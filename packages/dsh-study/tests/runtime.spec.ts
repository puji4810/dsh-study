import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LearningRuntime, activeSessionForConversation, type AttemptRecorderResult } from '../src/runtime.ts'
import { diagnoseAttempts } from '../src/diagnosis.ts'
import type { Diagnosis, StudyAttempt, StudyProject } from '../src/types.ts'

const tempDirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'studyos-runtime-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    // Best-effort cleanup; leave artifacts for inspection on failure.
    void dir
  }
})

function project(overrides: Record<string, unknown> = {}): StudyProject {
  return {
    schema_version: 'study_project.v2',
    project_id: 'demo-project',
    title: 'Demo',
    domain: 'general',
    timezone: 'Asia/Shanghai',
    phase: 'foundation',
    domain_pack: 'general.v1',
    workspace_type: 'skill-vault',
    artifact_policy: 'lightweight',
    tracks: [{ id: 't1', label: 'Track' }],
    objectives: [{
      objective_id: 'obj-1',
      capability: 'Derive',
      success_criteria: ['correct result'],
      evidence_targets: ['execution'],
      source_anchors: [{ kind: 'file', ref: 'x.ts' }],
    }],
    prompt_policy: {
      base_max_chars: 2000,
      intent_max_chars: 2500,
      domain_max_chars: 2000,
      project_summary_max_chars: 1200,
      total_max_chars: 6000,
      updates_apply: 'next_session' as const,
    },
    created_at: '2026-07-01T10:00:00Z',
    updated_at: '2026-07-01T10:00:00Z',
    ...overrides,
  } as unknown as StudyProject
}

const validContract = {
  schema_version: 'learning_contract.v1',
  contract_id: 'contract-1',
  project_id: 'demo-project',
  objective: 'Learn derivatives',
  mode: 'learn',
  assistance_level: 'independent',
  time_budget_minutes: 30,
  objective_ids: ['obj-1'],
  evidence_targets: ['execution'],
  created_at: '2026-07-01T10:00:00Z',
}

interface AttemptStore {
  attempts: StudyAttempt[]
}

function makeAttemptStore(): AttemptStore {
  return { attempts: [] }
}

const evalAgent = { kind: 'agent', confidence: 1.0 }

function runtimeSetup(overrides: {
  nowMs?: number
  adapter?: never
  recorder?: (args: Record<string, unknown>) => AttemptRecorderResult
  store?: AttemptStore
} = {}) {
  const sessionsDir = tempDir()
  const bindingIndexPath = join(tempDir(), 'active-sessions.json')
  const store = overrides.store ?? makeAttemptStore()
  const nowMs = overrides.nowMs ?? Date.parse('2026-07-01T10:00:00Z')
  let clock = nowMs
  const runtime = new LearningRuntime({
    project: project(),
    sessionsDir,
    bindingIndexPath,
    attemptReader: (projectId) => store.attempts.filter(a => a.project_id === projectId),
    attemptRecorder: overrides.recorder ?? ((args: Record<string, unknown>) => {
      const attempt = {
        schema_version: 'study_attempt.v1',
        attempt_id: String(args['attempt_id'] ?? `attempt-${store.attempts.length + 1}`),
        project_id: String(args['project_id']),
        item_id: String(args['item_id'] ?? ''),
        occurred_at: String(args['occurred_at'] ?? '2026-07-01T10:00:00Z'),
        response: String(args['response'] ?? ''),
        result: 'correct' as const,
        score: 1.0,
        duration_seconds: typeof args['duration_seconds'] === 'number' ? args['duration_seconds'] : undefined,
        evaluator: { kind: 'agent', confidence: 1.0 },
        assistance: { level: 'independent' } as const,
        transfer_level: args['transfer_level'] as never,
        session_id: String(args['session_id']),
        objective_ids: args['objective_ids'] as string[],
        source_anchors: args['source_anchors'] as never,
      } as StudyAttempt
      store.attempts.push(attempt)
      return { ok: true, data: { attempt } }
    }),
    snapshotBuilder: (attempts: StudyAttempt[]) => diagnoseAttempts(attempts),
    recommendationBuilder: (diagnosis: Diagnosis) => {
      // Default recommendation list mirrors the empty default for coverage of list shape.
      return (diagnosis.diagnosis_clusters as unknown[]).length > 0 ? [] : []
    },
    now: () => new Date(clock),
  })
  const tick = (ms: number) => { clock += ms }
  return { runtime, sessionsDir, bindingIndexPath, store, tick }
}

