import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { handleStudyNote } from '../../src/handlers/note.ts'
import { env, tempVault, writeNote } from '../helpers.ts'

const dirs: string[] = []
function mkVault(): string {
  const dir = tempVault()
  dirs.push(dir)
  return dir
}
afterEach(() => { for (const d of dirs.splice(0)) void d })

describe('handleStudyNote list', () => {
  it('lists notes with layer filtering', () => {
    const vault = mkVault()
    writeNote(vault, 'Box/a.md', '---\ntype: concept\n---\n# A\n')
    writeNote(vault, 'notes/b.md', '# B\n')
    const result = handleStudyNote({ action: 'list', layer: 'concept' }, env(vault))
    if (!result.ok) throw new Error('expected ok')
    expect(result.data.count).toBe(1)
    expect((result.data.notes as Array<{ path: string }>)[0]!.path).toBe('Box/a.md')
  })

  it('filters by tag and query and honors limit', () => {
    const vault = mkVault()
    writeNote(vault, 'a.md', '---\ntags: [x]\n---\n# One\ncontains needle\n')
    writeNote(vault, 'b.md', '---\ntags: [y]\n---\n# Two\nother\n')
    const byTag = handleStudyNote({ action: 'list', tag: 'x' }, env(vault))
    if (!byTag.ok) throw new Error('expected ok')
    expect(byTag.data.count).toBe(1)
    const byQuery = handleStudyNote({ action: 'list', query: 'needle', search_body: true }, env(vault))
    if (!byQuery.ok) throw new Error('expected ok')
    expect(byQuery.data.count).toBe(1)
  })

  it('normalizes Chinese query particles', () => {
    const vault = mkVault()
    writeNote(vault, 'a.md', '---\n---\n# Title\n导数的定义 here\n')
    const result = handleStudyNote({ action: 'list', query: '导数定义', normalize: true, search_body: true }, env(vault))
    if (!result.ok) throw new Error('expected ok')
    expect(result.data.count).toBe(1)
  })

  it('short-circuits normalize when the query strips to empty', () => {
    const vault = mkVault()
    writeNote(vault, 'a.md', '# Title\nbody text\n')
    const result = handleStudyNote({ action: 'list', query: '的与和之', normalize: true, search_body: true }, env(vault))
    if (!result.ok) throw new Error('expected ok')
    expect(result.data.count).toBe(0)
  })
})

describe('handleStudyNote read', () => {
  it('reads a note with body', () => {
    const vault = mkVault()
    writeNote(vault, 'a.md', '# Title\n\nbody text\n')
    const result = handleStudyNote({ action: 'read', note: 'a.md', include_body: true }, env(vault))
    if (!result.ok) throw new Error('expected ok')
    expect((result.data.note as { title: string }).title).toBe('Title')
    expect((result.data.note as { body: string }).body).toContain('body text')
  })

  it('reports NOTE_NOT_FOUND', () => {
    const vault = mkVault()
    const result = handleStudyNote({ action: 'read', note: 'missing.md' }, env(vault))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('NOTE_NOT_FOUND')
  })
})

describe('handleStudyNote extract', () => {
  it('extracts concepts, tags, and candidate concepts', () => {
    const vault = mkVault()
    writeNote(vault, 'a.md', '---\nconcepts: [[A]]\ntags: [t]\n---\n# Title\n\n[[B]] body\n')
    const result = handleStudyNote({ action: 'extract', note: 'a.md' }, env(vault))
    if (!result.ok) throw new Error('expected ok')
    expect(result.data.concepts).toEqual([['A', 1]])
    expect(result.data.tags).toEqual([['t', 1]])
    expect((result.data.candidate_concepts as unknown[]).length).toBeGreaterThan(0)
  })

  it('reports NOTE_RESOLUTION_FAILED for missing refs', () => {
    const vault = mkVault()
    const result = handleStudyNote({ action: 'extract', note: 'missing' }, env(vault))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('NOTE_RESOLUTION_FAILED')
  })
})

