#!/usr/bin/env node
/**
 * Regression tests for the chain-of-thought LOOP guard in the monitor watchdog
 * (src/monitor.ts + src/loop-guard.ts + src/handoff.ts + src/session-create.ts).
 *
 * Why this exists: a looping session never looks stalled — every cycle lands new
 * events, so "ms since last event" stays tiny and the stall branch can never fire.
 * The guard therefore has to catch the loop itself, interrupt the session, and hand
 * the task to a NEW session, without losing the task and without trampling the
 * subagents the old session spawned.
 *
 * Drives the REAL SessionMonitor (and the real monitor_start tool) against a stub
 * host context via Node type stripping: `npm test`.
 */
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionMonitor } from '../src/monitor.ts'
import { registerBridgeTools } from '../src/tools.ts'

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

/** The reported loop shape: three units, three rounds each. */
const LOOP_TEXT = ['写。', '好。', 'Go。', '写。', '好。', 'Go。', '写。', '好。', 'Go。'].join('\n')
/** Ordinary reasoning: every unit different, no period to find. */
const NORMAL_TEXT = ['先确认仓库里是否已有同类实现。', '再读取 tick 路径确认卡住判定只看时间戳。', '然后写一个纯函数的周期检测模块便于单测。'].join('\n')

// Event timestamps must be FRESH: stalledMs is computed backwards from now, so using
// the seq number as the time marks every session as stalled — and the stall branch
// then steers before the loop guard is ever reached, hiding the path under test.
const turnStart = (seq) => ({ seq, time: Date.now(), type: 'turn/start', data: { turn: 1 } })
const userMsg = (seq, text) => ({ seq, time: Date.now(), type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })
/** A finalized assistant step carrying chain-of-thought. */
const assistantReasoning = (seq, reasoning, text = 'ok') => ({
  seq, time: Date.now(), type: 'assistant/message',
  data: { turn: 1, step: 1, message: { content: [{ type: 'reasoning', text: reasoning }, { type: 'text', text }] } },
})

/**
 * Tolerant scoped context for the agent-creation setup callback: both
 * `agentPresets.composeFrom(agentCtx, …)` and `installModelSelection(agentCtx, …)`
 * may poke the scoped context, and this stub only has to not explode.
 */
function tolerantCtx() {
  const target = {}
  return new Proxy(target, {
    get: (obj, prop) => {
      if (prop === 'then') return undefined
      if (!(prop in obj)) obj[prop] = () => undefined
      return obj[prop]
    },
  })
}

function harness(options = {}) {
  const agents = new Map()
  const roots = new Set()
  const ownership = new Map()
  const created = []
  const cancels = []
  const steers = []
  const followups = []
  const registered = new Map()

  function addAgent(id, opts = {}) {
    const agent = {
      id,
      status: opts.status ?? 'running',
      options: { provider: 'test-provider', model: 'test-model' },
      ctx: tolerantCtx(),
      session: {
        header: { cwd: opts.cwd ?? 'D:/work', ...(opts.header ?? {}) },
        snapshotEvents: () => opts.events ?? [],
        requestHeader: () => ({ config: { provider: 'test-provider', model: 'test-model' } }),
      },
      ...(opts.inbox === undefined ? {} : { inbox: opts.inbox }),
      followup(message) { followups.push({ id, message }) },
      steer(message) { steers.push({ id, message }) },
      cancel(cause, cancelOptions) { cancels.push({ id, cause, options: cancelOptions }) },
    }
    agents.set(id, agent)
    if (opts.root !== false) roots.add(id)
    return agent
  }

  const ctx = {
    tools: { register: (tool) => { registered.set(tool.name, tool) } },
    agents: {
      get: (id) => agents.get(id),
      list: () => [...agents.values()],
      roots: () => [...agents.values()].filter((agent) => roots.has(agent.id)),
      isOwnedBy: (id, owner) => ownership.get(id) === owner.id,
      create: async (createOptions) => {
        created.push(createOptions)
        if (options.createThrows === true) throw new Error('create failed (stub)')
        const agent = addAgent(createOptions.sessionId, { status: 'running', events: [] })
        if (typeof createOptions.setup === 'function') await createOptions.setup(tolerantCtx())
        return { agent }
      },
    },
    workspaceRegistry: { list: () => [], resolveByPath: async () => undefined, get: () => undefined },
    agentPresets: { composeFrom: () => undefined, mount: async () => undefined },
    sessionPersistence: { open: async () => { throw new Error('not used') } },
    setInterval: () => 0,
    clearInterval: () => {},
    effect: () => {},
  }
  const registry = { record() {}, touch() {}, all: async () => [], load: async () => {}, persist: async () => {} }
  const logFile = join(tmpdir(), 'dsh-session-bridge-loop-' + String(process.pid) + '-' + Math.random().toString(16).slice(2) + '.log')
  const monitor = new SessionMonitor(ctx, registry, logFile)
  return {
    ctx, registry, monitor, agents, roots, ownership, created, cancels, steers, followups, registered,
    addAgent,
    registerTools() { registerBridgeTools({ ctx, registry, monitor }); return registered },
  }
}

