/* ============================================================
 * QBJD MUSE · 写入服务（唯一写者）
 * ============================================================
 * 设计要点（都是为了根治旧版的两个病根）：
 *  1) 旧版：前端拿着 GitHub token，把整份 likes.json 读出来改完再整体覆盖写回
 *     → 两个人同时操作，后写的把先写的整份抹掉（这就是"数据流失"）。
 *     新版：token 只存在于本服务端；每次操作走 Git Data API 打成一个新提交，
 *     并且用"读 ref → 建 blob → 建 tree → 建 commit → 更新 ref"的 CAS 循环，
 *     ref 被人抢先更新时（非 fast-forward）整段重做，绝不会覆盖别人的数据。
 *  2) 旧版：一次点赞产生多个提交、触发多次 Pages 构建。
 *     新版：一次操作 = 一个提交（wall + version + 收件箱文件一起进），
 *     把 Pages 构建次数压到最低。
 *
 * 数据结构（数据仓库内）：
 *   state/wall.json        回忆墙全量快照（照片记录 + 点赞名单 + 评论数）
 *   state/version.json     版本号（客户端轮询它判断有无新数据，很小）
 *   comments/<照片id>.json 该照片的评论列表（含点赞名单、回复关系）
 *   inbox/<用户名>.json    某人的通知收件箱（最新在前，最多 200 条）
 *   photos/<文件名>        原图
 *   photos/thumb_<文件名>  缩略图
 *
 * 环境变量：
 *   GH_TOKEN        细粒度 token，只给数据仓库 Contents: Read and write
 *   GH_OWNER        数据仓库所属账号
 *   GH_REPO         数据仓库名
 *   GH_BRANCH       分支（默认 main）
 *   SESSION_SECRET  随机字符串，用于签发登录令牌
 *   PASSCODE_HASH   共享密码的 SHA-256（十六进制小写）
 *   ALLOWED_USERS   允许的名单，逗号分隔
 * ============================================================ */

const GH_API = "https://api.github.com";
const MAX_INBOX = 200;
const MAX_ATTEMPTS = 6;

/* ---------- 基础工具 ---------- */
const enc = new TextEncoder();
const dec = new TextDecoder();

function utf8ToBase64(str) {
  const bytes = enc.encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}
