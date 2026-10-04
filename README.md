# pi-deep-plan

An autonomous planning loop for the [Pi coding agent](https://pi.dev): the model interviews
itself, dispatches its own research subagents, writes one plan document, and asks you exactly
once — at the end, to review it.

**Write protection is enforced by the harness, not by good intentions.** While planning, every
file-mutating tool call is blocked and `bash` is restricted to a read-only command allowlist.
The gate is only lifted by `deep_plan_approve`, after you approve.

五阶段闭环:`自问 → 自查 → 成文 → 单一审查 → 执行`。全程不向你提问;你的介入点只有最后的方案审查。

## Install

```bash
pi install git:github.com/YsLtr/pi-deep-plan
```

or try it for one run without touching settings:

```bash
pi -e git:github.com/YsLtr/pi-deep-plan
```

Requires Pi ≥ 0.85.0. Single runtime dependency: `shell-quote`.

## Use

```
/deep-plan <目标>
```

The extension immediately allocates a plan document at
`<cwd>/docs/plans/<YYYY-MM-DD>-<slug>.md`, arms the write gate, and shows the phase in the
status bar. Then:

| Phase | What happens |
| --- | --- |
| P1 自问 | Builds a design tree (from the `grilling` skill), answers every frontier question itself, and records each conclusion as a decision with evidence + confidence. |
| P2 自查 | Dispatches `researcher` (web) / `scout` (codebase) subagents in parallel, ≤3 concurrent; reports land in `.pi/tmp/`. |
| P3 成文 | Writes the plan (the only writable file), plus a task breakdown where each task is independently verifiable. |
| P4 审查 | Presents once: plan path + the **variable-decisions table** + task list, and three choices — approve / change variables / redo. Then it stops. |
| P5 执行 | `deep_plan_approve` lifts the gate; tasks are walked one at a time; `deep_plan_finish` finalizes and archives the plan. |

Preferences the model cannot know are never silently assumed: each becomes a row in the
variable-decisions table (3–8 rows, each with a default already in effect), which is the part
you review.

## Commands and tools

| Kind | Name |
| --- | --- |
| Command | `/deep-plan <goal>`, `/deep-plan-status`, `/deep-plan-gc [days] [apply]` |
| Tool | `deep_plan_start`, `deep_plan_record_decision`, `deep_plan_record_variable`, `deep_plan_review`, `deep_plan_approve`, `deep_plan_revise`, `deep_plan_finish` |
| Tool | `deep_plan_task` (title / add / list / update / remove), `deep_plan_step` (start / done / skip / block / unblock) |
| Prompt | `/deep-plan-go <goal>` |

Plan documents carry frontmatter (`title`, `status`, `created`, `session`, `approved`,
`completed`, `archived`) that the extension maintains across phase transitions. Finished plans
are archived to `docs/plans/archive/<year>/`; `/deep-plan-gc` sweeps old `done`/`abandoned`
plans (dry-run unless `apply` is passed).

## The write gate

`src/readonly.ts` gates `bash`/`powershell` during P1–P4. It tokenizes with `shell-quote`
(quote- and operator-aware) and checks every simple command in the pipeline against an
allowlist, following the approach of codex-cli's `is_known_safe_command`. It fails closed:
anything unparsed, unknown, or not provably read-only is refused.

Allowed — file inspection, text processing, search, `git`/`npm`/`cargo`/`go` read-only
subcommands, `cd`, `$(...)` bodies checked recursively, rtk-native readers (`rtk read`,
`rtk recall`, `rtk ls`, …), and harmless redirections (`2>&1`, `2>/dev/null`).

Refused — writers and process spawners (`rm`, `mv`, `cp`, `tee`, `sed -i`, `find -exec`,
`sudo`, `bash -c`, `npm install`, `cargo build`), every real file redirection, background `&`,
and sub-shell parentheses.

It also covers the case where the [rtk](https://github.com/rtk-ai/rtk) extension has already rewritten
`cat x` into `rtk read x` before the gate sees the command — the gate validates rtk's *wrapped*
argv, so `rtk test cargo test` is still refused.

The only write exceptions are the plan document itself and `.pi/tmp/` (subagent reports).

## Layout

```
src/index.ts        extension entry: gate, phase state machine, commands, tools, status widget
src/readonly.ts     read-only command gate (the allowlist)
src/readonly.test.ts   gate regression tests
src/state.ts        plan-document frontmatter + phase state
src/archive.ts      plan archiving / gc
src/tasks.ts        task list bookkeeping
skills/deep-plan/   the deep-plan skill + plan-format / research-contract references
prompts/            /deep-plan-go prompt template
```

## Development

```bash
npm test                    # node --experimental-strip-types --test src/*.test.ts
npm run typecheck           # tsc --noEmit
```

To hack on it, clone the repo anywhere and point Pi at it:

```bash
pi install ./pi-deep-plan
```

## License

MIT
