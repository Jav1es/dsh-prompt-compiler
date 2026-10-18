'use strict'

// F1：五维评分 —— 规则式、可解释、可复现。
//
// 为什么要重做（而不是沿用 service.js 里那个 score）：
//   原来的评分是「长度基础分(≤40) + 三要素各 +20」，三条硬规则、四个大台阶。
//   它有两个致命缺陷：
//     ① **不可解释**：只给一个数字，说不出哪一分丢在哪、丢给哪句话。
//     ② **可被廉价刷分**：堆长度就能拿 40 分基础分；只要出现「目标/格式」等词就 +20，
//        写「目标是不知道，格式随便」也能满分——这正是"假评分"。
//   README 要拿 F1 当卖点（Before/After 对比），就必须经得起这种反问。
//
// 本模块的设计原则：
//   **规则式（确定性）** —— 同一输入恒得同一分数，零成本、可进 CI、可复现。不调 LLM。
//   **可解释** —— 每一维给出 `reasons`（哪里扣分）+ `evidence`（扣分对应原文片段），
//                 用户能自己复核"这分扣得对不对"。
//   **抗刷分** —— 证据必须落在**有实质内容**的句子上，而不是无关词频或总长度（见下）。
//   **诚实的边界** —— 规则只看得见"形态"（有没有验收标准、有没有量化边界），
//                 看不见"语义质量"（验收标准写得对不对）。这一点写进 summary，不吹成模型级评审。
//
// 五维（各 20 分，总分 100）：
//   1. goal        目标清晰度    —— 说清"要做什么、为谁、产出什么"
//   2. context     上下文完整性  —— 提供背景、输入材料、领域/受众信息
//   3. constraint  约束明确性    —— 有可执行的边界（数量/范围/格式/禁止项/默认值）
//   4. acceptance  验证标准      —— 有"怎么算做对了"的可核验标准
//   5. ambiguity   歧义控制      —— 少模糊表述，多量化与消歧收口（**反向计分**）
//
// 🔴 反向维（ambiguity）的注意点：它衡量"没有歧义"，所以**越短的空 draft 越容易满分**。
//   故用 `substantive`（有实质内容的字符数）做系数：没内容就没有"歧义控制"可言。

// 零依赖：不 require 任何外部包（本插件的卖点之一是零运行时依赖）。

const DIMS = ['goal', 'context', 'constraint', 'acceptance', 'ambiguity']

const DIM_LABELS = {
  goal: '目标清晰度',
  context: '上下文完整性',
  constraint: '约束明确性',
  acceptance: '验证标准',
  ambiguity: '歧义控制',
}

// 结构行：markdown 标题 / 列表符号开头（「## Task」「- Constraints」）。
// 这类行承载的是**段名**，不是内容 —— 全部计数会造成"只有骨架也拿 23 分"。
// ⚠️ 刻意**不**把 `<task>` 这类 XML 标签当标题行：claude 风格产出的正文常紧跟在标签后面，
//    一律剔除会把真实内容也剔掉（正对照：`<task>抓取 A 站新闻</task>` 必须能评上目标分）。
const HEADING_LINE = /^\s{0,3}#{1,6}\s|^\s{0,3}[-*+]\s+[A-Za-z\u4e00-\u9fa5][\w\s]{0,20}$/

// ------------------------------------------------------------------ 词表
// 中英文兼顾。注意：这些是**线索**不是判据 —— 单独命中只给线索分，
// 证据分必须落在实质句子上。

