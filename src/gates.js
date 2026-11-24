// 三道宿主级硬门禁 + 只读子代理全局写工具兜底拦截 + 兼容长尾提醒
// 严格遵循 V2/V3/V4 探针实测结论：
//  1. 绝不拦截外层 PTC transport `run_code`，仅拦截其内部嵌套工具；
//  2. 所有 guard 逻辑包 try/catch，异常记录日志并放行，永不把正常调用炸毁；
//  3. Format v4 严禁 source.kind === "plugin"，本插件一律使用专属 producer-owned kind。
import { appendTextLine } from './metrics.js'

const WRITE_OR_MUTATION_TOOLS = new Set([
  'write',
  'edit',
  'write_file',
  'edit_file',
  'delete_file',
  'remove_file'
])

const READONLY_CHILD_DENIED_TOOLS = new Set([
  'write',
  'edit',
  'write_file',
  'edit_file',
  'delete_file',
  'remove_file',
  'pwsh',
  'bash',
  'persistent_pwsh',
  'persistent_bash',
  'run_command',
  'subagent',
  'subagent_fork',
  'delegate',
  'dispatch_external'
])

const STALL_ALLOWED_ESCAPE_TOOLS = new Set([
  'request_plan',
  'ask_expert',
  'ask_user_question',
  'dispatch_external'
])

const DELIVERY_TOOLS = new Set([
  'present'
])

const PLAN_GATE_EXEMPT_TOOLS = new Set([
  'read',
  'read_file',
  'read_image',
  'grep',
  'glob',
  'web_search',
  'web_fetch',
  'list_agents',
  'list_subagent_models',
  'request_plan',
  'request_review',
  'ask_expert',
  'ask_user_question',
  'dispatch_external',
  'todo_write',
  'progress_update'
])

function sessionIdOf(agent) {
  if (!agent) return ''
  return (agent.session && agent.session.id) || agent.id || ''
}

function isSubagent(agent) {
  return Boolean(agent && agent.session && agent.session.header && agent.session.header.parentSession)
}

