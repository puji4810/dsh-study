import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import type { UserConfig } from 'tsdown'
import { transform } from 'lightningcss'

const CSS_PREFIX = '\0dsh-study-css:'
const CSS_SUFFIX = '.mjs'
const EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
  '@deepseek-ai/dsh-client-runtime/client',
] as const

/** Build a dsh Web Client closure bundle with inlined CSS Modules. */
export function clientBundle(id: string): UserConfig {
  return {
    name: `${id}/client`,
    entry: { client: 'lib/client-types/client/index.js' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    sourcemap: true,
    clean: false,
    external: [...EXTERNALS],
    noExternal: (source: string) => EXTERNALS.includes(source as typeof EXTERNALS[number]) ? undefined : true,
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
    },
    plugins: [{
      name: 'dsh-study-css-modules',
      resolveId(source: string, importer: string | undefined) {
        if (!source.endsWith('.module.css')) return null
        return CSS_PREFIX + sourceAssetPath(source, importer) + CSS_SUFFIX
      },
      async load(virtualId: string) {
        if (!virtualId.startsWith(CSS_PREFIX)) return null
        const file = virtualId.slice(CSS_PREFIX.length, -CSS_SUFFIX.length)
        this.addWatchFile(file)
        const output = transform({
          filename: file,
          code: await readFile(file),
          cssModules: { pattern: '[hash]_[local]' },
          minify: true,
        })
        const classes: Record<string, string> = {}
        for (const [local, value] of Object.entries(output.exports ?? {})) classes[local] = value.name
        const tagId = `${id}/${basename(file)}`
        return [
          `const css = ${JSON.stringify(output.code.toString())};`,
          `const tagId = ${JSON.stringify(tagId)};`,
          "if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {",
          "  const tag = document.createElement('style');",
          `  tag.dataset.plugin = ${JSON.stringify(id)};`,
          '  tag.dataset.pluginCss = tagId;',
          '  tag.textContent = css;',
          '  document.head.appendChild(tag);',
          '}',
          `export default ${JSON.stringify(classes)};`,
        ].join('\n')
      },
    }],
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  }
}

function sourceAssetPath(source: string, importer: string | undefined): string {
  if (importer === undefined) return resolve(source)
  const emitted = resolve(dirname(importer), source)
  if (existsSync(emitted)) return emitted
  const marker = '/lib/client-types/'
  const boundary = emitted.indexOf(marker)
  return boundary < 0
    ? emitted
    : resolve(emitted.slice(0, boundary), 'src', emitted.slice(boundary + marker.length))
}
