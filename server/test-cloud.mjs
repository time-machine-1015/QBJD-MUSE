/* ============================================================
 * 前端数据层（cloud.js）测试：不联网，用假的 fetch / localStorage 跑
 * 跑法：node server/test-cloud.mjs
 * 目的：确认 cloud.js 暴露的字段和 index.html 期望的完全一致，
 *       以及读（Pages 快照）、写（云函数）两条路上的数据形状都对。
 * ============================================================ */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra !== undefined ? "  → " + JSON.stringify(extra) : "")); }
}

/* ---------- 造一个最小的浏览器环境 ---------- */
const store = new Map();
const localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
const calls = [];
let handler = () => { throw new Error("no handler"); };
const fetchStub = async (url, init) => { calls.push({ url, init }); return handler(url, init); };
const window = { addEventListener() {} };

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "..", "cloud.js"), "utf8");
const factory = new Function("window", "localStorage", "fetch", "indexedDB", "document", "Image", "FileReader", src + "\n;return window.MuseCloud;");
const MuseCloud = factory(window, localStorage, fetchStub, {}, {}, function () {}, function () {});

const API = "https://api.example.dev";
const DATA = "https://user.github.io/QBJD-MUSE-data";
const okJson = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

console.log("\n[1] 配置与登录");
MuseCloud.setConfig(API, DATA);
check("配置后 configured() = true", MuseCloud.configured() === true);
check("未登录时 loggedIn() = false", MuseCloud.loggedIn() === false);
{
  handler = async (url, init) => {
    const body = JSON.parse(init.body);
    if (url !== API + "/api/login") throw new Error("错误地址 " + url);
    if (body.user === "chenjianhao" && body.passcode === "123456") return okJson({ ok: true, user: "chenjianhao", token: "tk-1" });
    return okJson({ ok: false, error: "bad-passcode" }, 403);
  };
  let err = null;
  try { await MuseCloud.login("chenjianhao", "wrong"); } catch (e) { err = e; }
  check("密码错误会抛错并带上服务端原因", err && err.message === "bad-passcode" && err.status === 403, err && err.message);

  const user = await MuseCloud.login("chenjianhao", "123456");
  check("登录成功返回用户名", user === "chenjianhao");
  check("登录后 loggedIn() = true", MuseCloud.loggedIn() === true);
  check("令牌写进了本机存储", store.get("muse_token_v1") === "tk-1");
}

console.log("\n[2] 读回忆墙（Pages 快照 → 页面认识的结构）");
{
  const wall = {
    v: 7, updatedAt: 1,
    memories: [
      { id: "b.jpeg", createdAt: 200, author: "yangzelin", story: "第二张", season: 2, likes: ["chenjianhao"], commentCount: 3, w: 100, h: 200, image: "photos/b.jpeg", thumb: "photos/thumb_b.jpeg" },
      { id: "a.jpeg", createdAt: 100, author: "", story: "", season: null, likes: [], commentCount: 0, w: 10, h: 20, image: "photos/a.jpeg", thumb: "photos/thumb_a.jpeg" },
    ],
  };
  handler = async (url) => {
    if (url.startsWith(DATA + "/state/wall.json")) return okJson(wall);
    if (url.includes("comments/a.jpeg")) return okJson([{ id: "c1", author: "yangzelin", text: "好", createdAt: 5, likes: [], replyTo: null }]);
    if (url.includes("state/version.json")) return okJson({ v: 7, at: 1 });
    throw new Error("未预期的地址 " + url);
  };
  const list = await MuseCloud.loadWall();
  check("按时间倒序", list[0].id === "b.jpeg" && list[1].id === "a.jpeg", list.map((m) => m.id));
  const b = list[0];
  check("字段与旧版一致（页面不用改）",
    b.id === "b.jpeg" && b.story === "第二张" && b.author === "yangzelin" &&
    b.likes === 1 && b.liked === true && b.commentCount === 3 && b.w === 100 && typeof b.url === "string" && typeof b.thumbUrl === "string",
    b);
  check("图片走数据仓库 Pages，并保留旧站兜底",
    b.thumbUrl === DATA + "/photos/thumb_b.jpeg" && b.sbThumb === "https://time-machine-1015.github.io/QBJD-MUSE/photos/thumb_b.jpeg",
    { thumbUrl: b.thumbUrl, sbThumb: b.sbThumb });
  check("别人的赞不算在我头上", list[1].liked === false);
  check("无主的老照片 author 为空（可认领）", list[1].author === "");

  const cmts = await MuseCloud.loadComments("a.jpeg");
  check("评论按需单独拉取", cmts.length === 1 && cmts[0].text === "好");
  check("版本号可读（客户端轮询用）", (await MuseCloud.version()) === 7);
  check("请求都带了缓存穿透参数", calls.every((c) => c.url.includes("?cb=") || c.url.startsWith(API)));
}

