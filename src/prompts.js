// 精简子代理环境 preamble 加载 + Plan/Review JSON Schema + 提示词构造 + JSON 代码块降级抽取校验
import fs from 'node:fs'

/**
 * 默认精简环境 preamble（约 1.1 KB，替代给子代理注入 46 KB 全量 AGENTS.md）。
 * 若配置了 workflow.preambleFile 且文件可读，则优先读取该文件。
 */
export const DEFAULT_SUBAGENT_PREAMBLE = [
  '[子代理环境事实与安全红线]',
  '- 路径统一使用正斜杠盘符形式（如 F:/AiHarness）；不要用盘符根当工作区。',
  '- Windows 下 shell 为 pwsh 而非 bash；优先用内置 read / grep / glob 工具而非递归 shell 扫描。',
  '- 超过 100 KB 的大文件禁止整读，先查大小并按行范围或模式片段读取。',
  '- 安全红线（P0）：禁止读取/打印凭据或密钥值；禁止物理删除文件；禁止擅自启停进程/服务。',
  '- 事实与来源：易变事实（价格/版本/日期/限额/政策）只能以一手来源为准；二手源必须显式标注「二手，待核实」；无一手证据写 UNKNOWN。',
  '- 交付契约：收尾必须包含可见正文与关键证据（文件路径/行号/实跑输出）；只有思考没有正文视为未完成。'
].join('\n')

export const READ_ONLY_PREAMBLE = [
  '[只读约束] 你是只读子代理（规划 / 复审 / 调研）。',
  '允许：读取文件、搜索代码、查询只读命令或公开网页。',
  '禁止：创建/修改/删除任何文件，修改配置，执行任何写入型命令。',
  '所有结论直接返回给调用方。'
].join('\n')

/** 严格落在 DSH assertObjectJsonSchema 允许子集内的 PlanSchema（无不支持关键字）。 */
export const PLAN_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    rootCauseOrScope: {
      type: 'string',
      description: '根因假设或问题边界界定（禁止只治表象）'
    },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          action: { type: 'string' },
          owner: { type: 'string', enum: ['main', 'delegate-low', 'delegate-medium'] },
          files: { type: 'array', items: { type: 'string' } }
        },
        required: ['id', 'action', 'owner'],
        additionalProperties: false
      }
    },
    evidencePlan: {
      type: 'array',
      items: { type: 'string' },
      description: '证据计划：哪些断言必须一手源、哪些改动必须实跑命令留证'
    },
    acceptanceCriteria: {
      type: 'array',
      items: { type: 'string' },
      description: '客观验收清单：具体检查命令、预期输出、禁止触碰的边界'
    },
    outOfScope: {
      type: 'array',
      items: { type: 'string' },
      description: '明确不做的负向边界'
    }
  },
  required: ['rootCauseOrScope', 'steps', 'evidencePlan', 'acceptanceCriteria'],
  additionalProperties: false
}

/** 严格落在 DSH assertObjectJsonSchema 允许子集内的 ReviewSchema。 */
export const REVIEW_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    verdict: {
      type: 'string',
      enum: ['pass', 'fail']
    },
    summary: {
      type: 'string'
    },
    checkedCriteria: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          criterion: { type: 'string' },
          status: { type: 'string', enum: ['pass', 'fail', 'missing-evidence'] },
          note: { type: 'string' }
        },
        required: ['criterion', 'status', 'note'],
        additionalProperties: false
      }
    },
    gaps: {
      type: 'array',
      items: { type: 'string' },
      description: '未通过时的具体缺口与可执行修复指令；pass 时为空数组'
    }
  },
  required: ['verdict', 'summary', 'checkedCriteria', 'gaps'],
  additionalProperties: false
}

export function loadSubagentPreamble(preambleFile) {
  if (preambleFile) {
    try {
      const content = fs.readFileSync(preambleFile, 'utf8').trim()
      if (content) return content
    } catch {}
  }
  return DEFAULT_SUBAGENT_PREAMBLE
}

export function buildPlannerNewPrompt({ goal, pointers, priorFalsified, preamble, extraSystemPrompt, expectJsonFence }) {
  const sections = [
    READ_ONLY_PREAMBLE,
    preamble,
    extraSystemPrompt ? `[专家补充规则]\n${extraSystemPrompt}` : '',
    '【你的任务：开局架构与根因规划】',
    '请直接用只读工具核查相关代码、配置或日志，不要依赖模糊假设。',
    '你必须输出四要素：① 根因或边界界定（禁止治标不治本）；② 分步施工单（标明 main / delegate-low / delegate-medium）；③ 证据计划；④ 客观验收清单（含具体命令与负向边界）。',
    `\n【用户原始目标】\n${goal}`,
    pointers && pointers.length > 0 ? `\n【已知路径与线索指针】\n${pointers.map((p) => `- ${p}`).join('\n')}` : '',
    priorFalsified && priorFalsified.length > 0
      ? `\n【先前已证伪假设（勿重复）】\n${priorFalsified.map((p) => `- ${p}`).join('\n')}`
      : '',
    expectJsonFence
      ? '\n【输出格式要求】请最终仅输出一个 ```json 代码块，包含字段：rootCauseOrScope (string)、steps ([{id, action, owner, files?}])、evidencePlan (string[])、acceptanceCriteria (string[])、outOfScope (string[])。'
      : '\n【输出格式要求】核查完成后直接调用 structured_output 提交结构化计划。'
  ]
  return sections.filter(Boolean).join('\n\n')
}

