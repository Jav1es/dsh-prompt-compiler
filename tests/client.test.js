'use strict'

// client 半部渲染测试（此前 client 侧零测试覆盖）。
//
// 为什么值得有：client.js 是 ModuleLoader 格式、只在浏览器里跑，`node --check`
// 只能查语法，查不出「注册错插槽」「组件里引用了未定义变量」「条件渲染写反」这类
// 只在渲染时才炸的问题 —— 而插件 UI 一旦炸，用户在界面上直接看到白屏。
//
// 做法：搭一个最小宿主 —— stub React + 假 ModuleLoader + 假 ctx.slots，
// 真实执行 client.js 的 factory/apply，然后渲染关键组件，断言关键文案存在。
// 这不是像素级验证（那是浏览器的事），而是**结构性冒烟**。

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const CLIENT_SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'client.js'), 'utf8')

/** 造一个 React stub + 渲染器。返回 { React, render, problems }。 */
function makeReactStub() {
  const problems = []
  let hooks = []
  let hookIdx = 0
  let pendingEffects = []

  const React = {
    Fragment: 'Fragment',
    createElement(type, props, ...children) {
      // 真实 React 把 children 放进 props.children —— 必须照做，否则子组件读不到
      const kids = children.flat().filter(c => c !== null && c !== undefined && c !== false)
      const p = Object.assign({}, props || {})
      if (kids.length) p.children = kids.length === 1 ? kids[0] : kids
      return { type, props: p, children: kids }
    },
    useState(init) {
      const i = hookIdx++
      if (hooks[i] === undefined) hooks[i] = typeof init === 'function' ? init() : init
      const set = (v) => { hooks[i] = typeof v === 'function' ? v(hooks[i]) : v }
      return [hooks[i], set]
    },
    useEffect(fn) { pendingEffects.push(fn) },
    useRef(init) { return { current: init } },
    useMemo(fn) { return fn() },
    useCallback(fn) { return fn },
  }

  function render(node, depth) {
    if (depth === undefined) depth = 0
    if (depth > 80) { problems.push('嵌套过深（可能循环渲染）'); return '' }
    if (node === null || node === undefined || node === false) return ''
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map(n => render(n, depth + 1)).join('')
    if (typeof node.type === 'function') {
      hookIdx = 0
      let out
      try { out = node.type(Object.assign({}, node.props)) }
      catch (e) { problems.push('组件 ' + (node.type.name || '匿名') + ' 抛错: ' + e.message); return '' }
      return render(out, depth + 1)
    }
    if (typeof node.type !== 'string') { problems.push('非法元素 type: ' + String(node.type)); return '' }
    // 表单元素的 placeholder/checked 是属性不是文本，但设置页关键状态就在里面
    let attrs = ''
    if (node.type === 'input' || node.type === 'select' || node.type === 'textarea') {
      const p = node.props || {}
      const bits = []
      if (p.placeholder) bits.push('ph:' + p.placeholder)
      if (p.type === 'checkbox') bits.push(p.checked ? 'checked' : 'unchecked')
      if (p.type === 'radio') bits.push(p.checked ? 'radio-on' : 'radio-off')
      if (bits.length) attrs = '[' + bits.join(' ') + ']'
    }
    return attrs + render(node.children, depth + 1)
  }

  return {
    React,
    problems,
    render,
    resetHooks() { hooks = []; hookIdx = 0; pendingEffects = [] },
    async runEffects() {
      for (const fn of pendingEffects) { try { fn() } catch (e) { problems.push('effect 抛错: ' + e.message) } }
      pendingEffects = []
      // 让 effect 里的 promise 链落地
      for (let i = 0; i < 6; i++) await Promise.resolve()
      await new Promise(r => setTimeout(r, 10))
    },
  }
}