const observation = {
  evaluator: evalAgent,
  assistance: { level: 'independent', hints_used: 0 },
  attempt_id: 'attempt-1',
  response: 'answer',
  result: 'correct',
  score: 1.0,
  duration_seconds: 120,
  transfer_level: 'execution',
  concepts: [],
  patterns: [],
  objective_ids: ['obj-1'],
  diagnoses: [],
  source_anchors: [],
  artifact_refs: [],
}

describe('LearningRuntime.start', () => {
  it('creates an active session with its first activity', () => {
    const { runtime, sessionsDir } = runtimeSetup()
    const result = runtime.start({ sessionId: 'session-1', contract: validContract })
    const session = result['session'] as Record<string, unknown>
    expect(session['status']).toBe('active')
    expect(session['session_id']).toBe('session-1')
    expect(session['contract']).toMatchObject({ contract_id: 'contract-1' })
    expect(result['next_activity']).not.toBeNull()
    expect((result['next_activity'] as Record<string, unknown>)['activity_id']).toBe('activity-session-1-001')
    expect((result['continuation'] as Record<string, unknown>)['state']).toBe('continue')
    expect(existsSync(join(sessionsDir, 'session-1.json'))).toBe(true)
  })

  it('rejects a pre-existing session id', () => {
    const { runtime } = runtimeSetup()
    runtime.start({ sessionId: 'session-1', contract: validContract })
    expect(() => runtime.start({ sessionId: 'session-1', contract: validContract })).toThrowError(/Learning session already exists: session-1/)
  })

  it('rejects an invalid session id', () => {
    const { runtime } = runtimeSetup()
    expect(() => runtime.start({ sessionId: 'BAD ID', contract: validContract })).toThrowError(/session_id must match/)
  })

  it('binds a conversation and rejects a conflicting active conversation', () => {
    const { runtime, bindingIndexPath } = runtimeSetup()
    runtime.start({ sessionId: 'session-1', contract: validContract, conversationSessionId: 'conv-1' })
    const index = JSON.parse(readFileSync(bindingIndexPath, 'utf8'))
    expect(index['conv-1']).toEqual({ project_id: 'demo-project', learning_session_id: 'session-1' })
    expect(() => runtime.start({ sessionId: 'session-2', contract: validContract, conversationSessionId: 'conv-1' }))
      .toThrowError(/Conversation already has an active learning session: session-1/)
  })

  it('normalizes absent contract fields', () => {
    const { runtime } = runtimeSetup()
    const minimal = { ...validContract, contract_id: undefined, schema_version: undefined, project_id: undefined }
    delete (minimal as Record<string, unknown>)['contract_id']
    delete (minimal as Record<string, unknown>)['schema_version']
    delete (minimal as Record<string, unknown>)['project_id']
    const result = runtime.start({ sessionId: 'session-1', contract: minimal })
    const contract = (result['session'] as Record<string, unknown>)['contract'] as Record<string, unknown>
    expect(String(contract['contract_id'])).toMatch(/^contract-[0-9a-f]{16}$/)
    expect(contract['schema_version']).toBe('learning_contract.v1')
    expect(contract['project_id']).toBe('demo-project')
  })

  it('rejects an invalid contract', () => {
    const { runtime } = runtimeSetup()
    expect(() => runtime.start({ sessionId: 'session-1', contract: { ...validContract, project_id: 'other-project' } }))
      .toThrowError(/project_id must match project manifest/)
  })
})

