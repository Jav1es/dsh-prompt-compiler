# Changelog

本项目的所有重要变更都记录在此文件。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.4.1] - 2026-10-19

这一版只修一件事：**编译不再卡住不动**。

### 修复

- 🔴 **编译可能等几分钟且毫无反馈**（真实宿主实测 **215.7 秒**，同任务只要 5.8 秒）。三个叠加原因：
  1. **模型选择盲取列表第一个**：`resolveModelForProvider` 用 `listModels(provider)[0]`。
     workbuddy 列表首位是 `hy4-preview-f`，它一次编译吐 **2250~2632 个 chunk**（大量
     `reasoning-delta`），而会话在跑的 `hy3-x` 只要 **28 个** —— 慢约 37 倍。
     现在改为：**会话当前模型 → 该 provider 优选档 → 列表首个**，且前两级都要在
     `listModels` 清单里确认归属（不靠模型名猜，避免把 A 家的档塞给 B 家）。
  2. **`for await` 没有时限**：宿主不结束就永远等。现在加**双层 deadline（默认 90 秒）**：
     逐 chunk 检查 + 外层 `Promise.race`。后者是必需的 —— 若宿主一个 chunk 都不吐，
     内层检查永远轮不到执行。
  3. **超时后不再换 purpose/provider 重试**：那只会再等 90 秒，没有收益。直接降级出结果。
- **超时与"模型不可用"都明确告知用户**：`diag.timedOut` / `diag.timeoutNote` /
  `diag.modelUnavailable`。区分"我们主动放弃（太慢）"与"宿主出错"，
  并点名是**哪个模型**没调用成功，而不是只说一句"已降级"。
- **加载态显示已用时秒数**：前端每秒自增，超过 60 秒提示"超过 90 秒将自动改用规则式编译"。
  旧实现只有一句静态文案，界面几分钟纹丝不动，用户无法区分"在跑"和"死了"。

### 新增

- `setDeadlineMs(ms)`：设置单次模型调用时限。传 `null` = 回落默认 90 秒（返回 90000），
  传 `0` = 不限时（**仅测试用**）。
- `tests/timeout.test.js`（9 条）：锁死上述三项。每条都用**注入破坏**验证可被击穿 ——
  去掉 `Promise.race` 会让测试进程直接挂死（这本身就是"没有 deadline 就会挂住"的证据）。

### 诚实记录

- 宿主 `ctx.llm` 实际只有 `ctx / name / typertRemote / adapters / directory / discoveries`
  这些键（已用 `asar-read.cjs` 实读 `app.asar` + 运行时 `diag.llmKeys` 双向确认），
  **不暴露"当前会话模型"**。所以"优先用会话当前模型"这条在**本机当前版本上取不到值**，
  会自动退到 provider 优选档 `hy3-x`（实测有效）。等宿主提供该字段时无需改代码即可生效。

## [0.4.0] - 2026-10-17

这一版加了**确定性的质量尺子**和**可验证的对外材料**。
两条主线：一是把"prompt 好不好"这件事从主观判断变成可复跑的数字；二是承认
之前对竞品格局的判断有错，并把错的说法改回来。

### 新增

- **五维评分 `lib/scoring.js`**（F1）：目标 / 上下文 / 约束 / 验收 / 歧义各 20 分。
  **规则式、零依赖、零模型调用** —— 同一输入恒得同分，因此可以进 CI、可以做 Before/After 对比。
  与旧的 `score` 字段**并存不混算**（旧字段保留只为向后兼容）。
- **公开评测集 `evals/`**（F3）：12 条真实形态 draft + 4 条负向样本，`npm run eval` 一键复跑。
  实测：原始 draft 平均 **17.2**（区间 12–38）→ 补全信息后 **81.5**（平均 **+64.3**），
  38 个期望提升项命中率 **100%**，负向空壳全部 **0** 分。
- **交互式澄清 `elicitInteractive`**（E2）：真的通过 `ctx.userQuestions` 向用户提问。
  新增路由 `/api/elicit-interactive`。
