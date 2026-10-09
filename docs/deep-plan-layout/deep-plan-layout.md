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
`docs/<topic>/`,总纲是 `docs/<topic>/<topic>.md`,决策落在 `docs/<topic>/decisions/NNNN-<slug>.md`,
计划条目落在 `docs/<topic>/plan/NNNN-<slug>.md`。`docs/INDEX.md` 仍是唯一的全局话题索引。
现在做的原因是该扩展刚完成两阶段重构,`resolveDocPath` 已收敛为唯一路径真相源,趁布局只有一个
决策点时改,代价最低。

## 目标 / 非目标

- 目标: 话题文件夹布局落地 —— `resolveDocPath` 对「文件夹话题」产出 `docs/<topic>/<topic>.md`,
  并新增纯函数推导条目路径;`/deep-plan-docs` 与阶段注入文案反映新布局。
- 目标: `--doc` 能明确表达「要文件夹」(`--doc docs/foo/` 或指向已存在目录)。
- 目标: `deep_plan_review` 对话题文件夹内的条目文件做非空校验。
- 目标: 补 `resolveDocPath` 直接单测,并清掉测试里的旧布局硬编码。
- 目标: 提交归属改为按当次用户指令,不再写死给用户。
- 非目标: 不迁移、不搬动任何已有文档。存量 `docs/foo.md` 单文件话题继续原样工作(见 V1)。
- 非目标: 不改门禁的两个判定函数。`isDocPath` 是 `path.relative` 边界测试而非前缀匹配,任意深度的
  `docs/<topic>/**` 本就判定为文档,本次无需改动门禁代码。
- 非目标: 不放宽写作阶段的只读 shell 门禁。`mkdir` 继续被拒,建文件夹靠 `write`(见 D9)。
- 非目标: 不碰 `deep_plan_task` / `deep_plan_step` 的任务状态机。计划条目文件是给人读的
  正文,执行状态仍由任务系统承担,两者不互为真相。
- 非目标: 不引入 `CONTEXT-MAP.md` 或多 context 结构。

## 决策记录

### D1. 布局单位为「话题文件夹」,不是「每次运行一个文件夹」

- **结论**: `docs/<topic>/` 是一个话题(可长期维护的文档集);文件夹内一个文件一个条目。
  `docs/INDEX.md` 仍是全局话题目录。
- **依据**: `skills/deep-plan/references/plan-format.md:1-8` 规定文档是长期项目文档;
  `src/state.ts:220-221` 注释 "documents are long-lived project docs, not per-run artifacts.
  There is no date in the name and no archive — git holds the history.";
  `src/state.ts:162-174` 的 `resolveDocPath` 按 goal 的 slug 命名,同一话题重规划落在同一出处 —— 语义是话题。
- **置信度**: 高
- **备选**: 「每次运行一个文件夹(`docs/<date>-<slug>/`)」被否决 —— 与「不写按日期排布的变化记录」
  硬规矩直接冲突,且会让 `docs/` 变成历史垃圾场。「保持单文件、只允许子文件夹」被否决 ——
  那等于没改,用户要的正是条目分划方式的改变。

### D2. 术语留在总纲文件,决策与计划条目各自成文件

- **结论**: 话题文件夹内固定三个能力位 —— 总纲一个文件(概览 / 目标与非目标 / 术语 / 风险 / 开放问题)、
  决策每个一个文件、计划条目每个一个文件。
- **依据**: `domain-modeling/CONTEXT-FORMAT.md:5-19` 的术语是「一个命名 section 下的 term 列表」,
  天然是文件内结构,拆开会让「成对 `_Avoid_`」失去可读性;`domain-modeling/ADR-FORMAT.md:1-3`
  已规定 "ADRs live in `docs/adr/` and use sequential numbering: `0001-slug.md`" —— 决策本就是文件夹 + 一文件一决策。
- **置信度**: 高
- **备选**: 「术语也各一个文件」被否决(违背 CONTEXT-FORMAT 的列表语义);
  「决策留在总纲的决策记录小节、只把计划条目拆文件」被否决(没解决诉求,该诉求主要针对可数的决策与计划条目)。

### D3. 总纲文件保持 planPath 语义,条目路径由纯函数推导

- **结论**: 保留 `planPath` 指向话题文件夹内的总纲(`docs/<topic>/<topic>.md`),不新增 state 字段;
  新增 `planDir()` 与 `entryPath()` 两个纯函数做路径推导。
