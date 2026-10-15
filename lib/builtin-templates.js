'use strict'

// 内置模板数据 —— **纯数据，无逻辑**。
//
// 与引擎分离的原因：引擎一次写好就不再动，模板则是"会不断新增/调整"的东西。
// 加一个模板 = 往这个数组里加一个对象，不用碰 lib/templates.js。
//
// 形状（详见 lib/templates.js 的 validateTemplateShape）：
//   { id, version, category: 'review'|'generate'|'transform',
//     title, description, variables, defaults, template }
//
// 🔴 与用户原设计的差异（有意为之，不是遗漏）：
//   原设计里 Handlebars 模板用了 {{role}} / {{task}} / {{#dimensions}}，
//   但 §2 的 variables / defaults 里这三个都没有定义 —— 直接渲染会产出
//   "你是。" 这种缺段结果，且**很难发现**。这里把它们补进 defaults：
//     · role / task  → 固定文案，进 defaults
//     · dimensions   → 10 个评估维度，进 defaults（正好兑现"加维度只改配置、不改模板"）
//   引擎侧也已加了"未定义变量必须报错"的护栏，两边一起兜。

/** 作品集 / 个人主页评审 —— 本项目第一个"评审类模板"。 */
const portfolioReview = {
  id: 'portfolio-review',
  version: '1.0.0',
  category: 'review',
  title: '作品集 / 个人主页评审',
  description:
    '从简历顾问、UIUX 设计、技术招聘、HR 四个视角评审个人主页，' +
    '按 10 个固定维度 + 招聘方真实浏览节奏分析，输出带优先级的可执行整改清单。',

  // —— 调用方需要提供的变量 ——
  variables: {
    properties: {
      siteUrl: { type: 'string', required: true, description: '主页地址' },
      targetRoles: { type: 'string[]', required: true, description: '目标岗位，如 ["AI Agent 开发工程师"]' },
      background: {
        type: 'object',
        description: '个人背景（子项都可选，未给的会在输出里省略）',
        properties: {
          years: { type: 'string', description: '经验年限' },
          projects: { type: 'string', description: '主导项目量级' },
          clients: { type: 'string', description: '服务客户量级' },
          metrics: { type: 'string[]', description: '量化成果，如 ["RAG 93.3% @3"]' },
          openSource: { type: 'string', description: '开源产出' },
        },
      },
      coreSkills: { type: 'string[]', description: '核心能力关键词' },
      deployment: { type: 'string', description: '部署方式' },
    },
  },

  // —— 不给也能跑出完整结构的默认值 ——
  defaults: {
    role: '一位同时具备四种视角的复合评审者：资深作品集顾问、前端/UIUX 设计师、技术招聘官、HR。',
    task: '评估这个主页，给出建议、意见和优化方向。**不要直接重构代码**，也不要输出完整实现——我要的是可执行的整改判断。',
    readerPersonas: ['HR（初筛）', '技术面试官（判断真伪与深度）', '业务负责人（判断能不能解决问题）'],
    browsingMilestones: [
      { time: '5 秒', question: '是否一眼知道我是谁、做什么、为谁解决什么问题？' },
      { time: '30 秒', question: '能否找到 3 个最强项目，并看懂我在其中的具体贡献？' },
      { time: '2 分钟', question: '是否愿意主动联系我？联系路径有多长？' },
    ],
    priorityLevels: ['P0', 'P1', 'P2'],
    dimensions: [
      { name: '首屏定位', description: '第一屏能否在 5 秒内说清"我是谁、做什么、为谁解决什么问题"' },
      { name: '信息架构', description: '分块与导航是否让招聘方按「能力 → 证据 → 联系」顺畅走完，而不是迷路' },
      { name: '项目展示', description: '每个项目是否讲清背景、我的角色、技术选型、量化结果，而不是只堆技术名词' },
      { name: '简历化', description: '是否有时间线、岗位匹配度、可下载简历等"招聘方可直接采信"的要素' },
      { name: '视觉排版', description: '层级、留白、字体与配色是否专业且一致；移动端是否可用' },
      { name: '可信度与差异化', description: '是否有可验证的硬证据（开源仓库、CI 状态、量化指标、真实截图），而非自述' },
      { name: '求职转化', description: '联系入口是否显眼、路径是否最短、是否有明确的行动召唤' },
      { name: 'SEO 与分享', description: '标题 / 描述 / OG 卡片是否让链接被分享时能自证价值' },
      { name: '可访问性', description: '对比度、语义标签、键盘可达性、图片 alt 是否达标' },
      { name: '不同读者视角', description: 'HR / 技术面试官 / 业务负责人 三类读者各自最先看到什么、会在哪里卡住' },
    ],
    outputSections: [
      '总体诊断（一句话结论 + 当前最致命的短板）',
      '亮点（值得保留、不要改掉的部分）',
      '问题清单（逐条标注 P0/P1/P2，并给出修改前后对比建议）',
      '首页从上到下的建议结构（逐屏说明放什么、为什么）',
      '简历化建议（怎么把主页变成招聘方能直接采信的材料）',
      '文案优化示例（挑 3 处最弱的，给出改写前 / 改写后）',
      '视觉与交互优化清单',
      '行动清单（按优先级排序，每项标注预估工作量）',
      '需要我补充的信息（你无法从主页判断、需要我提供的东西）',
    ],
    constraints: [
      '必须结合我提供的背景与量化成果来评，不要给放之四海皆准的泛泛之谈',
      '每条问题都要指出**具体位置**和**具体改法**，不接受"建议优化排版"这种空话',
      '不要直接生成完整代码或整页重写；给结构和改法即可',
      '无法访问该网址时，必须先向我索要截图 / HTML / 内容清单，**严禁编造页面内容**',
    ],
    fallback:
      '如果你无法访问上面的主页（抓取失败、需要登录、或内容为空），请**立即停止评审**，' +
      '明确告诉我"无法访问"，并列出你需要我提供什么（整页截图 / 导出的 HTML / 各区块文案清单）。' +
      '在拿到材料之前，不要对页面内容做任何推测。',
  },

  // —— 渲染成 Markdown prompt ——
  template: `# 角色
你是{{role}}

# 任务
{{task}}

# 我的信息
- 主页：{{siteUrl}}
- 目标岗位：{{targetRoles}}
{{#if coreSkills}}- 核心能力：{{coreSkills}}
{{/if}}{{#if deployment}}- 部署方式：{{deployment}}
{{/if}}{{#if background.years}}- 经验年限：{{background.years}}
{{/if}}{{#if background.projects}}- 主导项目：{{background.projects}}
{{/if}}{{#if background.clients}}- 服务客户：{{background.clients}}
{{/if}}{{#if background.metrics}}- 量化成果：{{background.metrics}}
{{/if}}{{#if background.openSource}}- 开源产出：{{background.openSource}}
{{/if}}
# 请重点评估以下维度
{{#each dimensions}}
{{index}}. **{{name}}** —— {{description}}
{{/each}}
# 请按招聘方的真实浏览节奏走一遍
{{#each browsingMilestones}}
- {{time}}：{{question}}
{{/each}}
# 请分别站在这些读者的立场看
{{#each readerPersonas}}
- {{.}}
{{/each}}
# 输出格式（严格按此结构，逐段给，不要合并或省略）
{{#each outputSections}}
{{index}}. {{.}}
{{/each}}
问题清单请用 {{priorityLevels}} 标注优先级。

# 约束
{{#each constraints}}
- {{.}}
{{/each}}

# 兜底
{{fallback}}`,
}

