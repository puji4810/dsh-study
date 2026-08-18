import { defineConfig } from 'tsdown'
export default defineConfig({ entry: ['src/index.ts'], outDir: 'lib', format: ['esm'], platform: 'node', fixedExtension: false, dts: false, clean: false })