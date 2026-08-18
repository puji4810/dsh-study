import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { handleStudyConcept } from '../../src/handlers/concept.ts'
import { handleStudyNote } from '../../src/handlers/note.ts'
import { handleStudyReview } from '../../src/handlers/review.ts'
import { env, tempVault, writeNote } from '../helpers.ts'

const dirs: string[] = []
function mkVault(): string {
  const dir = tempVault()
  dirs.push(dir)
  return dir
}
afterEach(() => { for (const d of dirs.splice(0)) void d })

/** Construct a 408-style vault: subject folders, quoted wikilink list items,
 * an AGENTS.md doc inside examples/, and no plugin-written review fields yet. */
function vault408style(): string {
  const vault = mkVault()
  writeNote(vault, 'OS/examples/OS-0001.md', [
    '---',
    'type: example',
    'id: OS-0001',
    // No `difficulty`, `source`, or review fields: the plugin must cope with
    // agent-written metadata being absent.
    'tags:',
    '  - OS',
    '  - "同步与互斥"',
    'concepts:',
    '  - "[[进程创建]]"',
    '  - "[[同步原语]]"',
    '---',
    '# OS-0001 进程创建',
    '',
    '题干',
    '',
    '## 答案',
    '答案正文',
    '',
  ].join('\n'))
  writeNote(vault, 'DS/examples/DS-0002.md', [
    '---',
    'type: example',
    'difficulty: 3',
    'concepts: ["算法复杂度"]',
    'review_count: 1',
    'review_level: 2',
    'last_reviewed_at: 2026-07-10',
    'next_review_at: 2026-07-11',
    '---',
    '# DS-0002 复杂度',
    '',
    '## 答案',
    'O(n log n)',
    '',
  ].join('\n'))
  // Bare documentation files with no frontmatter must not become examples.
  writeNote(vault, 'OS/examples/AGENTS.md', [
    '# AGENTS.md — OS /examples',
    '',
    'Documentation for the examples folder.',
    '',
  ].join('\n'))
  writeNote(vault, 'DS/examples/AGENTS.md', '# AGENTS.md — DS /examples\n\nDocs only.\n')
  return vault
}

describe('vault-format compatibility (408-style vault)', () => {
  it('does not treat bare AGENTS.md docs as examples', () => {
    const vault = vault408style()
    const listed = handleStudyNote({ action: 'list', layer: 'example' }, env(vault))
    if (!listed.ok) throw new Error('expected ok')
    const paths = (listed.data.notes as Array<{ path: string }>).map(n => n.path)
    expect(paths).not.toContain('OS/examples/AGENTS.md')
    expect(paths).not.toContain('DS/examples/AGENTS.md')
    expect(paths.sort()).toEqual(['DS/examples/DS-0002.md', 'OS/examples/OS-0001.md'])
  })

  it('parses quoted list items and surfaces clean concepts', () => {
    const vault = vault408style()
    const read = handleStudyNote({ action: 'list', layer: 'example' }, env(vault))
    if (!read.ok) throw new Error('expected ok')
    const os = (read.data.notes as Array<{ path: string; concepts: string[] }>).find(n => n.path === 'OS/examples/OS-0001.md')
    expect(os?.concepts).toEqual(['进程创建', '同步原语'])
  })

  it('lists due rows with null difficulty/source and stays lossless', () => {
    const vault = vault408style()
    const due = handleStudyReview({ action: 'due', limit: 10 }, env(vault))
    if (!due.ok) throw new Error(`expected ok, got ${due.error.code}`)
    const rows = due.data.due as Array<Record<string, unknown>>
    expect(rows.some(row => String(row.path).endsWith('AGENTS.md'))).toBe(false)
    const os = rows.find(row => String(row.path).endsWith('OS-0001.md'))
    expect(os).toBeDefined()
    expect(os?.['difficulty']).toBeNull()
    expect(os?.['review_count']).toBe(0)
    const revived = JSON.parse(JSON.stringify(due))
    expect(JSON.stringify(revived)).toBe(JSON.stringify(due))
  })

  it('queue view handles notes missing difficulty/source', () => {
    const vault = vault408style()
    const queue = handleStudyConcept({ action: 'queue', limit: 20 }, env(vault))
    if (!queue.ok) throw new Error(`expected ok, got ${queue.error.code}`)
    const examples = queue.data.new_examples as Array<{ path: string; difficulty: unknown; source: unknown }>
    const os = examples.find(row => String(row.path).endsWith('OS-0001.md'))
    expect(os?.difficulty).toBeNull()
    expect(os?.source).toBeNull()
  })

  it('reads plugin-written review state on a reviewed note (DS-0002)', () => {
    const vault = vault408style()
    const due = handleStudyReview({ action: 'due', review_state: 'reviewed', limit: 10 }, env(vault))
    if (!due.ok) throw new Error('expected ok')
    const rows = due.data.due as Array<Record<string, unknown>>
    const ds = rows.find(row => String(row.path).endsWith('DS-0002.md'))
    expect(ds?.['review_count']).toBe(1)
    expect(ds?.['difficulty']).toBe(3)
    expect(ds?.['next_review_at']).toBe('2026-07-11')
  })
})