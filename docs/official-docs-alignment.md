# DSH 官方开发文档 vs 本项目实证结论 · 对齐表

> 生成时间：2026-10-13｜抓取范围：`https://deepseek-harness.github.io/deepseek-harness/` 官方开发文档站（develop/ + reference/ 共 18 个页面，另加 2 个 GitHub raw 源码文档）。
> 标注口径：**✅ 官方印证** / **⏳ 官方未覆盖（不冲突）** / **❌ 与官方冲突**。
> 本文档只做事实对照，不做架构判断。关键 URL 清单见文末。

---

## 一、逐条对照表

| # | 本项目已实证结论 | 官方状态 | 官方口径 / 证据 |
|---|---|---|---|
| 1 | 插件形态 = npm 包 + `cordis.patch.yml` + `lib/{index.js,client.js}` | **✅ 主体印证**（路径细节 ⏳） | [publish](https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish)：组合包 = npm 包，`package.json` 声明 `dsh.bundle`（`{ bundle: { patch: "./cordis.patch.yml" } }`）+ patch 文件 + 入口模块。⚠️ 官方示例入口是 **`index.js`**（`main: "index.js"`），`lib/` 这一层目录官方**未规定**，由 `package.json` 的 `main` / `exports` 自行决定。 |
| 2 | `export name` / `inject` / `apply`，**无 default export** | **✅ 函数形态**（这是官方主推形态）<br>**❌ “无 default export”作为硬性禁令** | [basic](https://deepseek-harness.github.io/deepseek-harness/develop/basic/)：`export const name` + `export function apply(ctx)` + `export const inject = [...]`。但同页「插件的三种形态」明确给出**对象形式** `export default { name, inject, apply }` 与**类形式** `export default class extends Service`，二者都用 `export default`。⇒ 应改述为「**函数形式不用 default**；default 仅用于对象/类形式」。 |
| 3 | 配置走 `apply(ctx, config)` | **✅** | [config](https://deepseek-harness.github.io/deepseek-harness/develop/basic/config)：`apply(ctx, config)`；`Config` interface + 同名 `Schema`（`@deepseek-ai/schemastery`），默认值写在 schema 里，cordis.yml 的 `config:` 传入。官方明确「不要导出普通对象作为 Config」。 |
| 4 | 第三方插件 `lib/` 内**零 `@deepseek-ai` 运行时 import** | **⏳ 官方未提此禁令**（有相近但不同的规则） | [publish](https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish)：官方口径是**依赖声明机制**而非禁令——「需要与宿主共享实例的 dsh 包同时声明在 `peerDependencies` 与 `devDependencies`；需要独立版本的第三方依赖和**无状态 dsh 工具包**放在 `dependencies`」。⇒ 官方**允许** import dsh 包，前提是声明为 peer。[slots](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/slots) 另有一条**针对 UI 包**的规则：「另一个功能包只能通过 `import type` 引入声明；绝不导入或转发它的运行时值」。⇒ 项目结论作为**风险规避策略**成立（与官方 UI 侧规则同向），但不宜表述为「官方要求零 import」。 |
| 5 | 槽位 `conversation.composer.dock` / `conversation.input.right` | **✅ 两者均存在** | [slots](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/slots) 当前层级树：`conversation.composer` 下有 `conversation.composer.dock`；同级还有 `conversation.input.left` / `conversation.input.right` / `conversation.input.dock` / `conversation.input.overlay`。 |
| 6 | 介入点 `agent/pre-step`（可整体替换 messages） | **✅** | [framework/events](https://deepseek-harness.github.io/deepseek-harness/develop/framework/events) 与 [core](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/core)：`agent/pre-step` 是 **waterfall**，payload `{ agent, messages, turn, step, signal }`，返回 `PreStepDecision = {kind:'reject'} \| {kind:'enter', messages, startsRequestSeries?}`。官方注：**不调 `next()` 会短路流水线**；`agent/pre-step` 是请求推导前唯一的 waterfall 链。⚠️ 官方未说「默认必须 off」，这是本项目自己的风险判断。 |
| 7 | 介入点 `ctx.userQuestions.ask()` | **✅** | [user-questions](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/user-questions)：`ctx.userQuestions.ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer>`（agent-scoped waterfall；另有 `askTimed` / `answer` / `attachWait`）。错误码含 `EMPTY_QUESTIONS`、`NO_PROVIDER`、`ASK_ABORTED`、`BAD_INTENT`、`CALLER_NOT_LIVE`、`DELEGATED_CALLER`。⇒ 「agentless 下会 `NO_PROVIDER`」**官方印证** ✅。 |
| 8 | LLM 只有 `ctx.llm.stream`（无 `call`/`complete`） | **✅ 调用入口层面** | [llm-streaming](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/llm-streaming)：`LlmRuntime` 面向调用方的模型调用即 `stream()`（可经 `llm/stream` waterfall 拦截）；另提供 `registerAdapter` / `resolveModelInfo` / `prepareCall` / `providerRetryPolicy` 等**管理面**方法，但**没有** `call`/`complete` 一次性接口。「一次适配器调用就是一次提供方尝试，直接调用 `ctx.llm.stream()` 的调用方仍然只尝试一次」——官方明文。 |
| 9 | `purpose` 仅 `'compaction' \| 'session-title'` | **✅ 精确印证** | [llm-streaming](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/llm-streaming) `GenerateOptions`：`purpose?: 'compaction' \| 'session-title'`，注释「Provider-neutral classification for an auxiliary model call… Ordinary conversation requests leave it unset.」⇒ 辅助调用**只能**标这两个值。⚠️ 「辅助调用须标 `source:{kind:'plugin'}`」——官方有 `MessageSourceMap`，明文「there is no shared catch-all `plugin` kind」，各生产方在自己模块里声明自己的 kind ⏳（未直接印证 `'plugin'` 这个字面量）。 |
| 10 | 服务注册方式（`ctx.provide`？还是 `TypertRemoteService`？） | **✅ 官方给了明确推荐路径**（见第二节）<br>`ctx.provide`：**存在但属底层 API**<br>`TypertRemoteService`：**⏳ 官方未提此名** | [framework/service](https://deepseek-harness.github.io/deepseek-harness/develop/framework/service)：官方推荐 `class X extends Service` + `super(ctx, 'name')` + `declare module` 类型合并，消费方 `inject=['name']` 后用 `ctx.<name>`。`ctx.provide` 出现在 [cordis-api/inherited](https://deepseek-harness.github.io/deepseek-harness/reference/cordis-api/inherited) 的底层清单里（「Low-level service-store access and binding」），**教程不推荐**。`TypertRemoteService` 未出现；官方对 Remote 的做法是 `@Remote(...)` **装饰器**（见 `ctx.agentPresets` / `ctx.userQuestions` 的 `@Remote` 标注）+ `ctx.typert` / `ctx.typertGateway` 两个服务（[capability-seams](https://deepseek-harness.github.io/deepseek-harness/reference/capability-seams)）。 |
| 11 | client 半部注入：`window.__ModuleLoader__`？/`cordis.patch.yml` 的 `dsh.client.inject`？ | **❌ 两个名字都不对**（官方机制存在但命名/位置不同） | [client-modules](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/client-modules)：官方机制 = 包在**自己的 `package.json`** 声明 `dsh.client`（`platform: 'web'`，可选 `inject` 边、可选 `immediately`），并在 **`exports["./client"]`** 导出构建好的 bundle；宿主扫描后组合出 **_`window.__DSH_BOOT__`_** entry 图（`WebBootGraph`），经 `/plugins/??<pkg>/client.js,...&rev=<rev>` combo 路由下发。`inject` 是 `dsh.client` 里的**包间依赖边**，不在 `cordis.patch.yml` 里。⇒ 「`__ModuleLoader__`」**改名**为 `__DSH_BOOT__`；「`dsh.client.inject`」位置改为 package.json。 |
| 12 | `peerDependencies` 该声明哪些包 | **✅ 官方给了判据** | [publish](https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish)：**需要与宿主共享实例的 dsh 包 → 同时写进 `peerDependencies` 与 `devDependencies`**（peer 副本给运行时解析，dev 副本给类型检查/独立测试）；**需要独立版本的第三方依赖 + 无状态 dsh 工具包 → `dependencies`**。另：未声明 `dsh.bundle` 的库包可安装但只作普通依赖。运行中的 peer 使用安装中的副本；规则**不校验 peer 版本范围**。 |
| 13 | 槽位共 86 个；必须是 `slots.inject(name, () => slots.register(...))`，裸 `register` 会 throw | **✅ inject 包裹规则**<br>**⏳ 86 这个数字** | [slots](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/slots)：官方示例代码就是 `ctx.slots.inject(key, () => ctx.slots.register({name, id, order}, Component))`，并说明「向未声明 slot 注册，或重复声明其他 entry 已拥有的 child，都会在插件激活时失败」。官方层级树按 master 分支约为 70 余个具名 key（文档未给总数，数字会随版本变）。⇒ **86 应以实调 `cordis_inspect what:"client"` 为准**，不写死在对外文档里。 |
| 14 | （补充）插件 bundle 必须声明 `dsh.bundle` manifest | **✅ 实证结论缺这一条** | [publish](https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish)：`package.json` 的 `dsh: { bundle: { patch: "./cordis.patch.yml" } }`。没有它，`dsh plugin` 会打印警告且**不激活任何层**。 |
| 15 | （补充）从 git 安装不跑 `build`，必须提供 `prepare` 脚本 | **✅ 实证结论未覆盖** | [publish](https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish)：git 安装拉源码不拉产物；作者需提供自包含 `prepare`；用户需在 profile 的 `pnpm-workspace.yaml` 写 `allowBuilds: <pkg>: true` 授权。 |
| 16 | （补充）`ctx.effect()` / `ctx.on()` / `ctx.tools.register()` 自动清理 | **✅** | [basic](https://deepseek-harness.github.io/deepseek-harness/develop/basic/) 与 [framework](https://deepseek-harness.github.io/deepseek-harness/develop/framework/)：Fiber 状态机 `PENDING→LOADING→ACTIVE→(UNLOADING)→DISPOSED`；必需服务消失时插件自动 dispose、服务回来后自动重载。 |

---

## 二、官方「服务注册 / 插件向 ctx 暴露服务」API 摘录

**结论：官方确实明文印证的「服务注册 API」= Cordis `Service` 基类 + `super(ctx, name)` + `declare module` 类型合并，消费方用 `inject` + `ctx.<name>`。`ctx.provide` 是存在的底层 API 但不是推荐路径。**

### 2.1 最小服务（[develop/framework/service](https://deepseek-harness.github.io/deepseek-harness/develop/framework/service)）

```ts
import { Service, type Context } from '@deepseek-ai/cordis'

export default class MetricsService extends Service {
  static inject = ['llm']   // A service may depend on other services.

  constructor(ctx: Context) {
    super(ctx, 'metrics')   // 'metrics' is the service name.
  }

  // Public service method.
  record(event: string, value: number) {
    // ...
  }
}
```

加载后消费方：

```ts
export const inject = ['metrics']

export function apply(ctx: Context) {
  ctx.metrics.record('tool_call', 1)
}
```

### 2.2 类型声明合并（同页）

```ts
import { Service, type Context } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context {
    metrics: MetricsService
  }
}

export default class MetricsService extends Service {
  constructor(ctx: Context) { super(ctx, 'metrics') }
  record(event: string, value: number) { /* ... */ }
}
```

### 2.3 必需依赖 vs 可选依赖（同页）

```ts
// Required: the plugin does not load while the service is absent.
export const inject = ['tools']

// Optional: omit inject and query with ctx.get() at the use site.
export function apply(ctx: Context) {
  const metrics = ctx.get('metrics')
  metrics?.record('plugin_loaded', 1)
}
```

### 2.4 三角色拆分（Service Definition / Provider / Consumer）——[develop/practice/](https://deepseek-harness.github.io/deepseek-harness/develop/practice/)

这一步直接对应「`ctx.promptCompiler` 服务 + `prompt_compile` 工具」的拆分方式：

```ts
// packages/my-cap/my-cap/src/index.ts  —— Service Definition
import { Service, type Context } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context { myCap: MyCapService }
}

export abstract class MyCapService extends Service {
  constructor(ctx: Context) { super(ctx, 'myCap') }
  /** Execute the capability. */
  abstract execute(request: MyCapRequest): Promise<MyCapResult>
}

export interface MyCapRequest { input: string }
export interface MyCapResult  { output: string }
```

```ts
// packages/my-cap/my-cap-local/src/index.ts  —— Service Provider
import type { Context } from '@deepseek-ai/cordis'
import { MyCapService, type MyCapRequest, type MyCapResult } from '@deepseek-ai/dsh-my-cap'

class MyCapLocal extends MyCapService {
  async execute(request: MyCapRequest): Promise<MyCapResult> {
    return { output: request.input.toUpperCase() }
  }
}

export const name = 'my-cap-local'
export function apply(ctx: Context) {
  ctx.plugin(MyCapLocal)     // ← 服务注册的实际动作
}
```

```ts
// packages/my-cap/tool-my-cap/src/index.ts  —— Consumer（把服务暴露成工具）
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'tool-my-cap'
export const inject = ['tools', 'myCap']

export function apply(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'my_cap',
    description: 'Execute my capability.',
    parameters: { input: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args) {
      const result = await ctx.myCap.execute({ input: args.input })
      return result.output
    },
  }))
}
```

```yaml
# cordis.yml
- name: '@deepseek-ai/dsh-my-cap-local'
- name: '@deepseek-ai/dsh-tool-my-cap'
```

官方设计要点（同页）：**不要预防性拆分**；Service Definition 拥有 Request/Result 类型；Provider 与 Consumer 互不依赖。

### 2.5 `ctx.provide` 的定位（[reference/cordis-api/inherited](https://deepseek-harness.github.io/deepseek-harness/reference/cordis-api/inherited)）

> `ctx.get / ctx.set / ctx.provide / ctx.accessor / ctx.mixin` — Low-level service-store access and binding. (`vendor/cordis/src/reflect.ts:7`)

即：`ctx.provide` **存在**（cordis 底层），但官方把他列在「inherited / low-level」里；教程与 practice 页一律用 `Service` 子类。⇒ 对外表述应写「**推荐** `extends Service`」，不要写「用 `ctx.provide`」。

---

## 三、需要修正/留意的三处表述

1. **「无 default export」** → 改为「函数形式不用 `export default`；`export default` 是官方支持的对象/类形态」。
2. **`window.__ModuleLoader__`** → 官方名是 **`window.__DSH_BOOT__`**；注入靠包 `package.json` 的 `dsh.client` + `exports["./client"]`，**不是** `cordis.patch.yml` 里的字段。
3. **「零 `@deepseek-ai` 运行时 import」** → 官方口径是「共享实例包写 `peerDependencies`、无状态 dsh 工具包写 `dependencies`」，禁 import 只针对 **client UI 声明包**（`import type` only）。这条作为自包含策略可以保留，但不要写成「官方要求」。

另外两条实证结论**缺了官方要求的环节**，建议补进清单：`package.json` 必须声明 `dsh.bundle`；从 git 安装需自包含 `prepare` 脚本 + 用户侧 `allowBuilds` 授权。

---

## 四、关键 URL 清单（共 20）

**develop/（教程）**
1. https://deepseek-harness.github.io/deepseek-harness/develop/basic/ — 插件形态、`name`/`inject`/`apply`、三种形态、自动清理
2. https://deepseek-harness.github.io/deepseek-harness/develop/basic/config — `apply(ctx, config)` + Schemastery schema
3. https://deepseek-harness.github.io/deepseek-harness/develop/basic/tool — `defineTool` 最小示例
4. https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish — **bundle manifest / `dsh.bundle` / peerDependencies 判据 / git 安装 prepare / 层优先级**
5. https://deepseek-harness.github.io/deepseek-harness/develop/framework/ — Fiber 状态机、自动清理、HMR
6. https://deepseek-harness.github.io/deepseek-harness/develop/framework/service — **服务注册主证**
7. https://deepseek-harness.github.io/deepseek-harness/develop/framework/events — emit/bail/serial/waterfall、事件命名
8. https://deepseek-harness.github.io/deepseek-harness/develop/practice/ — **三角色拆分 + `ctx.plugin(ProviderImpl)`**
9. https://deepseek-harness.github.io/deepseek-harness/develop/practice/llm-adapter — `LlmAdapter` / `registerAdapter`

**reference/（生成式参考）**
10. https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/core — `agent/pre-step` waterfall、`PreStepDecision`、`UserMessage`
11. https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/llm-streaming — `GenerateOptions.purpose`、`LlmRuntime`、adapter contract
12. https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/slots — **slot 层级树 + `slots.inject`/`register` + `import type` 规则**
13. https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/user-questions — `ctx.userQuestions.ask()` / `askTimed` / `NO_PROVIDER`
14. https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/client-modules — **`dsh.client` + `exports["./client"]` + `window.__DSH_BOOT__`**
15. https://deepseek-harness.github.io/deepseek-harness/reference/capability-seams — 全量 ctx 服务清单（含 `ctx.typert` / `ctx.typertGateway`）
16. https://deepseek-harness.github.io/deepseek-harness/reference/cordis-api/inherited — `ctx.provide` 等底层 API 定位
17. https://deepseek-harness.github.io/deepseek-harness/reference/cordis-api/service — `Service` 基类 / `super(ctx, name)`
18. https://deepseek-harness.github.io/deepseek-harness/reference/cookbook/adding-a-tool — `defineTool` 完整约定、`exec.agent.inject({source:{kind:'plugin',plugin}})`

**GitHub raw（源码文档，作为生成站的交叉校验）**
19. https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/subsystems/slots.zh.md — slot 树 master 版（比站点多 `plugins.add.actions`、`conversation.chat.flow`、`shell.bottom` 等）
20. https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/subsystems/user-questions.zh.md — `ask` 完整 JSDoc 与错误码

> 注：站点 `develop/` 索引页、`sitemap.xml`、`reference/subsystems/interaction` 抓取失败（HTTP 422），已用 raw 源码文档与 `capability-seams` 交叉覆盖，未构成证据缺口。
