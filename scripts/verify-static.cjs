'use strict'

// H1 分层验收 —— 静态层（verify:static）。
//
// 这一层**不跑任何业务逻辑**，只查"仓库形态是否自洽"。它的价值在于：
// 这些错误一旦带进发布，用户装上去就是坏的，而 `npm test` 全绿也照样发现不了。
//
// 本项目的具体风险点（不是抄来的通用清单，条条对应踩过的坑）：
//   ① `dsh.bundle.patch` 必须指向真实存在的文件 —— 缺了它 DSH 会警告**且不激活任何层**，
//      但 `node --check` 和单测都不会报错。这是最隐蔽的一类失败。
//   ② `exports` 里每个路径都必须真实存在 —— link 安装时用户/宿主按 exports 解析，
//      指向不存在文件的条目会在运行时才炸。
//   ③ `files` 必须覆盖运行所需的一切 —— 漏了 `lib/` 或 `cordis.patch.yml`，
//      发到 npm 后用户拿到的就是残包。
//   ④ 版本号三处一致（package.json / CHANGELOG 最新条目 / 没有 tag 冲突由 CI 管）。
//   ⑤ lib/ 里零 `@deepseek-ai` 运行时 import（本项目红线，见 AGENTS.md）。
//   ⑥ 换行：仓库内文本文件统一 LF（Windows 上容易被编辑器改成 CRLF，污染 diff）。
//   ⑦ README 内部链接指向的文件必须存在。
//   ⑧ `lib/` 必须入库（link 安装不跑 build，见 AGENTS.md 环境事实）。

const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const failures = []
const checks = []

function ok(name, detail) {
  checks.push({ name, pass: true, detail })
}
function fail(name, detail) {
  checks.push({ name, pass: false, detail })
  failures.push(`${name}：${detail}`)
}

function readJSON(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'))
}

// ---- ① bundle.patch 存在 ----
;(function checkBundle() {
  const name = 'dsh.bundle.patch 指向真实文件'
  const pkg = readJSON(path.join(ROOT, 'package.json'))
  const patch = pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch
  if (!patch) return fail(name, 'package.json 缺 dsh.bundle.patch（DSH 会警告且不激活任何层）')
  const abs = path.resolve(ROOT, patch)
  if (!fs.existsSync(abs)) return fail(name, `patch 文件不存在：${patch}`)
  ok(name, patch)
})()