- **依据**: `src/state.ts:162-174` `resolveDocPath` 是唯一路径真相源,只需改其产出;
  `src/state.ts:182-207` `listDocs` 已是递归 walk(带 `isDirectory` 分支),文件夹布局天然被支持。
- **置信度**: 高
- **备选**: 「新增一整套文件夹工具」被否决(工具面翻倍);「不改 state、让模型自己建文件夹」被否决
  (stampDoc / 门禁 / `--doc` 全按文件工作,总纲拿不到 frontmatter)。

### D4. frontmatter 只属于总纲,条目文件保持纯正文

- **结论**: 只有总纲带 frontmatter;`decisions/*` 与 `plan/*` 是纯正文,不 stamp。
- **依据**: `src/archive.ts:9-10` 注释 "The extension owns only the small metadata header of a document";
  `src/archive.ts:107-110` `stampDoc` 对缺失文件返回 `undefined` 而不创建 —— 若条目也要 stamp,
  就得额外保证它们存在,不如不 stamp;`ADR-FORMAT.md:11` "An ADR can be a single paragraph."
- **置信度**: 高
- **备选**: 「条目文件也带 frontmatter」被否决(与 domain-modeling 产物打架,且 finish 要遍历全部条目);
  「frontmatter 移到 INDEX.md」被否决(与「索引是话题清单」的定位冲突)。

### D5. `--doc` 需要用「结尾斜杠 / 已存在目录」区分文件夹与单文件

- **结论**: `--doc` 解析规则 —— 以 `/` 结尾、或指向已存在的目录 → 文件夹布局,总纲取 `<dir>/<dirname>.md`;
  带 `.md` → 就是该文件;其余无扩展名 → 沿用现有 `+ ".md"`。
- **依据**: 实测 `src/state.ts:168-171` 现有逻辑:`path.extname("docs/foo") === ""` 与
  `path.extname("docs/foo/") === ""` **都成立**,两者都被改写成 `docs/foo.md`,无法区分意图。
- **置信度**: 高
- **备选**: 「有扩展名当文件、无扩展名当文件夹」被否决(会静默改变 `--doc docs/foo` 现有用法含义);
  「不处理、文档里写明别这么传」被否决(能测出来的歧义不该留给用户记)。

### D6. `docs/INDEX.md` 仍是单一全局话题索引,不切分为每话题索引

- **结论**: 索引保持单一文件,每行从「文档」升级为「话题 + 入口链接」:`| 话题 | 入口 | 覆盖范围 |`。
  `indexFile()` 实现与调用点不变。
- **依据**: `INDEX_BASENAME` 仅经 `indexFile()`(`src/state.ts:152-154`)被 `/deep-plan-docs`
  (`src/index.ts:382`)与阶段注入文案(`src/index.ts:246`)消费 —— 单点消费,提级只改措辞与渲染;
  `README.md:76` 已把它描述为话题清单。
- **置信度**: 高
- **备选**: 「每话题一个 INDEX.md」被否决(让 `/deep-plan-docs` 退化为逐话题列索引,失去全局视图);
  「去掉索引、靠 listDocs 现算」被否决(丢掉「哪个话题讲什么」的人类可读描述)。

### D7. 补 `resolveDocPath` 直测,并清理测试里的旧布局硬编码

- **结论**: 除布局改动外,补 `resolveDocPath` 直接单测(文件夹 / 单文件 / 带 `.md` / 已存在目录 /
  越界拒绝五种输入),并把 `state.test.ts` 里 5 处 `docs/plans/**` 硬编码替换为当前布局。
- **依据**: 侦察确认 `resolveDocPath`/`isDocPath`/`listDocs`/`countDocs` 在 `src/state.test.ts` 中
  **没有任何直接用例**(`src/state.test.ts:6` 的 import 不含这些符号),`isDocPath` 仅经
  `isWriteAllowed` 间接覆盖;同时 `src/state.test.ts:13,14,19,30,47` 硬编码了代码里已不存在的
  `docs/plans/...`。
- **置信度**: 高
- **备选**: 「把 5 处旧路径批量改名了事」被否决 —— 断言会通过,但被改的正是路径推导,
  没有直测等于改完不可验证。

### D8. 提交归属是每次运行的偏好,不写死在文档与收尾契约里

- **结论**: 文档只固定一条不变约束 —— **文档阶段的提交与执行阶段的提交必须分开**;
  提交由谁执行按当次用户指令。本次用户明确指令「提交也由 agent 负责」,故执行阶段实现时,
  `deep_plan_review` 的收尾呈现不再要求用户跑 git,`before_agent_start` 两阶段注入文案同步改为
  「提交由你执行,先提文档再进执行阶段」。
