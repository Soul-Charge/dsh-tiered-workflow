// ExternalBackendAdapter v1 通用注册表（由 Cordis 服务 `tieredWorkflow` 暴露）
// 契约严格对齐 docs/WORKFLOW-ARCHITECTURE.md §3.7 与 dsh-antigravity-adapter/docs/CONTRACT.md

export const EXTERNAL_BACKEND_CONTRACT_VERSION = 1

const REQUIRED_CAP_KEYS = ['readonlyMode', 'structuredOutput', 'continuation', 'handoff', 'usageReporting']

/**
 * 边界校验外部适配器（外部插件注册入参视为不可信输入）。
 * 失败时抛带上下文的结构化 Error（operation / target / input_summary / error_code / context）。
 */
export function validateBackendAdapter(adapter) {
  const fail = (code, detail) => {
    const idSummary = adapter && typeof adapter.id === 'string' ? adapter.id : String(typeof adapter)
    const err = new Error(
      `[tieredWorkflow.registerBackend] target=${idSummary} error_code=${code}: ${detail}`
    )
    err.code = code
    err.operation = 'tieredWorkflow.registerBackend'
    err.target = idSummary
    err.input_summary = idSummary
    err.context = { contractVersion: adapter && adapter.contractVersion }
    throw err
  }

  if (adapter === null || typeof adapter !== 'object') {
    fail('INVALID_ADAPTER', 'adapter must be a non-null object')
  }
  if (adapter.contractVersion !== EXTERNAL_BACKEND_CONTRACT_VERSION) {
    fail(
      'UNSUPPORTED_CONTRACT_VERSION',
      `expected contractVersion=${EXTERNAL_BACKEND_CONTRACT_VERSION}, got ${JSON.stringify(adapter.contractVersion)}`
    )
  }
  if (typeof adapter.id !== 'string' || !/^[a-z0-9][a-z0-9-_]{0,63}$/.test(adapter.id.trim())) {
    fail('INVALID_BACKEND_ID', 'adapter.id must match /^[a-z0-9][a-z0-9-_]{0,63}$/')
  }
  if (adapter.id.trim() === 'dsh-spawn') {
    fail('RESERVED_BACKEND_ID', 'adapter.id "dsh-spawn" is reserved for built-in DSH spawn backend')
  }
  if (typeof adapter.label !== 'string' || !adapter.label.trim()) {
    fail('INVALID_BACKEND_LABEL', 'adapter.label must be a non-empty string')
  }
  if (adapter.capabilities === null || typeof adapter.capabilities !== 'object') {
    fail('MISSING_CAPABILITIES', 'adapter.capabilities must be an object')
  }
  for (const key of REQUIRED_CAP_KEYS) {
    if (typeof adapter.capabilities[key] !== 'boolean') {
      fail('INVALID_CAPABILITY', `adapter.capabilities.${key} must be a boolean`)
    }
  }
  if (typeof adapter.run !== 'function') {
    fail('MISSING_RUN', 'adapter.run must be a function')
  }
  if (adapter.healthCheck !== undefined && typeof adapter.healthCheck !== 'function') {
    fail('INVALID_HEALTH_CHECK', 'adapter.healthCheck must be a function when provided')
  }
}

export class ExternalBackendRegistry {
  constructor(logger = null) {
    this._backends = new Map()
    this._listeners = new Set()
    this._logger = logger
  }

  /** 注册外部后端适配器，返回幂等反注册 disposer。 */
  registerBackend(adapter) {
    validateBackendAdapter(adapter)
    const id = adapter.id.trim()
    if (this._backends.has(id)) {
      const err = new Error(
        `[tieredWorkflow.registerBackend] target=${id} error_code=DUPLICATE_BACKEND: backend "${id}" is already registered`
      )
      err.code = 'DUPLICATE_BACKEND'
      err.operation = 'tieredWorkflow.registerBackend'
      err.target = id
      err.input_summary = id
      err.context = { existing: [...this._backends.keys()] }
      throw err
    }

    const frozen = Object.freeze({
      contractVersion: EXTERNAL_BACKEND_CONTRACT_VERSION,
      id,
      label: adapter.label.trim(),
      capabilities: Object.freeze({
        readonlyMode: adapter.capabilities.readonlyMode,
        structuredOutput: adapter.capabilities.structuredOutput,
        continuation: adapter.capabilities.continuation,
        handoff: adapter.capabilities.handoff,
        usageReporting: adapter.capabilities.usageReporting
      }),
      healthCheck: adapter.healthCheck ? () => adapter.healthCheck() : undefined,
      run: (req) => adapter.run(req)
    })

    this._backends.set(id, frozen)
    this._notify('registered', id)

    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      if (this._backends.get(id) === frozen) {
        this._backends.delete(id)
        this._notify('unregistered', id)
      }
    }
  }

  has(id) {
    return typeof id === 'string' && this._backends.has(id.trim())
  }

  get(id) {
    return typeof id === 'string' ? this._backends.get(id.trim()) : undefined
  }

  /** 确定性排序列出所有已注册外部后端元数据。 */
  list() {
    return [...this._backends.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((b) => ({
        contractVersion: b.contractVersion,
        id: b.id,
        label: b.label,
        capabilities: { ...b.capabilities }
      }))
  }

  size() {
    return this._backends.size
  }

  /** 订阅后端增删变化（例如按需动态注册/卸载 dispatch_external 工具）。 */
  onChange(listener) {
    this._listeners.add(listener)
    return () => { this._listeners.delete(listener) }
  }

  /** 并发检查全部已注册后端健康状态（Promise.allSettled，单后端异常不影响其余）。 */
  async healthCheckAll() {
    const entries = [...this._backends.values()].sort((a, b) => a.id.localeCompare(b.id))
    const settled = await Promise.allSettled(
      entries.map(async (b) => {
        if (!b.healthCheck) return { id: b.id, label: b.label, ok: true, detail: 'no healthCheck declared' }
        const res = await b.healthCheck()
        return {
          id: b.id,
          label: b.label,
          ok: Boolean(res && res.ok),
          version: res && typeof res.version === 'string' ? res.version : undefined,
          detail: res && typeof res.detail === 'string' ? res.detail : undefined
        }
      })
    )
    return settled.map((item, i) => {
      if (item.status === 'fulfilled') return item.value
      const b = entries[i]
      return {
        id: b.id,
        label: b.label,
        ok: false,
        detail: item.reason instanceof Error ? item.reason.message : String(item.reason)
      }
    })
  }

  _notify(event, id) {
    for (const fn of this._listeners) {
      try {
        fn({ event, id, count: this._backends.size })
      } catch (error) {
        this._logger?.warn?.(
          `[tieredWorkflow.onChange] target=${id} error_code=LISTENER_ERROR: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    }
  }
}

/** 构造暴露给 Cordis 根上下文的 `tieredWorkflow` 服务面。 */
export function createTieredWorkflowService(registry) {
  return {
    contractVersion: EXTERNAL_BACKEND_CONTRACT_VERSION,
    registerBackend: (adapter) => registry.registerBackend(adapter),
    listBackends: () => registry.list(),
    getBackend: (id) => registry.get(id),
    healthCheckAll: () => registry.healthCheckAll()
  }
}
