# DSH 0.2.1-rc.2 底层平台探针实测报告（V1–V5 + 全局 AGENTS 协同审计）

> 测试日期：2026-11-24 · 测试平台：Windows 11 / Node v24.18.1 / DSH `0.2.1-rc.2`
> 测试方式：**源码精准核查 + 独立隔离的真 DSH 核心栈运行探针**（真实装配 `@deepseek-ai/cordis`、`dsh-llm`、`dsh-session`、`dsh-session-persistence-jsonl`、`dsh-session-query-sqlite`、`dsh-tools (mode:'ptc')`、`dsh-ptc-runtime-node`、`dsh-agent`、`dsh-agent-loop`、`dsh-agent-preset-registry`、`dsh-subagent`、`dsh-subagent-spawn-in-process`，接 Mock `LlmAdapter`，零外部 API 消耗、零触碰活 `web` profile）。
> 探针脚本留档：`F:/AiHarness/temp/v1-v5-probes/run-probes.mjs`（exit code 0，全项无报错通过）。

---

## 一、实测结论总览

| 编号 | 探测目标 | 结论 | 对 V2 实现的直接定案 |
|---|---|---|---|
| **V1** | `spawn` 绕过 `allowedModels`、`reasoningEffort` 透传、`deepseek-official` 核查 | **✅ 源码 + 运行时证实** | 插件直调 `startActivation` 不受内置 `allowedModels` 限制；完整透传 `provider`/`model`/`reasoningEffort`；`deepseek-official` 是官方 `@deepseek-ai/dsh-llm-deepseek-api-key` 注册的合法 provider（非配置 typo） |
| **V2** | `spawn` 全量 4 能力、`worker-readonly` 隔离性、UI 列表影响 | **✅ 源码 + 运行时证实（含 2 项修正）** | `spawn` 全量支持 `agentOptions`/`agentPreset`/`outputSchema`/`depthLimit`；但子代理仍继承全局工具且 preset 无 `hidden` 字段 → 采用「只读 preset（`tool-fs` 禁写 + 不挂 `agent-instructions`）+ `tools.guard` 按 `childId` 兜底禁写」双保险 |
| **V3** | PTC 模式下 `tools.guard` 硬拒绝传播机制 | **✅ 源码 + 运行时证实** | `guard` 返回文案原样以 `ToolCallError: <文案>` 抛入 `run_code`；未捕获时以错误返回外层，被 `try/catch` 时 `e.message` 即原指令文案 |
| **V4** | 拦住主力不调交付工具直接纯文本跳过复审 | **✅ 源码 + 运行时证实（避开 1 个大坑）** | `agent/turn-stopping` + `agent.steer()` 原生可靠拉回续跑，且可设 `maxResumes` 防死循环；**硬约束**：Format v4 禁止 `source.kind: "plugin"`，必须用插件专属 `source.kind` |
| **V5** | Planner 持久化 `coldResume` 续聊 + 全链路 6 维 Token 记账 | **✅ 源码 + 运行时证实（含 3 项关键定案）** | `coldResume` 保留历史、`provider/model/reasoningEffort` 与 `agentPreset`，但**不恢复 `outputSchema` 且 `delivery` 回落 `'parent'`** → 续聊采用原生异步回执 + `subagent/end` 更新 `plan.json`（零重复注入）；全局 `session/event` 可实时采齐父子全树 6 维 `TokenUsage` |
| **V6** | 全局 `AGENTS.md`（29.6 KB）与项目 `AGENTS.md`（16.3 KB）交互审计 | **✅ 实读核查完成** | 必须与全局 §1/§3 Grill Me 合并防二次确认、与 §12 熔断阈值统一（20 步 / 连续失败 3 次）、内部只读/执行预设不挂全量 `agent-instructions`（每轮立省 ~44 KB 系统提示）并由插件自动注入精简 preamble |

---

## 二、逐项实测证据与工程定案

### V1 · 路由权限、推理强度透传与 `deepseek-official` 核查

* **源码证据**：
  * `allowedModels` 校验仅存在于官方内置工具包 `dsh-tool-subagent/lib/index.js:91`（`assertAllowedModelSelection`），`dsh-subagent/lib/index.js` 的 `startActivation` 不读取该清单。
  * `dsh-llm-deepseek-api-key/lib/index.js:36` 定义 `const PROVIDER = "deepseek-official"`，且该插件已在 `F:/AiHarness/.dsh/profiles/web/cordis.patch.yml:312-313` 挂载（使用 API Key 鉴权，区别于登录态的 `deepseek-account`）。此前交接文档推断其“因不在允许清单而报错”不成立；实际是否可用仅取决于该路由是否配置有效 API Key。