function baseConfig(sessionId, extra = {}) {
  return { sessionId, intervalMs: 10000, doneKeywords: [], ...extra }
}

// --- the reported case --------------------------------------------------------
await test('loop → transfer: successor created, old session cancelled, monitor migrated', async () => {
  const h = harness()
  h.addAgent('main', { events: [turnStart(0), userMsg(1, '实现 X 功能'), assistantReasoning(2, LOOP_TEXT)] })
  h.monitor.start(baseConfig('main'))
  await h.monitor.tickNow()

  assert.equal(h.created.length, 1, 'exactly one successor session')
  const newId = h.created[0].sessionId
  assert.notEqual(newId, 'main')

  const handoff = h.followups.find((item) => item.id === newId)
  assert.ok(handoff !== undefined, 'handoff prompt sent to the successor')
  const handoffText = JSON.stringify(handoff.message)
  assert.ok(handoffText.includes('session_bridge_read'), 'handoff tells the successor to read the old log')
  assert.ok(handoffText.includes('main'), 'handoff carries the original session id')
  assert.ok(handoffText.includes('实现 X 功能'), 'handoff carries the task instruction')

  const oldCancel = h.cancels.find((item) => item.id === 'main')
  assert.ok(oldCancel !== undefined, 'old session was cancelled')
  assert.ok(String(oldCancel.cause.reason).includes('chain-of-thought loop detected'), 'cancel carries the loop reason')

  const list = h.monitor.list()
  assert.equal(list.length, 1, 'monitor migrated to exactly one entry')
  assert.equal(list[0].config.sessionId, newId)
  assert.equal(list[0].config.loopTransferDepth, 1, 'successor inherits depth + 1')
  assert.equal(list[0].lastAction, 'none', 'the successor itself is not marked as looping')
})

await test('loop detection is default-on and honours loopGuard:false', async () => {
  const h = harness()
  h.addAgent('main', { events: [turnStart(0), userMsg(1, 'task'), assistantReasoning(2, LOOP_TEXT)] })
  h.monitor.start(baseConfig('main', { loopGuard: false }))
  await h.monitor.tickNow()
  assert.equal(h.created.length, 0)
  assert.equal(h.cancels.length, 0)
})

await test('ordinary long reasoning does not trigger the guard', async () => {
  const h = harness()
  h.addAgent('main', { events: [turnStart(0), userMsg(1, 'task'), assistantReasoning(2, NORMAL_TEXT)] })
  h.monitor.start(baseConfig('main'))
  await h.monitor.tickNow()
  assert.equal(h.created.length, 0)
  assert.equal(h.cancels.length, 0)
})

await test('an idle session is never judged as looping', async () => {
  const h = harness()
  // pendingWork keeps the idle-settle branch from ending the monitor first.
  h.addAgent('main', { status: 'idle', inbox: { nextTurn: [{}] }, events: [assistantReasoning(2, LOOP_TEXT)] })
  h.monitor.start(baseConfig('main'))
  await h.monitor.tickNow()
  assert.equal(h.created.length, 0)
  assert.equal(h.cancels.length, 0)
})

// --- subagents ----------------------------------------------------------------
await test('a running descendant is NOT cancelled and is listed in the handoff', async () => {
  const h = harness()
  h.addAgent('main', { events: [turnStart(0), userMsg(1, '任务'), assistantReasoning(2, LOOP_TEXT)] })
  h.addAgent('sub-1', { root: false, status: 'running', events: [turnStart(0), userMsg(1, '子任务：抓取数据')] })
  h.ownership.set('sub-1', 'main')
  h.monitor.start(baseConfig('main'))
  await h.monitor.tickNow()

  assert.equal(h.cancels.filter((item) => item.id === 'sub-1').length, 0, 'descendant keeps running')
  const newId = h.created[0].sessionId
  const text = JSON.stringify(h.followups.find((item) => item.id === newId).message)
  assert.ok(text.includes('sub-1'), 'descendant listed in the handoff')
  assert.ok(text.includes('子任务：抓取数据'), 'descendant task carried into the handoff')
  assert.ok(text.includes('不要重做'), 'handoff tells the successor not to redo it')

  const transfer = h.monitor.list()[0].loop.transfers[0]
  assert.equal(transfer.descendants.length, 1)
  assert.equal(transfer.descendants[0].id, 'sub-1')
  assert.deepEqual(transfer.stopped, [])
})

