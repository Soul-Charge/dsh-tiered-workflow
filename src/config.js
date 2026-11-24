// 配置模型（向后兼容 0.2.x）+ 模型×推理强度一模多档路由选择
import z from '@deepseek-ai/schemastery'

export const DEFAULT_REMINDER_TEXT = '[系统提醒·非用户输入] 本回合你已连续 {n} 次工具调用而没有向用户汇报。先自查是否已满足求助条件（同一症状第 2 次出现 / 曾宣称修好又复现 / 用户说过治标或换过 3 种说法 / 已证伪假设没有新增）。满足就按 CONSULT-TEMPLATE.md 组织求助包后调用 ask_expert；不满足就继续，但别重复同一条路。'

export const DSH_SPAWN_BACKEND = 'dsh-spawn'

/**
 * 统一能力档位路由（支持一模多档：同模型不同 reasoningEffort / maxTokens / tier / backend）。
 * 兼容旧版 ExpertRoute 与 HelperRoute（缺省字段自动填默认值）。
 */
const ProfileRoute = z.object({
  name: z.string().default(''),
  backend: z.string().default(DSH_SPAWN_BACKEND),
  provider: z.string().default(''),
  model: z.string().default(''),
  reasoningEffort: z.string().default(''),
  maxTokens: z.number().default(0),
  tier: z.string().default('standard'),
  tags: z.array(z.string()).default([]),
  note: z.string().default(''),
  systemPrompt: z.string().default(''),
  backendOptions: z.any().default({})
})

const HelperRoute = z.object({
  name: z.string().default(''),
  backend: z.string().default(DSH_SPAWN_BACKEND),
  provider: z.string().default(''),
  model: z.string().default(''),
  reasoningEffort: z.string().default(''),
  maxTokens: z.number().default(0),
  tier: z.string().default('standard'),
  tags: z.array(z.string()).default([]),
  note: z.string().default(''),
  backendOptions: z.any().default({})
})

/**
 * DSH 设置命名空间 schema。
 * 硬约束：volatile 不能嵌套，也不能标在数组元素上；数组必须整数组 .volatile()。
 */
export const Config = z.object({
  // ── 0.2.x 原有字段（完全兼容） ──
  experts: z.array(ProfileRoute).default([]).volatile(),
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
    text: z.string().default(DEFAULT_REMINDER_TEXT)
  }).default({}),

  // ── V2 新增角色池（模型 × 推理强度 × 后端） ──
  planners: z.array(ProfileRoute).default([]).volatile(),
  reviewers: z.array(ProfileRoute).default([]).volatile(),

  // ── V2 工作流与观测配置 ──
  workflow: z.object({
    enabled: z.boolean().default(true).volatile(),
    defaultTrack: z.string().default('auto').volatile(),
    readonlyPreset: z.string().default('').volatile(),
    execPreset: z.string().default('').volatile(),
    maxPlannerFollowups: z.number().default(3).volatile(),
    maxReviewRetries: z.number().default(2).volatile(),
    preambleFile: z.string().default(''),
    stateDir: z.string().default(''),
    metricsLog: z.string().default('')
  }).default({}),

  // ── V2 三道宿主硬门禁（阈值默认对齐全局 AGENTS.md §12） ──
  gates: z.object({
    planGate: z.boolean().default(true).volatile(),
    stallBreaker: z.boolean().default(true).volatile(),
    stallToolThreshold: z.number().default(20).volatile(),
    stallConsecutiveFailures: z.number().default(3).volatile(),
    reviewGate: z.boolean().default(true).volatile()
  }).default({})
})

// ── 配置安全解包（volatile 叶子是 cosmokit Ref，每次读取重新解包） ────────────

function isRef(value) {
  return value !== null && typeof value === 'object' && typeof value.get === 'function'
}

