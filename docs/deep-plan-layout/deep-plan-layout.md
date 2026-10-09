---
title: deep-plan 文档布局：话题文件夹与条目分划
status: approved
topics: deep-plan 扩展的 docs/ 布局、条目粒度、话题路由
created: 2026-10-09
updated: 2026-10-09
---

# deep-plan 文档布局：话题文件夹与条目分划

> 这是长期维护的项目文档。不要写变更日志、日期版本或一次性计划表。

## 概览

deep-plan 现在规定 `docs/` 下**一个话题一个文件**(`docs/<slug>.md`),话题内部的条目
(决策、计划项)靠文件里的 `##` 子标题分划。当一份文档承载十几条决策和计划时,条目在文件内
只能靠编号和缩进区分,没有各自的路径,不能被单独引用、单独评审,也无法在文件系统层面排序。

本文档把条目分划从「文件内子条目」改为「子文件夹 + 一项一个文件」:输出的话题成为
`docs/<topic>/`,总纲是 `docs/<topic>/<topic>.md`,计划条目落在 `docs/<topic>/plan/NNNN-<slug>.md`。
`docs/INDEX.md` 是唯一的全局话题索引,也是本项目的开发文档入口。
现在做的原因是该扩展刚完成两阶段重构,`resolveDocPath` 已收敛为唯一路径真相源,趁布局只有一个
决策点时改,代价最低。

## 目标 / 非目标

- 目标: 话题文件夹布局落地 —— `resolveDocPath` 对「文件夹话题」产出 `docs/<topic>/<topic>.md`,
  并新增纯函数推导条目路径;`/deep-plan-docs` 与阶段注入文案反映新布局。
- 目标: `--doc` 能明确表达「要文件夹」(`--doc docs/foo/` 或指向已存在目录)。
- 目标: `deep_plan_review` 对话题文件夹内的条目文件做非空校验。
- 目标: 补 `resolveDocPath` 直接单测,并清掉测试里的旧布局硬编码。
- 目标: 提交归属改为按当次用户指令,不再写死给用户。
- 目标: **决策移出文档** —— 删除决策工具与 `decisions/` 位置,「为什么这么定」只记 git commit。
- 目标: **内化提问式规划** —— 设计树与 frontier 写进本 skill,不再依赖外部 skill。
- 目标: **`docs/` 定位为开发文档** —— 取代根目录 `development.md`,`INDEX.md` 兼作入口。
- 非目标: 不迁移、不搬动任何已有文档。存量 `docs/foo.md` 单文件话题继续原样工作(见 V1)。
- 非目标: 不改门禁的两个判定函数。`isDocPath` 是 `path.relative` 边界测试而非前缀匹配,任意深度的
  `docs/<topic>/**` 本就判定为文档,本次无需改动门禁代码。
- 非目标: 不放宽写作阶段的只读 shell 门禁。`mkdir` 继续被拒,建文件夹靠 `write`。
- 非目标: 不碰 `deep_plan_task` / `deep_plan_step` 的任务状态机。计划条目文件是给人读的
  正文,执行状态仍由任务系统承担,两者不互为真相。
- 非目标: 不保留「可变决策表」以外的用户审查机制 —— 提问式规划**不**向用户提问,
  用户只在收尾审查一次。

## 决策记录

**本话题不记决策。** 决策是**变值**:写进文档后一旦被推翻,文档就自己制造矛盾。
「为什么这么定、否决了什么」的唯一出处是 **git commit message** ——
`git log -- docs/deep-plan-layout/` 就是本话题的决策演进史。

## 术语与领域模型

**话题 (topic)**:
`docs/` 下可长期维护的一组文档,对应一个文件夹。由 goal 的 slug 或 `--doc` 指定。
_Avoid_: 计划 (plan)、任务 (task)、方案 (proposal)

**总纲 (overview document)**:
话题文件夹的主文件 `docs/<topic>/<topic>.md`,承载概览、目标与非目标、术语、风险与开放问题,
也是唯一带 frontmatter 的文件。
_Avoid_: 主文档 (main doc)、索引文件 (index file)

