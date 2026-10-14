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

test('回归④：block-end 不得把正文再算一遍（否则输出整体重复两遍）', async () => {
  // 真实宿主顺序：block-start → text-delta*（逐块累加）→ block-end（携带该块完整文本）
  const body = '## Task 抓取新闻\n## Constraints - 仅 HTTP GET\n## Output Format - 每行 JSON\n## Acceptance Criteria 1. 非空 title'
  const host = {
    listProviders: () => [{ id: 'workbuddy' }],
    listModels: async () => [{ id: 'hy3-x' }],
    stream() {
      const chunks = [
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: body },
        { type: 'block-end', index: 0, block: { type: 'text', text: body } },
        { type: 'finish', reason: { kind: 'stop' } },
      ]
      return (async function* () { for (const c of chunks) yield c })()
    },
  }
  const svc = createPromptCompiler({ llm: host })
  const out = await svc.compile('帮我写个爬虫')
  const n = (out.compiled.match(/## Task/g) || []).length
  assert.equal(n, 1, `## Task 应只出现 1 次，实得 ${n}（输出重复了）`)
  assert.ok(!out.compiled.includes(body + body), '正文被 block-end 重复累加')
})

test('回归④b：宿主只发 block-end（无 delta）时仍能取到正文', async () => {
  const body = '## Task 只有块结束事件\n## Constraints - x\n## Output Format - y\n## Acceptance Criteria 1. z'
  const host = {
    listProviders: () => [{ id: 'workbuddy' }],
    listModels: async () => [{ id: 'hy3-x' }],
    stream() {
      const chunks = [
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'block-end', index: 0, block: { type: 'text', text: body } },
        { type: 'finish', reason: { kind: 'stop' } },
      ]
      return (async function* () { for (const c of chunks) yield c })()
    },
  }
  const svc = createPromptCompiler({ llm: host })
  const out = await svc.compile('帮我写个爬虫')
  assert.equal(out.degraded, false, '不应降级')
  assert.ok(out.compiled.includes('## Task'), '无 delta 的宿主应走 block-end 兜底拿到正文')
})

test('回归⑤：reasoning-only 模型（思维链块在前、正文块在后且只有 block-end）必须取到正文', async () => {
  // 实测形态（nvidia/nemotron-3-super-120b-a12b，catalog 标 onlyReasoning:true）：
  //   block-start(0, reasoning) → reasoning-delta(0)* → block-start(1, text) → block-end(1, text)
  // 正文块只有 block-end、没有 text-delta。按 index 记账才能既不重复、又不丢失。
  const answer = '{"missing":["缺少目标"],"ambiguities":[],"score":30,"reasoning":"真答案"}'
  const host = {
    listProviders: () => [{ id: 'nvidia' }],
    listModels: async () => [{ id: 'nvidia/nemotron-3-super-120b-a12b' }],
    stream() {
      const chunks = [
        { type: 'block-start', index: 0, blockType: 'reasoning' },
        { type: 'reasoning-delta', index: 0, text: 'The user says 测试. Let me think about this.' },
        { type: 'reasoning-delta', index: 0, text: ' I should reply with the JSON only.' },
        { type: 'block-start', index: 1, blockType: 'text' },
        { type: 'block-end', index: 1, block: { type: 'text', text: answer } },
        { type: 'finish', reason: { kind: 'stop' } },
      ]
      return (async function* () { for (const c of chunks) yield c })()
    },
  }
  const svc = createPromptCompiler({ llm: host })
  const a = await svc.analyze('写个爬虫')
  assert.equal(a.score, 30, 'reasoning-only 模型的正文块应被取到（否则会静默降级到规则 score）')
  assert.equal(a.reasoning, '真答案')
  assert.ok(!JSON.stringify(a).includes('Let me think'), '思维链不得进入结果')
})

