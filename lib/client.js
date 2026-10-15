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

    // 把宿主回传的绝对路径缩成 ~ 开头再显示。
    // 起因：设置页/快捷卡原先直接回显 C:\Users\<用户名>\.dsh\...，
    // 这既啰嗦，也会把本机用户名带进截图（截图是要公开发布的）。
    // 认不出形状时**原样返回**——宁可显示真路径，也不编一个假的。
    function prettyPath(p) {
      if (typeof p !== 'string' || !p) return '~/.dsh/prompt-compiler/settings.json'
      var m = /^[A-Za-z]:\\Users\\[^\\]+\\/.exec(p) // Windows: C:\Users\<name>\...
      if (m) return '~\\' + p.slice(m[0].length)
      m = /^\/(?:home|Users)\/[^/]+\//.exec(p) // POSIX: /home/<name>/ 或 /Users/<name>/
      if (m) return '~/' + p.slice(m[0].length)
      return p
    }

    // 旧版遗留：外部模型配置曾存在浏览器 localStorage。
    // 现已迁到 host 侧持久化（lib/settings.js + /api/settings）。
    // 这里只保留**读取**，用于两个用途：
    //   ① 一次性迁移：老用户升级后把旧配置搬进 host（见 apply() 里的 migrateLegacyExt）
    //   ② 兜底：host 设置尚未加载完成时，currentExt() 暂时回退到它
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
    function clearLegacyExt() {
      try { window.localStorage.removeItem(EXT_KEY) } catch (e) {}
    }

    // —— 简单 store（自写，零 @deepseek-ai 依赖；复用竞品模式） ——
    var store = {
      busy: false,
      busyStage: null,
      error: null,      draft: '',
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
      // host 侧持久化设置（启动时拉取；设置页保存后刷新）
      settings: null,
      // —— 模板编译（评审类）的 UI 状态 ——
      // 与编译链路的 store 字段刻意分开：两条路径互不干扰，
      // 一边出错/关闭不会把另一边正在显示的结果清掉。
      templateMode: false,   // 是否打开模板卡
      templates: null,       // /api/templates 返回的模板元数据列表
      tplId: null,           // 已选模板 id；null = 还在选模板
      tplVars: {},           // 变量值（点路径扁平的嵌套对象）
      tplResult: null,       // /api/render 渲染结果
      tplBusy: false,
      tplError: null,
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
        // 模板卡的临时状态一并清掉（templates 列表留着，下次打开省一次请求）
        templateMode: false, tplId: null, tplVars: {}, tplResult: null, tplBusy: false, tplError: null,
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
      // 遮罩压暗到 55%：原先 35% 时，背景会话正文透过卡片仍可辨认（既伤可读性，也让截图无法公开）。
      '.pc-mask{position:fixed;inset:0;z-index:1200;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.55);pointer-events:auto}',
      // 🔴 别以为吃了 --dsw-alias-bg-overlay 就一定不透明：本主题下该 token 带 alpha，
      // 背景文字会透过来。backdrop-filter 把透出来的内容模糊掉，保证正文可读且截图可公开。
      '.pc-card{background:var(--dsw-alias-bg-overlay,#fff);backdrop-filter:blur(18px) saturate(1.1);-webkit-backdrop-filter:blur(18px) saturate(1.1);border:1px solid var(--dsw-alias-border-l2,#d5d5d5);border-radius:12px;box-shadow:0 10px 34px rgba(0,0,0,.30);width:min(600px,92vw);max-height:82vh;display:flex;flex-direction:column;color:var(--dsw-alias-label-primary,#222);font-size:14px;overflow:hidden}',
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
      // —— 设置页（settings.section）——
      // padding-bottom 必须 ≥ 底部 sticky 操作条的高度（约 51px）：滚动容器是宿主的面板，
      // 不是 .pcs 自己，没有这段留白时最后一行设置会永久压在「恢复默认/保存」条底下点不到。
      '.pcs{max-width:760px;color:var(--dsw-alias-label-primary,#222);padding-bottom:64px}',
      '.pcs-head{margin-bottom:20px}',
      '.pcs-title{margin:0 0 6px;font-size:18px;font-weight:600}',
      '.pcs-sub{margin:0;font-size:13px;line-height:1.7;color:var(--dsw-alias-label-secondary,#666)}',
      '.pcs-sub code{background:var(--dsw-alias-bg-layer-2,#f0f0f0);padding:1px 5px;border-radius:4px;font-size:12px}',
      '.pcs-loading{font-size:13px;color:var(--dsw-alias-label-secondary,#888);padding:20px 0}',
      '.pcs-sec{border-top:1px solid var(--dsw-alias-border-l1,#eee);padding:16px 0 6px}',
      '.pcs-sec-h{margin:0 0 4px;font-size:14px;font-weight:600}',
      '.pcs-sec-d{margin:0 0 12px;font-size:12px;line-height:1.7;color:var(--dsw-alias-label-secondary,#888)}',
      '.pcs-row{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:9px 0}',
      '.pcs-row-main{flex:1;min-width:0}',
      '.pcs-row-label{font-size:13px;font-weight:500;display:inline-flex;align-items:center;gap:6px}',
      '.pcs-row-hint{font-size:12px;line-height:1.65;color:var(--dsw-alias-label-secondary,#888);margin-top:3px}',
      '.pcs-row-ctl{flex:none;display:flex;align-items:center;padding-top:2px;max-width:52%}',
      '.pcs-tag{font-size:11px;color:var(--dsw-alias-state-error-primary,#d33);font-weight:400}',
      '.pcs-switch{width:16px;height:16px;cursor:pointer;accent-color:var(--dsw-alias-button-info-fill,#4d6bfe)}',
      '.pcs-switch:disabled{cursor:default;opacity:.5}',
      '.pcs-input{font-size:13px;padding:6px 9px;border:1px solid var(--dsw-alias-border-l2,#d5d5d5);border-radius:6px;background:var(--dsw-alias-bg-input,#fff);color:var(--dsw-alias-label-primary,#222);width:250px;max-width:100%;box-sizing:border-box}',
      '.pcs-input:disabled{opacity:.55}',
      '.pcs-sub-block{background:var(--dsw-alias-bg-layer-1,#fafafa);border:1px solid var(--dsw-alias-border-l1,#eee);border-radius:8px;padding:4px 14px 12px;margin:4px 0 8px}',
      '.pcs-radios{display:flex;gap:14px;flex-wrap:wrap}',
      '.pcs-radio{display:inline-flex;align-items:center;gap:5px;font-size:12px;cursor:pointer;white-space:nowrap}',
      '.pcs-actions{display:flex;align-items:center;gap:10px;border-top:1px solid var(--dsw-alias-border-l1,#eee);padding:14px 0 4px;margin-top:16px;position:sticky;bottom:0;background:var(--dsw-alias-bg-overlay,#fff)}',
      '.pcs-spacer{flex:1}',
      '.pcs-btn{font-size:13px;padding:6px 16px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2,#ccc);background:transparent;color:var(--dsw-alias-label-primary,#222);cursor:pointer}',
      '.pcs-btn:disabled{opacity:.5;cursor:default}',
      '.pcs-btn-primary{border:none;background:var(--dsw-alias-button-info-fill,#4d6bfe);color:#fff;font-weight:500}',
      '.pcs-msg{font-size:12px}',
      '.pcs-msg-ok{color:#1f8a4c}',
      '.pcs-msg-err{color:var(--dsw-alias-state-error-primary,#d33)}',
      // —— 模板卡（评审类模板）——
      '.pc-tpl-list{display:flex;flex-direction:column;gap:8px;max-height:52vh;overflow:auto}',
      '.pc-tpl-item{text-align:left;padding:10px 12px;border-radius:8px;cursor:pointer;' +
        'border:1px solid var(--dsw-alias-border-secondary,rgba(128,128,128,.28));' +
        'background:var(--dsw-alias-bg-secondary,rgba(128,128,128,.06))}',
      '.pc-tpl-item:hover{border-color:var(--dsw-alias-brand-primary,#4d6bfe)}',
      '.pc-tpl-item-title{font-weight:600;font-size:13px;display:flex;align-items:center;gap:6px}',
      '.pc-tpl-item-desc{font-size:12px;opacity:.72;margin-top:4px;line-height:1.5}',
      '.pc-tpl-tag{font-size:10px;padding:1px 6px;border-radius:99px;font-weight:400;' +
        'background:var(--dsw-alias-bg-tertiary,rgba(128,128,128,.18));opacity:.9}',
      '.pc-tpl-form{display:flex;flex-direction:column;gap:10px;max-height:52vh;overflow:auto;padding-right:2px}',
      '.pc-tpl-field{display:flex;flex-direction:column;gap:4px}',
      '.pc-tpl-label{font-size:12px;font-weight:600}',
      '.pc-tpl-req{color:var(--dsw-alias-state-error-primary,#d33);margin-left:3px}',
      '.pc-tpl-hint{font-size:11px;opacity:.62;line-height:1.45}',
      '.pc-tpl-input,.pc-tpl-area{width:100%;box-sizing:border-box;padding:6px 8px;border-radius:6px;' +
        'font-size:12px;font-family:inherit;color:inherit;' +
        'border:1px solid var(--dsw-alias-border-secondary,rgba(128,128,128,.3));' +
        'background:var(--dsw-alias-bg-primary,transparent)}',
      '.pc-tpl-area{min-height:90px;resize:vertical;line-height:1.5}',
      '.pc-tpl-sub{margin-left:10px;padding-left:10px;display:flex;flex-direction:column;gap:8px;' +
        'border-left:2px solid var(--dsw-alias-border-secondary,rgba(128,128,128,.22))}',
      '.pc-tpl-preview{white-space:pre-wrap;word-break:break-word;font-size:12px;line-height:1.6;' +
        'max-height:46vh;overflow:auto;padding:10px;border-radius:8px;' +
        'background:var(--dsw-alias-bg-secondary,rgba(128,128,128,.07))}',
      '.pc-tpl-meta{font-size:11px;opacity:.65;margin-bottom:6px}',
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

      // 启动即拉一次 host 侧设置：让 targetModel / 诊断可见性等立即生效。
      // 失败不影响插件（各处以默认值兜底）。
      refreshSettings()

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

      // —— 设置：host 侧持久化配置，启动时拉一次并缓存在 store.settings ——
      // 用途：① 让 UI 的 targetModel / 诊断可见性跟随设置页；
      //      ② 让设置页以外的地方也能读到当前偏好，无需各自再请求。
      function refreshSettings() {
        return rpc('/settings', {}).then(function (r) {
          var s = r && r.settings
          if (s) {
            patch({ settings: s })
            // 一次性迁移：host 侧还没有外部模型配置，但旧版 localStorage 里有 →
            // 搬进 host 并清掉本地副本（避免两份配置打架）。
            var hostEmpty = !s.external || (!s.external.baseUrl && !s.external.model)
            var legacy = loadExt()
            if (hostEmpty && legacy.baseUrl) {
              return rpc('/settings', {
                action: 'set',
                settings: {
                  external: {
                    enabled: !!legacy.enabled, priority: !!legacy.priority,
                    baseUrl: legacy.baseUrl, model: legacy.model, apiKey: legacy.apiKey || '',
                  },
                },
              }).then(function (r2) {
                if (r2 && r2.ok) {
                  clearLegacyExt()
                  patch({ settings: r2.settings })
                  return r2.settings
                }
                return s
              }).catch(function () { return s })
            }
          }
          return s
        }).catch(function () { return null })
      }

      // 读取当前生效的外部模型配置。设置已迁到 host 侧持久化（store.settings），
      // localStorage 仅作旧版本兼容回退。
      function currentExt() {
        var s = store.settings
        if (s && s.external) return s.external
        return loadExt()
      }

      // 读取一个诊断可见性开关（缺设置时按 true，保持旧行为）
      function diagFlag(key) {
        var s = store.settings
        if (!s || !s.diagnostics) return true
        return s.diagnostics[key] !== false
      }

      // 行为类开关
      function behaviorFlag(key) {
        var s = store.settings
        if (!s || !s.behavior) return false
        return s.behavior[key] === true
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
            // 设置一律由 host 读持久化配置（/api/settings），此处不传 external，
            // 避免浏览器 localStorage 与 host 设置两份真相源打架。
            var c = await rpc('/compile', { draft: store.draft, answers: answers, targetModel: store.targetModel || undefined })
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
            // 降级警告（设置页「降级时警告」可关）
            store.degraded && diagFlag('warnOnDegrade')
              ? React.createElement('div', { className: 'pc-warn' },
                  '⚠️ 当前为规则降级（宿主 LLM 未调用），仅套模板、未做文字优化。',
                  store.diag && diagFlag('showDiagMeta') ? React.createElement('div', { className: 'pc-diag' }, diagText(store.diag)) : null)
              : null,
            React.createElement('div', { className: 'pc-card-body' },
              // 模型徽章 —— 让用户一眼看到「这次是谁编的」，并区分外部/宿主来源
              (diagFlag('showModelBadge') || diagFlag('showScore'))
                ? React.createElement('div', { className: 'pc-badge-row' },
                    diagFlag('showModelBadge')
                      ? React.createElement('span', {
                          className: 'pc-badge' + (isExternalBadge(store.diag) ? ' pc-badge-ext' : ''),
                          title: isExternalBadge(store.diag)
                            ? '本次编译调用的是你在设置里配置的外部模型'
                            : '本次编译调用的是宿主（DSH 当前会话）的模型',
                        },
                          React.createElement('span', { className: 'pc-badge-dot' }),
                          'Model: ' + (store.degraded && !badge ? '规则模板（未调用模型）' : badge))
                      : null,
                    (diagFlag('showScore') && store.analysis) ? React.createElement('span', { className: 'pc-muted' },
                      '诊断评分：' + (typeof store.analysis.score === 'number' ? store.analysis.score : '—') + ' / 100') : null,
                  )
                : null,
              // 来源说明行：直接回应用户「我配了外部模型为什么还是本地」
              !store.degraded && store.diag && store.diag.source
                ? React.createElement('div', { className: 'pc-diag' },
                    store.diag.source === 'external'
                      ? '本次走的是外部模型（设置里配置的端点）。'
                      : (function () {
                          var ext = currentExt()
                          var cfgOk = ext.enabled && ext.baseUrl
                          // 情况一：外部调用失败 → 显示**具体原因**（用户最需要这条）
                          if (cfgOk && ext.priority && store.diag.extFailReason) {
                            return '本次回落到了宿主模型 —— 外部模型调用失败：'
                              + store.diag.extFailReason
                              + '（请检查设置里的接口地址 / 密钥 / 模型名）'
                          }
                          // 情况二：配了但没选"外部优先" → 明确告诉用户怎么改
                          if (cfgOk && !ext.priority) {
                            return '本次走的是宿主模型 —— 你已配置外部模型，但当前模式是「宿主优先，外部兜底」，'
                              + '只有宿主失败时才会用到它。想强制走外部：到「设置 → Prompt Compiler」选「外部模型优先」。'
                          }
                          // 情况三：没配或没启用
                          if (!cfgOk) {
                            return '本次走的是宿主模型（DSH 当前会话的模型）。'
                              + '想改用你自己的模型：到「设置 → Prompt Compiler」配置。'
                          }
                          return '本次走的是宿主模型（DSH 当前会话的模型）。'
                        })())
                : null,
              // 降级时也把外部配置状态说清楚（否则用户不知道是"没配"还是"配了没用上"）
              store.degraded && store.diag
                ? React.createElement('div', { className: 'pc-diag' },
                    (function () {
                      var ext = currentExt()
                      if (ext.enabled && ext.baseUrl) {
                        return '外部模型已配置但未成功产出'
                          + (store.diag.extFailReason ? '：' + store.diag.extFailReason : '')
                          + '；宿主模型也未返回内容，因此仅套用规则模板。'
                      }
                      return '未配置外部模型，且宿主模型未返回内容，因此仅套用规则模板。'
                    })())
                : null,
              // 非降级时也展示诊断元信息（chunk 数 / 首 chunk 形态 / 外部端点），让成功也可观测
              (!store.degraded && diagFlag('showDiagMeta') && diagMeta(store.diag))
                ? React.createElement('div', { className: 'pc-diag' }, '诊断：' + diagMeta(store.diag))
                : null,
              React.createElement('pre', { className: 'pc-preview' }, text),
              (behaviorFlag('showAssumptions') && Array.isArray(store.assumptions) && store.assumptions.length)
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
              // 设置由 host 侧的持久化配置决定（设置页维护），此处不再传 localStorage 的 external
              var c = await rpc('/compile', { draft: text, answers: {}, targetModel: store.targetModel || undefined })
              if (seq !== requestSeq) return
              patch({
                busy: false, busyStage: null,
                preview: c.compiled || '', assumptions: c.assumptions || [],
                polished: !!c.polished, degraded: !!c.degraded, diag: c.diag || null,
              })
              // 设置页「编译后自动回填」：填回输入框（仍不自动发送）
              if (behaviorFlag('autoApply') && c.compiled && typeof store.applyDraft === 'function') {
                store.applyDraft(c.compiled)
              }
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
          // 模板入口：评审类任务走模板（确定性、可复现、不消耗模型调用）。
          // 与「编译」是**两条并列路径**，所以给独立入口，而不是塞进编译链路里——
          // 否则用户会以为"模板"是编译的一个选项。
          React.createElement('button', {
            type: 'button',
            className: 'pc-btn',
            title: '用模板渲染 prompt（评审类：作品集评审 / 代码审查 / Prompt 评审）——不消耗模型调用',
            disabled: store.busy,
            onClick: function () {
              patch({ templateMode: true, tplId: null, tplVars: {}, tplResult: null, tplError: null })
            },
          },
            React.createElement('span', { className: 'pc-btn-icon' }, '📋'),
            React.createElement('span', null, '模板'),
          ),
          // 跨模型适配：composer 旁选择目标模型。
          // 默认值优先取设置页保存的偏好（host 侧），未保存过则为「通用」。
          React.createElement('select', {
            className: 'pc-select',
            title: '目标模型：决定编译输出的格式与语气风格（可在设置里设默认值）',
            value: store.targetModel || (store.settings && store.settings.compile ? store.settings.compile.targetModel : '') || '',
            disabled: store.busy,
            onChange: function (ev) { patch({ targetModel: ev.target.value }) },
          },
            React.createElement('option', { value: '' }, '通用'),
            React.createElement('option', { value: 'claude' }, 'Claude'),
            React.createElement('option', { value: 'gpt' }, 'GPT'),
            React.createElement('option', { value: 'deepseek' }, 'DeepSeek'),
            React.createElement('option', { value: 'local' }, '本地小模型'),
          ),
          // 外部模型快捷设置按钮（⚙）—— 完整设置见 DSH 设置面板
          React.createElement('button', {
            type: 'button',
            className: 'pc-btn',
            title: '外部模型快捷设置（完整设置：DSH 设置 → Prompt Compiler）',
            disabled: store.busy,
            onClick: function () {
              // 打开前确保读到最新设置（可能与设置页里刚改的不同步）
              refreshSettings()
              patch({ configMode: true })
            },
          }, '⚙')
        )
      }

      // —— 外部模型快捷设置卡（⚙ 打开） ——
      // 它只是设置页的快捷入口：读写 host 侧同一份配置（lib/settings.js），
      // 不再使用浏览器 localStorage（旧配置会在启动时一次性迁移，见 refreshSettings）。
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
        // 单一真相源：host 侧持久化设置（store.settings，由 /api/settings 维护）。
        // 本卡只是设置页的快捷入口，读写同一份配置 —— 不再使用浏览器 localStorage。
        var cur = currentExt()
        var [enabled, setEnabled] = React.useState(!!cur.enabled)
        var [baseUrl, setBaseUrl] = React.useState(cur.baseUrl || '')
        var [apiKey, setApiKey] = React.useState('')
        var [model, setModel] = React.useState(cur.model || '')
        var [priority, setPriority] = React.useState(!!cur.priority)
        var [tip, setTip] = React.useState('')
        var [busy, setBusy] = React.useState(false)
        function applyPreset(p) {
          setBaseUrl(p.baseUrl); setModel(p.model); setTip(p.hint)
          if (p.needKey) setEnabled(true)
        }
        // 启用的前置校验：地址和模型名是必填，缺了给出明确原因（而不是静默保存后编译失败）
        var invalid = enabled && (!baseUrl.trim() || !model.trim())
        function persist(extPatch, okTip) {
          if (busy) return
          setBusy(true); setTip('')
          rpc('/settings', { action: 'set', settings: { external: extPatch } }).then(function (r) {
            setBusy(false)
            if (r && r.ok) {
              patch({ settings: r.settings, configMode: false })
            } else {
              setTip('保存失败：' + ((r && r.error) || '未知错误'))
            }
          }).catch(function (e) {
            setBusy(false)
            setTip('保存失败：' + (e && e.message ? e.message : e))
          })
        }
        function save() {
          if (invalid) { setTip('启用时必须填写「接口地址」和「模型名称」'); return }
          // apiKey 留空 = 不修改（host 侧保留原值）
          var ext = {
            enabled: !!enabled, baseUrl: baseUrl.trim(),
            model: model.trim(), priority: !!priority,
          }
          if (apiKey.trim()) ext.apiKey = apiKey.trim()
          persist(ext)
        }
        return React.createElement('div', { className: 'pc-mask' },
          React.createElement('div', { className: 'pc-card' },
            React.createElement('div', { className: 'pc-card-title' }, '外部模型配置（快捷设置）'),
            React.createElement('div', { className: 'pc-card-body' },
              React.createElement('div', { className: 'pc-note' },
                '这里配置你自己拥有的模型接口（OpenAI 兼容 / 本地 ollama）。',
                React.createElement('br'),
                '不填也能用：插件默认调用 DSH 当前会话的模型。',
                '填了之后，用下面的开关决定「谁优先」。',
                React.createElement('br'),
                React.createElement('span', { className: 'pc-muted' },
                  '更多设置（编译风格、输出格式、诊断显示等）在「设置 → Prompt Compiler」里。')),

              React.createElement('div', { className: 'pc-field', style: { marginTop: '10px' } }, '使用方式（二选一）'),
              React.createElement('label', { className: 'pc-field', style: { display: 'flex', alignItems: 'flex-start', gap: '6px' } },
                React.createElement('input', {
                  type: 'radio', name: 'pc-ext-mode', checked: enabled && !priority, disabled: busy,
                  onChange: function () { setEnabled(true); setPriority(false) },
                }),
                React.createElement('span', null,
                  React.createElement('strong', null, '宿主优先，外部兜底（默认）'),
                  React.createElement('span', { className: 'pc-muted', style: { fontWeight: 'normal' } },
                    '　— 编译走 DSH 当前模型；只有宿主失败时才用下面的外部端点'))),

              React.createElement('label', { className: 'pc-field', style: { display: 'flex', alignItems: 'flex-start', gap: '6px' } },
                React.createElement('input', {
                  type: 'radio', name: 'pc-ext-mode', checked: enabled && priority, disabled: busy,
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
                  type: 'checkbox', checked: !enabled, disabled: busy,
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
                className: 'pc-input', type: 'text', disabled: busy,
                placeholder: '例：http://localhost:11434/api/chat',
                title: '模型服务的完整 HTTP 地址。本地 ollama 用 http://localhost:11434/api/chat；云端 OpenAI 兼容端点用 https://<域名>/v1/chat/completions',
                value: baseUrl, onChange: function (e) { setBaseUrl(e.target.value) },
              }),

              React.createElement('label', { className: 'pc-field' },
                'API Key',
                React.createElement('span', { className: 'pc-muted', style: { fontWeight: 'normal' } },
                  cur.apiKeySet ? '　（已保存，留空表示不修改）' : '　（本地 ollama 无需填写，留空即可）')),
              React.createElement('input', {
                className: 'pc-input', type: 'password', disabled: busy,
                placeholder: cur.apiKeySet ? '（已设置，留空不变）' : '例：sk-xxxxxxxx（本地 ollama 留空）',
                title: '云端服务商的密钥。本地 ollama 不需要；密钥只存在本机宿主文件里，不回显、不进日志。',
                value: apiKey, onChange: function (e) { setApiKey(e.target.value) },
              }),

              React.createElement('label', { className: 'pc-field' },
                '模型名称', React.createElement('span', { className: 'pc-req' }, '*'),
                React.createElement('span', { className: 'pc-muted', style: { fontWeight: 'normal' } },
                  '　（要与你端点上的模型 id 完全一致）')),
              React.createElement('input', {
                className: 'pc-input', type: 'text', disabled: busy,
                placeholder: '例：llama3.2 / deepseek-chat / gpt-4o-mini',
                title: '端点上实际可用的模型 id。写错会返回 404/400；ollama 可用 `ollama list` 查看已下载的模型名。',
                value: model, onChange: function (e) { setModel(e.target.value) },
              }),

              tip ? React.createElement('div', { className: 'pc-help', style: { marginTop: '8px' } }, '💡 ' + tip) : null,

              React.createElement('div', { className: 'pc-note' },
                '存储位置：宿主本机配置文件（',
                React.createElement('code', null, prettyPath(store.settings && store.settings._path)),
                '），对所有会话生效；密钥不回显、不进日志。'),
            ),
            React.createElement('div', { className: 'pc-card-actions' },
              React.createElement('button', {
                type: 'button', className: 'pc-ghost', disabled: busy,
                onClick: function () {
                  setEnabled(false); setBaseUrl(''); setApiKey(''); setModel('')
                  persist({ enabled: false, baseUrl: '', model: '', apiKey: '', priority: false })
                },
              }, '清空'),
              React.createElement('button', { type: 'button', className: 'pc-ghost', onClick: function () { patch({ configMode: false }) }, disabled: busy }, '取消'),
              React.createElement('button', { type: 'button', className: 'pc-primary', onClick: save, disabled: invalid || busy }, busy ? '保存中…' : '保存'),
            ),
          ))
      }

      // ══════════════════════════════════════════════════════════════════
      // 模板卡（评审类模板）：选模板 → 填变量 → 渲染 → 采用并回填。
      //
      // 与「✨ 编译」的分工（UI 上刻意分成两个入口，不塞进同一条链路）：
      //   · 编译 = 把输入框里的草稿交给 LLM 改写（需推理、每次可能不同）
      //   · 模板 = 用固定模板确定性渲染（同输入同输出、**不消耗模型调用**）
      //
      // 🔴 变量表单由模板的 `variables` schema **自动生成** ——
      //    所以以后新增模板完全不用碰这里（这是 host 侧把模板做成数据换来的）。
      // ══════════════════════════════════════════════════════════════════

      // 点路径读写：变量按 { background: { years: '5 年+' } } 嵌套存，表单按 'background.years' 寻址
      function tplPathGet(path) {
        var cur = store.tplVars
        var segs = String(path).split('.')
        for (var i = 0; i < segs.length; i++) {
          if (cur === null || typeof cur !== 'object') return undefined
          cur = cur[segs[i]]
        }
        return cur
      }
      function tplPathSet(path, value) {
        var next = JSON.parse(JSON.stringify(store.tplVars || {}))
        var segs = String(path).split('.')
        var cur = next
        for (var i = 0; i < segs.length - 1; i++) {
          if (cur[segs[i]] === null || typeof cur[segs[i]] !== 'object') cur[segs[i]] = {}
          cur = cur[segs[i]]
        }
        cur[segs[segs.length - 1]] = value
        patch({ tplVars: next })
      }

      // 按 schema 生成控件。支持 string / string[]（含 "string[]" 简写）/ object（下钻）。
      function tplField(name, def, path) {
        var type = def && def.type
        var isArr = type === 'array' || (typeof type === 'string' && type.slice(-2) === '[]')
        var label = React.createElement('div', { className: 'pc-tpl-label' }, name,
          def && def.required ? React.createElement('span', { className: 'pc-tpl-req' }, '*') : null)
        var hint = def && def.description
          ? React.createElement('div', { className: 'pc-tpl-hint' }, def.description) : null

        if (type === 'object' && def.properties) {
          return React.createElement('div', { className: 'pc-tpl-field', key: path },
            label, hint,
            React.createElement('div', { className: 'pc-tpl-sub' },
              Object.keys(def.properties).map(function (k) {
                return tplField(k, def.properties[k], path + '.' + k)
              })))
        }

        if (isArr) {
          var arrVal = tplPathGet(path)
          return React.createElement('div', { className: 'pc-tpl-field', key: path },
            label, hint,
            React.createElement('input', {
              className: 'pc-tpl-input', type: 'text',
              value: Array.isArray(arrVal) ? arrVal.join('、') : (arrVal || ''),
              placeholder: '多个值用「、」或逗号分隔',
              onChange: function (ev) {
                // 空串 → 空数组（不能是 ['']，否则"没填必填项"会被当成填了）
                tplPathSet(path, ev.target.value.split(/[、,，\n]/)
                  .map(function (s) { return s.trim() }).filter(Boolean))
              },
            }))
        }

        // 长文本字段用 textarea（代码 / 草稿 / 背景这类）
        var long = /^(code|draft|context|text|content)$/i.test(name)
        var val = tplPathGet(path)
        var v = typeof val === 'string' ? val : ''
        return React.createElement('div', { className: 'pc-tpl-field', key: path },
          label, hint,
          long
            ? React.createElement('textarea', {
                className: 'pc-tpl-area', value: v,
                onChange: function (ev) { tplPathSet(path, ev.target.value) },
              })
            : React.createElement('input', {
                className: 'pc-tpl-input', type: 'text', value: v,
                onChange: function (ev) { tplPathSet(path, ev.target.value) },
              }))
      }

      function TemplateCard() {
        var [, force] = React.useState(0)
        React.useEffect(function () {
          return subscribe(function () { force(function (x) { return x + 1 }) })
        }, [])
        // 挂载时拉一次模板列表；已有缓存就不重复请求
        React.useEffect(function () {
          if (store.templates || store.tplError) return
          rpc('/templates', {}).then(function (r) {
            patch({ templates: (r && r.templates) || [] })
          }).catch(function (e) {
            patch({ tplError: String(e && e.message ? e.message : e) })
          })
        }, [])

        var title = function (t) { return React.createElement('div', { className: 'pc-card-title' }, t) }
        var closeRow = function () {
          return React.createElement('div', { className: 'pc-card-actions' },
            React.createElement('button', { type: 'button', className: 'pc-btn', onClick: close }, '关闭'))
        }

        if (store.tplError && !store.templates) {
          return React.createElement('div', { className: 'pc-mask' },
            React.createElement('div', { className: 'pc-card' },
              title('模板加载失败'),
              React.createElement('div', { className: 'pc-card-body' },
                React.createElement('div', { className: 'pc-error' }, String(store.tplError))),
              closeRow()))
        }
        if (!store.templates) {
          return React.createElement('div', { className: 'pc-mask' },
            React.createElement('div', { className: 'pc-card' },
              title('模板'),
              React.createElement('div', { className: 'pc-loading-body' },
                React.createElement('div', { className: 'pc-spinner' }),
                React.createElement('div', { className: 'pc-loading-text' }, '正在读取模板列表…'))))
        }

        var tpl = null
        for (var i = 0; i < store.templates.length; i++) {
          if (store.templates[i].id === store.tplId) { tpl = store.templates[i]; break }
        }

        // —— ① 选模板 ——
        if (!tpl) {
          return React.createElement('div', { className: 'pc-mask' },
            React.createElement('div', { className: 'pc-card' },
              title('选择模板'),
              React.createElement('div', { className: 'pc-card-body' },
                React.createElement('div', { className: 'pc-tpl-hint', style: { marginBottom: '10px' } },
                  '模板按固定维度与输出结构渲染：结果可复现，**不消耗模型调用**。'),
                React.createElement('div', { className: 'pc-tpl-list' },
                  store.templates.map(function (t) {
                    return React.createElement('button', {
                      key: t.id, type: 'button', className: 'pc-tpl-item',
                      onClick: function () { patch({ tplId: t.id, tplVars: {}, tplResult: null, tplError: null }) },
                    },
                      React.createElement('div', { className: 'pc-tpl-item-title' },
                        t.title || t.id,
                        React.createElement('span', { className: 'pc-tpl-tag' }, t.category || 'generate'),
                        React.createElement('span', { className: 'pc-tpl-tag' }, 'v' + (t.version || '0.0.0'))),
                      React.createElement('div', { className: 'pc-tpl-item-desc' }, t.description || ''))
                  }))),
              closeRow()))
        }

        // —— ③ 渲染结果 ——
        if (store.tplResult !== null) {
          return React.createElement('div', { className: 'pc-mask' },
            React.createElement('div', { className: 'pc-card' },
              title((tpl.title || tpl.id) + ' · 渲染结果'),
              React.createElement('div', { className: 'pc-card-body' },
                React.createElement('div', { className: 'pc-tpl-meta' },
                  tpl.id + ' v' + (tpl.version || '0.0.0') + ' · ' + store.tplResult.length + ' 字符 · 本次未调用模型'),
                React.createElement('div', { className: 'pc-tpl-preview' }, store.tplResult)),
              React.createElement('div', { className: 'pc-card-actions' },
                React.createElement('button', {
                  type: 'button', className: 'pc-btn',
                  onClick: function () {
                    try {
                      if (navigator.clipboard && navigator.clipboard.writeText) {
                        navigator.clipboard.writeText(store.tplResult)
                        patch({ tplError: null })
                        return
                      }
                    } catch (e) { /* 落到下面的提示 */ }
                    patch({ tplError: '复制失败：浏览器未授予剪贴板权限' })
                  },
                }, '复制'),
                React.createElement('button', {
                  type: 'button', className: 'pc-btn',
                  disabled: typeof store.applyDraft !== 'function',
                  title: '写回输入框，**不会自动发送**',
                  onClick: function () {
                    if (typeof store.applyDraft === 'function') {
                      store.applyDraft(store.tplResult)
                      close()
                    }
                  },
                }, '采用并回填'),
                React.createElement('button', {
                  type: 'button', className: 'pc-btn',
                  onClick: function () { patch({ tplResult: null, tplError: null }) },
                }, '返回修改'),
                React.createElement('button', { type: 'button', className: 'pc-primary', onClick: close }, '关闭'))))
        }

        // —— ② 填变量 ——
        var props2 = (tpl.variables && tpl.variables.properties) || {}
        return React.createElement('div', { className: 'pc-mask' },
          React.createElement('div', { className: 'pc-card' },
            title(tpl.title || tpl.id),
            React.createElement('div', { className: 'pc-card-body' },
              React.createElement('div', { className: 'pc-tpl-hint', style: { marginBottom: '10px' } },
                '带 ', React.createElement('span', { className: 'pc-tpl-req' }, '*'),
                ' 的是必填。没填的可选项会**整条省略**，不会留空条目。'),
              React.createElement('div', { className: 'pc-tpl-form' },
                Object.keys(props2).map(function (k) { return tplField(k, props2[k], k) })),
              store.tplError
                ? React.createElement('div', { className: 'pc-error', style: { marginTop: '10px' } }, String(store.tplError))
                : null),
            React.createElement('div', { className: 'pc-card-actions' },
              React.createElement('button', {
                type: 'button', className: 'pc-btn',
                onClick: function () { patch({ tplId: null, tplVars: {}, tplResult: null, tplError: null }) },
              }, '返回选模板'),
              React.createElement('button', { type: 'button', className: 'pc-btn', onClick: close }, '关闭'),
              React.createElement('button', {
                type: 'button', className: 'pc-primary', disabled: store.tplBusy,
                onClick: function () {
                  patch({ tplBusy: true, tplError: null })
                  // 空值不传，交给 host 用模板 defaults 补齐 ——
                  // 也因此"必填没填"能正常触发 400 校验错误，而不是被空串蒙混过去。
                  var clean = {}
                  Object.keys(store.tplVars || {}).forEach(function (k) {
                    var v = store.tplVars[k]
                    if (v === '' || v === undefined || v === null) return
                    if (Array.isArray(v) && v.length === 0) return
                    clean[k] = v
                  })
                  rpc('/render', { template: tpl.id, variables: clean }).then(function (r) {
                    patch({ tplBusy: false, tplResult: (r && r.text) || '' })
                  }).catch(function (e) {
                    patch({ tplBusy: false, tplError: String(e && e.message ? e.message : e) })
                  })
                },
              }, store.tplBusy ? '渲染中…' : '渲染'))))
      }

      // —— shell.overlay 卡片组件（从 store 读状态，无 inputActions） ——
      function OverlayCard() {
        var [, force] = React.useState(0)
        React.useEffect(function () {
          return subscribe(function () { force(function (v) { return v + 1 }) })
        }, [])
        if (store.configMode) return React.createElement(ConfigCard)
        // 模板卡与编译链路**互相独立**：templateMode 先判，这样即便编译链路有残留
        // 状态（analysis/preview），打开模板卡也不会串台。
        if (store.templateMode) return React.createElement(TemplateCard)
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

      // ══════════════════════════════════════════════════════════════════
      // 设置页（settings.section）：把可交给宿主/用户的配置集中到 DSH 设置里。
      //
      // 设计要点：
      //   · 唯一的真相源是 host 侧的 settings.json（经 /api/settings 读写），
      //     不再依赖浏览器 localStorage —— 换浏览器/清缓存都不丢。
      //   · 每一项都带"说明 + 默认值 + 生效范围"，让不懂插件的用户也能看懂。
      //   · 保存按分组提交，未改动的组不受影响。
      //   · 注册走 slots.inject('settings.section', ...)（裸 register 会 throw）。
      // ══════════════════════════════════════════════════════════════════

      // —— settings.section 组件：自定义设置页 ——
      function SettingsSection() {
        var [st, setSt] = React.useState(null)
        var [msg, setMsg] = React.useState(null)
        var [busy, setBusy] = React.useState(false)
        var [dirty, setDirty] = React.useState(false)

        React.useEffect(function () {
          var alive = true
          rpc('/settings', {}).then(function (r) {
            if (!alive) return
            setSt(r.settings)
          }).catch(function (e) {
            if (!alive) return
            setMsg({ tone: 'err', text: '读取设置失败：' + (e && e.message ? e.message : e) })
          })
          return function () { alive = false }
        }, [])

        // 就地改一个字段（不立即落盘，等"保存"）
        function setField(group, key, value) {
          setSt(function (prev) {
            if (!prev) return prev
            var g = Object.assign({}, prev[group])
            g[key] = value
            return Object.assign({}, prev, { [group]: g })
          })
          setDirty(true)
          setMsg(null)
        }
        function save() {
          if (!st || busy) return
          setBusy(true); setMsg(null)
          // 只提交已知分组，避免把 _path / apiKeySet 等只读字段写回磁盘
          var payload = {
            external: {
              enabled: st.external.enabled, priority: st.external.priority,
              baseUrl: st.external.baseUrl, apiKey: st.external.apiKey, model: st.external.model,
            },
            compile: { targetModel: st.compile.targetModel, strongTemplate: st.compile.strongTemplate },
            format: {
              stripHeadings: st.format.stripHeadings, dropReasoning: st.format.dropReasoning,
              collapseBlank: st.format.collapseBlank,
            },
            diagnostics: {
              showScore: st.diagnostics.showScore, showModelBadge: st.diagnostics.showModelBadge,
              showDiagMeta: st.diagnostics.showDiagMeta, warnOnDegrade: st.diagnostics.warnOnDegrade,
            },
            behavior: { autoApply: st.behavior.autoApply, showAssumptions: st.behavior.showAssumptions },
          }
          rpc('/settings', { action: 'set', settings: payload }).then(function (r) {
            setBusy(false); setDirty(false)
            if (r && r.ok) {
              setSt(r.settings)
              // 同步到全局 store，让徽章/目标模型/诊断开关等立即跟随
              patch({ settings: r.settings })
              setMsg({ tone: 'ok', text: '已保存。下次编译即生效。' })
            } else {
              setMsg({ tone: 'err', text: '保存失败：' + ((r && r.error) || '未知错误') })
            }
          }).catch(function (e) {
            setBusy(false)
            setMsg({ tone: 'err', text: '保存失败：' + (e && e.message ? e.message : e) })
          })
        }
        function reset() {
          if (busy) return
          setBusy(true); setMsg(null)
          rpc('/settings', { action: 'reset' }).then(function (r) {
            setBusy(false); setDirty(false)
            setSt(r.settings)
            patch({ settings: r.settings })
            setMsg({ tone: 'ok', text: '已恢复默认设置。' })
          }).catch(function (e) {
            setBusy(false)
            setMsg({ tone: 'err', text: '重置失败：' + (e && e.message ? e.message : e) })
          })
        }

        if (!st) return React.createElement('div', { className: 'pcs' }, React.createElement('div', { className: 'pcs-loading' }, '正在读取设置…'))

        // —— 小组件：开关行 / 单选行 / 文本行 ——
        function Row(props) {
          return React.createElement('div', { className: 'pcs-row' },
            React.createElement('div', { className: 'pcs-row-main' },
              React.createElement('label', { className: 'pcs-row-label' }, props.label,
                props.tag ? React.createElement('span', { className: 'pcs-tag' }, props.tag) : null),
              props.hint ? React.createElement('div', { className: 'pcs-row-hint' }, props.hint) : null),
            React.createElement('div', { className: 'pcs-row-ctl' }, props.children))
        }
        function Toggle(props) {
          return React.createElement('input', {
            type: 'checkbox', className: 'pcs-switch',
            checked: !!props.checked, disabled: busy,
            onChange: function (e) { props.onChange(e.target.checked) },
          })
        }
        function Section(props) {
          return React.createElement('section', { className: 'pcs-sec' },
            React.createElement('h3', { className: 'pcs-sec-h' }, props.title),
            props.desc ? React.createElement('p', { className: 'pcs-sec-d' }, props.desc) : null,
            props.children)
        }

        return React.createElement('div', { className: 'pcs' },
          React.createElement('div', { className: 'pcs-head' },
            React.createElement('h2', { className: 'pcs-title' }, 'Prompt Compiler'),
            React.createElement('p', { className: 'pcs-sub' },
              '把粗糙的 draft 编译成结构化、可执行的 prompt。以下设置保存在宿主本机（',
              React.createElement('code', null, prettyPath(st._path)),
              '），对所有会话生效。')),

          // ══ ① 模型来源与优先级 ══
          React.createElement(Section, {
            title: '模型来源',
            desc: '决定编译时用哪个模型。默认使用 DSH 当前会话的模型；也可以指定你自己的模型接口。',
          },
            React.createElement(Row, {
              label: '外部模型',
              hint: '开启后可使用你自己配置的模型接口（OpenAI 兼容 / 本地 ollama）。关闭则只走 DSH 宿主模型。',
            }, React.createElement(Toggle, {
              checked: st.external.enabled,
              onChange: function (v) { setField('external', 'enabled', v) },
            })),

            st.external.enabled ? React.createElement('div', { className: 'pcs-sub-block' },
              React.createElement(Row, {
                label: '使用方式',
                hint: '「外部优先」= 编译一律走你的接口，失败才回落宿主；「宿主优先」= 只有宿主失败时才用你的接口。',
              }, React.createElement('div', { className: 'pcs-radios' },
                React.createElement('label', { className: 'pcs-radio' },
                  React.createElement('input', {
                    type: 'radio', name: 'pcs-pri', checked: !st.external.priority, disabled: busy,
                    onChange: function () { setField('external', 'priority', false) },
                  }), '宿主优先，外部兜底'),
                React.createElement('label', { className: 'pcs-radio' },
                  React.createElement('input', {
                    type: 'radio', name: 'pcs-pri', checked: !!st.external.priority, disabled: busy,
                    onChange: function () { setField('external', 'priority', true) },
                  }), '外部模型优先'))),

              React.createElement(Row, { label: '接口地址', tag: '必填', hint: 'OpenAI 兼容填到 /v1/chat/completions；ollama 填 /api/chat' },
                React.createElement('input', {
                  className: 'pcs-input', type: 'text', disabled: busy,
                  placeholder: '例：http://localhost:11434/api/chat',
                  value: st.external.baseUrl,
                  onChange: function (e) { setField('external', 'baseUrl', e.target.value) },
                })),

              React.createElement(Row, {
                label: 'API Key',
                hint: st.external.apiKeySet
                  ? '已保存一个密钥（出于安全不回显）。留空表示不修改；输入新值则覆盖。'
                  : '本地 ollama 无需填写。密钥只存在本机文件，不进日志、不回显。',
              }, React.createElement('input', {
                className: 'pcs-input', type: 'password', disabled: busy,
                placeholder: st.external.apiKeySet ? '（已设置，留空不变）' : '例：sk-xxxxxxxx（本地 ollama 留空）',
                value: st.external.apiKey || '',
                onChange: function (e) { setField('external', 'apiKey', e.target.value) },
              })),

              React.createElement(Row, { label: '模型名称', tag: '必填', hint: '必须与端点上的模型 id 完全一致' },
                React.createElement('input', {
                  className: 'pcs-input', type: 'text', disabled: busy,
                  placeholder: '例：llama3.2 / deepseek-chat / gpt-4o-mini',
                  value: st.external.model,
                  onChange: function (e) { setField('external', 'model', e.target.value) },
                })),
            ) : null),

          // ══ ② 编译风格 / 目标模型 ══
          React.createElement(Section, {
            title: '编译风格',
            desc: '控制编译产出的格式与改写力度。',
          },
            React.createElement(Row, {
              label: '目标模型',
              hint: '编译结果会按目标模型的偏好调整格式：Claude 用 XML 标签、GPT 用 Markdown、本地小模型用极简直白语句。',
            }, React.createElement('select', {
              className: 'pcs-input', disabled: busy,
              value: st.compile.targetModel,
              onChange: function (e) { setField('compile', 'targetModel', e.target.value) },
            },
              React.createElement('option', { value: '' }, '通用（模型无关 · Markdown）'),
              React.createElement('option', { value: 'claude' }, 'Claude（XML 标签）'),
              React.createElement('option', { value: 'gpt' }, 'GPT（Markdown）'),
              React.createElement('option', { value: 'deepseek' }, 'DeepSeek（Markdown）'),
              React.createElement('option', { value: 'local' }, '本地小模型（极简直白）'))),

            React.createElement(Row, {
              label: '强化编译模板',
              hint: '开启：对 draft 做真正的工程改写（补具体约束、消除歧义）。关闭：只做结构化整理与轻度润色，最大限度保留你的原话。',
            }, React.createElement(Toggle, {
              checked: st.compile.strongTemplate,
              onChange: function (v) { setField('compile', 'strongTemplate', v) },
            }))),

          // ══ ③ 清理与格式 ══
          React.createElement(Section, {
            title: '输出格式',
            desc: '控制编译结果在预览与回填时的呈现。',
          },
            React.createElement(Row, {
              label: '去掉标题行',
              hint: '开启后输出只保留正文，去掉 ## Task / ## Constraints 等标题。适合直接粘进别的工具。',
            }, React.createElement(Toggle, {
              checked: st.format.stripHeadings,
              onChange: function (v) { setField('format', 'stripHeadings', v) },
            })),
            React.createElement(Row, {
              label: '丢弃思维链',
              hint: '模型的思考过程（reasoning）不进入编译结果。建议保持开启。',
            }, React.createElement(Toggle, {
              checked: st.format.dropReasoning,
              onChange: function (v) { setField('format', 'dropReasoning', v) },
            })),
            React.createElement(Row, {
              label: '折叠多余空行',
              hint: '把连续空行压成一个，让输出更紧凑。',
            }, React.createElement(Toggle, {
              checked: st.format.collapseBlank,
              onChange: function (v) { setField('format', 'collapseBlank', v) },
            }))),

          // ══ ④ 诊断与提示 ══
          React.createElement(Section, {
            title: '诊断与提示',
            desc: '控制编译结果里显示多少技术信息。排障时建议全开，日常可关掉。',
          },
            React.createElement(Row, { label: '显示模型徽章', hint: '在结果上方显示本次实际使用的模型（区分宿主 / 外部）。' },
              React.createElement(Toggle, {
                checked: st.diagnostics.showModelBadge,
                onChange: function (v) { setField('diagnostics', 'showModelBadge', v) },
              })),
            React.createElement(Row, { label: '显示诊断评分', hint: '显示草稿完整度评分（0-100）与评审意见。' },
              React.createElement(Toggle, {
                checked: st.diagnostics.showScore,
                onChange: function (v) { setField('diagnostics', 'showScore', v) },
              })),
            React.createElement(Row, { label: '显示技术细节', hint: '显示 chunk 数等底层信息，仅在排查问题时需要。' },
              React.createElement(Toggle, {
                checked: st.diagnostics.showDiagMeta,
                onChange: function (v) { setField('diagnostics', 'showDiagMeta', v) },
              })),
            React.createElement(Row, { label: '降级时警告', hint: '当宿主模型不可用、只能用规则模板时，弹出警告横幅。' },
              React.createElement(Toggle, {
                checked: st.diagnostics.warnOnDegrade,
                onChange: function (v) { setField('diagnostics', 'warnOnDegrade', v) },
              }))),

          // ══ ⑤ 默认行为 ══
          React.createElement(Section, {
            title: '默认行为',
            desc: '编译完成后的交互方式。',
          },
            React.createElement(Row, {
              label: '编译后自动回填',
              hint: '编译完成后直接把结果填回输入框（仍然不会自动发送，需你确认）。',
            }, React.createElement(Toggle, {
              checked: st.behavior.autoApply,
              onChange: function (v) { setField('behavior', 'autoApply', v) },
            })),
            React.createElement(Row, {
              label: '显示自动假设',
              hint: '显示编译时替你做的推断（【推断】项），便于核对。',
            }, React.createElement(Toggle, {
              checked: st.behavior.showAssumptions,
              onChange: function (v) { setField('behavior', 'showAssumptions', v) },
            }))),

          // —— 底部操作区 ——
          React.createElement('div', { className: 'pcs-actions' },
            msg ? React.createElement('span', {
              className: 'pcs-msg ' + (msg.tone === 'ok' ? 'pcs-msg-ok' : 'pcs-msg-err'),
            }, msg.text) : null,
            React.createElement('span', { className: 'pcs-spacer' }),
            React.createElement('button', {
              type: 'button', className: 'pcs-btn', disabled: busy,
              onClick: reset,
            }, '恢复默认'),
            React.createElement('button', {
              type: 'button', className: 'pcs-btn pcs-btn-primary',
              disabled: busy || !dirty,
              onClick: save,
            }, busy ? '保存中…' : (dirty ? '保存' : '已保存'))),
        )
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

      // 设置页注册：出现在 DSH 设置面板的左侧导航里。
      // id 用自己的（'prompt-compiler'），不会顶掉别的插件的页；
      // order 取 60，排在 tiddlywiki(50) 之后、mcp-servers(82) 之前。
      try {
        slots.inject('settings.section', function () {
          return slots.register(
            {
              name: 'settings.section',
              id: 'prompt-compiler',
              order: 60,
              label: 'Prompt Compiler',
            },
            SettingsSection
          )
        })
      } catch (e) {
        // 宿主版本没有该插槽时不能让整个 client 半部挂掉
        console.error('[dsh-prompt-compiler] register settings.section failed:', e)
      }
    }

    exports.name = 'prompt-compiler'
    exports.inject = []
    exports.apply = apply
    return module.exports
  },
})