/** 加载 client.js 并执行 apply()，返回 { mod, registered }。 */
function loadClient(settingsPayload, opts) {
  let loadedDef = null
  const sandbox = {
    window: {
      __ModuleLoader__: { load(def) { loadedDef = def } },
      localStorage: {
        _d: {},
        getItem(k) { return this._d[k] === undefined ? null : this._d[k] },
        setItem(k, v) { this._d[k] = String(v) },
        removeItem(k) { delete this._d[k] },
      },
      addEventListener() {}, removeEventListener() {},
    },
    document: { createElement: () => ({ set textContent(_) {}, remove() {} }), head: { appendChild() {} } },
    console, setTimeout, clearTimeout,
    navigator: { clipboard: { writeText() { return Promise.resolve() } } },
  }
  sandbox.globalThis = sandbox
  // 默认 fetch 只回设置；模板类测试用 opts.fetch 按路径分流
  sandbox.fetch = (opts && opts.fetch) || (() => Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ ok: true, settings: settingsPayload }),
  }))
  vm.createContext(sandbox)
  vm.runInContext(CLIENT_SRC, sandbox)

  assert.ok(loadedDef, 'client.js 应调用 window.__ModuleLoader__.load')
  const stub = makeReactStub()
  const mod = loadedDef.factory(function (name) {
    if (name === 'react') return stub.React
    throw new Error('未预期的 require: ' + name)
  })

  const registered = {}
  const fakeCtx = {
    get(name) {
      if (name === 'slots') {
        return {
          inject(slot, fn) { const r = fn(); registered[slot] = r; return r },
          register(meta, comp) { return { meta, comp } },
        }
      }
      return undefined
    },
    effect(fn) { try { return fn() } catch (e) { return undefined } },
  }
  mod.apply(fakeCtx)
  return { mod, registered, stub }
}

// —— 遍历/查找辅助（React element 就是普通对象，可直接走 props/children） ——

/** 深度优先收集满足 pred 的元素。 */
function findAll(node, pred) {
  const out = []
  ;(function walk(n) {
    if (!n || typeof n !== 'object') return
    if (Array.isArray(n)) { n.forEach(walk); return }
    if (pred(n)) out.push(n)
    if (n.children) walk(n.children)
  })(node)
  return out
}

/** 收集所有可点击元素（有 onClick 的）。 */
function clickables(tree) {
  return findAll(tree, (n) => n && n.props && typeof n.props.onClick === 'function')
}

/** 在 tree 里按可见文案找一个可点击元素（取文案**包含** label 的最内层）。 */
function findByLabel(tree, label, stub) {
  const hits = clickables(tree).filter((n) => stub.render(n.children, 0).indexOf(label) !== -1)
  if (!hits.length) return null
  // 取渲染文本最短的 —— 即最内层那个，避免匹配到包了一层的外层元素
  return hits.sort((a, b) =>
    stub.render(a.children, 0).length - stub.render(b.children, 0).length)[0]
}

function sampleSettings(enabled) {
  return {
    external: {
      enabled: !!enabled, priority: !!enabled, baseUrl: 'http://localhost:11434/api/chat',
      apiKey: '', model: 'llama3.2', apiKeySet: true,
    },
    compile: { targetModel: '', strongTemplate: true },
    format: { stripHeadings: false, dropReasoning: true, collapseBlank: true },
    diagnostics: { showScore: true, showModelBadge: true, showDiagMeta: true, warnOnDegrade: true },
    behavior: { autoApply: false, showAssumptions: true },
    _path: '/tmp/pc-settings.json',
  }
}

test('client：apply() 必须注册三个插槽（含官方 settings.section 设置页）', () => {
  const { mod, registered } = loadClient(sampleSettings(true))
  assert.equal(mod.name, 'prompt-compiler')
  assert.equal(typeof mod.apply, 'function')
  for (const slot of ['conversation.input.right', 'shell.overlay', 'settings.section']) {
    assert.ok(registered[slot], '缺少插槽注册: ' + slot)
    assert.ok(registered[slot].comp, slot + ' 未提供组件')
  }
  // 设置页必须是官方插槽、且用我们自己的 id（不能顶掉别的插件的页）
  assert.equal(registered['settings.section'].meta.name, 'settings.section')
  assert.equal(registered['settings.section'].meta.id, 'prompt-compiler')
  assert.ok(registered['settings.section'].meta.label, '设置页应有导航标题')
})

