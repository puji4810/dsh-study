/**
 * StudyOS vault-note parsing, resolution, and wikilink-graph projection,
 * mirroring the Python plugin's `notes.py` rule-for-rule. Pure module: files,
 * sizes, and modification times arrive through arguments.
 * @module @puji4810/dsh-study/notes
 */

import type { StudyData, StudyNote } from './types.ts'

/** Obsidian wikilink pattern, matching an optional heading and alias. */
export const WIKILINK_RE = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g

/** Markdown ATX heading pattern, whole line, multiline. */
export const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/gm

/** Fenced-code-block pattern (non-greedy fences, dotall). */
export const CODE_BLOCK_RE = /```.*?```/gs

/** Common Chinese connective characters removed during CN-query normalization. */
export const CN_NORMALIZE_RE = /[的与和之]/g

/** A prepared note draft destined for one vault file. */
export interface NoteDraft {
  path: string
  relative: string
  content: string
  overwrite: boolean
  record: { path: string; title: string; aliases: string[]; wikilinks: string[]; warning: string | null }
}

/** A linkable object (note or asset) discovered in a vault. */
export interface LinkableObject {
  kind: 'note' | 'asset'
  path: string
  title: string
  aliases: string[]
  wikilinks: string[]
  warnings: string[]
}

/** The reachable wikilink graph plus every dangling-edge report. */
export interface WikilinkGraph {
  root_notes: string[]
  visited_notes: string[]
  node_count: number
  edge_count: number
  edges: Array<{ source: string; target: string; resolved: string[] }>
  missing: Array<{ source: string; target: string }>
  broken_links: Array<{ source: string; target: string }>
  ambiguous_links: Array<{ source: string; target: string; resolved: string[] }>
  warnings: string[]
}

/**
 * Parse one note's YAML frontmatter and body with a hand-rolled parser.
 * @param raw - the raw file text.
 * @returns frontmatter record, body text, and an optional warning.
 */
function parseFrontmatter(raw: string): { frontmatter: Record<string, unknown>; body: string; warning: string | null } {
  const lines = raw.split(/\r?\n/)
  if (lines.length === 0 || (lines[0] ?? '').trim() !== '---') {
    return { frontmatter: {}, body: raw, warning: null }
  }
  let endIndex: number | null = null
  for (let index = 1; index < lines.length; index += 1) {
    if ((lines[index] ?? '').trim() === '---') {
      endIndex = index
      break
    }
  }
  if (endIndex === null) {
    return {
      frontmatter: {},
      body: lines.slice(1).join('\n'),
      warning: 'Missing closing --- in frontmatter',
    }
  }
  const fmText = lines.slice(1, endIndex).join('\n')
  const body = lines.slice(endIndex + 1).join('\n')
  if (fmText.trim().length === 0) {
    return { frontmatter: {}, body, warning: null }
  }
  try {
    const parsed = parseYamlBlock(fmText)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { frontmatter: {}, body, warning: 'Frontmatter is not a mapping' }
    }
    return { frontmatter: parsed, body, warning: null }
  } catch (error) {
    return { frontmatter: {}, body, warning: `Failed to parse frontmatter: ${String((error as Error).message ?? error)}` }
  }
}

/** Minimal YAML subset: scalars, single-line arrays, and `key:` list blocks. */
function parseYamlBlock(text: string): Record<string, unknown> | null {
  const result: Record<string, unknown> = {}
  const lines = text.split(/\r?\n/)
  let index = 0
  while (index < lines.length) {
    const line = lines[index] ?? ''
    if (line.trim().length === 0 || line.trimStart().startsWith('#')) {
      index += 1
      continue
    }
    const match = /^(\S[^:]*?)\s*:(.*)$/.exec(line)
    if (match === null) {
      index += 1
      continue
    }
    const key = (match[1] ?? '').trim()
    const valueText = (match[2] ?? '').trim()
    if (key.length === 0) {
      index += 1
      continue
    }
    if (valueText.length === 0) {
      // Look ahead for an indented `- item` list block.
      const items: string[] = []
      let look = index + 1
      while (look < lines.length) {
        const lookLine = lines[look] ?? ''
        if (lookLine.trim().length === 0) {
          look += 1
          continue
        }
        if (lookLine.startsWith(' ') || lookLine.startsWith('\t')) {
          const itemMatch = /^\s*-\s*(.*)$/.exec(lookLine)
          if (itemMatch !== null) {
            items.push((itemMatch[1] ?? '').trim())
          } else {
            const itemValue = /^\s*(.+?)\s*$/.exec(lookLine.trimStart())
            if (itemValue !== null) items.push(itemValue[1] ?? '')
          }
          look += 1
          continue
        }
        break
      }
      if (items.length > 0) {
        result[key] = items
        index = look
      } else {
        result[key] = null
        index += 1
      }
      continue
    }
    result[key] = parseYamlScalar(valueText)
    index += 1
  }
  return result
}

