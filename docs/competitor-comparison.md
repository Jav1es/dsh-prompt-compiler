# H4 · DSH Prompt 类插件横向对比（≥20 个）

> **数据快照：2026-10-17**（`gh api repos/<owner>/<repo>` 逐个实取，23 个仓库全部返 200，无失败项）
> **核实纪律**：本表所有 star / 创建日期 / 最后推送时间均为**本次现场查询**，不是引用几天前的调研笔记。
>   对照：`docs/` 下旧笔记的快照是 2026-10-13，4 天内多个仓库的 star 已变（WestFox 114→123、
>   yi-yezhiqiu 51→98、Fishsb 90→97），**沿用旧数字即为错误**。
> **未核实的不写**：本表不收录无法确认存在的项目；每行都可点开核验。

---

## 1. 对比表（按 star 降序）

`类型` 一列是本表的核心区分维度，定义为：
- **A 一键改写** —— 点一下，LLM 把草稿改写成更好的 prompt 回填
- **B 发送后注入** —— 原话不改，在发送后/接收前把「真正要什么」作为上下文注入
- **C 交互式澄清** —— 先问用户几个问题，再据答案合成
- **D 模板/库/市场** —— 提供模板或提示词市场，不做优化
- **E 可编程服务** —— 暴露 `ctx.xxx` 服务 / 工具供其它插件与 Agent 调用
- **F 评分** —— 对 prompt 质量给出分数
- （非 DSH，仅作参照）

