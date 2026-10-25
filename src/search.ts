/**
 * 跨工作区全文检索（本 fork 新增）。
 *
 * 上游 bridge 的 find 按标题/工作区/id 找会话，read 负责读正文；但「按正文关键词
 * 在所有工作区里找」是缺的一环。DSH 内置 session_search 工具在工具层按 cwd 鉴权，
 * 而宿主服务 `ctx.sessionQuery` 本身没有这个限制——本工具直接消费该服务：
 *
 *  - 有全文索引时：searchSessions / searchEvents（快）；
 *  - 索引关闭时：listSessions + filterEvents 有界扫描（≤250 会话、4 并发），
 *    结果标记 degraded: true。
 *
 * 只读：不创建、不发送、不修改任何会话。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** 结果边界：搜索不得淹没模型上下文。 */
const DEFAULT_LIMIT = 10
const MAX_LIMIT = 30
/** 降级扫描自行构造摘要的字符上限。 */
const SNIPPET_CHARS = 240
/** 降级扫描最多打开的会话数。 */
const DEGRADED_SCAN_SESSIONS = 250
/** 降级扫描的并发日志读取数。 */
const DEGRADED_CONCURRENCY = 4

interface SessionHeaderLike {
  id: string
  cwd?: string
  createdAt?: number
}

interface SessionRecordLike {
  header: SessionHeaderLike
  live?: boolean
  persisted?: boolean
}

interface SearchDocumentLike {
  seq?: number
  type?: string
  surface?: string
  time?: number
  text?: string
  snippet?: string
}

interface SessionHitLike extends SessionRecordLike {
  bestMatch?: SearchDocumentLike
}

interface SessionEventHitLike extends SearchDocumentLike {
  sessionId?: string
}

interface SearchPage<T> {
  items?: T[]
  nextCursor?: unknown
  session?: { cwd?: string; createdAt?: number }
}

interface TitleObservationLike {
  sessionId: string
  status: 'fulfilled' | 'rejected'
  value?: { title?: { title?: string } }
}

/** 用到的 sessionQuery 服务面（结构类型：服务不在本插件的 inject 里也无需新依赖）。 */
interface SessionQueryLike {
  searchSessions(request: { query: string; limit?: number }): Promise<SearchPage<SessionHitLike>>
  searchEvents(request: { sessionId: string; query: string; limit?: number }): Promise<SearchPage<SessionEventHitLike>>
  listSessions(): Promise<SessionRecordLike[]>
  filterEvents(sessionId: string, filters: Array<{ kind: 'text'; text: string }>): Promise<SearchDocumentLike[]>
  filterSessions(filters: Array<{ kind: 'id'; values: string[] }>): Promise<SessionRecordLike[]>
  readTitleSnapshots(sessionIds: string[]): Promise<TitleObservationLike[]>
}

interface SearchArgs {
  query?: string
  sessionId?: string
  workspace?: string
  limit?: number
}

/** 取可选的 sessionQuery 服务；某些 profile 没有它。 */
function sessionQueryOf(ctx: Context): SessionQueryLike | undefined {
  const candidate = ctx as unknown as { get?: (name: string) => unknown }
  if (typeof candidate.get !== 'function') return undefined
  return candidate.get('sessionQuery') as SessionQueryLike | undefined
}

function asJson(value: unknown): Record<string, JsonValue> {
  return value as Record<string, JsonValue>
}

/** 可选全文索引未开启时返回该错误码；此时仍可手工扫描日志。 */
function isSearchDisabled(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  if (code === 'SESSION_QUERY_SEARCH_DISABLED') return true
  const message = error instanceof Error ? error.message : String(error ?? '')
  return /SESSION_QUERY_SEARCH_DISABLED|search is disabled/i.test(message)
}

function clampLimit(value: unknown): number {
  const limit = Number(value)
  if (!Number.isFinite(limit) || limit <= 0) return DEFAULT_LIMIT
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(limit)))
}

