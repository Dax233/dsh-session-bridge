/**
 * dsh-session-bridge monitor: 线程内的后台守护循环。
 * 对一个"主任务会话"按配置间隔轮询其进度（复用 statusSnapshot/规则判定），
 * 根据实际情况自动调度——卡住则 steer 催办/纠偏、卡住过久则 cancel 终止、
 * 出现完成关键词且空闲则结束监控并留档。可选 LLM 增强：判定是否偏离主题。
 * 作为插件自身的组件存在（非独立插件），用 session_bridge_monitor_start/_stop/_list 控制。
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import type LlmService from '@deepseek-ai/dsh-llm'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import {
  cancelLiveSession,
  collectDescendants,
  getLiveAgent,
  isRootAgent,
  isStalled,
  sendLiveMessage,
  sessionEvents,
  statusSnapshot,
  type BridgeStatusSnapshot,
  type LiveAgentLike,
} from './core.ts'
import { LOOP_DEFAULTS, detectLoop, type LoopGuardConfig, type LoopSignal } from './loop-guard.ts'
import { buildHandoffPrompt, extractTaskContext } from './handoff.ts'
import { createBridgeSession, type BridgeSessionCaller, type CreatedBridgeSession } from './session-create.ts'
import type { LoopPolicy } from './config.ts'
import type { BridgeRegistry } from './registry.ts'

export interface MonitorConfig {
  /** 目标主任务会话 id。 */
  sessionId: string
  /** 轮询间隔（毫秒），默认 10000。 */
  intervalMs: number
  /** 距最近一次事件超过该毫秒数即视为"卡住"，默认 60000。 */
  stalledMs?: number
  /** 连续卡住超过多少次后自动 cancel 终止，默认 3。 */
  maxStuckCycles?: number
  /** 判定为完成后出现的文本关键词（任一命中即视为完成信号）。 */
  doneKeywords: string[]
  /** 卡住时注入的 steer 文本（催办/纠偏），默认催办。 */
  onStallSteer?: string
  /** 是否用 LLM 判断偏离主题（默认 false，用规则即可）。 */
  useLlm?: boolean
  /** LLM 判定偏离时的纠正 steer 文本。 */
  onOffTrackSteer?: string
  /** 监控日志文件路径（缺省 DSH_HOME/super-injector/dsh-session-bridge-monitor.log）。 */
  logFile?: string
  /** 监控会话的说明，仅用于展示。 */
  label?: string
  /** 思维链（CoT）规则：对实时推理/文本做 contains/not-contains 匹配，持续命中达 cotMinHits 后触发 steer 或 cancel。 */
  coTRules?: CoTRule[]
  /** 一条规则连续命中多少个 tick 才触发（默认 1 = 立即）。 */
  cotMinHits?: number
  /** 思维链**循环**守卫：false 关闭（默认开启）。 */
  loopGuard?: boolean
  /** 循环检测字段：reasoning（默认，实时推理优先）/ text / both。 */
  loopField?: 'reasoning' | 'text' | 'both'
  /** 最小周期数（默认 2）。 */
  loopMinCycles?: number
  /** 最小重复次数（默认 3）；有效门槛 = max(loopMinCycles, loopMinRepeats)。 */
  loopMinRepeats?: number
  /** 置信度阈值（默认 0.6）。 */
  loopMinConfidence?: number
  /** 同一签名连续命中多少个 tick 才触发（默认 1 = 首次命中即触发）。 */
  loopMinHits?: number
  /** 触发冷却（毫秒，默认 max(intervalMs*2, 30000)）：冷却窗口内同一签名不重复触发。 */
  loopCooldownMs?: number
  /** 最多转移几次（默认 3）；同时是转移链的深度上限。 */
  loopMaxTransfers?: number
  /** 是否允许把任务转移到新会话（默认 true）；false = 只中断不转移。 */
  loopTransfer?: boolean
  /** 转移后是否自动守护新会话（默认 true）。 */
  loopAutoMonitor?: boolean
  /** 自定义交接提示模板（占位符 {{sessionId}}/{{cwd}}/{{reason}}/{{task}}/{{evidence}}/{{descendants}}）。 */
  loopHandoffPrompt?: string
  /** 子代理处置：report（默认：登记进交接）/ stop（转移时先终止仍在运行的）/ ignore（完全不管）。 */
  loopDescendants?: 'report' | 'stop' | 'ignore'
  /** 当前转移深度（内部每次转移 +1；达到 loopMaxTransfers 后退化为只中断）。 */
  loopTransferDepth?: number
}

/** 一条思维链规则：匹配实时链的内容并触发动作。 */
export interface CoTRule {
  /** contains = 匹配内容必须包含 value；not-contains = 必须不含 value。 */
  match: 'contains' | 'not-contains'
  /** 在哪个字段上匹配：reasoning（思维链）/ text（回复文本）/ both（任一）。 */
  field: 'reasoning' | 'text' | 'both'
  /** 匹配的关键词（非空）。 */
  value: string
  /** 触发动作：cancel 立即终止会话；steer 注入一条用户消息引导。 */
  action: 'steer' | 'cancel'
  /** steer 时的注入文案（缺省用默认催办文案）。 */
  message?: string
}

/** 一条 CoT 规则的连续命中计数（防单次 tick 误触发 & 防重复触发）。 */
export interface CoTRuleState {
  hits: number
  lastFiredAt: number | null
  lastMatch: boolean
  lastSubject: string
}

