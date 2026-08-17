# @puji4810/dsh-study

[English](README.md) | 中文

面向 DeepSeek Harness 的基于证据的学习编排，移植自 StudyOS 插件：学习者自有的 Markdown 笔记与 JSON 状态 Vault、两个模型工具、学习会话、艾宾浩斯间隔重复，以及一个「推导 → 决策 → 应用」日计划的证据驱动干预规划器。

## 安装

```sh
dsh plugin --profile web add @puji4810/dsh-study
```

这会把 StudyOS 安装到 `web` profile 并自动启用 Host 插件和 Web 面板。若也要在一次性命令中使用工具，再为 `headless` profile 安装一次：

```sh
dsh plugin --profile headless add @puji4810/dsh-study
```

dsh 的依赖按 profile 隔离，因此只需安装到实际使用的 profile。升级时把 `add` 换成 `update`。

## 功能

插件在 `ctx.tools` 上注册两个工具：

- `study_activity(resource, action, data?, vault_path?, project_id?)` — 状态接口：项目、日程、笔记、复习、尝试与计划提案。规范保存动作写入前先校验；`review.submit` 同时负责证据记录与复习间隔推进。
- `study_coach(action, scope?, data?, vault_path?, project_id?)` — 证据投影与会话运行时：`start`/`start_intervention`/`advance`/`snapshot`/`finish` 驱动一份学习契约；`diagnose`、`summarize`、`recommend`、`prioritize`、`propose_plan`、`evaluate_interventions`、`evaluate_adherence`、`generate_probe`、`propose_pattern` 从不可变尝试记录推导判断。

两个工具都以 StudyOS 信封 — `{ ok, data?, error?: { code, message, details? }, warnings }` — 作为规范返回值。领域失败是 `ok: false` 值而非抛出的异常；稳定错误码与 Python 插件一致（`SESSION_NOT_FOUND`、`PROPOSAL_FINGERPRINT_MISMATCH`、`BROKEN_WIKILINKS`、…）。各工作流的操作形态由 `prompt_context.load` 返回的操作指南承载，因此两个工具 schema 保持窄小。

当 `skills` 服务被组合时，插件还注册九个路由技能（`study-os`、`study-plan`、`study-organize`、`study-review`、`study-teach`、`study-lesson`、`study-tikz`、`study-assessment`、`study-grill`）与三个域包技能（`study-engineering`、`study-kaoyan`、`study-research`）。安装 `@puji4810/dsh-study` 时也会自动安装其 `@puji4810/dsh-tikz` 依赖，从而在 Web 客户端启用 TikZ 图形。

## Vault

StudyOS 状态存放在学习者自有的 Vault 目录中 — 与 Python 插件完全相同的磁盘布局，现有 Vault 无需迁移即可打开：

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

Markdown 笔记（概念、模式、带复习 frontmatter 的例题）与 `.StudyOS` 并排存放在 Vault 根部。所有时间戳必须带时区偏移；「本地日期」比较一律使用项目的 IANA 时区。写入是原子的（临时文件 + rename），所有路径都被限制在 Vault 内。

派生判断从不落盘：能力快照、干预成效、计划依从性与校准每次读取都从尝试记录重算，因此任何进度声明都能追溯到证据。

## 工作区与配置

```yaml
- id: studyos
  name: '@puji4810/dsh-study'
```

当前 dsh 工作区就是默认 Vault。因此每个工作区分别拥有自己的 `.StudyOS` 树、当前项目、笔记、日程、尝试与复习状态；在多个笔记仓库之间切换时不需要修改插件配置。

`config.vaultPath` 只是在 Session 没有关联工作区时使用的可选 fallback。单次工具调用仍可用 `vault_path` 覆盖前两者。三种来源都不可用时，StudyOS 会在最早可判定的位置明确失败。

## Web 面板

