# Changelog

本项目的所有重要变更都记录在此文件。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.2.0] - 2026-10-14

这一版的主题是**从「能跑」到「能用」**：加了设置页、把 LLM 链路上一串静默降级的
真 bug 全部定位并修掉，同时把 CI 和发布流程打通。

### 新增

- **插件设置页**：`DSH 设置 → Prompt Compiler`（官方插槽 `settings.section`，
  id `prompt-compiler`）。五组配置 —— 模型来源与优先级 / 编译风格与目标模型 /
  输出格式 / 诊断与提示 / 默认行为。
- **外部模型支持**：可接入任意 OpenAI 兼容端点或本地 ollama。
  两种使用方式二选一 —— **宿主优先、外部兜底**，或**外部模型优先、失败回落宿主**。
  响应体形状自适应（`choices[0].message.content` / ollama `message.content` /
  ollama `response` / 顶层 `content` 四种都认）。
- **配置统一落宿主本机**：`~/.dsh/prompt-compiler/settings.json`，client 与 host
  两侧读同一份。原先只存在浏览器 localStorage，宿主读不到、也无法复用。
  首次启动会把 localStorage 里的旧配置一次性迁移过来。
- **宿主路由 `/api/settings`**（读 / 写 / 恢复默认）；`compile` 以持久化设置为
  基线，请求体只做本次覆盖。
- **编译风格可选**：目标模型（Claude XML 标签 / 通用 Markdown / 本地小模型极简直白）、
  强化模板（真做工程改写）与温和模板（只整理不重写，含【待确认】标注）二选一。
- **输出格式开关**：去掉标题行、丢弃思维链、折叠多余空行。
- **诊断可见性开关**：模型徽章（区分宿主 / 外部）、诊断评分、技术细节、降级警告、
  自动假设、编译后自动回填。
- **`release.yml`**：推 `v*` tag 自动发布 —— 跑测试 → 校验 tag 与 `package.json`
  版本一致 → `npm publish --provenance`。

### 修复

- **静默降级（主根因）**：`messages[].content` 传了**字符串**，而宿主契约要求
  **内容块数组**。宿主投影消息时执行 `content.some(...)` 抛 `TypeError`，
  被 catch 成 `finish/error` chunk —— 表现成「模型不生效 / 静默降级」。
  改为构造合规的 `MessageBase`（`content: [{type:'text',text}]` + `source.kind:'plugin'`）。
- **思维链泄漏进正文**：`StreamChunk` 是判别联合，旧实现见到 `.text` 就取，
  把 `reasoning-delta` 的思考过程拼进了正文。改为按 `chunk.type` 判别，只认 `text-delta`。
- **输出重复两遍**：`block-end.block.text` 是该块的**完整文本**而非增量，
  与已累加的 deltas 重复。修完后 `## Task` 等标题不再出现两次。
- **reasoning-only 模型丢正文**：这类模型正文块只有 `block-end` 没有 `text-delta`，
  而旧的兜底逻辑用**全局** `!out` 判断、此时思维链已写满 `out`，导致正文被跳过。
  改为**按 `chunk.index` 记账**：有 delta 就不重复、没 delta 就用 `block.text` 补上。
- **LLM 输出结构被摧毁**：`tidyDraft` 是为**用户手打草稿**设计的（压空白、按句号重切句子），
  却被误用于模型返回的 Markdown —— `## Task\n抓取新闻。` 被粘成一行、`robots.txt`
  被句号切断、列表序号孤立。新增 `normalizeLlmOutput` 保结构，`tidyDraft` 只留给规则路径。
- **设置浅合并清空同组字段**：`write()` 用 `{...cur, ...patch}` 浅合并，
  只改 `external.model` 会把同组的 `enabled`/`baseUrl`/`apiKey` 全部回落默认值。
  改为按分组一层深合并。
