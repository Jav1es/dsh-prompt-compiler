# dsh-prompt-compiler

> **可编程的 prompt 编译层** —— 既服务人（澄清 + 评分 + 教学），也服务其他插件与 Agent（`ctx.promptCompiler` 服务 + `prompt_compile` 工具），跨 DSH / Claude Code。

## 它是什么

把用户粗糙的 draft 编译成精确完整的 prompt。三阶段：

1. **诊断分析** —— 识别 draft 缺什么（目标 / 上下文 / 约束 / 验证标准 / 歧义）
2. **交互式澄清** —— 用 `ctx.userQuestions.ask()` 插件内提问（不走 agent loop），用户拒绝时输出"自动推断"
3. **结构化合成** —— 强制含验收标准字段，逐字保留路径/命令/版本号

## 为什么不是"首创交互式澄清"

`yaoshuo530/dsh-prompt-enhancer`（5★）已实现完整链路。本项目的落点是 **"可编程层"**：通过 `ctx.promptCompiler` 服务让其他插件/Agent 也能调用编译能力（详见 `docs/competitor-audit.md` 的弱点清单）。

## 当前状态

- [x] A 组侦察（竞品审计 / 官方文档对齐 / 服务化先例）
- [x] B 组 P0 最小可验证插件（已装机，实调通过）
- [x] C 组服务化（定位核心，实调通过）
- [x] D 组 UI 完整链路（composer「✨ 编译」按钮 + overlay 诊断/澄清/预览/回填，实调通过）
- [x] E 组三阶段流程（analyze/compile 接 LLM，实调通过；elicit 保留规则）
- [x] F 组插件设置页（**DSH 设置 → Prompt Compiler**，配置落宿主本机，实调通过）

## 设置页（F 组）

**入口**：DSH **设置 → Prompt Compiler**（官方插槽 `settings.section`，id `prompt-compiler`）。

**持久化**：宿主本机 `~/.dsh/prompt-compiler/settings.json`（单一真相源，client / host 两侧读同一份）。
原先外部模型配置只存在浏览器 localStorage，宿主读不到 —— 已迁移。

五组配置，**全部真正生效**（不是摆设）：

| 组 | 关键项 |
|---|---|
| 模型来源 | 外部模型开关、**优先/兜底二选一**、接口地址、API Key、模型名 |
| 编译风格 | 目标模型（Claude/通用/本地）、强化模板 vs 温和模板 |
| 输出格式 | 去掉标题行、丢弃思维链、折叠多余空行 |
| 诊断与提示 | 模型徽章、诊断评分、技术细节、降级警告 |
| 默认行为 | 编译后自动回填、显示自动假设 |

**外部模型**：OpenAI 兼容 / 本地 ollama 均可。响应体形状自适应
（`choices[0].message.content` / ollama `message.content` / ollama `response` / 顶层 `content` 都认），
失败原因经 `diag.extFailReason` 暴露，不静默吞掉。

**安全**：API Key 只落宿主本机，界面**不回显明文**（显示「已设置，留空不变」）。

## 实调回执（B6 验收）

在 DSH `desktop` profile 中实调 `prompt_compile`：

| 项 | 内容 |
|---|---|
| 调用 | `prompt_compile` 工具 |
| 输入 | `{ "draft": "帮我写个爬虫" }` |
| 输出 | `# Compiled Prompt` / `## Task` / `## Constraints` / `## Output Format` 结构化模板 |
| 状态 | ✅ 工具被模型识别、调用、返回符合预期 |

