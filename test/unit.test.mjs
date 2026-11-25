import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { Config, readLiveConfig, pickProfile, DSH_SPAWN_BACKEND } from '../src/config.js'
import { ExternalBackendRegistry, EXTERNAL_BACKEND_CONTRACT_VERSION, validateBackendAdapter } from '../src/backends.js'
import { extractFinishKind, normalizeUsage, MetricsRecorder } from '../src/metrics.js'
import { WorkflowStateStore } from '../src/state.js'
import { precheckResearchText } from '../src/research-check.js'
import { extractJsonFromText, validatePlanObject, validateReviewObject, renderPlanMarkdown } from '../src/prompts.js'
import { WorkflowRunner } from '../src/runner.js'
import * as plugin from '../src/index.js'

test('exports: pure named exports without default export (Cordis Config safety)', () => {
  assert.equal('default' in plugin, false)
  assert.equal(plugin.name, 'tiered-workflow')
  assert.deepEqual(plugin.inject, ['tools'])
  assert.equal(typeof plugin.Config, 'function')
  assert.equal(typeof plugin.apply, 'function')
})

test('Config: validates defaults, backward-compatible 0.2.x config, and V2 tiered profiles', () => {
  const defaults = readLiveConfig(Config({}))
  assert.deepEqual(defaults.experts, [])
  assert.deepEqual(defaults.planners, [])
  assert.deepEqual(defaults.reviewers, [])
  assert.equal(defaults.workflow.enabled, true)
  assert.equal(defaults.gates.stallToolThreshold, 20)
  assert.equal(defaults.gates.stallConsecutiveFailures, 3)

  // 向后兼容旧版 0.2.x 配置（不含 planners/reviewers/backend/tier）
  const legacy = Config({
    experts: [{ name: 'opus', provider: 'totokens-claude-anthropic', model: 'claude-opus-5-5', tags: ['设计'] }],
    delegates: { low: [], medium: [{ name: 'm3', provider: 'minimax-code', model: 'MiniMax-M3.1-Flash' }] }
  })
  const live = readLiveConfig(legacy)
  assert.equal(live.experts[0].backend, DSH_SPAWN_BACKEND)
  assert.equal(live.experts[0].tier, 'standard')
  assert.equal(live.medium[0].backend, DSH_SPAWN_BACKEND)

  assert.throws(() => Config({ planners: 'not-an-array' }))
})

test('pickProfile: supports same model across multiple reasoningEfforts/tiers and external backends', () => {
  const reg = new ExternalBackendRegistry()
  reg.registerBackend({
    contractVersion: 1,
    id: 'antigravity',
    label: 'Antigravity',
    capabilities: { readonlyMode: true, structuredOutput: true, continuation: true, handoff: true, usageReporting: true },
    async run() { return { stopReason: 'completed', text: 'ok', durationMs: 1 } }
  })

  const routes = readLiveConfig({
    planners: [
      { name: 'opus-mid', provider: 'anthropic', model: 'claude-opus-5-5', reasoningEffort: 'medium', tier: 'standard', tags: ['规划', '诊断'] },
      { name: 'opus-max', provider: 'anthropic', model: 'claude-opus-5-5', reasoningEffort: 'max', tier: 'deep', tags: ['规划', '架构'] },
      { name: 'agy-deep', backend: 'antigravity', model: 'gemini-4-neon', reasoningEffort: 'high', tier: 'deep', tags: ['大工程'] },
      { name: 'uninstalled', backend: 'missing-cli', tier: 'standard', tags: ['诊断'] }
    ]
  }).planners

  const r1 = pickProfile(routes, { depth: 'normal', need: '诊断', backendRegistry: reg })
  assert.equal(r1.route.name, 'opus-mid')
  assert.equal(r1.route.reasoningEffort, 'medium')
  assert.equal(r1.matchedNeed, true)
  assert.equal(r1.matchedDepth, true)

  const r2 = pickProfile(routes, { depth: 'deep', need: '架构', backendRegistry: reg })
  assert.equal(r2.route.name, 'opus-max')
  assert.equal(r2.route.reasoningEffort, 'max')

  const r3 = pickProfile(routes, { depth: 'deep', need: '大工程', backendRegistry: reg })
  assert.equal(r3.route.name, 'agy-deep')
  assert.equal(r3.route.backend, 'antigravity')
})

