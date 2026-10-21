# Agent Note: 个人文件检索在独立只读执行单元中读取资料

Status: implemented

## 问题

个人主会话的文件工具只接受已知文件；子命令目录与资料目录独立，不能用运行命令替代资料检索。Coding 检索已有参数和扫描器，但其路由依赖旧 Store，直接在宿主调用扫描器也会绕开受限读取。

## 决定

个人 `list_files`、`search_files` 复用共享 schema、参数、rg 扫描器和预算；来源、配置、授权、开始与观察沿 `personalTools` 原生工具记录保存，不导入旧业务运行时。默认目录来自 `tools.json.workspace`。受限越界目录须先在现有资料授权入口开放，检索不增加递归审批协议；完全访问沿原文件权限。目标目录身份、原工作、配置和资料版本在开始前复核。

独立构建的检索 worker 接收一次有界输入；逻辑 cwd 与 roots 绑定资料。原生启动的 workspace 是独立私有临时目录，资料只作为只读 readRoots，避免通用启动器默认给 workspace 写权。Linux 复用持久 user scope；macOS 的持久监督器在 Seatbelt 外包装同一只读 profile，受限环境用准备结果，完全访问仍继承原账户环境。身份、请求指纹先保存，开始后恢复只停止原单元，不重放。临时目录变化只阻止新启动，不能阻止按原身份停止。

stdout 原流与 stderr 原流按此顺序拼接保存为一个最多8MiB的不可变产物，结果中的 rawStreams 保存各段字节数；预览只显示结构化命中，读取原文沿 read_artifact。扫描完整、预览裁剪和原始捕获 partial 保留不同含义。停止未核实保留原来源暂停；重开仍重核原执行，补独立停止证据而保留原观察和产物。

`personal-file-search` 标记与主/子/定时工具配置共同保存；旧程序不认识该扩展即拒绝。首次启用前完成旧未决工作；已有检索工具或操作却缺标记的档案拒绝恢复，不自动补造来源。定时计划只继承创建时清单，新增工具不会扩张旧计划。

## 既有笔记核对

检索 file-search、readRoots、个人资料和原生身份；[受控文件检索](2026-10-21-controlled-file-search.md)保留共享语义与 Coding 归属，[个人通用工具](../../implemented/architecture/2026-10-17-personal-tools-access-artifacts.md)保留授权和产物，[原生执行](../../implemented/architecture/2026-10-10-native-execution-sandbox.md)保留执行约束，[会话后台](2026-10-21-coding-background-processes.md)保留独立后台的业务归属。以上部分重叠并互链，没有完全吸收或过时提案。

## 备选方案

直接复用旧 ToolRouter 能少写接线，但会重新引入旧 Task/Store/ArtifactStore。宿主直接运行 rg 更短，但受限扫描没有原生只读保证。把资料目录直接交给通用启动器作 workspace 可复用全部默认值，却取得不需要的写权；选择私有临时 workspace 加只读资料根。另建检索业务 Task 和存储能隔离格式，但现有工具接纳、观察与产物已经完整，复用后无需另一套状态机。

## 后果

主、子和定时工作沿同一来源与资料范围检索，取消是无写入效果，停止未知仍可见。代价是需要构建自包含 worker、安装 rg 及平台原生执行前提；扫描没有索引或稳定分页，大资料须收窄 path/glob。真实模型、平台与 IM 的证据分别记录，不能由离线测试外推。
