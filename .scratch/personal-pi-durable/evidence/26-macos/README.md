# 完全访问命令本机验收

macOS / Node 24.15.0，基点 89b37f3。根工作区完成 setup、构建与静态检查，定向检查使用真实 SDK/provider HTTP/SSE、SQLite、Node/Bash，Linux manager/cgroup 为测试桩；不将它们作为真实 Linux 或模型证据。

- native.log：宿主、原生准备/身份/scope、worker 与产品入口六文件 76/76；包含修正 bwrap mock 后的 full returned/cancel。scope-final.log 增加无 tracking 的前置拒绝，单文件 4/4，相对先前新增 1 项。
- command-initial.log：宿主与 durable 命令两文件 46/46；其中宿主 23 项已在 native.log 重叠，durable 23 项覆盖三模式、未知/取消/重启占用、跨成员/服务/报告暂停和损坏恢复证据。
- personal-regression.log：其余十三文件 403 项，402 通过、1 项既有 Linux 专用跳过。
- permission-final.log：最终三模式真实请求与 full 关闭重开后复用 confirm、权限读取失败/缺工作覆盖旧标签，4/4；前三项重复，新增 1 项。上述合并为 504 个唯一场景，503 通过、1 跳过，不累计重复检查。

static-initial-failure.log 保留测试 mock 的 mode 参数遮蔽导致 number/string 比较类型失败；修正为 accessMode 后，static-first-pass.log、static-second-pass.log 与最终 static-final.log 通过。末轮仅将完全访问同步准备体提为函数，使错误边界的 try 只包一条调用；语句顺序、校验、返回和错误类型不变。host-after-try-extraction.log 为最终宿主 full 两项 2/2，原快照保留在 source-manifest-before-try-extraction.json/source-before-try-extraction.tar.gz；真实 Linux 正常项及独立反证也更新到提取后的最终字节。build.log 是最后冻结生产源码的完整构建，未跑全量 check。后续只改工单记账不重复运行全部测试。

source-manifest.json 与 source-files-tested.tar.gz 固定 23 个实施、测试、说明及 worker 文件；归档逐项长度/哈希和根当前内容由根代理复核。实际 Linux 的 34 文件及各场景证据另见 ../26-linux/README.md；两类环境证据不合并冒充真实平台。

independent-review/README.md 持有独立终审。审查者亲跑 72/72 基线、最终权限 3/3、宿主 2/2、fallback/tracking 2/2 及取消传播断言；撤宿主 full 准入使新用例失败，恢复相同字节后通过。其首轮基线在新增权限 section 前运行，最终文本以之后的请求及定向证据为准，无未解决阻断。最终同步准备体提取的逐句等价核对与基线/撤修复/恢复证明另见 independent-review/prepare-final/README.md。

text-estimates.json 从前后归档内实际 SDK 请求计算 chars/4、校准 1：main systemPrompt/toolSchemas 65/521 → 70/521，child 38/258 → 42/268；最终三个模式的子请求估算相同。完整主/子工具清单、提示、调用和结果均在 Linux 原始 modelCalls/permission-request 中，恢复、跨权限复用和异常提示另有本机回归。工具参数不提供权限、目录或执行引用，未知后仅允许查询原双流并结束本轮报告拥有者。

工程验收通过。真实模型、IM、拥有者实际菜单体验及完整 A1–A12 待验；本轮不切正式入口；拥有者已另行授权提交实现与证据，不推送或部署。
