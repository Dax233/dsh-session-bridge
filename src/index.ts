/**
 * dsh-session-bridge host half: 注册会话桥工具
 * (create / send / resume / wait / read / find / status / cancel / monitor_* )，
 * 让当前 agent 能通过提示词创建主会话、向任意会话发消息、等待 / 读取回复、
 * 跨工作区查找会话，以及作为"监控 worker"对主任务会话做后台守护 —
 * 轮询进度、卡住则 steer 催办/纠偏、卡住过久则 cancel 终止、完成即收尾。
 * 监控守护循环是插件自身的组件（见 monitor.ts），非独立插件。
 */
import type { Context } from '@deepseek-ai/cordis'
import { BridgeRegistry } from './registry.ts'
import { SessionMonitor } from './monitor.ts'
import { registerBridgeTools, type BridgeEnv } from './tools.ts'
import { Config, createLoopPolicy } from './config.ts'
import { createConfigWriter, registerLoopCommands } from './commands.ts'

/** 插件配置：思维链循环自动中断的开关与全局默认值（设置页表单与 /cot-loop 共用同一份）。 */
export { Config }

/** Plugin identity for cordis rows. */
export const name = 'dsh-session-bridge'

/** Services required before mounting. */
export const inject = ['sessions', 'agents', 'sessionPersistence', 'workspaceRegistry', 'agentPresets', 'tools', 'timer']

/** Host plugin body. */
export function apply(ctx: Context, config?: unknown): void {
  const registry = new BridgeRegistry()
  void registry.load().catch((error: unknown) => {
    console.warn('[dsh-session-bridge] registry load failed:', error instanceof Error ? error.message : String(error))
  })
  // 循环策略：总开关与全局默认值都从 Config 的 volatile 引用实时读取，
  // 所以设置页/命令改开关后，运行中的守护下一个 tick 就按新值走（无需重启或重载）。
  const policy = createLoopPolicy(config)
  // 监控循环会把任务转移到新会话，需要 registry 做桥侧登记（与工具共用同一条创建路径）。
  const monitor = new SessionMonitor(ctx, registry, undefined, policy)
  const env: BridgeEnv = { ctx, registry, monitor, policy }
  registerBridgeTools(env)
  // 斜杠命令 /cot-loop：与设置页共用同一份配置；commands 服务缺失时静默跳过。
  registerLoopCommands(ctx, { policy, writeConfig: createConfigWriter(ctx) })
  ctx.effect(() => () => monitor.dispose())
}
