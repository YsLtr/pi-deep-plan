---
name: deep-plan
description: 自主规划闭环 — 自己提问、自己派子代理查证、自己拟定方案,只在最后把方案连同「可变决策表」呈现一次给用户审查,批准后执行。Use when the user asks for a plan/proposal/design for a non-trivial task, or says 出个方案、先规划、别问我你自己定、deep plan.
disable-model-invocation: true
---

# Deep Plan

对非平凡任务产出一份可执行方案,**全程不问用户任何问题**。用户只在最后介入一次:
审查方案 + 改可变决策 + 批准执行。

五阶段:`自问 → 自查 → 成文 → 单一审查 → 执行`。

本 skill 由 `pi-deep-plan` 扩展提供**harness 层强制**:规划/审查阶段的写入被实际拦截,
不是靠自觉。门禁细节见下方 P0。

---

## P0. 启动与写保护

用 `/deep-plan <目标>` 启动。扩展会立刻:

- 分配方案文档路径(`<cwd>/docs/plans/<YYYY-MM-DD>-<slug>.md`),并开启**硬写保护**
- 拦截所有编辑器工具对其它路径的写入(`edit`/`write`/`replace`/`insert`/`undo_last_change`)
- 把 `bash`/`powershell` 限制在只读命令白名单内
- 状态栏显示当前阶段

放行例外只有两个:方案文档本身,以及 `.pi/tmp/`(子代理报告用)。
被拦时不要尝试绕过,直接调 `deep_plan_approve` 走后门是错的——那是用户批准后才用的。

随后加载两项纪律(各读一次,分开读):

- `read` `~/.pi/agent/skills/grilling/SKILL.md` — 设计树与 frontier 机制
- `read` `~/.pi/agent/skills/domain-modeling/SKILL.md` — 术语与 ADR 纪律

---

## P1. 自问(不问用户)

用 grilling 的设计树,**但把交互方向反转**:

- 建树,算 frontier(前置已定的、现在就能答的问题)。按轮推进。
- **每个 frontier 问题自己回答**,给出你的推荐答案。不要抛出等回复。
- 答案需要事实支撑 → 记下来,交给 P2 查,不要在这里猜。
- 每条结论用 `deep_plan_record_decision` 记录,带证据与置信度。
- 偏好/取舍/范围类结论,**另用 `deep_plan_record_variable` 暴露**成可变决策。

铁律:**没有任何东西被默默假设。** 凡是"我假定用户想要 X"的地方,
要么是一条 D(决策记录),要么是一行 V(可变决策)。两者都不是 = 漏了。

---

## P2. 自查(派子代理,不问用户)

**找到事实是你的活,永远不是用户的活。** 一次 `subagent` 调用、`children` 数组
并行派发,并发 ≤ 3,简报自包含。

- 联网事实 → `researcher`;代码库现状 → `scout`;已有改动审查 → `code-reviewer`。
- 派发契约、报告大纲、停止判据见扩展包内 `references/research-contract.md`。
- **不要阻塞**:子代理是异步的。等报告期间继续推进不依赖它的 frontier 问题。
- 报告回来后**先验证再采信**:文件是否真存在、结论是否带路径:行号或 URL。
- 报告写入 `.pi/tmp/`(写保护唯一放行的目录)。子代理只证明现状,方案由你写。

---

## P3. 成文

把方案写进扩展分配的那个路径(唯一可写文件)。骨架、各节要求、
**可变决策表 schema** 见扩展包内 `references/plan-format.md`。

先把任务识别清楚,再做拆解:

- `deep_plan_task action=title` 确立**动作开头的单句标题** + 详细范围(整个方案只做一次)。
- `deep_plan_task action=add` 逐条追加任务,每条必须**可独立验收**。
- `deep_plan_task action=list` 复核清单与进度。

三条硬要求:

- 「决策记录」每条附证据(路径:行号 或 URL),不许形容词。
- 「可变决策表」3-8 行,每行是**已生效的默认值**——方案按默认值可直接执行。
- 「非目标」「开放问题」不许空着。查不到就写"未能查证 + 已尝试的路径"。

写完调 `deep_plan_review`。它会校验:文档非空、可变决策 3-8 条、决策记录非空、**任务拆解至少一条**。
不达标会退回并列出原因。

