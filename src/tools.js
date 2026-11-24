// 注册全部工作流工具：ask_expert / delegate / request_plan / request_review / dispatch_external（按需动态注册）
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { DSH_SPAWN_BACKEND, pickProfile, routeLabel } from './config.js'
import { extractFinishKind, normalizeUsage } from './metrics.js'
import { READ_ONLY_PREAMBLE, loadSubagentPreamble } from './prompts.js'
import { precheckResearchText } from './research-check.js'

function readTextSafe(file) {
  try { return file ? fs.readFileSync(file, 'utf8') : '' } catch { return '' }
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

function sessionIdOf(agent) {
  if (!agent) return ''
  return (agent.session && agent.session.id) || agent.id || ''
}

function cwdOf(ctx, agent) {
  try {
    const wd = typeof ctx.get === 'function' ? ctx.get('workingDirectory') : undefined
    if (wd && typeof wd.get === 'function' && agent) {
      const dir = wd.get(agent)
      if (typeof dir === 'string' && dir) return dir
    }
  } catch {}
  return process.cwd()
}

export function registerWorkflowTools({ ctx, getConfig, backendRegistry, stateStore, metrics, runner, onExpertToggle }) {
  const disposers = []
  const service = (key) => (typeof ctx.get === 'function' ? ctx.get(key) : undefined)

  // ── 1. ask_expert（向后兼容 0.2.x + 修复 finish.reason.kind & 6 维 usage） ──
  disposers.push(ctx.tools.register({
    name: 'ask_expert',
    description: [
      '把一份按模板写好的求助包交给专家模型，同步返回纯文本建议（适合无需读大段代码的纯方向/审美/设计取舍）。',
      '若需要专家自己读代码做架构规划，请优先使用 request_plan。',
      '调用前须包含：第几次 / 根治或验收定义 / 已试或已证伪假设 / 一个问题，缺项会被直接拒绝。',
      '可选 need 参数按标签挑专家（例如 need:"审美"）；可选 depth:"normal"|"deep" 选推理档位。'
    ].join(''),
    parameters: {
      type: 'object',
      required: ['package'],
      properties: {
        package: { type: 'string', title: 'package', description: '按 CONSULT-TEMPLATE.md 填写的完整求助包全文。' },
        need: { type: 'string', title: 'need', description: '可选：按标签选择专家（大小写不敏感）。' },
        depth: { type: 'string', enum: ['normal', 'deep'], title: 'depth', description: '可选：档位深度 normal(standard) / deep。' }
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
          cacheReadTokens: { type: 'number' },
          cacheWriteTokens: { type: 'number' },
          outputTokens: { type: 'number' },
          reasoningTokens: { type: 'number' },
          totalTokens: { type: 'number' }
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
      const live = getConfig()
      const missing = []
      if (pkg.length < live.minPackageChars) missing.push('求助包太短（< ' + live.minPackageChars + ' 字符）')
      if (!/第\s*几次/.test(pkg)) missing.push('缺「第几次」')
      if (!/根治|验收/.test(pkg)) missing.push('缺「根治定义」')
      if (!/已证伪|已试|假设/.test(pkg)) missing.push('缺「已试/已证伪假设」')
      if (!/问题/.test(pkg)) missing.push('缺「一个问题」')
      if (missing.length) {
        throw new Error('ask_expert 拒绝执行（参数名应为 package，收到 ' + (raw ? '字符串 ' + raw.length + ' 字' : '空') + '）：' + missing.join('；') + '。先读 CONSULT-TEMPLATE.md 补全再调。')
      }

      const need = args && typeof args === 'object' && typeof args.need === 'string' ? args.need : ''
      const depth = args && typeof args === 'object' && typeof args.depth === 'string' ? args.depth : ''
      const picked = pickProfile(live.experts, { need, depth, backendRegistry })
      if (picked === null) {
        throw new Error('ask_expert 不可用：还没有配置任何可用的专家 —— 打开设置页在「专家列表」中配置 provider 与 model。')
      }
      const expert = picked.route
      const expertLabel = routeLabel(expert)
      const llm = service('llm')
      if (!llm) throw new Error('ask_expert 不可用：llm 服务未绑定')

      const me = routeOf(exec && exec.agent)
      if (me.provider === expert.provider && me.model === expert.model) {
        return { answer: '（跳过）你当前就在用专家模型，自己判断即可。', expert: expertLabel, truncated: false, matched: picked.matchedNeed, need }
      }

      const systemParts = []
      const globalPrompt = readTextSafe(live.systemPromptFile)
      if (globalPrompt) systemParts.push(globalPrompt)
      if (expert.systemPrompt) systemParts.push(expert.systemPrompt)
      const system = systemParts.join('\n\n')

      const options = {
        provider: expert.provider,
        model: expert.model,
        messages: [{ role: 'user', content: [{ type: 'text', text: pkg }] }],
        maxTokens: expert.maxTokens > 0 ? expert.maxTokens : live.maxTokens
      }
      if (system) options.system = system
      if (expert.reasoningEffort) options.reasoningEffort = expert.reasoningEffort

      const controller = new AbortController()
      const timer = setTimeout(() => { try { controller.abort(new Error('expert-bridge timeout')) } catch {} }, live.timeoutMs)
      const started = Date.now()
      let answer = ''
      let rawUsage = null
      let finish = null
      onExpertToggle?.(true)
      try {
        for await (const chunk of llm.stream({ ...options, signal: controller.signal })) {
          if (!chunk) continue
          if (chunk.type === 'text-delta' && typeof chunk.text === 'string') answer += chunk.text
          else if (chunk.type === 'usage') rawUsage = chunk.usage
          else if (chunk.type === 'finish') finish = chunk
        }
      } finally {
        onExpertToggle?.(false)
        clearTimeout(timer)
      }

      const finishKind = extractFinishKind(finish)
      if (finishKind === 'error' || finishKind === 'aborted') {
        throw new Error('ask_expert 调用失败：' + finishKind)
      }
      if (!answer.trim()) throw new Error('ask_expert：专家没有产出任何文本')

      const usage = normalizeUsage(rawUsage)
      metrics.recordExpertUsage({
        executor: me.provider + '/' + me.model,
        expert: expert.provider + '/' + expert.model,
        expertName: expert.name || '',
        reasoningEffort: expert.reasoningEffort || '',
        need,
        matched: picked.matchedNeed,
        packageChars: pkg.length,
        answerChars: answer.length,
        usage,
        finish,
        ms: Date.now() - started
      })

      // 完成一次专家咨询后重置本回合熔断计数
      const sid = sessionIdOf(exec && exec.agent)
      const st = stateStore.get(sid)
      if (st) stateStore.resetStall(st)

      const out = {
        answer,
        expert: expertLabel,
        truncated: finishKind === 'max-tokens',
        matched: picked.matchedNeed,
        need
      }
      if (usage) {
        for (const k of ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens', 'reasoningTokens', 'totalTokens']) {
          if (typeof usage[k] === 'number') out[k] = usage[k]
        }
      }
      return out
    }
  }))

  // ── 2. delegate（支持 worker-readonly/worker-exec 预设 + 自动 preamble + 只读硬隔离 + 外部后端） ──
  disposers.push(ctx.tools.register({
    name: 'delegate',
    description: [
      '把一件独立的活派给子代理（按档位与标签路由，自动前置环境事实 preamble）。',
      'tier:"low" = 便宜只读子代理（做搜索/阅读/整理杂活，自动施加只读约束与宿主 guard 硬防写）；',
      'tier:"medium" = 能力接近主力的施工子代理（可读写文件，适合边界清楚的独立子任务）。',
      '可选 need 按标签挑模型档位，可选 depth:"normal"|"deep" 选推理档位。'
    ].join(''),
    parameters: {
      type: 'object',
      required: ['tier', 'task'],
      properties: {
        tier: { type: 'string', enum: ['low', 'medium'], title: 'tier', description: '子代理档位：low（只读便宜）/ medium（可读写施工）。' },
        task: { type: 'string', title: 'task', description: '完整自包含任务描述（目标、边界、交付物、验收标准）。' },
        need: { type: 'string', title: 'need', description: '可选：按标签选择该档模型（大小写不敏感）。' },
        depth: { type: 'string', enum: ['normal', 'deep'], title: 'depth', description: '可选：档位深度 normal / deep。' },
        description: { type: 'string', title: 'description', description: '可选：3-5 个词的短标签。' }
      }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'subagentId', 'tier', 'backend', 'provider', 'model'],
        properties: {
          kind: { type: 'string' },
          subagentId: { type: 'string' },
          tier: { type: 'string' },
          backend: { type: 'string' },
          provider: { type: 'string' },
          model: { type: 'string' },
          reasoningEffort: { type: 'string' },
          answer: { type: 'string' },
          resumeHint: { type: 'string' }
        }
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.kind === 'external-completed'
          ? `[${value.backend}] ${value.answer || ''}${value.resumeHint ? '\n接管命令：' + value.resumeHint : ''}`
          : `started ${value.tier} subagent ${value.subagentId} (${value.provider}/${value.model}${value.reasoningEffort ? ' [' + value.reasoningEffort + ']' : ''})`
      }]
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const tier = args && typeof args === 'object' ? String(args.tier || '').trim().toLowerCase() : ''
      if (tier !== 'low' && tier !== 'medium') {
        throw new Error('delegate 拒绝执行：tier 只接受 "low" | "medium"')
      }
      const task = args && typeof args === 'object' && typeof args.task === 'string' ? args.task : ''
      if (!task.trim()) throw new Error('delegate 拒绝执行：task 不能为空')

      const live = getConfig()
      const need = typeof args.need === 'string' ? args.need : ''
      const depth = typeof args.depth === 'string' ? args.depth : ''
      const picked = pickProfile(tier === 'low' ? live.low : live.medium, { need, depth, backendRegistry })
      if (picked === null) {
        throw new Error('delegate 不可用：' + tier + ' 档还没有配置可用的路由 —— 请在设置页配置对应角色池。')
      }
      const route = picked.route
      const preamble = loadSubagentPreamble(live.workflow.preambleFile)
      const bodyParts = [
        tier === 'low' ? READ_ONLY_PREAMBLE : '',
        preamble,
        task
      ].filter(Boolean)
      const body = bodyParts.join('\n\n')
      const rootSessionId = sessionIdOf(exec && exec.agent)
      const cwd = cwdOf(ctx, exec && exec.agent)
      const signal = exec && exec.signal ? exec.signal : new AbortController().signal

      // 支持将 delegate 路由到已注册的外部后端
      if (route.backend !== DSH_SPAWN_BACKEND) {
        const adapter = backendRegistry.get(route.backend)
        if (!adapter) throw new Error(`delegate 不可用：外部后端 "${route.backend}" 未注册`)
        const started = Date.now()
        const res = await adapter.run({
          role: tier === 'low' ? 'worker-low' : 'worker-medium',
          cwd,
          prompt: body,
          readonly: tier === 'low',
          model: route.model || undefined,
          reasoningEffort: route.reasoningEffort || undefined,
          timeoutMs: live.timeoutMs,
          backendOptions: route.backendOptions,
          signal
        })
        metrics.recordEvent('delegate', {
          rootSessionId,
          role: `worker-${tier}`,
          backend: route.backend,
          profileName: routeLabel(route),
          externalSessionId: res.externalSessionId || '',
          stopReason: res.stopReason,
          ms: Date.now() - started,
          usage: res.usage
        })
        return {
          kind: 'external-completed',
          subagentId: res.externalSessionId || route.backend,
          tier,
          backend: route.backend,
          provider: route.backend,
          model: route.model || route.backend,
          reasoningEffort: route.reasoningEffort || '',
          answer: res.text || res.diagnostic || '',
          resumeHint: res.resumeHint || ''
        }
      }

      if (!(exec && exec.agent)) {
        throw new Error('delegate 拒绝执行：拿不到调用方 agent（exec.agent 为空），无法建立父子关系')
      }
      const subagents = service('subagents')
      if (!subagents || typeof subagents.startActivation !== 'function') {
        throw new Error('delegate 不可用：subagents 服务未就绪（宿主没有挂载 dsh-subagent）')
      }
      if (typeof signal.throwIfAborted === 'function') signal.throwIfAborted()

      const childId = randomUUID()
      const targetPresetName = tier === 'low' ? live.workflow.readonlyPreset : live.workflow.execPreset
      const agentPreset = await runner.resolvePreset(targetPresetName)
      const label = typeof args.description === 'string' && args.description.trim()
        ? args.description.trim()
        : `${tier} delegate`
      const agentOptions = { provider: route.provider, model: route.model }
      if (route.reasoningEffort) agentOptions.reasoningEffort = route.reasoningEffort
      if (route.maxTokens > 0) agentOptions.maxTokens = route.maxTokens

      if (tier === 'low') runner.readonlyChildIds.add(childId)
      metrics.tagSession(childId, {
        rootSessionId,
        role: `worker-${tier}`,
        profileName: routeLabel(route),
        backend: DSH_SPAWN_BACKEND
      })

      try {
        const activation = await subagents.startActivation({
          provider: 'spawn',
          label,
          childId,
          request: {
            cwd,
            prompt: [{ type: 'text', text: body }],
            parent: exec.agent,
            ...(agentPreset ? { agentPreset } : {}),
            maxDepth: 1,
            agentOptions
          },
          signal,
          delivery: 'parent'
        })
        return {
          kind: 'activation',
          subagentId: activation.childId,
          tier,
          backend: DSH_SPAWN_BACKEND,
          provider: route.provider,
          model: route.model,
          reasoningEffort: route.reasoningEffort || ''
        }
      } catch (error) {
        if (tier === 'low') runner.readonlyChildIds.delete(childId)
        throw error
      }
    }
  }))

  // ── 3. request_plan（首轮同步只读规划 + 续聊 V5-A + 3 轮上限自动升档 deep） ──
  disposers.push(ctx.tools.register({
    name: 'request_plan',
    description: [
      '拉起带只读工具的独立规划子代理（或已接入的外部后端）直接读代码/查日志产出结构化 plan.json 与 plan.md。',
      '主力无需手写长篇求助包：mode:"new" 时只需传 goal（原始目标）与 pointers（路径/报错线索）；',
      '同任务中途卡住或前提变化时，用 mode:"followup" 传 feedback 与 evidence 续聊原规划窗口（最多 3 轮，超限自动清零重开并升档 deep）。'
    ].join(''),
    parameters: {
      type: 'object',
      required: ['mode'],
      properties: {
        mode: { type: 'string', enum: ['new', 'followup'], title: 'mode', description: 'new（新开规划窗口）/ followup（续聊当前任务的规划窗口）。' },
        goal: { type: 'string', title: 'goal', description: 'mode:"new" 必填：用户原始目标或待解决的问题描述。' },
        pointers: { type: 'array', items: { type: 'string' }, title: 'pointers', description: '可选：相关文件路径、行号或报错线索列表。' },
        feedback: { type: 'string', title: 'feedback', description: 'mode:"followup" 必填：施工卡点、前提变化或需修订的方向。' },
        evidence: { type: 'string', title: 'evidence', description: '可选：实跑命令输出或错误原文。' },
        depth: { type: 'string', enum: ['normal', 'deep'], title: 'depth', description: '可选：档位深度 normal（常规标准档）/ deep（高推理/顶配攻坚档）。' },
        need: { type: 'string', title: 'need', description: '可选：按标签匹配规划档位（如 "架构"、"诊断"）。' },
        planDir: { type: 'string', title: 'planDir', description: '可选：plan.json / plan.md 落盘目录（建议 tasks/<任务名>）。' }
      }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['status', 'backend', 'profile'],
        properties: {
          status: { type: 'string' },
          backend: { type: 'string' },
          profile: { type: 'string' },
          sessionId: { type: 'string' },
          planPath: { type: 'string' },
          planMdPath: { type: 'string' },
          planVersion: { type: 'number' },
          reopenedDeep: { type: 'boolean' },
          resumeHint: { type: 'string' },
          note: { type: 'string' },
          plan: { type: 'object' }
        }
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.status === 'followup_dispatched'
          ? `已向原规划器 (${value.profile}) 发送续聊请求：${value.note || ''}`
          : `规划完成（${value.profile}，v${value.planVersion || 1}）${value.planMdPath ? '，已落盘：' + value.planMdPath : ''}\n${JSON.stringify(value.plan || {}, null, 2)}`
      }]
    },
    async execute(args, exec) {
      const live = getConfig()
      const mode = args && args.mode === 'followup' ? 'followup' : 'new'
      const need = typeof args?.need === 'string' ? args.need : ''
      let depth = typeof args?.depth === 'string' ? args.depth : 'normal'
      const cwd = cwdOf(ctx, exec && exec.agent)
      const rootSessionId = sessionIdOf(exec && exec.agent) || 'unknown-session'
      const state = stateStore.getOrCreate(rootSessionId)
      const signal = exec && exec.signal ? exec.signal : new AbortController().signal
      const planDir = typeof args?.planDir === 'string' && args.planDir.trim()
        ? args.planDir.trim()
        : (state.planPath ? path.dirname(state.planPath) : '')

      // 优先从 planners 池挑档位；若尚未配 planners 则优雅回落 experts 池（降低迁移门槛）
      const pool = live.planners.length > 0 ? live.planners : live.experts

      if (mode === 'followup') {
        const feedback = typeof args?.feedback === 'string' ? args.feedback.trim() : ''
        if (!feedback) throw new Error('request_plan(mode:"followup") 拒绝执行：feedback 不能为空')
        const evidence = typeof args?.evidence === 'string' ? args.evidence : ''

        // 若当前没有可续聊的规划会话，或已超过最大续聊轮次 → 清零重开并自动升档 deep！
        const overLimit = state.plannerTurns >= live.workflow.maxPlannerFollowups
        if (state.plannerSession && !overLimit) {
          const picked = pickProfile(pool, {
            need,
            depth,
            preferredBackend: state.plannerSession.backend,
            backendRegistry
          })
          if (!picked) throw new Error('request_plan 不可用：未配置可用的 planners（或 experts）路由')
          const res = await runner.runPlannerFollowup({
            parent: exec && exec.agent,
            state,
            route: picked.route,
            feedback,
            evidence,
            cwd,
            planDir,
            liveConfig: live,
            signal
          })
          if (!res.mustReopen) {
            if (res.mode === 'async-followup') {
              return {
                status: 'followup_dispatched',
                backend: res.backend,
                profile: res.profile,
                sessionId: res.sessionId,
                planPath: state.planPath,
                planMdPath: state.planMdPath,
                planVersion: state.planVersion,
                note: `第 ${res.turnNumber}/${res.maxTurns} 轮续聊已发往原只读规划器，完成后宿主将自动送回修订结果并更新 plan.json。`
              }
            }
            stateStore.setPlan(state, {
              plan: res.plan,
              planPath: res.planPath,
              planMdPath: res.planMdPath,
              plannerSession: { backend: res.backend, sessionId: res.sessionId },
              isFollowup: true
            })
            return {
              status: 'planned',
              backend: res.backend,
              profile: res.profile,
              sessionId: res.sessionId,
              planPath: res.planPath,
              planMdPath: res.planMdPath,
              planVersion: state.planVersion,
              resumeHint: res.resumeHint || '',
              plan: res.plan
            }
          }
        }

        // 超出续聊轮次上限或不支持续聊 → 记录已证伪线索，清零重开并强制升档 deep
        state.priorFalsified.push(feedback.slice(0, 300))
        depth = 'deep'
        const pickedDeep = pickProfile(pool, { need, depth: 'deep', backendRegistry })
        if (!pickedDeep) throw new Error('request_plan 不可用：未配置可用的 planners（或 experts）路由')
        const goal = (typeof args?.goal === 'string' && args.goal.trim()) || state.firstUserGoal || feedback
        const res = await runner.runPlannerNew({
          parent: exec && exec.agent,
          rootSessionId,
          route: pickedDeep.route,
          goal,
          pointers: Array.isArray(args?.pointers) ? args.pointers : [],
          priorFalsified: state.priorFalsified,
          cwd,
          planDir,
          liveConfig: live,
          signal
        })
        stateStore.setPlan(state, {
          plan: res.plan,
          planPath: res.planPath,
          planMdPath: res.planMdPath,
          plannerSession: { backend: res.backend, sessionId: res.sessionId },
          isFollowup: false
        })
        return {
          status: 'planned',
          backend: res.backend,
          profile: res.profile,
          sessionId: res.sessionId,
          planPath: res.planPath,
          planMdPath: res.planMdPath,
          planVersion: state.planVersion,
          reopenedDeep: true,
          resumeHint: res.resumeHint || '',
          note: overLimit
            ? `已达续聊上限（${live.workflow.maxPlannerFollowups} 轮），自动清零重开新窗口并升档至 deep 规划器`
            : '原规划会话不可续聊，已重开新窗口并升档至 deep 规划器',
          plan: res.plan
        }
      }

      // mode === 'new'
      const goal = (typeof args?.goal === 'string' && args.goal.trim()) || state.firstUserGoal
      if (!goal) throw new Error('request_plan(mode:"new") 拒绝执行：goal 不能为空')
      const picked = pickProfile(pool, { need, depth, backendRegistry })
      if (!picked) {
        throw new Error('request_plan 不可用：请先在设置页配置至少一条可用的规划器（planners）或专家（experts）路由。')
      }
      const res = await runner.runPlannerNew({
        parent: exec && exec.agent,
        rootSessionId,
        route: picked.route,
        goal,
        pointers: Array.isArray(args?.pointers) ? args.pointers : [],
        priorFalsified: state.priorFalsified,
        cwd,
        planDir,
        liveConfig: live,
        signal
      })
      stateStore.setPlan(state, {
        plan: res.plan,
        planPath: res.planPath,
        planMdPath: res.planMdPath,
        plannerSession: { backend: res.backend, sessionId: res.sessionId },
        isFollowup: false
      })
      return {
        status: 'planned',
        backend: res.backend,
        profile: res.profile,
        sessionId: res.sessionId,
        planPath: res.planPath,
        planMdPath: res.planMdPath,
        planVersion: state.planVersion,
        reopenedDeep: false,
        resumeHint: res.resumeHint || '',
        note: res.readonlyNotice || '',
        plan: res.plan
      }
    }
  }))

  // ── 4. request_review（轨 B 零成本来源预检 + 新鲜隔离上下文独立只读复审） ──
  disposers.push(ctx.tools.register({
    name: 'request_review',
    description: [
      '发起新鲜隔离上下文的独立只读复审，验收交付质量并解除交付复审门禁。',
      'scope:"research"（轨 B 调研）会先执行零成本代码预检（查未标注二手源与无一手源易变断言），再由独立复审器核查；',
      'scope:"engineering"（轨 C 工程）会对照 plan.json 验收清单、改动文件与实跑命令证据逐条验收。'
    ].join(''),
    parameters: {
      type: 'object',
      required: ['summary'],
      properties: {
        scope: { type: 'string', enum: ['research', 'engineering'], title: 'scope', description: '复审类型：research（调研）/ engineering（工程）；省略时按当前轨道自动判定。' },
        summary: { type: 'string', title: 'summary', description: '交付内容摘要或关键结论说明。' },
        draftText: { type: 'string', title: 'draftText', description: '轨 B 推荐提供：待交付的调研正文（用于零成本 URL 与来源分级预检）。' },
        artifactPaths: { type: 'array', items: { type: 'string' }, title: 'artifactPaths', description: '可选：待抽核的文件/报告路径列表。' },
        commandEvidence: { type: 'string', title: 'commandEvidence', description: '可选：实跑测试或校验命令输出摘要。' },
        depth: { type: 'string', enum: ['normal', 'deep'], title: 'depth', description: '可选：档位深度 normal / deep。' },
        need: { type: 'string', title: 'need', description: '可选：按标签匹配复审器档位。' }
      }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['verdict', 'scope', 'profile', 'summary', 'gaps'],
        properties: {
          verdict: { type: 'string' },
          scope: { type: 'string' },
          profile: { type: 'string' },
          summary: { type: 'string' },
          precheckWarnings: { type: 'array', items: { type: 'string' } },
          checkedCriteria: { type: 'array' },
          gaps: { type: 'array', items: { type: 'string' } }
        }
      },
      render: (_args, value) => [{
        type: 'text',
        text: `复审结论：${value.verdict.toUpperCase()}（${value.profile}）\n摘要：${value.summary}${value.gaps && value.gaps.length ? '\n待补缺口：\n' + value.gaps.map((g) => '- ' + g).join('\n') : ''}`
      }]
    },
    async execute(args, exec) {
      const live = getConfig()
      const summary = typeof args?.summary === 'string' ? args.summary.trim() : ''
      if (!summary) throw new Error('request_review 拒绝执行：summary 不能为空')

      const cwd = cwdOf(ctx, exec && exec.agent)
      const rootSessionId = sessionIdOf(exec && exec.agent) || 'unknown-session'
      const state = stateStore.getOrCreate(rootSessionId)
      const scope = args?.scope === 'research' || args?.scope === 'engineering'
        ? args.scope
        : (state.track === 'B' ? 'research' : 'engineering')
      const artifactPaths = Array.isArray(args?.artifactPaths) ? args.artifactPaths.map(String) : []
      const commandEvidence = typeof args?.commandEvidence === 'string' ? args.commandEvidence : ''
      const signal = exec && exec.signal ? exec.signal : new AbortController().signal

      // 轨 B 零成本代码预检（直接扫描 draftText + summary + 若可读的报告文件）
      let precheckWarnings = []
      if (scope === 'research') {
        const textChunks = [typeof args?.draftText === 'string' ? args.draftText : '', summary]
        for (const p of artifactPaths.slice(0, 3)) {
          try {
            const stat = fs.statSync(p)
            if (stat.isFile() && stat.size <= 102400) textChunks.push(fs.readFileSync(p, 'utf8'))
          } catch {}
        }
        const precheck = precheckResearchText(textChunks.filter(Boolean).join('\n\n'))
        precheckWarnings = precheck.warnings
      }

      const pool = live.reviewers.length > 0 ? live.reviewers : (live.planners.length > 0 ? live.planners : live.experts)
      const need = typeof args?.need === 'string' ? args.need : ''
      const depth = typeof args?.depth === 'string' ? args.depth : (state.reviewCount >= 2 ? 'deep' : 'normal')
      const picked = pickProfile(pool, { need, depth, backendRegistry })
      if (!picked) {
        // 若未配置任何复审模型但轨 B 代码预检有告警，直接返回零成本预检失败结果
        if (scope === 'research' && precheckWarnings.length > 0) {
          const fallbackFail = {
            verdict: 'fail',
            summary: '零成本来源预检未通过（且尚未配置独立复审模型）',
            checkedCriteria: [],
            gaps: precheckWarnings
          }
          stateStore.setReview(state, fallbackFail)
          return {
            verdict: 'fail',
            scope,
            profile: 'code-precheck',
            summary: fallbackFail.summary,
            precheckWarnings,
            checkedCriteria: [],
            gaps: precheckWarnings
          }
        }
        throw new Error('request_review 不可用：请先在设置页配置至少一条复审器（reviewers）或规划器/专家路由。')
      }

      const res = await runner.runReviewer({
        parent: exec && exec.agent,
        rootSessionId,
        route: picked.route,
        scope,
        originalGoal: state.firstUserGoal,
        plan: state.plan,
        summary,
        artifactPaths,
        commandEvidence,
        precheckWarnings,
        cwd,
        liveConfig: live,
        signal
      })

      stateStore.setReview(state, res.review)
      return {
        verdict: res.review.verdict,
        scope,
        profile: res.profile,
        summary: res.review.summary,
        precheckWarnings,
        checkedCriteria: res.review.checkedCriteria,
        gaps: res.review.gaps
      }
    }
  }))

  // ── 5. dispatch_external（仅当存在已注册 ExternalBackendAdapter 时按需暴露） ──
  let disposeExternalTool = null
  const syncExternalTool = () => {
    const hasBackends = backendRegistry.size() > 0
    if (hasBackends && !disposeExternalTool) {
      disposeExternalTool = ctx.tools.register({
        name: 'dispatch_external',
        description: [
          '向已注册的外部 Agent 后端（如 Antigravity）派发任务或交棒。',
          'mode:"run" = 在外部后端跑完并拿回结果继续当前主线；',
          'mode:"handoff" = 打包当前目标、plan.json 与关键文件路径，在外部后端开启持久化会话并返回 conversation_id 与接管指令供用户人工接管。'
        ].join(''),
        parameters: {
          type: 'object',
          required: ['mode', 'goal'],
          properties: {
            backend: { type: 'string', title: 'backend', description: '可选：指定外部后端 ID（如 "antigravity"）；省略时选第一个已注册后端。' },
            mode: { type: 'string', enum: ['run', 'handoff'], title: 'mode', description: 'run（执行并拿结果）/ handoff（开启持久会话交棒给用户）。' },
            goal: { type: 'string', title: 'goal', description: '完整任务目标。' },
            summary: { type: 'string', title: 'summary', description: '可选：当前进展与背景摘要。' },
            contextFiles: { type: 'array', items: { type: 'string' }, title: 'contextFiles', description: '可选：关键文件路径列表。' },
            conversationId: { type: 'string', title: 'conversationId', description: '可选：续聊已有外部会话 ID。' },
            readonly: { type: 'boolean', title: 'readonly', description: '可选：是否要求外部后端只读执行（handoff 默认 true）。' },
            model: { type: 'string', title: 'model', description: '可选：透传给外部后端的模型标识。' },
            reasoningEffort: { type: 'string', title: 'reasoningEffort', description: '可选：透传给外部后端的推理强度。' }
          }
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['backend', 'mode', 'stopReason', 'text'],
            properties: {
              backend: { type: 'string' },
              mode: { type: 'string' },
              stopReason: { type: 'string' },
              externalSessionId: { type: 'string' },
              resumeHint: { type: 'string' },
              text: { type: 'string' },
              diagnostic: { type: 'string' }
            }
          },
          render: (_args, value) => [{
            type: 'text',
            text: `[${value.backend}/${value.mode}] status=${value.stopReason}${value.externalSessionId ? ' session=' + value.externalSessionId : ''}${value.resumeHint ? '\n接管方式：' + value.resumeHint : ''}\n${value.text || value.diagnostic || ''}`
          }]
        },
        async execute(args, exec) {
          const list = backendRegistry.list()
          if (list.length === 0) throw new Error('dispatch_external 不可用：当前没有任何已注册的外部后端适配器')
          const backendId = typeof args?.backend === 'string' && args.backend.trim() ? args.backend.trim() : list[0].id
          const mode = args?.mode === 'handoff' ? 'handoff' : 'run'
          const goal = typeof args?.goal === 'string' ? args.goal.trim() : ''
          if (!goal) throw new Error('dispatch_external 拒绝执行：goal 不能为空')

          const live = getConfig()
          const cwd = cwdOf(ctx, exec && exec.agent)
          const rootSessionId = sessionIdOf(exec && exec.agent)
          const st = stateStore.get(rootSessionId)
          const signal = exec && exec.signal ? exec.signal : new AbortController().signal

          return runner.runExternalDispatch({
            backendId,
            mode,
            goal,
            summary: typeof args?.summary === 'string' ? args.summary : '',
            contextFiles: Array.isArray(args?.contextFiles) ? args.contextFiles.map(String) : [],
            planPath: st ? st.planPath : '',
            plan: st ? st.plan : null,
            conversationId: typeof args?.conversationId === 'string' ? args.conversationId : '',
            readonly: Boolean(args?.readonly),
            model: typeof args?.model === 'string' ? args.model : '',
            reasoningEffort: typeof args?.reasoningEffort === 'string' ? args.reasoningEffort : '',
            cwd,
            rootSessionId,
            liveConfig: live,
            signal
          })
        }
      })
    } else if (!hasBackends && disposeExternalTool) {
      try { disposeExternalTool() } catch {}
      disposeExternalTool = null
    }
  }
  syncExternalTool()
  disposers.push(backendRegistry.onChange(syncExternalTool))

  return () => {
    if (disposeExternalTool) {
      try { disposeExternalTool() } catch {}
      disposeExternalTool = null
    }
    for (const d of disposers) {
      try { d?.() } catch {}
    }
  }
}