test('client：设置页能渲染出五组配置与全部设置项', async () => {
  const { registered, stub } = loadClient(sampleSettings(true))
  const Comp = registered['settings.section'].comp

  stub.resetHooks()
  const first = stub.render(stub.React.createElement(Comp, {}), 0)
  assert.match(first, /正在读取设置/, '设置未就绪时应显示加载态')

  await stub.runEffects()
  const tree = stub.render(stub.React.createElement(Comp, {}), 0)

  assert.deepEqual(stub.problems, [], '渲染不得有结构性错误')
  for (const t of ['模型来源', '编译风格', '输出格式', '诊断与提示', '默认行为',
    '外部模型', '使用方式', '目标模型', '强化编译模板',
    '去掉标题行', '丢弃思维链', '折叠多余空行',
    '显示模型徽章', '显示诊断评分', '显示技术细节', '降级时警告',
    '编译后自动回填', '显示自动假设', '恢复默认', '保存']) {
    assert.ok(tree.indexOf(t) !== -1, '设置页缺少文案: ' + t)
  }
  // 必填标记 + 密钥已设置提示（后者在 placeholder 里）
  assert.ok(tree.indexOf('必填') !== -1, '应标出必填项')
  assert.ok(tree.indexOf('ph:（已设置，留空不变）') !== -1, '应提示密钥已保存且不回显')
})

test('client：外部模型关闭时隐藏子块但保留开关（条件渲染正确）', async () => {
  const { registered, stub } = loadClient(sampleSettings(false))
  const Comp = registered['settings.section'].comp
  stub.resetHooks()
  stub.render(stub.React.createElement(Comp, {}), 0)
  await stub.runEffects()
  const tree = stub.render(stub.React.createElement(Comp, {}), 0)

  assert.ok(tree.indexOf('外部模型') !== -1, '关闭态仍应显示开关')
  assert.equal(tree.indexOf('使用方式'), -1, '关闭态不应显示「使用方式」子块')
  assert.equal(tree.indexOf('接口地址'), -1, '关闭态不应显示接口地址输入')
})

test('client：设置页根容器须留出底部空隙，否则最后一行设置被 sticky 操作条永久遮住', () => {
  // 滚动容器是宿主的面板而不是 .pcs 自己，而 .pcs-actions 用 position:sticky;bottom:0
  // 浮在面板底部。若 .pcs 不留 padding-bottom，滚到底时最后一行设置的开关会压
  // 在「恢复默认/保存」条底下点不到 —— 2026-10-14 在 DSH 设置面板里实测复现。
  const root = /\.pcs\{([^}]*)\}/.exec(CLIENT_SRC)
  assert.ok(root, '应能取到 .pcs 根容器规则')
  const pad = /padding-bottom:\s*(\d+)px/.exec(root[1])
  assert.ok(pad, '.pcs 必须声明 padding-bottom 以避开 sticky 操作条')
  assert.ok(Number(pad[1]) >= 51,
    '.pcs 的 padding-bottom（' + pad[1] + 'px）须不小于 sticky 操作条高度（约 51px）')

  // 前提条件：操作条确实是贴底 sticky。这条不成立了就该重写本测试。
  const actions = /\.pcs-actions\{([^}]*)\}/.exec(CLIENT_SRC)
  assert.ok(actions && /position:sticky/.test(actions[1]) && /bottom:0/.test(actions[1]),
    '.pcs-actions 应为 position:sticky;bottom:0（本测试的前提）')
})

test('client：卡片不得让背景会话正文透出来（截图要公开发布的隐私回归）', () => {
  // 起因：.pc-card 直接吃 var(--dsw-alias-bg-overlay)，而该 token 在本主题下带 alpha，
  // 遮罩又只压了 35% ⇒ 背景会话正文透过卡片清晰可读（2026-10-16 实机截图复现，
  // 背景里能看到简历文件名与 secrets 字样）。既伤可读性，也让截图无法公开。
  const card = /\.pc-card\{([^}]*)\}/.exec(CLIENT_SRC)
  assert.ok(card, '应能取到 .pc-card 规则')
  assert.match(card[1], /backdrop-filter:\s*blur/,
    '.pc-card 必须有 backdrop-filter 模糊，否则背景正文会透过来')

  const mask = /\.pc-mask\{([^}]*)\}/.exec(CLIENT_SRC)
  assert.ok(mask, '应能取到 .pc-mask 规则')
  const alpha = /rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*([\d.]+)\s*\)/.exec(mask[1])
  assert.ok(alpha, '.pc-mask 应使用 rgba 黑色遮罩，便于断言不透明度')
  assert.ok(Number(alpha[1]) >= 0.5,
    '遮罩不透明度（' + alpha[1] + '）须不低于 0.5，否则背景文字仍可辨认')
})

