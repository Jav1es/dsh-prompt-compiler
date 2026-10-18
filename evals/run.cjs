'use strict'

// F3 评测运行器：把 evals/drafts.json 跑成**可复现数字**。
//
// 用法：
//   node evals/run.cjs                 # 跑全部，输出人类可读表格 + 落到 evals/last-report.json
//   node evals/run.cjs --json           # 只输出 JSON
//   node evals/run.cjs --id crawler-vague
//
// 🔴 为什么要有这个文件（而不是把断言写进 tests）：
//   tests 里断言的是"某条规则生效"（单元级）；而这里回答的是**产品级问题**：
//   ① 评分器在真实 draft 上是否区分得开？（烂 draft 必须低分，补全信息后必须显著上升）
//   ② 规则式 compile 的 Before→After 平均能提多少分？
//   ③ 空壳能不能刷分？（负向样本必须 0 分）
//   这三个问题的答案要能对外引用，所以必须**确定性可复现** —— 故只用规则路径（不调 LLM）。
//
// ⚠️ 口径（2026-10-17 用户拍板）：规则式基线为主、可选 LLM 档，**两者不混算**。
//   本运行器只跑规则档；LLM 档的分数会漂移，不能写进 README 的固定数字。
//   若将来要加 LLM 档，另开一个 runner 并**分开报告**，绝不平均到同一个数字里。

const fs = require('node:fs')
const path = require('node:path')
const { scoreText } = require('../lib/scoring')
const { createPromptCompiler } = require('../lib/service')

const EVAL_DIR = __dirname
const DATA = JSON.parse(fs.readFileSync(path.join(EVAL_DIR, 'drafts.json'), 'utf8'))

function arg(flag) {
  const i = process.argv.indexOf(flag)
  return i > -1 ? process.argv[i + 1] : undefined
}

function round(n) {
  return Math.round(n * 10) / 10
}

/**
 * 跑单条样本：先给 draft 打分，再按 answers 合成一个「用户补充了信息后」的 draft 打分。
 *
 * 为什么用「拼成一段自然语言」而不是直接调 compile：
 *   compile 走的是 LLM/规则编译，产物格式随实现变；而评测要衡量的是**信息量**
 *   对评分的影响。把 answers 按 "补充：xxx。" 拼回 draft 是最直接的口径，
 *   且和 scoring 的输入同构（都是 draft 文本）。
 */
function runCase(pc, c) {
  const before = scoreText(c.draft)
  let after = null
  let afterText = null
  if (c.answers && Object.keys(c.answers).length) {
    const extra = Object.keys(c.answers)
      .map(k => `${k}：${c.answers[k]}`)
      .join('。')
    afterText = `${c.draft}。${extra}。`
    after = scoreText(afterText)
  }
  const improved = after
    ? Object.keys(after.dims).filter(k => after.dims[k].score > before.dims[k].score)
    : []
  // 判定「期望维度是否达成」时，**已经满分的维度不算未达成** ——
  // 否则 case 里写了 goal 但 before 已 20/20 时，永远无法"再涨"，会制造假失败。
  const missedExpect = after
    ? (c.expectImprove || []).filter(k => {
        const d = after.dims[k]
        if (!d) return true
        return !(d.score > before.dims[k].score) && !(d.score >= d.max)
      })
    : []
  return {
    id: c.id,
    tag: c.tag || '',
    before: before.total,
    after: after ? after.total : null,
    delta: after ? after.total - before.total : null,
    improved,
    expectImprove: c.expectImprove || [],
    missedExpect,
    dimsBefore: Object.fromEntries(Object.entries(before.dims).map(([k, d]) => [k, d.score])),
    dimsAfter: after ? Object.fromEntries(Object.entries(after.dims).map(([k, d]) => [k, d.score])) : null,
    draftLength: c.draft.length,
  }
}

