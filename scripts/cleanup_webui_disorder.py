#!/usr/bin/env python3
"""
cleanup_webui_disorder.py — 事务清理 webui 污染 + user 去重

Usage:
  python3 scripts/cleanup_webui_disorder.py --webui ~/.hermes/hermes-web-ui/hermes-web-ui.db \
    --audit /tmp/disorder-audit.json [--session mt9mw1oj7r6t6j] [--apply]

Default dry-run (no --apply): 打印将删行数与校验
--apply: 真删，事务包裹，更新 sessions 计数
"""
import argparse, json, sqlite3
from pathlib import Path

ap = argparse.ArgumentParser()
ap.add_argument('--webui', required=True)
ap.add_argument('--audit', required=True)
ap.add_argument('--session', default='')
ap.add_argument('--apply', action='store_true')
args = ap.parse_args()

webui = Path(args.webui).expanduser()
audit = json.loads(Path(args.audit).expanduser().read_text(encoding='utf-8'))

# collect delete_ids
targets = {}
for r in audit['results']:
    sid = r['session_id']
    if args.session and sid != args.session:
        continue
    targets[sid] = r['delete_ids']

if not targets:
    print("no targets matched"); raise SystemExit(0)

total = sum(len(v) for v in targets.values())
print(f"targets: {list(targets.keys())} total_delete={total}")
for sid, ids in targets.items():
    print(f"  {sid}: {len(ids)} ids sample {ids[:8]}")

if not args.apply:
    print("dry-run, use --apply to delete")
    # verify remaining inversions
    con = sqlite3.connect(str(webui))
    for sid in targets:
        cur = con.cursor()
        cur.execute("WITH o AS (SELECT id,timestamp, LAG(timestamp) OVER (ORDER BY id) as p FROM messages WHERE session_id=?) SELECT COUNT(*) FROM o WHERE p IS NOT NULL AND timestamp < p -1", (sid,))
        cnt = cur.fetchone()[0]
        print(f"  {sid} current window inversions (id order) before delete: {cnt}")
        # simulate after
        ids = set(targets[sid])
        cur.execute("SELECT id, timestamp FROM messages WHERE session_id=? ORDER BY id", (sid,))
        rows = [(r[0], r[1]) for r in cur.fetchall() if r[0] not in ids]
        inv = sum(1 for i in range(1,len(rows)) if rows[i][1] < rows[i-1][1] -1)
        print(f"  {sid} after delete (id order) inversions: {inv} (expected >0 because keeps are tail-inserted; timestamp sort fixes rendering)")
        # timestamp sorted inversions
        rows_ts = sorted(rows, key=lambda x: (x[1], x[0]))
        inv_ts = sum(1 for i in range(1,len(rows_ts)) if rows_ts[i][1] < rows_ts[i-1][1] -1)
        print(f"  {sid} after delete (timestamp order) inversions: {inv_ts} (expect 0)")
    con.close()
    raise SystemExit(0)

# apply
con = sqlite3.connect(str(webui))
con.execute("PRAGMA journal_mode=WAL")
try:
    con.execute("BEGIN")
    for sid, ids in targets.items():
        if not ids:
            continue
        placeholders = ",".join("?" for _ in ids)
        cur = con.execute(f"DELETE FROM messages WHERE session_id=? AND id IN ({placeholders})", (sid, *ids))
        print(f"deleted {cur.rowcount} rows for {sid}")
        # update sessions
        cur2 = con.execute("SELECT COUNT(*) FROM messages WHERE session_id=?", (sid,))
        cnt = cur2.fetchone()[0]
        cur3 = con.execute("SELECT MAX(timestamp) FROM messages WHERE session_id=?", (sid,))
        max_ts = cur3.fetchone()[0]
        con.execute("UPDATE sessions SET message_count=?, last_active=?, history_revision=history_revision+1 WHERE id=?", (cnt, max_ts or 0, sid))
        print(f"  sessions update: message_count={cnt} last_active={max_ts}")
    con.execute("COMMIT")
    print("COMMIT ok")
    # post verify
    for sid in targets:
        cur = con.cursor()
        cur.execute("SELECT COUNT(*) FROM messages WHERE session_id=?", (sid,))
        print(f"  {sid} final count {cur.fetchone()[0]}")
        cur.execute("WITH o AS (SELECT timestamp, LAG(timestamp) OVER (ORDER BY timestamp, id) as p FROM messages WHERE session_id=?) SELECT COUNT(*) FROM o WHERE p IS NOT NULL AND timestamp < p -1", (sid,))
        print(f"  {sid} timestamp-order inversions after: {cur.fetchone()[0]}")
except Exception as e:
    con.execute("ROLLBACK")
    print(f"ROLLBACK due to {e}")
    raise
finally:
    con.close()
