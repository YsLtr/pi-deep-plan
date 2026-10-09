# D4. frontmatter 只属于总纲,条目文件保持纯正文

- **结论**: 只有总纲带 frontmatter;`decisions/*` 与 `plan/*` 是纯正文,不 stamp。
- **依据**: `src/archive.ts:9-10` 注释 "The extension owns only the small metadata header of a document";
  `src/archive.ts:107-110` `stampDoc` 对缺失文件返回 `undefined` 而不创建 —— 若条目也要 stamp,
  就得额外保证它们存在,不如不 stamp;`ADR-FORMAT.md:11` "An ADR can be a single paragraph."
- **置信度**: 高
- **备选**: 「条目文件也带 frontmatter」被否决(与 domain-modeling 产物打架,且 finish 要遍历全部条目);
  「frontmatter 移到 INDEX.md」被否决(与「索引是话题清单」的定位冲突)。
