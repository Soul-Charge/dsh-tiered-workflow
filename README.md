# dsh-expert-bridge

> **V2 演进蓝图（仓库已更名为 `dsh-tiered-workflow`）**：基于生产实测（26 次提醒 → 0 次主动求助），本插件正从「单点专家求助桥」演进为「模型 × 推理强度分档 + 三轨工作流 + 宿主硬门禁」的完整分工框架。详见架构设计 [docs/WORKFLOW-ARCHITECTURE.md](docs/WORKFLOW-ARCHITECTURE.md) 与 DSH 底层探针实测报告 [docs/PLATFORM-PROBES.md](docs/PLATFORM-PROBES.md)。当前本地运行态（`0.2.x`）仍维持原目录与包名不变，留待 V2 实施时一次性迁移。

给弱模型一个「卡住就问专家」的通道，一条长尾试错的硬提醒，以及一个**按能力分档派子代理**的入口。DSH 插件包（MIT），带浏览器设置页。

## 它解决什么问题

小模型跑长任务时有三种典型浪费：

1. **该问不问**——已经试了十几次还在同一条路上，直到人手动把问题搬到更强的模型那里；
2. **问得太贵**——把整套子代理体系（人设 + 几十个工具 schema）搬给专家，一次咨询先付三万 token；
3. **杂活也用主力**——改个错字、翻一遍目录、摘一段日志，也拿最贵的模型跑。

这个插件把三件事分开：**咨询**做成一次裸 LLM 调用（专家只读你粘贴的求助包，没有工具、看不到文件）；**触发**做成 harness 侧的硬提醒（工具调用计数 → 注入一条提醒）；**分档干活**做成两个可配置的子代理池（低档做杂活，中档能力接近主力）。

## 三个能力

| 能力 | 实现 | 说明 |
| --- | --- | --- |
| `ask_expert(package, need?)` | `ctx.llm.stream` 裸调用 | 同步返回纯文本建议；专家无工具、看不到文件；缺字段直接拒绝；可按标签选专家 |
| `delegate(tier, task, need?, description?)` | `subagents.startActivation` | 异步派子代理，立即返回子会话 id；`low` 只读软约束、`medium` 可读写 |
| 长尾提醒 | `ctx.tools.guard` 计数 + `agent.inject` | 同一回合连续 N 次工具调用后注入一条提醒，新回合归零 |

## 安装

1. 把本仓库装进 profile（`link:` 用 **Windows 绝对路径**）：

   ```powershell
   dsh plugin --profile web add link:F:/AiHarness/projects/dsh-expert-bridge
   ```

   这会同时写 profile `package.json` 的 `dependencies` 与 `dsh.profile.bundles`，并挂上包内 `cordis.patch.yml` 的 `expert-bridge` 行。

   > **新机器克隆后必须先建依赖联接**。本包从**自己目录**解析 `@deepseek-ai/schemastery`，仓库里不放 `node_modules`（`.gitignore` 已忽略）；缺这个联接时 `import()` 整包直接报 `ERR_MODULE_NOT_FOUND`（实测）。建法：
   >
   > ```powershell
   > New-Item -ItemType Junction -Path 'F:/AiHarness/projects/dsh-expert-bridge/node_modules/@deepseek-ai/schemastery' `
   >   -Target 'C:/Program Files/nvm/v24.18.1/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/schemastery'
   > ```
   >
   > 建好后应能验证：`node --input-type=module -e "console.log(typeof (await import('file:///.../src/index.js')).Config)"` 输出 `function`。

2. 在 profile 的 `cordis.patch.yml` 里给这一行补上部署相关字段（路径、提醒文案），模型路由留空、交给设置页：

   ```yaml
   - insert:
       - id: expert-bridge
         name: dsh-expert-bridge
         config:
           systemPromptFile: '<ABSOLUTE_PATH>/src/CONSULTANT-SYSTEM.md'
           usageLog: '<DSH_HOME>/storages/expert-usage.jsonl'
           debugLog: '<DSH_HOME>/storages/expert-bridge-debug.log'
   ```

3. 打开 Web GUI 的「设置 → 专家桥（expert-bridge）」，在**专家列表 / 低档子代理 / 中档子代理**里各加一条（provider + model 必填，模型选项来自 DSH 当前可路由模型目录）。保存会写回 profile patch。

4. 宿主级插件行改完即生效（热重载），**新装插件包或改包内代码需要重启 `dsh web`**；preset 内的插件行不会热生效。

> ⚠️ 从旧版（`file://` 直接挂 `.mjs`）升级时，**必须删掉旧的 `file://` 行**。两条行同时存在会注册两个同名 `ask_expert`，宿主直接报重复工具。

## 配置（settings namespace = profile 条目 id = `expert-bridge`）

