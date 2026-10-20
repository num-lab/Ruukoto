当前启动失败的具体原因已经确定：macOS 在 process.dlopen 加载 napi2native.darwin.arm64.node 时拒绝其代码签名，明确报告映射进程与非 platform 模块的 Team IDs 不同。这是本人提供启动日志中第一个 Napi2NativeLoader 失败，位于第 7 行；没有导出原始日志整行。错误最小短句为“code signature … not valid for use in process”及“mapping process and mapped file (non-platform) have different Team IDs”。

这把先前 Packet status 的通用“NativePacketClient 不可用”具体化为原生模块加载阶段的 Library Validation 拒绝。Loader 捕获 dlopen 异常后将 loaded 保持 false；NativePacketClient.check 随后失败，尚未进入 hook 初始化和 FetchRkey 自检。因此不应继续改 rkey、offset 或 Packet 配置来修这个启动失败。[官方 Loader](https://github.com/NapNeko/NapCatQQ/blob/v4.18.38/packages/napcat-core/packet/handler/napi2nativeLoader.ts)、[NativePacketClient 前检](https://github.com/NapNeko/NapCatQQ/blob/v4.18.38/packages/napcat-core/packet/client/nativeClient.ts)。

此前验真的官方 4.18.38 候选 addon 是 adhoc 签名、没有 TeamIdentifier，静态严格签名校验退出0；静态校验并不证明 QQ 宿主允许加载。当前日志与该类限制一致，但实际安装文件尚未取 hash 比较，不能把候选字节当成当前安装字节。当前日志已足够证明 Team ID 加载拒绝，无需再次 WS、GET、FetchRkey 或重投收件。

最小修复目标是让实际 QQ 宿主与 NapCat addon 的加载/签名方式符合上游支持路径。下一步可只读核对 Installer 对 Mac 的正式加载/签名流程及实际宿主、addon 的选定签名/entitlement 元数据，再形成一次明确维护方案；当前材料尚不能证明哪条签名变更是上游支持且可安全执行的修复。本次不执行重签名、不改 entitlement 或安全策略、不关闭 SIP、不绕过 TCC、不改 NapCat 配置、不退出或重启 QQ。后续经单独批准维护后，先核对一次启动 native loaded 成功及原纯状态结果；图片验证另行安排。

原日志只在 /Users/eitrous/Developer/Temp/napcat.log 保留，未复制或归档；本目录只存白名单结构化分类与上述最小短句。四个真实凭据仅在内存读取作变体过滤，未输出值、前缀、长度或 hash；完整 URL/rkey、配置、堆栈路径未输出。本次 WS、图片 GET、IM、模块执行、应用/配置修改均为0。
