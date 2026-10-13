# 服务化现成参照审计：`seven282/oss-prompt-optimizer`

> 审计对象：DSH 市场 20★、npm 已发布 `oss-prompt-optimizer`（v1.13.1）
> 审计目的：为本项目 C 组「注册 `ctx.promptCompiler` 服务并证明可编程」提供现成参照
> 审计时间：2026-10-13
> 审计方式：`git clone --depth 1` 后只读源码提取事实（一手素材）

---

## 一、仓库是否成功 clone

**是。**

| 项 | 值 |
|---|---|
| 克隆命令 | `git clone --depth 1 https://github.com/seven282/oss-prompt-optimizer <work>/oss-optimizer` |
| 退出码 | `EXIT=0` |
| 目标路径 | `dsh-prompt-compiler/work/oss-optimizer` |
| HEAD commit | `21f2f11c3066bbd783e8190156e6fd439d7f40e6` |
| commit 时间 | 2026-10-10 12:52:19 +0800 |
| commit 标题 | `refactor: move the optimizer result/options layer into src/optimizer/results.ts` |
| 包版本 | `1.13.1`（`package.json:3`） |

**来源等级：一手**（真实 `git clone` 成功 + 读源码）。本文件所有结论均带 `文件:行号`。

顶层内容确认：`client/`、`docs/`、`lib/`（入库的发布产物）、`scripts/`、`src/`、`tests/`、
`package.json`、`cordis.patch.yml`、`AGENTS.md`、`CHANGELOG.md`、`README.md` / `README.en.md`。

---

## 二、服务注册 API 实证（核心结论）

### 2.1 结论：既**不是** `ctx.provide(name, value)`，也**不是** `TypertRemoteService`，而是 **cordis 原生 `Service` 子类 + `super(ctx, 'promptOptimizer')`**

全仓库 grep `ctx.provide` 只在**测试假宿主**里出现（`tests/client-apply.test.ts:92-94`，用于伪造宿主服务），
生产代码里 `src/**` **零处** `ctx.provide`。
`TypertRemoteService` / `RemoteService` **全仓库零命中**（`grep -e 'Typert|RemoteService'` 无生产代码命中）。

确切写法如下：

```ts
// src/optimizer.ts:1
import { Service, type Context } from '@deepseek-ai/cordis'

// src/optimizer.ts:156
export class PromptOptimizerService extends Service {
  // src/optimizer.ts:164
  static inject = ['llm']
  // src/optimizer.ts:165
  static Config = Config

  // src/optimizer.ts:282-283
  constructor(ctx: Context, config: ConfigType) {
    super(ctx, 'promptOptimizer')     // ← 服务名在此注册
    ...
  }
}
```

编译产物一致（`lib/optimizer.js:188`）：`super(ctx, 'promptOptimizer');`

### 2.2 插件入口形态：class-form，但**有** `export default`

```ts
// src/index.ts:1-13
import { PromptOptimizerService } from './optimizer.js'
export const name = 'prompt-optimizer'
export const inject = ['llm']

// src/index.ts:69
export default PromptOptimizerService
```

⚠️ 与本项目既有硬结论「无 default export」的对照：`oss-prompt-optimizer` **有** `export default`
（指向服务类本身），同时导出 `name` / `inject`。二者不冲突，但本项目 AGENTS.md 的「无 default export」
是**另一条**约定来源，C 组照抄服务注册时**不要**把 `export default` 当成必要项。

### 2.3 三层依赖门禁（1.8.2 重构产物，值得直接抄）

| 层 | 机制 | 证据 |
|---|---|---|
| L0 硬门禁 | `export const inject = ['llm']` —— 唯一不可或缺的服务 | `src/index.ts:13`；`src/optimizer.ts:164` |
| L1 按功能软门禁 | `scopedInject(ctx, ['tools'], cb)` / `['systemPrompt']` / `['commands']` / `['settings']` | `src/optimizer.ts:351/354/358`、`src/settings.ts:64` |
| L2 可选服务 | `ctx.get('<name>')` + 判空，永不抛错 | `src/optimizer.ts:931`（`sessionQuery`）、`src/optimizer.ts:2344`（`agentDefaultModel`） |

