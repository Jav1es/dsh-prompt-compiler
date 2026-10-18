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

// —— 2026-10-14 用户反馈：「配了外部模型 API，编译时还是本地」 ——
// 真因：compile 里外部模型**只在宿主失败后**才被调用（纯兜底），
// UI 文案却承诺「优先」。今新增 extPriority 开关，两种模式都要可验证。

const HOST_MD = '## Task 宿主模型产出\n## Constraints - a\n## Output Format - b\n## Acceptance Criteria 1. c'
const EXT_MD = '## Task 外部模型产出\n## Constraints - x\n## Output Format - y\n## Acceptance Criteria 1. z'

/** 起一个本地假 HTTP 端点，冒充 OpenAI 兼容服务，返回固定文本。 */
function startFakeEndpoint(text) {
  const http = require('node:http')
  const hits = { n: 0 }
  const server = http.createServer((req, res) => {
    hits.n++
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ choices: [{ message: { content: text } }] }))
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      resolve({
        url: 'http://127.0.0.1:' + port + '/v1/chat/completions',
        hits,
        close: () => new Promise((r) => server.close(r)),
      })
    })
  })
}

const EXT_CFG = (url) => ({ enabled: true, baseUrl: url, apiKey: '', model: 'fake-ext-model' })

test('回归⑬（核心）：extPriority=true 时外部模型必须被真正调用（宿主可用也不抢先）', async () => {
  const ep = await startFakeEndpoint(EXT_MD)
  try {
    const svc = createPromptCompiler({ llm: hostReturning(HOST_MD) })
    const out = await svc.compile('帮我写个爬虫', {
      external: EXT_CFG(ep.url),
      extPriority: true,
    })
    assert.ok(out.compiled.includes('外部模型产出'), '外部模型优先时应使用外部产出，实得：' + out.compiled.slice(0, 80))
    assert.equal(out.diag.source, 'external', 'diag.source 应为 external')
    assert.equal(out.diag.modelUsed, 'fake-ext-model')
    assert.equal(ep.hits.n, 1, '外部端点应被调用 1 次')
  } finally { await ep.close() }
})

test('回归⑭：extPriority 缺省/false 时保持宿主优先（外部不抢先）', async () => {
  const ep = await startFakeEndpoint(EXT_MD)
  try {
    const svc = createPromptCompiler({ llm: hostReturning(HOST_MD) })
    const out = await svc.compile('帮我写个爬虫', { external: EXT_CFG(ep.url) })
    assert.ok(out.compiled.includes('宿主模型产出'), '默认应宿主优先，实得：' + out.compiled.slice(0, 80))
    assert.equal(out.diag.source, 'host')
    assert.equal(ep.hits.n, 0, '宿主成功时不应调用外部端点')
  } finally { await ep.close() }
})

test('回归⑮：extPriority=true 但外部失败 → 自动回落宿主（不降级规则）', async () => {
  // 指向一个必然连不上的端口
  const svc = createPromptCompiler({ llm: hostReturning(HOST_MD) })
  const out = await svc.compile('帮我写个爬虫', {
    external: { enabled: true, baseUrl: 'http://127.0.0.1:1/v1/chat/completions', apiKey: '', model: 'nope' },
    extPriority: true,
  })
  assert.equal(out.degraded, false, '外部失败后应回落宿主而不是降级规则')
  assert.ok(out.compiled.includes('宿主模型产出'), '应回落到宿主产出')
  assert.equal(out.diag.source, 'host')
})

test('回归⑯：宿主优先模式下宿主失败 → 外部兜底生效', async () => {
  const ep = await startFakeEndpoint(EXT_MD)
  try {
    const deadHost = {
      listProviders: () => [{ id: 'p' }],
      listModels: async () => [{ id: 'm' }],
      stream() {
        const chunks = [{ type: 'finish', reason: { kind: 'error', failure: { message: 'boom', code: 'X' } } }]
        return (async function* () { for (const c of chunks) yield c })()
      },
    }
    const svc = createPromptCompiler({ llm: deadHost })
    const out = await svc.compile('帮我写个爬虫', { external: EXT_CFG(ep.url) })
    assert.ok(out.compiled.includes('外部模型产出'), '宿主失败时应由外部兜底')
    assert.equal(out.diag.source, 'external')
  } finally { await ep.close() }
})