async function main() {
  const onlyId = arg('--id')
  const pc = createPromptCompiler(null) // null ⇒ 纯规则路径，确定性

  const cases = DATA.cases.filter(c => !onlyId || c.id === onlyId)
  const rows = []
  for (const c of cases) rows.push(runCase(pc, c))

  // 负向样本：必须 0 分
  const negatives = (DATA.$negativeCases.cases || []).map(n => ({
    id: n.id,
    total: scoreText(n.draft).total,
    expectTotal: n.expectTotal,
    pass: scoreText(n.draft).total === n.expectTotal,
  }))

  // 规则式 compile 的 Before→After（走真实 compile 路径，验证 service 集成）
  const compileRows = []
  for (const c of cases) {
    const out = await pc.compile(c.draft)
    compileRows.push({
      id: c.id,
      before: out.scoreDelta.total.before,
      after: out.scoreDelta.total.after,
      delta: out.scoreDelta.total.delta,
      degraded: out.degraded === true,
    })
  }

  const drafted = rows.filter(r => r.after != null)
  const avg = arr => (arr.length ? round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0)
  const summary = {
    caseCount: rows.length,
    negativeCount: negatives.length,
    // 区分度：烂 draft 的平均分
    avgBefore: avg(rows.map(r => r.before)),
    // 用户补全信息后的平均分与提升
    avgAfter: avg(drafted.map(r => r.after)),
    avgGain: avg(drafted.map(r => r.delta)),
    minBefore: rows.length ? Math.min(...rows.map(r => r.before)) : 0,
    maxBefore: rows.length ? Math.max(...rows.map(r => r.before)) : 0,
    // 澄清有效性：期望提升的维度真的提升了没有
    expectHitRate: (() => {
      const total = drafted.reduce((acc, r) => acc + r.expectImprove.length, 0)
      if (!drafted.length || total === 0) return 'n/a'
      const hit = drafted.reduce((acc, r) => acc + (r.expectImprove.length - r.missedExpect.length), 0)
      return round((hit / total) * 100) + '%'
    })(),
    negativeAllZero: negatives.every(n => n.pass),
    // 规则式 compile（真实路径）
    compileAvgBefore: avg(compileRows.map(r => r.before)),
    compileAvgAfter: avg(compileRows.map(r => r.after)),
    compileAvgDelta: avg(compileRows.map(r => r.delta)),
    allDegraded: compileRows.every(r => r.degraded),
  }

  const report = {
    generatedAt: new Date().toISOString(),
    mode: 'rules-only (deterministic; no LLM)',
    summary,
    cases: rows,
    negatives,
    compile: compileRows,
  }

  if (process.argv.includes('--json')) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n')
  } else {
    printTable(report)
  }
  fs.writeFileSync(path.join(EVAL_DIR, 'last-report.json'), JSON.stringify(report, null, 2) + '\n')
  return report
}

function pad(s, n) {
  const str = String(s)
  // 粗略按显示宽度对齐（中文按 2 列算）
  const w = [...str].reduce((a, ch) => a + (/[\u4e00-\u9fa5]/.test(ch) ? 2 : 1), 0)
  return str + ' '.repeat(Math.max(0, n - w))
}

function printTable(r) {
  const s = r.summary
  console.log('\n=== Prompt Compiler 评测集（F3，规则档 / 确定性）===\n')
  console.log(pad('id', 20) + pad('before', 8) + pad('after', 8) + pad('delta', 7) + '未达成的期望维度')
  console.log('-'.repeat(78))
  for (const c of r.cases) {
    console.log(
      pad(c.id, 20) +
        pad(c.before, 8) +
        pad(c.after == null ? '-' : c.after, 8) +
        pad(c.delta == null ? '-' : (c.delta > 0 ? '+' + c.delta : c.delta), 7) +
        (c.missedExpect.length ? c.missedExpect.join(', ') : '—')
    )
  }
  console.log('-'.repeat(78))
  console.log(`\n样本 ${s.caseCount} 条 + 负向 ${s.negativeCount} 条`)
  console.log(`draft 原始分：平均 ${s.avgBefore}（区间 ${s.minBefore}–${s.maxBefore}）`)
  console.log(`补全信息后：平均 ${s.avgAfter}（平均 +${s.avgGain}）`)
  console.log(`期望改进维度命中率：${s.expectHitRate}`)
  console.log(`负向样本全部 0 分：${s.negativeAllZero ? '✅ 是' : '❌ 否'}`)
  console.log(
    `\n规则式 compile 真实路径：${s.compileAvgBefore} → ${s.compileAvgAfter}（平均 +${s.compileAvgDelta}），全部走降级=${s.allDegraded}`
  )
  console.log('\n注：本表只跑规则档；LLM 档分数会漂移，不与本表混算。\n')
}

if (require.main === module) {
  main().catch(e => {
    console.error(e)
    process.exit(1)
  })
}

module.exports = { main, runCase }