侧栏底部入口打开按工作区隔离的 StudyOS 面板，可查看项目、阶段日程、日历事件与到期复习。新增的**计划**视图贯通完整干预流程：选择证据推导或自定义学习窗口，添加忙碌时段和每日上限，预览带证据理由的优先队列，按项调整顺序、延期、目标日程、开始时间与时长，然后显式保存、接受/拒绝并写入 Schedule。日程调整不会改写证据分数；草稿约束一旦变化，必须重新预览后才能决策。切换项目只更新该工作区的 `.StudyOS/projects/active.json`；只读面板投影本身不落盘。

## 干预规划

`study_coach.propose_plan` 仍保持干预队列由证据确定、结果可复现，但把日历投影拆成可选的 `data.scheduling` 层。调用方可以提供 `target_date`、一个或多个本地时间 `windows`、`busy` 时段、休息间隔、每日分钟上限和有下限的自动缩短；agent 在先读取 `prioritize` 后，还可以按 Intervention id 调整顺序、延期或指定日程/开始时间/时长，而不能改写证据原因和优先级。已有 Schedule 事件会被视为硬冲突，且可以反复调用只读的 `propose_plan` 比较不同方案。使用 `plan_proposal.save` 保存预览，或在项目本地当天用带相同排期参数的 `plan_proposal.ensure_today` 幂等保存；随后必须由学习者明确接受或拒绝。`study_coach.start_intervention` 会优先消费提案中实际排定的时长，并且只允许通过 `execution` 调整时间预算和协助等级，目标、证据维度与来源链保持不变。`plan_proposal.apply` 仍只是可选日历投影：先预检所有目标 Schedule，只写事件，提交失败时回滚。只有带精确来源的执行证据才会进入干预效果校准；依从性与成效信号仍受样本门槛与边界约束。

## 间隔重复

复习间隔基于艾宾浩斯而非 FSRS 或 SM-2：间隔表 `[1, 2, 4, 7, 15, 30, 60, 120]` 天，按 `review_level`（`0.5 … 2.5`）加权，失败时计数归零并安排到明天。复习状态存放在每张例题笔记的 frontmatter（`review_count`、`review_level`、`last_reviewed_at`、`next_review_at`）；`review.submit` 原子地记录尝试并推进间隔。

## Model Experience

### Request context and condition

#### What the model sees

两个工具 schema 及其 Python 插件描述，通过 `defineTool` 注册。当 skills 服务被组合时，十二个 StudyOS 技能也会出现在技能目录中。`study_coach.start` 或 `advance` 之后，插件通过 `agent.inject` 为下一次请求注入活跃会话上下文（`[StudyOS active learning session — turn-local context]` 加有界的会话载荷）。

##### `study_activity` description

```markdown
StudyOS state interface. Start a workflow with project.status, then prompt_context.load(intent) for its operation guide. Select an operation with resource and action; put its payload in data. Canonical save actions validate before writing. review.submit owns both evidence and spacing.
```

##### `study_coach` description

```markdown
StudyOS evidence projection and Session runtime. Load the workflow guide before use. start creates no evidence; advance requires an evaluated observation and returns continuation; finish may leave dimensions unverified. Analysis and proposal actions do not mutate Schedules.
```

#### Token effect

条件性：两个工具 schema 固定；工具结果、注入的活跃会话上下文与被加载的技能正文按调用产生，并受 StudyOS 提示策略约束（片段按优先级降级而非失败，会话上下文上限 2800 字符）。

#### KV Cache effect

独立：本包不贡献 system-prompt 段落，因此其存在不移动提示前缀；注入的上下文与工具结果追加调用方 agent 自有的每轮内容。

## Known Limitations and Deferred Work

- **没有 cron 运行限制** — `CRON_PROPOSAL_ONLY` 守护的是 dsh 中不存在的 Hermes `cron_` 会话 id；dsh 的定时运行通过与交互运行相同的显式工具调用决策提案。
- **概念图与复习统计缓存按调用重建** — Python 插件以一小时 TTL 在磁盘缓存投影；此处 handlers 每次调用重建（笔记规模小），且笔记变化时磁盘缓存文件仍会被失效。
- **`prompt_context` 片段随包内置** — 路由片段来自插件内联的技能正文而非磁盘 SKILL.md 文件，因此修改片段意味着修改包，而不是修改 Vault 文件。
