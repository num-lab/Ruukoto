# Electron 配置更新交互验收

结论：`passed`，10项通过，页面错误0；执行时间记录于本次制品，最终临时实例为 `/tmp/rk-egui-SGgDjR`。由独立审查上下文在真实 Electron 窗口中通过 Playwright 驱动，界面、preload、Host、HTTPS/WS 均为真实运行；安全存储和远端服务使用受控测试替身。

## 隔离与范围

临时 bootstrap 在导入现有构建前设置 appData、userData、sessionData 和 logs，Code 路径也指向临时目录并以 managed 模式禁止自动拉起。安全存储三方法在加载 Host 前换成测试 AES 存储，Chromium 使用 use-mock-keychain；未读取或修改日常应用的配置/凭据槽，未修改系统证书信任。进程内 TLS 仅信任已有测试 CA；测试远端只监听127.0.0.1随机端口。Electron 关闭后受控 HTTPS/WS 服务已收尾。

这份证据证明真实 Electron 的设置交互及 Host/bridge 传输，不证明真实 Keychain、Tailscale、实际 PA 后台发布、MCP 外部服务、真实模型或 IM；远端的在线/等待/失败/丢答状态由夹具控制。业务发布与配置落盘由独立后端回归证明。MyGo 的构建/Go 检查通过由主代理另持证据，MyGo 实机未执行，不能据此把两壳 A12 全部记为通过。

## 检查

| 场景 | 结果 |
| --- | --- |
| 真实连接 | Electron 窗口、preload bridge、DesktopHost 和回环 HTTPS/WS；从界面配对成功。 |
| 草稿 | 切页出现保留提示，继续编辑保留原值；仅显式放弃后采用当前配置。 |
| 在线保存 | 开发生命周期且缺模型凭据时仍可保存；无模型请求。 |
| 应答丢失 | 服务器接纳后断开该 HTTP 应答，界面显示待核实；显式读取原操作完成核实，POST 次数不增加，原草稿先保留。 |
| 离线保存 | 远程入口仍连接、后台标记离线，保存显示已保存而不启动后台。 |
| 目标等待 | 模型等待生效时，切到 Skills 后可选择远端库并独立保存。 |
| 文件异常 | 模型文件异常显示可行动提示，只限制模型页；仍能切到 Skills。 |
| 修复解封 | 恢复原文件状态后重新读取，模型输入解封且不新增保存。 |
| 生效失败 | 已保存而发布失败显示“生效失败”及核实原更改动作，未误报已生效。 |
| 坏服务停用 | 已有 MCP 服务的凭据文件不存在，界面显示“凭据缺失”；停用后显示已停用，不要求先发现工具或补凭据。 |

## 本轮发现与复验

首次真实交互发现 fileIssues 被并入 form unknown，从而由共享设置容器全局阻止导航。主代理把已读文件异常和 v2 unknown 限制放回本目标的 disabled/writable，保留 v1 pending 与未读传输丢答的原处理；两个跨真实 SettingsState 的回归由审查者亲跑2/2通过。最新两壳构建完成后，最终GUI10项全部重新通过。原失败材料位于临时目录，不作为通过证据；本目录只收录最终通过制品。

入库时仅统一文本文件末尾换行，并重算本目录 `artifact-sha256.txt`；截图、实际执行脚本及来源/构建指纹未变。原始脱敏证据包 SHA-256 为 `48aa256acba028585d4a2d9c45df3eb765cd1358675f8d43bc5eb5b91fe5dff0`。

## 复现与制品

```sh
node --import tsx /tmp/ruukoto-electron-review/run.mjs --run
```

启动GUI遵循工具的具体审批；脚本为现场专用，仓库和缓存 Playwright 的绝对路径已记录，不作为新增产品入口。脚本在启动前清洗继承的 ELECTRON_/NODE_ 标记，以免 Electron 被当作 Node 运行。截图等待保存对话框关闭并结束过渡动画。