- **`agent/pre-step` 自动模式**（E4）：**默认完全关闭**，需
  `enabled` 与 `iUnderstandTheRisk` **双开关**同时置位才生效；即便开启也**只追加、绝不替换**用户消息。
- **作品集页面 `docs/portfolio.html`**（H3）与**竞品对比表 `docs/competitor-comparison.md`**（H4，23 个仓库现场核实）。
- **三层验收 `verify:static` / `verify:unit` / `verify:e2e`**（H1），含**提示词守门**：
  双向校验系统提示与工具注册表一致（提示词提到的工具必须已注册，给模型用的工具必须被提示过）。
- **`verify:prompt` 独立成层**：提示词守门从 e2e 里拆出来单独跑。
  这类错单测、静态检查、e2e 主体都看不出来（服务能跑、路由能通，只是模型永远用不上那个工具），
  必须是单独一层把两边拉在一起比对。验收链最终形态：`static → unit → prompt → e2e`。
- **`docs/eval-report.md`**：对外数字的唯一出处，含逐条明细与「两档不混算」纪律说明。

### 修复

- 🔴 **规则式 compile 自己给自己扣分**（越编译越差）：`crawler-mid`「目标：帮我写个爬虫抓新闻，输出 JSON。」
  编译后 **34 → 32（−2）**。两个根因：
  - `Constraints` 段无用户答案时填了「明确、可执行、无歧义」—— 听着像约束，**实际什么都没约束**；
  - 假设句写了「模型在**合理**范围内自行决策」—— "合理"是模糊词，歧义维如实扣 2 分。
  ⇒ 改为**把缺口显式写成缺口**（「未提供约束，请补充：…」），假设句不用模糊词。
  修完规则式 compile 增益从 **+32.8 升到 +53.7**，最小增益 **+20**，**无一条为负**。
  新增测试底线⑤ / ⑤b，已用回滚注入验证会变红。
- **按句号无条件分句**，把 `news.example.com`、`robots.txt`、`v1.2.3` 切成半截，
  导致扣分证据无法复核。改为向前查找句末标点。
- **动作动词词表只收技术词汇**，导致「做个落地页」「优化一下」「帮我看看」全部判 0 分 ——
  而评分恰恰是为这类粗糙 draft 准备的。已扩充词表并加回归测试。
- **数量词识别漏了 `≥ ≤ ＞ ＜ ％`**，全角比较符写的量化要求拿不到分。
- **验收标准句子取第一处命中**，会挑到无关句子。改为挑最可验证的那句。
- **README 分数过期**：原写 30/100（旧算法），换尺后实测 12/100，已更正。
- **检查器假阳性两处**：把注释里的 `@deepseek-ai` 当违规；基于工作区文件判 CRLF（实际由
  `core.autocrlf` 导致，git 里是 LF）。均已修正并加正对照。

### 更正（重要）

竞品调研推翻了本项目此前三处自我认知，README 与作品集页面已同步收紧：

1. **「首创交互式澄清」不成立** —— `yaoshuo530/dsh-prompt-enhancer` 2026-08-28 已实现澄清卡片。
2. **「首创可编程 prompt 服务」也不成立** —— `seven282/oss-prompt-optimizer` 已有
   `ctx.promptOptimizer` + `prompt_optimize`；`SongMiao-tech` 同样暴露服务。
3. **「五维评分」不是独特名目** —— `Y1X1n` 自称五维诊断，`xueccci` 有评分弹窗。

真正立得住的差异点是：评分**规则式确定性可进 CI**、**公开评测集可复跑**、
**抗刷分与证据回溯由测试锁死**。

### 测试

`npm test` **181 条全绿**。关键不变量均用**注入破坏**验证过（改坏后测试确实变红），
而不是"跑一遍绿的就算数"。

## [0.3.1] - 2026-10-17

这一版是**隐私与可控性**的补丁。

### 新增

