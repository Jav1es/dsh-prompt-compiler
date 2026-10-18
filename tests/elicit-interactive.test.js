'use strict'

// E2 交互式澄清测试。
//
// 🔴 这组测试的重点不是"顺利问到答案"，而是**问不到的时候会不会崩**：
//   本插件是 agentless 的，官方文档明确 `ctx.userQuestions.ask()` 在无 answerer 时抛
//   `NO_PROVIDER`；在 subagent 里调用还会 `DELEGATED_CALLER`。
//   所以每一条失败路径都要有测试 —— 插件绝不能因为"问不到用户"就让整个编译链路失败。

const test = require('node:test')
const assert = require('node:assert/strict')
const { createPromptCompiler } = require('../lib/service.js')

const VAGUE = '帮我写个爬虫'

/** 造一个能正常作答的 ctx.userQuestions。 */
function fakeUserQuestions(respond) {
  const asked = []
  return {
    asked,
    ask: async req => {
      asked.push(req)
      return respond ? respond(req) : { answer: `关于 ${req.id} 的答案` }
    },
  }
}

test('E2 · 无 userQuestions 服务：不抛错，退回问题列表（agentless 常态）', async () => {
  const pc = createPromptCompiler(null)
  const r = await pc.elicitInteractive(VAGUE)
  assert.equal(r.asked, false)
  assert.equal(r.reason, 'no_user_questions')
  assert.ok(r.questions.length >= 1, '仍应返回问题列表供 UI 自行渲染')
  assert.equal(r.draft, VAGUE, '没问到就不能篡改 draft')
})

test('E2 · NO_PROVIDER：不抛错，标注原因', async () => {
  const ctx = {
    userQuestions: {
      ask: async () => {
        const e = new Error('no provider')
        e.code = 'NO_PROVIDER'
        throw e
      },
    },
  }
  const pc = createPromptCompiler(ctx)
  const r = await pc.elicitInteractive(VAGUE)
  assert.equal(r.asked, false)
  assert.equal(r.reason, 'ask_failed')
  assert.match(r.error, /NO_PROVIDER/)
  assert.ok(r.questions.length >= 1)
})

test('E2 · DELEGATED_CALLER：同样安全降级', async () => {
  const ctx = {
    userQuestions: {
      ask: async () => {
        const e = new Error('delegated')
        e.code = 'DELEGATED_CALLER'
        throw e
      },
    },
  }
  const pc = createPromptCompiler(ctx)
  const r = await pc.elicitInteractive(VAGUE)
  assert.equal(r.asked, false)
  assert.match(r.error, /DELEGATED_CALLER/)
})

test('E2 · 正常作答：asked=true，draft 被拼上答案', async () => {
  const uq = fakeUserQuestions()
  const pc = createPromptCompiler({ userQuestions: uq })
  const r = await pc.elicitInteractive(VAGUE)
  assert.equal(r.asked, true)
  assert.equal(r.reason, 'ok')
  assert.equal(uq.asked.length, r.questions.length, '每一题都应当真的问出去')
  assert.ok(r.draft.startsWith(VAGUE), '答案必须拼在原 draft 之后，不能替换原文')
  assert.ok(Object.keys(r.answers).length >= 1)
})

test('E2 · 提问时带上 source/detail：用户看得到"为什么要答这一题"', async () => {
  const uq = fakeUserQuestions()
  const pc = createPromptCompiler({ userQuestions: uq })
  await pc.elicitInteractive(VAGUE)
  assert.ok(uq.asked.length >= 1)
  for (const req of uq.asked) {
    assert.equal(req.source && req.source.kind, 'plugin')
    assert.equal(req.source.plugin, 'dsh-prompt-compiler')
    assert.ok(req.question, '缺 question 文本')
    // 说明放在 detail 而非 why：宿主提问协议的字段名是 detail，
    // 本插件内部叫 why（更直白），对外传参用协议的字段名。
    assert.ok(req.detail, '缺 detail 说明（为什么要答这一题）')
    assert.ok(req.id, '缺 id，答案无法按题归位')
  }
})

test('E2 · 用户全部跳过：asked=false，draft 保持原样（不污染）', async () => {
  const pc = createPromptCompiler({ userQuestions: { ask: async () => null } })
  const r = await pc.elicitInteractive(VAGUE)
  assert.equal(r.asked, false)
  assert.equal(r.reason, 'declined')
  assert.equal(r.draft, VAGUE, '用户跳过时绝不能往 draft 里塞东西')
})

test('E2 · 部分成功后失败：已拿到的答案必须保住（reason=partial）', async () => {
  let n = 0
  const ctx = {
    userQuestions: {
      ask: async () => {
        n += 1
        if (n === 1) return { answer: '第一个答案' }
        const e = new Error('boom')
        e.code = 'ASK_FAILED'
        throw e
      },
    },
  }
  const pc = createPromptCompiler(ctx)
  const r = await pc.elicitInteractive(VAGUE)
  assert.equal(r.asked, true)
  assert.equal(r.reason, 'partial')
  assert.equal(Object.keys(r.answers).length, 1, '已经问到的答案不能因为后面的失败被丢弃')
})

