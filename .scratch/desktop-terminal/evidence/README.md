# 集成终端验证

2026-10-20，macOS arm64，Node 24.15.0，Electron 44.7.2，MyGo 0.5.5。

日志仅规范行尾空白与末尾换行，未改动检查结果。

## 已执行

- `npm run setup`：依赖按锁文件恢复完成；此前定向 npm install 只安装 desktop 后个人依赖缺失，恢复后静态检查通过。
- `npm run check:static`：lint、根／workspace／foundation 类型、笔记和文档门禁通过，见[日志](static.log)。
- `npx tsx --test test/desktop-terminal.test.ts test/38-desktop-build.test.ts test/desktop-mygo.test.ts test/38-desktop-main.test.ts test/42-desktop-inspector.test.ts test/desktop-inspector-tools.test.ts test/desktop-startup.test.ts test/desktop-personal-interface.test.ts`：139通过、0失败、0跳过，见[日志](tests.log)。包括真实PTY中文、cwd、resize、200000字符输出与忽略TERM/HUP的交互前台进程回收，以及宿主打开期间取消／重置／退出的回归。
- `npm run build`：[根构建](root-build.log)通过。
- `npm run desktop:build`、`npm run desktop:mygo:build`：[Electron](electron-build.log)及[MyGo](mygo-build.log)构建通过。
- 两包 `codesign --verify --deep --strict` 通过；[包内PTY探针](packaged-pty.mjs)在Electron app.asar及MyGo resources中直接加载vendor，中文和100×30尺寸通过，见[Electron结果](electron-packaged-pty.json)和[MyGo结果](mygo-packaged-pty.json)。
- MyGo `go test -race ./...`通过（7.926s）；Go代码此后没有改变。

## 审查

独立[首轮实现审查](implementation-review.md)提出输入顺序及回收失败不可见两项阻断，已修：逐终端串行发送input/resize，失败后停止后续发送；关闭失败保持全局可见提示，提供重试，成功才清除。两项有窄回归并包含在139项通过中。首轮审查亲自证明反例与内存断言，受限沙箱未跑完真实PTY，不能据此代替作者的真实测试。

返工后的独立复审尚未获得结论：多个独立协作会话与新CLI审查上下文反复遭遇服务资源不匹配、加密内容解密失败或token限流。没有将作者自检记为独立通过，工单保留待复审。

## 未覆盖

真实两种窗口的输入法、快捷键、明暗、隐藏恢复与尺寸变化尚缺完整验收。电脑控制服务曾返回ScreenCaptureKit捕获失败；后续只能取得MyGo主界面树，无法核实终端。`native-fixture.mts`用临时Runtime/ControlServer和隔离档案启动窗口，可在电脑控制服务恢复后重跑；临时目录和进程只属于该脚本，不能用日常窗口替代。当前文件夹的ready信息来自尝试，不证明成功验收；本次隔离应用已退出，exitCode=0，临时目录已删除，见[清理结果](mygo-cleanup.json)。

全量`npm run check`、Linux矩阵与真实模型未运行；本次限桌面本机终端，根构建、静态与相关离线回归已覆盖。终端以应用账户运行，工作区只固定启动cwd；主动脱离、回收前已成为孤儿或回收快照后新派生的外部进程无法保证追回。
