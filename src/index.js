// expert-bridge — 卡住时向专家模型求助（同步）+ 分档派子代理 + 长尾试错的硬提醒
//
// 设计约束：
//  * 路由、模型、阈值全部来自配置（设置页或 profile patch），代码里不写死任何 provider/model；
//  * guard 永不抛出（抛了会打断工具调用）；
//  * 注入的提醒是 user 消息，必须带「系统提醒·非用户输入」前缀；
//  * 结构校验只查字段在不在，语义（空话）交给专家端的退回规则；
//  * 专家调用期间置 inExpert，避免嵌套调用污染计数节拍；
//  * 低档子代理的「只读」是软约束（工具描述 + 子代理 prompt 前置指令），**不是**强制隔离。
import fs from 'node:fs'
import z from '@deepseek-ai/schemastery'

export const name = 'expert-bridge'
export const inject = ['tools']

const REMINDER_TEXT = '[系统提醒·非用户输入] 本回合你已连续 {n} 次工具调用而没有向用户汇报。先自查是否已满足求助条件（同一症状第 2 次出现 / 曾宣称修好又复现 / 用户说过治标或换过 3 种说法 / 已证伪假设没有新增）。满足就按 CONSULT-TEMPLATE.md 组织求助包后调用 ask_expert；不满足就继续，但别重复同一条路。'

// 低档子代理的只读约束：拼在任务正文之前，靠模型自觉，不是沙箱。
const READ_ONLY_PREAMBLE = [
  '[只读约束] 你是被派来做调研/整理类工作的子代理。',
  '允许：读取文件、搜索内容、查看只读命令的输出。',
  '禁止：创建/修改/删除任何文件，修改配置，执行任何写入型命令（git 提交、包安装、重定向写文件、删除目录等）。',
  '如果结论需要落盘，把完整内容写在最终答复里返回给父代理，由父代理决定怎么写。'
].join('\n')

/** 专家路由：比子代理路由多一段可拼接的系统提示。 */
const ExpertRoute = z.object({
  name: z.string().default(''),
  provider: z.string().default(''),
  model: z.string().default(''),
  reasoningEffort: z.string().default(''),
  tags: z.array(z.string()).default([]),
  note: z.string().default(''),
  systemPrompt: z.string().default('')
})

/** 子代理路由（低/中两档共用同一个形状）。 */
const HelperRoute = z.object({
  name: z.string().default(''),
  provider: z.string().default(''),
  model: z.string().default(''),
  reasoningEffort: z.string().default(''),
  tags: z.array(z.string()).default([]),
  note: z.string().default('')
})

/**
 * 设置命名空间 schema。dsh-settings 只把 .volatile() 叶子交给设置页编辑，
 * 其余字段照旧从 profile patch 读。数组整数组 volatile（官方 allowedModels 同款）：
 * volatile 不能标在数组元素上，也不能嵌套 volatile。
 */
export const Config = z.object({
  experts: z.array(ExpertRoute).default([]).volatile(),
  delegates: z.object({
    low: z.array(HelperRoute).default([]).volatile(),
    medium: z.array(HelperRoute).default([]).volatile()
  }).default({}),
  maxTokens: z.number().default(8000).volatile(),
  timeoutMs: z.number().default(150000).volatile(),
  minPackageChars: z.number().default(600).volatile(),
  systemPromptFile: z.string().default(''),
  usageLog: z.string().default(''),
  debugLog: z.string().default(''),
  reminder: z.object({
    enabled: z.boolean().default(true).volatile(),
    threshold: z.number().default(47).volatile(),
    text: z.string().default(REMINDER_TEXT)
  }).default({})
})

// ── 配置读取 ─────────────────────────────────────────────────────────────────
// volatile 叶子是 cosmokit 引用（{ get() }），且值会随设置页保存而变，
// 所以每次调用都重新读一遍，不在 apply 里缓存。

function isRef(value) {
  return value !== null && typeof value === 'object' && typeof value.get === 'function'
}