describe('handleStudyNote audit/graph', () => {
  it('builds a graph over discovered notes', () => {
    const vault = mkVault()
    writeNote(vault, 'a.md', '# A\n\n[[b.md]]\n')
    writeNote(vault, 'b.md', '# B\n')
    const result = handleStudyNote({ action: 'graph' }, env(vault))
    if (!result.ok) throw new Error('expected ok')
    expect(result.data.broken_link_count).toBe(0)
  })

  it('reports broken links', () => {
    const vault = mkVault()
    writeNote(vault, 'a.md', '# A\n\n[[dangling]]\n')
    const result = handleStudyNote({ action: 'audit' }, env(vault))
    if (!result.ok) throw new Error('expected ok')
    expect(result.data.broken_link_count).toBe(1)
    expect((result.data.broken_links as Array<{ target: string }>)[0]!.target).toBe('dangling')
  })

  it('honors roots', () => {
    const vault = mkVault()
    writeNote(vault, 'a.md', '# A\n')
    writeNote(vault, 'b.md', '# B\n\n[[a.md]]\n')
    writeNote(vault, 'c.md', '# C\n\n[[dangling]]\n')
    const result = handleStudyNote({ action: 'graph', roots: ['b.md'] }, env(vault))
    if (!result.ok) throw new Error('expected ok')
    expect(result.data.broken_link_count).toBe(0)
  })
})

describe('handleStudyNote validate/save', () => {
  it('validates a batch and reports broken wikilinks', () => {
    const vault = mkVault()
    const result = handleStudyNote({ action: 'validate', notes: [{ path: 'a.md', content: '# A\n\n[[missing]]\n' }] }, env(vault))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('BROKEN_WIKILINKS')
  })

  it('validates a closed batch successfully', () => {
    const vault = mkVault()
    const result = handleStudyNote({
      action: 'validate',
      notes: [
        { path: 'a.md', content: '# A\n\n[[b]]\n' },
        { path: 'b.md', content: '# B\n' },
      ],
    }, env(vault))
    if (!result.ok) throw new Error('expected ok')
    expect(result.data.saved).toBe(false)
  })

  it('saves a batch and writes files', () => {
    const vault = mkVault()
    const result = handleStudyNote({
      action: 'save',
      notes: [
        { path: 'a.md', content: '# A\n\n[[b]]\n' },
        { path: 'b.md', content: '# B\n' },
      ],
    }, env(vault))
    if (!result.ok) throw new Error('expected ok')
    expect(result.data.saved).toBe(true)
    expect(existsSync(join(vault, 'a.md'))).toBe(true)
    expect(existsSync(join(vault, 'b.md'))).toBe(true)
  })

  it('reports NOTE_EXISTS when overwriting without permission', () => {
    const vault = mkVault()
    writeNote(vault, 'a.md', '# existing\n')
    const result = handleStudyNote({ action: 'save', notes: [{ path: 'a.md', content: '# new\n' }] }, env(vault))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('NOTE_EXISTS')
  })

  it('reports validation failure for a non-empty batch constraint', () => {
    const vault = mkVault()
    const result = handleStudyNote({ action: 'save', notes: [] }, env(vault))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('VALIDATION_FAILED')
  })

  it('deletes the concept graph cache after save', () => {
    const vault = mkVault()
    mkdirSync(join(vault, '.StudyOS'), { recursive: true })
    writeFileSync(join(vault, '.StudyOS', 'concept_graph.json'), '{}', 'utf8')
    handleStudyNote({ action: 'save', notes: [{ path: 'a.md', content: '# A\n' }] }, env(vault))
    expect(existsSync(join(vault, '.StudyOS', 'concept_graph.json'))).toBe(false)
  })
})