export interface MonitorEntryState {
  config: MonitorConfig
  startedAt: number
  lastTickAt: number
  stuckCount: number
  lastAction: 'none' | 'steer' | 'cancel' | 'done' | 'lost' | 'offtrack' | 'steady' | 'cot-steer' | 'cot-cancel'
    | 'loop-cancel' | 'loop-transfer' | 'loop-subagent-cancel'
  lastActionAt: number | null
  lastNote: string
  done: boolean
  cycles: number
  cot: {
    rules: { [key: string]: CoTRuleState }
  }
  /** 思维链循环守卫状态。 */
  loop: LoopGuardState
}

/** 循环守卫运行期状态（每个被监控会话一份）。 */
export interface LoopGuardState {
  /** 按字段记录命中状态：'reasoning' / 'text' / 'subagent:<id>'。 */
  fields: { [key: string]: LoopFieldState }
  /** 已完成的转移记录（同时用作转移次数预算）。 */
  transfers: LoopTransferRecord[]
  /** 上次转移尝试时间：失败后节流重试，避免每个 tick 都去建会话。 */
  lastAttemptAt: number | null
  /** 因循环被终止的子代理数。 */
  subagentCancels: number
}

/** 单个字段上的循环命中状态。 */
export interface LoopFieldState {
  /** 上一 tick 的签名（field|period|unit）；签名变化即视为另一个循环，命中计数复位。 */
  signature: string
  /** 同一签名的连续命中次数。 */
  hits: number
  /** 上次真正触发（转移/中断）的时间，冷却用。 */
  lastFiredAt: number | null
  /** 最近一次信号（展示用）。 */
  lastSignal: LoopSignal | null
}

/** 一次循环转移的记录。 */
export interface LoopTransferRecord {
  at: number
  from: string
  to: string
  reason: string
  period: number
  repeats: number
  confidence: number
  /** 转移时的转移深度（新会话继承 depth + 1）。 */
  depth: number
  /** 转移时刻原会话派生的子代理清单。 */
  descendants: Array<{ id: string; status: string; task?: string }>
  /** 本次转移中被主动终止的子代理 id。 */
  stopped: string[]
}

const SCAN_MS = 5000