const GOAL_CUES = [
  '目标', '目的', '任务是', '帮我做', '帮我写', '帮我改', '帮我分析', '生成', '产出', '输出',
  '写一个', '做一个', '实现', '实现一个', '重构', '审查', '评审', '总结', '翻译',
  'goal', 'objective', 'task', 'build', 'implement', 'analyze', 'review',
]
// 动作动词：draft 里没有"目标"字样但有一句"抓取 X 到 Y"，也是明确目标
//
// 🔴 2026-10-17 由评测集 F3 发现并修复的**假阴性**：
//   原词表只有「抓取/爬取/生成/编写/修复…」这类技术动词，导致真实用户最常写的中文口语指令
//   ——「做个落地页」「这个 SQL 太慢了，优化一下」「程序报错了，帮我看看」「写个命令…」
//   「帮我优化下简历」——**全部被判 0 分**（连目标维线索分都拿不到）。
//   这是最不能接受的误伤：评分的落点就是这类粗糙 draft，判 0 等于告诉用户"你什么都没说"。
//   ⇒ 补入中文高频动词。注意**只补动词，不补名词**，否则「## Task」式骨架也可能蹭到分
//     （骨架仍被 contentSentences 闸门拦在 0，见下方抗刷分逻辑与 tests）。
const ACTION_VERBS = [
  '抓取', '爬取', '提取', '生成', '编写', '修复', '迁移', '部署', '整理', '转换', '校验',
  '生成', '改写', '评估', '对比', '排查', '解析', '导出', '提交', '上传', '下载',
  // 中文口语高频动词（评测集补入）
  '做', '写', '改', '画', '设计', '实现', '优化', '重构', '检查', '审查', '看看', '看下',
  '分析', '总结', '整理', '翻译', '解释', '说明', '推荐', '规划', '制定', '搭建', '测试',
  '调试', '接入', '清理', '统计', '监控', '建模', '评审', '润色', '压缩', '拆分', '补',
  'fetch', 'scrape', 'parse', 'fix', 'refactor', 'migrate', 'deploy', 'export', 'convert', 'validate',
  'build', 'create', 'write', 'design', 'optimi', 'review', 'analyze', 'check', 'debug', 'draft', 'summarize',
]
const AUDIENCE_CUES = ['面向', '给', '使用者', '读者', '用户是', '受众', 'for ', 'audience', 'reader']

const CONTEXT_CUES = [
  '背景', '现状', '目前', '当前', '已有', '已有项目', '技术栈', '框架', '版本',
  '输入', '给定', '附件', '材料', '数据', '代码', '文件', '样例', '示例',
  '场景', '业务', '原因', '因为',
  'background', 'context', 'currently', 'existing', 'input', 'given', 'sample', 'example', 'because',
]

const CONSTRAINT_CUES = [
  '约束', '限制', '要求', '必须', '不要', '禁止', '只能', '不允许', '不超过', '至少', '最多',
  '必须', '约束', 'constraint', 'requirement', 'must', 'shall', 'do not', "don't", 'only', 'no more than',
]
const PROHIBITION_CUES = ['不要', '禁止', '不允许', '避免', '禁用', 'do not', "don't", 'never', 'avoid', 'forbidden']
const QUANTIFY_PATTERNS = [
  /\d+\s*(?:ms|s|秒|分钟|小时|天|次|条|个|行|字|字符|MB|KB|GB|px|%|％|℃|元|人)/i,
  /\b\d+\s*(?:requests?|req\/s|rps|qps|times?|items?|lines?|words?|chars?|MB|KB|GB)\b/i,
  // 🔴 2026-10-17 由评测集 F3 发现：符号集合只收了 >= / <= / > / <，
  //   漏了 Unicode 比较符 ≥ ≤ 与全角 ＞ ＜ —— 而「覆盖率 ≥ 90%」是**最常见**的验收写法之一，
  //   漏掉会把可核验标准误判成"较主观"。全角百分号 ％ 同理。
  /(?:至少|最多|不超过|不少于|不大于|不低于|>=|<=|≥|≤|＞|＜|>|<)\s*\d+/,
  /\b\d{1,3}(?:\.\d+)?\b/,
]

const FORMAT_WORDS = [
  '输出格式', '格式', '返回', 'json', 'yaml', 'csv', 'markdown', '表格', '列表', '代码块',
  'output format', 'format', 'return', 'schema', 'as json', 'as csv',
]

const ACCEPTANCE_CUES = [
  '验收', '验收标准', '完成标准', '算做对', '成功标准', '通过标准', '合格',
  '通过', '测试', '单测', '断言', '覆盖率', '不得报错', '零错误', '可核验',
  'acceptance', 'done when', 'definition of done', 'criteria', 'pass', 'verify', 'verified',
  'assert', 'coverage', 'test',
]
// "可核验"的第二形态：一句带量化断言的条件句（"封面不超 5 秒即算通过"）
const CHECKABLE_SENTENCE = /(?:如果|若|当|一旦|只要|除非).{2,}|(?:算|视为|即算|就算)(?:做对|通过|完成|合格|成功)/

const VAGUE_WORDS = [
  '等等', '之类', '一些', '某种', '相关', '差不多', '尽快', '合适', '合理', '适当', '尽量',
  '最好', '大概', '可能', '看情况', '再说', '什么的', '随便',
  'etc', 'some', 'various', 'appropriate', 'reasonable', 'as needed', 'if possible', 'roughly',
]
// 空话/不可执行表述：写了也不构成"约束"（"要写得清晰"不是约束）
const EMPTY_PHRASES = ['清晰', '明确', '清楚', '可读性', '友好', '优雅', '简洁', '高效', '高质量', '良好']