- **外部模型「配了却仍走本地」**（两个独立原因）：一是 `compile()` 先调宿主，
  只有宿主失败才轮到外部，导致宿主正常时外部**永远不会被调用**，而 UI 文案却写着「优先」——
  补 `extPriority` 开关使其名副其实；二是 `callExternalLLM` 只按 ollama 的响应形状解析，
  LM Studio / vLLM / LocalAI 跑在 localhost 上却返回 OpenAI 形状 ⇒ 解析出空串 ⇒ 判定失败
  ⇒ 静默回落宿主。改为形状自适应，并把失败原因经 `diag.extFailReason` 暴露出来。
- **设置页最后一行点不到**：`.pcs-actions` 是 `position:sticky;bottom:0`，
  而滚动容器是**宿主的面板**而非 `.pcs` 自己 ⇒ 没有底部留白时，
  最后一行设置的开关永久压在「恢复默认 / 保存」条底下。补 `.pcs { padding-bottom }`。

### 变更

- 外部模型配置的读写从浏览器 localStorage 迁到宿主侧（`/api/settings`）。
- `listModels` 返回空数组的 provider（DSH 用它隐藏模型组）直接跳过，不再发注定失败的调用；
  命中 `RATE_LIMIT` / `QUOTA` / `soft_rate` 时直接换 provider，不再换 purpose 重试。
- `publishConfig` 锁定 `registry.npmjs.org`（本机若把 npm 指向只读镜像，不加会发不出去）。

### 工程

- **修复 CI**：仓库此前**从未入库 `package-lock.json`**，而 workflow 用
  `cache: npm` + `npm ci`，两者都要求 lockfile ⇒ 每次 run 都在 `actions/setup-node`
  阶段报 `Dependencies lock file is not found` 直接失败，**一次测试都没跑到**。
  补 lockfile 后 CI 首次变绿（Node 22.x / 24.x 双版本矩阵）。
- `actions/checkout` 与 `actions/setup-node` 升到 v5，清掉 Node 20 弃用告警。
- 测试从 0 增至 **43 个**，覆盖 service / settings / client 三块。
  client 半部此前零覆盖，现用 stub React + 假 ModuleLoader 做结构性冒烟。
- 补 `repository` / `homepage` / `bugs` —— 缺 `repository` 时
  `npm publish --provenance` 会被 registry 以 422 拒绝（sigstore bundle 校验失败）。

### 说明

- `elicit`（澄清问题）按设计**保留规则实现**，不接 LLM —— 更快更可预测。
- 全链路保留规则降级：LLM 缺失 / 抛错 / 返回非 JSON / 缺字段时安全回落，不抛错。

## [0.1.0] - 2026-10-13

首个公开版本，完成 A–E 五组：

- **A 组侦察**：竞品审计（`dsh-prompt-enhancer` 已实现交互式澄清，据此把本项目
  落点明确为「**可编程的 prompt 编译层**」）、官方文档对齐、服务化先例调研。
- **B 组最小可验证插件**：三阶段流程跑通，`prompt_compile` 工具被模型识别、调用、
  返回结构化模板。
- **C 组服务化**：`ctx.provide('promptCompiler')` 注册服务 + `prompt_compiler_probe`
  消费。踩坑：用 `require('@deepseek-ai/cordis')` 拿 `Service` 基类 `extends`
  会与宿主 asar 形成 **cordis 双实例**导致服务注册失效，改为纯工厂函数 +
  宿主 `ctx.provide` 注册后消除。
- **D 组 UI 完整链路**：composer「✨ 编译」按钮 → 诊断 → 澄清卡 → 预览四段 →
  「采用并回填」（仅回填，不自动发送）。
- **E 组 LLM 接入**：`analyze` / `compile` 接 `ctx.llm.stream`（标 `source:{kind:'plugin'}`）。

[0.2.0]: https://github.com/Jav1es/dsh-prompt-compiler/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Jav1es/dsh-prompt-compiler/releases/tag/v0.1.0