function base64ToUtf8(b64) {
  const bin = atob(String(b64).replace(/\s+/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return dec.decode(bytes);
}
function timingSafeEqual(a, b) {
  const x = String(a), y = String(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}
async function sha256Hex(str) {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(str));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function randomId(n = 12) {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(36).padStart(2, "0")).join("").slice(0, n * 2);
}
async function hmacHex(key, data) {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, enc.encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* ---------- 环境 ---------- */
function config(env) {
  const owner = env.GH_OWNER || "";
  const repo = env.GH_REPO || "";
  const branch = env.GH_BRANCH || "main";
  if (!owner || !repo) throw new Error("服务端未配置 GH_OWNER / GH_REPO");
  if (!env.GH_TOKEN) throw new Error("服务端未配置 GH_TOKEN");
  return {
    owner, repo, branch, token: env.GH_TOKEN,
    secret: env.SESSION_SECRET || "",
    pass: env.PASSCODE_HASH || "",
    mqttSecret: env.MQTT_SECRET || "",
    mqttUrl: env.MQTT_URL || "wss://broker.emqx.io:8084/mqtt",
  };
}
function users(env) {
  return String(env.ALLOWED_USERS || "")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}
const displayName = (env, name) => {
  const hit = users(env).find((u) => u === String(name || "").trim().toLowerCase());
  return hit || String(name || "").trim();
};

/* ---------- MQTT 话题 ----------
 * 每人一个专属主题，主题名由服务端用密钥算出来（客户端只拿到自己的那一串，
 * 不在前端公开任何全局密钥）。推送不经过 GitHub，所以是"秒到"而不是等构建。 */
async function topicBase(cfg) {
  if (!cfg.mqttSecret) return "";
  return "qbjd/" + (await hmacHex(cfg.mqttSecret, "base")).slice(0, 12);
}
async function userTopic(cfg, user) {
  const base = await topicBase(cfg);
  if (!base) return "";
  const safe = String(user || "").toLowerCase().replace(/[^a-z0-9_-]/g, "");
  return safe ? base + "/u/" + safe : "";
}

/* ---------- GitHub API ---------- */
async function gh(cfg, path, init) {
  const res = await fetch(GH_API + `/repos/${cfg.owner}/${cfg.repo}` + path, {
    ...init,
    headers: {
      Authorization: "Bearer " + cfg.token,
      Accept: "application/vnd.github+json",
      "User-Agent": "qbjd-muse-write-api",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init && init.headers ? init.headers : {}),
    },
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) {}
  return { ok: res.ok, status: res.status, json, text };
}

/* 读一个文件：小文件走 Contents API（带 sha），大文件退回 Blobs API */
async function readFile(cfg, path, ref) {
  const r = await gh(cfg, `/contents/${encodeURI(path)}?ref=${encodeURIComponent(ref)}`, { method: "GET" });
  if (r.status === 404) return { exists: false, text: null, sha: null };
  if (!r.ok) throw new Error("读取 " + path + " 失败: HTTP " + r.status);
  const meta = r.json || {};
  if (meta.content && meta.encoding === "base64") {
    return { exists: true, text: base64ToUtf8(meta.content), sha: meta.sha, size: meta.size };
  }
  /* 文件较大时 Contents API 不返回内容，用 blob sha 取 */
  if (meta.sha) {
    const b = await gh(cfg, `/git/blobs/${meta.sha}`, { method: "GET" });
    if (b.ok && b.json && b.json.content) {
      return { exists: true, text: base64ToUtf8(b.json.content), sha: meta.sha, size: meta.size };
    }
  }
  return { exists: true, text: null, sha: meta.sha, size: meta.size };
}

/* 一次提交写多个文件（可删），返回新提交 sha；ref 被抢先更新时抛 CONFLICT */
async function commitFiles(cfg, files, message) {
  const refRes = await gh(cfg, `/git/ref/heads/${cfg.branch}`, { method: "GET" });
  if (!refRes.ok) throw new Error("读取分支失败: HTTP " + refRes.status);
  const parentSha = refRes.json.object.sha;
  const parent = await gh(cfg, `/git/commits/${parentSha}`, { method: "GET" });
  if (!parent.ok) throw new Error("读取父提交失败: HTTP " + parent.status);
  const baseTree = parent.json.tree.sha;

  const tree = [];
  for (const f of files) {
    if (f.delete) { tree.push({ path: f.path, mode: "100644", type: "blob", sha: null }); continue; }
    const content = f.base64 != null ? f.base64 : utf8ToBase64(f.text);
    const blob = await gh(cfg, `/git/blobs`, { method: "POST", body: JSON.stringify({ content, encoding: "base64" }) });
    if (!blob.ok) throw new Error("写 blob 失败(" + f.path + "): HTTP " + blob.status);
    tree.push({ path: f.path, mode: "100644", type: "blob", sha: blob.json.sha });
  }

  const newTree = await gh(cfg, `/git/trees`, { method: "POST", body: JSON.stringify({ base_tree: baseTree, tree }) });
  if (!newTree.ok) throw new Error("建 tree 失败: HTTP " + newTree.status);
  const newCommit = await gh(cfg, `/git/commits`, {
    method: "POST",
    body: JSON.stringify({ message, tree: newTree.json.sha, parents: [parentSha] }),
  });
  if (!newCommit.ok) throw new Error("建 commit 失败: HTTP " + newCommit.status);
  const move = await gh(cfg, `/git/refs/heads/${cfg.branch}`, {
    method: "PATCH",
    body: JSON.stringify({ sha: newCommit.json.sha, force: false }),
  });
  if (!move.ok) {
    const err = new Error("分支被抢先更新，需要重做本次操作（HTTP " + move.status + "）");
    err.conflict = true;
    throw err;
  }
  return { commit: newCommit.json.sha, version: Date.now() };
}

/* ---------- 数据读写 ---------- */
const emptyWall = () => ({ v: 0, updatedAt: 0, memories: [] });

async function loadWall(cfg) {
  const f = await readFile(cfg, "state/wall.json", cfg.branch);
  if (!f.exists || !f.text) return emptyWall();
  try {
    const w = JSON.parse(f.text);
    if (!Array.isArray(w.memories)) w.memories = [];
    return w;
  } catch (_) { return emptyWall(); }
}
async function loadInbox(cfg, user) {
  const f = await readFile(cfg, "inbox/" + String(user).toLowerCase() + ".json", cfg.branch);
  if (!f.exists || !f.text) return [];
  try { const a = JSON.parse(f.text); return Array.isArray(a) ? a : []; } catch (_) { return []; }
}
async function loadComments(cfg, photoId) {
  const f = await readFile(cfg, "comments/" + photoId + ".json", cfg.branch);
  if (!f.exists || !f.text) return [];
  try { const a = JSON.parse(f.text); return Array.isArray(a) ? a : []; } catch (_) { return []; }
}
const wallFile = (wall, at) => ({ path: "state/wall.json", text: JSON.stringify({ ...wall, updatedAt: at }, null, 2) });
const versionFile = (at) => ({ path: "state/version.json", text: JSON.stringify({ v: at, at }, null, 2) });
const inboxFile = (user, list) => ({ path: "inbox/" + String(user).toLowerCase() + ".json", text: JSON.stringify(list.slice(0, MAX_INBOX), null, 2) });

/* 把事件投递到若干人的收件箱；返回需要写入的文件（追加） */
async function deliver(cfg, recipients, event, out) {
  for (const who of recipients) {
    if (!who) continue;
    if (event.actor && who.toLowerCase() === String(event.actor).toLowerCase()) continue; /* 自己操作不通知自己 */
    const list = await loadInbox(cfg, who);
    out.push(inboxFile(who, [event, ...list.filter((e) => e.id !== event.id)]));
  }
}

/* ---------- 业务操作（每个操作 = 读状态 → 变更 → 一次提交 → CAS 重试） ---------- */

/* 上传照片：新增照片记录 + 事件（通知除自己以外的所有人） */
async function opUpload(cfg, env, actor, p) {
  const wall = await loadWall(cfg);
  const id = p.fileName || `${Date.now()}-${randomId(6)}.jpeg`;
  const at = Date.now();
  const memory = {
    id,
    createdAt: p.createdAt || at,
    author: actor,
    story: p.story || "",
    season: Number.isInteger(p.season) ? p.season : null,
    likes: [],
    commentCount: 0,
    w: p.w || 0,
    h: p.h || 0,
    image: "photos/" + id,
    thumb: "photos/thumb_" + id,
  };
  wall.memories = [memory, ...wall.memories.filter((m) => m.id !== id)];
  const event = { id: randomId(10), type: "new_photo", actor, photoId: id, at, text: "" };
  const files = [
    { path: "photos/" + id, base64: p.imageBase64 },
    { path: "photos/thumb_" + id, base64: p.thumbBase64 || p.imageBase64 },
    wallFile(wall, at),
    versionFile(at),
  ];
  const recipients = users(env).filter((u) => u !== actor.toLowerCase());
  await deliver(cfg, recipients, event, files);
  const r = await commitFiles(cfg, files, `add memory ${id} by ${actor}`);
  return { event, recipients, wall, version: at, commit: r.commit };
}

/* 点赞 / 取消点赞照片 */
async function opLikePhoto(cfg, env, actor, p) {
  const wall = await loadWall(cfg);
  const m = wall.memories.find((x) => x.id === p.photoId);
  if (!m) throw new HttpError(404, "照片不存在");
  const me = actor.toLowerCase();
  m.likes = Array.isArray(m.likes) ? m.likes : [];
  const had = m.likes.some((u) => String(u).toLowerCase() === me);
  const at = Date.now();
  const add = p.add !== false;
  const files = [];
  let event = null;
  const recipients = [m.author];
  if (add && !had) {
    m.likes.push(actor);
    event = { id: randomId(10), type: "like_photo", actor, photoId: m.id, at, text: "" };
  } else if (!add && had) {
    m.likes = m.likes.filter((u) => String(u).toLowerCase() !== me);
    /* 取消点赞不产生通知（避免骚扰） */
  }
  if (event) await deliver(cfg, recipients, event, files);
  if (!files.length && !event && ((add && had) || (!add && !had))) {
    return { event: null, version: wall.v || 0, wall, noop: true };   /* 幂等：重复操作直接成功 */
  }
  files.push(wallFile(wall, at), versionFile(at));
  const r = await commitFiles(cfg, files, `${add ? "like" : "unlike"} ${m.id} by ${actor}`);
  return { event, recipients: event ? recipients : [], wall, version: at, commit: r.commit };
}

/* 评论照片 或 回复某条评论 */
async function opComment(cfg, env, actor, p) {
  const wall = await loadWall(cfg);
  const m = wall.memories.find((x) => x.id === p.photoId);
  if (!m) throw new HttpError(404, "照片不存在");
  const list = await loadComments(cfg, p.photoId);
  const at = Date.now();
  const row = {
    id: randomId(12),
    author: actor,
    text: String(p.text || "").slice(0, 1000),
    createdAt: at,
    likes: [],
    replyTo: p.replyTo || null,
  };
  if (!row.text.trim()) throw new HttpError(400, "评论不能为空");
  list.push(row);
  m.commentCount = list.length;
  const files = [
    { path: "comments/" + p.photoId + ".json", text: JSON.stringify(list, null, 2) },
    wallFile(wall, at),
    versionFile(at),
  ];
  const parent = p.replyTo ? list.find((c) => c.id === p.replyTo) : null;
  const event = parent
    ? { id: randomId(10), type: "reply_comment", actor, photoId: p.photoId, commentId: row.id, parentCommentId: parent.id, at, text: row.text.slice(0, 80) }
    : { id: randomId(10), type: "comment_photo", actor, photoId: p.photoId, commentId: row.id, at, text: row.text.slice(0, 80) };
  const recipients = parent ? [parent.author] : [m.author];
  await deliver(cfg, recipients, event, files);
  const r = await commitFiles(cfg, files, `${parent ? "reply" : "comment"} on ${p.photoId} by ${actor}`);
  return { event, recipients, comment: row, wall, version: at, commit: r.commit };
}

/* 点赞 / 取消点赞某条评论 */
async function opLikeComment(cfg, env, actor, p) {
  const list = await loadComments(cfg, p.photoId);
  const row = list.find((c) => c.id === p.commentId);
  if (!row) throw new HttpError(404, "评论不存在");
  const me = actor.toLowerCase();
  row.likes = Array.isArray(row.likes) ? row.likes : [];
  const had = row.likes.some((u) => String(u).toLowerCase() === me);
  const at = Date.now();
  const add = p.add !== false;
  const files = [{ path: "comments/" + p.photoId + ".json", text: JSON.stringify(list, null, 2) }, versionFile(at)];
  let event = null;
  if (add && !had) {
    row.likes.push(actor);
    event = { id: randomId(10), type: "like_comment", actor, photoId: p.photoId, commentId: row.id, at, text: row.text.slice(0, 80) };
  } else if (!add && had) {
    row.likes = row.likes.filter((u) => String(u).toLowerCase() !== me);
  }
  const recipients = [row.author];
  if (event) await deliver(cfg, recipients, event, files);
  const r = await commitFiles(cfg, files, `${add ? "like" : "unlike"} comment ${row.id} by ${actor}`);
  return { event, recipients: event ? recipients : [], comments: list, version: at, commit: r.commit };
}

/* 保存/修改故事 */
async function opStory(cfg, env, actor, p) {
  const wall = await loadWall(cfg);
  const m = wall.memories.find((x) => x.id === p.photoId);
  if (!m) throw new HttpError(404, "照片不存在");
  if (m.author && m.author.toLowerCase() !== actor.toLowerCase()) throw new HttpError(403, "只能改自己写的回忆");
  const at = Date.now();
  m.story = String(p.story || "").slice(0, 4000);
  await commitFiles(cfg, [wallFile(wall, at), versionFile(at)], `story ${m.id} by ${actor}`);
  return { wall, version: at, event: null };
}

/* 删除回忆（含评论文件清理） */
async function opDelete(cfg, env, actor, p) {
  const wall = await loadWall(cfg);
  const m = wall.memories.find((x) => x.id === p.photoId);
  if (!m) throw new HttpError(404, "照片不存在");
  if (m.author && m.author.toLowerCase() !== actor.toLowerCase()) throw new HttpError(403, "只能删自己上传的回忆");
  const at = Date.now();
  wall.memories = wall.memories.filter((x) => x.id !== p.photoId);
  const files = [
    wallFile(wall, at),
    versionFile(at),
    { path: "comments/" + p.photoId + ".json", delete: true },
    { path: "photos/" + p.photoId, delete: true },
    { path: "photos/thumb_" + p.photoId, delete: true },
  ];
  await commitFiles(cfg, files, `delete memory ${p.photoId} by ${actor}`);
  return { wall, version: at, event: null };
}

/* 删除自己写的评论 */
async function opCommentDelete(cfg, env, actor, p) {
  const list = await loadComments(cfg, p.photoId);
  const row = list.find((c) => c.id === p.commentId);
  if (!row) throw new HttpError(404, "评论不存在");
  if (String(row.author).toLowerCase() !== actor.toLowerCase()) throw new HttpError(403, "只能删自己的评论");
  const at = Date.now();
  const next = list.filter((c) => c.id !== p.commentId);
  const wall = await loadWall(cfg);
  const m = wall.memories.find((x) => x.id === p.photoId);
  if (m) m.commentCount = next.length;
  await commitFiles(cfg, [
    { path: "comments/" + p.photoId + ".json", text: JSON.stringify(next, null, 2) },
    wallFile(wall, at),
    versionFile(at),
  ], `delete comment ${p.commentId} by ${actor}`);
  return { comments: next, wall, version: at, event: null };
}

/* 认领老照片：只在作者为空时生效（防止抢别人的作品） */
async function opClaim(cfg, env, actor, p) {
  const wall = await loadWall(cfg);
  const m = wall.memories.find((x) => x.id === p.photoId);
  if (!m) throw new HttpError(404, "照片不存在");
  if (m.author) {
    return { wall, version: wall.v || 0, noop: true, message: "这张已经有主人了" };
  }
  const at = Date.now();
  m.author = actor;
  await commitFiles(cfg, [wallFile(wall, at), versionFile(at)], `claim ${m.id} by ${actor}`);
  return { wall, version: at, event: null };
}

/* ---------- 会话 ---------- */
async function issueToken(cfg, user) {
  const payload = JSON.stringify({ u: user, exp: Date.now() + 60 * 24 * 3600 * 1000 });
  const p64 = utf8ToBase64(payload).replace(/=+$/, "");
  const sig = await hmacHex(cfg.secret || "dev-secret", p64);
  return p64 + "." + sig;
}
async function verifyToken(cfg, token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 2) return null;
  const sig = await hmacHex(cfg.secret || "dev-secret", parts[0]);
  if (!timingSafeEqual(sig, parts[1])) return null;
  try {
    const payload = JSON.parse(base64ToUtf8(parts[0]));
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload.u;
  } catch (_) { return null; }
}

/* ---------- HTTP ---------- */
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Authorization,Content-Type",
    "Access-Control-Allow-Methods": "POST,GET,OPTIONS",
    "Cache-Control": "no-store",
  },
});

