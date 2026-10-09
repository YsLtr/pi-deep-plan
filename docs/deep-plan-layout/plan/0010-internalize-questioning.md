# 10. 内化提问式规划,撤销对外部 skill 的依赖

把设计树 + frontier 的提问式规划写进 `skills/deep-plan/SKILL.md` 的 P1,**不再引用**
`grilling` / `domain-modeling` 两个外部 skill。P1 定为**自问自答**(问题自己提、答案自己给),
并在文案里把「提问与回答」写成强制环节,不是可选步骤。术语格式直接写进
`references/plan-format.md`,不再指向 `CONTEXT-FORMAT.md` / `ADR-FORMAT.md`。
验收:`rg "grilling|domain-modeling"` 在 `src/` 与 `skills/` 下无命中;SKILL.md 的 P1
同时给出「先写问题、再写答案」的格式与「跳过提问即反模式」的判据。
