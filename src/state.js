// 会话级三轨状态机（A/B/C 分诊特征快筛 + 人类逃生阀 + 熔断计数 + 持久化 state.json）
import fs from 'node:fs'
import path from 'node:path'

// 客观特征正则（零 LLM 成本，对齐全局 AGENTS.md §1/§3/§12 与交接实测痛点）
const EXPLICIT_TRACK_C_RE = /(先规划|走轨\s*C|先出方案|找根因|根治|彻底解决|跨文件重构|大重构|架构设计)/i
const RESEARCH_TRACK_B_RE = /(价格|定价|收费标准|倍率|最新.*版本|对比评测|竞品对比|调研报告|选型对比|会员限额|官方政策)/i
const USER_CORRECTION_RE = /(还是不对|没解决|治标不治本|治标|不对吧|又复现|没根治|别绕弯|挑.*毛病)/i

// 人类逃生阀（任何时刻显式放行，绝不锁死用户）
const SKIP_PLAN_RE = /(跳过规划|不用规划|免规划|直接改|跳过计划|skip\s+plan)/i
const SKIP_REVIEW_RE = /(跳过复审|不用复审|免复审|直接交付|跳过验收|skip\s+review)/i
const SKIP_ALL_GATES_RE = /(跳过门禁|跳过全部门禁|关掉门禁|关闭门禁|skip\s+gates)/i

export const WEB_RESEARCH_TOOLS = new Set(['web_search', 'web_fetch'])

export function extractUserText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
}

export class WorkflowStateStore {
  constructor({ getConfig, logger = null, now = () => Date.now() }) {
    this._getConfig = getConfig
    this._logger = logger
    this._now = now
    this._states = new Map()
  }

  /** 读取或初始化指定会话的状态对象（若配置了 stateDir 会尝试冷加载）。 */
  getOrCreate(sessionId, options = {}) {
    if (!sessionId) throw new Error('[WorkflowStateStore.getOrCreate] sessionId is required')
    let state = this._states.get(sessionId)
    if (state) return state

    const loaded = this._loadFromDisk(sessionId)
    if (loaded) {
      this._states.set(sessionId, loaded)
      return loaded
    }

    const cfg = this._getConfig()
    const presetId = typeof options.agentPreset === 'string' ? options.agentPreset : ''
    let initialTrack = 'A'
    if (presetId === 'core-heavy') {
      initialTrack = 'C'
    } else if (cfg.workflow.defaultTrack !== 'auto') {
      initialTrack = cfg.workflow.defaultTrack
    }

    state = {
      sessionId,
      agentPreset: presetId,
      track: initialTrack,
      escalatedFrom: null,
      escalationReason: '',
      firstUserGoal: '',
      planPath: '',
      planMdPath: '',
      planVersion: 0,
      plan: null,
      plannerSession: null, // { backend: string, sessionId: string }
      plannerTurns: 0,
      priorFalsified: [],
      reviewCount: 0,
      lastReviewVerdict: 'none', // 'none' | 'pass' | 'fail'
      reviewGaps: [],
      reviewSteerCountInTurn: 0,
      toolCallsSinceReset: 0,
      consecutiveFailures: 0,
      lastFailedTool: '',
      guardDeniesInTurn: 0,
      modifiedFiles: {}, // filePath -> edit count
      stalled: false,
      stallReason: '',
      userCorrectionCount: 0,
      humanOverride: { skipPlan: false, skipReview: false, skipStall: false },
      updatedAt: new Date(this._now()).toISOString()
    }
    this._states.set(sessionId, state)
    this._persist(state)
    return state
  }

  get(sessionId) {
    return sessionId ? this._states.get(sessionId) : undefined
  }

