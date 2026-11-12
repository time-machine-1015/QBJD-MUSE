/* ============================================================
 * QBJD MUSE · 前端数据层（cloud.js）
 * ============================================================
 * 职责：
 *   读 → 数据仓库的 GitHub Pages（免 token、不限次数、带缓存穿透参数）
 *   写 → 我们自己的云函数（唯一写者，token 只在服务端）
 *   本地 → 快照缓存，断网也能看回忆墙；上传失败进队列，联网自动补传
 *
 * 部署后只需要填下面 CFG 里的两个地址，其余代码不用动。
 * ============================================================ */
window.MuseCloud = (function () {
  const CFG = {
    /* 云端地址：读 = 数据仓库的 raw 源（不经 Pages 构建，永不存在 404 窗口，且 query 可穿透缓存、更新秒级可见）；
       写 = Deno Deploy 云函数 */
    API: "https://qbjd-muse-write.time-machine-1015.deno.net",
    DATA: "https://raw.githubusercontent.com/time-machine-1015/QBJD-MUSE-data/main",

    LEGACY_PHOTOS: "https://time-machine-1015.github.io/QBJD-MUSE/photos/",   /* 旧站照片兜底 */
    MQTT: "wss://broker.emqx.io:8084/mqtt",                                   /* 阶段 3 用 */
    WALL_CACHE_KEY: "muse_wall_v1",
    TOKEN_KEY: "muse_token_v1",
    USER_KEY: "muse_cloud_user_v1",
    MQTT_KEY: "muse_mqtt_v1",
    NOTIF_KEY: "muse_notifs_v1",
    LAST_VER_KEY: "muse_last_ver_v1",
    QUEUE_DB: "qbjd-muse-queue",
  };

  const configured = () => !!CFG.API && !!CFG.DATA;
  const read = (k) => { try { return localStorage.getItem(k) || ""; } catch (_) { return ""; } };
  const write = (k, v) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch (_) {} };

  let token = read(CFG.TOKEN_KEY);
  let user = read(CFG.USER_KEY);
  let mqttInfo = (() => { try { return JSON.parse(read(CFG.MQTT_KEY) || "{}") || {}; } catch (_) { return {}; } })();

  const loggedIn = () => configured() && !!token && !!user;
  const currentUser = () => user || "";

  function setConfig(api, data) {
    CFG.API = String(api || "").replace(/\/+$/, "");
    CFG.DATA = String(data || "").replace(/\/+$/, "");
  }

  /* ---------- 网络 ---------- */
  async function api(route, body, timeoutMs = 25000) {
    if (!configured()) throw new Error("尚未配置云端地址");
    /* 没登录就直接拦下，别白跑一趟网络（登录接口本身不需要令牌） */
    if (route !== "/api/login" && !loggedIn()) {
      const e = new Error("请先登录");
      e.status = 401;
      throw e;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(CFG.API + route, {
        method: "POST",
        headers: Object.assign({ "Content-Type": "application/json" }, token ? { Authorization: "Bearer " + token } : {}),
        body: JSON.stringify(body || {}),
        signal: ctrl.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) {
        const err = new Error(data.error || ("HTTP " + res.status));
        err.status = res.status;
        throw err;
      }
      return data;
    } finally { clearTimeout(timer); }
  }

  /* ---------- 登录 ---------- */
  async function login(name, passcode) {
    const r = await api("/api/login", { user: name, passcode });
    token = r.token; user = r.user;
    write(CFG.TOKEN_KEY, token); write(CFG.USER_KEY, user);
    if (r.mqtt && r.mqtt.topic) {
      mqttInfo = r.mqtt;
      write(CFG.MQTT_KEY, JSON.stringify(r.mqtt));
    }
    try { localStorage.setItem("muse_name", user); } catch (_) {}
    startRealtime(mqttInfo);
    startPolling();
    return user;
  }
  function logout() {
    stopRealtime();
    stopPolling();
    token = ""; user = "";
    write(CFG.TOKEN_KEY, ""); write(CFG.USER_KEY, ""); write(CFG.MQTT_KEY, "");
  }

  /* ---------- 读 ---------- */
  function snapshotUrl(path) {
    return CFG.DATA + "/" + String(path).replace(/^\/+/, "") + "?cb=" + Date.now();
  }

  /* 把仓库里的记录转成页面认识的结构（字段名与旧版保持一致，页面代码不用改） */
  function toMemory(r) {
    const likes = Array.isArray(r.likes) ? r.likes : [];
    const me = currentUser();
    const image = r.image || ("photos/" + r.id);
    const thumb = r.thumb || image;
    return {
      id: r.id,
      createdAt: r.createdAt || Date.now(),
      story: r.story || "",
      author: r.author || "",
      season: r.season === undefined ? null : r.season,
      likes: likes.length,
      liked: !!me && likes.some((u) => String(u).toLowerCase() === me.toLowerCase()),
      likedBy: likes,
      comments: [],
      commentCount: r.commentCount || 0,
      image_path: r.id,
      url: CFG.DATA + "/" + image,
      thumbUrl: CFG.DATA + "/" + thumb,
      sbUrl: CFG.LEGACY_PHOTOS + r.id,                 /* 旧站兜底（图片加载失败时自动切换） */
      sbThumb: CFG.LEGACY_PHOTOS + "thumb_" + r.id,
      w: r.w || 0, h: r.h || 0,
    };
  }

  async function loadWall() {
    if (!configured()) throw new Error("尚未配置云端地址");
    let res;
    try {
      res = await fetch(snapshotUrl("state/wall.json"), { cache: "no-store" });
    } catch (e) {
      const cached = read(CFG.WALL_CACHE_KEY);
      if (cached) { try { return JSON.parse(cached).map(toMemory); } catch (_) {} }
      throw e;
    }
    if (res.status === 404) { cacheWall([]); return []; }        /* 数据仓库刚建好还没内容 */
    if (!res.ok) throw new Error("回忆墙读取失败 HTTP " + res.status);
    const wall = await res.json();
    const list = (Array.isArray(wall.memories) ? wall.memories : [])
      .slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    cacheWall(list);
    return list.map(toMemory);
  }
  function cacheWall(list) {
    try { write(CFG.WALL_CACHE_KEY, JSON.stringify(list.slice(0, 500))); } catch (_) {}
  }

  async function loadComments(photoId) {
    try {
      const res = await fetch(snapshotUrl("comments/" + photoId + ".json"), { cache: "no-store" });
      if (!res.ok) return [];
      const list = await res.json();
      return Array.isArray(list) ? list : [];
    } catch (_) { return []; }
  }

  /* 版本号：客户端每 60 秒只拉这个几十字节的文件，判断有没有新动态 */
  async function version() {
    if (!configured()) return 0;
    try {
      const res = await fetch(snapshotUrl("state/version.json"), { cache: "no-store" });
      if (!res.ok) return 0;
      const v = await res.json();
      return Number(v && v.v) || 0;
    } catch (_) { return 0; }
  }

  /* ---------- 写 ---------- */
  /* 写成功后立刻把事件推给相关的人（MQTT 秒到；推送失败也不影响数据，对方 60 秒内轮询到） */
  async function writeAndBroadcast(route, body) {
    const r = await api(route, body);
    if (r && r.event && Array.isArray(r.mqttTopics) && mqtt && mqtt.state === "online") {
      const payload = { ...r.event, ver: Date.now() };
      for (const t of r.mqttTopics) mqtt.publish(t, payload);
    }
    if (r && r.event) bumpLocalVersion();
    return r;
  }

  const setLike = (photoId, add) => writeAndBroadcast("/api/like", { photoId, add });
  const addComment = (photoId, text, replyTo) => writeAndBroadcast("/api/comment", { photoId, text, replyTo: replyTo || null });
  const likeComment = (photoId, commentId, add) => writeAndBroadcast("/api/comment-like", { photoId, commentId, add });
  const deleteComment = (photoId, commentId) => api("/api/comment-delete", { photoId, commentId });
  const saveStory = (photoId, story) => api("/api/story", { photoId, story });
  const deleteMemory = (photoId) => api("/api/delete", { photoId });
  const claim = (photoId) => api("/api/claim", { photoId });

  /* ============================================================
   * 通知：MQTT 即时 + 60 秒轮询兜底
   * ============================================================ */
  let mqtt = null;
  let notifier = null;          /* 由页面注册：收到通知时弹卡片 */
  let wallDirty = null;         /* 由页面注册：有新动态时刷新回忆墙 */
  let versionTimer = null;
  let pollBusy = false;

  function loadNotifs() {
    try { const a = JSON.parse(read(CFG.NOTIF_KEY) || "[]"); return Array.isArray(a) ? a : []; } catch (_) { return []; }
  }
  let notifs = loadNotifs();
  const persistNotifs = () => {
    try { write(CFG.NOTIF_KEY, JSON.stringify(notifs.slice(0, 100))); } catch (_) {}
  };
  const bumpLocalVersion = () => { try { localStorage.setItem(CFG.LAST_VER_KEY, String(Date.now())); } catch (_) {} };

  function pushEvent(ev) {
    if (!ev || !ev.id) return false;
    if (notifs.some((n) => n.id === ev.id)) return false;
    const item = { ...ev, read: false };
    notifs.unshift(item);
    notifs = notifs.slice(0, 100);
    persistNotifs();
    try { notifier && notifier(item); } catch (_) {}
    if (item.type === "new_photo" && typeof wallDirty === "function") {
      clearTimeout(pushEvent._t);
      pushEvent._t = setTimeout(() => { try { wallDirty(); } catch (_) {} }, 2500);
    }
    return true;
  }

  function startRealtime(info) {
    const info2 = info || mqttInfo;
    const engine = typeof window !== "undefined" ? window.MuseMQTT : (typeof MuseMQTT !== "undefined" ? MuseMQTT : null);
    if (!engine || !info2 || !info2.topic || !info2.url) return;
    stopRealtime();
    try {
      mqtt = engine.createClient({
        url: info2.url,
        topics: [info2.topic],
        clientId: "qbjd-web-" + Math.random().toString(36).slice(2, 10),
        onMessage(topic, data) {
          if (data && typeof data === "object" && data.id) {
            pushEvent(data);
            if (data.type !== "new_photo" && typeof wallDirty === "function") {
              clearTimeout(pushEvent._t);
              pushEvent._t = setTimeout(() => { try { wallDirty(); } catch (_) {} }, 1500);
            }
          }
        },
        onState(s) {
          if (s === "online") { refreshInbox().catch(() => {}); }
        },
      });
      mqtt.start();
    } catch (_) { mqtt = null; }
  }
  function stopRealtime() { try { mqtt && mqtt.stop(); } catch (_) {} mqtt = null; }

  /* 轮询：每 60 秒只拉一个几十字节的版本号；变了才去拉收件箱 */
  async function refreshInbox() {
    if (!loggedIn()) return 0;
    try {
      const res = await fetch(snapshotUrl("inbox/" + user.toLowerCase() + ".json"), { cache: "no-store" });
      if (!res.ok) return 0;
      const list = await res.json();
      let added = 0;
      for (const ev of Array.isArray(list) ? list.slice().reverse() : []) if (pushEvent(ev)) added++;
      return added;
    } catch (_) { return 0; }
  }
  function startPolling() {
    stopPolling();
    versionTimer = setInterval(async () => {
      if (pollBusy || !loggedIn()) return;
      pollBusy = true;
      try {
        const v = await version();
        const last = Number(read(CFG.LAST_VER_KEY)) || 0;
        if (v && v !== last) {
          write(CFG.LAST_VER_KEY, String(v));
          await refreshInbox();
          if (typeof wallDirty === "function") { try { await wallDirty(); } catch (_) {} }
        }
      } finally { pollBusy = false; }
    }, 60000);
    /* 启动时先补一次，避免"关着 App 期间攒下的通知"要等一分钟 */
    setTimeout(() => { version().then((v) => { if (v) { write(CFG.LAST_VER_KEY, String(v)); } refreshInbox().catch(() => {}); }).catch(() => {}); }, 1500);
  }
  function stopPolling() { clearInterval(versionTimer); versionTimer = null; }

  function notifications() { return notifs.slice(); }
  function unreadCount() { return notifs.filter((n) => !n.read).length; }
  function markAllRead() { notifs = notifs.map((n) => ({ ...n, read: true })); persistNotifs(); }
  function markRead(id) { notifs = notifs.map((n) => (n.id === id ? { ...n, read: true } : n)); persistNotifs(); }
  function clearNotifications() { notifs = []; persistNotifs(); }
  function setNotifier(fn) { notifier = fn; }
  function setWallDirty(fn) { wallDirty = fn; }
  function mqttState() { return mqtt ? mqtt.state : "off"; }
  function realtimeInfo() { return mqttInfo; }

  /* ---------- 图片压缩（与页面同一套参数：1600/0.82 原图 + 480/0.72 缩略图） ---------- */
  function compress(file, maxSide, quality) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const sc = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
        if (sc >= 1 && file.size < 500 * 1024) { URL.revokeObjectURL(url); resolve({ blob: file, w: img.naturalWidth, h: img.naturalHeight }); return; }
        const w = Math.max(4, Math.round(img.naturalWidth * sc));
        const h = Math.max(4, Math.round(img.naturalHeight * sc));
        const c = document.createElement("canvas");
        c.width = w; c.height = h;
        const ctx = c.getContext("2d");
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        c.toBlob((blob) => {
          URL.revokeObjectURL(url);
          resolve({ blob: blob || file, w, h, origW: img.naturalWidth, origH: img.naturalHeight });
        }, "image/jpeg", quality);
      };
      img.onerror = () => { URL.revokeObjectURL(url); resolve({ blob: file, w: 0, h: 0 }); };
      img.src = url;
    });
  }
  const blobToB64 = (blob) => new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(",")[1] || "");
    fr.onerror = () => reject(new Error("读取图片失败"));
    fr.readAsDataURL(blob);
  });

  /* ---------- 上传（带失败队列，弱网不丢照片） ---------- */
  function queueDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(CFG.QUEUE_DB, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains("uploads")) req.result.createObjectStore("uploads", { keyPath: "id" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function queuePut(rec) {
    const db = await queueDb();
    await new Promise((resolve, reject) => {
      const t = db.transaction("uploads", "readwrite");
      t.objectStore("uploads").put(rec);
      t.oncomplete = resolve; t.onerror = () => reject(t.error);
    });
  }
  async function queueAll() {
    const db = await queueDb();
    return await new Promise((resolve, reject) => {
      const t = db.transaction("uploads", "readonly");
      const req = t.objectStore("uploads").getAll();
      t.oncomplete = () => resolve(req.result || []); t.onerror = () => reject(t.error);
    });
  }
  async function queueDel(id) {
    const db = await queueDb();
    await new Promise((resolve, reject) => {
      const t = db.transaction("uploads", "readwrite");
      t.objectStore("uploads").delete(id);
      t.oncomplete = resolve; t.onerror = () => reject(t.error);
    });
  }

  async function sendUpload(rec) {
    const r = await api("/api/upload", rec, 90000);
    return r;
  }

  async function uploadPhoto(file, opts) {
    const o = opts || {};
    const [big, small] = await Promise.all([compress(file, 1600, 0.82), compress(file, 480, 0.72)]);
    const id = Date.now() + "-" + Math.random().toString(36).slice(2, 8) + ".jpeg";
    const rec = {
      id,
      fileName: id,
      imageBase64: await blobToB64(big.blob),
      thumbBase64: await blobToB64(small.blob),
      w: big.w || 0, h: big.h || 0,
      season: Number.isInteger(o.season) ? o.season : null,
      story: o.story || "",
      createdAt: Date.now(),
    };
    try {
      await sendUpload(rec);
      return { id, queued: false };
    } catch (e) {
      /* 网络问题 → 存进本地队列，联网后自动补传（不丢照片） */
      if (!e || e.status !== 401) {
        try { await queuePut({ ...rec, id, failedAt: Date.now() }); return { id, queued: true }; } catch (_) {}
      }
      throw e;
    }
  }

  async function flushQueue(onDone) {
    if (!loggedIn()) return 0;
    let list = [];
    try { list = await queueAll(); } catch (_) { return 0; }
    let done = 0;
    for (const rec of list) {
      try {
        const payload = { ...rec };
        delete payload.failedAt;
        await sendUpload(payload);
        await queueDel(rec.id);
        done++;
      } catch (_) { break; }
    }
    if (done && typeof onDone === "function") onDone(done);
    return done;
  }

  async function queuedCount() {
    try { return (await queueAll()).length; } catch (_) { return 0; }
  }

  if (typeof window !== "undefined" && window.addEventListener) {
    window.addEventListener("online", () => { flushQueue().catch(() => {}); });
  }

  /* 刷新页面后：登录态还在就恢复通知通道（主题存在本机，令牌由服务端校验） */
  if (loggedIn()) { startRealtime(mqttInfo); startPolling(); }

  return {
    CFG, configured, loggedIn, currentUser, setConfig, login, logout,
    loadWall, loadComments, version, cacheWall,
    setLike, addComment, likeComment, deleteComment, saveStory, deleteMemory, claim,
    uploadPhoto, flushQueue, queuedCount,
    startRealtime, stopRealtime, refreshInbox, startPolling, stopPolling,
    notifications, unreadCount, markAllRead, markRead, clearNotifications,
    setNotifier, setWallDirty, mqttState, realtimeInfo,
  };
})();