/** Parse one scalar YAML value (single-line arrays, booleans, numbers, strings). */
function parseYamlScalar(value: string): unknown {
  const text = value.trim()
  if (text.startsWith('[') && text.endsWith(']')) {
    const inner = text.slice(1, -1).trim()
    if (inner.length === 0) return []
    return inner.split(',').map(item => parseYamlScalar(item)).filter(item => String(item).trim() !== '')
  }
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1)
  }
  if (text === 'true' || text === 'false') return text === 'true'
  if (text === 'null' || text === '~') return null
  if (/^-?\d+$/.test(text)) return Number(text)
  if (/^-?\d+\.\d+$/.test(text)) return Number(text)
  return text
}

/** Normalize an unknown frontmatter value into a list of trimmed strings. */
function asList(value: unknown): string[] {
  if (value === null || value === undefined) return []
  if (Array.isArray(value)) return value.map(item => String(item)).filter(item => item.trim() !== '')
  if (typeof value === 'string') {
    const stripped = value.trim()
    return stripped ? [stripped] : []
  }
  return [String(value)]
}

/** Strip wikilink decoration to the bare target name. */
function stripWikilink(value: string): string {
  let text = value.trim()
  if (text.startsWith('[[') && text.endsWith(']]')) text = text.slice(2, -2)
  if (text.includes('|')) text = text.split('|', 1)[0] ?? ''
  if (text.includes('#')) text = text.split('#', 1)[0] ?? ''
  return text.trim()
}

/** Extract unique non-code wikilink targets from a body. */
function extractWikilinks(body: string): string[] {
  const links: string[] = []
  const seen = new Set<string>()
  WIKILINK_RE.lastIndex = 0
  for (const match of body.replace(CODE_BLOCK_RE, '').matchAll(WIKILINK_RE)) {
    const target = (match[1] ?? '').trim()
    if (!target || target.includes('://') || seen.has(target)) continue
    seen.add(target)
    links.push(target)
  }
  return links
}

/** Extract ATX headings from a body, ignoring those inside code blocks. */
function extractHeadings(body: string): Array<{ level: number; text: string }> {
  const headings: Array<{ level: number; text: string }> = []
  const clean = body.replace(CODE_BLOCK_RE, '')
  HEADING_RE.lastIndex = 0
  for (const match of clean.matchAll(HEADING_RE)) {
    const hashes = match[1] ?? ''
    const text = match[2] ?? ''
    headings.push({ level: hashes.length, text: text.trim() })
  }
  return headings
}

/** Produce a plain-text excerpt, dropping code, blank lines, and headings. */
function excerpt(body: string, limit = 260): string {
  const cleanLines: string[] = []
  for (const line of body.replace(CODE_BLOCK_RE, '').split(/\r?\n/)) {
    const stripped = line.trim()
    if (!stripped || stripped.startsWith('#')) continue
    cleanLines.push(stripped)
  }
  const text = cleanLines.join(' ')
  return text.slice(0, limit) + (text.length > limit ? '...' : '')
}

/**
 * Classify a note into a layer from its relative path and frontmatter.
 * @param relativePath - the slash-separated path relative to the vault.
 * @param frontmatter - the parsed frontmatter record.
 * @returns one of `note`, `example`, `pattern`, `concept`, or a custom `type`.
 */
export function layerFrom(relativePath: string, frontmatter: StudyData): string {
  const noteType = String(frontmatter.type ?? '').trim()
  if (noteType) return noteType
  const relative = relativePath.replace(/\\/g, '/')
  const slashPath = `/${relative}`
  if (slashPath.includes('/examples/') || relative.startsWith('examples/')) return 'example'
  if (relative.includes('Box/题型/') || relative.includes('Box\\题型\\')) return 'pattern'
  if (slashPath.includes('/Box/') || relative.startsWith('Box/')) return 'concept'
  return 'note'
}