function clip(text: unknown, limit = SNIPPET_CHARS): string {
  const compact = String(text ?? '').replace(/\s+/g, ' ').trim()
  return compact.length <= limit ? compact : compact.slice(0, limit) + '…'
}

function matchesWorkspace(cwd: string | undefined, needle: string | undefined): boolean {
  if (needle === undefined) return true
  return typeof cwd === 'string' && cwd.toLowerCase().includes(needle.toLowerCase())
}

/** 为一批会话折叠标题；失败不影响搜索。 */
async function readTitles(ctx: Context, sessionIds: string[]): Promise<Map<string, string>> {
  const titles = new Map<string, string>()
  const service = sessionQueryOf(ctx)
  if (service === undefined || sessionIds.length === 0) return titles
  try {
    const results = await service.readTitleSnapshots(sessionIds)
    for (const result of results) {
      const title = result.status === 'fulfilled' ? result.value?.title?.title : undefined
      if (typeof title === 'string' && title !== '') titles.set(String(result.sessionId), title)
    }
  } catch {
    // 标题只是装饰：折叠失败不能拖垮搜索。
  }
  return titles
}

interface RowSource {
  sessionId: string
  title?: string
  cwd?: string
  live?: boolean
  persisted?: boolean
  createdAt?: number
  seq?: number
  type?: string
  surface?: string
  time?: number
  snippet?: string
}

/** 组装一行结果，保证所有字段都是 lossless JSON。 */
function row(source: RowSource): Record<string, JsonValue> {
  return {
    sessionId: source.sessionId,
    title: source.title ?? null,
    cwd: source.cwd ?? null,
    live: source.live === true,
    persisted: source.persisted === true,
    createdAt: typeof source.createdAt === 'number' ? source.createdAt : null,
    seq: typeof source.seq === 'number' ? source.seq : null,
    type: typeof source.type === 'string' ? source.type : null,
    surface: typeof source.surface === 'string' ? source.surface : null,
    time: typeof source.time === 'number' ? source.time : null,
    snippet: typeof source.snippet === 'string' ? source.snippet : null,
  }
}

/** 走索引：每个会话一条最强命中。 */
async function searchAllSessions(ctx: Context, service: SessionQueryLike, query: string, limit: number, workspace: string | undefined): Promise<Record<string, JsonValue>> {
  const requestLimit = workspace === undefined ? limit : Math.min(MAX_LIMIT, limit * 3)
  const page = await service.searchSessions({ query, limit: requestLimit })
  const hits = (page.items ?? [])
    .filter((hit) => matchesWorkspace(hit.header?.cwd, workspace))
    .slice(0, limit)
  const titles = await readTitles(ctx, hits.map((hit) => String(hit.header.id)))
  const items = hits.map((hit) => {
    const best = hit.bestMatch ?? {}
    return row({
      sessionId: String(hit.header.id),
      title: titles.get(String(hit.header.id)),
      cwd: hit.header.cwd,
      live: hit.live,
      persisted: hit.persisted,
      createdAt: hit.header.createdAt,
      seq: best.seq,
      type: best.type,
      surface: best.surface,
      time: best.time,
      snippet: best.snippet,
    })
  })
  return asJson({
    mode: 'sessions',
    degraded: false,
    query,
    total: items.length,
    hasMore: page.nextCursor !== undefined,
    items,
  })
}

/** 走索引：单会话内的命中事件。 */
async function searchOneSession(ctx: Context, service: SessionQueryLike, sessionId: string, query: string, limit: number): Promise<Record<string, JsonValue>> {
  const page = await service.searchEvents({ sessionId, query, limit })
  const header = page.session ?? {}
  const titles = await readTitles(ctx, [sessionId])
  let record: SessionRecordLike | undefined
  try {
    [record] = await service.filterSessions([{ kind: 'id', values: [sessionId] }])
  } catch {
    // 记录元数据只是装饰；事件命中才是结果。
  }
  const items = (page.items ?? []).slice(0, limit).map((hit) => row({
    sessionId: String(hit.sessionId ?? sessionId),
    title: titles.get(sessionId),
    cwd: header.cwd,
    live: record?.live,
    persisted: record?.persisted,
    createdAt: header.createdAt,
    seq: hit.seq,
    type: hit.type,
    surface: hit.surface,
    time: hit.time,
    snippet: hit.snippet,
  }))
  return asJson({
    mode: 'events',
    degraded: false,
    query,
    total: items.length,
    hasMore: page.nextCursor !== undefined,
    items,
  })
}

