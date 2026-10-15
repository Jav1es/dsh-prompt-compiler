'use strict'

// 零依赖模板引擎 —— 「模板编译」的核心。
//
// 定位（与 LLM 编译并列，不是替代）：
//   compile(draft, options)  → 让 **LLM** 把粗糙草稿编译成 prompt（不确定、需推理）
//   render(templateId, vars) → 用 **模板** 确定性地渲染出 prompt（确定、可复现、零成本）
//   评审类任务（"按固定维度评一遍"）适合后者：维度固定、输出结构固定、要可复现。
//
// 🔴 为什么自己写而不用 zod + handlebars：
//   本插件的卖点之一是**零运行时依赖**（dependencies 为空、lib/ 随包入库、零构建，
//   lib/sdk.js 也是手写的）。我们需要的子集很小——变量替换 / 点路径 / each / if /
//   必填与类型校验——为它引入两个依赖，会让 `dsh plugin add` 多装两个包，
//   也会削弱「自包含」这条叙事。故手写，并用单测把边界钉死。
//
// 🔴 关键设计：**未定义变量必须报错，不能静默渲染成空串**。
//   起因：用户给的 portfolio-review 设计里，模板用了 {{role}}/{{task}}/{{#dimensions}}，
//   但变量表里这三个都没定义——静默渲染会产出一份"看起来正常、实则缺段"的 prompt，
//   这种失败极难发现。宁可在渲染期直接报错。
//
// 语法（刻意只做子集，够用即可）：
//   {{var}}              变量，支持点路径 {{background.years}}
//   {{.}}                迭代中的当前项（标量）
//   {{#each path}}…{{/each}}   数组迭代；块内可用 {{.}} / {{field}} / {{index}} / {{@index}}
//   {{#if path}}…{{/if}}       真值才渲染
//   \{{                  转义，输出字面量 {{
//
// 不转义 HTML —— 本引擎产出的是 **prompt 文本**，不是 HTML。

// ------------------------------------------------------------------ 工具

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function typeOf(v) {
  if (Array.isArray(v)) return 'array'
  if (v === null) return 'null'
  return typeof v
}

/** 归一化类型写法：同时接受 "string[]" 简写与标准 {type:'array',items:{type:'string'}}。 */
function normalizeType(def) {
  const t = def && def.type
  if (typeof t === 'string' && t.endsWith('[]')) {
    return { type: 'array', items: { type: t.slice(0, -2) } }
  }
  return { type: t, items: def && def.items }
}

/**
 * 按点路径取值。
 * 只有**键真实存在**才算 found —— 键存在但值是 undefined 也算 found，
 * 这样模板里 {{x}} 与"提供了 x: undefined"能被区分开。
 */
function getPath(root, path) {
  const p = String(path == null ? '' : path).trim()
  if (p === '.') {
    // 迭代标量时，作用域被包成 {'.': value}
    if (isPlainObject(root) && Object.prototype.hasOwnProperty.call(root, '.')) {
      return { found: true, value: root['.'] }
    }
    return { found: root !== undefined && root !== null, value: root }
  }
  if (!p) return { found: false, value: undefined }
  let cur = root
  for (const seg of p.split('.')) {
    if (!isPlainObject(cur) && !Array.isArray(cur)) return { found: false, value: undefined }
    if (!Object.prototype.hasOwnProperty.call(cur, seg)) return { found: false, value: undefined }
    cur = cur[seg]
  }
  return { found: true, value: cur }
}

/** 深合并：defaults ← given。数组整体替换（不做元素级合并，语义更可预期）。 */
function deepMerge(base, given) {
  const out = isPlainObject(base) ? { ...base } : {}
  if (!isPlainObject(given)) return out
  for (const [k, v] of Object.entries(given)) {
    if (v === undefined) continue // undefined = 不覆盖（与「显式给了 null」区分）
    out[k] = (isPlainObject(v) && isPlainObject(out[k])) ? deepMerge(out[k], v) : v
  }
  return out
}

// ------------------------------------------------------------------ 校验

/**
 * 校验变量是否满足模板声明的 schema。
 * @returns {{ok:boolean, errors:string[]}}
 */