test('ExternalBackendRegistry: enforces v1 contract, idempotent dispose, and resilient healthCheckAll', async () => {
  const reg = new ExternalBackendRegistry()
  assert.throws(() => validateBackendAdapter(null), /INVALID_ADAPTER/)
  assert.throws(() => validateBackendAdapter({ contractVersion: 2 }), /UNSUPPORTED_CONTRACT_VERSION/)
  assert.throws(() => validateBackendAdapter({
    contractVersion: 1, id: 'dsh-spawn', label: 'bad',
    capabilities: { readonlyMode: true, structuredOutput: true, continuation: true, handoff: true, usageReporting: true },
    run: async () => ({})
  }), /RESERVED_BACKEND_ID/)

  const events = []
  reg.onChange((e) => events.push(e))

  const disposeA = reg.registerBackend({
    contractVersion: EXTERNAL_BACKEND_CONTRACT_VERSION,
    id: 'antigravity',
    label: 'Antigravity CLI',
    capabilities: { readonlyMode: true, structuredOutput: true, continuation: true, handoff: true, usageReporting: true },
    healthCheck: async () => ({ ok: true, version: '1.5.0' }),
    run: async () => ({ stopReason: 'completed', text: 'ok', durationMs: 5 })
  })
  const disposeB = reg.registerBackend({
    contractVersion: 1,
    id: 'broken-cli',
    label: 'Broken CLI',
    capabilities: { readonlyMode: false, structuredOutput: false, continuation: false, handoff: false, usageReporting: false },
    healthCheck: async () => { throw new Error('binary missing') },
    run: async () => ({ stopReason: 'error', text: '', durationMs: 1 })
  })

  assert.equal(reg.size(), 2)
  assert.deepEqual(reg.list().map((x) => x.id), ['antigravity', 'broken-cli'])

  const health = await reg.healthCheckAll()
  assert.equal(health[0].ok, true)
  assert.equal(health[0].version, '1.5.0')
  assert.equal(health[1].ok, false)
  assert.match(health[1].detail, /binary missing/)

  disposeA()
  disposeA() // 幂等
  disposeB()
  assert.equal(reg.size(), 0)
  assert.equal(events.length, 4)
})

test('metrics: extracts finish.reason.kind and 6-field disjoint TokenUsage', () => {
  assert.equal(extractFinishKind({ reason: { kind: 'stop' } }), 'stop')
  assert.equal(extractFinishKind({ kind: 'max-tokens' }), 'max-tokens')
  assert.equal(extractFinishKind('error'), 'error')
  assert.equal(extractFinishKind(null), 'unknown')

  const u = normalizeUsage({ inputTokens: 1, cacheReadTokens: 12000, cacheWriteTokens: 500, outputTokens: 200, reasoningTokens: 80 })
  assert.equal(u.billedInputTokens, 12501)
  assert.equal(u.reasoningTokens, 80)

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-metrics-'))
  const logFile = path.join(tmp, 'metrics.jsonl')
  const rec = new MetricsRecorder({
    getConfig: () => readLiveConfig({ usageLog: path.join(tmp, 'expert.jsonl'), workflow: { metricsLog: logFile } })
  })
  rec.recordExpertUsage({
    executor: 'a/b', expert: 'c/d', finish: { reason: { kind: 'stop' } },
    usage: { inputTokens: 1, cacheReadTokens: 9000, outputTokens: 100 }, ms: 1200
  })
  const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].finish, 'stop')
  assert.equal(lines[0].cacheReadTokens, 9000)
  assert.equal(lines[0].billedInputTokens, 9001)
})

test('WorkflowStateStore: triages A/B/C, escalates on user correction & §12 thresholds, honors human override', () => {
  const store = new WorkflowStateStore({ getConfig: () => readLiveConfig({}) })

  const s1 = store.getOrCreate('sess-1')
  assert.equal(s1.track, 'A')
  store.observeUserMessage(s1, '帮我对比一下各家最新价格和会员限额')
  assert.equal(s1.track, 'B')

  // 纠偏自动升轨 C
  store.observeUserMessage(s1, '这只是治标不治本，还是不对')
  assert.equal(s1.track, 'C')
  assert.equal(s1.userCorrectionCount, 1)

  // 连续失败 3 次触发 §12 熔断
  store.recordToolOutcome(s1, 'pwsh', true)
  store.recordToolOutcome(s1, 'pwsh', true)
  assert.equal(s1.stalled, false)
  store.recordToolOutcome(s1, 'pwsh', true)
  assert.equal(s1.stalled, true)

  // 逃生阀立即解除
  store.observeUserMessage(s1, '跳过门禁，我自己确认直接改')
  assert.equal(s1.humanOverride.skipPlan, true)
  assert.equal(s1.humanOverride.skipReview, true)
  assert.equal(s1.stalled, false)

  // core-heavy 初始直接轨 C
  const sHeavy = store.getOrCreate('sess-heavy', { agentPreset: 'core-heavy' })
  assert.equal(sHeavy.track, 'C')
})