| # | 仓库 | ★ | 创建 | 最后推送 | 语言 | 类型 | 一句话定位 |
|---|------|---|------|---------|------|------|-----------|
| 1 | [WestFox-AwA/dsh-prompt-optimizer](https://github.com/WestFox-AwA/dsh-prompt-optimizer) | 123 | 2026-09-11 | 2026-10-15 | JS | **B** | 注入式优化器：发送后把「这轮到底要什么」理清再注入给工作 AI，原话不改写、条条带逐字依据 |
| 2 | [yi-yezhiqiu/dsh-prompt-market](https://github.com/yi-yezhiqiu/dsh-prompt-market) | 98 | 2026-10-06 | 2026-10-11 | JS | **D** | 提示词市场：浏览 / 搜索 / 收藏 / 插入输入框 |
| 3 | [Fishsb/dsh-prompt-enhancer](https://github.com/Fishsb/dsh-prompt-enhancer) | 97 | 2026-08-13 | 2026-10-17 | JS | **A** | ✨ 一键增强 + 语音识别 + 服务异常一键重启 |
| 4 | [Jimmy0123-ux/dsh-token-pet](https://github.com/Jimmy0123-ux/dsh-token-pet) | 56 | 2026-09-01 | 2026-09-21 | TS | A（附属） | 双语桌宠 + token 台账，附带可编辑的 Prompt Optimizer |
| 5 | [FeatherHunter/dsh-prompt](https://github.com/FeatherHunter/dsh-prompt) | 43 | 2026-08-16 | 2026-10-17 | JS | **D** | Prompt 工具箱：24 条深度模板 + `/prompt` + 智能推荐 |
| 6 | [ffyfox/dsh-prompt-hardener](https://github.com/ffyfox/dsh-prompt-hardener) | 37 | 2026-09-28 | 2026-10-11 | JS | A（风格化） | 把提示词改写成「硬邦邦」风格 |
| 7 | [DIAG5/dsh-better-input](https://github.com/DIAG5/dsh-better-input) | 26 | 2026-08-20 | 2026-10-09 | JS | A（套件） | 输入增强套件：语音 + 提示词优化 + 文件类型 + 一切转 Markdown |
| 8 | [Y1X1n/dsh-prompt-optimizer](https://github.com/Y1X1n/dsh-prompt-optimizer) | 24 | 2026-08-18 | 2026-10-13 | TS | **A + F** | 发送栏一键「优化」：**五维诊断** + 改写稿 SSE 流式上屏，可替换/复制/撤回 |
| 9 | [seven282/oss-prompt-optimizer](https://github.com/seven282/oss-prompt-optimizer) | 20 | 2026-08-16 | 2026-10-10 | TS | **A + E** | 工具 `prompt_optimize` + 服务 `ctx.promptOptimizer` + ✨ 按钮 + 三种 outputStyle + best-of-N + 评测闭环 |
| 10 | [zhang-jiazhi/dsh-prompt-optimizer](https://github.com/zhang-jiazhi/dsh-prompt-optimizer) | 7 | 2026-08-30 | 2026-09-23 | JS | A（移植） | 移植 `linshenkx/prompt-optimizer`（上游 38,335 ★，非 DSH） |
| 11 | [JoukoPuro/dsh-prompt-polish](https://github.com/JoukoPuro/dsh-prompt-polish) | 6 | 2026-08-14 | 2026-08-14 | JS | A（多风格） | ✨ 图标按钮，4 种打磨风格 + i18n |
| 12 | [benrong2048-boop/dsh-prompt-polish](https://github.com/benrong2048-boop/dsh-prompt-polish) | 5 | 2026-09-30 | 2026-10-17 | JS | A | ✨ 一键流式改写 + 版本链 + 本地历史 + token 可见 |
| 13 | [wuchubuzai2018/dsh-ai-prompt-optimizer](https://github.com/wuchubuzai2018/dsh-ai-prompt-optimizer) | 5 | 2026-08-15 | 2026-08-16 | JS | A | 把粗略想法整理成更清晰完整的提示词 |
| 14 | [winditer/dsh-prompt-optimizer](https://github.com/winditer/dsh-prompt-optimizer) | 5 | 2026-08-17 | 2026-09-07 | TS | A | 无描述 |
| 15 | [yaoshuo530/dsh-prompt-enhancer](https://github.com/yaoshuo530/dsh-prompt-enhancer) | 5 | 2026-08-28 | 2026-08-28 | JS | **C** | ✨ Enhance + **澄清卡片**（已核验 README 原文） |
| 16 | [xueccci/dsh-prompt-lab](https://github.com/xueccci/dsh-prompt-lab) | 3 | 2026-09-22 | 2026-10-16 | JS | **C + F** | Agent 结构化优化器：三模式 + 四引擎 + **评分弹窗 + 继续优化** |
| 17 | [1321928757/dsh-prompt-polish](https://github.com/1321928757/dsh-prompt-polish) | 3 | 2026-08-17 | 2026-10-16 | JS | A（多策略） | 6 种策略 × 3 种语言 + 确认弹窗 + 最近 5 次历史 |
| 18 | [kee0012/dsh-prompt-optimizer](https://github.com/kee0012/dsh-prompt-optimizer) | 2 | 2026-09-06 | 2026-10-13 | JS | A | 输入框工具栏一键 ✨（可还原），设置收纳进 ▾ 弹出层 |
| 19 | [Areium/dsh-better-prompt](https://github.com/Areium/dsh-better-prompt) | 2 | 2026-09-09 | 2026-09-10 | JS | A（skill 驱动） | LLM 改写草稿回填，优化方向存为可编辑 skill |
| 20 | [peterliucius/dsh-prompt-optimize](https://github.com/peterliucius/dsh-prompt-optimize) | 1 | 2026-08-17 | 2026-08-17 | TS | A | 辅助 LLM 改写草稿，只替换草稿、绝不发送 |
| 21 | [SongMiao-tech/dsh-prompt-optimizer](https://github.com/SongMiao-tech/dsh-prompt-optimizer) | 1 | 2026-08-15 | 2026-08-15 | TS | **A + E** | monorepo，`ctx.promptOptimizer` 服务 + UI 包 |
| 22 | [subisle/dsh-prompt-optimizer](https://github.com/subisle/dsh-prompt-optimizer) | 0 | 2026-10-11 | 2026-10-13 | TS | A | 一键、会话上下文感知、`purpose:'compaction'` 零副作用 |
| — | [linshenkx/prompt-optimizer](https://github.com/linshenkx/prompt-optimizer) | 38,335 | 2025-02-12 | 2026-10-13 | TS | 非 DSH | Web 版 prompt 优化器，`zhang-jiazhi` 的上游 |
| — | **dsh-prompt-compiler（本项目）** | — | — | — | JS | **C + E + F** | 见下节 |

> 注：无任何仓库处于 `archived` 状态（本次逐个核验）。

---

## 2. 本项目在其中处于什么位置（**不夸大**）

| 能力 | 本品 | 已有竞品 |
|---|---|---|
| 一键改写 | ✅ | **绝大多数**（A 类 18 个） |
| **交互式澄清** | ✅ | ⚠️ **已有 2 个**：`yaoshuo530`（澄清卡片）、`xueccci`（评分弹窗+继续优化） |
| **五维评分** | ✅ 规则式、确定性、可复现 | ⚠️ `Y1X1n` 称"五维诊断"、`xueccci`/`seven282` 有评分/评测 |
| **可编程服务** | ✅ `ctx.promptCompiler` + `prompt_compile` / `prompt_template` 双工具 | ⚠️ **已有 2 个**：`seven282`（`ctx.promptOptimizer` + `prompt_optimize`）、`SongMiao-tech`（`ctx.promptOptimizer`） |
| **模板确定性渲染** | ✅ 零 LLM、可复现 | ⚠️ `FeatherHunter`（24 条模板）、`yi-yezhiqiu`（市场） |
| 评测集（可复现数字） | ✅ 12 条真实 draft + 4 负向，`npm run eval` | 未见公开同类 |

**必须承认的三点**（对外文档不得越过这条线）：

1. **"首创交互式澄清"不成立** —— `yaoshuo530/dsh-prompt-enhancer` 早在 2026-08-28 就实现了「模型判断是否需要澄清 → 弹澄清卡片 → 结构化问题」。本项目晚于它。
2. **"首创可编程 prompt 服务"也不成立** —— `seven282/oss-prompt-optimizer`（20 ★）已有 `ctx.promptOptimizer` + `prompt_optimize` 工具，`SongMiao-tech` 同样有服务。
3. **"五维评分"这一名目也不独特** —— `Y1X1n` 明确写"五维诊断"，`xueccci` 有评分弹窗。

**本项目真正的差异点（证据支撑，不说空话）**：

- **评分是规则式、确定性的，可进 CI** —— 竞品的评分依赖 LLM 调用，每次结果会漂移；本项目 `lib/scoring.js` 零依赖零模型，同一输入恒得同分（`tests/scoring.test.js` 有确定性断言，`npm run eval` 有连跑两次比对的测试）。
- **有公开评测集与可复现数字** —— 12 条真实 draft 从平均 17.2 分提升到 81.5 分，负向空壳恒 0 分；未见其它竞品公开类似口径。
- **双向防线做得实** —— 抗刷分（空壳必须 0 分）、证据可回溯（每处扣分指出原文片段），这两点在本项目是**测试锁死**的，不只是宣传语。

---

## 3. 生态规模：不要引用单一数字

| 口径 | 数字 | 可信度 |
|---|---|---|
| GitHub topic `dsh-plugin` | 约 1.9 万仓库 | 机械可复现，但**含大量蹭标签项目** ⇒ 只能当上限 |
| `0xsline/awesome-deepseek-harness` CATALOG.md（实测去重） | 1,727 个唯一仓库 | 人工策展，可逐条核验 ⇒ 可当下限 |
| 第三方 SEO 站声称（`dsh.so` 等） | 1.6 万+ | **口径未公开，不采信**（项目纪律：SEO 站不入证据链） |

**对外口径**：不给单一总量。若必须有量级感，写「GitHub `dsh-plugin` 标签下约 1.9 万个仓库（含蹭标签），人工策展目录收录量级为 10³」。

---

## 4. 数据可复现方法

```bash
gh api repos/<owner>/<repo> \
  --jq '"\(.full_name)|\(.stargazers_count)|\(.created_at)|\(.pushed_at)|\(.archived)|\(.language)"'
```

1. 逐条执行（表内每一行都可复现）；
2. 任何一条返回非 200 即视为**不存在**，不得写入表格；
3. 本表**必须**在引用前重新跑一遍 —— star 数在 4 天内已发生明显变动（见开头对照）。