/**
 * Build a full {@link StudyNote} from raw markdown text and source metadata.
 * @param raw - the raw file text.
 * @param context - the source path, byte size, and modification timestamp.
 * @returns the parsed note and an optional frontmatter warning.
 */
export function parseNoteMarkdown(
  raw: string,
  context: { path: string; size: number; modified: string },
): { note: StudyNote; warning: string | null } {
  const { path, size, modified } = context
  const basename = path.split('/').pop() ?? path
  const stem = basename.includes('.') ? basename.slice(0, basename.lastIndexOf('.')) : basename
  const { frontmatter, body, warning } = parseFrontmatter(raw)
  const headings = extractHeadings(body)
  const title = String(
    frontmatter.title
    ?? (headings.length > 0 ? (headings[0]?.text ?? '') : stem),
  )
  const note: StudyNote = {
    path,
    basename,
    title: title || stem,
    layer: layerFrom(path, frontmatter),
    frontmatter,
    tags: asList(frontmatter.tags),
    concepts: asList(frontmatter.concepts).map(stripWikilink),
    patterns: asList(frontmatter.patterns).map(stripWikilink),
    aliases: asList(frontmatter.aliases),
    headings,
    wikilinks: extractWikilinks(body),
    excerpt: excerpt(body),
    size,
    modified,
  }
  return { note, warning }
}

/**
 * Resolve a note reference against a set of parsed notes.
 *
 * A direct path match (with an optional `.md` completion) wins immediately;
 * otherwise candidates match against path, stem, basename, title, and aliases.
 * @param notes - the parsed notes to search.
 * @param ref - the reference string.
 * @returns the unique match plus the ambiguous candidate set on failure.
 */
export function resolveNoteRef(notes: StudyNote[], ref: string): { note: StudyNote | null; matches: StudyNote[] } {
  const trimmed = (ref ?? '').trim()
  if (!trimmed) return { note: null, matches: [] }
  const refClean = stripWikilink(trimmed)
  const direct = trimmed.replace(/\\/g, '/').replace(/^\.\//, '')
  for (const note of notes) {
    if (note.path === direct || note.path === `${direct}.md`) {
      return { note, matches: [] }
    }
  }
  const matches: StudyNote[] = []
  for (const note of notes) {
    const candidates = new Set([
      note.path,
      note.path.replace(/\.md$/, ''),
      note.basename,
      note.basename.replace(/\.md$/, ''),
      note.title,
      ...(note.aliases ?? []),
    ])
    if (candidates.has(refClean)) matches.push(note)
  }
  if (matches.length === 1) {
    const note = matches[0]
    if (note !== undefined) return { note, matches: [] }
  }
  return { note: null, matches }
}

/**
 * The top-level subject folder of a note's path, when present and non-hidden.
 * @param note - a parsed study note.
 * @returns the first path segment, or null.
 */
export function noteSubject(note: StudyNote): string | null {
  const parts = String(note.path ?? '').split('/')
  if (parts.length < 2 || (parts[0] ?? '').startsWith('.')) return null
  return parts[0] ?? null
}

/**
 * Validate and parse an untyped note batch into note drafts.
 *
 * Mirrors `_prepare_note_drafts`: enforces non-empty arrays, object items,
 * unique `.md` paths outside hidden directories, non-empty content, and the
 * overwrite rule, then records each draft's link metadata.
 * @param options - the vault root, the raw notes, and an overwrite default.
 * @returns the prepared drafts.
 */
export function prepareNoteDrafts(options: { vault: string; notes: unknown; overwrite?: boolean }): NoteDraft[] {
  const vault = options.vault
  const notes = options.notes
  const overwrite = options.overwrite ?? false
  if (!Array.isArray(notes) || notes.length === 0) {
    throw new Error('notes must be a non-empty array')
  }
  const drafts: NoteDraft[] = []
  const seen = new Set<string>()
  for (let index = 0; index < notes.length; index += 1) {
    const item = notes[index]
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new Error(`notes[${index}] must be an object`)
    }
    const record = item as Record<string, unknown>
    const rawPath = String(record.path ?? '').trim()
    const resolvedPath = resolveNotePath(vault, rawPath)
    const relative = resolvedPath.relative
    if (seen.has(relative.toLowerCase())) {
      throw new Error(`Duplicate note path in batch: ${relative}`)
    }
    seen.add(relative.toLowerCase())
    const content = record.content
    if (typeof content !== 'string' || content.trim().length === 0) {
      throw new Error(`notes[${index}].content must be a non-empty string`)
    }
    const mayOverwrite = Boolean(record.overwrite ?? overwrite)
    if (resolvedPath.exists && !mayOverwrite) {
      throw new Error(`Note already exists: ${relative}; set overwrite=true to update it`)
    }
    const { frontmatter, body, warning } = parseFrontmatter(content)
    const headings = extractHeadings(body)
    const stem = relative.split('/').pop()?.replace(/\.md$/, '') ?? relative
    const titleRaw = String(
      frontmatter.title
      ?? (headings.length > 0 ? (headings[0]?.text ?? '') : stem),
    ).trim()
    const recordResult = {
      path: relative,
      title: titleRaw || stem,
      aliases: asList(frontmatter.aliases),
      wikilinks: extractWikilinks(body),
      warning,
    }
    drafts.push({
      path: resolvedPath.absolute,
      relative,
      content,
      overwrite: mayOverwrite,
      record: recordResult,
    })
  }
  return drafts
}

