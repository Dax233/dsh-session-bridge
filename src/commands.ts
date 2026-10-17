/**
 * 斜杠命令 `/cot-loop`：在交互式 UI（Web / CLI）里直接开关「思维链循环自动中断」。
 *
 * 与设置页的表单**共用同一份配置**（profile patch 里本插件 entry 的 config）：
 *  - 优先用 `configEditor.edit()` 写回配置 → 持久化，Loader 走 volatile-only 提交，立即生效；
 *  - 宿主没有 configEditor（或写失败）时退化成本进程内存覆盖，并明确告知"仅本次运行有效"。
 *
 * 命令面是**可选**的：`commands` 服务不存在时静默跳过（旧 harness 上插件照常工作，
 * 也不引入新的 peer 依赖——两个服务都用运行时注入探测）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { LOOP_DESCENDANTS_VALUES, LOOP_FIELD_VALUES, type LoopPolicy } from './config.ts'

/** 本插件在 profile patch 里的 entry id（设置页表单、命令写回都按它定位）。 */
export const ENTRY_ID = 'dsh-session-bridge'
/** 命令名（小写，注册到 `ctx.commands`）。 */
export const COMMAND_NAME = 'cot-loop'

/** 命令返回值（dsh-commands 的契约：success 的 text 可省，error 的 text 必须非空）。 */
export interface CommandResult {
  kind: 'success' | 'error'
  text: string
}

/** 写回插件配置的结果。 */
export interface WriteResult {
  ok: boolean
  message: string
}

export interface LoopCommandDeps {
  /** 插件级循环策略（实时读总开关与默认值）。 */
  policy: LoopPolicy
  /** 把若干配置字段写回 profile patch；宿主无 configEditor 时返回 ok=false。 */
  writeConfig(patch: Record<string, unknown>): Promise<WriteResult>
}

interface CommandService {
  register(command: {
    name: string
    description: string
    input?: { hint?: string }
    handler: (payload: { rawInput?: string }) => Promise<CommandResult> | CommandResult
  }): unknown
}

