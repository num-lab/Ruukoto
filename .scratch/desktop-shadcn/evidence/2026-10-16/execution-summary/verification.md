# 执行尾部状态验收

本轮只改可变 demo，分支 codex/desktop-demo-ui，基点 6afb20a，保留前轮未提交内容。source-hashes.json 对应本轮最终源码；此前工具详情材料仍对应此前的哈希，本轮涉及 ToolActivity、demo-data、App 和检查的结论以本篇为准。正式 Desktop、后台、原始样例及两份冻结稿无变更。

## 工程与独立审查

macOS／Node 24.15.0 执行 demo check，通过类型、首屏及右栏检查、新增执行状态 SSR 和 Vite 构建；最后可访问名称增量后复跑通过，产物约 657.4kB，仍有既有大于 500kB 的 chunk 提示。SSR 验证 Thinking 仅状态、Working 默认展开完成与进行中工具、显式错误优先、运行中不借旧 diff／统计、已记录部分 diff／命令可见、尾部投影过滤 pending 审批且不修改历史，以及正常／失败 Working 和运行调用的明确可访问名称。

npm run check:static 的 lint、全部 workspace 类型、notes 和 docs 门禁通过。之后仅补运行中按钮 aria-label 与断言，最窄 demo check 再通过。git diff --check 通过；没有新增依赖或计时器。

trace_tool_details_review 独立方案与实现审查无阻断，亲跑最窄 checkToolActivity SSR 通过；后续单独核对 aria-label 与失败数增量无阻断。停止、排队和实际状态切换属于浏览器证据，不宣称由 SSR 证明。

## 浏览器实测

使用独立 Playwright CLI Chromium 访问当前 127.0.0.1:5173，测试 1280×827、1280×550 和 833×827。空闲没有执行尾部；切到 Thinking 后最后一个 MessageScrollerItem 只有旋转环和 Thinking，无折叠按钮或思考正文，命令审批卡隐藏，输入区有停止按钮。实际读取旋转环 transform 随时间变化，动画为 spin／1s。切到 Working 后同一尾部默认展开，2 个完成工具显示勾选，1 个进行中 Bash 与 summary 显示旋转环；命令详情显示完整输入与已有输出。

Working 中 Read 路径仍打开右栏文件预览，已完成 Edit 可展开删除／新增 diff；这些操作不移除执行尾部。Enter 输入后实际加入队列提示，执行条目的 data-message-id 仍为当前会话的 main:execution，已展开命令保持，状态继续在最后。停止后状态与停止按钮消失，原 pending 审批恢复；切到其他会话和返回后无旧执行预览或停止语义残留。再次启用 Working 可保留该会话的调用展开选择。

833px 窄栏执行条目 clientWidth／scrollWidth 都为 225px，无横向溢出；明暗截图等待有限过渡结束后拍摄并检查。prefers-reduced-motion: reduce 下旋转环 animationName 为 none。上翻阅读用真实 wheel 表达用户暂停跟随，随后排队新增消息，scrollTop 保持 0→0，最大滚动量 386→499；未修改原生滚动行为。最初用脚本直接设置 scrollTop 没有表达用户意图，不能据此判定暂停跟随；原生组件通过 wheel／key／touch 进入自由阅读，纠正操作后实测通过。

浏览器检查还发现运行中展开按钮的可访问名称为空，消费者补明确 aria-label 后按名称定位、展开和上述流程均通过。设置对话框退出需等待 Portal 移除，脚本已按实际生命周期等待。控制台只有既有 favicon.ico 404，无应用异常。

thinking-dark.png、working-dark.png 展示两种尾部，working-narrow.png／working-light.png 展示窄栏与明暗。静态图只证明最终布局；旋转、停止、排队和状态隔离结论来自实际操作与 DOM／计算布局。

## 交付范围

工程验收通过，独立材料审查亲核 38 项哈希和 4 张截图一致，无阻断；产品观感待拥有者审阅。所有任务／工具状态和文件仍为内存模拟，不证明真实模型、命令或 Electron 行为。未同步 Desktop，未提交。
