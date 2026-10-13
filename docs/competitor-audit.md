# 竞品审计：yaoshuo530/dsh-prompt-enhancer

> 审计对象：`yaoshuo530/dsh-prompt-enhancer`（MIT）
> 审计方式：`git clone --depth 1` 到本地，通读全部源码（只读，未运行）
> 审计时间：2026-10-13
> 证据约定：所有结论附 `文件:行号`，行号对应 clone 时的 HEAD `0def917`（2026-08-28 15:52:16 +0800）
> 本地路径：`work/competitor-enhancer/`（相对项目根 `dsh-prompt-compiler/`）

---

## 1. 仓库概览

### 1.1 一手元数据（`gh api repos/yaoshuo530/dsh-prompt-enhancer` 返 200）

| 项 | 值 |
|---|---|
| License | MIT（`gh` 返回 `license.spdx_id = MIT`；`LICENSE` 文件 1086 字节） |
| **stargazers_count** | **5**（与「DSH 市场 5★」一致） |
| forks_count | 0 |
| open_issues_count | 0 |
| default_branch | `main` |
| created_at | 2026-08-28T07:22:32Z |
| pushed_at | 2026-08-28T07:52:17Z |
| 版本 | `0.1.0`（`package.json:3`、`CHANGELOG.md:3`） |

> 结论：一次性发布、此后再无提交（created 与 pushed 相差 30 分钟），fork / issue 全为 0。

### 1.2 文件树（排除 `.git`，共 17 项）

```
.github/
└── workflows/ci.yml                 536 B   ← 只有语法检查
docs/
└── architecture.md                 4278 B   ← 架构说明（含一个已修 bug 的记录）
examples/
└── enhanced-prompt.md              1448 B   ← 输出示例
lib/
├── client.js                      14965 B   ← Client 半（浏览器，ModuleLoader 手写）
└── index.js                        15128 B   ← Host 半（Node，HTTP RPC + llm.stream）
.editorconfig                        167 B
.gitignore                           173 B
CHANGELOG.md                         523 B
CONTRIBUTING.md                      956 B
cordis.patch.yml                     116 B
LICENSE                             1086 B
package.json                        1338 B
README.md                           5342 B
README.zh.md                        4358 B
SECURITY.md                          468 B
```

**注意：仓库里没有 `src/`、没有 `tsconfig.json`、没有 `scripts/`、没有 tsdown/rollup/esbuild 配置、没有 `dist/`、没有任何测试文件。**

### 1.3 安装清单 `cordis.patch.yml`（全文 3 行）

```yaml
# dsh-prompt-enhancer 安装清单：把插件行插入 profile 配置
- insert:
    - name: dsh-prompt-enhancer
```

（`cordis.patch.yml:1-3`）符合本项目已知的「列表式 `insert:`」正确写法。

---

## 2. 三问逐条回答

### ① client bundle 如何产出成 ModuleLoader 格式？构建预设/命令是什么？

**答：没有构建。没有构建预设。没有构建命令。`lib/client.js` 是手写的 ModuleLoader 格式源码，由 DSH web 运行时直接加载。**

证据链：

1. **无构建工具链**：`package.json:15-17` 的 `scripts` 只有一个：
   ```json
   "scripts": {
     "check": "node --check lib/index.js && node --check lib/client.js"
   }
   ```
   没有 `build`、没有 `dev`、没有 tsdown。CI 也只跑语法检查（`.github/workflows/ci.yml:16-19`）。

2. **ModuleLoader 包装是手写的**：`lib/client.js:9-14`
   ```js
   window.__ModuleLoader__.load({
     id: "dsh-prompt-enhancer",
     factory: (require) => {
       var module = { exports: {} };
       var exports = module.exports;
       var React = require("react");
   ```
   末尾 `client.js:246-249` 手写 CJS 出口：
   ```js
   exports.inject = inject;
   exports.apply = apply;
   return module.exports;
   ```
   即：**手工伪造 `module` / `exports` 对象**，把 `require`（由 ModuleLoader 提供）拿来的 React 作为唯一外部依赖，全部 UI 用 `React.createElement` 裸写（`client.js:117-142` 等），**没有 JSX、没有编译**。

