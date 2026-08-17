import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'

export const inject = ['root']
const SCRIPT_ID = 'dsh-tikzjax'

/** Install TikZJax and turn settled `language-tikz` fences into SVGs. */
export function apply(_ctx: ClientContext): () => void {
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
      const node = document.createElement('script')
      node.type = 'text/tikz'
      node.dataset.texPackages = JSON.stringify({ pgfplots: '' })
      node.dataset.addToPreamble = normalized.preamble || '\\pgfplotsset{compat=1.12}'
      node.textContent = normalized.body
      host.replaceWith(node)
    }
  }
  process()
  const observer = new MutationObserver(process)
  observer.observe(document.body, { childList: true, subtree: true })
  return () => { observer.disconnect(); script.remove() }
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
