# Desktop 配色、字号、拖动与 Git 分页验收

日期2026-10-17，macOS arm64、Node v24.15.0；基点 `53fad806549622b2fb599550a79beff08cadc130`，检验对象为该基点后的未提交 Desktop 迁移及本轮差量。源码与证据指纹见 `sha256.json`，最终原生构建已包含协议31。本轮不提交、不推送，不重启日常应用或后台。

## 六项要求

| 要求 | 结果与证据 |
| --- | --- |
| Git分支不使用黑白灰 | 明暗主题各六种彩色token，节点、父边和ref图标同色，文字中性；超过六lane循环。实际浏览器 `git-dark.json`、`git-light.json` 和 `dark.png`／`light.png` 记录颜色；SSR回归核对六种lane均可出现。 |
| 去掉最近200条总量限制 | 每页200条，加载更多直到nextCursor为null，没有累计条数／页数上限；405条真实历史连续三页、无漏重、跨页合并与旧游标拒绝均通过。每次仍有5秒、每命令512 KiB、响应768 KiB与元数据安全预算。`git-final.log` 为最终17项真实Git／控制面回归；Demo展示全部静态样例，不模拟真实仓库分页。 |
| 拖动后原位置hover残留 | 实际红循环见 `hover-red.json`／`hover-red.png`：旧位置MCP仍匹配:hover，背景、关闭图标与mask残留。最终两组实际拖动结果见 `hover-green.json`、`hover-right.json`：浏览器虽仍有旧:hover，样式资格暂停，非选中背景透明、关闭键opacity0且pointer-events:none、mask:none；后续指针恢复见 `hover-pointer-restored.json`。`keyboard-focus.json` 为实际键盘Tab后关闭键focus-visible=true、opacity0.8、可命中。永久hook红绿见 `hover-hook-red.log`／`hover-hook-green.log`。 |
| 深色选中更亮且非实色 | 左栏和两组活动Tab均为14%透明白，仅覆盖对应选中背景；`typography-main.json`记录alpha，`dark.png`展示效果，浅色沿原主题。 |
| 去掉右栏与Tab栏之间分割线 | `.inspector-header`横向border-bottom为0，两个顶部Tab区之间的28px短竖线与内部工具栏线保留；实际值见 `typography-main.json`。 |
| 消息之外文字加2px | 独立源码审查核对两端各66处px声明（含媒体分支）及四种已用text token。右Tab13.5由源码审查确认；实际侧栏14.5、主Tab14、输入框15.5、模式／菜单／Context14、设置标题18及PA label16；主／子正文14、code13、Trace／审批14保留。见 `typography-main.json`、`typography-child.json`、`menu-fonts.json`、`settings-fonts.json`、`pa-form-fonts.json`、`context-fonts.json`。`file-fonts.json`及`source.png`证明源码14、行号12，共同23.8px行高，语法高亮保留。 |

## 工程检查

| 命令 | 结果 | 日志 |
| --- | --- | --- |
| `npx tsx --test test/desktop-workspace-git.test.ts test/desktop-git-layout.test.ts test/desktop-demo-v4.test.ts test/desktop-inspector-tools.test.ts test/desktop-polish.test.ts test/43-desktop-demo.test.ts` | 63／63，包含两端70000条纯函数布局，之后grafts新增回归另跑下行 | `targeted.log` |
| `npx tsx --test test/desktop-workspace-git.test.ts` | 最终17／17，含普通仓库、worktree common目录的grafts跨页变化及页内变化 | `git-final.log` |
| `npx tsx --test test/66-control-seam.test.ts test/125-agent-wait-view.test.ts test/desktop-polish.test.ts test/43-desktop-demo.test.ts test/desktop-interaction-regressions.test.ts` | 33／33 | `integration.log` |
| `npm run check:static` | 通过，含lint、全workspace类型检查、notes与文档检查 | `static.log` |
| `npm run check:docs` | 最终证据和工单落盘后通过 | `docs.log` |
| `npm --prefix .scratch/desktop-shadcn/demo run check` | 通过；已有大chunk提示 | `demo.log` |
| `npm run desktop:mygo:build`、`npm run desktop:build` | 两者通过 | `mygo-build.log`、`electron-build.log` |
| `codesign --verify --deep --strict` | 两个bundle均exit0 | `signatures.json` |

独立方案审查及实施审查无剩余阻断。实施复核用真实API发现info/grafts改变历史而旧cursor仍被接受，作者建立三条准确红循环并修复，审查者亲跑原反例与新增3项通过；修订指纹因此覆盖Git/common中的grafts。另独立核对了两端字体级联及来源断言；未把源码映射等同于原生视觉结果。

旧版200条无续页、70000条RangeError与grafts三项红循环的原工具输出分别保存为 `pagination-layout-red.log`、`grafts-red.log`；作者将原始输出提取后交付，没有在根重复跑旧实现。`grafts-green.log` 为作者修复后17项输出，根实际最终结果另存 `git-final.log`。

## 范围与恢复

真实界面验收在当前Demo的855×827视口完成，包含两个Tab区的拖动、键盘关闭键焦点、明暗配色、窄composer单排、菜单、PA设置、Context、子消息及文件源码。关闭本轮新增的Git／文件树／文件预览测试标签，恢复原两组顺序、深色、原主会话及收起右栏，未改变模型／模式／Effort或保存PA连接；最终视图见 `restored.png`。没有新建浏览器标签或启动性能服务。

尚未实测原生MyGo拖动与hover；上一轮原生自动化的坐标输入无法定位窗口，此轮不把Demo通过冒充原生结果。70000条用例只证明布局函数不再参数展开溢出及边索引正确，不证明70000个DOM节点的实际帧率；翻页后的巨大历史仍可能增加布局和内存开销。Desktop与后台需匹配协议31，日常后台未替换。恢复原生鼠标环境后按工单原标准复验，视觉取舍留拥有者查看截图；不降低验收标准。
