结论：本例尚无已验证可恢复的产品修复。原事件 URL 被产品原样保留、精确允许域已包含 gchat.qpic.cn；原 URL 的既有 Oracle GET 为 400。此次唯一 get_image 成功重新取得信息且变更 fileid，但其新 URL 的唯一 Oracle GET 仍为 400/text/plain/0 字节。该结果不能证明静态 rkey 必然失效，也不能把 get_image 成功当作收到图片；不建议针对静态签名拼接或增加 host 特判，未改产品代码、NapCat 配置或原收件。

实际边界：2026-10-18T15:23:32.269Z 仅发送 get_image 1 次，硬截止 12 秒，重试 0；24ms 内 status=ok/retcode=0。返回 file/url/file_size/file_name，无 base64；URL 与原事件同 host/path/query 键和顺序，appid/rkey/spec 值相同，仅 fileid 值改变，file_name 与原 identity 相同。返回 file_size=27491；本机返回路径 stat 为 46368 字节普通文件，access(R_OK)=false，未读取或绕过 OS 隐私边界。响应原文、URL 与路径仅存 0600 private/get-image-response.json，不在安全包内。

2026-10-18T15:25:02.612Z Oracle 对 get_image 新 URL 发起唯一 GET，423ms 后 HTTP400、text/plain、0 字节、空内容 SHA256；redirect:error，15 秒/8MiB 截止，无 token、无重试。不 GET 原 URL，不再次本机 GET，不 get_version_info/get_msg，不发 IM、不调用模型、不重投收件、不修改 live。此次外部额度已结束。

官方固定 commit 810052c605feb5044a080adfe99ba2fa69b7b351：[GetImage](https://github.com/NapNeko/NapCatQQ/blob/810052c605feb5044a080adfe99ba2fa69b7b351/packages/napcat-onebot/action/file/GetImage.ts#L6) 继承 GetFileBase；[GetFileBase](https://github.com/NapNeko/NapCatQQ/blob/810052c605feb5044a080adfe99ba2fa69b7b351/packages/napcat-onebot/action/file/GetFile.ts#L33) 以文件 identity 解码上下文，downloadMedia 后重读 element，再经 picElement 生成 URL；[picElement](https://github.com/NapNeko/NapCatQQ/blob/810052c605feb5044a080adfe99ba2fa69b7b351/packages/napcat-onebot/api/msg.ts#L123) 用原 fileName 作自定义缓存键绑定上下文，因此不是简单返回原 event 的 URL 字符串。缓存默认 24 小时，条件受实际安装版本与当前进程缓存约束。

原、新 URL 的 rkey 都与该 commit 中私聊静态 fallback 常量精确相同（只记录布尔，不记录值）。[getRkeyData](https://github.com/NapNeko/NapCatQQ/blob/810052c605feb5044a080adfe99ba2fa69b7b351/packages/napcat-core/apis/file.ts#L336) 的 online_rkey 是局部计算状态，初始 false，原生 PacketApi 或远端 rkeyManager 成功取得未过期数据才变为 true；false 分支生成 gchat 的 spec=0 URL。不能把 online_rkey:true 当配置建议。

相关官方配置为 [packetBackend 默认 auto、packetServer 默认空](https://github.com/NapNeko/NapCatQQ/blob/810052c605feb5044a080adfe99ba2fa69b7b351/packages/napcat-core/helper/config.ts#L20)。[PacketApi](https://github.com/NapNeko/NapCatQQ/blob/810052c605feb5044a080adfe99ba2fa69b7b351/packages/napcat-core/apis/packet.ts#L60) 还依赖 QQ 版本/架构映射、原生客户端可用及 FetchRkey 成功；disable 显式禁用。Core 构造读取配置并在启动调用 initApi；WebUI set-config 仅写文件，所审路径没有就地重初始化 PacketApi。配置存 napcat.json 或登录账号 napcat_<uin>.json；若将来获准调整，应安排 NapCat/QQ 重初始化后验证，而非声称编辑即热生效。本轮不改配置、不重启。已安装 NapCat 源和配置受 macOS 隐私限制不可读，安装版本未识别，因此不能指定当前故障来自 PacketApi、远端 rkey 服务或其他资源条件。

产品现有 input.url ?? resolver 分支意味着已有 URL 下载失败时不调用 get_image；这是可观测机制，尚不是本例可恢复缺陷的证明。若后续有某次真实、合法 get_image 产物可下载，才有依据设计通用且有界的解析回退，并保留严格 host/redirect/字节门禁；本例两条资源路径均未取得图片，不记为 QQ 图片验收通过。

旧入库 qq-image-download.json 仅证明 login ok 后发生 12 秒 timeout/1006，没有动作细分；不能称 get_image/get_msg 各自超时。此次精确 get_image ok 与旧未细分 timeout 分开保留。安全包不含原 event、整库、原/新 URL、rkey、返回路径或私有响应；官方源码只收 SHA/链接与已移除 fallback 字面量的分支摘录。