/** 读一个会话的正文命中，永不抛出。 */
async function scanSession(service: SessionQueryLike, sessionId: string, query: string): Promise<SearchDocumentLike[]> {
  try {
    return await service.filterEvents(sessionId, [{ kind: 'text', text: query }])
  } catch {
    return []
  }
}

/** 为已组装的行补标题。 */
async function attachTitles(ctx: Context, items: Array<Record<string, JsonValue>>): Promise<void> {
  if (items.length === 0) return
  const ids = [...new Set(items.map((item) => String(item.sessionId)))]
  const titles = await readTitles(ctx, ids)
  for (const item of items) item.title = titles.get(String(item.sessionId)) ?? null
}

/** 索引关闭时的全局降级扫描：每个会话一条最佳命中，按命中数与新旧排序。 */
async function degradedSearch(ctx: Context, service: SessionQueryLike, query: string, limit: number, workspace: string | undefined): Promise<Record<string, JsonValue>> {
  const records = (await service.listSessions())
    .slice(0, DEGRADED_SCAN_SESSIONS)
    .filter((record) => matchesWorkspace(record.header?.cwd, workspace))
  const matches: Array<{ record: SessionRecordLike; count: number; document: SearchDocumentLike }> = []
  for (let offset = 0; offset < records.length; offset += DEGRADED_CONCURRENCY) {
    const chunk = records.slice(offset, offset + DEGRADED_CONCURRENCY)
    const scanned = await Promise.all(chunk.map(async (record) => ({
      record,
      documents: await scanSession(service, String(record.header.id), query),
    })))
    for (const { record, documents } of scanned) {
      if (documents.length === 0) continue
      const current = documents.filter((document) => document.surface === 'current')
      matches.push({ record, count: documents.length, document: current[0] ?? documents[0]! })
    }
  }
  matches.sort((left, right) => right.count - left.count
    || (right.record.header.createdAt ?? 0) - (left.record.header.createdAt ?? 0))
  const selected = matches.slice(0, limit)
  const items = selected.map(({ record, document }) => row({
    sessionId: String(record.header.id),
    cwd: record.header.cwd,
    live: record.live,
    persisted: record.persisted,
    createdAt: record.header.createdAt,
    seq: document.seq,
    type: document.type,
    surface: document.surface,
    time: document.time,
    snippet: clip(document.text),
  }))
  await attachTitles(ctx, items)
  return asJson({
    mode: 'sessions',
    degraded: true,
    query,
    total: items.length,
    hasMore: matches.length > selected.length,
    items,
  })
}

/** 索引关闭时的单会话降级扫描。 */
async function degradedSessionEvents(ctx: Context, service: SessionQueryLike, sessionId: string, query: string, limit: number): Promise<Record<string, JsonValue>> {
  const matches = await scanSession(service, sessionId, query)
  const documents = matches.slice(0, limit)
  let record: SessionRecordLike | undefined
  try {
    [record] = await service.filterSessions([{ kind: 'id', values: [sessionId] }])
  } catch {
    // 记录元数据只是装饰；事件命中才是结果。
  }
  const items = documents.map((document) => row({
    sessionId,
    cwd: record?.header?.cwd,
    live: record?.live,
    persisted: record?.persisted,
    createdAt: record?.header?.createdAt,
    seq: document.seq,
    type: document.type,
    surface: document.surface,
    time: document.time,
    snippet: clip(document.text),
  }))
  await attachTitles(ctx, items)
  return asJson({
    mode: 'events',
    degraded: true,
    query,
    total: items.length,
    hasMore: matches.length > documents.length,
    items,
  })
}

