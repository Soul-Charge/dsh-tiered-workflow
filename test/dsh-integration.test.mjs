// 基于本机真实 DSH 0.2.1-rc.2 核心栈的端到端隔离集成测试（零外部 API 消耗、零触碰活 profile）
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import * as workflowPlugin from '../src/index.js'

const DSH_ROOT = 'C:/Program Files/nvm/v24.18.1/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'
const HAS_DSH = fs.existsSync(path.join(DSH_ROOT, 'dsh-subagent/lib/index.js'))

const imp = (pkg, sub = 'lib/index.js') => import(pathToFileURL(path.join(DSH_ROOT, pkg, sub)).href)

function makeTextStream(text, usage = { inputTokens: 100, cacheReadTokens: 800, cacheWriteTokens: 50, outputTokens: 40, reasoningTokens: 20, totalTokens: 1010 }) {
  return async function* () {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function makeToolCallStream(toolName, input, usage = { inputTokens: 120, cacheReadTokens: 600, outputTokens: 60, reasoningTokens: 30, totalTokens: 810 }) {
  return async function* () {
    const id = 'call_' + Math.random().toString(36).slice(2, 10)
    const raw = JSON.stringify(input)
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 0, id, name: toolName, argumentsDelta: raw }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: toolName, arguments: raw } }
    yield { type: 'usage', usage }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

test('DSH 0.2.1-rc.2 full-stack integration: gates, planner new/followup/deep-reopen, reviewer, external adapter, 6-field metrics', { skip: !HAS_DSH }, async () => {
  const { Context } = await imp('cordis')
  const { Loader } = await imp('cordis-plugin-loader')
  const { default: TypertRegistry } = await imp('dsh-typert-registry')
  const { default: LlmRuntime, LlmAdapter, createUserMessage } = await imp('dsh-llm')
  const { default: SystemPrompt } = await imp('dsh-system-prompt')
  const { default: SessionService } = await imp('dsh-session')
  const { default: SessionProjection } = await imp('dsh-session-projection')
  const PersistenceJsonl = await imp('dsh-session-persistence-jsonl')
  const { default: SessionQuerySqlite } = await imp('dsh-session-query-sqlite')
  const { default: FsLocal } = await imp('dsh-fs-local')
  const { default: SubprocessLocal } = await imp('dsh-subprocess-local')
  const { default: SandboxLocal } = await imp('dsh-sandbox-local')
  const { default: SandboxPolicy } = await imp('dsh-sandbox-policy')
  const { default: WorkingDirectory } = await imp('dsh-working-directory')
  const { default: ToolRuntime } = await imp('dsh-tools')
  const { default: NodePtcRuntime } = await imp('dsh-ptc-runtime-node')
  const { default: AgentRegistry } = await imp('dsh-agent')
  const { default: AgentLoop } = await imp('dsh-agent-loop')
  const { default: AgentPresetRegistry } = await imp('dsh-agent-preset-registry')
  const { default: SubagentService, STRUCTURED_OUTPUT_TOOL } = await imp('dsh-subagent')
  const SpawnInProcess = await imp('dsh-subagent-spawn-in-process')

  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tw-e2e-'))
  const sessionsDir = path.join(runDir, 'sessions')
  const workDir = path.join(runDir, 'workspace')
  const stateDir = path.join(runDir, 'state')
  const metricsLog = path.join(runDir, 'workflow-metrics.jsonl')
  const planDir = path.join(workDir, 'tasks', 'demo-fix')
  fs.mkdirSync(sessionsDir, { recursive: true })
  fs.mkdirSync(workDir, { recursive: true })

  const llmCalls = []
  const queuesByProvider = { workbuddy: [], moonshot: [], anthropic: [], minimax: [] }
  function pushFor(provider, ...handlers) {
    queuesByProvider[provider].push(...handlers)
  }
  class MockAdapter extends LlmAdapter {
    providerInfo(provider) { return { id: provider, name: provider } }
    async listModels(provider) { return [{ id: 'mock-model', name: 'mock-model', provider }] }
    async resolveModel(provider, model) {
      return {
        id: model, name: model, provider,
        context: { contextWindow: 200000, maxOutputTokens: 16000 },
        reasoning: { efforts: ['low', 'medium', 'high', 'max'].map((id) => ({ id, name: id })), defaultEffort: 'medium' }
      }
    }
    async *stream(options) {
      llmCalls.push({
        provider: options.provider,
        model: options.model,
        reasoningEffort: options.reasoningEffort ?? null,
        msgCount: (options.messages || []).length
      })
      const q = queuesByProvider[options.provider] || []
      const next = q.shift()
      if (!next) { yield* makeTextStream('fallback')(); return }
      yield* next(options)
    }
  }

  const ctx = new Context()
  ctx.baseUrl = pathToFileURL('C:/Program Files/nvm/v24.18.1/node_modules/@deepseek-ai/dsh/package.json').href
  ctx.plugin(TypertRegistry)
  ctx.plugin(Loader, { initial: [] })
  ctx.plugin(SystemPrompt)
  ctx.plugin(LlmRuntime)
  ctx.plugin(SessionService)
  ctx.plugin(SessionProjection)
  ctx.plugin(PersistenceJsonl, { root: sessionsDir })
  ctx.plugin(SessionQuerySqlite, { path: ':memory:', openAt: 'never' })
  ctx.plugin(FsLocal)
  ctx.plugin(SubprocessLocal)
  ctx.plugin(SandboxLocal)
  ctx.plugin(SandboxPolicy, { mode: 'danger-full-access', workspaceRoot: workDir })
  ctx.plugin(WorkingDirectory)
  ctx.plugin(ToolRuntime, { mode: 'ptc' })
  ctx.plugin(NodePtcRuntime)
  ctx.plugin(AgentRegistry)
  ctx.plugin(AgentLoop)
  const aprFiber = ctx.plugin(AgentPresetRegistry, { default: 'worker-readonly' })
  ctx.plugin(SubagentService)
  ctx.plugin(SpawnInProcess, { providerName: 'spawn' })

  // 先挂载一个模拟外部适配器消费者（验证 Cordis 乱序热发现！）
  const externalCalls = []
  let disposeExtBackend = null
  ctx.plugin({
    name: 'fake-antigravity-adapter',
    apply(c) {
      c.inject(['tieredWorkflow'], (inner) => {
        disposeExtBackend = inner.tieredWorkflow.registerBackend({
          contractVersion: 1,
          id: 'antigravity',
          label: 'Antigravity (fake agy)',
          capabilities: { readonlyMode: true, structuredOutput: true, continuation: true, handoff: true, usageReporting: true },
          healthCheck: async () => ({ ok: true, version: 'agy-test-1.0' }),
          async run(req) {
            externalCalls.push(req)
            if (req.role === 'handoff') {
              return {
                stopReason: 'completed',
                externalSessionId: 'agy-conv-999',
                resumeHint: 'agy --conversation agy-conv-999',
                text: '已接收交接包并停下等待用户指令',
                usage: { inputTokens: 20, cacheReadTokens: 500, outputTokens: 50, totalTokens: 570 },
                durationMs: 12
              }
            }
            return {
              stopReason: 'completed',
              externalSessionId: req.externalSessionId || 'agy-plan-1',
              resumeHint: 'agy --conversation ' + (req.externalSessionId || 'agy-plan-1'),
              text: 'planned via antigravity',
              structured: {
                rootCauseOrScope: 'external planner root cause',
                steps: [{ id: 'E1', action: 'apply fix', owner: 'main', files: ['a.js'] }],
                evidencePlan: ['unit test'],
                acceptanceCriteria: ['npm test passes'],
                outOfScope: []
              },
              usage: { inputTokens: 10, cacheReadTokens: 1000, outputTokens: 80, totalTokens: 1090 },
              durationMs: 15
            }
          }
        })
      })
    }
  })

  // 挂载本插件（注意：未传 readonlyPreset 之前先注册真实 worker-readonly preset）
  const pluginConfig = {
    experts: [{ name: 'opus-adv', provider: 'anthropic', model: 'claude-opus-5-5', reasoningEffort: 'medium', tags: ['审美'] }],
    planners: [
      { name: 'kimi-mid', provider: 'moonshot', model: 'kimi-k3.1-pro', reasoningEffort: 'medium', tier: 'standard', tags: ['规划'] },
      { name: 'opus-max', provider: 'anthropic', model: 'claude-opus-5-5', reasoningEffort: 'max', tier: 'deep', tags: ['架构'] },
      { name: 'agy-plan', backend: 'antigravity', model: 'gemini-4-neon', reasoningEffort: 'high', tier: 'standard', tags: ['外部'] }
    ],
    reviewers: [
      { name: 'kimi-rev', provider: 'moonshot', model: 'kimi-k3.1-pro', reasoningEffort: 'medium', tier: 'standard', tags: ['复审'] }
    ],
    delegates: {
      low: [{ name: 'm3', provider: 'minimax', model: 'MiniMax-M3.1-Flash', reasoningEffort: 'max', tier: 'standard', tags: ['调研'] }],
      medium: []
    },
    workflow: {
      enabled: true,
      defaultTrack: 'auto',
      readonlyPreset: 'worker-readonly',
      execPreset: '',
      maxPlannerFollowups: 2,
      maxReviewRetries: 2,
      stateDir,
      metricsLog
    },
    gates: {
      planGate: true,
      stallBreaker: true,
      stallToolThreshold: 20,
      stallConsecutiveFailures: 3,
      reviewGate: true
    }
  }

  const wfFiber = ctx.plugin(workflowPlugin, pluginConfig)
  await aprFiber.await()
  await wfFiber.await()
  await new Promise((r) => setTimeout(r, 200))

  ctx.llm.registerAdapter(['workbuddy', 'anthropic', 'moonshot', 'minimax'], new MockAdapter())

  // 注册全局测试写工具 & 报错工具（模拟 write / failing_tool）
  let writeExecutedCount = 0
  ctx.tools.register({
    name: 'write',
    description: 'Write file',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path'] },
    output: { schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false }, render: () => [{ type: 'text', text: 'OK' }] },
    async execute() { writeExecutedCount += 1; return { ok: true } }
  })
  ctx.tools.register({
    name: 'flaky_cmd',
    description: 'Always fails to test §12 failure breaker',
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false }, render: () => [{ type: 'text', text: 'OK' }] },
    async execute() { throw new Error('boom') }
  })

  await ctx.agentPresets.register({
    id: 'worker-readonly',
    name: '[内部] 只读子代理',
    description: 'readonly',
    order: 90,
    plugins: [
      { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: '只读子代理', complete: true, includeRuntimeContext: false } },
      { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs', config: { read: true, readImage: false, write: false, edit: false } }
    ]
  })

  // 验证 E2E-1: 外部后端乱序热发现 + dispatch_external 自动注册
  const twService = ctx.get('tieredWorkflow')
  assert.ok(twService, 'tieredWorkflow Cordis service must be provided')
  assert.equal(twService.listBackends().length, 1)
  assert.equal(twService.listBackends()[0].id, 'antigravity')
  assert.ok(ctx.tools.get('dispatch_external'), 'dispatch_external must register dynamically')

  // 创建主会话（轨 C 场景：含关键词「找根因并根治」）
  const parentHandle = await ctx.agents.create({
    sessionId: 'e2e-root-' + Date.now(),
    agentOptions: { provider: 'workbuddy', model: 'deepseek-v4.1-flash', reasoningEffort: 'max' },
    setup: async (_agentCtx, agent) => {
      await ctx.workingDirectory.set(agent, workDir, new AbortController().signal)
    }
  })
  const parent = parentHandle.agent

  // ── E2E-2 + E2E-3 + E2E-6: 完整轨 C 闭环 ──
  pushFor('workbuddy',
    // Parent step 1: 尝试不规划直接写文件（应被门禁 1 硬拒绝）
    makeToolCallStream('run_code', {
      description: 'Attempt write before plan',
      code: 'try { await tools.write({ path: "src/a.js" }); return "WROTE"; } catch (e) { return "BLOCKED:" + e.message; }'
    }),
    // Parent step 2: 按拒绝指令调用 request_plan(new)
    makeToolCallStream('run_code', {
      description: 'Call request_plan new',
      code: `return await tools.request_plan({ mode: "new", goal: "找根因并根治配置失效", pointers: ["src/a.js"], planDir: ${JSON.stringify(planDir)} });`
    }),
    // Parent step 3: 规划落盘解锁后写文件成功
    makeToolCallStream('run_code', {
      description: 'Write file after plan approved',
      code: 'return await tools.write({ path: "src/a.js", content: "fixed" });'
    }),
    // Parent step 4: 试图直接纯文本收尾跳过复审 → 触发 agent/turn-stopping 门禁 3B 硬拉回！
    makeTextStream('我已经改好了，直接结束。'),
    // Parent step 5: 被 steer 拉回后调用 request_review
    makeToolCallStream('run_code', {
      description: 'Run independent review after turn-stopping steer',
      code: 'return await tools.request_review({ scope: "engineering", summary: "已修复 src/a.js", artifactPaths: ["src/a.js"], commandEvidence: "unit test PASS" });'
    }),
    // Parent step 6: 复审通过，干净交付
    makeTextStream('复审通过，正式交付完成。')
  )
  pushFor('moonshot',
    // Planner step 1: 尝试调全局写工具 write（应被 0 号只读兜底守卫硬拒绝），随后调用 structured_output
    makeToolCallStream('run_code', {
      description: 'Readonly child tests write guard and submits plan',
      code: `
        let denied = '';
        try { await tools.write({ path: "hack.js" }); } catch (e) { denied = String(e.message || e); }
        await tools.${STRUCTURED_OUTPUT_TOOL}({
          rootCauseOrScope: "root cause verified | guard=" + denied.slice(0, 20),
          steps: [{ id: "S1", action: "fix a.js", owner: "main", files: ["src/a.js"] }],
          evidencePlan: ["run unit test"],
          acceptanceCriteria: ["unit test passes"],
          outOfScope: ["no refactor"]
        });
        return 'ok';
      `
    }, { inputTokens: 1, cacheReadTokens: 8000, cacheWriteTokens: 200, outputTokens: 150, reasoningTokens: 60, totalTokens: 8411 }),
    // Reviewer step 1: 新鲜只读上下文提交 pass
    makeToolCallStream('run_code', {
      description: 'Submit review pass',
      code: `
        await tools.${STRUCTURED_OUTPUT_TOOL}({
          verdict: "pass",
          summary: "根因定位准确，验收命令通过",
          checkedCriteria: [{ criterion: "unit test passes", status: "pass", note: "verified" }],
          gaps: []
        });
        return 'ok';
      `
    }, { inputTokens: 1, cacheReadTokens: 4000, outputTokens: 90, reasoningTokens: 40, totalTokens: 4131 })
  )

  parent.steer(createUserMessage({ content: [{ type: 'text', text: '请帮我找根因并根治配置失效问题' }], source: { kind: 'user' } }))
  await parent.whenIdle()

  // 验证门禁 1 拦住了第 1 次写，规划后放行了第 2 次写（总计只真正写入 1 次）
  assert.equal(writeExecutedCount, 1)
  assert.equal(fs.existsSync(path.join(planDir, 'plan.json')), true)
  assert.equal(fs.existsSync(path.join(planDir, 'plan.md')), true)
  const savedPlan = JSON.parse(fs.readFileSync(path.join(planDir, 'plan.json'), 'utf8'))
  // 验证 0 号只读守卫成功拦住了只读子代理里的 write 调用
  assert.match(savedPlan.plan.rootCauseOrScope, /只读隔离拒绝/)

  // 验证门禁 3B（turn-stopping）确实把纯文本跳过复审拉了回来（父会话有 1 条 dsh-tiered-workflow-review-gate 通知）
  const parentEvents = parent.session.snapshotEvents()
  const reviewSteers = parentEvents.filter((e) => e.type === 'user/message' && e.data?.source?.kind === 'dsh-tiered-workflow-review-gate')
  assert.equal(reviewSteers.length, 1)

  // ── E2E-4: Planner 续聊（V5-A 异步回执更新 plan.json 到 v2） + 超限自动清零升档 deep ──
  const settledPromise = new Promise((resolve) => {
    const off = ctx.on('subagent/end', () => { off(); resolve() })
  })
  pushFor('workbuddy',
    makeToolCallStream('run_code', {
      description: 'Request planner followup round 1',
      code: `return await tools.request_plan({ mode: "followup", feedback: "第1步发现路径不对", evidence: "ENOENT", planDir: ${JSON.stringify(planDir)} });`
    }),
    makeTextStream('等待原规划器修订完成。'),
    makeTextStream('收到 v2 计划。')
  )
  pushFor('moonshot',
    makeTextStream('```json\n{"rootCauseOrScope":"revised root cause v2","steps":[{"id":"S1","action":"fix b.js","owner":"main","files":["src/b.js"]}],"evidencePlan":["test b"],"acceptanceCriteria":["b passes"]}\n```', {
      inputTokens: 1, cacheReadTokens: 8600, outputTokens: 110, reasoningTokens: 45, totalTokens: 8756
    })
  )
  parent.steer(createUserMessage({ content: [{ type: 'text', text: '施工遇到 ENOENT，让规划器修订一下，跳过复审' }], source: { kind: 'user' } }))
  await settledPromise
  await new Promise((r) => setTimeout(r, 150))
  await parent.whenIdle()

  const planV2 = JSON.parse(fs.readFileSync(path.join(planDir, 'plan.json'), 'utf8'))
  assert.equal(planV2.version, 2)
  assert.equal(planV2.plan.rootCauseOrScope, 'revised root cause v2')

  // 再次 followup 触发超过 maxPlannerFollowups=2 → 自动清零重开并升档 deep（opus-max, reasoningEffort:'max'）
  queuesByProvider.workbuddy.length = 0
  queuesByProvider.moonshot.length = 0
  queuesByProvider.anthropic.length = 0
  const callsBeforeReopen = llmCalls.length
  pushFor('workbuddy',
    makeToolCallStream('run_code', {
      description: 'Followup over limit triggers deep reopen',
      code: `return await tools.request_plan({ mode: "followup", feedback: "v2 还是不行", planDir: ${JSON.stringify(planDir)} });`
    }),
    makeTextStream('已升档重开拿到 v3 计划。')
  )
  pushFor('anthropic',
    makeToolCallStream('run_code', {
      description: 'Deep planner submits v3',
      code: `
        await tools.${STRUCTURED_OUTPUT_TOOL}({
          rootCauseOrScope: "deep escalated root cause v3",
          steps: [{ id: "D1", action: "deep fix", owner: "main" }],
          evidencePlan: ["deep test"],
          acceptanceCriteria: ["all green"]
        });
        return 'ok';
      `
    })
  )
  parent.steer(createUserMessage({ content: [{ type: 'text', text: '还是不行，继续修订计划' }], source: { kind: 'user' } }))
  await parent.whenIdle()

  const deepPlannerCall = llmCalls.slice(callsBeforeReopen).find((c) => c.model === 'claude-opus-5-5')
  assert.ok(deepPlannerCall, 'exceeding maxPlannerFollowups must escalate to deep planner (opus-max)')
  assert.equal(deepPlannerCall.reasoningEffort, 'max')

  // ── E2E-5: 连续失败 3 次触发门禁 2（§12 止损熔断）阻断后续普通工具 ──
  queuesByProvider.workbuddy.length = 0
  pushFor('workbuddy',
    makeToolCallStream('run_code', { description: 'Fail 1', code: 'return await tools.flaky_cmd({});' }),
    makeToolCallStream('run_code', { description: 'Fail 2', code: 'return await tools.flaky_cmd({});' }),
    makeToolCallStream('run_code', { description: 'Fail 3', code: 'return await tools.flaky_cmd({});' }),
    // 第 4 步普通写工具应被门禁 2 止损熔断硬拒绝！
    makeToolCallStream('run_code', {
      description: 'Verify stall breaker blocks ordinary write',
      code: 'try { await tools.write({ path: "blocked.js" }); return "UNEXPECTED"; } catch (e) { return "STALL:" + e.message; }'
    }),
    makeTextStream('触发止损熔断，已停下。')
  )
  parent.steer(createUserMessage({ content: [{ type: 'text', text: '试跑一下失败命令' }], source: { kind: 'user' } }))
  await parent.whenIdle()
  // write 依然是之前的 1 次，没有因第 4 步被执行
  assert.equal(writeExecutedCount, 1)

  // ── E2E-7: 外部后端（antigravity）路由规划（自动解除熔断！） + handoff 交棒 + 6 维 metrics 落盘验证 ──
  queuesByProvider.workbuddy.length = 0
  pushFor('workbuddy',
    makeToolCallStream('run_code', {
      description: 'Plan via external antigravity backend and test handoff',
      code: `
        const p = await tools.request_plan({ mode: "new", goal: "大工程设计", need: "外部", planDir: ${JSON.stringify(planDir)} });
        const h = await tools.dispatch_external({ backend: "antigravity", mode: "handoff", goal: "交棒给 Antigravity 开 swarm", contextFiles: ["src/a.js"] });
        return { pBackend: p.backend, pSession: p.sessionId, hSession: h.externalSessionId, hHint: h.resumeHint };
      `
    }),
    makeTextStream('外部规划与交棒均成功。')
  )
  parent.steer(createUserMessage({ content: [{ type: 'text', text: '测一下外部后端规划和交棒' }], source: { kind: 'user' } }))
  await parent.whenIdle()

  assert.equal(externalCalls.length, 2)
  assert.equal(externalCalls[0].role, 'planner')
  assert.equal(externalCalls[1].role, 'handoff')

  // 验证 6 维 workflow-metrics.jsonl 完整落盘（覆盖 llm-step + request_plan + request_review + dispatch_external + 全部门禁）
  const metricRows = fs.readFileSync(metricsLog, 'utf8').trim().split('\n').map(JSON.parse)
  assert.ok(metricRows.some((r) => r.kind === 'llm-step' && r.role === 'planner' && r.usage.cacheReadTokens === 8000))
  assert.ok(metricRows.some((r) => r.kind === 'llm-step' && r.role === 'reviewer' && r.usage.cacheReadTokens === 4000))
  assert.ok(metricRows.some((r) => r.kind === 'dispatch_external' && r.backend === 'antigravity' && r.usage.cacheReadTokens === 500))
  assert.ok(metricRows.some((r) => r.kind === 'gate-denied' && r.gate === 'plan-gate'))
  assert.ok(metricRows.some((r) => r.kind === 'gate-denied' && r.gate === 'stall-breaker'))
  assert.ok(metricRows.some((r) => r.kind === 'gate-denied' && r.gate === 'readonly-child-guard'))

  // 验证外部后端反注册后 dispatch_external 自动卸载
  disposeExtBackend()
  assert.equal(ctx.tools.get('dispatch_external'), undefined)

  await parentHandle.dispose()
  await ctx.fiber.dispose().catch(() => {})
})