console.log("\n[3] 空仓库与断网的行为");
{
  handler = async () => new Response("nf", { status: 404 });
  MuseCloud.cacheWall([]);
  const list = await MuseCloud.loadWall();
  check("数据仓库还没有内容时显示空墙（不报错）", Array.isArray(list) && list.length === 0);

  /* 先缓存一份，再断网 */
  handler = async (url) => (url.includes("wall.json") ? okJson({ memories: [{ id: "x.jpeg", createdAt: 9, likes: [], commentCount: 0, image: "photos/x.jpeg", thumb: "photos/thumb_x.jpeg" }] }) : new Response("", { status: 404 }));
  await MuseCloud.loadWall();
  handler = async () => { throw new TypeError("Failed to fetch"); };
  const off = await MuseCloud.loadWall();
  check("断网时用本地快照兜底（不会白屏）", off.length === 1 && off[0].id === "x.jpeg", off);
}

console.log("\n[4] 写操作：地址、方法、鉴权头都对");
{
  const seen = [];
  handler = async (url, init) => {
    seen.push({ url, method: init.method, auth: init.headers.Authorization, body: JSON.parse(init.body) });
    if (url.endsWith("/api/like")) return okJson({ ok: true, event: { type: "like_photo" } });
    if (url.endsWith("/api/comment")) return okJson({ ok: true, comment: { id: "c9", author: "chenjianhao", text: "hi", createdAt: 1, likes: [], replyTo: null } });
    if (url.endsWith("/api/comment-like")) return okJson({ ok: true });
    if (url.endsWith("/api/comment-delete")) return okJson({ ok: true });
    if (url.endsWith("/api/story")) return okJson({ ok: true });
    if (url.endsWith("/api/delete")) return okJson({ ok: true });
    if (url.endsWith("/api/claim")) return okJson({ ok: true, noop: true, message: "这张已经有主人了" });
    return okJson({ ok: false, error: "unknown" }, 404);
  };
  await MuseCloud.setLike("x.jpeg", true);
  check("点赞带上了登录令牌", seen.at(-1).auth === "Bearer tk-1" && seen.at(-1).url === API + "/api/like");
  await MuseCloud.setLike("x.jpeg", false);
  check("取消点赞传 add=false", seen.at(-1).body.add === false);
  const row = await MuseCloud.addComment("x.jpeg", "hi");
  check("发表评论返回评论体", row.comment && row.comment.id === "c9" && seen.at(-1).body.text === "hi");
  await MuseCloud.addComment("x.jpeg", "reply", "c9");
  check("回复评论带 replyTo", seen.at(-1).body.replyTo === "c9");
  await MuseCloud.likeComment("x.jpeg", "c9", true);
  check("点赞评论接口正确", seen.at(-1).url === API + "/api/comment-like" && seen.at(-1).body.commentId === "c9");
  await MuseCloud.deleteComment("x.jpeg", "c9");
  check("删评论带上照片 id", seen.at(-1).body.photoId === "x.jpeg" && seen.at(-1).body.commentId === "c9");
  await MuseCloud.saveStory("x.jpeg", "故事");
  check("保存故事接口正确", seen.at(-1).body.story === "故事");
  await MuseCloud.deleteMemory("x.jpeg");
  check("删除接口正确", seen.at(-1).url === API + "/api/delete");
  const c = await MuseCloud.claim("x.jpeg");
  check("认领接口把服务端的提示带回来", c.noop === true && c.message === "这张已经有主人了", c);
}

console.log("\n[5] 退出登录与未配置状态");
{
  MuseCloud.logout();
  check("退出后 loggedIn() = false", MuseCloud.loggedIn() === false && MuseCloud.currentUser() === "");
  let err = null;
  try { await MuseCloud.setLike("x.jpeg", true); } catch (e) { err = e; }
  check("退出后写操作被拦住并给出原因", !!err, err && err.message);

  MuseCloud.setConfig("", "");
  check("没配置云端地址时 configured() = false（页面自动退回本机模式）", MuseCloud.configured() === false);
  err = null;
  try { await MuseCloud.loadWall(); } catch (e) { err = e; }
  check("未配置时读也不报错崩溃（抛出可捕获的提示）", err && /尚未配置/.test(err.message), err && err.message);
}

console.log(`\n结果：${pass} 项通过，${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