3. **运行时由 `package.json` 的 `dsh.client` 元数据驱动**（`package.json:34-47`）：
   ```json
   "dsh": {
     "bundle": { "patch": "./cordis.patch.yml" },
     "client": {
       "inject": [
         "@deepseek-ai/dsh-client-runtime",
         "@deepseek-ai/dsh-client-connection",
         "@deepseek-ai/dsh-client-ui-slots",
         "@deepseek-ai/dsh-client-locale"
       ],
       "platform": "web"
     }
   }
   ```
   这是**唯一可被称作"构建预设"的东西**：字段名 = `package.json → dsh.client`（含 `inject` 白名单数组 + `platform: "web"`）。`exports` 里 `"./client": "./lib/client.js"`（`package.json:26`）把 `lib/client.js` 直接暴露为子路径导出 —— 源码即产物。

4. **旁证（遗留痕迹）**：`.gitignore:4-6` 写着
   ```
   dist/
   lib/*.map
   ```
   说明作者最初按「有构建」的模板建仓库，最终却走了零构建路线；仓库里实际不存在 `dist/`。

> **对本项目的方法论意义**：client 半可以完全零构建 —— 手写 `window.__ModuleLoader__.load({ id, factory })` + `require("react")` + `React.createElement` 即可，不需要引入 tsdown。代价是无 JSX、无类型检查、无 tree-shaking。

---

### ② 澄清卡片的状态机怎么设计？代码位置？

**答：没有显式 FSM。是一个「单例可变 store + 订阅广播 + 渲染期 if 优先级链」，外加一个 `requestSeq` 做陈旧响应丢弃。**

#### 2.1 状态载体（非枚举，四个独立字段）

`lib/client.js:46`
```js
const store = { busy: false, error: null, questions: null, preview: null };
```
四个字段就是全部状态：`busy` / `error` / `questions` / `preview`。**没有 `state: 'idle'|'busy'|'clarify'|'preview'|'error'` 这样的枚举变量。**

#### 2.2 状态迁移原语

| 原语 | 位置 | 作用 |
|---|---|---|
| `emit()` | `client.js:49` | 广播给所有 listener |
| `patch(p)` | `client.js:50` | `Object.assign(store, p); emit()` —— 部分更新 |
| `close()` | `client.js:51` | `requestSeq++` + 四个字段全清（回到 idle） |
| `subscribe(fn)` | `client.js:52` | 注册 listener，返回退订函数 |

#### 2.3 重渲染机制（关键坑，作者踩过并修）

`client.js:169-170`（按钮）与 `client.js:221-222`（浮层）：
```js
const [, force] = React.useState(0);
React.useEffect(() => subscribe(() => force(v => v + 1)), []);
```
`docs/architecture.md:53-54` 明确记录：
> State updates use functional setState (`force(v => v + 1)`) to avoid React bail-out (a fixed bug where the UI stuck on the "enhancing" card).

#### 2.4 渲染期的 if 优先级链（= 事实上的状态判定）

`client.js:218-243`（`shell.overlay` 槽位注册）：
```js
if (store.busy)      { /* 223-229: 正在增强… */ }
if (store.error)     { /* 230-238: 增强失败卡 */ }
if (store.questions) return React.createElement(QuestionCard);   // 239
if (store.preview)   return React.createElement(PreviewCard);     // 240
return null;                                                       // 241
```
优先级：`busy` > `error` > `questions`(clarify) > `preview` > `null`(idle)。

#### 2.5 完整迁移表（从代码反推）