`scopedInject` 的实现（`src/compat/scope.ts:29-57`）：先看 `ctx.inject` 是否为函数，是则
`ctx.inject(deps, callback)`（cordis 4 的按依赖门禁），否则**立即执行** callback（兼容无 inject 的
宿主 / 单测 mock）；且内部 `runGuarded` 把 throw 降级为 `warn`（`src/compat/scope.ts:60-71`）。

设计动机原文（`src/optimizer.ts:157-163`）：静态 `inject` 列出全部服务时，**任一服务改名会让
cordis 拒绝加载整个插件**，进而拖垮 `dsh web` 进程；改为按功能门禁后「只丢一个功能」。

### 2.4 `cordis.patch.yml` 极简（无 config 段落）

```yaml
# cordis.patch.yml:3-5
- insert:
    - id: prompt-optimizer
      name: 'oss-prompt-optimizer'
```

注释说明（`cordis.patch.yml:6-9`）：不写 config，因为每个可调项都有 schema 默认值；模型路由来自
harness 的 `agentDefaultModel`，除非显式配置 `provider` + `model`。

### 2.5 生命周期事件（服务可编程的另一个面）

```ts
// src/events.ts:86-90
export const PROMPT_OPTIMIZER_EVENTS = {
  start: 'prompt-optimizer/optimize:start',
  success: 'prompt-optimizer/optimize:success',
  failure: 'prompt-optimizer/optimize:failure',
} as const
```

并用 `declare module '@deepseek-ai/cordis'` 增强 `Events` 接口，让订阅方拿到类型（`src/events.ts:92-101`，
发布产物 `lib/types/events.d.ts:85-94`）。发事件用 `this.ctx.emit(...)`，且 **try/catch 吞掉监听器异常**
（`src/optimizer.ts:644-655`，注释原文 "fire-and-forget"）。

---

## 三、服务方法清单

来源：`lib/types/optimizer.d.ts`（随包发布的公共 `.d.ts`，即**对外契约**），行号即该文件行号。

### 3.1 核心编译类（C 组最关心）

| 签名 | 行号 | 说明 |
|---|---|---|
| `optimize(rawInput: string, options?: OptimizeOptions): Promise<OptimizeResult>` | `423` | 优化一条原始指令；模型质量失败**不 throw**，返回原文 + 错误说明（`src/optimizer.ts:1424-1428`） |
| `iterate(lastOptimized: string, instruction: string, options?: OptimizeOptions): Promise<OptimizeResult>` | `465` | 在已有结果上按新要求改写（`src/optimizer.ts:1755-1761`） |

> 注意：**没有**独立的 `analyze` / `elicit` 公开方法。诊断（`buildDiagnosis`）、情境画像
> （`buildSituationProfile`）是 `src/` 内部的纯函数，经 `src/index.ts` 单独导出供外部直接 import，
> **不是**服务方法。C 组若要 `analyze` / `elicit` 阶段可编程，这是**超出本参照**的自有设计点。

### 3.2 观察 / 统计类

| 签名 | 行号 |
|---|---|
| `getStats(): OptimizeStats` | `376` |
| `getStatus(rawInput?: string): StatusSnapshot` | `386` |
| `getInsights(lang?: 'zh' \| 'en'): string` | `381` |
| `hostCapabilities(): Capabilities` | `112` |
| `canAssembleStream(): boolean` | `110` |

### 3.3 配置 / 开关类

| 签名 | 行号 |
|---|---|
| `isAutoOptimizeAll(): boolean` / `setAutoOptimizeAll(value: boolean): void` | `129` / `131` |
| `getMetaPromptLanguage(): 'auto' \| MetaLanguage` / `setMetaPromptLanguage(...)` | `137` / `141` |
| `resolveMetaLanguage(input: string): MetaLanguage` | `139` |
| `isContextAware(): boolean` / `contextConfig()` | `143` / `145` |
| `setUserOverride(key, value)` / `clearUserOverride` / `clearAllUserOverrides` / `getUserOverrides` | `400` / `402` / `404` / `406` |
| `computeAdaptationHints(): AdaptationHints` | `398` |

### 3.4 评测 / 择优 / 反馈类（可选，体量大）

