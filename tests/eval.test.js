'use strict'

// F3 评测集的**防退化**测试。
//
// 为什么评测集还需要测试：
//   评测集自己会腐烂 —— 有人为了"让数字好看"改 draft、有人放宽判定逻辑、
//   有人改了 scoring.js 让区分度悄悄变差。这些都让 `npm run eval` 依然"全绿"，
//   但对外引用的数字已经不成立了。
//   本文件锁死三条底线，任何改动只要破了其中一条，`npm test` 立刻红。
//
// 🔴 纪律：这里的阈值取的是**当前实测值再放宽一点**，不是理想值。
//   它们的用途是"防劣化"，不是"证明评分很准"。

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const { main } = require('../evals/run.cjs')
const DATA = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'evals', 'drafts.json'), 'utf8'))

test('评测集数据自身合法：id 唯一、expectImprove 只用真实存在的维度', () => {
  const ids = new Set()
  for (const c of DATA.cases) {
    assert.ok(c.id, '样本缺 id')
    assert.ok(!ids.has(c.id), `id 重复：${c.id}`)
    ids.add(c.id)
    assert.ok(typeof c.draft === 'string' && c.draft.length > 0, `${c.id} 的 draft 为空`)
    for (const d of c.expectImprove || []) {
      // 维度名写错（如写成 format）会让该条永远"未达成"，评测集就失真了
      assert.ok(
        ['goal', 'context', 'constraint', 'acceptance', 'ambiguity'].includes(d),
        `${c.id} 的 expectImprove 含非法维度：${d}`
      )
    }
  }
  assert.ok(DATA.cases.length >= 10, `样本数 ${DATA.cases.length} 太少，不足以说明问题`)
})

test('底线①：负向样本必须全部 0 分（空壳不得刷分）', async () => {
  const r = await main()
  assert.equal(r.summary.negativeAllZero, true, '有负向样本拿到了非 0 分，评分可被空壳刷分')
})

test('底线②：粗糙 draft 补全信息后必须显著提分（平均 ≥ +40）', async () => {
  const r = await main()
  assert.ok(
    r.summary.avgGain >= 40,
    `平均提升只有 +${r.summary.avgGain}，区分度不足（门槛 +40）`
  )
})

test('底线③：真实 draft 不得被判 0 分（否则等于告诉用户"你什么都没说"）', async () => {
  const r = await main()
  const zeros = r.cases.filter(c => c.before === 0)
  assert.equal(
    zeros.length,
    0,
    `以下真实 draft 被判 0 分：${zeros.map(c => c.id).join(', ')}`
  )
})

test('底线④：期望改进维度的命中率不得低于 90%（澄清价值的直接证据）', async () => {
  const r = await main()
  const rate = parseFloat(String(r.summary.expectHitRate))
  assert.ok(!Number.isNaN(rate), `命中率解析失败：${r.summary.expectHitRate}`)
  assert.ok(rate >= 90, `命中率 ${rate}% 低于 90%`)
})

test('确定性：同一评测集连跑两次，逐条分数完全一致（数字才能对外引用）', async () => {
  const a = await main()
  const b = await main()
  assert.deepEqual(
    a.cases.map(c => [c.id, c.before, c.after]),
    b.cases.map(c => [c.id, c.before, c.after])
  )
})

// 底线⑤：规则式 compile **不许把 prompt 改坏**。
//
// 🔴 这条是给一个真实事故加的：`crawler-mid`（「目标：帮我写个爬虫抓新闻，输出 JSON。」）
//   编译后从 34 分掉到 **32 分**。查下来是规则降级路径自己写的话被自己扣了分：
//     · Constraints 段填了「明确、可执行、无歧义」—— 听着像约束，其实什么都没约束
//     · 假设句写了「模型在**合理**范围内自行决策」—— "合理"被歧义维如实扣 2 分
//   ⇒ 插件自己产出的内容，不许给自己减分。修完后最小增益是 +20，没有一条为负。
test('底线⑤：规则式 compile 的每一条增益都必须 ≥ 0（编译不许把 prompt 改差）', async () => {
  const r = await main()
  const bad = r.compile.filter(c => c.delta < 0)
  assert.equal(
    bad.length,
    0,
    `以下样本编译后反而变差：${bad.map(c => `${c.id} ${c.before}→${c.after}(${c.delta})`).join(', ')}`
  )
})

test('底线⑤b：降级路径不得编造空话充当约束/格式', async () => {
  const { createPromptCompiler } = require('../lib/service.js')
  const pc = createPromptCompiler(null) // 无 LLM → 走规则降级
  const out = await pc.compile('目标：帮我写个爬虫抓新闻，输出 JSON。')
  // 这些是"听起来像约束、实际没约束"的话，绝不能再出现在产出里
  for (const phrase of ['明确、可执行、无歧义', '结构化、可直接使用', '合理范围内']) {
    assert.ok(!out.compiled.includes(phrase), `编译结果里出现了空话「${phrase}」`)
  }
  // 缺口必须**显式写成缺口**，而不是留白或伪装
  assert.match(out.compiled, /未提供约束/)
  assert.match(out.compiled, /未提供输出格式/)
})
