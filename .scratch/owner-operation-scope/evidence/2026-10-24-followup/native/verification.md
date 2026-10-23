# 原生挂载保护核对验收

第 6 项仅将 `prepareNativeLaunch` 的显式挂载由单目标循环改为现有批量核对。运行依赖根及代码资产例外、授权树文件别名检查保持。三个显式挂载的保护目录枚举由四次降至两次：显式挂载一次，运行依赖一次；不是整个原生启动只枚举一次。

## 回归与静态检查

- `red.log`：未改源代码时运行新增测试，枚举次数 `4 != 2` 失败；另外三项保护拒绝通过。
- `green.log`：macOS 执行 `npx tsx --test test/native-mount-protection.test.ts test/protected-path-batch.test.ts`，12 项通过。
- `macos-native-input.log`：构建 worker 与 native helper 后，`npx tsx --test test/101-native-execution.test.ts`，5 项通过。覆盖原有运行依赖例外、身份与文件别名要求。
- 两个改动文件的 ESLint、根 `npx tsc --noEmit`、`git diff --check` 通过。
- 独立审查者只读复审与亲跑 12 项，无阻断。

## 真实环境

macOS Darwin 27.0.0、Node v24.15.0；Linux `ssh tx`、6.8.0-117-generic、Node v24.21.0。Linux 复制源码与 package exports，直接用 `node --experimental-transform-types`，没有安装依赖或改变服务；该 Node 参数的实验性警告保留在日志。`source-hashes.json` 的十个文件逐一与 Linux 实测副本比较一致。

- `linux-tests.log`：同一新增与底层批量测试共 12 项通过。
- `native-smoke.mjs` 在两个平台直接调用正式 `createNativeLauncher`，以实际原生单元核实 confirm / auto-review 的工作区及授予可写、只读根可读不可写、保护目录不可读、停止核实成功；结果见 `macos-smoke.log` 与 `linux-smoke.log`。
- `linux-bind.mjs` 在正式 `/usr/bin/bwrap` 创建的临时 namespace 中，以真实 bind 将保护子目录映到工作区或后面的授予，将 nlink=1 的保护文件映到后面的只读根；三个入口在创建原生单元前拒绝。namespace 结束后同路径可通过准备，见 `linux-bind.log`。
- smoke 与 bind 临时夹具均已清理；远端本轮目录 `/tmp/ruukoto-native-batch.YS63bA` 已清理，不修改日常后台或系统配置。

未跑全量测试、真实模型、IM 或 Desktop 端到端；本项不改变这些入口。保护树与授权树本身仍须枚举，本次只消除同阶段按显式挂载数重复扫描。
