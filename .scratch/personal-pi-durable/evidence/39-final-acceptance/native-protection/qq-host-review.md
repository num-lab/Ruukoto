# 工单 39：QQ 图片 host 独立只读审查

结论：不阻断。新增 `multimedia.nt.qq.com.cn` 精确 host 与 NapCat 当前官方源码一致；只扩大一项已知图片来源，不扩大协议、重定向或凭据传递范围。

## 官方来源

当前公开 main 对应提交为 `810052c605feb5044a080adfe99ba2fa69b7b351`（2026-10-15）。[constant.ts 第 2 行](https://github.com/NapNeko/NapCatQQ/blob/810052c605feb5044a080adfe99ba2fa69b7b351/packages/napcat-core/types/constant.ts#L2) 固定 `IMAGE_HTTP_HOST_NT = 'https://multimedia.nt.qq.com.cn'`；[element.ts 第 447 行](https://github.com/NapNeko/NapCatQQ/blob/810052c605feb5044a080adfe99ba2fa69b7b351/packages/napcat-core/packet/message/element.ts#L447) 使用该 host 构造图片入口。来源摘录与文件定位保存在 `/tmp/ruukoto39-napcat-host-evidence.json`，未记录实际消息下载 URL 或 rkey。

## 实现审查

已读 `personal-qq-api.ts` 的图片直取与 `get_image` 解析链路及调用方。URL 校验仍要求 HTTPS、无 username/password，并对 URL 解析后的 hostname 作精确集合匹配；未引入 suffix 匹配。下载仍使用 `redirect: "error"`，不携带 QQ 连接凭据或 Authorization。无法校验的媒体拒绝保留为整条图片入站失败，不把缺图的文本部分送入模型。

新增最窄回归覆盖直接 URL 与 resolver 两路成功，并验证 HTTP、userinfo、伪装后缀域名在调用 fetch 前失败；验证 fetch 的 headers 未设置且 redirect 为 error。独立执行 `npx tsx --test --test-name-pattern='QQ：NapCat 官方' test/personal-qq.test.ts`，1/1 通过、0 跳过。日志：`/tmp/ruukoto39-qq-host-independent.log`。作者的 40 项回归结果由根持有，本审查不重复跑全组。

## 证据边界

本审查确认此前白名单遗漏了官方当前使用的 host。原始失败消息实际 URL 尚未取得，`get_msg/get_image` 读探针无回包是单列事实，不能据此认定 host 遗漏是原图唯一根因。未读取本轮 IM/模型凭据，未操作 live-profile，也未执行真实 QQ 重发。
