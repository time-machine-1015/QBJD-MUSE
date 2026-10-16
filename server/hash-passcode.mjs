/* 生成部署时要填的两个值（在你自己电脑上跑，密码不会离开这台机器）
 * 用法：node server/hash-passcode.mjs 你的共享密码
 */
import { randomBytes } from "node:crypto";

const pass = process.argv.slice(2).join(" ").trim();

if (!pass) {
  console.log("用法：node server/hash-passcode.mjs 你的共享密码");
  process.exit(1);
}

const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(pass));
const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");

console.log("");
console.log("把下面两行分别填进 Deno Deploy 的环境变量（不要写进任何文件、不要发到群里）：");
console.log("");
console.log("PASSCODE_HASH=" + hash);
console.log("SESSION_SECRET=" + randomBytes(32).toString("base64url"));
console.log("");
