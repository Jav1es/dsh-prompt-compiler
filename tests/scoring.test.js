'use strict'

// F1 五维评分测试（lib/scoring.js）。
//
// 这套评分要对外展示 Before/After 数字（README / 作品集），所以它本身必须先被审视。
// 本文件针对三类最容易骗过测试的毛病各设一道防线：
//
//   ① **假评分**：不管输入是什么都给 70-80 分。
//      → 「区分度」组：好/中/烂三档必须单调递增，且跨度足够大。
//   ② **空壳刷分**：只写四个段名（## Task / ## Constraints …）也能得分。
//      → 「抗刷分」组：零正文必须 0 分；XML 标签形态（claude 风格）**必须**能得分（正对照）。
//   ③ **规则恒真**：加了某条规则，但删掉对应内容分数不变（= 规则没生效）。
//      → 「正对照」组：每条规则都给出"有/无"两版输入，断言分数**必须变化**。
//
// 🔴 纪律：任何一条断言「某规则生效」，都要有对照输入证明它真的在起作用。
//    否则测试绿了也不能说明评分可信。

const test = require('node:test')
const assert = require('node:assert/strict')

const { scoreText, compareTexts, DIMS, DIM_LABELS, __internals } = require('../lib/scoring.js')
const { splitSentences, substantiveText, findVagueWords } = __internals

// ---------------------------------------------------------------- 样本

const VAGUE = '帮我写个爬虫'
const MEDIUM = '目标：帮我写个爬虫抓新闻，输出 JSON。'
const GOOD = [
  '目标：抓取 example.com 首页当日头条的标题与链接，整理成结构化列表，供运营同事每日 9 点前查看。',
  '背景：我们已有 Python 3.11 环境，requests 已装。',
  '约束：仅用 HTTP GET；遵守 robots.txt；单请求间隔至少 1s；超时 5s 即跳过；不要抓取付费内容。',
  '输出格式：每行一条 JSON，字段 title 与 url。',
  '验收标准：每条记录 title 非空、url 可访问；条数与首页头条数一致；无重复。',
].join('\n')

// ---------------------------------------------------------------- ① 区分度

test('区分度：好/中/烂三档单调递增，且跨度足以说明问题', () => {
  const bad = scoreText(VAGUE).total
  const mid = scoreText(MEDIUM).total
  const good = scoreText(GOOD).total

  assert.ok(bad < mid, `烂(${bad}) 必须低于 中(${mid})`)
  assert.ok(mid < good, `中(${mid}) 必须低于 好(${good})`)
  // 跨度：若"好"与"烂"差距不足 40 分，说明尺子太钝，Before/After 结论会不显著
  assert.ok(good - bad >= 40, `好与烂的差距应 ≥40，实际 ${good - bad}`)
  // 与 max 对齐：满分 100
  const perfect = scoreText(GOOD)
  assert.ok(perfect.total <= 100 && perfect.total > 0)
})

test('确定性：同一输入重复评分恒得同分，且不依赖随机/时间', () => {
  const a = scoreText(GOOD)
  const b = scoreText(GOOD)
  assert.deepEqual(a, b)
  // 五维各 20 分，总分 = 五维之和（口径一致，杜绝"总分另算")
  for (const k of DIMS) {
    assert.equal(a.dims[k].max, 20, `${k} 的上限必须是 20`)
    assert.ok(a.dims[k].score >= 0 && a.dims[k].score <= 20, `${k}=${a.dims[k].score} 越界`)
  }
  const sum = DIMS.reduce((s, k) => s + a.dims[k].score, 0)
  assert.equal(a.total, sum, '总分必须等于五维之和')
})

// ---------------------------------------------------------------- ② 抗刷分

test('抗刷分：只有段名的空壳必须 0 分（否则空 prompt 拿 20+ 分，评分就不可信）', () => {
  const shell = '## Task\n## Constraints\n## Output Format\n## Acceptance Criteria'
  assert.equal(scoreText(shell).total, 0, '零正文的骨架必须 0 分')
  assert.equal(scoreText('').total, 0)
  assert.equal(scoreText('   \n\n  ').total, 0)
  assert.equal(scoreText(null).total, 0)
  assert.equal(scoreText(undefined).total, 0)
})