// ------------------------------------------------------------------ 工具

function lower(s) { return s.toLowerCase() }

/**
 * 分句：中英文句读都切，保留原文片段用于证据展示。
 *
 * ⚠️ 不能简单地按 `.` 切 —— 英文句点在本项目的实际语料里大量出现在**非句末**位置：
 *   `news.example.com`（域名）、`robots.txt`（文件名）、`v1.2.3`（版本）、`3.14`（小数）。
 * 一律按点切会把一句话碎成「目标：抓取 news.」「example.」「com 首页新闻标题。」，
 * 后果是：(a) 证据引用成半截，用户无法复核；(b) 句子变短，可能跌破"实质陈述"阈值而误判。
 * ⇒ 只有「点 + 空白/结尾」才算句末；点后紧跟字母数字的保留在同一句里。
 */
function splitSentences(text) {
  return String(text)
    // 中文全角句读 / 换行：无条件切
    .split(/(?<=[。！？；])\s*|\n+/)
    .flatMap(part => part.split(/(?<=[.!?;])(?=\s|$)/))
    .map(s => s.trim())
    .filter(Boolean)
}

/** 有实质内容的字符数：排除全空白、纯标题行、纯列表符号。 */
function substantiveText(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n')
  let out = ''
  for (const line of lines) {
    if (HEADING_LINE.test(line)) continue      // 标题行不算内容（防止"## Task\n## Constraints"刷分）
    out += line + '\n'
  }
  return out.replace(/[\s\-*•·>|]/g, '')       // 去掉空白与常见标点占位
}

/**
 * 内容有效性闸门（抗刷分核心）。
 *
 * 两件事：
 *   ① `isSubstantiveSentence` —— 单句是否有实质陈述（非标题、≥6 实质字符）
 *   ② `contentSentences` —— 整段是否**真的写了内容**。纯骨架（只有四个段名）不算。
 *
 * 🔴 为什么需要 ②：实测发现 "## Task / ## Constraints / ## Output Format / ## Acceptance Criteria"
 *   这样**只有段名、零正文**的输入，因为段名里含 Goal/Format/Acceptance 等线索词，
 *   能拿到 23/100 —— 一个空壳 prompt 得 23 分是硬伤，会直接毁掉 F1 的可信度。
 *   ⇒ 没有任何一条实质性句子时，各维的证据分一律不给。
 */
function isSubstantiveSentence(s) {
  if (HEADING_LINE.test(s)) return false
  return substantiveText(s).length >= 6
}

function contentSentences(sentences) {
  return sentences.filter(isSubstantiveSentence)
}

function hasCue(text, cues) {
  const low = lower(text)
  return cues.some(c => low.includes(lower(c)))
}

function findQuantifications(text) {
  const found = []
  for (const re of QUANTIFY_PATTERNS) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')
    let m
    while ((m = g.exec(text)) !== null) {
      found.push(m[0])
      if (found.length > 20) return found
    }
  }
  return found
}

function findVagueWords(text) {
  const low = lower(text)
  return VAGUE_WORDS.filter(w => low.includes(lower(w)))
}

/** 截取证据片段：优先整句，过长则截断（保留可复核的原文，不编造）。 */
function snippet(s, max) {
  const limit = max || 48
  const t = String(s).trim()
  return t.length <= limit ? t : t.slice(0, limit) + '…'
}

/**
 * 某句是否"有实质内容的陈述"：至少 6 个非空白字符，且不是纯标题。
 * 这是抗刷分的核心闸门 —— 证据必须落在这里。（实现见下方 substantive 区块）
 */

/** 把某维的分数按「线索分 / 证据分」两段记，便于解释。 */
function makeDim(key, parts) {
  let score = 0
  const reasons = []
  for (const p of parts) {
    score += p.points
    if (p.text) reasons.push({ text: p.text, points: p.points, evidence: p.evidence || null })
  }
  score = Math.max(0, Math.min(20, Math.round(score)))
  return { key, label: DIM_LABELS[key], score, max: 20, reasons }
}

// ------------------------------------------------------------------ 各维评估