`runEval(options?)`（287）、`getEvalRubric()`（238）、`listEvalCases()`（240）、`getEvalRuns()`（249）、
`getEvalBaseline()`（251）、`setEvalBaseline(label?)`（257）、`getEvalSummary()`（259）、
`hasFeedbackService()`（344）、`scanFeedback()`（357）、`getFeedbackLedgers()`（359）、
`selectSummary(lang?)`（365）、`getLastSelection()`（367）、`formatFeedbackSignals(lang?)`（369）、
`updateFeedback(index, accepted)`（393）。

### 3.5 `OptimizeOptions` / `OptimizeResult` 契约

`OptimizeOptions`（`src/optimizer/results.ts:105-166`）：`signal`、`temperature`、`maxTokens`、
`outputLanguage`、`context`、`cacheScope`、`sessionId`、`enrich`、`senseNeeds`、`localTemplate`、`selectTemperatures`。

`OptimizeResult`（`src/optimizer/results.ts:169-199`）：`prompt`、`optimized`、`error?`、`errorCode?`、
`retries`、`sections?`、`outputTokens?`、`local?`、`refined?`、`selection?`。

**不变式**（`src/optimizer/results.ts:4-7`）：跨服务边界的一律是防御性拷贝（`cloneOptimizeResult` /
`cloneEvalRun`），调用方改返回值不会污染缓存/存储。

---

## 四、消费方示例（代码摘录）

### 4.1 同一插件内部：工具 → 服务（`src/tool.ts:134-145`）

```ts
async execute(args, exec) {
  const base = {
    signal: exec.signal,
    ...(args.temperature !== undefined ? { temperature: args.temperature } : {}),
    ...(args.maxTokens !== undefined ? { maxTokens: args.maxTokens } : {}),
    ...
  }
  if (args.lastOptimized !== undefined) {
    return service.iterate(args.lastOptimized, args.iterateInstruction ?? '', base)
  }
  return service.optimize(args.instruction, base)
}
```

关键点：工具注册函数直接**接收服务实例作参数**
（`registerPromptOptimizeTool(ctx, this.config, this, capabilities)`，`src/optimizer.ts:352`），
**不经过 `ctx.promptOptimizer` 解析**。

### 4.2 同一插件内部：命令 → 服务（`src/command.ts:80-84`）

```ts
const context = sessionContext(invocation.agent as { session?: unknown }, service)
const result = await service.optimize(text, {
  signal: invocation.signal,
  senseNeeds,
  ...(context !== undefined && context.length > 0 ? { context } : {}),
})
```

同样是构造期注入（`registerOptimizeCommand(scoped, this)`，`src/optimizer.ts:359`）。

### 4.3 同一插件内部：钩子 → 服务（`src/hook.ts:114-119`）

```ts
const result = await service.optimize(instruction, {
  signal: payload.signal,
  ...(context.length > 0 ? { context } : {}),
})
if (result.optimized) {
  nextMessages.push(optimizedMessage(result.prompt, config.hookIncludeOriginal, instruction, capabilities))
  replaced = true
  continue
}
```

（`src/optimizer.ts:357` 直接调用 `registerAutoOptimizeHook(ctx, this.config, this, capabilities)`，
**不走** `scopedInject`，因为 `agent/pre-step` 是 `ctx.on` 事件，不依赖具名服务。）

### 4.4 跨插件消费：`ctx.promptOptimizer` —— **只有 README 声明，仓库内无调用实例**

`README.md:53-54`：

> - **服务 `ctx.promptOptimizer`** — 其他插件可编程调用 `optimize(rawInput, { signal })` / `iterate(last, instruction, { signal })`；
>   浏览器端经 `ctx.remote.promptOptimizer`。

⚠️ **事实核查（含正对照）**：全仓库 grep `promptOptimizer` 共 15 处命中，分布为
`README.md` ×3、`README.en.md` ×3、`CHANGELOG.md` ×1、`src/events.ts` ×1（注释）、
`src/optimizer.ts` ×2（注释 + `super` 实参）、`lib/optimizer.js` ×2、`lib/events.js` ×1、
`lib/types/*.d.ts` ×2。
**正对照**：`src/optimizer.ts:283` 的 `super(ctx, 'promptOptimizer')` 能命中，说明 grep 模式有效；
但**没有任何** `ctx.promptOptimizer.` 形式的**读取**语句，也没有 `ctx.get('promptOptimizer')`。
⇒ **「注册」有实证（服务名字符串），「跨插件消费」仅 README 声明，无仓库内代码实证。**

