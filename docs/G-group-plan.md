# G 组方案：Claude Code 侧 mod（执行指南，未实现）

> 状态：**调研完成、方案已定，但本机未安装 Claude Code，代码未写、未实测。**
> 事实来源：`artifacts/g-claude-code-mod-facts.md`（基于本机留档的 Claude Code 官方文档原文，非二手）。
> 决策（2026-10-13）：用户选 **A 单文件自包含 mod** 形态，但落地方式选 **C（只写方案文档，代码待装 CC 后实现）**。

---

## 1. 为什么需要 G 组

DSH 侧插件已在 `desktop` profile 跑通（UI 按钮 + `promptCompiler` 服务）。
Claude Code 用户也需要同样能力。但 **Claude Code 是独立宿主，不能加载 DSH 插件、不能 import 我们的 npm 包**——
`$.ui.ask` / `$.model.complete` 是 **CC mod 的真实官方 API**，不是 DSL 示意；mod 是 CC 侧独立 JS 运行时。

## 2. 接入机制（两条路，能力不同）

| | settings hook（脚本） | mod（进程内 JS） |
|---|---|---|
| 能否改写 prompt | **否**（只能 `additionalContext` / block） | **是**（`prompt.submit` 返回 `next({...e, text})`） |
| 能否绘制 UI | 否 | 是（pane / band） |
| 能否调模型 | 借 `type:"prompt"` 间接 | `$.model.complete` |

**结论**：改写 prompt 只能用 **mod 的 `prompt.submit`**。`UserPromptSubmit` hook 官方原文 "can't replace the prompt"。纯 hook 做不了编译。

## 3. 推荐形态（A：单文件自包含 mod）

独立标准 CC 插件目录，**零 npm 依赖**（mod 运行时无 `require` / 无 Node API，见 Q3）：

```
dsh-prompt-compiler-cc/
├── .claude-plugin/plugin.json     # name: dsh-prompt-compiler（避开 claude-/anthropic- 保留前缀）
├── hooks/
│   ├── hooks.json                 # { "modules": ["./register.js"] }
│   └── register.js                # export function register(on) —— 自包含单文件
└── skills/compile/SKILL.md        # 【兜底】mod 不可用时仍可 /dsh-prompt-compiler:compile
```

`register.js` 从 DSH 侧 `lib/service.js` 的 `analyze/elicit/compile` **移植**（纯 JS，不依赖 cordis / llm 包；LLM 调用改走 `$.model.complete`）。
**维护两份逻辑**是本形态的工程代价（Q3 若能用 `$.process.run` 起外部 node 则免，但需实测）。

## 4. 三阶段映射

| 阶段 | CC 侧实现 | 依据 |
|---|---|---|
| ① 诊断 | `on('prompt.submit', ...)` 拿 `e.text`；可选 `$.model.complete({model:'haiku', maxTokens, timeoutMs})` 快判 | `prompt.submit` 可改写；`$.model.complete` 可指定便宜模型 |
| ② 澄清 | `await $.ui.ask(q, opts)`，**必须** `try/catch`；多轮靠模块内变量串联 | `$.ui.ask` 多轮安全；reject 即降级 |
| ③ 合成 | `$.model.complete(...)` → 改写 `next({ ...e, text: compiled })`；或 `{ drop: reason }` 退回输入框待确认 | `next({...e,text})` 改写后 transcript 显示新文本；`{drop}` 退回 |

## 5. 降级分支（8 个，必须覆盖）

| # | 分支 | 触发 | 策略 |
|---|---|---|---|
| D1 | `-p` / SDK / VS Code 面板（hooks 跑、无绘制） | `$.ui.ask` **reject** | `try/catch` 兜住 → **跳过澄清、默认假设直接编译**，把假设写进 `context` 让用户可见 |
| D2 | 用户主动放弃澄清 | 同 D1 `catch` | 同 D1 |
| D3 | **WSL 会话** | 插件根本不加载 | README 明示不支持；建议切 Windows 终端 / Desktop |
| D4 | 无 LLM / 模型调用失败 | `$.model.complete` 返回 `isAnswered:false` 或 reject | **降级纯规则/模板编译**，或放行原文 + `$.ui.log`；**必须查 `isAnswered`，不能只看 reject** |
| D5 | hook 超时（mod 自身 ≤10s） | 长等待必须包在 `$.ui.ask` 内才不计时限 | 合成设 `timeoutMs`；超时走 D4 |
| D6 | CC 版本过低（终端 <v2.1.287 / Desktop <v2.1.286） | mods 不加载 | README 标最低版本 + 同插件 skill 兜底 |
| D7 | 用户关 mods（`--safe-mode` / 组织策略） | mod 不加载但 skill/command 仍加载 | 同 D6：skill 兜底 |
| D8 | 命令名冲突 | `$.command.register` 对已占用名抛错 | 注册包 `try/catch`，名字避内置 |

> **D4 易漏**：API 失败 = 不 reject、返回 `isAnswered:false`；请求被拒（组织封禁模型）= reject。两条都兜。

## 6. 待确认项（实现时必须实测，本机无 CC 无法验证）

| # | 待确认 | 影响 |
|---|---|---|
| Q1 | `prompt.submit` 里 `await $.ui.ask` 的实际时限 / `drop` 能否在 ask 后使用 | 阻塞 + 后续 drop 语义 |
| Q2 | `$.ui.ask` 的 options 上限 / 是否支持自由文本 | 与 DSH `userQuestions.ask` 对齐 |
| **Q3** | **编译核心能否复用**：mod 无 Node API，DSH 核心是 ESM 包 → 能否打包进单文件 `register.js` 或改用 `$.process.run` 起外部 node | **最大工程风险，决定要不要维护两份逻辑** |
| Q4 | `$.prompt.fill` 语义（能否预填回输入框待确认） | 比 `{drop}` 体验更好 |
| Q5 | `prompt.submit` 与 `classic.UserPromptSubmit` 执行顺序 / 是否重复触发 | 避免跑两遍 |
| Q6 | mod hook 10s 时限是否对 `prompt.submit` 生效（`$.model.complete` 算不算在内） | 合成调模型可能超时 |
| Q7 | `$.store` / `$.state` 在 `-p` 下是否可用 | 跨轮记忆降级 |
| Q8 | 目标 CC 版本下限是否随版本变化（当前 v2.1.287+ / Desktop v2.1.286+） | 落地前重核 |

## 7. 执行步骤（待装 CC 后）

1. 本机装 Claude Code（终端 v2.1.287+ 或 Desktop v2.1.286+），验证 `claude --version`。
2. 建 `dsh-prompt-compiler-cc/` 目录，照 §3 结构写 `plugin.json` + `hooks.json` + `register.js`（从 `lib/service.js` 移植 analyze/elicit/compile）。
3. 实调 Q1–Q8（尤其 Q3 决定单文件 vs 外部 node）。
4. 覆盖 D1–D8 降级。
5. 写 `skills/compile/SKILL.md` 兜底。
6. `claude /plugin` 加载本地插件实测；`claude -p` 测 D1、`WSL` 测 D3（无 CC 则跳过）。
7. 发布到 Claude Code 插件市场 / GitHub Release 附安装说明。

## 8. 当前交付物

- 事实：`artifacts/g-claude-code-mod-facts.md`
- 本方案：`docs/G-group-plan.md`
- DSH 侧已完成可运行：`lib/service.js`（analyze/elicit/compile，移植源）
