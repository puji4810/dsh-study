import { createReadStream, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { extname, join, normalize, relative } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'

declare module '@deepseek-ai/cordis' { interface Context { webServer: WebServer } }
const require = createRequire(import.meta.url)
const DIST = join(require.resolve('mermaid/package.json'), '..', 'dist')
const MIME: Record<string, string> = {
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
}

/** Host service required to serve Mermaid assets. */
export const inject = ['webServer']

/** Stable Cordis plugin name. */
export const name = 'dsh-mermaid'

/** Serve Mermaid's browser bundle and release the route on unload. */
export function apply(ctx: Context): () => void {
  const dispose = ctx.webServer.register({ kind: 'prefix', path: '/dsh-mermaid', handler: (req, res) => {
    const requested = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname).slice('/dsh-mermaid'.length)
    const file = normalize(join(DIST, requested || '/mermaid.min.js'))
    if (relative(DIST, file).startsWith('..')) { res.statusCode = 403; res.end(); return }
    try { if (!statSync(file).isFile()) throw new Error('not file') } catch { res.statusCode = 404; res.end(); return }
    res.setHeader('content-type', MIME[extname(file)] ?? 'application/octet-stream')
    createReadStream(file).pipe(res)
  } })
  return dispose
}