import { normalizeRunUsage, type RunUsageSummary } from '@/utils/run-usage'
import { mergeTaskPlanMessages, type TaskPlanSnapshot } from '@/utils/task-plan'
import { chatSessionAgentAvatar } from '@/utils/chat-agent-avatar'
import {connectChatRun, startRunViaSocket, resumeSession, registerSessionHandlers, unregisterSessionHandlers, getChatRunSocket, respondToolApproval, onPeerUserMessage, onSessionCommand, onSessionTitleUpdated, onSessionWorkspaceUpdated, onSessionSettingsUpdated, respondClarify, type ChatRunTransport, type RunEvent, type ResumeSessionPayload, type StartRunRequest, type ContentBlock as ContentBlockImport, onRunUsageUpdated} from '@/api/studio/chat'
import { archiveSession as archiveSessionApi, deleteSession as deleteSessionApi, fetchSessionMessagesPage, fetchWorkingSessions, fetchSessions, type RunState, fetchWorkspaceRunChangeFile, setSessionModel, setSessionPushEnabled as persistSessionPushEnabled, setSessionReasoningEffort as persistSessionReasoningEffort, type HermesMessage, type SessionSummary, type WorkspaceRunChangeFileDetail, type WorkspaceRunChangeSummary } from '@/api/studio/sessions'
import { getActiveProfileName, getBaseUrlValue } from '@/api/client'
import { onAuthInvalidated } from '@/api/auth-invalidation'
import { inferCodingAgentApiMode, normalizeCodingAgentApiMode, type ChatCodingAgentId } from '@/api/coding-agents'
import { getDownloadUrl } from '@/api/studio/download'
import type { ProviderApiMode } from '@/api/studio/provider-api-mode'
import { defineStore } from 'pinia'
import { ref, computed, onScopeDispose } from 'vue'
import { observeBackgroundStatus } from '@/api/studio/background-status'
import { useAppStore } from './app'
import { useProfilesStore } from './profiles'
import { useSettingsStore } from './settings'
import { primeCompletionSound, playCompletionSound } from '@/utils/completion-sound'
import { showCompletionNotification } from '@/utils/completion-notification'
import { detectThinkingBoundary } from '@/utils/thinking-parser'
import { isKnownBridgeSessionCommand } from '@/utils/hermes/bridge-session-commands'
import { rewriteSkillSlashCommand, skillCommandName } from '@/utils/hermes/slash-command-skills'
import { responseErrorMessage } from '@/utils/http-error'
import { errorMessage } from '@/utils/format'
import {
  isPendingInteractionExpiredError,
  notifyPendingInteractionExpired,
  pendingInteractionDeadline,
  type PendingInteractionSubmitResult,
} from '@/utils/pending-interaction'
import { isImageMime } from '@/utils/attachments'

// Re-export ContentBlock for convenience
export type ContentBlock = ContentBlockImport

export const LIVE_CHAT_MESSAGE_PAGE_SIZE = 150
export const LIVE_CHAT_MAX_LOADED_MESSAGES = 300
const LEGACY_WORKSPACE_RUN_CHANGE_MESSAGE_PREFIX = 'workspace-run-change:'
type ChatAgentId = 'hermes' | 'claude' | 'codex' | 'pi' | 'grok' | 'opencode' | 'dsh' | 'cursor' | 'ekko-agent'

function agentToCodingAgentId(agent?: string): ChatCodingAgentId | undefined {
  if (agent === 'codex') return 'codex'
  if (agent === 'pi') return 'pi'
  if (agent === 'grok') return 'grok'
  if (agent === 'dsh') return 'dsh'
  if (agent === 'opencode') return 'opencode'
  if (agent === 'cursor') return 'cursor'
  if (agent === 'claude') return 'claude-code'
  if (agent === 'ekko-agent') return 'ekko-agent'
  return undefined
}

function codingAgentIdToAgent(id?: ChatCodingAgentId): ChatAgentId | undefined {
  if (id === 'codex') return 'codex'
  if (id === 'pi') return 'pi'
  if (id === 'grok') return 'grok'
  if (id === 'dsh') return 'dsh'
  if (id === 'opencode') return 'opencode'
  if (id === 'cursor') return 'cursor'
  if (id === 'claude-code') return 'claude'
  if (id === 'ekko-agent') return 'ekko-agent'
  return undefined
}

function moaReferenceLabel(evt: RunEvent): string {
  const label = typeof evt.label === 'string' && evt.label.trim()
    ? evt.label.trim()
    : 'reference'
  const index = Number.isFinite(Number(evt.index)) ? Number(evt.index) : undefined
  const count = Number.isFinite(Number(evt.count)) ? Number(evt.count) : undefined
  return index != null && count != null
    ? `${index}/${count} ${label}`
    : label
}

export interface Attachment {
  id: string
  name: string
  type: string
  size: number
  url: string
  file?: File
  /** Structured context sent to the model but rendered collapsed in the UI. */
  context?: string
  /** Original video attachment id when this file is a model-only representative frame. */
  videoFrameFor?: string
}

export interface Message {
  taskPlan?: TaskPlanSnapshot
  id: string
  role: 'user' | 'assistant' | 'system' | 'tool' | 'command'
  content: string
  timestamp: number
  toolName?: string
  toolCallId?: string
  toolPreview?: string
  toolArgs?: unknown
  toolResult?: unknown
  toolStatus?: 'running' | 'done' | 'error'
  toolDuration?: number  // 工具执行时长（秒）
  workspaceChanges?: WorkspaceRunChangeSummary[]
  runUsage?: RunUsageSummary
  isStreaming?: boolean
  attachments?: Attachment[]
  // 思考/推理文本。两条来源：
  //   1) 历史消息：来自 HermesMessage.reasoning 字段
  //   2) 流式：由 reasoning.delta / thinking.delta / reasoning.available 事件累加
  // 不含 <think> 包裹标签；内容自身可以为多段纯文本。
  reasoning?: string
  queued?: boolean
  systemType?: 'command' | 'error' | 'fork-divider' | 'tool-run' | 'compression'
  /**
   * A completed context compression, as a transcript entry.
   *
   * This used to live only in `compressionState` and render inside the run
   * indicator, which meant it disappeared the moment the run settled and never
   * appeared in a re-fetched transcript. A compression is a fact about the
   * conversation, so it belongs between the messages it happened between --
   * ordered by `startedAt`, which is the time it actually occurred.
   *
   * Client-injected: the server does not replay it, so a refresh can lose it.
   */
  compression?: CompressionTranscriptEntry
  /** Client-injected row (e.g. a run error) with no server-side counterpart,
   *  so a transcript re-fetch has to preserve it explicitly. */
  commandAction?: string
  commandData?: Record<string, unknown>
  finishReason?: string | null
  runMarker?: string | null
  toolRunId?: string
  toolMessages?: Message[]
  attachedToolMessages?: Message[]
}

export type SubagentStreamStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'error'
  | 'cancelled'
  | 'interrupted'

export interface SubagentStreamEntry {
  id: string
  kind: 'text' | 'thinking' | 'tool' | 'status'
  timestamp: number
  text?: string
  reasoning?: string
  reasoningEntryId?: string
  toolName?: string
  toolArgs?: unknown
  status?: SubagentStreamStatus | 'started'
}

export interface SubagentStream {
  sessionId: string
  subagentId: string
  taskIndex: number
  taskCount: number
  goal?: string
  model?: string
  status: SubagentStreamStatus
  startedAt: number
  updatedAt: number
  completedAt?: number
  durationSeconds?: number
  toolCount?: number
  apiCalls?: number
  inputTokens?: number
  outputTokens?: number
  costUsd?: number
  summary?: string
  lastBackgroundSeq?: number
  entries: SubagentStreamEntry[]
}

const SUBAGENT_STREAM_ENTRY_LIMIT = 200
const SUBAGENT_STREAM_TEXT_LIMIT = 80_000
let subagentStreamEntrySequence = 0

function subagentEventTimestamp(value: unknown): number {
  const timestamp = Number(value)
  if (!Number.isFinite(timestamp) || timestamp <= 0) return Date.now()
  return timestamp < 1_000_000_000_000 ? Math.round(timestamp * 1000) : Math.round(timestamp)
}

function subagentStatus(value: unknown, fallback: SubagentStreamStatus = 'running'): SubagentStreamStatus {
  const status = String(value || '').trim().toLowerCase()
  if (status === 'completed' || status === 'failed' || status === 'error' || status === 'cancelled' || status === 'interrupted') {
    return status
  }
  return fallback
}

function subagentEntryId(eventName: string, evt: RunEvent): string {
  const backgroundSequence = Number((evt as any).background_seq)
  if (Number.isFinite(backgroundSequence)) return `${eventName}:${backgroundSequence}`
  if ((evt as any).background_snapshot) return `snapshot:${eventName}`
  subagentStreamEntrySequence += 1
  return `${eventName}:${subagentStreamEntrySequence}`
}

function trimSubagentEntries(entries: SubagentStreamEntry[]): SubagentStreamEntry[] {
  return entries.length > SUBAGENT_STREAM_ENTRY_LIMIT
    ? entries.slice(entries.length - SUBAGENT_STREAM_ENTRY_LIMIT)
    : entries
}

function appendSubagentText(
  entries: SubagentStreamEntry[],
  entry: SubagentStreamEntry,
): SubagentStreamEntry[] {
  const previous = entries[entries.length - 1]
  if (previous?.kind === entry.kind && entry.text) {
    const previousText = previous.text || ''
    const nextText = entry.text.startsWith(previousText)
      ? entry.text
      : `${previousText}${entry.text}`
    entries[entries.length - 1] = {
      ...previous,
      text: nextText.slice(-SUBAGENT_STREAM_TEXT_LIMIT),
      timestamp: entry.timestamp,
    }
    return entries
  }
  entries.push({
    ...entry,
    text: entry.text?.slice(-SUBAGENT_STREAM_TEXT_LIMIT),
  })
  return trimSubagentEntries(entries)
}

function subagentReasoningSinceLastTool(
  entries: SubagentStreamEntry[],
): { id: string; text: string } | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]
    if (entry.kind === 'tool') return null
    if (entry.kind === 'thinking' && entry.text?.trim()) {
      return { id: entry.id, text: entry.text }
    }
  }
  return null
}

export function reduceSubagentStream(
  current: SubagentStream | undefined,
  sessionId: string,
  evt: RunEvent,
): SubagentStream {
  const eventName = String(evt.event || '')
  const subagentId = String((evt as any).subagent_id || evt.delegation_id || `${(evt as any).task_index ?? 0}`)
  const timestamp = subagentEventTimestamp(evt.timestamp || (evt as any).updated_at)
  const backgroundSequence = Number((evt as any).background_seq)
  if (
    current
    && Number.isFinite(backgroundSequence)
    && current.lastBackgroundSeq != null
    && backgroundSequence <= current.lastBackgroundSeq
  ) {
    return current
  }

  const incomingTaskIndex = Number((evt as any).task_index)
  const incomingTaskCount = Number((evt as any).task_count)
  const goal = String((evt as any).goal || '').trim()
  const model = String((evt as any).model || '').trim()
  const summary = String((evt as any).summary || '').trim()
  const rawText = String(evt.text || evt.preview || '')
  const text = rawText.trim()
  const toolName = String((evt as any).tool || (evt as any).name || '').trim()
  const durationSeconds = Number((evt as any).duration_seconds ?? (evt as any).duration)
  const toolCount = Number((evt as any).tool_count)
  const apiCalls = Number((evt as any).api_calls)
  const inputTokens = Number((evt as any).input_tokens)
  const outputTokens = Number((evt as any).output_tokens)
  const costUsd = Number((evt as any).cost_usd)
  const isTerminal = eventName === 'subagent.complete'
    || (eventName === 'delegation.updated' && ['completed', 'failed', 'error', 'cancelled', 'interrupted'].includes(String((evt as any).status || '').toLowerCase()))
  if (current && current.status !== 'running' && !isTerminal) return current
  const nextStatus = isTerminal
    ? subagentStatus((evt as any).status, 'completed')
    : 'running'
  const entries = current ? [...current.entries] : []
  const entryId = subagentEntryId(eventName, evt)

  if (eventName === 'subagent.start') {
    if (!entries.some(entry => entry.kind === 'status' && entry.status === 'started')) {
      entries.push({ id: entryId, kind: 'status', status: 'started', timestamp, text: goal || undefined })
    }
  } else if (eventName === 'subagent.text' && rawText) {
    const reasoning = subagentReasoningSinceLastTool(entries)
    appendSubagentText(entries, {
      id: entryId,
      kind: 'text',
      timestamp,
      text: rawText,
      reasoning: reasoning?.text,
      reasoningEntryId: reasoning?.id,
    })
  } else if (eventName === 'subagent.thinking' && rawText) {
    appendSubagentText(entries, { id: entryId, kind: 'thinking', timestamp, text: rawText })
  } else if (eventName === 'subagent.tool') {
    const reasoning = subagentReasoningSinceLastTool(entries)
    if (reasoning) {
      // A tool boundary is the final owner for this reasoning segment. Text
      // deltas can arrive before the tool call is announced, so revoke their
      // provisional ownership to avoid rendering the same reasoning twice.
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i]
        if (entry.kind !== 'text' || entry.reasoningEntryId !== reasoning.id) continue
        const {
          reasoning: _reasoning,
          reasoningEntryId: _reasoningEntryId,
          ...textEntry
        } = entry
        entries[i] = textEntry
      }
    }
    entries.push({
      id: entryId,
      kind: 'tool',
      timestamp,
      text: text || undefined,
      reasoning: reasoning?.text,
      reasoningEntryId: reasoning?.id,
      toolName: toolName || undefined,
      toolArgs: (evt as any).arguments,
    })
  } else if (eventName === 'subagent.progress' && text) {
    const previous = entries[entries.length - 1]
    const progressEntry: SubagentStreamEntry = {
      id: entryId,
      kind: 'status',
      status: 'running',
      timestamp,
      text,
    }
    if (previous?.kind === 'status' && previous.status === 'running') entries[entries.length - 1] = progressEntry
    else entries.push(progressEntry)
  }

  if (isTerminal) {
    const finalText = summary || text
    const previousTextEntry = [...entries].reverse().find(entry => entry.kind === 'text')
    const previousText = previousTextEntry?.text?.trim()
    if (finalText && previousText !== finalText) {
      const activeReasoning = subagentReasoningSinceLastTool(entries)
      const reasoning = activeReasoning?.id === previousTextEntry?.reasoningEntryId
        ? null
        : activeReasoning
      entries.push({
        id: `${entryId}:summary`,
        kind: 'text',
        timestamp,
        text: finalText,
        reasoning: reasoning?.text,
        reasoningEntryId: reasoning?.id,
      })
    }
    const previous = entries[entries.length - 1]
    const terminalEntry: SubagentStreamEntry = {
      id: entryId,
      kind: 'status',
      status: nextStatus,
      timestamp,
    }
    if (previous?.kind === 'status' && previous.status !== 'started') entries[entries.length - 1] = terminalEntry
    else entries.push(terminalEntry)
  }

  return {
    sessionId,
    subagentId,
    taskIndex: Number.isFinite(incomingTaskIndex) ? incomingTaskIndex : current?.taskIndex || 0,
    taskCount: Number.isFinite(incomingTaskCount) && incomingTaskCount > 0 ? incomingTaskCount : current?.taskCount || 1,
    goal: goal || current?.goal,
    model: model || current?.model,
    status: nextStatus,
    startedAt: current?.startedAt || subagentEventTimestamp((evt as any).started_at || timestamp),
    updatedAt: timestamp,
    completedAt: isTerminal ? subagentEventTimestamp((evt as any).completed_at || timestamp) : current?.completedAt,
    durationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : current?.durationSeconds,
    toolCount: Number.isFinite(toolCount) ? toolCount : current?.toolCount,
    apiCalls: Number.isFinite(apiCalls) ? apiCalls : current?.apiCalls,
    inputTokens: Number.isFinite(inputTokens) ? inputTokens : current?.inputTokens,
    outputTokens: Number.isFinite(outputTokens) ? outputTokens : current?.outputTokens,
    costUsd: Number.isFinite(costUsd) ? costUsd : current?.costUsd,
    summary: summary || current?.summary,
    lastBackgroundSeq: Number.isFinite(backgroundSequence) ? backgroundSequence : current?.lastBackgroundSeq,
    entries: trimSubagentEntries(entries),
  }
}

export interface MessageReference {
  id: string
  role: 'user' | 'assistant'
  content: string
  sender?: string
  senderId?: string
}

export interface ParsedMessageReference {
  content: string
  reply: string
}

export function parseMessageReference(content: string): ParsedMessageReference | null {
  if (!content.startsWith('<quoted_message')) return null
  const openEnd = content.indexOf('>\n')
  if (openEnd === -1) return null
  const closeMarker = '\n</quoted_message>'
  const closeStart = content.indexOf(closeMarker, openEnd + 2)
  if (closeStart === -1) return null

  return {
    content: content.slice(openEnd + 2, closeStart).trim(),
    reply: content.slice(closeStart + closeMarker.length).trim(),
  }
}

export function formatReferencedContentForDisplay(content: string): string {
  return content
    .trim()
    .split(/\r?\n/)
    .map(line => line ? `> ${line}` : '>')
    .join('\n')
}

export function formatMessageWithReference(reference: MessageReference, content: string): string {
  const sender = reference.sender?.trim()
  const openTag = sender
    ? `<quoted_message sender=${JSON.stringify(sender)}>`
    : '<quoted_message>'
  const quotedContent = reference.content.trim()
  const reply = content.trim()
  const referenceBlock = `${openTag}\n${quotedContent}\n</quoted_message>`
  return reply ? `${referenceBlock}\n\n${reply}` : referenceBlock
}

export interface PendingApproval {
  sessionId: string
  approvalId: string
  command: string
  description: string
  choices: Array<'once' | 'session' | 'always' | 'deny'>
  allowPermanent: boolean
  isMemoryWrite: boolean
  requestedAt: number
  countdownDeadline: number
}

export interface PendingClarify {
  sessionId: string
  clarifyId: string
  question: string
  choices: string[] | null
  initialResponse: string
  responseMode: string
  timeoutMs: number
  requestedAt: number
  countdownDeadline: number
}

export interface QueueInsertionState {
  generation: string
  runId?: string
  queueId: string
  runtime: 'hermes' | 'ekko' | 'claude-code' | 'codex' | 'pi' | 'grok' | 'opencode' | 'dsh' | 'cursor'
  phase: 'requesting' | 'waiting_for_tool_batch' | 'stopping_current_turn'
  guarantee: 'strict' | 'immediate'
  requestedAt: number
}

export interface Session {
  id: string
  profile?: string
  title: string
  source?: string
  agent?: string
  agentSessionId?: string
  agentNativeSessionId?: string
  codingAgentId?: ChatCodingAgentId
  codingAgentMode?: 'global' | 'scoped'
  agentPreset?: string
  messages: Message[]
  createdAt: number
  updatedAt: number
  model?: string
  provider?: string
  baseUrl?: string
  apiKey?: string
  apiMode?: ProviderApiMode
  messageCount?: number
  messageTotal?: number
  loadedMessageCount?: number
  hasMoreBefore?: boolean
  isLoadingOlderMessages?: boolean
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  contextTokens?: number
  endedAt?: number | null
  parentSessionId?: string | null
  forkPointMessageId?: string | null
  parentTitle?: string | null
  parentLastMessage?: string | null
  parentLastMessageRole?: string | null
  lastActiveAt?: number
  isPinned?: boolean
  isArchived?: boolean
  pushEnabled?: boolean
  workspace?: string | null
  categoryId?: number | null
  isLocalOnly?: boolean
  /** Per-session reasoning effort override.
   * Empty string / undefined = use config.yaml default.
   * Values: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' */
  reasoningEffort?: string
}

interface CompressionState {
  compressing: boolean
  messageCount: number
  beforeTokens: number
  afterTokens: number
  compressed: boolean | null
  error?: string
  /** Epoch ms the compression began; used as the transcript entry's time. */
  startedAt?: number
  /**
   * What the compression belongs to. A run-scoped compression cannot outlive
   * its run; an idle `/compress` command reports its own completion.
   */
  source?: 'run' | 'command'
}

/** The compression facts a transcript entry renders. */
export interface CompressionTranscriptEntry {
  compressing: boolean
  messageCount: number
  beforeTokens: number
  afterTokens: number
  compressed: boolean | null
  error?: string
  startedAt?: number
  source?: 'run' | 'command'
}

interface AbortState {
  aborting: boolean
  synced: boolean | null
  timedOut?: boolean
  message?: string
  error?: string
}

// How long to wait for abort.completed / abort.timeout before concluding the
// stop request was lost. Generous enough for a slow agent, short enough that a
// lost request does not leave the stop button dead for the rest of the run.
const ABORT_WATCHDOG_MS = 8000
const STOP_UNCONFIRMED_MESSAGE = 'Stop was not confirmed by the run. Press stop again.'

function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

export function alignWorkspaceChangeAssistantMessage(
  messages: Message[],
  change: WorkspaceRunChangeSummary | null | undefined,
  assistantMessageId?: string | null,
): string | null {
  const currentAssistantMessageId = String(assistantMessageId || '').trim()
  const persistedAssistantMessageId = String(change?.assistant_message_id || '').trim()
  if (!persistedAssistantMessageId) return currentAssistantMessageId || null
  if (!currentAssistantMessageId || persistedAssistantMessageId === currentAssistantMessageId) {
    return messages.some(item => item.id === persistedAssistantMessageId)
      ? persistedAssistantMessageId
      : currentAssistantMessageId || null
  }
  const message = messages.find(item => item.id === currentAssistantMessageId)
  const idAlreadyLoaded = messages.some(item => item.id === persistedAssistantMessageId)
  if (message && !idAlreadyLoaded) {
    message.id = persistedAssistantMessageId
    return persistedAssistantMessageId
  }
  return idAlreadyLoaded ? persistedAssistantMessageId : currentAssistantMessageId
}

export function attachWorkspaceChangesToExactTurns(
  messages: Message[],
  changes: WorkspaceRunChangeSummary[],
): void {
  for (const message of messages) message.workspaceChanges = []
  const assistantById = new Map(
    messages
      .filter(message => message.role === 'assistant')
      .map(message => [message.id, message]),
  )
  for (const change of changes) {
    const assistantMessageId = String(change.assistant_message_id || '').trim()
    if (!assistantMessageId) continue
    const target = assistantMessageId ? assistantById.get(assistantMessageId) : undefined
    if (target) target.workspaceChanges!.push(change)
  }
}

function isToolOutputError(output: unknown): boolean {
  if (typeof output !== 'string' || !output.trim()) return false
  try {
    const parsed = JSON.parse(output)
    if (parsed && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>
      if (record.success === false) return true
      if (record.error != null && String(record.error).trim() !== '') return true
    }
  } catch {
    return false
  }
  return false
}


async function uploadFiles(attachments: Attachment[]): Promise<{ name: string; path: string }[]> {
  if (attachments.length === 0) return []
  const formData = new FormData()
  for (const att of attachments) {
    if (att.file) formData.append('file', att.file, att.name)
  }
  const token = localStorage.getItem('hermes_api_key') || ''
  const profileName = getActiveProfileName()
  const base = getBaseUrlValue()
  const headers: Record<string, string> = {}
  if (token) headers.Authorization = `Bearer ${token}`
  if (profileName) headers['X-Hermes-Profile'] = profileName
  const res = await fetch(`${base}/api/studio/uploads`, {
    method: 'POST',
    body: formData,
    headers,
  })
  if (!res.ok) throw new Error(await responseErrorMessage(res, 'Upload failed'))
  const data = await res.json() as { files: { name: string; path: string }[] }
  return data.files
}

export async function buildContentBlocks(
  content: string,
  attachments?: Attachment[],
  uploadedFiles?: { name: string; path: string }[],
  includeContextText = true,
): Promise<ContentBlock[]> {
  const blocks: ContentBlock[] = []

  // Add text block if content is not empty
  if (content.trim()) {
    blocks.push({ type: 'text', text: content.trim() })
  }

  // Add attachment blocks using uploaded file paths
  if (attachments && attachments.length > 0 && uploadedFiles) {
    for (let i = 0; i < uploadedFiles.length; i++) {
      const uploaded = uploadedFiles[i]
      const attachment = attachments[i]

      // Check if it's an image
      if (isImageMime(attachment?.type)) {
        blocks.push({
          type: 'image',
          name: uploaded.name,
          path: uploaded.path,
          media_type: attachment.type,
          ...(attachment.context?.trim() ? { context: attachment.context.trim() } : {}),
          ...(attachment.videoFrameFor ? { video_frame: true } : {}),
        })
      } else {
        // Other files
        blocks.push({
          type: 'file',
          name: uploaded.name,
          path: uploaded.path,
          media_type: attachment?.type,
          ...(attachment?.context?.trim() ? { context: attachment.context.trim() } : {}),
        })
      }
      if (includeContextText && attachment?.context?.trim()) {
        blocks.push({
          type: 'text',
          text: `<browser_selection_context format="json">\n${attachment.context.trim()}\n</browser_selection_context>`,
        })
      }
    }
  }

  return blocks
}

function hasRuntimeToolPayload(value: unknown): boolean {
  return value !== null && value !== undefined && value !== ''
}

function runtimeToolPayloadOrUndefined(value: unknown): unknown | undefined {
  return hasRuntimeToolPayload(value) ? value : undefined
}

function runtimeToolOutputFromEvent(event: unknown): unknown | undefined {
  if (!event || typeof event !== 'object') return undefined
  const record = event as Record<string, unknown>
  return runtimeToolPayloadOrUndefined(
    record.output ?? record.result ?? record.content ?? record.preview,
  )
}

function runtimePayloadText(value: unknown): string {
  if (!hasRuntimeToolPayload(value)) return ''
  if (typeof value === 'string') return value
  try {
    const serialized = JSON.stringify(value)
    if (serialized !== undefined) return serialized
  } catch {
    // Fall through to String(value) for non-serializable runtime payloads.
  }
  return String(value)
}

function runtimeObjectPayload(value: unknown): Record<string, unknown> | null {
  if (!value) return null
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  if (typeof value !== 'string') return null
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function isBackgroundDelegateToolPayload(toolName: unknown, payload: unknown): boolean {
  if (String(toolName || '') !== 'delegate_task') return false
  return runtimeObjectPayload(payload)?.mode === 'background'
}

const HERMES_BACKGROUND_DELEGATE_ANCHOR_PREFIX = 'background-delegate:'

function backgroundDelegateTaskDescriptors(
  payload: Record<string, unknown>,
  toolArgs: unknown,
): Array<{ taskIndex: number; taskCount: number; goal: string }> {
  const args = runtimeObjectPayload(toolArgs)
  const payloadGoals = Array.isArray(payload.goals)
    ? payload.goals.map(value => String(value || '').trim())
    : []
  const argumentGoals = Array.isArray(args?.goals)
    ? args.goals.map(value => String(value || '').trim())
    : []
  const goals = payloadGoals.length > 0 ? payloadGoals : argumentGoals
  const fallbackGoal = String(payload.goal || args?.goal || '').trim()
  const requestedCount = Number(payload.count ?? payload.task_count)
  const taskCount = Math.max(
    1,
    Number.isFinite(requestedCount) ? requestedCount : 0,
    goals.length,
  )
  return Array.from({ length: taskCount }, (_, taskIndex) => ({
    taskIndex,
    taskCount,
    goal: goals[taskIndex] || (taskIndex === 0 ? fallbackGoal : ''),
  }))
}

function backgroundDelegateAnchorCallId(baseId: string, taskIndex: number): string {
  return `${HERMES_BACKGROUND_DELEGATE_ANCHOR_PREFIX}${baseId}:${taskIndex}`
}

function parsePersistedMoaToolPayload(toolName: string | undefined, value: unknown): { preview?: string; result?: unknown } | null {
  if (toolName !== 'moa_reference' && toolName !== 'moa_aggregating') return null
  const payload = typeof value === 'string'
    ? (() => {
        try {
          return JSON.parse(value)
        } catch {
          return null
        }
      })()
    : value
  if (!payload || typeof payload !== 'object') return null
  const data = payload as Record<string, unknown>
  const preview = typeof data.preview === 'string'
    ? data.preview
    : typeof data.label === 'string'
      ? data.label
      : typeof data.aggregator === 'string'
        ? data.aggregator
        : undefined
  const result = data.text ?? data.result
  return { preview, result }
}

function isPersistedMoaToolDisplay(msg: HermesMessage): boolean {
  return (msg.role === 'moa' || msg.display_role === 'tool')
    && (msg.tool_name === 'moa_reference' || msg.tool_name === 'moa_aggregating')
}

function runtimeToolOutputHasError(value: unknown): boolean {
  return typeof value === 'string' && isToolOutputError(value)
}

function readFinishReason(value: unknown): string | null | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  if (Object.prototype.hasOwnProperty.call(record, 'finishReason')) {
    return (record as { finishReason?: string | null }).finishReason
  }
  if (Object.prototype.hasOwnProperty.call(record, 'finish_reason')) {
    return (record as { finish_reason?: string | null }).finish_reason
  }
  return undefined
}

function readRunMarker(value: unknown): string | null | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  if (Object.prototype.hasOwnProperty.call(record, 'runMarker')) {
    return typeof record.runMarker === 'string' || record.runMarker == null
      ? record.runMarker as string | null
      : undefined
  }
  if (Object.prototype.hasOwnProperty.call(record, 'run_marker')) {
    return typeof record.run_marker === 'string' || record.run_marker == null
      ? record.run_marker as string | null
      : undefined
  }
  if (Object.prototype.hasOwnProperty.call(record, 'run_id')) {
    return typeof record.run_id === 'string' || record.run_id == null
      ? record.run_id as string | null
      : undefined
  }
  return undefined
}

function normalizedRunMarker(value: unknown): string | null {
  const runMarker = readRunMarker(value)
  return typeof runMarker === 'string' && runMarker.trim() !== '' ? runMarker.trim() : null
}

function toolInstanceKey(value: unknown, toolCallId: string): string {
  return `${normalizedRunMarker(value) || 'legacy'}\u0000${toolCallId}`
}

function setToolMetadata<T>(map: Map<string, T>, message: unknown, toolCallId: string, value: T) {
  const scopedKey = toolInstanceKey(message, toolCallId)
  const legacyKey = toolInstanceKey(null, toolCallId)
  map.set(scopedKey, value)
  // Some older rows only persisted the run marker on the tool result. Keep a
  // best-effort fallback without allowing it to override an exact scoped key.
  if (!map.has(legacyKey)) map.set(legacyKey, value)
}

function getToolMetadata<T>(map: Map<string, T>, message: unknown, toolCallId: string): T | undefined {
  return map.get(toolInstanceKey(message, toolCallId))
    ?? map.get(toolInstanceKey(null, toolCallId))
}

function isQueueInsertionInterruption(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const event = value as Pick<RunEvent, 'interrupted' | 'stop_reason'>
  return event.interrupted === true && event.stop_reason === 'queue_insertion'
}

// A few bridge failures reach the client as status *text* instead of an `error`
// field, e.g. "Non-retryable error (HTTP 502): HTTP 502: Provider returned 400".
// Rendering those as a neutral system notice meant one failure appeared twice:
// once amber while the run was still failing, then again red once the server
// persisted the same failure as a `role: 'error'` row.
//
// The patterns are deliberately high precision. An earlier, broader version also
// matched any sentence containing "error" or "failed" and repainted ordinary
// replies ("Error handling in the parser looks correct", "The failed test was
// flaky") red. Every pattern below is a machine-generated signature that cannot
// occur in a normal assistant answer.
const BRIDGE_FAILURE_PATTERNS: RegExp[] = [
  /^\s*Error\s*:/,
  /^\s*Non[- ]?retryable\b/i,
  /^\s*HTTP\s+[45]\d\d\b/i,
  /\bHTTP\s+[45]\d\d\s*:/i,
  /^\s*(fatal|critical)\b/i,
  /^\s*Traceback \(most recent call last\)/,
  /\bProvider returned\s+[45]\d\d\b/i,
  /\b(run failed|Run failed|Agent run failed)\b/,
  /^\s*Agent reported failure\b/i,
  /^\s*Failed to start\b/i,
]

export function isBridgeFailureText(raw: unknown): boolean {
  const text = String(raw || '').trim()
  if (!text) return false
  return BRIDGE_FAILURE_PATTERNS.some(pattern => pattern.test(text))
}

/**
 * The agent's turn-lease notices: "another process holds this session".
 *
 * These need their own list because the agent gives them no distinguishing
 * structure. Its status callback carries a `kind`, but the lease wait and a
 * compression both arrive as `lifecycle`, so the kind cannot separate "your turn
 * has not started" from "your turn is running and doing maintenance".
 *
 * They are not ordinary progress, though: nothing is happening yet and the
 * reader is waiting on someone else, so they keep the error treatment rather
 * than the neutral notice card. Narrow machine signatures only -- the hourglass
 * the agent prefixes these with, and the two phrasings it uses -- so this cannot
 * match a reply.
 */
const BRIDGE_BLOCKED_PATTERNS: RegExp[] = [
  // The agent prefixes this whole family with an hourglass, and this is the
  // only place that glyph is used as a marker. Deliberately the whole pattern:
  // a first version also matched the phrase "waiting for it to finish", which
  // is exactly the mistake this fork already made once -- it repainted the
  // ordinary reply "I was waiting for it to finish, then the parser looked
  // correct" as a blocked session.
  /^\s*\u23f3/,
]

export function isBridgeBlockedText(raw: unknown): boolean {
  const text = String(raw || '').trim()
  if (!text) return false
  return BRIDGE_BLOCKED_PATTERNS.some(pattern => pattern.test(text))
}

/**
 * The status kind the agent tags a message with: `lifecycle` for ordinary
 * progress, `warn` for a degraded path the reader must know about. Only `warn`
 * is treated as a problem.
 */