| 键 | 默认 | 设置页可写 | 含义 |
| --- | --- | --- | --- |
| `experts[]` | `[]` | ✅ 整数组 | 专家列表：`{name, provider, model, reasoningEffort, tags[], note, systemPrompt}` |
| `delegates.low[]` | `[]` | ✅ 整数组 | 低档子代理池（只读软约束），形状同上但无 `systemPrompt` |
| `delegates.medium[]` | `[]` | ✅ 整数组 | 中档子代理池（可读写） |
| `maxTokens` | 8000 | ✅ | 专家答复上限 |
| `timeoutMs` | 150000 | ✅ | 单次咨询超时 |
| `minPackageChars` | 600 | ✅ | 求助包最小长度，低于即拒绝 |
| `reminder.enabled` | true | ✅ | 长尾提醒开关 |
| `reminder.threshold` | 47 | ✅ | 连续多少次工具调用后提醒 |
| `systemPromptFile` | 空 | ❌ 走 patch | 专家端全局系统提示（含退回规则） |
| `usageLog` | 空 | ❌ 走 patch | JSONL 记账 |
| `debugLog` | 空 | ❌ 走 patch | 每行 `tool=… count=… bucket=… inExpert=…` |
| `reminder.text` | 内置文案 | ❌ 走 patch | `{n}` 会替换成当前计数 |

**代码里没有任何写死的 provider/model**；执行者模型在运行时从 `agent.session.requestHeader()` 读取，只用于记账与「自己就是专家时跳过」。路由列表整数组保存（设置页整表替换），volatile 叶子每次调用重新读取，所以设置页保存后立即生效，不用重启。

## 两个工具怎么用

### `ask_expert({ package, need? })`

1. 填 `docs/CONSULT-TEMPLATE.md`：第几次 / 根治定义 / 已证伪假设≥2 条 / 一个问题；
2. 结构缺项会被拒绝（`minPackageChars` + 四类正则）；
3. `need` 给了就在专家列表里按 `tags` 匹配（大小写不敏感），没命中或没给就用第一条可用的；返回里有 `matched` 告诉你是否命中；
4. 返回：`answer` / `expert`（名称或 `provider/model`）/ `truncated` / `matched` / `need` / 可选 usage。

### `delegate({ tier, task, need?, description? })`

- `tier:"low"`：便宜模型。**只读是软约束**——工具描述与子代理 prompt 都要求它只读（读文件、搜索、看只读命令输出；禁止写文件、改配置、跑写入型命令），但它**不是**沙箱强制隔离。重要改动自己复核。
- `tier:"medium"`：能力接近主力的模型，可以读写文件，适合边界清楚、一次能讲完的子任务。
- 立即返回 `{ kind:"activation", subagentId, tier, provider, model }`；子代理异步跑完，宿主把完成通知送回父会话。
- 子代理看不到你当前会话的历史，`task` 要写全：目标、边界、交付物、验收标准。
- `need` 按 `tags` 在该档模型池里挑；不填就用该档第一条。

## 验证

- `node --check src/index.js` 通过；
- `Config` 用真实 schemastery 跑过：默认值正确、样例配置被接受、非法数组被拒（`$.experts expected array`）；
- 26 项工具级冒烟（假 ctx + 假 llm + 假 subagents）：结构校验、need 选路、跳过自身、空列表报错、`startActivation` 参数形状、只读前置、非法 tier、guard 计数与提醒、guard 不抛错——全绿；
- 真实链路验证：装上后在设置页配好路由，调 `ask_expert` 应同步返回并在 `usageLog` 多一行；调 `delegate` 应返回子会话 id，子代理结束后父会话收到通知。

## 为什么是插件，不是"让子代理去问"

- 子代理继承父会话的整套人设与工具 schema，一次咨询首轮就三万多 token，而专家只需要读你那段求助包；
- 子代理是**异步**的，咨询这种交互，同步更顺（所以咨询走 `ask_expert`，干活走 `delegate`）；
- 只有 harness 侧的计数与注入，才能把"该问"从软约束变成硬信号。

## 已知坑

见 [docs/PITFALLS.md](docs/PITFALLS.md)。最容易踩的四条：

1. **设置命名空间必须等于 profile 条目 id**（`expert-bridge`），否则设置页显示"宿主未提供设置命名空间"；
2. 插件从**自身目录**解析 `@deepseek-ai/schemastery`：仓库里没有 `node_modules` 时，`import()` 整包直接报 `ERR_MODULE_NOT_FOUND`（实测），宿主也就起不来——部署前必须按「安装」一节建好那个目录联接；
3. `volatile` 不能嵌套 `volatile`，也不能标在数组元素上；要整数组可写就 `z.array(X).default([]).volatile()`；
4. `parameters` / `output.schema` 必须是标准 JSON Schema，对象级 `required: []`，别在属性上写 `required: true`。

## License

MIT
