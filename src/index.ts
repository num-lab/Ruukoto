/**
 * 程序化入口：以库方式启动/停止后台运行时与控制面。
 */

export { Runtime, type RuntimeConfig, RuntimeApiError } from "./runtime/runtime.ts";
export { ControlServer } from "./control/server.ts";
export { ControlClient, ControlClientError } from "./control/client.ts";
export { Db } from "./core/db.ts";
export { Store, StoreConflictError } from "./core/store.ts";
export { acquireInstanceLock, InstanceLockError } from "./core/instance-lock.ts";
export { resolveDirIdentity, verifyDirIdentity, DirIdentityError, type DirIdentity } from "./core/dir-identity.ts";
export { Driver } from "./agent/driver.ts";
export { parseSessionFile } from "./core/history.ts";
export { createMockTools, MOCK_TOOL_NAMES } from "./agent/mock-tools.ts";
export * from "./core/types.ts";
