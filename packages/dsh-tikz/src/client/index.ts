import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'

export const inject = ['root']
const SCRIPT_ID = 'dsh-tikzjax'

/** Install TikZJax and turn settled `language-tikz` fences into SVGs. */
export function apply(_ctx: ClientContext): () => void {
  const tikzLogs: string[] = []
  const timers = new Set<number>()
  const originalConsoleLog = console.log
  console.log = (...args: unknown[]) => {
    const message = args.map(value => value instanceof Error ? value.stack ?? value.message : String(value)).join(' ')
    if (/dvi|tex|undefined control|emergency|error|cannot find|could not find/i.test(message)) tikzLogs.push(message)
    originalConsoleLog.apply(console, args)
  }
  const script = document.createElement('script')
  script.id = SCRIPT_ID
  script.src = `${window.location.origin}/dsh-tikz/tikzjax.js`
  document.head.appendChild(script)
  const process = () => {
    const hosts = new Set<HTMLElement>()
    for (const code of document.querySelectorAll<HTMLElement>('code.language-tikz:not([data-dsh-tikz])')) {
      const host = code.closest<HTMLElement>('.md-code-block') ?? code.parentElement
      if (host !== null) hosts.add(host)
    }
    // Some markdown renderers omit the language-* class while retaining the
    // visible info-string banner. Match that banner by its text, not by its
    // CSS-module class name.
    for (const host of document.querySelectorAll<HTMLElement>('.md-code-block:not([data-dsh-tikz])')) {
      const language = [...host.querySelectorAll<HTMLElement>('div')]
        .find(element => element.children.length === 0 && element.textContent?.trim().toLowerCase() === 'tikz')
      if (language !== undefined) hosts.add(host)
    }
    for (const host of hosts) {
      const source = host.querySelector('pre code')?.textContent?.trim() ?? ''
      if (source === '') continue
      host.dataset.dshTikz = '1'
      const normalized = normalize(source)
      const result = document.createElement('div')
      result.className = 'dsh-tikz-result'
      result.dataset.dshTikzSource = source
      const node = document.createElement('script')
      node.type = 'text/tikz'
      // TikZJax uses this flag to surface TeX/WASM diagnostics instead of
      // reducing every compile failure to the generic img-not-found image.
      node.dataset.showConsole = 'true'
      node.dataset.texPackages = JSON.stringify({ pgfplots: '' })
      node.dataset.addToPreamble = normalized.preamble || '\\pgfplotsset{compat=1.12}'
      node.textContent = normalized.body
      result.append(node)
      host.replaceWith(result)
      const timer = window.setTimeout(() => {
        timers.delete(timer)
        reportTimeout(result, tikzLogs)
      }, 30000)
      timers.add(timer)
    }
    reportFailures(tikzLogs)
  }
  process()
  const observer = new MutationObserver(process)
  observer.observe(document.body, { childList: true, subtree: true })
  const failureObserver = new MutationObserver(() => reportFailures(tikzLogs))
  failureObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] })
  return () => {
    observer.disconnect()
    failureObserver.disconnect()
    script.remove()
    for (const timer of timers) window.clearTimeout(timer)
    timers.clear()
    console.log = originalConsoleLog
  }
}

function reportFailures(tikzLogs: readonly string[]): void {
  for (const result of document.querySelectorAll<HTMLElement>('.dsh-tikz-result:not([data-dsh-tikz-checked])')) {
    const image = result.querySelector<HTMLImageElement>('img[src*="invalid.site/img-not-found.png"]')
    if (image === null) continue
    reportDiagnostic(result, 'TikZJax 渲染失败（请检查图块源码与浏览器控制台首条错误）', tikzLogs)
  }
}

function reportTimeout(result: HTMLElement, tikzLogs: readonly string[]): void {
  if (result.dataset.dshTikzChecked === '1' || result.querySelector('svg path') !== null) return
  result.querySelector('svg')?.remove()
  reportDiagnostic(result, 'TikZJax 渲染超时（可能含非 ASCII 字符、缺失宏包或过重的 pgfplots 曲面）', tikzLogs)
}

function reportDiagnostic(result: HTMLElement, title: string, tikzLogs: readonly string[]): void {
  if (result.dataset.dshTikzChecked === '1') return
  result.dataset.dshTikzChecked = '1'
  const details = document.createElement('details')
  details.className = 'dsh-tikz-error'
  const summary = document.createElement('summary')
  summary.textContent = title
  const log = document.createElement('pre')
  log.className = 'dsh-tikz-error-log'
  log.textContent = tikzLogs.length > 0 ? tikzLogs.join('\n\n') : 'TikZJax 未返回可见的 TeX 错误日志。请检查 Network 中 tex_files、core.dump.gz 和 tex.wasm.gz 请求。'
  const source = document.createElement('pre')
  source.textContent = result.dataset.dshTikzSource ?? ''
  details.append(summary, log, source)
  result.append(details)
}

function normalize(source: string): { body: string; preamble: string } {
  const body: string[] = []
  const preamble: string[] = []
  let documentBody = false
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim()
    if (/^\\begin\{document\}/.test(line)) { documentBody = true; continue }
    if (/^\\end\{document\}/.test(line)) { documentBody = false; continue }
    if (!documentBody && (/^\\usepackage/.test(line) || /^\\usetikzlibrary/.test(line) || /^\\pgfplotsset/.test(line))) {
      preamble.push(line)
      continue
    }
    if (line) body.push(line)
  }
  return { body: body.join('\n'), preamble: preamble.join('\n') }
}

export default apply
