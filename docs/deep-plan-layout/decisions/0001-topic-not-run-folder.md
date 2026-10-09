# D1. 布局单位为「话题文件夹」,不是「每次运行一个文件夹」

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