`ctx.remote.promptOptimizer`（浏览器侧）同理：README 声明，但 `client/client.js` 里的实际 RPC 走的是
`ctx.get('remote.commands').execute(sessionId, command, args, signal)`（`client/client.js:405-409`），
**没有** `remote.promptOptimizer`.

### 4.5 跨插件消费的另一条路：事件订阅（`README.md:242-245`）

```ts
ctx.on('prompt-optimizer/optimize:success', ({ genAi }) => {
  if (genAi) span.setAttributes(genAi)
})
```

### 4.6 跨插件消费的第三条路：直接 import 纯函数（`src/index.ts:15-67`）

`src/index.ts` 把 `prompt.ts` / `validate.ts` / `select.ts` / `context.ts` / `situation.ts` 等的纯函数
全部 re-export，并把 `probeCapabilities` 等兼容层也导出（`src/index.ts:32`）。注释原文
（`src/index.ts:41-42`、`47-49`）：导出这些纯函数是为了「宿主或测试不经服务即可复现同一套规则」。

---

## 五、peerDependencies 摘录

```json
// package.json:84-92
"peerDependencies": {
  "@deepseek-ai/cordis": "^4.0.1",
  "react": "^18.2.0"
},
"peerDependenciesMeta": {
  "@deepseek-ai/cordis": {
    "optional": false
  }
}
```

| 键 | 声明位置 | 值 |
|---|---|---|
| `peerDependencies` | `package.json:84-87` | `@deepseek-ai/cordis: ^4.0.1`、`react: ^18.2.0` |
| `peerDependenciesMeta` | `package.json:88-92` | cordis `optional: false`（**硬 peer**）；`react` 未标注 |
| `dependencies` | `package.json:93-95` | `@deepseek-ai/schemastery: ^3.18.4`（**唯一运行时依赖**，config schema 用） |
| `devDependencies` | `package.json:96-105` | `@deepseek-ai/cordis ^4.0.1`、`dsh-commands / dsh-llm / dsh-timeout / dsh-tools` 均 `^0.1.0-rc.6`、`@types/node ^24`、`typescript ^5.8.3`、`vitest ^4.1.11` |
| `engines` | `package.json:47-50` | `node: >=22`、`dsh: ^0.2.0-rc.2` |

⚠️ **四个 dsh 域包只在 devDependencies**，生产运行时**不依赖**——因为 R1 规则禁止静态 import 它们
（`docs/compatibility.md:19-29`），一律经 `src/compat/loader.ts` 的 `createRequire` 同步懒加载
（`src/compat/loader.ts:23,34-44`），失败返回 `null` 而非抛错。**这与本项目 AGENTS.md 硬结论 2 完全一致。**

`dsh` 上架契约字段（`package.json:51-69`）：

```json
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "compatibility": {
    "dsh": "^0.2.0-rc.2",
    "dshReleases": { "0.2.0-rc.2": "compatible" }
  },
  "client": {
    "inject": [
      "@deepseek-ai/dsh-client-ui-conversation",
      "@deepseek-ai/dsh-api-remotes",
      "@deepseek-ai/dsh-client-connection"
    ],
    "platform": "web"
  }
}
```

`exports` 映射（`package.json:16-24`）：`.`（`lib/index.js`）、`./client`（`lib/client.js`）、
`./cordis.patch.yml`、`./package.json`。`files`（`package.json:25-33`）只含 `lib`、`cordis.patch.yml`
与选定 `docs/*`。

---

## 六、client 半部构建方式

