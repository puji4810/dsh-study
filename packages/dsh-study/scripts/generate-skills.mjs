#!/usr/bin/env node
// One-off generator: inlines StudyOS SKILL.md bodies into src/skills.ts.
// Source of truth: /home/puji/openedu/plugins/study_os/skills/<name>/SKILL.md.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.argv[2]
const outPath = process.argv[3]
if (root === undefined || outPath === undefined) throw new Error('usage: generate-skills.mjs <skills-dir> <out-file>')

const skills = []
for (const dir of readdirSync(root).sort()) {
  const path = join(root, dir, 'SKILL.md')
  const raw = readFileSync(path, 'utf8')
  const lines = raw.split('\n')
  if (lines[0]?.trim() !== '---') throw new Error(`no frontmatter in ${dir}`)
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
  if (end === -1) throw new Error(`unclosed frontmatter in ${dir}`)
  const fm = lines.slice(1, end).join('\n')
  const name = /^name:\s*(.+)$/m.exec(fm)?.[1]?.trim()
  const description = /^description:\s*(.+)$/m.exec(fm)?.[1]?.trim()
  if (!name || !description) throw new Error(`bad frontmatter in ${dir}`)
  const body = lines.slice(end + 1).join('\n').replace(/\n+$/, '\n')
  skills.push({ name, description, body })
}

const escape = (text) => text
  .replace(/\\/g, '\\\\')
  .replace(/`/g, '\\`')
  .replace(/\$\{/g, '\\${')

let out = `/**
 * StudyOS routed skills, inlined from the StudyOS plugin SKILL.md bodies (frontmatter
 * removed; name and description live beside each entry). Generated once from the source
 * of truth under /home/puji/openedu/plugins/study_os/skills; edit there and regenerate.
 * @module @puji4810/dsh-study/skills
 */

/** One bundled StudyOS skill: routing metadata plus the instruction body. */
export interface StudySkill {
  name: string
  description: string
  content: string
}

/** The nine routed skills in ladder order, then the three domain-pack prompt skills. */
export const STUDY_SKILLS: readonly StudySkill[] = [
`
for (const skill of skills) {
  out += `  {
    name: ${JSON.stringify(skill.name)},
    description: ${JSON.stringify(skill.description)},
    content: \`${escape(skill.body)}\`,
  },
`
}
out += `]

/** The base routing skill: source of the \`base\` prompt fragment. */
export const BASE_PROMPT_SKILL = 'study-os'
`
writeFileSync(outPath, out)
console.log(`wrote ${out.length} chars, ${skills.length} skills to ${outPath}`)
