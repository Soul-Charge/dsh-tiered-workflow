// 统一执行器：透明分流 dsh-spawn（V5-A 契约）与 ExternalBackendAdapter v1
// 关键保障：
//  1. 预分配 childId 提前入 readonlyChildIds 集合，0 毫秒竞态防只读子代理调用全局写工具；
//  2. 自动检测配置的 readonlyPreset / execPreset 是否已注册，未注册时安全降级不崩溃；
//  3. dsh-spawn 首轮走 delivery:'caller' + outputSchema 同步直返；续聊走 sendMessage + subagent/end 监听更新 plan.json；
//  4. 外部后端走 ExternalBackendAdapter.run()，天然支持续聊、handoff 与 6 维 usage 回传。
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { DSH_SPAWN_BACKEND, routeLabel } from './config.js'
import {
  PLAN_OUTPUT_SCHEMA,
  REVIEW_OUTPUT_SCHEMA,
  buildPlannerNewPrompt,
  buildPlannerFollowupPrompt,
  buildReviewerPrompt,
  buildHandoffPrompt,
  extractJsonFromText,
  loadSubagentPreamble,
  renderPlanMarkdown,
  validatePlanObject,
  validateReviewObject
} from './prompts.js'

function blocksToText(blocks) {
  if (!Array.isArray(blocks)) return typeof blocks === 'string' ? blocks : ''
  return blocks
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
}

async function resolveOptionalPreset(ctx, presetId) {
  if (!presetId) return undefined
  const registry = typeof ctx.get === 'function' ? ctx.get('agentPresets') : undefined
  if (!registry || typeof registry.list !== 'function') return undefined
  try {
    const list = await registry.list()
    if (Array.isArray(list) && list.some((p) => p && p.id === presetId)) {
      return presetId
    }
  } catch {}
  return undefined
}

export function writePlanArtifacts(planDir, plan, meta) {
  if (!planDir) return { planPath: '', planMdPath: '' }
  try {
    fs.mkdirSync(planDir, { recursive: true })
    const planPath = path.join(planDir, 'plan.json').replace(/\\/g, '/')
    const planMdPath = path.join(planDir, 'plan.md').replace(/\\/g, '/')
    fs.writeFileSync(planPath, JSON.stringify({ ...meta, plan }, null, 2), 'utf8')
    fs.writeFileSync(planMdPath, renderPlanMarkdown(plan, meta), 'utf8')
    return { planPath, planMdPath }
  } catch {
    return { planPath: '', planMdPath: '' }
  }
}

export class WorkflowRunner {
  constructor({ ctx, backendRegistry, metrics, stateStore, logger = null, now = () => Date.now() }) {
    this._ctx = ctx
    this._backends = backendRegistry
    this._metrics = metrics
    this._states = stateStore
    this._logger = logger
    this._now = now
    // 正在运行的只读子代理 sessionId 集合（供 gates.js 兜底硬拒继承自全局层的写工具）
    this.readonlyChildIds = new Set()
    // 正在等待续聊结算的 dsh-spawn planner：childId -> { state, planDir, profileName, versionBase }
    this._pendingFollowups = new Map()
  }