function validateVars(schema, value, prefix) {
  const errors = []
  const pre = prefix || ''
  const props = (schema && schema.properties) || {}
  const src = isPlainObject(value) ? value : {}

  for (const [name, rawDef] of Object.entries(props)) {
    const def = rawDef || {}
    const v = src[name]
    const label = pre ? `${pre}.${name}` : name
    const empty = v === undefined || v === null || v === ''
    const emptyArr = Array.isArray(v) && v.length === 0

    if (def.required && (empty || emptyArr)) {
      errors.push(`缺少必填变量：${label}${def.description ? '（' + def.description + '）' : ''}`)
      continue
    }
    if (empty) continue

    const { type: want, items } = normalizeType(def)
    if (!want) continue

    const actual = typeOf(v)
    const okType =
      want === 'array' ? actual === 'array'
      : want === 'object' ? actual === 'object'
      : want === 'string' ? actual === 'string'
      : want === 'number' ? actual === 'number'
      : want === 'boolean' ? actual === 'boolean'
      : true
    if (!okType) {
      errors.push(`变量 ${label} 类型不符：期望 ${want}，实际 ${actual}`)
      continue
    }

    if (want === 'array' && items && items.type) {
      v.forEach((x, i) => {
        if (typeOf(x) !== items.type) {
          errors.push(`变量 ${label}[${i}] 类型不符：期望 ${items.type}，实际 ${typeOf(x)}`)
        }
      })
    }
    if (want === 'object' && def.properties) {
      errors.push(...validateVars({ properties: def.properties }, v, label).errors)
    }
  }
  return { ok: errors.length === 0, errors }
}

// ------------------------------------------------------------------ 解析

/**
 * 把模板切成节点树。
 * 返回 { nodes, pos, closed }：closed 是结束标签名（子块解析到 {{/x}} 时回传）。
 */
function parseNodes(src, pos) {
  const nodes = []
  let i = pos
  let text = ''

  const flush = () => { if (text) { nodes.push({ type: 'text', value: text }); text = '' } }

  while (i < src.length) {
    const open = src.indexOf('{{', i)
    if (open < 0) { text += src.slice(i); i = src.length; break }

    // 转义：\{{ → 字面量 {{。
    // ⚠️ 必须在 indexOf('{{') 之后、按**紧邻的反斜杠个数**判断——不能只在循环开头判断
    //    src.startsWith('\\{{', i)：因为上面是跳到 open 的，反斜杠早就被并进 text 里了
    //    （首版就是这么写的，被 "前缀 \{{x}} 后缀" 这条用例抓出来）。
    let bs = 0
    while (open - 1 - bs >= i && src[open - 1 - bs] === '\\') bs++
    if (bs >= 1) {
      // 规则：**紧邻 {{ 的最后一个反斜杠是转义符，它前面的反斜杠是字面量**。
      // 于是 \{{ → {{，\\{{ → \{{（字面量反斜杠 + 真的被转义的标签）。
      text += src.slice(i, open - bs) + '\\'.repeat(bs - 1) + '{{'
      i = open + 2
      continue
    }

    text += src.slice(i, open)
    const close = src.indexOf('}}', open + 2)
    if (close < 0) { text += src.slice(open); i = src.length; break } // 未闭合 → 当普通文本

    const inner = src.slice(open + 2, close).trim()
    i = close + 2

    if (inner.startsWith('/')) {
      flush()
      return { nodes, pos: i, closed: inner.slice(1).trim() }
    }

    const blockM = /^#(each|if)\s+(.+)$/.exec(inner)
    if (blockM) {
      const kind = blockM[1]
      const path = blockM[2].trim()
      flush()
      const sub = parseNodes(src, i)
      if (sub.closed !== kind) {
        nodes.push({ type: 'error', message: `{{#${kind} ${path}}} 没有对应的 {{/${kind}}}（实际收到 {{/${sub.closed || '文件结尾'}}}）` })
        i = sub.pos
        continue
      }
      nodes.push({ type: 'block', kind, path, children: sub.nodes })
      i = sub.pos
      continue
    }

    flush()
    nodes.push({ type: 'var', path: inner })
  }

  flush()
  return { nodes, pos: i, closed: null }
}

// ------------------------------------------------------------------ 渲染

