/**
 * 交接（handoff）：把一个被中断会话的任务上下文，渲染成注入新会话的首条提示。
 *
 * 触发场景是思维链循环——原会话已经不可信（它正把同一段内容反复吐出来），所以交接
 * 必须让新会话**自己**去读原会话日志拿全上下文，而不是指望我们把上下文抄全。
 * 因此提示里给三样东西：原会话 id（可 session_bridge_read）、任务指令与中断前近况
 * （够它立刻开工的摘要）、以及原会话派生的子代理清单（避免重复劳动）。
 *
 * 纯函数：只吃事件日志与配置，不碰宿主。
 */
import { foldMessages, liveReasoningSnapshot, type BridgeMessageRow } from './core.ts'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** 截断上限：够读懂，又不会让交接提示膨胀到挤占新会话的上下文。 */
export const TASK_LIMIT = 1200
export const USER_LIMIT = 600
export const ASSISTANT_LIMIT = 800
export const REASONING_LIMIT = 1200
export const DESCENDANT_TASK_LIMIT = 400
/** 交接提示里最多逐个列出的子代理数，其余折叠为计数。 */
export const HANDOFF_DESCENDANT_LIMIT = 5

/** 从原会话日志里提取的任务上下文。 */
export interface BridgeTaskContext {
  /** 首条用户指令（任务定义）。 */
  task?: string
  /** 最近几条用户指令（可能含补充/纠偏）。 */
  recentUser: string[]
  /** 最后一条带文本的 assistant 回复。 */
  lastAssistant?: string
  /** 最后一段思维链（已定型优先，否则取进行中的增量）。 */
  lastReasoning?: string
}

export interface ExtractTaskContextOptions {
  taskLimit?: number
  userLimit?: number
  assistantLimit?: number
  reasoningLimit?: number
  /** 取最近几条用户指令（默认 3）。 */
  recentUsers?: number
}

function clip(text: string, limit: number): string {
  return text.length > limit ? text.slice(0, limit) + '…' : text
}

function firstUserText(rows: readonly BridgeMessageRow[]): string | undefined {
  for (const row of rows) if (row.role === 'user' && row.text !== undefined) return row.text
  return undefined
}

/**
 * 从事件日志折叠出交接所需的任务上下文。思维链优先取**已定型**的最后一段；
 * 若没有（会话正卡在循环里、最后一段还没定型），回落到进行中的增量流——
 * 循环现场通常正是后者。
 */
export function extractTaskContext(events: readonly SessionEvent[], options: ExtractTaskContextOptions = {}): BridgeTaskContext {
  const taskLimit = options.taskLimit ?? TASK_LIMIT
  const userLimit = options.userLimit ?? USER_LIMIT
  const assistantLimit = options.assistantLimit ?? ASSISTANT_LIMIT
  const reasoningLimit = options.reasoningLimit ?? REASONING_LIMIT
  const recentUsers = options.recentUsers ?? 3

  const rows = foldMessages(events)
  const task = firstUserText(rows)
  const userRows = rows.filter((row) => row.role === 'user' && row.text !== undefined)
  const recentUser = userRows.slice(-recentUsers).map((row) => clip(row.text ?? '', userLimit))

  let lastAssistant: string | undefined
  let lastReasoning: string | undefined
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i]
    if (row === undefined || row.role !== 'assistant') continue
    if (lastAssistant === undefined && row.text !== undefined) lastAssistant = clip(row.text, assistantLimit)
    if (lastReasoning === undefined && row.reasoning !== undefined) lastReasoning = clip(row.reasoning, reasoningLimit)
    if (lastAssistant !== undefined && lastReasoning !== undefined) break
  }
  if (lastReasoning === undefined) {
    const live = liveReasoningSnapshot(events)
    if (live !== null && live.reasoning !== '') lastReasoning = clip(live.reasoning, reasoningLimit)
  }

  return {
    ...(task === undefined ? {} : { task: clip(task, taskLimit) }),
    recentUser,
    ...(lastAssistant === undefined ? {} : { lastAssistant }),
    ...(lastReasoning === undefined ? {} : { lastReasoning }),
  }
}

/** 一个子代理在转移时刻的快照（清单项，不是完整输出）。 */
export interface BridgeDescendantInfo {
  id: string
  status: 'running' | 'idle'
  running: boolean
  origin?: 'subagent'
  delegationDepth?: number
  /** 该子代理的首条用户指令（它领到的任务）。 */
  task?: string
}