test('正对照：XML 标签形态（claude 风格）必须有内容分 —— 别把正文误当段名剔掉', () => {
  // 与上一条对照：同为"结构 + 内容"，只是标签不同。若实现把 <task> 当标题行剔除，
  // 这里会掉到 0 分，而实际上它是一份合格的 prompt。
  const xml = '<task>抓取 A 站首页头条标题与链接，交给运营同事。</task>\n<constraints>仅用 GET；间隔至少 2s；不要抓付费内容。</constraints>'
  const r = scoreText(xml)
  assert.ok(r.total > 30, `XML 形态应拿到实质分数，实际 ${r.total}`)
})

test('抗刷分：重复堆砌同一句话不能无限涨分（分数有上限且不随长度线性增长）', () => {
  const once = '约束：单请求间隔至少 1s；超时 5s 即跳过。'
  const many = Array.from({ length: 20 }, () => once).join('\n')
  const a = scoreText(once)
  const b = scoreText(many)
  assert.ok(b.total <= 100)
  // 允许"重复"带来的小幅波动，但不能因为长 20 倍就多拿 20 分以上
  assert.ok(b.total - a.total < 20, `堆砌 20 倍长度多拿了 ${b.total - a.total} 分，说明长度在刷分`)
})

// ---------------------------------------------------------------- ③ 逐维正对照
// 每条规则：给"有"与"无"两版输入，断言分数必须变。

test('正对照 · 目标维：把"要做什么"写成成句的实质陈述，目标分必须上升', () => {
  const without = '来个方案。'
  const withGoal = '目标：为客服团队写一份 FAQ 处理方案，交付 Markdown 文档。'
  assert.ok(scoreText(withGoal).dims.goal.score > scoreText(without).dims.goal.score,
    '有明确目标句必须比没有高')
})

test('正对照 · 目标维：补上受众信息，分必须上升', () => {
  const noAudience = '目标：写一个登录页面。'
  const withAudience = '目标：写一个登录页面，面向不熟悉电脑的老年用户。'
  assert.ok(scoreText(withAudience).dims.goal.score >= scoreText(noAudience).dims.goal.score,
    '受众线索不应降低分')
  assert.ok(scoreText(withAudience).dims.goal.score > scoreText(noAudience).dims.goal.score,
    '受众线索应提高目标分')
})

test('正对照 · 上下文维：补上背景与具体材料，分必须上升', () => {
  const bare = '目标：修一下这个 bug。'
  const contextual = '目标：修一下这个 bug。背景：目前登录接口在 Node 22 下必崩，现有代码在 src/auth.js，报错为 Cannot read property of undefined。'
  assert.ok(scoreText(contextual).dims.context.score > scoreText(bare).dims.context.score,
    '有背景+具体路径必须比没有高')
})

test('正对照 · 约束维：空话式要求不算约束，改成量化边界必须加分', () => {
  // 这条防的是"写了'要清晰'就给满分"——那是最典型的假评分
  const empty = '目标：写个抓取脚本。要求：清晰、优雅、高质量。'
  const quantified = '目标：写个抓取脚本。约束：单请求间隔至少 1s；超时 5s 即跳过；并发不超过 3。'
  assert.ok(scoreText(quantified).dims.constraint.score > scoreText(empty).dims.constraint.score,
    `量化边界(${scoreText(quantified).dims.constraint.score}) 必须高于空话(${scoreText(empty).dims.constraint.score})`)
})

test('正对照 · 约束维：补上禁止项，分必须上升', () => {
  const noProhib = '目标：写个抓取脚本。约束：单请求间隔至少 1s。'
  const withProhib = '目标：写个抓取脚本。约束：单请求间隔至少 1s；不要抓取付费内容。'
  assert.ok(scoreText(withProhib).dims.constraint.score > scoreText(noProhib).dims.constraint.score,
    '禁止项应提高约束分')
})