test('client：设置页不得回显含用户名的绝对路径（截图要公开发布的隐私回归）', async () => {
  // 宿主回传的 _path 是绝对路径（C:\Users\<用户名>\...）。原样显示会
  // 把本机用户名带进截图，而截图是要发到 GitHub / npm 的。
  const s = sampleSettings(true)
  s._path = 'C:\\Users\\Administrator\\.dsh\\prompt-compiler\\settings.json'
  const { registered, stub } = loadClient(s)
  const Comp = registered['settings.section'].comp

  stub.resetHooks()
  stub.render(stub.React.createElement(Comp, {}), 0)
  await stub.runEffects()
  const tree = stub.render(stub.React.createElement(Comp, {}), 0)

  assert.ok(tree.indexOf('Administrator') === -1,
    '设置页不得回显本机用户名；实际: ' + tree.slice(0, 400))
  assert.ok(tree.indexOf('~\\.dsh') !== -1,
    '应显示 ~ 缩写的配置路径；实际: ' + tree.slice(0, 400))
})

test('client：settings.section 注册失败不得拖垮整个 client 半部', () => {
  // 模拟宿主版本没有该插槽：inject 抛错时其余插槽仍必须注册成功
  let loadedDef = null
  const sandbox = {
    window: {
      __ModuleLoader__: { load(def) { loadedDef = def } },
      localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
      addEventListener() {}, removeEventListener() {},
    },
    document: { createElement: () => ({ set textContent(_) {}, remove() {} }), head: { appendChild() {} } },
    console, setTimeout, clearTimeout,
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, settings: sampleSettings(false) }) }),
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(CLIENT_SRC, sandbox)

  const stub = makeReactStub()
  const mod = loadedDef.factory(n => (n === 'react' ? stub.React : (() => { throw new Error('unexpected ' + n) })))
  const registered = {}
  const fakeCtx = {
    get(name) {
      if (name !== 'slots') return undefined
      return {
        inject(slot, fn) {
          if (slot === 'settings.section') throw new Error('宿主无此插槽')
          const r = fn(); registered[slot] = r; return r
        },
        register(meta, comp) { return { meta, comp } },
      }
    },
    effect(fn) { try { return fn() } catch (e) { return undefined } },
  }
  assert.doesNotThrow(() => mod.apply(fakeCtx), 'settings.section 失败不应让 apply 抛错')
  assert.ok(registered['conversation.input.right'], '其余插槽仍应注册成功')
  assert.ok(registered['shell.overlay'], '其余插槽仍应注册成功')
})

// ══════════════════════════════════════════════════════════════════════
// 模板 UI（评审类模板）
//
// 注意：stub 的 render() 返回**字符串**，所以这里不能靠它遍历树 ——
// 改为直接调用组件函数拿到 React element 树，再用 plainText() 取纯文本。
// 这样能在不起浏览器的情况下走完：点「模板」→ 列模板 → 选模板 →
// 按 schema 生成表单 → 渲染 → 采用并回填 的完整链路。
// ══════════════════════════════════════════════════════════════════════

/** 取元素树里的纯文本（不展开函数组件，避免误触发 hooks）。 */
function plainText(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(plainText).join('')
  if (typeof node.type === 'string') return plainText(node.children)
  return ''
}