interface ConfigEditorLike {
  entries(): Array<{ options?: { id?: string; name?: string } }>
  edit(
    entry: unknown,
    change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<unknown>
}

/** 通过 cordis 的可选注入拿一个服务；服务不存在时回调不执行（不抛错、不阻塞插件）。 */
function injectService(ctx: Context, names: string[], callback: (child: unknown) => void): void {
  const candidate = ctx as unknown as { inject?: (names: string[], cb: (child: unknown) => void) => unknown }
  if (typeof candidate.inject !== 'function') return
  try {
    candidate.inject(names, callback)
  } catch {
    // 注入失败（旧宿主/服务缺失）不该影响插件其余部分。
  }
}

/**
 * 构造"写回插件配置"的函数：定位本插件的 profile entry，把 patch 合并进它的 config。
 * 拿不到 configEditor 时返回 ok=false，调用方退化到内存开关。
 */
export function createConfigWriter(ctx: Context): (patch: Record<string, unknown>) => Promise<WriteResult> {
  let editor: ConfigEditorLike | undefined
  injectService(ctx, ['configEditor'], (child) => {
    const candidate = (child as { configEditor?: ConfigEditorLike }).configEditor
    if (candidate !== undefined && typeof candidate.edit === 'function' && typeof candidate.entries === 'function') {
      editor = candidate
    }
  })
  return async (patch: Record<string, unknown>): Promise<WriteResult> => {
    if (editor === undefined) {
      return { ok: false, message: '当前宿主没有 configEditor 服务' }
    }
    let entry: { options?: { id?: string; name?: string } } | undefined
    try {
      entry = editor.entries().find((row) => row?.options?.id === ENTRY_ID || row?.options?.name === ENTRY_ID)
    } catch (error) {
      return { ok: false, message: '读取 profile entry 失败：' + messageOf(error) }
    }
    if (entry === undefined) {
      return { ok: false, message: 'profile 里找不到 entry「' + ENTRY_ID + '」' }
    }
    try {
      await editor.edit(entry, (current) => ({ ...(current ?? {}), ...patch }))
    } catch (error) {
      return { ok: false, message: '写入配置失败：' + messageOf(error) }
    }
    return { ok: true, message: '已写入 profile patch：' + Object.keys(patch).join(', ') }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function clampNumber(raw: string, fallback: number, min: number, max: number, integer: boolean): number | undefined {
  const value = Number(raw)
  if (!Number.isFinite(value)) return undefined
  const clamped = Math.min(max, Math.max(min, value))
  return integer ? Math.round(clamped) : clamped
}

/** 状态摘要（命令无参数或 `status` 时输出）。 */
export function loopCommandStatus(deps: LoopCommandDeps): string {
  const defaults = deps.policy.defaults()
  const override = deps.policy.override()
  const source = override === undefined ? '插件配置' : '内存覆盖（本次运行）'
  return [
    '思维链循环自动中断：' + (deps.policy.enabled() ? '开启' : '关闭') + '（来源：' + source + '）',
    '检测参数：field=' + defaults.field + ' ' + String(defaults.minCycles) + 'x' + String(defaults.minRepeats)
      + ' hits=' + String(defaults.minHits) + ' confidence=' + defaults.minConfidence.toFixed(2)
      + ' cooldown=' + String(defaults.cooldownMs) + 'ms',
    '转移：maxTransfers=' + String(defaults.maxTransfers) + ' descendants=' + defaults.descendants,
    '设置页：设置 → Plugins → ' + ENTRY_ID + '（开关 loopGuard，与本命令同一份配置）',
    '用法：/cot-loop on | off | status | field <reasoning|text|both> | descendants <report|stop|ignore> | max-transfers <n> | help',
  ].join('\n')
}

const HELP_TEXT = [
  '/cot-loop on|off — 开关思维链循环自动中断（写回插件配置，立即生效）',
  '/cot-loop status — 显示当前开关与检测参数',
  '/cot-loop field reasoning|text|both — 循环检测看哪一段（默认 reasoning 思考阶段）',
  '/cot-loop descendants report|stop|ignore — 转移时如何处理子代理',
  '/cot-loop max-transfers <n> — 同一任务最多转移几次（0 = 只中断不转移）',
  '/cot-loop min-cycles <n> / min-repeats <n> / min-hits <n> — 检测门槛',
  '/cot-loop cooldown <ms> / confidence <0-1> — 冷却与置信度',
  '/cot-loop reset — 丢弃内存覆盖，回到插件配置的值',
  '参数类改动从下一个 monitor_start 起生效；开关（on/off）对已运行的守护立即生效。',
].join('\n')

async function applyPatch(
  deps: LoopCommandDeps,
  patch: Record<string, unknown>,
  label: string,
  live: boolean,
): Promise<CommandResult> {
  const written = await deps.writeConfig(patch)
  if (written.ok) {
    return { kind: 'success', text: label + '（已写入插件配置，' + (live ? '立即生效' : '下一个监控生效') + '）\n' + written.message }
  }
  return {
    kind: 'success',
    text: label + '（未能写入配置：' + written.message + '）\n'
      + (live ? '已改为本次运行的内存开关，重启后失效。' : '本次运行未改变（参数类改动需要写回配置）。'),
  }
}

/**
 * 解析并执行一条 `/cot-loop` 输入。
 * 纯函数形态（只依赖注入进来的 policy 与写回函数），便于直接单测。
 */
export async function runLoopCommand(rawInput: string, deps: LoopCommandDeps): Promise<CommandResult> {
  const parts = String(rawInput ?? '').trim().split(/\s+/).filter((part) => part !== '')
  const head = (parts[0] ?? 'status').toLowerCase()
  const arg = parts[1]
  switch (head) {
    case 'status':
      return { kind: 'success', text: loopCommandStatus(deps) }
    case 'help':
      return { kind: 'success', text: HELP_TEXT }
    case 'on':
    case 'off': {
      const enabled = head === 'on'
      const written = await deps.writeConfig({ loopGuard: enabled })
      if (written.ok) {
        deps.policy.setOverride(undefined)
        return { kind: 'success', text: '思维链循环自动中断已' + (enabled ? '开启' : '关闭') + '（已写入插件配置，立即生效）\n' + written.message }
      }
      deps.policy.setOverride(enabled)
      return {
        kind: 'success',
        text: '思维链循环自动中断已' + (enabled ? '开启' : '关闭') + '（本次运行的内存开关：' + written.message + '）\n'
          + '重启后失效；要持久化请在设置 → Plugins → ' + ENTRY_ID + ' 里改 loopGuard，或写进 profile 的 cordis.patch.yml。',
      }
    }
    case 'reset':
      deps.policy.setOverride(undefined)
      return { kind: 'success', text: '已丢弃内存覆盖，当前值来自插件配置：' + (deps.policy.enabled() ? '开启' : '关闭') }
    case 'field': {
      if (arg === undefined) return { kind: 'error', text: '用法：/cot-loop field <reasoning|text|both>' }
      const value = arg.toLowerCase()
      if (!(LOOP_FIELD_VALUES as readonly string[]).includes(value)) {
        return { kind: 'error', text: '未知字段「' + arg + '」，可选：' + LOOP_FIELD_VALUES.join(' / ') }
      }
      return applyPatch(deps, { loopField: value }, '检测字段已设为 ' + value, false)
    }
    case 'descendants': {
      if (arg === undefined) return { kind: 'error', text: '用法：/cot-loop descendants <report|stop|ignore>' }
      const value = arg.toLowerCase()
      if (!(LOOP_DESCENDANTS_VALUES as readonly string[]).includes(value)) {
        return { kind: 'error', text: '未知策略「' + arg + '」，可选：' + LOOP_DESCENDANTS_VALUES.join(' / ') }
      }
      return applyPatch(deps, { loopDescendants: value }, '子代理策略已设为 ' + value, false)
    }
    case 'max-transfers': {
      const value = arg === undefined ? undefined : clampNumber(arg, 0, 0, 64, true)
      if (value === undefined) return { kind: 'error', text: '用法：/cot-loop max-transfers <0-64>' }
      return applyPatch(deps, { loopMaxTransfers: value }, '最大转移次数已设为 ' + String(value), false)
    }
    case 'min-cycles': {
      const value = arg === undefined ? undefined : clampNumber(arg, 2, 1, 64, true)
      if (value === undefined) return { kind: 'error', text: '用法：/cot-loop min-cycles <1-64>' }
      return applyPatch(deps, { loopMinCycles: value }, '最小周期数已设为 ' + String(value), false)
    }
    case 'min-repeats': {
      const value = arg === undefined ? undefined : clampNumber(arg, 3, 2, 64, true)
      if (value === undefined) return { kind: 'error', text: '用法：/cot-loop min-repeats <2-64>' }
      return applyPatch(deps, { loopMinRepeats: value }, '最小重复次数已设为 ' + String(value), false)
    }
    case 'min-hits': {
      const value = arg === undefined ? undefined : clampNumber(arg, 1, 1, 64, true)
      if (value === undefined) return { kind: 'error', text: '用法：/cot-loop min-hits <1-64>' }
      return applyPatch(deps, { loopMinHits: value }, '触发前命中次数已设为 ' + String(value), false)
    }
    case 'cooldown': {
      const value = arg === undefined ? undefined : clampNumber(arg, 60_000, 0, 86_400_000, true)
      if (value === undefined) return { kind: 'error', text: '用法：/cot-loop cooldown <毫秒>' }
      return applyPatch(deps, { loopCooldownMs: value }, '冷却时间已设为 ' + String(value) + 'ms', false)
    }
    case 'confidence': {
      const value = arg === undefined ? undefined : clampNumber(arg, 0.6, 0, 1, false)
      if (value === undefined) return { kind: 'error', text: '用法：/cot-loop confidence <0-1>' }
      return applyPatch(deps, { loopMinConfidence: value }, '置信度阈值已设为 ' + value.toFixed(2), false)
    }
    default:
      return { kind: 'error', text: '未知子命令「' + head + '」。' + HELP_TEXT }
  }
}

/** 把 `/cot-loop` 注册进宿主命令面；没有 commands 服务时静默跳过。 */
export function registerLoopCommands(ctx: Context, deps: LoopCommandDeps): void {
  injectService(ctx, ['commands'], (child) => {
    const service = (child as { commands?: CommandService }).commands
    if (service === undefined || typeof service.register !== 'function') return
    service.register({
      name: COMMAND_NAME,
      description: '思维链循环自动中断：开关、状态与调参（与设置页共用同一份配置）',
      input: {
        hint: 'on | off | status | field <reasoning|text|both> | descendants <report|stop|ignore> | max-transfers <n> | help',
      },
      handler: (payload) => runLoopCommand(String(payload?.rawInput ?? ''), deps),
    })
  })
}