  /**
   * 监听全局 session/event 中的真实用户输入（仅 source.kind === 'user'），
   * 执行零成本特征快筛、纠偏升档与人类逃生阀识别。
   */
  attach(ctx) {
    if (!ctx || typeof ctx.on !== 'function') return () => {}
    const offEvent = ctx.on('session/event', (session, event) => {
      try {
        if (!session || !event) return
        // 仅追踪根会话（子代理不套用父会话的三轨状态机）
        if (session.header && session.header.parentSession) return
        if (event.type !== 'user/message') return
        const src = event.data && event.data.source
        // 严防误把插件/系统注入的消息当作用户消息
        if (src && src.kind !== 'user') return

        const text = extractUserText(event.data && event.data.content)
        if (!text.trim()) return

        const presetId = session.header && session.header.agentPreset ? session.header.agentPreset : ''
        const state = this.getOrCreate(session.id, { agentPreset: presetId })
        this.observeUserMessage(state, text)
      } catch (error) {
        this._logger?.warn?.(
          `[state.sessionEvent] error_code=USER_MSG_PARSE: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    })

    const offPreStep = ctx.on('agent/pre-step', (payload, next) => {
      try {
        if (payload && payload.agent && payload.step === 1) {
          const id = payload.agent.session ? payload.agent.session.id : payload.agent.id
          if (id && !(payload.agent.session?.header?.parentSession)) {
            const state = this._states.get(id)
            if (state) {
              state.toolCallsSinceReset = 0
              state.guardDeniesInTurn = 0
              state.reviewSteerCountInTurn = 0
              state.stalled = false
              state.stallReason = ''
              this._persist(state)
            }
          }
        }
      } catch {}
      return typeof next === 'function' ? next() : undefined
    })

    return () => {
      offEvent?.()
      offPreStep?.()
    }
  }

  /** 根据真实用户文本更新分诊轨道、纠偏计数与逃生阀。 */
  observeUserMessage(state, text) {
    if (!state.firstUserGoal) state.firstUserGoal = text.trim().slice(0, 1000)

    // 1. 人类逃生阀优先识别
    if (SKIP_ALL_GATES_RE.test(text)) {
      state.humanOverride.skipPlan = true
      state.humanOverride.skipReview = true
      state.humanOverride.skipStall = true
      state.stalled = false
    } else {
      if (SKIP_PLAN_RE.test(text)) state.humanOverride.skipPlan = true
      if (SKIP_REVIEW_RE.test(text)) state.humanOverride.skipReview = true
    }

    // 2. 纠偏信号（用户指出治标/不对/没解决）→ 计数 + 轨 A 自动升档轨 C
    if (USER_CORRECTION_RE.test(text)) {
      state.userCorrectionCount += 1
      if (state.track !== 'C') {
        state.escalatedFrom = state.track
        state.track = 'C'
        state.escalationReason = '用户纠偏/指出未根治'
      }
      // 纠偏后原有复审作废，需要重新复审
      state.lastReviewVerdict = 'none'
    }

    // 3. 客观特征快筛（仅在 auto 模式下升级，不降级）
    if (EXPLICIT_TRACK_C_RE.test(text) && state.track !== 'C') {
      state.escalatedFrom = state.track
      state.track = 'C'
      state.escalationReason = '命中轨 C 显式规划/根治特征'
    } else if (RESEARCH_TRACK_B_RE.test(text) && state.track === 'A') {
      state.track = 'B'
      state.escalationReason = '命中轨 B 调研取证特征'
    }

    this._touch(state)
    return state
  }

  /** 记录一次工具调用；触发 web 搜索时自动入轨 B，触达 §12 阈值置 stalled。 */
  recordToolCall(state, toolName, args) {
    state.toolCallsSinceReset += 1

    if (WEB_RESEARCH_TOOLS.has(toolName) && state.track === 'A') {
      state.track = 'B'
      state.escalationReason = `触发联网检索工具 ${toolName}`
    }

    // 跟踪同一文件被重复修改次数（防原地打转）
    if ((toolName === 'write' || toolName === 'edit' || toolName === 'write_file' || toolName === 'edit_file') && args && typeof args === 'object') {
      const targetPath = args.path || args.file_path || args.Path || args.filePath
      if (typeof targetPath === 'string' && targetPath.trim()) {
        const norm = targetPath.trim().replace(/\\/g, '/').toLowerCase()
        state.modifiedFiles[norm] = (state.modifiedFiles[norm] || 0) + 1
        // 一旦有新写入，旧复审结论作废
        if (state.lastReviewVerdict === 'pass') {
          state.lastReviewVerdict = 'none'
        }
      }
    }

    const cfg = this._getConfig()
    if (cfg.gates.stallBreaker && !state.humanOverride.skipStall) {
      if (state.toolCallsSinceReset >= cfg.gates.stallToolThreshold) {
        this.markStalled(state, `本回合工具调用已达 ${state.toolCallsSinceReset} 次（触发全局 §12 止损阈值 ${cfg.gates.stallToolThreshold}）`)
      }
    }

    this._touch(state)
  }

  /** 记录一次工具执行结果（用于检测 §12 失败型熔断：连续失败 ≥3 次）。 */
  recordToolOutcome(state, toolName, isError) {
    if (isError) {
      state.consecutiveFailures += 1
      state.lastFailedTool = toolName
      const cfg = this._getConfig()
      if (cfg.gates.stallBreaker && !state.humanOverride.skipStall && state.consecutiveFailures >= cfg.gates.stallConsecutiveFailures) {
        this.markStalled(state, `工具连续失败 ${state.consecutiveFailures} 次（最近：${toolName}，触发 §12 失败型熔断）`)
      }
    } else {
      state.consecutiveFailures = 0
      state.lastFailedTool = ''
    }
    this._touch(state)
  }

  markStalled(state, reason) {
    state.stalled = true
    state.stallReason = reason
    if (state.track === 'A') {
      state.escalatedFrom = 'A'
      state.track = 'C'
      state.escalationReason = reason
    }
    this._touch(state)
  }

  /** 完成一次规划、专家咨询或向用户求助后重置熔断状态。 */
  resetStall(state) {
    state.stalled = false
    state.stallReason = ''
    state.toolCallsSinceReset = 0
    state.consecutiveFailures = 0
    state.lastFailedTool = ''
    state.guardDeniesInTurn = 0
    this._touch(state)
  }

  setPlan(state, { plan, planPath, planMdPath, plannerSession, isFollowup }) {
    state.track = 'C'
    state.plan = plan
    if (planPath) state.planPath = planPath
    if (planMdPath) state.planMdPath = planMdPath
    state.planVersion = (state.planVersion || 0) + 1
    if (plannerSession) state.plannerSession = plannerSession
    state.plannerTurns = isFollowup ? (state.plannerTurns || 0) + 1 : 1
    state.lastReviewVerdict = 'none'
    this.resetStall(state)
    this._touch(state)
  }

  setReview(state, review) {
    state.reviewCount = (state.reviewCount || 0) + 1
    state.lastReviewVerdict = review.verdict
    state.reviewGaps = Array.isArray(review.gaps) ? [...review.gaps] : []
    this._touch(state)
  }

  _touch(state) {
    state.updatedAt = new Date(this._now()).toISOString()
    this._persist(state)
  }

  _stateFilePath(sessionId) {
    const cfg = this._getConfig()
    if (!cfg.workflow.stateDir) return ''
    const safe = String(sessionId).replace(/[^a-zA-Z0-9._-]/g, '_')
    return path.join(cfg.workflow.stateDir, `${safe}.json`)
  }

  _persist(state) {
    const filePath = this._stateFilePath(state.sessionId)
    if (!filePath) return
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf8')
    } catch (error) {
      this._logger?.warn?.(
        `[state.persist] target=${filePath} error_code=IO_ERROR: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  _loadFromDisk(sessionId) {
    const filePath = this._stateFilePath(sessionId)
    if (!filePath || !fs.existsSync(filePath)) return null
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
      if (parsed && typeof parsed === 'object' && parsed.sessionId === sessionId) {
        return parsed
      }
    } catch {}
    return null
  }
}
