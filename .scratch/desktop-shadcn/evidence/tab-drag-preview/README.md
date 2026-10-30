# Tab 拖动避让验收

环境：2026-10-17，可变 GUI demo，127.0.0.1:5173，用户原有 IAB 标签；原生 drag 输入与只读 DOM 采样。默认视口在过程中由700px变为713px，未设置视口覆盖；右栏可见宽229px、列表宽364px、横滚135px，标签始终180px。

## 结果

[检查结果](checks.json)的10项断言通过。每个 JSON 的 baseline、samples、after 分别记录拖动前、松手前采样与结束状态；预览时保持原 DOM 顺序，shift 为整槽偏移，实际 transform 与 x 包含160ms过渡中的位置，drop 后才提交顺序并清除预览。样本没有读取 React 内部状态。

- [向后拖动](session-forward.json)记录原序保持、源隐藏、中间项 shift=-1 和松手后末位；[浅色反向拖动](session-light-reverse.json)记录相反方向与主题。
- [移出取消](session-cancel.json)与[跨组取消](cross-group-cancel.json)保持原顺序，结束后预览清空；跨组右栏顺序也未变。
- [间隙落下](session-gap-drop.json)与[关闭键区域落下](session-close-area-drop.json)成功排序且不关闭标签。初次间隙尝试未提交，补齐 dragenter 与 dragover 共用落点处理后重新通过，旧失败样本已由最终实测覆盖。
- [右栏横滚后向前排序](right-scroll-reverse.json)由 indexeddb.ts、Schema Auditor 变为 Schema Auditor、indexeddb.ts，默认活动页仍为子 Agent 消息；首次尝试使用旧视口坐标落在可见区外而取消，按最新可见区重新定位后通过。
- 键盘 Alt+Shift+左排序后焦点、活动页与「避让验收草稿」保留；最终等宽与清理状态见 checks.json，完整可访问界面见[最终状态](final-state.txt)。上述断言来自实际浏览器读取。

[暗色拖动帧](../../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-shadcn%2Fevidence%2Ftab-drag-preview%2Fdrag-preview-dark.png)和[浅色拖动帧](../../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-shadcn%2Fevidence%2Ftab-drag-preview%2Fdrag-preview-light.png)显示源标签隐藏及兄弟项过渡中的位置；网页截图不包含系统绘制的原生拖影。right-drag-preview.png 是落下后的结果，不能证明拖动中避让。[暗色最终界面](../../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-shadcn%2Fevidence%2Ftab-drag-preview%2Fdark.png)与[浅色最终界面](../../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-shadcn%2Fevidence%2Ftab-drag-preview%2Flight.png)用于静态样式核对。

## 工程检查与限度

实施者执行 demo check（类型、自检、Vite 构建）、全仓 check:static，全部通过；构建仍有原有大于500kB的单块提示。新增定向自检覆盖前后避让、未跨越项、无效标识、源槽位与原数组不变。控制台没有 error／warn。独立审查者亲自运行 tsc、render自检、diff检查通过，最终证据审查见[工单](../../issues/15-tab-drag-preview.md)。

未提供长时间按住鼠标不动的验收，因为当前原生 drag 接口只提供起止坐标；固定原始槽位算法与连续样本用于核对不追逐位移后的目标。减弱动画沿用现有全局媒体规则，未更改系统偏好实测。系统原生拖影外观与避让手感留拥有者审阅。未验收触屏、跨窗、外部系统载荷或正式 Desktop，均不在本轮范围；未提交。
