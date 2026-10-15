'use strict'

// 模板引擎测试（lib/templates.js）。
//
// 这是「模板编译」能力的核心：compile(draft) 走 LLM（不确定），
// render(id, vars) 走模板（确定、可复现、零成本）。评审类任务属于后者。
//
// 重点验证五件事：
//   ① 🔴 **未定义变量必须报错**，不能静默渲染成空串
//      —— 起因：portfolio-review 的设计里模板用了 role/task/dimensions，
//         但变量表里三个都没定义。静默渲染会产出"看起来正常、实则缺段"的 prompt，
//         这种失败极难发现，所以要有专门的回归用例。
//   ② 点路径 / each / if / 转义 等语法行为正确
//   ③ 校验拦得住缺必填、类型不符、嵌套缺字段、空数组当缺失
//   ④ defaults ← vars 的深合并语义（数组整体替换、undefined 不覆盖）
//   ⑤ 模板本身写错时是**开发期错误**：跳过并告警，绝不让插件起不来

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  createRegistry, renderString, validateVars, validateTemplateShape,
  auditTemplate, deepMerge, getPath, normalizeType,
} = require('../lib/templates.js')

// ---------------------------------------------------------------- getPath

test('getPath：点路径、缺失键、键存在但值为 undefined 要能区分', () => {
  assert.deepEqual(getPath({ a: { b: 'x' } }, 'a.b'), { found: true, value: 'x' })
  assert.equal(getPath({ a: {} }, 'a.b').found, false, '缺键 → found:false')
  assert.equal(getPath({}, 'a').found, false)
  assert.equal(getPath({ a: 1 }, 'a.b').found, false, '中间不是对象 → found:false')
  // 键存在、值是 undefined：found 应为 true —— 这样能区分"没给"与"给了 undefined"
  assert.equal(getPath({ a: undefined }, 'a').found, true)
  assert.equal(getPath({ a: { b: undefined } }, 'a.b').found, true)
})

// ---------------------------------------------------------------- deepMerge

test('deepMerge：嵌套合并、数组整体替换、undefined 不覆盖', () => {
  assert.deepEqual(deepMerge({ a: { b: 1, c: 2 } }, { a: { b: 9 } }), { a: { b: 9, c: 2 } })
  assert.deepEqual(deepMerge({ a: [1, 2] }, { a: [3] }), { a: [3] }, '数组整体替换，不逐元素合并')
  assert.deepEqual(deepMerge({ a: 1 }, { a: undefined }), { a: 1 }, 'undefined = 不覆盖')
  assert.deepEqual(deepMerge({ a: 1 }, null), { a: 1 }, 'given 非对象时返回 base 副本')
  const base = { a: { b: 1 } }
  const out = deepMerge(base, { a: { c: 2 } })
  assert.equal(base.a.c, undefined, '不得改动传入的 base')
  assert.deepEqual(out, { a: { b: 1, c: 2 } })
})

// ---------------------------------------------------------------- 校验

test('validateVars：缺必填 / 类型不符 / 空数组当缺失', () => {
  const schema = {
    properties: {
      siteUrl: { type: 'string', required: true, description: '主页地址' },
      targetRoles: { type: 'string[]', required: true },
      optional: { type: 'string' },
    },
  }
  const missing = validateVars(schema, {})
  assert.equal(missing.ok, false)
  assert.ok(missing.errors.some(e => e.includes('siteUrl')), '应报出缺 siteUrl')
  assert.ok(missing.errors.some(e => e.includes('主页地址')), '错误信息应带上 description')

  assert.equal(validateVars(schema, { siteUrl: 'https://x', targetRoles: [] }).ok, false,
    'required 的数组为空 → 视为缺失')
  assert.equal(validateVars(schema, { siteUrl: 'https://x', targetRoles: ['a'] }).ok, true)
  assert.equal(validateVars(schema, { siteUrl: 123, targetRoles: ['a'] }).ok, false, '类型不符')
  assert.equal(validateVars(schema, { siteUrl: 'x', targetRoles: [1] }).ok, false, '元素类型不符')
})

test('validateVars：嵌套对象报错要带上父级路径', () => {
  const schema = {
    properties: {
      background: { type: 'object', properties: { years: { type: 'string', required: true } } },
    },
  }
  const r = validateVars(schema, { background: {} })
  assert.equal(r.ok, false)
  assert.ok(r.errors.some(e => e.includes('background.years')), `应带父级路径，实际：${r.errors.join('|')}`)
})

test('normalizeType：接受 "string[]" 简写与标准写法两种', () => {
  assert.deepEqual(normalizeType({ type: 'string[]' }), { type: 'array', items: { type: 'string' } })
  assert.deepEqual(
    normalizeType({ type: 'array', items: { type: 'string' } }),
    { type: 'array', items: { type: 'string' } }
  )
})

// ---------------------------------------------------------------- 渲染

test('renderString：变量与点路径', () => {
  assert.equal(renderString('{{a}}', { a: 'x' }).text, 'x')
  assert.equal(renderString('{{a.b.c}}', { a: { b: { c: 'deep' } } }).text, 'deep')
  assert.equal(renderString('数组：{{xs}}', { xs: ['a', 'b'] }).text, '数组：a、b')
  assert.deepEqual(renderString('{{a}}', { a: 'x' }).errors, [])
})

