/**
 * Build for dsh-session-bridge with tsdown (rolldown): one self-contained
 * host ESM bundle (every non-node: dependency — including all
 * @deepseek-ai/dsh-* imports — is inlined), so the plugin loads from any
 * assembly path without runtime resolution.
 */
import type { UserConfig } from 'tsdown'

const hostBundle: UserConfig = {
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  sourcemap: true,
  clean: false,
  deps: {
    // schemastery 留在外部：宿主本来就装着它（官方插件都从宿主解析），而内联副本会
    // 被 rolldown 摇掉 Schema.prototype.volatile —— 那样 Config 的字段就丢了 volatile
    // 标记，设置页看不到这些开关（实测：内联时产物里 meta.volatile 直接消失）。
    neverBundle: ['@deepseek-ai/schemastery'],
    alwaysBundle: (id: string) => !id.startsWith('node:'),
  },
  outputOptions: { entryFileNames: 'index.js' },
}

export default [hostBundle] satisfies UserConfig[]
