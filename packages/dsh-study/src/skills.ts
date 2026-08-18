/**
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
  {
    name: "study-assessment",
    description: "Analyze StudyOS exams and mistakes.",
    content: `
# StudyOS Assessment

## When To Use

Use for mock exams, weekly review, 错题, and diagnostics. Call
\`study_activity(resource="prompt_context", action="load",
data={"intent":"assessment"})\` or use \`"error_analysis"\`;
never mutate system prompts.

<!-- prompt-context:begin -->
## Diagnose From Evidence

1. Set the scope: one attempt, a concept, a session, a week, or the project.
   Read existing attempts before using \`study_coach\` on the same scope; it may
   summarize or recommend but never proves unobserved dimensions.
2. For a new answer, classify outcome, reasoning, missed conditions, concept,
   pattern, and next action. Record an immutable \`attempt\` first; log an
   \`error\` only when a concrete failure needs durable remediation.
3. Use \`review.weekly_report\` for a requested weekly artifact. Create
   \`review.create_task\` only for an accepted follow-up, not every
   recommendation.
4. For repeated evidence, request \`study_coach.generate_probe\`, ask one
   controlled retest before feedback, then record it as a new attempt. Pattern
   proposals stay candidates until explicitly saved and validated.
5. Return the evidence ids, diagnosis, highest-impact next step, and what is
   still unverified. Sync memory only after a meaningful completed session.

Separate careless execution from missing conditions, concept confusion, and
method gaps. Never convert a score, a review count, or a single correct answer
into a mastery claim.
<!-- prompt-context:end -->

## Diagnosis Payload Shape

Each non-empty \`diagnoses\` item must be an object with non-empty \`kind\` and
observed \`evidence\`, never a string label. \`kind\` is a short, stable category
such as \`condition_missed\` or \`concept_confusion\`; \`evidence\` quotes the
specific observed response or reasoning that supports it. An optional \`concept\`
names the concept most directly implicated. Use \`[]\` when no specific diagnosis
is supported by what was actually observed — an empty list is always better
than a guess.

## Choosing The Right Record

Shorthand above maps onto the persistence tool: \`attempt.record\` and
\`review.weekly_report\` are
\`study_activity(resource="attempt", action="record", ...)\` and
\`study_activity(resource="review", action="weekly_report", ...)\`. Existing
evidence is read back the same way, through \`study_activity\`, before any
\`study_coach\` analysis of that scope.

- \`attempt\` is the immutable evidence unit: one observed answer, its result,
  and its diagnoses. Record it first, before any downstream artifact.
- \`error\` is durable remediation state for a concrete failure worth revisiting.
  Not every wrong answer earns one; an attempt already carries the evidence.
- \`review.submit\` is the graded-review path. It stores the attempt and advances
  spacing atomically, so do not also call \`attempt.record\` for the same answer.
- \`review.create_task\` is a commitment. It belongs to a follow-up the learner
  accepted, not to every recommendation the analysis produced.
- Pattern proposals from \`study_coach.propose_pattern\` stay candidates until
  they are explicitly saved and validated. Never auto-apply one.

## Reporting A Diagnosis

Close with the evidence ids the diagnosis rests on, the diagnosis itself, the
single highest-impact next step, and an explicit statement of what remains
unverified. Naming the unverified part is what keeps a diagnosis honest: the
scope only covers dimensions that were actually observed, and a summary from
\`study_coach\` inherits that same limit.

Sync memory only after a meaningful completed session, so that stored context
reflects demonstrated work rather than an in-progress conversation.
`,
  },
  {
    name: "study-engineering",
    description: "Guide engineering and skill learning with StudyOS.",
    content: `
# StudyOS Engineering Domain Pack

Use only with \`domain_pack:"engineering.v1"\`. Load the active workflow intent
with \`study_activity(resource="prompt_context", action="load")\`;
never mutate system prompts.

Only the region between the \`prompt-context\` markers below is inlined into the
prompt fragment for this domain pack. Everything after the closing marker is
reference material for \`skill_view\` and for maintainers: it costs no prompt
budget, so it may be as detailed as it needs to be.

<!-- prompt-context:begin -->
## Evidence-Driven Engineering Learning

1. Identify an \`engineering-repo\`, \`skill-vault\`, or \`hybrid\` workspace. Read
   the real code, docs, benchmark, command output, or paper before explaining.
2. Define an observable skill: trace a call path, explain an invariant,
   reproduce a benchmark, implement a change, or compare designs.
3. Perform its ActivitySpec in the workspace; anchor \`advance\` to a real
   command, test, trace, benchmark, diff, or file.
4. Create a concept note only when it blocks understanding, recurs across work,
   or will be reused. Every durable note needs a source anchor.
5. Separate unverified claims from observed performance.

Avoid exam-vault defaults such as daily dashboards, Anki export, and full error
systems unless the user asks. Prefer lightweight, maintained records over a
large taxonomy of notes.
<!-- prompt-context:end -->

## Session Lifecycle Behind the Steps

The base \`study-os\` router fragment and the \`study_coach\` schema already carry
the Session lifecycle, so the marked region does not restate it. The mapping is
recorded here for maintainers.

- Step 2 opens the Session: \`study_coach(action="start", data={...})\` with a
  contract carrying \`objective\`, \`assistance_level\`, \`time_budget_minutes\`, and
  \`evidence_targets\`. All four are required by the schema.
- Step 3 records work: \`study_coach(action="advance", ...)\` with \`evaluator\`
  provenance and a source anchor. Add \`artifact_refs\` for the execution and
  transfer dimensions — that is where the engineering artifact vocabulary in
  the marked region applies, since the schema itself accepts free strings.
- Step 5 inspects and closes: \`study_coach(action="snapshot", ...)\` to choose
  the next probe, and \`study_coach(action="finish", ...)\` when stopping.

## Source Anchors

\`source_anchors[].kind\` is a closed enum (\`file\`, \`paper\`, \`book\`, \`web\`,
\`dataset\`, \`command\`, \`commit\`, \`note\`, \`other\`), and the model sees it on the
tool schema. In this domain the anchor is usually a file, a symbol inside a
file, a command, a benchmark run, or a paper; put the precise position — line
range, symbol name, benchmark case, commit — in \`locator\` or \`version\` so a
later Session can reopen the same evidence instead of re-deriving it.

A concept note without an anchor is an assertion, not a record. That rule stays
in the marked region because nothing in the tool schemas enforces it.

## Workspace Shapes

\`workspace_type\` is a free string on the project manifest; this pack expects
one of three shapes, and \`plugins/study_os/domain_packs/engineering.py\` seeds
the general default of \`skill-vault\`.

| Shape | What it holds | Where evidence comes from |
| --- | --- | --- |
| \`engineering-repo\` | A real code tree under study | Call paths, tests, diffs, command output, benchmarks |
| \`skill-vault\` | Notes about a skill with no single repo | Papers, docs, reproductions, worked exercises |
| \`hybrid\` | Notes plus one or more repos | Either, but every durable note still points at a source |

Identify the shape before the first explanation. It decides what counts as an
observable skill in step 2 and what a legitimate \`advance\` anchor looks like in
step 3.

## Why the Exam Defaults Are Off

The 考研 pack's habits — daily dashboards, Anki export, a full 错题 system —
assume a fixed syllabus and a dated exam. Engineering and skill work has
neither: the target moves, and a heavy record system decays into unmaintained
notes faster than it repays the setup. Build one only when the user asks for
it, and prefer a small set of maintained records with live anchors over a large
taxonomy.

## Pack Defaults

Defined by \`plugins/study_os/domain_packs/engineering.py\`, which reuses the
general project defaults and overrides \`domain_pack\` to \`engineering.v1\`. The
intervention duration is 45 minutes, longer than the 考研 pack's 30, because a
useful engineering probe usually includes reading real source or running
something. Activities are shaped by \`EngineeringActivityAdapter\`.
`,
  },
  {
    name: "study-grill",
    description: "Bridge grilling sessions into StudyOS decisions.",
    content: `
# StudyOS Grill

Use for a strategic learning decision, not routine planning, 整理, 复习,
assessment, or 错题 repair. Call \`study_activity(resource="prompt_context",
action="load", data={"intent":"planning"})\` and inspect existing \`decision\`
records; never mutate system prompts.

## Decision Flow

1. Define the decision, its owner, deadline, constraints, and reversible versus
   irreversible consequences. Search project notes or source material before
   asking the learner for discoverable facts.
2. Follow \`/grilling\`: ask one high-leverage question at a time, state a
   recommendation with reasoning, and compare concrete options rather than
   producing motivational prose.
3. Persist with \`study_activity(resource="decision", action="create")\` only
   after a stable decision is accepted. Include options, consequences, concepts,
   sources, and linked sessions. Do not write one for an open brainstorm.
4. Hand reusable knowledge to \`study-organize\`; route the resulting action plan
   to \`study-plan\`. Report the decision id or say clearly that nothing was
   persisted.
`,
  },
  {
    name: "study-kaoyan",
    description: "Guide 考研 learning with StudyOS.",
    content: `
# StudyOS 考研 Domain Pack

Use only with \`domain_pack:"kaoyan.v1"\`. Load the active workflow intent with
\`study_activity(resource="prompt_context", action="load", data={"intent":"..."})\`;
never mutate system prompts.

Only the region between the \`prompt-context\` markers below is inlined into the
prompt fragment for this domain pack. Everything after the closing marker is
reference material for \`skill_view\` and for maintainers: it costs no prompt
budget, so it may be as detailed as it needs to be.

<!-- prompt-context:begin -->
## 考研 Operating Rules

- Storage stays generic: 考研 is a domain pack, not a separate persistence
  model.
- Confirm exam date, phase, subjects, available time, and material before
  proposing a schedule. The default project is \`kaoyan-2027\`, but never assume
  it replaces the user's active project.
- Build curriculum from 考点, prerequisites, textbook/exercise sources, and
  representative problems. Foundation work favors definitions, formulas, and
  examples; review work favors 错题 clusters, weak prerequisites, and timed
  transfer practice.
- Persist only validated curricula and schedules. A saved calendar artifact is
  read-only in the desktop UI; never imply drag/drop or unsaved edits exist.
- Strategic study-system tradeoffs belong to \`study-grill\`, never routine
  schedules, 整理, 复习, or 错题 remediation.
<!-- prompt-context:end -->

## Skill Routing

The base \`study-os\` router already carries the routing table, so these mappings
are restated here only as domain vocabulary — they do not need to occupy the
domain fragment's budget.

- Schedules and next steps -> \`study-plan\`.
- Problem capture and 整理 -> \`study-organize\`.
- Retrieval, 复习, and spaced repetition -> \`study-review\`.
- Mock exams (模考) and 错题 analysis -> \`study-assessment\`.
- A missing prerequisite -> \`study-teach\`.
- \`study-lesson\` only for a requested or genuinely visual concept.
- Strategic study-system tradeoffs -> \`study-grill\` (see the marked region: this
  one carries a negative guardrail, so it stays in the prompt fragment).

## Pack Defaults

Defined by \`plugins/study_os/domain_packs/kaoyan.py\`. These are seeds for
\`project.init\`, not assumptions to apply to an existing project.

| Field | Default |
| --- | --- |
| \`project_id\` | \`kaoyan-2027\` |
| \`title\` | 2027 考研学习计划 |
| \`domain\` / \`exam_type\` | \`kaoyan\` / 考研 |
| \`exam_date\` | 2027-12-20 |
| \`phase\` | \`foundation\` |
| \`workspace_type\` | \`exam-vault\` |
| \`artifact_policy\` | \`lightweight\` |
| Intervention duration | 30 minutes |

Default subjects and target scores: 数学 (\`math\`, 120), 英语一 (\`english\`, 75),
政治 (\`politics\`, 75). The starter schedule template uses the \`Asia/Shanghai\`
timezone and a 基础阶段 phase whose goal is 完成核心考点覆盖.

Confirm each of these with the learner before building on them. An exam date,
a phase boundary, or a subject list carried over from the defaults into a
learner's real plan is a silent error that only surfaces months later.

## Curriculum Notes

- 考点 are the unit of coverage. A curriculum entry that cannot be traced to a
  考点, a prerequisite concept, or a representative problem is decoration.
- Foundation phase: definitions, formulas, worked examples, and the smallest
  transfer step that proves the definition landed.
- Review phase: 错题 clusters first, then the prerequisites those clusters
  expose, then timed transfer practice under exam conditions.
- Textbook and exercise sources belong on the curriculum entry, so a later
  session can reopen the same material instead of guessing.

## Persistence Notes

- A Markdown draft is never persistence. Curricula and schedules reach the
  desktop panel only through the validated save path.
- A saved calendar artifact renders read-only in the desktop UI. Never describe
  drag/drop, inline editing, or unsaved local edits to the learner — the next
  change goes through a new validated save.
`,
  },
  {
    name: "study-lesson",
    description: "Create visual StudyOS lesson artifacts.",
    content: `
# StudyOS VisualLesson

Use only when a requested lesson needs structure, flow, time, state, spatial
layout, or interaction. Call \`study_activity(resource="prompt_context",
action="load", data={"intent":"teaching"})\`; never mutate system prompts.

1. Read relevant concept notes and sources; define one visual learning
   objective and explain why text alone is insufficient.
2. Do not create HTML for routine 整理, 复习, weekly assessment, or 错题 repair.
   Prefer an existing note, explanation, or small probe unless a reusable visual
   artifact is justified.
3. For an accepted artifact, call \`study_activity(resource="lesson",
   action="create")\` with one complete HTML document, rationale, linked concepts,
   and source links. Read it back and report both HTML and metadata paths.
4. If the learner demonstrates something after using it, record that separate
   evidence through \`attempt\` or \`learning_record\`; viewing a lesson is not
   evidence of understanding.
`,
  },
  {
    name: "study-organize",
    description: "Organize problems into StudyOS notes.",
    content: `
# StudyOS Organize

Use when the user asks to 整理, analyze, or turn a problem into notes. Call
\`study_activity(resource="prompt_context", action="load",
data={"intent":"organizing"})\`; never mutate system prompts.

<!-- prompt-context:begin -->
## Layered Organization

Organize into Vault notes only; never mutate system prompts or skill files.

Choose the lightest layer that satisfies the request:

1. **Capture** preserves enough context for later work with minimal discovery.
2. **Synthesize** produces the smallest reusable note change after targeted
   discovery.
3. **Curate** improves collection-wide coherence through broader analysis.

Choose by requested outcome, scope, and reversibility; when uncertain, prefer
the least mutating layer. A request for a persisted note authorizes that scoped
write, while an analysis request does not. \`note.save\` validates links and
saves atomically; reserve \`note.validate\` for previews or higher-risk batches.

Report source, concepts/patterns found, files changed, and unresolved
ambiguity. Organizing a concept never makes it mastered.

Create a pattern only when it has a stable recognition signal, required
conditions, and a reusable solution routine. Prefer links to existing Box notes
over copying their explanation.
<!-- prompt-context:end -->

## Note Write Mechanics

The loaded operation guide carries the call shapes, while backend validation
owns these mechanics. They live outside the prompt-context region as reference.

- On a requested write, assemble complete \`{path, content}\` objects and call
  \`study_activity(resource="note", action="save", data={"notes":[...]})\`.
  Never use a generic file-writing tool for Vault notes.
- Validation follows WikiLinks recursively through both the batch and existing
  notes. If it reports a missing target, add a substantive note for that target
  to the same batch — and resolve any links introduced by that new note — until
  \`missing\` is empty. A batch that still has missing targets is rejected.
- \`note.save\` performs the same recursive validation before its atomic write.
  Use \`note.validate\` as a non-writing preview for a large or high-risk batch.
  \`overwrite:true\` permits replacement, so set it only for an intentional
  update and read that updated note back afterwards.

## Vault-Wide Checks

Use \`note.audit\` when the user asks to check the wider Vault. It reports
WikiLink integrity across notes that already exist and is independent of the
batch just written, so it is not part of a routine organizing pass.
`,
  },
  {
    name: "study-os",
    description: "Route StudyOS learning workflows.",
    content: `
# StudyOS Router

<!-- prompt-context:begin -->
## Route

Route plans and next steps to \`study-plan\`, organization to \`study-organize\`,
recall to \`study-review\`, teaching to \`study-teach\`, and diagnosis to
\`study-assessment\`. Route Domain Packs to their matching skill; use
\`study-lesson\` for interactive visual artifacts, \`study-tikz\` for mathematical
diagrams in Web explanations (send a \` \`\`\`tikz \` fence directly; it is Web-only,
with no local LaTeX/PDF compilation), and \`study-grill\` for strategic decisions.

## Flow

1. Enter the workflow the learner asked for. Call \`plan_proposal.ensure_today\`
   only for daily planning; never interrupt review or teaching with it.
2. The learner controls scope, pace, and stopping. Treat interaction completion
   and evidence verification separately; never continue solely to strengthen a
   verification label. Stopping closes future work without erasing supported
   observations already produced.
3. Read relevant records before changes; persist only completed outcomes:
   LearningRecord for demonstrated progress, LearningDecisionRecord for an
   accepted strategy.
4. Use one evidence owner. Atomic workflows complete themselves; otherwise
   follow one focused Session's ActivitySpec.
5. Never infer mastery from chat, counts, or plans.
   Never mutate system prompts; active Session state is turn-local context.
<!-- prompt-context:end -->

## Reference

Everything below this line stays in the skill document but is deliberately
outside the prompt-context markers: it is either already stated by the
\`study_activity\` / \`study_coach\` tool schema descriptions the model always
sees when the \`study\` toolset is on, or it is guidance for a human reading
\`skill_view\` rather than a rule the router has to carry into every turn.

### Setup

Enable \`study\` before a new chat.

### Entering a workflow

Check \`project.status\`; initialize only when asked. Load \`prompt_context.load\`
for the intent. Both steps are already in the \`study_activity\` description, and
this document only ever reaches the model *as* the output of
\`prompt_context.load\`, so repeating them inside the markers could not change
anything.

### Tool division of labour

\`study_activity\` owns state; \`study_coach\` concludes.

### Writes

Never use generic writes for supported resources: \`schedule.save\` registers
schedules; Vault notes require \`note.validate\`/\`note.save\` and all recursive
WikiLink misses. Audit with \`note.graph\`.

### Session call shapes

Start a focused Session once with the complete minimal contract:

\`\`\`text
study_coach(action="start", data={"session_id": "learn-topic-001", "contract":
  {"mode": "learn", "objective": "observable capability",
   "time_budget_minutes": 30, "assistance_level": "guided",
   "evidence_targets": ["explanation"]}})
\`\`\`

Use schema enums and an integer budget; optional \`objective_ids\` must exist.

Advance only after the learner responds, and reuse that \`session_id\` for
\`snapshot\` and \`finish\` — both rules are already carried by the \`study_coach\`
\`action\` and \`observation\` schema descriptions:

\`\`\`text
study_coach(action="advance", data={"session_id": "learn-topic-001",
  "observation": {"response": "observed response", "result": "partial",
   "evaluator": {"kind": "agent"}, "diagnoses": []}})
\`\`\`

### Evidence rules

Record only observed learner work. Never infer mastery from chat, counts, or
plans, nor auto-apply proposals. Cron may save a proposal but cannot decide it
or save a Schedule.
`,
  },
  {
    name: "study-plan",
    description: "Create, revise, and persist StudyOS learning schedules.",
    content: `
# StudyOS Planning

<!-- prompt-context:begin -->
## Schedule

\`events\` are timezone-aware sessions inside the phase range that satisfy
\`duration_minutes == end - start\`. Never encode a phase as a multi-day event.

## Workflow

1. Read the active project, curricula, and target Schedule. Create a missing
   curriculum first.
2. Map observable objectives, prerequisites, sources, time, and a checkpoint.
   Never invent dates, scores, or availability; keep topic names stable.
3. For advice, “how should I plan?”, or an explicit draft, return a compact
   draft without mutation. An imperative request to create, complete, update,
   register, or add a **StudyOS** plan/calendar authorizes persistence.
4. Missing daily time slots never block a long-term Schedule: save dated
   \`phases\` with \`events: []\` and add events only when times are known.
5. Do not end with “I will register it next.” Continue in the same turn
   through \`schedule.validate\` and \`schedule.save\`. Claim
   saved/registered/written/completed only after success, and report the
   returned path.

## Proposals

\`plan_proposal.ensure_today\` derives and persists the day's plan once; call it
for a daily plan or briefing rather than building one by hand, and do not
create a second plan when it returns \`created: false\`.

List pending proposals before saving one. Only an explicit learner decision
permits accept/reject. Apply an accepted proposal with \`plan_proposal.apply\`,
which writes its day-plan events and nothing else. Changing \`phases\` or \`range\`
is still \`schedule.validate\` then \`schedule.save\`.
<!-- prompt-context:end -->

## Reference

Everything below is background for a human or for \`skill_view\`. The loaded
operation guide carries call shapes; backend validation owns their invariants.

### Entry sequence

First call \`study_activity\` for \`project.status\`, then \`prompt_context.load\`
with intent \`planning\` or \`schedule_adjustment\`. Never mutate system prompts.

If \`study_activity\` is unavailable, ask to enable the \`study\` toolset; never
substitute file tools. (This case cannot be covered by the injected fragment:
\`prompt_context.load\` is itself a \`study_activity\` resource, so when the tool
is missing there is no fragment to read.)

### Schedule shape

- Long-term roadmaps belong in \`phases\`. Use \`phase.goal\`, optional \`goals\`,
  and an optional aggregate \`effort_minutes\` to describe a phase.
- \`events\` are optional concrete sessions: \`events\` may be empty until daily
  times are known, and are filled in later without reshaping the phase.

### Persisting a Schedule

Pass the same complete \`study_schedule.v1\` object to both calls, in order:

- \`study_activity(resource="schedule", action="validate", project_id="...", data={...})\`
- \`study_activity(resource="schedule", action="save", project_id="...", data={...})\`

\`data\` is the Schedule itself, never \`data.schedule\`, \`data.data\`, or a
prewritten file. \`schedule.save\` is registration: it validates, writes the
canonical file that the StudyOS panel discovers, and returns that path. Do not
write or register the Schedule separately.

A Markdown roadmap, including one written under \`.StudyOS/plans/\`, is not a
Schedule. Producing one does not satisfy a request to create, complete,
update, register, or add a StudyOS plan.

### Proposal tools

Use \`study_coach.prioritize\` to rank a project-wide Intervention Queue and
\`study_coach.propose_plan\` to produce a read-only Plan Proposal. Proposals are
stored through \`study_activity\` with \`resource="plan_proposal"\`, which supports
\`save\`, \`list\`, \`read\`, \`accept\`, and \`reject\`.

Acceptance records a decision and never mutates a Schedule on its own. Cron
sessions may save proposals but can never decide them or save Schedules.
`,
  },
  {
    name: "study-research",
    description: "Guide research and replication learning with StudyOS.",
    content: `
# StudyOS Research Domain Pack

Use only with \`domain_pack:"research.v1"\`. Tie claims to exact sources. Call
\`study_activity(resource="prompt_context", action="load", data={"intent":"teaching"})\`;
never mutate system prompts.

<!-- prompt-context:begin -->
## Research Flow

1. Read the objective and source anchors. Separate claim, reported evidence,
   learner inference, and uncertainty. Reading and agent explanation are not
   evidence.
2. Perform the ActivitySpec. For replication, record method, environment,
   command, result, and divergence; for explanation, name an assumption and a
   limitation. Preserve failed and partial results.
3. Report unverified dimensions.

## Research Integrity

Tie every claim to an exact locator and a versioned artifact. One replication
supports only its tested setup. Change one variable for near transfer; require
a falsifiable hypothesis and rejection condition for far transfer.
<!-- prompt-context:end -->

## Session Mechanics

The \`study_coach\` tool schema is authoritative for field names, enums, and
required keys. This section only records how the research flow above maps onto
the Session lifecycle.

1. **Start.** Open an explicit contract with
   \`study_coach(action="start", data={...})\`. Include one objective,
   source-backed \`objective_ids\`, assistance, time budget, and evidence
   targets. \`objective_ids\` are optional, but any id you pass must already
   exist in the active Learning Project, and in this pack each one should trace
   back to a source anchor rather than to an inference.
2. **Advance.** After each observed learner response, call
   \`study_coach(action="advance", data={...})\` with \`evaluator\` and
   \`source_anchors\`, plus \`artifact_refs\` for execution or transfer. A
   replication run, a script, a log, or a diff belongs in \`artifact_refs\`; the
   paper, repository, or ticket it came from belongs in \`source_anchors\` with
   its \`version\` and \`locator\` filled in whenever they are known.
3. **Snapshot and finish.** Use \`snapshot\` to choose the next probe and
   \`finish\` when stopping. Reuse the same \`session_id\` across \`start\`,
   \`advance\`, \`snapshot\`, and \`finish\`.

## Why These Rules

- **Reading is not evidence.** A learner who has read a paper, and an agent
  that has explained it, have both produced zero observations of learner
  capability. Only an evaluated learner response advances a Session.
- **Failures are results.** A replication that diverges is the most
  informative outcome in this pack. Recording it as \`fail\` or \`partial\`, with
  the divergence described, is what makes the next probe worth running.
- **Scope claims to what was tested.** Environment, version, and command
  determine what a single replication supports. Near transfer changes one
  variable at a time; far transfer needs a hypothesis stated in advance
  together with the condition that would reject it.
`,
  },
  {
    name: "study-review",
    description: "Run flexible StudyOS spaced-repetition reviews.",
    content: `
# StudyOS Review

Use for 复习 and 艾宾浩斯 review. Load context with \`study_activity\`
\`prompt_context.load\` at intent \`reviewing\`; never mutate system prompts.

<!-- prompt-context:begin -->
## Queue

Call \`review.due\`; default due/priority/10. Respect selectors and \`limit\`. On
shortfall report counts; if empty offer one relaxation, never broaden silently.

## Loop

1. Hide the solution and present one coherent retrieval task at a time.
2. Let the learner determine when their response is complete. Completion,
   correctness, and verification strength are independent judgments.
3. Stopping closes future work, not prior evidence. Evaluate the accumulated
   response against the learning objective, not the percentage of requested
   steps completed.
4. When the response supports a result, call \`review.submit\` once. Leave it
   unrecorded only when no evaluable response exists or the learner explicitly
   discards it. Offer the next item as an option, not an obligation.
<!-- prompt-context:end -->

## Queue selectors

\`review.due\` selectors combine with AND:

- Scope: \`notes\`, \`subjects\`, YAML tags, \`concepts\`
- Exclusion: \`exclude_paths:[".opencode","archive"]\`
- Level: \`difficulties\`, \`review_levels\`, \`min|max_review_level\`
- State: \`review_state\` due/new/reviewed/all; \`match\` any/all
- Order: \`sort\` priority, oldest, newest, difficulty_asc/desc, title

Hidden directories are excluded by default. \`limit\` caps the queue; it is
never a target to fill. On shortfall report \`count\` and \`available_count\`.

## Review levels

Do not ask for confidence or a review level; the backend assigns it:
incorrect → Lv.1, partial → Lv.2, correct → at least Lv.3, then Lv.4/Lv.5
after repeated correct reviews.

## Recording

\`review.submit\` saves evidence and spacing atomically, so one call finishes a
graded review. It is a completion action, never a checkpoint action. Never
also call \`attempt.record\` or \`review.record\`, start or advance a Learning
Session, or pass its returned \`attempt_id\` to \`study_coach.advance\`. Diagnoses
are objects, never strings; use \`[]\` when the response supports none. Ending
before every requested step is complete does not discard accumulated evidence.
Preserve spacing only when no evaluable response exists or the learner
explicitly asks not to record it.

## Interaction contract

Keep one response in progress until the learner treats it as complete.
\`partial\` describes quality, not interaction state. Do not grade before
completion or demand another confirmation afterwards. Judge the completed
response against the learning objective: stopping may still support a correct,
partial, or incorrect result. Closing future steps never erases prior evidence.
`,
  },
  {
    name: "study-teach",
    description: "Teach through StudyOS learning records.",
    content: `
# StudyOS Teach

Use for an explicit concept or skill lesson. Before teaching, call
\`study_activity(resource="prompt_context", action="load",
data={"intent":"teaching"})\` to load the loop below, then inspect the relevant
\`learning_record\` entries and source notes. Never mutate system prompts: the
loaded fragment is turn-local context, not prompt content to rewrite.

<!-- prompt-context:begin -->
## Teach-Test-Record

1. Read relevant records and set one small objective.
2. The learner controls depth, pace, assistance, and stopping. Adapt the
   teaching strategy instead of enforcing a fixed dialogue pattern.
3. Teach only what the objective needs from trusted sources. Choose explanation,
   questioning, retrieval, or application according to the learner's intent and
   current evidence.
4. Separate interaction completion from evidence verification. Record only what
   the available observation supports; never prolong teaching merely to obtain
   a stronger verification label.
5. Stopping closes future work without erasing supported observations. Record
   observed work with \`study_coach.advance\` in a Session, otherwise
   \`attempt.record\`. Create learning records only for durable evidence.
6. On \`ready_to_finish\`, finish unless the learner chooses a new follow-up.
   Report unverified parts; explanation alone never proves mastery.
<!-- prompt-context:end -->

## Recording Details

Inside an active Session, \`study_coach.advance\` carries evaluator and assistance provenance on the
observation payload. The \`observation\` tool schema lists the exact fields and
which of them are required, so follow it rather than guessing a shape here.

Use \`diagnoses: []\` when no specific diagnosis is supported. Otherwise every
item is an object with a non-empty \`kind\` and the observed \`evidence\`, never a
bare string; the \`diagnoses\` schema states the same rule and carries a worked
example.

## Sources That Count

"Trusted project sources" means files, papers, commands, or notes that actually
exist in the project, not recalled claims. Name the specific source an
explanation came from so the learner can re-check it, and say plainly which
parts of the lesson remain unverified.

## Handoffs

Hand a reusable note to \`study-organize\`, a visual need to \`study-lesson\`, and
a strategic tradeoff to \`study-grill\`. The \`study-os\` router skill carries this
same routing table, so it is stated once there for the loaded context and
repeated here only for readers of this skill.

## Editing This Skill

Only the text between the \`prompt-context\` begin and end HTML comment markers
is inlined by \`prompt_context.load\` and counted against the teaching budget.
Everything outside those markers is free: put explanation, examples, and
rationale here rather than shrinking the loop above. Do not write either marker
string anywhere else in this file — a second pair would be read as a second
fragment region.
`,
  },
  {
    name: "study-tikz",
    description: "Create Web-rendered TikZ diagrams for mathematical explanations in StudyOS; always return a tikz fence for dsh Web and never compile locally.",
    content: `
# StudyOS TikZ Diagrams

Use when a mathematical explanation benefits from a precise geometric figure,
such as a line integral, surface integral, orientation, vector field, region,
coordinate construction, or a multi-step spatial relation. Route ordinary
prose or a quick ASCII sketch to \`study-teach\`; use this skill when the figure
itself carries reasoning.

<!-- prompt-context:begin -->
## Web-only TikZ Contract

TikZ is rendered by the dsh Web client, not by the agent's local TeX
installation. Produce the diagram as a \` \`\`\`tikz \` fenced block in the answer
so TikZJax can replace it with an SVG in the browser. The delivery is complete
when that fence has been sent to Web; keep all compilation and rendering inside
the Web client.

Use the Web TikZ path exclusively: do not run \`pdflatex\`, \`xelatex\`,
\`lualatex\`, \`latexmk\`, or any other local compiler; do not create a PDF, local
SVG, image file, or compilation artifact as an intermediate result; and do not
ask the learner to open or upload one. If a preview is needed, send the fence
and inspect the Web-rendered result instead.

1. Put one complete diagram in a fenced \`tikz\` block. The dsh Web client
   renders it in-browser with TikZJax. Return the fence itself, rather than a
   path to a compiled artifact.
2. The environment already loads TikZ. \`pgfplots\` is also available by default,
   and dsh adds \`\\pgfplotsset{compat=1.12}\`. Do not add packages that are not
   needed. If a package is required explicitly, put \`\\usepackage{...}\` at the
   beginning of the fence, before \`\\begin{document}\`.
3. Keep the TikZ source ASCII/LaTeX-only: use LaTeX commands such as \`\\alpha\`
   and \`\\text{}\` for labels, and put Chinese prose outside the fence. TikZJax's
   bundled TeX fonts do not reliably compile raw CJK characters inside a
   diagram.
4. \`\\begin{document}\`/\`\\end{document}\` wrappers are accepted. Keep the actual
   drawing inside one \`tikzpicture\`; use \`\\usetikzlibrary{...}\` when a library
   such as \`calc\`, \`angles\`, \`quotes\`, or \`arrows.meta\` is needed.
5. Make the diagram self-explanatory: label axes, points, orientation arrows,
   boundaries, and the quantity being illustrated. State any non-obvious
   convention in one sentence outside the fence.
6. For a line or surface integral, show the domain and orientation first, then
   the path/surface, tangent or normal direction, and any projection or
   parameter marker used in the explanation. Use a TikZ figure when it reduces
   ambiguity; do not add decorative figures to routine arithmetic.
7. After presenting the figure, explain what each marked object means and check
   that the orientation in the picture matches the sign convention in the
   formula. A rendered figure is an explanation aid, not evidence that the
   learner understands it; verify understanding separately with a question or
   worked reconstruction.
8. Treat a complex \`pgfplots\` figure as an incremental artifact. First make one
   small panel render (for example, one \`axis\` with a low \`samples\` count), then
   add surfaces, sections, labels, and additional panels one layer at a time.
   For a four-panel 3D comparison, prefer four lightweight panels or a simpler
   TikZ schematic when the full surface mesh is not essential to the argument.
9. If Web rendering fails, use the first TeX/WASM error in the browser console
   as the diagnosis, remove the smallest failing layer, and resend the fence.
   \`img-not-found.png\` is only TikZJax's final failure placeholder; it is not a
   second image-generation step and should never be treated as the root cause.
<!-- prompt-context:end -->

## Practical Template

\`\`\`tikz
\\usetikzlibrary{arrows.meta,calc}
\\begin{document}
\\begin{tikzpicture}[>=Stealth, thick]
  \\draw[->] (-0.2,0) -- (4,0) node[right] {$x$};
  \\draw[->] (0,-0.2) -- (0,3) node[above] {$y$};
  \\draw[blue] (0.5,0.5) .. controls (1.5,2.5) and (2.5,2.5) .. (3.5,0.8);
  \\draw[->,red] (1.1,1.7) -- (1.35,1.95) node[above] {$\\mathbf t$};
  \\node at (2,0.25) {$C$};
\\end{tikzpicture}
\\end{document}
\`\`\`

If the figure uses \`pgfplots\`, keep the \`axis\` environment small and label the
domain and axes. Prefer TikZ primitives for a single curve, region, path, or
orientation arrow; they render faster and make the geometric intent clearer.

## Renderability checklist

Before sending a large diagram, check balanced environments and braces, keep
labels short, use explicit \`domain\`/\`y domain\` for parametric surfaces, and
avoid adding several high-sample \`surf\` meshes at once. A failed Web render is
repaired by a focused reduction or split, not by compiling a local PDF or SVG.
When a local source file is available, the bundled static checker
\`scripts/check_tikz_safety.py\` can flag these hazards; it never invokes TeX.
`,
  },
]

/** The base routing skill: source of the `base` prompt fragment. */
export const BASE_PROMPT_SKILL = 'study-os'
