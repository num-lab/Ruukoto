# MyGo 试验验收

日期：2026-10-17。环境：macOS 27 arm64、Node 24.15.0、Go 1.27.2、MyGo v0.5.5。基点：30f02b8；未提交实现以 [源码摘要](content-sha256.json) 对应实际文件（不含本验收与工单）为准。

## 工程检查

作者执行 `npm run setup` 完成首次安装。`npm run check:static` 的 lint、全 workspace typecheck 与 notes 通过后，第一次文档检查发现预算超限，已精简新增说明而未提高上限；最终 `npm run check:static` 全部通过。

桌面直系回归分两组执行：main、Personal、attachments、browser-security 与 MyGo 桥接第一组 95 例通过；build、recovery-guide、creation、stream、inspector、demo、agent-display、context、composer、inspector-tools、tool-activity、workspace-files 第二组 104 例通过。补充的 `test/desktop-mygo.test.ts` 三例全部通过，包含真实 Runtime／ControlServer 下的 DesktopHost、未开放操作拒绝、旧实例附件选择拒绝。第二组输出有原有 Vite 测试的 24678 端口占用诊断，104 例仍全部通过；未把该诊断当独立端口验收。

`cd apps/desktop/mygo && go test -race -count=1 ./...` 覆盖原始 JSON 与大整数保留、并发应答关联、进程退出／坏帧／帧超限、取消后 unknown、EOF、Node 路径失效、阻塞写入可取消、关闭后的迟到 online 丢弃，以及正常退出不发布错误。独立审查者另执行 Go race、TS 最窄回归，并用临时真实子进程探针复现后验证阻塞写入与迟到更新；修复已各有入库回归。

`npm run desktop:build` 与 `codesign --verify --deep --strict dist/mac-arm64/Ruukoto.app` 通过，Electron app.asar 不包含 out/mygo。`npm run desktop:mygo:build` 通过并自动检查 ad-hoc 签名，使用官方 CLI 打包，不是裸 go build 假装应用。两个产物分别保留。

## 真实 WKWebView

[夹具](fixture.mts) 使用临时真实 Runtime／ControlServer、独立控制目录及 userData、本地确定性 MockModelServer。GUI 操作通过原生界面执行，未使用静态 demo 或伪造 bridge。

- 工作区与已有会话由真实控制快照安装；点击会话恢复历史。
- 中文粘贴、Shift+Enter 换行、Enter 提交后得到真实新任务回显；[后台任务](tasks.json)保留原输入中的换行和 completed 状态。
- 原生附件选择器选中临时 sample.txt，上传后出现附件引用，发送后后台完成任务；原文与 34 字节附件信息可从任务记录和截图核对。
- 工作区文件树只列临时后台返回的 README.md／sample.txt，Markdown 预览显示真实正文。
- 设置中的明暗主题均能切换，见[暗色](../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-mygo%2Fevidence%2Fmygo-dark.png)与[浅色](../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-mygo%2Fevidence%2Fmygo-light.png)截图。UI 使用原 renderer，MyGo 追加 --app-region 拖动属性。
- 浏览器打开[本地恶意 iframe](iframe-probe.mjs)，[结果](iframe-result.json)与[真实树](mygo-iframe-ax.txt)显示 own runtime／bridge 为 undefined，读取 top.ruukoto 为 SecurityError，window.open 返回 null，顶层导航为 SecurityError，media API 不可用；顶层仍是 mygo://localhost/。见[截图](../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-mygo%2Fevidence%2Fmygo-iframe-probe.png)。此探针没有证明所有下载或网页权限分支；它们的拒绝另有原生 API 配置和源码审查依据。
- 只对夹具的 Node 子进程发送 SIGTERM 后，界面显示“暂时无法连接／MyGo 连接已关闭”，添加／发送禁用，见[故障截图](../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-mygo%2Fevidence%2Fmygo-disconnected.png)与[真实树](mygo-disconnected-ax.txt)。Cmd+Q 后夹具 app 与 Node PID 均不存在，夹具正常结束并回收临时后台。未发送重复业务请求。

首次构建还曾只读打开日常已有后台列表，确认可连接后立即退出，未提交任务、改配置或停止日常后台；上述可变操作全部在隔离夹具完成。

## 体积与限制

同机 `du -sk`：MyGo 应用 10096 KiB（约 9.86 MiB），Electron 应用 296240 KiB（约 289.3 MiB）。MyGo 不打包 Node，依赖构建时记录的外部 Node 与仓库；两个数字只是当前脚本产物占盘，不能推出总内存或冷启动改善。未测统一条件下的内存和启动时间。

未跑全仓 npm run check；未验真实外部模型、Personal 真 SSH、系统通知送达、中文 IME 组合输入、长流滚动与全部窗口手势，也未发布或公证。Go 子进程和既有 SSH 替身覆盖工程路径，不能冒充真实远端验收。拥有者随后明确确认保留 MyGo；未执行项目仍保留为验证限制。

独立终审通过：29 项源码摘要无差异，最终 Go race 与恢复提示两项定向测试由审查者亲验通过，两个最终产物严格验签通过；无未解决实现阻断。拥有者确认保留后，工单验收完成并转为 resolved；已授权本地提交与合入 codex/desktop-demo-ui，未执行项目仍保持原记录。

提交验收：拥有者明确确认保留，并授权提交后合入 codex/desktop-demo-ui。按提交前检查补跑 npm run build 通过；先前已通过的行为与原生验收复用，提交钩子执行最终静态检查。