* **运行时实测结果**：
  * 给父会话写入严格 `subagent/model-selection-policy`（仅允许 `minimax-code/MiniMax-M3.1-Flash`）后，直接调用 `ctx.subagents.startActivation({ provider: 'spawn', ... })`：
    * `totokens-claude-anthropic/claude-opus-5-5` + `reasoningEffort: "high"` → `stopReason: "completed"`，底层 `LlmAdapter.stream` 原样收到 `{ provider: "totokens-claude-anthropic", model: "claude-opus-5-5", reasoningEffort: "high" }`。
    * `deepseek-official/deepseek-flash` + `reasoningEffort: "medium"` → `stopReason: "completed"`，底层原样收到 `{ provider: "deepseek-official", model: "deepseek-flash", reasoningEffort: "medium" }`。
* **待实网验证项（不消耗本次探针额度）**：`totokens-claude-anthropic`（`https://totokens.cc`）中转端在多步工具调用子代理下的实际稳定性与延迟，以及 `deepseek-official` 账号侧密钥可用性，留待 Phase 1 实网冒烟验证。

---

### V2 · `spawn` 四项能力、只读隔离双保险与 Preset 列表影响

* **源码证据**：
  * `dsh-subagent-spawn-in-process/lib/index.js:21-26`：
    ```js
    capabilities = { agentOptions: true, agentPreset: true, outputSchema: true, depthLimit: true }
    ```
  * 对照：`dsh-subagent-fork-in-process/lib/index.js:35-40` 中 `agentPreset: false`，故带独立只读预设的子代理**必须走 `spawn`**。
  * `dsh-web-app/presets/minimal.patch.yml:17-23`：`@deepseek-ai/dsh-tool-fs` 原生支持按工具开关 `{ read: true, readImage: false, write: false, edit: false }`。
  * `dsh-agent-preset/lib/index.js:13-19` & `dsh-agent-preset-registry/lib/index.js:585`：预设 schema 仅有 `id/name/description/order/plugins`，**无 `hidden` 字段**，所有注册预设都会按 `order` 排序返回给 Web GUI。
* **运行时实测结果**：
  * 同时传入 `agentPreset: "worker-readonly"` + `outputSchema` + `maxDepth: 1` + `delivery: "caller"`：
    * `childHasReadTool: true`，`childHasWriteToolFromToolFs: false`（`write`/`edit` 彻底不存在于子代理工具集）；
    * `childHasStructuredOutputTool: true`（在 PTC `run_code` 内调用 `tools.structured_output(...)` 后，**自动触发 `concludeTurn` 立即结束子代理**，省去一轮多余收尾文本请求，且 `result.structured` 精确返回合法 JSON）；
    * `parentSettlementInjectedUnderCallerDelivery: 0`（零父会话污染）；
    * `maxDepthEnforcedError: "SubagentDepthError"`（子代理尝试派孙代理被宿主硬拦截）；
    * **`childInheritsGlobalTools: true`**（重要发现：注册在全局层的插件工具仍会被独立 preset 子代理继承！）。
* **工程定案**：
  1. **只读隔离采用双保险**：① `worker-readonly` 预设（`order: 90`，名带 `[内部]` 前缀）配置 `tool-fs: { read: true, readImage: true, write: false, edit: false }` + 搜索/网页只读工具，不装 shell 与写工具，且**不装 `dsh-agent-instructions`**；② 插件维护只读子代理 `childId` 集合，在 `ctx.tools.guard` 中兜底硬拒绝任何继承自全局层的写入/委派类工具。

---

### V3 · PTC 模式下 `tools.guard` 硬拒绝传播路径

* **源码证据**：
  * `dsh-tools/lib/index.js:1431`（PTC 子调用走完整 `scheduler.prepare(input)`）→ `:3337-3353`（命中 `guardReason(exec)` 返回 `isError: true` 且 `error.message = denialReason`）→ `:1468`（在 `run_code` 内抛出 `ToolCallError`）。
* **运行时实测结果**：
  * `guard` 返回拒绝文案 `'规划门禁拒绝：轨 C 尚未生成 plan.json。下一步请调用 request_plan({ mode: "new", goal }) 后再写文件。'`：
    * **场景 1（模型未 `try/catch`）**：外层 `run_code` 收到 `Error: code run failed (exception): ToolCallError: 规划门禁拒绝：轨 C 尚未生成 plan.json。下一步请调用 request_plan({ mode: "new", goal }) 后再写文件。`
    * **场景 2（模型用 `try/catch` 捕获）**：捕获到的 `e.message` 即为完整拒绝指令原文，无截断、无丢失。
