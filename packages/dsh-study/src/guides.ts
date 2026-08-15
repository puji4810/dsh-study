/**
 * StudyOS prompt-operation guides. Each intent maps to the exact operation shapes the
 * Python plugin discloses with a selected workflow; the data mirrors `tools.py` verbatim
 * so every model-facing guide string stays byte-identical.
 * @module @puji4810/dsh-study/guides
 */

/**
 * Per-intent operation guide. Keys are the seven prompt-context intents; each value lists
 * the `study_activity`/`study_coach` operations a workflow may disclose for that intent.
 */
export const PROMPT_OPERATION_GUIDES: Readonly<Record<string, ReadonlyArray<Readonly<Record<string, unknown>>>>> = {
  planning: [
    { tool: 'study_activity', operation: 'project.status' },
    { tool: 'study_activity', operation: 'curriculum.list' },
    { tool: 'study_activity', operation: 'schedule.list|read|template' },
    {
      tool: 'study_activity',
      operation: 'schedule.validate|save',
      data: 'complete study_schedule.v1 object returned from template',
    },
    {
      tool: 'study_activity',
      operation: 'plan_proposal.ensure_today|list|read|save|accept|reject|apply',
    },
  ],
  schedule_adjustment: [
    { tool: 'study_activity', operation: 'project.status' },
    { tool: 'study_activity', operation: 'schedule.list|read|template' },
    {
      tool: 'study_activity',
      operation: 'schedule.validate|save',
      data: 'complete study_schedule.v1 object',
    },
  ],
  organizing: [
    {
      tool: 'study_activity',
      operation: 'note.list|read|extract',
      data_fields: ['note', 'folder', 'query', 'include_body'],
    },
    {
      tool: 'study_activity',
      operation: 'note.save|validate',
      data_fields: ['notes[{path,content,overwrite?}]', 'overwrite?'],
    },
    { tool: 'study_activity', operation: 'note.audit|graph', data_fields: ['roots?'] },
  ],
  reviewing: [
    {
      tool: 'study_activity',
      operation: 'review.due',
      data_fields: [
        'notes?',
        'subjects?',
        'tags?',
        'concepts?',
        'difficulties?',
        'review_levels?',
        'review_state?',
        'match?',
        'sort?',
        'limit?',
        'exclude_paths?',
      ],
    },
    {
      tool: 'study_activity',
      operation: 'note.read',
      data_fields: ['note', 'include_body?'],
    },
    {
      tool: 'study_activity',
      operation: 'review.submit',
      data_fields: [
        'note',
        'response',
        'result',
        'duration_seconds',
        'hints_used?',
        'evaluator?',
        'assistance?',
        'diagnoses?',
      ],
    },
  ],
  teaching: [
    { tool: 'study_activity', operation: 'learning_record.list|read' },
    { tool: 'study_activity', operation: 'note.list|read' },
    {
      tool: 'study_coach',
      action: 'start',
      data_fields: [
        'session_id',
        'contract{mode,objective,time_budget_minutes,assistance_level,evidence_targets,objective_ids?}',
      ],
    },
    {
      tool: 'study_coach',
      action: 'advance',
      data_fields: [
        'session_id',
        'observation{response,result,evaluator,score?,duration_seconds?,concepts?,diagnoses?,source_anchors?,artifact_refs?}',
      ],
    },
    { tool: 'study_coach', action: 'snapshot|finish', data_fields: ['session_id'] },
  ],
  assessment: [
    {
      tool: 'study_activity',
      operation: 'attempt.record|list|read',
      data_fields: [
        'item_id?',
        'response?',
        'result?',
        'evaluator?',
        'diagnoses?',
        'concepts?',
        'start_date?',
        'end_date?',
      ],
    },
    { tool: 'study_activity', operation: 'review.weekly_report|create_task' },
    {
      tool: 'study_coach',
      action: 'diagnose|summarize|recommend|generate_probe|propose_pattern',
      data_fields: ['concept?', 'item_id?', 'attempt_ids?', 'start_date?', 'end_date?'],
    },
  ],
  error_analysis: [
    {
      tool: 'study_activity',
      operation: 'attempt.record|list|read',
      data_fields: ['response?', 'result?', 'evaluator?', 'diagnoses?', 'concepts?'],
    },
    { tool: 'study_activity', operation: 'error.record|review.create_task' },
    {
      tool: 'study_coach',
      action: 'diagnose|recommend|generate_probe|propose_pattern',
      data_fields: ['concept?', 'item_id?', 'attempt_ids?'],
    },
  ],
}
