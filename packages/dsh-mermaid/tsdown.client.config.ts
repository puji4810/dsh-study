import { defineConfig } from 'tsdown'
export default defineConfig({
  entry: { client: 'lib/client-types/client/index.js' }, outDir: 'lib', format: ['cjs'], platform: 'browser', dts: false, sourcemap: true, clean: false,
  outputOptions: {
    entryFileNames: 'client.js',
    banner: 'window.__ModuleLoader__.load({ id: "@puji4810/dsh-mermaid", factory: (require) => {',
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})