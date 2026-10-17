#!/usr/bin/env node
/**
 * Regression tests for the chain-of-thought loop guard (src/loop-guard.ts).
 *
 * The guard's job: tell a *sequence* loop (写。好。Go。写。好。Go。写。好。Go。) apart from
 * an ordinary long chain of thought. Two facts drive the expectations here:
 *
 *  1. Punctuation is kept inside units, so "写。" and "好。" stay distinct — strip it
 *     and every unit collapses to "" (or the same string), erasing the period.
 *  2. The effective repeat floor is max(minCycles, minRepeats) = 3 by default, so
 *     "3 units x 2 rounds" must NOT fire while "2 units x 3 rounds" must.
 *
 * Pure-function tests: no host, no build, no DSH runtime (Node type stripping).
 */
import assert from 'node:assert/strict'
import {
  LOOP_DEFAULTS,
  charRepeatRate,
  detectLoop,
  splitUnits,
  tailPeriodicRepeat,
} from '../src/loop-guard.ts'

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

/** The exact shape from the report: three units, three rounds each. */
const reportedLoop = '写。\n好。\nGo。\n'.repeat(3)

// --- the reported case --------------------------------------------------------
await test('detectLoop: the reported 写。/好。/Go。 loop fires with period 3, repeats 3', () => {
  const signal = detectLoop(reportedLoop)
  assert.equal(signal.detected, true)
  assert.equal(signal.kind, 'sentence')
  assert.equal(signal.period, 3)
  assert.equal(signal.repeats, 3)
  assert.ok(signal.confidence >= LOOP_DEFAULTS.minConfidence, 'confidence ' + signal.confidence)
  assert.equal(signal.unit, '写。好。Go。')
})

await test('detectLoop: single-line variant of the same loop still fires', () => {
  const signal = detectLoop('写。好。Go。写。好。Go。写。好。Go。')
  assert.equal(signal.detected, true)
  assert.equal(signal.period, 3)
  assert.equal(signal.repeats, 3)
})

// --- threshold semantics ------------------------------------------------------
await test('detectLoop: 2 units x 3 rounds fires (period 2)', () => {
  const signal = detectLoop('甲。\n乙。\n'.repeat(3))
  assert.equal(signal.detected, true)
  assert.equal(signal.period, 2)
  assert.equal(signal.repeats, 3)
})

await test('detectLoop: 1 unit x 3 rounds fires (period 1)', () => {
  const signal = detectLoop('写。'.repeat(3))
  assert.equal(signal.detected, true)
  assert.equal(signal.period, 1)
  assert.equal(signal.repeats, 3)
})

await test('detectLoop: 3 units x 2 rounds does NOT fire (repeat floor is 3)', () => {
  // max(minCycles=2, minRepeats=3) = 3 — two rounds is ordinary prose, not a loop.
  const signal = detectLoop('写。\n好。\nGo。\n'.repeat(2))
  assert.equal(signal.detected, false)
})

await test('detectLoop: 2 units x 2 rounds does NOT fire', () => {
  assert.equal(detectLoop('甲。\n乙。\n'.repeat(2)).detected, false)
})

await test('detectLoop: a single repeated line twice does NOT fire', () => {
  assert.equal(detectLoop('同一行。\n同一行。\n').detected, false)
})

// --- false-positive guards ----------------------------------------------------
await test('detectLoop: ordinary long reasoning (every unit different) does NOT fire', () => {
  const text = [
    '先确认仓库里是否已有同类实现，避免重复造轮子。',
    '接着读取 monitor 的 tick 路径，确认卡住判定只看事件时间戳。',
    '然后设计一个纯函数的周期检测模块，便于单元测试覆盖。',
    '再把检测接到守护循环里，触发后创建新会话并注入交接提示。',
    '最后补上回归测试与产物级断言，确保构建产物也带新参数。',
    '收尾时更新中英文 README 与 CHANGELOG，并把版本号同步到两个 manifest。',
  ].join('\n')
  const signal = detectLoop(text)
  assert.equal(signal.detected, false)
  assert.ok(signal.confidence < LOOP_DEFAULTS.minConfidence, 'confidence ' + signal.confidence)
})

await test('detectLoop: empty / non-string input is safe', () => {
  for (const input of ['', undefined, null, 42]) {
    const signal = detectLoop(input)
    assert.equal(signal.detected, false)
    assert.equal(signal.chars, 0)
  }
})

