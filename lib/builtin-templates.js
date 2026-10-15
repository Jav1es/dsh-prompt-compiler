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

/** 所有内置模板。新增模板往这里加即可。 */
const BUILTIN_TEMPLATES = [portfolioReview]

module.exports = { BUILTIN_TEMPLATES, portfolioReview }
