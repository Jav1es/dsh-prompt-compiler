'use strict'

// 设置层测试（lib/settings.js）。
//
// 这是 2026-10-14 新增的 host 侧持久化层：把原先散在浏览器 localStorage 的配置
// 收拢成一份宿主侧 JSON，供设置页与编译逻辑共用。
//
// 重点验证四件事：
//   ① 默认值姿态——不配置也能正常工作
//   ② 读-改-写只影响传入的分组，未传的保持原样
//   ③ 未知/损坏输入被 sanitize 掉，且绝不抛错（否则插件起不来）
//   ④ apiKey 绝不经 view() 回显明文

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

// 用临时 DSH_HOME 隔离，避免污染真实用户配置
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-settings-test-'))
process.env.DSH_HOME = TMP

const settings = require('../lib/settings.js')

test('默认值：未配置任何东西时给出完整、可用的默认姿态', () => {
  const s = settings.read()
  assert.equal(s.external.enabled, false, '默认不启用外部模型')
  assert.equal(s.external.priority, false, '默认宿主优先')
  assert.equal(s.compile.strongTemplate, true, '默认启用强化模板')
  assert.equal(s.format.dropReasoning, true, '默认丢弃思维链')
  assert.equal(s.diagnostics.showModelBadge, true, '默认显示模型徽章')
  assert.equal(s.behavior.autoApply, false, '默认不自动回填')
  // 分组齐全
  for (const g of ['external', 'compile', 'format', 'diagnostics', 'behavior']) {
    assert.ok(s[g] && typeof s[g] === 'object', `缺少分组 ${g}`)
  }
})

test('读-改-写：只覆盖传入的分组，其余保持原样', () => {
  settings.write(settings.DEFAULTS) // 先归零
  const r1 = settings.write({ compile: { targetModel: 'claude' } })
  assert.equal(r1.ok, true)
  assert.equal(settings.read().compile.targetModel, 'claude')
  assert.equal(settings.read().compile.strongTemplate, true, '未传的字段应保持默认')

  // 再改另一个分组，不应冲掉上一个分组
  settings.write({ format: { stripHeadings: true } })
  const after = settings.read()
  assert.equal(after.format.stripHeadings, true)
  assert.equal(after.compile.targetModel, 'claude', '改 format 不应影响 compile')
})

test('回归：只改分组内一个字段，不得清空同组其它字段（深合并）', () => {
  // 真因：write() 最初用 `{...cur, ...patch}` 做**浅**合并，patch.external 会整体
  // 替换 cur.external ⇒ 未 patch 的字段被 sanitize 回落默认值。
  // 实测症状：只改 external.model，enabled 变 false、baseUrl 变 ''。
  settings.write(settings.DEFAULTS)
  settings.write({
    external: { enabled: true, priority: true, baseUrl: 'http://x/y', model: 'llama3.2', apiKey: 'sk-k' },
  })

  settings.write({ external: { model: 'other' } })   // 只动一个字段
  const a = settings.read().external
  assert.equal(a.model, 'other', '被 patch 的字段应更新')
  assert.equal(a.enabled, true, 'enabled 不应被清空')
  assert.equal(a.priority, true, 'priority 不应被清空')
  assert.equal(a.baseUrl, 'http://x/y', 'baseUrl 不应被清空')
  assert.equal(a.apiKey, 'sk-k', 'apiKey 不应被清空')

  // 改别一个分组也不应影响本分组
  settings.write({ compile: { targetModel: 'claude' } })
  assert.equal(settings.read().external.baseUrl, 'http://x/y', '改 compile 不应影响 external')
})

test('sanitize：未知字段被丢弃，类型错误回退默认', () => {  const out = settings.sanitize({
    external: { enabled: 'yes', baseUrl: 123, bogus: 'x' },  // 类型全错 + 多余键
    compile: { targetModel: 'gpt', strongTemplate: 'nope' },
    nope: { a: 1 },                                          // 未知分组
  })
  assert.equal(out.external.enabled, false, '字符串 "yes" 不应被当成 true')
  assert.equal(out.external.baseUrl, '', '非字符串应回退默认')
  assert.equal(out.external.bogus, undefined, '未知键应被丢弃')
  assert.equal(out.compile.targetModel, 'gpt', '合法字符串应保留')
  assert.equal(out.compile.strongTemplate, true, '非法布尔应回退默认')
  assert.equal(out.nope, undefined, '未知分组应被丢弃')
})

test('read：文件损坏时不抛错，回退默认值', () => {
  fs.mkdirSync(path.dirname(settings.FILE), { recursive: true })
  fs.writeFileSync(settings.FILE, '{ this is not json', 'utf8')
  const s = settings.read()
  assert.equal(s.external.enabled, false, '损坏文件应回退默认')
  assert.equal(typeof s.compile.strongTemplate, 'boolean')
})

