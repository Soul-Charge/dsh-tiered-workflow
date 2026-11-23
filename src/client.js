// dsh-expert-bridge — 浏览器端设置页（DSH Web GUI），接口契约 v2
//
// 职责：在「设置」里提供一个整页分区，编辑本插件（设置命名空间 = profile 条目 id
// 'expert-bridge'）的可调项：
//   ① 专家列表（ask_expert 用：可带 tags / note / 附加 systemPrompt）
//   ② 低档子代理列表（delegate 用：只读**软约束**，见下）
//   ③ 中档子代理列表（delegate 用）
//   ④ 数值四项（maxTokens / timeoutMs / minPackageChars / reminder.threshold）
//   ⑤ 提醒开关（reminder.enabled）
//   ⑥ 保存 / 放弃 + 状态提示
//
// 数据来源与写入通道全部走官方客户端服务，不自建端点：
//   * 读：ctx.configForms.get('expert-bridge').getSnapshot()（宿主 describe 镜像）
//   * 写：同一个控制器的 mutate(ops, revision)；被宿主拒绝时 resolve(false)，不抛错
//   * 模型目录：ctx.remote.session.modelCatalog()（provider = group.id，model = model.id）
//   * 只在宿主确实提供该命名空间时挂载：ctx.configForms.whileServed([...], register)
//
// 数组字段在宿主侧是「整数组 volatile」，所以页面一次整表替换，不能逐元素写。
//
// ⚠ 低档子代理的「只读」是**软约束**：实现方式是 host 在委派时往子代理 prompt 里
//   写明「只读」，宿主侧没有强制工具限制。本页文案与 docs/GUI.md 都必须这么写，
//   不得宣称「强制只读」。
//
// 设计约束：
//   * bundle 里没有模块语法（它是 __ModuleLoader__ 工厂），样式全部内联；
//   * 代码里不写死任何 provider / model，选项全部来自模型目录；
//   * loading / unavailable / 只读 / 目录为空 / 目录失败 / 保存被拒 / revision 冲突
//     七种状态都有可见文案；不用 alert / confirm。
window.__ModuleLoader__.load({
  id: 'dsh-expert-bridge',
  factory(require) {
    const react = require('react')

    /** 设置命名空间 = profile 里本插件的条目 id（与 host 的 Config 一一对应）。 */
    const NS = 'expert-bridge'

    /**
     * 三个可编辑清单。path 是 mutate 用的 Config 路径（整表替换），
     * withSystemPrompt 表示该清单的条目多一个 systemPrompt 字段。
     */
    const LISTS = [
      { key: 'experts', path: ['experts'], withSystemPrompt: true },
      { key: 'low', path: ['delegates', 'low'], withSystemPrompt: false },
      { key: 'medium', path: ['delegates', 'medium'], withSystemPrompt: false },
    ]

    /** 数值项：界面控件 ↔ Config 路径。 */
    const NUMBER_FIELDS = [
      { key: 'maxTokens', path: ['maxTokens'], min: 1, max: 2000000, fallback: 8000 },
      { key: 'timeoutMs', path: ['timeoutMs'], min: 1000, max: 3600000, fallback: 150000 },
      { key: 'minPackageChars', path: ['minPackageChars'], min: 0, max: 200000, fallback: 600 },
      { key: 'reminderThreshold', path: ['reminder', 'threshold'], min: 1, max: 100000, fallback: 47 },
    ]

    // ── 文案（zh 必填，en 同键同义）─────────────────────────────────────────────
    const ZH = {
      nav: '专家桥',
      title: '专家桥（expert-bridge）',
      intro:
        '卡住时把按模板写好的求助包发给专家（ask_expert）；需要跑杂活时，用 delegate 把任务派给低档或中档子代理。' +
        '三张清单里的模型都从这里选，选项来自 DSH 当前的模型目录。',
      expertsTitle: '专家列表',
      expertsDesc: 'ask_expert 按 need 匹配这些条目的 tags；没给 need 或没命中时用第一条配置完整的。',
      lowTitle: '低档子代理',
      lowDesc:
        '做简单杂活的子代理。只读是**软约束**：委派时宿主只在子代理提示里写明「只读、不要写文件」，并没有强制限制工具——别指望它可靠地改文件。',
      mediumTitle: '中档子代理',
      mediumDesc: '能力接近主力的子代理：可以读写文件、跑命令，用于需要动手的委派。',
      listEmpty: '清单为空。点下面的「添加一条」开始配置。',
      addItem: '添加一条',
      moveUp: '上移',
      moveDown: '下移',
      remove: '删除',
      itemIndex: '第 {n} 条',
      fieldName: '名称（可空）',
      fieldNameHint: '给人看的标签，记账与回执里会用到。',
      fieldNote: '备注（可空）',
      fieldNoteHint: '给自己看的说明，不影响匹配。',
      fieldProvider: '供应商路由',
      fieldModel: '模型',
      fieldEffort: '推理档位',
      fieldTags: '标签（逗号分隔）',
      fieldTagsHint: 'ask_expert / delegate 的 need 会与这里的标签逐一比对（去空白、大小写不敏感）。',
      fieldSystemPrompt: '附加系统提示（可空）',
      fieldSystemPromptHint: '非空时拼在全局 CONSULTANT-SYSTEM.md 之后，作为这位专家的额外要求。',
      notSelected: '（未选择）',
      effortDefault: '（模型默认）',
      missingInCatalog: '（当前目录中不存在，已保留原值）',
      incompleteItem: '供应商与模型要么都选，要么都留空。',
      numbers: '运行参数',
      maxTokens: '回答上限（maxTokens）',
      timeoutMs: '单次调用超时（毫秒）',
      minPackageChars: '求助包最小长度（字符）',
      reminder: '长尾试错提醒',
      reminderEnabled: '开启回合内提醒',
      reminderThreshold: '触发阈值（连续工具调用次数）',
      save: '保存',
      saving: '保存中…',
      discard: '放弃修改',
      dirty: '有未保存的修改',
      clean: '与宿主当前值一致',
      loading: '正在读取模型目录…',
      catalogEmpty: '宿主当前没有可路由的模型：请先在「设置 → 模型」里配置至少一个供应商。',
      catalogErrorPrefix: '模型目录读取失败：',
      catalogApiMissing:
        '当前宿主没有提供模型目录接口（remote.session.modelCatalog），无法列出可选模型；可继续在 cordis.patch.yml 里手填。',
      unavailable:
        '宿主还没有提供 expert-bridge 这个设置命名空间：插件未安装、条目未启用或被组合拒绝时都是这个状态，重启 DSH 后再看。',
      formLoading: '正在读取当前设置…',
      readonly: '当前设置文档为只读（部署层或命令行覆盖），页面不能写入。',
      invalidNumber: '必须是整数（minPackageChars 可为 0）',
      invalidEmpty: '不能为空',
      errInvalid: '有输入不合法，先修正标红的字段。',
      errConflict: '设置已在别处被修改，为避免覆盖别人的改动，这次没有写入。请点「放弃修改」重新读取后再改。',
      conflictDetail: '（期望 revision {expected}，实际 {actual}）',
      errRejected:
        '宿主拒绝了这次写入：命名空间未注册、或字段不被接受（Config 与页面字段不一致时会这样）。草稿已保留。',
      errSavePrefix: '保存失败：',
      saved: '已保存，立即生效（无需重启 DSH）。',
      nothingToSave: '没有需要保存的修改。',
      failuresPrefix: '部分供应商未能加载：',
      saveHint: '写入走宿主的 settings.mutate，落在 profile 的 cordis.patch.yml 里。',
    }
    const EN = {
      nav: 'Expert Bridge',
      title: 'Expert Bridge (expert-bridge)',
      intro:
        'Send a template-shaped consult package to an expert (ask_expert) when stuck; use delegate to hand chores to a low or medium subagent. ' +
        'Every model in the three lists is picked here, from the models DSH currently routes.',
      expertsTitle: 'Experts',
      expertsDesc: 'ask_expert matches these entries by tag against need; with no need (or no match) it takes the first fully configured one.',
      lowTitle: 'Low-tier subagents',
      lowDesc:
        'A subagent for simple chores. Read-only is a SOFT constraint: on delegation the host only writes "read-only, do not write files" into the child prompt and does not restrict its tools. Do not expect it to edit files reliably.',
      mediumTitle: 'Medium-tier subagents',
      mediumDesc: 'A subagent about as capable as the main model: may read and write files and run commands.',
      listEmpty: 'This list is empty. Use "Add entry" below to start.',
      addItem: 'Add entry',
      moveUp: 'Move up',
      moveDown: 'Move down',
      remove: 'Remove',
      itemIndex: 'Entry {n}',
      fieldName: 'Name (optional)',
      fieldNameHint: 'A human label used in receipts and usage records.',
      fieldNote: 'Note (optional)',
      fieldNoteHint: 'Free-form reminder for yourself; does not affect matching.',
      fieldProvider: 'Provider route',
      fieldModel: 'Model',
      fieldEffort: 'Reasoning effort',
      fieldTags: 'Tags (comma separated)',
      fieldTagsHint: 'need on ask_expert / delegate is matched against these tags (trimmed, case-insensitive).',
      fieldSystemPrompt: 'Extra system prompt (optional)',
      fieldSystemPromptHint: 'Appended after the global CONSULTANT-SYSTEM.md when non-empty.',
      notSelected: '(not selected)',
      effortDefault: '(model default)',
      missingInCatalog: '(not in the current catalog, kept as-is)',
      incompleteItem: 'Pick both a provider and a model, or leave both empty.',
      numbers: 'Runtime parameters',
      maxTokens: 'Answer cap (maxTokens)',
      timeoutMs: 'Per-call timeout (ms)',
      minPackageChars: 'Minimum package length (chars)',
      reminder: 'Long-tail nudge',
      reminderEnabled: 'Enable in-turn nudge',
      reminderThreshold: 'Threshold (consecutive tool calls)',
      save: 'Save',
      saving: 'Saving…',
      discard: 'Discard changes',
      dirty: 'Unsaved changes',
      clean: 'Matches the host value',
      loading: 'Reading the model catalog…',
      catalogEmpty: 'The host routes no models right now: configure at least one provider under Settings → Models.',
      catalogErrorPrefix: 'Model catalog read failed: ',
      catalogApiMissing:
        'This host exposes no model catalog (remote.session.modelCatalog), so no options can be listed; you can still edit cordis.patch.yml by hand.',
      unavailable:
        'The host does not serve the expert-bridge settings namespace yet: the plugin is not installed, its entry is disabled, or the composition rejected it. Restart DSH and look again.',
      formLoading: 'Reading the current settings…',
      readonly: 'The settings document is read-only (deployment or command-line overlay), so this page cannot write.',
      invalidNumber: 'must be an integer (minPackageChars may be 0)',
      invalidEmpty: 'required',
      errInvalid: 'Some inputs are invalid; fix the highlighted fields first.',
      errConflict: 'The settings changed elsewhere, so nothing was written (that would overwrite the other change). Click "Discard changes" to reload before editing.',
      conflictDetail: ' (expected revision {expected}, actual {actual})',
      errRejected:
        'The host refused the write: the namespace is not registered, or a field was not accepted (a page/Config mismatch looks exactly like this). Your draft was kept.',
      errSavePrefix: 'Save failed: ',
      saved: 'Saved; effective immediately (no DSH restart needed).',
      nothingToSave: 'Nothing to save.',
      failuresPrefix: 'Some providers failed to load: ',
      saveHint: 'Writes go through the host settings.mutate and land in the profile cordis.patch.yml.',
    }

    // ── 小工具（不依赖任何外部模块）──────────────────────────────────────────────
    function record(value) {
      return value !== null && typeof value === 'object' && Array.isArray(value) === false ? value : {}
    }
    function str(value) {
      return typeof value === 'string' ? value : ''
    }
    function at(root, path) {
      let cursor = record(root)
      for (let index = 0; index < path.length; index += 1) {
        if (cursor === null || typeof cursor !== 'object') return undefined
        cursor = cursor[path[index]]
      }
      return cursor
    }
    function describeError(error) {
      if (error === null || error === undefined) return 'unknown error'
      if (typeof error === 'string') return error
      if (typeof error.message === 'string' && error.message !== '') return error.message
      try {
        return JSON.stringify(error)
      } catch (nested) {
        return String(error)
      }
    }
    /** 目录里一条 provider 分组里的模型列表。 */
    function modelsOf(group) {
      const models = record(group).models
      return Array.isArray(models) ? models.filter(function (item) { return item !== null && typeof item === 'object' }) : []
    }
    /** 某模型的推理档位列表（可能为空）。 */
    function effortsOf(model) {
      const reasoning = record(record(model).reasoning)
      const efforts = reasoning.efforts
      return Array.isArray(efforts) ? efforts.filter(function (item) { return item !== null && typeof item === 'object' }) : []
    }
    function findGroup(catalog, providerId) {
      if (providerId === '') return undefined
      const groups = Array.isArray(catalog.groups) ? catalog.groups : []
      for (let index = 0; index < groups.length; index += 1) {
        if (str(record(groups[index]).id) === providerId) return groups[index]
      }
      return undefined
    }
    function findModel(group, modelId) {
      if (group === undefined || modelId === '') return undefined
      const models = modelsOf(group)
      for (let index = 0; index < models.length; index += 1) {
        if (str(record(models[index]).id) === modelId) return models[index]
      }
      return undefined
    }

    /**
     * 标签文本 ↔ string[]：接受数组（宿主值）或逗号分隔文本（草稿）。
     * 规则：按中英文逗号切分、去首尾空白、丢空项、去重（保留首次出现，大小写原样）。
     */
    function splitTags(value) {
      const parts = Array.isArray(value)
        ? value.map(function (item) { return str(item) })
        : str(value).split(/[,，]/)
      const seen = Object.create(null)
      const result = []
      for (let index = 0; index < parts.length; index += 1) {
        const text = parts[index].trim()
        if (text === '') continue
        if (seen[text] === true) continue
        seen[text] = true
        result.push(text)
      }
      return result
    }
    function joinTags(value) {
      return splitTags(value).join(', ')
    }

    /** 一条清单项在草稿里的形状（tags 是文本，数字/文本都当字符串编辑）。 */
    function draftItem(source, withSystemPrompt) {
      const item = record(source)
      return {
        name: str(item.name),
        provider: str(item.provider),
        model: str(item.model),
        reasoningEffort: str(item.reasoningEffort),
        tags: joinTags(Array.isArray(item.tags) ? item.tags : []),
        note: str(item.note),
        systemPrompt: withSystemPrompt === true ? str(item.systemPrompt) : '',
      }
    }

    /** 一条清单项落盘的形状（整表替换时的 value 元素）。 */
    function writeItem(item, withSystemPrompt) {
      const result = {
        name: str(item.name),
        provider: str(item.provider),
        model: str(item.model),
        reasoningEffort: str(item.reasoningEffort),
        tags: splitTags(item.tags),
        note: str(item.note),
      }
      if (withSystemPrompt === true) result.systemPrompt = str(item.systemPrompt)
      return result
    }

    function projectHostList(value, withSystemPrompt) {
      const list = Array.isArray(value) ? value : []
      return list.map(function (item) { return writeItem(draftItem(item, withSystemPrompt), withSystemPrompt) })
    }
    function projectDraftList(list, withSystemPrompt) {
      const items = Array.isArray(list) ? list : []
      return items.map(function (item) { return writeItem(item, withSystemPrompt) })
    }
    /** 两条清单是否等价（双方都由 writeItem 产出，键序稳定，可直接序列化比较）。 */
    function sameList(a, b) {
      return JSON.stringify(a) === JSON.stringify(b)
    }

    /** 深拷一份宿主值当基线：快照是只读投影，留着比对「别人有没有改过这个字段」。 */
    function cloneValue(value) {
      if (value === null || typeof value !== 'object') return value
      try {
        return JSON.parse(JSON.stringify(value))
      } catch (error) {
        return value
      }
    }
    /** 标量/对象是否等价（配置值是 JSON 形状，序列化比较够用）。 */
    function sameValue(a, b) {
      if (a === b) return true
      if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
      try {
        return JSON.stringify(a) === JSON.stringify(b)
      } catch (error) {
        return false
      }
    }
    /** op.path 对应的清单规格；不是清单路径就返回 undefined。 */
    function listSpecOfPath(path) {
      for (let index = 0; index < LISTS.length; index += 1) {
        const spec = LISTS[index]
        if (spec.path.length !== path.length) continue
        let same = true
        for (let part = 0; part < spec.path.length; part += 1) {
          if (spec.path[part] !== path[part]) {
            same = false
            break
          }
        }
        if (same) return spec
      }
      return undefined
    }
    /** 错误是否像宿主侧 revision 冲突（两种情况都见过）。 */
    function looksLikeConflict(error) {
      const text = describeError(error).toLowerCase()
      return text.indexOf('settings_conflict') >= 0 || text.indexOf('changed since it was read') >= 0
    }

    /** 把宿主解出的配置值折算成页面草稿。 */
    function readDraft(value) {
      const source = record(value)
      const draft = { delegates: {} }
      for (let index = 0; index < LISTS.length; index += 1) {
        const spec = LISTS[index]
        const raw = at(source, spec.path)
        const list = Array.isArray(raw) ? raw : []
        const items = list.map(function (item) { return draftItem(item, spec.withSystemPrompt) })
        if (spec.key === 'experts') draft.experts = items
        else draft.delegates[spec.key] = items
      }
      for (let index = 0; index < NUMBER_FIELDS.length; index += 1) {
        const spec = NUMBER_FIELDS[index]
        const current = at(source, spec.path)
        draft[spec.key] = typeof current === 'number' && Number.isFinite(current) ? String(current) : ''
      }
      draft.reminderEnabled = record(source.reminder).enabled === true
      return draft
    }

    function emptyItem(withSystemPrompt) {
      return { name: '', provider: '', model: '', reasoningEffort: '', tags: '', note: '', systemPrompt: withSystemPrompt === true ? '' : '' }
    }

    /** 清单键 → 草稿里的数组。 */
    function listOf(draft, key) {
      if (draft === null) return []
      if (key === 'experts') return Array.isArray(draft.experts) ? draft.experts : []
      const delegates = record(draft.delegates)
      return Array.isArray(delegates[key]) ? delegates[key] : []
    }
    function setListOf(draft, key, items) {
      if (key === 'experts') draft.experts = items
      else draft.delegates[key] = items
    }

    function parseInteger(raw, spec) {
      const text = String(raw === undefined || raw === null ? '' : raw).trim()
      if (text === '') return { ok: false, missing: true }
      if (/^[0-9]+$/.test(text) === false) return { ok: false, missing: false }
      const value = Number(text)
      if (Number.isSafeInteger(value) === false) return { ok: false, missing: false }
      if (value < spec.min || value > spec.max) return { ok: false, missing: false }
      return { ok: true, value: value }
    }

    /** 页面控制器：宿主快照 + 模型目录 + 草稿 + 写入队列。 */
    class ExpertBridgePage {
      constructor(ctx, t) {
        this.ctx = ctx
        this.t = t
        this.form = ctx.configForms.get(NS)
        this.draft = null
        this.draftRevision = undefined
        // 基线：seed 时的宿主值快照。冲突判定只比较「本次要写的字段」的基线值与当前值，
        // 单纯的 revision 变化（插件热挂载 / 配置文档整体重载）不再拦人。
        this.baseline = null
        this.baselineRevision = undefined
        this.saving = false
        this.notice = null
        this.conflicted = false
        this.disposed = false
        this.catalog = { phase: 'loading', groups: [], failures: [], default: undefined, error: '' }
        this.listeners = new Set()
        this.snapshot = null
        this.captureFromForm()
        this.publish()
        const page = this
        this.offForm = this.form.subscribe(function () { page.onFormChange() })
        this.offAdapters = this.watchAdapters()
        this.loadCatalog()
      }

      /** 目录变更事件：宿主换路由时重拉选项；拿不到订阅能力就只靠手动重载。 */
      watchAdapters() {
        const remote = this.ctx.remote
        if (remote === null || remote === undefined || typeof remote.$on !== 'function') return function () {}
        const page = this
        try {
          const off = remote.$on('llm/adapters-updated', function () { page.loadCatalog() })
          return typeof off === 'function' ? off : function () {}
        } catch (error) {
          return function () {}
        }
      }

      loadCatalog() {
        if (this.disposed) return
        const remote = this.ctx.remote
        const session = remote === null || remote === undefined ? undefined : remote.session
        if (session === undefined || session === null || typeof session.modelCatalog !== 'function') {
          this.catalog = { phase: 'error', groups: [], failures: [], default: undefined, error: this.t('catalogApiMissing') }
          this.publish()
          return
        }
        this.catalog = {
          phase: 'loading',
          groups: this.catalog.groups,
          failures: this.catalog.failures,
          default: this.catalog.default,
          error: '',
        }
        this.publish()
        const page = this
        Promise.resolve(session.modelCatalog()).then(
          function (response) {
            if (page.disposed) return
            if (response === null || response === undefined || response.ok !== true) {
              const error = response !== null && response !== undefined ? response.error : undefined
              const text = describeError(error)
              page.catalog = {
                phase: 'error',
                groups: [],
                failures: [],
                default: undefined,
                error: text === 'unknown error' ? page.t('catalogApiMissing') : text,
              }
              page.publish()
              return
            }
            const value = record(response.value)
            page.catalog = {
              phase: 'ready',
              groups: Array.isArray(value.groups) ? value.groups : [],
              failures: Array.isArray(value.failures) ? value.failures : [],
              default: value.default,
              error: '',
            }
            page.publish()
          },
          function (error) {
            if (page.disposed) return
            page.catalog = { phase: 'error', groups: [], failures: [], default: undefined, error: describeError(error) }
            page.publish()
          },
        )
      }

      onFormChange() {
        if (this.disposed) return
        if (this.draft === null) this.captureFromForm()
        this.publish()
      }

      /** 从宿主快照重建草稿基线（草稿为 null 表示「跟随宿主」）。 */
      captureFromForm() {
        const state = this.form.getSnapshot()
        if (state === null || state === undefined || state.status !== 'ready') {
          this.draft = null
          this.draftRevision = undefined
          this.baseline = null
          this.baselineRevision = undefined
          return
        }
        this.draft = readDraft(state.value)
        this.draftRevision = state.revision
        this.baseline = cloneValue(state.value)
        this.baselineRevision = state.revision
      }

      /** 丢弃草稿，重新读取宿主值与模型目录（也是冲突后的恢复路径）。 */
      discardDraft() {
        this.draft = null
        this.conflicted = false
        this.notice = null
        this.captureFromForm()
        this.loadCatalog()
        this.publish()
      }

      /** 确保有可编辑草稿（宿主就绪后第一次编辑时建立）。 */
      editable() {
        if (this.draft === null) this.captureFromForm()
        return this.draft !== null
      }

      setItemField(key, index, field, value) {
        if (this.editable() === false) return
        const list = listOf(this.draft, key)
        const item = record(list[index])
        const next = Object.assign({}, item)
        next[field] = str(value)
        // 换 provider 会让旧 model/effort 失去意义；换 model 会让旧 effort 失去意义。
        if (field === 'provider') {
          next.model = ''
          next.reasoningEffort = ''
        } else if (field === 'model') {
          next.reasoningEffort = ''
        }
        list[index] = next
        this.notice = null
        this.conflicted = false
        this.publish()
      }

      addItem(key) {
        if (this.editable() === false) return
        const spec = LISTS.filter(function (entry) { return entry.key === key })[0]
        const withSystemPrompt = spec !== undefined && spec.withSystemPrompt === true
        const list = listOf(this.draft, key).slice()
        list.push(emptyItem(withSystemPrompt))
        setListOf(this.draft, key, list)
        this.notice = null
        this.publish()
      }

      removeItem(key, index) {
        if (this.editable() === false) return
        const list = listOf(this.draft, key).slice()
        list.splice(index, 1)
        setListOf(this.draft, key, list)
        this.notice = null
        this.publish()
      }

      moveItem(key, index, delta) {
        if (this.editable() === false) return
        const list = listOf(this.draft, key).slice()
        const target = index + delta
        if (target < 0 || target >= list.length) return
        const moved = list[index]
        list[index] = list[target]
        list[target] = moved
        setListOf(this.draft, key, list)
        this.notice = null
        this.publish()
      }

      setNumber(key, value) {
        if (this.editable() === false) return
        this.draft[key] = String(value === undefined || value === null ? '' : value)
        this.notice = null
        this.publish()
      }

      setReminder(enabled) {
        if (this.editable() === false) return
        this.draft.reminderEnabled = enabled === true
        this.notice = null
        this.publish()
      }

      /** 逐条校验清单项：provider 与 model 必须同时给或同时空。 */
      itemErrors() {
        const errors = Object.create(null)
        for (let index = 0; index < LISTS.length; index += 1) {
          const spec = LISTS[index]
          const list = listOf(this.draft, spec.key)
          for (let itemIndex = 0; itemIndex < list.length; itemIndex += 1) {
            const item = record(list[itemIndex])
            const hasProvider = str(item.provider) !== ''
            const hasModel = str(item.model) !== ''
            if (hasProvider !== hasModel) errors[spec.key + ':' + itemIndex] = this.t('incompleteItem')
          }
        }
        return errors
      }

      /**
       * 这个 op 要写的字段，是否已经被别人改过。
       * 比较「seed 基线值」与「宿主当前值」——revision 变了但值没变不算冲突。
       */
      changedElsewhere(op) {
        const state = this.form.getSnapshot()
        const current = state === null || state === undefined ? undefined : state.value
        const spec = listSpecOfPath(op.path)
        if (spec !== undefined) {
          const before = projectHostList(at(this.baseline, spec.path), spec.withSystemPrompt)
          const now = projectHostList(at(current, spec.path), spec.withSystemPrompt)
          return sameList(before, now) === false
        }
        if (this.baseline === null) return false
        return sameValue(at(this.baseline, op.path), at(current, op.path)) === false
      }

      /** 冲突文案 + 诊断：期望 revision（seed 时）与实际 revision（现在）。 */
      conflictText(actual) {
        const expected = this.baselineRevision
        const detail = this.t('conflictDetail')
          .replace('{expected}', expected === undefined ? '?' : String(expected))
          .replace('{actual}', actual === undefined ? '?' : String(actual))
        return this.t('errConflict') + detail
      }

      /** 等 describe 镜像跟上：revision 一变就返回新值；轮次用完返回 undefined。 */
      async waitForRevision(from, tries, delayMs) {
        const budget = typeof tries === 'number' && tries > 0 ? tries : 8
        const pause = typeof delayMs === 'number' && delayMs >= 0 ? delayMs : 25
        for (let attempt = 0; attempt < budget; attempt += 1) {
          const state = this.form.getSnapshot()
          if (state !== null && state !== undefined && state.status === 'ready' && state.revision !== from) return state.revision
          await new Promise(function (resolve) { setTimeout(resolve, pause) })
        }
        const latest = this.form.getSnapshot()
        if (latest !== null && latest !== undefined && latest.revision !== undefined && latest.revision !== from) return latest.revision
        return undefined
      }

      /** 发起一次 mutate，并把「被拒」「传输失败」「像冲突」分开报出来。 */
      async writeOnce(ops, revision) {
        try {
          // 被宿主拒绝时控制器 resolve(false)；传输层错误才 reject。
          const accepted = await this.form.mutate(ops, revision)
          if (accepted === false) return { ok: false, rejected: true, conflictLike: false, error: null }
          return { ok: true, rejected: false, conflictLike: false, error: null }
        } catch (error) {
          return { ok: false, rejected: false, conflictLike: looksLikeConflict(error), error: error }
        }
      }

      /** 草稿 ↔ 宿主值的差异，折算成一次 mutate 的 ops 列表。 */
      plan() {
        const empty = { ops: [], invalid: [] }
        if (this.draft === null) return empty
        const state = this.form.getSnapshot()
        const current = record(state === null || state === undefined ? undefined : state.value)
        const ops = []
        const invalid = []
        for (let index = 0; index < LISTS.length; index += 1) {
          const spec = LISTS[index]
          const before = projectHostList(at(current, spec.path), spec.withSystemPrompt)
          const after = projectDraftList(listOf(this.draft, spec.key), spec.withSystemPrompt)
          if (sameList(before, after) === false) ops.push({ op: 'set', path: spec.path, value: after })
        }
        for (let index = 0; index < NUMBER_FIELDS.length; index += 1) {
          const spec = NUMBER_FIELDS[index]
          const parsed = parseInteger(this.draft[spec.key], spec)
          if (parsed.ok !== true) {
            invalid.push({ key: spec.key, message: parsed.missing === true ? this.t('invalidEmpty') : this.t('invalidNumber') })
            continue
          }
          const previous = at(current, spec.path)
          if (previous !== parsed.value) ops.push({ op: 'set', path: spec.path, value: parsed.value })
        }
        const previousEnabled = record(current.reminder).enabled === true
        if (this.draft.reminderEnabled !== previousEnabled) {
          ops.push({ op: 'set', path: ['reminder', 'enabled'], value: this.draft.reminderEnabled === true })
        }
        return { ops: ops, invalid: invalid }
      }

      async save() {
        if (this.saving) return
        const state = this.form.getSnapshot()
        if (state === null || state === undefined || state.status !== 'ready') {
          this.notice = { tone: 'err', text: this.t('unavailable') }
          this.publish()
          return
        }
        if (state.writable !== true) {
          this.notice = { tone: 'err', text: this.t('readonly') }
          this.publish()
          return
        }
        if (this.draft === null) {
          this.notice = { tone: 'info', text: this.t('nothingToSave') }
          this.publish()
          return
        }
        const plan = this.plan()
        const itemErrors = this.itemErrors()
        if (plan.invalid.length > 0 || Object.keys(itemErrors).length > 0) {
          this.notice = { tone: 'err', text: this.t('errInvalid') }
          this.publish()
          return
        }
        if (plan.ops.length === 0) {
          this.draft = null
          this.captureFromForm()
          this.notice = { tone: 'info', text: this.t('nothingToSave') }
          this.publish()
          return
        }
        // 字段级冲突判定：只对「本次真正要写」的 path 比较基线值与当前值。
        // revision 变了但值没变（插件热挂载、配置文档整体重载）不算冲突，继续写。
        const contested = []
        for (let index = 0; index < plan.ops.length; index += 1) {
          if (this.changedElsewhere(plan.ops[index])) contested.push(plan.ops[index].path.join('.'))
        }
        if (contested.length > 0) {
          this.conflicted = true
          this.notice = { tone: 'err', text: this.conflictText(state.revision) + ' [' + contested.join(', ') + ']' }
          this.publish()
          return
        }
        this.saving = true
        this.conflicted = false
        this.notice = null
        this.publish()
        // 栅栏用宿主「当前」revision：基线值没被动过，就说明这一批字段仍可安全提交。
        const attempted = state.revision
        let outcome = await this.writeOnce(plan.ops, attempted)
        let revisionMoved = false
        let lastRevision = attempted
        if (outcome.ok !== true && (outcome.rejected === true || outcome.conflictLike === true)) {
          // 宿主侧冲突/拒绝：等镜像给出新 revision，再用同一批 ops 重试一次。
          const fresh = await this.waitForRevision(attempted, 8, 25)
          if (fresh !== undefined && fresh !== attempted) revisionMoved = true
          lastRevision = fresh === undefined ? attempted : fresh
          if (this.disposed) return
          outcome = await this.writeOnce(plan.ops, lastRevision)
        }
        if (this.disposed) return
        this.saving = false
        if (outcome.ok === true) {
          // 写入成功必须 re-seed：把草稿与基线/revision 一起更新到写入后的值，
          // 否则下一次保存会拿旧基线误判冲突。
          this.draft = null
          this.conflicted = false
          await this.waitForRevision(attempted, 4, 15)
          this.captureFromForm()
          this.notice = { tone: 'ok', text: this.t('saved') }
        } else if (outcome.error !== null && outcome.error !== undefined) {
          this.notice = {
            tone: 'err',
            text: outcome.conflictLike === true
              ? this.conflictText(lastRevision)
              : this.t('errSavePrefix') + describeError(outcome.error),
          }
        } else {
          this.notice = {
            tone: 'err',
            text: this.t('errRejected') + (revisionMoved === true ? this.conflictText(lastRevision) : ''),
          }
        }
        this.publish()
      }

      /** 供 React 的 read face：同一份对象直到下次 publish，保证 useSyncExternalStore 稳定。 */
      project() {
        const state = this.form.getSnapshot()
        const status = state === null || state === undefined ? 'loading' : state.status
        const plan = this.draft === null ? { ops: [], invalid: [] } : this.plan()
        return {
          formStatus: status,
          writable: state !== null && state !== undefined && state.writable === true,
          revision: state === null || state === undefined ? undefined : state.revision,
          catalog: this.catalog,
          draft: this.draft,
          dirty: plan.ops.length > 0,
          invalidKeys: plan.invalid.reduce(function (acc, item) { acc[item.key] = item.message; return acc }, {}),
          itemErrors: this.draft === null ? Object.create(null) : this.itemErrors(),
          saving: this.saving,
          notice: this.notice,
          conflicted: this.conflicted,
        }
      }

      publish() {
        this.snapshot = this.project()
        const listeners = Array.from(this.listeners)
        for (let index = 0; index < listeners.length; index += 1) listeners[index]()
      }

      subscribe(listener) {
        this.listeners.add(listener)
        const page = this
        return function () { page.listeners.delete(listener) }
      }

      getSnapshot() {
        if (this.snapshot === null) this.snapshot = this.project()
        return this.snapshot
      }

      dispose() {
        this.disposed = true
        this.listeners.clear()
        if (typeof this.offForm === 'function') this.offForm()
        if (typeof this.offAdapters === 'function') this.offAdapters()
      }
    }

    // ── 样式（全部内联：bundle 不允许依赖外部 CSS）────────────────────────────────
    const STYLE = {
      root: { display: 'flex', flexDirection: 'column', gap: '14px', padding: '4px 2px 24px', maxWidth: '900px' },
      h1: { fontSize: '17px', fontWeight: 600, margin: 0 },
      intro: { fontSize: '13px', lineHeight: 1.6, opacity: 0.78, margin: 0 },
      card: { border: '1px solid rgba(127,127,127,0.28)', borderRadius: '10px', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '10px' },
      item: { border: '1px solid rgba(127,127,127,0.2)', borderRadius: '8px', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: '8px', background: 'rgba(127,127,127,0.04)' },
      itemHead: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      itemIndex: { fontSize: '12px', fontWeight: 600, opacity: 0.72, margin: 0 },
      cardTitle: { fontSize: '14px', fontWeight: 600, margin: 0 },
      cardDesc: { fontSize: '12px', lineHeight: 1.55, opacity: 0.7, margin: 0 },
      row: { display: 'flex', flexDirection: 'column', gap: '4px' },
      grid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' },
      label: { fontSize: '12px', fontWeight: 500, opacity: 0.85 },
      control: { width: '100%', boxSizing: 'border-box', padding: '6px 8px', borderRadius: '6px', border: '1px solid rgba(127,127,127,0.35)', background: 'transparent', color: 'inherit', fontSize: '13px' },
      controlInvalid: { borderColor: '#d9534f' },
      hint: { fontSize: '11px', lineHeight: 1.5, opacity: 0.62, margin: 0 },
      err: { color: '#d9534f', fontSize: '12px', margin: 0, lineHeight: 1.5 },
      ok: { color: '#3fa34d', fontSize: '12px', margin: 0, lineHeight: 1.5 },
      info: { fontSize: '12px', margin: 0, lineHeight: 1.5, opacity: 0.8 },
      actions: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
      button: { padding: '6px 14px', borderRadius: '6px', border: '1px solid rgba(127,127,127,0.4)', background: 'transparent', color: 'inherit', fontSize: '13px', cursor: 'pointer' },
      smallButton: { padding: '3px 9px', borderRadius: '6px', border: '1px solid rgba(127,127,127,0.4)', background: 'transparent', color: 'inherit', fontSize: '12px', cursor: 'pointer' },
      checkboxRow: { display: 'flex', alignItems: 'center', gap: '8px' },
      empty: { fontSize: '12px', opacity: 0.7, margin: 0, lineHeight: 1.5 },
    }

    function usePageSnapshot(page) {
      const subscribe = react.useCallback(function (listener) { return page.subscribe(listener) }, [page])
      const get = react.useCallback(function () { return page.getSnapshot() }, [page])
      if (typeof react.useSyncExternalStore === 'function') {
        return react.useSyncExternalStore(subscribe, get, get)
      }
      const pair = react.useState(function () { return get() })
      react.useEffect(function () {
        return subscribe(function () { pair[1](get()) })
      }, [subscribe, get])
      return pair[0]
    }

    /** 一个「供应商 → 模型 → 推理档位」三联下拉。 */
    function RouteSelects(props) {
      const t = props.t
      const item = record(props.item)
      const catalog = props.catalog
      const disabled = props.disabled
      const onChange = props.onChange
      const groups = Array.isArray(catalog.groups) ? catalog.groups : []
      const group = findGroup(catalog, str(item.provider))
      const model = findModel(group, str(item.model))

      const providerOptions = []
      if (group === undefined && str(item.provider) !== '') {
        providerOptions.push({ value: str(item.provider), label: str(item.provider) + ' ' + t('missingInCatalog') })
      }
      for (let index = 0; index < groups.length; index += 1) {
        const entry = record(groups[index])
        const id = str(entry.id)
        if (id === '') continue
        providerOptions.push({ value: id, label: id + (str(entry.name) !== '' ? ' — ' + str(entry.name) : '') })
      }

      const models = modelsOf(group)
      const modelOptions = []
      if (model === undefined && str(item.model) !== '') {
        modelOptions.push({ value: str(item.model), label: str(item.model) + ' ' + t('missingInCatalog') })
      }
      for (let index = 0; index < models.length; index += 1) {
        const entry = record(models[index])
        const id = str(entry.id)
        if (id === '') continue
        modelOptions.push({ value: id, label: id + (str(entry.name) !== '' ? ' — ' + str(entry.name) : '') })
      }

      const efforts = effortsOf(model)
      const effortOptions = []
      const currentEffort = str(item.reasoningEffort)
      if (currentEffort !== '' && efforts.some(function (entry) { return str(record(entry).id) === currentEffort }) === false) {
        effortOptions.push({ value: currentEffort, label: currentEffort + ' ' + t('missingInCatalog') })
      }
      for (let index = 0; index < efforts.length; index += 1) {
        const entry = record(efforts[index])
        const id = str(entry.id)
        if (id === '') continue
        effortOptions.push({ value: id, label: id + (str(entry.name) !== '' ? ' — ' + str(entry.name) : '') })
      }

      function option(entry) {
        return react.createElement('option', { key: 'o-' + entry.value, value: entry.value }, entry.label)
      }
      function select(key, label, value, options, emptyLabel, onValue) {
        const blank = react.createElement('option', { key: 'empty', value: '' }, emptyLabel)
        return react.createElement('div', { key: key, style: STYLE.row },
          react.createElement('label', { style: STYLE.label }, label),
          react.createElement('select', {
            style: STYLE.control,
            value: value,
            disabled: disabled,
            onChange: function (event) { onValue(event.currentTarget.value) },
          }, [blank].concat(options.map(option))),
        )
      }

      return react.createElement('div', null,
        react.createElement('div', { style: STYLE.grid },
          select('provider', t('fieldProvider'), str(item.provider), providerOptions, t('notSelected'), function (value) { onChange('provider', value) }),
          select('model', t('fieldModel'), str(item.model), modelOptions, t('notSelected'), function (value) { onChange('model', value) }),
        ),
        react.createElement('div', { style: STYLE.grid },
          select('effort', t('fieldEffort'), currentEffort, effortOptions, t('effortDefault'), function (value) { onChange('reasoningEffort', value) }),
        ),
      )
    }

    /** 清单里的一条：名称/备注/模型三联/tags/（专家）附加系统提示 + 上移/下移/删除。 */
    function ListItemCard(props) {
      const t = props.t
      const spec = props.spec
      const item = record(props.item)
      const index = props.index
      const total = props.total
      const disabled = props.disabled
      const invalid = props.invalid
      const onChange = props.onChange
      const onRemove = props.onRemove
      const onMove = props.onMove
      const withSystemPrompt = spec.withSystemPrompt === true

      function textField(key, label, hint, multiline) {
        return react.createElement('div', { key: key, style: STYLE.row },
          react.createElement('label', { style: STYLE.label }, label),
          multiline === true
            ? react.createElement('textarea', {
                style: Object.assign({}, STYLE.control, { minHeight: '62px', resize: 'vertical', fontFamily: 'inherit' }),
                value: str(item[key]),
                disabled: disabled,
                onChange: function (event) { onChange(key, event.currentTarget.value) },
              })
            : react.createElement('input', {
                type: 'text',
                style: STYLE.control,
                value: str(item[key]),
                disabled: disabled,
                onChange: function (event) { onChange(key, event.currentTarget.value) },
              }),
          hint === '' ? null : react.createElement('p', { style: STYLE.hint }, hint),
        )
      }

      const body = []
      body.push(react.createElement('div', { key: 'head', style: STYLE.itemHead },
        react.createElement('p', { style: STYLE.itemIndex }, t('itemIndex').replace('{n}', String(index + 1)) + ' / ' + String(total)),
        react.createElement('button', {
          type: 'button',
          style: STYLE.smallButton,
          disabled: disabled || index === 0,
          title: t('moveUp'),
          onClick: function () { onMove(-1) },
        }, '↑'),
        react.createElement('button', {
          type: 'button',
          style: STYLE.smallButton,
          disabled: disabled || index === total - 1,
          title: t('moveDown'),
          onClick: function () { onMove(1) },
        }, '↓'),
        react.createElement('button', {
          type: 'button',
          style: STYLE.smallButton,
          disabled: disabled,
          onClick: function () { onRemove() },
        }, t('remove')),
      ))
      body.push(react.createElement('div', { key: 'names', style: STYLE.grid },
        textField('name', t('fieldName'), t('fieldNameHint'), false),
        textField('note', t('fieldNote'), t('fieldNoteHint'), false),
      ))
      body.push(react.createElement(RouteSelects, {
        key: 'route',
        t: t,
        item: item,
        catalog: props.catalog,
        disabled: disabled,
        onChange: onChange,
      }))
      body.push(textField('tags', t('fieldTags'), t('fieldTagsHint'), false))
      if (withSystemPrompt === true) {
        body.push(textField('systemPrompt', t('fieldSystemPrompt'), t('fieldSystemPromptHint'), true))
      }
      if (invalid !== undefined) {
        body.push(react.createElement('p', { key: 'invalid', style: STYLE.err, role: 'alert' }, invalid))
      }

      return react.createElement('div', { style: STYLE.item }, body)
    }

    /** 一个清单分区：标题/说明 + 条目 + 添加按钮。 */
    function ListSection(props) {
      const t = props.t
      const spec = props.spec
      const state = props.state
      const items = props.items
      const disabled = props.disabled
      const children = []
      children.push(react.createElement('p', { key: 'title', style: STYLE.cardTitle }, props.title))
      children.push(react.createElement('p', { key: 'desc', style: STYLE.cardDesc }, props.desc))
      if (items.length === 0) {
        children.push(react.createElement('p', { key: 'empty', style: STYLE.empty }, t('listEmpty')))
      }
      for (let index = 0; index < items.length; index += 1) {
        const itemIndex = index
        children.push(react.createElement(ListItemCard, {
          key: spec.key + '-' + itemIndex,
          t: t,
          spec: spec,
          item: items[itemIndex],
          index: itemIndex,
          total: items.length,
          catalog: state.catalog,
          disabled: disabled,
          invalid: state.itemErrors[spec.key + ':' + itemIndex],
          onChange: function (field, value) { props.onChange(itemIndex, field, value) },
          onRemove: function () { props.onRemove(itemIndex) },
          onMove: function (delta) { props.onMove(itemIndex, delta) },
        }))
      }
      children.push(react.createElement('div', { key: 'add', style: STYLE.actions },
        react.createElement('button', {
          type: 'button',
          style: STYLE.button,
          disabled: disabled,
          onClick: function () { props.onAdd() },
        }, t('addItem')),
      ))
      return react.createElement('div', { style: STYLE.card }, children)
    }

    /** 设置页主体。owner props 由外壳提供（close），其余来自本端注册时的 inject。 */
    function ExpertBridgeSection(props) {
      const page = props.page
      const t = page.t
      const state = usePageSnapshot(page)
      const draft = state.draft
      const catalog = state.catalog
      const formReady = state.formStatus === 'ready'
      const disabled = formReady !== true || state.writable !== true || state.saving === true || draft === null
      const children = []

      children.push(react.createElement('h1', { key: 'title', style: STYLE.h1 }, t('title')))
      children.push(react.createElement('p', { key: 'intro', style: STYLE.intro }, t('intro')))

      // 状态区：表单未就绪 / 未提供 / 只读 / 目录问题
      if (state.formStatus === 'loading') {
        children.push(react.createElement('p', { key: 'form-loading', style: STYLE.info, role: 'status' }, t('formLoading')))
      }
      if (state.formStatus === 'unavailable') {
        children.push(react.createElement('p', { key: 'form-unavailable', style: STYLE.err, role: 'alert' }, t('unavailable')))
      }
      if (formReady === true && state.writable !== true) {
        children.push(react.createElement('p', { key: 'readonly', style: STYLE.err, role: 'alert' }, t('readonly')))
      }
      if (catalog.phase === 'loading') {
        children.push(react.createElement('p', { key: 'catalog-loading', style: STYLE.info, role: 'status' }, t('loading')))
      }
      if (catalog.phase === 'error') {
        children.push(react.createElement('p', { key: 'catalog-error', style: STYLE.err, role: 'alert' }, t('catalogErrorPrefix') + catalog.error))
      }
      if (catalog.phase === 'ready' && (Array.isArray(catalog.groups) ? catalog.groups.length : 0) === 0) {
        children.push(react.createElement('p', { key: 'catalog-empty', style: STYLE.err, role: 'status' }, t('catalogEmpty')))
      }
      if (Array.isArray(catalog.failures) && catalog.failures.length > 0) {
        const names = catalog.failures.map(function (entry) {
          const row = record(entry)
          return str(row.id) !== '' ? str(row.id) : (str(row.name) !== '' ? str(row.name) : 'unknown')
        })
        children.push(react.createElement('p', { key: 'catalog-failures', style: STYLE.err }, t('failuresPrefix') + names.join(', ')))
      }

      // 三个清单
      const sections = [
        { spec: LISTS[0], title: t('expertsTitle'), desc: t('expertsDesc') },
        { spec: LISTS[1], title: t('lowTitle'), desc: t('lowDesc') },
        { spec: LISTS[2], title: t('mediumTitle'), desc: t('mediumDesc') },
      ]
      for (let index = 0; index < sections.length; index += 1) {
        const section = sections[index]
        const items = listOf(draft, section.spec.key)
        children.push(react.createElement(ListSection, {
          key: 'list-' + section.spec.key,
          t: t,
          spec: section.spec,
          state: state,
          items: items,
          title: section.title,
          desc: section.desc,
          disabled: disabled,
          onAdd: function () { page.addItem(section.spec.key) },
          onRemove: function (itemIndex) { page.removeItem(section.spec.key, itemIndex) },
          onMove: function (itemIndex, delta) { page.moveItem(section.spec.key, itemIndex, delta) },
          onChange: function (itemIndex, field, value) { page.setItemField(section.spec.key, itemIndex, field, value) },
        }))
      }

      // 数值项
      const numberRows = NUMBER_FIELDS.map(function (spec) {
        const value = draft === null ? '' : draft[spec.key]
        const invalid = state.invalidKeys[spec.key]
        const style = invalid === undefined ? STYLE.control : Object.assign({}, STYLE.control, STYLE.controlInvalid)
        return react.createElement('div', { key: spec.key, style: STYLE.row },
          react.createElement('label', { style: STYLE.label }, t(spec.key)),
          react.createElement('input', {
            type: 'text',
            inputMode: 'numeric',
            style: style,
            value: value,
            disabled: disabled,
            'aria-invalid': invalid === undefined ? undefined : 'true',
            onChange: function (event) { page.setNumber(spec.key, event.currentTarget.value) },
          }),
          invalid === undefined ? null : react.createElement('p', { style: STYLE.err }, invalid),
        )
      })
      children.push(react.createElement('div', { key: 'numbers', style: STYLE.card },
        react.createElement('p', { style: STYLE.cardTitle }, t('numbers')),
        react.createElement('div', { style: Object.assign({}, STYLE.row, { gap: '10px' }) }, numberRows),
      ))

      // 提醒开关 + 阈值（阈值已在数值项里，这里只放开关）
      children.push(react.createElement('div', { key: 'reminder', style: STYLE.card },
        react.createElement('p', { style: STYLE.cardTitle }, t('reminder')),
        react.createElement('label', { style: STYLE.checkboxRow },
          react.createElement('input', {
            type: 'checkbox',
            checked: draft === null ? false : draft.reminderEnabled === true,
            disabled: disabled,
            onChange: function (event) { page.setReminder(event.currentTarget.checked) },
          }),
          react.createElement('span', { style: STYLE.label }, t('reminderEnabled')),
        ),
        react.createElement('p', { style: STYLE.hint }, t('reminderThreshold')),
      ))

      // 操作区 + 提示
      const actions = [
        react.createElement('button', {
          key: 'save',
          type: 'button',
          style: STYLE.button,
          disabled: disabled === true || state.dirty !== true,
          onClick: function () { page.save() },
        }, state.saving === true ? t('saving') : t('save')),
        react.createElement('button', {
          key: 'discard',
          type: 'button',
          style: STYLE.button,
          disabled: state.saving === true,
          onClick: function () { page.discardDraft() },
        }, t('discard')),
        react.createElement('span', { key: 'dirty', style: STYLE.hint }, state.dirty === true ? t('dirty') : t('clean')),
      ]
      if (state.notice !== null) {
        const tone = state.notice.tone
        const style = tone === 'err' ? STYLE.err : (tone === 'ok' ? STYLE.ok : STYLE.info)
        actions.push(react.createElement('span', { key: 'notice', style: style, role: tone === 'err' ? 'alert' : 'status' }, state.notice.text))
      }
      children.push(react.createElement('div', { key: 'actions', style: STYLE.actions }, actions))
      children.push(react.createElement('p', { key: 'hint', style: STYLE.hint }, t('saveHint')))

      return react.createElement('div', { style: STYLE.root, 'data-expert-bridge-settings': 'v2' }, children)
    }

    /** 客户端插件注入的服务：slots + locale + 模型目录 remote + 配置表单服务。 */
    const inject = ['slots', 'locale', 'remote', 'remote.session', 'configForms']

    function apply(ctx) {
      ctx.effect(function () {
        return ctx.locale.register(NS, { zh: ZH, en: EN })
      }, 'expert-bridge: settings dictionaries')
      const t = ctx.locale.bind(NS)
      // 宿主不服务该命名空间时，页面对用户完全不存在（而不是渲染一个空壳）。
      ctx.effect(function () {
        return ctx.configForms.whileServed([NS], function () {
          const page = new ExpertBridgePage(ctx, t)
          const off = ctx.slots.inject('settings.section', function () {
            return ctx.slots.register({
              name: 'settings.section',
              id: NS,
              order: 900,
              label: function () { return t('nav') },
              locale: NS,
              inject: function () { return { page: page } },
            }, ExpertBridgeSection)
          })
          return function () {
            if (typeof off === 'function') off()
            page.dispose()
          }
        })
      }, 'expert-bridge: settings section')
    }

    return {
      inject: inject,
      apply: apply,
    }
  },
})
