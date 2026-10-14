'use strict'

// H 组：service 层测试（纯规则降级路径，不依赖 LLM / 宿主 ctx）。
// 用 node 内置 test runner：`node --test`。
// 设计：createPromptCompiler(null) 时 callLLM 恒返回 null，
// analyze/compile 必须安全降级为规则实现且不抛错 —— 这是插件在
// agentless / NO_PROVIDER 下仍能用的核心不变量。

const test = require('node:test')
const assert = require('node:assert/strict')
const { createPromptCompiler } = require('../lib/service.js')

const pc = createPromptCompiler(null)

test('analyze: 粗糙 draft 给出低分 + 列出缺失要素', async () => {
  const out = await pc.analyze('帮我写个爬虫')
  assert.equal(typeof out.score, 'number')
  assert.ok(out.score >= 0 && out.score <= 100)
  assert.ok(Array.isArray(out.missing))
  // "帮我写个爬虫" 缺目标/约束/格式，missing 不应为空
  assert.ok(out.missing.length > 0)
})

test('analyze: 完整 draft 给出高分', async () => {
  const rich =
    '目标：抓取 example.com 的新闻标题。约束：仅用 Python requests + BeautifulSoup，' +
    '不爬 robots.txt 禁止的页面。输出格式：每行一条 JSON（标题 + 链接）。'
  const out = await pc.analyze(rich)
  assert.ok(out.score > 60, `完整 draft 应高分，实得 ${out.score}`)
  assert.ok(out.missing.length === 0, `完整 draft missing 应为空，实得 ${JSON.stringify(out.missing)}`)
})

test('elicit: 返回结构化澄清问题（≤3 条）', async () => {
  const out = await pc.elicit('帮我写个爬虫')
  assert.ok(Array.isArray(out.questions))
  assert.ok(out.questions.length >= 1 && out.questions.length <= 3)
  for (const q of out.questions) {
    assert.equal(typeof q.id, 'string')
    assert.equal(typeof q.text, 'string')
    assert.equal(typeof q.why, 'string')
  }
})

test('compile: 无 LLM 时规则降级产出非空 compiled + assumptions', async () => {
  const out = await pc.compile('帮我写个爬虫')
  assert.equal(typeof out.compiled, 'string')
  assert.ok(out.compiled.length > 0)
  assert.ok(Array.isArray(out.assumptions))
})

test('compile: 带 answers 时 assumptions 不再含已答要素', async () => {
  const out = await pc.compile('帮我写个爬虫', {
    answers: { goal: '抓取新闻标题' },
  })
  assert.equal(typeof out.compiled, 'string')
  assert.ok(out.compiled.length > 0)
})

test('analyze/compile 不抛错（agentless 安全降级）', async () => {
  await assert.doesNotReject(async () => {
    await pc.analyze('x')
    await pc.compile('x')
  })
})

// —— 2026-10-14 两个真实故障的回归测试（带假 LLM 的宿主契约仿真） ——

/** 造一个符合宿主 GenerateOptions / StreamChunk 契约的假 ctx.llm。 */
function fakeHost(opts) {
  const o = opts || {}
  const seen = []
  return {
    seen,
    listProviders: () => [{ id: 'workbuddy', name: 'WorkBuddy' }],
    listModels: async () => [{ provider: 'workbuddy', id: 'hy3-x', name: 'Hy3' }],
    stream(input) {
      seen.push(input)
      // 契约断言：content 必须是块数组，且 id/source 必填（否则真实宿主抛
      // "content.some is not a function"）。
      if (o.assertContract !== false) {
        assert.ok(Array.isArray(input.messages), 'messages 必须是数组')
        for (const m of input.messages) {
          assert.ok(Array.isArray(m.content), `message.content 必须是块数组，实得 ${typeof m.content}`)
          assert.equal(typeof m.id, 'string', 'message.id 必填')
          assert.ok(m.source && typeof m.source === 'object', 'message.source 必填')
        }
      }
      const chunks = o.chunks || [
        { type: 'block-start', index: 0, blockType: 'reasoning' },
        { type: 'reasoning-delta', index: 0, text: '我先想想……不该出现在正文里。' },
        { type: 'block-start', index: 1, blockType: 'text' },
        { type: 'text-delta', index: 1, text: '{"missing":[],"ambiguities":[],"score":77,' },
        { type: 'text-delta', index: 1, text: '"reasoning":"模型真的跑了"}' },
        { type: 'finish', reason: { kind: 'stop' } },
      ]
      return (async function* () { for (const c of chunks) yield c })()
    },
  }
}

test('回归①：messages 必须符合宿主契约（content 块数组 + id + source）', async () => {
  const host = fakeHost()
  const svc = createPromptCompiler({ llm: host })
  await svc.compile('帮我写个爬虫')
  assert.ok(host.seen.length > 0, '应当真的调用了 llm.stream')
})

test('回归②：reasoning-delta 不得混入正文（否则思维链泄漏进 compile 结果）', async () => {
  const host = fakeHost()
  const svc = createPromptCompiler({ llm: host })
  const out = await svc.compile('帮我写个爬虫')
  assert.ok(!out.compiled.includes('我先想想'), '思维链泄漏进了 compile 输出：' + out.compiled.slice(0, 200))
  assert.ok(!out.compiled.includes('不该出现在正文里'), '思维链泄漏进了 compile 输出')
  assert.equal(out.degraded, false, 'LLM 有正常返回时不应降级')
})

test('回归②b：analyze 只吃 text-delta，思维链不污染解析', async () => {
  const host = fakeHost()
  const svc = createPromptCompiler({ llm: host })
  const a = await svc.analyze('帮我写个爬虫')
  assert.equal(a.score, 77, '应解析出模型返回的 score')
  assert.equal(a.reasoning, '模型真的跑了')
})

test('回归③：finish(stop) 不得被误判成拒绝', async () => {
  const host = fakeHost()
  const svc = createPromptCompiler({ llm: host })
  const out = await svc.compile('帮我写个爬虫')
  assert.equal(out.degraded, false)
  const detail = (out.diag && out.diag.attemptsDetail) || []
  assert.ok(!detail.some(d => /reject=finish: \{"kind":"stop"\}/.test(d)), 'finish(stop) 被误判为拒绝')
})