test('renderString：each 支持标量、对象、index/@index', () => {
  assert.equal(renderString('{{#each xs}}{{.}},{{/each}}', { xs: ['a', 'b'] }).text, 'a,b,')
  assert.equal(
    renderString('{{#each xs}}{{index}}. {{.}}\n{{/each}}', { xs: ['a', 'b'] }).text,
    '1. a\n2. b\n',
    'index 是 1 基（便于写「1. 2. 3.」）'
  )
  assert.equal(renderString('{{#each xs}}{{@index}}:{{/each}}', { xs: ['a'] }).text, '0:',
    '@index 是 0 基（Handlebars 惯例）')
  assert.equal(
    renderString('{{#each xs}}{{name}}={{val}};{{/each}}', { xs: [{ name: 'A', val: 1 }, { name: 'B', val: 2 }] }).text,
    'A=1;B=2;'
  )
})

test('renderString：if 与嵌套 each', () => {
  assert.equal(renderString('{{#if ok}}Y{{/if}}', { ok: true }).text, 'Y')
  assert.equal(renderString('{{#if ok}}Y{{/if}}', { ok: false }).text, '')
  assert.equal(renderString('{{#if ok}}Y{{/if}}', { ok: '' }).text, '')
  // 空数组 / 空对象按"没有内容"处理（与 Handlebars 对齐）——
  // 否则 {{#if background.metrics}} 会渲染出 "- 量化成果：" 这种空条目
  assert.equal(renderString('{{#if xs}}Y{{/if}}', { xs: [] }).text, '', '空数组视为假')
  assert.equal(renderString('{{#if o}}Y{{/if}}', { o: {} }).text, '', '空对象视为假')
  assert.equal(renderString('{{#if xs}}Y{{/if}}', { xs: ['a'] }).text, 'Y', '非空数组视为真')
  assert.equal(
    renderString('{{#each gs}}{{#each items}}{{.}}{{/each}}|{{/each}}', { gs: [{ items: ['a', 'b'] }, { items: ['c'] }] }).text,
    'ab|c|'
  )
})

test('renderString：\\{{ 转义输出字面量 {{', () => {
  assert.equal(renderString('\\{{a}}', { a: 'x' }).text, '{{a}}')
  assert.equal(renderString('前缀 \\{{not-a-var}} 后缀', {}).errors.length, 0,
    '转义后的 {{x}} 不应被当成变量（否则会误报未定义）')
  // 双反斜杠 = 字面量反斜杠 + 被转义的标签
  assert.equal(renderString('\\\\{{a}}', { a: 'x' }).text, '\\{{a}}')
})

// ---------------------------------------------------------------- 🔴 核心回归

test('🔴 核心回归：漏定义 role / dimensions（用户原设计就有的坑）必须被拦住', () => {
  const tpl = '# 角色\n你是{{role}}。\n{{#each dimensions}}{{index}}. {{name}}\n{{/each}}'
  const t = { id: 'x', template: tpl, defaults: {}, variables: { properties: {} } }

  // 第一层：静态审计 —— 输出位与循环位**都能**抓到
  const audit = auditTemplate(t)
  assert.equal(audit.ok, false, '应判定不合规')
  assert.ok(audit.missing.includes('role'), `审计应抓到 role，实际：${audit.missing.join('|')}`)
  assert.ok(audit.missing.includes('dimensions'), `审计应抓到 dimensions，实际：${audit.missing.join('|')}`)

  // 第二层：运行时 —— 输出位的 role 直接报错，不会静默变空
  assert.ok(renderString(tpl, {}).errors.some(e => e.includes('role')),
    '输出位缺变量必须报错（这是最难发现的一类失败）')

  // —— 正对照：防止审计"永远报警"的假阳性 ——
  assert.equal(
    auditTemplate({ id: 'a', template: '{{a}}{{#each xs}}{{.}}{{/each}}', defaults: { a: '1', xs: ['x'] }, variables: { properties: {} } }).ok,
    true, 'defaults 里有出处 → 应通过'
  )
  assert.equal(
    auditTemplate({ id: 'b', template: '{{siteUrl}}', defaults: {}, variables: { properties: { siteUrl: { type: 'string' } } } }).ok,
    true, '声明在 variables.properties 里也算有出处'
  )
  assert.equal(
    auditTemplate({ id: 'c', template: '{{#each xs}}{{name}}/{{@index}}{{/each}}', defaults: { xs: [{ name: 'a' }] }, variables: { properties: {} } }).ok,
    true, 'each 体内引用元素字段不应误报'
  )
  assert.equal(
    auditTemplate({ id: 'd', template: '{{background.years}}', defaults: {}, variables: { properties: { background: { type: 'object', properties: { years: { type: 'string' } } } } } }).ok,
    true, '嵌套 properties 应能逐段下钻'
  )
})