| 环节 | 事实 | 证据 |
|---|---|---|
| 源码形态 | **手写** `client/client.js`，宿主 `__ModuleLoader__` 格式，**无打包器** | `client/client.js:1-3,15-21` |
| 构建 | `tsc -p tsconfig.build.json`（`src` → `lib`）+ `node scripts/copy-client.mjs`（`client/client.js` → `lib/client.js`） | `package.json:71`；`scripts/copy-client.mjs:8-11` |
| 静态检查 | 独立 `tsconfig.client.json`：`allowJs` + `checkJs` + `strict: false` + DOM lib + `types: []`，`include: ["client"]`；命令 `pnpm check:client` | `tsconfig.client.json`；`package.json:74` |
| 类型声明 | `client/globals.d.ts`（292 字节）声明宿主 `__ModuleLoader__` 环境 | 目录列表 |
| 依赖注入 | `var inject = ['remote']`（**最小集**）；`locale` / `slots` / `sessions` / `configForms` 一律 `ctx.get('<name>')` 判空 | `client/client.js:41,285,295,405,638,727` |
| Slot 注册 | `slots.inject('conversation.input.left', () => slots.register({...}))` 与 `slots.inject('settings.section', ...)` | `client/client.js:413-414,882-883` |
| 导出 | `exports.name` / `exports.inject` / `exports.apply`（`apply` 是 `async function apply(ctx)`） | `client/client.js:901-903,284` |
| 类型检查纪律 | `checkJs` 必须**保持能报错**（注入未定义标识符须失败）；项目**没有 linter**，不要引入 | `AGENTS.md`（仓库级指令） |

**R2b 硬规则**（`docs/compatibility.md:56-79`）：`remote.commands` 是**独立服务名**（宿主
`dsh-api-gateway` 用 `remoteServiceKey(ns) = 'remote.' + ns` 注册），必须整体 `ctx.get('remote.commands')`
且**在调用时**解析；`ctx.get('remote').commands` 与 `ctx.remote.commands` 都会抛
`cannot get property "remote.commands" without inject`。实测边界：dsh 全部带点服务名 18 个**全部**
`remote.` 前缀，`super(ctx, '<literal>')` 的 86 个字面名**无一带点**（`docs/compatibility.md:76-78`）。

---

## 七、对本项目 C 组的直接可复用点

| # | 可复用点 | 证据 | C 组动作建议 |
|---|---|---|---|
| 1 | **服务注册的确切写法**：`class X extends Service` + `static inject = [...]`（硬门禁，只放真正必需的）+ `super(ctx, '<服务名>')`。**不要**用 `ctx.provide` | `src/optimizer.ts:156,164,283`；`src/index.ts:13` | `ctx.promptCompiler` 照此写；`static inject` 只放 `['llm']` |
| 2 | **按功能软门禁** `scopedInject`（内部用 cordis 4 `ctx.inject(deps, cb)`，无 inject 时立即执行，throw 降级为 warn） | `src/compat/scope.ts:29-79`；`src/optimizer.ts:351-360` | 直接抄 `compat/scope.ts`（79 行）；工具 / 命令 / systemPrompt 各挂各的门禁 |
| 3 | **可选服务一律 `ctx.get('<name>')` 判空**，不进 `inject`、不直读 `ctx.<name>` | `src/optimizer.ts:931,2344`；`docs/compatibility.md:43-54` | 与本项目「裸 `register` 会 throw」同源，统一走 `ctx.get` |
| 4 | **服务方法签名模板**：`optimize(rawInput, options)` / `iterate(last, instruction, options)`，返回 `Promise<Result>`，**质量失败不 throw**（返回原文 + `error` + `errorCode`） | `src/optimizer.ts:1424-1429,1755-1761`；`src/optimizer/results.ts:169-199` | `promptCompiler.compile(draft, options)` 同形；`analyze` / `elicit` 是本项目自有设计，本参照**无**对应方法 |
| 5 | **跨服务边界返回防御性拷贝** | `src/optimizer/results.ts:4-7,20-52` | 结果对象深拷贝后再返回/入缓存 |
| 6 | **生命周期事件 + `declare module '@deepseek-ai/cordis'` 类型增强**，emit 用 try/catch 吞异常 | `src/events.ts:86-101`；`src/optimizer.ts:644-655` | `prompt-compiler/compile:start\|success\|failure` 同形；这是「可编程」的第二条证明路径 |
| 7 | **纯函数层单独 re-export**，让宿主/测试不经服务即可复现规则 | `src/index.ts:32,41-52` | 把 `analyze` / 评分 / 模板渲染的纯函数也导出，降低服务耦合 |
| 8 | **peerDependencies 只留 `@deepseek-ai/cordis` + `react`**，dsh 域包只进 devDependencies，运行时经 `createRequire` 同步懒加载（失败返回 `null`） | `package.json:84-105`；`src/compat/loader.ts:23,34-44`；`docs/compatibility.md:19-29` | 与本项目硬结论 2 一致，直接对齐 |
| 9 | **client 半部手写 ModuleLoader + `copy-client.mjs` 复制到 `lib/`，无打包器**；`checkJs` 承担静态检查 | `client/client.js:15-21`；`scripts/copy-client.mjs`；`tsconfig.client.json` | 若 C 组也要 client 半部，这条最省事 |
| 10 | **`exports` 映射 `./client` → `lib/client.js`**，且 `lib/` 必须**入库**（STORE 只读固定 commit、不跑 build） | `package.json:16-24`；`AGENTS.md` 发布流程段 | 与本项目「npm 发布」路径相关，注意不要 gitignore `lib/` |
| 11 | **`cordis.patch.yml` 极简**（`insert` 一行 id + name，config 全走 schema 默认值） | `cordis.patch.yml:3-9` | 配置有默认就不写 patch config，减少冲突面 |

