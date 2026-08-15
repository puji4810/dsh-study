/**
 * StudyOS prompt-context handler: `load`. Mirrors the Python `tools.py`
 * `handle_study_prompt_context` and its fragment/budget ladder verbatim (lines 2408-2584)
 * so the injected prompt fragments, drop reasons, and budget block stay identical.
 * @module @puji4810/dsh-study/handlers/prompt-context
 */

import { existsSync } from 'node:fs'
import { INTENT_SKILL, VALID_PROMPT_INTENTS } from '../constants.ts'
import { err, errFrom, ok, StudyOSError, type StudyEnvelope } from '../errors.ts'
import { domainPackFor } from '../domain-packs.ts'
import { PROMPT_OPERATION_GUIDES } from '../guides.ts'
import { STUDY_SKILLS } from '../skills.ts'
import {
  allocate,
  estimateTokens,
  extractPromptFragment,
  resolveReserves,
  truncateToChars,
  truncateToTokens,
} from '../prompt-budget.ts'
import type { StudyData } from '../types.ts'
import {
  promptBudget,
  promptPolicy,
  promptSummaryPath,
  readProjectManifest,
  readTextPrefix,
  resolveVaultPath,
} from '../vault.ts'
import type { HandlerEnv } from './dispatch.ts'

/** base and intent carry the routing contract, so the ladder never drops them. */
const REQUIRED_PROMPT_KINDS = ['base', 'intent']

/** domain fragments are atomic: dropped rather than truncated below their reserve. */
const ATOMIC_PROMPT_KINDS = ['domain']

/** A collected prompt fragment awaiting budgeting. */
interface PromptCandidate {
  kind: string
  source: string
  content: string
  charCount: number
  tokenCount: number
}

/** Look up a bundled skill by name. */
function skillByName(name: string): { content: string } | null {
  const skill = STUDY_SKILLS.find(item => item.name === name)
  return skill === undefined ? null : { content: skill.content }
}

/** Build a prompt fragment candidate. */
function promptFragment(kind: string, source: string, content: string): PromptCandidate {
  return {
    kind,
    source,
    content,
    charCount: content.length,
    tokenCount: estimateTokens(content),
  }
}

/**
 * Extract one skill's marked prompt fragment, or null when the skill is missing or empty.
 * @param kind - the fragment kind.
 * @param skillName - the skill name.
 * @returns `{ fragment, warnings }` the Python `_read_prompt_fragment` way.
 */
function readPromptFragment(kind: string, skillName: string): { fragment: PromptCandidate | null; warnings: string[] } {
  const label = `skills/${skillName}/SKILL.md`
  const skill = skillByName(skillName)
  if (skill === null) {
    return { fragment: null, warnings: [`${kind} prompt source missing: ${label}`] }
  }
  const { content, warning } = extractPromptFragment(skill.content, label)
  const warnings = warning ? [warning] : []
  if (!content) warnings.push(`${kind} prompt source has no marked content: ${label}`)
  return { fragment: promptFragment(kind, label, content), warnings }
}

/** Which budget retired a fragment, naming the knob to widen. */
function dropReason(kind: string, budget: number, reserve: number, unit: string): string {
  if (ATOMIC_PROMPT_KINDS.includes(kind)) {
    return `the ${budget} ${unit} budget could not hold it above its ${reserve} ${unit} reserve`
  }
  return `the ${budget} ${unit} budget was exhausted by higher-priority fragments`
}

/**
 * Read exactly as much of a summary file as the pool can ever fund, the Python
 * `_read_summary_text` way.
 * @param path - the summary file path.
 * @param poolTokens - the token pool.
 * @returns the leading summary text.
 */
function readSummaryText(path: string, poolTokens: number): string {
  return readTextPrefix(path, 4 * Math.max(0, poolTokens) + 4)
}

/** The `char_count` ceiling index for a candidate's per-kind reserve. */
function charReserve(policy: StudyData, kind: string): number {
  return Math.trunc(Number(policy[`${kind}_max_chars`]))
}

