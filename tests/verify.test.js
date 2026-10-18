'use strict'

// H1 的**检查器自检**。
//
// 为什么检查器也要测：
//   一个永远打印 ✔ 的检查器比没有检查器更危险 —— 它给人虚假安全感。
//   本文件对每个静态检查构造一个"应当失败"的场景，断言它**真的会失败**。
//
// 🔴 原则：只测"能抓到问题"，不测"当前仓库是干净的"（后者是 verify:static 的活）。
//   这里全部在临时目录里造现场，不影响真实仓库。

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const cp = require('node:child_process')

const STATIC = path.resolve(__dirname, '..', 'scripts', 'verify-static.cjs')
const E2E = path.resolve(__dirname, '..', 'scripts', 'verify-e2e.cjs')

/** 在临时目录里造一个最小插件仓库，跑 verify-static，返回 {code, out}。 */
function runStaticIn(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-static-'))
  try {
    // 脚本按 __dirname/.. 找根目录，所以要把它复制成 scripts/ 结构
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true })
    fs.copyFileSync(STATIC, path.join(dir, 'scripts', 'verify-static.cjs'))
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(dir, rel)
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, content)
    }
    // 初始化 git（换行检查依赖 git；未初始化时该检查会跳过）
    try {
      cp.execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' })
      cp.execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' })
      cp.execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'x'], {
        cwd: dir,
        stdio: 'ignore',
      })
    } catch {
      /* git 不可用时换行检查会跳过，不影响其它检查 */
    }
    const r = cp.spawnSync(process.execPath, [path.join(dir, 'scripts', 'verify-static.cjs'), '--json'], {
      encoding: 'utf8',
    })
    return { code: r.status, report: JSON.parse(r.stdout || '{"checks":[],"failures":[]}') }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function baseFiles(overrides) {
  return {
    'package.json': JSON.stringify(
      {
        name: 'x',
        version: '1.0.0',
        main: 'lib/index.js',
        files: ['lib/', 'cordis.patch.yml'],
        dsh: { bundle: { patch: './cordis.patch.yml' } },
        exports: { '.': './lib/index.js', './package.json': './package.json' },
      },
      null,
      2
    ),
    'cordis.patch.yml': 'x: 1\n',
    'lib/index.js': 'module.exports = {}\n',
    'CHANGELOG.md': '## [1.0.0] - 2026-01-01\n',
    'README.md': '# x\n',
    '.gitignore': 'node_modules/\n',
    ...overrides,
  }
}

function failingNames(report) {
  return report.checks.filter(c => !c.pass).map(c => c.name)
}

// —— 作品集页面（H3）检查器自检 ——
// 这个页面是对外发布物，页面上的数字必须对得上评测集；写错没人会替你发现。
const PORTFOLIO_H2 = ['安装', '诚实披露']

function portfolioHtml({ claimItems = 2, readmeCmd = 'dsh plugin --profile desktop add npm:x' } = {}) {
  return [
    '<html><head></head><body>',
    '<header><h1>x</h1></header>',
    `<pre><code>${readmeCmd}</code></pre>`,
    ...PORTFOLIO_H2.map(h => `<h2>${h}</h2><p>y</p>`),
    `<p>${claimItems} 个期望提升项</p>`,
    '<p>平均 10 分提升到 20 分，增益 10</p>',
    '<footer><p>z</p></footer>',
    '</body></html>',
  ].join('\n')
}

const REPORT_OK = JSON.stringify({
  summary: { avgBefore: 10, avgAfter: 20, avgGain: 10 },
  cases: [{ expectImprove: ['goal'] }, { expectImprove: ['a', 'b'] }],
})

test('verify:static · 作品集页面：数字与评测集一致时通过（正对照）', () => {
  const { report } = runStaticIn(
    baseFiles({
      'docs/portfolio.html': portfolioHtml({ claimItems: 3 }),
      'evals/last-report.json': REPORT_OK,
      'README.md': '# x\n\ndsh plugin --profile desktop add npm:x\n',
    })
  )
  assert.ok(
    !failingNames(report).some(n => n.includes('作品集')),
    `干净的作品集页面被误报：${JSON.stringify(failingNames(report))}`
  )
})

test('verify:static · 作品集页面能抓到：期望提升项数与实测不符（本项目真犯过的错）', () => {
  const { report } = runStaticIn(
    baseFiles({
      // 实际 3 项，页面写 36 —— 这正是 H3 首版犯的错
      'docs/portfolio.html': portfolioHtml({ claimItems: 36 }),
      'evals/last-report.json': REPORT_OK,
      'README.md': '# x\n\ndsh plugin --profile desktop add npm:x\n',
    })
  )
  assert.ok(
    failingNames(report).some(n => n.includes('作品集')),
    '页面数字与评测集不符却没被抓到'
  )
})