export function plain(value) {
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

function nonNegative(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

function str(value, fallback = '') {
  return typeof value === 'string' ? value : fallback
}

function plainObject(value) {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const out = {}
    for (const key of Object.keys(value)) out[key] = plain(value[key])
    return out
  }
  return {}
}

export function normalizeRoute(raw, withSystemPrompt) {
  const r = raw !== null && typeof raw === 'object' ? raw : {}
  const backendRaw = str(r.backend).trim()
  const tierRaw = str(r.tier).trim().toLowerCase()
  const route = {
    name: str(r.name).trim(),
    backend: backendRaw || DSH_SPAWN_BACKEND,
    provider: str(r.provider).trim(),
    model: str(r.model).trim(),
    reasoningEffort: str(r.reasoningEffort).trim(),
    maxTokens: nonNegative(r.maxTokens, 0),
    tier: tierRaw === 'deep' ? 'deep' : 'standard',
    tags: Array.isArray(r.tags) ? r.tags.map((t) => String(t).trim()).filter(Boolean) : [],
    note: str(r.note),
    backendOptions: plainObject(r.backendOptions)
  }
  if (withSystemPrompt) route.systemPrompt = str(r.systemPrompt)
  return route
}

export function normalizeRoutes(value, withSystemPrompt) {
  return Array.isArray(value) ? value.map((raw) => normalizeRoute(raw, withSystemPrompt)) : []
}

export function readLiveConfig(config) {
  const c = config !== null && typeof config === 'object' ? config : {}
  const delegates = plain(c.delegates) || {}
  const reminder = plain(c.reminder) || {}
  const workflow = plain(c.workflow) || {}
  const gates = plain(c.gates) || {}
  const defaultTrackRaw = str(workflow.defaultTrack, 'auto').trim().toUpperCase()
  const defaultTrack = ['A', 'B', 'C'].includes(defaultTrackRaw) ? defaultTrackRaw : 'auto'

  return {
    experts: normalizeRoutes(plain(c.experts), true),
    planners: normalizeRoutes(plain(c.planners), true),
    reviewers: normalizeRoutes(plain(c.reviewers), true),
    low: normalizeRoutes(delegates.low, false),
    medium: normalizeRoutes(delegates.medium, false),
    maxTokens: positive(plain(c.maxTokens), 8000),
    timeoutMs: positive(plain(c.timeoutMs), 150000),
    minPackageChars: nonNegative(plain(c.minPackageChars), 600),
    systemPromptFile: str(c.systemPromptFile).trim(),
    usageLog: str(c.usageLog).trim(),
    debugLog: str(c.debugLog).trim(),
    reminder: {
      enabled: reminder.enabled !== false,
      threshold: positive(reminder.threshold, 47),
      text: str(reminder.text) || DEFAULT_REMINDER_TEXT
    },
    workflow: {
      enabled: workflow.enabled !== false,
      defaultTrack,
      readonlyPreset: str(workflow.readonlyPreset).trim(),
      execPreset: str(workflow.execPreset).trim(),
      maxPlannerFollowups: positive(workflow.maxPlannerFollowups, 3),
      maxReviewRetries: nonNegative(workflow.maxReviewRetries, 2),
      preambleFile: str(workflow.preambleFile).trim(),
      stateDir: str(workflow.stateDir).trim(),
      metricsLog: str(workflow.metricsLog).trim()
    },
    gates: {
      planGate: gates.planGate !== false,
      stallBreaker: gates.stallBreaker !== false,
      stallToolThreshold: positive(gates.stallToolThreshold, 20),
      stallConsecutiveFailures: positive(gates.stallConsecutiveFailures, 3),
      reviewGate: gates.reviewGate !== false
    }
  }
}

export function routeLabel(route) {
  if (route.name) return route.name
  const base = route.backend && route.backend !== DSH_SPAWN_BACKEND
    ? route.backend + (route.model ? ':' + route.model : '')
    : route.provider + '/' + route.model
  return route.reasoningEffort ? `${base} [${route.reasoningEffort}]` : base
}

/**
 * 校验一条路由在当前环境下是否可执行：
 * - dsh-spawn 后端要求 provider 与 model 均非空；
 * - 外部后端要求已在 ExternalBackendRegistry 中注册（model 可选）。
 */
export function isRouteUsable(route, backendRegistry) {
  if (!route) return false
  if (route.backend === DSH_SPAWN_BACKEND) {
    return Boolean(route.provider && route.model)
  }
  return Boolean(backendRegistry && typeof backendRegistry.has === 'function' && backendRegistry.has(route.backend))
}

/**
 * 确定性一模多档选路器：
 * 1. 先按可用性过滤；
 * 2. 若指定 preferredBackend，先收敛到该后端（无命中则回落全体可用）；
 * 3. 若指定 depth（'normal' | 'deep'），优先匹配对应 tier（'standard' | 'deep'）；
 * 4. 在目标池内按 need（大小写不敏感精确匹配 tags）选第一条；未命中则取目标池第一条。
 */
export function pickProfile(routes, options = {}) {
  const { need = '', depth = '', preferredBackend = '', backendRegistry = null } = options
  const usable = (Array.isArray(routes) ? routes : []).filter((r) => isRouteUsable(r, backendRegistry))
  if (usable.length === 0) return null

  let pool = usable
  const wantedBackend = typeof preferredBackend === 'string' ? preferredBackend.trim() : ''
  if (wantedBackend) {
    const byBackend = pool.filter((r) => r.backend === wantedBackend)
    if (byBackend.length > 0) pool = byBackend
  }

  const wantedTier = depth === 'deep' ? 'deep' : (depth === 'normal' ? 'standard' : '')
  let matchedDepth = false
  if (wantedTier) {
    const byTier = pool.filter((r) => r.tier === wantedTier)
    if (byTier.length > 0) {
      pool = byTier
      matchedDepth = true
    }
  }

  const wantedNeed = typeof need === 'string' ? need.trim().toLowerCase() : ''
  if (wantedNeed) {
    const hit = pool.find((r) => r.tags.some((t) => t.toLowerCase() === wantedNeed))
    if (hit !== undefined) {
      return { route: hit, matchedNeed: true, matchedDepth, fallback: false }
    }
  }

  return { route: pool[0], matchedNeed: false, matchedDepth, fallback: Boolean(wantedNeed) }
}
