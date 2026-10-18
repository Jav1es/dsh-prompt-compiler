'use strict'

// E4 自动模式测试（安全边界为主）。
//
// 🔴 这个功能的**主要风险不是"不工作"，而是"工作了但改错了"**：
//   `agent/pre-step` 能把用户消息整体替换后交给模型。一旦实现有 bug，
//   用户说的和他以为模型听到的不一致，而且**没有任何报错**。
//
// 因此本文件的重点：
//   ① 默认必须**根本不注册监听**（不是注册了再 return）；
//   ② 即便开启，也必须**只追加、不替换、不删除**（"模型听到的 ⊇ 用户说的"）；
//   ③ 下游的 reject 决策必须原样尊重（无权推翻别的插件）；
//   ④ 自身出错必须**原样放行**，不能让用户的对话失败。

const test = require('node:test')
const assert = require('node:assert/strict')
const { installAutoMode, readAutoMode, buildHint, extractText } = require('../lib/auto-mode.js')

/** 造一个记录监听的 ctx。 */
function fakeCtx() {
  const listeners = []
  return {
    listeners,
    on(name, fn) {
      listeners.push({ name, fn })
      return () => {
        const i = listeners.findIndex(l => l.fn === fn)
        if (i >= 0) listeners.splice(i, 1)
      }
    },
  }
}

const USER_MSG = { id: 'm1', role: 'user', source: { kind: 'user' }, content: '帮我写个爬虫把新闻抓下来' }

function enter(messages) {
  return { kind: 'enter', messages }
}
const nextOf = decision => async () => decision

// ---------------------------------------------------------------- 默认关闭

test('E4 默认：完全没配置时，不注册任何监听（不是注册了再 return）', () => {
  const ctx = fakeCtx()
  const r = installAutoMode(ctx, {})
  assert.equal(r.enabled, false)
  assert.equal(r.reason, 'disabled')
  assert.equal(ctx.listeners.length, 0, '默认路径下不该注册监听，哪怕只是空跑')
})

test('E4 默认：只写 enabled=true 不够，必须双钥匙', () => {
  const ctx = fakeCtx()
  const r = installAutoMode(ctx, { auto: { enabled: true } })
  assert.equal(r.enabled, false)
  assert.equal(r.reason, 'risk_not_acknowledged')
  assert.equal(ctx.listeners.length, 0, '风险未确认时不得注册监听')
})

test('E4 默认：只写 iUnderstandTheRisk=true 也不够', () => {
  const ctx = fakeCtx()
  const r = installAutoMode(ctx, { auto: { iUnderstandTheRisk: true } })
  assert.equal(r.enabled, false)
  assert.equal(r.reason, 'disabled')
  assert.equal(ctx.listeners.length, 0)
})

test('E4 默认：非布尔真值（"true" 字符串、1）都不算开启', () => {
  for (const v of ['true', 1, 'yes', {}]) {
    const r = readAutoMode({ enabled: v, iUnderstandTheRisk: true })
    assert.equal(r.enabled, false, `enabled=${JSON.stringify(v)} 被当成了 true`)
  }
})

test('E4 开启：双钥匙都置位才注册监听', () => {
  const ctx = fakeCtx()
  const r = installAutoMode(ctx, { auto: { enabled: true, iUnderstandTheRisk: true }, log() {} })
  assert.equal(r.enabled, true)
  assert.equal(ctx.listeners.length, 1)
  assert.equal(ctx.listeners[0].name, 'agent/pre-step')
  assert.equal(typeof r.dispose, 'function')
})

// ---------------------------------------------------------------- 只追加，不替换

test('E4 核心不变量：原有消息一条不少、一条不改，只在末尾追加', async () => {
  const ctx = fakeCtx()
  installAutoMode(ctx, { auto: { enabled: true, iUnderstandTheRisk: true }, log() {} })
  const fn = ctx.listeners[0].fn

  const original = [USER_MSG, { id: 'm2', role: 'assistant', content: '好的' }]
  const snapshot = JSON.parse(JSON.stringify(original))

  const out = await fn({ agent: {}, messages: original, turn: 1, signal: null }, nextOf(enter(original)))

  assert.equal(out.kind, 'enter')
  assert.ok(out.messages.length > original.length, '应当追加了内容')
  // 前缀逐条相等 —— 这比"长度对"更严格
  for (let i = 0; i < snapshot.length; i += 1) {
    assert.deepEqual(out.messages[i], snapshot[i], `第 ${i} 条消息被改动了`)
  }
  // 原数组本身不得被就地修改
  assert.deepEqual(original, snapshot, '实现不得就地修改传入的 messages 数组')
})

