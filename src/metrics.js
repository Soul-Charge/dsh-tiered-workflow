// 6 维互斥 TokenUsage 采集 + 全链路观测记账（workflow-metrics.jsonl / usageLog）
// 依据 V5 探针实测：dsh-llm 的 TokenUsage 6 字段互斥（inputTokens 仅为未缓存输入），
// 且 finish.reason 是对象 { kind, ... }，必须取 finish.reason.kind 避免 "[object Object]"。
import fs from 'node:fs'
import path from 'node:path'

/** 规范化 FinishReason，兼容对象 { kind } 与字符串。 */
export function extractFinishKind(finish) {
  if (!finish) return 'unknown'
  const reason = typeof finish === 'object' && 'reason' in finish ? finish.reason : finish
  if (typeof reason === 'string' && reason.trim()) return reason.trim()
  if (reason && typeof reason === 'object' && typeof reason.kind === 'string' && reason.kind.trim()) {
    return reason.kind.trim()
  }
  return 'unknown'
}

/** 规范化 6 维互斥 TokenUsage（仅保留有效非负数值字段，不伪造缺失项）。 */
export function normalizeUsage(raw) {
  if (!raw || typeof raw !== 'object') return null
  const out = {}
  const keys = ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens', 'reasoningTokens', 'totalTokens']
  let any = false
  for (const key of keys) {
    const val = raw[key]
    if (typeof val === 'number' && Number.isFinite(val) && val >= 0) {
      out[key] = val
      any = true
    }
  }
  if (!any) return null
  // 顺手计算 billedInputTokens（未缓存 + 缓存读 + 缓存写），方便后续直看账单，不覆盖原始字段
  if (out.inputTokens !== undefined || out.cacheReadTokens !== undefined || out.cacheWriteTokens !== undefined) {
    out.billedInputTokens = (out.inputTokens || 0) + (out.cacheReadTokens || 0) + (out.cacheWriteTokens || 0)
  }
  return out
}

export function appendJsonLine(filePath, record, logger = null) {
  if (!filePath) return false
  try {
    const dir = path.dirname(filePath)
    if (dir) fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(filePath, JSON.stringify(record) + '\n', 'utf8')
    return true
  } catch (error) {
    logger?.warn?.(
      `[metrics.appendJsonLine] target=${filePath} error_code=IO_ERROR: ${error instanceof Error ? error.message : String(error)}`
    )
    return false
  }
}

export function appendTextLine(filePath, line, logger = null) {
  if (!filePath) return false
  try {
    const dir = path.dirname(filePath)
    if (dir) fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(filePath, line + '\n', 'utf8')
    return true
  } catch (error) {
    logger?.warn?.(
      `[metrics.appendTextLine] target=${filePath} error_code=IO_ERROR: ${error instanceof Error ? error.message : String(error)}`
    )
    return false
  }
}

/**
 * 实时观测器：
 * 1. 通过全局 session/event 零读盘捕获父子整树全部 LLM 步的 6 维 TokenUsage；
 * 2. 通过 childId → { rootSessionId, role, profileName } 注册表把每个子代理归属到根会话与具体角色；
 * 3. 同时接收外部后端（ExternalBackendAdapter）与 ask_expert 的显式记账写入 workflow-metrics.jsonl。
 */
export class MetricsRecorder {
  constructor({ getConfig, logger = null, now = () => Date.now() }) {
    this._getConfig = getConfig
    this._logger = logger
    this._now = now
    // sessionId -> { rootSessionId, role, profileName, backend }
    this._sessionMeta = new Map()
    // rootSessionId -> 内存汇总计数（供状态查看与测试断言）
    this._totals = new Map()
  }

  /** 为一个子代理会话登记角色与根会话归属，供 session/event 实时归账。 */
  tagSession(sessionId, meta) {
    if (!sessionId) return
    this._sessionMeta.set(sessionId, {
      rootSessionId: meta.rootSessionId || sessionId,
      role: meta.role || 'unknown',
      profileName: meta.profileName || '',
      backend: meta.backend || 'dsh-spawn'
    })
  }