/** 执行一次检索。 */
async function search(ctx: Context, args: SearchArgs): Promise<Record<string, JsonValue>> {
  const query = typeof args.query === 'string' ? args.query.trim() : ''
  if (query === '') throw new Error('session_search_global: query must be a non-empty string')
  const service = sessionQueryOf(ctx)
  if (service === undefined) throw new Error('session_search_global: this profile has no sessionQuery service')
  const limit = clampLimit(args.limit)
  const workspace = typeof args.workspace === 'string' && args.workspace.trim() !== '' ? args.workspace.trim() : undefined
  const sessionId = typeof args.sessionId === 'string' && args.sessionId.trim() !== '' ? args.sessionId.trim() : undefined
  try {
    return sessionId === undefined
      ? await searchAllSessions(ctx, service, query, limit, workspace)
      : await searchOneSession(ctx, service, sessionId, query, limit)
  } catch (error) {
    if (!isSearchDisabled(error)) throw error
    return sessionId === undefined
      ? degradedSearch(ctx, service, query, limit, workspace)
      : degradedSessionEvents(ctx, service, sessionId, query, limit)
  }
}

/** 渲染检索结果。 */
function renderResult(_args: Record<string, unknown>, value: Record<string, unknown>): Array<{ type: 'text'; text: string }> {
  const items = value.items as Array<Record<string, unknown>> | undefined
  if (!Array.isArray(items) || items.length === 0) {
    const suffix = value.degraded === true ? ' (degraded scan)' : ''
    return [{ type: 'text', text: '(no session matches for ' + JSON.stringify(value.query) + suffix + ')' }]
  }
  const lines: string[] = []
  for (const [index, item] of items.entries()) {
    const title = item.title ?? '(untitled)'
    const state = item.live === true ? 'live' : 'offline'
    const cwd = item.cwd === null ? '' : ' @ ' + String(item.cwd)
    lines.push(String(index + 1) + '. ' + String(item.sessionId) + ' — ' + String(title) + ' [' + state + ']' + cwd)
    const when = item.time === null ? '' : ' · ' + new Date(Number(item.time)).toISOString()
    lines.push('   seq ' + String(item.seq) + ' · ' + String(item.type) + ' · ' + String(item.surface) + when)
    lines.push('   ' + clip(item.snippet, 600))
  }
  const tail = value.degraded === true
    ? '\n(degraded scan: no full-text index is open in this profile; matches come from a bounded log scan)'
    : value.mode === 'sessions'
      ? '\nRead a match with session_bridge_read, or repeat with sessionId to list matching events inside it.'
      : ''
  return [{ type: 'text', text: lines.join('\n') + tail }]
}

/** 注册 session_search_global。 */
export function registerSearchTool(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'session_search_global',
    description: 'Search the full text of every session in every workspace, including sessions that belong to other working directories (the built-in session_search only sees the caller workspace). '
      + 'Returns the strongest match per session: session id, title, cwd, live/offline state, event sequence number and a snippet. '
      + 'Pass sessionId to list matching events inside that one session instead. Read-only; follow up with session_bridge_read to read the surrounding conversation.',
    parameters: {
      query: { type: 'string', required: true, description: 'Literal search text over stored session bodies (user and assistant messages, tool calls, tool results).' },
      sessionId: { type: 'string', description: 'Search inside this exact session and return matching events (seq/type/snippet) instead of one hit per session.' },
      workspace: { type: 'string', description: 'Only sessions whose working directory contains this substring, case-insensitive (e.g. "memory_research").' },
      limit: { type: 'number', description: 'Maximum results (default ' + String(DEFAULT_LIMIT) + ', max ' + String(MAX_LIMIT) + ').' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: renderResult,
    },
    async execute(args: SearchArgs) {
      return search(ctx, args)
    },
  }))
}