// ---- ② exports 路径存在 / ③ files 覆盖运行所需 ----
;(function checkExportsAndFiles() {
  const pkg = readJSON(path.join(ROOT, 'package.json'))
  const name = 'exports 每个目标文件都存在'
  const missing = []
  for (const [key, target] of Object.entries(pkg.exports || {})) {
    const t = typeof target === 'string' ? target : target && target.default
    if (!t) {
      missing.push(`${key}（无字符串目标）`)
      continue
    }
    if (t === './package.json') continue
    if (!fs.existsSync(path.resolve(ROOT, t))) missing.push(`${key} → ${t}`)
  }
  if (missing.length) fail(name, missing.join('; '))
  else ok(name, `${Object.keys(pkg.exports || {}).length} 条`)

  // files 必须覆盖 main 与 patch（否则发布残包）
  const name2 = 'files 覆盖 main 与 patch'
  const files = pkg.files || []
  const need = []
  const main = pkg.main || ''
  if (main && !files.some(f => main.startsWith(f.replace(/\/$/, '')) || main.startsWith(f))) {
    need.push(`main(${main})`)
  }
  const patch = (pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch || '').replace(/^\.\//, '')
  if (patch && !files.includes(patch)) need.push(`patch(${patch})`)
  if (need.length) fail(name2, `files 未覆盖：${need.join(', ')}`)
  else ok(name2, files.join(', '))
})()

// ---- ④ 版本一致性：package.json vs CHANGELOG 最新条目 ----
;(function checkVersion() {
  const name = '版本号与 CHANGELOG 一致'
  const pkg = readJSON(path.join(ROOT, 'package.json'))
  const clPath = path.join(ROOT, 'CHANGELOG.md')
  if (!fs.existsSync(clPath)) return fail(name, 'CHANGELOG.md 不存在')
  const cl = fs.readFileSync(clPath, 'utf8')
  const m = cl.match(/^##\s*\[(\d+\.\d+\.\d+[^\]]*)\]/m)
  if (!m) return fail(name, 'CHANGELOG.md 找不到形如 "## [x.y.z]" 的条目')
  if (m[1] !== pkg.version) {
    return fail(name, `package.json=${pkg.version}，CHANGELOG 最新=${m[1]}（发版前必须同步）`)
  }
  ok(name, pkg.version)
})()

// ---- ⑤ lib/ 零 @deepseek-ai 运行时 import（项目红线）----
;(function checkNoSdkImport() {
  const name = 'lib/ 无 @deepseek-ai 运行时 import'
  const libDir = path.join(ROOT, 'lib')
  const offenders = []
  for (const f of fs.readdirSync(libDir)) {
    if (!f.endsWith('.js')) continue
    const src = fs.readFileSync(path.join(libDir, f), 'utf8')
    for (const [i, raw] of src.split('\n').entries()) {
      // 先剥掉行尾注释与整行注释 —— 本项目多处注释里**写着** require('@deepseek-ai/...') 作说明，
      // 那是文字不是代码（首版就在这里误报，正对照见 verify-static.test.js）
      const line = stripComment(raw)
      if (!line.trim()) continue
      if (/(?:require\s*\(\s*['"]@deepseek-ai\/|^\s*import\s+(?!type\s)[^\n]*from\s*['"]@deepseek-ai\/)/.test(line)) {
        offenders.push(`${f}:${i + 1}`)
      }
    }
  }
  if (offenders.length) fail(name, offenders.join(', '))
  else ok(name, '干净')
})()

/** 去掉注释：整行注释直接清空，行尾注释砍掉；不会把 URL 里的 // 当注释。 */
function stripComment(line) {
  const t = line.trimStart()
  // 整行注释：`// ...`、`* ...`、`/* ...`
  if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return ''
  // 行尾注释：// 前面不是冒号（避免 http://）也不是引号内的内容
  const m = line.match(/(^|[^:'"`])\/\/.*$/)
  return m ? line.slice(0, m.index + (m[1] ? m[1].length : 0)) : line
}

// ---- ⑥ 换行统一 LF（查 **git blob**，不是本地工作区）----
// 🔴 首版查的是工作区文件，结果 11 个文件报 CRLF —— 但那是 `core.autocrlf=true`
//    把 LF 检出成 CRLF 的正常现象，仓库里存的一直是 LF。
//    ⇒ 判断对象错了就会假阳性，而且会诱导人去做一次毫无意义的全量重写。
//    正确口径：向 git 要 blob 字节；没有 git（如 tarball 解压）时退回读文件并只做告警。
;(function checkLineEndings() {
  const name = '仓库内文本文件换行统一 LF'
  const cp = require('node:child_process')
  let files
  try {
    files = cp
      .execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n')
      .map(s => s.trim())
      .filter(Boolean)
      .filter(f => /\.(js|cjs|mjs|json|md|yml|yaml|ts)$/.test(f))
      .filter(f => f !== 'evals/last-report.json')
  } catch {
    return ok(name, '跳过（非 git 环境，不判定）')
  }
  const bad = []
  for (const f of files) {
    try {
      const buf = cp.execFileSync('git', ['cat-file', 'blob', `HEAD:${f}`], {
        cwd: ROOT,
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      if (buf.includes(0x0d)) bad.push(f)
    } catch {
      // 未入库的新文件：退回读工作区（此时工作区的换行就是将来入库的换行）
      try {
        if (fs.readFileSync(path.join(ROOT, f)).includes(0x0d)) bad.push(`${f}（未提交）`)
      } catch {
        /* ignore */
      }
    }
  }
  if (bad.length) {
    fail(name, `git 中存有 CRLF：${bad.slice(0, 8).join(', ')}${bad.length > 8 ? ` …共 ${bad.length} 个` : ''}`)
  } else {
    ok(name, `${files.length} 个文件均为 LF`)
  }
})()

// ---- ⑦ README 内部链接指向的文件存在 ----
;(function checkDocLinks() {
  const name = 'README 内部链接有效'
  const readme = path.join(ROOT, 'README.md')
  if (!fs.existsSync(readme)) return fail(name, 'README.md 不存在')
  const md = fs.readFileSync(readme, 'utf8')
  const bad = []
  // 只查相对路径链接（http(s):// 与 #锚点 跳过）
  const re = /\[[^\]]*\]\((?!https?:|#|mailto:)([^)\s]+)\)/g
  let m
  while ((m = re.exec(md)) !== null) {
    const target = decodeURIComponent(m[1].split('#')[0])
    if (!target) continue
    if (!fs.existsSync(path.resolve(ROOT, target))) bad.push(target)
  }
  if (bad.length) fail(name, `失效：${bad.join(', ')}`)
  else ok(name, '全部有效')

})()

// ---- ⑦b 作品集页面（H3）的结构自检 ----
// 这个页面是**对外发布物**，一旦带病上线不会有人替你发现：
//   - 残留的编辑痕迹（HTML 标签不配对、被误删的小节）
//   - 声称的数字与评测集实际结果不符（对外数字造假是最贵的错误）
//   - 引用了不存在的文件
;(function checkPortfolio() {
  const name = '作品集页面 docs/portfolio.html 自洽'
  const p = path.join(ROOT, 'docs', 'portfolio.html')
  if (!fs.existsSync(p)) return ok(name, '未提供作品集页面（H3 未做时不判定）')
  const html = fs.readFileSync(p, 'utf8')
  const bad = []

  // ① 标签配对（只查本页用到的块级标签）
  for (const tag of ['html', 'head', 'body', 'header', 'footer', 'table', 'ul', 'ol', 'pre']) {
    const open = (html.match(new RegExp(`<${tag}[\\s>]`, 'gi')) || []).length
    const close = (html.match(new RegExp(`</${tag}>`, 'gi')) || []).length
    if (open !== close) bad.push(`<${tag}> 开 ${open} / 闭 ${close}`)
  }

  // ② 必须有的段落（防"被误删一节"这类事故）
  for (const h2 of ['安装', '诚实披露']) {
    if (!html.includes(`<h2>${h2}</h2>`)) bad.push(`缺少「${h2}」小节`)
  }

  // ③ 数字断言必须与评测集一致 —— 拿真实 report 比对，不比就不知道它过没过期
  const reportPath = path.join(ROOT, 'evals', 'last-report.json')
  if (fs.existsSync(reportPath)) {
    const r = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
    const s = r.summary || {}
    const expected = []
    if (s.avgBefore != null) expected.push(String(s.avgBefore))
    if (s.avgAfter != null) expected.push(String(s.avgAfter))
    if (s.avgGain != null) expected.push(String(s.avgGain))
    const missing = expected.filter(v => !html.includes(v))
    if (missing.length) bad.push(`页面未体现评测数字：${missing.join(', ')}（数字过期或写错）`)

    // 期望提升项总数：必须与真实数据吻合（本页曾写错成 36，实际 38）
    const total = (r.cases || []).reduce((n, c) => n + (c.expectImprove || []).length, 0)
    const claim = html.match(/(\d+)\s*个期望提升项/)
    if (claim && Number(claim[1]) !== total) {
      bad.push(`「${claim[1]} 个期望提升项」与实测 ${total} 不符`)
    }
  }

  // ④ 安装命令必须与 README 一致（本页曾写成未经验证的 github: 简写）
  const readmePath = path.join(ROOT, 'README.md')
  if (fs.existsSync(readmePath)) {
    const readme = fs.readFileSync(readmePath, 'utf8')
    const cmds = readme.match(/dsh plugin --profile desktop add \S+/g) || []
    for (const c of cmds) {
      if (!html.includes(c)) bad.push(`页面缺少 README 中的安装命令：${c}`)
    }
  }

  if (bad.length) fail(name, bad.join('；'))
  else ok(name, '标签配对、小节齐全、数字与评测集一致、安装命令与 README 一致')
})()

// ---- ⑦c 评测报告 docs/eval-report.md 的数字必须与实跑结果一致 ----
// 评测报告是**对外数字的唯一出处**（README 与作品集都引用它）。
// 它会随代码变化而过期，而过期的对外数字是最贵的错误 —— 所以拿实跑报告比对。
;(function checkEvalReport() {
  const name = '评测报告 docs/eval-report.md 与实跑结果一致'
  const docPath = path.join(ROOT, 'docs', 'eval-report.md')
  if (!fs.existsSync(docPath)) return ok(name, '未提供评测报告（不判定）')
  const reportPath = path.join(ROOT, 'evals', 'last-report.json')
  if (!fs.existsSync(reportPath)) return fail(name, '缺少 evals/last-report.json，无法核对（先跑 npm run eval）')

  let report
  try {
    report = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
  } catch (e) {
    return fail(name, `last-report.json 解析失败：${e.message}`)
  }
  const doc = fs.readFileSync(docPath, 'utf8')
  const s = report.summary || {}
  const bad = []

  // ① 汇总数字必须在文档里出现
  const need = []
  if (s.avgBefore != null) need.push(['原始平均分', String(s.avgBefore)])
  if (s.avgAfter != null) need.push(['澄清后平均分', String(s.avgAfter)])
  if (s.avgGain != null) need.push(['平均增益', String(s.avgGain)])
  if (s.compileAvgDelta != null) need.push(['规则式 compile 增益', String(s.compileAvgDelta)])
  for (const [label, v] of need) {
    if (!doc.includes(v)) bad.push(`${label} ${v} 未出现在报告中（数字过期？）`)
  }

  // ② 逐条明细必须覆盖评测集的每一条，且分数一致
  for (const c of report.cases || []) {
    if (!doc.includes(c.id)) {
      bad.push(`缺少样本 ${c.id}`)
      continue
    }
    const line = doc.split('\n').find(l => l.includes(c.id))
    if (line && !(line.includes(`| ${c.before} |`) && line.includes(`| ${c.after} |`))) {
      bad.push(`样本 ${c.id} 的分数与实跑不符（实跑 ${c.before}→${c.after}）`)
    }
  }

  // ③ 不许再有负增益被放过（这条真出过事故）
  const badNeg = (report.compile || []).filter(c => c.delta < 0)
  if (badNeg.length) {
    bad.push(`规则式 compile 仍有负增益：${badNeg.map(c => `${c.id} ${c.delta}`).join(', ')}`)
  }

  if (bad.length) fail(name, bad.slice(0, 6).join('；') + (bad.length > 6 ? ` …共 ${bad.length} 处` : ''))
  else ok(name, `汇总/逐条与实跑一致（${(report.cases || []).length} 条）`)
})()

// ---- ⑧ lib/ 必须入库（link 安装不跑 build）----
;(function checkLibTracked() {
  const name = 'lib/ 未被 gitignore（link 安装不跑 build）'
  const gi = path.join(ROOT, '.gitignore')
  if (!fs.existsSync(gi)) return ok(name, '无 .gitignore')
  const lines = fs
    .readFileSync(gi, 'utf8')
    .split('\n')
    .map(s => s.trim())
    .filter(s => s && !s.startsWith('#'))
  const hit = lines.find(l => l === 'lib' || l === 'lib/' || l === 'lib/**' || l === '**/lib/')
  if (hit) fail(name, `.gitignore 含 "${hit}" —— 发布后用户拿不到 lib/`)
  else ok(name, '未忽略')
})()

// ---- 输出 ----
const isJSON = process.argv.includes('--json')
const report = { layer: 'static', checks, failures }
if (isJSON) {
  process.stdout.write(JSON.stringify(report, null, 2) + '\n')
} else {
  console.log('\n=== verify:static ===\n')
  for (const c of checks) {
    console.log(`${c.pass ? '✔' : '✖'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`)
  }
  console.log('')
}
process.exit(failures.length ? 1 : 0)