  /** 绑定全局 session/event 监听器，返回 disposer。 */
  attach(ctx) {
    if (!ctx || typeof ctx.on !== 'function') return () => {}
    return ctx.on('session/event', (session, event) => {
      try {
        if (!session || !event) return
        if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return
        const usage = normalizeUsage(event.data && event.data.usage)
        if (!usage) return

        const sessionId = session.id || ''
        const parentId = session.header && session.header.parentSession ? session.header.parentSession : null
        const tagged = this._sessionMeta.get(sessionId)
        const rootSessionId = tagged ? tagged.rootSessionId : (parentId || sessionId)
        const role = tagged ? tagged.role : (parentId ? 'subagent' : 'main')
        const headerCfg = typeof session.requestHeader === 'function' ? session.requestHeader()?.config : null
        const route = headerCfg && headerCfg.provider && headerCfg.model
          ? { provider: headerCfg.provider, model: headerCfg.model, reasoningEffort: headerCfg.reasoningEffort || '' }
          : null

        this._accumulate(rootSessionId, role, usage)

        const cfg = this._getConfig()
        const target = cfg.workflow.metricsLog
        if (target) {
          appendJsonLine(target, {
            ts: new Date(this._now()).toISOString(),
            kind: 'llm-step',
            sessionId,
            rootSessionId,
            parentSession: parentId,
            role,
            profileName: tagged ? tagged.profileName : '',
            backend: tagged ? tagged.backend : 'dsh-spawn',
            eventType: event.type,
            route,
            usage
          }, this._logger)
        }
      } catch (error) {
        this._logger?.warn?.(
          `[metrics.sessionEvent] error_code=EVENT_PARSE_ERROR: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    })
  }

  /** 记录一次工作流角色调用、外部后端调用或门禁事件。 */
  recordEvent(kind, fields) {
    const cfg = this._getConfig()
    const usage = fields && fields.usage ? normalizeUsage(fields.usage) : null
    if (usage && fields.rootSessionId) {
      this._accumulate(fields.rootSessionId, fields.role || kind, usage)
    }
    const payload = {
      ts: new Date(this._now()).toISOString(),
      kind,
      ...fields,
      ...(usage ? { usage } : {})
    }
    if (cfg.workflow.metricsLog) {
      appendJsonLine(cfg.workflow.metricsLog, payload, this._logger)
    }
    return payload
  }

  /** 兼容旧版 expert-usage.jsonl（修复 finish.reason.kind 与 6 维 usage）。 */
  recordExpertUsage(fields) {
    const cfg = this._getConfig()
    const usage = fields && fields.usage ? normalizeUsage(fields.usage) : null
    const payload = {
      ts: new Date(this._now()).toISOString(),
      executor: fields.executor || '',
      expert: fields.expert || '',
      expertName: fields.expertName || '',
      reasoningEffort: fields.reasoningEffort || '',
      need: fields.need || '',
      matched: Boolean(fields.matched),
      packageChars: fields.packageChars || 0,
      answerChars: fields.answerChars || 0,
      ...(usage || {}),
      finish: extractFinishKind(fields.finish),
      ms: fields.ms || 0
    }
    if (cfg.usageLog) {
      appendJsonLine(cfg.usageLog, payload, this._logger)
    }
    if (cfg.workflow.metricsLog) {
      appendJsonLine(cfg.workflow.metricsLog, { kind: 'ask_expert', ...payload }, this._logger)
    }
    return payload
  }

  /** 查询某根会话内存聚合 token（供测试与状态诊断）。 */
  getSessionSummary(rootSessionId) {
    const entry = this._totals.get(rootSessionId)
    if (!entry) return null
    return structuredClone(entry)
  }

  _accumulate(rootSessionId, role, usage) {
    if (!rootSessionId) return
    let entry = this._totals.get(rootSessionId)
    if (!entry) {
      entry = {
        steps: 0,
        inputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        totalTokens: 0,
        byRole: {}
      }
      this._totals.set(rootSessionId, entry)
    }
    const add = (target) => {
      target.steps += 1
      target.inputTokens += usage.inputTokens || 0
      target.cacheReadTokens += usage.cacheReadTokens || 0
      target.cacheWriteTokens += usage.cacheWriteTokens || 0
      target.outputTokens += usage.outputTokens || 0
      target.reasoningTokens += usage.reasoningTokens || 0
      target.totalTokens += usage.totalTokens || ((usage.billedInputTokens || 0) + (usage.outputTokens || 0))
    }
    add(entry)
    if (!entry.byRole[role]) {
      entry.byRole[role] = { steps: 0, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 }
    }
    add(entry.byRole[role])
  }
}