test('precheckResearchText: flags unlabeled secondary domains and ungrounded volatile claims', () => {
  const bad = precheckResearchText('最新价格：每月 99 元，来源 https://si163.com/ai-wool/qoder-free-credits')
  assert.equal(bad.ok, false)
  assert.ok(bad.warnings.some((w) => w.includes('si163.com')))
  assert.ok(bad.warnings.some((w) => w.includes('一手官方 URL')))

  const good = precheckResearchText(
    '官方定价见 https://api-docs.deepseek.com/quick_start/pricing ；社区帖子（二手，待核实）：https://si163.com/ai-wool/qoder-free-credits'
  )
  assert.equal(good.ok, true)
  assert.equal(good.warnings.length, 0)
})

test('prompts: extractJsonFromText + validatePlanObject + validateReviewObject + renderPlanMarkdown', () => {
  const raw = '先分析一下。\n```json\n{"rootCauseOrScope":"missing lock","steps":[{"id":"S1","action":"add lock","owner":"main","files":["a.js"]}],"evidencePlan":["run unit test"],"acceptanceCriteria":["exit 0"]}\n```'
  const obj = extractJsonFromText(raw)
  const checked = validatePlanObject(obj)
  assert.equal(checked.ok, true)
  const md = renderPlanMarkdown(checked.plan, { profile: 'opus-mid', version: 1 })
  assert.match(md, /missing lock/)
  assert.match(md, /\[S1\] \(main\)/)

  const rev = validateReviewObject({
    verdict: 'fail',
    summary: '缺实跑证据',
    checkedCriteria: [{ criterion: 'exit 0', status: 'missing-evidence', note: '未贴输出' }],
    gaps: ['请补跑 node --test 并贴输出']
  })
  assert.equal(rev.ok, true)
  assert.equal(rev.review.verdict, 'fail')
})

test('client.js: loads in fake __ModuleLoader__, edits planners + hard gates, and plans clean mutate ops', async () => {
  const code = fs.readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
  let loadedDef = null
  globalThis.window = {
    __ModuleLoader__: { load(def) { loadedDef = def } }
  }
  const fn = new Function(code)
  fn()
  assert.ok(loadedDef && typeof loadedDef.factory === 'function')

  const fakeReact = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useSyncExternalStore: (_sub, snap) => snap()
  }
  const clientMod = loadedDef.factory((id) => {
    if (id === 'react') return fakeReact
    throw new Error('unexpected require: ' + id)
  })

  let hostValue = {
    experts: [],
    planners: [],
    reviewers: [],
    delegates: { low: [], medium: [] },
    maxTokens: 8000,
    timeoutMs: 150000,
    minPackageChars: 600,
    reminder: { enabled: true, threshold: 47 },
    workflow: { enabled: true, defaultTrack: 'auto', readonlyPreset: '', execPreset: '', maxPlannerFollowups: 3, maxReviewRetries: 2 },
    gates: { planGate: true, stallBreaker: true, stallToolThreshold: 20, stallConsecutiveFailures: 3, reviewGate: true }
  }
  let hostRevision = 1
  const mutations = []
  let formListeners = []
  let capturedSection = null

  const fakeCtx = {
    locale: {
      register: () => () => {},
      bind: () => (k) => k
    },
    remote: {
      session: {
        modelCatalog: async () => ({
          ok: true,
          groups: [{
            id: 'totokens-claude-anthropic',
            name: 'Claude',
            models: [{ id: 'claude-opus-5-5', name: 'Opus 5.5', reasoning: { efforts: [{ id: 'medium', name: 'medium' }, { id: 'max', name: 'max' }] } }]
          }]
        })
      }
    },
    configForms: {
      whileServed: (_ns, cb) => cb(),
      get: () => ({
        getSnapshot: () => ({ status: 'ready', writable: true, value: hostValue, revision: hostRevision }),
        subscribe: (cb) => { formListeners.push(cb); return () => {} },
        mutate: async (ops, rev) => {
          mutations.push({ ops, rev })
          hostRevision += 1
          return true
        }
      })
    },
    slots: {
      inject: (_name, cb) => cb(),
      register: (meta, comp) => { capturedSection = { meta, comp }; return () => {} }
    },
    effect: (cb) => cb()
  }

  clientMod.apply(fakeCtx)
  assert.ok(capturedSection)
  const page = capturedSection.meta.inject().page
  // 添加一条外部后端规划器（允许无 provider）与关闭门禁 1
  page.addItem('planners')
  page.setItemField('planners', 0, 'name', 'agy-deep')
  page.setItemField('planners', 0, 'backend', 'antigravity')
  page.setItemField('planners', 0, 'tier', 'deep')
  page.setItemField('planners', 0, 'tags', '大工程, 架构')
  page.setBool('planGate', false)
  page.setText('readonlyPreset', 'worker-readonly')

  // 即使宿主 revision 因外部热重载 +5，只要字段基线未变，仍应允许保存不误报冲突
  hostRevision += 5
  await page.save()

  assert.equal(mutations.length, 1)
  const paths = mutations[0].ops.map((o) => o.path.join('.'))
  assert.ok(paths.includes('planners'))
  assert.ok(paths.includes('gates.planGate'))
  assert.ok(paths.includes('workflow.readonlyPreset'))
  const plannerOp = mutations[0].ops.find((o) => o.path.join('.') === 'planners')
  assert.equal(plannerOp.value[0].backend, 'antigravity')
  assert.equal(plannerOp.value[0].tier, 'deep')
  assert.deepEqual(plannerOp.value[0].tags, ['大工程', '架构'])

  delete globalThis.window
})

