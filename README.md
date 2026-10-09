# pi-deep-plan

Two-stage autonomous loop for the [Pi coding agent](https://pi.dev). The model interviews
itself, dispatches its own research subagents, and **writes documents first, code second** —
asking you only twice: is the documentation right, and may it start changing code.

**Scope is enforced by the harness, not by good intentions.** Each stage can only reach its
own side of the repository:

| Stage | Writable | Commit |
| --- | --- | --- |
| 1. Documentation | `docs/` (plus `.pi/tmp/` scratch) | **docs only** |
| 2. Execution | the repository, with `docs/` frozen | **code only** |

Freezing `docs/` during stage two is what keeps the two commits from ever overlapping. The
extension never runs git itself: it states the boundary and the owner of the commit is whatever
the current run's instruction says — the agent by default, or you if you ask for it.

Documents are long-lived project docs, not per-run artifacts: no date in the filename, no
archive, no changelog. **Git holds the history, and `git diff` is the plan for this run.**

`自问 → 自查 → 成文 → 提交文档 → 批准 → 执行`。全程不向你提问事实;你的介入点只有这两次。

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
/deep-plan <目标> [--doc docs/<路径>.md]
```

The extension picks the target document (from `--doc`, else the goal's slug), scopes writes to
`docs/`, and shows the stage in the status bar. Then:

| Stage | What happens |
| --- | --- |
| 自问 | Builds a design tree and works its frontier in rounds — **writing each question out and then answering it**, so the questioning always happens and never blocks on the user. Conclusions become results in the document. |
| 自查 | Dispatches `researcher` (web) / `scout` (codebase) subagents in parallel, ≤3 concurrent; reports land in `.pi/tmp/`. |
| 成文 | Refines the target document in place — a project document, not a change log — and breaks the work into independently verifiable `deep_plan_task` items. |
| 收尾 | Presents once: document path + the **variable-decisions table** + task list. Then it stops. |
| 提交文档 | `docs/` only, as its own commit. The agent commits by default; the extension itself never runs git. |
| 执行 | `deep_plan_approve` freezes `docs/` and opens the repository; tasks are walked one at a time; `deep_plan_finish` finalizes the document. Repo code goes in a separate commit. |

**A document conflict stops the run.** If execution finds the document contradicts the code,
itself, or a fact it needs, the model must not work around it: `deep_plan_revise conflict=true`
halts the run, blocks the in-flight task, re-freezes the repository, and re-opens `docs/`. The
reason is recorded and shown on the next run, and the halted task stays `blocked` until it is
genuinely finished — so a doc fix can never read as completed work.

Preferences the model cannot know are never silently assumed: each becomes a row in the
variable-decisions table (3–8 rows, each with a default already in effect), which is the part
you review.

## Commands and tools

| Kind | Name |
| --- | --- |
| Command | `/deep-plan <goal> [--doc <path>]`, `/deep-plan-status`, `/deep-plan-docs` |
| Tool | `deep_plan_start`, `deep_plan_record_variable`, `deep_plan_review`, `deep_plan_approve`, `deep_plan_revise`, `deep_plan_finish` |
| Tool | `deep_plan_task` (title / add / list / update / remove), `deep_plan_step` (start / done / skip / block / unblock) |

## Layout: a topic is a folder, an entry is a file

```
docs/
  INDEX.md                      topic index / development entry point
  <topic>/
    <topic>.md                  overview: scope, terms, risks, open questions
    plan/NNNN-<slug>.md         one plan entry per file
```

`docs/` **is** the project's development documentation — it takes the place of a root
`development.md`. How to build, how to test, the conventions, and each topic's design conclusions
all live here, entered through `docs/INDEX.md`.

A topic is a long-lived document set, not a run. Inside it, each plan item is its own file, so it
can be linked, reviewed and ordered on its own instead of being a `##` heading buried in one long
document. Terminology stays in the overview, because it is a list of terms with paired `_Avoid_` —
splitting those into files would break the pairing.

The folder is built by writing the first file into it (`write` creates parents); `bash mkdir` is
denied by the read-only gate in stage one. A topic folder is only created when asked for — via
`--doc docs/topic/`, or a directory that already exists — so an existing flat `docs/foo.md`
single-file topic keeps working and is never silently reinterpreted.

### Decisions are not in the documents

A decision is a **variable, not a constant**: one written into a document today is likely to be
revisited after another round of questioning. A document is maintained for the long term, so
freezing revisited reasoning into it means steadily manufacturing contradictions. A commit is a
point-in-time snapshot, so it records *why it was decided then* without pretending the answer is
final.

So documents carry **results** — terms, goals, non-goals, risks, plan items — and the reasoning
lives in the **git commit message**. There is no `docs/<topic>/decisions/` and no `docs/adr/`; the
extension has no decision-recording tool, and `git log` is the decision history.

Documents carry frontmatter (`title`, `status`, `topics`, `created`, `updated`, `approved`)
that the extension maintains across stage transitions. `status` is `writing` while documents
are being refined and `approved` once execution may start. Documents stay in `docs/` in place:
nothing is archived, renamed, or dated — git holds the history. `docs/INDEX.md` is the topic
index; `/deep-plan-docs` lists the tree grouped by layout and whether the index exists.

Entry files are plain prose — frontmatter belongs to the overview alone. `deep_plan_review`
refuses to close stage one while any plan entry file is empty; it does not police sequence
numbering, because the task list, not the file names, owns completeness.

## The write gate

Two independent gates enforce the stage boundary.

**File mutations.** `src/state.ts` holds `PATH_FIELDS` (an explicit `path`/`file`/`file_path`)
and `ANCHOR_FIELDS` (the anchor arguments of each anchored editor), and `extractWriteTarget`
turns a call into a target path. Every entry in `FILE_MUTATION_TOOLS` — `edit`, `write`,
`replace`, `replace_match`, `insert`, `copy`, `move`, `undo_last_change` — is checked against
`isWriteAllowed`, which admits the document side under `docs/` during stage one and the
repository side during stage two. A call with no recognisable target is blocked.

The anchored editors (`replace`/`replace_match`/`insert`/`copy`/`move`) do not take a usable
`path` — theirs is optional and rejected unless require-path mode is on — so the gate resolves
their target from the anchor instead. Because Pi gives every package its own module root, the
gate cannot read the editor's anchor registry; it rebuilds the `anchor -> file` map from the
rows those tools serve (`aBcD│content`, `+aBcD│`, `-aBcD│`) as `read` results arrive
(`collectAnchors`). Every supplied anchor must resolve, and all must agree on one file: a
partial or stale set is refused, because the call's real target would otherwise be unproven.

**Shell.** `src/readonly.ts` gates `bash`/`powershell`. It tokenizes with `shell-quote`
(quote- and operator-aware) and checks every simple command in the pipeline against an
allowlist, following the approach of codex-cli's `is_known_safe_command`. It fails closed:
anything unparsed, unknown, or not provably read-only is refused.

Allowed — file inspection, text processing, search, `git`/`npm`/`cargo`/`go` read-only
subcommands, `cd`, `$(...)` bodies checked recursively, `FOO=bar` env prefixes, and harmless
redirections (`2>&1`, `2>/dev/null`, `>&-`).

Refused — writers and process spawners (`rm`, `mv`, `cp`, `tee`, `sed -i`, `find -exec`,
`sudo`, `bash -c`, `npm install`, `cargo build`), every real file redirection, background `&`,
and sub-shell parentheses.
Both gates are lifted out of the way by `deep_plan_approve` and re-armed by `deep_plan_revise`.

## Layout

```
src/index.ts        extension entry: scopes, stage machine, commands, tools, status widget
src/readonly.ts     read-only command gate (the allowlist)
src/readonly.test.ts   gate regression tests
src/state.ts        document paths, stage state, write scopes, anchor resolution
src/archive.ts      document frontmatter parsing / stamping
src/tasks.ts        task list bookkeeping
skills/deep-plan/   the deep-plan skill + doc-format / research-contract references
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
