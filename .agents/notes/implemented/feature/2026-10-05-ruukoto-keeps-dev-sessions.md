# Agent Note: ruukoto 保留普通开发会话

Status: implemented

原出处：ADR 0017「补充：ruukoto 保留普通开发会话」

## 问题

开发本项目的 `npm run dev` 实例运行 ruukoto 产品，并用普通开发会话工作。若按 Personal Agent 产品拒绝其创建与提交，会立即打断现有开发实例；直接切换该实例到 ruukoto-code 又会被数据目录产品归属拒绝，必须先迁移现有开发档案。

## 决定

ruukoto 产品允许普通开发会话的创建与提交。`npm run dev` 继续以 ruukoto 产品的普通开发会话开发本项目。Coding Agent 仍是编码主要入口，ruukoto 的这项能力是兼容保留；[两个产品](../architecture/2026-10-02-two-agent-products.md)的定位和档案隔离不变。

固定角色退役时，旧项目新建入口只在 ruukoto-code 改为工作区提示，不扩展到 ruukoto。会话身份的入口资格无需增加产品维度，SubAgent、main、普通开发会话与退役归档仍按实际身份核实，不能借这个保留规则恢复固定 coding/chat 写入口。开发入口自己的档案与生命周期见[开发启动入口](../process/2026-10-09-dev-launchers.md)。

## 验证

决定由拥有者在[会话身份工单 08](../../../../.scratch/architecture/issues/08-session-profile.md)访谈确认，并记入[固定角色退役工单 23](../../../../.scratch/agent-direction/issues/23-contract-legacy-roles.md)的 2026-10-05 拥有者决定。工单 23 的普通 dev 测试与真实后台冒烟提供既有接线证据；其中模型为桩，未实测真实 IM。此次保留决定本身没有另改执行逻辑，也没有原 ADR 独立登记的测试命令结果。

## 备选方案

把开发实例改成 ruukoto-code 并迁移档案，再让 ruukoto 拒绝普通 dev，可以让 Personal Agent 的产品能力与定位严格对应；工单 23 明确列出此选项，但产品归属禁止直接切换，现有档案迁移与约 37 个默认 ruukoto 产品的 dev 测试都要处理。拥有者选择保留现状，避免为产品限制打断当前开发工作。

## 后果

现有开发档案与日常开发流程可继续使用，身份判定不增加产品参数。代价是 ruukoto 的实际可用能力包含普通开发会话，不能仅凭产品名称假定它不可编码；未来若决定移除，必须先提供开发档案迁移并更新调用方和测试。[运行说明](../../../../docs/runtime.md)描述现状。
