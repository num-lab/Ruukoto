# Git 横向浏览、本地网页与执行活动

Status: ready-for-human

## 目标与边界

拥有者要求删除Git续页状态文字、让提交图横向滚动、删除新标签页SubAgent栏及空会话两行引导，reasoning放工具组首行且Thinking下面直接显示已有内容，删除浏览器的嵌入／HTTP提示，支持file://本地文档，并修复Thinking／Working空窗。同步Demo和Desktop对应展示；不提交、不推送，不重启日常应用或后台。不生成或猜测reasoning，只展示实际记录的累计内容（现有Driver只记录8KiB尾部，不宣称全文）。

## 方案

Git保留自动续页和错误／重试，去掉可见续页状态文字，以aria-busy表达读取；提交列表采用max-content最小宽度，水平滚动属于现有日志容器，分支／主题不再挤缩。新标签页保留浏览器、文件树与可用Git入口；SubAgent仍由消息委派行打开，已开标签不变。空会话成功加载后留白，历史正在加载的真实反馈保留。

执行活动只改前端投影／渲染，保留已有在线、审批、暂停、取消及终态约束；真实running工具显示Working，其余running且无非空assistant流正文时显示Thinking，覆盖请求前、工具参数生成和工具轮间空窗。thinking开启批次，后续同任务普通工具并入，空thinking仍是批次边界；不跨消息或任务合并，Agent调用继续独立。历史非空reasoning位于批次第一条可折叠Thought行，Thinking下直接显示当前未归入已执行工具批的真实text，不复用上一轮或重复显示。事件中的text是累计替换，不拼接事件片段。Driver／ViewState真实重放已抓到toolcall_start结束thinking、tool_intent尚未产生期间phase=null的红循环。

file://由顶层宿主显式打开并生成每文档独立loopback origin和opaque token的预览能力，iframe使用替代URL，地址栏保留用户原file URL。能力仅覆盖所选文档和同目录静态资源，校验真实路径、拒绝越界／符号链接逃逸／敏感元数据，限制文件与资源预算；模块／fetch使用不带凭据的CORS。复用主frame generic request，由Host在后台路由前拦截本地open/release，不能转发控制面；普通本地文档保留外部CDN与网络能力，token并不防止恶意本地脚本主动泄露所选目录能力，不宣称完全隔离。受控地址栏导航、刷新、关闭或宿主退出释放能力（不承诺opaque iframe内部自行导航能即时感知），迟到响应不可覆盖新地址。继续使用sandbox、主frame IPC身份和设备权限拒绝，不全局放开file或webSecurity。Demo普通网页不具有任意本机文件权限，只同步URL与文案，宿主不可用时明确返回失败；不伪装本地读取成功。浏览器无底部嵌入提示和HTTP-only提示，非法地址保留aria-invalid并给简短有效的状态反馈。

## 范围与验证

根为当前checkout唯一写入者，浏览器实现放独立managed worktree，复制当前全部已修改／未跟踪基线，只汇入增量补丁。浏览器作者拥有BrowserPanel、URL解析、宿主本地能力与专用测试，根负责Git、空会话、新标签页、活动分组与文档整合。独立方案审查后实施，按实际结果重定检查。

验证覆盖Git横向溢出与无省略、续页无可见文案；新标签页与空会话；真实Driver事件重放下首次请求、参数生成、轮间、正文stream、审批／暂停／取消／离线／终态，历史与实时reasoning只显示一次、原文和首行位置；file URL规范化、非法主机／凭据／遍历、资源边界／预算／释放、相对CSS／图片／module/fetch及导航竞态。浏览器可真实验证HTTP替代文档与正式组件，不把fixture当模型或原生；两种桌面构建、签名与宿主变化所需Go回归。check:static及最窄相关用例，不跑全仓check。原生前提缺失保留人工验收，不降低标准。

## 交接

基点53fad806549622b2fb599550a79beff08cadc130，保留此前全部未提交迁移与修复。工程／产品验收待执行；本机文件读取的授权来自拥有者本次明确功能要求，具体安全实现不重复索取授权。

## 方案审查

独立上下文desktop_v4_review亲跑Driver红例，确认工具参数生成与轮间空窗；Git、新标签、空会话与reasoning分组无阻断。浏览器采用Host本地op及既有顶层来源校验，无需新增Go／preload RPC；外部CDN禁令不是必要安全前提，能力根、敏感路径、预算和撤销必须保留。desktop_ui_audit另核对实时批次边界，结论后补。

## 实施与独立复审

Desktop与Demo已同步入口、空会话、工具批次及浏览器展示。文件能力采用Host本地desktop_browser_open／release，无新控制协议或Go／preload RPC；新文件main/browser-documents.ts、renderer/browser-document.ts与对应回归。独立审查发现`.envrc`／`.git-credentials`漏读，实际HTTP和直接open均增加红绿回归，现拒绝完整`.env*`前缀及常见凭据元数据。浏览器最终复审亲跑2项和原反例，阻断解除。

活动审查发现JSONL空assistant工具调用正文先分组后删除会拆开reasoning，已改为分组及latest之前过滤，仅排除无正文无附件消息，保留空thinking、正文、附件与任务边界。真实EventFlow窄回归已绿；旧不显示reasoning／空会话引导断言同步。Git真实浏览器抓到横向5069px后末尾哨兵留在左侧、无法续页，改为自然宽度ol内的li；同位置pages由0变1。li ref类型随DOM同步。活动独立复审亲跑11项活动、4项消息、1项observer、原空assistant反例及Desktop类型，均通过，无剩余阻断。

本次工程与产品交互证据汇总见[验收记录](../evidence/browser-activity/README.md)，源与证据指纹见同目录sha256.json。原生验收使用隔离Electron Main／preload和独立标识MyGo Go／preload／sidecar，加载正式BrowserPanel与受控本机HTML，非日常App或真实模型任务；两壳均显示native:true、module:true、CSS rgb(12,34,56)、图片宽8，iframe bridge为undefined。Electron刷新回收旧listener，两壳退出均回收当前listener。完整日常任务及真实provider端到端未运行，不用fixture冒充真实模型；已有Driver事件重放验证状态转换。

工程验收通过，产品主观视觉留拥有者复验；未要求提交或推送。原生证据由独立审查者核对截图、JSON与README后确认措辞准确，无剩余阻断。隔离browser实现工作副本已归档；临时原生实例已退出，日常MyGo未重启。
