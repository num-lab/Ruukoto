# 盲审报告（第 1 轮，SKILL.md 730c2740…）

审查者：独立执行上下文（general-purpose 子代理），只读 `/tmp/aft/blind/`。报告共 29 条发现：browser B1–B21、bash S1–S8、跨工具 X1；另有 9 条对 SKILL.md 的意见。下表只列与案例相关的发现及其要点。

| 发现 | 位置（审查者所引） | 规则 | 要点 |
| --- | --- | --- | --- |
| B16 | `browser-tools.ts:57-58`，`url` 无描述 | J1 | 只支持 http/https 未写；本地 HTML 先试 file:// 被拒，转 bash 起服务 |
| S1 | `worker.ts:121-126`、`:142-148`；bash 描述 | J7 | 后台进程在返回时整组回收，或继承管道挂到超时；之后浏览器连不上 |
| B9 | `browser-manager.ts:119-120`、`:616-619`；`browser-tools.ts:169-171` | J3 | 冻结状态的进入条件与宿主自动 pause 未写 |
| B10 | `browser-manager.ts:120`「请核实当前页面，不能重复旧动作」、`:608`「请先核实原执行并显式关闭」 | J2、J4 | 核实当前页面无工具可做；核实原执行属内部术语；禁令无正面做法与范围；模型 close→start→open 后重复原动作 |
| B11 | 描述「人工登录先 pause…新消息的新任务才能 resume」、`:607` | J3 | 暂停期间可用动作、退出方式未写；同一机制也用于结果未知后的自动冻结 |
| B14 | `browser-tools.ts:166` `JSON.stringify(data)`；`browser-manager.ts:32-55` | J5 | status/start/close 返回整个绑定记录（pid、socketDir、cdpUrl…） |
| B18 | 描述「仅完全访问的拥有者 main/普通开发会话」 | J8 | 工具可见即资格已满足 |
| S4 | `tool-router.ts:402-407` | J6、J5 | 每个输出流无条件追加捕获提示 |