test('verify:static · 作品集页面能抓到：少了必须的小节（防误删）', () => {
  const { report } = runStaticIn(
    baseFiles({
      'docs/portfolio.html': portfolioHtml().replace('<h2>安装</h2>', ''),
      'evals/last-report.json': REPORT_OK,
      'README.md': '# x\n\ndsh plugin --profile desktop add npm:x\n',
    })
  )
  assert.ok(failingNames(report).some(n => n.includes('作品集')), '缺少「安装」小节却没被抓到')
})

test('verify:static · 作品集页面能抓到：标签不配对', () => {
  const { report } = runStaticIn(
    baseFiles({
      'docs/portfolio.html': portfolioHtml().replace('</body></html>', '</body>'),
      'evals/last-report.json': REPORT_OK,
      'README.md': '# x\n\ndsh plugin --profile desktop add npm:x\n',
    })
  )
  assert.ok(failingNames(report).some(n => n.includes('作品集')), '</html> 少了却没被抓到')
})

test('verify:static · 作品集页面能抓到：安装命令与 README 不一致', () => {
  const { report } = runStaticIn(
    baseFiles({
      'docs/portfolio.html': portfolioHtml({ claimItems: 3, readmeCmd: 'dsh plugin add wrong:pkg' }),
      'evals/last-report.json': REPORT_OK,
      'README.md': '# x\n\ndsh plugin --profile desktop add npm:x\n',
    })
  )
  assert.ok(
    failingNames(report).some(n => n.includes('作品集')),
    '页面安装命令与 README 不一致却没被抓到'
  )
})

test('verify:static 正对照：干净仓库必须全部通过（否则下面的"能抓到问题"不可信）', () => {
  const { code, report } = runStaticIn(baseFiles())
  assert.equal(code, 0, `干净仓库竟然失败：${JSON.stringify(report.failures)}`)
  assert.ok(failingNames(report).length === 0)
})

test('verify:static 能抓到：bundle.patch 指向不存在的文件', () => {
  const { code, report } = runStaticIn(
    baseFiles({
      'package.json': JSON.stringify({
        name: 'x',
        version: '1.0.0',
        main: 'lib/index.js',
        files: ['lib/', 'cordis.patch.yml'],
        dsh: { bundle: { patch: './nope.yml' } },
        exports: { '.': './lib/index.js' },
      }),
    })
  )
  assert.equal(code, 1)
  assert.ok(failingNames(report).includes('dsh.bundle.patch 指向真实文件'), JSON.stringify(report.failures))
})

test('verify:static 能抓到：缺 dsh.bundle.patch（DSH 不激活任何层）', () => {
  const { code, report } = runStaticIn(
    baseFiles({
      'package.json': JSON.stringify({ name: 'x', version: '1.0.0', main: 'lib/index.js', files: ['lib/'] }),
    })
  )
  assert.equal(code, 1)
  assert.ok(failingNames(report).includes('dsh.bundle.patch 指向真实文件'))
})

test('verify:static 能抓到：exports 指向不存在文件', () => {
  const { code, report } = runStaticIn(
    baseFiles({
      'package.json': JSON.stringify({
        version: '1.0.0',
        main: 'lib/index.js',
        files: ['lib/', 'cordis.patch.yml'],
        dsh: { bundle: { patch: './cordis.patch.yml' } },
        exports: { '.': './lib/index.js', './ghost': './lib/ghost.js' },
      }),
    })
  )
  assert.equal(code, 1)
  assert.ok(failingNames(report).includes('exports 每个目标文件都存在'))
})

test('verify:static 能抓到：版本号与 CHANGELOG 不一致', () => {
  const { code, report } = runStaticIn(
    baseFiles({
      'package.json': JSON.stringify({
        version: '9.9.9',
        main: 'lib/index.js',
        files: ['lib/', 'cordis.patch.yml'],
        dsh: { bundle: { patch: './cordis.patch.yml' } },
        exports: { '.': './lib/index.js' },
      }),
    })
  )
  assert.equal(code, 1)
  assert.ok(failingNames(report).includes('版本号与 CHANGELOG 一致'))
})