/** 代码审查 —— 评审类。**自研**，不挂任何外部框架名。 */
const codeReview = {
  id: 'code-review',
  version: '1.0.0',
  category: 'review',
  title: '代码审查',
  description:
    '按 6 个固定维度（正确性 / 边界与异常 / 安全 / 性能 / 可维护性 / 测试）审查一段代码或 diff，' +
    '输出带严重级别（阻断 / 严重 / 建议）的问题清单与片段级改法。',

  variables: {
    properties: {
      code: { type: 'string', required: true, description: '待审查的代码或 diff 原文' },
      language: { type: 'string', description: '语言 / 框架' },
      context: { type: 'string', description: '这段代码要解决什么问题、跑在什么环境' },
      focus: { type: 'string[]', description: '特别关注的方面，如 ["并发安全", "错误处理"]' },
    },
  },

  defaults: {
    role: '一位严格的资深工程师，做过多年 code review。既能发现真 bug，也克制地不把个人风格偏好当成问题。',
    task: '审查下面这段代码，找出**真实存在的问题**并给出可执行的修改建议。不要重写整个文件，不要因为风格偏好而报问题。',
    dimensions: [
      { name: '正确性', description: '逻辑是否真的实现了它声称要做的事；有没有写反、漏分支、错用 API' },
      { name: '边界与异常', description: '空值 / 空集合 / 越界 / 并发 / 超时 / 失败路径是否被处理，而不是只在 happy path 上成立' },
      { name: '安全', description: '注入、越权、密钥泄漏、不受限的资源消耗；本机特有的坑也要指出' },
      { name: '性能', description: '有没有 N+1、无界内存增长、重复计算、不必要的同步等待' },
      { name: '可维护性', description: '命名与结构是否让下一个人看得懂；有没有把复杂度藏起来的隐式耦合' },
      { name: '测试', description: '这段改动有没有可测的边界；现有测试是否覆盖了它的失败路径' },
    ],
    severityLevels: ['阻断', '严重', '建议'],
    outputSections: [
      '总体判断（这段代码能不能合；一句话结论）',
      '必须先修的问题（阻断级：位置 + 问题 + 改法）',
      '应该修的问题（严重级）',
      '可以更好（建议级，**明确标注这是偏好而非缺陷**）',
      '值得肯定的地方（不要只挑刺）',
      '测试建议（该补哪些用例）',
    ],
    constraints: [
      '每条问题必须给出**具体位置**（函数名 / 行号 / 代码片段）和**具体改法**',
      '不要把风格偏好伪装成缺陷——是偏好就明说是偏好',
      '不要输出整份重写后的代码；给片段级修改建议',
      '看不清意图时先问，不要假装看懂了',
    ],
    fallback:
      '如果给出的内容不是代码、或信息不足以判断，直接说明并列出你需要什么' +
      '（完整文件 / 调用方 / 运行环境）。**不要凭猜测编造问题。**',
  },

  template: `# 角色
你是{{role}}

# 任务
{{task}}

# 评审对象
{{#if language}}- 语言 / 框架：{{language}}
{{/if}}{{#if context}}- 背景：{{context}}
{{/if}}{{#if focus}}- 特别关注：{{focus}}
{{/if}}
\`\`\`
{{code}}
\`\`\`

# 请逐项检查
{{#each dimensions}}
{{index}}. **{{name}}** —— {{description}}
{{/each}}
# 输出格式（严格按此结构）
{{#each outputSections}}
{{index}}. {{.}}
{{/each}}
问题请用 {{severityLevels}} 标注严重级别。

# 约束
{{#each constraints}}
- {{.}}
{{/each}}

# 兜底
{{fallback}}`,
}

