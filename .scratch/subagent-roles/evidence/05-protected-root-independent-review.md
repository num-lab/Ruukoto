# 05 保护根测试夹具独立补充审查

requirements_audit 仅在独立临时副本执行，主区保持只读；本附录补充第26个修复文件，不改写已归档的60项输入与25文件独立审查。

原 test/10-access-modes.test.ts:621–623 把 `/var/lib/ruukoto` 当作无害固定保护根。root 保存的 Linux 原路径探针中，根目录、`/var`、`/srv/work` 三种请求都在 `identityCovers` 遍历宿主实际 `/var/lib/ruukoto/service-ops` 时抛 EACCES。这只证明这条夹具碰撞真实宿主权限；不泛化其他失败，也不将原完整检查改记通过。生产 `approved-ops.ts:66–126` 未改，遍历失败继续向上传播。

被审更正仅 test/10-access-modes.test.ts:620–637：创建并 canonicalize 自有临时根，在其下创建真实 protected/work 空目录，分别断言文件系统根祖先、直接祖先拒绝与兄弟允许，仍调用原生产 `assertGrantNotProtected`，不 mock 身份检查，finally 只清理自有夹具。原三项语义全部保留，修补方向成立。

独立执行：`npx tsx --test --test-name-pattern='assertGrantNotProtected：根目录视为所有保护根的祖先' test/10-access-modes.test.ts`，工作目录 `/var/folders/y4/36h8kvvd4q52vjptp522rzfc0000gn/T/rk05-target-independent-sjdtgrlt`。被检文件从主区复制到独立私有 workspace 包解析副本，实际 1/1、0失败、0跳过、exit 0，1343.216667 ms；日志 `/tmp/05-independent-protected-root-fixture.log`，未执行模型或 native 场景。

边界：这次独立执行为 macOS 最窄断言。Linux 原完整 runner 继续保持修补前冻结输入和原退出事实，不能把本次独立通过拼成最终26文件全量通过；Linux 后续新夹具结果与完整运行分别记录。

文件/原探针/补丁/日志摘要见 `/tmp/05-protected-root-independent-inputs.json`。