- **依据**: `src/index.ts:583-586` 现状收尾呈现硬编码「先只提交文档(示例 `git add docs/ && git commit`)
  —— 这一步由用户执行」;`skills/deep-plan/references/plan-format.md` 收尾契约第 4 条同样写死
  「由用户执行」「不要替用户跑 git」。用户本次指令与之直接冲突。
- **置信度**: 中
- **备选**: 「让 agent 提交但保留旧呈现文案」被否决 —— 文案与行为不一致,下次运行会读到互相矛盾的
  指令,正是文档冲突的成因;「把这条委托留到以后实现」被否决 —— 明知不一致还留着,等于留 TBD。

### D9. 建话题文件夹用 write 隐式建父目录,不放开 mkdir

- **结论**: 文件夹靠写入文件隐式创建 —— 模型建话题文件夹的动作就是往
  `docs/<topic>/<topic>.md` 里写第一个文件,`write` 自动建父目录。`bash mkdir` 继续被拒,
  写作阶段的只读 shell 契约不动。写作阶段的注入文案要写明这条。
- **依据**: `src/readonly.ts:40` 的 `DENIED_BINARIES` 显式含 `"mkdir"`,写作阶段 bash 门禁
  直接拒绝该命令(实测 `mkdir -p docs/x && git mv ...` 被拦)。而写文件走的是
  `src/state.ts:243-251` 的 `isWriteAllowed`(只看目标是否在 `docs/` 下),不经 shell 门禁;
  实测 `write` 已在本仓库不存在的 `docs/deep-plan-layout/` 下成功落盘。
- **置信度**: 高
- **备选**: 「把 `mkdir` 加进只读放行名单」被否决 —— 它写文件系统,放行会破坏「写作阶段
  bash 严格只读」这条契约,而那正是门禁存在的理由;「让模型用重定向等方式绕过」被否决 ——
  门禁明确禁止绕过,且这正是它要拦的行为。

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
| V2 | 计划条目与决策的子文件夹名与文件名形态? | **`plan/` 放计划条目,文件名为 `NNNN-<slug>.md`**;决策用 domain-modeling 既有约定 `decisions/NNNN-<slug>.md` | `ADR-FORMAT.md:1-3` 固定了 `docs/adr/` + `NNNN-slug.md`,为不与既有约定打架,决策位沿用同构命名;数字前缀让文件系统排序即执行顺序(`src/state.ts:202` `listDocs` 返回 `.sort()`) | 低 —— 改 dot-dir 名(如 `entries/`)只需改常量与文档措辞,路径由纯函数推导不散落 |
| V3 | `deep_plan_review` 要不要校验条目文件(空文件 / 编号连续)? | **每个条目文件非空即通过,不强制编号连续。** 除总纲外,若话题文件夹存在 `decisions/` 或 `plan/`,该文件夹内每个 `.md` 必须有非空正文;空条目文件一律退回 | `src/index.ts:546` 现有 `bodyOf(body) === ""` 正是「拒绝空文档」的先例;而 `deep_plan_task` 已承担计划条目完整性(`src/index.ts:556-558` 要求 tasks 非空),再在文件层查编号连续性会形成两份真相 | 中 —— 校验逻辑本身是新增(数文件、查条目非空),不做的话质量靠模型自觉;改回「只校验总纲」是删掉一个分支 |
| V4 | 文档提交由谁执行? | **由执行者(agent)提交,两段分开提。** 文档阶段收尾后 agent 先提 `docs/`;批准进入执行阶段后 agent 再提代码,各自成 commit;收尾呈现不再写「由用户执行」 | 用户本次明确指令「提交也由 agent 负责」;现状 `src/index.ts:583-586` 与 `plan-format.md` 收尾契约第 4 条把提交归属写死给用户 | 中 —— 影响两处文案(src/index.ts:583-586 与 plan-format.md 收尾契约),改成「用户提交」即删掉一个分支 |

## 计划

1. `src/state.ts` 新增 `planDir()` 与 `entryPath(kind, slug, seq)` 纯函数 — 验收:
   单测断言 `entryPath("decisions","x",3)` 产出 `docs/<topic>/decisions/0003-x.md`。
2. `resolveDocPath` 支持文件夹布局与 D5 的三条 `--doc` 解析规则 — 验收:
   D7 的五种输入单测全绿,且 `--doc docs/foo/` 与 `--doc docs/foo` 产出不同结果。