- `review-result.json`：passed、10项检查、空errors、来源/构建/脚本SHA-256。
- `electron-isolation.json`：实际appData/userData/sessionData/logs路径及测试存储调用计数。
- `wire-summary.json`：仅路径、保存次数和公开回执；不记录Authorization或候选secret。
- `output/playwright/`：逐步界面文本、个人连接状态与截图。
- `scripts/`：本轮实际执行的bootstrap、受控远端和Playwright驱动；不包含临时存储密钥或凭据目录。

关键截图：[等待生效](../../../git-history-cleanup/archive.md?path=.scratch%2Fconfiguration-updates%2Fevidence%2Felectron%2Foutput%2Fplaywright%2F05-waiting-model.png)、[独立Skills保存](../../../git-history-cleanup/archive.md?path=.scratch%2Fconfiguration-updates%2Fevidence%2Felectron%2Foutput%2Fplaywright%2F06-independent-skills.png)、[目标文件异常](../../../git-history-cleanup/archive.md?path=.scratch%2Fconfiguration-updates%2Fevidence%2Felectron%2Foutput%2Fplaywright%2F07-model-file-issue.png)、[生效失败](../../../git-history-cleanup/archive.md?path=.scratch%2Fconfiguration-updates%2Fevidence%2Felectron%2Foutput%2Fplaywright%2F09-publication-failed.png)、[坏凭据服务已停用](../../../git-history-cleanup/archive.md?path=.scratch%2Fconfiguration-updates%2Fevidence%2Felectron%2Foutput%2Fplaywright%2F10-disabled-bad-mcp.png)。

## 来源指纹

| 文件 | SHA-256 |
| --- | --- |
| `apps/desktop/src/renderer/personal-settings-state.ts` | `7cb8142342534e8ad7a0d487f43da999834194745963805d0a23c90ce6e59fc0` |
| `apps/desktop/src/renderer/personal-settings-pages.tsx` | `3af27a95c7e60ad1cb2af5608cb864466f4e01b1ca9ea4ee8e5d2704ee3c446e` |
| `apps/desktop/src/renderer/settings-state.ts` | `017284141d7edb1bc94f7a3ef91d42a755c3be9366a3cbe9c59f839471e3f1b0` |
| `apps/desktop/src/renderer/settings-dialog.tsx` | `5793ae1b5db64e5cb55eaf556397257c1fb74959834855d4f937daaa7b0ebd49` |
| `apps/desktop/src/main/personal-settings-controller.ts` | `8512a5a14bbf492306a6d002dad5994c44de11d3d900dd044a6debc23d90cfd7` |
| `apps/desktop/src/main/personal-controller.ts` | `d6230a1e87c11c6393227a36c5940b73c921591650c13e6ca6ad757fc042dd25` |
| `apps/desktop/src/main/host.ts` | `9433dfa84a69592d35a61fe45309c280ce028427182a32ace507bbf175f76f24` |
| `apps/desktop/src/shared/personal-settings.ts` | `e06211c209d14e0689e36e4e3b6654cfddfe04122e7f98aa5b068b34ab907190` |
| `test/desktop-personal-settings-pages.test.ts` | `058589004d8e2fe00ee906845c3d5eb503b0f2e1d63c1e49b2a501579f2c4440` |
| `apps/desktop/out/renderer/index.html` | `4b56f24ecff3e69631b55ccb71ae5b66bd2aba1a1a31b1b4d18341b8e51c4ecd` |
| `apps/desktop/out/renderer/assets/index-BahDwEVU.js` | `cec057595b3a16a8305179f8da7bef098a0f911d0d3942dc040a55edeb2a892b` |
| `apps/desktop/out/renderer/assets/index-DFbfZYat.css` | `7b92d6757bb2b2c544a5c29e3a35fd1db568c6d949d330e01c6f506be3250c90` |