test('回归⑥：reasoning块有delta + 正文块也有delta ⇒ 只取正文，且不重复', async () => {
  const body = '## Task 正文\n## Constraints - a\n## Output Format - b\n## Acceptance Criteria 1. c'
  const host = {
    listProviders: () => [{ id: 'x' }],
    listModels: async () => [{ id: 'm' }],
    stream() {
      const chunks = [
        { type: 'block-start', index: 0, blockType: 'reasoning' },
        { type: 'reasoning-delta', index: 0, text: '思考中……' },
        { type: 'block-end', index: 0, block: { type: 'reasoning', text: '思考中……' } },
        { type: 'block-start', index: 1, blockType: 'text' },
        { type: 'text-delta', index: 1, text: body },
        { type: 'block-end', index: 1, block: { type: 'text', text: body } },
        { type: 'finish', reason: { kind: 'stop' } },
      ]
      return (async function* () { for (const c of chunks) yield c })()
    },
  }
  const svc = createPromptCompiler({ llm: host })
  const out = await svc.compile('写个爬虫')
  assert.equal((out.compiled.match(/## Task/g) || []).length, 1, '正文重复了')
  assert.ok(!out.compiled.includes('思考中'), '思维链泄漏')
})

test('回归⑦：provider 被限流(429)时不应换 purpose 重试，应直接换 provider', async () => {
  const calls = []
  const answer = '## Task ok\n## Constraints - a\n## Output Format - b\n## Acceptance Criteria 1. c'
  const host = {
    listProviders: () => [{ id: 'limited' }, { id: 'good' }],
    listModels: async (p) => (p === 'limited' ? [{ id: 'm1' }] : [{ id: 'm2' }]),
    stream(input) {
      calls.push(input.provider)
      if (input.provider === 'limited') {
        const chunks = [
          { type: 'finish', reason: { kind: 'error', failure: { message: '429 soft_rate', code: 'RATE_LIMIT' } } },
        ]
        return (async function* () { for (const c of chunks) yield c })()
      }
      const chunks = [
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: answer },
        { type: 'finish', reason: { kind: 'stop' } },
      ]
      return (async function* () { for (const c of chunks) yield c })()
    },
  }
  const svc = createPromptCompiler({ llm: host })
  const out = await svc.compile('写个爬虫')
  assert.equal(out.degraded, false)
  assert.equal(calls.filter(p => p === 'limited').length, 1, '限流的 provider 不应被重试第二次')
  assert.ok(calls.includes('good'), '应当换到可用的 provider')
})

test('回归⑧：无可选模型的 provider 应被跳过（空 listModels 不发调用）', async () => {
  const calls = []
  const host = {
    listProviders: () => [{ id: 'empty' }, { id: 'ok' }],
    listModels: async (p) => (p === 'empty' ? [] : [{ id: 'm' }]),
    stream(input) {
      calls.push(input.provider)
      const chunks = [
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: '## Task ok' },
        { type: 'finish', reason: { kind: 'stop' } },
      ]
      return (async function* () { for (const c of chunks) yield c })()
    },
  }
  const svc = createPromptCompiler({ llm: host })
  await svc.compile('写个爬虫')
  assert.ok(!calls.includes('empty'), '空目录 provider 不应被调用')
  assert.ok(calls.includes('ok'))
})

// —— 2026-10-14 用户 UI 实测反馈（截图）暴露的问题，回归测试 ——

const goodMarkdown = [
  '## Task',
  '抓取新闻标题与链接。',
  '',
  '## Constraints',
  '- 仅使用 HTTP GET。',
  '- 遵守 robots.txt 规则。',
  '',
  '## Output Format',
  '每行一条 JSON。',
  '',
  '## Acceptance Criteria',
  '1. 每条含非空 title。',
  '2. 无重复。',
].join('\n')

test('回归⑨（问题5/问题2）：LLM 输出的 markdown 结构必须原样保留，不得被压平', async () => {
  const svc = createPromptCompiler({ llm: hostReturning(goodMarkdown) })
  const out = await svc.compile('写个爬虫')
  // 核心不变量：四个标题各占一行
  for (const h of ['## Task', '## Constraints', '## Output Format', '## Acceptance Criteria']) {
    assert.ok(out.compiled.includes(h + '\n'), `标题 "${h}" 后应换行（未被粘上正文）`)
  }
  // 标题不得与正文挤在同一行（注意：\s 含 \n，必须用 [^\S\n] 只匹配同行空白）
  assert.ok(!/## Task[^\S\n]+\S/.test(out.compiled), '## Task 被粘上了正文')
  // robots.txt 不得被拆成两行
  assert.ok(out.compiled.includes('robots.txt'), 'robots.txt 被句点误切断了')
  assert.ok(!/robots\.\n/.test(out.compiled), 'robots. 后面不应换行')
  // 列表序号不得孤立成行
  assert.ok(!/## Acceptance Criteria\s+1\.\s*\n/.test(out.compiled), '标题后挂了孤立序号')
})

test('回归⑩（问题5）：模型把标题与正文写在同一行时应自动拆开', async () => {
  const messy = '## Task 抓取新闻。\n## Constraints - 仅 GET。\n## Output Format 每行 JSON。\n## Acceptance Criteria 1. x'
  const svc = createPromptCompiler({ llm: hostReturning(messy) })
  const out = await svc.compile('写个爬虫')
  assert.ok(out.compiled.includes('## Task\n'), '## Task 应独占一行')
  assert.ok(out.compiled.includes('抓取新闻。'), '正文应保留')
  assert.ok(out.compiled.includes('## Acceptance Criteria\n1. x'), '序号应从标题拆到下一行')
})

test('回归⑪（问题3）：diag 必须暴露实际使用的模型，供 UI 显示徽章', async () => {
  const host = {
    listProviders: () => [{ id: 'workbuddy' }],
    listModels: async () => [{ id: 'hy3-x' }],
    stream() {
      const chunks = [
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: goodMarkdown },
        { type: 'finish', reason: { kind: 'stop' } },
      ]
      return (async function* () { for (const c of chunks) yield c })()
    },
  }
  const svc = createPromptCompiler({ llm: host })
  const out = await svc.compile('写个爬虫')
  assert.equal(out.diag.providerUsed, 'workbuddy')
  assert.equal(out.diag.modelUsed, 'hy3-x', 'diag.modelUsed 应记录实际模型（徽章数据源）')
  assert.equal(out.diag.usedModelLabel, 'workbuddy/hy3-x')
})

test('回归⑫（问题2）：规则降级路径仍应输出四段结构（tidyDraft 只用于 draft）', async () => {
  const svc = createPromptCompiler(null) // 无 LLM → 规则降级
  const out = await svc.compile('帮我写个爬虫')
  assert.equal(out.degraded, true)
  assert.ok(out.compiled.includes('## Task'), '规则路径应有四段结构')
  assert.ok(out.compiled.includes('## Constraints'))
  assert.ok(out.compiled.includes('## Output Format'))
})

/** 造一个按 StreamChunk 契约吐单段文本的假宿主。 */
function hostReturning(text) {
  return {
    listProviders: () => [{ id: 'workbuddy' }],
    listModels: async () => [{ id: 'hy3-x' }],
    stream() {
      const chunks = [
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text },
        { type: 'finish', reason: { kind: 'stop' } },
      ]
      return (async function* () { for (const c of chunks) yield c })()
    },
  }
}

