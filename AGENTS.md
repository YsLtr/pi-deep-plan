# pi-deep-plan

Pi 扩展:两阶段的自主规划闭环 —— 第一阶段只写 `docs/`,第二阶段只写代码,两阶段之间由门禁强制。
设计规格见 [`docs/INDEX.md`](docs/INDEX.md)。

## 交接

> 本节在下一次交接时整体替换。

### 上次完成的工作

1. 把写作语体标准写成规范条款,并同步到四份表达:`docs/INDEX.md` §3.1(权威)、
   `docs/02-文档规范/04-写作语体.md`(契约)、`skills/deep-plan/SKILL.md`、
   `skills/deep-plan/references/plan-format.md`。
2. 修 `docs/` 的语体违规 78 处、失效的行号引用 8 处。
3. 用独立子代理 `code-reviewer` 逐条核验文档断言与代码行为,发现 11 处不符,全部修正。
4. 修掉其中 3 个产品缺陷 —— 门禁的静默放行路径:

   | 缺陷 | 修复 |
   | --- | --- |
   | 裸 `pi` 穿过门禁(`args.every` 对空数组恒为真,而裸 `pi` 正是启动交互式可写 agent 的形态) | 加 `args.length > 0` 前置条件 |
   | 裸 `node` / `python` / `python3` / `py` 是开放 REPL | 加 `args.length === 0` 拒绝 |
   | `topics` / `created` 是从未被写入或读取的死 frontmatter 字段 | 从 `DocFrontmatter` 与 `FIELD_ORDER` 删除 |

   另修一处生命周期不对称:`session_shutdown` 原先只重置 `state`,现在连 `anchorPaths` 一并清空。
   `src/readonly.test.ts` 新增 30 条断言,钉住上述行为与 git / npm 的两层白名单
   (读形态放行:`git config -l`、`git remote -v`、`git stash list`、`npm ls`;写形态拒绝)。

5. 新增第 12 条语体禁令「禁止正反杂糅」,并把「文档与代码的关系」「一致性核对」写进
   `docs/INDEX.md` §6.1–§6.2。
6. 交接规范内化为本扩展的 skill:`skills/handoff/SKILL.md`。

### 当前仓库状况

工作树干净。设计文档 29 篇(6 个部分:22 章 + 6 篇部分索引 + `INDEX.md`),
其中的 `src/*.ts:行号` 引用已按最近一次 `src/` 改动重新基准。

### 未决问题

`node script.js` 与 `python script.py` 仍被放行。脚本文件的行为不读取脚本本身无法静态判定,
故保留为已知边界(见 `docs/01-写入门禁/02-只读命令门禁.md` §7 的 L4)。是否收紧待用户裁决。

### 后续任务

用户未指定后续任务。

2026-10-09 21:14 (+0800)
