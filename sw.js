/* QBJD MUSE · Service Worker
 * 策略：外壳（html/manifest/图标）网络优先 + 静态资源缓存优先
 * 数据（照片/点赞/评论）全部走云端 API，不拦截跨域请求，保证永远新鲜 */
const CACHE = "qbjd-muse-v1";
const SHELL = ["./index.html", "./manifest.json", "./icon-192.png", "./icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);

  /* 云端缩略图（卡片用，几十 KB）：缓存优先，二次打开回忆墙秒出；
     原图不缓存（看大图时按需加载，避免缓存撑爆） */
  if (url.origin === "https://mjznyjsetuhklrklajem.supabase.co" &&
      url.pathname.includes("/storage/v1/object/public/photos/thumb_")) {
    e.respondWith(
      caches.match(e.request).then(
        (hit) =>
          hit ||
          fetch(e.request).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put(e.request, copy));
            }
            return res;
          })
      )
    );
    return;
  }

  /* 只处理同源请求；数据/大图/视频跨域请求不拦截 */
  if (url.origin !== self.location.origin) return;
  /* 登录背景视频较大（13MB），走网络不缓存 */
  if (/\.(mp4|webm)$/.test(url.pathname)) return;

  /* 首页：网络优先，成功后更新缓存；断网时用缓存兜底 */
  if (e.request.mode === "navigate" || /\/index\.html$/.test(url.pathname)) {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
          return res;
        })
        .catch(() => caches.match(e.request).then((hit) => hit || caches.match("./index.html")))
    );
    return;
  }
  /* 其他静态资源：缓存优先，miss 再走网络并顺手入缓存 */
  e.respondWith(
    caches.match(e.request).then(
      (hit) =>
        hit ||
        fetch(e.request).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(e.request, copy));
          }
          return res;
        })
    )
  );
});