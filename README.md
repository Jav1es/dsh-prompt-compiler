# dsh-prompt-compiler

> **把粗糙的 draft 编译成精确、完整、可执行的 prompt。**
> 诊断缺什么 → 交互式澄清 → 结构化合成。

它有两个身份：给**人**用的 UI 插件（composer 工具栏「✨ 编译」+ DSH 设置页），
以及一个**可编程的 prompt 编译层** —— 其他插件与 Agent 可以直接
`ctx.promptCompiler.analyze / elicit / compile`，或调用 `prompt_compile` 工具。

[![npm version](https://img.shields.io/npm/v/dsh-prompt-compiler?color=4d6bfe&label=npm)](https://www.npmjs.com/package/dsh-prompt-compiler)
[![npm downloads](https://img.shields.io/npm/dm/dsh-prompt-compiler)](https://www.npmjs.com/package/dsh-prompt-compiler)
[![CI](https://github.com/Jav1es/dsh-prompt-compiler/actions/workflows/ci.yml/badge.svg)](https://github.com/Jav1es/dsh-prompt-compiler/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![node](https://img.shields.io/badge/node-%5E22.19.0%20%7C%7C%20%3E%3D24-informational)](package.json)

![DSH 设置 → Prompt Compiler](./docs/assets/settings-page.png)

---

## 问题：你的 prompt 大概率缺这五样

随手写的一句话指令，看起来没毛病，实际上把大量决策甩给了模型：

> `帮我写个爬虫，抓点新闻，越快越好`

本插件给它做体检，结果是 **30/100**，缺：目标的具体说明、约束条件（语言/库/robots/速度口径）、
上下文（运行环境、去重、存储）、验证标准、输出格式；另有「越快越好」无度量标准等 4 处歧义。

**同一个 draft，编译后长这样**（真实输出，节选）：

```markdown
## Task
抓取用户提供的新闻网站首页当日可见的新闻标题及其对应链接，整理为结构化列表。

## Constraints
- 仅使用 HTTP GET 方法发送请求。
- 严格遵守目标网站的 robots.txt 规则；若禁止抓取则终止任务。
- 单次请求间隔不得小于 1 秒；请求超时 5 秒，超时视为失败并跳过。
- 不抓取需要登录、付费或其他访问限制的内容；仅抓取公开可直接访问的新闻条目。
- 用户必须在调用时给出目标新闻网站的首页完整 URL（含 http/https 前缀）。

## Output Format
每条新闻占一行，采用纯文本 JSON：{"title": "<标题>", "url": "<绝对 URL>"}

## Acceptance Criteria
1. 每行的 title 非空，且 url 可直接访问（返回 HTTP 2xx）。
2. 输出条目之间没有完全重复的 title-url 配对。
3. 所有请求均尊重 robots.txt，且间隔 ≥ 1s、超时 ≤ 5s。
4. 若页面无法获取或无可识别的新闻条目，则输出为空且不报错。
```

差别不在文风，在于**原来靠模型猜的那些决策，现在被显式写成约束和验收标准**。

---

## 三阶段

| 阶段 | 做什么 | 实现 |
|---|---|---|
| ① 诊断分析 | 识别 draft 缺什么（目标 / 上下文 / 约束 / 验证标准 / 歧义），给 0–100 评分与理由 | `ctx.llm.stream` |
| ② 交互式澄清 | 就缺失项提问，每个问题都附「**不答会怎样**」 | 规则实现（更快更可预测） |
| ③ 结构化合成 | 强制产出 Task / Constraints / Output Format / **Acceptance Criteria** 四段 | `ctx.llm.stream` |

全程**保留规则降级**：LLM 缺失、抛错、返回非 JSON、缺字段时，安全回落到规则实现，不抛错。

---

## 快速开始

```bash
# 从 npm 安装（推荐）
dsh plugin --profile desktop add npm:dsh-prompt-compiler

# 或从 GitHub 安装
dsh plugin --profile desktop add git+https://github.com/Jav1es/dsh-prompt-compiler.git
```

**重启 DSH**。然后在任意会话的输入框右侧看到「✨ 编译」按钮即生效。

> 需要 DeepSeek Harness `0.2.0-rc.2` 及以上，宿主已配置可用的 LLM provider。
> `link:` / 本地安装不跑 build，因此 `lib/` 已随仓库入库。

---

## 用法一：给人用

1. 在输入框写一句话 draft（别费心润色）
2. 点「✨ 编译」
3. 看诊断评分 → 回答澄清问题（不想答就跳过，会标注为「自动推断」）
4. 预览四段结果 → 「采用并回填」（**只回填，不会替你发送**）或「复制」

![编译结果：模型徽章 + 四段结构 + 自动假设](./docs/assets/compile-result.png)

顶部徽章会明确告诉你**这一次是哪个模型在干活**（宿主模型 / 外部模型 · 模型名），
下方是编译结果，以及模型自行补上的「自动假设」供你核对 —— 不让你在黑暗里猜。

---

## 用法二：给插件与 Agent 用（差异化核心）

这是本项目的落点。**编译能力不该被锁死在某个 UI 里** —— 任何插件都能拿到它：

```js
// 消费方插件：声明依赖后即可使用
export const inject = ['promptCompiler']

export function apply(ctx, config) {
  // 1) 只要诊断
  const { missing, ambiguities, score, reasoning } = await ctx.promptCompiler.analyze(draft)

  // 2) 只要澄清问题（每问带 why）
  const { questions } = await ctx.promptCompiler.elicit(draft)

  // 3) 要成品
  const { compiled, assumptions, degraded } = await ctx.promptCompiler.compile(draft, {
    answers:      { goal: '...' },     // 澄清答案（可选）
    targetModel:  'claude',            // 'claude' | '' (通用) | 'local'
    strongTemplate: true,              // false = 温和模式，只整理不重写
    format:       { stripHeadings: false, collapseBlank: true },
    extPriority:  false,               // true = 外部模型优先，失败回落宿主
  })
}
```

Agent 侧则有开箱即用的工具：给一句粗糙指令，模型可以自己调 `prompt_compile` 把它编译好再执行。

服务经**宿主 `ctx.provide('promptCompiler', ...)`** 注册，`lib/` 内**零 `@deepseek-ai` 运行时 import** ——
这一点是踩坑换来的，见下方「关键踩坑」。

---

## 设置

**DSH 设置 → Prompt Compiler**。五组配置，全部落到宿主本机
`~/.dsh/prompt-compiler/settings.json`（client / host 两侧读同一份），对所有会话生效。

| 组 | 你能调什么 |
|---|---|
| **模型来源** | 用宿主当前会话模型，还是接你自己的端点（**宿主优先-外部兜底** / **外部模型优先** 二选一） |
| **编译风格** | 目标模型（Claude XML / 通用 Markdown / 本地小模型极简直白）、强化模板 vs 温和模板 |
| **输出格式** | 去掉 `##` 标题行、丢弃思维链、折叠多余空行 |
| **诊断与提示** | 模型徽章（区分宿主/外部）、诊断评分、技术细节、降级警告 |
| **默认行为** | 编译后自动回填、显示自动假设 |

**外部模型**支持任意 OpenAI 兼容端点（DeepSeek / OpenAI / LM Studio / vLLM / LocalAI…）
或本地 ollama。响应体形状自适应，失败原因会经 `diag.extFailReason` 明确告诉你，不静默吞掉。

**API Key 只落宿主本机，界面不回显明文**（显示为「已设置，留空不变」）。

---

## 更多截图

| 工具调用回执 | 服务化（可编程层）证据 |
|---|---|
| ![prompt_compile](./docs/assets/b6-prompt_compile-demo.png) | ![probe](./docs/assets/c3-prompt_compiler-probe.png) |
| `prompt_compile` 被模型识别、调用、返回四段模板 | `prompt_compiler_probe` 返回 analysis + elicitation + compile 三段可解析 JSON |

| 完整链路（诊断 → 澄清 → 预览 → 回填） | LLM 接入回执 |
|---|---|
| ![UI 完整链路](./docs/assets/d-ui-complete.png) | ![LLM probe](./docs/assets/e-llm-probe.png) |
| composer「✨ 编译」到「采用并回填」全流程 | `analyze` / `compile` 走 `ctx.llm.stream` 的实调回执 |

---

## 诚实披露

- **本项目不宣称「首创交互式澄清」**。`yaoshuo530/dsh-prompt-enhancer` 已实现完整澄清链路；
  本项目的差异点是**可编程层**（`ctx.promptCompiler` 服务 + `prompt_compile` 工具），
  让编译能力能被其他插件与 Agent 复用，而不是只服务一个 UI 按钮。
- **`elicit` 走规则实现，不接 LLM** —— 这是设计选择（更快更可预测），不是未完成。
- **Claude Code 侧尚未实现**。跨端是方向，目前只有 DSH。

---

## 关键踩坑（都已解决，写下来省你几小时）

1. **`messages[].content` 必须是内容块数组，不是字符串。**
   传字符串时宿主投影消息执行 `content.some(...)` 抛 `TypeError`，被 catch 成
   `finish/error` chunk —— 表面看是「模型不生效 / 静默降级」，实际是**契约用错**。
   排查时**先读 `reason.failure.message` 原文**，别急着怀疑策略拦截。
2. **`StreamChunk` 是判别联合**（`text-delta` / `reasoning-delta` / `block-start` / `block-end` / `usage` / `finish`）。
   见到 `.text` 就取会把思维链拼进正文；`block-end.block.text` 是该块的**完整文本**而非增量，
   直接累加会让输出重复两遍。
3. **reasoning-only 模型正文块可能只有 `block-end`、没有 `text-delta`**。
   兜底不能看「全局是否已有输出」（那时思维链早就写满了），要**按 `chunk.index` 记账**。
4. **`lib/` 内零 `@deepseek-ai` 运行时 import。** 早期用 `require('@deepseek-ai/cordis')`
   拿 `Service` 基类 `extends`，在 `link:` 安装下与宿主 asar 形成 **cordis 双实例**，
   服务注册静默失效。改为纯工厂函数 + 宿主 `ctx.provide` 注册后彻底消除。
5. **`npm publish --provenance` 要求 `package.json` 有 `repository` 字段**，
   否则 registry 直接 422（`Failed to validate repository information`），**代码根本没上传**。

---

## 项目结构

```
dsh-prompt-compiler/
├── lib/
│   ├── index.js      # host 半：工具 / 提示词 / HTTP 路由
│   ├── service.js    # promptCompiler 服务（analyze / elicit / compile + LLM 调用）
│   ├── settings.js   # 设置持久化（~/.dsh/prompt-compiler/settings.json）
│   ├── client.js     # client 半：UI + 设置页（零构建，手写 ModuleLoader）
│   └── sdk.js        # 自包含 defineTool
├── tests/            # node --test：service / settings / client 三套，43 个用例
├── docs/             # 竞品审计、官方文档对齐、服务化先例调研
└── .github/workflows/  # ci.yml（Node 22/24 矩阵）、release.yml（tag 自动发布）
```

## 开发

```bash
npm ci         # 需 package-lock.json（CI 同款；lockfile 已入库）
npm run check  # 语法检查
npm test       # 43 个用例
```

CI 在 Node 22.x / 24.x 上跑 `npm ci → check → test`。

**改 UI 注意**：`tests/client.test.js` 是结构性冒烟（stub React + 假 ModuleLoader），
只覆盖「结构 + 文案 + 条件渲染」，**测不出布局缺陷**。涉及浮层 / `position:sticky` /
滚动容器的改动，务必实机看一眼再发版。

## 版本

变更记录见 [CHANGELOG.md](./CHANGELOG.md)。

## License

[MIT](./LICENSE)
