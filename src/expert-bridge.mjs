// expert-bridge — 卡住时向专家模型求助（同步）+ 长尾试错的硬提醒
//
// 设计约束：
//  * 专家路由、模型、阈值全部来自配置，代码里不写死任何 provider/model；
//  * guard 永不抛出（抛了会打断工具调用）；
//  * 注入的提醒是 user 消息，必须带「系统提醒·非用户输入」前缀；
//  * 结构校验只查字段在不在，语义（空话）交给专家端的退回规则；
//  * 专家调用期间置 inExpert，避免嵌套调用污染计数节拍。
import fs from 'node:fs'

export const name = 'expert-bridge'
export const inject = ['tools']

const DEFAULTS = {
  expert: { provider: '', model: '', reasoningEffort: '' },
  maxTokens: 8000,
  timeoutMs: 150000,
  minPackageChars: 600,
  systemPromptFile: '',
  usageLog: '',
  debugLog: '',
  reminder: {
    enabled: true,
    threshold: 47,
    text: '[系统提醒·非用户输入] 本回合你已连续 {n} 次工具调用而没有向用户汇报。先自查是否已满足求助条件（同一症状第 2 次出现 / 曾宣称修好又复现 / 用户说过治标或换过 3 种说法 / 已证伪假设没有新增）。满足就按 CONSULT-TEMPLATE.md 组织求助包后调用 ask_expert；不满足就继续，但别重复同一条路。'
  }
}