function evalGoal(text, sentences) {
  const parts = []
  const content = contentSentences(sentences)
  const cueHit = hasCue(text, GOAL_CUES) || hasCue(text, ACTION_VERBS)
  if (cueHit) parts.push({ points: 6, text: '出现了目标/动作线索' })
  else parts.push({ points: 0, text: '找不到"要做什么"的线索（无目标词，也无动作动词）' })

  // 证据分：必须有一句实质陈述里同时含有线索/动词（无正文时一律不给）
  const goalSentence = content.find(s =>
    hasCue(s, GOAL_CUES) || hasCue(s, ACTION_VERBS))
  if (goalSentence) parts.push({ points: 6, text: '有一句实质陈述说清了要做什么', evidence: snippet(goalSentence) })
  else parts.push({ points: 0, text: content.length ? '没有一句实质陈述承接目标（只有词、没有句）' : '没有任何正文句子（只有段名/骨架）' })

  // 是否需要交代"为谁"：有受众线索 或 陈述足够具体（含具体对象）
  if (hasCue(text, AUDIENCE_CUES)) parts.push({ points: 4, text: '交代了受众/面向对象' })
  else if (goalSentence && findQuantifications(goalSentence).length > 0) parts.push({ points: 4, text: '目标句含具体对象（虽未点明受众）' })
  else parts.push({ points: 0, text: '未说明产出给谁用' })

  // 产出物形态：目标里点出了交付物（文件/接口/报告/脚本）
  const DELIVERABLE = ['脚本', '文件', '报告', '页面', '接口', '函数', '文档', '表格', 'JSON', 'csv', 'script', 'file', 'report', 'page', 'api', 'function', 'doc']
  if (hasCue(text, DELIVERABLE)) parts.push({ points: 4, text: '指出了交付物形态' })
  else if (hasCue(text, FORMAT_WORDS)) parts.push({ points: 4, text: '指出了输出格式（可作为交付形态）' })
  else parts.push({ points: 0, text: '未说明产出长什么样（文件/接口/报告…）' })

  return makeDim('goal', parts)
}