| # | 迁移 | 代码位置 |
|---|---|---|
| 0 | idle → busy | 点击按钮 `patch({ busy:true, error:null, questions:null, preview:null })` `client.js:181` |
| 1 | busy → error | `prepare` 返回 `error` `client.js:185`；RPC 抛错 `client.js:202` |
| 2 | busy → clarify | `res.needClarification && questions.length>0` → `patch({ busy:false, questions:{items,assumptions,text,sessionId} })` `client.js:186-188` |
| 3 | busy → preview（直通，跳过澄清） | 同一次 onClick 内直接 `rpc('complete', {answers: []})` → `patch({ busy:false, preview:{text} })` `client.js:190-198` |
| 4 | clarify → preview | QuestionCard `submit()` → `rpc('complete')` → `patch({ questions:null, preview:{text: res.enhanced} })` `client.js:101-110` |
| 5 | clarify → 本地 error（`err`，非 store.error） | `client.js:109`、`client.js:111`、`client.js:114` |
| 6 | preview → idle（应用） | `apply()` → `store.applyDraft(text)` → `setApplied(true)` → `close()` `client.js:148-152` |
| 7 | 任意 → idle（放弃/取消/关闭） | `close` 按钮 `client.js:139`、`160`、`236` |

#### 2.6 并发防护：`requestSeq`

- 声明 `client.js:47`（`let requestSeq = 0`）
- 发起：`const seq = ++requestSeq`（`client.js:97` QuestionCard submit、`client.js:180` 按钮 onClick）
- 失效：`close()` 里 `requestSeq++`（`client.js:51`）
- 丢弃陈旧响应：`if (seq !== requestSeq) return`，见 `client.js:108`、`184`、`196`、`201`，以及 catch 分支 `client.js:113`

#### 2.7 卡片内部的局部 React state（不属于 FSM，但影响 UX）

| 组件 | 局部 state | 位置 |
|---|---|---|
| `QuestionCard` | `answers`（`useState(() => items.map(...))`，**只初始化一次**） | `client.js:80` |
| `QuestionCard` | `submitting` | `client.js:81` |
| `QuestionCard` | `err` | `client.js:82` |
| `PreviewCard` | `applied` | `client.js:147` |

#### 2.8 入口守卫 `canRun`

`client.js:177`
```js
const canRun = draft.trim().length > 0 && !store.busy && store.questions === null;
```
**只排除了 `busy` 和 `questions`，没有排除 `error` / `preview`**（见弱点 W3）。

> **对本项目的方法论意义**：这套「store + subscribe + force + requestSeq」是可用且已被验证的最简模式（约 8 行），但缺显式枚举。本项目建议升级为 `state` 单一枚举 + reducer，避免 if 链的隐式优先级。

---

### ③ `POST /__dsh-enhance/api` 的 HTTP RPC 契约？

**答：自造的极简 JSON-RPC（单一 endpoint + `method` 字段分发），注册在 DSH web server 的 prefix 路由上。**

#### 3.1 路由注册

`lib/index.js:332`
```js
ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/__dsh-enhance', handler: handle }))
```
- 依赖注入声明：`export const inject = ['llm', 'webServer']`（`index.js:11`）
- 包在 `ctx.effect()` 内，插件卸载时自动注销（cordis 惯例）

#### 3.2 请求行与路由匹配（`index.js:292-305`）

```js
const raw = (req.url || '').split('?')[0].split('#')[0];     // 293
decoded = decodeURIComponent(raw);                            // 296（try/catch 兜底）
const isApi = req.method === 'POST' && /\/api\/?$/.test(decoded); // 300
if (!isApi) → 404 { ok:false, error:'not found' }             // 301-304
```
- **只接受 POST**；非 POST 或路径不匹配一律 404
- 匹配的是**后缀正则** `/\/api\/?$/`，配合 prefix `/__dsh-enhance` ⇒ 有效路径即 `/__dsh-enhance/api`

#### 3.3 请求体读取（`index.js:306-315`）

```js
let body = ''
for await (const chunk of req) body += chunk   // 307 —— 无大小上限
payload = JSON.parse(body || '{}')             // 310
// 解析失败 → 400 { ok:false, error:'请求体不是合法 JSON' }
```

#### 3.4 信封格式

**请求**
```jsonc
{
  "method": "prepare" | "complete",   // index.js:316 用 api[payload.method] 查表
  "args": { ... }                     // index.js:323 handler(payload.args || {})
}
```

**响应（统一信封）**