describe('handleStudyNote invalid action', () => {
  it('rejects unknown actions', () => {
    const result = handleStudyNote({ action: 'bogus' }, env(mkVault()))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('INVALID_ACTION')
  })

  it('defaults to list when no action is given', () => {
    const vault = mkVault()
    writeNote(vault, 'a.md', '# A\n')
    const result = handleStudyNote({}, env(vault))
    if (!result.ok) throw new Error('expected ok')
    expect(result.data.count).toBe(1)
  })

  it('resolves a read by path and tolerates an empty note ref', () => {
    const vault = mkVault()
    writeNote(vault, 'a.md', '# A\n')
    const byPath = handleStudyNote({ action: 'read', path: 'a.md' }, env(vault))
    if (!byPath.ok) throw new Error('expected ok')
    expect((byPath.data.note as { path: string }).path).toBe('a.md')
    const emptyRef = handleStudyNote({ action: 'read', note: '', path: '' }, env(vault))
    expect(emptyRef.ok).toBe(false)
    if (!emptyRef.ok) expect(emptyRef.error.code).toBe('NOTE_NOT_FOUND')
    const emptyExtract = handleStudyNote({ action: 'extract', note: '  ' }, env(vault))
    if (!emptyExtract.ok) throw new Error('expected ok')
    expect((emptyExtract.data.notes as unknown[]).length).toBe(1)
  })
})

describe('handleStudyNote list filters and errors', () => {
  it('honors folder and file_glob discovery scoping', () => {
    const vault = mkVault()
    writeNote(vault, 'Box/a.md', '---\ntype: concept\n---\n# A\n')
    writeNote(vault, 'notes/b.md', '# B\n')
    const byFolder = handleStudyNote({ action: 'list', folder: 'Box' }, env(vault))
    if (!byFolder.ok) throw new Error('expected ok')
    expect(byFolder.data.count).toBe(1)
    expect((byFolder.data.notes as Array<{ path: string }>)[0]!.path).toBe('Box/a.md')
    const byGlob = handleStudyNote({ action: 'list', folder: 'notes', file_glob: '*.md' }, env(vault))
    if (!byGlob.ok) throw new Error('expected ok')
    expect(byGlob.data.count).toBe(1)
  })

  it('caps results at the requested limit', () => {
    const vault = mkVault()
    writeNote(vault, 'a.md', '# A\n')
    writeNote(vault, 'b.md', '# B\n')
    const result = handleStudyNote({ action: 'list', limit: 1 }, env(vault))
    if (!result.ok) throw new Error('expected ok')
    expect(result.data.count).toBe(1)
  })

  it('reports LIST_NOTES_FAILED for a missing vault path', () => {
    const result = handleStudyNote({ action: 'list', vault_path: 'definitely-not-a-vault' }, env(mkVault()))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('LIST_NOTES_FAILED')
  })

  it('includes the body only for search_body with a query', () => {
    const vault = mkVault()
    writeNote(vault, 'a.md', '# One\n\nhidden pearl\n')
    const result = handleStudyNote({ action: 'list', query: 'pearl', search_body: true }, env(vault))
    if (!result.ok) throw new Error('expected ok')
    expect(result.data.count).toBe(1)
    expect((result.data.notes as Array<{ body?: string }>)[0]!.body).toContain('pearl')
  })

  it('parses a body when frontmatter has no closing fence', () => {
    const vault = mkVault()
    writeNote(vault, 'a.md', '---\ntitle: X\nno closing fence body text\n')
    const result = handleStudyNote({ action: 'list', query: 'fence', search_body: true }, env(vault))
    if (!result.ok) throw new Error('expected ok')
    expect(result.data.count).toBe(1)
  })
})

describe('handleStudyNote read ambiguity and errors', () => {
  it('reports NOTE_AMBIGUOUS when two notes share a title', () => {
    const vault = mkVault()
    writeNote(vault, 'a.md', '---\ntitle: Same\n---\n# A\n')
    writeNote(vault, 'b.md', '---\ntitle: Same\n---\n# B\n')
    const result = handleStudyNote({ action: 'read', note: 'Same' }, env(vault))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('NOTE_AMBIGUOUS')
      expect((result.error.details as { matches?: string[] })?.matches?.length).toBe(2)
    }
  })

  it('reports READ_NOTE_FAILED for a missing vault path', () => {
    const result = handleStudyNote({ action: 'read', note: 'a.md', vault_path: 'definitely-not-a-vault' }, env(mkVault()))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('READ_NOTE_FAILED')
  })
})