test('回归⑰：本机 OpenAI 兼容端点（非 ollama 响应形状）必须能解析', async () => {
  // 真因：旧实现用 127.0.0.1 判定"这是 ollama"，只按 data.message.content 解析；
  // 而 LM Studio / vLLM / LocalAI 等在 localhost 上返回的是 OpenAI 形状
  // ⇒ 解析出空串 ⇒ 被当成失败 ⇒ 静默回落宿主（用户报的"配了外部还是本地"）。
  const ep = await startOpenAIEndpoint(EXT_MD)
  try {
    const svc = createPromptCompiler({ llm: hostReturning(HOST_MD) })
    const out = await svc.compile('帮我写个爬虫', { external: EXT_CFG(ep.url), extPriority: true })
    assert.ok(out.compiled.includes('外部模型产出'),
      'localhost 上的 OpenAI 形状响应应被正确解析，实得：' + out.compiled.slice(0, 80))
    assert.equal(out.diag.source, 'external')
  } finally { await ep.close() }
})

test('回归⑱：外部端点报错时，必须把原因暴露给 UI（不能静默回落）', async () => {
  const ep = await startErrorEndpoint(401, '{"error":{"message":"Invalid API key provided"}}')
  try {
    const svc = createPromptCompiler({ llm: hostReturning(HOST_MD) })
    const out = await svc.compile('帮我写个爬虫', { external: EXT_CFG(ep.url), extPriority: true })
    assert.equal(out.diag.source, 'host', '应回落到宿主')
    assert.ok(out.diag.extFailReason, 'diag.extFailReason 必须记录外部失败原因')
    assert.match(out.diag.extFailReason, /401/, '原因里应含 HTTP 状态码，便于用户自查')
    assert.match(out.diag.extFailReason, /Invalid API key/, '原因里应带端点返回的说明')
  } finally { await ep.close() }
})

test('回归⑲：ollama 形状（data.message.content）同样要能解析', async () => {
  const ep = await startOllamaEndpoint('## Task ollama 产出\n## Constraints - q')
  try {
    const svc = createPromptCompiler({ llm: hostReturning(HOST_MD) })
    const out = await svc.compile('帮我写个爬虫', { external: EXT_CFG(ep.url), extPriority: true })
    assert.ok(out.compiled.includes('ollama 产出'), 'ollama 形状应被解析')
    assert.equal(out.diag.source, 'external')
  } finally { await ep.close() }
})

/** 起一个返回 OpenAI 兼容形状的假端点。 */
function startOpenAIEndpoint(text) {
  return startHttp((req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ choices: [{ message: { content: text } }] }))
  })
}
/** 起一个返回 ollama /api/chat 形状的假端点。 */
function startOllamaEndpoint(text) {
  return startHttp((req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ message: { content: text } }))
  })
}
/** 起一个固定返回错误的假端点。 */
function startErrorEndpoint(status, body) {
  return startHttp((req, res) => {
    res.statusCode = status
    res.setHeader('content-type', 'application/json')
    res.end(body || '')
  })
}
/** 通用假 HTTP 端点（随机端口，返回 url 与关闭句柄）。 */
function startHttp(handler) {
  const http = require('node:http')
  const server = http.createServer(handler)
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: 'http://127.0.0.1:' + server.address().port + '/v1/chat/completions',
        close: () => new Promise((r) => server.close(r)),
      })
    })
  })
}

// ---------------------------------------------------------------- 模板编译（render / listTemplates）
//
// render 与 compile 的分工：compile 走 LLM（不确定、需推理），render 走模板
// （确定、可复现、零成本）。这里同时验证"两者并存互不影响"——因为 render 是**新增**
// 能力，绝不能碰坏已被工具 / 路由 / README / 作品集消费的 compile。

test('render: 确定性渲染——同一输入两次结果必须完全一致（这正是它与 compile 的分工）', () => {
  const vars = { siteUrl: 'https://x.dev', targetRoles: ['A'] }
  const a = pc.render('portfolio-review', vars)
  const b = pc.render('portfolio-review', vars)
  assert.equal(a.ok, true, a.ok ? '' : a.errors.join('|'))
  assert.equal(a.text, b.text, 'render 必须确定性，否则"可复现"这个卖点不成立')
  assert.match(a.text, /https:\/\/x\.dev/)
  assert.equal(a.id, 'portfolio-review')
  assert.equal(typeof a.version, 'string')
})

test('render 与 compile 并存互不影响（compile 签名与行为零改动）', async () => {
  const c = await pc.compile('帮我写个爬虫', {})
  assert.equal(typeof c.compiled, 'string')
  assert.ok(c.compiled.length > 0)
  assert.equal(c.degraded, true, '无 llm 时仍应规则降级')
  // 同一实例上 render 依然可用
  assert.equal(pc.render('portfolio-review', { siteUrl: 'https://x.dev', targetRoles: ['A'] }).ok, true)
})