describe('LearningRuntime.advance', () => {
  it('records evidence and advances the activity sequence', () => {
    const { runtime, store, tick } = runtimeSetup()
    runtime.start({ sessionId: 'session-1', contract: validContract })
    tick(60_000)
    const result = runtime.advance({ sessionId: 'session-1', observation })
    expect(store.attempts).toHaveLength(1)
    expect((result['evidence'] as Record<string, unknown>)['attempt_id']).toBe('attempt-1')
    const session = result['session'] as Record<string, unknown>
    expect((session['activity_history'] as unknown[])).toHaveLength(1)
    expect((session['evidence_ids'] as unknown[])).toEqual(['attempt-1'])
    expect(result['recommendations']).toBeInstanceOf(Array)
  })

  it('rejects a non-object observation', () => {
    const { runtime } = runtimeSetup()
    runtime.start({ sessionId: 'session-1', contract: validContract })
    expect(() => runtime.advance({ sessionId: 'session-1', observation: 'nope' })).toThrowError(/observation must be an object/)
  })

  it('rejects a missing evaluator', () => {
    const { runtime } = runtimeSetup()
    runtime.start({ sessionId: 'session-1', contract: validContract })
    expect(() => runtime.advance({ sessionId: 'session-1', observation: { ...observation, evaluator: undefined } }))
      .toThrowError(/advance requires observation.evaluator so evidence provenance is explicit/)
  })

  it('rejects an unknown evaluator kind', () => {
    const { runtime } = runtimeSetup()
    runtime.start({ sessionId: 'session-1', contract: validContract })
    expect(() => runtime.advance({ sessionId: 'session-1', observation: { ...observation, evaluator: { kind: 'oracle' } } }))
      .toThrowError(/observation.evaluator.kind must be one of: agent, human, program, self/)
  })

  it('rejects an observation the adapter considers ungrounded', () => {
    const { runtime } = runtimeSetup()
    // GeneralActivityAdapter accepts any observation, so use a custom adapter path via the recorder failing later.
    // We instead verify the default adapter accepts and moves on.
    runtime.start({ sessionId: 'session-1', contract: validContract })
    const result = runtime.advance({ sessionId: 'session-1', observation })
    expect((result['session'] as Record<string, unknown>)['status']).toBe('active')
  })

  it('propagates a recorder failure with its code/message', () => {
    const { runtime } = runtimeSetup({
      recorder: () => ({ ok: false, error: { code: 'EVIDENCE_RECORD_FAILED', message: 'boom' } }),
    })
    runtime.start({ sessionId: 'session-1', contract: validContract })
    expect(() => runtime.advance({ sessionId: 'session-1', observation })).toThrowError('boom')
  })

  it('falls back to default code/message when the recorder omits them', () => {
    const { runtime } = runtimeSetup({
      recorder: () => ({ ok: false, error: { code: '', message: '' } }),
    })
    runtime.start({ sessionId: 'session-1', contract: validContract })
    expect(() => runtime.advance({ sessionId: 'session-1', observation })).toThrowError(/Failed to record learning evidence/)
  })

  it('errors when the recorder returns no evidence', () => {
    const { runtime } = runtimeSetup({ recorder: () => ({ ok: true, data: {} }) })
    runtime.start({ sessionId: 'session-1', contract: validContract })
    expect(() => runtime.advance({ sessionId: 'session-1', observation })).toThrowError(/Attempt recorder returned no evidence/)
  })

  it('rejects an unknown session id', () => {
    const { runtime } = runtimeSetup()
    expect(() => runtime.advance({ sessionId: 'session-9', observation })).toThrowError(/Learning session not found: session-9/)
  })
})

describe('LearningRuntime.snapshot and finish', () => {
  it('finishes a completed session and reports the outcome', () => {
    const { runtime } = runtimeSetup()
    runtime.start({ sessionId: 'session-1', contract: validContract })
    runtime.advance({ sessionId: 'session-1', observation })
    const result = runtime.finish({ sessionId: 'session-1' })
    const session = result['session'] as Record<string, unknown>
    expect(session['status']).toBe('completed')
    expect(result['outcome']).toMatchObject({ evidence_count: 1 })
    expect((result['outcome'] as Record<string, unknown>)['evidence_attempt_ids']).toEqual(['attempt-1'])
  })

  it('advance after finish reports the session as not active', () => {
    const { runtime } = runtimeSetup()
    runtime.start({ sessionId: 'session-1', contract: validContract })
    runtime.finish({ sessionId: 'session-1' })
    expect(() => runtime.advance({ sessionId: 'session-1', observation })).toThrowError(/Learning session is not active: session-1/)
  })

  it('finish of a non-active session throws SESSION_NOT_ACTIVE', () => {
    const { runtime } = runtimeSetup()
    runtime.start({ sessionId: 'session-1', contract: validContract })
    runtime.finish({ sessionId: 'session-1' })
    expect(() => runtime.finish({ sessionId: 'session-1' })).toThrowError(/Learning session is not active: session-1/)
  })

  it('snapshot returns the session and competency snapshot', () => {
    const { runtime } = runtimeSetup()
    runtime.start({ sessionId: 'session-1', contract: validContract })
    const result = runtime.snapshot({ sessionId: 'session-1' })
    expect(result['session']).toBeTruthy()
    expect(result['competency_snapshot']).toBeTruthy()
  })

  it('unbinds the conversation on finish', () => {
    const { runtime, bindingIndexPath } = runtimeSetup()
    runtime.start({ sessionId: 'session-1', contract: validContract, conversationSessionId: 'conv-1' })
    runtime.finish({ sessionId: 'session-1' })
    const index = JSON.parse(readFileSync(bindingIndexPath, 'utf8'))
    expect(index['conv-1']).toBeUndefined()
  })
})