describe('handleStudyNote extract discovery and scalars', () => {
  it('accepts a non-array note scalar and counts patterns/tags', () => {
    const vault = mkVault()
    writeNote(vault, 'a.md', '---\nconcepts: [A, B]\npatterns: [P, Q]\ntags: [t1, t2]\n---\n# Title\n\n## A short heading\n\n[[W]]\n')
    const result = handleStudyNote({ action: 'extract', note: 'a.md' }, env(vault))
    if (!result.ok) throw new Error('expected ok')
    expect(result.data.concepts).toEqual([['A', 1], ['B', 1]])
    expect(result.data.patterns).toEqual([['P', 1], ['Q', 1]])
    expect(result.data.tags).toEqual([['t1', 1], ['t2', 1]])
  })

  it('accepts a notes array reference', () => {
    const vault = mkVault()
    writeNote(vault, 'a.md', '---\nconcepts: [[A]]\n---\n# One\n')
    const result = handleStudyNote({ action: 'extract', notes: ['a.md'] }, env(vault))
    if (!result.ok) throw new Error('expected ok')
    expect(result.data.concepts).toEqual([['A', 1]])
  })

  it('treats a non-list scalar ref as a missing note', () => {
    const vault = mkVault()
    const result = handleStudyNote({ action: 'extract', note: 42 }, env(vault))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('NOTE_RESOLUTION_FAILED')
  })

  it('accepts a null notes ref and reports NOTE_RESOLUTION_FAILED for ambiguity', () => {
    const vault = mkVault()
    writeNote(vault, 'a.md', '---\ntitle: Dup\n---\n# A\n')
    writeNote(vault, 'b.md', '---\ntitle: Dup\n---\n# B\n')
    const nullRef = handleStudyNote({ action: 'extract', notes: null }, env(vault))
    if (!nullRef.ok) throw new Error('expected ok')
    const ambiguous = handleStudyNote({ action: 'extract', note: 'Dup' }, env(vault))
    expect(ambiguous.ok).toBe(false)
    if (!ambiguous.ok) {
      expect(ambiguous.error.code).toBe('NOTE_RESOLUTION_FAILED')
      expect((ambiguous.error.details as { ambiguous: Record<string, string[]> }).ambiguous['Dup']?.length).toBe(2)
    }
  })

  it('discovers notes with query/tag/layer filters and a limit', () => {
    const vault = mkVault()
    writeNote(vault, 'a.md', '---\nconcepts: [[A]]\ntags: [x]\n---\n# One\n')
    writeNote(vault, 'b.md', '---\nconcepts: [[B]]\ntags: [x]\n---\n# Two\n')
    const byQuery = handleStudyNote({ action: 'extract', query: 'One' }, env(vault))
    if (!byQuery.ok) throw new Error('expected ok')
    expect(byQuery.data.concepts).toEqual([['A', 1]])
    const byTag = handleStudyNote({ action: 'extract', tag: 'x' }, env(vault))
    if (!byTag.ok) throw new Error('expected ok')
    expect((byTag.data.notes as unknown[]).length).toBe(2)
    const byLayer = handleStudyNote({ action: 'extract', layer: 'concept' }, env(vault))
    if (!byLayer.ok) throw new Error('expected ok')
    expect((byLayer.data.notes as unknown[]).length).toBe(0)
    const limited = handleStudyNote({ action: 'extract', limit: 1 }, env(vault))
    if (!limited.ok) throw new Error('expected ok')
    expect((limited.data.notes as unknown[]).length).toBe(1)
  })

  it('reports EXTRACT_CONCEPTS_FAILED for a missing vault path', () => {
    const result = handleStudyNote({ action: 'extract', vault_path: 'definitely-not-a-vault' }, env(mkVault()))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('EXTRACT_CONCEPTS_FAILED')
  })
})