test('view：apiKey 绝不明文回显，只回传 apiKeySet 标志', () => {
  settings.write(settings.DEFAULTS)
  settings.write({ external: { apiKey: 'sk-secret-should-not-leak', baseUrl: 'http://x/y', model: 'm' } })
  const v = settings.view()
  assert.equal(v.external.apiKey, '', 'apiKey 不得回显明文')
  assert.equal(v.external.apiKeySet, true, '应告诉 UI "已配置"')
  assert.ok(JSON.stringify(v).indexOf('sk-secret-should-not-leak') === -1, '明文不得出现在任何字段里')
  // 但磁盘上确实存着（编译时要用）
  assert.equal(settings.read().external.apiKey, 'sk-secret-should-not-leak')
})

test('write：写入后能被 read 读回（含 apiKey）', () => {
  settings.write(settings.DEFAULTS)
  const r = settings.write({
    external: { enabled: true, priority: true, baseUrl: 'http://127.0.0.1:11434/api/chat', model: 'llama3.2', apiKey: 'k' },
  })
  assert.equal(r.ok, true)
  const back = settings.read()
  assert.equal(back.external.enabled, true)
  assert.equal(back.external.priority, true)
  assert.equal(back.external.model, 'llama3.2')
  assert.equal(back.external.apiKey, 'k')
})

test('applyUiPatch：apiKey 回传空串时必须保留原密钥（否则每次保存都会清空）', () => {
  settings.write(settings.DEFAULTS)
  settings.write({ external: { enabled: true, baseUrl: 'http://x/y', model: 'm', apiKey: 'sk-original' } })

  // 模拟设置页保存：view() 不回传明文，所以表单里 apiKey 天然是 ''
  const fromUi = {
    external: { enabled: true, priority: true, baseUrl: 'http://x/y', model: 'm-new', apiKey: '' },
  }
  const r = settings.applyUiPatch(fromUi)
  assert.equal(r.ok, true)
  const after = settings.read()
  assert.equal(after.external.apiKey, 'sk-original', '空串不应清空已保存的密钥')
  assert.equal(after.external.model, 'm-new', '其它字段应正常更新')
  assert.equal(after.external.priority, true)
})

test('applyUiPatch：显式给出新密钥时应覆盖', () => {
  settings.write(settings.DEFAULTS)
  settings.write({ external: { baseUrl: 'http://x/y', model: 'm', apiKey: 'sk-old' } })
  settings.applyUiPatch({ external: { apiKey: 'sk-new', baseUrl: 'http://x/y', model: 'm' } })
  assert.equal(settings.read().external.apiKey, 'sk-new')
})

// —— 与 compile 的联动：设置经 service 生效 ——

test('format.stripHeadings 生效：编译结果去掉 ## 标题行', async () => {
  const { createPromptCompiler } = require('../lib/service.js')
  const md = '## Task\n抓取新闻。\n\n## Constraints\n- 仅 GET。\n\n## Output Format\nJSON\n\n## Acceptance Criteria\n1. x'
  const host = {
    listProviders: () => [{ id: 'p' }],
    listModels: async () => [{ id: 'm' }],
    stream() {
      const chunks = [
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: md },
        { type: 'finish', reason: { kind: 'stop' } },
      ]
      return (async function* () { for (const c of chunks) yield c })()
    },
  }
  const svc = createPromptCompiler({ llm: host })

  const keep = await svc.compile('d', { format: { stripHeadings: false } })
  assert.ok(keep.compiled.includes('## Task'), '关闭时应保留标题')

  const stripped = await svc.compile('d', { format: { stripHeadings: true } })
  assert.ok(!/^#{1,6}\s/m.test(stripped.compiled), '开启时不应再有标题行')
  assert.ok(stripped.compiled.includes('抓取新闻'), '正文必须保留')
})

test('compile.strongTemplate=false 时改用温和提示词（不主动改写）', async () => {
  const { createPromptCompiler } = require('../lib/service.js')
  let seenSystem = ''
  const host = {
    listProviders: () => [{ id: 'p' }],
    listModels: async () => [{ id: 'm' }],
    stream(input) {
      seenSystem = input.messages[0].content[0].text
      const chunks = [
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: '## Task\nx' },
        { type: 'finish', reason: { kind: 'stop' } },
      ]
      return (async function* () { for (const c of chunks) yield c })()
    },
  }
  const svc = createPromptCompiler({ llm: host })

  await svc.compile('d', { strongTemplate: true })
  assert.ok(seenSystem.includes('真改写'), '强化模式应要求真改写')

  await svc.compile('d', { strongTemplate: false })
  assert.ok(seenSystem.includes('整理'), '温和模式应只做整理')
  assert.ok(!seenSystem.includes('真改写，不照搬'), '温和模式不应含强化原则')
})
