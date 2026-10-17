/* ============================================================
 * 本地验收测试：不联网、不碰真实仓库，用假 GitHub 验证并发写入
 * 跑法：node server/test-local.mjs
 * ============================================================ */
import { handle } from "./write-api.js";
import { installMockGitHub } from "./mock-github.mjs";

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra ? "  → " + JSON.stringify(extra) : "")); }
}

const sha256Hex = async (s) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))]
  .map((b) => b.toString(16).padStart(2, "0")).join("");

const env = {
  GH_TOKEN: "fake-token",
  GH_OWNER: "o",
  GH_REPO: "r",
  GH_BRANCH: "main",
  SESSION_SECRET: "test-secret",
  PASSCODE_HASH: await sha256Hex("123456"),
  ALLOWED_USERS: "chenjianhao,yangzelin,tanglinshu",
  MQTT_SECRET: "test-mqtt-secret",
};

const mock = installMockGitHub({ owner: "o", repo: "r" });

async function call(route, body, token) {
  const res = await handle(new Request("https://api.test" + route, {
    method: body === undefined ? "GET" : "POST",
    headers: token ? { Authorization: "Bearer " + token, "Content-Type": "application/json" } : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env);
  return { status: res.status, body: await res.json() };
}

console.log("\n[1] 健康检查与登录");
{
  const r = await call("/api/ping");
  check("ping 正常", r.body.ok === true, r.body);
  const bad = await call("/api/login", { user: "chenjianhao", passcode: "000000" });
  check("密码错误被拒绝", bad.status === 403 && bad.body.error === "bad-passcode", bad);
  const notIn = await call("/api/login", { user: "路人甲", passcode: "123456" });
  check("名单外的人被拒绝", notIn.status === 403 && notIn.body.error === "not-in-list", notIn);
}

const tokens = {};
const topics = {};
for (const u of ["chenjianhao", "yangzelin", "tanglinshu"]) {
  const r = await call("/api/login", { user: u, passcode: "123456" });
  check("登录成功 " + u, r.body.ok === true && !!r.body.token, r.body);
  check("登录返回专属 MQTT 主题 " + u,
    !!r.body.mqtt && r.body.mqtt.url.startsWith("wss://") &&
    new RegExp("^qbjd/[0-9a-f]{12}/u/" + u + "$").test(r.body.mqtt.topic),
    r.body.mqtt);
  tokens[u] = r.body.token;
  topics[u] = r.body.mqtt.topic;
}

console.log("\n[2] 上传照片：一次操作 = 一个提交，其余 7 类人收到通知");
let photoId = "";
{
  const before = mock.commitCount;
  const r = await call("/api/upload", {
    fileName: "1791911780302-xx3fpx.jpeg",
    imageBase64: Buffer.from("fake-image-bytes").toString("base64"),
    thumbBase64: Buffer.from("fake-thumb").toString("base64"),
    w: 1200, h: 1600, season: 2, story: "",
  }, tokens["chenjianhao"]);
  photoId = r.body.event && r.body.event.photoId;
  check("上传成功", r.body.ok === true, r.body);
  check("只产生 1 个提交", mock.commitCount - before === 1, { before, after: mock.commitCount });
  check("原图与缩略图都写进仓库", !!mock.read("photos/" + photoId) && !!mock.read("photos/thumb_" + photoId));
  const wall = mock.json("state/wall.json");
  check("回忆墙里有这条记录且作者正确", wall.memories.length === 1 && wall.memories[0].author === "chenjianhao", wall.memories);
  check("上传者本人不会收到自己的通知", mock.read("inbox/chenjianhao.json") === undefined);
  const inboxY = mock.json("inbox/yangzelin.json");
  check("其他人收到 new_photo 通知", Array.isArray(inboxY) && inboxY[0].type === "new_photo" && inboxY[0].actor === "chenjianhao", inboxY);
}

console.log("\n[3] 点赞照片：幂等 + 通知作者");
{
  const r1 = await call("/api/like", { photoId, add: true }, tokens["yangzelin"]);
  check("点赞成功并产生事件", r1.body.ok === true && r1.body.event.type === "like_photo", r1.body);
  check("点赞响应带上了照片作者的推送主题", Array.isArray(r1.body.mqttTopics) && r1.body.mqttTopics[0] === topics["chenjianhao"], r1.body.mqttTopics);
  check("回忆墙里的点赞名单已更新", mock.json("state/wall.json").memories[0].likes.includes("yangzelin"));
  const inboxC = mock.json("inbox/chenjianhao.json");
  check("照片作者收到 like_photo 通知", inboxC[0].type === "like_photo" && inboxC[0].actor === "yangzelin", inboxC[0]);

  const before = mock.commitCount;
  const r2 = await call("/api/like", { photoId, add: true }, tokens["yangzelin"]);
  check("重复点赞是幂等的（不重复计数、不产生提交）",
    r2.body.ok === true && mock.commitCount === before &&
    mock.json("state/wall.json").memories[0].likes.filter((u) => u === "yangzelin").length === 1, r2.body);

  const r3 = await call("/api/like", { photoId, add: false }, tokens["yangzelin"]);
  check("取消点赞生效", r3.body.ok === true && !mock.json("state/wall.json").memories[0].likes.includes("yangzelin"), r3.body);
}

console.log("\n[4] 评论与回复：三种通知分别落到正确的人");
let cid = "";
{
  const r1 = await call("/api/comment", { photoId, text: "这张真好看" }, tokens["tanglinshu"]);
  cid = r1.body.comment.id;
  check("评论照片成功", r1.body.ok === true && r1.body.event.type === "comment_photo", r1.body);
  check("照片作者收到评论通知", mock.json("inbox/chenjianhao.json")[0].type === "comment_photo");
  check("评论文件已生成、评论数同步", mock.json("comments/" + photoId + ".json").length === 1 && mock.json("state/wall.json").memories[0].commentCount === 1);

  const r2 = await call("/api/comment", { photoId, text: "我也这么觉得", replyTo: cid }, tokens["yangzelin"]);
  check("回复评论成功", r2.body.ok === true && r2.body.event.type === "reply_comment", r2.body);
  check("被回复的人（评论作者）收到通知，且带着被回复的那条评论 id",
    mock.json("inbox/tanglinshu.json")[0].type === "reply_comment" && mock.json("inbox/tanglinshu.json")[0].parentCommentId === cid,
    mock.json("inbox/tanglinshu.json")[0]);

  const r3 = await call("/api/comment-like", { photoId, commentId: cid, add: true }, tokens["chenjianhao"]);
  check("点赞评论成功", r3.body.ok === true && r3.body.event.type === "like_comment", r3.body);
  check("评论作者收到 like_comment 通知", mock.json("inbox/tanglinshu.json")[0].type === "like_comment");

  const delOther = await call("/api/comment-delete", { photoId, commentId: cid }, tokens["yangzelin"]);
  check("不能删别人的评论", delOther.status === 403, delOther.body);
  const delOwn = await call("/api/comment-delete", { photoId, commentId: cid }, tokens["tanglinshu"]);
  check("可以删自己的评论，评论数同步", delOwn.body.ok === true && mock.json("state/wall.json").memories[0].commentCount === 1, delOwn.body);
}

console.log("\n[4b] 老照片认领（作者为空时才能认领，有主就锁死）");
{
  const wall = mock.json("state/wall.json");
  wall.memories.push({ id: "legacy-1.jpeg", createdAt: 1, author: "", story: "", season: 0, likes: [], commentCount: 0, w: 1, h: 1, image: "photos/legacy-1.jpeg", thumb: "photos/thumb_legacy-1.jpeg" });
  mock.commitPath("state/wall.json", JSON.stringify(wall), "import legacy photo");

  const c1 = await call("/api/claim", { photoId: "legacy-1.jpeg" }, tokens["yangzelin"]);
  check("无主的老照片可以被认领", c1.body.ok === true && mock.json("state/wall.json").memories.find((m) => m.id === "legacy-1.jpeg").author === "yangzelin", c1.body);
  const c2 = await call("/api/claim", { photoId: "legacy-1.jpeg" }, tokens["tanglinshu"]);
  check("已有主人的照片不能被抢走", c2.body.noop === true && mock.json("state/wall.json").memories.find((m) => m.id === "legacy-1.jpeg").author === "yangzelin", c2.body);
}

console.log("\n[5] 并发保护（旧版最致命的 bug）：别人抢先提交时不能覆盖");
{
  const before = mock.json("state/wall.json");
  mock.injectConflict();                       /* 模拟"你读到状态后、提交前，别人先提交了" */
  const r = await call("/api/like", { photoId, add: true }, tokens["tanglinshu"]);
  const after = mock.json("state/wall.json");
  check("冲突后自动重做并成功", r.body.ok === true, r.body);
  check("没有被覆盖：对方的故事改动仍在", String(after.memories[0].story).includes("[外人改动]"), after.memories[0]);
  check("本次点赞也生效了（两边都在）", after.memories[0].likes.includes("tanglinshu"), after.memories[0].likes);
  check("原有数据没丢", after.memories.length === before.memories.length && after.memories[0].author === "chenjianhao");
}

console.log("\n[6] 故事修改权限 + 删除回忆");
{
  const denied = await call("/api/story", { photoId, story: "我要改别人的" }, tokens["yangzelin"]);
  check("不能改别人写的回忆", denied.status === 403, denied.body);
  const ok = await call("/api/story", { photoId, story: "那天下午的太阳" }, tokens["chenjianhao"]);
  check("作者可以改故事", ok.body.ok === true && mock.json("state/wall.json").memories[0].story === "那天下午的太阳");

  const cToo = await call("/api/comment", { photoId, text: "x" }, tokens["yangzelin"]);
  check("评论接口仍可用（为删除测试准备）", cToo.body.ok === true);
  const del = await call("/api/delete", { photoId }, tokens["chenjianhao"]);
  check("作者可以删除回忆（该条从墙上消失，其它记录保留）",
    del.body.ok === true &&
    !mock.json("state/wall.json").memories.some((m) => m.id === photoId) &&
    mock.json("state/wall.json").memories.length === 1, del.body);
  check("关联评论文件被清理", mock.read("comments/" + photoId + ".json") === undefined);
  check("照片文件被清理", mock.read("photos/" + photoId) === undefined && mock.read("photos/thumb_" + photoId) === undefined);

  const delByOther = await call("/api/delete", { photoId }, tokens["yangzelin"]);
  check("别人删不掉（记录已不存在，返回 404）", delByOther.status === 404);
}

console.log("\n[7] 令牌校验");
{
  const r = await call("/api/like", { photoId, add: true }, "bad.token");
  check("伪造令牌被拒绝", r.status === 401, r.body);
}

console.log(`\n结果：${pass} 项通过，${fail} 项失败（提交总数 ${mock.commitCount}）`);
mock.restore();
process.exit(fail === 0 ? 0 : 1);
