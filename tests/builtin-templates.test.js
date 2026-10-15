'use strict'

// 内置模板测试（lib/builtin-templates.js）。
//
// 引擎的测试在 templates.test.js；这里测的是**模板数据本身**对不对：
//   · 每个内置模板都要过形状校验 + 静态审计（引用的变量都有出处）
//   · portfolio-review 在"给全"与"只给必填"两种输入下都要产出完整结构
//   · 量化指标必须**逐字保留**——这是这个模板存在的意义（结合真实成果，不泛泛而谈）
//   · 只给必填时，可选背景要**整条省略**，不能产出「经验年限：」这种空条目
//
// 最后一条是踩出来的：引擎首版把 {{#if}} 也当"未定义变量"报错，
// 导致最小输入直接渲染失败；修完条件位语义后才有这条用例钉住。

const test = require('node:test')
const assert = require('node:assert/strict')

const { createRegistry, validateTemplateShape, auditTemplate } = require('../lib/templates.js')
const { BUILTIN_TEMPLATES } = require('../lib/builtin-templates.js')

const MINIMAL = {
  siteUrl: 'https://example.dev/',
  targetRoles: ['AI Agent 开发工程师'],
}

const FULL = {
  siteUrl: 'https://jav1es.github.io/portfolio/',
  targetRoles: ['企业级 AI Agent 开发工程师', 'FDE'],
  background: {
    years: '5 年+',
    projects: '300+ 项目',
    clients: '100+ 客户',
    metrics: ['RAG 93.3% @3', '6 个 MIT 开源', 'CI 全绿'],
    openSource: '6 个 MIT 仓库',
  },
  coreSkills: ['企业级智能体', 'RAG', '评测与可观测性', 'MCP'],
  deployment: 'GitHub Pages',
}

test('内置模板：至少有一个；每个都过形状校验与静态审计', () => {
  assert.ok(BUILTIN_TEMPLATES.length >= 1, '至少要有一个内置模板')
  for (const t of BUILTIN_TEMPLATES) {
    assert.deepEqual(validateTemplateShape(t), [], `模板 ${t.id} 形状不合法`)
    const audit = auditTemplate(t)
    assert.equal(audit.ok, true, `模板 ${t.id} 引用了未声明变量：${audit.missing.join('、')}`)
  }
})

test('内置模板：id 不重复，category 合法', () => {
  const ids = BUILTIN_TEMPLATES.map(t => t.id)
  assert.equal(new Set(ids).size, ids.length, 'id 不能重复')
  for (const t of BUILTIN_TEMPLATES) {
    assert.ok(['review', 'generate', 'transform'].includes(t.category), `${t.id} 的 category 非法`)
  }
})

test('portfolio-review：给全输入时结构完整（9 段输出 + 10 维度 + 3 里程碑 + 3 视角 + 4 约束）', () => {
  const reg = createRegistry(BUILTIN_TEMPLATES)
  const r = reg.render('portfolio-review', FULL)
  assert.equal(r.ok, true, r.ok ? '' : r.errors.join('|'))
  const t = r.text

  const sections = t.match(/^\d+\. (总体诊断|亮点|问题清单|首页从上到下|简历化建议|文案优化示例|视觉与交互优化清单|行动清单|需要我补充的信息)/gm) || []
  assert.equal(sections.length, 9, `输出结构应为 9 段，实际 ${sections.length}`)

  assert.equal((t.match(/^\d+\. \*\*/gm) || []).length, 10, '评估维度应为 10 个')
  assert.equal((t.match(/^- (5 秒|30 秒|2 分钟)：/gm) || []).length, 3, '浏览里程碑应为 3 个')
  assert.equal((t.match(/^- (HR|技术面试官|业务负责人)/gm) || []).length, 3, '读者视角应为 3 个')
  assert.equal((t.match(/^- (必须结合|每条问题|不要直接生成|无法访问)/gm) || []).length, 4, '约束应为 4 条')
  assert.match(t, /P0/, '应带优先级说明')
})

test('portfolio-review：量化指标与关键背景逐字保留（不得改写或省略）', () => {
  const reg = createRegistry(BUILTIN_TEMPLATES)
  const t = reg.render('portfolio-review', FULL).text
  for (const s of [
    'https://jav1es.github.io/portfolio/',
    '企业级 AI Agent 开发工程师',
    'FDE',
    '5 年+', '300+ 项目', '100+ 客户',
    'RAG 93.3% @3', '6 个 MIT 开源', 'CI 全绿',
    '6 个 MIT 仓库',
    '企业级智能体', '评测与可观测性', 'MCP',
    'GitHub Pages',
  ]) {
    assert.ok(t.includes(s), `输出应逐字包含「${s}」`)
  }
})

test('portfolio-review：只给必填也能渲染，且可选背景整条省略（不产出空条目）', () => {
  const reg = createRegistry(BUILTIN_TEMPLATES)
  const r = reg.render('portfolio-review', MINIMAL)
  assert.equal(r.ok, true, `最小输入必须能渲染，实际报错：${r.ok ? '' : r.errors.join('|')}`)

  for (const ghost of ['经验年限：', '主导项目：', '服务客户：', '量化成果：', '开源产出：', '核心能力：', '部署方式：']) {
    assert.ok(!r.text.includes(ghost), `未提供的可选项不应产出空条目「${ghost}」`)
  }
  // 但固定结构必须还在
  assert.equal((r.text.match(/^\d+\. \*\*/gm) || []).length, 10, '维度是默认值，不应随输入缺失而消失')
  assert.equal((r.text.match(/^\d+\. (总体诊断|亮点|问题清单|首页从上到下|简历化建议|文案优化示例|视觉与交互优化清单|行动清单|需要我补充的信息)/gm) || []).length, 9)
  assert.ok(r.text.includes(MINIMAL.siteUrl))
})

test('portfolio-review：缺必填返回结构化错误，不抛裸异常', () => {
  const reg = createRegistry(BUILTIN_TEMPLATES)
  const r = reg.render('portfolio-review', { targetRoles: ['X'] })
  assert.equal(r.ok, false)
  assert.ok(r.errors.some(e => e.includes('siteUrl')), `应点名 siteUrl，实际：${r.errors.join('|')}`)

  const r2 = reg.render('portfolio-review', { siteUrl: 'https://x.dev' })
  assert.equal(r2.ok, false)
  assert.ok(r2.errors.some(e => e.includes('targetRoles')))
})

test('portfolio-review：兜底与"不许编造"的约束必须在场（这是防幻觉的关键）', () => {
  const reg = createRegistry(BUILTIN_TEMPLATES)
  const t = reg.render('portfolio-review', MINIMAL).text
  assert.match(t, /严禁编造页面内容/, '必须明确禁止编造页面内容')
  assert.match(t, /无法访问/, '必须有"无法访问时怎么办"的兜底')
  assert.match(t, /不要直接重构代码|不要直接生成完整代码/, '必须约束"只评审、不重写"')
})

test('注册表：list() 回元数据但不回模板正文', () => {
  const reg = createRegistry(BUILTIN_TEMPLATES)
  const list = reg.list()
  assert.ok(list.length >= 1)
  for (const m of list) {
    assert.ok(m.id && m.title && m.category, '元数据应含 id/title/category')
    assert.equal(m.template, undefined, '不得回传模板正文')
  }
})
