# Personal 三类设置实现与验收

## 对象与结论

基点 `ea000a04abcbf38c44893d94c7892e6af2a18a49`，工程实现与独立审查通过。模型、Skills、MCP 沿独立 Personal 管理连接读取原档案，真实停存启由已有 Host 执行；工程通过不代替真实 Linux 固定 systemd 与原生双壳产品验收。当前状态为 ready-for-human；拥有者已授权本次提交，未推送或部署。

模型只编辑 Personal 单模型与环境变量引用，测试当前草稿和保存分开；Skills 远端逐层选库/包、预览、托管启停与逻辑移除，外部来源只读；MCP 使用真实私有文件或显式匿名，完整工具定义分页读取，迁入前禁止新增不能表示停用的服务。导航保护、旧聊天状态隔离、字段错误、只读、忙、冲突、未知结果、已保存未启动与显式恢复均有窄回归。没有新增依赖、preload 方法或本机秘密存储。

## 作者检查

- `npm run check:static`：lint、根与各 workspace 类型、foundation 类型、172 篇 notes、链接、预算与段落检查通过。
- `npx tsx --test test/desktop-settings.test.ts test/desktop-personal-settings.test.ts test/desktop-settings-models.test.ts test/desktop-settings-mcp.test.ts test/desktop-settings-skills.test.ts test/personal-settings.test.ts`：首轮 96/97，通过项涵盖 Code 模型、Skills、容器与 Personal SSH/后端；Code MCP 无会话默认首工作区的旧断言一次失败，单独完整复跑 `test/desktop-settings-mcp.test.ts` 15/15，未改断言或放宽要求，暂未稳定复现。
- `npx tsx --test test/desktop-settings.test.ts test/desktop-settings-skills.test.ts test/desktop-personal-settings-pages.test.ts test/desktop-personal-settings.test.ts test/personal-settings.test.ts`：当时 82/82；随后新增 MCP 续页修订冲突与 Skills 续页来源隔离，页面文件最终 24/24。并跑 SSR 出现过 Vite 默认 WebSocket 端口占用诊断，用例仍通过；单独页面复跑没有该诊断。
- 托管保存回执由独立副本补齐，导入、停用、移除分别断言 saved/target；旧实现先红，修复后后端与 Host 33/33，根上下文直接核对保存提交、回执与 Host 修订读回并纳入上述回归，未用实现者自审替代验收。
- `npm run desktop:build`、`npm run desktop:mygo:build` 及两壳 `codesign --verify --deep --strict` 通过。构建保留现有大 chunk、打包元数据与未公证提示，不将构建或签名当作原生运行体验。
- `git diff --check` 通过；`npm run change-scope -- --base HEAD` 核实本单没有已提交或暂存路径。

## 独立实现审查

上下文 `/root/personal_contracts` 独立读取工单、规格、实际 UI/容器、Host 和后端，发现并复核五项修复：失效技能库可从已核实档案重新选目录；保存并继续保留原导航；旧 MCP 格式禁止新增隐式启用服务；完整工具按单项读取；Host 前检也按单项读取，避免大配置在分页前超限。页面与容器亲跑 35/35，最新导航/工具分页/旧格式 3/3、Host 小页前检 1/1，通过；内存 loader 分别撤回导航与工具小页修复，新用例均按预期失败，未改工作区或依赖。

审查结论无未解决阻断，文档与实际代码一致。Skills 回执的一行修复由该协作者编写，根上下文负责独立核对及真实文件回归；独立 UI/Host 审查不声称审查者审过自己的实现。最后 MCP 续页补充覆盖配置变化及配置消失，审查者亲跑 1/1；摘要类型与只读凭据提示复核通过；Skills 续页新增比较外部库配置与托管修订，审查者亲跑 1/1，防止同托管修订下混入新外部来源。原审查其余结论继续有效。

## 合成浏览器

使用正式 `main.tsx` 与设置组件，入口 [personal-pages.html](personal-pages.html)、[合成 bridge](personal-pages.js)。Playwright 验证：模型保存并继续到 Skills；远端目录选择/预览/导入与托管停用；MCP 编辑、发现与停用；丢答后读回已保存未启动，再恢复和结束维护，写次数不增加。全部写请求属于 Personal，技能不调用 Mac 选择器，正文不生成外部图片；430px 无页面横向溢出，减少动态效果下可操作，控制台 0 错误、0 警告。

截图仅展示模拟配置，不含真实凭据：[深色模型](08-model-dark.png)、[技能导入确认](08-skill-import-dark.png)、[深色 MCP](08-mcp-dark.png)、[430px 浅色模型](08-model-light-430.png)、[430px 恢复入口](08-recovery-light-430.png)。截图前后有正常组件滚动；模拟页面不能证明真实 SSH、systemd、MCP 或原生两壳可用。

## 待真实环境验收

沿 [07 Linux 记录](07-linux.md)的缺口，需同账户、固定系统级 `ruukoto-backend.service`、精确启停权限与受支持优雅停止策略的 Linux 隔离档案，以及指定模型/MCP 凭据。未向 tx 的旧生产服务发维护指令。

拥有者/部署管理员准备环境后，由 09 在 Electron、MyGo 分别走模型保存生效、远端技能导入/停用、MCP 配置/发现/启停，验证忙拒绝、真实启动失败/断线恢复、切回 Code 不串写、关闭重开持久性、明暗/窄窗/键盘体验。当前真实模型与 HTTPS MCP、固定服务停存启、原生双壳均未验证；新个人聊天仍未接入桌面协议，继续使用 IM 或 CLI。
