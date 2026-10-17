# Agent Note: Git 历史按页读取到末尾

Status: implemented

## 问题

Desktop 将200条同时作为一次读取容量和历史总量，无法查看更早提交；直接移除 max-count 会撞输出与时间预算，全部历史也会放大每行扫描全部边的工作量。

## 决定

read_workspace_git 接受程序管理的 opaque cursor，返回 nextCursor，null 表示到末尾。每页200条，没有累计提交数或页数上限；Desktop 点击加载更多追加，刷新替换首批。每页保留5秒、每命令512 KiB、响应768 KiB及原有保护根、元数据身份与100000项扫描预算。游标只含偏移与修订摘要，不接客户端命令、根目录或 revision argv；协议升为31，不改持久化格式。

修订摘要绑定工作区、根与 Git／common 目录身份、原始及解析后的HEAD、全部refs及remote名称、shallow与info/grafts内容。Git log使用--all，展示分支／tag之外的refs也会改变遍历，必须参与核实；--no-replace-objects不会禁用grafts。首尾摘要不一致、游标与当前修订不符或翻页时已非仓库，拒绝为workspace_git_changed并提示刷新，不把浮动偏移的结果拼接到原前缀。所有参数在本轮读取前校验，元数据读取有界且保留身份检查。

Inspector追加按缓存对象、实例代次与原游标判断归属，去重并发；刷新及断线使旧追加失效，失败保留已加载内容并允许重试原游标。累计提交统一布局，lane前缀保持；useMemo避免无关更新重排，逐行边索引代替每行筛选全部边，最大lane数用循环计算。Demo显示全部静态样例，不伪造真实后台分页。

## 既有决定

检索 Git graph、Desktop、分页、游标及提交详情的 proposed／implemented／rejected。与[Desktop迁移](../architecture/2026-10-17-desktop-demo-v4.md)部分重叠，本篇取代其最多200条总量，保护根与只读边界继续适用；[图形样例](2026-10-17-demo-git-graph.md)与[提交详情](2026-10-17-demo-git-commit-details.md)继续持有展示与行高决定。其余命中无关。

## 备选方案

一次返回全部历史没有分页状态，但大仓库会超过控制帧和命令预算；仅把200提高到更大数字仍留下不可继续的总上限。仅传offset更短，但refs、grafts或shallow改变会漏项或重复，改为修订绑定的游标。引入虚拟列表适合更大规模绘制，但当前可以按需追加，先移除重复边扫描和大数组参数展开，不增加依赖。

## 后果

可继续查看全部可达历史，每次读取仍受明确预算；仓库更新后需要刷新，已加载图不会悄悄混入另一修订。405条真实历史、跨页合并、首尾变更、非法及跨工作区游标、追加失败与迟到、70000条布局有回归；这些检查不证明70000行DOM的交互帧率。工程与界面证据见[工单21](../../../../.scratch/desktop-shadcn/issues/21-polish-history.md)。

点击触发由[滚动自动续页](2026-10-17-desktop-git-lazy-loading.md)取代，分页读取与一致性决定继续适用。