* **工程定案 & 待实网验证项**：
  * 门禁拒绝文案保持**简短、直接给出下一步工具名与参数**。
  * 记录同一会话的连续被拒计数，防弱模型在 `run_code` 内盲目重试。
  * 现役主力 `deepseek-v4.1-flash` 收到该 `ToolCallError` 后的实际服从率，留待 Phase 1 实网验证。

---

### V4 · `agent/turn-stopping` 拦截纯文本跳过复审 & Format v4 硬约束避坑

* **源码证据**：
  * `dsh-agent-loop/lib/index.js:1000-1008`：当本步无工具调用且 `inbox.nextStep` 为空时，串行派发 `agent/turn-stopping`；若监听器内调用 `agent.steer(...)` 塞入消息，`inbox.nextStep` 变为非空，循环不退出直接进入下一步。
  * **关键坑点（本次探针直接踩出）**：`dsh-session-format-v3-to-v4/lib/index.js:126` 强制校验：
    ```js
    if (... || value["kind"] === "plugin") throw new SessionFormatError("format v4 message requires a producer-owned source kind");
    ```
    如果照抄旧插件写法传 `source: { kind: 'plugin', ... }`，会话持久化写盘会**直接抛异常失败**！
* **运行时实测结果**：
  * 改用专属 `source: { kind: 'dsh-tiered-workflow-review-gate', form: 'notice', summary: '...' }` 后：
    * **正常流**：第 1 步纯文本试图跳过复审 → 被 `steer` 拉回 → 第 2 步调 `probe_review` → 第 3 步正常交付（`steerCount: 1, totalSteps: 3`）。
    * **防死循环流**：顽固模型永不调复审 → 达到上限 `maxResumes = 2` 后干净放行（`steerCount: 2, totalSteps: 3, releasedCleanly: true`）。
* **工程定案**：
  * 门禁 3（交付复审门禁）同时覆盖两处：① `tools.guard` 拦交付/落盘工具；② `agent/turn-stopping` + `agent.steer()` 拦纯文本直接收尾（带 `maxResumes: 2` 上限，超限放行并记入未复审指标）。
  * 本插件所有注入消息严禁使用 `source.kind: "plugin"`，一律使用专属命名（如 `dsh-tiered-workflow-review-gate` / `dsh-tiered-workflow-stall-breaker`）。

---

### V5 · Planner 持久化 `coldResume` 续聊与全链路 6 维 Token 记账

* **源码证据**：
  * `dsh-subagent/lib/index.js:555-561`：持久化 `subagent/descriptor` 刻意省略 `outputSchema` 与 `maxTokens`（仅作用于单次 activation）。
  * `dsh-subagent/lib/index.js:2167-2183` & `:1841`：`coldResume` 重建子代理时恢复 `provider`/`model`/`reasoningEffort`/`agentPreset`，但**不传 `outputSchema` 也不传 `delivery`**（因此 `delivery` 回落为默认的 `"parent"`）。
  * `dsh-llm/lib/types/types.d.ts:153-174`：`TokenUsage` 六字段**互斥计数**（`inputTokens` 仅为未缓存输入；总计费输入 = `inputTokens + cacheReadTokens + cacheWriteTokens`，另含 `outputTokens`、`reasoningTokens`、`totalTokens`）。**彻底解释了此前 `expert-usage.jsonl` 中 `inputTokens` 恒为 1 的原因**：旧代码只记了 `inputTokens` 与 `outputTokens`，漏记了 `cacheReadTokens` / `cacheWriteTokens`！
  * `dsh-llm/lib/types/types.d.ts:131-151`：`finish.reason` 是对象 `{ kind: 'stop' | 'tool-calls' | 'max-tokens' | 'aborted' | 'error' }`，旧代码 `String(finish.reason)` 必然产出 `"[object Object]"`，应取 `finish.reason.kind`。
* **运行时实测结果**：
  * 第 1 轮 `startActivation(delivery:'caller', outputSchema, agentPreset:'worker-readonly', reasoningEffort:'medium')`：`stopReason: "completed"`，拿到 `structured: { planVersion: 1, ... }`，父会话零通知。
  * 第 2 轮 `sendMessage(parent, childId, ...)` 触发真 `coldResume`：
    * `preservedPriorHistoryMsgCount: 7`（完整保留首轮上下文）；
    * `observedRoute`: `{ provider: "totokens-claude-anthropic", model: "claude-opus-5-5", reasoningEffort: "medium" }`（完整恢复）；
    * `hasReadToolAfterResume: true`，`hasWriteToolFromToolFsAfterResume: false`（只读预设完整恢复）；
    * `hasStructuredOutputAfterResume: false`（证实无 `structured_output` 工具）；
    * `parentReceivedExtraSettlementMsgCount: 1`（`source.kind: "subagent-settled"`，证实 `coldResume` 回落 `'parent'` 后会自动将结算通知推给父会话并唤醒父会话）。
  * 全局 `ctx.on('session/event', ...)` 捕获了父子整树全部 `assistant/message` 事件中的 6 维 `TokenUsage`（实测精确累加 `inputTokens: 2`, `cacheReadTokens: 25200`, `outputTokens: 265`, `reasoningTokens: 120`），并可通过 `session.header.parentSession` 归属到同一根会话。