- **编译可中断**：点「✨ 编译」后，加载卡新增「**取消编译**」按钮。
  临时反悔、或想改 draft 重来时，不必被锁在「正在编译…」里干等 ——
  点它立刻回到输入框，**草稿一个字都不丢**。
  - 实现：`rpc()` 接上 `AbortController`；取消时 abort 在途请求 +
    `requestSeq++` 让在途回调失效 + 立即退出 busy。
  - 用户主动取消是**安静收场**，不会弹「编译失败」错误卡。
  - 诚实边界：掐断的是**客户端等待**。宿主那次调用可能仍在后台跑完
    （编译无副作用，最坏只是白花一次算力），UI 不会被它的晚到结果打扰。

### 修复

- **卡片不再透出背景会话正文**：`.pc-card` 直接吃 `var(--dsw-alias-bg-overlay)`，
  而该 token 在本主题下**带 alpha**（fallback 写的是不透明的 `#fff`，极易误以为安全），
  遮罩又只有 35% ⇒ 背景里的会话正文透过卡片**清晰可读**。这既是可读性问题，
  也让界面截图无法公开发布。修：遮罩压到 55% + 卡片加 `backdrop-filter` 模糊
  （不硬编码颜色，保住暗色主题）。
- **设置页不再回显本机用户名**：原先把宿主回传的绝对路径原样贴出来
  （`C:\Users\<用户名>\.dsh\...`），截图公开即泄露。新增 `prettyPath()`
  缩成 `~\.dsh\...`；认不出路径形状时**原样返回**，不编造。

### 工程

- 测试 96 → **97**；新增两条回归用例（卡片不透明 / 路径不含用户名）与
  一条中断链路用例（busy 卡必须有中断入口 + 点它必须真的 abort + 取消后不报错），
  均已做对照实验确认在修复前会失败。
- 测试沙箱补上 `AbortController` —— 原先没提供，会让中断链路在单测里
  **静默退化成不可取消**而测试照样绿。
- 全部公开截图重裁：去掉顶部会话标题条、模型/额度徽章，设置页另起裁切避开
  左侧应用栏（余额/积分）；新增「模板卡」与「取消编译」两张配图。

## [0.3.0] - 2026-10-15

### 新增

- **模板编译层**（`ctx.promptCompiler.render` / `listTemplates`）：与 LLM 编译**并列**的第二条路径。
  `compile(draft)` 让 LLM 把粗糙草稿改写成 prompt（不确定、需推理）；
  `render(templateId, vars)` 用模板**确定性**渲染（同输入同输出、零模型成本）——
  适合"按固定维度评一遍"这类要求可复现的任务。
  - **刻意不重载 `compile`**：它已被工具 / 三个路由 / README / 作品集消费，重载会破。
- **零依赖模板引擎**（`lib/templates.js`）：`{{var}}` / 点路径 / `{{#each}}` / `{{#if}}` / `\{{` 转义；
  `defaults ← vars` 深合并；必填与类型校验；模板注册时**静态审计**引用的变量是否有出处。
  之所以手写而不是引入 zod + handlebars：本插件的卖点之一是零运行时依赖（`dependencies` 为空）。
- **三个内置模板**（category 均为 `review`）：
  - `portfolio-review` —— 作品集 / 个人主页评审。四个视角、10 个评估维度、
    按招聘方真实浏览节奏（5 秒 / 30 秒 / 2 分钟）分析，输出 9 段带 P0–P2 优先级的整改清单，
    含"无法访问网址时严禁编造"的兜底。
  - `code-review` —— 代码审查。6 维度（正确性 / 边界与异常 / 安全 / 性能 / 可维护性 / 测试）、
    6 段输出、阻断 / 严重 / 建议三级，含"不要把风格偏好伪装成缺陷"的约束。
  - `prompt-review` —— Prompt 评审。0–100 评分 + 缺失要素 / 歧义点 / 改写对照 / 可复制补强段。
  - ⚠️ **命名诚实**：本项目**不**把这两个模板叫 CLARITY / PRECISE。查证（`gh api` 列该仓库
    `frameworks/`）后确认 `dreamor/prompt-optimizer-skill` 里**没有**这两个框架（它有
    CRISPE / RACEF / RISEN / RTF / TAG 等 60+ 个），公开来源也查不到——真实存在的是
    **CLEAR**。凭空宣称出处是诚信问题，故改为自研并如实标注。
