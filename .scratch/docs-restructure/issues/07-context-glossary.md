Status: ready-for-agent

# CONTEXT.md 收回为纯术语表

依赖：03、06（实现细节要有着落）。范围见 [spec](../spec.md)。

## 做法

- 每个词条只保留定义和 _Avoid_。表名、工具名、实施状态、issue 编号与 ADR 编号移出：先查模块文档或 note 有没有同一事实，没有就补到对应模块文档（现状）或 note（理由），然后从词条里删掉。SubAgent 词条最长，逐句核对。
- 开头一段改为：项目包括两个产品，各一句话，架构见 `docs/architecture.md`。不再引用 ADR 和 runtime.md。
- 词条的增删仍由 `domain-modeling` 维护，`docs/agents/domain.md` 里的读取顺序不变。

## 验收

- [ ] `grep -nE "issue|ADR|工单|runtime\.md" CONTEXT.md` 无命中。
- [ ] 删掉的每个事实，都能在模块文档或 note 里找到（对照表记入 Comments）。
- [ ] 术语名称和 _Avoid_ 列表没有改动，只删实现细节。

## Comments