| HTTP | 体 | 位置 |
|---|---|---|
| 200 | `{ "ok": true, "value": <method 返回值> }` | `index.js:324-325` |
| 400 | `{ "ok": false, "error": "请求体不是合法 JSON" }` | `index.js:312-313` |
| 404 | `{ "ok": false, "error": "not found" }` | `index.js:302-303` |
| 404 | `{ "ok": false, "error": "未知 API 方法: <method>" }` | `index.js:318-319` |
| 500 | `{ "ok": false, "error": "<String(e.message)>" }` | `index.js:327-328` |

Content-Type 恒为 `application/json; charset=utf-8`。

#### 3.5 方法表

`index.js:290`：`const api = { prepare, complete }`

##### `prepare(args)`

- **入参**（`index.js:201-202`）：`{ text: string, sessionId: string }`
- **前置校验**：`text` 空 → 直接返回 `{ error: '提示词为空' }`（`index.js:203`）；无模型路由 → `{ error: '未找到可用的模型路由：请先在该会话进行过一次对话，或在设置中选择默认模型' }`（`index.js:206`）
- **出参**（`index.js:239-243`）：
  ```jsonc
  {
    "needClarification": true,          // 仅当 ===true 且 questions 非空才为真（240）
    "questions": [ Question ],          // 241
    "assumptions": ["默认假设文本"]      // 242
  }
  ```
- **错误出参**：`{ error }`（`index.js:227` 模型调用失败、`index.js:234` JSON 解析失败）
- `Question` schema（`normalizeQuestion`，`index.js:128-144`）：
  ```jsonc
  {
    "id": "q1",              // 必需，string，否则整条丢弃（129）
    "question": "问题内容",   // 必需，string（129）
    "detail": "补充说明",     // 可选
    "header": "短标题",       // 可选
    "multiSelect": false,    // 仅 ===true 为真（141）
    "options": [ { "label": "选项", "description": "选项说明" } ]  // 空数组时置 undefined（142）
  }
  ```

##### `complete(args)`

- **入参**（`index.js:247-250`）：`{ text: string, sessionId: string, answers: Answer[], assumptions: string[] }`
- `Answer` 形状（client 侧构造 `client.js:104-105`，host 侧消费 `formatAnswers` `index.js:146-156`）：
  ```jsonc
  { "id": "q1", "question": "…", "selected": ["选项A"], "custom": "补充" }  // custom 为空串时省略
  ```
- **出参成功**：`{ enhanced: "<增强后的提示词纯文本>" }`（`index.js:287`）
- **出参失败**：`{ error }`（`index.js:251` 空、`254` 无路由、`283` 模型失败、`286` 空结果）

#### 3.6 Client 侧调用封装

`client.js:54-65`
```js
async function rpc(method, args) {
  const res = await fetch('/__dsh-enhance/api', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, args }),
  });
  const data = await res.json().catch(() => ({}));
  if (!data || data.ok !== true) throw new Error((data && data.error) || 'RPC 失败（HTTP ' + res.status + '）');
  return data.value;
}
```
调用点：`rpc('prepare', { text, sessionId })`（`client.js:183`）、`rpc('complete', {...})`（`client.js:101`、`client.js:190`）。

#### 3.7 协议特征小结

- **同步请求/响应，无 streaming**：即使 host 内部用 `llm.stream`（`index.js:117`），对 client 也是「等到流完再一次性返回」（`index.js:115-125` 累积 `out`）。complete 最长阻塞 120s（`index.js:280`）。
- **无鉴权、无 CSRF、无 sessionId 归属校验**（见弱点 W15）。
- **业务错误走 HTTP 200**：`prepare`/`complete` 内部 `return { error }` 仍被包成 `{ ok:true, value:{error} }`（`index.js:325`），client 必须额外判 `res.error`（`client.js:109`、`185`）。

---

## 3. 可复用点清单（抄它的什么）