test('E2 · shouldStop：调用方可在两题之间中止', async () => {
  const uq = fakeUserQuestions()
  const pc = createPromptCompiler({ userQuestions: uq })
  const r = await pc.elicitInteractive(VAGUE, { shouldStop: () => true })
  assert.equal(uq.asked.length, 1, 'shouldStop 返回 true 后不应继续问')
  assert.equal(r.asked, true)
})

test('E2 · 返回值形态容错：字符串 / {answer} / {value} / {selected[]}', async () => {
  const shapes = ['纯字符串答案', { answer: 'a' }, { value: 'v' }, { selected: ['x', 'y'] }]
  for (const shape of shapes) {
    const pc = createPromptCompiler({ userQuestions: { ask: async () => shape } })
    const r = await pc.elicitInteractive(VAGUE, { shouldStop: () => true })
    assert.equal(r.asked, true, `形态 ${JSON.stringify(shape)} 没被识别成有效答案`)
    assert.ok(Object.values(r.answers)[0].length > 0)
  }
})

test('E2 · 认不出的返回形态按"未答"处理，不猜测', async () => {
  const pc = createPromptCompiler({ userQuestions: { ask: async () => ({ unknown: 1 }) } })
  const r = await pc.elicitInteractive(VAGUE)
  assert.equal(r.asked, false)
  assert.equal(r.draft, VAGUE)
})

test('E2 · 澄清之后 compile 能吃到补充信息（端到端串起来）', async () => {
  const uq = fakeUserQuestions(req =>
    req.id === 'goal' ? { answer: '抓取 example.com 的新闻标题与链接' } : null
  )
  const pc = createPromptCompiler({ userQuestions: uq })
  const r = await pc.elicitInteractive(VAGUE)
  assert.ok(r.draft.includes('example.com'), '补充的答案应出现在 draft 里')

  const compiled = await pc.compile(r.draft)
  const plain = await pc.compile(VAGUE)
  assert.ok(
    compiled.scoreDelta.total.before > plain.scoreDelta.total.before,
    `澄清后 before 分应更高：${compiled.scoreDelta.total.before} vs ${plain.scoreDelta.total.before}`
  )
})

// 🔴 红线测试：绝不能把 userQuestions 声明为必需服务。
//
// Cordis 的 inject 是**必需**语义（源码：未激活时抛 `cannot get required service`）。
// 而 `@deepseek-ai/dsh-user-questions` 在官方包清单里是**可选组件**（default: no）。
// 一旦写进 exports.inject，所有没装该组件的宿主都会**拒绝激活本插件** ——
// 为了一个可选增强能力砸掉整个插件，这是绝不能犯的错。
test('E2 红线：exports.inject 不得包含 userQuestions（否则无该组件的宿主直接起不来）', () => {
  const plugin = require('../lib/index.js')
  const inject = Array.isArray(plugin.inject) ? plugin.inject : []
  assert.ok(
    !inject.includes('userQuestions'),
    `exports.inject 含 userQuestions —— 会让未安装可选组件 dsh-user-questions 的宿主拒绝激活插件。` +
      `当前 inject=${JSON.stringify(inject)}`
  )
})

test('E2 · 有 askTimed 时优先用 askTimed（带时限，不吊死编译链路）', async () => {
  const calls = []
  const ctx = {
    userQuestions: {
      // 故意让 ask() 抛错：如果实现走了 ask，本测试会红
      ask: async () => {
        throw new Error('不应该调用无时限的 ask')
      },
      askTimed: async req => {
        calls.push(req)
        return { answer: '时限内作答' }
      },
    },
  }
  const pc = createPromptCompiler(ctx)
  const r = await pc.elicitInteractive(VAGUE, { shouldStop: () => true })
  assert.equal(r.asked, true)
  assert.ok(calls.length === 1, '应当调用 askTimed')
  assert.equal(typeof calls[0].timeout, 'number', 'askTimed 必须带 timeout')
  assert.ok(calls[0].timeout > 0)
})

test('E2 · 只有 ask（无 askTimed）时退回 ask，不报错', async () => {
  const pc = createPromptCompiler({ userQuestions: { ask: async () => ({ answer: 'ok' }) } })
  const r = await pc.elicitInteractive(VAGUE, { shouldStop: () => true })
  assert.equal(r.asked, true)
})

test('E2 · 宿主 ctx 访问 userQuestions 就抛错时，仍安全降级', async () => {
  const ctx = {
    get userQuestions() {
      throw new Error('cannot get property "userQuestions" without inject')
    },
  }
  const pc = createPromptCompiler(ctx)
  const r = await pc.elicitInteractive(VAGUE)
  assert.equal(r.asked, false)
  assert.equal(r.reason, 'no_user_questions')
  assert.ok(r.questions.length >= 1)
})