test('正对照 · 验收维：补上验收标准，分必须上升', () => {
  const noAcceptance = '目标：写个抓取脚本。约束：单请求间隔至少 1s。'
  const withAcceptance = noAcceptance + ' 验收标准：每条记录 title 非空；条数与首页一致。'
  assert.ok(scoreText(withAcceptance).dims.acceptance.score > scoreText(noAcceptance).dims.acceptance.score,
    '验收标准应提高验收分')
})

test('正对照 · 歧义维（反向）：插入模糊词，分必须下降', () => {
  // ⚠️ 样本必须够长（≥20 实质字符），否则会被"内容过短"闸门一刀切为 0，
  //    导致 0 vs 0 的假通过/假失败 —— 第一次写这条用例就踩了这个坑。
  const clean = '目标是生成一份季度运营报告。约束：不超过 3 页，只统计华东区数据。'
  const vague = '目标是生成一份季度运营报告，尽量合适一点，等等再补。约束：不超过 3 页，只统计华东区数据。'
  const c = scoreText(clean).dims.ambiguity.score
  const v = scoreText(vague).dims.ambiguity.score
  assert.ok(c > 0, `对照组必须真的评上分（实际 ${c}），否则这条断言没有意义`)
  assert.ok(v < c, `含模糊词(${v}) 必须低于干净文本(${c})`)
})

test('正对照 · 歧义维（反向）：写了"待定"扣分，写了"默认收口"加分', () => {
  const open = '目标是写一个登录接口，具体字段待定。约束：不超过 3 页。'
  const closed = '目标是写一个登录接口，若未指定则默认返回 JSON。约束：不超过 3 页。'
  assert.ok(scoreText(closed).dims.ambiguity.score > scoreText(open).dims.ambiguity.score,
    '主动收口应高于自述待定')
})

test('歧义维空内容保护：极短文本不能因为"没出现模糊词"而白拿高分', () => {
  // 反向维最容易出的 bug：空字符串里没有任何模糊词 ⇒ 满分。
  assert.equal(scoreText('').dims.ambiguity.score, 0)
  assert.equal(scoreText('a').dims.ambiguity.score, 0)
})

// ---------------------------------------------------------------- 可解释性

test('可解释性：每一维都要给出 reasons，扣分项要能指向原文证据', () => {
  const r = scoreText(MEDIUM)
  for (const k of DIMS) {
    const d = r.dims[k]
    assert.equal(d.key, k)
    assert.equal(d.label, DIM_LABELS[k])
    assert.ok(Array.isArray(d.reasons) && d.reasons.length > 0, `${k} 必须给出至少一条理由`)
    for (const reason of d.reasons) {
      assert.equal(typeof reason.text, 'string')
      assert.ok(reason.text.length > 0, '理由文案不能为空')
      assert.equal(typeof reason.points, 'number')
    }
  }
  // 有正文时，summary 必须包含总分
  assert.ok(r.summary.includes(String(r.total)))
})

test('可解释性：模糊词扣分必须带上"是哪几个词"—— 否则用户无法复核', () => {
  const r = scoreText('目标是做个落地页，尽量好看一点，等等再补细节，先给初稿。')
  const amb = r.dims.ambiguity
  const hit = amb.reasons.find(x => x.text.includes('模糊表述'))
  assert.ok(hit, '应有一条"模糊表述"理由')
  assert.ok(hit.text.includes('尽量') || hit.text.includes('等等'), `理由里要指名道姓，实际：${hit.text}`)
})

// ---------------------------------------------------------------- Before/After

test('compareTexts：同一把尺子量两段文本，delta = 逐维差值之和', () => {
  const c = compareTexts(VAGUE, GOOD)
  assert.equal(c.before.total, scoreText(VAGUE).total)
  assert.equal(c.after.total, scoreText(GOOD).total)
  assert.equal(c.delta, c.after.total - c.before.total)
  assert.ok(c.delta > 0, '好文本必须比烂文本高')

  const sumDim = DIMS.reduce((s, k) => s + c.perDim[k].delta, 0)
  assert.equal(c.delta, sumDim, 'delta 必须等于逐维 delta 之和')

  for (const k of DIMS) {
    const row = c.perDim[k]
    assert.equal(row.label, DIM_LABELS[k])
    assert.equal(row.delta, row.after - row.before)
  }
})