| # | 可复用点 | 证据位置 | 说明 |
|---|---|---|---|
| R1 | **零构建 client 半**：手写 `window.__ModuleLoader__.load({id, factory})` + 手写 `module/exports` shim | `client.js:9-14`、`246-249` | 省掉 tsdown 整条工具链；代价是无 JSX/无类型 |
| R2 | **槽位注册正确姿势** `slots.inject(name, () => slots.register(meta, render))` | `client.js:166-167`、`218-219` | 与本项目已知「裸 register 会 throw」一致，可照抄 |
| R3 | **`requestSeq` 陈旧响应丢弃** | `client.js:47`、`97`、`108`、`180`、`184`、`196`、`201` | 7 行代码解决竞态，值得照搬 |
| R4 | **函数式 `force(v => v + 1)` 避免 React bail-out** | `client.js:170`、`222` + `docs/architecture.md:53-54` | 外部 store 驱动 React 的必备技巧，作者踩坑后明确记录 |
| R5 | **`withTimeout` 优先用 `ctx.get('timer')`** | `index.js:23-36` | 用宿主 timer 服务（可随插件卸载清理）而非裸 `setTimeout` |
| R6 | **`extractJson` 容错解析**：先剥 ```` ```json ```` 围栏，再取首个 `{` 到末个 `}` | `index.js:38-46` | 模型输出 JSON 的实用清洗器，可直接抄 |
| R7 | **`normalizeQuestion` 白名单字段净化** | `index.js:128-144` | 逐字段判类型、脏数据整条丢弃，防御模型乱输出 |
| R8 | **DSH 主题 token 复用**：`--dsw-alias-button-info-fill` / `--dsw-alias-bg-overlay` / `--dsw-alias-border-l1/l2` 等，且每个都带 fallback 色值 | `client.js:18-43`（尤其 `38`） | 视觉原生感的低成本做法 |
| R9 | **回填输入框**：`props.inputActions.setDraft(text)` | `client.js:173-176`、`149` | 「预览 → 应用」闭环的关键 API |
| R10 | **槽位选择**：`conversation.input.right`（order 200）+ `shell.overlay`（order 200） | `client.js:167`、`219` | order 200 是它实测可用的取值 |
| R11 | **`package.json` 元数据写法**：`dsh.bundle.patch` + `dsh.client.inject` + `dsh.client.platform` + `exports["./client"]` | `package.json:24-47` | 声明式、无需构建脚本 |
| R12 | **`cordis.patch.yml` 列表式 `insert:`** | `cordis.patch.yml:1-3` | 与本项目纪律一致 |
| R13 | **第一性原理四段式系统提示**（思考/规划/执行/反馈）+ 上下文分段标签 `<context>` / `<history>` / `<user_prompt>` / `<answers>` / `<assumptions>` | `index.js:158-198`、`207-221`、`255-277` | 可直接作为本项目 prompt 模板的基线 |
| R14 | **`ctx.effect(() => ...)` 包裹资源注册** | `index.js:332`（路由）、`client.js:73`（样式注入） | 卸载自动清理 |
| R15 | **模型路由选择**：`agent.options` → 回退 `agentDefaultModel.currentSelection()` | `index.js:48-58` | 三级回退的取值顺序 |
| R16 | **上下文截断保护**：persona 12000 字符、history 6000 字符 + 「…(截断)」标记 | `index.js:72`、`97` | 防 context 爆炸 |
| R17 | **`reasoningEffort: 'off'` + `temperature: 0.3`** 用于结构化输出 | `index.js:108-114` | 提升 JSON 稳定性的实用参数 |

---

## 4. 弱点清单（= 本项目的卖点）

> 每条带代码位置证据，按「本项目可攻击的强度」排序。

### W1 — 🔴 无服务化 API：其它插件/Agent 完全无法复用（**本项目头号卖点**）
- `index.js:9-11` 只导出 `name` / `inject` / `apply`，**没有导出任何 service**，也没在 `ctx` 上挂载任何能力。
- 全部能力锁死在 `POST /__dsh-enhance/api` 这一个 HTTP 端点上（`index.js:332`）；浏览器之外（CLI、TUI、其它插件、子 Agent）**一条路都没有**。
- ⇒ 本项目 `ctx.promptCompiler` 服务 + `prompt_compile` 工具（自包含 `defineTool`）是**结构性差异**，不是功能多少的差异。

### W2 — 🔴 零跨 harness：只支持 DSH web
- `package.json:45` 写死 `"platform": "web"`；`README.md:94`「DeepSeek Harness (DSH) web」。
- 全仓库无任何 CLI / Claude Code / 非浏览器路径；`lib/client.js` 直接引用 `window`（`client.js:9`）与 `document`（`client.js:68`），在 Node 侧必然崩。
- ⇒ 本项目「跨 DSH（主）/ Claude Code（次）」是它完全没有的维度。

### W3 — 🟠 状态机是隐式 if 优先级链，无枚举、无非法态保护
- `client.js:223-241` 的优先级链是**唯一**的状态判定依据；没有 `state` 枚举变量。
- 直接后果：`busy` 与 `error` 同时为真时只渲染 busy（`error` 被静默吞掉）；`questions` 与 `preview` 同时为真时只渲染 clarify。
- `canRun` 守卫 `client.js:177` 只排除 `busy` / `questions`，**未排除 `error` 与 `preview`** ⇒ error 卡弹出时按钮仍可点击触发新一轮请求。

### W4 — 🟠 业务错误用 HTTP 200 包装，协议语义混乱
- `prepare`/`complete` 内部 `return { error }`（`index.js:203`、`206`、`227`、`234`、`251`、`254`、`283`、`286`）都被 `index.js:325` 包成 `{ ok:true, value:{error} }` 返回 200。
- client 必须靠**应用层字段**二次判断：`if (res && res.error)`（`client.js:109`、`185`、`197`）。
- 对比：`ok:false` 只用于传输层/未知方法（`index.js:303`、`313`、`319`、`328`）。两套错误语义混在一个信封里。

### W5 — 🟠 与 DSH 已知的 LLM 调用约定不符：未标 `source` / 未处理 `purpose`
- `index.js:106-114` 的 `ctx.llm.stream({...})` **没有传 `source:{kind:'plugin'}`**，也没有传 `purpose`。
- 本项目实证结论：辅助调用须标 `source`；`purpose` 仅 `'compaction' | 'session-title'` —— 竞品两处都没做，属于「能用但不规范」，在多插件并发场景下无法归因与限流。

### W6 — 🟠 参数硬编码，零配置项
- `index.js:108-114`：`reasoningEffort:'off'`、`temperature:0.3`、`maxTokens:4000` 全部写死。
- `index.js:13` 的 `export function apply(ctx)` **不接收 `config` 参数**，`inject` 里也没有 config 服务 ⇒ 用户无法选模型、无法调温度、无法开关澄清、无法改问题数量上限（"最多 3 个问题"写死在 prompt 里，`index.js:167`）。
- `README.md:43` 直接写「Configuration: None required」。

### W7 — 🟠 两轮全量上下文重复付费，无缓存
- `prepare`（`index.js:207-221`）与 `complete`（`index.js:255-277`）**各自独立调用 `collectContext`**（`index.js:204`、`252`），每次都重新 `systemPrompt.assemble()`（`index.js:67`）+ `readSurface()`（`index.js:81`），各带上至 12000 + 6000 字符。
- 一次「澄清 → 生成」= 两次 assemble + 两次 readSurface + 两次 LLM 调用，**persona/history 完全重复计价**。

### W8 — 🟠 无降级路径
- 无模型路由 → 直接失败 `index.js:206`；模型报错 → 直接失败 `index.js:227`/`283`；JSON 解析失败 → 直接失败 `index.js:234`。
- **没有任何规则式/模板式兜底**：没有本地模板库、没有「跳过增强直接用原文」、没有离线模式。
- `withTimeout` 在 `ctx.get('timer')` 为 undefined 时**直接返回原 promise，等于无超时**（`index.js:24-25`），连超时保护都会静默失效。

### W9 — 🟡 无评分 / 无质量度量 / 无迭代
- 功能列表（`README.md:10-17`）里**没有 scoring**，代码里也不存在任何评分逻辑；输出只有 `{ enhanced }`（`index.js:287`）。
- 澄清**只有一轮**：`QuestionCard.submit()` 直接 `rpc('complete')`（`client.js:101`），成功后 `patch({questions:null, preview:...})`（`client.js:110`），**不会回到 clarify 态**；没有「再改一轮」、没有 diff 视图、没有版本对比。
- ⇒ 本项目「澄清 + **评分** + 教学」三件套中，它只有第一件。

### W10 — 🟡 无持久化、无历史、无撤销
- 全流程在内存单例 `store`（`client.js:46`）里，**刷新即丢**；无磁盘存储、无历史记录。
- 「应用到输入框」直接 `actions.setDraft(text)` 覆盖（`client.js:149`），**未保存原 draft** ⇒ 用户无法撤销回原文（`PreviewCard` 只有 `applied` 标记 `client.js:147`，`close()` 后一切清空 `client.js:51`）。

### W11 — 🟡 HTTP 端点无鉴权、无 CSRF、无 body 限制、无 sessionId 归属校验
- `index.js:332` 注册时**没有任何 auth 中间件**；任何能访问 DSH web server 的来源都可 POST。
- `index.js:307` `for await (const chunk of req) body += chunk` —— **无 Content-Length 校验、无大小上限**（DoS 面）。
- `sessionId` 由客户端任意传入（`client.js:183`），host 侧**不校验该 session 是否属于当前用户/连接**（`index.js:202`、`248`）⇒ 可读取任意会话的 persona 与最近 30 条对话。
- 无 CSRF token、无 Origin 校验；`SECURITY.md` 只有漏洞上报流程，无威胁模型。

### W12 — 🟡 日志泄露用户内容
- `index.js:121` 每次 LLM 调用都 `console.log` 输出前 120 字符：`'[enhance] llm finish=… head=' + out.slice(0,120)` —— 用户提示词内容直接进日志。
- `index.js:233` 解析失败时 `console.error('enhance.prepare parse failed', raw)` —— **整段模型原始输出**进日志。
- `index.js:74`、`99`、`226`、`282` 同样 `console.error` 无脱敏。

### W13 — 🟡 无取消机制（AbortController 缺失）
- `close()` 只是 `requestSeq++`（`client.js:51`）让响应被丢弃，host 侧请求**仍在跑**（最长 90s/120s，`index.js:224`、`280`）。
- `withTimeout` 是 Promise.race 式的丢弃，**未向下游 `llm.stream` 传播 abort**（`index.js:23-36` vs `index.js:117` 的 `for await` 循环没有 break/abort）。
- 反复点「取消」会持续消耗模型 token。

### W14 — 🟡 依赖声明未实际使用 + i18n 缺失
- `package.json:39-43` 声明注入 4 个 `@deepseek-ai/dsh-client-*`，但 `client.js:14` **只 `require("react")`** —— runtime / connection / ui-slots / locale 一个都没用。
- UI 文案全中文硬编码：`client.js:119`（"增强前需要你确认几个问题"）、`139-140`（取消/生成增强提示词）、`155-161`（增强后的提示词/放弃/应用到输入框）、`226-227`（正在增强提示词…）等。
- `CONTRIBUTING.md:25` 明确承认：「UI strings are currently Chinese; keep them in the plugin code.」

### W15 — 🟡 无测试、无类型、质量门禁形同虚设
- 仓库**无 test 目录、无任何测试文件**。
- CI 只有 `node --check lib/index.js && node --check lib/client.js`（`.github/workflows/ci.yml:16-19`、`package.json:16`）—— 只验语法，不验行为。
- 全仓库无 `tsconfig`、无 JSDoc 类型、无 lint。

### W16 — 🟡 代码质量细节问题
| 问题 | 位置 |
|---|---|
| render 期间写外部可变单例：`store.applyDraft = ...` | `client.js:174-176` |
| `QuestionCard` 的 `answers` 用 `useState(() => ...)` 只初始化一次，questions 变化不会重置 | `client.js:80` |
| `slots === undefined` 时**静默 `return`**，无任何日志/降级提示，插件表现为「按钮就是不出现」 | `client.js:75-76` |
| `inject` 为空数组但 `exports.inject = inject`，未声明任何依赖却用了 `slots` / `ctx.effect` | `client.js:16`、`246` |
| 拼接字符串构造 UI 文案与 answers（`formatAnswers` 手工拼 `→ 选择:`），易被用户输入注入破坏格式 | `index.js:146-156` |
| `extractJson` 用 `lastIndexOf('}')` 粗暴截断，嵌套/多对象输出会误取 | `index.js:43-45` |
| `req.url` 先 `decodeURIComponent` 再正则匹配，解码后的 `%2F` 可能造成路径歧义 | `index.js:293-300` |

### W17 — 🟡 无障碍 / 键盘交互缺失
- `enhance-mask` 无 `role="dialog"`、无 `aria-*`，无 Esc 关闭、无焦点陷阱、无初始焦点（`client.js:117-142`、`153-163`）。
- 遮罩 `client.js:23` 只有 `onClick` 在按钮上，点遮罩空白不关闭。

### W18 — 🟢 维护活跃度低、功能覆盖窄
- 2026-08-28 单日发布后再无提交（created/pushed 相差 30 分钟）；fork 0、issue 0、star 5（`gh api` 一手数据）。
- 只覆盖「即时增强」一个场景：无模板库、无领域预设、无批量、无 A/B、无输出格式约束（格式只写在 prompt 里 `index.js:195`，无结构化校验）。
- `README.md:92-97` 声明依赖「至少一个可用的模型路由」，无自带模型/无本地规则引擎。

---

## 5. Client 构建预设摘录

### 5.1 结论先行

> **该仓库不存在构建预设（无 tsdown / 无 `scripts/` / 无 `tsconfig`）**。
> 唯一可称为「client 构建预设」的是 `package.json` 里的 **`dsh.client`** 字段：
> 字段名 `dsh.client`，含 `inject`（数组）与 `platform`（`"web"`）。

### 5.2 摘录 `package.json:22-51`（原文）

```json
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",
    "./package.json": "./package.json"
  },
  "files": [
    "lib/",
    "cordis.patch.yml",
    "README.md"
  ],
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    },
    "client": {
      "inject": [
        "@deepseek-ai/dsh-client-runtime",
        "@deepseek-ai/dsh-client-connection",
        "@deepseek-ai/dsh-client-ui-slots",
        "@deepseek-ai/dsh-client-locale"
      ],
      "platform": "web"
    }
  },
  "engines": {
    "node": "^22.19.0 || >=24"
  },
  "license": "MIT"