export function isWarningStatusKind(raw: unknown): boolean {
  return String(raw || '').trim().toLowerCase() === 'warn'
}

function hasAssistantVisibleText(message: Message | null | undefined): boolean {
  if (!message) return false
  return message.content.trim() !== '' || (message.reasoning?.trim() ?? '') !== ''
}

function selectResumedInFlightAssistant(messages: Message[], activeRunMarker?: string | null): Message | null {
  if (messages.length === 0) return null
  const lastMessage = messages[messages.length - 1]
  if (lastMessage?.role !== 'assistant') return null
  const finishReason = readFinishReason(lastMessage)
  const runMarker = readRunMarker(lastMessage)
  const hasMatchingRunMarker = !!activeRunMarker && !!runMarker && runMarker === activeRunMarker
  return finishReason === null || hasMatchingRunMarker ? lastMessage : null
}

function getReplayRunMarker(events?: Array<{ event: string; data: RunEvent }>): string | null {
  if (!Array.isArray(events)) return null
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const runMarker = readRunMarker(events[i]?.data)
    if (typeof runMarker === 'string' && runMarker.trim() !== '') return runMarker
  }
  return null
}

function resolveResumedAssistantState(
  messages: Message[],
  options: {
    previousActiveAssistantMessageId?: string | null
    previousReasoningAssistantMessageId?: string | null
    activeRunMarker?: string | null
  },
): {
  activeAssistant: Message | null
  reasoningAssistant: Message | null
  runMarker: string | null
  hadVisibleText: boolean
} {
  const activeAssistant = options.previousActiveAssistantMessageId
    ? messages.find(m => m.role === 'assistant' && m.id === options.previousActiveAssistantMessageId) || null
    : null
  const selectedActiveAssistant = activeAssistant || selectResumedInFlightAssistant(messages, options.activeRunMarker)
  const reasoningAssistant = options.previousReasoningAssistantMessageId
    ? messages.find(m => m.role === 'assistant' && m.id === options.previousReasoningAssistantMessageId) || null
    : null
  const selectedReasoningAssistant = reasoningAssistant || (selectedActiveAssistant?.reasoning ? selectedActiveAssistant : null)
  const selectedRunMarker = readRunMarker(selectedActiveAssistant) ?? options.activeRunMarker ?? null
  return {
    activeAssistant: selectedActiveAssistant,
    reasoningAssistant: selectedReasoningAssistant,
    runMarker: selectedRunMarker,
    hadVisibleText: hasAssistantVisibleText(selectedActiveAssistant),
  }
}

/**
 * Reads a persisted compression row.
 *
 * The server stores these as `role: 'command'` with `display_role: 'compression'`
 * and a JSON payload, so a compression survives a re-fetch the way an ordinary
 * message does. Matching on the display_role rather than the prose is what lets
 * one entry update in place from "Compressing..." to the final numbers.
 */
function readCompressionRecord(msg: HermesMessage): CompressionTranscriptEntry | null {
  if (msg.display_role !== 'compression') return null
  const raw = String(msg.content ?? '').trim()
  if (!raw.startsWith('{')) return null
  try {
    const payload = JSON.parse(raw)?.__compression
    if (!payload || typeof payload !== 'object' || typeof payload.startedAt !== 'number') return null
    return {
      compressing: false,
      messageCount: Number(payload.messageCount) || 0,
      beforeTokens: Number(payload.beforeTokens) || 0,
      afterTokens: Number(payload.afterTokens) || 0,
      compressed: payload.compressed ?? null,
      error: typeof payload.error === 'string' ? payload.error : undefined,
      source: payload.source === 'command' ? 'command' : 'run',
      startedAt: payload.startedAt,
    }
  } catch {
    return null
  }
}

function mapHermesMessages(msgs: HermesMessage[], taskPlans: unknown[] = [], previous: Message[] = []): Message[] {
  // Filter out assistant messages with no display content unless they carry tool call metadata
  // needed to name later tool result rows when resuming persisted history.
  const filteredMsgs = msgs.filter(m => {
    if (m.role === 'assistant') {
      return (m.tool_calls?.length || 0) > 0 || runtimePayloadText((m as any).content).trim() !== '' || !!m.run_usage
    }
    return true
  })

  // Hermes Agent kernel (state.db) sometimes writes the same assistant
  // message twice (identical content, timestamps seconds-to-minutes apart,
  // often with a tool message interleaved: assistant → tool → assistant(dup)).
  // The previous logic required strict consecutiveness and used a broken
  // 5000-second window (timestamp is seconds, not ms). Fix: per-role dedup,
  // window 300s (5min), ignores interleaving tool/system rows.
  const dedupedMsgs: HermesMessage[] = []
  const lastByRole = new Map<string, { norm: string; ts: number }>()
  const DEDUP_WINDOW_SEC = 300
  for (const m of filteredMsgs) {
    const role = m.role ?? ''
    const content = runtimePayloadText((m as any).content) ?? ''
    const norm = content.replace(/\s+/g, ' ').trim()
    const ts = m.timestamp ?? 0
    // A persisted failure is never a duplicate to be collapsed. Each failed run
    // records its own `role: 'error'` row, and the user is meant to see every
    // one of them where it happened. Deduplicating them made a retried failure
    // erase the earlier record and surface only the newest.
    if (norm && role !== 'error') {
      const prev = lastByRole.get(role)
      const isDup = !!prev
        && ts >= prev.ts
        && ts - prev.ts < DEDUP_WINDOW_SEC
        && (norm === prev.norm
          || (norm.length > 20 && prev.norm.length > 20 && (norm.startsWith(prev.norm) || prev.norm.startsWith(norm))))
      if (isDup) continue
      lastByRole.set(role, { norm, ts })
    } else {
      lastByRole.set(role, { norm: '', ts })
    }
    dedupedMsgs.push(m)
  }

  // Build lookups from assistant messages with tool_calls
  const toolNameMap = new Map<string, string>()
  const toolArgsMap = new Map<string, unknown>()
  const toolReasoningMap = new Map<string, string>()
  for (const msg of dedupedMsgs) {
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        if (tc.id) {
          if (tc.function?.name) setToolMetadata(toolNameMap, msg, tc.id, tc.function.name)
          if (hasRuntimeToolPayload(tc.function?.arguments)) setToolMetadata(toolArgsMap, msg, tc.id, tc.function.arguments)
          if (msg.reasoning?.trim()) setToolMetadata(toolReasoningMap, msg, tc.id, msg.reasoning)
        }
      }
    }
  }

  const result: Message[] = []
  for (const msg of dedupedMsgs) {
    // A failed run is persisted by the server as `role: 'error'`. It renders
    // through the same red bubble the client used to inject locally, but it now
    // arrives with the transcript, so it survives a re-fetch, a session switch
    // and another device. The server filters this role out of model context.
    if (msg.role === 'error') {
      result.push({
        id: String(msg.id),
        role: 'assistant',
        content: String(msg.content || ''),
        timestamp: Math.round(msg.timestamp * 1000),
        isStreaming: false,
        systemType: 'error',
        runMarker: readRunMarker(msg),
      })
      continue
    }
    // Skip assistant messages that only contain tool_calls (no meaningful content)
    if (msg.role === 'assistant' && msg.tool_calls?.length && !runtimePayloadText((msg as any).content).trim()) {
      // Emit a tool.started message for each tool call
      for (const tc of msg.tool_calls) {
        result.push({
          id: String(msg.id) + '_' + tc.id,
          role: 'tool',
          content: '',
          timestamp: Math.round(msg.timestamp * 1000),
          toolName: tc.function?.name || undefined,
          toolCallId: tc.id,
          toolArgs: runtimeToolPayloadOrUndefined(tc.function?.arguments),
          reasoning: msg.reasoning?.trim() ? msg.reasoning : undefined,
          toolStatus: 'done',
          finishReason: readFinishReason(msg),
          runMarker: readRunMarker(msg),
        })
      }
      if (!msg.run_usage) continue
    }

    // Tool result messages. MoA display rows are persisted with role "moa"
    // so they can render as tool lines without becoming model-context tool results.
    if (msg.role === 'tool' || isPersistedMoaToolDisplay(msg)) {
      const tcId = msg.tool_call_id || ''
      const exactPlaceholderIdx = result.findIndex(m =>
        m.role === 'tool'
        && m.toolCallId === tcId
        && !m.toolResult
        && normalizedRunMarker(m) === normalizedRunMarker(msg),
      )
      const placeholderIdx = exactPlaceholderIdx !== -1
        ? exactPlaceholderIdx
        : result.findIndex(m =>
            m.role === 'tool'
            && m.toolCallId === tcId
            && !m.toolResult
            && normalizedRunMarker(m) === null,
          )
      const placeholder = placeholderIdx !== -1 ? result[placeholderIdx] : undefined
      const toolName = msg.tool_name || getToolMetadata(toolNameMap, msg, tcId) || placeholder?.toolName || undefined
      const toolArgs = getToolMetadata(toolArgsMap, msg, tcId) ?? placeholder?.toolArgs
      const toolReasoning = getToolMetadata(toolReasoningMap, msg, tcId) || placeholder?.reasoning
      const moaPayload = parsePersistedMoaToolPayload(toolName, (msg as any).content)
      const backgroundDelegate = isBackgroundDelegateToolPayload(toolName, (msg as any).content)
      const delegatePayload = toolName === 'delegate_task'
        ? runtimeObjectPayload(msg.display_content) || runtimeObjectPayload((msg as any).content)
        : null
      // Extract a short preview from the content
      let preview = moaPayload?.preview || ''
      const contentText = runtimePayloadText((msg as any).content)
      if (!preview && contentText) {
        try {
          const parsed = typeof (msg as any).content === 'string'
            ? JSON.parse(contentText)
            : (msg as any).content
          preview = parsed?.url || parsed?.title || parsed?.preview || parsed?.summary || ''
        } catch {
          preview = contentText.slice(0, 80)
        }
      }
      // Remove only the placeholder belonging to this run. Coding-agent CLIs
      // may reuse raw ids such as `item_2` on every resumed turn.
      if (placeholderIdx !== -1) {
        result.splice(placeholderIdx, 1)
      }
      if (delegatePayload?.runtime === 'ekko') {
        const subagentId = String(delegatePayload.subagent_id || '').trim()
        if (!subagentId) continue
        const delegateArgs = runtimeObjectPayload(toolArgs)
        const status = subagentStatus(delegatePayload.status)
        const taskIndex = Number(delegatePayload.task_index ?? 0)
        const taskCount = Math.max(1, Number(delegatePayload.task_count ?? 1) || 1)
        const goal = String(delegatePayload.goal || delegateArgs?.goal || '').trim()
        const summary = String(delegatePayload.summary || delegatePayload.output || '').trim()
        const label = `${Number.isFinite(taskIndex) ? taskIndex + 1 : 1}/${taskCount}`
        const durationMs = Number(delegatePayload.duration_ms)
        const restoredPayload = {
          ...delegatePayload,
          goal,
          duration_seconds: delegatePayload.duration_seconds
            ?? (Number.isFinite(durationMs) ? durationMs / 1000 : undefined),
        }
        result.push({
          id: String(msg.id),
          role: 'tool',
          content: '',
          timestamp: Math.round(msg.timestamp * 1000),
          toolName: 'delegate_task',
          toolCallId: `subagent:${subagentId}`,
          toolArgs,
          toolPreview: `${label}${summary ? ` · ${summary}` : goal ? ` · ${goal}` : ''}`.slice(0, 220),
          toolResult: restoredPayload,
          reasoning: toolReasoning,
          toolStatus: status === 'running' ? 'running' : status === 'completed' ? 'done' : 'error',
          finishReason: readFinishReason(msg),
          runMarker: readRunMarker(msg),
        })
        continue
      }
      if (delegatePayload?.runtime === 'hermes') {
        const persistedTasks = Array.isArray(delegatePayload.tasks)
          ? delegatePayload.tasks.filter(task => task && typeof task === 'object') as Array<Record<string, unknown>>
          : [delegatePayload]
        const restorableTasks = persistedTasks.filter(task => String(task.subagent_id || '').trim())
        if (restorableTasks.length > 0) {
          for (const [index, task] of restorableTasks.entries()) {
            const subagentId = String(task.subagent_id || '').trim()
            const status = subagentStatus(task.status)
            const taskIndex = Number(task.task_index ?? index)
            const taskCount = Math.max(1, Number(task.task_count ?? restorableTasks.length) || 1)
            const goal = String(task.goal || '').trim()
            const summary = String(task.summary || task.output || '').trim()
            const label = `${Number.isFinite(taskIndex) ? taskIndex + 1 : index + 1}/${taskCount}`
            result.push({
              id: `${String(msg.id)}:background:${Number.isFinite(taskIndex) ? taskIndex : index}`,
              role: 'tool',
              content: '',
              timestamp: Math.round(msg.timestamp * 1000),
              toolName: 'delegate_task',
              toolCallId: `subagent:${subagentId}`,
              toolArgs,
              toolPreview: `${label}${summary ? ` · ${summary}` : goal ? ` · ${goal}` : ''}`.slice(0, 220),
              toolResult: task,
              reasoning: toolReasoning,
              toolStatus: status === 'running' ? 'running' : status === 'completed' ? 'done' : 'error',
              finishReason: readFinishReason(msg),
              runMarker: readRunMarker(msg),
            })
          }
          continue
        }
      }
      if (backgroundDelegate && delegatePayload) {
        const baseId = tcId || String(msg.id)
        for (const task of backgroundDelegateTaskDescriptors(delegatePayload, toolArgs)) {
          const label = `${task.taskIndex + 1}/${task.taskCount}`
          result.push({
            id: `${String(msg.id)}:background:${task.taskIndex}`,
            role: 'tool',
            content: '',
            timestamp: Math.round(msg.timestamp * 1000),
            toolName: 'delegate_task',
            toolCallId: backgroundDelegateAnchorCallId(baseId, task.taskIndex),
            toolArgs,
            toolPreview: `${label}${task.goal ? ` · ${task.goal}` : ''}`.slice(0, 220),
            toolResult: {
              ...delegatePayload,
              runtime: 'hermes',
              task_index: task.taskIndex,
              task_count: task.taskCount,
              goal: task.goal,
            },
            reasoning: toolReasoning,
            toolStatus: 'done',
            finishReason: readFinishReason(msg),
            runMarker: readRunMarker(msg),
          })
        }
        continue
      }
      result.push({
        id: String(msg.id),
        role: 'tool',
        content: '',
        timestamp: Math.round(msg.timestamp * 1000),
        toolName,
        toolCallId: tcId || undefined,
        toolArgs,
        toolPreview: typeof preview === 'string' ? preview.slice(0, 100) || undefined : undefined,
        toolResult: moaPayload ? runtimeToolPayloadOrUndefined(moaPayload.result) : runtimeToolPayloadOrUndefined((msg as any).content),
        reasoning: toolReasoning,
        toolStatus: readFinishReason(msg) === 'error' ? 'error' : 'done',
        finishReason: readFinishReason(msg),
        runMarker: readRunMarker(msg),
      })
      continue
    }

    // A persisted compression renders as its own transcript entry rather than a
    // command bubble, so the same rounded card covers both the live notice and
    // the settled record.
    const compressionRecord = readCompressionRecord(msg)
    if (compressionRecord) {
      result.push({
        id: String(msg.id),
        role: 'system',
        content: msg.display_content ?? '',
        systemType: 'compression',
        compression: compressionRecord,
        timestamp: Math.round(msg.timestamp * 1000),
        isStreaming: false,
      })
      continue
    }

    // Normal user/assistant/command messages
    const displayRole = msg.display_role || msg.role
    const displayContent = msg.display_content ?? msg.content
    result.push({
      id: String(msg.id),
      // `compression` never reaches here -- readCompressionRecord consumes it
      // above -- but the fallback keeps the union honest if that ever changes.
      role: displayRole === 'moa' || displayRole === 'compression' ? 'system' : displayRole,
      content: displayContent || '',
      runUsage: normalizeRunUsage(msg.run_usage),
      timestamp: Math.round(msg.timestamp * 1000),
      reasoning: msg.reasoning ? msg.reasoning : undefined,
      systemType: displayRole === 'command' ? 'command' : undefined,
      finishReason: readFinishReason(msg),
      runMarker: readRunMarker(msg),
    })
  }
  const restored = mergeTaskPlanMessages(result, taskPlans)
  const restoredIds = new Set(restored.map(message => message.id))
  const merged = mergeTaskPlanMessages(restored, previous.filter(message => message.taskPlan && restoredIds.has(message.id)).map(message => message.taskPlan))
  return merged
}

function normalizeForDedup(s: string): string {
  return (s ?? '').replace(/\s+/g, ' ').trim()
}

function isDuplicateAssistantContent(
  msgs: Message[],
  role: Message['role'],
  content: string,
  ts: number,
  windowSec = 300,
): boolean {
  const norm = normalizeForDedup(content)
  if (!norm) return false
  // Only assistant replies are deduped; user messages are never dropped
  // (re-sending after a network failure is legitimate) and tool messages may
  // legitimately repeat the same preview.
  if (role !== 'assistant') return false
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    if (m.role !== role) {
      const dt = (ts - (m.timestamp || 0)) / 1000
      if (dt > windowSec) break
      continue
    }
    const prevNorm = normalizeForDedup(m.content)
    if (!prevNorm) continue
    const dt = (ts - (m.timestamp || 0)) / 1000
    if (dt < 0 || dt >= windowSec) {
      if (dt >= windowSec) break
      continue
    }
    if (
      prevNorm === norm ||
      (prevNorm.length > 20 &&
        norm.length > 20 &&
        (norm.startsWith(prevNorm) || prevNorm.startsWith(norm)))
    ) {
      return true
    }
    break
  }
  return false
}

/**
 * The one number a session is ordered by: when its newest message landed.
 *
 * `ended_at` is deliberately NOT part of it. `ended_at` is when the *run* closed,
 * which is strictly later than its last message whenever the finalization does
 * work that emits no message — a deliberate settle delay, usage accounting, and
 * a goal-evaluation LLM call that may run for up to two minutes. Sorting by it
 * made a session that finished at 23:00 outrank one whose last message arrived at
 * 20:30, even though the transcript plainly shows which was more recent.
 *
 * Activity time has exactly one meaning on the server: `last_active` is derived
 * from the newest persisted message. `started_at` is only a fallback for a
 * session that has no messages at all.
 */
function sessionActivitySeconds(s: SessionSummary): number {
  return s.last_active || s.started_at || 0
}

function lastVisibleMessage(messages?: Message[] | null): Message | null {
  if (!messages?.length) return null
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message.role !== 'user' && message.role !== 'assistant') continue
    if (!String(message.content || '').trim()) continue
    return message
  }
  return null
}

function lastVisibleMessageContent(messages?: Message[] | null): string | null {
  const message = lastVisibleMessage(messages)
  if (!message) return null
  const content = String(message.content || '').replace(/\s+/g, ' ').trim()
  return content.length > 280 ? `${content.slice(0, 277)}...` : content
}

function lastVisibleMessageRole(messages?: Message[] | null): string | null {
  return lastVisibleMessage(messages)?.role || null
}

function applySessionTokenUsage(session: Session, usage: {
  inputTokens?: number | null; outputTokens?: number | null
  cacheReadTokens?: number | null; cacheWriteTokens?: number | null; contextTokens?: number | null
}) {
  for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'contextTokens'] as const) {
    const value = usage[key]
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) session[key] = value
  }
}

function mapHermesSession(s: SessionSummary): Session {
  const codingAgentId = agentToCodingAgentId(s.agent)
  const isCodingAgentSession = s.source === 'coding_agent' || Boolean(codingAgentId)
  const codingAgentMode = isCodingAgentSession
    ? (s.agent_mode === 'global' || s.agent_mode === 'scoped'
        ? s.agent_mode
        : s.provider === 'global' ? 'global' : 'scoped')
    : undefined
  const activitySeconds = sessionActivitySeconds(s)
  return {
    id: s.id,
    profile: s.profile || 'default',
    title: s.title || '',
    source: s.source || undefined,
    agent: s.agent || undefined,
    agentSessionId: s.agent_session_id || undefined,
    agentNativeSessionId: s.agent_native_session_id || undefined,
    codingAgentId,
    codingAgentMode,
    messages: [],
    createdAt: Math.round(s.started_at * 1000),
    updatedAt: Math.round(activitySeconds * 1000),
    model: s.model,
    provider: s.provider || (s as any).billing_provider || '',
    apiMode: s.api_mode,
    agentPreset: s.agent_preset || undefined,
    reasoningEffort: s.reasoning_effort || undefined,
    messageCount: s.message_count,
    messageTotal: s.message_count,
    loadedMessageCount: 0,
    hasMoreBefore: false,
    inputTokens: s.input_tokens,
    outputTokens: s.output_tokens,
    cacheReadTokens: s.cache_read_tokens,
    cacheWriteTokens: s.cache_write_tokens,
    endedAt: s.ended_at != null ? Math.round(s.ended_at * 1000) : null,
    parentSessionId: s.parent_session_id || null,
    forkPointMessageId: (s as any).fork_point_message_id != null ? String((s as any).fork_point_message_id) : null,
    parentTitle: s.parent_title || null,
    parentLastMessage: s.parent_last_message || null,
    parentLastMessageRole: s.parent_last_message_role || null,
    lastActiveAt: s.last_active != null ? Math.round(s.last_active * 1000) : undefined,
    isPinned: Boolean(s.is_pinned),
    isArchived: Boolean(s.is_archived),
    pushEnabled: Boolean(s.push_enabled),
    workspace: s.workspace || null,
    categoryId: s.category_id ?? null,
  }
}

const STORAGE_KEY_PREFIX = 'hermes_active_session_'
type ChatRuntimeMode = 'default' | 'global_agent'
let activeRuntimeMode: ChatRuntimeMode = 'default'
const LEGACY_STORAGE_KEY = 'hermes_active_session'
const SESSION_PROFILE_FILTER_STORAGE_KEY = 'hermes_session_profile_filter_v1'

// 获取当前 profile 名称，用于隔离缓存。
// 从 profiles store 的 activeProfileName（同步 localStorage）读取，
// 避免异步加载导致 chat store 初始化时拿到 null。
function getProfileName(): string {
  try {
    return useProfilesStore().activeProfileName || 'default'
  } catch {
    return 'default'
  }
}

function runtimeStoragePrefix(): string {
  return activeRuntimeMode === 'global_agent' ? `${STORAGE_KEY_PREFIX}global_agent_` : STORAGE_KEY_PREFIX
}

function storageKey(): string { return runtimeStoragePrefix() + getProfileName() }
function legacyStorageKey(): string | null { return activeRuntimeMode === 'default' && getProfileName() === 'default' ? LEGACY_STORAGE_KEY : null }

function isCodingAgentLikeSession(session?: Pick<Session, 'source' | 'agent' | 'codingAgentId'> | null): boolean {
  return session?.source === 'coding_agent' ||
    Boolean(session?.codingAgentId) ||
    Boolean(agentToCodingAgentId(session?.agent))
}

function clearCodingAgentRuntimeCredentials(session?: Session | null) {
  if (!session || !isCodingAgentLikeSession(session)) return
  session.baseUrl = undefined
  session.apiKey = undefined
}

function shouldPreserveRuntimeApiMode(session?: Session | null): boolean {
  return isCodingAgentLikeSession(session) && session?.codingAgentMode !== 'global'
}

function isQuotaExceededError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const e = error as { name?: string, code?: number }
  return e.name === 'QuotaExceededError' || e.code === 22 || e.code === 1014
}

function recoverStorageQuota() {
  try {
    // 清理所有会话相关的旧缓存（已完全废弃）
    const prefixes = [
      'hermes_sessions_cache_v1_',
      'hermes_session_msgs_v1_',
      'hermes_session_pins_v1_',
      'hermes_human_only_v1_',
      // Failures are persisted by the server as `role: 'error'` now, so the
      // per-browser mirror of them has no reader left. Drop it rather than
      // leaving a stale copy of a failure in every open browser forever.
      'hermes_local_errors_v1_',
    ]
    const keysToRemove: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key) continue
      if (key === storageKey() || key === LEGACY_STORAGE_KEY) continue
      if (prefixes.some(prefix => key.startsWith(prefix))) {
        keysToRemove.push(key)
      }
    }
    keysToRemove.forEach(key => removeItem(key))
    if (keysToRemove.length > 0) {
      console.log(`Recovered storage: cleared ${keysToRemove.length} old session cache entries`)
    }
  } catch {
    // ignore
  }
}

function setItemBestEffort(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
    return
  } catch (error) {
    if (!isQuotaExceededError(error)) return
  }

  recoverStorageQuota()

  try {
    localStorage.setItem(key, value)
  } catch {
    // quota exceeded or private mode — ignore, cache is best-effort
  }
}

