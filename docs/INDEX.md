# 开发文档

本目录就是本项目的**开发文档**,取代传统的根目录 `development.md`:构建、测试、约定、
各话题的设计结论都住在这里。一行一个话题并指向它的入口(总纲)。

| 话题 | 入口 | 覆盖范围 |
|------|------|----------|
| deep-plan 文档布局 | [docs/deep-plan-layout/deep-plan-layout.md](./deep-plan-layout/deep-plan-layout.md) | `docs/` 的话题文件夹布局、计划条目分划、`--doc` 路由、条目校验与提交归属 |

## 约定

本仓库自身的开发方式(与上面的话题无关的通用部分):

- 测试:`npm test`(node --test)。类型检查:`npm run typecheck`。
- 决策不写进文档,只写进 **git commit message** —— 决策会变,文档要长期自洽。
  详见 [deep-plan 文档布局](./deep-plan-layout/deep-plan-layout.md)。