test('WorkflowRunner & plugin.apply: propagates external stopReason errors and registers Cordis v4 effect teardown', async () => {
  const reg = new ExternalBackendRegistry()
  reg.registerBackend({
    contractVersion: EXTERNAL_BACKEND_CONTRACT_VERSION,
    id: 'antigravity',
    label: 'Antigravity',
    capabilities: { readonlyMode: true, structuredOutput: true, continuation: true, handoff: true, usageReporting: true },
    async run() {
      return { stopReason: 'timeout', text: '', diagnostic: 'agy timed out after 5000ms' }
    }
  })
  const recorded = []
  const fakeMetrics = { recordEvent: (kind, payload) => recorded.push({ kind, payload }), tagSession: () => {} }
  const runner = new WorkflowRunner({ ctx: {}, backendRegistry: reg, metrics: fakeMetrics, stateStore: null })
  const liveConfig = readLiveConfig(Config({}))

  await assert.rejects(
    () => runner.runPlannerNew({
      parent: null,
      rootSessionId: 's1',
      route: { name: 'agy-p', backend: 'antigravity', model: '', reasoningEffort: '', systemPrompt: '', backendOptions: {} },
      goal: 'test timeout',
      pointers: [],
      priorFalsified: [],
      cwd: process.cwd(),
      planDir: '',
      liveConfig
    }),
    (err) => err.code === 'EXTERNAL_PLANNER_FAILED' && /stopReason=timeout/.test(err.message) && /agy timed out/.test(err.message)
  )

  await assert.rejects(
    () => runner.runReviewer({
      parent: null,
      rootSessionId: 's1',
      route: { name: 'agy-r', backend: 'antigravity', model: '', reasoningEffort: '', systemPrompt: '', backendOptions: {} },
      scope: 'engineering',
      originalGoal: 'g',
      plan: null,
      summary: 's',
      artifactPaths: [],
      commandEvidence: '',
      precheckWarnings: [],
      cwd: process.cwd(),
      liveConfig
    }),
    (err) => err.code === 'EXTERNAL_REVIEWER_FAILED' && /stopReason=timeout/.test(err.message)
  )
  assert.equal(recorded.length, 2)
  assert.equal(recorded[0].payload.stopReason, 'timeout')

  // Verify plugin.apply uses ctx.effect for Cordis v4 teardown
  let effectCleanup = null
  let toolDisposedCount = 0
  const fakeCtx = {
    provide: () => {},
    set: () => {},
    get: () => undefined,
    on: () => () => {},
    effect: (fn) => { effectCleanup = fn() },
    tools: {
      register: () => () => { toolDisposedCount += 1 },
      guard: () => () => {}
    }
  }
  plugin.apply(fakeCtx, {})
  assert.equal(typeof effectCleanup, 'function')
  effectCleanup()
  assert.ok(toolDisposedCount >= 4)
})