describe('handleStudyNote graph roots and errors', () => {
  it('reports NOTE_GRAPH_FAILED for a missing vault path', () => {
    const result = handleStudyNote({ action: 'graph', vault_path: 'definitely-not-a-vault' }, env(mkVault()))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('NOTE_GRAPH_FAILED')
  })
})

describe('handleStudyNote save details', () => {
  it('saves a draft that references an existing vault note (closed batch)', () => {
    const vault = mkVault()
    writeNote(vault, 'existing.md', '# Existing\n')
    const result = handleStudyNote({ action: 'save', notes: [{ path: 'a.md', content: '# A\n\n[[existing]]\n' }] }, env(vault))
    if (!result.ok) throw new Error('expected ok')
    expect(result.data.saved).toBe(true)
  })

  it('overwrites an existing note when overwrite is set', () => {
    const vault = mkVault()
    writeNote(vault, 'a.md', '# old\n')
    const result = handleStudyNote({ action: 'save', overwrite: true, notes: [{ path: 'a.md', content: '# new\n\n[[a.md]]\n' }] }, env(vault))
    if (!result.ok) throw new Error('expected ok')
    const notes = result.data.notes as Array<{ created: boolean; updated: boolean }>
    expect(notes[0]!.created).toBe(false)
    expect(notes[0]!.updated).toBe(true)
  })

  it('reports VALIDATION_FAILED for a non-object item and a duplicate path', () => {
    const vault = mkVault()
    const badItem = handleStudyNote({ action: 'save', notes: [42] }, env(vault))
    expect(badItem.ok).toBe(false)
    if (!badItem.ok) expect(badItem.error.code).toBe('VALIDATION_FAILED')
    const dup = handleStudyNote({ action: 'save', notes: [{ path: 'a.md', content: '# A\n' }, { path: 'a.md', content: '# B\n' }] }, env(vault))
    expect(dup.ok).toBe(false)
  })

  it('reports VALIDATION_FAILED for empty content, escape, and hidden dir', () => {
    const vault = mkVault()
    const cases: unknown[] = [
      { path: 'a.md', content: '  ' },
      { path: '../a.md', content: '# A\n' },
      { path: '.hidden/a.md', content: '# A\n' },
    ]
    for (const notes of cases) {
      const result = handleStudyNote({ action: 'save', notes: [notes] }, env(vault))
      expect(result.ok).toBe(false)
    }
  })

  it('rolls back newly written notes when a later write fails', () => {
    const vault = mkVault()
    // Pre-create the directory so the first two drafts write successfully before
    // the third (nested under a now-file path) fails.
    mkdirSync(join(vault, 'sub'), { recursive: true })
    const result = handleStudyNote({
      action: 'save',
      notes: [
        { path: 'sub/a.md', content: '# A\n' },
        { path: 'sub/b.md', content: '# B\n' },
        { path: 'sub/b.md/c.md', content: '# C\n' },
      ],
    }, env(vault))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('SAVE_NOTES_FAILED')
    expect(existsSync(join(vault, 'sub', 'a.md'))).toBe(false)
    expect(existsSync(join(vault, 'sub'))).toBe(false)
  })

  it('restores an overwritten note when a later write fails', () => {
    const vault = mkVault()
    writeNote(vault, 'a.md', '# original\n')
    const result = handleStudyNote({
      action: 'save',
      overwrite: true,
      notes: [
        { path: 'a.md', content: '# new\n\n[[a.md]]\n' },
        { path: 'a.md/sub.md', content: '# B\n' },
      ],
    }, env(vault))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('SAVE_NOTES_FAILED')
    expect(readFileSync(join(vault, 'a.md'), 'utf8')).toBe('# original\n')
  })
})