/** Prompt 评审 —— 评审类。**自研**（不是 CLEAR / CRISPE 等任何外部框架）。 */
const promptReview = {
  id: 'prompt-review',
  version: '1.0.0',
  category: 'review',
  title: 'Prompt 评审',
  description:
    '诊断一段 prompt 缺什么、哪里有歧义，给出 0–100 评分、逐条问题与改写前后对照，' +
    '输出可直接照做的补强清单。',

  variables: {
    properties: {
      draft: { type: 'string', required: true, description: '待评审的 prompt / 指令原文' },
      targetModel: { type: 'string', description: '目标模型，如 Claude / GPT / 本地小模型' },
      useCase: { type: 'string', description: '它会被用在什么场景、由谁调用' },
    },
  },

  defaults: {
    role: '一位严谨的 prompt 工程评审者，关注"这段指令能不能被稳定执行"，而不是文风好不好看。',
    task: '评审下面这段 prompt。指出它作为**可执行指令**的缺陷，并给出改写建议。不要直接替我重写整段——给改法。',
    dimensions: [
      { name: '目标清晰度', description: '是否说清了要产出什么；有没有"帮我看看"这类无法验收的表述' },
      { name: '上下文完整性', description: '执行所需的信息（输入在哪、环境是什么、给谁用）是否齐备' },
      { name: '约束明确性', description: '边界与禁忌是否写明；"尽量""最好"这类软约束会被忽略' },
      { name: '输出格式', description: '交付形态是否指定到可被下游直接消费的程度' },
      { name: '验收标准', description: '有没有判断"做对了"的依据；没有就只能靠感觉' },
      { name: '歧义与过度授权', description: '哪些地方模型可以自行发挥、哪些地方不该让它自由发挥' },
    ],
    outputSections: [
      '总体评分（0–100）与一句话结论',
      '缺失要素（按影响排序，每条说明"不补会怎样"）',
      '歧义点（指出原文哪句话会产生多种理解）',
      '改写建议（挑最关键的 3 处，给"原句 → 改后"对照，不要整段重写）',
      '可直接追加的补强段（约束 / 验收标准 / 输出格式三个可复制片段）',
      '需要我补充的信息',
    ],
    constraints: [
      '必须引用原文的具体句子来指问题，不要泛泛而谈',
      '不要整段重写；给"原句 → 改后"对照',
      '区分"缺陷"与"个人偏好"',
      '不确定我的真实意图时先问，不要替我假设',
    ],
    fallback:
      '如果给出的不是 prompt、或信息不足以判断，直接说明并列出你需要什么。**不要编造原文里没有的内容。**',
  },

  template: `# 角色
你是{{role}}

# 任务
{{task}}

# 评审对象
{{#if targetModel}}- 目标模型：{{targetModel}}
{{/if}}{{#if useCase}}- 使用场景：{{useCase}}
{{/if}}
\`\`\`
{{draft}}
\`\`\`

# 请逐项检查
{{#each dimensions}}
{{index}}. **{{name}}** —— {{description}}
{{/each}}
# 输出格式（严格按此结构）
{{#each outputSections}}
{{index}}. {{.}}
{{/each}}
# 约束
{{#each constraints}}
- {{.}}
{{/each}}

# 兜底
{{fallback}}`,
}

/**
 * 所有内置模板。新增模板往这里加即可。
 *
 * 🔴 命名诚实（2026-10-15）：`NEXT-STEPS.md` 的 F2 曾写"CLARITY（真实存在，
 *    dreamor/prompt-optimizer-skill）、PRECISE（真实存在）"。**这两个都不存在** ——
 *    该仓库 frameworks/ 下 60+ 个框架里没有（CRISPE / RACEF / RISEN / RTF / TAG … 有），
 *    公开来源也查不到（真实存在的是 **CLEAR**，不是 CLARITY）。故本项目不挂这两个名字，
 *    改为自研并如实标注，避免凭空宣称出处。
 */
const BUILTIN_TEMPLATES = [portfolioReview, codeReview, promptReview]

module.exports = { BUILTIN_TEMPLATES, portfolioReview, codeReview, promptReview }