/** Resolve a raw note path against the vault, protecting against escapes. */
function resolveNotePath(
  vault: string,
  raw: string,
): { absolute: string; relative: string; exists: boolean } {
  if (!raw) throw new Error('note path is required')
  const normalized = raw.replace(/\\/g, '/').replace(/^\.\//, '')
  const absolute = `${vault.replace(/\/+$/, '')}/${normalized}`
  const parts = normalized.split('/')
  for (const part of parts) {
    if (part === '..') throw new Error(`Path escapes vault: ${raw}`)
  }
  const withSuffix = absolute.endsWith('.md') ? absolute : `${absolute}.md`
  const suffix = withSuffix.split('/').pop() ?? ''
  if (!suffix.toLowerCase().endsWith('.md')) {
    throw new Error(`StudyOS notes must use the .md extension: ${raw}`)
  }
  const relative = withSuffix.slice(`${vault.replace(/\/+$/, '')}/`.length)
  for (const part of relative.split('/')) {
    if (part.startsWith('.')) {
      throw new Error(`StudyOS notes cannot be saved in hidden directories: ${raw}`)
    }
  }
  return { absolute: withSuffix, relative, exists: fileExists(withSuffix) }
}

/** Whether a path exists (pure-filesystem shim, overridable by tests). */
function fileExists(_path: string): boolean {
  return false
}

/**
 * Build the reachable wikilink graph from linkable objects and note drafts.
 *
 * Drafts shadow same-path notes; assets are linkable but never traversed;
 * `roots` (when given) resolve only to notes. Dangling edges are reported as
 * `missing` (aliased as `broken_links`) and ambiguous ones as `ambiguous_links`.
 * @param options - the objects, optional drafts, and optional root references.
 * @returns the graph.
 */
export function buildWikilinkGraph(options: {
  objects: LinkableObject[]
  drafts?: NoteDraft[]
  roots?: string[] | null
}): WikilinkGraph {
  const drafts = options.drafts ?? []
  const rawObjects = options.objects
  const draftRecords = new Map<string, NoteDraft['record']>()
  for (const draft of drafts) draftRecords.set(draft.relative, draft.record)

  const objects = new Map<string, LinkableObject>()
  for (const object of rawObjects) {
    if (draftRecords.has(object.path)) continue
    objects.set(object.path, object)
  }
  for (const [relative, record] of draftRecords) {
    objects.set(relative, {
      kind: 'note',
      path: record.path,
      title: record.title,
      aliases: record.aliases,
      wikilinks: record.wikilinks,
      warnings: record.warning ? [record.warning] : [],
    })
  }

  const targetIndex = new Map<string, Set<string>>()
  for (const [objectId, record] of objects) {
    const keys = record.kind === 'note' ? recordKeys(record) : assetKeys(record)
    for (const key of keys) {
      let bucket = targetIndex.get(key)
      if (bucket === undefined) {
        bucket = new Set()
        targetIndex.set(key, bucket)
      }
      bucket.add(objectId)
    }
  }

  const resolve = (source: string, target: string): string[] => {
    const keys = [linkKey(target)]
    const sourceParts = source.length > 0 ? source.split('/') : []
    if (sourceParts.length > 1) {
      const parent = sourceParts.slice(0, -1).join('/')
      keys.push(linkKey(`${parent}/${stripWikilink(target)}`))
    }
    const matches = new Set<string>()
    for (const key of keys) {
      for (const match of targetIndex.get(key) ?? []) matches.add(match)
    }
    return [...matches].sort()
  }

  let rootIds: string[]
  if (options.roots === null || options.roots === undefined) {
    rootIds = drafts.length > 0
      ? drafts.map(draft => draft.relative)
      : [...objects].filter(([, record]) => record.kind === 'note').map(([id]) => id).sort()
  } else {
    rootIds = []
    for (const root of options.roots) {
      for (const match of resolve('', String(root))) {
        const record = objects.get(match)
        if (record?.kind === 'note') rootIds.push(match)
      }
    }
  }

  const queue = [...new Set(rootIds)]
  const visited = new Set<string>()
  const edges: Array<{ source: string; target: string; resolved: string[] }> = []
  const missing: Array<{ source: string; target: string }> = []
  const ambiguous: Array<{ source: string; target: string; resolved: string[] }> = []
  const warnings: string[] = []

  while (queue.length > 0) {
    const source = queue.shift()
    if (source === undefined) break
    if (visited.has(source)) continue
    const record = objects.get(source)
    if (record === undefined || record.kind !== 'note') continue
    visited.add(source)
    for (const warning of record.warnings) {
      if (warning) warnings.push(`${source}: ${warning}`)
    }
    for (const target of record.wikilinks) {
      const resolved = resolve(source, target)
      if (resolved.length === 0) {
        missing.push({ source, target })
        continue
      }
      const edge = { source, target, resolved }
      edges.push(edge)
      if (resolved.length > 1) ambiguous.push(edge)
      for (const destination of resolved) {
        if (objects.get(destination)?.kind === 'note' && !visited.has(destination)) {
          queue.push(destination)
        }
      }
    }
  }

  const dedupeMissing = [...new Map(missing.map(item => [`${item.source}\u0000${item.target}`, item])).values()]
  dedupeMissing.sort((a, b) => {
    const aKey = `${a.source.toLowerCase()}\u0000${a.target.toLowerCase()}`
    const bKey = `${b.source.toLowerCase()}\u0000${b.target.toLowerCase()}`
    return aKey < bKey ? -1 : aKey > bKey ? 1 : 0
  })
  edges.sort((a, b) => compareEdges(a, b))
  ambiguous.sort((a, b) => compareEdges(a, b))

  return {
    root_notes: [...new Set(rootIds)],
    visited_notes: [...visited].sort(),
    node_count: visited.size,
    edge_count: edges.length,
    edges,
    missing: dedupeMissing,
    broken_links: dedupeMissing,
    ambiguous_links: ambiguous,
    warnings: [...new Set(warnings)].sort(),
  }
}

/** Compare two edges by casefolded source then target. */
function compareEdges(
  a: { source: string; target: string },
  b: { source: string; target: string },
): number {
  const aSource = a.source.toLowerCase()
  const bSource = b.source.toLowerCase()
  if (aSource !== bSource) return aSource < bSource ? -1 : 1
  const aTarget = a.target.toLowerCase()
  const bTarget = b.target.toLowerCase()
  return aTarget < bTarget ? -1 : aTarget > bTarget ? 1 : 0
}

/** Normalize a link target into a casefolded lookup key. */
function linkKey(value: unknown): string {
  let target = stripWikilink(String(value ?? '')).replace(/\\/g, '/').trim()
  while (target.startsWith('./')) target = target.slice(2)
  if (target.toLowerCase().endsWith('.md')) target = target.slice(0, -3)
  return target.toLowerCase()
}

/** The lookup keys for a note object (path, stem, basename, title, aliases). */
function recordKeys(record: LinkableObject): Set<string> {
  const path = record.path
  const basename = path.split('/').pop() ?? path
  const stem = basename.includes('.') ? basename.slice(0, basename.lastIndexOf('.')) : basename
  const keys = new Set<string>([
    linkKey(path),
    linkKey(path.replace(/\.md$/, '')),
    linkKey(basename),
    linkKey(stem),
    linkKey(record.title),
  ])
  for (const alias of record.aliases) keys.add(linkKey(alias))
  keys.delete('')
  return keys
}

/** The lookup keys for an asset object (path and basename). */
function assetKeys(record: LinkableObject): Set<string> {
  const basename = record.path.split('/').pop() ?? ''
  return new Set([record.path.toLowerCase(), basename.toLowerCase()])
}
