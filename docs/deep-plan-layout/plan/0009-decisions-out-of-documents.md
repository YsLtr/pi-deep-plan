# 9. 决策移出文档:删除决策工具与 decisions/ 位置,决策只记 git commit

删除 `deep_plan_record_decision` 工具与 `docs/<topic>/decisions/` 位置;`deep_plan_review`
不再要求「决策记录非空」;删除上一轮加的 `crossPostedDecisions` / `listAdrFiles` 与
`docs/adr/` 概念(它们管的就是决策文件)。同时清掉 `docs/deep-plan-layout/decisions/` 下
已有的 10 个文件。验收:`rg "record_decision|decisions/|docs/adr"` 在产品代码与 skill 文档里
无命中;`npm test` 与 `npm run typecheck` 全绿。