```

### 5.3 摘录 `package.json:15-17`（唯一的 script）

```json
  "scripts": {
    "check": "node --check lib/index.js && node --check lib/client.js"
  },
```

### 5.4 摘录 `lib/client.js:9-14`（手写 ModuleLoader 头）

```js
window.__ModuleLoader__.load({
  id: "dsh-prompt-enhancer",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require("react");
```

### 5.5 摘录 `lib/client.js:246-249`（手写 ModuleLoader 尾）

```js
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  }
});
```

### 5.6 摘录 `docs/architecture.md:47-54`（官方自述）

```
## Client half (`lib/client.js`)

- ModuleLoader-format browser plugin (`window.__ModuleLoader__.load`).
- UI contributions:
  - `conversation.input.right` — the "✨ Enhance" button (id `enhance-prompt`).
  - `shell.overlay` — overlay cards (id `enhance-overlay`): busy state,
    clarification questions, preview, error.
- Communication with the Host half uses `fetch('/__dsh-enhance/api', ...)`.
- State updates use functional setState (`force(v => v + 1)`) to avoid React
  bail-out (a fixed bug where the UI stuck on the "enhancing" card).
```

---

## 6. 一句话定位（供本项目引用）

`dsh-prompt-enhancer` 是一个**手工打造、零构建、单场景、仅 DSH web、无服务化 API** 的 UI 型增强器 —— 它的 UI 交互链路（按钮 → 澄清卡 → 预览 → 回填）已跑通且可直接借鉴，但在**可编程性（service / tool）、跨 harness、降级、评分、鉴权、可测试性**六个维度全部空白，正是本项目「可编程 prompt 编译层」的差异化空间。
