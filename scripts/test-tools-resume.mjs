#!/usr/bin/env node
/**
 * Regression tests for `session_bridge_resume` (src/tools.ts + src/core.ts).
 *
 * A real device run (2026-10-27) showed that resuming a persisted session with
 * `session_bridge_resume` failed the next turn with
 * `prompt variable "{{model}}" has no value for this assembly (section
 * "deployment:persona-prefix")`: `agents.resume` was called without
 * `agentOptions`, so `agent.options.model` (the source of the prompt's
 * `{{model}}` variable) stayed undefined.
 *
 * The tool must therefore always resolve a route:
 * explicit args > the session's own persisted request header > the calling
 * agent's request header > the deployment default selection.
 *
 * Node type stripping keeps this runnable without a build: `npm test`.
 */
import assert from 'node:assert/strict'
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

function tolerantCtx(overrides = {}, guardedProps = []) {
  const target = { ...overrides }
  return new Proxy(target, {
    get: (obj, prop) => {
      if (prop === 'then') return undefined
      // Cordis throws for an undeclared service read as a property; the tool
      // must use ctx.get() instead (pinned by the cordisGuard test).
      if (typeof prop === 'string' && guardedProps.includes(prop)) {
        throw new Error('cannot get property "' + prop + '" without inject')
      }
      if (!(prop in obj)) obj[prop] = () => undefined
      return obj[prop]
    },
  })
}

const SESSION_ID = 'session-3d3f0341-65be-4fe6-a377-688f322ea865'
const WS = { id: 'ws-temp', path: 'F:/github/temp', sessionIds: [] }

function headerEvent(config) {
  return { seq: 0, time: Date.now(), type: 'request/header', data: { header: { config }, reason: 'initial' } }
}

function harness(options = {}) {
  const registered = new Map()
  const resumeCalls = []
  const records = []
  const resumeAgent = {
    id: SESSION_ID,
    status: 'idle',
    options: {},
    ctx: tolerantCtx(),
    session: {
      header: { cwd: 'F:/github/temp' },
      snapshotEvents: () => [],
      requestHeader: () => undefined,
    },
    followup() {},
    steer() {},
    cancel() {},
  }

  const ctx = tolerantCtx({
    get: (name) => (options.defaultSelection !== undefined && name === 'agentDefaultModel'
      ? { currentSelection: () => options.defaultSelection }
      : undefined),
    tools: { register: (tool) => { registered.set(tool.name, tool) } },
    agents: {
      get: () => undefined,
      list: () => [],
      resume: async (resumeOptions) => {
        resumeCalls.push(resumeOptions)
        return { agent: resumeAgent }
      },
    },
    workspaceRegistry: {
      get: (id) => (id === WS.id ? WS : undefined),
      list: () => [WS],
      resolveByPath: async (cwd) => (cwd === WS.path ? { id: WS.id, path: WS.path, attachSession: async () => {} } : undefined),
    },
    sessionPersistence: {
      list: async () => [{ header: { id: SESSION_ID, cwd: 'F:/github/temp', createdAt: 1 } }],
      open: async () => ({
        header: { cwd: 'F:/github/temp' },
        read: async () => ({ events: options.events ?? [] }),
        close: async () => {},
      }),
    },

  })

  const registry = {
    record(entry) { records.push(entry) },
    touch() {},
    all: async () => [],
    load: async () => {},
    persist: async () => {},
  }
  const monitor = { dispose() {}, start() {}, stop: () => false, list: () => [] }
  registerBridgeTools({ ctx, registry, monitor })

  return {
    tools: registered,
    resumeCalls,
    records,
    async run(args, execOverrides = {}) {
      const exec = { signal: new AbortController().signal, ...execOverrides }
      return registered.get('session_bridge_resume').execute(args, exec)
    },
  }
}

await test('resume: the session persisted request header supplies provider/model', async () => {
  const h = harness({ events: [headerEvent({ provider: 'p-log', model: 'm-log', reasoningEffort: 'high' })] })
  const result = await h.run({ sessionId: SESSION_ID })
  assert.equal(result.resumed, true)
  assert.equal(h.resumeCalls.length, 1)
  assert.deepEqual(h.resumeCalls[0].agentOptions, { provider: 'p-log', model: 'm-log', reasoningEffort: 'high' })
  assert.equal(h.records[0].source, 'resume')
})

await test('resume: explicit provider/model override the persisted header', async () => {
  const h = harness({ events: [headerEvent({ provider: 'p-log', model: 'm-log' })] })
  await h.run({ sessionId: SESSION_ID, provider: 'p-arg', model: 'm-arg' })
  assert.deepEqual(h.resumeCalls[0].agentOptions, { provider: 'p-arg', model: 'm-arg' })
})

await test('resume: falls back to the calling agent request header when the log has no header', async () => {
  const h = harness({ events: [] })
  const callerSession = {
    header: { cwd: 'F:/caller' },
    snapshotEvents: () => [],
    requestHeader: () => ({ config: { provider: 'p-caller', model: 'm-caller', reasoningEffort: 'low' } }),
  }
  await h.run({ sessionId: SESSION_ID }, { agent: { session: callerSession } })
  assert.deepEqual(h.resumeCalls[0].agentOptions, { provider: 'p-caller', model: 'm-caller', reasoningEffort: 'low' })
})

await test('resume: falls back to the deployment default selection last', async () => {
  const h = harness({ events: [], defaultSelection: { provider: 'p-default', model: 'm-default' } })
  await h.run({ sessionId: SESSION_ID })
  assert.deepEqual(h.resumeCalls[0].agentOptions, { provider: 'p-default', model: 'm-default' })
})

await test('resume: reads the deployment default through ctx.get under Cordis inject rules', async () => {
  const h = harness({ events: [], defaultSelection: { provider: 'p-default', model: 'm-default' }, cordisGuard: true })
  await h.run({ sessionId: SESSION_ID })
  assert.deepEqual(h.resumeCalls[0].agentOptions, { provider: 'p-default', model: 'm-default' })
})

await test('resume: never calls agents.resume without agentOptions when a route is known', async () => {
  const h = harness({ events: [] })
  await h.run({ sessionId: SESSION_ID, model: 'm-only' })
  assert.ok(h.resumeCalls[0].agentOptions, 'agentOptions must be present to fill the {{model}} prompt variable')
  assert.equal(h.resumeCalls[0].agentOptions.model, 'm-only')
})

console.log('')
console.log('tools-resume: ' + passed + ' passed, ' + failed + ' failed')
if (failed > 0) process.exit(1)

