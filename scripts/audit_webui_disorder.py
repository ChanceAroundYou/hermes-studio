#!/usr/bin/env python3
"""
audit_webui_disorder.py — 只读审计 webui 镜像库的 id↑timestamp↓ 倒流 + user 重发去重

Usage:
  python3 scripts/audit_webui_disorder.py --webui ~/.hermes/hermes-web-ui/hermes-web-ui.db \
    --json /tmp/disorder-audit.json --md /tmp/disorder-audit.md [--session mt9mw1oj7r6t6j]

- 默认全库扫描；指定 --session 则仅该 session
- 只读，不写库
- 窗口倒流阈值 1s，抗浮点抖动
- pollution: LAG(timestamp) OVER (ORDER BY id) 倒流且 (role,norm) 在更早 id 已存在
- user-dedup: role=user 同 norm 10s 窗口内多份，保留毫秒精度的最新一条
"""
import argparse, json, re, sqlite3, sys
from collections import defaultdict, Counter
from pathlib import Path

def norm(s: str) -> str:
    return re.sub(r'\s+', ' ', s or '').strip()

def has_fraction(ts: float) -> bool:
    # state 的毫秒时间戳带小数，webui 本地整秒无小数
    return abs(ts - round(ts)) > 1e-6

ap = argparse.ArgumentParser()
ap.add_argument('--webui', required=True)
ap.add_argument('--json', dest='json_out', default='/tmp/disorder-audit.json')
ap.add_argument('--md', dest='md_out', default='/tmp/disorder-audit.md')
ap.add_argument('--session', default='')
ap.add_argument('--dedup-window', type=float, default=10.0, help='user dedup window seconds')
args = ap.parse_args()

webui = Path(args.webui).expanduser()
if not webui.exists():
    print(f"webui DB not found: {webui}", file=sys.stderr); sys.exit(1)

con = sqlite3.connect(str(webui))
con.row_factory = sqlite3.Row
cur = con.cursor()

# sessions to scan
if args.session:
    sessions = [args.session]
else:
    cur.execute("SELECT DISTINCT session_id FROM messages ORDER BY session_id")
    sessions = [r[0] for r in cur.fetchall()]

results = []
total_pollution = 0
total_dedup = 0

for sid in sessions:
    cur.execute("SELECT id, role, content, timestamp FROM messages WHERE session_id=? ORDER BY id", (sid,))
    rows = cur.fetchall()
    if not rows:
        continue
    # earliest map
    earliest = {}  # (role,norm)-> earliest id
    for r in rows:
        key = (r['role'], norm(r['content']))
        if key not in earliest:
            earliest[key] = r['id']

    # 1) pollution: window LAG
    poll_ids = set()
    poll_details = []
    prev_ts = None
    prev_id = None
    for r in rows:
        ts = float(r['timestamp'] or 0)
        if prev_ts is not None and ts < prev_ts - 1:
            key = (r['role'], norm(r['content']))
            # only count if same normalized content already existed earlier (not a genuinely new early message)
            if earliest.get(key, r['id']) < r['id']:
                poll_ids.add(r['id'])
                poll_details.append({
                    'session_id': sid,
                    'prev_id': prev_id, 'prev_ts': prev_ts,
                    'cur_id': r['id'], 'cur_ts': ts,
                    'role': r['role'], 'norm_head': norm(r['content'])[:80],
                    'reason': 'pollution'
                })
        prev_ts = ts
        prev_id = r['id']

    # 2) user dedup: 10s window clustering per (role,norm) where role=user
    dedup_ids = set()
    dedup_details = []
    # group by norm for user only
    by_norm = defaultdict(list)
    for r in rows:
        if r['role'] != 'user':
            continue
        key = norm(r['content'])
        if not key:
            continue
        by_norm[key].append(r)

    for n, lst in by_norm.items():
        if len(lst) < 2:
            continue
        # sort by timestamp then id
        lst = sorted(lst, key=lambda x: (float(x['timestamp'] or 0), x['id']))
        # cluster by 10s window
        cluster = [lst[0]]
        for nxt in lst[1:]:
            if float(nxt['timestamp'] or 0) - float(cluster[-1]['timestamp'] or 0) <= args.dedup_window:
                cluster.append(nxt)
            else:
                # resolve cluster
                if len(cluster) > 1:
                    # keep the one with fractional ts (authoritative) and max ts; if tie, max id
                    # score: (has_fraction, ts, id)
                    keep = max(cluster, key=lambda x: (has_fraction(float(x['timestamp'] or 0)), float(x['timestamp'] or 0), x['id']))
                    for x in cluster:
                        if x['id'] != keep['id']:
                            dedup_ids.add(x['id'])
                            dedup_details.append({
                                'session_id': sid,
                                'del_id': x['id'], 'del_ts': float(x['timestamp'] or 0),
                                'keep_id': keep['id'], 'keep_ts': float(keep['timestamp'] or 0),
                                'norm_head': n[:80],
                                'reason': 'user-dedup'
                            })
                cluster = [nxt]
        if len(cluster) > 1:
            keep = max(cluster, key=lambda x: (has_fraction(float(x['timestamp'] or 0)), float(x['timestamp'] or 0), x['id']))
            for x in cluster:
                if x['id'] != keep['id']:
                    dedup_ids.add(x['id'])
                    dedup_details.append({
                        'session_id': sid,
                        'del_id': x['id'], 'del_ts': float(x['timestamp'] or 0),
                        'keep_id': keep['id'], 'keep_ts': float(keep['timestamp'] or 0),
                        'norm_head': n[:80],
                        'reason': 'user-dedup'
                    })

    # Dedup keeps (authoritative ms copies) must not be flagged as pollution,
    # even though their id order creates a window inversion — timestamp sort will fix order.
    dedup_keep_ids = set()
    for d in dedup_details:
        dedup_keep_ids.add(d['keep_id'])
    # remove keeps from pollution set
    poll_ids = poll_ids - dedup_keep_ids
    # filter details accordingly
    poll_details = [d for d in poll_details if d['cur_id'] in poll_ids]

    # For this sid, collect deletable
    all_del = (poll_ids | dedup_ids)
    poll_only = poll_ids  # already dedup-keep-excluded
    if poll_only or dedup_ids:
        results.append({
            'session_id': sid,
            'total_messages': len(rows),
            'pollution_ids': sorted(poll_only),
            'pollution_details': [d for d in poll_details if d['cur_id'] in poll_only],
            'user_dedup_del_ids': sorted(dedup_ids),
            'user_dedup_details': dedup_details,
            'delete_ids': sorted(all_del),
        })
        total_pollution += len(poll_only)
        total_dedup += len(dedup_ids)