test('render: 失败返回结构化错误、不抛（模板不存在 / 缺必填）', () => {
  const nf = pc.render('nope', {})
  assert.equal(nf.ok, false)
  assert.ok(nf.errors.some(e => e.includes('未找到模板')))

  const bad = pc.render('portfolio-review', {})
  assert.equal(bad.ok, false)
  assert.ok(bad.errors.some(e => e.includes('siteUrl')), `应点名 siteUrl，实际：${bad.errors.join('|')}`)
})

test('listTemplates: 至少含 portfolio-review，且不回传模板正文', () => {
  const list = pc.listTemplates()
  assert.ok(Array.isArray(list))
  const pr = list.find(t => t.id === 'portfolio-review')
  assert.ok(pr, '应含 portfolio-review')
  assert.equal(pr.category, 'review')
  assert.equal(pr.template, undefined, '不得回传模板正文')
  assert.ok(pr.variables && pr.variables.properties, '应带变量 schema 供 UI 生成表单')
})

// —— F1 五维评分接入（analyze 带 before 分，compile 带 After 分 + delta） ——
// 核心不变量：**三条 compile 路径都必须带 scoreDelta**。
// 少哪条，Before/After 对比就会在那一档静默失效（UI 显示空白而不是报错）。

const GOOD_DRAFT =
  '目标：抓取 news.example.com 首页新闻标题。背景：给运营做每日速览，读者是非技术同学。' +
  '约束：仅用 Python requests + BeautifulSoup，超时 10 秒，不爬 robots.txt 禁止的页面。' +
  '输出格式：每行一条 JSON，字段 title/url。验收标准：连续跑 3 天，每天至少 20 条且字段非空。'

test('F1 · analyze 必须带 score5d（规则降级路径）', async () => {
  const out = await pc.analyze('帮我写个爬虫')
  assert.ok(out.score5d, 'analyze 结果缺 score5d')
  assert.equal(typeof out.score5d.total, 'number')
  for (const k of ['goal', 'context', 'constraint', 'acceptance', 'ambiguity']) {
    assert.ok(out.score5d.dims[k], `score5d 缺维度 ${k}`)
  }
})

test('F1 · analyze 必须带 score5d（LLM 路径）', async () => {
  const svc = createPromptCompiler({ llm: fakeHost() })
  const out = await svc.analyze('帮我写个爬虫')
  assert.equal(out.score, 77, 'LLM 的 score 仍保留在 score 字段（兼容旧消费者）')
  assert.ok(out.score5d, 'LLM 路径也要带 score5d')
  assert.notEqual(out.score5d.total, out.score, '五维分与 LLM 分不混算，不应恰好同值')
})

test('F1 · compile 带 scoreDelta（规则降级路径）', async () => {
  const out = await pc.compile('帮我写个爬虫')
  assert.ok(out.scoreDelta, 'compile 结果缺 scoreDelta')
  assert.equal(out.degraded, true)
  assert.equal(out.scoreDelta.total.after, out.score5d.total, 'after 必须等于结果自身的五维总分')
  assert.equal(out.scoreDelta.perDim && Object.keys(out.scoreDelta.perDim).length, 5, 'perDim 应含五个维度')
})

test('F1 · compile 带 scoreDelta（LLM 宿主路径）—— 三条路径都要有', async () => {
  const svc = createPromptCompiler({ llm: fakeHost() })
  const out = await svc.compile('帮我写个爬虫')
  assert.equal(out.degraded, false)
  assert.ok(out.scoreDelta, 'LLM 路径缺 scoreDelta')
  assert.equal(typeof out.scoreDelta.total.after, 'number')
})

test('F1 · 编译应当提升分数：完整 draft 的 After ≥ Before', async () => {
  const before = await pc.analyze(GOOD_DRAFT)
  const out = await pc.compile(GOOD_DRAFT)
  assert.ok(out.scoreDelta.total.after >= out.scoreDelta.total.before,
    `编译后反而掉分：${out.scoreDelta.total.before} → ${out.scoreDelta.total.after}`)
  assert.ok(before.score5d.total > 0, 'Good draft 的 before 分不应为 0（否则对比无意义）')
})

test('F1 · 五维分确定性：同一 draft 两次 analyze 完全相等（可进 CI）', async () => {
  const a = await pc.analyze(GOOD_DRAFT)
  const b = await pc.analyze(GOOD_DRAFT)
  assert.deepEqual(a.score5d, b.score5d)
})