const TPL_LIST = {
  templates: [
    {
      id: 'portfolio-review', version: '1.0.0', category: 'review',
      title: '作品集 / 个人主页评审', description: '从四个视角评审个人主页',
      variables: {
        properties: {
          siteUrl: { type: 'string', required: true, description: '主页地址' },
          targetRoles: { type: 'string[]', required: true, description: '目标岗位' },
          background: {
            type: 'object', description: '个人背景',
            properties: {
              years: { type: 'string', description: '经验年限' },
              metrics: { type: 'string[]', description: '量化成果' },
            },
          },
        },
      },
    },
    {
      id: 'code-review', version: '1.0.0', category: 'review',
      title: '代码审查', description: '按 6 个维度审查代码',
      variables: { properties: { code: { type: 'string', required: true, description: '代码或 diff' } } },
    },
  ],
}

/** 按路径分流的假 fetch，并记录调用。 */
function tplFetch(renderReply) {
  const calls = []
  const fetchImpl = (url, init) => {
    const body = init && init.body ? JSON.parse(init.body) : {}
    calls.push({ url, body })
    if (/\/templates$/.test(url)) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(TPL_LIST) })
    }
    if (/\/render$/.test(url)) {
      if (renderReply && renderReply.error) {
        return Promise.resolve({ ok: false, status: 400, json: () => Promise.resolve({ error: renderReply.error }) })
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ok: true, id: body.template, version: '1.0.0', text: renderReply.text }),
      })
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, settings: sampleSettings(true) }) })
  }
  return { calls, fetch: fetchImpl }
}

/** 在元素树里找 button。 */
function buttonsOf(el) {
  return findAll(el, (n) => n && n.type === 'button' && n.props)
}

/**
 * 渲染 overlay 根并**展开到实际的卡片元素**。
 * OverlayCard 返回的是 `createElement(TemplateCard)` —— 一个 type 为函数的元素，
 * plainText 不展开函数组件，所以必须手动调一次，否则拿到空文本。
 * 展开前 resetHooks，让卡片组件的 hooks 从 0 开始。
 */
function openCard(stub, Overlay) {
  stub.resetHooks()
  // 注意：这里直接调 Overlay —— 别再写成 openCard，否则自递归
  let el = Overlay(Object.assign({}, {}))
  if (el && typeof el.type === 'function') {
    stub.resetHooks()
    el = el.type(Object.assign({}, el.props))
  }
  return el
}

test('client：composer 工具栏提供「模板」入口，且与「编译」并列', () => {
  const { registered, stub } = loadClient(sampleSettings(true))
  const Comp = registered['conversation.input.right'].comp
  stub.resetHooks()
  const el = Comp({ useInput: () => 'x', inputActions: { setDraft() {} } })
  const text = plainText(el)
  assert.ok(text.indexOf('模板') !== -1, '应有「模板」入口')
  assert.ok(text.indexOf('编译') !== -1, '「编译」入口应保留（两条并列路径）')
  assert.ok(buttonsOf(el).some((b) => plainText(b).indexOf('模板') !== -1), '「模板」应可点击')
})

