/**
 * dsh-session-bridge loop guard: 思维链循环检测（纯函数，无宿主依赖）。
 *
 * 用途：守护循环（monitor.ts）用它判定目标会话的实时思维链/流式文本是否陷入
 * "序列循环"——同一段内容被反复输出（例：写。/ 好。/ Go。 三个单位各重复三次）。
 * 这类循环**不会**被卡住判定抓到：每步都有新事件落地，`isStalled` 永远为 false；
 * 也不是 `coRules` 那种子串匹配能表达的（它需要"序列重复"语义）。
 *
 * 两条互补通路，取置信度较高者：
 * 1. 句子级尾部周期检测：把文本切成单位（句子/行），找最小的周期 p，要求末尾
 *    k 个周期逐段完全相等（k 同时满足 minCycles 与 minRepeats）。
 * 2. 字符 n-gram 重复率：无标点/无换行的连续重复（例如同一 40 字符片段刷屏）
 *    在单位切分下可能退化成一个单位，用 n-gram 重复率兜底。
 *
 * 切分刻意**保留句末标点**（"写。" ≠ "好。"）：若把标点剥掉，短循环单位会变成
 * 相同或空字符串，周期结构被抹平，检测直接失效。
 *
 * 纯读、无副作用；输入非法（非字符串/空）一律安全返回"未命中"。
 */

/** 参与检测的尾部窗口（字符）：只看最近的思维链，避免长历史稀释周期结构。 */
export const TAIL_WINDOW = 1200

/** 重复单位在信号里的展示上限（字符）。 */
export const UNIT_PREVIEW = 120

/** 周期搜索上限（单位数）；超过该长度的"周期"已不像循环。 */
export const MAX_PERIOD = 8

/** 循环检测配置（全部可选，缺省见 LOOP_DEFAULTS）。 */
export interface LoopGuardConfig {
  /** 最小周期数（默认 2）。 */
  minCycles?: number
  /** 最小重复次数（默认 3）。 */
  minRepeats?: number
  /** 置信度阈值（默认 0.6）。 */
  minConfidence?: number
  /** 字符 n-gram 的 n（默认 4）。 */
  charN?: number
  /** 字符级重复率阈值（默认 0.5）。 */
  charRepeatRate?: number
  /** 启用字符级检测所需的最小 token 数（默认 120）。 */
  charMinTokens?: number
}

/** 一次循环检测的结果。 */
export interface LoopSignal {
  /** 是否判定为循环（受 minConfidence / 各阈值约束）。 */
  detected: boolean
  /** 命中来源：句子级周期 / 字符 n-gram。 */
  kind: 'sentence' | 'char'
  /** 周期（句子数；char 模式为 n）。 */
  period: number
  /** 周期重复次数（char 模式为 n-gram 的平均出现次数）。 */
  repeats: number
  /** 置信度 0..1。 */
  confidence: number
  /** 重复单位（截断至 UNIT_PREVIEW 字符）。 */
  unit: string
  /** 参与检测的尾部文本长度（字符）。 */
  chars: number
}

/** 默认阈值：2 句×3 次 / 3 句×2 次起判；2 次重复太常见，不触发。 */
export const LOOP_DEFAULTS = {
  minCycles: 2,
  minRepeats: 3,
  minConfidence: 0.6,
  charN: 4,
  charRepeatRate: 0.5,
  charMinTokens: 120,
} as const

/**
 * 把文本切成检测单位：在换行与句末标点**之后**切分，标点保留在单位内。
 * 每段折叠空白并 trim，空段丢弃。
 */
export function splitUnits(text: string): string[] {
  if (typeof text !== 'string' || text === '') return []
  const parts = text.split(/(?<=[。！？；!?;\n])/)
  const units: string[] = []
  for (const raw of parts) {
    const unit = raw.replace(/\s+/g, ' ').trim()
    if (unit !== '') units.push(unit)
  }
  return units
}

/** 比较 units[from .. from+p-1] 与模板 units[ref .. ref+p-1] 是否逐段相等。 */
function sameRun(units: readonly string[], from: number, ref: number, p: number): boolean {
  for (let j = 0; j < p; j += 1) if (units[from + j] !== units[ref + j]) return false
  return true
}

/**
 * 在单位序列**尾部**找最小周期：以最后 p 个单位为模板，从尾部向前数连续相等的
 * 周期数 k（而不是 `floor(n/p)`）。这一点很关键——长思维链里"前面几百句正常、
 * 最后三轮开始循环"是最常见的情形，用 `floor(n/p)` 会把检测范围拉到前缀噪声上，
 * 反而漏报。p 从 1 递增，因此返回的是**最小**周期。
 * 要求 k 同时满足 minCycles 与 minRepeats（有效门槛 = 两者较大者）。未找到返回 null。
 */