test('E4：用户消息已含验收标准时不追加（不做无谓打扰）', async () => {
  const ctx = fakeCtx()
  installAutoMode(ctx, { auto: { enabled: true, iUnderstandTheRisk: true }, log() {} })
  const fn = ctx.listeners[0].fn
  const msg = { id: 'm1', role: 'user', content: '抓取新闻标题。验收标准：连续跑三天不报错。' }
  const out = await fn({ messages: [msg], turn: 1, signal: null }, nextOf(enter([msg])))
  assert.equal(out.messages.length, 1, '已有验收标准却仍追加了提示')
})

test('E4：极短输入（"继续"）不追加提示', async () => {
  const ctx = fakeCtx()
  installAutoMode(ctx, { auto: { enabled: true, iUnderstandTheRisk: true }, log() {} })
  const fn = ctx.listeners[0].fn
  const msg = { id: 'm1', role: 'user', content: '继续' }
  const out = await fn({ messages: [msg], turn: 1, signal: null }, nextOf(enter([msg])))
  assert.equal(out.messages.length, 1)
})

// ---------------------------------------------------------------- 尊重下游与自身容错

test('E4：下游 reject 必须原样返回（无权推翻别的插件）', async () => {
  const ctx = fakeCtx()
  installAutoMode(ctx, { auto: { enabled: true, iUnderstandTheRisk: true }, log() {} })
  const fn = ctx.listeners[0].fn
  const out = await fn({ messages: [USER_MSG], turn: 1, signal: null }, nextOf({ kind: 'reject' }))
  assert.deepEqual(out, { kind: 'reject' })
})

test('E4：signal 已中止时不追加', async () => {
  const ctx = fakeCtx()
  installAutoMode(ctx, { auto: { enabled: true, iUnderstandTheRisk: true }, log() {} })
  const fn = ctx.listeners[0].fn
  const out = await fn(
    { messages: [USER_MSG], turn: 1, signal: { aborted: true } },
    nextOf(enter([USER_MSG]))
  )
  assert.equal(out.messages.length, 1)
})

test('E4：自身异常时原样放行（绝不让用户的对话失败）', async () => {
  const ctx = fakeCtx()
  installAutoMode(ctx, { auto: { enabled: true, iUnderstandTheRisk: true }, log() {} })
  const fn = ctx.listeners[0].fn
  // 造一个会让 buildHint 抛错的输入（content 是怪异的 getter）
  const evil = {
    get content() {
      throw new Error('boom')
    },
    role: 'user',
  }
  const decision = enter([evil])
  const out = await fn({ messages: [evil], turn: 1, signal: null }, nextOf(decision))
  assert.equal(out, decision, '出错时应原样返回下游结果')
})

test('E4：可被 dispose 卸载', () => {
  const ctx = fakeCtx()
  const r = installAutoMode(ctx, { auto: { enabled: true, iUnderstandTheRisk: true }, log() {} })
  assert.equal(ctx.listeners.length, 1)
  r.dispose()
  assert.equal(ctx.listeners.length, 0, 'dispose 后监听应被移除')
})

// ---------------------------------------------------------------- 工具函数

test('E4 extractText：只取 user 消息，字符串与块数组都能处理', () => {
  const text = extractText([
    { role: 'system', content: '不该被算进来' },
    { role: 'user', content: '字符串内容' },
    { role: 'user', content: [{ type: 'text', text: '块内容' }] },
  ])
  assert.ok(text.includes('字符串内容'))
  assert.ok(text.includes('块内容'))
  assert.ok(!text.includes('不该被算进来'), 'system 消息不该被计入用户需求')
})

test('E4 buildHint：空输入返回 null', () => {
  assert.equal(buildHint([]), null)
  assert.equal(buildHint([{ role: 'assistant', content: 'x' }]), null)
})
