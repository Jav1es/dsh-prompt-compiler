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

    // —— 问题3：模型徽章 ——
    // 用户要求「输出区域旁明确标示使用的模型」。
    // 关键：还要能一眼看出**走的是外部模型还是宿主模型**（用户反馈：配了外部却仍是本地）。
    function modelBadge(d) {
      if (!d) return '—'
      if (d.source === 'external') {
        var m = d.modelUsed || (d.usedModelLabel || '').replace(/^external\//, '')
        return '外部模型' + (m && m !== 'unknown' ? ' · ' + m : '')
      }
      var label = null
      if (d.usedModelLabel) label = d.usedModelLabel
      else if (d.modelUsed) label = (d.providerUsed ? d.providerUsed + '/' : '') + d.modelUsed
      else if (d.providerUsed) label = d.providerUsed
      if (!label) return d.source === 'host' ? '宿主模型' : '—'
      // 友好化：把 provider 前缀换成用户认得的名字
      return String(label)
        .replace(/^workbuddy-ai\//, 'WorkBuddy AI · ')
        .replace(/^workbuddy\//, 'WorkBuddy · ')
        .replace(/^deepseek-official\//, 'DeepSeek · ')
        .replace(/^deepseek-account\//, 'DeepSeek · ')
        .replace(/^nvidia\//, 'NVIDIA NIM · ')
        .replace(/^external\//, '外部模型 · ')
    }

    // 徽章是否为「外部模型」（用于着色区分）
    function isExternalBadge(d) {
      return !!(d && d.source === 'external')
    }

    // 外部模型配置：浏览器侧 localStorage 暂存（不经 DSH 配置体系）。
    // host 侧 Node 读不到 localStorage，故每次 /compile 请求体携带 external，host 不持久化。
    var EXT_KEY = 'dsh-prompt-compiler-external'
    var EXT_DEFAULT = { enabled: false, baseUrl: '', apiKey: '', model: '', priority: false }
    function loadExt() {
      try {
        var raw = window.localStorage.getItem(EXT_KEY)
        if (!raw) return Object.assign({}, EXT_DEFAULT)
        var o = JSON.parse(raw)
        return {
          enabled: !!o.enabled,
          baseUrl: o.baseUrl || '',
          apiKey: o.apiKey || '',
          model: o.model || '',
          // priority=true：外部模型优先（勾了「优先使用外部模型」）
          priority: !!o.priority,
        }
      } catch (e) { return Object.assign({}, EXT_DEFAULT) }
    }
    function saveExt(o) {
      try { window.localStorage.setItem(EXT_KEY, JSON.stringify(o)) } catch (e) {}
    }

    // —— 简单 store（自写，零 @deepseek-ai 依赖；复用竞品模式） ——
    var store = {
      busy: false,
      busyStage: null,
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
        busy: false, busyStage: null, error: null, draft: '', analysis: null,
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
      // —— 问题3：模型徽章 ——
      '.pc-badge{display:inline-flex;align-items:center;gap:6px;font-size:12px;padding:3px 10px;border-radius:999px;background:var(--dsw-alias-bg-layer-2,#eef1ff);color:var(--dsw-alias-button-info-fill,#4d6bfe);border:1px solid var(--dsw-alias-border-l2,#d5d9ff);white-space:nowrap}',
      // 外部模型徽章用绿色区分，一眼看出「走的是自己的模型」
      '.pc-badge-ext{background:#eaf7ee;color:#1f8a4c;border-color:#bfe6cd}',
      '.pc-badge-dot{width:6px;height:6px;border-radius:50%;background:currentColor;flex:none}',
      '.pc-badge-row{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-bottom:10px}',
      // —— 问题1：加载态（遮罩 + 转圈 + 文字） ——
      '.pc-loading-body{display:flex;align-items:center;gap:12px;padding:22px 18px}',
      '.pc-spinner{width:20px;height:20px;flex:none;border:2px solid var(--dsw-alias-border-l2,#d5d5d5);border-top-color:var(--dsw-alias-button-info-fill,#4d6bfe);border-radius:50%;animation:pc-spin .8s linear infinite}',
      '@keyframes pc-spin{to{transform:rotate(360deg)}}',
      '.pc-loading-text{font-size:13px;line-height:1.6;color:var(--dsw-alias-label-primary,#222)}',
      '.pc-loading-hint{font-size:12px;color:var(--dsw-alias-label-secondary,#888);margin-top:2px}',
      // —— 问题4：配置卡引导 ——
      '.pc-help{font-size:12px;color:var(--dsw-alias-label-secondary,#666);line-height:1.6;margin:2px 0 0}',
      '.pc-help code{background:var(--dsw-alias-bg-layer-2,#f0f0f0);padding:1px 4px;border-radius:4px;font-size:11px}',
      '.pc-preset{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0 2px}',
      '.pc-preset button{border:1px solid var(--dsw-alias-border-l2,#ccc);background:transparent;color:var(--dsw-alias-label-secondary,#666);border-radius:999px;padding:3px 10px;font-size:12px;cursor:pointer}',
      '.pc-preset button:hover{background:var(--dsw-alias-bg-layer-2,#f0f0f0);color:var(--dsw-alias-label-primary,#222)}',
      '.pc-req{color:var(--dsw-alias-state-error-primary,#d33);margin-left:2px}',
      '.pc-note{background:var(--dsw-alias-bg-layer-1,#fafafa);border:1px solid var(--dsw-alias-border-l1,#eee);border-radius:8px;padding:10px 12px;margin-top:10px;font-size:12px;line-height:1.7;color:var(--dsw-alias-label-secondary,#666)}',
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

      // —— 问题5：输出呈现前的最后一道清洗（防御性，host 已做 normalizeLlmOutput） ——
      // 用户反馈「编译好的内容充满很多 # 号、孤立 Task 行」。host 侧已改为保结构规整，
      // 这里再做一层廉价兜底：只针对**明显的残缺行**，不改动正常正文。
      //   · 形如 `## Acceptance Criteria 1.` 这种「标题后直接跟列表序号」的孤立行
      //     → 把末尾的 `1.` 拆到下一行（编号不该挂在标题上）
      //   · 单独一行的裸标题词（如只有 `Task`）→ 补上 `## ` 前缀，避免看起来像正文错乱
      function sanitizePreview(text) {
        if (typeof text !== 'string' || !text) return ''
        var heads = ['Task', 'Constraints', 'Output Format', 'Acceptance Criteria', 'Assumptions']
        var lines = text.split('\n')
        var out = []
        for (var i = 0; i < lines.length; i++) {
          var line = lines[i]
          // 1) 标题行末尾挂着列表序号：`## Acceptance Criteria 1.` → 拆行
          var m = line.match(/^\s{0,3}(#{1,6})\s*(.+?)\s+(\d{1,2}[.、])\s*$/)
          if (m && heads.some(function (h) { return m[2].trim() === h })) {
            out.push(m[1] + ' ' + m[2].trim())
            out.push(m[3])
            continue
          }
          // 2) 孤立裸标题词：整行只有 `Task` 这类词 → 补 `## `
          var t = line.trim()
          if (t && heads.indexOf(t) >= 0) {
            out.push('## ' + t)
            continue
          }
          out.push(line)
        }
        return out.join('\n')
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
            var ext = loadExt()
            var c = await rpc('/compile', { draft: store.draft, answers: answers, targetModel: store.targetModel, external: ext, extPriority: !!ext.priority })
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
              // 问题1：提交澄清答案后要真正调用模型编译（较慢），必须给出可见的进行中反馈，
              // 否则用户只看到按钮变灰、以为卡死。
              submitting
                ? React.createElement('div', { className: 'pc-loading-body' },
                    React.createElement('div', { className: 'pc-spinner' }),
                    React.createElement('div', { className: 'pc-loading-text' }, '正在调用模型编译…'))
                : null,
            ),
            React.createElement('div', { className: 'pc-card-actions' },
              React.createElement('button', { type: 'button', className: 'pc-ghost', onClick: close, disabled: submitting }, '取消'),
              React.createElement('button', { type: 'button', className: 'pc-primary', onClick: submit, disabled: submitting }, submitting ? '编译中…' : '生成编译结果'),
            ),
          ))
      }

      // —— 预览卡 ——
      function PreviewCard() {
        var text = sanitizePreview(store.preview || '')
        var [applied, setApplied] = React.useState(false)
        var badge = modelBadge(store.diag)
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
              // 模型徽章 —— 让用户一眼看到「这次是谁编的」，并区分外部/宿主来源
              React.createElement('div', { className: 'pc-badge-row' },
                React.createElement('span', {
                  className: 'pc-badge' + (isExternalBadge(store.diag) ? ' pc-badge-ext' : ''),
                  title: isExternalBadge(store.diag)
                    ? '本次编译调用的是你在 ⚙ 里配置的外部模型'
                    : '本次编译调用的是宿主（DSH 当前会话）的模型',
                },
                  React.createElement('span', { className: 'pc-badge-dot' }),
                  'Model: ' + (store.degraded && !badge ? '规则模板（未调用模型）' : badge)),
                store.analysis ? React.createElement('span', { className: 'pc-muted' },
                  '诊断评分：' + (typeof store.analysis.score === 'number' ? store.analysis.score : '—') + ' / 100') : null,
              ),
              // 来源说明行：直接回应用户「我配了外部模型为什么还是本地」
              !store.degraded && store.diag && store.diag.source
                ? React.createElement('div', { className: 'pc-diag' },
                    store.diag.source === 'external'
                      ? '本次走的是外部模型（⚙ 中配置的端点）。'
                      : (function () {
                          var ext = loadExt()
                          var cfgOk = ext.enabled && ext.baseUrl
                          // 情况一：外部调用失败 → 显示**具体原因**（用户最需要这条）
                          if (cfgOk && ext.priority && store.diag.extFailReason) {
                            return '本次回落到了宿主模型 —— 外部模型调用失败：'
                              + store.diag.extFailReason
                              + '（请检查 ⚙ 里的接口地址 / 密钥 / 模型名）'
                          }
                          // 情况二：配了但没选"外部优先" → 明确告诉用户怎么改
                          if (cfgOk && !ext.priority) {
                            return '本次走的是宿主模型 —— 你已配置外部模型，但当前模式是「宿主优先，外部兜底」，'
                              + '只有宿主失败时才会用到它。想强制走外部：到 ⚙ 选「外部模型优先」。'
                          }
                          // 情况三：没配或没启用
                          if (!cfgOk) {
                            return '本次走的是宿主模型（DSH 当前会话的模型）。'
                              + '想改用你自己的模型：点 ⚙ 配置并选择「外部模型优先」。'
                          }
                          return '本次走的是宿主模型（DSH 当前会话的模型）。'
                        })())
                : null,
              // 降级时也把外部配置状态说清楚（否则用户不知道是"没配"还是"配了没用上"）
              store.degraded && store.diag
                ? React.createElement('div', { className: 'pc-diag' },
                    (function () {
                      var ext = loadExt()
                      if (ext.enabled && ext.baseUrl) {
                        return '外部模型已配置但未成功产出'
                          + (store.diag.extFailReason ? '：' + store.diag.extFailReason : '')
                          + '；宿主模型也未返回内容，因此仅套用规则模板。'
                      }
                      return '未配置外部模型，且宿主模型未返回内容，因此仅套用规则模板。'
                    })())
                : null,
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
          // 问题1：busy 必须覆盖**整条链路**（analyze → elicit/compile），
          // 直到结果或错误出现才关闭。旧实现一拿到 analyze 结果就 busy=false，
          // 后面还要跑更慢的 /compile，中间露出空白 ⇒ 用户以为"弹窗一闪而过"。
          patch({
            busy: true, busyStage: '正在分析草稿…', error: null, draft: text,
            analysis: null, questions: null, answers: null, preview: null, assumptions: null,
          })
          try {
            var analysis = await rpc('/analyze', { draft: text })
            if (seq !== requestSeq) return
            var missing = Array.isArray(analysis.missing) ? analysis.missing : []
            patch({ analysis: analysis })
            if (missing.length > 0) {
              patch({ busyStage: '正在生成澄清问题…' })
              var e = await rpc('/elicit', { draft: text })
              if (seq !== requestSeq) return
              // 需要用户补充信息 ⇒ 结束加载态，转为澄清卡
              patch({ busy: false, busyStage: null, questions: Array.isArray(e.questions) ? e.questions : [], answers: {} })
            } else {
              patch({ busyStage: '正在调用模型编译…' })
              var ext = loadExt()
              var c = await rpc('/compile', { draft: text, answers: {}, targetModel: store.targetModel, external: ext, extPriority: !!ext.priority })
              if (seq !== requestSeq) return
              patch({
                busy: false, busyStage: null,
                preview: c.compiled || '', assumptions: c.assumptions || [],
                polished: !!c.polished, degraded: !!c.degraded, diag: c.diag || null,
              })
            }
          } catch (err) {
            if (seq !== requestSeq) return
            patch({ busy: false, busyStage: null, error: String(err && err.message ? err.message : err) })
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
            title: '配置外部模型（可设为优先使用，或在宿主不可用时兜底）',
            disabled: store.busy,
            onClick: function () { patch({ configMode: true }) },
          }, '⚙')
        )
      }

      // —— 直连兜底配置卡（⚙ 打开；localStorage 暂存，compile 请求体携带） ——
      // 问题4：用户反馈「配置外部模型的地方没有引导，看不懂什么意思」。
      // 现在补上：用途说明、每个字段的必填标记 + 占位示例 + 悬浮提示、一键预设、
      // 以及「什么时候才需要填这里」的说明。
      var PRESETS = [
        {
          name: '本地 ollama', baseUrl: 'http://localhost:11434/api/chat',
          model: 'llama3.2', apiKey: '', needKey: false,
          hint: '需先在本机运行 ollama（如 ollama pull llama3.2）；无需 API Key',
        },
        {
          name: 'DeepSeek 官方', baseUrl: 'https://api.deepseek.com/v1/chat/completions',
          model: 'deepseek-chat', apiKey: '', needKey: true,
          hint: '需填 DeepSeek 的 API Key（platform.deepseek.com 获取）',
        },
        {
          name: 'OpenAI 兼容', baseUrl: 'https://api.openai.com/v1/chat/completions',
          model: 'gpt-4o-mini', apiKey: '', needKey: true,
          hint: '任何 OpenAI 兼容端点均可：填完整的 /v1/chat/completions 地址',
        },
      ]
      function ConfigCard() {
        var init = loadExt()
        var [enabled, setEnabled] = React.useState(init.enabled)
        var [baseUrl, setBaseUrl] = React.useState(init.baseUrl)
        var [apiKey, setApiKey] = React.useState(init.apiKey)
        var [model, setModel] = React.useState(init.model)
        var [priority, setPriority] = React.useState(init.priority)
        var [tip, setTip] = React.useState('')
        function applyPreset(p) {
          setBaseUrl(p.baseUrl); setModel(p.model); setTip(p.hint)
          if (p.needKey) setEnabled(true)
        }
        // 启用的前置校验：地址和模型名是必填，缺了给出明确原因（而不是静默保存后编译失败）
        var invalid = enabled && (!baseUrl.trim() || !model.trim())
        function save() {
          if (invalid) { setTip('启用时必须填写「接口地址」和「模型名称」'); return }
          saveExt({
            enabled: !!enabled, baseUrl: baseUrl.trim(), apiKey: apiKey.trim(),
            model: model.trim(), priority: !!priority,
          })
          patch({ configMode: false })
        }
        return React.createElement('div', { className: 'pc-mask' },
          React.createElement('div', { className: 'pc-card' },
            React.createElement('div', { className: 'pc-card-title' }, '外部模型配置（直连兜底）'),
            React.createElement('div', { className: 'pc-card-body' },
              React.createElement('div', { className: 'pc-note' },
                '这里配置你自己拥有的模型接口（OpenAI 兼容 / 本地 ollama）。',
                React.createElement('br'),
                '不填也能用：插件默认调用 DSH 当前会话的模型。',
                '填了之后，用下面的开关决定「谁优先」。'),

              React.createElement('div', { className: 'pc-field', style: { marginTop: '10px' } }, '使用方式（二选一）'),
              React.createElement('label', { className: 'pc-field', style: { display: 'flex', alignItems: 'flex-start', gap: '6px' } },
                React.createElement('input', {
                  type: 'radio', name: 'pc-ext-mode', checked: enabled && !priority,
                  onChange: function () { setEnabled(true); setPriority(false) },
                }),
                React.createElement('span', null,
                  React.createElement('strong', null, '宿主优先，外部兜底（默认）'),
                  React.createElement('span', { className: 'pc-muted', style: { fontWeight: 'normal' } },
                    '　— 编译走 DSH 当前模型；只有宿主失败时才用下面的外部端点'))),

              React.createElement('label', { className: 'pc-field', style: { display: 'flex', alignItems: 'flex-start', gap: '6px' } },
                React.createElement('input', {
                  type: 'radio', name: 'pc-ext-mode', checked: enabled && priority,
                  onChange: function () { setEnabled(true); setPriority(true) },
                }),
                React.createElement('span', null,
                  React.createElement('strong', null, '外部模型优先'),
                  React.createElement('span', { className: 'pc-muted', style: { fontWeight: 'normal' } },
                    '　— 编译一律走下面的外部端点；只有外部失败时才回落到宿主。'),
                  React.createElement('div', { className: 'pc-help' },
                    '⚠️ 想「配了外部模型就一定用它」，请选这一项。'))),

              React.createElement('label', { className: 'pc-field', style: { marginTop: '6px' } },
                React.createElement('input', {
                  type: 'checkbox', checked: !enabled,
                  onChange: function (e) { setEnabled(!e.target.checked) },
                }),
                ' 不使用外部模型（只用宿主模型）'),

              React.createElement('div', { className: 'pc-field', style: { marginTop: '10px' } }, '快速填充（可点击套用示例）'),
              React.createElement('div', { className: 'pc-preset' },
                PRESETS.map(function (p, i) {
                  return React.createElement('button', {
                    key: i, type: 'button',
                    title: p.hint,
                    onClick: function () { applyPreset(p) },
                  }, p.name)
                })),

              React.createElement('label', { className: 'pc-field' },
                '接口地址', React.createElement('span', { className: 'pc-req' }, '*'),
                React.createElement('span', { className: 'pc-muted', style: { fontWeight: 'normal' } },
                  '　（OpenAI 兼容请填到 /v1/chat/completions；ollama 填 /api/chat）')),
              React.createElement('input', {
                className: 'pc-input', type: 'text',
                placeholder: '例：http://localhost:11434/api/chat',
                title: '模型服务的完整 HTTP 地址。本地 ollama 用 http://localhost:11434/api/chat；云端 OpenAI 兼容端点用 https://<域名>/v1/chat/completions',
                value: baseUrl, onChange: function (e) { setBaseUrl(e.target.value) },
              }),

              React.createElement('label', { className: 'pc-field' },
                'API Key',
                React.createElement('span', { className: 'pc-muted', style: { fontWeight: 'normal' } },
                  '　（本地 ollama 无需填写，留空即可）')),
              React.createElement('input', {
                className: 'pc-input', type: 'password',
                placeholder: '例：sk-xxxxxxxx（本地 ollama 留空）',
                title: '云端服务商的密钥。本地 ollama 不需要；密钥只存在本机浏览器 localStorage，不写入磁盘、不进日志。',
                value: apiKey, onChange: function (e) { setApiKey(e.target.value) },
              }),

              React.createElement('label', { className: 'pc-field' },
                '模型名称', React.createElement('span', { className: 'pc-req' }, '*'),
                React.createElement('span', { className: 'pc-muted', style: { fontWeight: 'normal' } },
                  '　（要与你端点上的模型 id 完全一致）')),
              React.createElement('input', {
                className: 'pc-input', type: 'text',
                placeholder: '例：llama3.2 / deepseek-chat / gpt-4o-mini',
                title: '端点上实际可用的模型 id。写错会返回 404/400；ollama 可用 `ollama list` 查看已下载的模型名。',
                value: model, onChange: function (e) { setModel(e.target.value) },
              }),

              tip ? React.createElement('div', { className: 'pc-help', style: { marginTop: '8px' } }, '💡 ' + tip) : null,

              React.createElement('div', { className: 'pc-note' },
                '隐私与存储：配置保存在本机浏览器 localStorage，仅本机可见；',
                '编译时才随请求发给宿主进程，宿主不落盘。清空浏览器数据即清除。'),
            ),
            React.createElement('div', { className: 'pc-card-actions' },
              React.createElement('button', {
                type: 'button', className: 'pc-ghost',
                onClick: function () {
                  setEnabled(false); setBaseUrl(''); setApiKey(''); setModel('')
                  saveExt({ enabled: false, baseUrl: '', apiKey: '', model: '' })
                  setTip('已清空外部模型配置，将使用宿主当前会话模型。')
                },
              }, '清空'),
              React.createElement('button', { type: 'button', className: 'pc-ghost', onClick: function () { patch({ configMode: false }) } }, '取消'),
              React.createElement('button', { type: 'button', className: 'pc-primary', onClick: save, disabled: invalid }, '保存'),
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
        // 问题1：加载态必须**始终**可见，直到结果返回或失败。
        // 旧实现只在 store.busy 时显示一个无动画的静态卡片，且 busy 在 /analyze 返回后
        // 立刻被置 false —— 若后续还要跑 /elicit 或 /compile（耗时更久），中间会出现
        // 「弹窗消失 / 空白」的空档，用户以为卡死了。现在 busy 覆盖整条链路。
        if (store.busy) {
          return React.createElement('div', { className: 'pc-mask' },
            React.createElement('div', { className: 'pc-card' },
              React.createElement('div', { className: 'pc-card-title' }, '正在编译…'),
              React.createElement('div', { className: 'pc-loading-body' },
                React.createElement('div', { className: 'pc-spinner' }),
                React.createElement('div', null,
                  React.createElement('div', { className: 'pc-loading-text' }, store.busyStage || '正在分析草稿…'),
                  React.createElement('div', { className: 'pc-loading-hint' }, '正在调用模型编译，请稍候（不会自动发送）'),
                ),
              ),
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
