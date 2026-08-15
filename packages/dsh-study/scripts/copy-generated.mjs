import { copyFile, mkdir } from 'node:fs/promises'

const root = new URL('../', import.meta.url)
const output = new URL('lib/', root)
await mkdir(output, { recursive: true })

for (const name of [
  'typert.host.js',
  'typert.host.d.ts',
  'typert.remote-client.js',
  'typert.remote-client.d.ts',
  'typert.remote-client.d.ts.map',
]) {
  await copyFile(new URL(`generated/${name}`, root), new URL(name, output))
}
