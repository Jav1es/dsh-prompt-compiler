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
