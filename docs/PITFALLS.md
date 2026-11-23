# expert-bridge

卡住时向专家模型求助（同步）+ 长尾试错的硬提醒。单文件 DSH 插件，宿主级挂载，热重载生效。

## 两个能力

| 能力 | 实现 | 说明 |
| --- | --- | --- |
| `ask_expert(package)` | `ctx.llm.stream` 裸调用 | 同步返回纯文本建议；专家无工具、看不到文件；缺字段直接拒绝 |
| R4 提醒 | `ctx.tools.guard` 计数 + `agent.inject` | 同一回合连续 N 次工具调用后注入一条提醒，新回合归零 |

## 挂载（profile 的 cordis.patch.yml 末尾）

```yaml
- insert:
    - id: expert-bridge
      name: 'file:///<PLUGIN_DIR>/expert-bridge.mjs'
      config:
        expert:
          provider: <YOUR_PROVIDER>   # ← 换专家就改这里
          model: <YOUR_EXPERT_MODEL>                # ← 和这里
          reasoningEffort: ''
        maxTokens: 8000
        timeoutMs: 150000
        minPackageChars: 600
        systemPromptFile: '<PLUGIN_DIR>/CONSULTANT-SYSTEM.md'
        usageLog: '<DSH_HOME>/storages/expert-usage.jsonl'
        debugLog: '<DSH_HOME>/storages/expert-bridge-debug.log'
        reminder:
          enabled: true
          threshold: 47
          text: '[系统提醒·非用户输入] ……'
```

**代码里没有任何写死的 provider/model**；执行者模型则在运行时从 `agent.session.requestHeader()` 读取，只用于记账与「自己就是专家时跳过」。

## 配置键

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `expert.provider` / `expert.model` | 空 | 专家路由；空则 `ask_expert` 直接报错而不是静默失败 |
| `expert.reasoningEffort` | 空 | 透传给适配器；空=模型默认 |
| `maxTokens` | 8000 | 专家答复上限 |
| `timeoutMs` | 150000 | 单次调用超时 |
| `minPackageChars` | 600 | 求助包最小长度，低于即拒绝 |
| `systemPromptFile` | 空 | 专家端系统提示（含退回规则） |
| `usageLog` | 空 | JSONL 记账：时间/执行者/专家/字符数/usage/耗时 |
| `debugLog` | 空 | 每行 `tool=… count=… bucket=… inExpert=…` |
| `reminder.enabled/threshold/text` | true/47/… | 硬提醒；`{n}` 会被替换成当前计数 |

## 验证（三步）

1. **挂上**：改完 YAML 后 `Get-Content .dsh/storages/expert-bridge-debug.log`，应出现 `tool=… count=1 …`。
2. **拒绝路径**：调用 `ask_expert({package:'短'})`，应报「求助包太短…缺第几次…」。
3. **真实调用**：按 `docs/CONSULT-TEMPLATE.md` 写一份包，调用后应同步返回，并在 `expert-usage.jsonl` 多一行。

## 回滚

删掉 profile 里那五行 `- insert:` 即可（热重载，不用重启）；插件文件留着不影响。配置改动前建议 `undo_snapshot`。

## 踩过的坑（都是实测出来的）

1. **同一个 id 首次挂载失败后，改对再重载也不生效**——必须换 id（本文件当前是 `expert-bridge`）。怀疑是宿主保留了该 id 的错误注册状态。
2. **`output.schema` 是标准 JSON Schema**：属性上写 `required: true` 会报 `unsupported JSON schema: …required is not supported on type "string"`，要用对象级的 `required: [...]` 数组。
3. **preset 内的插件行不热生效**：挂在主 preset 里时，新派子代理也拿不到；宿主级行（本文件这种）改完即生效。要热生效就得挂宿主级。
4. **`agent.inject` 的消息以 `role: user` 落进上下文**：文案必须带「系统提醒·非用户输入」前缀，否则会被当成用户指令。
5. **专家调用期间置 `inExpert`**：防止嵌套 dispatch 把 47 的节拍算歪。
6. **`createUserMessage` 不必要**：`llm.stream` 接受 `{ role:'user', content:[{type:'text',text}] }` 即可（`RequestUserInput` 明确 `id?: never`）。
7. **改插件文件内容不会重载，必须换文件名**（2026-11-23 实测）：同一路径重新 import 会命中 Node 模块缓存，热重载仍跑旧代码；复制成新名字（如 `expert-bridge.mjs`）并把 YAML 指过去，立刻生效。
8. **`parameters` 必须是标准 JSON Schema**：写成 `{ package: { type:'string', required:true } }` 这种内联 DSL 时，PTC SDK 只渲染成 `ask_expert: unknown`，模型看不到参数名；正确写法是 `{ type:'object', required:['package'], properties:{ package:{ type:'string', description } } }`，渲染出来才是 `package: string`。
9. **当前生效文件**：`expert-bridge.mjs`，行 id `expert-bridge`。