* **工程定案（V5-A 方案）**：
  1. **Planner 首轮 vs 续聊分工**：
     * **首轮（`mode: 'new'`）**：走 `startActivation({ delivery: 'caller', outputSchema: PlanSchema, agentPreset: 'worker-readonly', maxDepth: 1 })`，同步拿到结构化 `plan.json` 并落盘，零额外消息。
     * **续聊（`mode: 'followup'`，最多 3 轮）**：走 `sendMessage(parent, plannerChildId, ...)`，prompt 末尾明确要求以 `json` 代码块输出修订版计划；工具**立即返回 `{ status: 'followup_dispatched', childId }`（异步）**，顺应 `coldResume` 原生的 `subagent-settled` 通知唤醒父会话，同时插件监听 `subagent/end` 自动提取并校验更新 `plan.json`——**彻底避免双份重复注入，也不存在同步长超时阻塞**。
  2. **统一 6 维记账**：通过全局 `session/event` 实时按根会话聚合所有角色（主力 + Planner + Reviewer + Worker）的 `inputTokens` / `cacheReadTokens` / `cacheWriteTokens` / `outputTokens` / `reasoningTokens` / `totalTokens` 写入 `workflow-metrics.jsonl`，并同步修复 `ask_expert` 的 `finish.reason.kind` 与缓存字段遗漏。

---

### V6 · 全局 `AGENTS.md` 协同审计（`C:/Users/NaE/.agents/AGENTS.md`）

核查全局规则（29,590 字节）与 `references/subagent-task-preamble.md`（4,011 字节）后，发现 4 处必须提前对齐的设计点（否则上线后规则会彼此打架或浪费大量 token）：

1. **避免与 §1/§3 Grill Me 叠床架屋（防二次打扰用户）**：
   * 全局 §1 已将请求分为「诊断/求助（≤3 步只读，不 Grill） / 问答 / 执行任务（Grill Me + 等明确开工） / 闲聊」。
   * 对齐口径：
     * **诊断/求助** → 主力先做 ≤3 步只读探查；若已定根因且小改走轨 A，若 3 步未定根因或需根治直接进轨 C 调 `request_plan`；
     * **问答（含价格/最新/版本对比）** → 轨 B（一手源台账 + 独立复审）；
     * **执行任务（复杂/跨文件）** → 轨 C，**直接由 Planner 产出含验收标准的方案作为 §3.3 确认材料交用户一次拍板**，不再出现“先被弱主力 Grill 一轮，确认后又要等 Planner 规划一轮”的双重交互。
2. **门禁 2 直接对齐 §12 止损熔断（P0）**：
   * 全局 §12 已写死 P0 熔断标准：失败连续 **3 步** / 只读空转 **5 步** / 会话步数超 **20 步** / 单步推理超 **5000 字符**。
   * 门禁 2 直接作为 §12 的宿主级机械执行器：默认步数阈值由原草案 25 次对齐收紧为 **20 次**（可配置），连续失败对齐 **3 次**。
3. **子代理省 46 KB System Prompt（高性价比关键优化）**：
   * 当前常驻 `AGENTS.md`（全局 29.6 KB + 项目 16.3 KB ≈ 46 KB）通过 `agent-instructions` 注入给每个继承它的子代理。
   * 在内部预设 `worker-readonly` / `worker-exec` 中**不挂载 `@deepseek-ai/dsh-agent-instructions`**，改由插件按 §13.5 自动注入一份 ~1.5 KB 的精简环境事实 preamble（从配置文件指定路径读）+ 最小 P0 安全摘要：既根治弱主力派子代理忘带 preamble 踩 Windows/pwsh 坑的问题，又为每个子代理**每轮立省 ~44 KB 系统提示词输入**。
4. **产物落点对齐 §7**：
   * 人类可读的 `plan.md` 落盘到任务目录 `tasks/<任务名>/`；插件内部运行态 `state.json` 与 `workflow-metrics.jsonl` 落在 `$DSH_HOME/storages/`，绝不污染工作区根目录。
