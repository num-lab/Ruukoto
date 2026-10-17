import * as childProcess from "node:child_process";
class ServiceHelperError extends Error {
  constructor(message, reasonCode, capture) {
    super(message);
    this.reasonCode = reasonCode;
    this.capture = capture;
    this.code = reasonCode;
  }
  reasonCode;
  capture;
  code;
}
function opUnitFor(hostOpId) {
  return `ruukoto-service-op-${hostOpId}.service`;
}
const REPLY_PREFIX = "RUUKOTO_SERVICE_REPLY ";
async function callHelper(cfg, args, opts) {
  if (opts.signal?.aborted) throw new ServiceHelperError("\u4EFB\u52A1\u5DF2\u505C\u6B62\uFF0Chelper \u5C1A\u672A\u542F\u52A8", "aborted");
  const argv = cfg.useSudo ? [cfg.sudoPath, "-n", cfg.helperPath, ...args] : [process.execPath, cfg.helperPath, ...args];
  return await new Promise((resolve, reject) => {
    let child;
    try {
      child = childProcess.spawn(argv[0], argv.slice(1), {
        env: { PATH: "/usr/bin:/bin" },
        stdio: ["ignore", "pipe", "pipe"],
        detached: true
      });
    } catch (err) {
      reject(new ServiceHelperError(`\u670D\u52A1\u7BA1\u7406 helper \u542F\u52A8\u5931\u8D25\uFF1A${err.message}`, "spawn_failed"));
      return;
    }
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    let truncated = false;
    let failureReason;
    const failure = (message, code) => new ServiceHelperError(message, code, { stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), truncated });
    const collect = (target, chunk) => {
      const remaining = Math.max(0, (opts.maxOutputBytes ?? Infinity) - bytes);
      const kept = chunk.subarray(0, remaining);
      if (kept.length) target.push(kept);
      bytes += kept.length;
      if (kept.length < chunk.length) {
        truncated = true;
        stop("\u670D\u52A1\u7BA1\u7406 helper \u8F93\u51FA\u8D85\u8FC7\u4E0A\u9650\uFF0C\u5DF2\u505C\u6B62\u68C0\u67E5\uFF1B\u5DF2\u4FDD\u7559\u6709\u754C\u8F93\u51FA\u3002", "output_limit");
      }
    };
    child.stdio[1].on("data", (c) => collect(stdout, c));
    child.stdio[2].on("data", (c) => collect(stderr, c));
    const killGroup = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
        }
      }
    };
    const stop = (message, code) => {
      if (failureReason) return;
      failureReason = { message, code };
      killGroup();
    };
    const timer = setTimeout(() => stop(`\u670D\u52A1\u7BA1\u7406 helper \u8C03\u7528\u8D85\u65F6\uFF08${opts.timeoutMs}ms\uFF09`, "timeout"), opts.timeoutMs);
    const onAbort = () => {
      stop("\u4EFB\u52A1\u5DF2\u505C\u6B62\uFF0Chelper \u8C03\u7528\u5DF2\u4E2D\u6B62", "aborted");
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (err) => {
      failureReason ??= { message: `\u670D\u52A1\u7BA1\u7406 helper \u542F\u52A8\u5931\u8D25\uFF1A${err.message}`, code: "spawn_failed" };
    });
    child.on("close", () => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      if (failureReason) {
        reject(failure(failureReason.message, failureReason.code));
        return;
      }
      const out = Buffer.concat(stderr).toString("utf8");
      const lines = out.split("\n").filter((l) => l.startsWith(REPLY_PREFIX));
      const line = lines[0];
      if (lines.length !== 1) {
        reject(
          failure(
            `\u670D\u52A1\u7BA1\u7406 helper \u672A\u8FD4\u56DE\u7ED3\u6784\u5316\u7ED3\u679C\uFF08\u5E94\u7B54\u987B\u552F\u4E00\uFF09\uFF1A${out.trim().slice(0, 200) || "\uFF08\u65E0\u8F93\u51FA\uFF09"}`,
            "protocol_error"
          )
        );
        return;
      }
      let reply;
      try {
        reply = JSON.parse(line.slice(REPLY_PREFIX.length).trim());
      } catch {
        reject(
          failure(`\u670D\u52A1\u7BA1\u7406 helper \u5E94\u7B54\u4E0D\u662F\u5408\u6CD5 JSON\uFF08\u62D2\u7EDD\u5F53\u4F5C\u6210\u529F\uFF09\uFF1A${line.slice(0, 200)}`, "protocol_error")
        );
        return;
      }
      if (!reply || typeof reply !== "object" || reply.v !== 1 || typeof reply.verb !== "string" || typeof reply.ok !== "boolean" || !reply.ok && (reply.reasonCode !== void 0 && (typeof reply.reasonCode !== "string" || !/^[a-z_]{1,64}$/.test(reply.reasonCode)) || reply.error !== void 0 && typeof reply.error !== "string")) {
        reject(failure("\u670D\u52A1\u7BA1\u7406 helper \u534F\u8BAE\u5B57\u6BB5\u4E0D\u5B8C\u6574\u6216\u7248\u672C\u4E0D\u7B26", "protocol_error"));
        return;
      }
      resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), reply });
    });
    if (opts.signal?.aborted) onAbort();
  });
}
function requireOk(reply, verb) {
  if (!reply.ok) {
    throw new ServiceHelperError(`\u670D\u52A1\u7BA1\u7406 helper \u62D2\u7EDD\uFF08${reply.reasonCode ?? "unknown"}\uFF09\uFF1A${reply.error ?? "\u672A\u7ED9\u51FA\u539F\u56E0"}`, reply.reasonCode ?? "refused");
  }
  if (reply.verb !== verb) throw new ServiceHelperError("\u670D\u52A1\u7BA1\u7406 helper \u5E94\u7B54\u4E0E\u8BF7\u6C42\u4E0D\u7B26", "protocol_error");
  return reply;
}
const HEX64 = /^[0-9a-f]{64}$/;
function expectRevisions(reply) {
  if (!("policyRevision" in reply) || typeof reply.policyRevision !== "string" || typeof reply.unitRevision !== "string" || !HEX64.test(reply.policyRevision) || !HEX64.test(reply.unitRevision) || typeof reply.machineId !== "string" || !reply.machineId || reply.machineId.length > 256) {
    throw new ServiceHelperError("\u670D\u52A1\u7BA1\u7406 helper \u8FD4\u56DE\u7684\u4FEE\u8BA2\u6307\u7EB9\u4E0D\u5B8C\u6574", "protocol_error");
  }
  return { machineId: reply.machineId, policyRevision: reply.policyRevision, unitRevision: reply.unitRevision };
}
export {
  ServiceHelperError,
  callHelper,
  expectRevisions,
  opUnitFor,
  requireOk
};