export function buildPlannerFollowupPrompt({ feedback, evidence, turnNumber, maxTurns }) {
  return [
    `【同任务规划修订 · 第 ${turnNumber}/${maxTurns} 轮追问】`,
    '你保留了上一轮对代码库的理解；如有必要请先用只读工具复核最新现场，再给出修订版完整计划。',
    `\n【施工卡点 / 新发现】\n${feedback}`,
    evidence ? `\n【实跑报错或观测证据】\n${evidence}` : '',
    '\n【输出格式要求】请最终给出一个完整 ```json 代码块，包含修订后的 rootCauseOrScope、steps ([{id, action, owner, files?}])、evidencePlan、acceptanceCriteria、outOfScope 字段。'
  ].filter(Boolean).join('\n')
}

export function buildReviewerPrompt({ scope, originalGoal, plan, summary, artifactPaths, commandEvidence, precheckWarnings, preamble, extraSystemPrompt, expectJsonFence }) {
  const sections = [
    READ_ONLY_PREAMBLE,
    preamble,
    extraSystemPrompt ? `[复审补充规则]\n${extraSystemPrompt}` : '',
    `【你的任务：独立只读复审（${scope === 'research' ? '调研取证轨 B' : '复杂工程轨 C'}）】`,
    '你是完全独立的验收者，不受施工者思考过程影响。请自己读取交付文件核验：',
    scope === 'research'
      ? '重点核查：① 价格/版本/日期/政策等易变事实是否都有一手官方来源；② 是否混入未标注的二手博客/羊毛站；③ 证据不足的断言是否如实标 UNKNOWN。'
      : '重点核查：① 改动是否真正解决根因而非表层补丁；② 验收清单里的检查命令是否真的运行并有实证输出；③ 是否越界改动了无关文件或遗漏关键边界。',
    originalGoal ? `\n【原始任务目标】\n${originalGoal}` : '',
    plan ? `\n【已批准的规划与验收清单（plan.json）】\n${JSON.stringify(plan, null, 2)}` : '',
    `\n【施工方提交摘要】\n${summary}`,
    artifactPaths && artifactPaths.length > 0 ? `\n【待抽核文件/交付物路径】\n${artifactPaths.map((p) => `- ${p}`).join('\n')}` : '',
    commandEvidence ? `\n【施工方提供的实跑命令证据】\n${commandEvidence}` : '',
    precheckWarnings && precheckWarnings.length > 0
      ? `\n【零成本代码预检已发现的疑似问题（必须逐条核查）】\n${precheckWarnings.map((w) => `- ${w}`).join('\n')}`
      : '',
    expectJsonFence
      ? '\n【输出格式要求】请最终仅输出一个 ```json 代码块，包含字段：verdict ("pass"|"fail")、summary (string)、checkedCriteria ([{criterion, status, note}])、gaps (string[])。'
      : '\n【输出格式要求】核查完成后直接调用 structured_output 提交结构化复审结果。'
  ]
  return sections.filter(Boolean).join('\n\n')
}

export function buildHandoffPrompt({ goal, summary, contextFiles, planPath, plan }) {
  return [
    '【来自 DSH 的任务交接包（Handoff 模式）】',
    '请先确认任务目标、读取下面列出的关键文件，给出简明的接管确认与初步切入点，然后**停下来等待用户在当前会话中给出下一步指令，不要擅自执行任何写文件或修改操作**。',
    `\n【任务目标】\n${goal}`,
    summary ? `\n【当前进展与背景】\n${summary}` : '',
    contextFiles && contextFiles.length > 0 ? `\n【关键文件路径】\n${contextFiles.map((f) => `- ${f}`).join('\n')}` : '',
    planPath ? `\n【已有规划文件】${planPath}` : '',
    plan ? `\n【当前 plan.json 摘要】\n${JSON.stringify(plan, null, 2)}` : ''
  ].filter(Boolean).join('\n')
}