### 7.1 需要 C 组自己补的（本参照**没有**的）

- **跨插件 `ctx.<服务名>` 消费的代码实证**：本仓库只有 README 声明（`README.md:53-54`），
  仓库内所有消费都是**构造期传实例**（`this`），不是 `ctx.promptOptimizer`。
  ⇒ C 组要「证明可编程」，**必须自己写一个最小消费方插件并实测**，不能引本仓库作实证。
- **`analyze` / `elicit` 阶段的公开服务方法**：本参照只有 `optimize` / `iterate` 两个公开方法，
  诊断与画像走纯函数导出。三阶段（诊断 → 澄清 → 合成）若要逐阶段可编程，是本项目自有设计。
- **`ctx.remote.<服务名>`（浏览器侧）的可行证据**：本仓库实际 RPC 走 `remote.commands.execute`
  驱动命令（`client/client.js:405-409`），README 里的 `ctx.remote.promptOptimizer` **无代码实证**。

---

## 附：证据索引（按文件）

| 文件 | 关键行 | 内容 |
|---|---|---|
| `src/optimizer.ts` | 1, 156, 164-165, 282-283 | 服务类定义、`static inject`、`super(ctx, 'promptOptimizer')` |
| `src/optimizer.ts` | 351-360 | 四个 `scopedInject` 按功能门禁 |
| `src/optimizer.ts` | 1429, 1761 | `optimize` / `iterate` 公开方法 |
| `src/optimizer.ts` | 644-655 | `ctx.emit` + try/catch 吞异常 |
| `src/optimizer.ts` | 2258, 2225 | `ctx.llm.stream(options)`；`source: { kind: 'plugin', plugin: ... }` |
| `src/index.ts` | 4, 13, 69 | `name` / `inject` / `export default` |
| `src/compat/scope.ts` | 29-79 | `scopedInject` 实现 |
| `src/compat/loader.ts` | 23, 34-44 | `createRequire` 同步懒加载，失败 `null` |
| `src/events.ts` | 86-101 | 事件常量 + cordis 类型增强 |
| `src/optimizer/results.ts` | 105-199 | `OptimizeOptions` / `OptimizeResult` |
| `src/tool.ts` | 53, 66, 134-145 | 工具注册 + 调 `service.optimize` / `iterate` |
| `src/command.ts` | 67, 80-84, 101 | 命令注册 + 调服务 |
| `src/hook.ts` | 90, 114-119 | `agent/pre-step` 钩子调服务 |
| `package.json` | 16-24, 47-69, 84-105 | exports / engines / dsh 契约 / peer + dev deps |
| `cordis.patch.yml` | 3-9 | 极简 insert |
| `client/client.js` | 15-21, 41, 285-295, 405-409, 413, 882, 901-903 | 手写 ModuleLoader client |
| `scripts/copy-client.mjs` | 8-11 | client → lib 复制 |
| `tsconfig.client.json` | 全文 | `checkJs` 非 strict DOM |
| `README.md` | 53-54, 229-252 | `ctx.promptOptimizer` 声明 + 事件文档 |
| `docs/compatibility.md` | 19-29, 43-54, 56-79 | R1 / R2 / R2b 三条规则 |
