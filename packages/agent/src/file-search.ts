import { Type } from "typebox";

// Note: 见 .agents/notes/implemented/feature/2026-10-21-controlled-file-search.md
export const FILE_SEARCH_TOOL_NAMES = ["list_files", "search_files"] as const;
export type FileSearchName = typeof FILE_SEARCH_TOOL_NAMES[number];
export const FILE_SEARCH_BYTES = 8 * 1024 * 1024;
export const FILE_SEARCH_TIMEOUT_MS = 10_000;
export const FILE_SEARCH_PREVIEW_BYTES = 64 * 1024;

const commonParameters = {
  path: Type.Optional(Type.String({ minLength: 1, description: "现有目录，相对工作目录或绝对路径；默认工作目录，须在当前读取范围内。越界时请拥有者先通过路径授予入口开放。" })),
  glob: Type.Optional(Type.String({ minLength: 1, maxLength: 512, description: "单个 rg 文件路径 glob，最多512字符；显式指定可覆盖 ignore 和隐藏过滤，但不扩大读取范围。" })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, description: "预览条目数，默认100，范围1–200；不限制原流捕获。" })),
};
const description = "无 glob 时遵循根内 ignore 并跳过隐藏文件；显式 glob 沿 rg 覆盖语义。跳过二进制文件与符号链接，不读取父级或用户全局 ignore/config。返回检索根、相对路径及扫描/预览完整性；最多扫描10秒、捕获8 MiB，预览最多64 KiB。预览裁剪可用 read_artifact 查证据；扫描不完整请收窄 path/glob。结果是观察，后续 read 会重新核实对象。";

export const FILE_SEARCH_DEFINITIONS = [
  { name: "list_files", label: "list_files", description: `递归列出普通文本文件。${description}`, parameters: Type.Object(commonParameters) },
  { name: "search_files", label: "search_files", description: `对文件内容作字面匹配，返回1起行号及最多2048字符的行片段。${description}`, parameters: Type.Object({
    query: Type.String({ minLength: 1, maxLength: 4096, pattern: "^[^\\r\\n]+$", description: "非空字面文本，最多4096字符，不含换行；不解释正则或 Shell 参数。" }),
    ...commonParameters,
    ignore_case: Type.Optional(Type.Boolean({ description: "忽略大小写，默认 false。" })),
  }) },
] as const;

export class FileSearchError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export interface FileSearchParams {
  path?: string;
  glob?: string;
  limit: number;
  query?: string;
  ignore_case?: boolean;
}

export function fileSearchParams(name: FileSearchName, value: Record<string, unknown>): FileSearchParams {
  const invalid = (): never => { throw new FileSearchError("file_search_invalid_params", "检索参数无效；使用现有目录、单个 glob 和1–200的 limit，query 须为不含换行的1–4096字符字面文本。"); };
  const allowed = name === "search_files" ? ["path", "glob", "limit", "query", "ignore_case"] : ["path", "glob", "limit"];
  if (Object.keys(value).some(key => !allowed.includes(key))) invalid();
  for (const key of ["path", "glob"] as const) {
    const text = value[key];
    if (text !== undefined && (typeof text !== "string" || !text.length || text.includes("\0") || (key === "glob" && text.length > 512))) invalid();
  }
  if (value.limit !== undefined && (typeof value.limit !== "number" || !Number.isInteger(value.limit) || value.limit < 1 || value.limit > 200)) invalid();
  if (name === "search_files" && (typeof value.query !== "string" || !value.query.length || value.query.length > 4096 || /[\r\n\0]/.test(value.query))) invalid();
  if (value.ignore_case !== undefined && typeof value.ignore_case !== "boolean") invalid();
  return { path: value.path as string | undefined, glob: value.glob as string | undefined, limit: value.limit as number | undefined ?? 100,
    query: value.query as string | undefined, ignore_case: value.ignore_case as boolean | undefined };
}

export function fileSearchArgv(name: FileSearchName, params: FileSearchParams): string[] {
  const args = ["--no-config", "--no-ignore-parent", "--no-ignore-global", "--no-require-git", "--no-follow", "--threads=1"];
  if (params.glob !== undefined) args.push(`--glob=${params.glob}`);
  if (name === "list_files") args.push("--files", "--null");
  else {
    args.push("--json", "--fixed-strings");
    if (params.ignore_case) args.push("--ignore-case");
    args.push("-e", params.query!);
  }
  return [...args, "--", "."];
}

export interface FileSearchEntry { path: string; line?: number; text?: string; lineTruncated?: boolean }
export interface FileSearchResult {
  root: string;
  entries: FileSearchEntry[];
  capturedCount: number;
  scanComplete: boolean;
  previewTruncated: boolean;
  partial: boolean;
  filtering: string;
  code?: string;
  message?: string;
}

export function searchUtf8(bytes: Buffer): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new FileSearchError("file_search_encoding_unsupported", "发现非 UTF-8 路径，无法无损表示；保留已捕获部分，请收窄到 UTF-8 路径目录。"); }
}

/** rg JSON 的路径 bytes 必须无损；正文 bytes 只用于有界展示。 */
export function rgText(value: { text?: string; bytes?: string }, path: boolean): string {
  if (typeof value.text === "string") return value.text;
  if (typeof value.bytes === "string") return path ? searchUtf8(Buffer.from(value.bytes, "base64")) : Buffer.from(value.bytes, "base64").toString("utf8");
  throw new FileSearchError("file_search_output_invalid", "检索输出格式无效；保留已捕获部分，请向拥有者报告并检查 rg 安装。");
}