截图：![B6 prompt_compile](https://raw.githubusercontent.com/Jav1es/dsh-prompt-compiler/main/docs/assets/b6-prompt_compile-demo.png)

## 实调回执（C3 服务化验收）—— "可编程层"定位证据

在 DSH `desktop` profile 中实调 `prompt_compiler_probe`（内部调 `ctx.promptCompiler.analyze/elicit/compile`）：

| 项 | 内容 |
|---|---|
| 调用 | `prompt_compiler_probe` 工具 |
| 输入 | `{ "draft": "帮我写个爬虫" }` |
| 输出 | 结构化 JSON：`analysis`（missing/ambiguities/score）+ `elicitation`（带 why 的问题）+ `compile`（compiled 模板 + assumptions） |
| 状态 | ✅ 服务被注册（`ctx.provide('promptCompiler', instance)`）、被工具消费、三段结果可解析 |

截图：![C3 prompt_compiler_probe](https://raw.githubusercontent.com/Jav1es/dsh-prompt-compiler/main/docs/assets/c3-prompt_compiler-probe.png)

**关键踩坑（已解决）**：服务化初版用 `require('@deepseek-ai/cordis')` 拿 `Service` 基类 `extends`，在 link 包下形成与宿主 asar 的 **cordis 双实例**，导致服务注册失效（runtime 查不到 key）。最终改为纯工厂函数 + 宿主 `ctx.provide` 注册，彻底消除双实例 —— 这实打实验证了项目红线「`lib/` 内零 `@deepseek-ai` 运行时 import」的必要性。

## 实调回执（D 组 UI 完整链路验收）

在 DSH `desktop` profile 重启后实调浏览器 UI：

| 项 | 内容 |
|---|---|
| 入口 | composer 工具栏右侧「✨ 编译」按钮（`conversation.input.right`，order 200） |
| 交互 | 点按钮 → 读输入框草稿 → `/api/analyze`（LLM 诊断）→ 缺要素时 `/api/elicit` 显示澄清卡 → 收集答案调 `/api/compile` → overlay 预览四段 |
| 回写 | 「采用并回填」走 `inputActions.setDraft`（**仅回填，不 submit**）+ 「复制」+「关闭」 |
| 状态 | ✅ 按钮出现、overlay 渲染、回填生效，完整链路闭环 |

截图：![D UI 完整链路](https://raw.githubusercontent.com/Jav1es/dsh-prompt-compiler/main/docs/assets/d-ui-complete.png)

**关键设计（已实调验证）**：
1. client 半零构建：手写 `window.__ModuleLoader__.load({id,factory})` + `require('react')` + `React.createElement`；`package.json.dsh.client.inject` 补 4 包（runtime/connection/ui-slots/locale）+ `platform:'web'`。
2. slots 注册必须 `slots.inject(name, () => slots.register({name,id,order}, Component))`（裸 register 会 throw）。
3. 读草稿走 `props.useInput(s=>s.draft)`（`inputActions` 无 getter）；overlay 无 `inputActions`，回填经 store 桥接回 `input.right` 按钮侧。
4. host↔client 走 `ctx.webServer.register`（原生 Node HTTP，前缀 `/__dsh-prompt-compiler`，手工读 body 1MB 限长 + 异常 400），闭包持 `promptCompiler`，零 `@deepseek-ai` 运行时 import。

## 实调回执（E 组 LLM 智能接入验收）

在 DSH `desktop` profile 中实调 `prompt_compiler_probe`：

| 项 | 内容 |
|---|---|
| 调用 | `prompt_compiler_probe` 工具 |
| 输入 | `{ "draft": "帮我写个爬虫" }` |
| 输出 | `analysis` 含 LLM 生成的 `reasoning` + 更细致的 `missing`/`ambiguities`/`score`（非规则三件套）；`compile` 含 **Task/Constraints/Output Format/Acceptance Criteria 四段**的 LLM 合成 |
| 状态 | ✅ `analyze`/`compile` 成功调 `ctx.llm.stream`（标 `source:{kind:'plugin'}`），LLM 接入链路打通 |

截图：![E LLM probe](https://raw.githubusercontent.com/Jav1es/dsh-prompt-compiler/main/docs/assets/e-llm-probe.png)

**关键踩坑（已解决）**：
1. 插件 `exports.inject` 漏 `'llm'` ⇒ `apply` 时 `ctx.llm` 为 undefined、服务静默降级规则。补 `inject:['tools','systemPrompt','llm']` 后 `ctx.llm` 可用（host 侧 `llm` 是 `dsh-base` 注册的可注入服务）。
2. LLM 返回常带 ```` ```json ```` 围栏或前后缀 ⇒ `extractJson` 增强：先剥代码块围栏、再抓首尾 `{...}`、容忍前后缀；`ANALYZE_SYSTEM` 提示词强化「禁代码块、首字符必须 `{`」。
3. 全程保留规则降级：llm 缺失/抛错/返回非 JSON/缺字段时安全回落规则实现，不抛错。

`elicit`（澄清问题）按设计保留规则实现（更快更可预测，不接 LLM）。

## 安装

> 需要 DeepSeek Harness（DSH）`0.2.0-rc.2` 及以上。插件用 `ctx.llm.stream` 做智能诊断/合成，需宿主已配置可用的 LLM provider。

**方式一：从 Git 仓库安装（推荐，无需 npm 账号）**

```bash
dsh plugin --profile desktop add git+https://github.com/Jav1es/dsh-prompt-compiler.git
```

**方式二：从 npm 安装**

```bash
dsh plugin --profile desktop add npm:dsh-prompt-compiler
```

**方式三：本地路径 / link 安装（开发用）**

```bash
dsh plugin --profile desktop add link:/绝对路径/dsh-prompt-compiler
```

安装后**重启 DSH**；打开任意会话，composer 工具栏右侧出现「✨ 编译」按钮即生效。
（DSH 的 `link:` / 本地安装不跑 build，因此 `lib/` 必须随包提供——本仓库已将其入库。）

## 仓库结构

```
dsh-prompt-compiler/
├── lib/
│   ├── index.js      # host 半（Node：工具 / 提示词 / 路由）
│   ├── service.js    # promptCompiler 服务（analyze/elicit/compile + LLM 调用）
│   ├── settings.js   # 设置持久化（~/.dsh/prompt-compiler/settings.json）
│   ├── client.js     # client 半（浏览器：UI + 设置页）
│   └── sdk.js        # 自包含 defineTool（抄 dsh-tiddlywiki，MIT）
├── tests/            # node --test（service / settings / client 三套）
├── docs/             # 侦察产物
├── .github/workflows/ci.yml
├── package.json
└── cordis.patch.yml
```

## 开发

```bash
npm ci         # 需 package-lock.json（CI 同款；lockfile 已入库）
npm run check  # 语法检查
npm test       # node --test，43 个用例
```

CI（`.github/workflows/ci.yml`）在 Node 22.x / 24.x 上跑 `npm ci → check → test`。

**改 UI 注意**：stub 渲染测试（`tests/client.test.js`）只覆盖"结构 + 文案 + 条件渲染"，
**测不出布局缺陷**（被遮住、点不到）。涉及浮层 / `position:sticky` / 滚动容器的改动，
必须实机看一眼再发版。

## 纪律（来自项目 AGENTS.md）

- `lib/` 内零 `@deepseek-ai` 运行时 import（仅 `import type` 安全）
- 判"某包是否内置"只能用 `asar-read.cjs` 实读
- 不引用 SEO 站数字
