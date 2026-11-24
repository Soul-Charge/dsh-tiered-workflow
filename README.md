# dsh-tiered-workflow（compat package: `dsh-expert-bridge`）

> 仓库已更名为 **`dsh-tiered-workflow`**；为兼容当前 DSH `web` profile 联接，npm 包名与设置命名空间暂保持 `dsh-expert-bridge` / `expert-bridge`，支持从 `0.2.x` 零配置破坏平滑升级。

面向 DSH `>= 0.2.1-rc.2`（PTC 模式）的**低预算多模型分档分工与宿主级硬门禁工作流插件**（MIT，含 Web 设置页）。

* 完整架构蓝图：[docs/WORKFLOW-ARCHITECTURE.md](docs/WORKFLOW-ARCHITECTURE.md)
* DSH `0.2.1-rc.2` 底层探针实测报告：[docs/PLATFORM-PROBES.md](docs/PLATFORM-PROBES.md)
* 踩坑备忘：[docs/PITFALLS.md](docs/PITFALLS.md) · GUI 说明：[docs/GUI.md](docs/GUI.md)

---

## 核心能力（`0.3.0`）

| 能力 | 工具 / 机制 | 说明 |
|---|---|---|
| **一模多档角色池** | `planners` / `reviewers` / `experts` / `delegates.low` / `delegates.medium` | 同一模型可配多条不同 `reasoningEffort`、`tier`（`standard`/`deep`）、`tags` 与执行后端 `backend`（默认 `dsh-spawn`，可热插拔外部后端） |
| **带只读工具规划器** | `request_plan({ mode: 'new'\|'followup', ... })` | 首轮 `delivery:'caller'` + `outputSchema` 同步产出 `plan.json`/`plan.md`；同任务续聊走 `coldResume`（V5-A 异步回执自动更新 `plan.json`），超 3 轮自动清零重开并升档 `deep` |
| **独立新鲜只读复审** | `request_review({ scope, summary, ... })` | 轨 B 先跑零成本 URL/二手源预检，再由新鲜只读子代理核查；轨 C 对照 `plan.json` 验收清单与实跑证据逐项打分 |
| **三道宿主级硬门禁** | `tools.guard` + `agent/turn-stopping` | ① 规划门禁（轨 C 未规划禁写）；② §12 止损熔断（默认 20 步或连错 3 次硬阻断）；③ 交付复审门禁（拦 `present` 与纯文本直接收尾，带 `maxReviewRetries` 上限与专属 `source.kind`）；全门禁支持人类逃生阀（回复「跳过规划/复审/门禁」立即放行） |
| **只读子代理双保险** | `worker-readonly` 预设 + `readonlyChildIds` 守卫 | 预设物理禁写并省去 46 KB 全量 `AGENTS.md`（插件自动注入 ~1.5 KB 精简 preamble），同时宿主 `tools.guard` 按预分配 `childId` 兜底硬拒继承自全局层的写工具 |
| **通用外部后端适配口** | Cordis 服务 `tieredWorkflow.registerBackend(adapter)` + 动态工具 `dispatch_external` | 严格遵循 `ExternalBackendAdapter` v1 契约，可热插拔接入独立插件（如 [dsh-antigravity-adapter](https://github.com/Soul-Charge/dsh-antigravity-adapter)），支持 `run` 与 `handoff` 人工交棒 |
| **6 维全树实时记账** | 全局 `session/event` → `workflow-metrics.jsonl` | 实时聚合父会话 + 所有子代理 + 外部后端的 6 维互斥 `TokenUsage`（`inputTokens`/`cacheReadTokens`/`cacheWriteTokens`/`outputTokens`/`reasoningTokens`/`totalTokens`），并修复 `finish.reason.kind` |
| **兼容旧工具** | `ask_expert` / `delegate` | 100% 兼容 `0.2.x` 配置与调用方式，增强一模多档、`worker-readonly`/`worker-exec` 预设自动挂载与精简 preamble 自动前置 |

---

## 仓库目录结构

```text
src/
  index.js           # Cordis 命名导出入口（无 export default），挂载模块并 provide('tieredWorkflow')
  config.js          # schemastery Config（兼容 0.2.x）与一模多档 pickProfile 选路器
  backends.js        # ExternalBackendAdapter v1 校验与注册表
  state.js           # 会话级三轨状态机（A/B/C 快筛、纠偏升档、逃生阀、§12 计数与持久化）
  metrics.js         # 6 维互斥 TokenUsage 采集与 workflow-metrics.jsonl 记账
  prompts.js         # 精简 preamble、Plan/Review JSON Schema、提示词构造与 JSON 代码块降级抽取
  research-check.js  # 轨 B 零成本来源分级代码预检
  runner.js          # dsh-spawn（V5-A）与外部后端统一执行器
  gates.js           # 三道宿主硬门禁 + 只读子代理 0 号兜底守卫
  tools.js           # 5 个工作流工具注册（含 dispatch_external 动态显隐）
  client.js          # Web GUI 设置页（5 张角色档位表 + 工作流与硬门禁开关/阈值）
presets/
  core-v1.patch.yml          # 日常极简主力基座预设（~480 字）
  core-heavy.patch.yml       # 攻坚规划优先入口（初始锁定轨 C）
  worker-readonly.patch.yml  # 内部只读子代理预设（order: 90，省 46 KB AGENTS.md）
  worker-exec.patch.yml      # 内部施工子代理预设（order: 91）
test/
  unit.test.mjs              # 纯逻辑 + 假宿主设置页单元测试
  dsh-integration.test.mjs   # 基于真实 DSH 0.2.1-rc.2 核心栈的端到端隔离集成测试
```

---

## 安装与部署

1. 将本仓库装入 profile（`link:` 必须使用 **Windows 绝对路径**）：
   ```powershell
   dsh plugin --profile web add link:F:/AiHarness/projects/dsh-expert-bridge
   ```
   > 首次克隆需建立 `@deepseek-ai/schemastery` 目录联接：
   > ```powershell
   > New-Item -ItemType Directory -Force 'F:/AiHarness/projects/dsh-expert-bridge/node_modules/@deepseek-ai'
   > New-Item -ItemType Junction `
   >   -Path 'F:/AiHarness/projects/dsh-expert-bridge/node_modules/@deepseek-ai/schemastery' `
   >   -Target 'C:/Program Files/nvm/v24.18.1/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/schemastery'
   > ```
2. （推荐）将 `presets/*.patch.yml` 按需合入 `$DSH_HOME/profiles/web/cordis.patch.yml`，并在 `expert-bridge` 配置行补全路径字段（`workflow.stateDir`、`workflow.metricsLog`、`workflow.preambleFile`、`usageLog`、`debugLog`）。
3. 重启 `dsh web` 后，打开 **「设置 → 分层工作流」** 配置各角色档位池（支持同一模型配多条不同 `reasoningEffort` 与 `standard`/`deep` 档位）与硬门禁阈值。

---

## 验证

```powershell
npm test                   # 9/9 单元测试（Config/选路/后端契约/6维记账/状态机/来源预检/GUI 设置页）
npm run test:integration   # 真实 DSH 0.2.1-rc.2 核心栈端到端隔离集成测试（E2E-1 ~ E2E-7 全绿）
```

## License

MIT
