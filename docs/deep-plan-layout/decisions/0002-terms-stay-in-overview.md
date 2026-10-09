# D2. 术语留在总纲文件,决策与计划条目各自成文件

- **结论**: 话题文件夹内固定三个能力位 —— 总纲一个文件(概览 / 目标与非目标 / 术语 / 风险 / 开放问题)、
  决策每个一个文件、计划条目每个一个文件。
- **依据**: `domain-modeling/CONTEXT-FORMAT.md:5-19` 的术语是「一个命名 section 下的 term 列表」,
  天然是文件内结构,拆开会让「成对 `_Avoid_`」失去可读性;`domain-modeling/ADR-FORMAT.md:1-3`
  已规定 "ADRs live in `docs/adr/` and use sequential numbering: `0001-slug.md`" —— 决策本就是文件夹 + 一文件一决策。
- **置信度**: 高
- **备选**: 「术语也各一个文件」被否决(违背 CONTEXT-FORMAT 的列表语义);
  「决策留在总纲的决策记录小节、只把计划条目拆文件」被否决(没解决诉求,该诉求主要针对可数的决策与计划条目)。