# Summary
# Also compute global window inversion count for reference
# (already done per session as pollution, but raw window count is larger because not all inversions are content-duplicated)
out = {
    'webui': str(webui),
    'dedup_window': args.dedup_window,
    'sessions_scanned': len(sessions),
    'sessions_with_deletions': len(results),
    'total_pollution_deletions': total_pollution,
    'total_user_dedup_deletions': total_dedup,
    'total_deletions': total_pollution + total_dedup,
    'results': results,
}

# Also add raw window inversion stats for mt9mw1oj7r6t6j if present
if args.session:
    sids_for_raw = [args.session]
else:
    # top 5 sessions by count to give context
    sids_for_raw = [r['session_id'] for r in results[:5]] or sessions[:3]

raw_stats = []
for sid in ( [args.session] if args.session else [r['session_id'] for r in results[:5]] ):
    cur.execute("SELECT id, timestamp, LAG(timestamp) OVER (ORDER BY id) as prev_ts, LAG(id) OVER (ORDER BY id) as prev_id FROM (SELECT id, timestamp FROM messages WHERE session_id=? ORDER BY id)", (sid,))
    # sqlite window query direct
    cur2 = con.cursor()
    cur2.execute("WITH o AS (SELECT id, timestamp, LAG(timestamp) OVER (ORDER BY id) as p FROM messages WHERE session_id=?) SELECT COUNT(*) FROM o WHERE p IS NOT NULL AND timestamp < p - 1", (sid,))
    raw_cnt = cur2.fetchone()[0]
    raw_stats.append({'session_id': sid, 'raw_window_inversions': raw_cnt})
out['raw_window_stats'] = raw_stats

Path(args.json_out).write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding='utf-8')

# MD
md = []
md.append(f"# Disorder Audit — {webui}")
md.append("")
md.append(f"- dedup_window: {args.dedup_window}s (user 10s)")
md.append(f"- sessions_scanned: {len(sessions)}")
md.append(f"- sessions_with_deletions: {len(results)}")
md.append(f"- total_deletions: {total_pollution + total_dedup} (pollution {total_pollution} + user-dedup {total_dedup})")
md.append("")
if raw_stats:
    md.append("## Raw window inversions (id ASC, timestamp < prev -1s)")
    for s in raw_stats:
        md.append(f"- `{s['session_id']}`: {s['raw_window_inversions']}")
    md.append("")
for r in results:
    md.append(f"## {r['session_id']} — total {r['total_messages']}, delete {len(r['delete_ids'])}")
    if r['user_dedup_details']:
        md.append(f"### user-dedup ({len(r['user_dedup_details'])}) — 删旧留真，保留毫秒权威")
        for d in r['user_dedup_details']:
            md.append(f"- del `{d['del_id']}` ({d['del_ts']:.2f}) → keep `{d['keep_id']}` ({d['keep_ts']:.5f}) | `{d['norm_head']}`")
    if r['pollution_details']:
        md.append(f"### pollution ({len(r['pollution_details'])}) — 新 id + 旧 timestamp 倒流")
        for d in r['pollution_details']:
            md.append(f"- cur `{d['cur_id']}` ({d['cur_ts']:.2f}) after prev `{d['prev_id']}` ({d['prev_ts']:.2f}) | role={d['role']} | `{d['norm_head']}`")
    md.append(f"**delete_ids**: `{r['delete_ids']}`")
    md.append("")

Path(args.md_out).write_text("\n".join(md), encoding='utf-8')
print(f"wrote {args.json_out} and {args.md_out}")
print(f"sessions_with_deletions={len(results)} total_deletions={total_pollution+total_dedup} (pollution {total_pollution} + dedup {total_dedup})")
# print preview for mt9mw1oj7r6t6j if present
for r in results:
    if r['session_id'] == 'mt9mw1oj7r6t6j':
        print(f"mt9mw1oj7r6t6j delete_ids={r['delete_ids']}")
        print(f"  pollution_ids={r['pollution_ids']}")
        print(f"  dedup_ids={r['user_dedup_del_ids']}")
con.close()
