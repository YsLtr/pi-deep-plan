# 1. state.ts 新增 planDir/entryPath 纯函数

`src/state.ts` 新增 `planDir()` 与 `entryPath(kind, slug, seq)` 纯函数 — 验收:
单测断言 `entryPath("plan","x",3)` 产出 `docs/<topic>/plan/0003-x.md`,且编号零填充到四位。
