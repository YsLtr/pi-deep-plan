# 5. 清理 state.test.ts 旧布局硬编码并补 resolveDocPath 直测

清理 `state.test.ts` 旧布局硬编码,补 `resolveDocPath` 直测(D7)— 验收:
全仓 `rg "docs/plans"` 无命中;`npm test` 与 `npm run typecheck` 全绿。