function evalContext(text, sentences) {
  const parts = []
  const content = contentSentences(sentences)
  if (hasCue(text, CONTEXT_CUES)) parts.push({ points: 8, text: '提供了背景/输入材料信息' })
  else parts.push({ points: 0, text: '没有交代背景或已有材料（模型只能凭空猜）' })

  const ctxSentence = content.find(s => hasCue(s, CONTEXT_CUES))
  if (ctxSentence) parts.push({ points: 6, text: '背景落在具体句子里', evidence: snippet(ctxSentence) })
  else parts.push({ points: 0, text: content.length ? '背景信息没有成句（只出现关键词）' : '没有任何正文句子（只有段名/骨架）' })

  // 输入的具体性：有数字/路径/版本/代码标识即算具体输入
  const concrete = findQuantifications(text).length > 0
    || /[A-Za-z]:\\|\/[\w.-]+\/|`[^`]+`|\.(?:js|ts|py|json|yml|yaml|md|txt|css|html)\b/i.test(text)
  if (concrete) parts.push({ points: 6, text: '给出了具体材料（数字/路径/版本/代码标识）' })
  else parts.push({ points: 0, text: '材料停留在抽象描述，没有具体参数/路径/样例' })

  return makeDim('context', parts)
}

function evalConstraint(text, sentences) {
  const parts = []
  const content = contentSentences(sentences)
  const cueHit = hasCue(text, CONSTRAINT_CUES) || hasCue(text, FORMAT_WORDS)
  if (cueHit) parts.push({ points: 5, text: '出现了约束/格式类线索' })
  else parts.push({ points: 0, text: '没有出现任何约束或格式要求' })

  // 量化边界：约束必须是**可执行的具体值**，不是"要清晰"这类空话。
  // 只在正文里找 —— 段名里的 "Output Format" 不是量化边界。
  const contentText = content.join('\n')
  const quants = findQuantifications(contentText)
  if (quants.length > 0) {
    parts.push({ points: 9, text: `含 ${quants.length} 处量化边界`, evidence: quants.slice(0, 4).join(' / ') })
  } else {
    const emptyHit = EMPTY_PHRASES.filter(w => contentText.includes(w))
    parts.push({
      points: 0,
      text: !content.length
        ? '没有任何正文句子（只有段名/骨架）'
        : emptyHit.length
          ? `只有空话式要求（${emptyHit.join('、')}），不可执行`
          : '没有量化边界（数量/范围/时限/格式都没写死）',
    })
  }

  // 禁止项 / 兜底默认：这两类最能约束模型"自由发挥"
  const prohib = PROHIBITION_CUES.some(c => lower(contentText).includes(lower(c)))
  const fallback = /若未指定|未指定则|默认|否则|fallback|by default/i.test(contentText)
  if (prohib || fallback) {
    parts.push({ points: 6, text: prohib ? '写明了禁止项' : '写了默认兜底策略' })
  } else {
    parts.push({ points: 0, text: '没写禁止项，也没写"未指定时默认如何"' })
  }

  return makeDim('constraint', parts)
}

function evalAcceptance(text, sentences) {
  const parts = []
  const content = contentSentences(sentences)
  const contentText = content.join('\n')
  const checkable = content.find(s => CHECKABLE_SENTENCE.test(s))
  // 线索分只在**有正文**时给：纯骨架里的 "Acceptance Criteria" 是段名，不是验收标准
  if (content.length && hasCue(contentText, ACCEPTANCE_CUES)) {
    parts.push({ points: 8, text: '提到验收/合格/测试類标准' })
  } else if (checkable) {
    parts.push({ points: 8, text: '有"满足条件即算做对"的判定句', evidence: snippet(checkable) })
  } else {
    parts.push({ points: 0, text: content.length ? '没有"怎么算做对了"的标准' : '没有任何正文句子（只有段名/骨架）' })
  }

  // 选"验收句"：不能只取首个命中 —— 「给这个函数写点单元测试。…acceptance：覆盖率 ≥ 90%」
  // 里第一句只是陈述任务，真正的验收标准在后面。取首个会把可核验的句子丢掉，
  // 误判成"较主观"（评测集 F3 实测踩到）。
  // ⇒ 在全部候选里挑**可核验性最强**的一句（有量化 > 无量化），同分时取靠后的
  //   （中文习惯把结论/标准写在后面）。
  const accCandidates = content.filter(s => hasCue(s, ACCEPTANCE_CUES))
  const scoreAcc = s => (findQuantifications(s).length > 0 ? 2 : 0) + (CHECKABLE_SENTENCE.test(s) ? 1 : 0)
  const accSentence = accCandidates.length
    ? accCandidates.reduce((best, s) => (scoreAcc(s) >= scoreAcc(best) ? s : best), accCandidates[0])
    : undefined
  if (accSentence) parts.push({ points: 8, text: '验收标准有具体句子承载', evidence: snippet(accSentence) })
  else if (checkable) parts.push({ points: 8, text: '判定条件已写明', evidence: snippet(checkable) })
  else parts.push({ points: 0, text: '验收标准没有落到句子上' })

  // 可核验性：验收句里含数字或可观测结果，才叫"可核验"
  const checkableEvidence = (accSentence || checkable || '')
  if (checkableEvidence && (findQuantifications(checkableEvidence).length > 0
    || /不得|不允许|必须|全部|每条|每一个|零|no\s/i.test(checkableEvidence))) {
    parts.push({ points: 4, text: '验收标准可核验（含数字或可观测结果）' })
  } else if (checkableEvidence) {
    parts.push({ points: 2, text: '验收标准较主观（缺数字/可观测结果）' })
  } else {
    parts.push({ points: 0, text: '无验收标准可核验' })
  }

  return makeDim('acceptance', parts)
}

function evalAmbiguity(text, sentences) {
  // 反向计分：满分 20 = 完全无歧义。扣分项 = 模糊词 + 长句缠绕 + 反问/待定。
  const parts = []
  const vague = findVagueWords(text)
  if (vague.length === 0) {
    parts.push({ points: 8, text: '没有模糊表述（"等等/尽量/合适"类）' })
  } else {
    // 每个模糊词扣 2 分，最多扣 8
    const deduct = Math.min(8, vague.length * 2)
    parts.push({
      points: 8 - deduct,
      text: `含 ${vague.length} 处模糊表述：${vague.join('、')}`,
      evidence: snippet(sentences.find(s => vague.some(w => lower(s).includes(lower(w)))) || ''),
    })
  }

  // 消歧线索：有"若未指定则默认…"这类收口，说明作者主动处理了歧义
  const closure = /若未指定|未指定则|默认|否则|即视为|按以下解释/i.test(text)
  parts.push({ points: closure ? 7 : 0, text: closure ? '对未指定项给了默认收口' : '对可多重解读之处没有收口' })

  // 未决问题：draft 自己带着问号/待定，说明还没想清楚 → 扣分
  const unresolved = /待定|待确认|看情况|再说|不确定|tbd|to be decided/i.test(text)
  parts.push({ points: unresolved ? 0 : 5, text: unresolved ? '自述"待定/不确定"，意图未收敛' : '未见未决项' })

  const dim = makeDim('ambiguity', parts)
  // 空内容保护：按**实质正文**（含段名）判断是否"有东西可评估"。
  //   ⚠️ 这里必须用 substantiveText（不剔除段名）而不是 contentSentences：
  //      否则 `## Task\n## Constraints\n…` 这种纯骨架会因为"没歧义"白拿 20 分。
  //   阈值取 20 字符 —— 实测「目标：生成一份报告。约束：不超过 3 页。」(≈20 字)
  //   是一份很短的合法 draft，不应被判为"无从评估"（否则规则式评测集里的短样本会被一刀切）。
  const sub = substantiveText(text).length
  if (sub < 20) {
    dim.score = 0
    dim.reasons = [{ text: '内容过短（实质字符 < 20），无从评估歧义控制', points: -dim.score, evidence: null }]
  }
  return dim
}

