# D3. 总纲文件保持 planPath 语义,条目路径由纯函数推导

- **结论**: 保留 `planPath` 指向话题文件夹内的总纲(`docs/<topic>/<topic>.md`),不新增 state 字段;
  新增 `planDir()` 与 `entryPath()` 两个纯函数做路径推导。
- **依据**: `src/state.ts:162-174` `resolveDocPath` 是唯一路径真相源,只需改其产出;
  `src/state.ts:182-207` `listDocs` 已是递归 walk(带 `isDirectory` 分支),文件夹布局天然被支持。
- **置信度**: 高
- **备选**: 「新增一整套文件夹工具」被否决(工具面翻倍);「不改 state、让模型自己建文件夹」被否决
  (stampDoc / 门禁 / `--doc` 全按文件工作,总纲拿不到 frontmatter)。
