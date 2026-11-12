/* Deno Deploy 入口（Playground 用）：把 server/write-api.js 的处理器挂到 HTTP 上。
 * 环境变量在 Deploy 控制台的 Env Variables 里配置，运行时通过 Deno.env 读取。 */
import handler from "./write-api.js";

Deno.serve((request) => handler.fetch(request, Deno.env.toObject()));
