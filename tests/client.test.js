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
function loadClient(settingsPayload) {
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
  }
  sandbox.globalThis = sandbox
  sandbox.fetch = () => Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ ok: true, settings: settingsPayload }),
  })
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