/**
 * Handle a study_prompt_context operation (`load`).
 * @param args - the operation payload.
 * @param env - the handler environment.
 * @returns the operation envelope.
 */
export function handleStudyPromptContext(args: StudyData, env: HandlerEnv): StudyEnvelope {
  try {
    const vault = resolveVaultPath(args['vault_path'], env.vaultPath)
    const intent = String(args['intent'] || '').trim()
    if (!(VALID_PROMPT_INTENTS as readonly string[]).includes(intent)) {
      return err('INVALID_INTENT', `Unsupported StudyOS intent: ${intent}`)
    }
    const project = readProjectManifest(vault, args['project_id'])
    const policy = promptPolicy(project)
    const { poolTokens, totalMaxChars } = promptBudget(policy)
    const domainPack = String(args['domain_pack'] || project.domain_pack || '').trim()
    const warnings: string[] = []
    const candidates: PromptCandidate[] = []

    for (const [kind, skill] of [['base', 'study-os'], ['intent', INTENT_SKILL[intent as keyof typeof INTENT_SKILL]]] as Array<[string, string]>) {
      const { fragment, warnings: fragmentWarnings } = readPromptFragment(kind, skill)
      if (fragment === null || fragment.content === '') {
        return err('PROMPT_CONTEXT_SOURCE_MISSING', fragmentWarnings[fragmentWarnings.length - 1] ?? '')
      }
      warnings.push(...fragmentWarnings)
      candidates.push(fragment)
    }

    const domainSkill = domainPackFor(domainPack).promptSkill
    if (domainSkill) {
      const { fragment, warnings: fragmentWarnings } = readPromptFragment('domain', domainSkill)
      if (fragment === null || fragment.content === '') {
        warnings.push(...fragmentWarnings.slice(0, -1))
        warnings.push(`${fragmentWarnings[fragmentWarnings.length - 1] ?? ''}; domain fragment skipped`)
      } else {
        warnings.push(...fragmentWarnings)
        candidates.push(fragment)
      }
    }

    const summaryPath = promptSummaryPath(vault, project.project_id)
    if (existsSync(summaryPath)) {
      const summary = readSummaryText(summaryPath, poolTokens)
      if (summary) {
        candidates.push(promptFragment('project_summary', `.StudyOS/projects/${project.project_id}/prompt_summary.md`, summary))
      }
    }

    const reserves = resolveReserves(policy)
    const charReserves = Object.fromEntries(
      Object.keys(reserves).map(kind => [kind, charReserve(policy, kind)]),
    ) as Record<string, number>
    const contents = Object.fromEntries(candidates.map(candidate => [candidate.kind, candidate.content])) as Record<string, string>

    const tokenCuts: Record<string, { text: string; truncated: boolean }> = {}
    const tokenCut = (kind: string, grant: number): { text: string; truncated: boolean } => {
      const key = `${kind}\u0000${grant}`
      let cut = tokenCuts[key]
      if (cut === undefined) {
        cut = truncateToTokens(contents[kind] ?? '', grant)
        tokenCuts[key] = cut
      }
      return cut
    }

    const tokenGrants = allocate(
      poolTokens,
      candidates.map(candidate => ({ kind: candidate.kind, size: candidate.tokenCount, reserve: reserves[candidate.kind] ?? 0 })),
      {
        protected: REQUIRED_PROMPT_KINDS,
        dropBelowReserve: ATOMIC_PROMPT_KINDS,
        measure: (kind, grant) => estimateTokens(tokenCut(kind, grant).text),
      },
    )

    const staged: Array<{ candidate: PromptCandidate; content: string; tokenTruncated: boolean }> = []
    for (const candidate of candidates) {
      const kind = candidate.kind
      const grant = tokenGrants[kind] ?? 0
      const { text: content, truncated: tokenTruncated } = tokenCut(kind, grant)
      if (!content) {
        if (REQUIRED_PROMPT_KINDS.includes(kind)) {
          return err(
            'PROMPT_CONTEXT_TOO_LARGE',
            `prompt budget cannot hold the ${kind} fragment: total_max_tokens ${poolTokens} is too small to route`,
          )
        }
        warnings.push(`${kind} fragment dropped: ${dropReason(kind, poolTokens, reserves[kind] ?? 0, 'token')}`)
        continue
      }
      staged.push({ candidate, content, tokenTruncated })
    }

    const stagedContents = Object.fromEntries(staged.map(({ candidate, content }) => [candidate.kind, content])) as Record<string, string>
    const charCuts: Record<string, { text: string; truncated: boolean }> = {}
    const charCut = (kind: string, grant: number): { text: string; truncated: boolean } => {
      const key = `${kind}\u0000${grant}`
      let cut = charCuts[key]
      if (cut === undefined) {
        cut = truncateToChars(stagedContents[kind] ?? '', grant)
        charCuts[key] = cut
      }
      return cut
    }

    const charGrants = allocate(
      totalMaxChars,
      staged.map(({ candidate, content }) => ({ kind: candidate.kind, size: content.length, reserve: charReserves[candidate.kind] ?? 0 })),
      {
        protected: REQUIRED_PROMPT_KINDS,
        dropBelowReserve: ATOMIC_PROMPT_KINDS,
        measure: (kind, grant) => charCut(kind, grant).text.length,
      },
    )

    const fragments: Array<Record<string, unknown>> = []
    let usedChars = 0
    const delivered = new Set<string>()
    for (const { candidate, tokenTruncated } of staged) {
      const kind = candidate.kind
      const grant = charGrants[kind] ?? 0
      const { text: content, truncated: charTruncated } = charCut(kind, grant)
      if (!content) {
        if (REQUIRED_PROMPT_KINDS.includes(kind)) {
          return err(
            'PROMPT_CONTEXT_TOO_LARGE',
            `prompt budget cannot hold the ${kind} fragment: total_max_chars ${totalMaxChars} is too small to route`,
          )
        }
        warnings.push(`${kind} fragment dropped: ${dropReason(kind, totalMaxChars, charReserves[kind] ?? 0, 'character')}`)
        continue
      }
      if (tokenTruncated) {
        warnings.push(
          `${kind} fragment truncated to ${estimateTokens(content)} tokens `
          + `(allocated ${tokenGrants[kind] ?? 0} of a ${poolTokens} token pool)`,
        )
      }
      if (charTruncated) {
        warnings.push(
          `${kind} fragment truncated to ${content.length} characters `
          + `(allocated ${grant} of a ${totalMaxChars} character ceiling)`,
        )
      }
      usedChars += content.length
      delivered.add(kind)
      fragments.push({ kind, source: candidate.source, char_count: content.length, token_count: estimateTokens(content), content })
    }

    return ok(
      {
        intent,
        project_id: project.project_id,
        domain_pack: domainPack,
        fragments,
        operation_guide: PROMPT_OPERATION_GUIDES[intent],
        total_char_count: usedChars,
        total_token_count: fragments.reduce((sum, fragment) => sum + Number(fragment['token_count']), 0),
        budget: {
          pool_tokens: poolTokens,
          total_max_chars: totalMaxChars,
          reserve_tokens: reserves,
          granted_tokens: Object.fromEntries(
            Object.keys(tokenGrants).map(kind => [kind, delivered.has(kind) ? (tokenGrants[kind] ?? 0) : 0]),
          ),
          granted_chars: Object.fromEntries(
            Object.keys(tokenGrants).map(kind => [kind, delivered.has(kind) ? (charGrants[kind] ?? 0) : 0]),
          ),
        },
      },
      warnings,
    )
  } catch (error) {
    if (error instanceof StudyOSError) return errFrom(error)
    return err('STUDY_PROMPT_CONTEXT_FAILED', String((error as Error).message ?? error))
  }
}