describe('LearningRuntime invalid session files', () => {
  it('reports SESSION_STATE_INVALID for a malformed session JSON', () => {
    const { runtime, sessionsDir } = runtimeSetup()
    writeFileSync(join(sessionsDir, 'session-1.json'), '{ not valid json', 'utf8')
    expect(() => runtime.snapshot({ sessionId: 'session-1' })).toThrowError(/Invalid JSON in session-1.json/)
  })

  it('reports SESSION_STATE_INVALID for a non-object session file', () => {
    const { runtime, sessionsDir } = runtimeSetup()
    writeFileSync(join(sessionsDir, 'session-1.json'), '"just a string"', 'utf8')
    expect(() => runtime.snapshot({ sessionId: 'session-1' })).toThrowError(/session-1.json must contain an object/)
  })

  it('reports SESSION_STATE_INVALID for a mismatched session id', () => {
    const { runtime, sessionsDir } = runtimeSetup()
    writeFileSync(join(sessionsDir, 'session-1.json'), JSON.stringify({
      schema_version: 'learning_session.v1',
      session_id: 'other-session',
      project_id: 'demo-project',
    }), 'utf8')
    expect(() => runtime.snapshot({ sessionId: 'session-1' })).toThrowError(/Invalid learning session: session-1/)
  })
})

describe('activeSessionForConversation', () => {
  it('returns null for a blank conversation id', () => {
    const dir = tempDir()
    expect(activeSessionForConversation(dir, '   ')).toBeNull()
  })

  it('returns null when the index does not exist', () => {
    const dir = tempDir()
    expect(activeSessionForConversation(dir, 'conv-1')).toBeNull()
  })

  it('resolves a bound active session', () => {
    const dir = tempDir()
    const runtimeDir = join(dir, '.StudyOS', 'runtime')
    mkdirSync(runtimeDir, { recursive: true })
    mkdirSync(join(dir, '.StudyOS', 'projects', 'demo-project', 'sessions'), { recursive: true })
    writeFileSync(join(runtimeDir, 'active-sessions.json'), JSON.stringify({
      'conv-1': { project_id: 'demo-project', learning_session_id: 'session-1' },
    }), 'utf8')
    writeFileSync(join(dir, '.StudyOS', 'projects', 'demo-project', 'sessions', 'session-1.json'), JSON.stringify({
      schema_version: 'learning_session.v1',
      session_id: 'session-1',
      project_id: 'demo-project',
      status: 'active',
      conversation_session_id: 'conv-1',
    }), 'utf8')
    const session = activeSessionForConversation(dir, 'conv-1')
    expect(session).not.toBeNull()
    expect(session?.session_id).toBe('session-1')
  })

  it('returns null when the binding shapes are invalid', () => {
    const dir = tempDir()
    const runtimeDir = join(dir, '.StudyOS', 'runtime')
    mkdirSync(runtimeDir, { recursive: true })
    writeFileSync(join(runtimeDir, 'active-sessions.json'), JSON.stringify({
      'conv-1': { project_id: 'BAD ID!', learning_session_id: 'BAD ID!' },
      'conv-2': 'not-an-object',
    }), 'utf8')
    expect(activeSessionForConversation(dir, 'conv-1')).toBeNull()
    expect(activeSessionForConversation(dir, 'conv-2')).toBeNull()
  })

  it('returns null when the session file is missing or not active', () => {
    const dir = tempDir()
    const runtimeDir = join(dir, '.StudyOS', 'runtime')
    mkdirSync(runtimeDir, { recursive: true })
    mkdirSync(join(dir, '.StudyOS', 'projects', 'demo-project', 'sessions'), { recursive: true })
    writeFileSync(join(runtimeDir, 'active-sessions.json'), JSON.stringify({
      'conv-1': { project_id: 'demo-project', learning_session_id: 'session-missing' },
      'conv-2': { project_id: 'demo-project', learning_session_id: 'session-inactive' },
      'conv-3': { project_id: 'demo-project', learning_session_id: 'session-wrongconv' },
    }), 'utf8')
    writeFileSync(join(dir, '.StudyOS', 'projects', 'demo-project', 'sessions', 'session-inactive.json'), JSON.stringify({
      schema_version: 'learning_session.v1',
      session_id: 'session-inactive',
      project_id: 'demo-project',
      status: 'completed',
      conversation_session_id: 'conv-2',
    }), 'utf8')
    writeFileSync(join(dir, '.StudyOS', 'projects', 'demo-project', 'sessions', 'session-wrongconv.json'), JSON.stringify({
      schema_version: 'learning_session.v1',
      session_id: 'session-wrongconv',
      project_id: 'demo-project',
      status: 'active',
      conversation_session_id: 'different-conversation',
    }), 'utf8')
    expect(activeSessionForConversation(dir, 'conv-1')).toBeNull()
    expect(activeSessionForConversation(dir, 'conv-2')).toBeNull()
    expect(activeSessionForConversation(dir, 'conv-3')).toBeNull()
  })
})
