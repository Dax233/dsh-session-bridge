#!/usr/bin/env node
/**
 * Regression tests for the handoff prompt (src/handoff.ts).
 *
 * The handoff is what the successor session actually reads, so two properties
 * matter and both are asserted here:
 *  1. It must carry enough to start working (task, recent instructions, last
 *     reply, last chain-of-thought) AND the original session id, because the
 *     successor is told to read the old log itself rather than trust a summary.
 *  2. Subagents must be split by state — still running (do NOT redo), halted by
 *     the loop (re-delegate), already finished (read the result) — and an empty
 *     category must leave no dangling section.
 *
 * Pure-function tests: no host, no build (Node type stripping).
 */
import assert from 'node:assert/strict'
import { buildHandoffPrompt, extractTaskContext, HANDOFF_DESCENDANT_LIMIT } from '../src/handoff.ts'

let passed = 0
let failed = 0

async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log('PASS ' + name)
  } catch (error) {
    failed += 1
    console.error('FAIL ' + name)
    console.error('     ' + (error instanceof Error ? error.message : String(error)))
  }
}

const turnStart = (seq) => ({ seq, time: Date.now(), type: 'turn/start', data: { turn: 1 } })
const userMsg = (seq, text) => ({ seq, time: Date.now(), type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })
const assistantText = (seq, text) => ({ seq, time: Date.now(), type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text }] } } })
const assistantReasoning = (seq, reasoning, text = 'ok') => ({
  seq, time: Date.now(), type: 'assistant/message',
  data: { turn: 1, step: 1, message: { content: [{ type: 'reasoning', text: reasoning }, { type: 'text', text }] } },
})
/** An in-flight stream: reasoning lives in data.stream, NOT in a finalized content block. */
const assistantStreaming = (seq, reasoning) => ({
  seq, time: Date.now(), type: 'assistant/message',
  data: { turn: 1, step: 1, stream: [{ type: 'chunk', chunk: { type: 'reasoning-delta', text: reasoning } }], message: { content: [{ type: 'text', text: 'partial' }] } },
})

// --- task context -------------------------------------------------------------
await test('extractTaskContext: task, recent instructions, last reply and reasoning', () => {
  const events = [
    turnStart(0),
    userMsg(1, '实现 X 功能'),
    userMsg(2, '顺带补测试'),
    assistantReasoning(3, '先看现有实现。', '正在做'),
    userMsg(4, '别忘了更新文档'),
  ]
  const context = extractTaskContext(events)
  assert.equal(context.task, '实现 X 功能', 'first user message is the task')
  assert.deepEqual(context.recentUser, ['实现 X 功能', '顺带补测试', '别忘了更新文档'])
  assert.equal(context.lastAssistant, '正在做')
  assert.equal(context.lastReasoning, '先看现有实现。')
})

await test('extractTaskContext: falls back to the in-flight reasoning stream', () => {
  const context = extractTaskContext([turnStart(0), userMsg(1, 'task'), assistantStreaming(2, '写。好。Go。')])
  assert.equal(context.lastReasoning, '写。好。Go。', 'live reasoning-delta used when nothing is finalized')
})

await test('extractTaskContext: recent instructions are capped and long text clipped', () => {
  const events = [userMsg(1, 'a'), userMsg(2, 'b'), userMsg(3, 'c'), userMsg(4, 'd'), userMsg(5, 'e')]
  const context = extractTaskContext(events)
  assert.deepEqual(context.recentUser, ['c', 'd', 'e'], 'last 3 by default')
  assert.equal(context.task, 'a')
  const long = extractTaskContext([userMsg(1, 'x'.repeat(3000))], { taskLimit: 100 })
  assert.equal(long.task.length, 101, 'clipped to limit + ellipsis')
  assert.ok(long.task.endsWith('…'))
})

await test('extractTaskContext: empty log is safe', () => {
  const context = extractTaskContext([])
  assert.equal(context.task, undefined)
  assert.deepEqual(context.recentUser, [])
  assert.equal(context.lastAssistant, undefined)
  assert.equal(context.lastReasoning, undefined)
})

// --- handoff prompt -----------------------------------------------------------
const baseInput = {
  sessionId: 'sb-old',
  cwd: 'D:/work',
  reason: 'chain-of-thought loop: period=3 repeats=3 confidence=1.00',
  context: { task: '实现 X 功能', recentUser: ['实现 X 功能'], lastAssistant: '正在做', lastReasoning: '写。好。Go。' },
}

