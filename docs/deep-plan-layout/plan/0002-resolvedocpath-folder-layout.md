# 2. resolveDocPath 支持文件夹布局与 --doc 三条解析规则

`resolveDocPath` 支持文件夹布局与 D5 的三条 `--doc` 解析规则 — 验收:
D7 的五种输入单测全绿,且 `--doc docs/foo/` 与 `--doc docs/foo` 产出不同结果。