/** 从纯文本或 ```json 代码块中稳健提取并解析最后一个合法 JSON 对象。 */
export function extractJsonFromText(text) {
  if (typeof text !== 'string' || !text.trim()) return null
  const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)]
  for (let i = fences.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(fences[i][1].trim())
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch {}
  }
  const trimmed = text.trim()
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const parsed = JSON.parse(trimmed)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch {}
  }
  const first = trimmed.indexOf('{')
  const last = trimmed.lastIndexOf('}')
  if (first !== -1 && last > first) {
    try {
      const parsed = JSON.parse(trimmed.slice(first, last + 1))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch {}
  }
  return null
}

/** 校验规划对象是否包含必填四要素，返回 { ok, plan?, errors[] }。 */
export function validatePlanObject(obj) {
  const errors = []
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, errors: ['plan must be a JSON object'] }
  }
  if (typeof obj.rootCauseOrScope !== 'string' || !obj.rootCauseOrScope.trim()) {
    errors.push('missing non-empty rootCauseOrScope')
  }
  if (!Array.isArray(obj.steps) || obj.steps.length === 0) {
    errors.push('steps must be a non-empty array')
  }
  if (!Array.isArray(obj.evidencePlan)) {
    errors.push('evidencePlan must be an array')
  }
  if (!Array.isArray(obj.acceptanceCriteria) || obj.acceptanceCriteria.length === 0) {
    errors.push('acceptanceCriteria must be a non-empty array')
  }
  if (errors.length > 0) return { ok: false, errors }
  return {
    ok: true,
    errors: [],
    plan: {
      rootCauseOrScope: obj.rootCauseOrScope.trim(),
      steps: obj.steps.map((s, idx) => ({
        id: typeof s?.id === 'string' && s.id.trim() ? s.id.trim() : `S${idx + 1}`,
        action: typeof s?.action === 'string' ? s.action.trim() : String(s ?? ''),
        owner: ['main', 'delegate-low', 'delegate-medium'].includes(s?.owner) ? s.owner : 'main',
        files: Array.isArray(s?.files) ? s.files.map(String) : []
      })),
      evidencePlan: obj.evidencePlan.map(String),
      acceptanceCriteria: obj.acceptanceCriteria.map(String),
      outOfScope: Array.isArray(obj.outOfScope) ? obj.outOfScope.map(String) : []
    }
  }
}

/** 校验复审对象是否符合 ReviewSchema。 */
export function validateReviewObject(obj) {
  const errors = []
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, errors: ['review must be a JSON object'] }
  }
  if (obj.verdict !== 'pass' && obj.verdict !== 'fail') {
    errors.push('verdict must be "pass" or "fail"')
  }
  if (typeof obj.summary !== 'string' || !obj.summary.trim()) {
    errors.push('missing non-empty summary')
  }
  if (!Array.isArray(obj.checkedCriteria)) {
    errors.push('checkedCriteria must be an array')
  }
  if (!Array.isArray(obj.gaps)) {
    errors.push('gaps must be an array')
  }
  if (errors.length > 0) return { ok: false, errors }
  return {
    ok: true,
    errors: [],
    review: {
      verdict: obj.verdict,
      summary: obj.summary.trim(),
      checkedCriteria: obj.checkedCriteria.map((c) => ({
        criterion: typeof c?.criterion === 'string' ? c.criterion : '',
        status: ['pass', 'fail', 'missing-evidence'].includes(c?.status) ? c.status : 'missing-evidence',
        note: typeof c?.note === 'string' ? c.note : ''
      })),
      gaps: obj.gaps.map(String)
    }
  }
}

/** 将结构化 plan.json 渲染为人类可读的 plan.md（供 §3.3 确认开工与复审对照）。 */
export function renderPlanMarkdown(plan, meta = {}) {
  const lines = [
    `# 任务规划（Plan）`,
    '',
    meta.profile ? `> 规划档位：${meta.profile} · 生成时间：${meta.generatedAt || new Date().toISOString()} · 版本：v${meta.version || 1}` : '',
    '',
    '## 1. 根因与边界界定',
    plan.rootCauseOrScope,
    '',
    '## 2. 分步施工单',
    ...plan.steps.map((s) => `- **[${s.id}] (${s.owner})** ${s.action}${s.files && s.files.length ? ` — 文件：\`${s.files.join('`, `')}\`` : ''}`),
    '',
    '## 3. 证据计划',
    ...(plan.evidencePlan.length ? plan.evidencePlan.map((e) => `- ${e}`) : ['- 无特殊外部证据项']),
    '',
    '## 4. 客观验收清单',
    ...plan.acceptanceCriteria.map((a) => `- [ ] ${a}`),
    ...(plan.outOfScope && plan.outOfScope.length ? ['', '## 5. 明确不做（负向边界）', ...plan.outOfScope.map((o) => `- ${o}`)] : [])
  ]
  return lines.filter((line, i) => !(line === '' && i === 2)).join('\n') + '\n'
}
