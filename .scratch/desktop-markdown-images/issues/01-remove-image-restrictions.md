# Desktop Markdown 直接显示图片

Status: resolved

## 目标与边界

拥有者在 2026-10-25 明确要求「过度设计，删除掉这些限制」，授权移除正文图片占位、本机图片 URL 过滤和图片 CSP 来源限制。Code 主／子会话、Personal 聊天、文件 Markdown 预览与双端 Skills 正文统一生成原生 img，并保留原 src 与 alt。图片使用浏览器原有地址解析、加载与失败行为；不新增代理、路径授权、远端路径映射或配置。原始 HTML、链接过滤、脚本 CSP 与 IPC 保持现有行为。

## 方案与实现

1. 删除四处 img 占位 renderer；四处均使用 react-markdown 的 URL 转换入口，只对 img 的 src 原样返回，其他 URL 沿用库的 defaultUrlTransform。SkillBody 同时覆盖 Code 和 Personal 技能页。
2. 开发和生产的 img-src 开放网络、file、data 与 blob 图片，增加一行 CSS 按正文宽度缩放；原生壳或操作系统的限制仍由原环境处理。
3. 更新现有 CSP／Code与PA Skills／文件预览断言，新增实际 Conversation、PersonalChat、FilePreview 和 SkillBody 的 SSR 回归。
4. 同步 desktop 模块文档及[决策笔记](../../../.agents/notes/implemented/simplification/2026-10-25-desktop-markdown-images.md)，与旧图片限制决定互链。

## 进展与交接

- 当前角色与阶段：根代理完成实现与验收；image_path 完成独立方案和实现审查，无未解决阻断。
- 当前内容：develop，审查基点为 5af29a1e9f70956f6ec73bb8f35ac689dbfdd398；实现提交可通过本工单路径的 git log 定位。审查对象为相对该基点的实现与回归，以及新增 test/desktop-markdown-images.test.ts、决策笔记和本工单；根代理是唯一工作区写入者。
- 下一动作：拥有者需要使用已安装应用时重新构建并启动；本次未替换日常安装包。
- 阻塞：无。

## 验收与证据

工程验收通过。根代理先运行 `npx tsx --test test/desktop-markdown-images.test.ts`，旧实现输出 img 列表为空，与预期七类图片地址不符；修改后同一检查通过。覆盖 HTTPS、HTTP、file、data、blob、绝对路径、相对路径与 alt，并保留 HTML 跳过及危险链接过滤。

根代理运行以下三组定向用例，合计222例通过，零跳过：

- `npx tsx --test test/desktop-markdown-images.test.ts test/desktop-browser-security.test.ts test/desktop-interaction-regressions.test.ts test/desktop-personal-native.test.ts test/desktop-personal-settings-pages.test.ts test/desktop-settings-skills.test.ts`：57例通过。
- `npx tsx --test test/38-desktop-build.test.ts test/38-desktop-main.test.ts test/42-desktop-inspector.test.ts test/41-desktop-stream.test.ts test/desktop-workspace-files.test.ts`：108例通过，包含实际 electron-vite bundle 构建与制品检查。
- `npx tsx --test test/desktop-inspector-tools.test.ts`：57例通过。

`npm run check:static` 通过 lint、全 workspace／foundation typecheck、notes 和 docs 检查；最终文件预览断言修订后另运行该文件 ESLint 与根 typecheck，均通过。`git diff --check` 通过；note anchors 无悬空引用。并行运行既有 Vite 夹具时出现24678端口占用诊断，未影响用例结果；本次未改测试服务配置。

范围内的原生图片加载验收通过。image_native_probe 独立上下文使用 Electron44.7.2、最终生产 CSP、隔离 userData、隐藏 file 页面与自有1×1 PNG，开启 sandbox／contextIsolation、关闭 nodeIntegration；relative、absolute、file URL、loopback HTTP、data、blob 六类均触发 load，naturalWidth／naturalHeight 均为1。旧 CSP 对照中 HTTP 与 blob 触发 error、尺寸0，本机路径和data可加载。探针退出0，临时二进制、档案和进程已清理，未启动产品后台或日常实例。

未覆盖 HTTPS 实网、MyGo 原生 file 访问与完整应用正文布局；这些结果不由 SSR 或独立 Electron 页面代替。相对图片地址仍按页面地址解析，远端工作区路径不自动映射到本机，符合本次直接使用浏览器加载的范围。

2026-10-25 独立方案审查：image_path 亲读四处源码、安装版 react-markdown、开发与生产 CSP，结论可实施，无阻断；要求补齐 Personal 技能页共用入口的断言，已落实。

2026-10-25 独立实现审查通过：image_path 亲跑新 Markdown 与开发／生产 CSP 共6例，通过；发现文件预览旧断言仍禁止 img 后，根代理补齐目标图片断言，审查者再次亲跑该窄用例1例通过。源码、文档与旧决定互链无其他阻断。该修订后源码未再变化，原审查保持有效。

## Comments

2026-10-25：用户在解释旧限制后明确要求删除。独立方案通过后实施，无待拥有者确认取舍。