export interface HandoffPromptInput {
  /** 原会话 id（被中断的那个）。 */
  sessionId: string
  /** 工作目录。 */
  cwd: string
  /** 中断原因（人类可读，含周期/重复次数/置信度）。 */
  reason: string
  context: BridgeTaskContext
  /** 原会话派生的子代理。 */
  descendants?: readonly BridgeDescendantInfo[]
  /** 本次转移中被主动终止的子代理 id（loopDescendants: 'stop'）。 */
  stopped?: readonly string[]
  /** 自定义模板；缺省用 DEFAULT_HANDOFF_TEMPLATE。占位符见该常量。 */
  template?: string
}

/** 内置交接模板。占位符：{{sessionId}} {{cwd}} {{reason}} {{task}} {{evidence}} {{descendants}}。 */
export const DEFAULT_HANDOFF_TEMPLATE = [
  '你接续一个被中断的任务。原会话的思维链陷入了循环（{{reason}}），已被自动中断。',
  '',
  '原会话: {{sessionId}}',
  '工作目录: {{cwd}}',
  '',
  '原任务指令:',
  '{{task}}',
  '',
  '中断前近况:',
  '{{evidence}}',
  '',
  '{{descendants}}',
  '',
  '请先用 session_bridge_read(sessionId="{{sessionId}}") 读取原会话的完整记录以了解上下文，',
  '然后继续推进该任务。不要重复原会话已完成的步骤，也不要再产出它循环时那段内容。',
].join('\n')

function renderEvidence(context: BridgeTaskContext): string {
  const parts: string[] = []
  if (context.recentUser.length > 0) {
    parts.push('最近的用户指令:\n' + context.recentUser.map((text) => '- ' + text.replace(/\n+/g, ' ')).join('\n'))
  }
  if (context.lastAssistant !== undefined) parts.push('最后一条回复:\n' + context.lastAssistant)
  if (context.lastReasoning !== undefined) parts.push('最后一段思维链（可能已进入循环）:\n' + context.lastReasoning)
  return parts.length === 0 ? '(无可用摘要)' : parts.join('\n\n')
}

function renderDescendants(items: readonly BridgeDescendantInfo[]): string[] {
  const shown = items.slice(0, HANDOFF_DESCENDANT_LIMIT)
  const lines = shown.map((item) => {
    const depth = item.delegationDepth === undefined ? '' : `, depth ${String(item.delegationDepth)}`
    const task = item.task === undefined ? '' : ': ' + item.task.replace(/\n+/g, ' ')
    return `- ${item.id} (${item.status}${depth})${task}`
  })
  if (items.length > shown.length) lines.push(`- …另有 ${String(items.length - shown.length)} 个未列出`)
  return lines
}

/**
 * 渲染交接提示。子代理分三类给出不同指令：仍在跑的**不要重做**（去读它的结果）、
 * 被终止的按原分工重派、已结束的直接读结果。空段落整段省略。
 */
export function buildHandoffPrompt(input: HandoffPromptInput): string {
  const descendants = input.descendants ?? []
  const stopped = new Set(input.stopped ?? [])
  const running = descendants.filter((item) => item.running && !stopped.has(item.id))
  const halted = descendants.filter((item) => stopped.has(item.id))
  const finished = descendants.filter((item) => !item.running && !stopped.has(item.id))

  const blocks: string[] = []
  if (running.length > 0) {
    blocks.push([
      '原会话仍在运行的子代理（不要重做它们的工作；可用 session_bridge_status / session_bridge_wait 观察，',
      '完成后用 session_bridge_read 取结果）:',
      ...renderDescendants(running),
    ].join('\n'))
  }
  if (halted.length > 0) {
    blocks.push([
      '已终止的子代理（因思维链循环被中断；需要时请按同样的分工重新派生）:',
      ...renderDescendants(halted),
    ].join('\n'))
  }
  if (finished.length > 0) {
    blocks.push([
      '已结束的子代理（结果留在原会话日志里，可用 session_bridge_read 取回）:',
      ...renderDescendants(finished),
    ].join('\n'))
  }

  const template = input.template !== undefined && input.template.trim() !== '' ? input.template : DEFAULT_HANDOFF_TEMPLATE
  return template
    .replaceAll('{{sessionId}}', input.sessionId)
    .replaceAll('{{cwd}}', input.cwd)
    .replaceAll('{{reason}}', input.reason)
    .replaceAll('{{task}}', input.context.task ?? '(未能从原会话日志中解析出任务指令)')
    .replaceAll('{{evidence}}', renderEvidence(input.context))
    .replaceAll('{{descendants}}', blocks.join('\n\n'))
}
