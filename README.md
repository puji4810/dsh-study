# @puji4810/dsh-study

English | [中文](README.zh.md)

Evidence-backed learning orchestration for DeepSeek Harness, ported from the StudyOS plugin: a learner-owned Vault of Markdown notes and JSON state, two model-facing tools, learning sessions, Ebbinghaus spaced repetition, and an evidence-driven intervention planner that derives, decides, and applies day plans.

## Install

```sh
dsh plugin --profile web add @puji4810/dsh-study
```

This installs StudyOS into the `web` profile and automatically enables both the Host plugin and Web panel. To use its tools in one-shot commands too, install it into the `headless` profile separately:

```sh
dsh plugin --profile headless add @puji4810/dsh-study
```

dsh dependencies are isolated by profile, so install the package only into profiles you use. Replace `add` with `update` when upgrading.

The package also installs `@puji4810/dsh-tikz`. In the Web profile, TikZ fenced blocks are rendered by TikZJax with `pgfplots` and `\\pgfplotsset{compat=1.12}` enabled by default.

## What it does

The plugin registers two tools on `ctx.tools`:

- `study_activity(resource, action, data?, vault_path?, project_id?)` — the state interface: projects, schedules, notes, reviews, attempts, and plan proposals. Canonical save actions validate before writing; `review.submit` owns both evidence recording and review spacing.
- `study_coach(action, scope?, data?, vault_path?, project_id?)` — the evidence projection and session runtime: `start`/`start_intervention`/`advance`/`snapshot`/`finish` drive one learning contract, while `diagnose`, `summarize`, `recommend`, `prioritize`, `propose_plan`, `evaluate_interventions`, `evaluate_adherence`, `generate_probe`, and `propose_pattern` derive judgments from immutable attempts.

Both tools return the StudyOS envelope — `{ ok, data?, error?: { code, message, details? }, warnings }` — as their canonical value. Domain failures are `ok: false` values, never thrown exceptions; the stable error codes mirror the Python plugin (`SESSION_NOT_FOUND`, `PROPOSAL_FINGERPRINT_MISMATCH`, `BROKEN_WIKILINKS`, …). The operation shapes for each workflow live in the operation guides returned by `prompt_context.load`, so the two tool schemas stay narrow.

When the `skills` service is composed, the plugin also registers the nine routed StudyOS skills (`study-os`, `study-plan`, `study-organize`, `study-review`, `study-teach`, `study-lesson`, `study-tikz`, `study-assessment`, `study-grill`) plus the three domain-pack skills (`study-engineering`, `study-kaoyan`, `study-research`). Installing `@puji4810/dsh-study` also installs its `@puji4810/dsh-tikz` dependency, which enables TikZ diagrams in the Web client.

## The Vault

StudyOS state lives in a learner-owned Vault directory — the same on-disk layout as the Python plugin, so an existing Vault opens unchanged:

```
<vault>/.StudyOS/
  projects/active.json                          # { "project_id": "<id>" }
  projects/<id>/manifest.json                   # study_project.v1 | .v2
  projects/<id>/prompt_summary.md               # project memory, stored whole
  projects/<id>/activity/attempts-YYYY-MM.jsonl # immutable study_attempt.v1 lines
  projects/<id>/schedules/<schedule_id>.json    # study_schedule.v1
  projects/<id>/plan-proposals/<id>.json        # study_plan_proposal.v1
  projects/<id>/pattern-proposals/<id>.json     # study_pattern_proposal.v1
  projects/<id>/sessions/<id>.json              # learning_session.v1
  projects/<id>/decisions|learning-records|lessons/
  runtime/active-sessions.json                  # conversation → session binding
  concept_graph.json, review_stats.json         # cached projections
```

Markdown notes (concepts, patterns, examples with review frontmatter) live at the Vault root alongside `.StudyOS`. Every timestamp must carry a timezone offset; "local date" comparisons always use the project's IANA timezone. Writes are atomic (temp file + rename), and every path is confined to the Vault.

The derived judgments are never stored: competency snapshots, intervention outcomes, plan adherence, and calibration are recomputed from attempts on every read, so a progress claim always traces back to evidence.

## Workspaces and configuration

```yaml
- id: studyos
  name: '@puji4810/dsh-study'
```

The current dsh workspace is the default Vault. Each workspace therefore owns an independent `.StudyOS` tree, active project, notes, schedules, attempts, and reviews; switching between note repositories switches Vaults without changing plugin configuration.

