/**
 * StudyOS note resource handlers: list, read, extract, audit, graph, validate, save.
 * Mirrors the original list/read/extract handlers and the `_note_activity`
 * save/validate/audit/graph flow, including the exact
 * BROKEN_WIKILINKS and NOTE_EXISTS error text.
 * @module @puji4810/dsh-study/handlers/note
 */

import { existsSync, readFileSync, rmSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'

import { err, ok, StudyOSError, type StudyEnvelope } from '../errors.ts'
import { buildWikilinkGraph, prepareNoteDrafts, resolveNoteRef, type NoteDraft, type WikilinkGraph } from '../notes.ts'
import type { StudyData, StudyNote } from '../types.ts'
import { stripWikilink } from '../util.ts'
import { listMarkdownNotes, readNoteFile, resolveVaultPath, studyDir } from '../vault.ts'
import type { HandlerEnv } from './dispatch.ts'

/** Normalize an unknown value into a list of trimmed non-empty strings. */
function asList(value: unknown): string[] {
  if (value === null || value === undefined) return []
  if (Array.isArray(value)) return value.map(item => String(item)).filter(item => item.trim() !== '')
  if (typeof value === 'string') {
    const stripped = value.trim()
    return stripped ? [stripped] : []
  }
  return [String(value)]
}

/** Strip common Chinese connective particles for fuzzy matching. */
function normalizeCn(text: string): string {
  return text.replace(/[的与和之]/g, '')
}

/** Whether a note matches query/tag/layer filters, plus optional body/normalize. */
function matchesNote(
  note: StudyNote,
  query: string | undefined,
  tag: string | undefined,
  layer: string | undefined,
  searchBody: boolean,
  normalize: boolean,
): boolean {
  if (layer && note.layer !== layer) return false
  if (tag) {
    const wanted = tag.trim().replace(/^#/, '')
    const tags = new Set(note.tags.map(item => item.replace(/^#/, '')))
    if (!tags.has(wanted)) return false
  }
  if (query) {
    const queryLower = query.toLowerCase()
    const haystacks = [
      note.path,
      note.title,
      note.excerpt,
      note.aliases.join(' '),
      note.concepts.join(' '),
      note.patterns.join(' '),
      note.wikilinks.join(' '),
    ]
    if (searchBody) haystacks.push(note.body!)
    const lowered = haystacks.map(item => item.toLowerCase())
    if (lowered.some(item => item.includes(queryLower))) return true
    if (normalize) {
      const normalizedQuery = normalizeCn(queryLower)
      if (normalizedQuery && lowered.some(item => normalizeCn(item).includes(normalizedQuery))) return true
    }
    return false
  }
  return true
}

/** Clamp a list limit into `[1, 500]`. */
function limitFrom(value: unknown, def: number): number {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : def
  return Math.max(1, Math.min(numeric, 500))
}

/** The list of notes matching no special filters, in discovery order. */
function discoverNotes(vault: string, args: StudyData): StudyNote[] {
  const options: { folder?: string; fileGlob?: string; includeStudyOs?: boolean } = {}
  if (typeof args.folder === 'string') options.folder = args.folder
  if (typeof args.file_glob === 'string') options.fileGlob = args.file_glob
  options.includeStudyOs = Boolean(args.include_study_os)
  return listMarkdownNotes(vault, options)
}

/**
 * Dispatch a StudyOS note operation.
 * @param args - the payload with `action` and action-specific fields.
 * @param env - the handler environment.
 * @returns the note envelope.
 */
export function handleStudyNote(args: StudyData, env: HandlerEnv): StudyEnvelope {
  const action = String(args.action || 'list').trim()
  if (action === 'list') return listNotes(args, env)
  if (action === 'read') return readNote(args, env)
  if (action === 'extract') return extractConcepts(args, env)
  if (action === 'audit' || action === 'graph') return wikilinkGraph(args, env, action)
  if (action === 'validate' || action === 'save') return validateOrSave(args, env, action)
  return err('INVALID_ACTION', `Unsupported study_note action: ${action}`)
}

/** The `list` action. */
function listNotes(args: StudyData, env: HandlerEnv): StudyEnvelope {
  try {
    const vault = resolveVaultPath(args.vault_path, env.vaultPath)
    const limit = limitFrom(args.limit, 100)
    const searchBody = Boolean(args.search_body)
    const normalize = Boolean(args.normalize)
    const includeBody = searchBody && Boolean(args.query)
    const query = typeof args.query === 'string' ? args.query : undefined
    const tag = typeof args.tag === 'string' ? args.tag : undefined
    const layer = typeof args.layer === 'string' ? args.layer : undefined
    const notes: StudyNote[] = []
    for (const note of discoverNotesIncludingBody(vault, args, includeBody)) {
      if (!matchesNote(note, query, tag, layer, searchBody, normalize)) continue
      notes.push(note)
      if (notes.length >= limit) break
    }
    return ok({ vault_path: vault, count: notes.length, notes })
  } catch (error) {
    return err('LIST_NOTES_FAILED', errorMessage(error))
  }
}

/** Discover notes, re-parsing with body when the query requires it. */
function discoverNotesIncludingBody(vault: string, args: StudyData, includeBody: boolean): StudyNote[] {
  const notes = discoverNotes(vault, args)
  if (!includeBody) return notes
  return notes.map(note => {
    const raw = readFileSync(`${vault}/${note.path}`, 'utf8')
    return parseWithBody(raw, note).note
  })
}

/** Re-parse a note's raw text to attach its body, keeping discovery metadata. */
function parseWithBody(raw: string, note: StudyNote): { note: StudyNote } {
  const lines = raw.split(/\r?\n/)
  let body = raw
  if (lines[0]!.trim() === '---') {
    const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
    if (end > 0) body = lines.slice(end + 1).join('\n')
    else return { note: { ...note, body: raw } }
  }
  return { note: { ...note, body } }
}

/** The `read` action. */
function readNote(args: StudyData, env: HandlerEnv): StudyEnvelope {
  try {
    const vault = resolveVaultPath(args.vault_path, env.vaultPath)
    const noteRef = String(args.note || args.path || '').trim()
    const includeBody = Boolean(args.include_body)
    let note: StudyNote
    let warnings: string[]
    try {
      ;({ note, warnings } = readNoteFile(vault, noteRef, { includeBody }))
    } catch (error) {
      if ((error as { code?: string }).code === 'NOTE_AMBIGUOUS') {
        const details = (error as StudyOSError).details as { matches: string[] }
        return err('NOTE_AMBIGUOUS', `More than one note matched ${JSON.stringify(noteRef)}`, {
          matches: details.matches,
        })
      }
      return err('NOTE_NOT_FOUND', `Note not found: ${noteRef}`)
    }
    return ok({ vault_path: vault, note }, warnings)
  } catch (error) {
    return err('READ_NOTE_FAILED', errorMessage(error))
  }
}

/** The `extract` action. */
function extractConcepts(args: StudyData, env: HandlerEnv): StudyEnvelope {
  try {
    const vault = resolveVaultPath(args.vault_path, env.vaultPath)
    const limit = limitFrom(args.limit, 50)
    const refs = asList(args.notes ?? args.note)
    const paths: StudyNote[] = []
    if (refs.length > 0) {
      const ambiguous: Record<string, string[]> = {}
      const missing: string[] = []
      const notes = discoverNotes(vault, args)
      for (const ref of refs) {
        const { note, matches } = resolveNoteRef(notes, ref)
        if (note) paths.push(note)
        else if (matches.length > 0) ambiguous[ref] = matches.slice(0, 20).map(item => item.path)
        else missing.push(ref)
      }
      if (Object.keys(ambiguous).length > 0 || missing.length > 0) {
        return err('NOTE_RESOLUTION_FAILED', 'Some notes could not be resolved', { ambiguous, missing })
      }
    } else {
      const query = typeof args.query === 'string' ? args.query : undefined
      const tag = typeof args.tag === 'string' ? args.tag : undefined
      const layer = typeof args.layer === 'string' ? args.layer : undefined
      for (const note of discoverNotes(vault, args)) {
        if (matchesNote(note, query, tag, layer, false, false)) paths.push(note)
        if (paths.length >= limit) break
      }
    }

    const concepts = new Map<string, number>()
    const patterns = new Map<string, number>()
    const tags = new Map<string, number>()
    const candidates = new Map<string, number>()
    const notesOut: Array<Record<string, unknown>> = []
    for (const note of paths.slice(0, limit)) {
      for (const item of note.concepts) bump(concepts, item)
      for (const item of note.patterns) bump(patterns, item)
      for (const item of note.tags) bump(tags, item)
      for (const item of note.wikilinks) bump(candidates, stripWikilink(item))
      for (const heading of note.headings) {
        const text = heading.text.trim()
        if (text.length >= 2 && text.length <= 40) bump(candidates, text)
      }
      notesOut.push({ path: note.path, title: note.title, layer: note.layer })
    }

    return ok({
      vault_path: vault,
      notes: notesOut,
      concepts: [...concepts.entries()].sort((a, b) => b[1] - a[1]),
      patterns: [...patterns.entries()].sort((a, b) => b[1] - a[1]),
      tags: [...tags.entries()].sort((a, b) => b[1] - a[1]),
      candidate_concepts: [...candidates.entries()].sort((a, b) => b[1] - a[1]).slice(0, 50),
    })
  } catch (error) {
    return err('EXTRACT_CONCEPTS_FAILED', errorMessage(error))
  }
}

/** Increment a frequency map. */
function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1)
}

/** The shared `audit`/`graph` action. */
function wikilinkGraph(args: StudyData, env: HandlerEnv, _action: string): StudyEnvelope {
  try {
    const vault = resolveVaultPath(args.vault_path, env.vaultPath)
    const roots = Array.isArray(args.roots)
      ? args.roots.map(item => String(item)).filter(item => item.trim() !== '')
      : null
    const objects = notesToLinkable(vault, args)
    const graph = buildWikilinkGraph({ objects, roots })
    return ok({
      vault_path: vault,
      graph,
      broken_link_count: graph.missing.length,
      broken_links: graph.missing,
    }, graph.warnings)
  } catch (error) {
    return err('NOTE_GRAPH_FAILED', errorMessage(error))
  }
}

/** Map discovered notes into the linkable objects the graph builder consumes. */
function notesToLinkable(vault: string, args: StudyData): Array<{ kind: 'note'; path: string; title: string; aliases: string[]; wikilinks: string[]; warnings: string[] }> {
  return discoverNotes(vault, args).map(note => ({
    kind: 'note' as const,
    path: note.path,
    title: note.title,
    aliases: note.aliases,
    wikilinks: note.wikilinks,
    warnings: [],
  }))
}

/** The shared `validate`/`save` action. */
function validateOrSave(args: StudyData, env: HandlerEnv, action: string): StudyEnvelope {
  const vault = resolveVaultPath(args.vault_path, env.vaultPath)
  const overwrite = Boolean(args.overwrite)
  let drafts: NoteDraft[]
  try {
    drafts = prepareNoteDrafts({ vault, notes: args.notes, overwrite })
  } catch (error) {
    return err('VALIDATION_FAILED', errorMessage(error))
  }
  // Re-check existence against the live filesystem to reproduce the original
  // overwrite guard before any write happens.
  if (!overwrite) {
    for (const draft of drafts) {
      if (existsSync(draft.path)) {
        return err('NOTE_EXISTS', `Note already exists: ${draft.relative}; set overwrite=true to update it`)
      }
    }
  }
  const objects = draftObjects(vault, drafts)
  const graph = buildWikilinkGraph({ objects, drafts, roots: null })
  if (graph.missing.length > 0) {
    return err(
      'BROKEN_WIKILINKS',
      'The note batch contains dangling WikiLinks. Add substantive notes for every missing target to the same notes array and retry; validation follows those notes recursively.',
      {
        missing: graph.missing,
        notes: drafts.map(draft => ({
          path: draft.relative,
          exists: existsSync(draft.path),
          wikilinks: draft.record.wikilinks,
        })),
        graph,
      },
    )
  }
  if (action === 'validate') {
    return ok({
      vault_path: vault,
      saved: false,
      notes: drafts.map(draft => ({
        path: draft.relative,
        exists: existsSync(draft.path),
        wikilinks: draft.record.wikilinks,
      })),
      graph,
      missing: [],
      broken_link_count: 0,
      broken_links: [],
    })
  }
  return saveDrafts(args, env, vault, drafts, graph)
}

/** Linkable objects derived solely from the pending drafts. */
function draftObjects(vault: string, drafts: NoteDraft[]) {
  return listMarkdownNotes(vault)
    .filter(note => !drafts.some(draft => draft.relative === note.path))
    .map(note => ({
      kind: 'note' as const,
      path: note.path,
      title: note.title,
      aliases: note.aliases,
      wikilinks: note.wikilinks,
      warnings: [] as string[],
    }))
}

/** Write the validated drafts, backing up and rolling back on failure. */
function saveDrafts(args: StudyData, env: HandlerEnv, vault: string, drafts: NoteDraft[], graph: WikilinkGraph): StudyEnvelope {
  void env
  const backups = new Map<string, { existed: boolean; content: string | null }>()
  for (const draft of drafts) {
    const existed = existsSync(draft.path)
    backups.set(draft.relative, { existed, content: existed ? readFileSync(draft.path, 'utf8') : null })
  }
  const written: NoteDraft[] = []
  try {
    for (const draft of drafts) {
      written.push(draft)
      writeFileSync(draft.path, draft.content, 'utf8')
    }
  } catch (error) {
    for (const draft of [...written].reverse()) {
      const backup = backups.get(draft.relative)
      if (backup?.existed && backup.content !== null) {
        writeFileSync(draft.path, backup.content, 'utf8')
      } else {
        try { unlinkSync(draft.path) } catch { /* fall through */ }
        removeEmptyParents(draft.path, vault)
      }
    }
    return err('SAVE_NOTES_FAILED', errorMessage(error))
  }
  rmSync(`${studyDir(vault)}/concept_graph.json`, { force: true })
  void args
  return ok({
    vault_path: vault,
    saved: true,
    notes: drafts.map(draft => {
      const backup = backups.get(draft.relative)!
      return {
        path: draft.relative,
        created: !backup.existed,
        updated: backup.existed,
        wikilinks: draft.record.wikilinks,
      }
    }),
    graph,
    missing: [],
    broken_link_count: 0,
    broken_links: [],
  })
}

/** Remove empty parent directories up to (but not including) the vault root. */
function removeEmptyParents(path: string, vault: string): void {
  let parent = path.slice(0, path.lastIndexOf('/'))
  while (parent && parent !== vault && parent.startsWith(`${vault}/`)) {
    try {
      rmdirSync(parent)
    } catch {
      break
    }
    parent = parent.slice(0, parent.lastIndexOf('/'))
  }
}

function errorMessage(error: unknown): string {
  return (error as Error).message
}