function plain(value) {
  if (isRef(value)) return plain(value.get())
  if (Array.isArray(value)) return value.map(plain)
  if (value !== null && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) return value
    const out = {}
    for (const key of Object.keys(value)) out[key] = plain(value[key])
    return out
  }
  return value
}

function positive(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

function text(value, fallback = '') {
  return typeof value === 'string' ? value : fallback
}

function normalizeRoute(raw, withSystemPrompt) {
  const r = raw !== null && typeof raw === 'object' ? raw : {}
  const route = {
    name: text(r.name).trim(),
    provider: text(r.provider).trim(),
    model: text(r.model).trim(),
    reasoningEffort: text(r.reasoningEffort).trim(),
    tags: Array.isArray(r.tags) ? r.tags.map((tag) => String(tag).trim()).filter(Boolean) : [],
    note: text(r.note)
  }
  if (withSystemPrompt) route.systemPrompt = text(r.systemPrompt)
  return route
}

function normalizeRoutes(value, withSystemPrompt) {
  return Array.isArray(value) ? value.map((raw) => normalizeRoute(raw, withSystemPrompt)) : []
}

function readConfig(config) {
  const c = config !== null && typeof config === 'object' ? config : {}
  const delegates = plain(c.delegates) || {}
  const reminder = plain(c.reminder) || {}
  return {
    experts: normalizeRoutes(plain(c.experts), true),
    low: normalizeRoutes(delegates.low, false),
    medium: normalizeRoutes(delegates.medium, false),
    maxTokens: positive(plain(c.maxTokens), 8000),
    timeoutMs: positive(plain(c.timeoutMs), 150000),
    minPackageChars: positive(plain(c.minPackageChars), 600),
    systemPromptFile: text(c.systemPromptFile),
    usageLog: text(c.usageLog),
    debugLog: text(c.debugLog),
    reminder: {
      enabled: reminder.enabled !== false,
      threshold: positive(reminder.threshold, 47),
      text: text(reminder.text) || REMINDER_TEXT
    }
  }
}

function labelOf(route) {
  return route.name ? route.name : route.provider + '/' + route.model
}

/**
 * 按 need 选一条可用路由：need 命中 tags 优先，否则取第一条 provider+model 都非空的路由。
 * 返回 null 表示这一组里没有任何可用路由。
 */
function pickRoute(routes, need) {
  const usable = routes.filter((route) => route.provider && route.model)
  if (usable.length === 0) return null
  const wanted = typeof need === 'string' ? need.trim().toLowerCase() : ''
  if (wanted) {
    const hit = usable.find((route) => route.tags.some((tag) => tag.toLowerCase() === wanted))
    if (hit !== undefined) return { route: hit, matched: true }
  }
  return { route: usable[0], matched: false }
}

// ── 文件记账 ─────────────────────────────────────────────────────────────────

function readText(file) {
  try { return file ? fs.readFileSync(file, 'utf8') : '' } catch { return '' }
}

function appendLine(file, line) {
  if (!file) return
  try { fs.appendFileSync(file, line + '\n') } catch {}
}

function appendJson(file, value) {
  if (!file) return
  try {
    fs.mkdirSync(file.replace(/[\\/][^\\/]+$/, ''), { recursive: true })
    fs.appendFileSync(file, JSON.stringify(value) + '\n')
  } catch {}
}

/** 执行者自己的路由：只用于记账与「自己就是专家时跳过」。 */
function routeOf(agent) {
  try {
    const header = agent && agent.session && typeof agent.session.requestHeader === 'function'
      ? agent.session.requestHeader() : undefined
    const cfg = header && header.config
    if (cfg && typeof cfg.provider === 'string' && typeof cfg.model === 'string') {
      return { provider: cfg.provider, model: cfg.model }
    }
  } catch {}
  return { provider: '', model: '' }
}

export function apply(ctx, config = {}) {
  let inExpert = false
  let seq = 0
  // bucket：每个 agent 一个稳定序号，避免把对象地址当作身份
  const buckets = new WeakMap()
  const bucketOf = (agent) => {
    let bucket = buckets.get(agent)
    if (!bucket) {
      seq += 1
      bucket = { id: seq, count: 0 }
      buckets.set(agent, bucket)
    }
    return bucket
  }
  const service = (key) => (typeof ctx.get === 'function' ? ctx.get(key) : undefined)

  // ── 长尾提醒 ──────────────────────────────────────────────────────────────
  ctx.tools.guard((exec) => {
    try {
      if (!exec || !exec.agent) return undefined
      const live = readConfig(config)
      const bucket = bucketOf(exec.agent)
      if (inExpert) {
        appendLine(live.debugLog, 'tool=' + exec.name + ' bucket=' + bucket.id + ' inExpert=1 skipped')
        return undefined
      }
      bucket.count += 1
      appendLine(live.debugLog, 'tool=' + exec.name + ' count=' + bucket.count + ' bucket=' + bucket.id + ' inExpert=0')
      if (live.reminder.enabled && bucket.count % live.reminder.threshold === 0) {
        exec.agent.inject({
          id: 'expert-bridge-reminder-' + Date.now(),
          role: 'user',
          content: [{ type: 'text', text: String(live.reminder.text).replace('{n}', String(bucket.count)) }],
          source: { kind: 'expert-bridge-reminder' }
        })
        appendLine(live.debugLog, 'reminder injected at count=' + bucket.count + ' bucket=' + bucket.id)
      }
    } catch (error) {
      try { appendLine(readConfig(config).debugLog, 'guard-ERR ' + (error && error.message ? error.message : error)) } catch {}
    }
    return undefined
  })

  ctx.on('agent/pre-step', (payload, next) => {
    try {
      if (payload && payload.agent && payload.step === 1) {
        const bucket = bucketOf(payload.agent)
        bucket.count = 0
        appendLine(readConfig(config).debugLog, 'turn-reset bucket=' + bucket.id)
      }
    } catch {}
    return next()
  })

  // ── ask_expert ────────────────────────────────────────────────────────────
  ctx.tools.register({
    name: 'ask_expert',
    description: [
      '把一份按模板写好的求助包交给专家模型，同步返回纯文本建议。',
      '专家看不到你的文件、不能调用工具，只能读你粘贴的内容；调用前必须先读 CONSULT-TEMPLATE.md 并填写，缺项会被直接拒绝。',
      '只用于「事实我都拿得到但解释不了」的方向性问题；缺事实时先去取证，不要问。',
      '可选 need 参数用来在专家列表里按标签挑一个（例如 need:"架构"）；不填就用列表里第一个可用的专家。'
    ].join(''),
    parameters: {
      type: 'object',
      required: ['package'],
      properties: {
        package: { type: 'string', title: 'package', description: '按 CONSULT-TEMPLATE.md 填写的完整求助包全文（第几次 / 根治定义 / 已证伪假设≥2条 / 一个问题）。' },
        need: { type: 'string', title: 'need', description: '可选：按标签选择专家（大小写不敏感，匹配专家配置里的 tags）。' }
      }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['answer', 'expert', 'truncated', 'matched', 'need'],
        properties: {
          answer: { type: 'string' },
          expert: { type: 'string' },
          truncated: { type: 'boolean' },
          matched: { type: 'boolean' },
          need: { type: 'string' },
          inputTokens: { type: 'number' },
          outputTokens: { type: 'number' }
        }
      },
      render: (_args, value) => [{ type: 'text', text: String(value && value.answer ? value.answer : '') }]
    },
    async execute(args, exec) {
      const raw = args && typeof args === 'object'
        ? (typeof args.package === 'string' ? args.package
          : typeof args.text === 'string' ? args.text
          : typeof args.content === 'string' ? args.content
          : typeof args.brief === 'string' ? args.brief
          : typeof args.prompt === 'string' ? args.prompt : '')
        : (typeof args === 'string' ? args : '')
      const pkg = raw
      const live = readConfig(config)
      const missing = []
      if (pkg.length < live.minPackageChars) missing.push('求助包太短（< ' + live.minPackageChars + ' 字符）')
      if (!/第\s*几次/.test(pkg)) missing.push('缺「第几次」')
      if (!/根治|验收/.test(pkg)) missing.push('缺「根治定义」')
      if (!/已证伪|已试|假设/.test(pkg)) missing.push('缺「已试/已证伪假设」')
      if (!/问题/.test(pkg)) missing.push('缺「一个问题」')
      if (missing.length) throw new Error('ask_expert 拒绝执行（参数名应为 package，收到 ' + (raw ? '字符串 ' + raw.length + ' 字' : '空') + '）：' + missing.join('；') + '。先读 CONSULT-TEMPLATE.md 补全再调。')

      const need = args && typeof args === 'object' && typeof args.need === 'string' ? args.need : ''
      const picked = pickRoute(live.experts, need)
      if (picked === null) {
        throw new Error('ask_expert 不可用：还没有配置任何可用的专家 —— 打开「设置 → 专家桥（expert-bridge）→ 专家列表」加一条（provider 与 model 必填），或在 profile 的 expert-bridge 行里写 config.experts。')
      }
      const expert = picked.route
      const expertLabel = labelOf(expert)
      const llm = service('llm')
      if (!llm) throw new Error('ask_expert 不可用：llm 服务未绑定')

      const me = routeOf(exec && exec.agent)
      if (me.provider === expert.provider && me.model === expert.model) {
        return { answer: '（跳过）你当前就在用专家模型，自己判断即可。', expert: expertLabel, truncated: false, matched: picked.matched, need }
      }

      const systemParts = []
      const globalPrompt = readText(live.systemPromptFile)
      if (globalPrompt) systemParts.push(globalPrompt)
      if (expert.systemPrompt) systemParts.push(expert.systemPrompt)
      const system = systemParts.join('\n\n')

      const options = {
        provider: expert.provider,
        model: expert.model,
        messages: [{ role: 'user', content: [{ type: 'text', text: pkg }] }],
        maxTokens: live.maxTokens
      }
      if (system) options.system = system
      if (expert.reasoningEffort) options.reasoningEffort = expert.reasoningEffort

      const controller = new AbortController()
      const timer = setTimeout(() => { try { controller.abort(new Error('expert-bridge timeout')) } catch {} }, live.timeoutMs)
      const started = Date.now()
      let answer = ''
      let usage = null
      let finish = null
      inExpert = true
      try {
        for await (const chunk of llm.stream({ ...options, signal: controller.signal })) {
          if (!chunk) continue
          if (chunk.type === 'text-delta' && typeof chunk.text === 'string') answer += chunk.text
          else if (chunk.type === 'usage') usage = chunk.usage
          else if (chunk.type === 'finish') finish = chunk
        }
      } finally {
        inExpert = false
        clearTimeout(timer)
      }
      const reason = finish && finish.reason ? String(finish.reason) : 'unknown'
      if (reason === 'error' || reason === 'aborted') throw new Error('ask_expert 调用失败：' + reason)
      if (!answer.trim()) throw new Error('ask_expert：专家没有产出任何文本')

      appendJson(live.usageLog, {
        ts: new Date().toISOString(),
        executor: me.provider + '/' + me.model,
        expert: expert.provider + '/' + expert.model,
        expertName: expert.name || '',
        need,
        matched: picked.matched,
        packageChars: pkg.length,
        answerChars: answer.length,
        inputTokens: usage && usage.inputTokens,
        outputTokens: usage && usage.outputTokens,
        finish: reason,
        ms: Date.now() - started
      })

      return {
        answer,
        expert: expertLabel,
        truncated: reason === 'max-tokens',
        matched: picked.matched,
        need,
        ...(usage && typeof usage.inputTokens === 'number' ? { inputTokens: usage.inputTokens } : {}),
        ...(usage && typeof usage.outputTokens === 'number' ? { outputTokens: usage.outputTokens } : {})
      }
    }
  })

  // ── delegate ──────────────────────────────────────────────────────────────
  ctx.tools.register({
    name: 'delegate',
    description: [
      '把一件独立的活派给子代理，立即返回子会话 id，完成后宿主会把结果通知回你。',
      'tier:"low" = 便宜模型，做搜索/阅读/整理类杂活；**只读软约束**（工具描述与子代理 prompt 都要求它不写文件，但不是强制隔离，重要改动自己复核）。',
      'tier:"medium" = 能力接近主力的模型，可以读写文件，适合中等规模、边界清楚、能一次讲完的子任务。',
      '可选 need 参数按标签在这档的模型列表里挑一个。子代理看不到你当前会话的历史，任务要写全。'
    ].join(''),
    parameters: {
      type: 'object',
      required: ['tier', 'task'],
      properties: {
        tier: { type: 'string', enum: ['low', 'medium'], title: 'tier', description: '子代理档位：low（只读软约束、便宜）/ medium（可读写、能力接近主力）。' },
        task: { type: 'string', title: 'task', description: '完整任务描述。子代理没有你的上下文，写清目标、边界、要交付什么、怎么算做完。' },
        need: { type: 'string', title: 'need', description: '可选：按标签选择这一档的模型（大小写不敏感，匹配模型配置里的 tags）。' },
        description: { type: 'string', title: 'description', description: '可选：3-5 个词的短标签，显示在子代理列表里。' }
      }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'subagentId', 'tier', 'provider', 'model'],
        properties: {
          kind: { type: 'string' },
          subagentId: { type: 'string' },
          tier: { type: 'string' },
          provider: { type: 'string' },
          model: { type: 'string' }
        }
      },
      render: (_args, value) => [{
        type: 'text',
        text: 'started ' + value.tier + ' subagent ' + value.subagentId + ' (' + value.provider + '/' + value.model + ')'
      }]
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const tier = args && typeof args === 'object' ? String(args.tier || '').trim().toLowerCase() : ''
      if (tier !== 'low' && tier !== 'medium') {
        throw new Error('delegate 拒绝执行：tier 只接受 "low" | "medium"（收到 ' + JSON.stringify(args && args.tier) + '）')
      }
      const task = args && typeof args === 'object' && typeof args.task === 'string' ? args.task : ''
      if (!task.trim()) throw new Error('delegate 拒绝执行：task 不能为空')

      const live = readConfig(config)
      const need = typeof args.need === 'string' ? args.need : ''
      const picked = pickRoute(tier === 'low' ? live.low : live.medium, need)
      if (picked === null) {
        throw new Error('delegate 不可用：' + tier + ' 档还没有配置可用的模型 —— 打开「设置 → 专家桥（expert-bridge）」，在「' + (tier === 'low' ? '低档子代理' : '中档子代理') + '」里加一条（provider 与 model 必填）。')
      }
      const route = picked.route

      if (!(exec && exec.agent)) {
        throw new Error('delegate 拒绝执行：拿不到调用方 agent（exec.agent 为空），无法建立父子关系')
      }
      const subagents = service('subagents')
      if (!subagents || typeof subagents.startActivation !== 'function') {
        throw new Error('delegate 不可用：subagents 服务未就绪（宿主没有挂载 dsh-subagent）')
      }
      const signal = exec && exec.signal ? exec.signal : new AbortController().signal
      if (typeof signal.throwIfAborted === 'function') signal.throwIfAborted()

      const body = tier === 'low' ? READ_ONLY_PREAMBLE + '\n\n' + task : task
      const label = typeof args.description === 'string' && args.description.trim()
        ? args.description.trim()
        : tier + ' delegate'
      const agentOptions = { provider: route.provider, model: route.model }
      if (route.reasoningEffort) agentOptions.reasoningEffort = route.reasoningEffort

      const activation = await subagents.startActivation({
        provider: 'spawn',
        label,
        request: {
          prompt: [{ type: 'text', text: body }],
          parent: exec.agent,
          agentOptions
        },
        signal,
        delivery: 'parent'
      })

      return {
        kind: 'activation',
        subagentId: activation.childId,
        tier,
        provider: route.provider,
        model: route.model
      }
    }
  })
}