`config.vaultPath` is an optional fallback for calls whose Session has no workspace. A tool call may still override either value with `vault_path`. StudyOS fails at the first resolvable point when none of those three paths exists.

## Web panel

The sidebar footer opens a workspace-scoped StudyOS panel. It shows projects, schedule phases, calendar events, and due reviews. Its **Plan** view exposes the full intervention lifecycle: choose an evidence-derived or custom study window, add busy periods and daily caps, preview the ranked queue, reorder/defer/pin individual interventions, then explicitly save, accept or reject, and apply the resulting events. Editing constraints never rewrites evidence scores, and a changed draft must be previewed again before it can be decided. Selecting a project updates only that workspace's `.StudyOS/projects/active.json`; read-only dashboard projections are not persisted.

## Intervention planning

`study_coach.propose_plan` keeps the Intervention Queue evidence-derived and deterministic, then applies an optional `data.scheduling` layer to the calendar projection. The caller may provide a `target_date`, one or more local `windows`, `busy` periods, break and daily-minute caps, and bounded duration fitting; after reading `prioritize`, an agent may also reorder, defer, or place specific Intervention ids without rewriting their evidence reasons or scores. Existing Schedule events are treated as hard conflicts, and the read-only call can be repeated to compare alternatives. Persist with `plan_proposal.save`, or use `plan_proposal.ensure_today` with the same controls for the project-local current date only; an explicit learner decision then accepts or rejects it. `study_coach.start_intervention` executes one accepted item, consumes its concrete day-plan duration when present, and permits only constrained `execution` overrides for time budget and assistance level while preserving objective, evidence target, and provenance. `plan_proposal.apply` remains optional calendar projection only: it preflights every target Schedule, writes events and nothing else, and rolls back partial commits. Only provenance-linked attempts feed intervention-effect calibration; adherence and outcome signals remain sample-gated and bounded.

## Spaced repetition

Review spacing is Ebbinghaus-based, not FSRS or SM-2: the interval table `[1, 2, 4, 7, 15, 30, 60, 120]` days, weighted by `review_level` (`0.5 … 2.5`), with a failure resetting the count and scheduling tomorrow. Review state lives in each example note's frontmatter (`review_count`, `review_level`, `last_reviewed_at`, `next_review_at`); `review.submit` records the attempt and advances the spacing atomically.

## Model Experience

### Request context and condition

#### What the model sees

The two tool schemas with their Python-plugin descriptions, registered through `defineTool`. When the skills service is composed, the twelve StudyOS skills also appear in the skill catalog. After `study_coach.start` or `advance`, the plugin injects the active-session context (`[StudyOS active learning session — turn-local context]` plus the bounded session payload) for the next request through `agent.inject`.

##### `study_activity` description

```markdown
StudyOS state interface. Start a workflow with project.status, then prompt_context.load(intent) for its operation guide. Select an operation with resource and action; put its payload in data. Canonical save actions validate before writing. review.submit owns both evidence and spacing.
```

##### `study_coach` description

```markdown
StudyOS evidence projection and Session runtime. Load the workflow guide before use. start creates no evidence; advance requires an evaluated observation and returns continuation; finish may leave dimensions unverified. Analysis and proposal actions do not mutate Schedules.
```

#### Token effect

Conditional: the two tool schemas are fixed; tool results, the injected active-session context, and loaded skill bodies are per-call and bounded by the StudyOS prompt policy (fragments degrade by priority instead of failing, and the session context is capped at 2800 characters).

#### KV Cache effect

Independent: this package contributes no system-prompt section, so its presence does not shift the prompt prefix; injected context and tool results append per-turn content owned by the calling agent.

## Known Limitations and Deferred Work

- **No cron-run restriction** — `CRON_PROPOSAL_ONLY` guarded Hermes' `cron_` session ids, which do not exist in dsh; scheduled dsh runs decide proposals through the same explicit tool calls as interactive ones.
- **Concept-graph and review-stats caches are per-call** — the Python plugin cached projections on disk with a one-hour TTL; here handlers rebuild them per call (notes scale is small) and the on-disk cache files are still invalidated when notes change.
- **`prompt_context` fragments are bundled** — the routing fragments come from the plugin's inlined skill bodies rather than SKILL.md files on disk, so editing a fragment means editing the package, not a Vault file.