function n(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

function pick(config) {
  const c = config || {}
  return {
    expert: { ...DEFAULTS.expert, ...(c.expert || {}) },
    maxTokens: n(c.maxTokens, DEFAULTS.maxTokens),
    timeoutMs: n(c.timeoutMs, DEFAULTS.timeoutMs),
    minPackageChars: n(c.minPackageChars, DEFAULTS.minPackageChars),
    systemPromptFile: typeof c.systemPromptFile === 'string' ? c.systemPromptFile : '',
    usageLog: typeof c.usageLog === 'string' ? c.usageLog : '',
    debugLog: typeof c.debugLog === 'string' ? c.debugLog : '',
    reminder: { ...DEFAULTS.reminder, ...(c.reminder || {}) }
  }
}

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
  const cfg = pick(config)
  let systemPrompt = readText(cfg.systemPromptFile)
  let llm = null
  let inExpert = false
  let seq = 0

  if (typeof ctx.inject === 'function') {
    ctx.inject(['llm'], (llmCtx) => {
      llm = llmCtx && typeof llmCtx === 'object'
        ? (llmCtx.llm !== undefined ? llmCtx.llm : (typeof llmCtx.get === 'function' ? llmCtx.get('llm') : undefined))
        : undefined
    })
  }

  // bucket：每个 agent 一个稳定序号，避免把对象地址当作身份
  const buckets = new WeakMap()
  const bucketOf = (agent) => {
    let b = buckets.get(agent)
    if (!b) { seq += 1; b = { id: seq, count: 0 }; buckets.set(agent, b) }
    return b
  }

  ctx.tools.guard((exec) => {
    try {
      if (!exec || !exec.agent) return undefined
      const b = bucketOf(exec.agent)
      if (inExpert) {
        appendLine(cfg.debugLog, 'tool=' + exec.name + ' bucket=' + b.id + ' inExpert=1 skipped')
        return undefined
      }
      b.count += 1
      appendLine(cfg.debugLog, 'tool=' + exec.name + ' count=' + b.count + ' bucket=' + b.id + ' inExpert=0')
      if (cfg.reminder.enabled && b.count % cfg.reminder.threshold === 0) {
        exec.agent.inject({
          id: 'expert-bridge-reminder-' + Date.now(),
          role: 'user',
          content: [{ type: 'text', text: String(cfg.reminder.text).replace('{n}', String(b.count)) }],
          source: { kind: 'expert-bridge-reminder' }
        })
        appendLine(cfg.debugLog, 'reminder injected at count=' + b.count + ' bucket=' + b.id)
      }
    } catch (error) {
      appendLine(cfg.debugLog, 'guard-ERR ' + (error && error.message ? error.message : error))
    }
    return undefined
  })

  ctx.on('agent/pre-step', (payload, next) => {
    try {
      if (payload && payload.agent && payload.step === 1) {
        const b = bucketOf(payload.agent)
        b.count = 0
        appendLine(cfg.debugLog, 'turn-reset bucket=' + b.id)
      }
    } catch {}
    return next()
  })

  ctx.tools.register({
    name: 'ask_expert',
    description: [
      '把一份按模板写好的求助包交给专家模型，同步返回纯文本建议。',
      '专家看不到你的文件、不能调用工具，只能读你粘贴的内容；调用前必须先读 CONSULT-TEMPLATE.md 并填写，缺项会被直接拒绝。',
      '只用于「事实我都拿得到但解释不了」的方向性问题；缺事实时先去取证，不要问。'
    ].join(''),
    parameters: {
      type: 'object',
      required: ['package'],
      properties: {
        package: { type: 'string', title: 'package', description: '按 CONSULT-TEMPLATE.md 填写的完整求助包全文（第几次 / 根治定义 / 已证伪假设≥2条 / 一个问题）。' }
      }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['answer', 'expert', 'truncated'],
        properties: {
          answer: { type: 'string' },
          expert: { type: 'string' },
          truncated: { type: 'boolean' },
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
      const missing = []
      if (pkg.length < cfg.minPackageChars) missing.push('求助包太短（< ' + cfg.minPackageChars + ' 字符）')
      if (!/第\s*几次/.test(pkg)) missing.push('缺「第几次」')
      if (!/根治|验收/.test(pkg)) missing.push('缺「根治定义」')
      if (!/已证伪|已试|假设/.test(pkg)) missing.push('缺「已试/已证伪假设」')
      if (!/问题/.test(pkg)) missing.push('缺「一个问题」')
      if (missing.length) throw new Error('ask_expert 拒绝执行（参数名应为 package，收到 ' + (raw ? '字符串 ' + raw.length + ' 字' : '空') + '）：' + missing.join('；') + '。先读 CONSULT-TEMPLATE.md 补全再调。')
      if (!llm) throw new Error('ask_expert 不可用：llm 服务未绑定')
      if (!cfg.expert.provider || !cfg.expert.model) {
        throw new Error('ask_expert 不可用：未配置 expert.provider / expert.model（在 profile 的 expert-bridge 行里填）')
      }
      if (!systemPrompt) systemPrompt = readText(cfg.systemPromptFile)
      const me = routeOf(exec && exec.agent)
      if (me.provider === cfg.expert.provider && me.model === cfg.expert.model) {
        return { answer: '（跳过）你当前就在用专家模型，自己判断即可。', expert: cfg.expert.provider + '/' + cfg.expert.model, truncated: false }
      }

      const options = {
        provider: cfg.expert.provider,
        model: cfg.expert.model,
        messages: [{ role: 'user', content: [{ type: 'text', text: pkg }] }],
        maxTokens: cfg.maxTokens
      }
      if (systemPrompt) options.system = systemPrompt
      if (cfg.expert.reasoningEffort) options.reasoningEffort = cfg.expert.reasoningEffort

      const controller = new AbortController()
      const timer = setTimeout(() => { try { controller.abort(new Error('expert-bridge timeout')) } catch {} }, cfg.timeoutMs)
      const started = Date.now()
      let text = ''
      let usage = null
      let finish = null
      inExpert = true
      try {
        for await (const chunk of llm.stream({ ...options, signal: controller.signal })) {
          if (!chunk) continue
          if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
          else if (chunk.type === 'usage') usage = chunk.usage
          else if (chunk.type === 'finish') finish = chunk
        }
      } finally {
        inExpert = false
        clearTimeout(timer)
      }
      const reason = finish && finish.reason ? String(finish.reason) : 'unknown'
      if (reason === 'error' || reason === 'aborted') throw new Error('ask_expert 调用失败：' + reason)
      if (!text.trim()) throw new Error('ask_expert：专家没有产出任何文本')

      appendJson(cfg.usageLog, {
        ts: new Date().toISOString(),
        executor: me.provider + '/' + me.model,
        expert: cfg.expert.provider + '/' + cfg.expert.model,
        packageChars: pkg.length,
        answerChars: text.length,
        inputTokens: usage && usage.inputTokens,
        outputTokens: usage && usage.outputTokens,
        finish: reason,
        ms: Date.now() - started
      })

      return {
        answer: text,
        expert: cfg.expert.provider + '/' + cfg.expert.model,
        truncated: reason === 'max-tokens',
        ...(usage && typeof usage.inputTokens === 'number' ? { inputTokens: usage.inputTokens } : {}),
        ...(usage && typeof usage.outputTokens === 'number' ? { outputTokens: usage.outputTokens } : {})
      }
    }
  })
}

export default { name, inject, apply }
