#!/usr/bin/env node
/**
 * 回归测试：session_search_global（本 fork 新增的跨工作区正文检索）。
 *
 * 直接跑 src/search.ts（node --experimental-strip-types），用桩 sessionQuery
 * 覆盖三条路径：索引态、单会话事件、索引关闭时的降级扫描。
 */
import assert from 'node:assert/strict'
import { registerSearchTool } from '../src/search.ts'

let passed = 0
const ok = (label) => {
  passed += 1
  console.log('  ok ' + label)
}

/** 造一个只暴露 register 的 tools 服务和 sessionQuery 桩。 */
function mount(sessionQuery) {
  const tools = new Map()
  const ctx = {
    tools: { register: (tool) => { tools.set(tool.name, tool) } },
    get: (name) => (name === 'sessionQuery' ? sessionQuery : undefined),
  }
  registerSearchTool(ctx)
  assert.equal(tools.size, 1, 'exactly one tool is registered')
  const tool = tools.get('session_search_global')
  assert.ok(tool, 'tool is named session_search_global')
  return tool
}

const record = (id, cwd, live) => ({ header: { id, cwd, createdAt: 100 }, live, persisted: true })

/** 通用标题桩。 */
const titles = async (ids) => ids.map((id) => ({ sessionId: id, status: 'fulfilled', value: { title: { title: 'title:' + id } } }))

// ---------- 1) 索引态：工作区过滤 + 标题 + 渲染 ----------
{
  const requests = []
  const tool = mount({
    async searchSessions(request) {
      requests.push(request)
      return {
        items: [
          { ...record('session-other', '/work/memory_research', false), bestMatch: { seq: 4, type: 'user/message', surface: 'current', time: 200, snippet: 'interface contract' } },
          { ...record('session-self', '/work/dsh-plugins', true), bestMatch: { seq: 9, type: 'assistant/message', surface: 'current', time: 300, snippet: 'something else' } },
        ],
        nextCursor: 'next',
      }
    },
    readTitleSnapshots: titles,
  })
  const value = await tool.execute({ query: 'interface', workspace: 'memory_research' })
  assert.deepEqual(requests[0], { query: 'interface', limit: 30 }, 'workspace filter over-fetches then trims')
  assert.equal(value.degraded, false)
  assert.equal(value.total, 1)
  assert.equal(value.hasMore, true)
  assert.equal(value.items[0].sessionId, 'session-other')
  assert.equal(value.items[0].title, 'title:session-other')
  assert.equal(JSON.stringify(value).includes('undefined'), false, 'value stays lossless JSON')
  const text = tool.output.render({}, value).map((block) => block.text).join('\n')
  assert.match(text, /session-other/)
  assert.match(text, /session_bridge_read/)
  assert.doesNotMatch(text, /session-self/)
  ok('indexed search filters by workspace, folds titles, renders readable rows')
}

// ---------- 2) 单会话：事件命中 + 记录状态 ----------
{
  const tool = mount({
    async searchEvents(request) {
      assert.deepEqual(request, { sessionId: 'session-a', query: 'protocol', limit: 5 })
      return {
        session: { id: 'session-a', cwd: '/work/memory_research', createdAt: 1 },
        items: [{ sessionId: 'session-a', seq: 7, type: 'tool/result', surface: 'current', time: 10, snippet: 'protocol v2' }],
      }
    },
    async filterSessions(filters) {
      assert.deepEqual(filters, [{ kind: 'id', values: ['session-a'] }])
      return [{ ...record('session-a', '/work/memory_research', true) }]
    },
    readTitleSnapshots: titles,
  })
  const value = await tool.execute({ query: 'protocol', sessionId: 'session-a', limit: 5 })
  assert.equal(value.mode, 'events')
  assert.equal(value.total, 1)
  assert.equal(value.items[0].live, true)
  assert.equal(value.items[0].type, 'tool/result')
  ok('single-session search returns event hits with live state')
}

// ---------- 3) 索引关闭：降级扫描（每会话一条最佳命中 + 排序） ----------
{
  const tool = mount({
    async searchSessions() {
      throw Object.assign(new Error('session search is disabled in this deployment'), { code: 'SESSION_QUERY_SEARCH_DISABLED' })
    },
    async listSessions() {
      return [
        record('session-b', '/work/temp', false),
        record('session-c', '/work/dsh-plugins', true),
        record('session-d', '/work/memory_research', false),
      ]
    },
    async filterEvents(sessionId, filters) {
      assert.deepEqual(filters, [{ kind: 'text', text: 'interface' }])
      if (sessionId === 'session-b') return [{ seq: 3, type: 'assistant/message', surface: 'current', time: 30, text: 'the interface is stable' }]
      if (sessionId === 'session-d') return [
        { seq: 5, type: 'user/message', surface: 'current', time: 50, text: 'interface draft' },
        { seq: 6, type: 'assistant/message', surface: 'current', time: 60, text: 'interface final' },
      ]
      return []
    },
    readTitleSnapshots: titles,
  })
  const value = await tool.execute({ query: 'interface' })
  assert.equal(value.degraded, true)
  assert.equal(value.total, 2)
  assert.equal(value.items[0].sessionId, 'session-d', 'more matches rank first')
  assert.equal(value.items[1].sessionId, 'session-b')
  assert.equal(value.items[0].snippet, 'interface draft')
  const text = tool.output.render({}, value).map((block) => block.text).join('\n')
  assert.match(text, /degraded/)
  ok('closed index falls back to a bounded per-session scan and says so')
}

// ---------- 4) 空查询 / 缺服务 ----------
{
  const tool = mount({})
  await assert.rejects(() => tool.execute({ query: '   ' }), /non-empty/)
  const missing = mount(undefined)
  await assert.rejects(() => missing.execute({ query: 'x' }), /no sessionQuery service/)
  ok('empty query and a profile without sessionQuery fail with clear errors')
}

console.log('\ntest-search: ' + String(passed) + ' checks passed')