/** 循环检测字段（默认只查思维链）。 */
function loopFieldOf(config: MonitorConfig): 'reasoning' | 'text' | 'both' {
  const field = config.loopField
  return field === 'text' || field === 'both' ? field : 'reasoning'
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

function clampFloat(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

/** 检测阈值：非法值一律回落默认（工具层已 clamp 一次，这里兜住内部直接调用）。 */
function loopThresholds(config: MonitorConfig): Required<LoopGuardConfig> {
  return {
    minCycles: clampInt(config.loopMinCycles, LOOP_DEFAULTS.minCycles, 2, 8),
    minRepeats: clampInt(config.loopMinRepeats, LOOP_DEFAULTS.minRepeats, 2, 20),
    minConfidence: clampFloat(config.loopMinConfidence, LOOP_DEFAULTS.minConfidence, 0.1, 1),
    charN: LOOP_DEFAULTS.charN,
    charRepeatRate: LOOP_DEFAULTS.charRepeatRate,
    charMinTokens: LOOP_DEFAULTS.charMinTokens,
  }
}

/** 触发冷却窗口：默认 max(intervalMs*2, 30s)。 */
function loopCooldownOf(config: MonitorConfig): number {
  return clampInt(config.loopCooldownMs, Math.max(config.intervalMs * 2, 30_000), 1_000, 3_600_000)
}

/** 最大转移次数（同时是转移链深度上限）。 */
function loopMaxTransfersOf(config: MonitorConfig): number {
  return clampInt(config.loopMaxTransfers, 3, 1, 50)
}

/** 同一签名连续命中多少次才触发。 */
function loopMinHitsOf(config: MonitorConfig): number {
  return clampInt(config.loopMinHits, 1, 1, 100)
}

/** 空循环守卫状态。 */
function emptyLoopState(): LoopGuardState {
  return { fields: {}, transfers: [], lastAttemptAt: null, subagentCancels: 0 }
}

function dshLogFile(override: string | undefined): string {
  if (override !== undefined && override !== '') return override
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'super-injector', 'dsh-session-bridge-monitor.log')
}

export class SessionMonitor {
  private readonly entries = new Map<string, MonitorEntryState>()
  private timer: unknown | undefined
  private readonly logFile: string
  // 显式字段赋值而不是 TS 参数属性：Node 的 strip-only 类型擦除不支持参数属性，
  // 而本仓库的测试就是用 node --experimental-strip-types 直接跑 src/*.ts 的。
  private readonly ctx: Context
  private readonly registry: BridgeRegistry
  // 插件级循环策略（总开关 + 全局默认值）；独立使用（测试）时为 undefined，全部走内置默认值。
  private readonly policy: LoopPolicy | undefined

  constructor(ctx: Context, registry: BridgeRegistry, logFile?: string, policy?: LoopPolicy) {
    this.ctx = ctx
    this.registry = registry
    this.logFile = dshLogFile(logFile)
    this.policy = policy
  }

  /**
   * 本 tick 是否做循环检测：单次 monitor 参数（loopGuard=false）与插件级总开关
   * （设置页/命令）任意一个关闭即不做。总开关实时读 volatile 引用，所以已运行的守护也立即停手。
   */
  private loopEnabled(entry: MonitorEntryState): boolean {
    if (entry.config.loopGuard === false) return false
    return this.policy === undefined ? true : this.policy.enabled()
  }

  /** 守护没显式传的 loop* 参数，用插件配置里的全局默认值补齐（参数类改动从下一个 start 生效）。 */
  private applyPolicyDefaults(config: MonitorConfig): MonitorConfig {
    const policy = this.policy
    if (policy === undefined) return config
    const defaults = policy.defaults()
    return {
      ...config,
      loopField: config.loopField ?? defaults.field,
      loopMinCycles: config.loopMinCycles ?? defaults.minCycles,
      loopMinRepeats: config.loopMinRepeats ?? defaults.minRepeats,
      loopMinConfidence: config.loopMinConfidence ?? defaults.minConfidence,
      loopMinHits: config.loopMinHits ?? defaults.minHits,
      loopCooldownMs: config.loopCooldownMs ?? defaults.cooldownMs,
      loopMaxTransfers: config.loopMaxTransfers ?? defaults.maxTransfers,
      loopDescendants: config.loopDescendants ?? defaults.descendants,
    }
  }

  /** 启动对一个会话的监控（幂等：已存在则更新配置）。 */
  start(rawConfig: MonitorConfig): MonitorEntryState {
    const config = this.applyPolicyDefaults(rawConfig)
    const existing = this.entries.get(config.sessionId)
    const now = Date.now()
    const cotInit: MonitorEntryState['cot'] = {
      rules: (config.coTRules ?? []).reduce<Record<string, CoTRuleState>>((acc, rule, index) => {
        const key = String(index) + ':' + rule.match + ':' + rule.field + ':' + rule.value
        acc[key] = { hits: 0, lastFiredAt: null, lastMatch: false, lastSubject: '' }
        return acc
      }, {}),
    }
    const entry: MonitorEntryState = existing !== undefined
      ? { ...existing, config, lastTickAt: now }
      : {
        config,
        startedAt: now,
        lastTickAt: now,
        stuckCount: 0,
        lastAction: 'none',
        lastActionAt: null,
        lastNote: '监控已启动',
        done: false,
        cycles: 0,
        cot: cotInit,
        loop: emptyLoopState(),
      }
    if (entry.cot === undefined) entry.cot = cotInit
    // 旧版本留下的条目可能没有 loop 字段（宿主热重载后仍在内存里）。
    if (entry.loop === undefined) entry.loop = emptyLoopState()
    this.entries.set(config.sessionId, entry)
    this.ensureTimer()
    this.log(entry, 'monitor start session=' + config.sessionId + ' interval=' + config.intervalMs
      + ' stalled=' + String(config.stalledMs ?? 60000) + ' maxStuck=' + String(config.maxStuckCycles ?? 3)
      + this.loopSummary(config))
    return entry
  }

  /** 启动日志里的循环守卫摘要。 */
  private loopSummary(config: MonitorConfig): string {
    if (config.loopGuard === false) return ' loop=off'
    if (this.policy !== undefined && !this.policy.enabled()) return ' loop=off(plugin)'
    const thresholds = loopThresholds(config)
    const depth = clampInt(config.loopTransferDepth, 0, 0, 1000)
    return ' loop=' + loopFieldOf(config) + '/' + String(thresholds.minCycles) + 'x' + String(thresholds.minRepeats)
      + '@' + thresholds.minConfidence.toFixed(2) + ' descendants=' + (config.loopDescendants ?? 'report')
      + (config.loopTransfer === false ? ' transfer=off' : ' maxTransfers=' + String(loopMaxTransfersOf(config)))
      + (depth === 0 ? '' : ' depth=' + String(depth))
  }

  /** 停止对一个会话的监控。返回是否存在。 */
  stop(sessionId: string): boolean {
    const existed = this.entries.delete(sessionId)
    if (this.entries.size === 0) this.disposeTimer()
    if (existed) this.stderr('[dsh-session-bridge] monitor stop session=' + sessionId)
    return existed
  }

  /** 全部活动监控快照。 */
  list(): MonitorEntryState[] {
    return [...this.entries.values()].map((e) => ({ ...e, config: { ...e.config } }))
  }

  /** 移除所有监控（插件卸载用）。 */
  dispose(): void {
    this.disposeTimer()
    this.entries.clear()
  }

  /** 立即触发一轮扫描（测试/手动）：绕过 interval 节流，强制评估每个活动条目。 */
  async tickNow(): Promise<void> {
    await this.tick(true)
  }

  private ensureTimer(): void {
    if (this.timer !== undefined) return
    const timer = this.ctx as unknown as { setInterval(fn: () => void, ms: number): unknown }
    this.timer = timer.setInterval(() => {
      void this.tick().catch((error) => {
        this.stderr('[dsh-session-bridge] monitor tick error: ' + String(error))
      })
    }, SCAN_MS)
  }

  private disposeTimer(): void {
    if (this.timer === undefined) return
    const ctx = this.ctx as unknown as { clearInterval(handle: unknown): void }
    try { ctx.clearInterval(this.timer) } catch { /* noop */ }
    this.timer = undefined
  }

  /**
   * 一轮扫描。force=true 忽略 interval 节流（tickNow 用）。
   * 遍历用快照：循环转移会在 tickEntry 里新增（新会话）与删除（原会话）条目，
   * 直接迭代 Map 会让新条目在同一个 tick 里被重复评估。
   */
  private async tick(force = false): Promise<void> {
    const now = Date.now()
    for (const entry of [...this.entries.values()]) {
      if (entry.done) continue
      if (!this.entries.has(entry.config.sessionId)) continue
      if (!force && now - entry.lastTickAt < entry.config.intervalMs) continue
      entry.lastTickAt = now
      entry.cycles += 1
      await this.tickEntry(entry)
    }
  }

  private async tickEntry(entry: MonitorEntryState): Promise<void> {
    const { sessionId } = entry.config
    const agent = getLiveAgent(this.ctx, sessionId)
    if (agent === undefined) {
      entry.stuckCount += 1
      entry.lastAction = 'lost'
      entry.lastActionAt = Date.now()
      entry.lastNote = '目标会话离线（不在 live）'
      this.log(entry, 'target not live; stuck=' + entry.stuckCount)
      if (this.shouldCancel(entry)) this.doCancel(entry, '目标会话离线')
      return
    }
    const snapshot = statusSnapshot(this.ctx, agent)

    // 1) 完成判定：出现完成关键词（且空闲）。
    if (this.isDone(entry, snapshot)) {
      entry.done = true
      entry.lastAction = 'done'
      entry.lastActionAt = Date.now()
      entry.lastNote = '检测到完成信号，监控结束'
      this.log(entry, 'DONE → stop monitor')
      this.stopWithLog(sessionId)
      return
    }

    // 1b) 空闲且无待处理：任务已静默结束，收尾而不是反复催办/取消。
    if (snapshot.running !== 'running' && !snapshot.pendingWork) {
      entry.done = true
      entry.lastAction = 'done'
      entry.lastActionAt = Date.now()
      entry.lastNote = '目标已空闲且无待处理，监控收尾'
      this.log(entry, 'IDLE no-pending → stop monitor (settled)')
      this.stopWithLog(sessionId)
      return
    }

    // 1c) 思维链循环守卫：必须放在卡住判定**之前**——循环期间每一步都在落地新事件，
    //     "距最近事件的时间"永远很小，isStalled 永远不会触发（这正是循环能一直跑下去的原因）。
    if (snapshot.running === 'running' && this.loopEnabled(entry)) {
      const loopHandled = await this.evaluateLoopGuard(entry, snapshot, agent)
      if (loopHandled) return
    }

    // 2) 卡住判定：仅对 running 会话有意义（距最近事件超过阈值）。
    //    判定走 core.isStalled（唯一真源，与 session_bridge_status 的 [STALLED] 标注一致）。
    const stalled = isStalled(snapshot.running, snapshot.stalledMs, entry.config.stalledMs ?? 60000)
    if (stalled) {
      entry.stuckCount += 1
      entry.lastActionAt = Date.now()
      if (this.shouldCancel(entry)) {
        this.doCancel(entry, '卡住超过 ' + entry.config.maxStuckCycles + ' 次')
        return
      }
      // 3) 可选 LLM 偏离判定（有 llm 且开启时）。
      if (entry.config.useLlm === true && this.hasLlm()) {
        const offtrack = await this.judgeOffTrack(entry, snapshot, agent.options as { provider?: string; model?: string })
        if (offtrack === 'offtrack') {
          const steer = entry.config.onOffTrackSteer ?? '检测到任务偏离主题，请回到原始目标继续，并简要说明你下一步怎么做。'
          sendLiveMessage(this.ctx, sessionId, steer, 'steer')
          entry.lastAction = 'offtrack'
          entry.lastNote = 'LLM 判定偏离主题，已 steer 纠偏'
          entry.stuckCount = 0
          this.log(entry, 'OFFTRACK → steer: ' + steer)
          return
        }
        if (offtrack === 'stuck') {
          const steer = entry.config.onStallSteer ?? '较长一段时间没有实质进展，请简明汇报当前进度并继续推进任务。'
          sendLiveMessage(this.ctx, sessionId, steer, 'steer')
          entry.lastAction = 'steer'
          entry.lastNote = 'LLM 判定卡住，已 steer 催办'
          this.log(entry, 'STUCK → steer: ' + steer)
          return
        }
        // 'steady'：LLM 认为仍在推进，重置。
        entry.lastAction = 'steady'
        entry.lastNote = 'LLM 判定仍在推进'
        entry.stuckCount = 0
        this.log(entry, 'LLM verdict=steady; reset stuck')
        return
      }
      // 4) 纯规则：卡住 → steer 催办。
      const steer = entry.config.onStallSteer ?? '较长一段时间没有实质进展，请简明汇报当前进度并继续推进任务。'
      sendLiveMessage(this.ctx, sessionId, steer, 'steer')
      entry.lastAction = 'steer'
      entry.lastNote = '卡住 ' + entry.stuckCount + ' 次，已 steer 催办'
      this.log(entry, 'STALL(#' + entry.stuckCount + ') → steer: ' + steer)
      return
    }

    // 4b) 思维链（CoT）规则检查：对实时推理/文本做匹配，持续命中则 steer/cancel。
    // 与卡住逻辑正交：即使会话在推进，只要思维链不符合规则也可提前终止/纠偏。
    const cotHandled = this.evaluateCoTRules(entry, snapshot, sessionId)
    if (cotHandled) return

    // 5) 正常推进：重置卡住计数。
    if (entry.stuckCount !== 0) entry.stuckCount = 0
    entry.lastAction = 'steady'
    entry.lastActionAt = Date.now()
    entry.lastNote = '正常推进（lastActivity now-' + String(snapshot.stalledMs ?? '?') + 'ms）'
    this.log(entry, 'steady; lastActivity now-' + String(snapshot.stalledMs ?? '?') + 'ms')
  }

  private shouldCancel(entry: MonitorEntryState): boolean {
    return entry.stuckCount >= (entry.config.maxStuckCycles ?? 3)
  }

  private doCancel(entry: MonitorEntryState, reason: string): void {
    cancelLiveSession(this.ctx, entry.config.sessionId, false, reason)
    entry.lastAction = 'cancel'
    entry.lastActionAt = Date.now()
    entry.lastNote = '连续卡住，已 cancel 终止: ' + reason
    this.log(entry, 'CANCEL session=' + entry.config.sessionId + ' reason=' + reason)
  }

  private isDone(entry: MonitorEntryState, snapshot: BridgeStatusSnapshot): boolean {
    const keywords = entry.config.doneKeywords ?? []
    if (keywords.length === 0) return false
    // 只有空闲才算真正收尾（避免 turn 中途误判完成）。
    if (snapshot.running === 'running') return false
    const text = `${snapshot.lastAssistantText ?? ''}\n${snapshot.recent.map((r) => r.text ?? '').join('\n')}`
    if (!text) return false
    return keywords.some((kw) => kw !== '' && text.includes(kw))
  }

  /**
   * 评估思维链（CoT）规则。规则只对 live 会话有意义：running 时用进行中的
   * reasoning-delta 流，空闲时回落到已定型 lastReasoning。not-contains 规则作用在
   * reasoning 字段时，若该会话本就没有推理（非推理模型/尚未产出），不判定为命中，
   * 避免误 cancel 一个根本不产生思维链的会话。
   * @returns true 表示本 tick 已被某条规则触发并处理（steer/cancel），调用方应 return。
   */
  private evaluateCoTRules(entry: MonitorEntryState, snapshot: BridgeStatusSnapshot, sessionId: string): boolean {
    const rules = entry.config.coTRules ?? []
    if (rules.length === 0) return false
    const minHits = entry.config.cotMinHits ?? 1

    // 评估主体：进行中的实时推理/文本，否则已定型的上次推理/回复。
    const hasLive = (snapshot.liveReasoning ?? '') !== ''
    const subject = {
      reasoning: snapshot.liveReasoning ?? snapshot.lastReasoning ?? '',
      text: snapshot.lastAssistantText ?? '',
      hasReasoning: hasLive || (snapshot.lastReasoning ?? '') !== '',
    }

    const now = Date.now()
    const rulesState = entry.cot
    let engaged = false
    rules.forEach((rule, index) => {
      if (engaged) return
      const key = String(index) + ':' + rule.match + ':' + rule.field + ':' + rule.value
      const st = rulesState.rules[key] ?? { hits: 0, lastFiredAt: null, lastMatch: false }

      // not-contains 作用在 reasoning 且本就没有推理时：不算命中。
      if (rule.field === 'reasoning' && rule.match === 'not-contains' && !subject.hasReasoning) {
        st.lastMatch = false
        st.hits = 0
        return
      }

      let hit: boolean
      if (rule.field === 'reasoning') {
        hit = rule.match === 'contains' ? subject.reasoning.includes(rule.value) : !subject.reasoning.includes(rule.value)
      } else if (rule.field === 'text') {
        hit = rule.match === 'contains' ? subject.text.includes(rule.value) : !subject.text.includes(rule.value)
      } else { // 'both'
        const reasonHas = subject.reasoning.includes(rule.value)
        const textHas = subject.text.includes(rule.value)
        hit = rule.match === 'contains' ? (reasonHas || textHas) : (!reasonHas && !textHas)
      }

      st.lastMatch = hit
      st.hits = hit ? st.hits + 1 : 0
      this.log(entry, 'CoT rule ' + key + ' hit=' + String(hit) + ' hits=' + String(st.hits) + '/' + String(minHits))

      const shouldFire = hit && st.hits >= minHits
      if (!shouldFire) return
      // 冷却：同一规则在冷却窗口内不重复触发（除非匹配状态先复位再命中）。
      const coolMs = Math.max(entry.config.intervalMs, 5000) * 2
      if (st.lastFiredAt !== null && now - st.lastFiredAt < coolMs) return

      st.lastFiredAt = now
      if (rule.action === 'cancel') {
        const reason = 'reasoning-rule:' + rule.value
        cancelLiveSession(this.ctx, sessionId, false, reason)
        entry.lastAction = 'cot-cancel'
        entry.lastActionAt = Date.now()
        entry.lastNote = '思维链规则触发 cancel: ' + rule.value
        entry.stuckCount = 0
        this.log(entry, 'COT-CANCEL session=' + sessionId + ' rule=' + key + ' value=' + rule.value)
      } else {
        const steer = rule.message !== undefined && rule.message.trim() !== ''
          ? rule.message.trim()
          : '监控判定：思维链/回复匹配规则「' + rule.value + '」，请据此调整方向并继续推进任务。'
        sendLiveMessage(this.ctx, sessionId, steer, 'steer')
        entry.lastAction = 'cot-steer'
        entry.lastActionAt = Date.now()
        entry.lastNote = '思维链规则触发 steer: ' + rule.value
        entry.stuckCount = 0
        this.log(entry, 'COT-STEER session=' + sessionId + ' rule=' + key + ' steer=' + steer)
      }
      engaged = true
      st.hits = 0
    })
    return engaged
  }

  /**
   * 思维链循环守卫：目标会话的思维链陷入**序列循环**（同一段内容被反复输出，例如
   * "写。好。Go。写。好。Go。写。好。Go。"）时，中断它并把任务转移到新会话继续；
   * 同时顺带照看它派生的子代理（见 evaluateSubagentLoops）。
   *
   * 只在 running 时评估：空闲会话没有"正在循环"的思维链，而且 loop 检测吃的是
   * 实时推理增量（reasoning-delta），空闲时那份增量为空。
   * @returns true 表示本 tick 已处理（转移或中断），调用方应 return。
   */
  private async evaluateLoopGuard(entry: MonitorEntryState, snapshot: BridgeStatusSnapshot, agent: LiveAgentLike): Promise<boolean> {
    const config = entry.config

    // 子代理循环：终止那个子代理（不转移、不打断主会话），并 steer 主会话重派。
    const subagentHandled = config.loopDescendants !== 'ignore' ? this.evaluateSubagentLoops(entry, agent) : false

    const field = loopFieldOf(config)
    const thresholds = loopThresholds(config)
    // 进行中的推理增量优先（循环现场就在增量流里）；没有增量时回落到已定型推理。
    const reasoning = (snapshot.liveReasoning ?? '') !== '' ? (snapshot.liveReasoning ?? '') : (snapshot.lastReasoning ?? '')
    const text = snapshot.lastAssistantText ?? ''

    let hit: { field: string; signal: LoopSignal } | null = null
    if (field === 'reasoning' || field === 'both') {
      const signal = detectLoop(reasoning, thresholds)
      if (signal.detected) hit = { field: 'reasoning', signal }
    }
    if (hit === null && (field === 'text' || field === 'both')) {
      const signal = detectLoop(text, thresholds)
      if (signal.detected) hit = { field: 'text', signal }
    }
    // 目标会话本身没循环，但本 tick 刚处理过子代理循环 → 到此为止：继续往下会撞上
    // stall 分支，对刚被中断子代理的主会话再 steer 催办，只会把它推向下一轮循环。
    if (hit === null) return subagentHandled

    const now = Date.now()
    const signature = hit.field + '|' + String(hit.signal.period) + '|' + hit.signal.unit
    const prev = entry.loop.fields[hit.field]
    const state: LoopFieldState = prev ?? { signature: '', hits: 0, lastFiredAt: null, lastSignal: null }
    state.hits = prev !== undefined && prev.signature === signature ? prev.hits + 1 : 1
    state.signature = signature
    state.lastSignal = hit.signal
    entry.loop.fields[hit.field] = state

    const minHits = loopMinHitsOf(config)
    const reason = 'chain-of-thought loop: field=' + hit.field + ' period=' + String(hit.signal.period)
      + ' repeats=' + String(hit.signal.repeats) + ' confidence=' + hit.signal.confidence.toFixed(2)
      + (hit.signal.unit === '' ? '' : ' unit=' + JSON.stringify(hit.signal.unit.slice(0, 60)))
    this.log(entry, 'LOOP-HIT field=' + hit.field + ' period=' + String(hit.signal.period)
      + ' repeats=' + String(hit.signal.repeats) + ' confidence=' + hit.signal.confidence.toFixed(2)
      + ' hits=' + String(state.hits) + '/' + String(minHits))
    if (state.hits < minHits) return false

    const cooldown = loopCooldownOf(config)
    if (state.lastFiredAt !== null && now - state.lastFiredAt < cooldown) {
      this.log(entry, 'LOOP-HIT suppressed by cooldown (' + String(now - state.lastFiredAt) + 'ms < ' + String(cooldown) + 'ms)')
      return false
    }
    state.lastFiredAt = now
    state.hits = 0

    // 子代理会话（用户显式监控了某个子代理）：只中断、不转移——把它提升成一个新的
    // 顶层会话会破坏原执行树（父会话等的是这个子代理的结果，不是另一个新会话）。
    if (isRootAgent(this.ctx, config.sessionId) === false) {
      this.loopCancel(entry, reason + ' [subagent session → no transfer]')
      this.notifyParent(entry, agent, config.sessionId, reason)
      return true
    }

    const depth = clampInt(config.loopTransferDepth, 0, 0, 1000)
    const maxTransfers = loopMaxTransfersOf(config)
    if (config.loopTransfer === false) {
      this.loopCancel(entry, reason + ' [transfer disabled]')
      return true
    }
    if (entry.loop.transfers.length >= maxTransfers || depth >= maxTransfers) {
      this.loopCancel(entry, reason + ' [transfer budget exhausted: ' + String(entry.loop.transfers.length) + '/' + String(maxTransfers)
        + ', depth ' + String(depth) + ']')
      return true
    }
    return await this.transferToNewSession(entry, agent, reason, hit.signal, depth)
  }

  /**
   * 把任务转移到新会话：**先建新会话**（带交接提示），确认成功后再中断原会话——
   * 反过来的话，创建失败就变成"任务被中断、且没有任何接续"，那是丢任务。
   * 任一步失败都保持原监控，并按 interval 节流重试。
   */
  private async transferToNewSession(
    entry: MonitorEntryState,
    agent: LiveAgentLike,
    reason: string,
    signal: LoopSignal,
    depth: number,
  ): Promise<boolean> {
    const config = entry.config
    const oldId = config.sessionId
    const now = Date.now()
    const retryMs = Math.max(config.intervalMs, 10_000)
    if (entry.loop.lastAttemptAt !== null && now - entry.loop.lastAttemptAt < retryMs) return false
    entry.loop.lastAttemptAt = now

    // 子代理处置：report（默认）只登记进交接；stop 先终止仍在运行的子代理；ignore 完全不看。
    const descendants = config.loopDescendants === 'ignore' ? [] : collectDescendants(this.ctx, agent)
    const stopped: string[] = []
    if (config.loopDescendants === 'stop') {
      for (const child of descendants) {
        if (!child.running) continue
        if (cancelLiveSession(this.ctx, child.id, false, 'loop transfer: stop descendant')) {
          stopped.push(child.id)
          this.log(entry, 'LOOP-SUBAGENT-CANCEL id=' + child.id + ' reason=transfer-stop')
        }
      }
    }

    const context = extractTaskContext(sessionEvents(agent.session))
    const handoff = buildHandoffPrompt({
      sessionId: oldId,
      cwd: agent.session.header.cwd ?? '',
      reason,
      context,
      descendants,
      stopped,
      ...(config.loopHandoffPrompt === undefined ? {} : { template: config.loopHandoffPrompt }),
    })

    let created: CreatedBridgeSession
    try {
      created = await createBridgeSession(this.ctx, this.registry, {
        caller: { ctx: agent.ctx, session: agent.session as unknown as BridgeSessionCaller['session'] },
        callerCwd: agent.session.header.cwd,
        title: (config.label ?? 'session') + ' (loop-transfer)',
        prompt: handoff,
      })
    } catch (error) {
      entry.lastNote = '循环转移失败（保持原监控）: ' + String(error)
      this.log(entry, 'LOOP-TRANSFER-FAILED from=' + oldId + ' error=' + String(error))
      // 返回 true = 本 tick 已处理：失败后若继续往下走会撞上 stall 分支，对一个正在
      // 循环的会话再 steer 催办只会把它推得更深；下一个 tick 再按节流重试转移。
      return true
    }

    entry.loop.transfers.push({
      at: now,
      from: oldId,
      to: created.sessionId,
      reason,
      period: signal.period,
      repeats: signal.repeats,
      confidence: signal.confidence,
      depth,
      descendants: descendants.map((item) => ({
        id: item.id,
        status: item.status,
        ...(item.task === undefined ? {} : { task: item.task }),
      })),
      stopped,
    })
    this.log(entry, 'LOOP-TRANSFER from=' + oldId + ' to=' + created.sessionId + ' depth=' + String(depth)
      + ' descendants=' + String(descendants.length) + ' stopped=' + String(stopped.length))
    this.stderr('[dsh-session-bridge] monitor loop-transfer ' + oldId + ' → ' + created.sessionId)

    // 新会话已经带着交接提示跑起来了，此时中断原会话不会丢任务。
    cancelLiveSession(this.ctx, oldId, false, 'chain-of-thought loop detected')
    entry.lastAction = 'loop-transfer'
    entry.lastActionAt = Date.now()
    entry.lastNote = '思维链循环，已转移到新会话 ' + created.sessionId

    if (config.loopAutoMonitor !== false) {
      const next = this.start({
        ...config,
        sessionId: created.sessionId,
        label: (config.label ?? 'session') + ' (loop-transfer)',
        loopTransferDepth: depth + 1,
      })
      // 转移链延续：新条目继承同一份转移记录与计数。不继承的话，转移预算会随新条目
      // 重置，一个「转移后又循环」的任务可以无限接力下去。
      next.loop.transfers = entry.loop.transfers
      next.loop.subagentCancels = entry.loop.subagentCancels
    }
    this.entries.delete(oldId)
    if (this.entries.size === 0) this.disposeTimer()
    return true
  }

  /**
   * 照看目标会话派生的子代理：某个子代理的思维链陷入循环时，终止**那个子代理**，
   * 并 steer 主会话告知需要重派。
   *
   * 刻意不在这里做转移：子代理被终止不会打断主会话的执行树，而"子代理也各开一个新
   * 会话接续"会与主会话的转移叠加，导致重复劳动与递归级联（每个新会话又派生新子代理）。
   * 默认只查思维链（子代理的产出通常就是它的推理）。
   */
  private evaluateSubagentLoops(entry: MonitorEntryState, agent: LiveAgentLike): boolean {
    const descendants = collectDescendants(this.ctx, agent)
    if (descendants.length === 0) return false
    let handled = false
    const config = entry.config
    const thresholds = loopThresholds(config)
    const minHits = loopMinHitsOf(config)
    const cooldown = loopCooldownOf(config)
    const now = Date.now()
    for (const child of descendants) {
      if (!child.running) continue
      const childAgent = getLiveAgent(this.ctx, child.id)
      if (childAgent === undefined) continue
      const snapshot = statusSnapshot(this.ctx, childAgent)
      const reasoning = (snapshot.liveReasoning ?? '') !== '' ? (snapshot.liveReasoning ?? '') : (snapshot.lastReasoning ?? '')
      const signal = detectLoop(reasoning, thresholds)
      if (!signal.detected) continue
      const key = 'subagent:' + child.id
      const signature = String(signal.period) + '|' + signal.unit
      const prev = entry.loop.fields[key]
      const state: LoopFieldState = prev ?? { signature: '', hits: 0, lastFiredAt: null, lastSignal: null }
      state.hits = prev !== undefined && prev.signature === signature ? prev.hits + 1 : 1
      state.signature = signature
      state.lastSignal = signal
      entry.loop.fields[key] = state
      if (state.hits < minHits) continue
      if (state.lastFiredAt !== null && now - state.lastFiredAt < cooldown) continue
      state.lastFiredAt = now
      state.hits = 0
      if (!cancelLiveSession(this.ctx, child.id, false, 'chain-of-thought loop (subagent)')) continue
      entry.loop.subagentCancels += 1
      entry.lastAction = 'loop-subagent-cancel'
      entry.lastActionAt = now
      entry.lastNote = '子代理 ' + child.id + ' 思维链循环，已终止并通知主会话重派'
      this.log(entry, 'LOOP-SUBAGENT-CANCEL id=' + child.id + ' period=' + String(signal.period)
        + ' repeats=' + String(signal.repeats) + ' confidence=' + signal.confidence.toFixed(2))
      sendLiveMessage(this.ctx, config.sessionId,
        '你的子代理 ' + child.id + ' 的思维链陷入循环（period=' + String(signal.period) + ' repeats=' + String(signal.repeats)
        + '），已被终止。请按原分工重新派生它，或自己完成那部分工作。', 'steer')
      handled = true
    }
    return handled
  }

  /** 循环触发但无法/不该转移时：只中断原会话。 */
  private loopCancel(entry: MonitorEntryState, reason: string): void {
    cancelLiveSession(this.ctx, entry.config.sessionId, false, reason)
    entry.lastAction = 'loop-cancel'
    entry.lastActionAt = Date.now()
    entry.lastNote = '思维链循环，已中断: ' + reason
    this.log(entry, 'LOOP-CANCEL session=' + entry.config.sessionId + ' reason=' + reason)
  }

  /** 子代理会话自身循环被中断后，通知它的父会话（若父仍在 live）。 */
  private notifyParent(entry: MonitorEntryState, agent: LiveAgentLike, childId: string, reason: string): void {
    const parentId = (agent.session.header as { parentSession?: string }).parentSession
    if (parentId === undefined || parentId === '') return
    const sent = sendLiveMessage(this.ctx, parentId,
      '你的子代理 ' + childId + ' 的思维链陷入循环（' + reason + '），已被终止。请按原分工重新派生它，或自己完成那部分工作。', 'steer')
    if (sent) this.log(entry, 'LOOP-SUBAGENT-NOTIFY parent=' + parentId + ' child=' + childId)
  }

  private hasLlm(): boolean {
    const ctx = this.ctx as unknown as { llm?: LlmService }
    return ctx.llm !== undefined
  }

  /** LLM 判定当前状态：'stuck' | 'offtrack' | 'steady'。失败回落 'steady'。 */
  private async judgeOffTrack(entry: MonitorEntryState, snapshot: BridgeStatusSnapshot, route: { provider?: string; model?: string }): Promise<'stuck' | 'offtrack' | 'steady'> {
    const ctx = this.ctx as unknown as { llm?: LlmService }
    if (ctx.llm === undefined) return 'steady'
    // 用主任务 agent 自身的模型路由（若无则无法发起 LLM 判定，回落规则）。
    const provider = route.provider
    const model = route.model
    if (provider === undefined || model === undefined) return 'steady'
    const recentText = snapshot.recent.map((r) => (r.role === 'user' ? '[user]' : '[assistant]') + ' ' + (r.text ?? r.reasoning ?? '')).join('\n').slice(-1200)
    try {
      let text = ''
      const stream = ctx.llm.stream({
        provider,
        model,
        system: '你是任务监控 agent。给定一个主任务会话的最新消息流，判定它当前处于哪种状态，只输出一个词：stuck（很久无实质进展）/ offtrack（明显偏离原始目标）/ steady（正常推进）。',
        messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: recentText }] })],
        temperature: 0,
        reasoningEffort: ReasoningEffortId('off'),
        maxTokens: 40,
      })
      for await (const chunk of stream) {
        if (chunk.type === 'text-delta') text += chunk.text
      }
      const verdict = text.trim().toLowerCase()
      if (verdict.startsWith('stuck')) return 'stuck'
      if (verdict.startsWith('offtrack')) return 'offtrack'
      return 'steady'
    } catch {
      return 'steady'
    }
  }

  private stopWithLog(sessionId: string): void {
    this.stderr('[dsh-session-bridge] monitor session=' + sessionId + ' marked done')
    this.entries.delete(sessionId)
    if (this.entries.size === 0) this.disposeTimer()
  }

  private log(entry: MonitorEntryState, msg: string): void {
    try {
      mkdirSync(dirname(this.logFile), { recursive: true })
      appendFileSync(this.logFile, `[${new Date().toISOString()}] session=${entry.config.sessionId} lastReply=${entry.config.label ?? ''} ${msg}\n`)
    } catch { /* 日志失败静默 */ }
  }

  private stderr(msg: string): void {
    try {
      console.warn(msg)
    } catch { /* noop */ }
  }
}