await test('detectLoop: a long non-repeating prefix does not hide a tail loop', () => {
  // 回归：早先的实现用 floor(n/p) 取周期数，前缀一长就把比对范围拉到前缀噪声上，
  // 漏报"前面正常、最后三轮才开始循环"这种最常见的情形。尾部连续段必须独立命中。
  const prefix = Array.from(
    { length: 120 },
    (_, i) => '阶段' + i + '产出编号' + (i * 7919) + '校验位' + String.fromCharCode(0x4e00 + i) + '。',
  ).join('')
  const signal = detectLoop(prefix + reportedLoop)
  assert.equal(signal.detected, true)
  assert.equal(signal.kind, 'sentence')
  assert.equal(signal.period, 3)
  assert.equal(signal.repeats, 3)
  assert.ok(signal.chars <= 1200, 'window bounded, got ' + signal.chars)
})

await test('detectLoop: the tail window bounds very long inputs', () => {
  const signal = detectLoop('前言'.repeat(500) + reportedLoop)
  assert.equal(signal.detected, true)
  assert.ok(signal.chars <= 1200, 'window bounded, got ' + signal.chars)
})

// --- character-level fallback -------------------------------------------------
await test('detectLoop: punctuation-free repetition is caught by the n-gram fallback', () => {
  const block = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd'
  const signal = detectLoop(block.repeat(6))
  assert.equal(signal.detected, true)
  assert.equal(signal.kind, 'char')
  assert.ok(signal.confidence >= 0.5, 'rate ' + signal.confidence)
})

await test('charRepeatRate: empty and short text are safe', () => {
  assert.deepEqual(charRepeatRate('', 4), { tokens: 0, repeated: 0, rate: 0, top: '' })
  assert.equal(charRepeatRate('abc', 4).tokens, 0)
  assert.equal(charRepeatRate(undefined, 4).tokens, 0)
  // n < 2 falls back to the default n.
  assert.equal(charRepeatRate('aaaaaaaa', 1).tokens, 5)
})

// --- unit splitting -----------------------------------------------------------
await test('splitUnits: punctuation is kept inside units (写。/好。 stay distinct)', () => {
  assert.deepEqual(splitUnits(reportedLoop), ['写。', '好。', 'Go。', '写。', '好。', 'Go。', '写。', '好。', 'Go。'])
  assert.deepEqual(splitUnits('一。二。三。'), ['一。', '二。', '三。'])
  assert.deepEqual(splitUnits('What? Yes! Ok; done.'), ['What?', 'Yes!', 'Ok;', 'done.'])
})

await test('splitUnits: whitespace is folded and empty units dropped', () => {
  assert.deepEqual(splitUnits('  甲。 \n\n 乙。 \n'), ['甲。', '乙。'])
  assert.deepEqual(splitUnits('   \n\n '), [])
  assert.deepEqual(splitUnits(''), [])
  assert.deepEqual(splitUnits(undefined), [])
})

// --- period search ------------------------------------------------------------
await test('tailPeriodicRepeat: returns the SMALLEST period, not the longest', () => {
  // "a b a b a b" is period 2 (3 rounds), not period 6 (1 round).
  const found = tailPeriodicRepeat(['a', 'b', 'a', 'b', 'a', 'b'])
  assert.equal(found.period, 2)
  assert.equal(found.repeats, 3)
  assert.equal(found.covered, 6)
  assert.equal(found.unit, 'ab')
})

await test('tailPeriodicRepeat: needs a complete tail, ignores a noisy prefix', () => {
  const found = tailPeriodicRepeat(['噪声', 'x', 'y', 'x', 'y', 'x', 'y'])
  assert.equal(found.period, 2)
  assert.equal(found.repeats, 3)
  assert.equal(found.unit, 'xy')
})

await test('tailPeriodicRepeat: a prefix of any length is ignored (tail-run scan)', () => {
  const noise = Array.from({ length: 40 }, (_, i) => 'n' + i)
  const found = tailPeriodicRepeat([...noise, 'a', 'b', 'a', 'b', 'a', 'b'])
  assert.equal(found.period, 2)
  assert.equal(found.repeats, 3)
  assert.equal(found.covered, 6)
  assert.equal(found.unit, 'ab')
})

await test('tailPeriodicRepeat: returns null without enough rounds or units', () => {
  assert.equal(tailPeriodicRepeat([]), null)
  assert.equal(tailPeriodicRepeat(['a']), null)
  assert.equal(tailPeriodicRepeat(['a', 'b', 'a', 'b']), null) // 2 rounds < 3
  assert.equal(tailPeriodicRepeat(['a', 'b', 'c', 'a', 'b', 'c'], { minRepeats: 3 }), null)
})

await test('tailPeriodicRepeat: respects a raised minCycles', () => {
  assert.equal(tailPeriodicRepeat(['a', 'b', 'a', 'b', 'a', 'b'], { minCycles: 4 }), null)
  assert.equal(tailPeriodicRepeat(['a', 'b', 'a', 'b', 'a', 'b', 'a', 'b'], { minCycles: 4 }).repeats, 4)
})

console.log('')
console.log(String(passed) + ' passed, ' + String(failed) + ' failed')
if (failed > 0) process.exit(1)