test('未定义变量：输出位报错，条件位/循环位按"缺失=空"处理（规则刻意不同）', () => {
  // 输出位：缺 → 报错（静默变空最危险）
  assert.ok(renderString('{{nope}}', {}).errors.some(e => e.includes('nope')))

  // 条件位：缺 → 假，**不报错**。{{#if x}} 本就是"有才渲染"的惯用法，
  // 若这里也报错，可选变量就没法写（portfolio-review 的 coreSkills / background.* 正是如此）
  assert.deepEqual(renderString('{{#if nope}}Y{{/if}}', {}).errors, [])
  assert.equal(renderString('{{#if nope}}Y{{/if}}', {}).text, '')

  // 循环位：缺 → 空列表，同样不报错
  assert.deepEqual(renderString('{{#each nope}}{{.}}{{/each}}', {}).errors, [])
  assert.equal(renderString('{{#each nope}}{{.}}{{/each}}', {}).text, '')

  // 但"给了非数组"是类型误用，要报错
  assert.ok(renderString('{{#each notArr}}{{.}}{{/each}}', { notArr: 'str' }).errors.some(e => e.includes('不是数组')))

  // 块未闭合
  const unclosed = renderString('{{#each xs}}x', { xs: [] })
  assert.ok(unclosed.errors.some(e => e.includes('没有对应的')), `块未闭合要报错，实际：${unclosed.errors.join('|')}`)
})

// ---------------------------------------------------------------- 注册表

const SAMPLE = {
  id: 'demo',
  version: '1.0.0',
  category: 'review',
  title: '示例模板',
  description: '用于测试',
  variables: {
    properties: {
      target: { type: 'string', required: true, description: '目标' },
      items: { type: 'string[]' },
    },
  },
  defaults: { items: ['默认一', '默认二'], role: '评审员' },
  template: '你是{{role}}，评审{{target}}：\n{{#each items}}{{index}}. {{.}}\n{{/each}}',
}

test('注册表：渲染成功路径 + defaults 生效', () => {
  const reg = createRegistry([SAMPLE])
  const r = reg.render('demo', { target: '主页' })
  assert.equal(r.ok, true, r.ok ? '' : r.errors.join('|'))
  assert.match(r.text, /你是评审员/)
  assert.match(r.text, /评审主页/)
  assert.match(r.text, /1\. 默认一/)
  assert.match(r.text, /2\. 默认二/)
  assert.equal(r.id, 'demo')
  assert.equal(r.version, '1.0.0')
  assert.ok(r.text.endsWith('\n'), '结尾应规整为单个换行')
})

test('注册表：未找到模板 / 校验失败都返回结构化错误，不抛裸异常', () => {
  const reg = createRegistry([SAMPLE])
  const nf = reg.render('no-such', {})
  assert.equal(nf.ok, false)
  assert.ok(nf.errors.some(e => e.includes('未找到模板 no-such')))
  assert.ok(nf.errors.some(e => e.includes('demo')), '应列出可用模板')

  const bad = reg.render('demo', {})
  assert.equal(bad.ok, false, '缺必填 target 应失败')
  assert.ok(bad.errors.some(e => e.includes('target')))
})

test('注册表：list() 只回元数据，不回模板正文（避免工具返回体过大）', () => {
  const reg = createRegistry([SAMPLE])
  const list = reg.list()
  assert.equal(list.length, 1)
  assert.equal(list[0].id, 'demo')
  assert.equal(list[0].category, 'review')
  assert.ok(list[0].variables, '应带变量 schema 供 UI 生成表单')
  assert.equal(list[0].template, undefined, '不得回传模板正文')
})

test('注册表：非法模板被跳过并告警，不影响其它模板（插件绝不因此起不来）', () => {
  const warns = []
  const orig = console.warn
  console.warn = (m) => warns.push(String(m))
  let reg
  try {
    reg = createRegistry([
      { id: 'ok', template: 'A' },
      { id: 'bad-cat', template: 'B', category: 'nonsense' },
      { template: 'C' }, // 缺 id
      null,
      { id: 'ok2', template: 'D' },
    ])
  } finally {
    console.warn = orig
  }
  const ids = reg.list().map(t => t.id)
  assert.deepEqual(ids, ['ok', 'ok2'], '合法的保留、非法的跳过')
  assert.equal(warns.length, 3, `应告警 3 次，实际 ${warns.length}`)
})

test('validateTemplateShape：抓得住缺 id / 缺 template / 非法 category', () => {
  assert.deepEqual(validateTemplateShape({ id: 'a', template: 't' }), [])
  assert.ok(validateTemplateShape({ template: 't' }).some(e => e.includes('id')))
  assert.ok(validateTemplateShape({ id: 'a' }).some(e => e.includes('template')))
  assert.ok(validateTemplateShape({ id: 'a', template: 't', category: 'x' }).some(e => e.includes('category')))
})

test('register：运行时注册非法模板返回错误，合法模板可立即渲染', () => {
  const reg = createRegistry([])
  assert.equal(reg.register({ id: 'x' }).ok, false, '缺 template')
  assert.equal(reg.register(SAMPLE).ok, true)
  assert.equal(reg.render('demo', { target: 'T' }).ok, true)
})