await test('loopDescendants:stop cancels running descendants before transferring', async () => {
  const h = harness()
  h.addAgent('main', { events: [turnStart(0), userMsg(1, '任务'), assistantReasoning(2, LOOP_TEXT)] })
  h.addAgent('sub-1', { root: false, status: 'running', events: [userMsg(1, '子任务')] })
  h.ownership.set('sub-1', 'main')
  h.monitor.start(baseConfig('main', { loopDescendants: 'stop' }))
  await h.monitor.tickNow()

  const stop = h.cancels.find((item) => item.id === 'sub-1')
  assert.ok(stop !== undefined, 'descendant cancelled on request')
  assert.ok(String(stop.cause.reason).includes('stop descendant'))
  const transfer = h.monitor.list()[0].loop.transfers[0]
  assert.deepEqual(transfer.stopped, ['sub-1'])
})

await test('loopDescendants:ignore leaves descendants out of the handoff entirely', async () => {
  const h = harness()
  h.addAgent('main', { events: [turnStart(0), userMsg(1, '任务'), assistantReasoning(2, LOOP_TEXT)] })
  h.addAgent('sub-1', { root: false, status: 'running', events: [userMsg(1, '子任务')] })
  h.ownership.set('sub-1', 'main')
  h.monitor.start(baseConfig('main', { loopDescendants: 'ignore' }))
  await h.monitor.tickNow()

  assert.equal(h.cancels.filter((item) => item.id === 'sub-1').length, 0)
  const newId = h.created[0].sessionId
  const text = JSON.stringify(h.followups.find((item) => item.id === newId).message)
  assert.equal(text.includes('sub-1'), false, 'descendant not mentioned')
})

await test('a looping subagent is cancelled and the main session is steered (no transfer)', async () => {
  const h = harness()
  h.addAgent('main', { events: [turnStart(0), userMsg(1, '任务'), assistantReasoning(2, NORMAL_TEXT)] })
  h.addAgent('sub-1', { root: false, status: 'running', events: [assistantReasoning(2, LOOP_TEXT)] })
  h.ownership.set('sub-1', 'main')
  h.monitor.start(baseConfig('main'))
  await h.monitor.tickNow()

  assert.equal(h.created.length, 0, 'a subagent loop never spawns a successor session')
  const stop = h.cancels.find((item) => item.id === 'sub-1')
  assert.ok(stop !== undefined, 'looping subagent cancelled')
  assert.ok(String(stop.cause.reason).includes('chain-of-thought loop (subagent)'))
  const steer = h.steers.find((item) => item.id === 'main')
  assert.ok(steer !== undefined, 'main session told to re-delegate')
  assert.ok(JSON.stringify(steer.message).includes('sub-1'))
  assert.equal(h.monitor.list()[0].loop.subagentCancels, 1)
  assert.equal(h.monitor.list()[0].lastAction, 'loop-subagent-cancel')
})

await test('a subagent session that loops is only cancelled, never transferred', async () => {
  const h = harness()
  h.addAgent('main', { root: false, status: 'running', events: [] })
  h.addAgent('sub-1', {
    root: false,
    status: 'running',
    header: { origin: 'subagent', parentSession: 'main', delegationDepth: 1 },
    events: [assistantReasoning(2, LOOP_TEXT)],
  })
  h.monitor.start(baseConfig('sub-1'))
  await h.monitor.tickNow()

  assert.equal(h.created.length, 0, 'no successor for a subagent session')
  const stop = h.cancels.find((item) => item.id === 'sub-1')
  assert.ok(stop !== undefined)
  assert.ok(String(stop.cause.reason).includes('subagent session'))
  const steer = h.steers.find((item) => item.id === 'main')
  assert.ok(steer !== undefined, 'parent session notified')
  assert.equal(h.monitor.list()[0].lastAction, 'loop-cancel')
})

// --- transfer guards ----------------------------------------------------------
await test('transfer depth cap degrades to a plain cancel', async () => {
  const h = harness()
  h.addAgent('main', { events: [turnStart(0), userMsg(1, 'task'), assistantReasoning(2, LOOP_TEXT)] })
  h.monitor.start(baseConfig('main', { loopTransferDepth: 3, loopMaxTransfers: 3 }))
  await h.monitor.tickNow()
  assert.equal(h.created.length, 0)
  assert.ok(h.cancels.find((item) => item.id === 'main') !== undefined)
  assert.equal(h.monitor.list()[0].lastAction, 'loop-cancel')
})