export async function handle(request, env) {
  if (request.method === "OPTIONS") return json({ ok: true });
  const url = new URL(request.url);
  const route = url.pathname.replace(/\/+$/, "");
  let cfg;
  try { cfg = config(env); } catch (e) { return json({ ok: false, error: e.message }, 500); }

  try {
    if (route === "/api/ping") {
      return json({ ok: true, service: "qbjd-muse-write-api", users: users(env).length, branch: cfg.branch });
    }

    if (route === "/api/login") {
      const p = await request.json();
      const name = String(p.user || "").trim();
      const pass = String(p.passcode || "");
      if (!users(env).includes(name.toLowerCase())) return json({ ok: false, error: "not-in-list" }, 403);
      const want = cfg.pass || await sha256Hex("123456");
      const got = await sha256Hex(pass);
      if (!timingSafeEqual(want, got)) return json({ ok: false, error: "bad-passcode" }, 403);
      const user = displayName(env, name);
      return json({
        ok: true, user, token: await issueToken(cfg, user),
        mqtt: { url: cfg.mqttUrl, topic: await userTopic(cfg, user) },
      });
    }

    /* 以下接口都需要登录令牌 */
    const actor = await verifyToken(cfg, (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, ""));
    if (!actor) return json({ ok: false, error: "unauthorized" }, 401);

    if (request.method !== "POST") return json({ ok: false, error: "method-not-allowed" }, 405);
    const p = await request.json();

    let result = null;
    let lastErr = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        if (route === "/api/like") result = await opLikePhoto(cfg, env, actor, p);
        else if (route === "/api/comment") result = await opComment(cfg, env, actor, p);
        else if (route === "/api/comment-like") result = await opLikeComment(cfg, env, actor, p);
        else if (route === "/api/upload") result = await opUpload(cfg, env, actor, p);
        else if (route === "/api/story") result = await opStory(cfg, env, actor, p);
        else if (route === "/api/delete") result = await opDelete(cfg, env, actor, p);
        else if (route === "/api/comment-delete") result = await opCommentDelete(cfg, env, actor, p);
        else if (route === "/api/claim") result = await opClaim(cfg, env, actor, p);
        else if (route === "/api/comments") { result = { comments: await loadComments(cfg, p.photoId) }; }
        else if (route === "/api/wall") { result = { wall: await loadWall(cfg) }; }
        else return json({ ok: false, error: "unknown-route" }, 404);
        break;
      } catch (e) {
        lastErr = e;
        if (!e.conflict) throw e;               /* 只有"分支被抢先更新"才重做 */
      }
    }
    if (!result && lastErr) throw lastErr;
    /* 告诉客户端：这次操作该推给谁（主题），客户端拿到后立即 MQTT 推送 */
    if (result && Array.isArray(result.recipients) && result.recipients.length) {
      const topics = await Promise.all(result.recipients.map((u) => userTopic(cfg, u)));
      result.mqttTopics = topics.filter(Boolean);
    }
    return json({ ok: true, actor, ...result });
  } catch (e) {
    const status = e instanceof HttpError ? e.status : (e && e.conflict ? 409 : 500);
    return json({ ok: false, error: e && e.message ? e.message : String(e), retry: !!(e && e.conflict) }, status);
  }
}

/* Deno Deploy / 标准 fetch 入口 */
export default { fetch: (request, env, ctx) => handle(request, env || globalThis.env || {}) };