---

## P4. 单一审查(唯一一次打扰用户)

`deep_plan_review` 通过后进入 review 阶段(写保护仍生效)。**一次**呈现:

1. 方案文档路径——写成 markdown 链接(`deep_plan_review` / `deep_plan_approve` 结果里已经给好,原样复制即可)。**不要把正文贴进对话**,正文只存在于文档里,用户自己打开看。
2. **可变决策表全文**——这是用户逐项过目的部分。
3. 三个选项:**批准执行** / **修改可变决策** / **打回重做**。

呈现后**停住**,等用户回话。不要在同一轮里既呈现又开工。

用户改可变决策 → 用 `deep_plan_revise` 回到规划阶段,同步更新决策记录与方案正文,
再 `deep_plan_review` 重新提交。

---

## P5. 执行(批准后)

用户批准后调 `deep_plan_approve`:校验方案非空后解除写保护,进入执行阶段。

- `deep_plan_step action=start` 开始一个任务(同时只能有一个进行中)。
- 做完对照该任务的验收方式确认,再 `deep_plan_step action=done`。
- 卡住时用 `action=block note=...` 记录受阻原因,解除后 `action=unblock`;确实不做的用 `action=skip`。
- 方案文档留在 `docs/plans/`,作为执行依据;改动与它不一致时同步更新。
- 执行中冒出的新决策:小改直接做并记录;**改变已批准范围的**调 `deep_plan_revise`
  重新走审查,不要自作主张扩大范围。
- 全部任务完成后调 `deep_plan_finish` 收尾。它会定稿方案状态(`status: done`;用户叫停时用
  `status: "abandoned"`)并**自动归档**到 `docs/plans/archive/<年>/`,使 `docs/plans/` 顶层只留活跃方案。
  文件不会被删除;确实要留在原地时传 `keepInPlace: true`。
- **收尾顺序(硬要求)**:先 `deep_plan_finish`,**再**提交。归档本质是一次 `git mv`,必须发生在
  `git add` 之前 —— 提交后再 finish,会凭空多出一个只含 rename 的 git 差异,落到下一个无关提交里
  (本项目 4.16.0 就吃过这个亏)。判断标准:`git status --short` 提交后为空。
- **与 handoff 合并为一步**:需要更新 `AGENTS.md` 并提交时,按 `~/.pi/agent/skills/handoff/SKILL.md`
  走,但把 `deep_plan_finish` 放在 `git add` **之前** —— 最后一个任务 done → `deep_plan_finish`(定稿+归档)
  → 更新 `AGENTS.md` → 一次提交同时带走代码、归档 rename 与交接。

## 方案文档生命周期

扩展在阶段转换时自动维护方案文档的 frontmatter,你不需要手写:

```yaml
---
title: <任务标题>
status: draft | review | approved | done | abandoned
created: YYYY-MM-DD
session: <pi session id>
approved: YYYY-MM-DD
completed: YYYY-MM-DD
archived: YYYY-MM-DD
---
```

**顶层保持干净**:完成的方案自动移入 `docs/plans/archive/<年>/`。
如果顶层仍堆着旧的已完成方案(比如换过项目的目录),让用户跑 `/deep-plan-gc [天数] [apply]`:
默认阈值 30 天,**只归档 done/abandoned 且超期的**,不认识的状态一律保留。
无交互 UI 时是 dry-run;不加 `apply` 一定先问用户。

---

## 反模式(出现即停手重来)

- 向用户提问任何事实或偏好 → 违反本 skill 的核心。事实自己查,偏好自己定默认值。
- 把没验证的推断写进 `Verified Facts` 或当作既定事实 → 标 `[推断]` 或进开放问题。
- 方案里出现"待用户确认"的占位符 → 改成「可变决策表」里一行带默认值的 V。
- 被写保护拦截后改用 bash 重定向绕开 → 立刻停止,这是纪律违背。
- 呈现方案后又自己往下开工 → P4 必须停住等批准。
- 把方案正文再贴一遍进对话 → 正文只存在于文档里,审查时只给路径 + 可变决策表 + 任务清单。
- 可变决策表为空或超过 8 条 → `deep_plan_review` 会退回;自问深度不对,回到 P1。
