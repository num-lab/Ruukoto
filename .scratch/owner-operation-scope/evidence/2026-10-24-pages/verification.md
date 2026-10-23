# 文件树续页与按需 Git 验证

基点 `18c6e8ab` 是本轮开始时按拥有者要求提交的第 4–6 项。本记录覆盖其后的第 7、8 项；最终源码、文档及可执行验收夹具见 `source-hashes.json`。已有 CI／测试策略工作不在范围内，日常应用与后台未重启。

## 工程验证

- 后端新增四项在旧实现全部失败，见 `backend/red.log`；`npx tsx --test test/desktop-workspace-files.test.ts test/dir-identity.test.ts test/66-control-seam.test.ts` 共 43 项通过，见 `backend/green.log`。覆盖跨页完整排序、根／子目录、字节预算、目录变化、无效／跨来源游标、真实控制 socket 和既有路径身份拒绝。
- 前端 `desktop-inspector-tools`、`desktop-live-files`、`desktop-file-tree-loading` 共 92 项通过，见 `desktop/final.log`，覆盖 Inspector 状态、Git 缓存／分页状态、实际文件预览与目录加载反馈；旧版本新页触发一次 Git 查询，现版本零次，见 `desktop/regression.log`。新增反例覆盖离线未知状态、刷新时前部新增、后页失败、折叠祖先及迟到应答。删除缓存核实使用 Set，避免累计条目增多后的二次方查找。
- 汇总 `npm run check:static` 通过，见 `static.log`；`git diff --check` 通过。`npm run desktop:build` 与 `npm run desktop:mygo:build` 通过，见两个 build 日志；两个生成的 macOS app 均经 `codesign --verify --deep --strict` 通过。Electron 构建保留原有默认图标、ad-hoc 签名与未公证提示。
- 独立审查者 `pages_lazy_review` 亲跑后端 9 项和前端 22 项；删除判定改 Set 后另跑 2 项，并运行现有可执行 `file-tree-repro.mjs`。代码、方案、文档与旧决定回链无剩余阻断。独立受验文件与汇总主树逐文件 SHA-256 一致，无需把原样复制视为新的实现。

## 大目录

macOS、Node v24.15.0，真实临时目录含 12,000 个文件。三轮首页为 11.37／6.88／6.51 ms，后页为 8.02／6.68／7.00 ms；每页等待期间 1ms 定时器推进 7–11 次。每页 200 项，脚本和原始结果见 `backend/benchmark.mts`、`backend/benchmark.json`。此结果不代表远端文件系统或固定延迟保证；每页仍枚举目标单层全部条目，只保留 201 个候选。

原基准从独立工作副本导入，其源码哈希与主树一致。保存时仅将脚本导入改为包名以便复跑；主树再跑的首页为 12.50／7.85／6.63 ms、后页为 8.70／6.94／7.27 ms，事件循环均推进，结果见 `backend/benchmark-main.json`。

## 真实浏览器交互

`ui-server.mts` 启动隔离 Runtime 与认证 control socket，Vite 只转发文件／Git 等只读操作。`ui.tsx` 装配正式 `CodeState`、`InspectorHeader`、`InspectorPanel`、CSS 和容器，不使用目录或 Git 响应替身。准备普通目录、一个有真实提交的 Git 仓库和空仓库；模型回调禁止调用，最终计数为零。Playwright 使用 headed Chromium 操作，原始步骤和断言在 `ui-entry.log`、`ui-pages.log`、`ui-git.log`、`ui-layout.log`，控制请求记录在 `ui-requests.json`。

| 行为 | 结果 |
| --- | --- |
| 新页／重新加载显示 Git graph，点击前不查仓库 | 查询增量 0；点击增量 1，成功返回 null 后显示简短非仓库提示 |
| 根目录加载第二页后，自动刷新遇到前部新增 | 原 400 项前缀的末项仍保留；新文件出现，已删除文件消失，最终 405 个文件及子目录完整 |
| 子目录继续加载 | 200 → 400 → 406 个文件，无重复，到末尾移除续页按钮 |
| 文件树读取与工作区切换 | Git 查询增量均为 0 |
| 点击真实仓库及空仓库 | 各增加一次查询；分别显示真实「验收提交」和「暂无提交」 |
| 明暗及窄栏 | 320px 右栏的续页按钮、标签和内容可见；沿原滚动容器显示 |

截图见 [固定入口](screenshots/entry-light.png)、[非仓库](screenshots/no-repository.png)、[明色续页](screenshots/directory-more-light.png)、[窄栏暗色续页](screenshots/directory-more-dark-narrow.png)、[子目录末页](screenshots/nested-pages-dark-narrow.png)、[真实提交](screenshots/git-repository-dark.png)和[空仓库](screenshots/git-empty-dark.png)。最初验收夹具缺少正式布局的邻栏及高度容器，修正夹具后重新加载并重拍；编辑夹具触发的 Vite 热更新警告不属于产品结论。最终截图和计数来自修正后的正式容器装配。

浏览器、Vite 与临时后台已关闭，两次验收的临时数据目录已清理；未修改真实工作区、系统配置或日常后台。

## 限制与升级

协议由 38 升至 39，需要 Desktop 与后台一起更新；旧客户端／后台组合按原协议不兼容提示拒绝。提交不包括日常服务升级，未运行原生 Electron／WKWebView 交互、Linux 分页实测、全量测试或真实模型／IM。浏览器证据证明正式组件及真实控制读取，不代替原生壳交互。持续变动的目录可能需要稳定后刷新，多页刷新成本仍随目录规模及已加载页数增长。