3. `deep_plan_review` 对话题文件夹内条目文件做非空校验(V3)— 验收:
   放一个空的 `plan/0001-x.md` 会让 review 退回并指名该文件;删掉后通过。
4. `/deep-plan-docs` 与两阶段注入文案反映话题布局(D6)— 验收:
   命令输出里话题以入口文件形式呈现;注入文案不再说「在 docs/ 下新建」而说「在话题文件夹内新建条目」。
5. 清理 `state.test.ts` 旧布局硬编码,补 `resolveDocPath` 直测(D7)— 验收:
   全仓 `rg "docs/plans"` 无命中;`npm test` 与 `npm run typecheck` 全绿。
6. 同步文档:`plan-format.md` 骨架加入话题文件夹布局与条目文件约定;`SKILL.md` 的分划与
   通配行对齐新布局;`README.md` 布局段更新 — 验收:
   三份文档里对布局的描述与代码实际产出一致。
7. 提交归属改为按当次指令(D8/V4)— 改 `src/index.ts:583-586` 收尾呈现与
   `before_agent_start` 两阶段注入文案,去掉「这一步由用户执行」的写死说法,改为「提交由你执行,
   先提文档再进执行阶段」;`plan-format.md` 收尾契约第 4 条同步。验收:
   收尾呈现里不再出现「由用户执行」;两段提交分离的约束仍在(文档 commit 与代码 commit 不混)。
8. 写作阶段注入文案点明「建文件夹用 write 写第一个文件,不要用 mkdir」(D9)— 验收:
   文案里出现该指引;`bash mkdir` 仍被写作阶段门禁拒绝(不变)。

## 风险与回滚

| 风险 | 触发信号 | 应对 | 回滚方式 |
|------|----------|------|----------|
| `--doc docs/foo` 语义变化让既有用法落到别处 | 用户报「文档建到了我没说的地方」 | D5 规则只对「结尾斜杠 / 已存在目录」改判,裸无扩展名一律仍为单文件 | 回退 `resolveDocPath` 一处判定 |
| 条目文件数多导致 review 变慢 | review 明显卡顿 | 只遍历话题文件夹内一层 `decisions/` `plan/`,不递归更深 | 收窄到只查总纲 |
| 模型被要求写多个文件却只写了总纲 | review 里条目位为空但总纲自洽 | V3 非空校验只要文件夹存在就逐个查;额外在注入文案里点明条目要各自成文件 | 放宽为非强制 |
| 索引与文件夹实际内容漂移 | `/deep-plan-docs` 输出与 `ls docs/` 对不上 | 索引由模型维护,`/deep-plan-docs` 如实展示两者供对照 | 无(展示层,不改状态) |
| 补测改动被误当布局改动回滚 | 回滚后单测变少 | 计划把补测列为独立条目(计划 5),与布局条目分开 | 无 |
| 提交归属改成 agent 后两段提交被混成一段 | `git log` 里文档与代码在同一个 commit | 文案里保留「两段分离」这条不变约束;提交前先 `git status` 确认改动落在该落的那边 | 恢复「由用户执行」的措辞,不再让 agent 提 |
| 模型改用 `bash mkdir` 建文件夹被门禁拦下而卡住 | 门禁报「被禁止的命令: mkdir」 | 注入文案点明用 `write` 写第一个文件即可(计划 8);门禁文案本身也提示不要绕过 | 无(行为不变) |

## 开放问题

- **未能查证**:`skills/deep-plan/SKILL.md:65,71` 与 `plan-format.md:42` 引用了
  `domain-modeling/CONTEXT-FORMAT.md` 与 `ADR-FORMAT.md`,但本仓库内不存在这两个文件。
  已尝试:对仓库全量 `rg`(见侦察报告第 5 节,`skills/` 下只有 SKILL.md 与两份 references)。
  判定:这两份格式属 domain-modeling skill 的职责范围,路径在 `~/.pi/agent/skills/domain-modeling/`
  (已确认该目录下两份文件存在),**不在本仓库内**,因此本方案的「计划」条目不修改它们,
  只让本仓库文档与之对齐。
- **未能查证**:`docs/adr/` 与 `docs/<topic>/decisions/` 并存是否会造成两处决策。已尝试:
  遍历 `plan-format.md:42` 与 `SKILL.md:71` 的措辞。判定:ADR 是「需要独立成篇的硬决策」的
  全局位,`decisions/` 是「某话题内的决策」的话题位;两者用 `INDEX.md` 一行关联。
  是否需要进一步约束(例如话题内决策禁止外溢到 `docs/adr/`)留待执行阶段按实际情况决定。