await test('loopTransfer:false only interrupts', async () => {
  const h = harness()
  h.addAgent('main', { events: [turnStart(0), userMsg(1, 'task'), assistantReasoning(2, LOOP_TEXT)] })
  h.monitor.start(baseConfig('main', { loopTransfer: false }))
  await h.monitor.tickNow()
  assert.equal(h.created.length, 0)
  assert.equal(h.monitor.list()[0].lastAction, 'loop-cancel')
})

await test('a failed transfer keeps the original monitor and never cancels the task', async () => {
  const h = harness({ createThrows: true })
  h.addAgent('main', { events: [turnStart(0), userMsg(1, 'task'), assistantReasoning(2, LOOP_TEXT)] })
  h.monitor.start(baseConfig('main'))
  await h.monitor.tickNow()

  assert.equal(h.cancels.length, 0, 'old session untouched when creation fails')
  const list = h.monitor.list()
  assert.equal(list.length, 1)
  assert.equal(list[0].config.sessionId, 'main')
  assert.equal(list[0].loop.transfers.length, 0)
  assert.ok(list[0].lastNote.includes('转移失败'), 'failure recorded: ' + list[0].lastNote)
})

await test('loopMinHits requires consecutive polls with the same signature', async () => {
  const h = harness()
  h.addAgent('main', { events: [turnStart(0), userMsg(1, 'task'), assistantReasoning(2, LOOP_TEXT)] })
  h.monitor.start(baseConfig('main', { loopMinHits: 2 }))
  await h.monitor.tickNow()
  assert.equal(h.created.length, 0, 'first hit is below the threshold')
  await h.monitor.tickNow()
  assert.equal(h.created.length, 1, 'second consecutive hit fires')
})

await test('loopAutoMonitor:false leaves the successor unwatched', async () => {
  const h = harness()
  h.addAgent('main', { events: [turnStart(0), userMsg(1, 'task'), assistantReasoning(2, LOOP_TEXT)] })
  h.monitor.start(baseConfig('main', { loopAutoMonitor: false }))
  await h.monitor.tickNow()
  assert.equal(h.created.length, 1)
  assert.equal(h.monitor.list().length, 0)
})

// --- tool surface -------------------------------------------------------------
await test('session_bridge_monitor_start maps every loop* argument onto the config', async () => {
  const h = harness()
  const tools = h.registerTools()
  h.addAgent('main', { events: [] })
  await tools.get('session_bridge_monitor_start').execute({
    sessionId: 'main',
    loopGuard: false,
    loopField: 'both',
    loopMinCycles: 3,
    loopMinRepeats: 4,
    loopMinConfidence: 0.75,
    loopMinHits: 2,
    loopCooldownMs: 45000,
    loopMaxTransfers: 5,
    loopTransfer: false,
    loopAutoMonitor: false,
    loopDescendants: 'stop',
    loopHandoffPrompt: 'custom {{sessionId}}',
    loopTransferDepth: 2,
  }, {})
  const config = h.monitor.list()[0].config
  assert.equal(config.loopGuard, false)
  assert.equal(config.loopField, 'both')
  assert.equal(config.loopMinCycles, 3)
  assert.equal(config.loopMinRepeats, 4)
  assert.equal(config.loopMinConfidence, 0.75)
  assert.equal(config.loopMinHits, 2)
  assert.equal(config.loopCooldownMs, 45000)
  assert.equal(config.loopMaxTransfers, 5)
  assert.equal(config.loopTransfer, false)
  assert.equal(config.loopAutoMonitor, false)
  assert.equal(config.loopDescendants, 'stop')
  assert.equal(config.loopHandoffPrompt, 'custom {{sessionId}}')
  assert.equal(config.loopTransferDepth, 2)
})

await test('monitor_list renders the loop guard state', async () => {
  const h = harness()
  const tools = h.registerTools()
  h.addAgent('main', { events: [turnStart(0), userMsg(1, 'task'), assistantReasoning(2, LOOP_TEXT)] })
  await tools.get('session_bridge_monitor_start').execute({ sessionId: 'main', loopDescendants: 'report' }, {})
  await h.monitor.tickNow()
  const listTool = tools.get('session_bridge_monitor_list')
  const listed = await listTool.execute({}, {})
  const text = listTool.output.render({}, listed).map((block) => block.text).join('\n')
  assert.ok(text.includes('loopGuard: on field=reasoning'), 'loop line rendered: ' + text.slice(0, 400))
  assert.ok(text.includes('transfers: 1'), 'transfer counted')
  assert.ok(text.includes('descendants=report'))
})

console.log('')
console.log(String(passed) + ' passed, ' + String(failed) + ' failed')
if (failed > 0) process.exit(1)
