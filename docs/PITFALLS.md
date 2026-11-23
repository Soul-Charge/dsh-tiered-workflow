# 踩过的坑（都是实测出来的）

> 本文件是 dsh-expert-bridge 的排障清单。前 8 条是单文件 `file://` 时代的原始记录（保留作历史），
> 9 起是升级成正式插件包后新增的。

## A. 单文件 `file://` 时代（历史，2026-11 之前）

1. **同一个 id 首次挂载失败后，改对再重载也不生效**——必须换 id。怀疑宿主保留了该 id 的错误注册状态。**升级成包之后这条依然成立**：新行请用新 id，别复用旧的 `expert-bridge-v*`。
2. **`output.schema` 是标准 JSON Schema**：属性上写 `required: true` 会报 `unsupported JSON schema: …required is not supported on type "string"`，要用对象级的 `required: [...]` 数组。
3. **preset 内的插件行不热生效**：挂在 preset 里时，新派子代理也拿不到；宿主级行改完即生效。
4. **`agent.inject` 的消息以 `role: user` 落进上下文**：文案必须带「系统提醒·非用户输入」前缀，否则会被当成用户指令。
5. **专家调用期间置 `inExpert`**：防止嵌套调用把 47 的节拍算歪。
6. **`createUserMessage` 不必要**：`llm.stream` 接受 `{ role:'user', content:[{type:'text',text}] }` 即可。
7. **改插件文件内容不会重载**：同一路径重新 import 会命中 Node 模块缓存；旧做法是复制成新文件名并把 YAML 指过去。升级成包之后仍建议**改版本号或重启**，别指望热替换。
8. **`parameters` 必须是标准 JSON Schema**：写成 `{ package: { type:'string', required:true } }` 这种内联 DSL，PTC SDK 只渲染成 `ask_expert: unknown`，模型看不到参数名。正确写法是 `{ type:'object', required:['package'], properties:{ package:{ type:'string', description } } }`。

## B. 正式插件包（0.2.0 起）

9. **设置命名空间 = profile 条目 id**。`dsh-settings` 按 `entry.options.id` 定位命名空间，浏览器设置页读写的也是同一个字符串。本包两处都必须叫 `expert-bridge`（`cordis.patch.yml` 的 `id` 与 `src/client.js` 的目标命名空间）。不一致时设置页只会显示"宿主未提供设置命名空间 xxx"，不会报错。

10. **裸导入依赖仓库内的目录联接**。`import z from '@deepseek-ai/schemastery'` 是相对**本包目录**解析的：仓库里没有 `node_modules` 时，直接 `node --input-type=module -e "import('file:///<repo>/src/index.js')"` 就报 `ERR_MODULE_NOT_FOUND: @deepseek-ai/schemastery`（实测），宿主加载同理会失败。解法是在仓库里放一个目录联接指向宿主安装的那份：

    ```powershell
    New-Item -ItemType Junction -Path <repo>/node_modules/@deepseek-ai/schemastery `
      -Target 'C:/Program Files/nvm/v24.18.1/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/schemastery'
    ```

    `.gitignore` 已忽略 `node_modules/`，联接不进版本库；**新机器克隆后必须重建**。建好后实测整包导入正常（`Config=function`、`default=undefined`）。

11. **`volatile` 的两个硬限制**（schemastery）：不能嵌套 volatile（`z.object({...}).volatile()` 里再放 volatile 叶子会炸），也不能标在数组元素上。要让设置页能编辑一个列表，就**整数组 volatile**：`z.array(Route).default([]).volatile()`，页面整表替换。

12. **volatile 叶子是引用不是值**：解析后的配置里拿到的是 `{ get() }`（cosmokit volatile ref），而且设置页保存后会变。**每次调用重新读**（本包用 `plain()` 递归解引用），不要在 `apply` 里缓存一份快照。

13. **旧的 `file://` 行必须删掉**。升级成包之后若旧行还在，会同时挂载两份插件、注册两个同名 `ask_expert`，宿主报重复工具；排查时先 `Select-String` 一遍 profile 的 `cordis.patch.yml`。

14. **低档子代理的"只读"是软约束**。实现只在工具描述与子代理 prompt 前置段写死只读要求，没有沙箱、没有工具白名单、没有受限 preset。低档模型仍可能写文件；需要硬隔离请自己给它挂受限 preset。**任何文档都不许把它写成"强制只读"**。

15. **`agentOptions` 只认三个字段**：`{ provider, model, reasoningEffort? }`。给 `startActivation` 传别的字段会被忽略或直接失败；`delivery:'parent'` 才会把完成通知送回父会话（`'caller'` 是工作流等待模式）。

16. **`routeOf(agent)` 拿不到路由不是错误**：某些上下文（例如没有请求头的合成会话）`session.requestHeader()` 返回空，此时记账里执行者是 `/`，且「自己就是专家」的跳过判断不会触发。这是有意的降级，不要改成抛错。