function getItemBestEffort(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function removeItem(key: string) {
  try {
    localStorage.removeItem(key)
  } catch {
    // ignore
  }
}

// Run errors exist only in the client transcript: the server never stores them.
// They used to vanish on the next re-fetch (session switch, tab focus, resume)
// because the transcript was replaced wholesale. In-memory rows cover those
// paths; a small localStorage mirror also covers a page reload.
// Strip the circular `file: File` reference from attachments before caching —
// File objects don't serialize and we only need name/type/size/url for display.

export const useChatStore = defineStore('chat', () => {
  const runtimeMode = ref<ChatRuntimeMode>(activeRuntimeMode)
  const seenSessionCommandEvents = new WeakSet<RunEvent>()
  const sessions = ref<Session[]>([])
  const activeSessionId = ref<string | null>(null)
  const focusMessageId = ref<string | null>(null)
  /**
   * Everything this client knows about one session's run, in one record.
   *
   * This replaces five parallel maps keyed by session id -- `streamStates`,
   * `serverWorking`, `runStates`, `backgroundPendingBySession`, `runStartedAt` --
   * plus the run id. They all described one thing, which is why every
   * disagreement between them was invisible: a reader that consulted three of
   * the five answered differently from one that consulted two, and which fields
   * had to be cleared on a terminal event depended on which had been written.
   *
   * The reported symptoms were all this shape. A ring stayed lit because
   * `reconcileSessionIdle` cleared three of the six and left `runStates` holding
   * `running`, which no reader ever withdrew. A stop named a run that
   * had already been replaced because the id was only recorded where the flag was
   * first set. A snapshot entry that said `idle` lit the ring because membership
   * of the snapshot was read as "busy".
   *
   * One record per session, one writer, one reader.
   */
  interface SessionRun {
    /** As the server reported it. `idle` means the server says nothing runs. */
    phase: RunState
    /** The run this describes, when the server named one. */
    runId?: string
    /** When the run began, as the server reported it. Drives the elapsed clock. */
    startedAt?: number
    /** Live delegations. Not part of `phase`: a delegation outlives its run. */
    delegations: number
    /** A stream this client attached, with the abort handle that detaches it. */
    stream?: { abort: () => void | boolean }
  }

  const sessionRuns = ref<Map<string, SessionRun>>(new Map())

  const EMPTY_SESSION_RUN: SessionRun = { phase: 'idle', delegations: 0 }

  function sessionRunFor(sessionId: string | null | undefined): SessionRun {
    const sid = sessionId || ''
    return (sid ? sessionRuns.value.get(sid) : undefined) || EMPTY_SESSION_RUN
  }

  function sameSessionRun(a: SessionRun | undefined, b: SessionRun): boolean {
    return Boolean(a)
      && a!.phase === b.phase
      && a!.runId === b.runId
      && a!.startedAt === b.startedAt
      && a!.delegations === b.delegations
      && a!.stream === b.stream
  }

  /**
   * The only writer of run state.
   *
   * Fields absent from `patch` keep their current value, so a caller that knows
   * about only one of them cannot erase the others by omission -- which is how
   * `reconcileSessionIdle` used to leave the phase behind and hold the ring lit
   * with nothing under it.
   */
  function patchSessionRun(sessionId: string | null | undefined, patch: Partial<SessionRun>): void {
    const sid = sessionId || ''
    if (!sid) return
    const current = sessionRuns.value.get(sid)
    const next: SessionRun = {
      phase: patch.phase ?? current?.phase ?? 'idle',
      runId: 'runId' in patch ? patch.runId : current?.runId,
      startedAt: 'startedAt' in patch ? patch.startedAt : current?.startedAt,
      delegations: patch.delegations ?? current?.delegations ?? 0,
      stream: 'stream' in patch ? patch.stream : current?.stream,
    }
    // An entry that says nothing is removed, so `has` reads as "this session has
    // something to report" rather than "this session was mentioned once".
    const empty = next.phase === 'idle' && !next.stream && next.delegations <= 0 && !next.startedAt
    if (empty) {
      if (!current) return
      const copy = new Map(sessionRuns.value)
      copy.delete(sid)
      sessionRuns.value = copy
      return
    }
    if (sameSessionRun(current, next)) return
    sessionRuns.value = new Map(sessionRuns.value).set(sid, next)
  }

  /** Adopt a run: the server reports it as running, or this client just started one. */
  function markSessionRunning(sessionId: string, startedAt?: number): void {
    patchSessionRun(sessionId, {
      phase: 'running',
      ...(startedAt && startedAt > 0 ? { startedAt } : {}),
    })
  }

  /**
   * Record that this client is following the run, with the handle that stops it.
   *
   * Attaching a stream is not the same as learning the run is live: the bridge
   * path attaches one for a run it already knows about, and `ensureAbortHandle`
   * attaches one to a session the resume already reported as working. It only
   * records the handle.
   */
  function attachSessionStream(sessionId: string, stream: { abort: () => void | boolean }): void {
    patchSessionRun(sessionId, { stream })
  }

  /**
   * Converge a session to idle, clearing every field a reader could hold.
   *
   * `delegations` deliberately survives: a delegation is not part of the run and
   * can outlive it, and the snapshot is what settles that count.
   */
  function markSessionIdle(sessionId: string | null | undefined): void {
    patchSessionRun(sessionId, {
      phase: 'idle',
      runId: undefined,
      startedAt: undefined,
      stream: undefined,
    })
  }

  /**
   * Read-only views of `sessionRuns`, for the callers that only look.
   *
   * Nothing writes through these any more. They are derived, so they cannot
   * drift from the record they describe.
   */
  const serverWorking = computed<Set<string>>(() => new Set(
    [...sessionRuns.value].filter(([, run]) => run.phase === 'running').map(([sid]) => sid),
  ))

  const streamStates = computed<Map<string, { abort: () => void | boolean }>>(() => {
    const out = new Map<string, { abort: () => void | boolean }>()
    for (const [sid, run] of sessionRuns.value) if (run.stream) out.set(sid, run.stream)
    return out
  })

  /** Authoritative live delegation counts, never inferred from transcript history. */
  const backgroundPendingBySession = computed<Map<string, number>>(() => {
    const out = new Map<string, number>()
    for (const [sid, run] of sessionRuns.value) if (run.delegations > 0) out.set(sid, run.delegations)
    return out
  })
  let runtimeGeneration = 0
  const backgroundObservers = new Map<string, () => void>()

  function clearBackgroundObservers() {
    for (const dispose of backgroundObservers.values()) dispose()
    backgroundObservers.clear()
    for (const sid of [...sessionRuns.value.keys()]) {
      if ((sessionRuns.value.get(sid)?.delegations || 0) > 0) patchSessionRun(sid, { delegations: 0 })
    }
  }

  const unsubscribeAuthInvalidation = onAuthInvalidated(() => {
    runtimeGeneration += 1
    clearBackgroundObservers()
    // A new generation starts from nothing: keeping any part of the previous one
    // is what let a stale flag outlive the profile or mode it belonged to.
    sessionRuns.value = new Map()
  })

  onScopeDispose(() => {
    unsubscribeAuthInvalidation()
    runtimeGeneration += 1
    clearBackgroundObservers()
  })

  function setBackgroundPending(sessionId: string, pending: unknown) {
    const count = Number(pending)
    if (Number.isFinite(count) && count > 0) {
      const session = sessions.value.find(s => s.id === sessionId)
      if (!session) return
      patchSessionRun(sessionId, { delegations: count })
      if (!backgroundObservers.has(sessionId)) {
        const generation = runtimeGeneration
        backgroundObservers.set(sessionId, observeBackgroundStatus(
          sessionId, session.profile || 'default', runtimeTransport(),
          pending => {
            if (generation === runtimeGeneration) setBackgroundPending(sessionId, pending)
          },
        ))
      }
    } else {
      patchSessionRun(sessionId, { delegations: 0 })
      backgroundObservers.get(sessionId)?.()
      backgroundObservers.delete(sessionId)
    }
  }

  function applyBackgroundPendingEvent(sessionId: string, evt: RunEvent) {
    if (evt.background_pending != null || evt.event === 'run.completed' || evt.event === 'run.failed' || evt.event === 'abort.completed') {
      setBackgroundPending(sessionId, evt.background_pending)
    }
  }
  /** sessionIds with a terminal /fork command submitted but not settled yet */
  const pendingForkCommands = ref<Set<string>>(new Set())
  /** Sessions that completed while the user was viewing another session. */
  const completedUnreadSessions = ref<Set<string>>(new Set())
  /** UI-only live streams for Hermes background subagents. Never sent into parent context. */
  const subagentStreams = ref<Map<string, SubagentStream>>(new Map())
  const storedSessionProfileFilter = getItemBestEffort(SESSION_PROFILE_FILTER_STORAGE_KEY)?.trim()
  // Filter out invalid values like 'null', 'undefined', '__all__'
  const isValidProfile = storedSessionProfileFilter
    && storedSessionProfileFilter !== 'null'
    && storedSessionProfileFilter !== 'undefined'
    && storedSessionProfileFilter !== '__all__'
  const sessionProfileFilter = ref<string | null>(
    isValidProfile ? storedSessionProfileFilter : null,
  )
  /** sessionId → queued message count */
  /**
   * When the run showing in each session began, as the server reported it.
   * A client that opens the page mid-run needs this: without it the thinking
   * timer counts from its own first render and restarts on every navigation.
   */
  const runStartedAt = computed<Map<string, number>>(() => {
    const out = new Map<string, number>()
    for (const [sid, run] of sessionRuns.value) if (run.startedAt) out.set(sid, run.startedAt)
    return out
  })

  /**
   * Recording when a run began is the same act as learning it is running, so
   * this sets the phase too. Callers used to pair it with a separate
   * `serverWorking.add`, which is the duplication this record removes: a start
   * time without a running phase is a run the ring would never light for.
   */
  function setRunStartedAt(sessionId: string, startedAt: number) {
    if (!sessionId || !(startedAt > 0)) return
    markSessionRunning(sessionId, startedAt)
  }

  /** Forget the run clock without changing what is known about the run. */
  function clearRunStartedAt(sessionId: string) {
    if (!sessionId || !sessionRuns.value.get(sessionId)?.startedAt) return
    patchSessionRun(sessionId, { startedAt: undefined })
  }

  /**
   * Converge every local "this run is still active" signal to idle, using the
   * authoritative answer from the server.
   *
   * `isStreaming` is an OR over several independent sources
   * (streamStates, serverWorking, live subagent streams), so clearing only one
   * of them leaves the session permanently busy: the header keeps showing
   * "thinking", and the next send is treated as live and gets queued instead of
   * dispatched. This is the single idempotent place that clears all of them.
   *
   * Safe to call repeatedly and from any resume path.
   */
  function reconcileSessionIdle(sessionId: string | null | undefined) {
    const sid = sessionId || ''
    if (!sid) return
    // Every field, not the three this used to reach: leaving `runStates` holding
    // `running` meant the phase outlived the run entirely, so the ring stayed
    // lit after reconciling with nothing behind it.
    markSessionIdle(sid)
    setAbortState(sid, null)
    // Clear per-message spinner state even when the payload carried no messages
    // (short runs), and settle any tool row left mid-flight.
    const msgs = getSessionMsgs(sid)
    msgs.forEach(m => {
      if (m.role === 'assistant' && m.isStreaming) {
        updateMessage(sid, m.id, { isStreaming: false })
      }
    })
    msgs.forEach((m, i) => {
      if (m.role === 'tool' && m.toolStatus === 'running' && !m.toolCallId?.startsWith('subagent:')) {
        msgs[i] = { ...m, toolStatus: 'done' }
      }
    })
    // A run-scoped compression cannot outlive its run, so an idle session is
    // proof that a lingering "Compressing..." banner lost its completion event.
    settleStaleCompression(sid)
  }

  /**
   * Every resume path has to agree about the run clock, and every terminal path
   * has to forget it — otherwise the next run in the same session inherits the
   * previous run's start and reports a far larger elapsed time.
   */
  function applyResumedRunActivity(sessionId: string, data: { isWorking?: boolean; runStartedAt?: number; backgroundPending?: number }) {
    setBackgroundPending(sessionId, data.backgroundPending)
    const startedAt = Number(data?.runStartedAt) || 0
    if (data?.isWorking && startedAt > 0) setRunStartedAt(sessionId, startedAt)
    else clearRunStartedAt(sessionId)
  }
  const queueLengths = ref<Map<string, number>>(new Map())
  /** sessionId → queued user messages not yet visible in the transcript */
  const queuedUserMessages = ref<Map<string, Message[]>>(new Map())
  /** sessionId → server-owned safe-boundary insertion state */
  const queueInsertionStates = ref<Map<string, QueueInsertionState>>(new Map())
  /** sessionId → queue ids that server reported as dequeued before the peer message arrived */
  const dequeuedQueueIds = ref<Map<string, Set<string>>>(new Map())
  /** sessionId → message selected as the reference for the next user turn */
  const messageReferences = ref<Map<string, MessageReference>>(new Map())
  const activeMessageReference = computed(() => {
    const sid = activeSessionId.value
    return sid ? messageReferences.value.get(sid) || null : null
  })
  const pendingApprovals = ref<Map<string, PendingApproval>>(new Map())
  const pendingApprovalResponseIds = new Map<string, string>()
  const activePendingApproval = computed(() => {
    const sid = activeSessionId.value
    return sid ? pendingApprovals.value.get(sid) || null : null
  })

  const pendingClarifies = ref<Map<string, PendingClarify>>(new Map())
  const pendingClarifyResponseIds = new Map<string, string>()
  const activePendingClarify = computed(() => {
    const sid = activeSessionId.value
    return sid ? pendingClarifies.value.get(sid) || null : null
  })

  function setSessionProfileFilter(profile: string | null) {
    const normalized = profile?.trim()
    sessionProfileFilter.value = normalized && normalized !== '__all__' ? normalized : null
    if (sessionProfileFilter.value) {
      setItemBestEffort(SESSION_PROFILE_FILTER_STORAGE_KEY, sessionProfileFilter.value)
    } else {
      removeItem(SESSION_PROFILE_FILTER_STORAGE_KEY)
    }
  }

  function validateSessionProfileFilter(profileNames: string[]) {
    const current = sessionProfileFilter.value
    if (!current || profileNames.length === 0 || profileNames.includes(current)) return
    setSessionProfileFilter(null)
  }

  // History page's own profile filter — independent from the main chat list.
  // Mirrors `setSessionProfileFilter` but with its own storage key so the two
  // filters don't interfere with each other.
  const HISTORY_PROFILE_FILTER_STORAGE_KEY = 'hermes_history_profile_filter'
  const storedHistoryProfileFilter = getItemBestEffort(HISTORY_PROFILE_FILTER_STORAGE_KEY)?.trim()
  const isValidHistoryProfile = storedHistoryProfileFilter
    && storedHistoryProfileFilter !== 'null'
    && storedHistoryProfileFilter !== 'undefined'
    && storedHistoryProfileFilter !== '__all__'
    && storedHistoryProfileFilter !== 'all'
  const historySessionProfileFilter = ref<string | null>(
    isValidHistoryProfile ? storedHistoryProfileFilter : null,
  )
  function setHermesSessionProfileFilter(profile: string | null) {
    const normalized = profile?.trim()
    historySessionProfileFilter.value = normalized && normalized !== '__all__' && normalized !== 'all'
      ? normalized
      : null
    if (historySessionProfileFilter.value) {
      setItemBestEffort(HISTORY_PROFILE_FILTER_STORAGE_KEY, historySessionProfileFilter.value)
    } else {
      removeItem(HISTORY_PROFILE_FILTER_STORAGE_KEY)
    }
  }

  // 自动播放语音开关
  const autoPlaySpeechEnabled = ref(false)

  function setAutoPlaySpeech(enabled: boolean) {
    autoPlaySpeechEnabled.value = enabled
  }
  const isStreaming = computed(() => {
    const sid = activeSessionId.value
    if (sid == null) return false
    if (streamStates.value.has(sid) || serverWorking.value.has(sid)) return true
    // Background delegations (e.g.绘画 via delegate_task background) run
    // outside isWorking — check live subagent streams for this session.
    for (const s of subagentStreams.value.values()) {
      if (s.sessionId === sid && s.status === 'running') return true
    }
    return false
  })
  const isForkPending = computed(() => {
    const sid = activeSessionId.value
    return sid != null && pendingForkCommands.value.has(sid)
  })
  const isLoadingSessions = ref(false)
  // In-flight mutexes for the background live-sync paths (12s tick,
  // visibilitychange). Skip-style: a colliding refresh is dropped and the next
  // tick re-runs it — both operations are idempotent reads.
  let sessionListRefreshInFlight = false
  let liveMessageSyncInFlight = false
  const sessionsLoaded = ref(false)
  const messageLoadRequests = ref<Map<string, number>>(new Map())
  const isLoadingMessages = computed(() => {
    const sid = activeSessionId.value
    return sid ? messageLoadRequests.value.has(sid) : false
  })
  const isRunActive = computed(() => isStreaming.value)
  let loadSessionsRequestSequence = 0
  let switchSessionRequestSequence = 0
  const olderMessageLoads = new WeakMap<Session, object>()
  let activeSelectionSequence = 0
  const reasoningEffortWriteChains = new Map<string, Promise<boolean>>()
  const reasoningEffortWriteTargets = new Map<string, string | undefined>()
  const reasoningEffortConfirmedValues = new Map<string, string | undefined>()
  const pushEnabledWriteChains = new Map<string, Promise<boolean>>()
  const pushEnabledWriteTargets = new Map<string, boolean>()
  const pushEnabledConfirmedValues = new Map<string, boolean>()

  function beginMessageLoad(sessionId: string, requestSequence: number) {
    const next = new Map(messageLoadRequests.value)
    next.set(sessionId, requestSequence)
    messageLoadRequests.value = next
  }

  function endMessageLoad(sessionId: string, requestSequence: number) {
    if (messageLoadRequests.value.get(sessionId) !== requestSequence) return
    const next = new Map(messageLoadRequests.value)
    next.delete(sessionId)
    messageLoadRequests.value = next
  }

  async function fetchRuntimeSessions(profile?: string | null): Promise<SessionSummary[]> {
    const scopedProfile = profile || undefined
    if (runtimeMode.value === 'global_agent') return fetchSessions('global_agent', undefined, scopedProfile)

    const [localSessions, globalSessions] = await Promise.all([
      fetchSessions(undefined, undefined, scopedProfile),
      fetchSessions('global_agent', undefined, scopedProfile),
    ])
    // Local (webui DB) is authoritative for the same session: it stores the
    // canonical provider id (custom:llmux), while the CLI-side global store
    // keeps the legacy bare "custom" + base_url form. Merging global-over-local
    // corrupted provider to "custom", which then fails to match any provider
    // group in the model picker (=> no highlight / looks like a reset).
    const byId = new Map<string, SessionSummary>()
    for (const session of [...globalSessions, ...localSessions]) byId.set(session.id, session)
    return [...byId.values()].sort((a, b) =>
      sessionActivitySeconds(b) - sessionActivitySeconds(a),
    )
  }

  function runtimeTransport(): ChatRunTransport {
    return runtimeMode.value === 'global_agent' ? 'global-agent' : 'chat-run'
  }

  function setRuntimeMode(mode: ChatRuntimeMode) {
    if (runtimeMode.value === mode) return
    activeRuntimeMode = mode
    runtimeMode.value = mode
    runtimeGeneration += 1
    clearBackgroundObservers()
    sessions.value = []
    pendingRunUsage.clear()
    completedUnreadSessions.value = new Set()
    queueLengths.value = new Map()
    queuedUserMessages.value = new Map()
    queueInsertionStates.value = new Map()
    pendingApprovals.value = new Map()
    pendingClarifies.value = new Map()
    pendingApprovalResponseIds.clear()
    pendingClarifyResponseIds.clear()
    sessionRuns.value = new Map()
    pendingForkCommands.value = new Set()
    workspaceRunChangesBySession.value = new Map()
    abortWatchdogs.clear()
    abortStates.value = new Map()
    sessionsLoaded.value = false
    clearActiveSession()
  }

  // Compression state is scoped per session because sockets can stay joined to
  // background sessions while another chat is active.
  /**
   * Command names of the skills loaded for this session, used to decide whether a
   * bare `/name` is a skill invocation before the Agent sees it. Populated by the
   * composer's skills fetch; a miss here means the text goes through as prose,
   * which is exactly the failure this exists to prevent.
   */
  const knownSkillCommandNames = ref<Set<string>>(new Set())
  function setKnownSkillCommandNames(sessionId: string | null | undefined, names: string[]) {
    if (!sessionId) return
    knownSkillCommandNames.value = new Set(names.map(name => skillCommandName(name)).filter(Boolean))
  }

  const compressionStates = ref<Map<string, CompressionState>>(new Map())
  const compressionState = computed<CompressionState | null>(() => {
    const sid = activeSessionId.value
    return sid ? compressionStates.value.get(sid) || null : null
  })

  function setCompressionState(sessionId: string | null | undefined, state: CompressionState | null) {
    if (!sessionId) return
    const next = new Map(compressionStates.value)
    if (state) next.set(sessionId, state)
    else next.delete(sessionId)
    compressionStates.value = next
    // Mirrors the live banner into the transcript on every path (socket events,
    // resume snapshot, stale settle). Recording here rather than at each call
    // site is deliberate: the reconcile paths matter most, since they are the
    // ones a client that missed the live event depends on.
    //
    // A cleared state deliberately leaves its transcript entry alone. Clearing
    // means "stop tracking this", not "it never happened" -- a compression
    // permanently drops context, so the record has to outlive the run indicator.
    //
    if (state) recordCompressionEntry(sessionId, state)
  }

  /**
   * Writes a compression into the transcript as a real entry, positioned by the
   * time it began rather than the time the event arrived.
   *
   * Compression used to render inside the run indicator only, which meant two
   * losses: it vanished the moment the run settled (the indicator's condition is
   * isRunActive || abortState), and it was absent from any re-fetched
   * transcript. Both matter because a compression permanently discards context --
   * a user scrolling back has to be able to see that it happened, and where.
   *
   * Not persisted: the server does not replay compression entries, so a refresh
   * can lose them. That is deliberate -- the authoritative snapshot only carries
   * the *latest* compression, which is enough to stop the UI claiming a finished
   * compression is still running, but not enough to rebuild history.
   *
   * Keyed on `startedAt` so a re-delivered event updates its entry in place
   * instead of stacking duplicates.
   */
  function recordCompressionEntry(sessionId: string | null | undefined, state: CompressionState) {
    const sid = sessionId || ''
    if (!sid) return
    const startedAt = state.startedAt || Date.now()
    const session = sessions.value.find(item => item.id === sid)
    if (!session) return
    const id = `compression:${sid}:${startedAt}`
    const entry: Message = {
      id,
      role: 'system',
      content: '',
      timestamp: startedAt,
      systemType: 'compression',
      compression: { ...state, startedAt },
    }
    // Keyed on startedAt, which is also how the server persists the row. So once
    // the persisted row arrives on a resume it replaces this live entry in place
    // instead of appearing beside it -- "Compressing..." becomes the settled
    // record rather than turning into two lines.
    //
    // Every match is collapsed, not just the first: the live entry and the server
    // row both carry this startedAt, and replacing only one of them would leave
    // the duplicate this is meant to prevent.
    const matches = session.messages
      .map((message, index) => ({ message, index }))
      .filter(({ message }) => message.id === id || message.compression?.startedAt === startedAt)
    if (matches.length) {
      // Prefer a server row's identity so the transcript matches what the next
      // re-fetch produces.
      const persisted = matches.find(({ message }) => message.compression?.compressing === false)
      const at = matches[0].index
      const keepId = persisted?.message.id ?? matches[0].message.id
      for (let i = matches.length - 1; i >= 1; i -= 1) session.messages.splice(matches[i].index, 1)
      session.messages.splice(at, 1, { ...entry, id: keepId })
      return
    }
    // Later messages already carry timestamps past the compression start, so the
    // entry has to land between them rather than at the tail.
    const insertAt = session.messages.findIndex(message => message.timestamp > startedAt)
    if (insertAt === -1) session.messages.push(entry)
    else session.messages.splice(insertAt, 0, entry)
  }

  /**
   * Stops claiming a run-scoped compression is still running once its run is
   * over. `compression.completed` is a single socket event: when it is lost
   * (session switched away mid-compression, reconnect, dropped frame) the
   * banner used to say "Compressing..." forever. The compression did happen, so
   * keep that fact but drop the live claim (`compressed: null` renders as
   * "Compression finished").
   */
  function settleStaleCompression(sessionId: string | null | undefined) {
    const sid = sessionId || ''
    if (!sid) return
    const current = compressionStates.value.get(sid)
    if (!current?.compressing) return
    // `/compress` runs while the session is idle, so an idle session says
    // nothing about it; it reports completion on its own.
    if (current.source === 'command') return
    setCompressionState(sid, { ...current, compressing: false, compressed: null })
  }

  /**
   * Collapses the live entry into the persisted row once a re-fetch brings it.
   *
   * `recordCompressionEntry` only merges when a compression *event* arrives, so a
   * resume that replaces the message list could leave the client-injected live
   * entry sitting beside the server row for the same compression. Both carry the
   * same `startedAt`, which is the only reliable link between them: the live id
   * is synthetic and the server row keeps its own.
   */
  function mergePersistedCompressionEntries(sessionId: string | null | undefined) {
    const sid = sessionId || ''
    if (!sid) return
    const session = sessions.value.find(item => item.id === sid)
    if (!session) return
    const persisted = session.messages.filter(
      message => message.compression && message.compression.compressing === false,
    )
    if (!persisted.length) return
    for (const row of persisted) {
      const startedAt = row.compression!.startedAt
      if (startedAt == null) continue
      const liveIndex = session.messages.findIndex(
        message => message.id === `compression:${sid}:${startedAt}`,
      )
      if (liveIndex === -1) continue
      // Keep the server row's identity so the transcript matches what the next
      // re-fetch produces.
      session.messages.splice(liveIndex, 1, row)
    }
    // A persisted row that already landed keeps its own place; make sure no
    // second copy of the same compression is left behind anywhere in the list.
    const seen = new Set<number>()
    for (let index = session.messages.length - 1; index >= 0; index -= 1) {
      const startedAt = session.messages[index].compression?.startedAt
      if (startedAt == null) continue
      if (seen.has(startedAt)) session.messages.splice(index, 1)
      else seen.add(startedAt)
    }
  }

  /**
   * Reconciles the local banner with the server's authoritative snapshot. This
   * is what makes the state self-healing: every attach/refresh replaces whatever
   * the client believed with what actually happened.
   */
  function reconcileCompressionState(
    sessionId: string,
    snapshot: ResumeSessionPayload['compression'],
    isWorking: boolean,
  ) {
    if (snapshot) {
      const source = snapshot.source === 'command' ? 'command' : 'run'
      const live = snapshot.stage === 'started' && (source === 'command' || isWorking)
      setCompressionState(sessionId, {
        compressing: live,
        messageCount: snapshot.messageCount || 0,
        beforeTokens: snapshot.beforeTokens || 0,
        afterTokens: snapshot.afterTokens || 0,
        compressed: live ? null : (snapshot.compressed ?? null),
        error: snapshot.error,
        source,
        startedAt: snapshot.startedAt || Date.now(),
      })
      return
    }
    if (!isWorking) settleStaleCompression(sessionId)
  }

  // Abort state is scoped per session because background sockets remain active
  // while another conversation is selected.
  const abortStates = ref<Map<string, AbortState>>(new Map())
  const abortWatchdogs = new Map<string, ReturnType<typeof setTimeout>>()

  function clearAbortWatchdog(sessionId: string) {
    const timer = abortWatchdogs.get(sessionId)
    if (timer === undefined) return
    clearTimeout(timer)
    abortWatchdogs.delete(sessionId)
  }

  function setAbortState(sessionId: string | null | undefined, state: AbortState | null) {
    if (!sessionId) return
    clearAbortWatchdog(sessionId)
    if (state?.aborting) {
      abortWatchdogs.set(
        sessionId,
        setTimeout(() => {
          abortWatchdogs.delete(sessionId)
          if (!abortStates.value.get(sessionId)?.aborting) return
          setAbortState(sessionId, {
            aborting: false,
            synced: false,
            error: STOP_UNCONFIRMED_MESSAGE,
          })
        }, ABORT_WATCHDOG_MS),
      )
    }
    const next = new Map(abortStates.value)
    if (state) next.set(sessionId, state)
    else next.delete(sessionId)
    abortStates.value = next
  }

  const abortState = computed<AbortState | null>({
    get: () => {
      const sid = activeSessionId.value
      return sid ? abortStates.value.get(sid) || null : null
    },
    set: state => setAbortState(activeSessionId.value, state),
  })
  const isAborting = computed(() => abortState.value?.aborting === true)

  const activeSession = ref<Session | null>(null)
  const messages = computed<Message[]>(() => activeSession.value?.messages || [])
  const workspaceRunChangesBySession = ref<Map<string, Map<string, WorkspaceRunChangeSummary>>>(new Map())

  /**
   * Authoritative activity state, last seen from the server's periodic snapshot.
   *
   * `finishing` is deliberately NOT busy: by then `run.completed` has been
   * delivered, the remaining work (settle delay, usage accounting, goal
   * evaluation) emits no messages, and the server accepts new input rather than
   * queueing it. Showing a spinner there would contradict what the server is
   * actually willing to do.
   */
  function isSessionLive(sessionId: string): boolean {
    const run = sessionRuns.value.get(sessionId)
    if (!run) return false
    // Deliberately no clock of its own.
    //
    // There used to be one, and it was wrong in both directions. `run_started_at`
    // is when the run *began*, not when it was last heard from, so any window
    // unlit every run that outlived it: a session running for fourteen minutes
    // read exactly like a leaked flag and sat dark while a three-minute session
    // lit up beside it. Widening the window only moves which long run goes dark.
    //
    // What ends a run is the snapshot. It is the only writer of the phase, and it
    // withdraws one both when the server stops reporting the session and when the
    // server reports a phase that is not `running`. The poll runs whenever any
    // session holds a phase or a stream, so there is always something to correct
    // and the correction always arrives. A second clock on top could only
    // disagree with it.
    return run.phase === 'running' || Boolean(run.stream)
  }

  // Display activity is broader than foreground execution (send/queue/voice).
  function isSessionWorking(sessionId: string): boolean {
    return isSessionLive(sessionId) || (sessionRuns.value.get(sessionId)?.delegations || 0) > 0
  }

  function isSessionCompletedUnread(sessionId: string): boolean {
    return completedUnreadSessions.value.has(sessionId)
  }

  function clearSessionCompletedUnread(sessionId: string) {
    if (!completedUnreadSessions.value.has(sessionId)) return
    const next = new Set(completedUnreadSessions.value)
    next.delete(sessionId)
    completedUnreadSessions.value = next
  }

  function setMessageReference(sessionId: string, reference: MessageReference) {
    const next = new Map(messageReferences.value)
    next.set(sessionId, reference)
    messageReferences.value = next
  }

  function clearMessageReference(sessionId: string) {
    if (!messageReferences.value.has(sessionId)) return
    const next = new Map(messageReferences.value)
    next.delete(sessionId)
    messageReferences.value = next
  }

  function markSessionCompletedUnread(sessionId: string, hasQueue = false) {
    if (hasQueue) {
      return
    }
    if (activeSessionId.value === sessionId) {
      clearSessionCompletedUnread(sessionId)
      return
    }
    const next = new Set(completedUnreadSessions.value)
    next.add(sessionId)
    completedUnreadSessions.value = next
  }

  function pruneCompletedUnreadSessions(existingIds: Set<string>) {
    const next = new Set([...completedUnreadSessions.value].filter(id => existingIds.has(id)))
    if (next.size !== completedUnreadSessions.value.size) completedUnreadSessions.value = next
  }

  function clearActiveSession() {
    activeSelectionSequence++
    const sid = activeSessionId.value
    activeSessionId.value = null
    activeSession.value = null
    focusMessageId.value = null
    setAbortState(sid, null)
    setCompressionState(sid, null)
    removeItem(storageKey())
  }

  function attachWorkspaceChangesToMessages(sessionId: string) {
    const target = sessions.value.find(session => session.id === sessionId)
    if (!target) return
    const changes = workspaceRunChangesBySession.value.get(sessionId)
    target.messages = target.messages.filter(
      message => !message.id.startsWith(LEGACY_WORKSPACE_RUN_CHANGE_MESSAGE_PREFIX),
    )
    if (!changes) {
      for (const message of target.messages) message.workspaceChanges = []
      return
    }
    const runChanges = [...changes.values()].filter(change => change?.source === 'run')
    attachWorkspaceChangesToExactTurns(target.messages, runChanges)
  }

  function setWorkspaceRunChanges(sessionId: string, changes: WorkspaceRunChangeSummary[]) {
    const next = new Map(workspaceRunChangesBySession.value)
    const byChangeId = new Map<string, WorkspaceRunChangeSummary>()
    for (const change of changes) {
      if (change?.change_id) byChangeId.set(change.change_id, change)
    }
    next.set(sessionId, byChangeId)
    workspaceRunChangesBySession.value = next
    attachWorkspaceChangesToMessages(sessionId)
  }

  function mergeWorkspaceRunChanges(sessionId: string, changes: WorkspaceRunChangeSummary[]) {
    const next = new Map(workspaceRunChangesBySession.value)
    const byChangeId = new Map(next.get(sessionId) || [])
    for (const change of changes) {
      if (change?.change_id) byChangeId.set(change.change_id, change)
    }
    next.set(sessionId, byChangeId)
    workspaceRunChangesBySession.value = next
    attachWorkspaceChangesToMessages(sessionId)
  }

  function upsertWorkspaceRunChange(sessionId: string, change: WorkspaceRunChangeSummary | null | undefined) {
    if (!change?.change_id) return
    const next = new Map(workspaceRunChangesBySession.value)
    const current = new Map(next.get(sessionId) || [])
    current.set(change.change_id, change)
    next.set(sessionId, current)
    workspaceRunChangesBySession.value = next
    attachWorkspaceChangesToMessages(sessionId)
  }

  function handleWorkspaceRunChangeEvent(
    sessionId: string,
    evt: any,
    assistantMessageId?: string | null,
  ): string | null {
    const change = evt?.change as WorkspaceRunChangeSummary | undefined
    const target = sessions.value.find(session => session.id === sessionId)
    const alignedAssistantMessageId = target
      ? alignWorkspaceChangeAssistantMessage(target.messages, change, assistantMessageId)
      : assistantMessageId || null
    upsertWorkspaceRunChange(sessionId, change)
    return alignedAssistantMessageId
  }

  const pendingRunUsage = new Map<string, Map<string, NonNullable<ReturnType<typeof normalizeRunUsage>>>>()

  function handleTerminalWorkspaceRunChange(
    sessionId: string,
    evt: any,
    assistantMessageId?: string | null,
  ) {
    const change = evt?.workspace_run_change as WorkspaceRunChangeSummary | undefined
    const target = sessions.value.find(session => session.id === sessionId)
    if (target) alignWorkspaceChangeAssistantMessage(target.messages, change, assistantMessageId)
    upsertWorkspaceRunChange(sessionId, change)
    const originalSummary = normalizeRunUsage(evt?.run_usage)
    const summary = originalSummary && (pendingRunUsage.get(sessionId)?.get(originalSummary.runId) || originalSummary)
    if (summary) {
      pendingRunUsage.get(sessionId)?.delete(summary.runId)
      if (!pendingRunUsage.get(sessionId)?.size) pendingRunUsage.delete(sessionId)
    }
    if (target && summary) {
      let message = target.messages.find(m => m.role === 'assistant' && m.id === summary.assistantMessageId)
        || target.messages.find(m => m.role === 'assistant' && m.id === assistantMessageId)
      if (!message && summary.assistantMessageId) {
        message = { id: summary.assistantMessageId, role: 'assistant', content: '', timestamp: Date.now() }
        target.messages.push(message)
      }
      if (message) {
        if (summary.assistantMessageId && !target.messages.some(m => m !== message && m.id === summary.assistantMessageId)) message.id = summary.assistantMessageId
        message.runUsage = summary
      }
    }
  }

  async function loadWorkspaceRunChangeFile(sessionId: string, toolCallId: string, fileId: number): Promise<WorkspaceRunChangeFileDetail | null> {
    return fetchWorkspaceRunChangeFile(sessionId, toolCallId, fileId)
  }

  function ensureSessionLoaded(summary: SessionSummary): Session {
    const existing = sessions.value.find(session => session.id === summary.id)
    const mapped = mapHermesSession(summary)
    if (existing) {
      Object.assign(existing, {
        ...mapped,
        messages: existing.messages,
        contextTokens: existing.contextTokens,
        apiMode: mapped.apiMode || existing.apiMode,
        loadedMessageCount: existing.loadedMessageCount,
        hasMoreBefore: existing.hasMoreBefore,
      })
      return existing
    }
    sessions.value.unshift(mapped)
    return mapped
  }

  // Load a session that may belong to a different profile than the one
  // currently selected, by fetching its detail directly by id. The server
  // returns the real profile on the session; we inject it into the list and
  // switch to it so a deep link like /hermes/session/<id> renders without
  // requiring the user to manually switch profiles first.
  async function ensureSessionByDirectFetch(sessionId: string): Promise<boolean> {
    try {
      const detail = await fetchSessionMessagesPage(sessionId, 0, LIVE_CHAT_MESSAGE_PAGE_SIZE)
      if (!detail?.session) return false
      const target = ensureSessionLoaded(detail.session as SessionSummary)
      target.messages = mapHermesMessages(detail.messages || [], [], sessionId ? [] : [])
      target.loadedMessageCount = detail.messages.length
      target.messageTotal = detail.total
      target.messageCount = detail.total
      target.hasMoreBefore = detail.hasMore
      await switchSession(sessionId)
      return true
    } catch (err) {
      console.error('Failed to load session directly:', err)
      return false
    }
  }

  async function loadSessions(profile?: string | null, preferredSessionId?: string | null) {
    const requestSequence = ++loadSessionsRequestSequence
    const selectionSequence = activeSelectionSequence
    isLoadingSessions.value = true
    try {
      const list = await fetchRuntimeSessions(profile)
      if (requestSequence !== loadSessionsRequestSequence) return
      const fresh = list.map(mapHermesSession)
      const selectionChanged = selectionSequence !== activeSelectionSequence
      // Search can select a session outside the sidebar's first page. Keep
      // that selection when mounting its route, including title-only hits.
      const preserveSelection = selectionChanged || focusMessageId.value
        || (preferredSessionId && preferredSessionId === activeSessionId.value)
      const explicitlySelectedSession = preserveSelection && activeSessionId.value
        ? sessions.value.find(session => session.id === activeSessionId.value) || activeSession.value
        : null
      // Preserve already-loaded messages for sessions that are still present,
      // so we don't blow away the active session's messages on refresh.
      const runtimeByIdBefore = new Map(sessions.value.map(s => [s.id, {
        messages: s.messages,
        contextTokens: s.contextTokens,
        apiMode: s.apiMode,
      }]))
      for (const s of fresh) {
        const prev = runtimeByIdBefore.get(s.id)
        if (prev?.messages?.length) s.messages = prev.messages
        if (prev?.contextTokens != null) s.contextTokens = prev.contextTokens
        if (!s.apiMode && prev?.apiMode) s.apiMode = prev.apiMode
      }
      const freshIds = new Set(fresh.map(session => session.id))
      const localOnlySessions = sessions.value.filter(session =>
        session.isLocalOnly
        && !freshIds.has(session.id)
        && (!profile || session.profile === profile),
      )
      if (
        explicitlySelectedSession
        && !freshIds.has(explicitlySelectedSession.id)
        && !localOnlySessions.some(session => session.id === explicitlySelectedSession.id)
      ) {
        localOnlySessions.unshift(explicitlySelectedSession)
      }
      sessions.value = [...localOnlySessions, ...fresh]
      pruneCompletedUnreadSessions(new Set(sessions.value.map(s => s.id)))

      // A session load may have started before the user selected or created a
      // different chat. Keep the refreshed list, but do not let that stale
      // continuation take ownership of the active selection.
      if (selectionChanged) {
        activeSession.value = activeSessionId.value
          ? sessions.value.find(session => session.id === activeSessionId.value) || null
          : null
        return
      }

      // Restore route-selected session first (tab-local source of truth),
      // then current in-memory session, then persisted legacy/default choice,
      // then fallback to the most recent session.
      //
      // With cross-profile opening, auto-select the user's intended session even
      // if it belongs to a different profile (switchSession switches the active
      // profile to follow it and primes the chat-run socket on that profile).
      const currentId = activeSessionId.value
      const legacyActiveKey = legacyStorageKey()
      const storedId = getItemBestEffort(storageKey()) || (legacyActiveKey ? getItemBestEffort(LEGACY_STORAGE_KEY) : null)
      const sessionExists = (sid: string | null | undefined) => !!sid && !!sessions.value.find(item => item.id === sid)
      const targetId = preferredSessionId && sessionExists(preferredSessionId)
        ? preferredSessionId
        : currentId && sessionExists(currentId)
          ? currentId
          : storedId && sessionExists(storedId)
            ? storedId
            : sessions.value[0]?.id
      if (targetId) {
        await switchSession(targetId, targetId === currentId ? focusMessageId.value : null)
      } else {
        clearActiveSession()
      }
    } catch (err) {
      if (requestSequence === loadSessionsRequestSequence) {
        console.error('Failed to load sessions:', err)
      }
    } finally {
      if (requestSequence === loadSessionsRequestSequence) {
        isLoadingSessions.value = false
        sessionsLoaded.value = true
      }
    }
  }

  // Refresh ONLY the session list metadata (titles, ordering, new/removed
  // sessions) without switching the active session or reloading its messages.
  // Used for live sync so sessions created elsewhere (CLI, Telegram, another
  // device) appear without a manual reload. Skips while streaming to avoid
  // churn.
  //
  // CRITICAL: this MERGES IN-PLACE into the existing session objects instead of
  // replacing the array with `mapHermesSession` clones. `activeSession` is a ref
  // bound to a specific object inside `sessions.value` (see switchSession), and
  // streaming deltas mutate that same object via `sessions.value.find(...)`. If
  // we swapped in fresh objects, `activeSession.value` would point at an orphan
  // and live messages would stop appearing until a manual reload. Mutating the
  // existing objects preserves referential identity so streaming keeps working.
  async function refreshSessionListOnly(profile?: string | null): Promise<void> {
    // Deliberately NOT gated on isStreaming. This refresh is the only thing
    // that applies the server's authoritative `working-sessions` snapshot, and
    // the moment a user is most likely to be watching another session work is
    // while their own session is streaming. Gating here silently froze the
    // working flags of every *other* session for the whole run, so a
    // background delegation only lit up once you opened it by hand.
    if (isLoadingSessions.value) return
    if (sessionListRefreshInFlight) return
    sessionListRefreshInFlight = true
    try {
      const list = await fetchRuntimeSessions(profile ?? sessionProfileFilter.value)
      const incoming = list.map(mapHermesSession)
      const existingById = new Map(sessions.value.map(s => [s.id, s]))

      // Skip the full array rebuild when nothing changed — otherwise every
      // 12s tick replaces the array reference, triggering a Vue re-render
      // that collapses any expanded list items on mobile.
      const currentIds = sessions.value.map(s => s.id)
      const incomingIdsArr = incoming.map(s => s.id)
      const hasChanged = currentIds.length !== incomingIdsArr.length
        || currentIds.some((id, i) => id !== incomingIdsArr[i])
      // Build the next array reusing existing objects (identity-preserving) and
      // inserting genuinely-new sessions as fresh objects.
      const next: Session[] = []
      // Always include all sessions that are already in the list, even if they
      // are not in the server response for this profile. This prevents the 12s
      // poll from silently dropping cross-profile sessions that were opened via
      // deep link or direct fetch.
      const keptIds = new Set<string>()
      for (const fresh of incoming) {
        const existing = existingById.get(fresh.id)
        if (existing) {
          // Update scalar metadata in-place; never touch runtime/scroll state
          // (messages, loadedMessageCount, hasMoreBefore, contextTokens).
          existing.title = fresh.title
          existing.source = fresh.source
          // The server owns activity time. It now advances last_active on every
          // persisted message, so this is live; mirroring it unconditionally is
          // what keeps the sidebar from disagreeing with any other client.
          existing.updatedAt = fresh.updatedAt
          existing.lastActiveAt = fresh.lastActiveAt
          existing.endedAt = fresh.endedAt
          existing.model = fresh.model
          existing.provider = fresh.provider
          existing.apiMode = fresh.apiMode || existing.apiMode
          existing.reasoningEffort = fresh.reasoningEffort
          if (!pushEnabledWriteTargets.has(existing.id)) existing.pushEnabled = fresh.pushEnabled
          existing.messageCount = fresh.messageCount
          applySessionTokenUsage(existing, fresh)
          existing.workspace = fresh.workspace
          existing.isPinned = fresh.isPinned
          existing.categoryId = fresh.categoryId
          existing.isLocalOnly = false
          // messageTotal: keep the larger of server count vs what we've loaded,
          // so we don't shrink below already-rendered messages mid-session.
          if (fresh.messageTotal != null) {
            existing.messageTotal = Math.max(fresh.messageTotal, existing.loadedMessageCount || 0)
          }
          next.push(existing)
          keptIds.add(fresh.id)
        } else {
          next.push(fresh)
          keptIds.add(fresh.id)
        }
      }
      // Preserve sessions that are already in the list but not in the server
      // response (e.g. cross-profile sessions opened via deep link).
      for (const existing of sessions.value) {
        if (!keptIds.has(existing.id)) {
          next.push(existing)
          keptIds.add(existing.id)
        }
      }

      // Only replace the array when the list actually changed.
      if (hasChanged || next.length !== currentIds.length) {
        sessions.value = next
        pruneCompletedUnreadSessions(new Set(next.map(s => s.id)))
      }
      await applyWorkingSessionsSnapshot()

      // Defensive: re-bind activeSession to the (same) object now in the array,
      // by id, in case anything above changed array membership.
      const activeId = activeSessionId.value
      if (activeId) {
        const again = sessions.value.find(s => s.id === activeId)
        if (again && activeSession.value !== again) activeSession.value = again
      }
    } catch (err) {
      console.error('Failed to refresh session list:', err)
    } finally {
      sessionListRefreshInFlight = false
    }
  }

  /**
   * How long a locally observed run start outranks a `working-sessions`
   * snapshot that does not list it. One poll interval plus a little slack: long
   * enough that a poll which raced the start cannot clear the flag, short
   * enough that a genuinely leaked flag is still healed.
   */
  const WORKING_SNAPSHOT_FRESHNESS_MS = 15_000

  const WORKING_SNAPSHOT_POLL_MS = 3_000

  /**
   * How long a silent delegation still counts as local evidence of a live run.
   *
   * A safety net for a client that received nothing at all; the precise path is
   * the snapshot reconciliation in applyWorkingSessionsSnapshot. Generous,
   * because a delegation running one long tool call emits nothing for a while
   * and clearing early would show the session as idle while it still works.
   */
  const SUBAGENT_EVIDENCE_FRESHNESS_MS = 120_000

  /**
   * Whether this client has evidence that `sessionId` is running right now,
   * which a lagging snapshot must not talk it out of: an attached stream, a
   * live subagent delegation, or a start observed so recently that the
   * snapshot could predate it.
   */
  function hasLocalRunEvidence(sessionId: string, now: number): boolean {
    // Bounded like every other source here. An attached stream normally clears
    // itself in its own cleanup, and the server's watchdog emits `run.completed`
    // for a run it decides is dead -- but only for sessions with `isWorking`, so
    // a background session whose terminal event was lost had no way out: this
    // veto held `serverWorking` forever and the ring with it.
    // The snapshot-veto window, not the display window: this answer decides
    // whether the server's silence may override a local flag, so it has to be
    // short -- a snapshot that raced a real run must not be overruled.
    // This is the only window left: it decides whether the server's silence may
    // overrule a local flag, and nothing bounds how long a run may last.
    if (streamStates.value.has(sessionId)) {
      const startedAt = runStartedAt.value.get(sessionId) || 0
      return startedAt > 0 && now - startedAt < WORKING_SNAPSHOT_FRESHNESS_MS
    }
    for (const subagent of subagentStreams.value.values()) {
      if (subagent.sessionId !== sessionId || subagent.status !== 'running') continue
      // A delegation that is still alive keeps advancing `updatedAt`. Requiring
      // recent activity bounds this veto the same way the run-start evidence
      // below is bounded, so a leaked stream cannot outlive the snapshot. Every
      // other source here is bounded, and this one was not: a `subagent.complete`
      // that never reached a background session kept the sidebar ring spinning
      // until the user opened the conversation and triggered a resume.
      if (now - subagent.updatedAt < SUBAGENT_EVIDENCE_FRESHNESS_MS) return true
    }
    const startedAt = runStartedAt.value.get(sessionId) || 0
    return startedAt > 0 && now - startedAt < WORKING_SNAPSHOT_FRESHNESS_MS
  }

  /**
   * Converge the sidebar to the authoritative server state of "which sessions
   * are still running" without opening each conversation. Called by
   * refreshSessionListOnly so a freshly opened Studio repairs the working
   * flags of all listed sessions in one request.
   */
  async function applyWorkingSessionsSnapshot(): Promise<void> {
    try {
      const snapshot = await fetchWorkingSessions()
      const now = Date.now()
      const live = new Set(snapshot.map(session => String(session.session_id)))
      // The snapshot is a plain HTTP read, so it can be in flight while a run
      // starts, and it knows nothing about the subagent streams this client is
      // following. It may only relax a flag when the client has no local
      // evidence of a live run to contradict it.
      // The server now states the phase outright, so the snapshot can be taken
      // at face value instead of being inferred from membership. A session the
      // server still reports as `finishing` must keep that state rather than
      // being cleared as unknown.
      // A delegation runs outside `isWorking`, so the server reports
      // `background_pending` per session and includes sessions that have live
      // delegations but no foreground run. This is the authority the client
      // lacked. Settle those streams first: hasLocalRunEvidence below consults
      // them, so reconciling later would deadlock against itself and the ring
      // would never stop.
      const backgroundPending = new Map<string, number>()
      for (const entry of snapshot) {
        backgroundPending.set(String(entry.session_id), Number(entry.background_pending) || 0)
      }
      // The snapshot is also the only authority that can switch the delegation
      // light OFF. It was computed above, used to settle delegation streams, and
      // then dropped on the floor -- nothing ever wrote it into
      // `backgroundPendingBySession`, and nothing ever cleared it. So the flag
      // was write-only from the socket events: once a `delegation.updated`
      // lit it, no code path could put it out, and the ring stayed on forever
      // with no notice. That is the reported symptom, and the previous fix only
      // addressed the sibling `subagentStreams` leak, not this one.
      //
      // Applied for every session in the list, not just the live ones: absence
      // from the snapshot is the server's way of saying "not busy", exactly as
      // it is for `serverWorking` below.
      for (const session of sessions.value) {
        const pending = backgroundPending.get(session.id) || 0
        const known = backgroundPendingBySession.value.get(session.id) || 0
        if (pending === known) continue
        // `setBackgroundPending(0)` tears down the per-session observer socket
        // as well as clearing the count, which is what keeps a finished
        // delegation from re-lighting the ring on a stale event.
        setBackgroundPending(session.id, pending)
      }

      const finishedBySnapshot = new Set<string>()
      for (const stream of [...subagentStreams.value.values()]) {
        if (stream.status !== 'running') continue
        if (live.has(stream.sessionId)) continue
        if ((backgroundPending.get(stream.sessionId) || 0) > 0) continue
        settleInterruptedSubagents(stream.sessionId)
        finishedBySnapshot.add(stream.sessionId)
      }

      // The snapshot is the authority on phase, run identity and delegation
      // count, and the only writer that can withdraw them. Applied field by field
      // through `patchSessionRun`, so a poll that knows nothing about a stream
      // this client attached does not erase it.
      const seenInSnapshot = new Set<string>()
      for (const entry of snapshot) {
        const sid = String(entry.session_id)
        seenInSnapshot.add(sid)
        // Live again, so the next finished run is allowed to report itself.
        snapshotFinishNotified.delete(sid)
        const phase = entry.run_state ?? 'running'
        const reportedStart = Number(entry.run_started_at) || 0
        // The run identity is refreshed on every poll, not only when the phase is
        // first seen. A queued run replaces a finished one without the session
        // ever leaving this list, so recording it once left the client naming the
        // previous run -- and a stop that names a dead run is dropped as stale,
        // which turns it into a silent no-op rather than a visible failure.
        patchSessionRun(sid, {
          phase,
          runId: String(entry.run_id || '') || undefined,
          // A phase the server has withdrawn carries no clock with it: the
          // elapsed timer reads this and would otherwise keep counting.
          startedAt: phase === 'running' && reportedStart > 0 ? reportedStart : undefined,
        })
      }

      // Sessions the snapshot no longer lists. Only withdrawn when this client has
      // no local evidence to the contrary, because the read can be in flight while
      // a run starts, and clearing then makes the sidebar blink out for a poll.
      const dropped = [...sessionRuns.value.keys()]
        .filter(id => !seenInSnapshot.has(id) && !hasLocalRunEvidence(id, now))
      for (const id of dropped) markSessionIdle(id)
      // The terminal event for a session this client is not attached to never
      // arrives, so the poll is the only place that can learn it finished. It used
      // to be silent about that, which is why a finished run looked identical to a
      // stuck one. Reported once per session.
      for (const id of new Set([...dropped, ...finishedBySnapshot])) {
        settleSessionFinished(id)
      }
      // The same snapshot is the authoritative word on compression: a run-scoped
      // compression cannot outlive its run, so this heals a banner whose
      // `compression.completed` event was lost, for every session, every poll.
      const liveWorking = new Set(snapshot.map(entry => String(entry.session_id)))
      for (const entry of snapshot) {
        reconcileCompressionState(String(entry.session_id), entry.compression ?? null, true)
      }
      for (const sid of [...compressionStates.value.keys()]) {
        if (liveWorking.has(sid) || hasLocalRunEvidence(sid, now)) continue
        settleStaleCompression(sid)
      }
    } catch (err) {
      console.warn('Failed to refresh working sessions snapshot:', err)
    }
  }

  // Re-pull active session from server. Used on tab-visible events.
  async function refreshActiveSession(): Promise<boolean> {
    const sid = activeSessionId.value
    if (!sid) return false
    try {
      const target = sessions.value.find(s => s.id === sid)
      if (!target) return false
      const limit = focusMessageId.value
        ? Math.max(target.loadedMessageCount || LIVE_CHAT_MESSAGE_PAGE_SIZE, LIVE_CHAT_MESSAGE_PAGE_SIZE)
        : Math.min(
          Math.max(target.loadedMessageCount || LIVE_CHAT_MESSAGE_PAGE_SIZE, LIVE_CHAT_MESSAGE_PAGE_SIZE),
          LIVE_CHAT_MAX_LOADED_MESSAGES,
        )
      const detail = await fetchSessionMessagesPage(sid, 0, limit, activeSession.value?.profile)
      if (!detail) return false
      const mapped = mapHermesMessages(detail.messages || [], detail.taskPlans, sid ? [] : [])
      target.messages = mapped
      restorePersistedSubagentStreams(sid)
      setWorkspaceRunChanges(sid, detail.workspaceRunChanges || [])
      target.loadedMessageCount = detail.messages.length
      target.messageTotal = detail.total
      target.messageCount = detail.total
      target.hasMoreBefore = detail.hasMore
      if (detail.session.title) target.title = detail.session.title
      target.workspace = detail.session.workspace || target.workspace || null
      target.isPinned = Boolean(detail.session.is_pinned)
      target.categoryId = detail.session.category_id ?? null
      if (!pushEnabledWriteTargets.has(sid)) target.pushEnabled = Boolean(detail.session.push_enabled)
      target.isLocalOnly = false
      target.parentSessionId = detail.session.parent_session_id || target.parentSessionId || null
      target.forkPointMessageId = (detail.session as any).fork_point_message_id != null ? String((detail.session as any).fork_point_message_id) : target.forkPointMessageId || null
      target.parentTitle = detail.session.parent_title || target.parentTitle || null
      target.parentLastMessage = detail.session.parent_last_message || target.parentLastMessage || null
      target.parentLastMessageRole = detail.session.parent_last_message_role || target.parentLastMessageRole || null
      return true
    } catch (err) {
      console.error('Failed to refresh active session:', err)
      return false
    }
  }


  function createSession(options: {
    profile?: string
    model?: string
    provider?: string
    source?: 'api_server' | 'cli' | 'coding_agent' | 'global_agent' | 'workflow' | 'group_chat'
    agent?: ChatAgentId
    codingAgentId?: ChatCodingAgentId
    codingAgentMode?: 'global' | 'scoped'
    agentPreset?: string
    workspace?: string | null
    categoryId?: number | null
    baseUrl?: string
    apiKey?: string
    apiMode?: ProviderApiMode
  } = {}): Session {
    const source = runtimeMode.value === 'global_agent' ? 'global_agent' : options.source || 'cli'
    const codingAgentId = options.codingAgentId || agentToCodingAgentId(options.agent)
    const codingAgentMode = codingAgentId ? (options.codingAgentMode || 'scoped') : undefined
    const session: Session = {
      id: uid(),
      profile: options.profile || useProfilesStore().activeProfileName || 'default',
      title: '',
      source,
      agent: options.agent || codingAgentIdToAgent(codingAgentId) || 'hermes',
      codingAgentId,
      codingAgentMode,
      agentPreset: options.agentPreset,
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      model: options.model || undefined,
      provider: options.provider || '',
      workspace: options.workspace || null,
      categoryId: options.categoryId ?? null,
      isLocalOnly: true,
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      apiMode: options.apiMode,
    }
    sessions.value.unshift(session)
    return session
  }

  function newCliSession(): Session {
    const now = new Date()
    const ts = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0'),
      '_',
      String(now.getHours()).padStart(2, '0'),
      String(now.getMinutes()).padStart(2, '0'),
      String(now.getSeconds()).padStart(2, '0'),
    ].join('')
    const hex = Math.random().toString(16).slice(2, 8)
    const session: Session = {
      id: `${ts}_${hex}`,
      title: '',
      source: runtimeMode.value === 'global_agent' ? 'global_agent' : 'cli',
      agent: 'hermes',
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    sessions.value.unshift(session)
    return session
  }

  async function switchSession(sessionId: string, focusId?: string | null) {
    const generation = runtimeGeneration
    activeSelectionSequence++
    const requestSequence = ++switchSessionRequestSequence
    const isCurrentSelection = () => generation === runtimeGeneration
      && activeSessionId.value === sessionId
      && requestSequence === switchSessionRequestSequence
    clearThinkingObservationFor(sessionId)
    activeSessionId.value = sessionId
    focusMessageId.value = focusId ?? null
    setItemBestEffort(storageKey(), sessionId)
    const legacyActiveKey = legacyStorageKey()
    if (legacyActiveKey) removeItem(legacyActiveKey)
    activeSession.value = sessions.value.find(s => s.id === sessionId) || null
    clearSessionCompletedUnread(sessionId)

    if (!activeSession.value) {
      // Cross-profile deep link: the session isn't in the list yet, but the
      // REST-first path below can still load messages. Create a stub entry
      // so the UI doesn't flash blank and return.
      const stub = {
        id: sessionId,
        title: '',
        source: 'cli',
        agent: 'hermes',
        messages: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } as Session
      activeSession.value = stub
      sessions.value.unshift(stub)
    }

    // ── Follow the active session's profile ──
    // Parallel-profile: each profile runs its own bridge worker and session
    // table; no run is destroyed when focus changes. We update the UI focus
    // profile (active_profile marker) to match the session being opened so
    // request-scoped APIs and the chat-run socket bind to the right profile.
    // connectChatRun() reconnects the chat-run socket to the new profile the
    // next time it's called, so incoming run events land on the correct
    // connection. In-flight runs in other profiles keep running untouched.
    const targetProfile = activeSession.value?.profile || 'default'
    // The message page below is profile-scoped HTTP and does not need the
    // interactive profile to have been switched first, so a cross-profile switch
    // must not sit in front of it. Awaiting it here serialised the whole open
    // behind `PUT /api/hermes/profiles/active`, which spawns the hermes CLI
    // (~0.8s) and re-scans the profile's skill tree -- on every session open.
    //
    // Opening a session in the profile you are already in is the common case and
    // then there is nothing to wait for, so that path stays fully synchronous:
    // `connectChatRun` is still primed before anything else, and no extra
    // microtask is introduced. Only a real cross-profile switch is handed to the
    // caller as a promise, which the socket resume below awaits.
    let profileSwitch: Promise<unknown> | null = null
    try {
      const profilesStore = useProfilesStore()
      if (targetProfile !== getProfileName()) {
        profileSwitch = profilesStore.switchHermesProfile(targetProfile)
          .catch(err => {
            console.warn('[switchSession] failed to switch active profile to', targetProfile, ':', err)
          })
      }
      // Prime the chat-run socket for this profile so streaming events /
      // resume / send all attach to the connection bound to targetProfile.
      connectChatRun(targetProfile)
    } catch (err) {
      console.warn('[switchSession] failed to switch active profile to', targetProfile, ':', err)
    }

    beginMessageLoad(sessionId, requestSequence)
    let backgroundPendingOnResume = 0
    // P0: track whether the REST-first path already populated messages. On
    // mobile/slow networks the socket `resume` may arrive late (or its bridge
    // status lookup may exceed our forward-timeout), and unconditionally
    // overwriting target.messages with a stale/late `resumed` payload is what
    // makes the first render wait ~12s for the background poll. If REST already
    // delivered the latest page, keep it and let `resumed` only refresh the
    // live isWorking/queue state, not clobber the message list.
    let restLoadedMessages = false

    // ── REST-first: load messages via HTTP (cross-profile, no socket profile check) ──
    let loaded = false
    try {
      const target = sessions.value.find(s => s.id === sessionId) || activeSession.value
      if (target) {
        const limit = Math.min(
          Math.max(target.loadedMessageCount || 0, LIVE_CHAT_MESSAGE_PAGE_SIZE),
          LIVE_CHAT_MAX_LOADED_MESSAGES,
        )
        const page = await fetchSessionMessagesPage(sessionId, 0, limit, target.profile)
        if (page?.messages && requestSequence === switchSessionRequestSequence && activeSessionId.value === sessionId) {
          const t = sessions.value.find(s => s.id === sessionId)
          if (t) {
            restLoadedMessages = true
            t.messages = mapHermesMessages(page.messages as any[], [], sessionId ? [] : [])
            restorePersistedSubagentStreams(sessionId)
            setWorkspaceRunChanges(sessionId, (page as any).workspaceRunChanges || [])
            t.loadedMessageCount = page.messages.length
            t.messageTotal = (page as any).total ?? t.messageCount ?? t.loadedMessageCount
            t.messageCount = t.messageTotal
            t.hasMoreBefore = (page as any).hasMore ?? (t.loadedMessageCount || 0) < (t.messageTotal || 0)
            // Update profile from API response — critical for unimported sessions
            // whose stub may have wrong default/cross-profile profile. The socket
            // must connect to the session's actual profile or sendMessage will fail
            // with "Session not found" or profile mismatch.
            if (page.session?.profile) t.profile = page.session.profile
            if (!t.title) {
              const firstUser = t.messages.find(m => m.role === 'user')
              if (firstUser) {
                const ttl = firstUser.content.slice(0, 40)
                t.title = ttl + (firstUser.content.length > 40 ? '...' : '')
              }
            }
            activeSession.value = t
          }
        }
      }
    } catch (err) {
      console.warn('[switchSession] REST load failed, will try socket resume:', err)
      restLoadedMessages = false
    }

    // P0: always reattach to authoritative server state (isWorking + background).
    // Local memory (serverWorking/target.isWorking) is cleared on refresh and
    // the session list has no isWorking field — gating on it skips the resume
    // and leaves a live绘画 run stuck at isWorking=false.
    try {
      // The resume travels on the chat-run socket, which is bound to a profile,
      // so it has to wait for a cross-profile switch. The message page already
      // loaded in parallel, which is where the perceived open time came from.
      if (profileSwitch) await profileSwitch
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('resume timeout')), 15_000)
        resumeSession(sessionId, (data) => {
          clearTimeout(timeout)
          if (
            data.session_id !== sessionId
            || generation !== runtimeGeneration
            || activeSessionId.value !== sessionId
            || requestSequence !== switchSessionRequestSequence
          ) {
            resolve()
            return
          }
          const target = sessions.value.find(s => s.id === sessionId)
          if (!target) {
            resolve()
            return
          }
          if (data.isWorking) {
            markSessionRunning(sessionId)
          } else {
            // Clearing only serverWorking left streamStartedAt/streamStates and
            // per-message isStreaming set, so the session stayed "thinking" and
            // the next send got queued. Reconcile every source at once.
            reconcileSessionIdle(sessionId)
          }
          backgroundPendingOnResume = Number(data.backgroundPending || 0)
          if (data.queueLength && data.queueLength > 0) {
            queueLengths.value.set(sessionId, data.queueLength)
          } else {
            queueLengths.value.delete(sessionId)
          }
          if (Array.isArray((data as any).queueMessages)) {
            replaceQueuedUserMessages(sessionId, normalizeQueuedUserMessages((data as any).queueMessages))
          } else if (!data.queueLength) {
            replaceQueuedUserMessages(sessionId, [])
          }
          replaceQueueInsertionState(sessionId, data.queueInsertion)
          applyResumedRunActivity(sessionId, data as any)
          if ((data as any).isAborting) {
            setAbortState(sessionId, { aborting: true, synced: null })
          } else if (!data.isWorking) {
            setAbortState(sessionId, null)
          }
          // The server snapshot is authoritative: it is the only thing that can
          // correct a compression whose completion event we never received.
          reconcileCompressionState(sessionId, data.compression, !!data.isWorking)
          if (!data.isWorking && !data.compression) setCompressionState(sessionId, null)
          applySessionTokenUsage(target, data)
          applyResumedSessionSettings(data)
          if (typeof data.workspace === 'string') {
            target.workspace = data.workspace.trim() || null
            target.isLocalOnly = false
          }
          target.parentSessionId = (data as any).parentSessionId || target.parentSessionId || null
          target.forkPointMessageId = (data as any).forkPointMessageId != null ? String((data as any).forkPointMessageId) : target.forkPointMessageId || null
          target.parentTitle = (data as any).parentTitle || target.parentTitle || null
          target.parentLastMessage = (data as any).parentLastMessage || target.parentLastMessage || null
          target.parentLastMessageRole = (data as any).parentLastMessageRole || target.parentLastMessageRole || null
          if (Array.isArray(data.messages)) {
            if (!restLoadedMessages) {
              target.messages = mapHermesMessages(data.messages as any[], data.taskPlans, sessionId ? [] : [])
              mergePersistedCompressionEntries(sessionId)
              restorePersistedSubagentStreams(sessionId)
              setWorkspaceRunChanges(sessionId, data.workspaceRunChanges || [])
              target.loadedMessageCount = data.messageLoadedCount ?? data.messages.length
              target.messageTotal = data.messageTotal ?? target.messageCount ?? target.loadedMessageCount
              target.messageCount = target.messageTotal
              target.hasMoreBefore = data.hasMoreBefore ?? target.loadedMessageCount < target.messageTotal
            } else {
              // Even if REST already loaded, still apply workspaceRunChanges from resumed
              setWorkspaceRunChanges(sessionId, data.workspaceRunChanges || [])
            }
          }
          if (!target.title) {
            const firstUser = target.messages.find(m => m.role === 'user')
            if (firstUser) {
              const t = firstUser.content.slice(0, 40)
              target.title = t + (firstUser.content.length > 40 ? '...' : '')
            }
          }
          activeSession.value = target
          // Process replayed events (compression state etc.)
          if (data.events?.length) {
            for (const evt of data.events) {
              const e = evt.data as any
              if (e.event === 'compression.started') {
                setCompressionState(sessionId, {
                  compressing: true,
                  messageCount: e.message_count || 0,
                  beforeTokens: e.token_count || 0,
                  afterTokens: 0,
                  compressed: null,
                  source: e.source === 'command' ? 'command' : 'run',
                  startedAt: Number(e.started_at) || Date.now(),
                })
              } else if (e.event === 'compression.completed') {
                const afterTokens = e.contextTokens || e.afterTokens || 0
                const previous = compressionStates.value.get(sessionId)
                setCompressionState(sessionId, {
                  compressing: false,
                  messageCount: e.totalMessages || 0,
                  beforeTokens: e.beforeTokens || 0,
                  afterTokens,
                  compressed: e.compressed ?? false,
                  error: e.error,
                  source: e.source === 'command' ? 'command' : (previous?.source || 'run'),
                  startedAt: Number(e.started_at) || previous?.startedAt || Date.now(),
                })
                if (e.contextTokens != null) target.contextTokens = e.contextTokens
              } else if (e.event === 'abort.started') {
                setAbortState(sessionId, { aborting: true, synced: null })
              } else if (e.event === 'abort.timeout') {
                setAbortState(sessionId, { aborting: true, synced: false, timedOut: true, message: (e as any).message })
              } else if (e.event === 'abort.completed') {
                setAbortState(sessionId, { aborting: false, synced: e.synced ?? false })
                settleInterruptedSubagents(sessionId)
              } else if (e.event === 'approval.requested') {
                setPendingApproval({ ...e, session_id: sessionId } as RunEvent)
              } else if (e.event === 'approval.resolved') {
                clearPendingApproval({ ...e, session_id: sessionId } as RunEvent)
              } else if (e.event === 'clarify.requested') {
                setPendingClarify({ ...e, session_id: sessionId } as RunEvent)
              } else if (e.event === 'clarify.resolved') {
                clearPendingClarify({ ...e, session_id: sessionId } as RunEvent)
              } else if (e.event === 'run.failed') {
                handleTerminalWorkspaceRunChange(sessionId, e)
                addAgentErrorMessage(sessionId, e.error)
                markSessionIdle(sessionId)
                queueLengths.value.delete(sessionId)
              } else if (e.event === 'plan.updated' || e.event === 'agent.event' || e.event === 'run.reattach_failed') {
                handleAgentEvent(e)
              } else if (e.event === 'workspace.diff.completed') {
                handleWorkspaceRunChangeEvent(sessionId, e)
              } else if (e.event === 'tool.started') {
                handleToolStartedEvent(sessionId, e as RunEvent)
              } else if (e.event === 'tool.completed' || e.event === 'tool.failed') {
                handleToolCompletedEvent(sessionId, e as RunEvent)
              } else if (e.event === 'moa.reference' || e.event === 'moa.aggregating') {
                handleMoaEvent(sessionId, e as RunEvent)
              } else if (String(e.event || '').startsWith('subagent.') || e.event === 'delegation.updated') {
                handleSubagentEvent(sessionId, e as RunEvent)
              }
            }
          }
          if (Array.isArray(data.backgroundTasks)) {
            for (const task of data.backgroundTasks) {
              const lastEvent = String(task.last_event || '')
              const status = String(task.status || '')
              const event = lastEvent.startsWith('subagent.')
                ? lastEvent
                : status === 'running' ? 'subagent.progress' : 'subagent.complete'
              handleSubagentEvent(sessionId, {
                ...task,
                event,
                session_id: sessionId,
                background_snapshot: true,
                subagent_id: task.subagent_id,
                tool: task.last_tool,
                name: task.last_tool,
                text: task.preview,
                duration_seconds: task.duration_seconds,
              } as RunEvent)
            }
          }
          resolve()
        }, activeSession.value?.profile, runtimeTransport())
      })
      // A search hit can be older than both the resume page and the live-chat
      // history cap. Only explicit message navigation may extend that window.
      while (focusId && isCurrentSelection()) {
        const target = activeSession.value
        if (!target || target.messages.some(message => message.id === focusId)) break
        const offset = target.loadedMessageCount || 0
        if (!await loadOlderMessages(sessionId, isCurrentSelection)) break
        if ((target.loadedMessageCount || 0) <= offset) break
      }
      loaded = isCurrentSelection() && (!focusId || !!activeSession.value?.messages.some(message => message.id === focusId))
      if (isCurrentSelection() && !loaded) focusMessageId.value = null
    } catch (err) {
      console.error('Failed to load session messages via resume:', err)
      if (isCurrentSelection()) focusMessageId.value = null
    } finally {
      endMessageLoad(sessionId, requestSequence)
    }

    // Resume in-flight run event listeners if needed
    if (generation === runtimeGeneration && activeSessionId.value === sessionId && requestSequence === switchSessionRequestSequence) {
      resumeServerWorkingRun(sessionId, backgroundPendingOnResume > 0, !serverWorking.value.has(sessionId))
    }
    return loaded
  }

  async function loadOlderMessages(sessionId = activeSessionId.value, searchSelection?: () => boolean): Promise<boolean> {
    if (!sessionId) return false
    const target = sessions.value.find(s => s.id === sessionId)
    if (!target || (!searchSelection && target.isLoadingOlderMessages) || !target.hasMoreBefore) return false
    const offset = target.loadedMessageCount || 0
    if (!searchSelection && offset >= LIVE_CHAT_MAX_LOADED_MESSAGES) return false
    const limit = searchSelection
      ? LIVE_CHAT_MESSAGE_PAGE_SIZE
      : Math.min(LIVE_CHAT_MESSAGE_PAGE_SIZE, LIVE_CHAT_MAX_LOADED_MESSAGES - offset)
    const loadToken = {}
    const previousMessages = target.messages
    olderMessageLoads.set(target, loadToken)
    target.isLoadingOlderMessages = true
    try {
      const page = await fetchSessionMessagesPage(sessionId, offset, limit, target.profile)
      if (olderMessageLoads.get(target) !== loadToken || target.messages !== previousMessages
        || (searchSelection && !searchSelection())) return false
      if (!page) return false
      if (page.messages.length === 0) {
        target.hasMoreBefore = false
        return false
      }

      const existingIds = new Set(target.messages.map(message => message.id))
      const olderMessages = mapHermesMessages(page.messages).filter(message => !existingIds.has(message.id))
      target.messages = mergeTaskPlanMessages([...olderMessages, ...target.messages], page.taskPlans || [], sessionId)
      restorePersistedSubagentStreams(sessionId)
      mergeWorkspaceRunChanges(sessionId, page.workspaceRunChanges || [])
      target.loadedMessageCount = offset + page.messages.length
      target.messageTotal = page.total
      target.messageCount = page.total
      target.hasMoreBefore = page.hasMore
      return olderMessages.length > 0
    } catch (err) {
      console.error('Failed to load older session messages:', err)
      return false
    } finally {
      if (olderMessageLoads.get(target) === loadToken) {
        olderMessageLoads.delete(target)
        target.isLoadingOlderMessages = false
      }
    }
  }

  function newChat(options: {
    profile?: string
    model?: string
    provider?: string
    source?: 'api_server' | 'cli' | 'coding_agent' | 'global_agent' | 'workflow' | 'group_chat'
    agent?: ChatAgentId
    codingAgentId?: ChatCodingAgentId
    codingAgentMode?: 'global' | 'scoped'
    agentPreset?: string
    workspace?: string | null
    categoryId?: number | null
    baseUrl?: string
    apiKey?: string
    apiMode?: ProviderApiMode
  } = {}): Session {
    const appStore = useAppStore()
    const storageSource = runtimeMode.value === 'global_agent' ? 'global_agent' : options.source || 'cli'
    const codingAgentId = options.codingAgentId || agentToCodingAgentId(options.agent)
    const isGlobalCodingAgent = Boolean(codingAgentId) && options.codingAgentMode === 'global'
    const session = createSession({
      profile: options.profile,
      model: isGlobalCodingAgent ? undefined : options.model || appStore.selectedModel || undefined,
      provider: isGlobalCodingAgent ? '' : options.provider || appStore.selectedProvider || '',
      source: storageSource,
      agent: options.agent,
      codingAgentId,
      codingAgentMode: options.codingAgentMode,
      agentPreset: options.agentPreset,
      workspace: options.workspace,
      categoryId: options.categoryId,
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      apiMode: options.apiMode,
    })
    void switchSession(session.id)
    return session
  }

  async function switchSessionModel(modelId: string, provider?: string, sessionId?: string, apiMode?: ProviderApiMode): Promise<boolean> {
    const targetId = sessionId || activeSession.value?.id
    if (!targetId) return false
    const target = sessions.value.find(s => s.id === targetId)
    const activeTarget = activeSession.value?.id === targetId ? activeSession.value : null
    const session = target || activeTarget
    if (session?.codingAgentMode === 'global' && isCodingAgentLikeSession(session)) return false
    const previousProvider = String(target?.provider ?? activeTarget?.provider ?? '')
    const nextProvider = provider || ''
    const shouldClearRuntimeCredentials = previousProvider !== nextProvider && (
      isCodingAgentLikeSession(target) || isCodingAgentLikeSession(activeTarget)
    )
    const preservedApiMode = apiMode || (previousProvider === nextProvider
      ? (shouldPreserveRuntimeApiMode(target) ? target?.apiMode : undefined) ||
        (shouldPreserveRuntimeApiMode(activeTarget) ? activeTarget?.apiMode : undefined)
      : undefined)
    const isLocalOnly = target?.isLocalOnly === true || activeTarget?.isLocalOnly === true
    if (!isLocalOnly) {
      await reasoningEffortWriteChains.get(targetId)?.catch(() => false)
      const ok = await setSessionModel(targetId, modelId, provider || '', preservedApiMode)
      if (!ok) return false
    }
    if (target) {
      target.model = modelId
      target.provider = provider || ''
      target.apiMode = preservedApiMode
      target.reasoningEffort = undefined
      if (shouldClearRuntimeCredentials) clearCodingAgentRuntimeCredentials(target)
    }
    if (activeTarget) {
      activeTarget.model = modelId
      activeTarget.provider = provider || ''
      activeTarget.apiMode = preservedApiMode
      activeTarget.reasoningEffort = undefined
      if (shouldClearRuntimeCredentials) clearCodingAgentRuntimeCredentials(activeTarget)
    }
    return true
  }

  async function deleteSession(sessionId: string): Promise<boolean> {
    const target = sessions.value.find(s => s.id === sessionId)
    const ok = await deleteSessionApi(sessionId, target?.profile)
    if (!ok) return false
    setBackgroundPending(sessionId, 0)
    sessions.value = sessions.value.filter(s => s.id !== sessionId)
    clearMessageReference(sessionId)
    setAbortState(sessionId, null)
    if (activeSessionId.value === sessionId) {
      if (sessions.value.length > 0) {
        await switchSession(sessions.value[0].id)
      } else {
        const session = createSession()
        switchSession(session.id)
      }
    }
    return true
  }

  async function archiveSession(sessionId: string): Promise<boolean> {
    const target = sessions.value.find(s => s.id === sessionId)
    const ok = await archiveSessionApi(sessionId)
    if (!ok) return false
    setBackgroundPending(sessionId, 0)
    sessions.value = sessions.value.filter(s => s.id !== sessionId)
    clearMessageReference(sessionId)
    setAbortState(sessionId, null)
    if (completedUnreadSessions.value.has(sessionId)) {
      const next = new Set(completedUnreadSessions.value)
      next.delete(sessionId)
      completedUnreadSessions.value = next
    }
    if (activeSessionId.value === sessionId) {
      if (sessions.value.length > 0) {
        await switchSession(sessions.value[0].id)
      } else {
        clearActiveSession()
      }
    } else if (target) {
      await refreshSessionListOnly(sessionProfileFilter.value)
    }
    return true
  }

  function getSessionMsgs(sessionId: string): Message[] {
    const s = sessions.value.find(s => s.id === sessionId)
    return s?.messages || []
  }

  function isEkkoAgentSession(sessionId: string): boolean {
    const session = sessions.value.find(item => item.id === sessionId)
    return session?.codingAgentId === 'ekko-agent' || session?.agent === 'ekko-agent'
  }

  function addMessage(sessionId: string, msg: Message) {
    const s = sessions.value.find(s => s.id === sessionId)
    if (s) s.messages.push(msg)
  }

  function addMessageInTimelineOrder(sessionId: string, msg: Message) {
    const session = sessions.value.find(item => item.id === sessionId)
    if (!session) return
    const insertAt = session.messages.findIndex(existing => existing.timestamp > msg.timestamp)
    if (insertAt === -1) {
      session.messages.push(msg)
      return
    }
    session.messages.splice(insertAt, 0, msg)
  }

  function addHermesBackgroundDelegateAnchors(
    sessionId: string,
    toolCallId: string | undefined,
    output: unknown,
    toolArgs: unknown,
    runMarker?: string | null,
  ) {
    const payload = runtimeObjectPayload(output)
    if (!payload || payload.mode !== 'background' || payload.runtime === 'ekko') return
    const baseId = toolCallId || String(payload.delegation_id || uid())
    const messages = getSessionMsgs(sessionId)
    for (const task of backgroundDelegateTaskDescriptors(payload, toolArgs)) {
      const anchorCallId = backgroundDelegateAnchorCallId(baseId, task.taskIndex)
      if (messages.some(message =>
        message.toolCallId === anchorCallId
        && normalizedRunMarker(message) === (runMarker || null),
      )) continue
      const label = `${task.taskIndex + 1}/${task.taskCount}`
      addMessage(sessionId, {
        id: uid(),
        role: 'tool',
        content: '',
        timestamp: Date.now(),
        toolName: 'delegate_task',
        toolCallId: anchorCallId,
        toolArgs,
        toolPreview: `${label}${task.goal ? ` · ${task.goal}` : ''}`.slice(0, 220),
        toolResult: {
          ...payload,
          runtime: 'hermes',
          task_index: task.taskIndex,
          task_count: task.taskCount,
          goal: task.goal,
        },
        toolStatus: 'done',
        runMarker,
      })
    }
  }

  function findHermesBackgroundDelegateAnchor(messages: Message[], evt: RunEvent): Message | undefined {
    const taskIndex = Number((evt as any).task_index ?? 0)
    const goal = String((evt as any).goal || '').trim()
    const candidates = messages.filter(message =>
      message.role === 'tool'
      && message.toolCallId?.startsWith(HERMES_BACKGROUND_DELEGATE_ANCHOR_PREFIX)
      && runtimeObjectPayload(message.toolResult)?.runtime === 'hermes',
    )
    return candidates.find(message => {
      const payload = runtimeObjectPayload(message.toolResult)
      return Number(payload?.task_index ?? 0) === taskIndex
        && (!goal || !String(payload?.goal || '').trim() || String(payload?.goal || '').trim() === goal)
    }) || candidates.find(message => Number(runtimeObjectPayload(message.toolResult)?.task_index ?? 0) === taskIndex)
  }

  function addOrUpdateSession(session: Session) {
    const existingIndex = sessions.value.findIndex(s => s.id === session.id)
    if (existingIndex !== -1) {
      // Update existing session
      sessions.value[existingIndex] = session
    } else {
      // Add new session
      sessions.value.push(session)
    }
  }

  function updateMessage(sessionId: string, id: string, update: Partial<Message>) {
    const s = sessions.value.find(s => s.id === sessionId)
    if (!s) return
    const idx = s.messages.findIndex(m => m.id === id)
    if (idx !== -1) {
      s.messages[idx] = { ...s.messages[idx], ...update }
    }
  }

  function findToolMessageForEvent(
    messages: Message[],
    evt: RunEvent,
    toolCallId?: string,
  ): Message | undefined {
    const eventRunMarker = normalizedRunMarker(evt)
    const reversed = [...messages].reverse()
    const hasMatchingId = (message: Message) => !toolCallId || message.toolCallId === toolCallId

    if (eventRunMarker) {
      const exact = reversed.find(message =>
        message.role === 'tool'
        && hasMatchingId(message)
        && normalizedRunMarker(message) === eventRunMarker
        && (toolCallId || message.toolStatus === 'running'),
      )
      if (exact) return exact

      // A legacy started event may not have carried its run marker even when
      // the corresponding completion does. Adopt only an unscoped running row.
      return reversed.find(message =>
        message.role === 'tool'
        && hasMatchingId(message)
        && normalizedRunMarker(message) === null
        && message.toolStatus === 'running',
      )
    }

    // Without a run marker, never revive a finalized historical row. The most
    // recent running match is the only safe legacy fallback.
    return reversed.find(message =>
      message.role === 'tool'
      && hasMatchingId(message)
      && message.toolStatus === 'running',
    )
  }

  function handleToolStartedEvent(sessionId: string, evt: RunEvent, reasoning?: string) {
    const toolName = evt.tool || evt.name
    if (
      isBackgroundDelegateToolPayload(toolName, evt.arguments)
      || (isEkkoAgentSession(sessionId) && toolName === 'delegate_task')
    ) return

    const toolCallId = typeof (evt as any).tool_call_id === 'string'
      ? String((evt as any).tool_call_id)
      : undefined
    const messages = getSessionMsgs(sessionId)
    const existing = toolCallId ? findToolMessageForEvent(messages, evt, toolCallId) : undefined
    const eventRunMarker = normalizedRunMarker(evt)
    if (existing) {
      const isSettled = existing.toolStatus === 'done'
        || existing.toolStatus === 'error'
        || existing.toolResult !== undefined
      updateMessage(sessionId, existing.id, {
        toolName: toolName || existing.toolName,
        runMarker: existing.runMarker || eventRunMarker,
        toolArgs: hasRuntimeToolPayload(evt.arguments) ? evt.arguments : existing.toolArgs,
        toolPreview: evt.preview || existing.toolPreview,
        reasoning: existing.reasoning || reasoning,
        toolStatus: isSettled ? existing.toolStatus : 'running',
      })
      return
    }

    addMessage(sessionId, {
      id: uid(),
      role: 'tool',
      content: '',
      timestamp: Date.now(),
      toolName,
      toolCallId,
      runMarker: eventRunMarker,
      toolPreview: evt.preview,
      toolArgs: runtimeToolPayloadOrUndefined(evt.arguments),
      reasoning,
      toolStatus: 'running',
    })
  }

  function handleToolCompletedEvent(sessionId: string, evt: RunEvent) {
    const toolCallId = typeof (evt as any).tool_call_id === 'string'
      ? String((evt as any).tool_call_id)
      : undefined
    const messages = getSessionMsgs(sessionId)
    const existing = findToolMessageForEvent(messages, evt, toolCallId)
    const output = runtimeToolOutputFromEvent(evt)
    const toolName = evt.tool || evt.name || existing?.toolName
    const eventRunMarker = normalizedRunMarker(evt)

    if (isBackgroundDelegateToolPayload(toolName, output)) {
      const session = sessions.value.find(item => item.id === sessionId)
      if (session && existing) session.messages = session.messages.filter(message => message !== existing)
      addHermesBackgroundDelegateAnchors(
        sessionId,
        toolCallId,
        output,
        existing?.toolArgs,
        eventRunMarker,
      )
      return
    }
    if (
      isEkkoAgentSession(sessionId)
      && toolName === 'delegate_task'
      && runtimeObjectPayload(output)?.runtime === 'ekko'
    ) {
      const session = sessions.value.find(item => item.id === sessionId)
      if (session && existing) session.messages = session.messages.filter(message => message !== existing)
      return
    }

    const hasError = evt.event === 'tool.failed'
      || (evt as any).error === true
      || runtimeToolOutputHasError(output)
    if (existing) {
      updateMessage(sessionId, existing.id, {
        toolName: toolName || existing.toolName,
        runMarker: existing.runMarker || eventRunMarker,
        toolStatus: hasError ? 'error' : 'done',
        toolDuration: (evt as any).duration,
        toolResult: output,
      })
      return
    }

    // Completion can arrive after a reconnect even when the start event was
    // not replayed. Preserve the call instead of silently dropping it.
    addMessage(sessionId, {
      id: uid(),
      role: 'tool',
      content: '',
      timestamp: Date.now(),
      toolName,
      toolCallId,
      runMarker: eventRunMarker,
      toolPreview: evt.preview,
      toolResult: output,
      toolStatus: hasError ? 'error' : 'done',
      toolDuration: (evt as any).duration,
    })
  }

  function settleRunningTools(sessionId: string, status: 'done' | 'error') {
    const msgs = getSessionMsgs(sessionId)
    msgs.forEach((m, i) => {
      if (m.role === 'tool' && m.toolStatus === 'running' && !m.toolCallId?.startsWith('subagent:')) {
        msgs[i] = { ...m, toolStatus: status }
      }
    })
  }

  function settleRuntimeDisplayForCommand(sessionId: string) {
    const msgs = getSessionMsgs(sessionId)
    msgs.forEach((m, i) => {
      if (m.isStreaming) updateMessage(sessionId, m.id, { isStreaming: false })
      if (m.role === 'tool' && m.toolStatus === 'running') {
        msgs[i] = { ...m, toolStatus: 'done' }
      }
    })
  }

  function clearAgentEventMessages(sessionId: string) {
    const s = sessions.value.find(s => s.id === sessionId)
    if (!s) return
    s.messages = s.messages.filter(m => m.commandAction !== 'agent.event' || m.systemType === 'error')
  }

  function handleSubagentEvent(sessionId: string, evt: RunEvent) {
    const eventName = String(evt.event || '')
    if (!eventName.startsWith('subagent.') && eventName !== 'delegation.updated') return

    if (eventName === 'delegation.updated') {
      const delegationId = String(evt.delegation_id || '').trim()
      const status = subagentStatus((evt as any).status)
      if (status === 'running') return
      const sessionStreams = [...subagentStreams.value.values()].filter(stream =>
        stream.sessionId === sessionId && stream.status === 'running',
      )
      const exactMatch = sessionStreams.find(stream => stream.subagentId === delegationId)
      const targets = exactMatch
        ? [exactMatch]
        : ['failed', 'error', 'cancelled', 'interrupted'].includes(status)
          ? sessionStreams
          : []
      for (const stream of targets) {
        handleSubagentEvent(sessionId, {
          ...evt,
          event: 'subagent.complete',
          subagent_id: stream.subagentId,
          task_index: stream.taskIndex,
          task_count: stream.taskCount,
          goal: stream.goal,
          model: stream.model,
          status,
        })
      }
      return
    }

    const subagentId = String((evt as any).subagent_id || `${(evt as any).task_index ?? 0}`)
    const streamKey = `${sessionId}:${subagentId}`
    const currentStream = subagentStreams.value.get(streamKey)
    const nextStream = reduceSubagentStream(currentStream, sessionId, evt)
    if (nextStream === currentStream) return
    subagentStreams.value.set(streamKey, nextStream)
    const toolCallId = `subagent:${subagentId}`
    const taskIndex = Number((evt as any).task_index ?? 0)
    const taskCount = Number((evt as any).task_count ?? 1)
    const label = `${taskIndex + 1}/${Math.max(1, taskCount || 1)}`
    const toolName = String((evt as any).tool || (evt as any).name || '')
    const toolCount = Number((evt as any).tool_count || 0)
    const goal = String((evt as any).goal || '').trim()
    const rawText = String(evt.text || evt.preview || '')
    const text = rawText.trim()
    const summary = String((evt as any).summary || '').trim()
    const duration = Number((evt as any).duration_seconds ?? (evt as any).duration)

    let preview = `${label}${goal ? ` · ${goal}` : ''}`
    if (eventName === 'subagent.start') {
      preview = `${label}${goal ? ` · ${goal}` : ''}`
    } else if (eventName === 'subagent.tool') {
      preview = `${label}${toolCount ? ` · #${toolCount}` : ''}${toolName ? ` · ${toolName}` : ''}${text ? ` · ${text}` : ''}`
    } else if (eventName === 'subagent.progress' || eventName === 'subagent.text' || eventName === 'subagent.thinking') {
      preview = `${label}${text ? ` · ${text}` : goal ? ` · ${goal}` : ''}`
    } else if (eventName === 'subagent.complete') {
      preview = `${label}${summary ? ` · ${summary}` : text ? ` · ${text}` : ''}`
    }

    const msgs = getSessionMsgs(sessionId)
    const existing = msgs.find(m => m.role === 'tool' && m.toolCallId === toolCallId)
      || findHermesBackgroundDelegateAnchor(msgs, evt)
    const toolStatus = nextStream.status === 'running'
      ? 'running'
      : nextStream.status === 'completed' ? 'done' : 'error'
    const update: Partial<Message> = {
      toolName: 'delegate_task',
      toolCallId,
      toolPreview: preview.slice(0, 220),
      toolArgs: eventName === 'subagent.tool'
        ? runtimeToolPayloadOrUndefined((evt as any).arguments)
        : existing?.toolArgs,
      toolStatus,
      toolDuration: Number.isFinite(duration) ? duration : undefined,
      toolResult: eventName === 'subagent.complete'
        ? JSON.stringify({
            status: (evt as any).status || 'completed',
            summary: summary || text,
            api_calls: (evt as any).api_calls,
            input_tokens: (evt as any).input_tokens,
            output_tokens: (evt as any).output_tokens,
            output_tail: (evt as any).output_tail,
          }, null, 2)
        : existing?.toolResult,
    }

    if (existing) {
      updateMessage(sessionId, existing.id, update)
      return
    }

    addMessageInTimelineOrder(sessionId, {
      id: uid(),
      role: 'tool',
      content: '',
      timestamp: nextStream.startedAt,
      ...update,
    })
  }

  function restorePersistedSubagentStreams(sessionId: string) {
    for (const message of getSessionMsgs(sessionId)) {
      if (message.role !== 'tool' || !message.toolCallId?.startsWith('subagent:')) continue
      const subagentId = message.toolCallId.slice('subagent:'.length).trim()
      if (!subagentId || subagentStreams.value.has(`${sessionId}:${subagentId}`)) continue
      const payload = runtimeObjectPayload(message.toolResult)
      if (!payload) continue
      const status = subagentStatus(payload.status)
      const restoredOutput = String(payload.output || payload.output_tail || payload.summary || '').trim()
      handleSubagentEvent(sessionId, {
        ...payload,
        event: status === 'running' ? 'subagent.start' : 'subagent.complete',
        session_id: sessionId,
        subagent_id: subagentId,
        background: payload.mode === 'background',
        background_snapshot: true,
        summary: restoredOutput || payload.summary,
        timestamp: message.timestamp,
      } as RunEvent)
    }
  }

  function settleInterruptedSubagents(sessionId: string) {
    const runningStreams = [...subagentStreams.value.values()].filter(stream =>
      stream.sessionId === sessionId && stream.status === 'running',
    )
    for (const stream of runningStreams) {
      handleSubagentEvent(sessionId, {
        event: 'subagent.complete',
        session_id: sessionId,
        subagent_id: stream.subagentId,
        task_index: stream.taskIndex,
        task_count: stream.taskCount,
        goal: stream.goal,
        model: stream.model,
        status: 'interrupted',
        timestamp: Date.now(),
      })
    }
  }

  function getSubagentStream(sessionId: string, subagentId: string): SubagentStream | null {
    return subagentStreams.value.get(`${sessionId}:${subagentId}`) || null
  }

  function handleMoaEvent(sessionId: string, evt: RunEvent) {
    const eventName = String(evt.event || '')
    if (eventName !== 'moa.reference' && eventName !== 'moa.aggregating') return

    const msgs = getSessionMsgs(sessionId)
    if (eventName === 'moa.reference') {
      const label = moaReferenceLabel(evt)
      const index = Number.isFinite(Number(evt.index)) ? Number(evt.index) : label
      const toolCallId = `moa:reference:${evt.run_id || 'run'}:${index}`
      const output = typeof evt.text === 'string'
        ? evt.text
        : typeof evt.delta === 'string'
          ? evt.delta
          : ''
      const update: Partial<Message> = {
        toolName: 'moa_reference',
        toolCallId,
        runMarker: readRunMarker(evt),
        toolPreview: label.slice(0, 220),
        toolStatus: 'done',
        toolResult: output,
      }
      const existing = msgs.find(m => m.role === 'tool' && m.toolCallId === toolCallId)
      if (existing) {
        updateMessage(sessionId, existing.id, update)
        return
      }
      addMessage(sessionId, {
        id: uid(),
        role: 'tool',
        content: '',
        timestamp: Date.now(),
        ...update,
      })
      return
    }

    const aggregator = typeof evt.aggregator === 'string' && evt.aggregator.trim()
      ? evt.aggregator.trim()
      : 'aggregator'
    const toolCallId = `moa:aggregating:${evt.run_id || 'run'}`
    const update: Partial<Message> = {
      toolName: 'moa_aggregating',
      toolCallId,
      runMarker: readRunMarker(evt),
      toolPreview: aggregator.slice(0, 220),
      toolStatus: 'running',
      toolArgs: { aggregator },
    }
    const existing = msgs.find(m => m.role === 'tool' && m.toolCallId === toolCallId)
    if (existing) {
      updateMessage(sessionId, existing.id, update)
      return
    }
    addMessage(sessionId, {
      id: uid(),
      role: 'tool',
      content: '',
      timestamp: Date.now(),
      ...update,
    })
  }

  // A failure is a real turn outcome, so it belongs in the transcript at the
  // position where it happened and it stays there. The server persists it as a
  // `role: 'error'` row that is excluded from model context, which is why the
  // user can see it forever while the agent never receives it.
  //
  // This used to try to be clever and it broke that guarantee three ways:
  //
  //  - it overwrote a short streaming message in place, erasing the reply that
  //    the run had already produced;
  //  - it rewrote the previous error bubble when the same failure was reported
  //    twice, moving the error to the end of the transcript;
  //  - it scanned the whole history and silently dropped a new error whenever an
  //    identical one existed within the window, so retrying made the recorded
  //    failure disappear and reappear somewhere else.
  //
  // All three are gone. A failure is always appended as its own row and never
  // merged into, or suppressed by, an earlier one.
  function addAgentErrorMessage(sessionId: string, error?: unknown) {
    const message = errorMessage(error)
    const content = message ? `Error: ${message}` : 'Run failed'
    const now = Date.now()
    const msgs = getSessionMsgs(sessionId)
    const last = msgs[msgs.length - 1]
    if (last?.isStreaming) {
      // Close the stream so the partial reply stops rendering as in-flight, but
      // never reuse the row: whatever the run managed to say is real output and
      // the failure is a separate event.
      updateMessage(sessionId, last.id, { isStreaming: false })
    }
    addMessage(sessionId, {
      id: uid(),
      role: 'assistant',
      content,
      timestamp: now,
      systemType: 'error',
    })
  }

  /**
   * Failures that were previously rendered as a warning-coloured system notice
   * now share the single error bubble (`systemType: 'error'`), while keeping the
   * neutral system role so assistant-message accounting is unaffected.
   */
  function addSystemErrorMessage(sessionId: string, content: string) {
    const now = Date.now()
    addMessage(sessionId, {
      id: uid(),
      role: 'system',
      content,
      timestamp: now,
      systemType: 'error',
    })
  }

  function handleSessionCommandEvent(evt: RunEvent) {
    if (seenSessionCommandEvents.has(evt)) return
    seenSessionCommandEvents.add(evt)

    const sid = evt.session_id
    if (!sid) return
    const target = sessions.value.find(s => s.id === sid)
    const action = (evt as any).action as string | undefined
    const command = String((evt as any).command || '').toLowerCase()
    if ((evt as any).started === true && (evt as any).terminal === false) {
      markSessionRunning(sid)
      setRunStartedAt(sid, Date.now())
    }
    if ((evt as any).terminal === true) {
      markSessionIdle(sid)
      clearRunStartedAt(sid)
      pendingForkCommands.value.delete(sid)
      const msgs = getSessionMsgs(sid)
      msgs.forEach((m, i) => {
        if (m.isStreaming) updateMessage(sid, m.id, { isStreaming: false })
        if (m.role === 'tool' && m.toolStatus === 'running') {
          msgs[i] = { ...m, toolStatus: (evt as any).ok === false ? 'error' : 'done' }
        }
      })
    }

    if (action === 'clear' && command === 'clear') {
      if (target) target.messages = []
      queuedUserMessages.value.delete(sid)
      queueLengths.value.delete(sid)
      queueInsertionStates.value.delete(sid)
      clearMessageReference(sid)
      if ((evt as any).clearHistory) {
        const message = String((evt as any).message || '')
        if (message) {
          addMessage(sid, {
            id: uid(),
            role: 'command',
            content: message,
            timestamp: Date.now(),
            systemType: (evt as any).ok === false ? 'error' : 'command',
            commandAction: action,
            commandData: { ...(evt as any) },
          })
        }
      }
      return
    }

    if (action === 'title' && target && typeof (evt as any).title === 'string') {
      target.title = (evt as any).title
    }

    if (action === 'usage' && target && (evt as any).available !== false) {
      applySessionTokenUsage(target, evt as any)
    }

    if (action === 'destroy') {
      markSessionIdle(sid)
      clearRunStartedAt(sid)
      queueLengths.value.delete(sid)
      queuedUserMessages.value.delete(sid)
      queueInsertionStates.value.delete(sid)
      clearMessageReference(sid)
      setAbortState(sid, null)
      const msgs = getSessionMsgs(sid)
      msgs.forEach(m => {
        if (m.isStreaming) updateMessage(sid, m.id, { isStreaming: false })
        if (m.role === 'tool' && m.toolStatus === 'running') m.toolStatus = 'error'
      })
    }

    if (action === 'branch' && (evt as any).ok !== false) {
      const branch = ((evt as any).branchSession || {}) as Record<string, unknown>
      const newSessionId = String((evt as any).newSessionId || branch.id || '').trim()
      if (newSessionId) {
        const existing = sessions.value.find(s => s.id === newSessionId)
        if (!existing) {
          sessions.value.unshift({
            id: newSessionId,
            profile: typeof branch.profile === 'string' ? branch.profile : undefined,
            title: String((evt as any).newSessionTitle || branch.title || 'Branch'),
            source: typeof branch.source === 'string' ? branch.source : 'cli',
            messages: [],
            createdAt: typeof branch.createdAt === 'number' ? branch.createdAt : Date.now(),
            updatedAt: typeof branch.updatedAt === 'number' ? branch.updatedAt : Date.now(),
            model: typeof branch.model === 'string' ? branch.model : undefined,
            provider: typeof branch.provider === 'string' ? branch.provider : undefined,
            messageCount: typeof branch.messageCount === 'number' ? branch.messageCount : undefined,
            messageTotal: typeof branch.messageCount === 'number' ? branch.messageCount : undefined,
            loadedMessageCount: 0,
            hasMoreBefore: false,
            parentSessionId: typeof branch.parentSessionId === 'string'
              ? branch.parentSessionId
              : typeof (evt as any).parentSessionId === 'string' ? (evt as any).parentSessionId : sid,
            forkPointMessageId: branch.forkPointMessageId != null ? String(branch.forkPointMessageId) : null,
            parentTitle: typeof branch.parentTitle === 'string' ? branch.parentTitle : target?.title || null,
            parentLastMessage: typeof branch.parentLastMessage === 'string' ? branch.parentLastMessage : lastVisibleMessageContent(target?.messages),
            parentLastMessageRole: typeof branch.parentLastMessageRole === 'string' ? branch.parentLastMessageRole : lastVisibleMessageRole(target?.messages),
            workspace: typeof branch.workspace === 'string' ? branch.workspace : null,
          })
        }
        void switchSession(newSessionId)
      }
    }

    const message = String((evt as any).message || '')
    if (message) {
      addMessage(sid, {
        id: uid(),
        role: 'command',
        content: message,
        timestamp: Date.now(),
        systemType: (evt as any).ok === false ? 'error' : 'command',
        commandAction: action,
        commandData: { ...(evt as any) },
      })
    }
  }

  function handleAgentEvent(evt: RunEvent) {
    const sid = evt.session_id
    if (!sid) return
    if (evt.event === 'plan.updated') {
      const target = sessions.value.find(session => session.id === sid)
      if (target) target.messages = mergeTaskPlanMessages(target.messages, [evt], sid)
      return
    }
    if ((evt as any).source === 'coding_agent' && (evt as any).kind === 'status') return
    // A payload that arrives on `error` is a failure by construction, so it is
    // tagged structurally. Guessing from ordinary message text misfired badly
    // ("Error handling in the parser looks correct", "The failed test was
    // flaky") and painted real replies red.
    const rawError = (evt as any).error
    const isErrorEvent = typeof rawError === 'string' && rawError.trim() !== ''
    const text = String((evt as any).text || (evt as any).message || rawError || '').trim()
    if (!text) return
    // Some bridge failures arrive as status *text* rather than an `error` field,
    // e.g. "Non-retryable error (HTTP 502): ...". Those must not fall through to
    // the notice bubble and then be re-rendered red once the server persists the
    // same failure, which made one run look like two differently-styled errors.
    // Only unambiguous machine-generated signatures count; none of them can
    // occur in a normal reply.
    //
    // The lease notices are routed with them, and `kind === 'warn'` with those:
    // what falls past this point is progress, and progress is not a problem.
    if ((evt as any).event === 'run.reattach_failed' || isErrorEvent || isBridgeFailureText(text)
      || isBridgeBlockedText(text) || isWarningStatusKind((evt as any).kind)) {
      addAgentErrorMessage(sid, text)
      return
    }

    const msgs = getSessionMsgs(sid)
    const last = msgs[msgs.length - 1]
    const commandData = { ...(evt as any) }
    if (last?.role === 'system' && last.commandAction === 'agent.event') {
      if (last.content === text) return
      updateMessage(sid, last.id, {
        content: text,
        timestamp: Date.now(),
        commandData,
      })
      return
    }

    addMessage(sid, {
      id: uid(),
      role: 'system',
      content: text,
      timestamp: Date.now(),
      commandAction: 'agent.event',
      commandData,
    })
  }

  function enqueueUserMessage(sessionId: string, message: Message) {
    const queue = queuedUserMessages.value.get(sessionId) || []
    if (queue.some(item => item.id === message.id)) return
    const nextMap = new Map(queuedUserMessages.value)
    nextMap.set(sessionId, [...queue, { ...message, queued: true }])
    queuedUserMessages.value = nextMap
  }

  function updateQueuedUserMessage(sessionId: string, messageId: string, patch: Partial<Message>) {
    const queue = queuedUserMessages.value.get(sessionId)
    if (!queue?.length) return
    const next = queue.map(message => message.id === messageId
      ? { ...message, ...patch, queued: true }
      : message)
    const nextMap = new Map(queuedUserMessages.value)
    nextMap.set(sessionId, next)
    queuedUserMessages.value = nextMap
  }

  function dropQueuedUserMessage(sessionId: string, messageId: string): boolean {
    const queue = queuedUserMessages.value.get(sessionId)
    if (!queue?.length) return false
    const next = queue.filter(message => message.id !== messageId)
    if (next.length === queue.length) return false
    const nextMap = new Map(queuedUserMessages.value)
    if (next.length > 0) {
      nextMap.set(sessionId, next)
      queueLengths.value.set(sessionId, next.length)
    } else {
      nextMap.delete(sessionId)
      queueLengths.value.delete(sessionId)
    }
    queuedUserMessages.value = nextMap
    return true
  }

  function removeQueuedMessage(sessionId: string, messageId: string) {
    if (!dropQueuedUserMessage(sessionId, messageId)) return
    getChatRunSocket(runtimeTransport())?.emit('cancel_queued_run', {
      session_id: sessionId,
      queue_id: messageId,
    })
  }

  function insertQueuedMessage(sessionId: string, messageId: string) {
    if (!(queuedUserMessages.value.get(sessionId) || []).some(message => message.id === messageId)) return
    getChatRunSocket(runtimeTransport())?.emit('insert_queued_run', {
      session_id: sessionId,
      queue_id: messageId,
    })
  }

  function replaceQueueInsertionState(sessionId: string, raw: ResumeSessionPayload['queueInsertion'] | RunEvent | null | undefined) {
    const nextMap = new Map(queueInsertionStates.value)
    const phase = raw?.phase
    const generation = typeof raw?.generation === 'string' ? raw.generation : ''
    const queueId = typeof raw?.queue_id === 'string' ? raw.queue_id : ''
    if (!raw || phase === 'cancelled' || phase === 'starting_queued_message' || !generation || !queueId) {
      nextMap.delete(sessionId)
      queueInsertionStates.value = nextMap
      return
    }
    if (phase !== 'requesting' && phase !== 'waiting_for_tool_batch' && phase !== 'stopping_current_turn') return
    nextMap.set(sessionId, {
      generation,
      runId: typeof raw.run_id === 'string' ? raw.run_id : undefined,
      queueId,
      runtime: raw.runtime === 'ekko'
        || raw.runtime === 'claude-code'
        || raw.runtime === 'codex'
        || raw.runtime === 'pi'
        || raw.runtime === 'grok'
        || raw.runtime === 'opencode'
        || raw.runtime === 'dsh'
        || raw.runtime === 'cursor'
        ? raw.runtime
        : 'hermes',
      phase,
      guarantee: raw.guarantee === 'immediate' ? 'immediate' : 'strict',
      requestedAt: typeof raw.requested_at === 'number' ? raw.requested_at : Date.now(),
    })
    queueInsertionStates.value = nextMap
  }

  function handleQueueInsertionUpdated(evt: RunEvent) {
    const sid = evt.session_id
    if (!sid) return
    replaceQueueInsertionState(sid, evt)
  }

  function normalizeQueuedUserMessages(rawMessages: unknown): Message[] {
    if (!Array.isArray(rawMessages)) return []
    return rawMessages.flatMap((raw) => {
      const peer = raw as NonNullable<RunEvent['queued_messages']>[number]
      const content = typeof peer?.content === 'string' ? peer.content : ''
      const messageId = peer?.id != null ? String(peer.id) : ''
      if (!messageId || !content.trim()) return []
      const timestamp = typeof peer?.timestamp === 'number' && Number.isFinite(peer.timestamp)
        ? Math.round(peer.timestamp * 1000)
        : Date.now()
      const role = peer?.role === 'command' ? 'command' : 'user'
      return [{
        id: messageId,
        role,
        content,
        timestamp,
        queued: true,
        systemType: role === 'command' ? 'command' as const : undefined,
      }]
    })
  }

  function replaceQueuedUserMessages(sessionId: string, messages: Message[]) {
    const existingById = new Map((queuedUserMessages.value.get(sessionId) || []).map(message => [message.id, message]))
    const merged = messages.map(message => ({
      ...(existingById.get(message.id) || {}),
      ...message,
      attachments: existingById.get(message.id)?.attachments || message.attachments,
      queued: true,
    }))
    const nextMap = new Map(queuedUserMessages.value)
    if (merged.length > 0) {
      nextMap.set(sessionId, merged)
    } else {
      nextMap.delete(sessionId)
    }
    queuedUserMessages.value = nextMap
  }

  function markDequeuedQueueId(sessionId: string, messageId: string) {
    const nextMap = new Map(dequeuedQueueIds.value)
    const ids = new Set(nextMap.get(sessionId) || [])
    ids.add(messageId)
    nextMap.set(sessionId, ids)
    dequeuedQueueIds.value = nextMap
  }

  function consumeDequeuedQueueId(sessionId: string, messageId: string): boolean {
    const ids = dequeuedQueueIds.value.get(sessionId)
    if (!ids?.has(messageId)) return false
    const nextIds = new Set(ids)
    nextIds.delete(messageId)
    const nextMap = new Map(dequeuedQueueIds.value)
    if (nextIds.size > 0) nextMap.set(sessionId, nextIds)
    else nextMap.delete(sessionId)
    dequeuedQueueIds.value = nextMap
    return true
  }

  function handleRunQueuedEvent(sessionId: string, evt: RunEvent) {
    const queueLength = Number((evt as any).queue_length || 0)
    if (queueLength > 0) {
      queueLengths.value.set(sessionId, queueLength)
    } else {
      queueLengths.value.delete(sessionId)
    }

    const dequeuedId = (evt as any).dequeued_queue_id != null
      ? String((evt as any).dequeued_queue_id)
      : ''
    if (dequeuedId) {
      const existingQueue = queuedUserMessages.value.get(sessionId) || []
      const dequeued = existingQueue.find(message => message.id === dequeuedId)
      if (Array.isArray((evt as any).queued_messages)) {
        const queued = normalizeQueuedUserMessages((evt as any).queued_messages)
        replaceQueuedUserMessages(sessionId, queued)
      } else {
        const nextQueue = existingQueue.filter(message => message.id !== dequeuedId)
        replaceQueuedUserMessages(sessionId, nextQueue)
      }
      if (dequeued && !getSessionMsgs(sessionId).some(message => message.id === dequeued.id)) {
        addMessage(sessionId, { ...dequeued, queued: false })
        updateSessionTitle(sessionId)
      } else if (!dequeued) {
        markDequeuedQueueId(sessionId, dequeuedId)
      }
      return
    }

    if (Array.isArray((evt as any).queued_messages)) {
      const queued = normalizeQueuedUserMessages((evt as any).queued_messages)
      replaceQueuedUserMessages(sessionId, queued)
      return
    }

    const peer = evt.message
    const content = typeof peer?.content === 'string' ? peer.content : ''
    const messageId = peer?.id != null ? String(peer.id) : ''
    if (!messageId || !content.trim()) return

    if ((queuedUserMessages.value.get(sessionId) || []).some(msg => msg.id === messageId)) return

    const timestamp = typeof peer?.timestamp === 'number' && Number.isFinite(peer.timestamp)
      ? Math.round(peer.timestamp * 1000)
      : Date.now()
    const msgs = getSessionMsgs(sessionId)
    const existingIndex = msgs.findIndex(msg => msg.id === messageId && msg.role === 'user')
    const existing = existingIndex >= 0 ? msgs[existingIndex] : null
    if (existingIndex >= 0) {
      msgs.splice(existingIndex, 1)
    }

    enqueueUserMessage(sessionId, {
      ...(existing || {}),
      id: messageId,
      role: peer?.role === 'command' ? 'command' : 'user',
      content,
      timestamp: existing?.timestamp || timestamp,
      attachments: existing?.attachments,
      queued: true,
      systemType: peer?.role === 'command' ? 'command' : existing?.systemType,
    })
  }

  function setPendingApproval(evt: RunEvent) {
    const sid = evt.session_id
    const approvalId = (evt as any).approval_id as string | undefined
    if (!sid || !approvalId) return
    if (pendingApprovalResponseIds.get(sid) !== approvalId) pendingApprovalResponseIds.delete(sid)
    const description = String((evt as any).description || '')
    const normalizedDescription = description.trim().toLowerCase().replace(/\s+/g, ' ')
    const isMemoryWrite = !Boolean((evt as any).allow_permanent) && (
      normalizedDescription === 'save to memory' ||
      normalizedDescription.startsWith('save to memory:') ||
      normalizedDescription.startsWith('save to memory?')
    )
    const rawChoices = Array.isArray((evt as any).choices) ? (evt as any).choices : ['once', 'session', 'deny']
    const choices = rawChoices
      .filter((choice: unknown): choice is PendingApproval['choices'][number] =>
        choice === 'once' || choice === 'session' || choice === 'always' || choice === 'deny')
    pendingApprovals.value.set(sid, {
      sessionId: sid,
      approvalId,
      command: String((evt as any).command || ''),
      description,
      choices: isMemoryWrite ? ['once', 'deny'] : choices.length ? choices : ['once', 'session', 'deny'],
      allowPermanent: Boolean((evt as any).allow_permanent),
      isMemoryWrite,
      requestedAt: Date.now(),
      countdownDeadline: pendingInteractionDeadline(
        (evt as any).remaining_timeout_ms,
        (evt as any).timeout_ms,
      ),
    })
    pendingApprovals.value = new Map(pendingApprovals.value)
  }

  function clearPendingApproval(evt: RunEvent) {
    const sid = evt.session_id
    if (!sid) return
    const approvalId = String((evt as any).approval_id || '')
    const attempted = Boolean(approvalId && pendingApprovalResponseIds.get(sid) === approvalId)
    if (attempted) pendingApprovalResponseIds.delete(sid)
    const current = pendingApprovals.value.get(sid)
    if (!current) {
      if (attempted && (evt as any).resolved === false && ((evt as any).stale === true || isPendingInteractionExpiredError((evt as any).error || (evt as any).reason))) {
        notifyPendingInteractionExpired()
      }
      return
    }
    if (approvalId && current.approvalId !== approvalId) return
    if ((evt as any).resolved === false) {
      if ((evt as any).stale === true || isPendingInteractionExpiredError((evt as any).error || (evt as any).reason)) {
        dismissPendingApprovalFor(sid, current.approvalId)
        if (attempted) notifyPendingInteractionExpired()
      }
      return
    }
    pendingApprovals.value.delete(sid)
    pendingApprovals.value = new Map(pendingApprovals.value)
  }

  function setPendingClarify(evt: RunEvent) {
    const sid = evt.session_id
    const clarifyId = (evt as any).clarify_id as string | undefined
    if (!sid || !clarifyId) return
    if (pendingClarifyResponseIds.get(sid) !== clarifyId) pendingClarifyResponseIds.delete(sid)
    pendingClarifies.value.set(sid, {
      sessionId: sid,
      clarifyId,
      question: String((evt as any).question || ''),
      choices: Array.isArray((evt as any).choices) ? (evt as any).choices : null,
      initialResponse: String((evt as any).initial_response || ''),
      responseMode: String((evt as any).response_mode || ''),
      timeoutMs: Number((evt as any).timeout_ms) || 300000,
      requestedAt: Date.now(),
      countdownDeadline: pendingInteractionDeadline(
        (evt as any).remaining_timeout_ms,
        (evt as any).timeout_ms,
      ),
    })
    pendingClarifies.value = new Map(pendingClarifies.value)
  }

  function clearPendingClarify(evt: RunEvent) {
    const sid = evt.session_id
    if (!sid) return
    const clarifyId = String((evt as any).clarify_id || '')
    const attempted = Boolean(clarifyId && pendingClarifyResponseIds.get(sid) === clarifyId)
    if (attempted) pendingClarifyResponseIds.delete(sid)
    const current = pendingClarifies.value.get(sid)
    if (!current) {
      if (attempted && (evt as any).resolved === false && ((evt as any).stale === true || isPendingInteractionExpiredError((evt as any).error || (evt as any).reason))) {
        notifyPendingInteractionExpired()
      }
      return
    }
    if (clarifyId && current.clarifyId !== clarifyId) return
    if ((evt as any).resolved === false) {
      if ((evt as any).stale === true || isPendingInteractionExpiredError((evt as any).error || (evt as any).reason)) {
        dismissPendingClarifyFor(sid, current.clarifyId)
        if (attempted) notifyPendingInteractionExpired()
      }
      return
    }
    pendingClarifies.value.delete(sid)
    pendingClarifies.value = new Map(pendingClarifies.value)
  }

  function clearPendingInteractions(sessionId: string) {
    pendingApprovalResponseIds.delete(sessionId)
    pendingClarifyResponseIds.delete(sessionId)
    let changed = false
    if (pendingApprovals.value.has(sessionId)) {
      pendingApprovals.value.delete(sessionId)
      changed = true
    }
    if (pendingClarifies.value.has(sessionId)) {
      pendingClarifies.value.delete(sessionId)
      changed = true
    }
    if (changed) {
      pendingApprovals.value = new Map(pendingApprovals.value)
      pendingClarifies.value = new Map(pendingClarifies.value)
    }
  }

  function dismissPendingApprovalFor(sessionId: string, approvalId: string) {
    const pending = pendingApprovals.value.get(sessionId)
    if (!pending || pending.approvalId !== approvalId) return
    pendingApprovals.value.delete(sessionId)
    pendingApprovals.value = new Map(pendingApprovals.value)
  }

  function dismissPendingClarifyFor(sessionId: string, clarifyId: string) {
    const pending = pendingClarifies.value.get(sessionId)
    if (!pending || pending.clarifyId !== clarifyId) return
    pendingClarifies.value.delete(sessionId)
    pendingClarifies.value = new Map(pendingClarifies.value)
  }

  function respondToClarifyFor(sessionId: string, clarifyId: string, response: string): PendingInteractionSubmitResult {
    const pending = pendingClarifies.value.get(sessionId)
    if (!pending || pending.clarifyId !== clarifyId) return 'missing'
    respondClarify(sessionId, clarifyId, response, runtimeTransport())
    pendingClarifyResponseIds.set(sessionId, clarifyId)
    return 'submitted'
  }

  function respondToClarify(response: string): PendingInteractionSubmitResult {
    const pending = activePendingClarify.value
    if (!pending) return 'missing'
    const result = respondToClarifyFor(pending.sessionId, pending.clarifyId, response)
    if (result === 'submitted') dismissPendingClarifyFor(pending.sessionId, pending.clarifyId)
    return result
  }


  function respondApprovalFor(sessionId: string, approvalId: string, choice: PendingApproval['choices'][number]): PendingInteractionSubmitResult {
    const pending = pendingApprovals.value.get(sessionId)
    if (!pending || pending.approvalId !== approvalId) return 'missing'
    respondToolApproval(sessionId, approvalId, choice, runtimeTransport())
    pendingApprovalResponseIds.set(sessionId, approvalId)
    return 'submitted'
  }

  function respondApproval(choice: PendingApproval['choices'][number]): PendingInteractionSubmitResult {
    const pending = activePendingApproval.value
    if (!pending) return 'missing'
    const result = respondApprovalFor(pending.sessionId, pending.approvalId, choice)
    if (result === 'submitted') dismissPendingApprovalFor(pending.sessionId, pending.approvalId)
    return result
  }

  function updateSessionTitle(sessionId: string) {
    const target = sessions.value.find(s => s.id === sessionId)
    if (!target) return
    if (!target.title) {
      const firstUser = target.messages.find(m => m.role === 'user')
      if (firstUser) {
        const title = firstUser.attachments?.length
          ? firstUser.attachments.map(a => a.name).join(', ')
          : firstUser.content
        target.title = title.slice(0, 40) + (title.length > 40 ? '...' : '')
      }
    }
  }

  function applyGeneratedSessionTitle(evt: RunEvent) {
    const sid = evt.session_id
    const title = typeof (evt as any).title === 'string' ? (evt as any).title.trim() : ''
    if (!sid || !title) return
    const target = sessions.value.find(s => s.id === sid)
    if (target) {
      target.title = title
    }
    if (activeSession.value?.id === sid) {
      activeSession.value.title = title
    }
  }

  function applySessionWorkspaceUpdate(evt: RunEvent) {
    const sid = evt.session_id
    const workspace = typeof evt.workspace === 'string' ? evt.workspace.trim() : ''
    if (!sid || !workspace) return
    const target = sessions.value.find(s => s.id === sid)
    if (target) {
      target.workspace = workspace
      target.isLocalOnly = false
    }
    if (activeSession.value?.id === sid) {
      activeSession.value.workspace = workspace
      activeSession.value.isLocalOnly = false
    }
  }

  function applySessionSettingsUpdate(evt: RunEvent) {
    const sid = evt.session_id
    if (!sid) return
    const targets = [sessions.value.find(s => s.id === sid), activeSession.value?.id === sid ? activeSession.value : null]
      .filter((session): session is Session => Boolean(session))
    for (const target of new Set(targets)) {
      if (typeof evt.model === 'string') target.model = evt.model
      if (typeof evt.provider === 'string') target.provider = evt.provider
      if (typeof evt.api_mode === 'string') target.apiMode = evt.api_mode as ProviderApiMode || undefined
      if (typeof evt.reasoning_effort === 'string') {
        const incomingEffort = evt.reasoning_effort || undefined
        const pendingEffort = reasoningEffortWriteTargets.get(sid)
        if (!reasoningEffortWriteTargets.has(sid) || pendingEffort === incomingEffort) {
          target.reasoningEffort = incomingEffort
        }
      }
      if (typeof evt.push_enabled === 'boolean') {
        const pendingEnabled = pushEnabledWriteTargets.get(sid)
        if (!pushEnabledWriteTargets.has(sid) || pendingEnabled === evt.push_enabled) {
          target.pushEnabled = evt.push_enabled
        }
      }
    }
  }

  function applyResumedSessionSettings(data: ResumeSessionPayload) {
    applySessionSettingsUpdate({
      event: 'session.settings.updated',
      session_id: data.session_id,
      ...(typeof data.model === 'string' ? { model: data.model } : {}),
      ...(typeof data.provider === 'string' ? { provider: data.provider } : {}),
      ...(typeof data.api_mode === 'string' ? { api_mode: data.api_mode || undefined } : {}),
      ...(typeof data.reasoning_effort === 'string' ? { reasoning_effort: data.reasoning_effort } : {}),
      ...(typeof data.push_enabled === 'boolean' ? { push_enabled: data.push_enabled } : {}),
    })
  }

  function primeNotificationSoundIfEnabled() {
    const { display } = useSettingsStore()
    if (display.bell_on_complete || display.approval_bell) {
      primeCompletionSound()
    }
  }

  function playCompletionBellIfEnabled() {
    if (useSettingsStore().display.bell_on_complete) {
      void playCompletionSound()
    }
  }

  function truncateNotificationText(value: string, maxLength: number): string {
    const normalized = value.replace(/\s+/g, ' ').trim()
    if (normalized.length <= maxLength) return normalized
    return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`
  }

  function completionNotificationAgent(session: Session): { icon: string } {
    // Reuse the shared avatar map: a second copy of these paths is how the
    // subpath build ended up with icon 404s for the newer agents.
    const codingAgentId = session.codingAgentId || agentToCodingAgentId(session.agent)
    return { icon: chatSessionAgentAvatar({ codingAgentId }).src }
  }

  function completionNotificationBody(session: Session, message?: Message): string {
    const preview = message?.content || session.title || 'Message complete.'
    return truncateNotificationText(preview, 140)
  }

  /**
   * Sessions this client has already reported finished, so one completed run
   * cannot notify twice and a leak cannot notify every poll.
   */
  const snapshotFinishNotified = new Set<string>()

  /**
   * The single place a run is declared finished.
   *
   * Three paths used to conclude "done" independently:
   *
   *   1. two `run.completed` handlers, one per transport (socket start, resume);
   *   2. the periodic snapshot, for sessions this client is not attached to;
   *   3. the delegation reconciliation inside the snapshot.
   *
   * Each decided for itself whether to notify, and only path 2 consulted the
   * dedupe set. So one completion could fire twice (socket, then the snapshot
   * that followed it), and the notice for a non-active session was delivered up
   * to a full poll interval late -- which is what "the notification is delayed"
   * looked like. Deduplicating here rather than at each caller means a new
   * completion path cannot reintroduce either problem.
   *
   * `messageId` is only known to the transport paths; the snapshot has no
   * message to point at and lets the notification pick the latest assistant
   * message itself.
   */
  function settleSessionFinished(sessionId: string, messageId?: string | null) {
    const sid = String(sessionId || '').trim()
    if (!sid) return
    const alreadyReported = snapshotFinishNotified.has(sid)
    snapshotFinishNotified.add(sid)
    // Whoever gets here first is the authority: the snapshot may lag behind a
    // terminal event this client already saw, so it must not overwrite a
    // message-specific notification with a less precise one.
    if (alreadyReported) return
    if (!sessions.value.some(session => session.id === sid)) return
    if (sid === activeSessionId.value) return
    showCompletionNotificationIfEnabled(sid, messageId ?? null)
  }

  function showCompletionNotificationIfEnabled(sessionId: string, messageId?: string | null) {
    const settingsStore = useSettingsStore()
    if (!settingsStore.display.notify_on_complete) return

    const session = sessions.value.find(s => s.id === sessionId)
    if (!session) return
    const message = messageId
      ? session.messages.find(m => m.id === messageId)
      : [...session.messages].reverse().find(m => m.role === 'assistant')

    const agent = completionNotificationAgent(session)
    void showCompletionNotification({
      title: truncateNotificationText(session.title || 'Hermes', 80),
      body: completionNotificationBody(session, message),
      icon: agent.icon,
      tag: `hermes-complete-${sessionId}-${message?.id || Date.now()}`,
    })
  }

  // Shared run-event helpers — single source for the two big switch blocks
  // (startRunViaSocket + resumeServerWorkingRun). Mutates ctx in place.
  type RunEventCtx = {
    sid: string
    activeAssistantMessageId: string | null
    reasoningAssistantMessageId: string | null
    activeRunMarker: string | null
    runProducedAssistantText: boolean
    runProducedAssistantContent: boolean
    runHadToolActivity: boolean
  }

  function handleReasoningDeltaShared(evt: RunEvent, ctx: RunEventCtx) {
    const text = (evt as any).text || (evt as any).delta || ''
    if (!text) return
    ctx.runProducedAssistantText = true
    // Sidebar order should not jitter on every streamed reasoning character;
    // it is bumped on structural events (tool finished / sentence settled) instead.
    const msgs = getSessionMsgs(ctx.sid)
    const reasoningTargetId = ctx.reasoningAssistantMessageId || ctx.activeAssistantMessageId
    const last = reasoningTargetId ? msgs.find(m => m.id === reasoningTargetId) : null
    if (last?.role === 'assistant') {
      last.reasoning = (last.reasoning || '') + text
      ctx.reasoningAssistantMessageId = last.id
      noteReasoningStart(last.id)
    } else {
      if (isDuplicateAssistantContent(msgs, 'assistant', text, Date.now())) return
      const newId = uid()
      addMessage(ctx.sid, { id: newId, role: 'assistant', content: '', timestamp: Date.now(), isStreaming: true, reasoning: text } as Message)
      ctx.activeAssistantMessageId = newId
      ctx.reasoningAssistantMessageId = newId
      noteReasoningStart(newId)
    }
  }

  function handleMessageDeltaShared(evt: RunEvent, ctx: RunEventCtx) {
    if ((evt as any).delta) {
      ctx.runProducedAssistantText = true
      ctx.runProducedAssistantContent = true
    }
    const msgs = getSessionMsgs(ctx.sid)
    const last = ctx.activeAssistantMessageId ? msgs.find(m => m.id === ctx.activeAssistantMessageId) : null
    if (last?.role === 'assistant' && last.isStreaming) {
      const prev = last.content
      const next = prev + ((evt as any).delta || '')
      noteThinkingDelta(last.id, prev, next)
      if (last.reasoning) noteReasoningEnd(last.id)
      last.content = next
    } else {
      const nextContent = (evt as any).delta || ''
      if (isDuplicateAssistantContent(msgs, 'assistant', nextContent, Date.now())) return
      const newId = uid()
      noteThinkingDelta(newId, '', nextContent)
      addMessage(ctx.sid, { id: newId, role: 'assistant', content: nextContent, timestamp: Date.now(), isStreaming: true } as Message)
      ctx.activeAssistantMessageId = newId
    }
  }

  function handleMessageInterimShared(evt: RunEvent, ctx: RunEventCtx) {
    const text = String((evt as any).text || '')
    if (!text.trim()) return
    ctx.runProducedAssistantText = true
    ctx.runProducedAssistantContent = true
    const msgs = getSessionMsgs(ctx.sid)
    const active = ctx.activeAssistantMessageId ? msgs.find(m => m.id === ctx.activeAssistantMessageId) : null
    if (active?.role === 'assistant') {
      active.content = text
      active.isStreaming = false
      if (active.reasoning) noteReasoningEnd(active.id)
    } else {
      if (isDuplicateAssistantContent(msgs, 'assistant', text, Date.now())) return
      addMessage(ctx.sid, { id: uid(), role: 'assistant', content: text, timestamp: Date.now(), isStreaming: false } as Message)
    }
    ctx.activeAssistantMessageId = null
    ctx.reasoningAssistantMessageId = null
  }

  async function sendMessage(content: string, attachments?: Attachment[]) {
    const generation = runtimeGeneration
    if ((!content.trim() && !(attachments && attachments.length > 0))) return

    primeNotificationSoundIfEnabled()

    // The composer inserts `/plan-only` for a custom skill: what the menu shows
    // is what gets typed. That bare form is not a known bridge command, so it
    // would be sent as an ordinary user message and the Agent would receive the
    // text without ever loading the skill. Rewrite it here, at the one place that
    // decides what goes on the wire, so hand-typing behaves the same as selecting
    // from the menu.
    const trimmedContent = rewriteSkillSlashCommand(
      content.trim(),
      knownSkillCommandNames.value,
      // Bridge sessions only. In a coding-agent session `/skill` is inert text
      // (`isBridgeSlashCommand` is `!isCodingAgentSession && ...`), and an Ekko
      // session dispatches skills by bare name -- it injects valid skill names
      // into context and the model loads the body itself. Prefixing here would
      // replace a working invocation with one the agent cannot resolve.
      activeSession.value?.source === 'cli',
    )

    if (!activeSession.value) {
      const session = createSession()
      switchSession(session.id)
    }

    // Capture session ID at send time — all callbacks use this, not activeSessionId
    const sid = activeSessionId.value!
    const shouldSendInitialSessionConfig = activeSession.value
      ? activeSession.value.messageCount == null || activeSession.value.messageCount === 0
      : false
    const isCodingAgentSession = isCodingAgentLikeSession(activeSession.value)
    const isBridgeSlashCommand = !isCodingAgentSession && isKnownBridgeSessionCommand(trimmedContent)
    const isBridgeCompressCommand = isBridgeSlashCommand && /^\/compress(?:\s|$)/i.test(trimmedContent)
    const isBridgePlanCommand = isBridgeSlashCommand && /^\/plan(?:\s|$)/i.test(trimmedContent)
    const isBridgeSkillCommand = isBridgeSlashCommand && /^\/skill(?:\s|$)/i.test(trimmedContent)
    const isBridgeBundleCommand = isBridgeSlashCommand && /^\/bundles(?:\s|$)/i.test(trimmedContent)
    const isBridgeMoaCommand = isBridgeSlashCommand && /^\/moa(?:\s|$)/i.test(trimmedContent)
    const isBridgeGoalCommand = isBridgeSlashCommand && /^\/goal(?:\s|$)/i.test(trimmedContent)
    const isBridgeForkCommand = isBridgeSlashCommand && /^\/fork(?:\s|$)/i.test(trimmedContent)
    const messageReference = isBridgeSlashCommand ? null : messageReferences.value.get(sid) || null
    const submittedContent = messageReference
      ? formatMessageWithReference(messageReference, trimmedContent)
      : trimmedContent
    // Coding agents were excluded here, which is the one path where the user has
    // definitely just started a run and least wants to wait for a poll. The
    // exclusion came in with an upstream commit and carried no reason; the
    // snapshot corrects a wrong guess within one interval, so guessing early is
    // strictly better than being dark late.
    const shouldOptimisticallyShowRunStatus = !isBridgeForkCommand
    const wasLiveBeforeSend = isSessionLive(sid)
    if (isBridgeForkCommand) {
      if (pendingForkCommands.value.has(sid)) return
      pendingForkCommands.value = new Set(pendingForkCommands.value).add(sid)
    }
    const shouldQueue = wasLiveBeforeSend && (
      !isBridgeSlashCommand ||
      isBridgePlanCommand ||
      isBridgeSkillCommand ||
      isBridgeBundleCommand ||
      isBridgeMoaCommand
    )
    if (isBridgeSlashCommand && !shouldQueue && !wasLiveBeforeSend) {
      settleRuntimeDisplayForCommand(sid)
    }

    const visibleAttachments = attachments?.filter(attachment => !attachment.videoFrameFor)
    const userMsg: Message = {
      id: uid(),
      role: isBridgeSlashCommand ? 'command' : 'user',
      content: submittedContent,
      timestamp: Date.now(),
      attachments: visibleAttachments && visibleAttachments.length > 0 ? visibleAttachments : undefined,
      queued: shouldQueue,
      systemType: isBridgeSlashCommand ? 'command' : undefined,
    }

    if (shouldQueue) {
      enqueueUserMessage(sid, userMsg)
    } else {
      addMessage(sid, userMsg)
      updateSessionTitle(sid)
      if (shouldOptimisticallyShowRunStatus) {
        setRunStartedAt(sid, Date.now())
        markSessionRunning(sid)
      }
    }
    clearMessageReference(sid)

    let runSubmitted = false
    try {

      // Build input in Anthropic format
      let input: string | ContentBlock[]
      let displayInput: string | ContentBlock[] | undefined
      if (attachments && attachments.length > 0) {
        // Has attachments: upload first, then build content blocks
        const uploaded = await uploadFiles(attachments)
        if (generation !== runtimeGeneration) return

        // Update attachment URLs on the user message for display
        const urlMap = new Map(uploaded.map(f => {
          return [f.name, getDownloadUrl(f.path, f.name)]
        }))
        if (shouldQueue && userMsg.attachments) {
          userMsg.attachments = userMsg.attachments.map(a => {
            const dl = urlMap.get(a.name)
            return dl ? { ...a, url: dl } : a
          })
          updateQueuedUserMessage(sid, userMsg.id, { attachments: userMsg.attachments })
        } else {
          const msgs = getSessionMsgs(sid)
          const lastUser = msgs.findLast(m => m.id === userMsg.id)
          if (lastUser?.attachments) {
            lastUser.attachments = lastUser.attachments.map(a => {
              const dl = urlMap.get(a.name)
              return dl ? { ...a, url: dl } : a
            })
          }
        }

        // Build content blocks with uploaded file paths
        input = await buildContentBlocks(submittedContent, attachments, uploaded)
        if (generation !== runtimeGeneration) return
        if (attachments.some(attachment => attachment.context?.trim())) {
          displayInput = await buildContentBlocks(submittedContent, attachments, uploaded, false)
          if (generation !== runtimeGeneration) return
        }
      } else {
        // No attachments: use plain text format
        input = submittedContent
      }

      const appStore = useAppStore()
      await appStore.waitForModelsForRun()
      if (generation !== runtimeGeneration) return
      const sessionModel = activeSession.value?.model || appStore.selectedModel
      const sessionProvider = activeSession.value?.provider || appStore.selectedProvider
      const sessionProfile = activeSession.value?.profile || useProfilesStore().activeProfileName || undefined
      const profileModelGroups = sessionProfile
        ? appStore.profileModelGroups.find(entry => entry.profile === sessionProfile)?.groups
        : undefined
      const runModelGroups = profileModelGroups?.length ? profileModelGroups : appStore.modelGroups
      const providerGroup = runModelGroups.find(group => group.provider === sessionProvider)
      const storedSource = activeSession.value?.source
      const sessionSource: StartRunRequest['source'] = storedSource === 'global_agent'
        ? 'global_agent'
        : storedSource === 'workflow'
          ? 'workflow'
        : isCodingAgentSession
          ? 'coding_agent'
          : storedSource === 'api_server'
            ? 'api_server'
            : 'cli'
      const isCodingAgentExecution = sessionSource === 'coding_agent' || (sessionSource === 'workflow' && isCodingAgentSession)
      const codingAgentId: ChatCodingAgentId =
        activeSession.value?.codingAgentId ||
        agentToCodingAgentId(activeSession.value?.agent) ||
        'claude-code'
      const codingAgentMode = activeSession.value?.codingAgentMode || 'scoped'
      const codingAgentApiMode = isCodingAgentExecution && codingAgentMode !== 'global'
        ? normalizeCodingAgentApiMode(
            activeSession.value?.apiMode || providerGroup?.api_mode,
            inferCodingAgentApiMode(
              sessionProvider || providerGroup?.provider,
              activeSession.value?.baseUrl || providerGroup?.base_url,
            ),
          )
        : undefined
      const runPayload: StartRunRequest = {
        input,
        ...(displayInput ? { display_input: displayInput } : {}),
        session_id: sid,
        profile: sessionProfile,
        model: isCodingAgentExecution
          ? (codingAgentMode === 'global' ? undefined : sessionModel || undefined)
          : shouldSendInitialSessionConfig ? sessionModel || undefined : undefined,
        provider: isCodingAgentExecution
          ? (codingAgentMode === 'global' ? undefined : sessionProvider || undefined)
          : shouldSendInitialSessionConfig ? sessionProvider || undefined : undefined,
        model_groups: runModelGroups.map(group => ({
          provider: group.provider,
          models: group.models,
        })),
        queue_id: userMsg.id,
        workspace: activeSession.value?.workspace || undefined,
        category_id: activeSession.value?.categoryId ?? null,
        source: sessionSource,
        ...(runtimeMode.value === 'global_agent' ? { session_source: 'global_agent' as const } : {}),
        ...(sessionSource === 'workflow' ? { session_source: 'workflow' as const } : {}),
        ...(isCodingAgentExecution
          ? {
              coding_agent_id: codingAgentId,
              agent_preset: activeSession.value?.agentPreset,
              mode: codingAgentMode,
              baseUrl: codingAgentMode === 'global' ? undefined : activeSession.value?.baseUrl || providerGroup?.base_url || undefined,
              apiKey: codingAgentMode === 'global' ? undefined : activeSession.value?.apiKey || providerGroup?.api_key || undefined,
              apiMode: codingAgentApiMode,
            }
          : {}),
        // Per-session reasoning effort override. Hermes bridge and scoped coding
        // agents both consume this when the selected provider/API supports it.
        // Global coding-agent mode uses the user's native CLI config, so avoid
        // injecting a per-session override there.
        reasoning_effort: isCodingAgentExecution && codingAgentMode === 'global'
          ? undefined
          : activeSession.value?.reasoningEffort || undefined,
        push_enabled: activeSession.value?.pushEnabled !== false,
      }
      if (shouldSendInitialSessionConfig && activeSession.value) {
        activeSession.value.messageCount = Math.max(activeSession.value.messageCount || 0, 1)
      }

      // Helper to clean up this session's stream state
      const cleanup = () => {
        markSessionIdle(sid)
        // The run is over: its start must not leak into the next one.
        clearRunStartedAt(sid)
      }

      // Per-active-run flags used to detect silently-swallowed errors at run.completed.
      // hermes-agent occasionally emits run.completed with empty output and no
      // usage when the agent layer caught an upstream error (e.g. invalid API
      // key). We need to distinguish: (a) run with assistant text produced,
      // (b) run with only tool activity, (c) run with truly nothing visible.
      // Reset on every run.started because one handler may span multiple queued runs.
      let runProducedAssistantText = false
      let runProducedAssistantContent = false
      let runHadToolActivity = false
      let activeAssistantMessageId: string | null = null
      let reasoningAssistantMessageId: string | null = null
      let activeRunMarker: string | null = null

      const closeStreamingAssistant = () => {
        const msgs = getSessionMsgs(sid)
        msgs.forEach(m => {
          if (m.role === 'assistant' && m.isStreaming) {
            updateMessage(sid, m.id, { isStreaming: false })
          }
        })
        activeAssistantMessageId = null
        reasoningAssistantMessageId = null
        activeRunMarker = null
      }

      const applyReconnectResume = (data: ResumeSessionPayload) => {
        if (generation !== runtimeGeneration || data.session_id !== sid) return
        const target = sessions.value.find(s => s.id === sid)
        if (!target) return

        if (data.isWorking) markSessionRunning(sid)
        else markSessionIdle(sid)
        applyResumedRunActivity(sid, data as any)
        reconcileCompressionState(sid, data.compression, !!data.isWorking)

        if (data.queueLength && data.queueLength > 0) {
          queueLengths.value.set(sid, data.queueLength)
        } else {
          queueLengths.value.delete(sid)
        }

        if (Array.isArray(data.queueMessages)) {
          replaceQueuedUserMessages(sid, normalizeQueuedUserMessages(data.queueMessages))
        } else if (!data.queueLength) {
          replaceQueuedUserMessages(sid, [])
        }
        replaceQueueInsertionState(sid, data.queueInsertion)

        if (data.isAborting) {
          setAbortState(sid, { aborting: true, synced: null })
        } else if (!data.isWorking) {
          setAbortState(sid, null)
        }
        // keep compression visible (no auto-clear on !isWorking)

        applySessionTokenUsage(target, data)
        applyResumedSessionSettings(data)

        if (Array.isArray(data.messages)) {
          const previousActiveAssistantMessageId = activeAssistantMessageId
          const previousReasoningAssistantMessageId = reasoningAssistantMessageId
          const replayRunMarker = getReplayRunMarker(data.events) ?? activeRunMarker
          target.messages = mapHermesMessages(data.messages as any[], data.taskPlans, sid ? [] : [])
          mergePersistedCompressionEntries(sid)
          restorePersistedSubagentStreams(sid)
          setWorkspaceRunChanges(sid, data.workspaceRunChanges || [])
          target.loadedMessageCount = data.messageLoadedCount ?? data.messages.length
          target.messageTotal = data.messageTotal ?? target.messageCount ?? target.loadedMessageCount
          target.messageCount = target.messageTotal
          target.hasMoreBefore = data.hasMoreBefore ?? target.loadedMessageCount < target.messageTotal
          const resumedAssistantState = data.isWorking
            ? resolveResumedAssistantState(target.messages, {
                previousActiveAssistantMessageId,
                previousReasoningAssistantMessageId,
                activeRunMarker: replayRunMarker,
              })
            : {
                activeAssistant: null,
                reasoningAssistant: null,
                runMarker: null,
                hadVisibleText: false,
              }

          const resumedActiveAssistant = resumedAssistantState.activeAssistant
          const resumedReasoningAssistant = resumedAssistantState.reasoningAssistant
          activeRunMarker = resumedAssistantState.runMarker

          if (resumedActiveAssistant) {
            resumedActiveAssistant.isStreaming = true
            activeAssistantMessageId = resumedActiveAssistant.id
            if (resumedAssistantState.hadVisibleText) runProducedAssistantText = true
          } else {
            activeAssistantMessageId = null
          }

          if (resumedReasoningAssistant) {
            reasoningAssistantMessageId = resumedReasoningAssistant.id
            if (resumedReasoningAssistant.reasoning) noteReasoningStart(resumedReasoningAssistant.id)
          } else {
            reasoningAssistantMessageId = null
          }
        }

        if (data.events?.length) {
          for (const evt of data.events) {
            const e = evt.data as RunEvent
            switch (e.event) {
              case 'compression.started':
                setCompressionState(sid, {
                  compressing: true,
                  messageCount: (e as any).message_count || 0,
                  beforeTokens: (e as any).token_count || 0,
                  afterTokens: 0,
                  compressed: null,
                  source: (e as any).source === 'command' ? 'command' : 'run',
                  startedAt: Number((e as any).started_at) || Date.now(),
                })
                break
              case 'compression.completed': {
                const afterTokens = (e as any).contextTokens || (e as any).afterTokens || 0
                const previous = compressionStates.value.get(sid)
                setCompressionState(sid, {
                  compressing: false,
                  messageCount: (e as any).totalMessages || 0,
                  beforeTokens: (e as any).beforeTokens || 0,
                  afterTokens,
                  compressed: (e as any).compressed ?? false,
                  error: (e as any).error,
                  source: (e as any).source === 'command' ? 'command' : (previous?.source || 'run'),
                  startedAt: Number((e as any).started_at) || previous?.startedAt || Date.now(),
                })
                if ((e as any).contextTokens != null) target.contextTokens = (e as any).contextTokens
                break
              }
              case 'abort.started':
                setAbortState(sid, { aborting: true, synced: null })
                break
              case 'abort.timeout':
                setAbortState(sid, { aborting: true, synced: false, timedOut: true, message: (e as any).message })
                break
              case 'abort.completed':
                setAbortState(sid, { aborting: false, synced: (e as any).synced ?? false })
                settleInterruptedSubagents(sid)
                break
              case 'approval.requested':
                setPendingApproval({ ...e, session_id: sid })
                break
              case 'approval.resolved':
                clearPendingApproval({ ...e, session_id: sid })
                break
              case 'clarify.requested':
                setPendingClarify({ ...e, session_id: sid })
                break
              case 'clarify.resolved':
                clearPendingClarify({ ...e, session_id: sid })
                break
              case 'run.failed':
                handleTerminalWorkspaceRunChange(sid, e)
                if (!isQueueInsertionInterruption(e)) addAgentErrorMessage(sid, e.error)
                break
              case 'plan.updated':
              case 'agent.event':
                handleAgentEvent(e)
                break
            }
          }
        }

        if (activeSessionId.value === sid) activeSession.value = target
        if (!data.isWorking && !(data.queueLength && data.queueLength > 0)) {
          clearAgentEventMessages(sid)
          cleanup()
          activeAssistantMessageId = null
          updateSessionTitle(sid)
        }
      }

      // Send run via Socket.IO and listen to streamed events — all closures capture `sid`
      const ctrl = startRunViaSocket(
        runPayload,
        // onEvent
        (evt: RunEvent) => {
          if (generation !== runtimeGeneration || (evt.session_id && evt.session_id !== sid)) return
          applyBackgroundPendingEvent(sid, evt)
          const eventRunMarker = readRunMarker(evt)
          if (eventRunMarker) activeRunMarker = eventRunMarker
          switch (evt.event) {
            case 'run.started':
              clearSessionCompletedUnread(sid)
              markSessionRunning(sid)
              setRunStartedAt(sid, Date.now())
              clearAgentEventMessages(sid)
              setAbortState(sid, null)
              // keep compression completed visible across runs (cleared only by next compression.started)
              runProducedAssistantText = false
              runProducedAssistantContent = false
              runHadToolActivity = false
              closeStreamingAssistant()
              activeRunMarker = readRunMarker(evt) ?? null
              if ((evt as any).queue_length > 0) {
                queueLengths.value.set(sid, (evt as any).queue_length)
              } else {
                queueLengths.value.delete(sid)
              }
              break

            case 'run.queued': {
              handleRunQueuedEvent(sid, evt)
              break
            }

            case 'run.queue_insertion.updated': {
              handleQueueInsertionUpdated(evt)
              break
            }

            case 'session.command': {
              handleSessionCommandEvent(evt)
              break
            }

            case 'session.workspace.updated': {
              applySessionWorkspaceUpdate(evt)
              break
            }

            case 'session.settings.updated': {
              applySessionSettingsUpdate(evt)
              break
            }

            case 'plan.updated':
            case 'agent.event': {
              handleAgentEvent(evt)
              break
            }

            case 'run.reattach_failed': {
              handleAgentEvent(evt)
              break
            }

            case 'compression.started': {
              setCompressionState(sid, {
                compressing: true,
                messageCount: (evt as any).message_count || 0,
                beforeTokens: (evt as any).token_count || 0,
                afterTokens: 0,
                compressed: null,
                source: (evt as any).source === 'command' ? 'command' : 'run',
                startedAt: Number((evt as any).started_at) || Date.now(),
              })
              break
            }

            case 'compression.completed': {
              const afterTokens = (evt as any).contextTokens || (evt as any).afterTokens || 0
              const previous = compressionStates.value.get(sid)
              setCompressionState(sid, {
                compressing: false,
                messageCount: (evt as any).totalMessages || 0,
                beforeTokens: (evt as any).beforeTokens || 0,
                afterTokens,
                compressed: (evt as any).compressed ?? false,
                error: (evt as any).error,
                source: (evt as any).source === 'command' ? 'command' : (previous?.source || 'run'),
                startedAt: Number((evt as any).started_at) || previous?.startedAt || Date.now(),
              })
              if ((evt as any).contextTokens != null) {
                const target = sessions.value.find(s => s.id === sid)
                if (target) target.contextTokens = (evt as any).contextTokens
              }
              break
            }

            case 'abort.started': {
              setAbortState(sid, { aborting: true, synced: null })
              break
            }

            case 'abort.timeout': {
              setAbortState(sid, { aborting: true, synced: false, timedOut: true, message: (evt as any).message })
              break
            }

            case 'abort.completed': {
              setAbortState(sid, { aborting: false, synced: (evt as any).synced ?? false })
              settleInterruptedSubagents(sid)
              clearPendingInteractions(sid)
              const abortedAssistant = getSessionMsgs(sid).find(message => message.id === activeAssistantMessageId)
                || [...getSessionMsgs(sid)].reverse().find(message => message.role === 'assistant' && message.isStreaming)
              handleTerminalWorkspaceRunChange(sid, evt, abortedAssistant?.id)
              if (abortedAssistant) updateMessage(sid, abortedAssistant.id, { isStreaming: false })
              if ((evt as any).queue_length > 0) {
                queueLengths.value.set(sid, (evt as any).queue_length)
                setAbortState(sid, null)
                break
              }
              const msgs = getSessionMsgs(sid)
              const lastMsg = msgs[msgs.length - 1]
              if (lastMsg?.isStreaming) {
                updateMessage(sid, lastMsg.id, { isStreaming: false })
              }
              msgs.forEach((m, i) => {
                if (m.role === 'tool' && m.toolStatus === 'running') {
                  msgs[i] = { ...m, toolStatus: 'done' }
                }
              })
              cleanup()
              setAbortState(sid, null)
              break
            }

            case 'reasoning.delta':
            case 'thinking.delta': {
              const _c: RunEventCtx = { sid, activeAssistantMessageId, reasoningAssistantMessageId, activeRunMarker, runProducedAssistantText, runProducedAssistantContent, runHadToolActivity }
              handleReasoningDeltaShared(evt, _c)
              activeAssistantMessageId = _c.activeAssistantMessageId
              reasoningAssistantMessageId = _c.reasoningAssistantMessageId
              activeRunMarker = _c.activeRunMarker
              runProducedAssistantText = _c.runProducedAssistantText
              runProducedAssistantContent = _c.runProducedAssistantContent
              runHadToolActivity = _c.runHadToolActivity
              break
            }

            case 'moa.reference': {
              runHadToolActivity = true
              handleMoaEvent(sid, evt)
              break
            }

            case 'moa.aggregating': {
              runHadToolActivity = true
              handleMoaEvent(sid, evt)
              break
            }

            case 'reasoning.available': {
              // Upstream run_agent.py fires reasoning.available with
              // `assistant_message.content[:500]` as the preview — i.e.,
              // the main answer, not real reasoning. Ignore the payload
              // and only use this event as a "thinking ended" signal so
              // the duration counter stops.
              const msgs = getSessionMsgs(sid)
              const last = msgs[msgs.length - 1]
              if (last?.role === 'assistant' && last.isStreaming) {
                // 只有当 reasoning.delta 事件曾经启动过计时，才标记结束；
                // 否则（上游未转发 delta，只发这一次 available）不显示时长。
                noteReasoningEnd(last.id)
              }

              break
            }

            case 'message.delta': {
              const _c: RunEventCtx = { sid, activeAssistantMessageId, reasoningAssistantMessageId, activeRunMarker, runProducedAssistantText, runProducedAssistantContent, runHadToolActivity }
              handleMessageDeltaShared(evt, _c)
              activeAssistantMessageId = _c.activeAssistantMessageId
              reasoningAssistantMessageId = _c.reasoningAssistantMessageId
              activeRunMarker = _c.activeRunMarker
              runProducedAssistantText = _c.runProducedAssistantText
              runProducedAssistantContent = _c.runProducedAssistantContent
              runHadToolActivity = _c.runHadToolActivity
              break
            }

            case 'message.interim': {
              const _c: RunEventCtx = { sid, activeAssistantMessageId, reasoningAssistantMessageId, activeRunMarker, runProducedAssistantText, runProducedAssistantContent, runHadToolActivity }
              handleMessageInterimShared(evt, _c)
              activeAssistantMessageId = _c.activeAssistantMessageId
              reasoningAssistantMessageId = _c.reasoningAssistantMessageId
              activeRunMarker = _c.activeRunMarker
              runProducedAssistantText = _c.runProducedAssistantText
              runProducedAssistantContent = _c.runProducedAssistantContent
              runHadToolActivity = _c.runHadToolActivity
              break
            }

            case 'session.title.updated': {
              applyGeneratedSessionTitle(evt)
              break
            }

            case 'tool.started': {
              runHadToolActivity = true
              const startedToolName = evt.tool || evt.name
              if (
                isBackgroundDelegateToolPayload(startedToolName, evt.arguments)
                || (isEkkoAgentSession(sid) && startedToolName === 'delegate_task')
              ) break
              const msgs = getSessionMsgs(sid)
              const last = activeAssistantMessageId
                ? msgs.find(m => m.id === activeAssistantMessageId)
                : msgs[msgs.length - 1]
              const toolReasoning =
                last?.role === 'assistant' && last.reasoning?.trim()
                  ? last.reasoning
                  : undefined
              if (last?.isStreaming) {
                updateMessage(sid, last.id, { isStreaming: false })
              }
              activeAssistantMessageId = null
              reasoningAssistantMessageId = null
              handleToolStartedEvent(sid, evt, toolReasoning)
              break
            }

            case 'tool.completed':
            case 'tool.failed': {
              runHadToolActivity = true
              handleToolCompletedEvent(sid, evt)
              break
            }

            case 'workspace.diff.completed': {
              activeAssistantMessageId = handleWorkspaceRunChangeEvent(sid, evt, activeAssistantMessageId)
              break
            }

            case 'subagent.start':
            case 'subagent.tool':
            case 'subagent.progress':
            case 'subagent.text':
            case 'subagent.thinking':
            case 'subagent.complete':
            case 'delegation.updated': {
              runHadToolActivity = true
              handleSubagentEvent(sid, evt)
              break
            }

            case 'approval.requested': {
              setPendingApproval(evt)
              break
            }

            case 'approval.resolved': {
              clearPendingApproval(evt)
              break
            }

            case 'clarify.requested': {
              setPendingClarify(evt)
              break
            }

            case 'clarify.resolved': {
              clearPendingClarify(evt)
              break
            }

            case 'run.completed': {
              clearRunStartedAt(sid)
              const msgs = getSessionMsgs(sid)
              const lastMsg = activeAssistantMessageId
                ? msgs.find(m => m.id === activeAssistantMessageId)
                : msgs[msgs.length - 1]
              const completedAssistantMessageId = lastMsg?.role === 'assistant' && lastMsg.isStreaming
                ? lastMsg.id
                : null
              clearAgentEventMessages(sid)
              if (lastMsg?.isStreaming) {
                updateMessage(sid, lastMsg.id, { isStreaming: false })
              }
              settleRunningTools(sid, 'done')
              settleStaleCompression(sid)
              // Server-computed usage (local countTokens, snapshot-aware)
              if ((evt as any).inputTokens != null) {
                const target = sessions.value.find(s => s.id === sid)
                if (target) {
                  applySessionTokenUsage(target, evt as any)
                }
              }
              // Belt-and-suspenders: some providers may deliver the final
              // assistant text only via run.completed.output (no message.delta
              // stream). If we never produced assistant text but the gateway
              // reports a non-empty output, fall back to rendering it as a
              // single assistant message so the user actually sees the reply.

              // Check if backend provided parsed content (from stringified array format)
              let finalOutputTrimmed = ''
              if ((evt as any).parsed_content !== undefined) {
                // Backend has parsed stringified array format, update last assistant message
                const msgs = getSessionMsgs(sid)
                const lastAssistant = activeAssistantMessageId
                  ? msgs.find(m => m.id === activeAssistantMessageId)
                  : completedAssistantMessageId
                    ? msgs.find(m => m.id === completedAssistantMessageId)
                    : undefined
                const parsedContent = typeof (evt as any).parsed_content === 'string'
                  ? (evt as any).parsed_content
                  : ''
                const parsedContentTrimmed = parsedContent.trim()
                if (lastAssistant) {
                  const existingContentTrimmed = lastAssistant.content?.trim() ?? ''
                  if (parsedContentTrimmed || !existingContentTrimmed) {
                    updateMessage(sid, lastAssistant.id, {
                      content: parsedContent,
                    })
                    finalOutputTrimmed = parsedContentTrimmed
                    if (parsedContentTrimmed) {
                      runProducedAssistantText = true
                      runProducedAssistantContent = true
                    }
                  } else {
                    finalOutputTrimmed = existingContentTrimmed
                    runProducedAssistantText = true
                  }
                  if ((evt as any).parsed_reasoning) {
                    updateMessage(sid, lastAssistant.id, {
                      reasoning: (evt as any).parsed_reasoning,
                    })
                  }
                } else if (parsedContentTrimmed) {
                  if (isDuplicateAssistantContent(getSessionMsgs(sid), 'assistant', parsedContent, Date.now())) {
                    finalOutputTrimmed = parsedContentTrimmed
                  } else {
                    addMessage(sid, {
                      id: uid(),
                      role: 'assistant',
                      content: parsedContent,
                      reasoning: typeof (evt as any).parsed_reasoning === 'string' ? (evt as any).parsed_reasoning : undefined,
                      timestamp: Date.now(),
                    })
                    finalOutputTrimmed = parsedContentTrimmed
                    runProducedAssistantText = true
                    runProducedAssistantContent = true
                  }
                }
              } else {
                // Fallback to output field (legacy behavior)
                const finalOutput =
                  typeof evt.output === 'string' ? evt.output : ''
                finalOutputTrimmed = finalOutput.trim()
                if (!runProducedAssistantContent && finalOutputTrimmed !== '') {
                  const activeAssistant = activeAssistantMessageId
                    ? getSessionMsgs(sid).find(message =>
                        message.id === activeAssistantMessageId && message.role === 'assistant')
                    : null
                  if (activeAssistant) {
                    updateMessage(sid, activeAssistant.id, { content: finalOutput })
                  } else {
                    if (isDuplicateAssistantContent(getSessionMsgs(sid), 'assistant', finalOutput, Date.now())) {
                      runProducedAssistantText = true
                    } else {
                      addMessage(sid, {
                        id: uid(),
                        role: 'assistant',
                        content: finalOutput,
                        timestamp: Date.now(),
                      })
                      runProducedAssistantText = true
                      runProducedAssistantContent = true
                    }
                  }
                }
              }
              // Workaround for upstream hermes-agent bug: when the agent
              // layer silently swallows an error (e.g. invalid API key,
              // unsupported model), the gateway still emits run.completed
              // with an empty output. Without surfacing it here the chat UI
              // looks frozen / "succeeded with no reply". Detect by the
              // combination of: no assistant text AND no tool activity AND
              // empty final output. Usage being zero is a *supporting*
              // signal but not required, since some providers/local models
              // legitimately omit usage.
              const queueInsertionInterruption = isQueueInsertionInterruption(evt)
              const swallowedError =
                !runProducedAssistantText &&
                !runHadToolActivity &&
                finalOutputTrimmed === '' &&
                !queueInsertionInterruption
              if (swallowedError) {
                addSystemErrorMessage(sid, 'Error: Agent returned no output. The model call may have failed (e.g. invalid API key, model not supported by provider, or context exceeded). Check the hermes-agent logs for details.')
              } else {
                playCompletionBellIfEnabled()
                settleSessionFinished(sid, completedAssistantMessageId)
              }
              const terminalAssistantMessageId = completedAssistantMessageId || [...getSessionMsgs(sid)]
                .reverse()
                .find(message => message.role === 'assistant' && String(message.content || '').trim())
                ?.id
              handleTerminalWorkspaceRunChange(sid, evt, terminalAssistantMessageId)
              attachWorkspaceChangesToMessages(sid)

              // 自动播放语音
              if (autoPlaySpeechEnabled.value && runProducedAssistantContent) {
                const msgs = getSessionMsgs(sid)
                const lastAssistant = [...msgs].reverse().find(m => m.role === 'assistant')
                if (lastAssistant?.content) {
                  // 延迟一小会儿再播放，确保 UI 更新完成
                  setTimeout(() => {
                    playMessageSpeech(lastAssistant.id, lastAssistant.content)
                  }, 300)
                }
              }

              const hasQueue = (evt as any).queue_remaining > 0
              markSessionCompletedUnread(sid, hasQueue)
              if (hasQueue) {
                queueLengths.value.set(sid, (evt as any).queue_remaining)
              } else {
                cleanup()
              }
              activeAssistantMessageId = null
              reasoningAssistantMessageId = null
              activeRunMarker = null
              updateSessionTitle(sid)
              break
            }

            case 'run.failed': {
              clearRunStartedAt(sid)
              settleStaleCompression(sid)
              clearPendingInteractions(sid)
              const failedMessages = getSessionMsgs(sid)
              const failedAssistant = activeAssistantMessageId
                ? failedMessages.find(message => message.id === activeAssistantMessageId)
                : [...failedMessages].reverse().find(message => message.role === 'assistant' && message.isStreaming)
              const queueInsertionInterruption = isQueueInsertionInterruption(evt)
              handleTerminalWorkspaceRunChange(sid, evt, failedAssistant?.id)
              clearAgentEventMessages(sid)
              if ((evt as any).inputTokens != null) {
                const target = sessions.value.find(s => s.id === sid)
                if (target) {
                  applySessionTokenUsage(target, evt as any)
                }
              }
              if (queueInsertionInterruption) {
                if (failedAssistant?.isStreaming) updateMessage(sid, failedAssistant.id, { isStreaming: false })
                settleRunningTools(sid, 'done')
              } else {
                addAgentErrorMessage(sid, evt.error)
                settleRunningTools(sid, 'error')
              }
              if ((evt as any).queue_remaining > 0) {
                queueLengths.value.set(sid, (evt as any).queue_remaining)
              } else {
                cleanup()
              }
              activeAssistantMessageId = null
              reasoningAssistantMessageId = null
              activeRunMarker = null
              break
            }

            case 'usage.updated': {
              const target = sessions.value.find(s => s.id === sid)
              if (target) {
                applySessionTokenUsage(target, evt as any)
              }
              break
            }
          }
        },
        // onDone
        () => {
          const msgs = getSessionMsgs(sid)
          const last = msgs[msgs.length - 1]
          if (last?.isStreaming) {
            updateMessage(sid, last.id, { isStreaming: false })
          }
          cleanup()
          activeAssistantMessageId = null
          reasoningAssistantMessageId = null
          activeRunMarker = null
          updateSessionTitle(sid)
        },
        // onError
        (err) => {
          console.warn('Socket.IO run stream error:', err.message)
          addAgentErrorMessage(sid, err.message)
          const msgs = getSessionMsgs(sid)
          msgs.forEach((m, i) => {
            if (m.role === 'tool' && m.toolStatus === 'running') {
              msgs[i] = { ...m, toolStatus: 'error' }
            }
          })
          cleanup()
          activeAssistantMessageId = null
          reasoningAssistantMessageId = null
          activeRunMarker = null
        },
        undefined,
        { onReconnectResume: applyReconnectResume, transport: runtimeTransport() },
      )
      runSubmitted = true

      if (isCodingAgentSession) {
        markSessionRunning(sid)
        attachSessionStream(sid, ctrl)
      } else if (!isBridgeSlashCommand || isBridgeCompressCommand || isBridgePlanCommand || isBridgeGoalCommand) {
        attachSessionStream(sid, ctrl)
      }
    } catch (err: any) {
      if (generation !== runtimeGeneration) return
      if (isBridgeForkCommand) {
        const nextPendingForkCommands = new Set(pendingForkCommands.value)
        nextPendingForkCommands.delete(sid)
        pendingForkCommands.value = nextPendingForkCommands
      }
      if (shouldQueue && !runSubmitted) {
        dropQueuedUserMessage(sid, userMsg.id)
      }
      if (!shouldQueue && !runSubmitted) {
        markSessionIdle(sid)
      }
      addSystemErrorMessage(sid, `Error: ${err?.message || String(err)}`)
    }
  }

  /**
   * Resume an in-flight run after page refresh.
   * Emits 'resume' to join the session room on the server,
   * then sets up event listeners to receive ongoing events.
   */
  function resumeServerWorkingRun(sid: string, force = false, passive = false) {
    const generation = runtimeGeneration
    // Don't register duplicate listeners if already streaming.
    //
    // A leftover streamStates entry used to make this bail out forever, so a
    // leaked flag could never be repaired: every later resume re-attached,
    // saw the entry, returned, and the session stayed "thinking" indefinitely.
    // When the caller says the run is NOT active, clear local residue first and
    // re-evaluate, so this path can heal instead of deadlock.
    if (!force && !passive && !serverWorking.value.has(sid) && streamStates.value.has(sid)) {
      reconcileSessionIdle(sid)
    }
    if (streamStates.value.has(sid)) return
    // Only set up listeners if the server reported an active run during resume.
    if (!force && !serverWorking.value.has(sid)) return

    let closed = false
    let runProducedAssistantText = false
    let runProducedAssistantContent = false
    let runHadToolActivity = false
    let activeAssistantMessageId: string | null = null
    let reasoningAssistantMessageId: string | null = null
    let activeRunMarker: string | null = null

    const cleanup = () => {
      if (closed) return
      closed = true
      markSessionIdle(sid)
      clearRunStartedAt(sid)
      // Unregister from global session handlers
      unregisterSessionHandlers(sid)
    }

    const markIdleKeepingBackgroundListener = () => {
      markSessionIdle(sid)
      closeStreamingAssistant()
      clearRunStartedAt(sid)
    }

    const ensureAbortHandle = () => {
      if (streamStates.value.has(sid)) return
      // Deliberately not requestRunAbort(): that prefers the stored handle, so
      // delegating to it here made this closure call itself forever.
      attachSessionStream(sid, {
        abort: () => emitAbortOnSessionSocket(sid),
      })
    }

    const closeStreamingAssistant = () => {
      const msgs = getSessionMsgs(sid)
      msgs.forEach(m => {
        if (m.role === 'assistant' && m.isStreaming) {
          updateMessage(sid, m.id, { isStreaming: false })
        }
      })
      activeAssistantMessageId = null
      reasoningAssistantMessageId = null
      activeRunMarker = null
    }

    const initializeResumedAssistantState = () => {
      const resumedAssistantState = resolveResumedAssistantState(getSessionMsgs(sid), { activeRunMarker })
      activeRunMarker = resumedAssistantState.runMarker
      if (resumedAssistantState.activeAssistant) {
        resumedAssistantState.activeAssistant.isStreaming = true
        activeAssistantMessageId = resumedAssistantState.activeAssistant.id
        if (resumedAssistantState.hadVisibleText) runProducedAssistantText = true
      }
      if (resumedAssistantState.reasoningAssistant) {
        reasoningAssistantMessageId = resumedAssistantState.reasoningAssistant.id
        if (resumedAssistantState.reasoningAssistant.reasoning) {
          noteReasoningStart(resumedAssistantState.reasoningAssistant.id)
        }
      }
    }

    initializeResumedAssistantState()

    // Shared event handler — filters by session_id tag
    function handleEvent(evt: RunEvent) {
      const isCompressionEvt = evt.event === 'compression.started' || evt.event === 'compression.completed'
      if (closed || generation !== runtimeGeneration) {
        if (!isCompressionEvt) return
        if (generation !== runtimeGeneration) return
      }
      // Filter events for this session (server tags all events with session_id)
      if (evt.session_id && evt.session_id !== sid) return
      applyBackgroundPendingEvent(sid, evt)
      const eventRunMarker = readRunMarker(evt)
      if (eventRunMarker) activeRunMarker = eventRunMarker
      switch (evt.event) {
        case 'run.queued': {
          handleRunQueuedEvent(sid, evt)
          break
        }

        case 'run.queue_insertion.updated': {
          handleQueueInsertionUpdated(evt)
          break
        }

        case 'session.command': {
          handleSessionCommandEvent(evt)
          break
        }

        case 'session.workspace.updated': {
          applySessionWorkspaceUpdate(evt)
          break
        }

        case 'session.settings.updated': {
          applySessionSettingsUpdate(evt)
          break
        }

        case 'plan.updated':
        case 'agent.event': {
          handleAgentEvent(evt)
          break
        }

        case 'run.reattach_failed': {
          handleAgentEvent(evt)
          break
        }

        case 'run.started':
          clearSessionCompletedUnread(sid)
          markSessionRunning(sid)
          setRunStartedAt(sid, Date.now())
          ensureAbortHandle()
          clearAgentEventMessages(sid)
          setAbortState(sid, null)
          // keep compression completed visible across runs
          runProducedAssistantText = false
          runProducedAssistantContent = false
          runHadToolActivity = false
          closeStreamingAssistant()
          activeRunMarker = readRunMarker(evt) ?? null
          if ((evt as any).queue_length > 0) {
            queueLengths.value.set(sid, (evt as any).queue_length)
          } else {
            queueLengths.value.delete(sid)
          }
          break

        case 'compression.started': {
          setCompressionState(sid, {
            compressing: true,
            messageCount: (evt as any).message_count || 0,
            beforeTokens: (evt as any).token_count || 0,
            afterTokens: 0,
            compressed: null,
            source: (evt as any).source === 'command' ? 'command' : 'run',
            startedAt: Number((evt as any).started_at) || Date.now(),
          })
          break
        }

        case 'compression.completed': {
          const afterTokens = (evt as any).contextTokens || (evt as any).afterTokens || 0
          const previous = compressionStates.value.get(sid)
          setCompressionState(sid, {
            compressing: false,
            messageCount: (evt as any).totalMessages || 0,
            beforeTokens: (evt as any).beforeTokens || 0,
            afterTokens,
            compressed: (evt as any).compressed ?? false,
            error: (evt as any).error,
            source: (evt as any).source === 'command' ? 'command' : (previous?.source || 'run'),
            startedAt: Number((evt as any).started_at) || previous?.startedAt || Date.now(),
          })
          if ((evt as any).contextTokens != null) {
            const target = sessions.value.find(s => s.id === sid)
            if (target) target.contextTokens = (evt as any).contextTokens
          }
          break
        }

        case 'abort.started': {
          setAbortState(sid, { aborting: true, synced: null })
          break
        }

        case 'abort.timeout': {
          setAbortState(sid, { aborting: true, synced: false, timedOut: true, message: (evt as any).message })
          break
        }

        case 'abort.completed': {
          setAbortState(sid, { aborting: false, synced: (evt as any).synced ?? false })
          settleInterruptedSubagents(sid)
          clearPendingInteractions(sid)
          const abortedAssistant = getSessionMsgs(sid).find(message => message.id === activeAssistantMessageId)
            || [...getSessionMsgs(sid)].reverse().find(message => message.role === 'assistant' && message.isStreaming)
          handleTerminalWorkspaceRunChange(sid, evt, abortedAssistant?.id)
          if (abortedAssistant) updateMessage(sid, abortedAssistant.id, { isStreaming: false })
          if ((evt as any).queue_length > 0) {
            queueLengths.value.set(sid, (evt as any).queue_length)
            setAbortState(sid, null)
            break
          }
          const msgs = getSessionMsgs(sid)
          const lastMsg = msgs[msgs.length - 1]
          if (lastMsg?.isStreaming) {
            updateMessage(sid, lastMsg.id, { isStreaming: false })
          }
          msgs.forEach((m, i) => {
            if (m.role === 'tool' && m.toolStatus === 'running') {
              msgs[i] = { ...m, toolStatus: 'done' }
            }
          })
          cleanup()
          setAbortState(sid, null)
          break
        }

        case 'reasoning.delta':
        case 'thinking.delta': {
          const _c: RunEventCtx = { sid, activeAssistantMessageId, reasoningAssistantMessageId, activeRunMarker, runProducedAssistantText, runProducedAssistantContent, runHadToolActivity }
          handleReasoningDeltaShared(evt, _c)
          activeAssistantMessageId = _c.activeAssistantMessageId
          reasoningAssistantMessageId = _c.reasoningAssistantMessageId
          activeRunMarker = _c.activeRunMarker
          runProducedAssistantText = _c.runProducedAssistantText
          runProducedAssistantContent = _c.runProducedAssistantContent
          runHadToolActivity = _c.runHadToolActivity
          break
        }

        case 'moa.reference': {
          runHadToolActivity = true
          handleMoaEvent(sid, evt)
          break
        }

        case 'moa.aggregating': {
          runHadToolActivity = true
          handleMoaEvent(sid, evt)
          break
        }

        case 'reasoning.available': {
          const msgs = getSessionMsgs(sid)
          const last = msgs[msgs.length - 1]
          if (last?.role === 'assistant' && last.isStreaming) {
            noteReasoningEnd(last.id)
          }

          break
        }

        case 'message.delta': {
          const _c: RunEventCtx = { sid, activeAssistantMessageId, reasoningAssistantMessageId, activeRunMarker, runProducedAssistantText, runProducedAssistantContent, runHadToolActivity }
          handleMessageDeltaShared(evt, _c)
          activeAssistantMessageId = _c.activeAssistantMessageId
          reasoningAssistantMessageId = _c.reasoningAssistantMessageId
          activeRunMarker = _c.activeRunMarker
          runProducedAssistantText = _c.runProducedAssistantText
          runProducedAssistantContent = _c.runProducedAssistantContent
          runHadToolActivity = _c.runHadToolActivity
          break
        }

        case 'message.interim': {
          const _c: RunEventCtx = { sid, activeAssistantMessageId, reasoningAssistantMessageId, activeRunMarker, runProducedAssistantText, runProducedAssistantContent, runHadToolActivity }
          handleMessageInterimShared(evt, _c)
          activeAssistantMessageId = _c.activeAssistantMessageId
          reasoningAssistantMessageId = _c.reasoningAssistantMessageId
          activeRunMarker = _c.activeRunMarker
          runProducedAssistantText = _c.runProducedAssistantText
          runProducedAssistantContent = _c.runProducedAssistantContent
          runHadToolActivity = _c.runHadToolActivity
          break
        }

        case 'session.title.updated': {
          applyGeneratedSessionTitle(evt)
          break
        }

        case 'tool.started': {
          runHadToolActivity = true
          const startedToolName = evt.tool || evt.name
          if (
            isBackgroundDelegateToolPayload(startedToolName, evt.arguments)
            || (isEkkoAgentSession(sid) && startedToolName === 'delegate_task')
          ) break
          const msgs = getSessionMsgs(sid)
          const last = activeAssistantMessageId
            ? msgs.find(m => m.id === activeAssistantMessageId)
            : msgs[msgs.length - 1]
          const toolReasoning =
            last?.role === 'assistant' && last.reasoning?.trim()
              ? last.reasoning
              : undefined
          if (last?.isStreaming) {
            updateMessage(sid, last.id, { isStreaming: false })
          }
          activeAssistantMessageId = null
          reasoningAssistantMessageId = null
          handleToolStartedEvent(sid, evt, toolReasoning)

          break
        }

        case 'tool.completed':
        case 'tool.failed': {
          runHadToolActivity = true
          handleToolCompletedEvent(sid, evt)

          break
        }

        case 'workspace.diff.completed': {
          activeAssistantMessageId = handleWorkspaceRunChangeEvent(sid, evt, activeAssistantMessageId)
          break
        }

        case 'subagent.start':
        case 'subagent.tool':
        case 'subagent.progress':
        case 'subagent.text':
        case 'subagent.thinking':
        case 'subagent.complete':
        case 'delegation.updated': {
          runHadToolActivity = true
          handleSubagentEvent(sid, evt)
          break
        }

        case 'approval.requested': {
          setPendingApproval(evt)
          break
        }

        case 'approval.resolved': {
          clearPendingApproval(evt)
          break
        }

        case 'clarify.requested': {
          setPendingClarify(evt)
          break
        }

        case 'clarify.resolved': {
          clearPendingClarify(evt)
          break
        }

        case 'run.completed': {
          clearRunStartedAt(sid)
          clearAgentEventMessages(sid)
          const hasQueue = (evt as any).queue_remaining > 0
          const hasBackground = (evt.background_pending || 0) > 0
          if (hasQueue) {
            queueLengths.value.set(sid, (evt as any).queue_remaining)
          } else {
            queueLengths.value.delete(sid)
          }
          const msgs = getSessionMsgs(sid)
          const lastMsg = activeAssistantMessageId
            ? msgs.find(m => m.id === activeAssistantMessageId)
            : msgs[msgs.length - 1]
          const completedAssistantMessageId = lastMsg?.role === 'assistant' && lastMsg.isStreaming
            ? lastMsg.id
            : null
          if (lastMsg?.isStreaming) {
            updateMessage(sid, lastMsg.id, { isStreaming: false })
          }
          settleRunningTools(sid, 'done')
          // Server-computed usage (local countTokens, snapshot-aware)
          if ((evt as any).inputTokens != null) {
            const target = sessions.value.find(s => s.id === sid)
            if (target) {
              applySessionTokenUsage(target, evt as any)
            }
          }
          // Check if backend provided parsed content (from stringified array format)
          let finalOutputTrimmed = ''
          if ((evt as any).parsed_content !== undefined) {
            // Backend has parsed stringified array format, update last assistant message
            const msgs = getSessionMsgs(sid)
            const lastAssistant = activeAssistantMessageId
              ? msgs.find(m => m.id === activeAssistantMessageId)
              : completedAssistantMessageId
                ? msgs.find(m => m.id === completedAssistantMessageId)
                : undefined
            const parsedContent = typeof (evt as any).parsed_content === 'string'
              ? (evt as any).parsed_content
              : ''
            const parsedContentTrimmed = parsedContent.trim()
            if (lastAssistant) {
              const existingContentTrimmed = lastAssistant.content?.trim() ?? ''
              if (parsedContentTrimmed || !existingContentTrimmed) {
                updateMessage(sid, lastAssistant.id, {
                  content: parsedContent,
                })
                finalOutputTrimmed = parsedContentTrimmed
                if (parsedContentTrimmed) {
                  runProducedAssistantText = true
                  runProducedAssistantContent = true
                }
              } else {
                finalOutputTrimmed = existingContentTrimmed
                runProducedAssistantText = true
              }
              if ((evt as any).parsed_reasoning) {
                updateMessage(sid, lastAssistant.id, {
                  reasoning: (evt as any).parsed_reasoning,
                })
              }
            } else if (parsedContentTrimmed) {
              if (isDuplicateAssistantContent(getSessionMsgs(sid), 'assistant', parsedContent, Date.now())) {
                finalOutputTrimmed = parsedContentTrimmed
              } else {
                addMessage(sid, {
                  id: uid(),
                  role: 'assistant',
                  content: parsedContent,
                  reasoning: typeof (evt as any).parsed_reasoning === 'string' ? (evt as any).parsed_reasoning : undefined,
                  timestamp: Date.now(),
                })
                finalOutputTrimmed = parsedContentTrimmed
                runProducedAssistantText = true
                runProducedAssistantContent = true
              }
            }
          } else {
            // Fallback to output field (legacy behavior)
            const finalOutput = typeof evt.output === 'string' ? evt.output : ''
            finalOutputTrimmed = finalOutput.trim()
            if (!runProducedAssistantContent && finalOutputTrimmed !== '') {
              const activeAssistant = activeAssistantMessageId
                ? getSessionMsgs(sid).find(message =>
                    message.id === activeAssistantMessageId && message.role === 'assistant')
                : null
              if (activeAssistant) {
                updateMessage(sid, activeAssistant.id, { content: finalOutput })
              } else {
                if (isDuplicateAssistantContent(getSessionMsgs(sid), 'assistant', finalOutput, Date.now())) {
                  runProducedAssistantText = true
                } else {
                  addMessage(sid, {
                    id: uid(),
                    role: 'assistant',
                    content: finalOutput,
                    timestamp: Date.now(),
                  })
                  runProducedAssistantText = true
                  runProducedAssistantContent = true
                }
              }
              runProducedAssistantContent = true
            }
          }
          const queueInsertionInterruption = isQueueInsertionInterruption(evt)
          const swallowedError = !runProducedAssistantText
            && !runHadToolActivity
            && finalOutputTrimmed === ''
            && !queueInsertionInterruption
          if (swallowedError) {
            addSystemErrorMessage(sid, 'Error: Agent returned no output. The model call may have failed (e.g. invalid API key, model not supported by provider, or context exceeded). Check the hermes-agent logs for details.')
          } else {
            playCompletionBellIfEnabled()
            settleSessionFinished(sid, completedAssistantMessageId)
          }
          const terminalAssistantMessageId = completedAssistantMessageId || [...getSessionMsgs(sid)]
            .reverse()
            .find(message => message.role === 'assistant' && String(message.content || '').trim())
            ?.id
          handleTerminalWorkspaceRunChange(sid, evt, terminalAssistantMessageId)
          attachWorkspaceChangesToMessages(sid)

          // Auto-play speech for every completed assistant message
          if (autoPlaySpeechEnabled.value && runProducedAssistantContent) {
            const msgs = getSessionMsgs(sid)
            const lastAssistant = [...msgs].reverse().find(m => m.role === 'assistant')
            if (lastAssistant?.content) {
              setTimeout(() => {
                playMessageSpeech(lastAssistant.id, lastAssistant.content)
              }, 300)
            }
          }

          if (!hasQueue && !hasBackground) {
            markSessionCompletedUnread(sid)
            cleanup()
            activeAssistantMessageId = null
            reasoningAssistantMessageId = null
            activeRunMarker = null
          } else if (hasQueue) {
            markSessionCompletedUnread(sid, true)
            // More runs pending — reset for next run but don't cleanup
            activeAssistantMessageId = null
            reasoningAssistantMessageId = null
            activeRunMarker = null
          } else {
            markSessionCompletedUnread(sid)
            markIdleKeepingBackgroundListener()
            activeAssistantMessageId = null
            reasoningAssistantMessageId = null
            activeRunMarker = null
          }
          updateSessionTitle(sid)
          break
        }

        case 'run.failed': {
          clearRunStartedAt(sid)
          clearPendingInteractions(sid)
          const failedMessages = getSessionMsgs(sid)
          const failedAssistant = activeAssistantMessageId
            ? failedMessages.find(message => message.id === activeAssistantMessageId)
            : [...failedMessages].reverse().find(message => message.role === 'assistant' && message.isStreaming)
          const queueInsertionInterruption = isQueueInsertionInterruption(evt)
          handleTerminalWorkspaceRunChange(sid, evt, failedAssistant?.id)
          clearAgentEventMessages(sid)
          if ((evt as any).inputTokens != null) {
            const target = sessions.value.find(s => s.id === sid)
            if (target) {
              applySessionTokenUsage(target, evt as any)
            }
          }
          const hasQueue = (evt as any).queue_remaining > 0
          const hasBackground = (evt.background_pending || 0) > 0
          if (hasQueue) {
            queueLengths.value.set(sid, (evt as any).queue_remaining)
          } else {
            queueLengths.value.delete(sid)
          }
          if (queueInsertionInterruption) {
            if (failedAssistant?.isStreaming) updateMessage(sid, failedAssistant.id, { isStreaming: false })
            settleRunningTools(sid, 'done')
          } else {
            addAgentErrorMessage(sid, evt.error)
            settleRunningTools(sid, 'error')
          }
          if (!hasQueue && !hasBackground) {
            cleanup()
          } else if (hasBackground && !hasQueue) {
            markIdleKeepingBackgroundListener()
          }
          activeAssistantMessageId = null
          reasoningAssistantMessageId = null
          activeRunMarker = null
          break
        }

        case 'usage.updated': {
          const target = sessions.value.find(s => s.id === sid)
          if (target) {
            applySessionTokenUsage(target, evt as any)
          }
          break
        }
      }
    }

    // Register handlers in global session map
    registerSessionHandlers(sid, {
      onMessageDelta: (evt) => handleEvent(evt),
      onMessageInterim: (evt) => handleEvent(evt),
      onReasoningDelta: (evt) => handleEvent(evt),
      onThinkingDelta: (evt) => handleEvent(evt),
      onReasoningAvailable: (evt) => handleEvent(evt),
      onToolStarted: (evt) => handleEvent(evt),
      onToolCompleted: (evt) => handleEvent(evt),
      onWorkspaceDiffCompleted: (evt) => handleEvent(evt),
      onSubagentEvent: (evt) => handleEvent(evt),
      onRunStarted: (evt) => handleEvent(evt),
      onRunCompleted: (evt) => handleEvent(evt),
      onRunFailed: (evt) => handleEvent(evt),
      onCompressionStarted: (evt) => handleEvent(evt),
      onCompressionCompleted: (evt) => handleEvent(evt),
      onAbortStarted: (evt) => handleEvent(evt),
      onAbortTimeout: (evt) => handleEvent(evt),
      onAbortCompleted: (evt) => handleEvent(evt),
      onUsageUpdated: (evt) => handleEvent(evt),
      onAgentEvent: (evt) => handleEvent(evt),
      onSessionCommand: (evt) => handleEvent(evt),
      onSessionWorkspaceUpdated: (evt) => handleEvent(evt),
      onSessionSettingsUpdated: applySessionSettingsUpdate,
      onRunQueued: (evt) => handleEvent(evt),
      onQueueInsertionUpdated: (evt) => handleEvent(evt),
      onClarifyRequested: (evt) => handleEvent(evt),
      onClarifyResolved: (evt) => handleEvent(evt),
    })

    // No need to emit resume here — switchSession already did it.
    // Server already joined room and replayed events.
    // Just set up handlers for ongoing streaming events.

    // A passive listener keeps background subagent telemetry alive without
    // making the parent session look busy. The abort handle is installed when
    // the completion notification starts its autonomous parent turn.
    if (!passive) ensureAbortHandle()
  }

  function handlePeerUserMessage(evt: RunEvent) {
    const sid = evt.session_id
    if (evt.event === 'approval.requested') return setPendingApproval(evt)
    if (evt.event === 'approval.resolved') return clearPendingApproval(evt)
    if (evt.event === 'clarify.requested') return setPendingClarify(evt)
    if (evt.event === 'clarify.resolved') return clearPendingClarify(evt)
    if (!sid || activeSessionId.value !== sid || !activeSession.value) return

    const peer = evt.message
    const content = typeof peer?.content === 'string' ? peer.content : ''
    if (!content.trim()) return

    const messageId = peer?.id != null ? String(peer.id) : ''
    const isPeerCommand = peer?.role === 'command'
    const msgs = getSessionMsgs(sid)
    if (messageId && msgs.some(msg => msg.id === messageId)) {
      markSessionRunning(sid)
      resumeServerWorkingRun(sid, true)
      return
    }
    if (messageId && (queuedUserMessages.value.get(sid) || []).some(msg => msg.id === messageId)) {
      if (isPeerCommand && !peer?.queued) {
        dropQueuedUserMessage(sid, messageId)
      } else {
        markSessionRunning(sid)
        resumeServerWorkingRun(sid, true)
        return
      }
    }

    const timestamp = typeof peer?.timestamp === 'number' && Number.isFinite(peer.timestamp)
      ? Math.round(peer.timestamp * 1000)
      : Date.now()

    const message: Message = {
      id: messageId || uid(),
      role: isPeerCommand ? 'command' : 'user',
      content,
      timestamp,
      queued: !!peer?.queued,
      systemType: isPeerCommand ? 'command' : undefined,
    }
    const wasDequeued = messageId ? consumeDequeuedQueueId(sid, messageId) : false
    if (peer?.queued || (
      peer?.queued !== false
      && !isPeerCommand
      && !wasDequeued
      && isSessionLive(sid)
    )) {
      enqueueUserMessage(sid, message)
    } else {
      addMessage(sid, message)
      updateSessionTitle(sid)
    }
    markSessionRunning(sid)
    resumeServerWorkingRun(sid, true)
  }

  onPeerUserMessage(handlePeerUserMessage)

  function handleGlobalSessionCommand(evt: RunEvent) {
    const sid = evt.session_id
    if (!sid || activeSessionId.value !== sid || !activeSession.value) return
    const shouldAttachToStartedRun = (evt as any).started === true && (evt as any).terminal === false
    handleSessionCommandEvent(evt)
    if (shouldAttachToStartedRun) {
      markSessionRunning(sid)
      resumeServerWorkingRun(sid, true)
    }
  }

  onSessionCommand(handleGlobalSessionCommand)

  onSessionTitleUpdated(applyGeneratedSessionTitle)
  onSessionWorkspaceUpdated(applySessionWorkspaceUpdate)
  onSessionSettingsUpdated(applySessionSettingsUpdate)
  onRunUsageUpdated(evt => {
    const sid = evt.session_id
    const summary = normalizeRunUsage((evt as any).run_usage)
    const session = sessions.value.find(item => item.id === sid)
    if (!sid || !session || !summary?.assistantMessageId) return
    applySessionTokenUsage(session, evt as any)
    // Late native logs and prices belong to this exact run, even when another
    // turn is already streaming. Never fall back to the newest assistant.
    const message = session.messages.find(item => item.role === 'assistant'
      && (item.id === summary.assistantMessageId || item.runUsage?.runId === summary.runId))
    const terminalNotReceived = !message?.runUsage
    if (message) message.runUsage = summary
    if (terminalNotReceived) {
      const updates = pendingRunUsage.get(sid) || new Map()
      updates.set(summary.runId, summary)
      pendingRunUsage.set(sid, updates)
    }
  })

  /**
   * Ask the server to stop `sid`, naming the run.
   *
   * `socket.connected` is deliberately not consulted. socket.io buffers an emit
   * while the socket is down and delivers it on reconnect, so refusing to send
   * turned a recoverable stop into a reported failure -- the exact report that
   * came from a phone whose socket had dropped. The buffered request is only
   * safe because it carries a run id: the server drops it if that run has since
   * ended, so a late delivery cannot kill the run that replaced it.
   */
  function emitAbortOnSessionSocket(sid: string): boolean {
    const socket = getChatRunSocket(runtimeTransport())
    // No socket object at all is different from a socket that is reconnecting:
    // without one there is nothing to buffer into, so that is still a failure.
    if (!socket) return false
    const runId = sessionRunFor(sid).runId
    socket.emit('abort', { session_id: sid, run_id: runId || undefined })
    return true
  }

  /**
   * Ask the server to stop. Returns false only when the request provably could
   * not leave this tab; a `void` from a legacy abort handle counts as sent, so a
   * stubbed handle cannot fake a failure.
   */
  function requestRunAbort(sid: string): boolean {
    const ctrl = streamStates.value.get(sid)
    if (ctrl) return ctrl.abort() !== false
    return emitAbortOnSessionSocket(sid)
  }

  function stopStreaming() {
    const sid = activeSessionId.value
    if (!sid) return
    if (isAborting.value) return
    clearPendingInteractions(sid)
    // The ring is driven by `isSessionWorking`, which also counts a live
    // delegation. Gating on the two foreground flags alone meant a session that
    // was busy only through a background delegation showed a lit ring whose stop
    // button returned without emitting anything at all -- the fourth reader of
    // the same three sources, after the ring itself and the send-vs-queue check.
    // Same predicate, so the indicator and the button cannot disagree.
    if (!isSessionWorking(sid)) return
    // Set the flag only once the request can actually leave this tab. Painting
    // "Pausing..." for a stop that was dropped on the floor is what made a dead
    // socket indistinguishable from a slow agent.
    setAbortState(sid, { aborting: true, synced: null })
    if (!requestRunAbort(sid)) {
      setAbortState(sid, { aborting: false, synced: false, error: STOP_UNCONFIRMED_MESSAGE })
      return
    }
    const msgs = getSessionMsgs(sid)
    const lastMsg = msgs[msgs.length - 1]
    if (lastMsg?.isStreaming) {
      updateMessage(sid, lastMsg.id, { isStreaming: false })
    }
  }

  // Tab visibility: re-sync when returning to foreground
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        // Live-sync the session list so sessions created elsewhere (CLI,
        // Telegram, another device) appear without a manual reload.
        // (removed `!isStreaming` guard — see P0 deadlock note below)
        void refreshSessionListOnly()
      }
      if (document.visibilityState === 'visible' && activeSessionId.value) {
        const sid = activeSessionId.value
        if (sid) {
          // P1: MUST run even when streamStates.has(sid) — a lost run.completed
          // leaves serverWorking/isStreaming stuck forever. resumeSession is
          // idempotent (read-only) so repeated calls are safe.
          // P0: this re-sync MUST run even when isStreaming is currently true.
          // A lost terminal event can leave serverWorking stuck at true, which
          // makes isStreaming stay true forever; if we gate on `!isStreaming`
          // here we can never re-query authoritative isWorking and the "thinking"
          // indicator deadlocks. resumeSession re-attaches to the server and
          // returns the real isWorking, breaking the deadlock.
          const generation = runtimeGeneration
          resumeSession(sid, (data) => {
            if (generation !== runtimeGeneration || data.session_id !== sid || activeSessionId.value !== sid) return
            if (data.isWorking) {
              markSessionRunning(sid)
            } else {
              // Shared with the switchSession path so the two can never drift.
              // (This block used to be the only correct one.)
              reconcileSessionIdle(sid)
            }
            applyResumedRunActivity(sid, data as any)
            if (data.isAborting) {
              setAbortState(sid, { aborting: true, synced: null })
            } else if (!data.isWorking) {
              setAbortState(sid, null)
            }
            // The server snapshot is authoritative: it is the only thing that can
            // correct a compression whose terminal event we never received.
            reconcileCompressionState(sid, data.compression, !!data.isWorking)
            applyResumedSessionSettings(data)
            if (activeSession.value) applySessionTokenUsage(activeSession.value, data)
            if (Array.isArray(data.messages) && activeSession.value) {
              if (typeof data.workspace === 'string') {
                activeSession.value.workspace = data.workspace.trim() || null
                activeSession.value.isLocalOnly = false
              }
              activeSession.value.messages = mapHermesMessages(data.messages as any[], data.taskPlans, sid ? [] : [])
              restorePersistedSubagentStreams(sid)
              setWorkspaceRunChanges(sid, data.workspaceRunChanges || [])
              activeSession.value.loadedMessageCount = data.messageLoadedCount ?? data.messages.length
              activeSession.value.messageTotal = data.messageTotal ?? activeSession.value.messageCount ?? activeSession.value.loadedMessageCount
              activeSession.value.messageCount = activeSession.value.messageTotal
              activeSession.value.hasMoreBefore = data.hasMoreBefore ?? activeSession.value.loadedMessageCount < activeSession.value.messageTotal
            }
            resumeServerWorkingRun(sid, (data.backgroundPending || 0) > 0, !data.isWorking)
          }, activeSession.value?.profile, runtimeTransport())
        }
      }
    })
  }

  /**
   * Fast poll for run state only.
   *
   * The 12s tick below ends up calling `refreshSessionListOnly`, which is a
   * database read for the session list. Running that four times as often to
   * tighten the completion notice would quadruple the DB load, so the
   * working-sessions endpoint gets its own faster tick instead: it reads the
   * socket server's in-memory `sessionMap` and serializes a small array, so it
   * is cheap enough to run while a run is in flight.
   *
   * This is what makes "the notification arrives late" go away. The notice for
   * a session this client is not attached to can only be learned from the
   * snapshot, so the notice latency was exactly the old poll interval.
   */
  let workingSnapshotPollInFlight = false
  if (typeof window !== 'undefined' && !(typeof process !== 'undefined' && process.env.VITEST) && !(globalThis as any).__vitest_worker__) {
    window.setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
      // Skip rather than queue: a colliding poll is redundant and the next tick
      // is 3s away.
      if (workingSnapshotPollInFlight) return
      // Unconditional, and that is the point.
      //
      // This used to return early when the client already believed nothing was
      // running -- which is self-defeating: it can only ever confirm a run the
      // client already knows about, never discover one. A run started by the CLI,
      // by another device, or by a background delegation therefore waited for the
      // twelve-second session-list poll, and the ring appeared long after the run
      // had visibly started.
      //
      // The read is a plain in-memory map on the server with no database access,
      // which is what makes polling it at this rate reasonable.
      workingSnapshotPollInFlight = true
      void applyWorkingSessionsSnapshot()
        .catch(() => { /* a failed poll must not surface as an error toast */ })
        .finally(() => { workingSnapshotPollInFlight = false })
    }, WORKING_SNAPSHOT_POLL_MS)
  }

  // Background polling for live session-list sync: sessions created or advanced
  // on the VM via CLI/Telegram/another device must show up and re-sort here
  // without a manual reload. It runs while the tab is visible, including during
  // a local run — the refresh is a metadata-only HTTP read and cannot disrupt
  // streaming, which arrives over the socket instead. visibilitychange (above)
  // covers waking from a hidden tab; this covers "left it open and watching".
  if (typeof window !== 'undefined' && !(typeof process !== 'undefined' && process.env.VITEST) && !(globalThis as any).__vitest_worker__) {
    window.setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
      // Not gated on isStreaming: watching a session run is exactly when the
      // sidebar most needs other sessions' working flags and activity times.
      void refreshSessionListOnly()
      // Live-sync NEW messages only. The server paginates newest-first
      // (offset=0 = latest page). We re-fetch the latest page and prepend any
      // messages whose id is newer than the client's current newest id.
      // We do NOT touch loadedMessageCount (that is owned by
      // loadOlderMessages for backward pagination) and we never re-add
      // existing messages, so this cannot introduce duplicates or make the
      // visible messages appear to drift older.
      const sid = activeSessionId.value
      if (sid && !streamStates.value.has(sid)) {
        const target = sessions.value.find(s => s.id === sid)
        if (target && target.messages?.length && !liveMessageSyncInFlight) {
          liveMessageSyncInFlight = true
          try {
          let _fetchSessionMessagesPage: ((...args: any[]) => Promise<any>) | undefined
          try { _fetchSessionMessagesPage = fetchSessionMessagesPage as unknown as ((...args: any[]) => Promise<any>) } catch { _fetchSessionMessagesPage = undefined }
          if (typeof _fetchSessionMessagesPage !== 'function') { liveMessageSyncInFlight = false; return }
          _fetchSessionMessagesPage(sid, 0, LIVE_CHAT_MESSAGE_PAGE_SIZE, target.profile).then(page => {
            if (!page?.messages?.length) return
            const freshMsgs = mapHermesMessages(page.messages as any[])
            const currentNewestId = target.messages[target.messages.length - 1]?.id
            const currentNewestTs = target.messages[target.messages.length - 1]?.timestamp || 0
            // Keep only messages strictly newer than the newest we already
            // display. Same-timestamp messages are NOT auto-accepted here;
            // they must be validated via id dedup below. The previous
            // `timestamp === currentNewestTs` backdoor let re-inserted old
            // messages (new autoincrement id, old second-precision timestamp)
            // slip through when the tail-window count misclassified them as
            // missing.
            const newMsgs = freshMsgs.filter(m => {
              if (m.id === currentNewestId) return false
              return m.timestamp > currentNewestTs
            })
            if (!newMsgs.length) return
            // Drop any already-present ids (safety).
            const existingIds = new Set(target.messages.map(m => m.id))
            const dedupedById = newMsgs.filter(m => !existingIds.has(m.id))
            if (!dedupedById.length) return
            const deduped = dedupedById.filter(m => {
              // Only assistant replies are deduped; user messages are never
              // dropped (re-sending after a network failure is legitimate).
              if (m.role !== 'assistant') return true
              return !isDuplicateAssistantContent(target.messages, m.role, m.content, m.timestamp)
            })
            if (!deduped.length) return
            target.messages.push(...deduped)
            target.messages.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0) || Number(a.id) - Number(b.id))
            target.messageTotal = page.total
            target.messageCount = page.total
            target.hasMoreBefore = (page as any).hasMore ?? (target.loadedMessageCount || 0) < (target.messageTotal ?? 0)
            restorePersistedSubagentStreams(sid)
            setWorkspaceRunChanges(sid, [])
          }).catch(() => {}).finally(() => {
            liveMessageSyncInFlight = false
          })
          } catch { liveMessageSyncInFlight = false }
        }
      }
    }, 12_000)
  }

  // Transient observation of <think> boundaries during active streaming.
  // Not persisted; cleared on session switch. See spec §5.3.
  const thinkingObservation = new Map<string, { startedAt?: number; endedAt?: number }>()

  function getThinkingObservation(messageId: string) {
    return thinkingObservation.get(messageId)
  }

  function noteThinkingDelta(messageId: string, prevContent: string, nextContent: string) {
    const { startedAtBoundary, endedAtBoundary } = detectThinkingBoundary(prevContent, nextContent)
    if (!startedAtBoundary && !endedAtBoundary) return
    const existing = thinkingObservation.get(messageId) || {}
    if (startedAtBoundary && existing.startedAt === undefined) {
      existing.startedAt = Date.now()
    }
    if (endedAtBoundary && existing.endedAt === undefined) {
      existing.endedAt = Date.now()
    }
    thinkingObservation.set(messageId, existing)
  }

  /** 第一次见到某条消息的 reasoning 文本时，标记 startedAt。 */
  function noteReasoningStart(messageId: string) {
    const existing = thinkingObservation.get(messageId) || {}
    if (existing.startedAt === undefined) {
      existing.startedAt = Date.now()
      thinkingObservation.set(messageId, existing)
    }
  }

  /** 内容首次到达（视为推理结束）或显式收到 reasoning.available 时，标记 endedAt。 */
  function noteReasoningEnd(messageId: string) {
    const existing = thinkingObservation.get(messageId)
    if (!existing || existing.startedAt === undefined) return
    if (existing.endedAt === undefined) {
      existing.endedAt = Date.now()
      thinkingObservation.set(messageId, existing)
    }
  }

  function clearProviderFromSessions(provider: string) {
    if (!provider) return
    const target = provider.toLowerCase()
    for (const s of sessions.value) {
      if ((s.provider || '').toLowerCase() === target) {
        s.model = undefined
        s.provider = ''
      }
    }
  }

  async function setSessionReasoningEffort(sessionId: string, effort: string): Promise<boolean> {
    const target = sessions.value.find(s => s.id === sessionId)
    const activeTarget = activeSession.value?.id === sessionId ? activeSession.value : null
    const session = target || activeTarget
    if (!session) return false

    const nextEffort = effort || undefined
    const previousEffort = session.reasoningEffort
    if (target) target.reasoningEffort = nextEffort
    if (activeTarget) activeTarget.reasoningEffort = nextEffort
    if (session.isLocalOnly) return true

    if (!reasoningEffortWriteChains.has(sessionId)) {
      reasoningEffortConfirmedValues.set(sessionId, previousEffort)
    }
    reasoningEffortWriteTargets.set(sessionId, nextEffort)
    const previousWrite = reasoningEffortWriteChains.get(sessionId) || Promise.resolve(true)
    const write: Promise<boolean> = previousWrite
      .catch(() => false)
      .then(() => persistSessionReasoningEffort(sessionId, effort))
      .then((ok) => {
        if (ok) reasoningEffortConfirmedValues.set(sessionId, nextEffort)
        if (!ok && reasoningEffortWriteTargets.get(sessionId) === nextEffort) {
          const confirmedEffort = reasoningEffortConfirmedValues.get(sessionId)
          if (target) target.reasoningEffort = confirmedEffort
          if (activeTarget) activeTarget.reasoningEffort = confirmedEffort
        }
        return ok
      })
      .finally(() => {
        if (reasoningEffortWriteChains.get(sessionId) !== write) return
        reasoningEffortWriteChains.delete(sessionId)
        reasoningEffortWriteTargets.delete(sessionId)
        reasoningEffortConfirmedValues.delete(sessionId)
      })
    reasoningEffortWriteChains.set(sessionId, write)
    return write
  }

  async function setSessionPushEnabled(sessionId: string, enabled: boolean): Promise<boolean> {
    const target = sessions.value.find(s => s.id === sessionId)
    const activeTarget = activeSession.value?.id === sessionId ? activeSession.value : null
    const session = target || activeTarget
    if (!session) return false

    const previousEnabled = Boolean(session.pushEnabled)
    if (target) target.pushEnabled = enabled
    if (activeTarget) activeTarget.pushEnabled = enabled
    if (session.isLocalOnly) return true

    if (!pushEnabledWriteChains.has(sessionId)) {
      pushEnabledConfirmedValues.set(sessionId, previousEnabled)
    }
    pushEnabledWriteTargets.set(sessionId, enabled)
    const previousWrite = pushEnabledWriteChains.get(sessionId) || Promise.resolve(true)
    const write: Promise<boolean> = previousWrite
      .catch(() => false)
      .then(() => persistSessionPushEnabled(sessionId, enabled))
      .then((ok) => {
        if (ok) pushEnabledConfirmedValues.set(sessionId, enabled)
        if (!ok && pushEnabledWriteTargets.get(sessionId) === enabled) {
          const confirmedEnabled = pushEnabledConfirmedValues.get(sessionId) || false
          if (target) target.pushEnabled = confirmedEnabled
          if (activeTarget) activeTarget.pushEnabled = confirmedEnabled
        }
        return ok
      })
      .finally(() => {
        if (pushEnabledWriteChains.get(sessionId) !== write) return
        pushEnabledWriteChains.delete(sessionId)
        pushEnabledWriteTargets.delete(sessionId)
        pushEnabledConfirmedValues.delete(sessionId)
      })
    pushEnabledWriteChains.set(sessionId, write)
    return write
  }

  function clearThinkingObservationFor(_sessionId: string) {
    // messageId 与 sessionId 的关联未单独持有；方案是切会话时一律清空。
    // 这符合 spec 定义：observation 是"当前会话范围内"的 transient 状态。
    thinkingObservation.clear()
  }

  // 播放消息语音
  function playMessageSpeech(messageId: string, content: string) {
    // 触发自定义事件，让 MessageItem 组件处理播放
    const event = new CustomEvent('auto-play-speech', {
      detail: { messageId, content }
    })
    window.dispatchEvent(event)
  }

  return {
    sessions,
    runtimeMode,
    activeSessionId,
    activeSession,
    focusMessageId,
    messages,
    isStreaming,
    isForkPending,
    isRunActive,
    isSessionLive,
    isSessionWorking,
    reconcileSessionIdle,
    runStartedAt,
    // Exposed alongside runStartedAt/abortState so the independent sources that
    // feed `isStreaming` can be inspected and asserted on directly.
    serverWorking,
    streamStates,
    // The run record and the three primitives that write it. Exported so a test
    // can put a session in a state that otherwise needs a live socket to reach,
    // while still going through the same single writer production uses -- a test
    // that set the fields directly would be testing a shape the app never
    // produces, which is how the previous parallel maps stayed green while
    // disagreeing with each other.
    sessionRuns,
    markSessionRunning,
    markSessionIdle,
    attachSessionStream,
    setBackgroundPending,
    // Same reason as the two above: the delegation count is the third independent
    // source behind isSessionWorking, and a test cannot tell which one lit the
    // ring without reading it.
    backgroundPendingBySession,
    isSessionCompletedUnread,
    clearSessionCompletedUnread,
    sessionProfileFilter,
    setSessionProfileFilter,
    validateSessionProfileFilter,
    setHermesSessionProfileFilter,
    compressionState,
    setKnownSkillCommandNames,
    abortState,
    isAborting,
    queueLengths,
    queuedUserMessages,
    queueInsertionStates,
    activeMessageReference,
    pendingApprovals,
    activePendingApproval,
    pendingClarifies,
    activePendingClarify,
    subagentStreams,
    getSubagentStream,
    removeQueuedMessage,
    insertQueuedMessage,
    setMessageReference,
    clearMessageReference,
    isLoadingSessions,
    sessionsLoaded,
    isLoadingMessages,

    newChat,
    newCliSession,
    switchSession,
    ensureSessionLoaded,
    ensureSessionByDirectFetch,
    loadOlderMessages,
    switchSessionModel,
    addOrUpdateSession,
    clearProviderFromSessions,
    deleteSession,
    archiveSession,
    sendMessage,
    stopStreaming,
    respondApproval,
    respondApprovalFor,
    respondToClarify,
    respondToClarifyFor,
    loadSessions,
    refreshSessionListOnly,
    refreshActiveSession,
    getThinkingObservation,
    noteThinkingDelta,
    noteReasoningStart,
    noteReasoningEnd,
    clearThinkingObservationFor,
    setAutoPlaySpeech,
    playMessageSpeech,
    loadWorkspaceRunChangeFile,
    setSessionReasoningEffort,
    setSessionPushEnabled,
    setRuntimeMode,
    historySessionProfileFilter,
  }
})
