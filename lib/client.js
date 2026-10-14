'use strict'

/**
 * dsh-prompt-compiler — Client half (D 组：UI 完整链路)。
 *
 * ModuleLoader 格式（window.__ModuleLoader__.load），手写 React.createElement，零构建。
 * 浏览器 UI：
 *   - composer 工具行右侧「✨ 编译」按钮（conversation.input.right）
 *   - 浮层卡片：诊断 / 澄清 / 预览 / 错误 / loading（shell.overlay）
 * 与 Host 半经 POST /__dsh-prompt-compiler/api/{analyze,elicit,compile} 通信。
 *
 * 红线：本文件除 require("react") 外，零 @deepseek-ai 运行时 import。
 */
window.__ModuleLoader__.load({
  id: 'dsh-prompt-compiler',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')

    var API = '/__dsh-prompt-compiler/api'

    // 把 callLLM 诊断对象转成中文提示（审计建议：暴露降级原因，避免静默）
    function diagText(d) {
      if (!d) return ''
      if (!d.hasLlm) return '原因：宿主未提供 ctx.llm（请在 DSH 配置可用的 LLM provider）。'
      if (!d.hasStream) return '原因：ctx.llm.stream 不可用（宿主 LLM 接口异常）。'
      if (d.err) return '原因：调用异常 — ' + d.err
      if (d.degenerateOutput) return '原因：宿主返回了无效内容（' + d.degenerateOutput + '），已视为失败并降级。'
      if (d.reject) {
        var detail = (Array.isArray(d.attemptsDetail) && d.attemptsDetail.length)
          ? ' ‖ 尝试明细：' + d.attemptsDetail.join(' ‖ ')
          : ''
        var meta = ''
        if (Array.isArray(d.registeredProviders) && d.registeredProviders.length) meta += ' ‖ 已注册=[' + d.registeredProviders.join(',') + ']'
        if (d.providerModels && typeof d.providerModels === 'object') meta += ' ‖ 模型映射=' + JSON.stringify(d.providerModels)
        if (Array.isArray(d.candidates) && d.candidates.length) meta += ' ‖ 候选=[' + d.candidates.join(',') + ']'
        if (d.providerUsed) meta += ' ‖ 命中provider=' + d.providerUsed
        if (d.modelId) meta += ' ‖ modelId=' + d.modelId
        if (Array.isArray(d.llmKeys) && d.llmKeys.length) meta += ' ‖ llm 键=[' + d.llmKeys.join(',') + ']'
        return '原因：宿主拒绝了插件调用 —— ' + d.reject + detail + meta
      }
      if (d.emptyStream) {
        var s = '原因：模型返回了空流（宿主未产出内容，可能被 purpose/source 策略拦截）。'
        if (typeof d.chunkCount === 'number') s += ' [chunk 数=' + d.chunkCount + (d.firstShape ? ', 首 chunk 形态=' + d.firstShape : '') + ']'
        return s
      }
      return '原因：未知（LLM 未返回内容）。'
    }

    // 非降级时的诊断行：让"LLM 成功"也可观测（chunk 数 / 首 chunk 形态 / 是否走了外部端点）
    function diagMeta(d) {
      if (!d) return ''
      var bits = []
      if (typeof d.chunkCount === 'number') bits.push('chunk 数=' + d.chunkCount)
      if (d.firstShape) bits.push('首 chunk 形态=' + d.firstShape)
      if (d.external) bits.push('外部端点=' + d.external)
      if (d.hasLlm === false) bits.push('宿主无 ctx.llm')
      return bits.length ? bits.join(' · ') : ''
    }

    // 直连兜底配置：浏览器侧 localStorage 暂存（开发者快速配置通道，不经 DSH 配置体系）。
    // host 侧 Node 读不到 localStorage，故每次 /compile 请求体携带 external，host 不持久化。
    var EXT_KEY = 'dsh-prompt-compiler-external'
    function loadExt() {
      try {
        var raw = window.localStorage.getItem(EXT_KEY)
        if (!raw) return { enabled: false, baseUrl: '', apiKey: '', model: '' }
        var o = JSON.parse(raw)
        return { enabled: !!o.enabled, baseUrl: o.baseUrl || '', apiKey: o.apiKey || '', model: o.model || '' }
      } catch (e) { return { enabled: false, baseUrl: '', apiKey: '', model: '' } }
    }
    function saveExt(o) {
      try { window.localStorage.setItem(EXT_KEY, JSON.stringify(o)) } catch (e) {}
    }

    // —— 简单 store（自写，零 @deepseek-ai 依赖；复用竞品模式） ——
    var store = {
      busy: false,
      error: null,
      draft: '',
      analysis: null,
      questions: null,
      answers: null,
      preview: null,
      assumptions: null,
      // 跨模型适配：空=默认 model-agnostic markdown；可选 gpt/claude/deepseek/local
      targetModel: '',
      polished: false,
      degraded: false,
      diag: null,
      configMode: false,
    }
    var listeners = new Set()
    function emit() { listeners.forEach(function (l) { l() }) }
    function patch(p) { Object.assign(store, p); emit() }
    function subscribe(fn) { listeners.add(fn); return function () { listeners.delete(fn) } }
    function close() {
      patch({
        busy: false, error: null, draft: '', analysis: null,
        questions: null, answers: null, preview: null, assumptions: null,
        polished: false, degraded: false,
        // targetModel 保留（用户偏好，不随关闭重置）
      })
    }

    var requestSeq = 0

    var CSS = [
      '.pc-btn{display:inline-flex;align-items:center;gap:4px;border:none;background:transparent;color:var(--dsw-alias-label-secondary,#777);font-size:12px;cursor:pointer;padding:4px 8px;border-radius:6px;white-space:nowrap}',
      '.pc-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2,#f0f0f0);color:var(--dsw-alias-label-primary,#222)}',
      '.pc-btn:disabled{opacity:.4;cursor:default}',
      '.pc-select{font-size:11px;height:22px;padding:0 2px;border:1px solid var(--dsw-alias-border-l2,#d5d5d5);border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#777);cursor:pointer;max-width:88px}',
      '.pc-select:disabled{opacity:.4;cursor:default}',
      '.pc-warn{background:#fff4e5;border:1px solid #ffb866;color:#8a4b00;font-size:12px;padding:8px 14px;line-height:1.5;word-break:break-word}',
      '.pc-diag{margin-top:4px;opacity:.85}',
      '.pc-field{display:block;font-size:12px;margin:8px 0 2px;color:var(--dsw-alias-label-primary,#222)}',
      '.pc-input{width:100%;box-sizing:border-box;font-size:13px;padding:6px 8px;border:1px solid var(--dsw-alias-border-l2,#d5d5d5);border-radius:6px;background:var(--dsw-alias-bg-input,#fff);color:var(--dsw-alias-label-primary,#222)}',
      '.pc-field input[type=checkbox]{vertical-align:middle;margin-right:4px}',
      '.pc-btn-icon{font-size:13px;line-height:1}',
      '.pc-mask{position:fixed;inset:0;z-index:1200;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.35);pointer-events:auto}',
      '.pc-card{background:var(--dsw-alias-bg-overlay,#fff);border:1px solid var(--dsw-alias-border-l2,#d5d5d5);border-radius:12px;box-shadow:0 10px 34px rgba(0,0,0,.22);width:min(600px,92vw);max-height:82vh;display:flex;flex-direction:column;color:var(--dsw-alias-label-primary,#222);font-size:14px;overflow:hidden}',
      '.pc-card-title{padding:14px 18px;font-weight:600;border-bottom:1px solid var(--dsw-alias-border-l1,#eee);flex:none}',
      '.pc-card-body{padding:14px 18px;overflow:auto}',
      '.pc-card-actions{padding:12px 18px;display:flex;justify-content:flex-end;gap:8px;border-top:1px solid var(--dsw-alias-border-l1,#eee);flex:none}',
      '.pc-muted{color:var(--dsw-alias-label-secondary,#666)}',
      '.pc-error{color:var(--dsw-alias-state-error-primary,#d33);white-space:pre-wrap;font-size:13px;margin-top:6px}',
      '.pc-diag{margin-bottom:12px}',
      '.pc-diag-score{font-weight:600;margin-bottom:6px}',
      '.pc-diag-sec{margin-top:8px}',
      '.pc-diag-h{font-weight:600;margin-bottom:4px;color:var(--dsw-alias-label-secondary,#666)}',
      '.pc-diag ul,.pc-assume ul{margin:4px 0 0;padding-left:18px}',
      '.pc-q{margin-bottom:14px}',
      '.pc-q-text{font-weight:600;margin-bottom:4px;line-height:1.5}',
      '.pc-q-why{color:var(--dsw-alias-label-secondary,#666);font-size:13px;margin-bottom:8px;line-height:1.5}',
      '.pc-input{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2,#ccc);border-radius:8px;padding:8px 10px;font-size:13px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#222)}',
      '.pc-preview{white-space:pre-wrap;font-size:13px;line-height:1.7;max-height:42vh;overflow:auto;background:var(--dsw-alias-bg-layer-1,#fafafa);border:1px solid var(--dsw-alias-border-l1,#eee);border-radius:8px;padding:12px 14px;color:var(--dsw-alias-label-primary,#222);margin:0}',
      '.pc-assume{margin-top:12px}',
      '.pc-primary{border:none;background:var(--dsw-alias-button-info-fill,#4d6bfe);color:#fff;border-radius:8px;padding:7px 16px;font-size:13px;font-weight:500;cursor:pointer}',
      '.pc-primary:hover:not(:disabled){background:var(--dsw-alias-button-info-hover,#6b86ff)}',
      '.pc-primary:disabled{opacity:.55;cursor:default}',
      '.pc-ghost{border:1px solid var(--dsw-alias-border-l2,#ccc);background:transparent;color:var(--dsw-alias-label-primary,#222);border-radius:8px;padding:7px 16px;font-size:13px;cursor:pointer}',
      '.pc-ghost:disabled{opacity:.55;cursor:default}',
    ].join('\n')

    function apply(ctx) {
      // 注入样式（effect 返回清理函数）。
      ctx.effect(function () {
        var el = document.createElement('style')
        el.textContent = CSS
        document.head.appendChild(el)
        return function () { el.remove() }
      })

      var slots = ctx.get('slots')
      if (slots === undefined) return

      async function rpc(path, body) {
        var res = await fetch(API + path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body || {}),
        })
        var data = await res.json().catch(function () { return {} })
        if (!res.ok) throw new Error((data && data.error) || ('HTTP ' + res.status))
        return data
      }

      // —— 诊断展示块 ——
      function DiagnosisBlock() {
        var a = store.analysis
        if (!a) return null
        return React.createElement('div', { className: 'pc-diag' },
          React.createElement('div', { className: 'pc-diag-score' },
            '完整度评分：' + (typeof a.score === 'number' ? a.score : '—') + ' / 100'),
          a.reasoning ? React.createElement('div', { className: 'pc-muted' }, a.reasoning) : null,
          Array.isArray(a.missing) && a.missing.length
            ? React.createElement('div', { className: 'pc-diag-sec' },
                React.createElement('div', { className: 'pc-diag-h' }, '缺失要素'),
                React.createElement('ul', null, a.missing.map(function (m, i) {
                  return React.createElement('li', { key: i }, m)
                })))
            : null,
          Array.isArray(a.ambiguities) && a.ambiguities.length
            ? React.createElement('div', { className: 'pc-diag-sec' },
                React.createElement('div', { className: 'pc-diag-h' }, '歧义点'),
                React.createElement('ul', null, a.ambiguities.map(function (m, i) {
                  return React.createElement('li', { key: i }, m)
                })))
            : null,
        )
      }

      // —— 澄清卡（questions） ——
      function QuestionsCard() {
        var items = store.questions || []
        var [answers, setAnswers] = React.useState(function () {
          var init = {}
          items.forEach(function (q) { init[q.id] = '' })
          return init
        })
        var [submitting, setSubmitting] = React.useState(false)
        var [err, setErr] = React.useState(null)
        function setOne(id, v) {
          setAnswers(function (prev) { var n = Object.assign({}, prev); n[id] = v; return n })
        }
        async function submit() {
          var seq = ++requestSeq
          setSubmitting(true); setErr(null)
          try {
            var c = await rpc('/compile', { draft: store.draft, answers: answers, targetModel: store.targetModel, external: loadExt() })
            if (seq !== requestSeq) return
            if (c && c.compiled) patch({ questions: null, preview: c.compiled, assumptions: c.assumptions || [], polished: !!c.polished, degraded: !!c.degraded, diag: c.diag || null })
            else { setErr('未获得编译结果'); setSubmitting(false) }
          } catch (e) {
            if (seq !== requestSeq) return
            setErr(String(e && e.message ? e.message : e)); setSubmitting(false)
          }
        }
        return React.createElement('div', { className: 'pc-mask' },
          React.createElement('div', { className: 'pc-card' },
            React.createElement('div', { className: 'pc-card-title' }, '诊断与澄清'),
            React.createElement('div', { className: 'pc-card-body' },
              React.createElement(DiagnosisBlock),
              React.createElement('div', { className: 'pc-diag-h' }, '为生成更精准的 prompt，请补充以下信息（可留空）'),
              items.map(function (q) {
                return React.createElement('div', { className: 'pc-q', key: q.id },
                  React.createElement('div', { className: 'pc-q-text' }, q.text),
                  q.why ? React.createElement('div', { className: 'pc-q-why' }, q.why) : null,
                  React.createElement('input', {
                    className: 'pc-input',
                    type: 'text',
                    value: answers[q.id] || '',
                    placeholder: '你的回答（可选）',
                    onChange: function (e) { setOne(q.id, e.target.value) },
                  }),
                )
              }),
              err ? React.createElement('div', { className: 'pc-error' }, String(err)) : null,
            ),
            React.createElement('div', { className: 'pc-card-actions' },
              React.createElement('button', { type: 'button', className: 'pc-ghost', onClick: close, disabled: submitting }, '取消'),
              React.createElement('button', { type: 'button', className: 'pc-primary', onClick: submit, disabled: submitting }, submitting ? '编译中…' : '生成编译结果'),
            ),
          ))
      }

      // —— 预览卡 ——
      function PreviewCard() {
        var text = store.preview || ''
        var [applied, setApplied] = React.useState(false)
        function applyDraftFn() {
          if (typeof store.applyDraft === 'function') store.applyDraft(text)
          setApplied(true); close()
        }
        return React.createElement('div', { className: 'pc-mask' },
          React.createElement('div', { className: 'pc-card' },
            React.createElement('div', { className: 'pc-card-title' }, '编译后的 prompt'),
            store.degraded
              ? React.createElement('div', { className: 'pc-warn' },
                  '⚠️ 当前为规则降级（宿主 LLM 未调用），仅套模板、未做文字优化。',
                  store.diag ? React.createElement('div', { className: 'pc-diag' }, diagText(store.diag)) : null)
              : null,
            React.createElement('div', { className: 'pc-card-body' },
              store.analysis ? React.createElement('div', { className: 'pc-muted' },
                '诊断评分：' + (typeof store.analysis.score === 'number' ? store.analysis.score : '—') + ' / 100') : null,
              // 非降级时也展示诊断元信息（chunk 数 / 首 chunk 形态 / 外部端点），让成功也可观测
              !store.degraded && diagMeta(store.diag)
                ? React.createElement('div', { className: 'pc-diag' }, '诊断：' + diagMeta(store.diag))
                : null,
              React.createElement('pre', { className: 'pc-preview' }, text),
              Array.isArray(store.assumptions) && store.assumptions.length
                ? React.createElement('div', { className: 'pc-assume' },
                    React.createElement('div', { className: 'pc-diag-h' }, '自动假设（请核对）'),
                    React.createElement('ul', null, store.assumptions.map(function (a, i) {
                      return React.createElement('li', { key: i }, a)
                    })))
                : null,
            ),
            React.createElement('div', { className: 'pc-card-actions' },
              React.createElement('button', {
                type: 'button', className: 'pc-ghost',
                onClick: function () { try { navigator.clipboard.writeText(text) } catch (e) {} },
                disabled: applied,
              }, '复制'),
              React.createElement('button', { type: 'button', className: 'pc-ghost', onClick: close, disabled: applied }, '关闭'),
              React.createElement('button', { type: 'button', className: 'pc-primary', onClick: applyDraftFn, disabled: applied }, applied ? '已回填' : '采用并回填'),
            ),
          ))
      }

      // —— conversation.input.right 按钮组件（持有 useInput / inputActions / store） ——
      function CompileButton(props) {
        var [, force] = React.useState(0)
        React.useEffect(function () {
          return subscribe(function () { force(function (v) { return v + 1 }) })
        }, [])
        var draft = props.useInput ? props.useInput(function (s) { return s.draft }) : ''
        var actions = props.inputActions
        // 回填桥接：overlay 无 inputActions，通过 store.applyDraft 复用本组件的 setDraft。
        store.applyDraft = (actions && typeof actions.setDraft === 'function')
          ? function (t) { return actions.setDraft(t) }
          : null
        var canRun = draft.trim().length > 0 && !store.busy && store.questions === null && store.preview === null
        async function onClick() {
          if (!canRun) return
          var seq = ++requestSeq
          var text = draft.trim()
          patch({ busy: true, error: null, draft: text, analysis: null, questions: null, answers: null, preview: null, assumptions: null })
          try {
            var analysis = await rpc('/analyze', { draft: text })
            if (seq !== requestSeq) return
            var missing = Array.isArray(analysis.missing) ? analysis.missing : []
            patch({ busy: false, analysis: analysis })
            if (missing.length > 0) {
              var e = await rpc('/elicit', { draft: text })
              if (seq !== requestSeq) return
              patch({ questions: Array.isArray(e.questions) ? e.questions : [], answers: {} })
            } else {
              var c = await rpc('/compile', { draft: text, answers: {}, targetModel: store.targetModel, external: loadExt() })
              if (seq !== requestSeq) return
              patch({ preview: c.compiled || '', assumptions: c.assumptions || [], polished: !!c.polished, degraded: !!c.degraded, diag: c.diag || null })
            }
          } catch (err) {
            if (seq !== requestSeq) return
            patch({ busy: false, error: String(err && err.message ? err.message : err) })
          }
        }
        return React.createElement(React.Fragment, null,
          React.createElement('button', {
            type: 'button',
            className: 'pc-btn',
            title: '把当前输入框的草稿编译成结构化 prompt（仅回填，不自动发送）',
            disabled: !canRun,
            onClick: onClick,
          },
            React.createElement('span', { className: 'pc-btn-icon' }, '✨'),
            React.createElement('span', null, store.busy ? '编译中' : '编译'),
          ),
          // 跨模型适配：composer 旁选择目标模型（默认空=model-agnostic markdown）
          React.createElement('select', {
            className: 'pc-select',
            title: '目标模型：决定编译输出的格式与语气风格',
            value: store.targetModel,
            disabled: store.busy,
            onChange: function (ev) { patch({ targetModel: ev.target.value }) },
          },
            React.createElement('option', { value: '' }, '通用'),
            React.createElement('option', { value: 'claude' }, 'Claude'),
            React.createElement('option', { value: 'gpt' }, 'GPT'),
            React.createElement('option', { value: 'deepseek' }, 'DeepSeek'),
            React.createElement('option', { value: 'local' }, '本地小模型'),
          ),
          // 直连兜底配置按钮（⚙）
          React.createElement('button', {
            type: 'button',
            className: 'pc-btn',
            title: '配置外部模型（当宿主 LLM 不可用时直连兜底）',
            disabled: store.busy,
            onClick: function () { patch({ configMode: true }) },
          }, '⚙')
        )
      }

      // —— 直连兜底配置卡（⚙ 打开；localStorage 暂存，compile 请求体携带） ——
      function ConfigCard() {
        var init = loadExt()
        var [enabled, setEnabled] = React.useState(init.enabled)
        var [baseUrl, setBaseUrl] = React.useState(init.baseUrl)
        var [apiKey, setApiKey] = React.useState(init.apiKey)
        var [model, setModel] = React.useState(init.model)
        function save() {
          var o = { enabled: !!enabled, baseUrl: baseUrl.trim(), apiKey: apiKey.trim(), model: model.trim() }
          saveExt(o)
          patch({ configMode: false })
        }
        return React.createElement('div', { className: 'pc-mask' },
          React.createElement('div', { className: 'pc-card' },
            React.createElement('div', { className: 'pc-card-title' }, '外部模型配置（直连兜底）'),
            React.createElement('div', { className: 'pc-card-body' },
              React.createElement('label', { className: 'pc-field' },
                React.createElement('input', { type: 'checkbox', checked: enabled, onChange: function (e) { setEnabled(e.target.checked) } }),
                ' 启用（宿主 LLM 不可用时直连此端点）'),
              React.createElement('label', { className: 'pc-field' }, 'Endpoint (OpenAI-compatible 或 ollama)'),
              React.createElement('input', { className: 'pc-input', type: 'text', placeholder: 'http://localhost:11434/api/chat 或 https://api.deepseek.com/v1/chat/completions', value: baseUrl, onChange: function (e) { setBaseUrl(e.target.value) } }),
              React.createElement('label', { className: 'pc-field' }, 'API Key（本地 ollama 留空）'),
              React.createElement('input', { className: 'pc-input', type: 'password', placeholder: 'sk-... 或留空', value: apiKey, onChange: function (e) { setApiKey(e.target.value) } }),
              React.createElement('label', { className: 'pc-field' }, 'Model 名'),
              React.createElement('input', { className: 'pc-input', type: 'text', placeholder: 'phi-4-mini / llama3.2 / deepseek-chat', value: model, onChange: function (e) { setModel(e.target.value) } }),
              React.createElement('div', { className: 'pc-muted' }, '配置存于浏览器 localStorage，仅本机；compile 时随请求发送，host 不落盘。'),
            ),
            React.createElement('div', { className: 'pc-card-actions' },
              React.createElement('button', { type: 'button', className: 'pc-ghost', onClick: function () { patch({ configMode: false }) } }, '取消'),
              React.createElement('button', { type: 'button', className: 'pc-primary', onClick: save }, '保存'),
            ),
          ))
      }

      // —— shell.overlay 卡片组件（从 store 读状态，无 inputActions） ——
      function OverlayCard() {
        var [, force] = React.useState(0)
        React.useEffect(function () {
          return subscribe(function () { force(function (v) { return v + 1 }) })
        }, [])
        if (store.configMode) return React.createElement(ConfigCard)
        if (store.busy) {
          return React.createElement('div', { className: 'pc-mask' },
            React.createElement('div', { className: 'pc-card' },
              React.createElement('div', { className: 'pc-card-title' }, '正在编译…'),
              React.createElement('div', { className: 'pc-card-body pc-muted' }, '正在分析草稿、调用模型编译，请稍候。'),
            ))
        }
        if (store.error) {
          return React.createElement('div', { className: 'pc-mask' },
            React.createElement('div', { className: 'pc-card' },
              React.createElement('div', { className: 'pc-card-title' }, '编译失败'),
              React.createElement('div', { className: 'pc-card-body' },
                React.createElement('div', { className: 'pc-error' }, String(store.error)),
              ),
              React.createElement('div', { className: 'pc-card-actions' },
                React.createElement('button', { type: 'button', className: 'pc-primary', onClick: close }, '关闭')),
            ))
        }
        if (store.questions) return React.createElement(QuestionsCard)
        if (store.preview) return React.createElement(PreviewCard)
        return null
      }

      // D2：两个 list slot 注册（裸 register 会 throw，必须用 slots.inject 包裹）。
      slots.inject('conversation.input.right', function () {
        return slots.register(
          { name: 'conversation.input.right', id: 'prompt-compiler-btn', order: 200 },
          CompileButton
        )
      })

      slots.inject('shell.overlay', function () {
        return slots.register(
          { name: 'shell.overlay', id: 'prompt-compiler-overlay', order: 200 },
          OverlayCard
        )
      })
    }

    exports.name = 'prompt-compiler'
    exports.inject = []
    exports.apply = apply
    return module.exports
  },
})