export function tailPeriodicRepeat(
  units: readonly string[],
  opts: { minCycles?: number; minRepeats?: number; maxPeriod?: number } = {},
): { period: number; repeats: number; covered: number; unit: string } | null {
  const minCycles = opts.minCycles ?? LOOP_DEFAULTS.minCycles
  const minRepeats = opts.minRepeats ?? LOOP_DEFAULTS.minRepeats
  const maxPeriod = opts.maxPeriod ?? MAX_PERIOD
  const floor = Math.max(minCycles, minRepeats)
  const n = Array.isArray(units) ? units.length : 0
  // 至少要能放下 floor 个周期，否则这个 p 不可能达标。
  const limit = Math.min(maxPeriod, Math.floor(n / floor))
  for (let p = 1; p <= limit; p += 1) {
    let k = 1
    while ((k + 1) * p <= n && sameRun(units, n - (k + 1) * p, n - p, p)) k += 1
    if (k < floor) continue
    const start = n - k * p
    return { period: p, repeats: k, covered: k * p, unit: units.slice(start, start + p).join('') }
  }
  return null
}

/**
 * 字符 n-gram 重复率（空白先剥离）：`repeated` 为"重复出现的 token 数"
 * （每个 token 的出现次数减一之和），`rate = repeated / tokens`。
 */
export function charRepeatRate(text: string, n: number): { tokens: number; repeated: number; rate: number; top: string } {
  const size = Number.isInteger(n) && n >= 2 ? n : LOOP_DEFAULTS.charN
  const compact = typeof text === 'string' ? text.replace(/\s+/g, '') : ''
  if (compact.length < size) return { tokens: 0, repeated: 0, rate: 0, top: '' }
  const counts = new Map<string, number>()
  let tokens = 0
  for (let i = 0; i + size <= compact.length; i += 1) {
    const gram = compact.slice(i, i + size)
    counts.set(gram, (counts.get(gram) ?? 0) + 1)
    tokens += 1
  }
  let repeated = 0
  let top = ''
  let topCount = 0
  for (const [gram, count] of counts) {
    if (count > 1) repeated += count - 1
    if (count > topCount) { topCount = count; top = gram }
  }
  return { tokens, repeated, rate: tokens === 0 ? 0 : repeated / tokens, top }
}

/**
 * 句子级置信度：重复次数（权重 0.5）+ 单位长度（0.3）+ 循环段字符量（0.2）。
 * 刻意**不**用 covered/units.length：那会让"前面 100 句正常、最后 3 轮循环"这种
 * 最需要抓的情形反被判为低置信度（前缀越长越不触发，方向正好反了）。
 */
function sentenceConfidence(repeats: number, covered: number, unitLength: number): number {
  const repeatTerm = Math.min(1, repeats / 3)
  const lengthTerm = Math.min(1, unitLength / 6)
  const coverTerm = Math.min(1, (unitLength * covered) / 16)
  return Math.min(1, 0.5 * repeatTerm + 0.3 * lengthTerm + 0.2 * coverTerm)
}

function preview(text: string): string {
  return text.length > UNIT_PREVIEW ? text.slice(0, UNIT_PREVIEW) + '…' : text
}

function missSignal(chars: number): LoopSignal {
  return { detected: false, kind: 'sentence', period: 0, repeats: 0, confidence: 0, unit: '', chars }
}

/**
 * 检测一段文本是否陷入循环。先试句子级周期（更精确、可解释），未达阈值时再用
 * 字符 n-gram 兜底；两者都不满足返回 detected:false 的信号（仍带最接近的量化值）。
 */
export function detectLoop(text: string, config: LoopGuardConfig = {}): LoopSignal {
  const minCycles = config.minCycles ?? LOOP_DEFAULTS.minCycles
  const minRepeats = config.minRepeats ?? LOOP_DEFAULTS.minRepeats
  const minConfidence = config.minConfidence ?? LOOP_DEFAULTS.minConfidence
  const charN = config.charN ?? LOOP_DEFAULTS.charN
  const charRate = config.charRepeatRate ?? LOOP_DEFAULTS.charRepeatRate
  const charMinTokens = config.charMinTokens ?? LOOP_DEFAULTS.charMinTokens

  const source = typeof text === 'string' ? text : ''
  const tail = source.length > TAIL_WINDOW ? source.slice(-TAIL_WINDOW) : source
  const units = splitUnits(tail)
  const periodic = tailPeriodicRepeat(units, { minCycles, minRepeats })

  let sentence: LoopSignal = missSignal(tail.length)
  if (periodic !== null) {
    const confidence = sentenceConfidence(periodic.repeats, periodic.covered, periodic.unit.length)
    sentence = {
      detected: confidence >= minConfidence,
      kind: 'sentence',
      period: periodic.period,
      repeats: periodic.repeats,
      confidence,
      unit: preview(periodic.unit),
      chars: tail.length,
    }
    if (sentence.detected) return sentence
  }

  const stats = charRepeatRate(tail, charN)
  if (stats.tokens >= charMinTokens) {
    const unique = Math.max(1, stats.tokens - stats.repeated)
    const charSignal: LoopSignal = {
      detected: stats.rate >= charRate,
      kind: 'char',
      period: charN,
      repeats: Math.round(stats.tokens / unique),
      confidence: stats.rate,
      unit: preview(stats.top),
      chars: tail.length,
    }
    if (charSignal.detected || charSignal.confidence > sentence.confidence) return charSignal
  }

  return sentence
}
