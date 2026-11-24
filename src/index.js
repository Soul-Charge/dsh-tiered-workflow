// dsh-tiered-workflow（当前运行包名兼容 dsh-expert-bridge）
//
// 多模型分档分工与宿主级硬门禁工作流框架：
//  * 一模多档角色池（模型 × reasoningEffort × backend × tag）
//  * Cordis 根服务 `tieredWorkflow` 暴露 ExternalBackendAdapter v1 通用适配口（支持热插拔外部后端如 Antigravity）
//  * 三轨渐进状态机 + 三道宿主硬门禁（规划门禁 / §12 止损熔断 / 交付独立复审含 turn-stopping 拦截）+ 人类逃生阀
//  * 全局 session/event 实时 6 维互斥 TokenUsage 聚合记账
//
// 平台硬约束：绝不使用 `export default`（cordis-plugin-loader 会将 exports 覆盖为 exports.default，顶掉 Config 导致设置页消失）。
import { Config, readLiveConfig } from './config.js'
import { ExternalBackendRegistry, createTieredWorkflowService } from './backends.js'
import { MetricsRecorder } from './metrics.js'
import { WorkflowStateStore } from './state.js'
import { WorkflowRunner } from './runner.js'
import { installWorkflowGates } from './gates.js'
import { registerWorkflowTools } from './tools.js'

export const name = 'expert-bridge'
export const inject = ['tools']
export { Config }

export function apply(ctx, config = {}) {
  let inExpert = false
  const logger = ctx && ctx.logger ? ctx.logger : null
  const getConfig = () => readLiveConfig(config)

  // 1. 通用外部后端适配口注册表（Cordis `tieredWorkflow` 服务）
  const backendRegistry = new ExternalBackendRegistry(logger)
  const tieredWorkflowService = createTieredWorkflowService(backendRegistry)
  if (typeof ctx.provide === 'function' && typeof ctx.set === 'function') {
    ctx.provide('tieredWorkflow')
    ctx.set('tieredWorkflow', tieredWorkflowService)
  }

  // 2. 6 维全树实时观测与状态机
  const metrics = new MetricsRecorder({ getConfig, logger })
  const stateStore = new WorkflowStateStore({ getConfig, logger })
  const runner = new WorkflowRunner({ ctx, backendRegistry, metrics, stateStore, logger })

  const disposers = [
    metrics.attach(ctx),
    stateStore.attach(ctx),
    runner.attach(ctx),
    installWorkflowGates({
      ctx,
      getConfig,
      stateStore,
      runner,
      metrics,
      isInExpert: () => inExpert,
      logger
    }),
    registerWorkflowTools({
      ctx,
      getConfig,
      backendRegistry,
      stateStore,
      metrics,
      runner,
      onExpertToggle: (flag) => { inExpert = Boolean(flag) }
    })
  ]

  // 卸载时清理全部监听与工具注册
  if (typeof ctx.on === 'function') {
    ctx.on('dispose', () => {
      for (const d of disposers) {
        try { d?.() } catch {}
      }
    })
  }

  // 返回内部句柄方便自动化测试直接检视（Cordis 会忽略 apply 的普通对象返回值）
  return {
    tieredWorkflow: tieredWorkflowService,
    backendRegistry,
    metrics,
    stateStore,
    runner
  }
}