**条目 (entry)**:
话题内可被单独引用的一项,一个文件一个条目。当前两种:决策与计划条目。
_Avoid_: 小节 (section)、子条目 (sub-item)

**单文件话题 (single-file topic)**:
没有拆出任何条目的旧形态话题 `docs/<slug>.md`。仍然合法,不强制迁移。
_Avoid_: legacy 文档

**话题索引 (topic index)**:
`docs/INDEX.md`,全局唯一,一行一个话题并指向其入口。
_Avoid_: 目录 (catalog)、清单 (manifest)

## 可变决策

**这是用户唯一需要逐项过目的部分。**

| # | 决策项 | 默认值 | 依据 | 改动代价 |
|---|--------|--------|------|----------|
| V1 | 已有单文件文档(`docs/foo.md`)要不要强制迁到文件夹(`docs/foo/foo.md`)? | **只有已成话题时才建文件夹。** `--doc docs/foo/foo.md` 或 goal 命中已有话题文件夹 → 文件夹布局;否则 `docs/foo.md` 单文件照旧(向后兼容,不搬动已有文档) | 分划只在文档有多个条目时才需要,单文件单文档没有可分的条目;`src/state.ts:162-174` 现状只产出单文件,硬切会让存量 `docs/` 突然变成「非话题布局」 | 低 —— 只影响 `resolveDocPath` 里一次 mkdir 的时机(建文件夹 vs 不建)与文档里一节措辞 |
| V2 | 计划条目的子文件夹名与文件名形态? | **`plan/` 放计划条目,文件名为 `NNNN-<slug>.md`** | 数字前缀让文件系统排序即执行顺序(`src/state.ts` 的 `listDocs` 返回 `.sort()`);`plan/` 是唯一的条目位 —— 决策不进文档,所以没有 `decisions/` | 低 —— 改目录名只需改常量与文档措辞,路径由纯函数推导不散落 |
| V3 | `deep_plan_review` 要不要校验计划条目文件(空文件 / 编号连续)? | **每个计划条目文件非空即通过,不强制编号连续。** 若话题文件夹存在 `plan/`,该文件夹内每个 `.md` 必须有非空正文;空条目文件一律退回 | `src/index.ts` 现有 `bodyOf(body) === ""` 正是「拒绝空文档」的先例;而 `deep_plan_task` 已承担计划条目完整性(要求 tasks 非空),再在文件层查编号连续性会形成两份真相 | 中 —— 校验逻辑本身是新增(数文件、查条目非空),不做的话质量靠模型自觉;改回「只校验总纲」是删掉一个分支 |
| V4 | 文档提交由谁执行? | **由执行者(agent)提交,两段分开提。** 文档阶段收尾后 agent 先提 `docs/`;批准进入执行阶段后 agent 再提代码,各自成 commit;收尾呈现不再写「由用户执行」 | 用户本次明确指令「提交也由 agent 负责」;现状 `src/index.ts:583-586` 与 `plan-format.md` 收尾契约第 4 条把提交归属写死给用户 | 中 —— 影响两处文案(src/index.ts:583-586 与 plan-format.md 收尾契约),改成「用户提交」即删掉一个分支 |

## 计划

一个计划条目一个文件,按编号即执行顺序。执行状态由 `deep_plan_task` 管理,不写在这里。

