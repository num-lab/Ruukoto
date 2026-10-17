# Agent Note: 侧栏折叠按钮连续位移

Status: implemented

## 问题

侧栏收起按钮与顶栏展开按钮是两个节点；状态切换即挂载顶栏按钮，而侧栏宽度才开始过渡。真实Demo逐帧测得x从210跳至268，再随顶栏移至36，形成58px向右跳位；原生顶栏还有交通灯留白。

## 决定

app-window直接持有一个永久按钮，放在侧栏inert区域外，沿用原ref、焦点和点击／键盘入口，aria-controls及aria-expanded表达状态。展开时left为侧栏宽度减42px，收起终点为Demo16px／Desktop84px；left与侧栏宽度均使用200ms ease，按钮层级高于顶栏并显式no-drag。收起后顶栏padding为按钮终点加30px，保持原标签终点，padding也过渡；鼠标和键盘调宽禁用left过渡，减少动画沿用全局偏好。

检索toggleSidebar、折叠、侧栏和过渡：既有[Desktop迁移](../architecture/2026-10-17-desktop-demo-v4.md)继续持有原生交通灯与玻璃层，[文件树反馈](../feature/2026-10-17-desktop-file-tree-loading.md)独立持有目录反馈决定，其余无对应按钮交接决定。

## 备选方案

新按钮延迟出现可掩盖单向跳位，但交接中缺少可操作按钮，焦点和快速反向仍不稳定。仅补偿新节点位移需要同步两个节点及焦点，永久按钮直接消除交接。取消侧栏动画虽不再看到过程，却丢失既有交互要求。

## 后果

按钮保持同一DOM，收起时连续左移并保留焦点，减少左右跳位；定位数值与现有26px按钮和标题栏留白绑定。真实Demo帧210单调下降至36，来源断言和SSR守住单节点及位置归属；原生MyGo与具体窗口尺寸的体验缺口见[工单23](../../../../.scratch/desktop-shadcn/issues/23-files-sidebar.md)。