// ------------------------------------------------------------------ 主入口

/**
 * 对一段文本做五维评分（**确定性**，同输入恒同分）。
 *
 * @param {string} text 待评分文本（可以是原始 draft，也可以是编译后的 prompt）
 * @returns {{total:number, dims:object, summary:string, note:string, inputLength:number}}
 */
function scoreText(text) {
  const t = typeof text === 'string' ? text : ''
  const sentences = splitSentences(t)

  const dims = {
    goal: evalGoal(t, sentences),
    context: evalContext(t, sentences),
    constraint: evalConstraint(t, sentences),
    acceptance: evalAcceptance(t, sentences),
    ambiguity: evalAmbiguity(t, sentences),
  }

  const total = DIMS.reduce((sum, k) => sum + dims[k].score, 0)
  // 空壳保护：没有任何实质正文（只有段名/空白）时总分归零 ——
  // 否则 "## Task / ## Constraints / …" 这种骨架会拿到 20 分以上，直接毁掉评分可信度。
  const hasContent = contentSentences(sentences).length > 0
  const total2 = hasContent ? total : 0

  return {
    total: total2,
    dims: hasContent ? dims : zeroDims(dims),
    summary: hasContent ? summarize(total2, dims) : '总分 0/100；没有任何实质正文（只有段名或空白）',
    note: '规则式评分：只看"形态"（有没有验收标准、有没有量化边界），看不到"语义质量"（验收标准写得对不对）。可复现、零成本，不调 LLM。',
    inputLength: t.length,
  }
}

function zeroDims(dims) {
  const out = {}
  for (const k of DIMS) {
    out[k] = {
      ...dims[k],
      score: 0,
      reasons: [...dims[k].reasons, { text: '空壳输入：无实质正文，本维不计分', points: 0, evidence: null }],
    }
  }
  return out
}

/**
 * Before/After 对比。
 *
 * ⚠️ 必须同一口径、同一评分函数 —— 否则"提升"来自尺子松动，而不是文本变好。
 * 这里两段文本走**同一个 scoreText**，delta 为逐维差值之和。
 *
 * @param {string} before 原始 draft
 * @param {string} after  编译后的 prompt
 */
function compareTexts(before, after) {
  const b = scoreText(before)
  const a = scoreText(after)
  const perDim = {}
  for (const k of DIMS) {
    perDim[k] = { label: DIM_LABELS[k], before: b.dims[k].score, after: a.dims[k].score, delta: a.dims[k].score - b.dims[k].score }
  }
  return {
    before: b,
    after: a,
    delta: a.total - b.total,
    perDim,
  }
}

function summarize(total, dims) {
  const weak = DIMS.filter(k => dims[k].score <= 8).map(k => DIM_LABELS[k])
  const strong = DIMS.filter(k => dims[k].score >= 16).map(k => DIM_LABELS[k])
  const head = `总分 ${total}/100`
  const parts = []
  if (strong.length) parts.push(`强项：${strong.join('、')}`)
  if (weak.length) parts.push(`短板：${weak.join('、')}`)
  return parts.length ? `${head}；${parts.join('；')}` : head
}

module.exports = {
  DIMS,
  DIM_LABELS,
  scoreText,
  compareTexts,
  // 供测试与评测集复用的内部工具（非稳定 API，外部消费者请只用 scoreText/compareTexts）
  __internals: { splitSentences, substantiveText, findVagueWords, findQuantifications, isSubstantiveSentence },
}
