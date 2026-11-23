# dsh-expert-bridge

给弱模型一个「卡住就问专家」的通道，外加一条长尾试错的硬提醒。单文件 DSH 插件，MIT。

## 它解决什么问题

小模型跑长任务时有两种典型浪费：

1. **该问不问**——已经试了十几次还在同一条路上，直到人手动把问题搬到更强的模型那里；
2. **问得太贵**——把整个子代理体系（人设 + 几十个工具 schema）搬给专家，一次咨询先付三万 token。

这个插件把两件事拆开：**通道**做成一次裸 LLM 调用（专家只读你粘贴的求助包，没有工具、看不到文件），**触发**做成 harness 侧的硬提醒（工具调用计数 → 注入一条提醒）。

## 两个能力

| 能力 | 实现 |
| --- | --- |
| `ask_expert(package)` | 同步调用 `ctx.llm.stream`，返回纯文本建议 + usage；缺字段直接拒绝 |
| 长尾提醒 | `ctx.tools.guard` 计数，每 `threshold` 次工具调用 `agent.inject` 一条提醒，新回合归零 |

## 安装

把 `src/expert-bridge.mjs` 放到任意可读路径，然后在 DSH profile 的 `cordis.patch.yml` 末尾加：

```yaml
- insert:
    - id: expert-bridge
      name: 'file:///<ABSOLUTE_PATH>/expert-bridge.mjs'
      config:
        expert:
          provider: <YOUR_PROVIDER>          # 换成你自己的路由，代码里没有写死任何模型
          model: <YOUR_EXPERT_MODEL>
          reasoningEffort: ''
        maxTokens: 8000
        timeoutMs: 150000
        minPackageChars: 600
        systemPromptFile: '<ABSOLUTE_PATH>/CONSULTANT-SYSTEM.md'
        usageLog: '<DSH_HOME>/storages/expert-usage.jsonl'
        debugLog: '<DSH_HOME>/storages/expert-bridge-debug.log'
        reminder:
          enabled: true
          threshold: 47
          text: '[系统提醒·非用户输入] 本回合你已连续 {n} 次工具调用而没有向用户汇报。先自查是否已满足求助条件；满足就按 CONSULT-TEMPLATE.md 组织求助包后调用 ask_expert。'
```

宿主级行改完即生效（热重载），不需要重启；**preset 内的插件行不会热生效**，只能挂宿主级或重启。

## 配置项

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `expert.provider` / `expert.model` | 空 | 专家路由；空则工具直接报错，而不是静默失败 |
| `expert.reasoningEffort` | 空 | 透传给适配器，空=模型默认 |
| `maxTokens` | 8000 | 专家答复上限 |
| `timeoutMs` | 150000 | 单次调用超时 |
| `minPackageChars` | 600 | 求助包最小长度，低于即拒绝 |
| `systemPromptFile` | 空 | 专家端系统提示（含退回规则） |
| `usageLog` | 空 | JSONL 记账：时间 / 执行者 / 专家 / 字符数 / usage / 耗时 |
| `debugLog` | 空 | 每行 `tool=… count=… bucket=… inExpert=…` |
| `reminder.enabled/threshold/text` | true / 47 / … | 硬提醒；`{n}` 替换成当前计数 |

## 验证（三步）

1. **挂上**：改完 YAML 后看 debug 日志，应出现 `tool=… count=1 …`；
2. **拒绝路径**：调 `ask_expert({package:'短'})`，应报「求助包太短…缺第几次…」；
3. **真实调用**：按 `docs/CONSULT-TEMPLATE.md` 写一份包，调用后应同步返回，并在 usage 日志多一行。

## 为什么是插件，不是"让子代理去问"

- 子代理继承父会话的整套人设与工具 schema，一次咨询首轮就三万多 token，而专家只需要读你那段求助包；
- 子代理是**异步**的（返回 activation id，答案下一轮才到），咨询这种交互，同步更顺；
- 只有 harness 侧的计数与注入，才能把"该问"从软约束变成硬信号。

## 已知坑

见 [docs/PITFALLS.md](docs/PITFALLS.md)。最常踩的三条：

1. 改插件文件内容不会重载——**必须换文件名**（模块按路径缓存）；
2. `parameters` 必须是标准 JSON Schema，写成内联 DSL 会渲染成 `unknown`；
3. `agent.inject` 的消息以 `role: user` 落进上下文，文案要带「系统提醒·非用户输入」前缀。

## License

MIT