function stringify(v) {
  if (v === null || v === undefined) return ''
  if (Array.isArray(v)) return v.map(stringify).join('、')
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

/**
 * {{#if}} 的真值判断。
 * ⚠️ 不能直接用 JS 真值：`[]` 与 `{}` 在 JS 里都是真值，但模板里
 *    {{#if background.metrics}} 明显是想要"有内容才渲染" —— 否则会产出
 *    "- 量化成果：" 这种空条目。故与 Handlebars 对齐：空数组 / 空对象为假。
 */
function isTruthy(v) {
  if (!v) return false
  if (Array.isArray(v)) return v.length > 0
  if (isPlainObject(v)) return Object.keys(v).length > 0
  return true
}

function renderNodes(nodes, scope, errors) {
  let out = ''
  for (const n of nodes) {
    if (n.type === 'text') { out += n.value; continue }

    if (n.type === 'error') { errors.push(n.message); continue }

    if (n.type === 'var') {
      const r = getPath(scope, n.path)
      if (!r.found) { errors.push(`模板引用了未定义变量：{{${n.path}}}`); continue }
      out += stringify(r.value)
      continue
    }

    if (n.type === 'block') {
      const r = getPath(scope, n.path)

      // 🔴 条件位与输出位的规则**刻意不同**：
      //   · {{x}}  缺 → 报错（输出位静默变空，是"看起来正常实则缺段"，必须拦）
      //   · {{#if x}} 缺 → 当作假，**不报错**。这本就是"有才渲染"的惯用法；
      //     若这里也报错，可选变量就没法写了——本模板的 coreSkills / background.*
      //     正是这种情况（首版就栽在这：护栏用力过猛，最小输入直接渲染失败）。
      //   · {{#each x}} 缺 → 当作空列表，同样不报错。
      //   模板作者写错路径的风险，由 auditTemplate() 在注册时静态告警兜底。
      if (n.kind === 'if') {
        if (r.found && isTruthy(r.value)) out += renderNodes(n.children, scope, errors)
        continue
      }

      // each
      if (!r.found) continue
      if (!Array.isArray(r.value)) {
        errors.push(`{{#each ${n.path}}} 的值不是数组（实际 ${typeOf(r.value)}）`)
        continue
      }
      r.value.forEach((item, idx) => {
        // 标量项包成 {'.': v}；对象项浅拷一份并补 index / @index
        const base = isPlainObject(item) ? { ...item } : { '.': item }
        const sub = { ...base, index: idx + 1, '@index': idx }
        out += renderNodes(n.children, sub, errors)
      })
      continue
    }
  }
  return out
}

/**
 * 渲染模板字符串。
 * @returns {{text:string, errors:string[]}}
 */
function renderString(tpl, scope) {
  const errors = []
  let ast
  try {
    ast = parseNodes(String(tpl == null ? '' : tpl), 0)
  } catch (e) {
    return { text: '', errors: [`模板解析失败：${e && e.message ? e.message : e}`] }
  }
  const text = renderNodes(ast.nodes, scope || {}, errors)
  return { text, errors }
}

// ------------------------------------------------------------------ 注册表

// ------------------------------------------------------------------ 静态审计

/**
 * 收集模板引用的路径。
 * 规则：块路径**总是**收集；输出位变量只在 {{#each}} 体**外**收集 ——
 * each 体内引用的是"元素字段"（如 {{name}}），元素形状不一定写进 schema，
 * 收集它只会制造误报。
 */
function collectRefs(nodes, inEach, out) {
  for (const n of nodes) {
    if (n.type === 'var') {
      if (!inEach) out.add(n.path)
      continue
    }
    if (n.type === 'block') {
      out.add(n.path)
      collectRefs(n.children, inEach || n.kind === 'each', out)
    }
  }
  return out
}

/** 点路径是否"有出处"：defaults 里真的有（含数组元素形状），或 variables.properties 里声明过。 */
function isDeclared(path, tpl) {
  if (path === '.' || path === 'index' || path === '@index') return true
  const segs = path.split('.')

  // ① 从 defaults 实际值里走
  let cur = tpl.defaults
  let viaDefaults = true
  for (const s of segs) {
    const v = Array.isArray(cur) ? cur[0] : cur
    if (!isPlainObject(v) || !Object.prototype.hasOwnProperty.call(v, s)) { viaDefaults = false; break }
    cur = v[s]
  }
  if (viaDefaults) return true

  // ② 从 variables.properties 里走（只认 properties，逐段下钻）
  cur = tpl.variables && tpl.variables.properties
  for (const s of segs) {
    if (!isPlainObject(cur) || !Object.prototype.hasOwnProperty.call(cur, s)) return false
    cur = cur[s]
    if (isPlainObject(cur) && isPlainObject(cur.properties)) cur = cur.properties
  }
  return true
}

/**
 * 模板静态审计：模板里引用的每个路径，是否都能从 defaults 或 variables 里找到出处。
 *
 * 🔴 为什么需要它：用户给的 portfolio-review 设计里，模板用了 {{role}} / {{task}} /
 *    {{#dimensions}}，但变量表里三个都没定义。而条件位 / 循环位的未定义是**静默**的
 *    （见 renderNodes 的注释），所以这类漏定义在运行时未必报错——必须在注册时静态抓。
 * @returns {{ok:boolean, missing:string[]}}
 */
function auditTemplate(tpl) {
  const nodes = parseNodes(String((tpl && tpl.template) || ''), 0).nodes
  const refs = collectRefs(nodes, false, new Set())
  const missing = [...refs].filter(p => !isDeclared(p, tpl || {}))
  return { ok: missing.length === 0, missing }
}

/** 模板数据的形状校验 —— 拦"写得不对的模板"，不是拦用户输入。 */
function validateTemplateShape(t) {
  const bad = []
  if (!t || typeof t !== 'object') return ['模板必须是对象']
  if (!t.id || typeof t.id !== 'string') bad.push('缺少 id')
  if (!t.template || typeof t.template !== 'string') bad.push('缺少 template')
  if (t.category && !['review', 'generate', 'transform'].includes(t.category)) {
    bad.push(`category 非法：${t.category}（只允许 review / generate / transform）`)
  }
  if (t.variables && !isPlainObject(t.variables)) bad.push('variables 必须是对象')
  if (t.defaults && !isPlainObject(t.defaults)) bad.push('defaults 必须是对象')
  return bad
}

/**
 * 建注册表。
 * @param {Array} templates 内置模板数据
 */
function createRegistry(templates) {
  const map = new Map()
  for (const t of templates || []) {
    const bad = validateTemplateShape(t)
    if (bad.length) {
      // 内置模板写错是**开发期错误**，但绝不能让插件起不来 —— 跳过并记录
      console.warn(`[prompt-compiler] 跳过非法模板 ${(t && t.id) || '(无 id)'}：${bad.join('；')}`)
      continue
    }
    // 形状合法 ≠ 引用合法：模板可能引用了谁都没提供的变量。这里静态告警，
    // 但不拒绝注册（拒绝会让插件因一个模板写错就少一个能力；告警 + 渲染期报错更稳）。
    const audit = auditTemplate(t)
    if (!audit.ok) {
      console.warn(`[prompt-compiler] 模板 ${t.id} 引用了未声明的变量：${audit.missing.join('、')}`)
    }
    map.set(t.id, t)
  }

  return {
    /** 列出模板元数据（**不含 template 正文**，避免工具返回体过大）。 */
    list() {
      return [...map.values()].map(t => ({
        id: t.id,
        version: t.version || '0.0.0',
        category: t.category || 'generate',
        title: t.title || t.id,
        description: t.description || '',
        variables: t.variables || {},
      }))
    },

    get(id) { return map.get(id) || null },

    /** 运行时注册（供将来读用户自定义模板用）。 */
    register(t) {
      const bad = validateTemplateShape(t)
      if (bad.length) return { ok: false, errors: bad }
      map.set(t.id, t)
      return { ok: true }
    },

    /**
     * 渲染：defaults ← vars 深合并 → 校验 → 渲染。
     * 任何一步失败都返回结构化错误，不抛裸异常。
     * @returns {{ok:true, text:string, id:string, version:string} | {ok:false, errors:string[]}}
     */
    render(id, vars) {
      const t = map.get(id)
      if (!t) {
        const ids = [...map.keys()]
        return { ok: false, errors: [`未找到模板 ${id}${ids.length ? '；可用：' + ids.join(', ') : ''}`] }
      }
      const values = deepMerge(t.defaults || {}, vars || {})
      const v = validateVars(t.variables || {}, values)
      if (!v.ok) return { ok: false, errors: v.errors }

      const r = renderString(t.template, values)
      if (r.errors.length) return { ok: false, errors: r.errors }

      return {
        ok: true,
        id: t.id,
        version: t.version || '0.0.0',
        text: r.text.replace(/\n{3,}/g, '\n\n').trim() + '\n',
      }
    },
  }
}

module.exports = {
  createRegistry,
  renderString,
  validateVars,
  validateTemplateShape,
  auditTemplate,
  collectRefs,
  isDeclared,
  deepMerge,
  getPath,
  normalizeType,
}
