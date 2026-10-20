当前阻断已缩到 Napi2Native 原生模块加载，但底层原因尚缺。按官方 v4.18.38，NativePacketClient 的可用性前检只读取 napi2nativeLoader.loaded；此处抛“不可用”意味着加载标志为 false，不等于已经证明 client 对象为 undefined。PacketApi.pkt 可能只是右侧构造先抛，赋值没有完成。该阶段在 hook 初始化、FetchRkey 自检之前，不能归成新一轮 rkey 请求失败。[原生前检](https://github.com/NapNeko/NapCatQQ/blob/v4.18.38/packages/napcat-core/packet/client/nativeClient.ts#L29)。

Loader 只有三类失败出口：平台不在允许名单、对应 .node 路径不存在/不可访问、process.dlopen 抛错。darwin.arm64 在名单中。官方加载器不读取 packetServer；bypass/o3HookMode 的读取或应用发生在构造后，不能靠改这些配置使失败的 load 变成功。NativePacketClient 的 hook 初始化失败会产生另一个后续错误，和当前前检拒绝分开。[Loader](https://github.com/NapNeko/NapCatQQ/blob/v4.18.38/packages/napcat-core/packet/handler/napi2nativeLoader.ts#L30)。

候选模块是已验真发行包中的 arm64 Mach-O，SHA256 5a48995703afbb2889c73ee4624b1df41dc5fbc563e77d9224aa5f2aec048953；本机 codesign --verify --strict 退出0、adhoc、无TeamIdentifier。Mach-O minos15.0、sdk15.5，依赖均为系统Foundation/AppKit及系统库；@rpath/napi2native.node是LC_ID_DYLIB自身标识，不能把它当成已证明缺失的外部依赖。当前宿主macOS27满足该最低版本，但候选的静态校验不证明实际安装文件相同，也不证明QQ宿主会接受加载。没有执行该模块或修改签名。

为何纯状态没有更底层错误：Loader 构造捕获 dlopen 异常只写 logger，不存 PacketApi 的错误栈；后者取得的是后来前检失败。重复 status 不应被当成能恢复启动首错的办法。logger 默认开控制台、关文件；Shell先构造Loader，Core初始化后才按账号配置添加文件transport，没有把已发控制台消息回填到新文件的代码。所以下面文件路径即使存在，也不保证包含最早这一行。[日志实现](https://github.com/NapNeko/NapCatQQ/blob/v4.18.38/packages/napcat-core/helper/log.ts#L57)。

最低只需本人提供当前这次启动控制台/运行日志里的一条 Napi2NativeLoader 缺失文件或加载出错记录，以及紧随的 Error/code 和最初几行堆栈。无需整份账号日志、配置、图片或再次状态调用。磁盘备选是实际 NAPCAT_WORKDIR/logs/YYYY-MM-DD_HH-mm-ss.mmm.log；未覆盖时通常为 /Users/eitrous/Library/Containers/com.tencent.qq/Data/Library/Application Support/QQ/NapCat/logs。QQ进程HOME和NAPCAT_WORKDIR以实际为准。若没有保存该首错，明确记缺失；不自动重启或提出系统安全改动。

本次只读了已验证候选和公开primary源码、父任务提供的safe元数据；未读私有packet响应原文，未做WS/get_image/FetchRkey/IM/图片GET、未下载或改app/config。现不能根据通用前检错误选择“补文件”还是修正ABI/权限/签名/依赖；这些只是dlopen错误可能区分的类别，不是已认定原因。
