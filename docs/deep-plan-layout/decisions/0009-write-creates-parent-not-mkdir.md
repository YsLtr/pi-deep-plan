# D9. 建话题文件夹用 write 隐式建父目录,不放开 mkdir

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
