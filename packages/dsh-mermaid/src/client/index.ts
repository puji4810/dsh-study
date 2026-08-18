import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'

export const inject = ['root']
const SCRIPT_ID = 'dsh-mermaid'
const SCRIPT_URL = `${window.location.origin}/dsh-mermaid/mermaid.min.js`

/** The subset of the Mermaid API this renderer uses. */
interface MermaidApi {
  initialize(options: Record<string, unknown>): void
  render(id: string, source: string): Promise<{ svg: string }>
}

/** Install Mermaid and turn settled `language-mermaid` fences into SVGs. */
export function apply(_ctx: ClientContext): () => void {
  let sequence = 0
  let failedRef = false
  let initialized = false
  const timers = new Set<number>()
  const queue: Array<() => Promise<void>> = []
  let draining = false
  const originalConsoleLog = console.log.bind(console)

  const drain = async (): Promise<void> => {
    if (draining) return
    draining = true
    try {
      while (queue.length > 0) {
        const task = queue.shift()!
        try {
          await task()
        } catch (error) {
          originalConsoleLog('dsh-mermaid render failed:', error)
        }
      }
    } finally {
      draining = false
    }
  }
  const enqueue = (task: () => Promise<void>): void => {
    queue.push(task)
    void drain()
  }

  /** Late-bound accessor; initializes Mermaid once, following the color scheme. */
  const api = (): MermaidApi | null => {
    const candidate = (window as unknown as { mermaid?: MermaidApi }).mermaid
    if (candidate === undefined || typeof candidate.render !== 'function') return null
    if (!initialized) {
      const dark = typeof window.matchMedia === 'function'
        && window.matchMedia('(prefers-color-scheme: dark)').matches
      candidate.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: dark ? 'dark' : 'default',
        fontFamily: 'var(--font-sans, sans-serif)',
      })
      initialized = true
    }
    return candidate
  }

  /** Wait until the served bundle is ready (or proven missing). */
  const whenReady = async (): Promise<MermaidApi | null> => {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const current = api()
      if (current !== null) return current
      if (failedRef) return null
      await new Promise<void>(resolve => {
        const timer = window.setTimeout(resolve, 250)
        timers.add(timer)
      })
    }
    return null
  }

  /** Bound a render to a ceiling so pathological diagrams cannot hang the page. */
  const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error('render timeout')), ms)
      timers.add(timer)
      promise.then(
        value => { window.clearTimeout(timer); timers.delete(timer); resolve(value) },
        error => { window.clearTimeout(timer); timers.delete(timer); reject(error) },
      )
    })

  const reportDiagnostic = (host: HTMLElement, title: string, detail: string): void => {
    if (host.dataset.dshMermaidChecked === '1') return
    host.dataset.dshMermaidChecked = '1'
    host.classList.add('dsh-mermaid-error')
    const details = document.createElement('details')
    details.className = 'dsh-mermaid-error-details'
    const summary = document.createElement('summary')
    summary.textContent = title
    const log = document.createElement('pre')
    log.className = 'dsh-mermaid-error-log'
    log.textContent = detail || 'Mermaid 未返回详细错误信息，请检查浏览器控制台。'
    const source = document.createElement('pre')
    source.textContent = host.dataset.dshMermaidSource ?? ''
    details.append(summary, log, source)
    host.append(details)
  }

  const render = async (host: HTMLElement, source: string): Promise<void> => {
    const current = await whenReady()
    if (current === null) {
      reportDiagnostic(host, 'Mermaid 资源加载失败（/dsh-mermaid/mermaid.min.js 不可用）', '')
      return
    }
    try {
      const id = `dsh-mermaid-${(sequence += 1)}`
      const { svg } = await withTimeout(current.render(id, source), 60000)
      const result = document.createElement('div')
      result.className = 'dsh-mermaid-result'
      result.dataset.dshMermaidSource = source
      result.innerHTML = svg
      host.replaceWith(result)
    } catch (error) {
      if (host.isConnected) reportDiagnostic(host, 'Mermaid 渲染失败（请检查图块语法后重试）', errorMessage(error))
    }
  }

  const process = (): void => {
    const hosts = new Set<HTMLElement>()
    for (const code of document.querySelectorAll<HTMLElement>('code.language-mermaid:not([data-dsh-mermaid])')) {
      const host = code.closest<HTMLElement>('.md-code-block') ?? code.parentElement
      if (host !== null) hosts.add(host)
    }
    // Some markdown renderers omit the language-* class while retaining the
    // visible info-string banner. Match that banner by its text, not by its
    // CSS-module class name.
    for (const host of document.querySelectorAll<HTMLElement>('.md-code-block:not([data-dsh-mermaid])')) {
      const language = [...host.querySelectorAll<HTMLElement>('div')]
        .find(element => element.children.length === 0 && element.textContent?.trim().toLowerCase() === 'mermaid')
      if (language !== undefined) hosts.add(host)
    }
    for (const host of hosts) {
      const source = host.querySelector('pre code')?.textContent?.trim() ?? ''
      if (source === '') continue
      host.dataset.dshMermaid = '1'
      enqueue(() => render(host, source))
    }
  }

  const script = document.createElement('script')
  script.id = SCRIPT_ID
  script.src = SCRIPT_URL
  script.addEventListener('load', () => { process() })
  script.addEventListener('error', () => { failedRef = true; process() })
  document.head.appendChild(script)

  process()
  const observer = new MutationObserver(process)
  observer.observe(document.body, { childList: true, subtree: true })

  return () => {
    observer.disconnect()
    script.remove()
    for (const timer of timers) window.clearTimeout(timer)
    timers.clear()
  }
}

/** Best-effort human-readable message from an arbitrary thrown value. */
function errorMessage(error: unknown): string {
  try {
    if (error instanceof Error) return error.message
    if (typeof error === 'object' && error !== null && 'message' in error && typeof (error as { message: unknown }).message === 'string') {
      return (error as { message: string }).message
    }
    return String(error)
  } catch {
    return '<unprintable error>'
  }
}

export default apply