// 轨 B（调研取证轨）零成本代码预检：
// 在调用付费/标准档复审子代理之前，先静态扫描交付内容中的低质二手源混入与无源易变断言。

const SECONDARY_DOMAIN_PATTERNS = [
  /(?:^|\.)csdn\.net$/i,
  /(?:^|\.)cnblogs\.com$/i,
  /(?:^|\.)jianshu\.com$/i,
  /(?:^|\.)zhihu\.com$/i,
  /(?:^|\.)juejin\.cn$/i,
  /(?:^|\.)reddit\.com$/i,
  /(?:^|\.)medium\.com$/i,
  /(?:^|\.)si163\.com$/i,
  /(?:^|\.)v2ex\.com$/i,
  /(?:^|\.)linux\.do$/i,
  /(?:^|\.)bilibili\.com$/i,
  /(?:^|\.)mp\.weixin\.qq\.com$/i
]

const SECONDARY_PATH_HINTS = [
  /ai-wool/i,
  /free-credits/i,
  /\/blog\//i,
  /\/forum\//i
]

const VOLATILE_CLAIM_RE = /(价格|定价|收费|免费|额度|限额|倍率|折扣|最新|版本|发布日期|每\s*\d+\s*小时|元\/|美元\/|\$\s*\d+(?:\.\d+)?)/

const SECONDARY_LABEL_RE = /(二手|待核实|非官方|社区|博客|论坛|转述|传闻)/

const UNKNOWN_LABEL_RE = /(UNKNOWN|未取到官方|无一手来源|暂无官方)/i

/**
 * 扫描调研文本，返回零成本代码预检报告：
 * - ok: boolean（仅当没有硬阻断级告警时为 true）
 * - warnings: string[]（送入独立复审子代理逐条抽核）
 * - urls: { url, host, isSecondary, labeled }[]
 */
export function precheckResearchText(text) {
  if (typeof text !== 'string' || !text.trim()) {
    return { ok: false, warnings: ['交付内容为空，无法进行来源预检'], urls: [] }
  }

  const warnings = []
  const urls = []
  const lines = text.split(/\r?\n/)

  const urlRe = /https?:\/\/[^\s)>"'`\]]+/gi
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const matches = [...line.matchAll(urlRe)]
    for (const m of matches) {
      const rawUrl = m[0].replace(/[.,;，。；]+$/, '')
      let host = ''
      let pathname = ''
      try {
        const parsed = new URL(rawUrl)
        host = parsed.hostname
        pathname = parsed.pathname
      } catch {
        continue
      }
      const isSecondary = SECONDARY_DOMAIN_PATTERNS.some((re) => re.test(host)) ||
        SECONDARY_PATH_HINTS.some((re) => re.test(pathname))
      // 检查同行及紧邻上下各 1 行是否已有二手显式标注
      const neighborhood = [lines[i - 1] || '', line, lines[i + 1] || ''].join(' ')
      const labeled = SECONDARY_LABEL_RE.test(neighborhood)
      urls.push({ url: rawUrl, host, isSecondary, labeled, line: i + 1 })
      if (isSecondary && !labeled) {
        warnings.push(`第 ${i + 1} 行疑似引用二手/社区来源 (${host}) 但未显式标注「二手，待核实」：${rawUrl}`)
      }
    }
  }

  const hasVolatileClaims = VOLATILE_CLAIM_RE.test(text)
  const primaryUrls = urls.filter((u) => !u.isSecondary)
  if (hasVolatileClaims && primaryUrls.length === 0 && !UNKNOWN_LABEL_RE.test(text)) {
    warnings.push('文本包含价格/版本/限额/最新等易变事实断言，但未检测到任何一手官方 URL，也未标注 UNKNOWN / 没取到官方说法')
  }

  return {
    ok: warnings.length === 0,
    warnings,
    urls
  }
}