- **工具 `prompt_template`**：不传 `template` 先列出可用模板，传了就渲染；
  渲染失败回结构化错误 JSON，让模型能自我修正而不是被异常打断。
- **HTTP 路由** `/api/templates`、`/api/render`。
- **client 半的模板 UI**：composer 工具栏新增「📋 模板」入口（与「✨ 编译」**并列**）。
  选模板 → 填变量 → 渲染 → 「采用并回填」（仅回填，不发送）。
  变量表单由模板的 `variables` schema **自动生成**（string / string[] / object 下钻），
  所以以后新增模板完全不用改 `client.js`。
  空值不上传、交给模板 `defaults` 补齐；结果里标明「本次未调用模型」。

### 说明

- 🔴 **两种"未定义"的语义刻意不同**：输出位 `{{x}}` 缺变量**直接报错**
  （静默渲染成空是最难发现的一类失败）；条件位 `{{#if x}}` 缺变量按"假"处理
  （这本来就是"有才渲染"的惯用法，否则可选变量根本没法写）。
  首版把两者都当错误，导致只给必填变量时**整个模板渲染失败**——
  这条边界现在有专门的用例钉住。
- 用户给的原始设计里，Handlebars 模板引用了 `{{role}}` / `{{task}}` / `{{#dimensions}}`，
  但这三个变量在变量表里都没定义。已全部补进 `defaults`（10 个维度做成默认值，
  正好兑现"加维度只改配置、不改模板"）；引擎侧也加了静态审计 + 输出位报错双重兜底。
- 测试从 43 增至 **94**，新增 `tests/{templates,builtin-templates,index}.test.js`。
  其中 `tests/index.test.js` 是 host 半**首次**有测试覆盖（用 stub ctx 真实执行 `apply`，
  覆盖工具注册、路由 200/400/404、1MB 限长、非法 JSON）；
  `tests/client.test.js` 新增模板 UI 的三条端到端结构用例，
  其中一条专门钉住「**用户代码里的 `{{...}}` 不得被二次解析**」——
  否则用户提交的 Vue / Jinja 模板代码会被当成模板变量吃掉或误报未定义。

### 已验证

- 重启宿主后实测：`/api/templates` → 200、`/api/render` 正常输入 → 200、缺必填 → **400 + 可读原因**；
  `prompt_template` 工具可直接调用。（负对照：改动前这两个路由是 404。）

## [0.2.1] - 2026-10-14

**纯文档版本 —— 代码零改动。** 之所以要单独发一个版本，是因为 npm 的**版本不可变**：
0.2.0 发布时带的是旧 README，之后重写的文档只进了 GitHub，npm 页面上仍是旧版。
本版把 README / CHANGELOG 同步到 npm。

### 文档

- 重写 README：卖点前置、npm/CI/license badges、真实 before-after 对照
  （同一个 draft 诊断 30 分 → 编译后约束与验收标准显式化）、
  可编程层的 `analyze` / `elicit` / `compile` 真实签名示例、
  「诚实披露」一节（不宣称首创交互式澄清、`elicit` 走规则是设计选择、Claude Code 侧未实现）、
  5 条关键踩坑。
- 新增实机截图 `docs/assets/compile-result.png`（编译结果 + 模型徽章 + 自动假设）
  与 `docs/assets/settings-page.png`（设置页）。
- 新增本文件，并加入 `package.json` 的 `files`，确保随包发布。

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

[0.3.1]: https://github.com/Jav1es/dsh-prompt-compiler/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/Jav1es/dsh-prompt-compiler/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/Jav1es/dsh-prompt-compiler/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/Jav1es/dsh-prompt-compiler/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Jav1es/dsh-prompt-compiler/releases/tag/v0.1.0