  /** 绑定 subagent/end 监听器：回收 readonlyChildIds 并在 dsh-spawn 续聊结算时自动更新 plan.json。 */
  attach(ctx) {
    if (!ctx || typeof ctx.on !== 'function') return () => {}
    return ctx.on('subagent/end', (info) => {
      try {
        if (!info || !info.id) return
        const childId = info.id
        // 若不是等待中的续聊任务，安全移出只读集合（续聊期间会重新加入）
        this.readonlyChildIds.delete(childId)

        const pending = this._pendingFollowups.get(childId)
        if (!pending) return
        this._pendingFollowups.delete(childId)

        const rawText = blocksToText(info.lastAssistantMessage)
        const parsed = extractJsonFromText(rawText)
        const validated = validatePlanObject(parsed)
        if (validated.ok) {
          const artifacts = writePlanArtifacts(pending.planDir, validated.plan, {
            profile: pending.profileName,
            version: (pending.state.planVersion || 1) + 1,
            generatedAt: new Date(this._now()).toISOString(),
            followup: true
          })
          this._states.setPlan(pending.state, {
            plan: validated.plan,
            planPath: artifacts.planPath || pending.state.planPath,
            planMdPath: artifacts.planMdPath || pending.state.planMdPath,
            plannerSession: { backend: DSH_SPAWN_BACKEND, sessionId: childId },
            isFollowup: true
          })
          this._metrics.recordEvent('planner-followup-settled', {
            rootSessionId: pending.state.sessionId,
            childId,
            profileName: pending.profileName,
            planVersion: pending.state.planVersion,
            ok: true
          })
        } else {
          this._metrics.recordEvent('planner-followup-settled', {
            rootSessionId: pending.state.sessionId,
            childId,
            profileName: pending.profileName,
            ok: false,
            errors: validated.errors
          })
        }
      } catch (error) {
        this._logger?.warn?.(
          `[runner.subagentEnd] error_code=FOLLOWUP_SETTLE_ERR: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    })
  }

  /** 发起一轮全新规划（支持 dsh-spawn 同步 structured_output 与外部后端透明路由）。 */
  async runPlannerNew({ parent, rootSessionId, route, goal, pointers, priorFalsified, cwd, planDir, liveConfig, signal }) {
    const preamble = loadSubagentPreamble(liveConfig.workflow.preambleFile)
    const label = routeLabel(route)
    const started = this._now()

    if (route.backend !== DSH_SPAWN_BACKEND) {
      const adapter = this._requireExternalAdapter(route.backend, 'runPlannerNew')
      const expectJsonFence = !adapter.capabilities.structuredOutput
      const prompt = buildPlannerNewPrompt({
        goal,
        pointers,
        priorFalsified,
        preamble,
        extraSystemPrompt: route.systemPrompt,
        expectJsonFence
      })
      const res = await adapter.run({
        role: 'planner',
        cwd,
        prompt,
        readonly: true,
        outputSchema: adapter.capabilities.structuredOutput ? PLAN_OUTPUT_SCHEMA : undefined,
        model: route.model || undefined,
        reasoningEffort: route.reasoningEffort || undefined,
        timeoutMs: liveConfig.timeoutMs,
        backendOptions: route.backendOptions,
        signal
      })
      const planObj = this._extractValidPlan(res.structured, res.text, 'runPlannerNew:' + route.backend)
      const artifacts = writePlanArtifacts(planDir, planObj, {
        profile: label,
        backend: route.backend,
        version: 1,
        generatedAt: new Date(this._now()).toISOString()
      })
      this._metrics.recordEvent('request_plan', {
        rootSessionId,
        role: 'planner',
        mode: 'new',
        backend: route.backend,
        profileName: label,
        externalSessionId: res.externalSessionId || '',
        stopReason: res.stopReason,
        ms: this._now() - started,
        usage: res.usage
      })
      return {
        mode: 'sync',
        backend: route.backend,
        sessionId: res.externalSessionId || '',
        resumeHint: res.resumeHint || '',
        profile: label,
        plan: planObj,
        planPath: artifacts.planPath,
        planMdPath: artifacts.planMdPath,
        readonlyNotice: adapter.capabilities.readonlyMode ? '' : `外部后端 ${route.backend} 未声明硬只读能力，已前置只读指令，请核查工作区状态`
      }
    }

    // DSH 原生 spawn 路径（delivery: 'caller' + outputSchema + maxDepth: 1 + 预留 childId 硬隔离）
    const subagents = this._requireSubagents('runPlannerNew')
    const childId = randomUUID()
    const agentPreset = await resolveOptionalPreset(this._ctx, liveConfig.workflow.readonlyPreset)
    const prompt = buildPlannerNewPrompt({
      goal,
      pointers,
      priorFalsified,
      preamble,
      extraSystemPrompt: route.systemPrompt,
      expectJsonFence: false
    })
    const agentOptions = { provider: route.provider, model: route.model }
    if (route.reasoningEffort) agentOptions.reasoningEffort = route.reasoningEffort
    if (route.maxTokens > 0) agentOptions.maxTokens = route.maxTokens

    this.readonlyChildIds.add(childId)
    this._metrics.tagSession(childId, {
      rootSessionId,
      role: 'planner',
      profileName: label,
      backend: DSH_SPAWN_BACKEND
    })

    let res
    try {
      const activation = await subagents.startActivation({
        provider: 'spawn',
        label: `planner:${label}`,
        childId,
        request: {
          cwd,
          prompt: [{ type: 'text', text: prompt }],
          parent,
          ...(agentPreset ? { agentPreset } : {}),
          outputSchema: PLAN_OUTPUT_SCHEMA,
          maxDepth: 1,
          agentOptions
        },
        signal,
        delivery: 'caller'
      })
      res = await activation.result
    } finally {
      this.readonlyChildIds.delete(childId)
    }

    if (res.stopReason !== 'completed') {
      const err = new Error(
        `[runner.runPlannerNew] target=${label} error_code=PLANNER_FAILED: stopReason=${res.stopReason} ${res.diagnostic || ''}`
      )
      err.code = 'PLANNER_FAILED'
      throw err
    }

    const planObj = this._extractValidPlan(res.structured, blocksToText(res.output), 'runPlannerNew:dsh-spawn')
    const artifacts = writePlanArtifacts(planDir, planObj, {
      profile: label,
      backend: DSH_SPAWN_BACKEND,
      version: 1,
      generatedAt: new Date(this._now()).toISOString()
    })
    this._metrics.recordEvent('request_plan', {
      rootSessionId,
      role: 'planner',
      mode: 'new',
      backend: DSH_SPAWN_BACKEND,
      profileName: label,
      childId,
      stopReason: res.stopReason,
      ms: this._now() - started
    })
    return {
      mode: 'sync',
      backend: DSH_SPAWN_BACKEND,
      sessionId: childId,
      resumeHint: '',
      profile: label,
      plan: planObj,
      planPath: artifacts.planPath,
      planMdPath: artifacts.planMdPath,
      readonlyNotice: ''
    }
  }

  /**
   * 规划续聊（V5-A 契约）：
   * - dsh-spawn：通过 sendMessage 触发 coldResume，立即返回异步回执，由原生 subagent-settled 唤醒父会话并经 subagent/end 更新 plan.json；
   * - 外部后端：若支持 continuation，直接带 externalSessionId 同步调用并返回修订版 plan。
   */
  async runPlannerFollowup({ parent, state, route, feedback, evidence, cwd, planDir, liveConfig, signal }) {
    const existing = state.plannerSession
    const turnNumber = (state.plannerTurns || 1) + 1
    const maxTurns = liveConfig.workflow.maxPlannerFollowups
    const label = routeLabel(route)
    const followupPrompt = buildPlannerFollowupPrompt({ feedback, evidence, turnNumber, maxTurns })

    if (existing.backend !== DSH_SPAWN_BACKEND) {
      const adapter = this._requireExternalAdapter(existing.backend, 'runPlannerFollowup')
      if (!adapter.capabilities.continuation || !existing.sessionId) {
        return { mustReopen: true, reason: `后端 ${existing.backend} 不支持续聊或缺少外部会话 ID` }
      }
      const started = this._now()
      const res = await adapter.run({
        role: 'planner',
        cwd,
        prompt: followupPrompt,
        readonly: true,
        outputSchema: adapter.capabilities.structuredOutput ? PLAN_OUTPUT_SCHEMA : undefined,
        externalSessionId: existing.sessionId,
        model: route.model || undefined,
        reasoningEffort: route.reasoningEffort || undefined,
        timeoutMs: liveConfig.timeoutMs,
        backendOptions: route.backendOptions,
        signal
      })
      const planObj = this._extractValidPlan(res.structured, res.text, 'runPlannerFollowup:' + existing.backend)
      const artifacts = writePlanArtifacts(planDir, planObj, {
        profile: label,
        backend: existing.backend,
        version: (state.planVersion || 1) + 1,
        generatedAt: new Date(this._now()).toISOString(),
        followup: true
      })
      this._metrics.recordEvent('request_plan', {
        rootSessionId: state.sessionId,
        role: 'planner',
        mode: 'followup',
        backend: existing.backend,
        profileName: label,
        externalSessionId: res.externalSessionId || existing.sessionId,
        stopReason: res.stopReason,
        ms: this._now() - started,
        usage: res.usage
      })
      return {
        mode: 'sync',
        backend: existing.backend,
        sessionId: res.externalSessionId || existing.sessionId,
        resumeHint: res.resumeHint || '',
        profile: label,
        plan: planObj,
        planPath: artifacts.planPath || state.planPath,
        planMdPath: artifacts.planMdPath || state.planMdPath
      }
    }

    // DSH 原生 spawn 续聊（V5-A 异步回执）
    const subagents = this._requireSubagents('runPlannerFollowup')
    const childId = existing.sessionId
    this.readonlyChildIds.add(childId)
    this._pendingFollowups.set(childId, {
      state,
      planDir: planDir || (state.planPath ? path.dirname(state.planPath) : ''),
      profileName: label
    })
    this._metrics.tagSession(childId, {
      rootSessionId: state.sessionId,
      role: 'planner',
      profileName: label,
      backend: DSH_SPAWN_BACKEND
    })

    try {
      const messageId = await subagents.sendMessage(
        parent,
        childId,
        [{ type: 'text', text: followupPrompt }],
        { signal }
      )
      this._metrics.recordEvent('request_plan', {
        rootSessionId: state.sessionId,
        role: 'planner',
        mode: 'followup-dispatched',
        backend: DSH_SPAWN_BACKEND,
        profileName: label,
        childId,
        messageId,
        turnNumber
      })
      return {
        mode: 'async-followup',
        backend: DSH_SPAWN_BACKEND,
        sessionId: childId,
        messageId,
        profile: label,
        turnNumber,
        maxTurns
      }
    } catch (error) {
      this._pendingFollowups.delete(childId)
      this.readonlyChildIds.delete(childId)
      throw error
    }
  }

  /** 独立新鲜上下文只读复审（严禁复用 Planner 会话）。 */
  async runReviewer({ parent, rootSessionId, route, scope, originalGoal, plan, summary, artifactPaths, commandEvidence, precheckWarnings, cwd, liveConfig, signal }) {
    const preamble = loadSubagentPreamble(liveConfig.workflow.preambleFile)
    const label = routeLabel(route)
    const started = this._now()

    if (route.backend !== DSH_SPAWN_BACKEND) {
      const adapter = this._requireExternalAdapter(route.backend, 'runReviewer')
      const expectJsonFence = !adapter.capabilities.structuredOutput
      const prompt = buildReviewerPrompt({
        scope,
        originalGoal,
        plan,
        summary,
        artifactPaths,
        commandEvidence,
        precheckWarnings,
        preamble,
        extraSystemPrompt: route.systemPrompt,
        expectJsonFence
      })
      const res = await adapter.run({
        role: 'reviewer',
        cwd,
        prompt,
        readonly: true,
        outputSchema: adapter.capabilities.structuredOutput ? REVIEW_OUTPUT_SCHEMA : undefined,
        model: route.model || undefined,
        reasoningEffort: route.reasoningEffort || undefined,
        timeoutMs: liveConfig.timeoutMs,
        backendOptions: route.backendOptions,
        signal
      })
      const reviewObj = this._extractValidReview(res.structured, res.text, 'runReviewer:' + route.backend)
      this._metrics.recordEvent('request_review', {
        rootSessionId,
        role: 'reviewer',
        scope,
        backend: route.backend,
        profileName: label,
        verdict: reviewObj.verdict,
        gapCount: reviewObj.gaps.length,
        ms: this._now() - started,
        usage: res.usage
      })
      return {
        backend: route.backend,
        profile: label,
        externalSessionId: res.externalSessionId || '',
        resumeHint: res.resumeHint || '',
        review: reviewObj
      }
    }

    const subagents = this._requireSubagents('runReviewer')
    const childId = randomUUID()
    const agentPreset = await resolveOptionalPreset(this._ctx, liveConfig.workflow.readonlyPreset)
    const prompt = buildReviewerPrompt({
      scope,
      originalGoal,
      plan,
      summary,
      artifactPaths,
      commandEvidence,
      precheckWarnings,
      preamble,
      extraSystemPrompt: route.systemPrompt,
      expectJsonFence: false
    })
    const agentOptions = { provider: route.provider, model: route.model }
    if (route.reasoningEffort) agentOptions.reasoningEffort = route.reasoningEffort
    if (route.maxTokens > 0) agentOptions.maxTokens = route.maxTokens

    this.readonlyChildIds.add(childId)
    this._metrics.tagSession(childId, {
      rootSessionId,
      role: 'reviewer',
      profileName: label,
      backend: DSH_SPAWN_BACKEND
    })

    let res
    try {
      const activation = await subagents.startActivation({
        provider: 'spawn',
        label: `reviewer:${label}`,
        childId,
        request: {
          cwd,
          prompt: [{ type: 'text', text: prompt }],
          parent,
          ...(agentPreset ? { agentPreset } : {}),
          outputSchema: REVIEW_OUTPUT_SCHEMA,
          maxDepth: 1,
          agentOptions
        },
        signal,
        delivery: 'caller'
      })
      res = await activation.result
    } finally {
      this.readonlyChildIds.delete(childId)
    }

    if (res.stopReason !== 'completed') {
      const err = new Error(
        `[runner.runReviewer] target=${label} error_code=REVIEWER_FAILED: stopReason=${res.stopReason} ${res.diagnostic || ''}`
      )
      err.code = 'REVIEWER_FAILED'
      throw err
    }

    const reviewObj = this._extractValidReview(res.structured, blocksToText(res.output), 'runReviewer:dsh-spawn')
    this._metrics.recordEvent('request_review', {
      rootSessionId,
      role: 'reviewer',
      scope,
      backend: DSH_SPAWN_BACKEND,
      profileName: label,
      childId,
      verdict: reviewObj.verdict,
      gapCount: reviewObj.gaps.length,
      ms: this._now() - started
    })
    return {
      backend: DSH_SPAWN_BACKEND,
      profile: label,
      childId,
      review: reviewObj
    }
  }

  /** 显式派发或交棒给外部后端（供 dispatch_external 使用）。 */
  async runExternalDispatch({ backendId, mode, goal, summary, contextFiles, planPath, plan, conversationId, readonly, model, reasoningEffort, cwd, rootSessionId, liveConfig, signal }) {
    const adapter = this._requireExternalAdapter(backendId, 'runExternalDispatch')
    if (mode === 'handoff' && !adapter.capabilities.handoff) {
      const err = new Error(
        `[runner.runExternalDispatch] target=${backendId} error_code=HANDOFF_UNSUPPORTED: backend "${backendId}" does not support handoff mode`
      )
      err.code = 'HANDOFF_UNSUPPORTED'
      throw err
    }
    const prompt = mode === 'handoff'
      ? buildHandoffPrompt({ goal, summary, contextFiles, planPath, plan })
      : [goal, summary ? `\n【补充上下文】\n${summary}` : '', contextFiles?.length ? `\n【参考文件】\n${contextFiles.map((f) => `- ${f}`).join('\n')}` : ''].filter(Boolean).join('\n')

    const started = this._now()
    const res = await adapter.run({
      role: mode === 'handoff' ? 'handoff' : 'worker-medium',
      cwd,
      prompt,
      readonly: mode === 'handoff' ? true : Boolean(readonly),
      externalSessionId: conversationId || undefined,
      model: model || undefined,
      reasoningEffort: reasoningEffort || undefined,
      timeoutMs: liveConfig.timeoutMs,
      backendOptions: {},
      signal
    })
    this._metrics.recordEvent('dispatch_external', {
      rootSessionId,
      role: mode === 'handoff' ? 'handoff' : 'external-worker',
      backend: backendId,
      mode,
      externalSessionId: res.externalSessionId || '',
      stopReason: res.stopReason,
      ms: this._now() - started,
      usage: res.usage
    })
    return {
      backend: backendId,
      mode,
      stopReason: res.stopReason,
      externalSessionId: res.externalSessionId || '',
      resumeHint: res.resumeHint || '',
      text: res.text || '',
      diagnostic: res.diagnostic || ''
    }
  }

  /** 解析指定预设名供 delegate 使用。 */
  async resolvePreset(presetId) {
    return resolveOptionalPreset(this._ctx, presetId)
  }

  _requireSubagents(op) {
    const subagents = typeof this._ctx.get === 'function' ? this._ctx.get('subagents') : undefined
    if (!subagents || typeof subagents.startActivation !== 'function') {
      const err = new Error(`[runner.${op}] target=subagents error_code=SUBAGENTS_UNAVAILABLE: subagents service is not mounted`)
      err.code = 'SUBAGENTS_UNAVAILABLE'
      throw err
    }
    return subagents
  }

  _requireExternalAdapter(backendId, op) {
    const adapter = this._backends.get(backendId)
    if (!adapter) {
      const err = new Error(
        `[runner.${op}] target=${backendId} error_code=BACKEND_NOT_FOUND: external backend "${backendId}" is not registered (installed: ${this._backends.list().map((b) => b.id).join(', ') || 'none'})`
      )
      err.code = 'BACKEND_NOT_FOUND'
      throw err
    }
    return adapter
  }

  _extractValidPlan(structured, rawText, origin) {
    const candidate = structured || extractJsonFromText(rawText)
    const checked = validatePlanObject(candidate)
    if (!checked.ok) {
      const err = new Error(
        `[${origin}] target=plan error_code=INVALID_PLAN_SCHEMA: ${checked.errors.join('; ')}`
      )
      err.code = 'INVALID_PLAN_SCHEMA'
      throw err
    }
    return checked.plan
  }

  _extractValidReview(structured, rawText, origin) {
    const candidate = structured || extractJsonFromText(rawText)
    const checked = validateReviewObject(candidate)
    if (!checked.ok) {
      const err = new Error(
        `[${origin}] target=review error_code=INVALID_REVIEW_SCHEMA: ${checked.errors.join('; ')}`
      )
      err.code = 'INVALID_REVIEW_SCHEMA'
      throw err
    }
    return checked.review
  }
}