test('compareTexts：文本变差时 delta 必须为负（尺子不是单调加分的）', () => {
  const c = compareTexts(GOOD, VAGUE)
  assert.ok(c.delta < 0, `好→烂 的 delta 必须为负，实际 ${c.delta}`)
})

// ---------------------------------------------------------------- 工具函数

test('splitSentences：中英文句读都能切，且不丢内容', () => {
  const s = splitSentences('目标：抓取新闻。约束：间隔 1s！输出 JSON？Done.')
  assert.equal(s.length, 4)
  assert.ok(s[0].startsWith('目标'))
  assert.ok(substantiveText('## Task\n抓取新闻') === '抓取新闻')
})

// 🔴 回归：真实用户最常写的中文口语指令不能被判 0 分（评测集 F3 发现的假阴性）
// 原 ACTION_VERBS 只收技术动词，导致「做个落地页」「优化一下」「帮我看看」全部 0 分 ——
// 而评分的落点正是这类粗糙 draft，判 0 等于告诉用户"你什么都没说"。
test('回归 · 中文口语指令必须拿到目标线索分（不得被判 0）', () => {
  const colloquial = [
    '做个落地页，好看点，参考苹果那种',
    '这个 SQL 太慢了，优化一下',
    '程序报错了，帮我看看',
    '写个命令把日志里报错的行找出来',
    '帮我优化下简历',
  ]
  for (const d of colloquial) {
    const r = scoreText(d)
    assert.ok(r.total > 0, `「${d}」被判 0 分（口语动词没进词表）`)
    assert.ok(r.dims.goal.score > 0, `「${d}」目标维 0 分`)
  }
})

// 对照：扩词表**不得**破坏抗刷分 —— 空壳仍必须 0 分
test('回归 · 扩词表后空壳仍必须 0 分（扩词不能把骨架也放过）', () => {
  for (const shell of [
    '',
    '   \n\t  ',
    '## Task\n## Constraints\n## Output Format\n## Acceptance Criteria',
    '# Goal\n# Context\n# Constraints\n# Acceptance',
  ]) {
    assert.equal(scoreText(shell).total, 0, `空壳拿到了分：${JSON.stringify(shell)}`)
  }
})

test('findVagueWords：大小写不敏感，英文词也认', () => {
  assert.ok(findVagueWords('Please add Some stuff, etc.').length >= 2)
  assert.equal(findVagueWords('抓取 example.com 首页').length, 0)
})

// 🔴 回归：英文句点不能一律当句末（真实踩到的 bug）
// 上一版按 `.` 无条件切，导致「目标：抓取 news.」「example.」「com 首页新闻标题。」——
// 证据引用成半截，用户无法复核；句子变短还可能跌破"实质陈述"阈值而误判。
test('splitSentences 回归：域名/文件名/版本号/小数里的点不得当句末', () => {
  const domain = splitSentences('目标：抓取 news.example.com 首页新闻标题。背景：给运营做速览。')
  assert.equal(domain.length, 2, `域名被切碎：${JSON.stringify(domain)}`)
  assert.ok(domain[0].includes('news.example.com'), `域名应完整保留：${domain[0]}`)

  const file = splitSentences('约束：不爬 robots.txt 禁止的页面，超时 3.14 秒。')
  assert.equal(file.length, 1, `文件名/小数被切碎：${JSON.stringify(file)}`)

  // 正对照：真正的英文句末（点后跟空格或结尾）**必须**仍然切
  const en = splitSentences('Goal: scrape example.com. Constraints: use requests. Output: JSON.')
  assert.equal(en.length, 3, `英文句末没切开：${JSON.stringify(en)}`)
})