test('client：模板卡完整链路——列模板 → 选模板 → 按 schema 生成表单 → 渲染 → 可回填', async () => {
  const fx = tplFetch({ text: '# 角色\n你是评审员\n# 约束\n- x\n' })
  const { registered, stub } = loadClient(sampleSettings(true), { fetch: fx.fetch })
  const Comp = registered['conversation.input.right'].comp
  const Overlay = registered['shell.overlay'].comp
  let applied = null

  // ① 点「模板」打开模板卡
  stub.resetHooks()
  const compEl = Comp({ useInput: () => 'x', inputActions: { setDraft(t) { applied = t } } })
  buttonsOf(compEl).find((b) => plainText(b).indexOf('模板') !== -1).props.onClick()

  // ② 首帧应是加载态，effect 跑完后列出模板
  stub.resetHooks()
  assert.ok(plainText(openCard(stub, Overlay)).indexOf('正在读取模板列表') !== -1, '首帧应为加载态')
  await stub.runEffects()

  stub.resetHooks()
  let ov = openCard(stub, Overlay)
  let text = plainText(ov)
  assert.ok(text.indexOf('选择模板') !== -1, '应进入选模板步骤')
  assert.ok(text.indexOf('作品集 / 个人主页评审') !== -1, '应列出模板标题')
  assert.ok(text.indexOf('代码审查') !== -1, '应列出全部模板')
  assert.deepEqual(stub.problems, [], '渲染不得有结构性错误')

  // ③ 选「作品集 / 个人主页评审」→ 表单按 schema 生成
  buttonsOf(ov).find((b) => plainText(b).indexOf('作品集 / 个人主页评审') !== -1).props.onClick()
  stub.resetHooks()
  ov = openCard(stub, Overlay)
  text = plainText(ov)
  for (const label of ['siteUrl', 'targetRoles', 'background', 'years', 'metrics']) {
    assert.ok(text.indexOf(label) !== -1, `表单应含字段 ${label}`)
  }
  assert.ok(text.indexOf('*') !== -1, '必填项应有标记')
  assert.ok(text.indexOf('主页地址') !== -1, '应显示字段说明')

  // ④ 填一个必填项后点「渲染」
  const inputs = findAll(ov, (n) => n.type === 'input' && n.props && n.props.onChange)
  assert.ok(inputs.length >= 1, '应生成输入控件')
  inputs[0].props.onChange({ target: { value: 'https://x.dev/' } })

  stub.resetHooks()
  ov = openCard(stub, Overlay)
  buttonsOf(ov).find((b) => plainText(b) === '渲染').props.onClick()
  await new Promise((r) => setTimeout(r, 20))

  // ⑤ 展示结果，且请求体里带上模板 id 与已填值
  stub.resetHooks()
  ov = openCard(stub, Overlay)
  text = plainText(ov)
  assert.ok(text.indexOf('渲染结果') !== -1, '应进入结果步骤')
  assert.ok(text.indexOf('本次未调用模型') !== -1, '结果里应标明未消耗模型调用')
  assert.ok(text.indexOf('# 角色') !== -1, '应显示渲染出的正文')

  const renderCall = fx.calls.filter((c) => /\/render$/.test(c.url)).pop()
  assert.ok(renderCall, '应调用了 /render')
  assert.equal(renderCall.body.template, 'portfolio-review')
  assert.equal(renderCall.body.variables.siteUrl, 'https://x.dev/')
  assert.equal(renderCall.body.variables.targetRoles, undefined, '空数组不应上传（交给 host 用 defaults）')

  // ⑥ 采用并回填只写输入框，不发送
  buttonsOf(ov).find((b) => plainText(b) === '采用并回填').props.onClick()
  assert.equal(applied, '# 角色\n你是评审员\n# 约束\n- x\n', '应把渲染结果写回输入框')
})

test('client：渲染失败（400）时显示可读错误，不白屏', async () => {
  const fx = tplFetch({ error: '缺少必填变量：siteUrl（主页地址）' })
  const { registered, stub } = loadClient(sampleSettings(true), { fetch: fx.fetch })
  const Comp = registered['conversation.input.right'].comp
  const Overlay = registered['shell.overlay'].comp

  stub.resetHooks()
  const compEl = Comp({ useInput: () => 'x', inputActions: { setDraft() {} } })
  buttonsOf(compEl).find((b) => plainText(b).indexOf('模板') !== -1).props.onClick()
  stub.resetHooks(); openCard(stub, Overlay)
  await stub.runEffects()

  stub.resetHooks()
  let ov = openCard(stub, Overlay)
  buttonsOf(ov).find((b) => plainText(b).indexOf('代码审查') !== -1).props.onClick()
  stub.resetHooks()
  ov = openCard(stub, Overlay)
  buttonsOf(ov).find((b) => plainText(b) === '渲染').props.onClick()
  await new Promise((r) => setTimeout(r, 20))

  stub.resetHooks()
  ov = openCard(stub, Overlay)
  const text = plainText(ov)
  assert.ok(text.indexOf('缺少必填变量') !== -1, '应把 host 的可读错误显示出来')
  assert.ok(text.indexOf('渲染') !== -1, '失败后应留在表单，允许改了再试')
  assert.deepEqual(stub.problems, [], '渲染不得有结构性错误')
})