| # | 条目 | 文件 |
|---|------|------|
| 1 | state.ts 新增 planDir/entryPath 纯函数 | [plan/0001-state-plandir-entrypath.md](./plan/0001-state-plandir-entrypath.md) |
| 2 | resolveDocPath 支持文件夹布局与 --doc 三条解析规则 | [plan/0002-resolvedocpath-folder-layout.md](./plan/0002-resolvedocpath-folder-layout.md) |
| 3 | deep_plan_review 校验条目文件非空 | [plan/0003-review-entry-non-empty.md](./plan/0003-review-entry-non-empty.md) |
| 4 | /deep-plan-docs 与两阶段注入文案反映话题布局 | [plan/0004-docs-command-and-phase-injection.md](./plan/0004-docs-command-and-phase-injection.md) |
| 5 | 清理 state.test.ts 旧布局硬编码并补 resolveDocPath 直测 | [plan/0005-clean-test-hardcoded-paths.md](./plan/0005-clean-test-hardcoded-paths.md) |
| 6 | 同步文档:plan-format.md / SKILL.md / README.md 对齐新布局 | [plan/0006-sync-docs-plan-format-skill-readme.md](./plan/0006-sync-docs-plan-format-skill-readme.md) |
| 7 | 提交归属改为按当次指令 | [plan/0007-commit-ownership-per-run.md](./plan/0007-commit-ownership-per-run.md) |
| 8 | 写作阶段注入文案点明用 write 建文件夹 | [plan/0008-writing-phase-folder-guidance.md](./plan/0008-writing-phase-folder-guidance.md) |
| 9 | 决策移出文档:删除决策工具与 decisions/ 位置,决策只记 git commit | [plan/0009-decisions-out-of-documents.md](./plan/0009-decisions-out-of-documents.md) |
| 10 | 内化提问式规划,撤销对外部 skill 的依赖 | [plan/0010-internalize-questioning.md](./plan/0010-internalize-questioning.md) |
| 11 | docs/ 定位为开发文档,INDEX.md 兼作入口 | [plan/0011-docs-are-development-docs.md](./plan/0011-docs-are-development-docs.md) |

## 风险与回滚

| 风险 | 触发信号 | 应对 | 回滚方式 |
|------|----------|------|----------|
| `--doc docs/foo` 语义变化让既有用法落到别处 | 用户报「文档建到了我没说的地方」 | D5 规则只对「结尾斜杠 / 已存在目录」改判,裸无扩展名一律仍为单文件 | 回退 `resolveDocPath` 一处判定 |
| 条目文件数多导致 review 变慢 | review 明显卡顿 | 只遍历话题文件夹内一层 `plan/`,不递归更深 | 收窄到只查总纲 |
| 模型被要求写多个文件却只写了总纲 | review 里条目位为空但总纲自洽 | V3 非空校验只要文件夹存在就逐个查;额外在注入文案里点明条目要各自成文件 | 放宽为非强制 |
| 索引与文件夹实际内容漂移 | `/deep-plan-docs` 输出与 `ls docs/` 对不上 | 索引由模型维护,`/deep-plan-docs` 如实展示两者供对照 | 无(展示层,不改状态) |
| 补测改动被误当布局改动回滚 | 回滚后单测变少 | 计划把补测列为独立条目(计划 5),与布局条目分开 | 无 |
| 提交归属改成 agent 后两段提交被混成一段 | `git log` 里文档与代码在同一个 commit | 文案里保留「两段分离」这条不变约束;提交前先 `git status` 确认改动落在该落的那边 | 恢复「由用户执行」的措辞,不再让 agent 提 |
| 模型改用 `bash mkdir` 建文件夹被门禁拦下而卡住 | 门禁报「被禁止的命令: mkdir」 | 注入文案点明用 `write` 写第一个文件即可(计划 8);门禁文案本身也提示不要绕过 | 无(行为不变) |

## 开放问题

- **已解决**(原「未能查证」):格式规范曾引用外部 `domain-modeling` skill 的
  `CONTEXT-FORMAT.md` / `ADR-FORMAT.md`。现已**内化**:术语格式与写法直接写进
  `skills/deep-plan/references/plan-format.md`,不再依赖任何外部 skill(见「计划的第 9 条」)。
- **已解决**(原「未能查证」):`docs/adr/` 与话题内决策并存是否造成两处决策。
  不再适用 —— 决策**不进文档**,它的唯一出处是 git commit message,所以既没有
  `docs/adr/` 也没有 `docs/<topic>/decisions/`,两处漂移的问题从源头消失。
  依据:决策是变值,写进长期维护的文档会持续制造自相矛盾(见「计划的第 9 条」)。