await test('buildHandoffPrompt: substitutes every placeholder', () => {
  const prompt = buildHandoffPrompt(baseInput)
  assert.ok(prompt.includes('sb-old'), 'original session id')
  assert.ok(prompt.includes('D:/work'), 'cwd')
  assert.ok(prompt.includes('period=3 repeats=3'), 'reason')
  assert.ok(prompt.includes('实现 X 功能'), 'task')
  assert.ok(prompt.includes('正在做'), 'last reply in the evidence block')
  assert.ok(prompt.includes('写。好。Go。'), 'last chain-of-thought in the evidence block')
  assert.ok(prompt.includes('session_bridge_read(sessionId="sb-old")'), 'instructs reading the old log')
  assert.equal(prompt.includes('{{'), false, 'no placeholder left behind')
})

await test('buildHandoffPrompt: missing task gets an explicit fallback', () => {
  const prompt = buildHandoffPrompt({ ...baseInput, context: { recentUser: [] } })
  assert.ok(prompt.includes('(未能从原会话日志中解析出任务指令)'))
  assert.ok(prompt.includes('(无可用摘要)'))
})

await test('buildHandoffPrompt: no descendants leaves no dangling section', () => {
  const prompt = buildHandoffPrompt({ ...baseInput, descendants: [] })
  assert.equal(prompt.includes('子代理'), false)
})

await test('buildHandoffPrompt: descendants are split by state with distinct instructions', () => {
  const descendants = [
    { id: 'sub-run', status: 'running', running: true, delegationDepth: 1, task: '抓取数据' },
    { id: 'sub-loop', status: 'idle', running: false, task: '分析数据' },
    { id: 'sub-done', status: 'idle', running: false, task: '写报告' },
  ]
  const prompt = buildHandoffPrompt({ ...baseInput, descendants, stopped: ['sub-loop'] })
  assert.ok(prompt.includes('原会话仍在运行的子代理'), 'running section')
  assert.ok(prompt.includes('不要重做'), 'running section says do not redo')
  assert.ok(prompt.includes('已终止的子代理'), 'halted section')
  assert.ok(prompt.includes('已结束的子代理'), 'finished section')
  assert.ok(prompt.includes('sub-run (running, depth 1): 抓取数据'), 'running entry with depth and task')
  assert.ok(prompt.includes('sub-loop (idle)'), 'halted entry')
  assert.ok(prompt.includes('sub-done (idle)'), 'finished entry')
  // A stopped subagent must not also be advertised as still running.
  const runningSection = prompt.slice(prompt.indexOf('原会话仍在运行的子代理'), prompt.indexOf('已终止的子代理'))
  assert.equal(runningSection.includes('sub-loop'), false)
})

await test('buildHandoffPrompt: only the running section appears when others are empty', () => {
  const prompt = buildHandoffPrompt({ ...baseInput, descendants: [{ id: 'sub-run', status: 'running', running: true }] })
  assert.ok(prompt.includes('原会话仍在运行的子代理'))
  assert.equal(prompt.includes('已终止的子代理'), false)
  assert.equal(prompt.includes('已结束的子代理'), false)
})

await test('buildHandoffPrompt: overflowing descendant lists collapse into a count', () => {
  const descendants = Array.from({ length: HANDOFF_DESCENDANT_LIMIT + 3 }, (_, i) => ({ id: 'sub-' + String(i), status: 'running', running: true }))
  const prompt = buildHandoffPrompt({ ...baseInput, descendants })
  assert.ok(prompt.includes('sub-0'))
  assert.ok(prompt.includes('sub-' + String(HANDOFF_DESCENDANT_LIMIT - 1)))
  assert.equal(prompt.includes('sub-' + String(HANDOFF_DESCENDANT_LIMIT)), false, 'entries past the limit are collapsed')
  assert.ok(prompt.includes('另有 3 个未列出'))
})

await test('buildHandoffPrompt: a custom template is used verbatim', () => {
  const prompt = buildHandoffPrompt({ ...baseInput, template: 'resume {{task}} @ {{cwd}} (from {{sessionId}}) {{descendants}}' })
  assert.equal(prompt.startsWith('resume 实现 X 功能 @ D:/work (from sb-old)'), true)
})

console.log('')
console.log(String(passed) + ' passed, ' + String(failed) + ' failed')
if (failed > 0) process.exit(1)
