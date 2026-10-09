# D7. 补 `resolveDocPath` 直测,并清理测试里的旧布局硬编码

- **结论**: 除布局改动外,补 `resolveDocPath` 直接单测(文件夹 / 单文件 / 带 `.md` / 已存在目录 /
  越界拒绝五种输入),并把 `state.test.ts` 里 5 处 `docs/plans/**` 硬编码替换为当前布局。
- **依据**: 侦察确认 `resolveDocPath`/`isDocPath`/`listDocs`/`countDocs` 在 `src/state.test.ts` 中
  **没有任何直接用例**(`src/state.test.ts:6` 的 import 不含这些符号),`isDocPath` 仅经
  `isWriteAllowed` 间接覆盖;同时 `src/state.test.ts:13,14,19,30,47` 硬编码了代码里已不存在的
  `docs/plans/...`。
- **置信度**: 高
- **备选**: 「把 5 处旧路径批量改名了事」被否决 —— 断言会通过,但被改的正是路径推导,
  没有直测等于改完不可验证。