test('verify:static 能抓到：lib/ 里出现 @deepseek-ai 运行时 require（项目红线）', () => {
  const { code, report } = runStaticIn(
    baseFiles({ 'lib/bad.js': "const { Service } = require('@deepseek-ai/cordis')\n" })
  )
  assert.equal(code, 1)
  assert.ok(failingNames(report).includes('lib/ 无 @deepseek-ai 运行时 import'), JSON.stringify(report.failures))
})

test('verify:static 不误报：注释里提到 @deepseek-ai 不算违规（首版就在这里假阳性）', () => {
  const { report } = runStaticIn(
    baseFiles({
      'lib/ok.js': "// 本项目红线：不要 require('@deepseek-ai/cordis')\nconst x = 1\n",
    })
  )
  assert.ok(
    !failingNames(report).includes('lib/ 无 @deepseek-ai 运行时 import'),
    '注释里的说明文字被当成了真实 import'
  )
})

test('verify:static 能抓到：lib/ 被 gitignore（link 安装拿不到代码）', () => {
  const { code, report } = runStaticIn(baseFiles({ '.gitignore': 'node_modules/\nlib/\n' }))
  assert.equal(code, 1)
  assert.ok(failingNames(report).includes('lib/ 未被 gitignore（link 安装不跑 build）'))
})

test('verify:static 能抓到：README 内部链接指向不存在文件', () => {
  const { code, report } = runStaticIn(baseFiles({ 'README.md': '[文档](./docs/missing.md)\n' }))
  assert.equal(code, 1)
  assert.ok(failingNames(report).includes('README 内部链接有效'))
})

test('verify:e2e 正对照：当前仓库跑 e2e 必须通过（含明确标注的跳过项）', () => {
  const r = cp.spawnSync(process.execPath, [E2E, '--json'], { encoding: 'utf8' })
  const report = JSON.parse(r.stdout)
  const fails = report.results.filter(x => x.status === 'fail')
  assert.equal(fails.length, 0, `e2e 失败：${JSON.stringify(fails)}`)
  // 跳过项必须如实标注为 skip，不能伪装成 pass
  const http = report.results.find(x => x.name.startsWith('真宿主 HTTP 链路'))
  assert.ok(http, '缺少真宿主 HTTP 链路这一项（应当显式标注跳过）')
  assert.equal(http.status, 'skip')
})

// —— 提示词守门：验证它真的能抓到"提示词与工具注册表不一致" ——
//
// 做法：把 lib/index.js 复制到临时目录并注入两个错误，跑 e2e 断言变红。
// 不直接改真实文件（并发/中断下会把仓库改坏）。

function runE2EWithPatchedIndex(mutate) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-e2e-'))
  try {
    const repoRoot = path.resolve(__dirname, '..')
    // 复制 lib/ 与必要文件
    for (const rel of ['lib', 'scripts', 'package.json', 'cordis.patch.yml']) {
      fs.cpSync(path.join(repoRoot, rel), path.join(dir, rel), { recursive: true })
    }
    const indexPath = path.join(dir, 'lib', 'index.js')
    fs.writeFileSync(indexPath, mutate(fs.readFileSync(indexPath, 'utf8')))
    const r = cp.spawnSync(process.execPath, [path.join(dir, 'scripts', 'verify-e2e.cjs'), '--json'], {
      encoding: 'utf8',
      env: { ...process.env, PC_E2E_URL: '' },
    })
    return JSON.parse(r.stdout || '{"results":[]}')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test('提示词守门能抓到：提示词提到一个不存在的工具', () => {
  const report = runE2EWithPatchedIndex(src =>
    src.replace('你有一个 prompt_compile 工具可用', '你有一个 prompt_ghost_tool 工具可用')
  )
  const gate = report.results.find(x => x.name.startsWith('提示词守门'))
  assert.ok(gate, '没跑到提示词守门')
  assert.equal(gate.status, 'fail', '提示词提到不存在的工具却没被抓到')
  assert.ok(/prompt_ghost_tool/.test(gate.detail), gate.detail)
})

test('提示词守门能抓到：新注册了工具但提示词没交代', () => {
  const report = runE2EWithPatchedIndex(src =>
    // 在 apply 里多注册一个"给模型用"的工具（描述不含"内部"字样 ⇒ 不免除）
    src.replace(
      'ctx.tools.register(',
      `ctx.tools.register({ name: 'prompt_extra_tool', description: '额外工具', parameters: {}, execute: async () => 'x' })\n  ctx.tools.register(`
    )
  )
  const gate = report.results.find(x => x.name.startsWith('提示词守门'))
  assert.equal(gate.status, 'fail', '注册了未交代的工具却没被抓到')
  assert.ok(/prompt_extra_tool/.test(gate.detail), gate.detail)
})
