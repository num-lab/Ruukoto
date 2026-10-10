/**
 * 校验暂存区的文件以恰好一个换行结尾。
 * `git diff --cached --check` 管行尾空白与末尾空行，但不检测「末尾缺换行」，
 * 本脚本补上这一项。空文件与二进制文件不判。
 *
 * 用法（pre-commit 调用）：node scripts/check-staged-eol.mjs
 */

import { execFileSync } from "node:child_process";

/** 二进制或不应判定的扩展名。 */
const SKIP = /\.(png|jpe?g|gif|webp|ico|pdf|woff2?|ttf|otf|zip|gz|tgz|wasm|snap)$/i;

/** 取暂存区文件内容；文件已删除或不存在时返回 null。 */
function stagedContent(path) {
  try {
    return execFileSync("git", ["show", `:${path}`], { maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return null;
  }
}

const status = execFileSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACM", "-z"], { encoding: "utf8" });
const paths = status.split("\0").filter(Boolean);
const problems = [];

for (const path of paths) {
  if (SKIP.test(path)) continue;
  const content = stagedContent(path);
  if (content === null || content.length === 0) continue;
  // 含 NUL 视为二进制，跳过。
  if (content.includes(0)) continue;
  const text = content.toString("utf8");
  if (!text.endsWith("\n")) problems.push(`${path}：文件末尾缺少换行`);
  else if (text.endsWith("\n\n")) problems.push(`${path}：文件末尾有多余空行`);
}

if (problems.length === 0) {
  console.log(`check-staged-eol：${paths.length} 个暂存文件的行尾换行均正确。`);
  process.exit(0);
}

console.error("check-staged-eol：暂存文件的行尾换行不合规：");
for (const problem of problems) console.error(`  ${problem}`);
console.error("\n约定：文件以恰好一个换行结尾。");
process.exit(1);