function buildSteerUserMessage(text, sourceKind, summary) {
  return {
    id: `${sourceKind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: {
      kind: sourceKind,
      form: 'notice',
      summary
    }
  }
}

export function installWorkflowGates({ ctx, getConfig, stateStore, runner, metrics, isInExpert, logger = null }) {
  const disposers = []
  let seq = 0
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

  // ── 1. 核心 tools.guard（同步单调拒绝：返回字符串拒绝，undefined 放行） ──
  disposers.push(ctx.tools.guard((exec) => {
    try {
      if (!exec || !exec.agent) return undefined
      const toolName = String(exec.name || '')
      // PTC 模式下外层 run_code 必须始终放行，只校验内部嵌套工具调用
      if (toolName === 'run_code') return undefined

      const live = getConfig()
      const agent = exec.agent
      const sid = sessionIdOf(agent)

      // 0 号铁律：只读子代理全局写工具兜底硬拒绝（解决 V2 实测发现的 childInheritsGlobalTools）
      if (sid && runner.readonlyChildIds.has(sid)) {
        if (READONLY_CHILD_DENIED_TOOLS.has(toolName)) {
          metrics.recordEvent('gate-denied', {
            rootSessionId: agent.session?.header?.parentSession || sid,
            sessionId: sid,
            gate: 'readonly-child-guard',
            toolName
          })
          return `只读隔离拒绝：你当前是只读子代理，禁止调用写入/执行/委派工具 "${toolName}"。请只使用读取与搜索类工具，并将结论直接返回给调用方。`
        }
        return undefined
      }

      // 其余子代理（如 medium 施工子代理）不套用主会话三轨门禁
      if (isSubagent(agent)) return undefined

      // 专家同步调用期间不污染计数
      const bucket = bucketOf(agent)
      if (isInExpert()) {
        appendTextLine(live.debugLog, `tool=${toolName} bucket=${bucket.id} inExpert=1 skipped`, logger)
        return undefined
      }

      bucket.count += 1
      appendTextLine(live.debugLog, `tool=${toolName} count=${bucket.count} bucket=${bucket.id} inExpert=0`, logger)

      if (!live.workflow.enabled) {
        // 工作流关闭时，仅保留原 0.2.x 长尾软提醒兼容
        if (live.reminder.enabled && bucket.count % live.reminder.threshold === 0 && typeof agent.inject === 'function') {
          agent.inject(buildSteerUserMessage(
            String(live.reminder.text).replace('{n}', String(bucket.count)),
            'dsh-tiered-workflow-reminder',
            `已连续 ${bucket.count} 次工具调用提醒`
          ))
          appendTextLine(live.debugLog, `reminder injected at count=${bucket.count} bucket=${bucket.id}`, logger)
        }
        return undefined
      }

      const presetId = agent.session && agent.session.header ? agent.session.header.agentPreset || '' : ''
      const state = stateStore.getOrCreate(sid || `bucket-${bucket.id}`, { agentPreset: presetId })

      // 先执行门禁检查，再计入本轮调用（防止被拒的逃生工具本身把自己卡死）
      if (STALL_ALLOWED_ESCAPE_TOOLS.has(toolName)) {
        // 用户主动求助或重新规划时直接放行
        if (toolName === 'ask_user_question') stateStore.resetStall(state)
        return undefined
      }

      // ── 门禁 2 · §12 止损熔断门禁（最高优先级，阻断原地打转） ──
      if (live.gates.stallBreaker && state.stalled && !state.humanOverride.skipStall) {
        state.guardDeniesInTurn += 1
        metrics.recordEvent('gate-denied', {
          rootSessionId: state.sessionId,
          gate: 'stall-breaker',
          toolName,
          reason: state.stallReason,
          denyCount: state.guardDeniesInTurn
        })
        const planMode = state.plannerSession ? 'followup' : 'new'
        return [
          `止损熔断（${state.stallReason}）：禁止继续调用 "${toolName}" 原地试错。`,
          `下一步请二选一：`,
          `1) 调用 request_plan({ mode: "${planMode}", ${planMode === 'followup' ? 'feedback: "卡点说明", evidence: "报错原文"' : 'goal: "目标", pointers: ["相关路径"]'} }) 让只读规划器重新定方向；`,
          `2) 调用 ask_user_question 向用户汇报已试方案、失败原因与候选路径等待裁决（若需强制继续，请用户在对话中回复「跳过门禁」）。`
        ].join(' ')
      }

      // ── 门禁 1 · 规划门禁（轨 C 未生成 plan.json 前禁止写文件） ──
      if (live.gates.planGate && state.track === 'C' && !state.plan && !state.humanOverride.skipPlan) {
        if (WRITE_OR_MUTATION_TOOLS.has(toolName) && !PLAN_GATE_EXEMPT_TOOLS.has(toolName)) {
          state.guardDeniesInTurn += 1
          metrics.recordEvent('gate-denied', {
            rootSessionId: state.sessionId,
            gate: 'plan-gate',
            toolName,
            denyCount: state.guardDeniesInTurn
          })
          return `规划门禁拒绝：当前任务处于轨 C 且尚未生成 plan.json，禁止调用 "${toolName}" 修改文件。下一步请先调用 request_plan({ mode: "new", goal: "用户目标", pointers: ["相关文件路径"] }) 产出规划方案后再施工（或在对话中请用户回复「跳过规划」放行）。`
        }
      }

      // ── 门禁 3A · 交付工具复审门禁（拦截 present） ──
      if (live.gates.reviewGate && DELIVERY_TOOLS.has(toolName) && !state.humanOverride.skipReview) {
        const needsReview = shouldRequireReview(state)
        if (needsReview && state.lastReviewVerdict !== 'pass') {
          state.guardDeniesInTurn += 1
          metrics.recordEvent('gate-denied', {
            rootSessionId: state.sessionId,
            gate: 'review-gate-tool',
            toolName,
            track: state.track,
            denyCount: state.guardDeniesInTurn
          })
          const scope = state.track === 'B' ? 'research' : 'engineering'
          return `复审门禁拒绝：当前轨 ${state.track} 尚未通过独立复审，禁止调用 "${toolName}" 交付。下一步请先调用 request_review({ scope: "${scope}", summary: "交付摘要", artifactPaths: [...], commandEvidence: "..." })，通过后再交付（或请用户回复「跳过复审」）。`
        }
      }

      // 记录此次放行的工具调用（会自动判定是否触发 web 入轨 B 或达到 §12 步数熔断阈值）
      stateStore.recordToolCall(state, toolName, exec.arguments)

      // 兼容旧版软提醒：仅当 stallBreaker 关闭且 reminder 开启时触发
      if (!live.gates.stallBreaker && live.reminder.enabled && bucket.count % live.reminder.threshold === 0 && typeof agent.inject === 'function') {
        agent.inject(buildSteerUserMessage(
          String(live.reminder.text).replace('{n}', String(bucket.count)),
          'dsh-tiered-workflow-reminder',
          `已连续 ${bucket.count} 次工具调用提醒`
        ))
        appendTextLine(live.debugLog, `reminder injected at count=${bucket.count} bucket=${bucket.id}`, logger)
      }
    } catch (error) {
      logger?.warn?.(
        `[gates.toolsGuard] error_code=GUARD_ERR: ${error instanceof Error ? error.message : String(error)}`
      )
    }
    return undefined
  }))

  // ── 2. 监听根会话工具结果，检测 §12 失败型熔断（连续失败 ≥3 次） ──
  if (typeof ctx.on === 'function') {
    disposers.push(ctx.on('session/event', (session, event) => {
      try {
        if (!session || !event) return
        if (session.header && session.header.parentSession) return
        if (event.type !== 'tool/result') return
        const state = stateStore.get(session.id)
        if (!state) return
        const msg = event.data && event.data.message
        const isError = Boolean(event.data && (event.data.error || event.data.isError || (msg && msg.isError)))
        const toolName = (event.data && event.data.name) || (msg && msg.name) || 'tool'
        stateStore.recordToolOutcome(state, toolName, isError)
      } catch {}
    }))

    // ── 3. 门禁 3B · agent/turn-stopping 拦截纯文本直接跳过复审（V4 实测通路） ──
    disposers.push(ctx.on('agent/turn-stopping', async ({ agent, turn }) => {
      try {
        if (!agent || isSubagent(agent)) return
        const live = getConfig()
        if (!live.workflow.enabled || !live.gates.reviewGate) return
        const sid = sessionIdOf(agent)
        const state = stateStore.get(sid)
        if (!state || state.humanOverride.skipReview) return
        if (!shouldRequireReview(state)) return
        if (state.lastReviewVerdict === 'pass') return

        const maxRetries = live.workflow.maxReviewRetries
        if (state.reviewSteerCountInTurn >= maxRetries) {
          metrics.recordEvent('review-gate-released', {
            rootSessionId: state.sessionId,
            turn,
            track: state.track,
            steerCount: state.reviewSteerCountInTurn,
            reason: 'maxReviewRetries reached'
          })
          return
        }

        const scope = state.track === 'B' ? 'research' : 'engineering'
        const steerText = [
          `[复审门禁·未通过独立复审] 当前任务处于轨 ${state.track} 且尚未通过独立复审，暂不能直接收尾交付。`,
          `请立刻调用 request_review({ scope: "${scope}", summary: "交付摘要", ${scope === 'research' ? 'draftText: "待交付调研正文"' : 'artifactPaths: ["改动文件路径"], commandEvidence: "实跑输出"'} }) 完成独立验收。`,
          state.reviewGaps.length > 0 ? `上一轮复审缺口：${state.reviewGaps.join('；')}` : ''
        ].filter(Boolean).join('\n')

        if (typeof agent.steer === 'function') {
          agent.steer(buildSteerUserMessage(
            steerText,
            'dsh-tiered-workflow-review-gate',
            `轨 ${state.track} 交付前独立复审门禁`
          ))
          state.reviewSteerCountInTurn += 1
          metrics.recordEvent('review-gate-steered', {
            rootSessionId: state.sessionId,
            turn,
            track: state.track,
            steerCount: state.reviewSteerCountInTurn
          })
        }
      } catch (error) {
        logger?.warn?.(
          `[gates.turnStopping] error_code=STEER_ERR: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    }))

    // 新回合第 1 步重置 bucket 计数（兼容旧逻辑）
    disposers.push(ctx.on('agent/pre-step', (payload, next) => {
      try {
        if (payload && payload.agent && payload.step === 1) {
          const bucket = bucketOf(payload.agent)
          bucket.count = 0
          appendTextLine(getConfig().debugLog, `turn-reset bucket=${bucket.id}`, logger)
        }
      } catch {}
      return typeof next === 'function' ? next() : undefined
    }))
  }

  return () => {
    for (const d of disposers) {
      try { d?.() } catch {}
    }
  }
}

/**
 * 精准判定当前会话是否已进入“需要交付前独立复审”阶段，避免闲聊或首轮提问被误拦：
 * - 轨 B：本轮实际触发过联网/工具调用（toolCallsSinceReset > 0）；
 * - 轨 C：已经生成过 plan 或已经修改过至少一个文件。
 */
export function shouldRequireReview(state) {
  if (!state) return false
  if (state.track === 'B') {
    return state.toolCallsSinceReset > 0
  }
  if (state.track === 'C') {
    return Boolean(state.plan) || Object.keys(state.modifiedFiles || {}).length > 0
  }
  return false
}
