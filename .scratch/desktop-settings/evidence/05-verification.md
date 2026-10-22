# Code Skills 实现与验收记录

日期：2026-10-21。基点 `2cc9c7721f802613770413f4016d75047c35d612`，开工时工作区干净，01、04 均 resolved。05 按已批准方案完成工程交付，产品验收待拥有者；拥有者已要求提交到当前分支，未授权推送。写入测试均使用临时隔离 Runtime／Control，未修改日常配置或技能源目录。

## 实际交付

设置 → Skills → Code 无需打开会话即可取得有界技能列表、名称检索、来源、启停、仅显式调用与诊断。列表分批取得，检索不向后台发起全库搜索。按稳定身份读取正文，Markdown 跳过 HTML、图片只显示文字、链接限 HTTP(S)，不执行技能内容。

Electron 与 MyGo 的系统目录选择均消费 DesktopHost：选择前固定原 Code 实例及连接，选择后和后台预览返回时再次核实。宿主保存路径、技能身份、内容与清单修订；renderer 提交只含选择引用，不放行后台原始路径预览／导入操作，不增加通用文件 API 或旧 Personal 操作。取消不写，确认后复制单包至 Code 私有托管区，源目录不变。一次选择只发送一次导入，失败及重选使旧预览失效。

托管副本支持启用、停用和逻辑移除，均先展示影响。仅显式调用是独立属性；停用及移除阻止后续新任务与新显式调用，旧任务、原恢复引用与已记录正文保持可读，逻辑移除保留包字节。外部维护来源只读。冲突保留原列表、选择和预览，用户刷新比较后显式重新选择；丢答和在途断线保留原操作身份，恢复同一实例后读回，不重发。读回失败保持待核实；确认后台未安装时保留失效预览，重新选择前不能再次导入。

同步 [desktop 模块](../../../docs/modules/desktop.md)、[操作说明](../../../docs/usage.md#桌面客户端)与[决策笔记](../../../.agents/notes/implemented/feature/2026-10-21-desktop-code-skills.md)。共享复制安全、清单布局及旧任务选择语义沿用 [04 证据](04-verification.md)，未改后端协议或运行时选择规则。

## 工程检查

| 检查 | 结果与范围 |
| --- | --- |
| `npx tsx --test test/38-desktop-main.test.ts test/desktop-mygo.test.ts test/56-skills.test.ts test/desktop-settings-skills.test.ts test/desktop-settings.test.ts` | 94/94 通过，无跳过，约 11.4 秒；05 新增 13 项、MyGo 新增 bridge 映射回归 |
| `npm run check:static` | lint、根及全部 workspace／foundation 类型、笔记与文档门禁通过 |
| `npm run desktop:build` | Electron 构建通过，沿既有配置 ad-hoc 签名，未 notarize |
| `npm run desktop:mygo:build` | MyGo 构建及签名通过 |
| `cd apps/desktop/mygo && go test -race ./...` | 通过，约 7.8 秒 |
| `codesign --verify --deep --strict dist/mac-arm64/Ruukoto.app` | 通过 |
| `codesign --verify --deep --strict 'dist/mygo/darwin-arm64/Ruukoto MyGo.app'` | 通过 |
| `git diff --check` | 通过 |

定向用例在真实隔离后台和共用宿主上分别模拟 Electron 单回调与 MyGo 选择前／选择后两步，证明导入、取消不写、拒绝 Personal 和任意路径、连接变化拒绝、外部不可移除、清单冲突、原身份读回以及不产生第二份包。启停和移除丢答分别读回实际状态，已移除项仍可按身份读回正文；前 50 项以外的选择刷新后仍可管理，分页冲突不拼接两个修订。源正文及引用文件未改，逻辑移除后托管引用字节仍在。测试中的 reconnect 只重建宿主连接，不能当作完整应用或后台重启证据。

## 合成浏览器检查

Playwright CLI 的 Chromium 加载正式设置组件、样式和合成 bridge。浅色 1280×720 检查列表、来源与诊断；深色 760×500 检查滚动、正文与停用确认，实测 document.scrollWidth 为 760、对话框宽 728、右侧 panel.clientWidth 与 scrollWidth 均为 558，没有横向溢出。模拟减少动态效果后，键盘 Tab／Enter 能确认停用并读回已停用状态；导入预览显示名称、描述、文件数、字节数、仅显式调用和源目录不变说明，预览未确认时原技能操作禁用。

正文中包含 script 与远程图片，实际 `.skills-body` 中 img、script 节点均为 0，图片替换为文字。SSR 另断言不产生 script、img、iframe 或 javascript: 链接。已查看[浅色列表](desktop-skills-light.png)、[深色窄窗确认](desktop-skills-dark-narrow.png)与[导入预览](desktop-skills-import-preview.png)。合成入口初次缺 Vite React preamble，修正入口后继续检查；开发 HMR WebSocket 被浏览器本地网络规则阻断，不将该合成入口当作真实应用控制台或生产 CSP 验收。

## 独立实现审查

独立上下文 `/root/skills_contract` 直接读取 05、规格、实际源码、调用方、测试与文档，亲跑新增 Skills 定向文件 11/11，通过且无跳过；另以 VM 核实 MyGo 目标与实例透传、disconnected 分类及不重放，执行 diff 空白检查。作者随后追加启停／移除丢答和未安装读回两条用例，包含在最终 94/94 中，未改变被审查的产品代码。

中途发现两项 P2：重新选择取消／失败后旧预览仍可提交，以及第 51 项起在刷新首屏后管理按钮失效。已分别在重选开始使旧预览失效、按已核实详情保留首屏外管理资格，并补能捕获旧实现的窄回归。审查确认修复有效，最终无未解决阻断；工程验收通过。

## 产品验收与恢复条件

工单状态为 ready-for-human，下一责任人为拥有者。尚未在真实 Electron 与 MyGo 打开系统选择器导入测试技能、启停后退出重开；没有使用日常实例或真实用户技能进行写入。需要在两壳各选同一测试包、确认源目录未改、启停与重启后核实持久性，并验收真实键盘焦点、明暗窄窗、Markdown、安全空态与诊断是否可理解。合成浏览器、隔离后台回归、构建及签名不替代这些验收。

08 可复用页面结构与托管状态交互，仍须使用远端路径选择与 Personal 维护流程；本单没有接入 Personal 管理，不因此解除 06／07 的前置。本次未跑全仓 `npm run check`，未执行真实模型请求、物理回收或发布。
