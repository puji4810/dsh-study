import { createReadStream, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { extname, join, normalize, relative } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'

declare module '@deepseek-ai/cordis' { interface Context { webServer: WebServer } }
const require = createRequire(import.meta.url)
const DIST = join(require.resolve('@drgrice1/tikzjax/package.json'), '..', 'dist')
const MIME: Record<string, string> = { '.js': 'text/javascript', '.css': 'text/css', '.gz': 'application/gzip', '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.ttf': 'font/ttf' }

/** Host service required to serve TikZJax assets. */
export const inject = ['webServer']

/** Stable Cordis plugin name. */
export const name = 'dsh-tikz'

/** Serve TikZJax's browser assets and release the route on unload. */
export function apply(ctx: Context): () => void {
  const dispose = ctx.webServer.register({ kind: 'prefix', path: '/dsh-tikz', handler: (req, res) => {
    const requested = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname).slice('/dsh-tikz'.length)
    const file = normalize(join(DIST, requested || '/tikzjax.js'))
    if (relative(DIST, file).startsWith('..')) { res.statusCode = 403; res.end(); return }
    try { if (!statSync(file).isFile()) throw new Error('not file') } catch { res.statusCode = 404; res.end(); return }
    res.setHeader('content-type', MIME[extname(file)] ?? 'application/octet-stream')
    createReadStream(file).pipe(res)
  } })
  return dispose
}
