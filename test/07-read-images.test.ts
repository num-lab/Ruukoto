import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { crc32 } from "node:zlib";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { createLocalLauncher } from "@ruukoto/agent/execution/launchers.ts";
import { ToolWorkerHost } from "@ruukoto/agent/tool-worker/host.ts";
import { parseSessionFile } from "@ruukoto/core/history.ts";
import type { Task } from "@ruukoto/core/types.ts";
import { createProjectSession, realTools, startTestRuntime, taskStatus, waitFor } from "./helpers/testkit.ts";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "base64");
const IMAGES = [
  { mimeType: "image/png", bytes: PNG },
  { mimeType: "image/jpeg", bytes: Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDi6KKK+ZP3E//Z", "base64") },
  { mimeType: "image/webp", bytes: Buffer.from("UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoBAAEAAUAmJaACdLoB+AADsAD+8ut//NgVzXPv9//S4P0uD9Lg/9KQAAA=", "base64") },
];

function workerFixture(scope: "普通" | "工作区" | "资料根") {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-read-images-")));
  const workspace = path.join(root, "work"), materials = path.join(root, "materials"), outside = path.join(root, "outside");
  for (const dir of [workspace, materials, outside]) fs.mkdirSync(dir);
  const imagePath = path.join(scope === "资料根" ? materials : workspace, "image.bin");
  fs.writeFileSync(imagePath, PNG);
  fs.writeFileSync(path.join(workspace, "text.png"), "普通文本\n");
  fs.writeFileSync(path.join(outside, "image.png"), PNG);
  fs.symlinkSync(path.join(outside, "image.png"), path.join(workspace, "escape.png"));
  const host = ToolWorkerHost.create(createLocalLauncher(), {
    taskId: "read-images", mode: "full_access", workspace, grantedPaths: [],
    ...(scope === "普通" ? {} : { readRoots: scope === "资料根" ? [{ path: materials }] : [] }),
  });
  let callIndex = 0;
  return {
    host, workspace, outside, imagePath,
    async read(file: string) {
      const chunks: Buffer[] = [];
      const id = `read-${++callIndex}`;
      const result = await host.call({ opId: id, sdkCallId: id, name: "read", params: { path: file },
        onData: (stream, bytes) => { if (stream === "file_read") chunks.push(bytes); } });
      return { result, content: result.content as Array<ImageContent | TextContent>, bytes: Buffer.concat(chunks) };
    },
    async close() { await host.stop(); fs.rmSync(root, { recursive: true, force: true }); },
  };
}

for (const scope of ["普通", "工作区", "资料根"] as const) {
  test(`read 图片：${scope}读取按实际内容识别，原始字节只捕获一次，文本不变`, async () => {
    const f = workerFixture(scope);
    try {
      await f.host.start();
      for (const [index, expected] of IMAGES.entries()) {
        const file = `${f.imagePath}-${index}`;
        fs.writeFileSync(file, expected.bytes);
        const read = await f.read(file);
        assert.equal(read.result.isError, false);
        const image = read.content.find(part => part.type === "image");
        assert.ok(image, "模型结果必须含 image 块，不能把图片当文本");
        assert.equal(image.mimeType, expected.mimeType);
        assert.deepEqual(Buffer.from(image.data, "base64"), expected.bytes);
        assert.deepEqual(read.bytes, expected.bytes, "探测与读取不得重复捕获原始字节");
      }

      const text = await f.read(path.join(f.workspace, "text.png"));
      assert.deepEqual(text.content, [{ type: "text", text: "普通文本\n" }]);
      assert.deepEqual(text.bytes, Buffer.from("普通文本\n"));
      if (scope !== "普通") {
        for (const file of [path.join(f.outside, "image.png"), path.join(f.workspace, "escape.png")]) {
          const rejected = await f.read(file);
          assert.equal(rejected.result.isError, true, "范围外路径与符号链接不得用于图片探测");
          assert.equal(rejected.content.some(part => part.type === "image"), false);
          assert.equal(rejected.bytes.length, 0, "被拒路径的正文不得流回后台");
        }
      }
    } finally { await f.close(); }
  });
}

test("read 图片：结果帧超限返回工具错误，完整原文保留，后续读取仍可用", async () => {
  const f = workerFixture("普通");
  const body = Buffer.from(`Comment\0${"x".repeat(Math.floor(3.2 * 1024 * 1024))}`);
  const header = Buffer.alloc(8), checksum = Buffer.alloc(4);
  header.writeUInt32BE(body.length); header.write("tEXt", 4);
  checksum.writeUInt32BE(crc32(Buffer.concat([header.subarray(4), body])));
  const large = Buffer.concat([PNG.subarray(0, -12), header, body, checksum, PNG.subarray(-12)]);
  fs.writeFileSync(path.join(f.workspace, "large.png"), large);
  try {
    await f.host.start();
    const read = await f.read(path.join(f.workspace, "large.png"));
    assert.equal(read.result.isError, true);
    assert.match(read.content.filter(part => part.type === "text").map(part => part.text).join("\n"), /消息超限/);
    assert.deepEqual(read.bytes, large, "失败结果不丢失已捕获的完整原始图片");
    const next = await f.read(f.imagePath);
    assert.equal(next.result.isError, false);
    assert.ok(next.content.some(part => part.type === "image"), "超限不得终止整个工作进程");
  } finally { await f.close(); }
});

for (const supportsImages of [true, false]) {
  test(`read 图片：${supportsImages ? "视觉模型实际收到图像且会话可重建" : "仅文本模型在图片请求发出前明确失败"}`, async () => {
    const t = await startTestRuntime("read-image-model", req => {
      if (!req.messages.some(message => message.role === "tool")) {
        return { kind: "tool_calls", calls: [{ id: "image-read", name: "read", arguments: { path: "image.bin" } }] };
      }
      return { kind: "text", text: "图片读取完成" };
    }, { workDirs: 1, config: realTools() });
    const resolve = t.runtime.modelCatalog.resolve.bind(t.runtime.modelCatalog);
    t.runtime.modelCatalog.resolve = async selection => ({ ...await resolve(selection), input: supportsImages ? ["text", "image"] : ["text"] });
    try {
      fs.writeFileSync(path.join(t.work[0]!, "image.bin"), PNG);
      const { sessionId } = await createProjectSession(t.client, t.work[0]!);
      const task = await t.client.request<Task>("submit", {
        model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" },
        session_id: sessionId, request_id: "read-image", input: "读取 image.bin 的图片",
      });
      await waitFor("图片任务结束", () => ["completed", "failed"].includes(t.runtime.store.getTask(task.id)!.status), 60_000);
      const detail = await taskStatus(t.client, task.id);
      const session = t.runtime.store.getSession(sessionId)!;
      const history = parseSessionFile(session.sessionFile!);
      assert.ok(history.some(entry => entry.type === "message" && JSON.stringify(entry.message).includes(PNG.toString("base64"))),
        "模型可见的图片正文须进入会话记录");
      const artifact = detail.artifacts.find((entry: { name: string }) => entry.name.includes("文件正文"));
      assert.equal(artifact.status, "complete");
      const raw = await t.client.request<{ data: string }>("read_artifact", { task_id: task.id, artifact_id: artifact.id });
      assert.deepEqual(Buffer.from(raw.data, "base64"), PNG);
      if (supportsImages) {
        assert.equal(detail.task.status, "completed");
        assert.equal(t.server.calls.length, 2);
        const images = t.server.calls[1]!.messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
          .filter(part => part.type === "image_url");
        assert.deepEqual(images.map(part => part.image_url.url), [`data:image/png;base64,${PNG.toString("base64")}`]);
        const record = t.runtime.store.listSelectionRecordsByTask(task.id)[1]!;
        const snapshot = await t.client.request<{ data: string }>("read_artifact", { task_id: task.id, artifact_id: record.promptArtifactId });
        assert.ok(Buffer.from(snapshot.data, "base64").toString("utf8").includes(PNG.toString("base64")), "prompt 快照保留实际图片输入");
      } else {
        assert.equal(detail.task.status, "failed");
        assert.match(detail.task.errorMessage, /image_input_unsupported/);
        assert.equal(t.server.calls.length, 1, "仅文本模型不得收到丢图后的第二次请求");
      }
    } finally { await t.shutdown(); }
  });
}
