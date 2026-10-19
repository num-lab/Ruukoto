# A1首故障诊断：独立macOS最窄实验

原38已累计后代停止用例真实运行一次，1/1、exit0、无跳过，约2.789秒墙钟；本轮未复现identity_unavailable，没有actual firstfault。原17 macOS、原38与原17 Linux的精确触发仍未归因；本轮绿测、旧EPERM类别、已修尾帧竞态与早期非唯一原因不互相替代。

## 变更与停止边界

只在/tmp/ruukoto39-native-batch修改packages/agent/src/execution/native-macos-supervisor.c，生成本副本ignored worker/native-macos-supervisor；原用例字节不变，根源码和原生制品未动。C-only原字节delta为ruukoto39-native-first-fault-diagnostic.patch，属于实验仪器，不建议直接合入正式产品。

诊断仅保存首个已拒绝分支，并在原stopped状态消息时发出一条有界[ruukoto:native] first_fault JSON stderr。字段包含单调时刻、phase/callsite/API/detail、PID、attempt、count/expected、立即保存的errno及其解释范围、列表needed/capacity、完整身份大小与PID/unique字段有效性、是否与内存累计成员PID数字匹配。只有完整大小才读取返回身份字段，不用零化或部分缓冲推断目标身份；cached_member_pid只表示数字匹配，不证明不可变身份相同。

保存动作保持调用时errno；不增加libproc查询，不记录环境、参数、进程名或目录。返回值、3次重核、1ms重核延迟、250ms观察上限、TERM/KILL/settle期限、audit-token信号与粘性uncertain/reaped及目录占用规则保持。名单/内存错误仍失败，不忽略非成员候选；先于身份错误的其他未核实reason仍保持首位。

errno只存原始值并标明来源：identity沿原代码先清零，只有零返回并有新errno标error_return_after_clear；完整/部分成功返回不解释errno。owner_processes原list查询未清零，故标raw_not_cleared，不把可能陈旧errno定因。Apple公开libproc wrapper说明了syscall错误被映射成零返回的方式，参见[Apple xnu libproc.c](https://github.com/apple-oss-distributions/xnu/blob/main/libsyscall/wrappers/libproc/libproc.c)；它不是本机动态库或private flavor的逐字节同源证明，故仍以现场返回与有效性字段为准。

## 构建与真实实验

编译沿原scripts/build-native.mjs的/usr/bin/clang -std=c11 -Wall -Wextra -Werror -O2，exit0。原test/fixtures/native-identity-check.c七项返回/重核检查编译执行0，只验证仪器没有改变已测返回语义，不能作为真实OS归因证据。

实际命令、时间、源码/二进制/原用例SHA在ruukoto39-native-first-fault-actual-result.json。平台macOS27.0.1 arm64、Node24.15；命令只选test/101-native-macos-helper.test.ts中原38失败的一个完整名称，真实libproc、真实自有后代与信号，不运行其他helper/100，也不运行模型、IM、服务或旧write_result_missing工作。

原C的SHA为1d183131d2905e9c1dfbb19dfb3ec8b5a55a3da4cb89ed8053c3e790bfde8bcf；诊断C为a265db23e70f760c6a965ba5476f15e0cc1826b2c01a5c6d9acd5145678744de；二进制为4777b6d309f35516f7fb11e15d3fe57d006ed0fd627ae27ebfcb6825715202cb；原用例仍faf17b4f3d568639671bce3e9fe775d452d962388c37829bbe91139ac0f83aaf。

额外raw-stderr tee首轮未匹配macOS /tmp→/private/tmp规范路径，未生成sidecar；这项仪器缺口原样记在actual-result，不声称已取得原始首故障。原用例仍完整等待进程关闭并断言stopped.reaped=true，故主结论只是未复现。未来tee已同时接受规范路径与别名；本轮不为修tee重复绿测。诊断构建/观察本身可能改变时序，也不把当前单例通过当组合/宽批次通过。

## 仍需区分的分支

macOS正常观察中的owner_processes候选/列表失败、signal_member核实失败与alive_members复核失败仍都能生成旧reason。缺实际首故障时，不能从原worker PID或总耗时选择其中一项；也不能从旧count0/EPERM把未填字段当作目标UID。Linux原17是local双层进程组，不使用这份C；其worker组查询、命令组回执与exit/stdout顺序需独立取证，不能在Linux上把libproc诊断当覆盖。
