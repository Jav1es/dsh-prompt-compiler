# 评测报告（规则式基线）

> **快照**：2026-10-17T15:05:40.034Z　**模式**：rules-only (deterministic; no LLM)
> 本文件由 `npm run eval` 的实跑结果人工整理，**所有数字可在本机复跑验证**。
> 复跑：`npm run eval`（约 1 秒，零模型调用、零费用）。

## 1. 结论先行

| 指标 | 数值 |
|---|---|
| 样本数（正向 / 负向） | 12 / 4 |
| 原始 draft 平均分 | **17.2**（区间 12–38） |
| 补全信息后平均分 | **81.5**（平均 **+64.3**） |
| 期望改进维度命中率 | **100%** |
| 负向样本是否全部 0 分 | **是** |
| 规则式 compile 真实路径 | 17.2 → 70.8（平均 **+53.7**，全部走降级） |

## 2. 逐条明细（澄清前 / 澄清后）

| id | 类型 | 原文 | 澄清前 | 澄清后 | 增益 | 期望改进维度 |
|---|---|---|---|---|---|---|
| `crawler-vague` | 后端/自动化 | 帮我写个爬虫… | 12 | 69 | **+57** | goal, constraint, acceptance |
| `crawler-mid` | 后端/自动化 | 目标：帮我写个爬虫抓新闻，输出 JSON。… | 34 | 87 | **+53** | context, constraint, acceptance |
| `landing-page` | 前端 | 做个落地页，好看点，参考苹果那种… | 12 | 87 | **+75** | goal, context, constraint, acceptance |
| `code-review` | 工程实践 | 帮我 review 一下这段代码… | 26 | 87 | **+61** | goal, context, acceptance |
| `meeting-summary` | 办公 | 帮我把这个会议纪要总结一下… | 12 | 69 | **+57** | goal, constraint, acceptance |
| `sql-opt` | 数据 | 这个 SQL 太慢了，优化一下… | 12 | 85 | **+73** | context, constraint, acceptance |
| `ppt-outline` | 办公 | 帮我写个 PPT 大纲… | 12 | 78 | **+66** | goal, context, acceptance |
| `unit-test` | 工程实践 | 给这个函数写点单元测试… | 38 | 87 | **+49** | goal, context, acceptance |
| `translation` | 内容 | 把这段英文翻译成中文… | 12 | 70 | **+58** | context, constraint, acceptance |
| `bug-report` | 工程实践 | 程序报错了，帮我看看… | 12 | 91 | **+79** | context, goal, acceptance |
| `shell-command` | 后端/自动化 | 写个命令把日志里报错的行找出来… | 12 | 87 | **+75** | constraint, acceptance, context |
| `resume-polish` | 办公 | 帮我优化下简历… | 12 | 81 | **+69** | goal, context, constraint, acceptance |

## 3. 规则式 compile 真实路径（不接 LLM）

这一栏是**插件在完全没有 LLM 时**的真实表现，最接近"用户不配模型也能用"的下限。

| id | 编译前 | 编译后 | 增益 |
|---|---|---|---|
| `crawler-vague` | 12 | 72 | **+60** |
| `crawler-mid` | 34 | 54 | **+20** |
| `landing-page` | 12 | 72 | **+60** |
| `code-review` | 26 | 72 | **+46** |
| `meeting-summary` | 12 | 72 | **+60** |
| `sql-opt` | 12 | 72 | **+60** |
| `ppt-outline` | 12 | 72 | **+60** |
| `unit-test` | 38 | 76 | **+38** |
| `translation` | 12 | 72 | **+60** |
| `bug-report` | 12 | 72 | **+60** |
| `shell-command` | 12 | 72 | **+60** |
| `resume-polish` | 12 | 72 | **+60** |

> ⚠️ 这一栏曾经出过事故：`crawler-mid` 编译后 **34 → 32（−2）**。
> 根因是降级路径自己写的话被自己扣分 —— `Constraints` 段填了「明确、可执行、无歧义」
> （听着像约束、实际没约束），假设句里写了「合理范围内」（"合理"是模糊词，歧义维如实扣 2 分）。
> 已修复：缺口**显式写成缺口**，假设句不用模糊词。修完后最小增益 **+20**，无一条为负。
> 回归测试：`tests/eval.test.js` 的底线⑤ / ⑤b（已用回滚注入验证会变红）。

## 4. 负向样本（抗刷分）

| id | 得分 | 期望 | 通过 |
|---|---|---|---|
| `empty` | 0 | 0 | ✅ |
| `whitespace` | 0 | 0 | ✅ |
| `heading-shell` | 0 | 0 | ✅ |
| `heading-shell-md` | 0 | 0 | ✅ |

这些样本专门用来证明评分器**不能被刷分**：光写段名、堆长度、堆敬语，一律 0 分。

## 5. 两档不混算（纪律）

| 档 | 是否确定性 | 能否进 CI | 能否进 Before/After | 用途 |
|---|---|---|---|---|
| **规则式（本报告）** | ✅ 同一输入恒得同分 | ✅ | ✅ | 基线、对外数字、回归门禁 |
| LLM 档（可选） | ❌ 每次可能不同 | ❌ | ❌ | 更贴近人判断的主观参考 |

所以：**对外只引用本报告的数字**。LLM 档即使跑出更漂亮的数，也不并入、不引用 ——
会漂移的数字不能当结论。
