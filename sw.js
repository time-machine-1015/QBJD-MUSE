/* QBJD MUSE · Service Worker
 * 策略：外壳（html/manifest/图标）网络优先 + 静态资源缓存优先
 * 数据（照片/点赞/评论）全部走云端 API，不拦截跨域请求，保证永远新鲜
 *
 * 【重要】App（Capacitor/Android WebView）环境自动自毁：
 * WebView 的 Cache API 支持不完整，SW 拦截图片请求会导致请求挂起、图片永远加载不出来。
 * 检测到 WebView UA（含 "; wv)"）时：清空缓存 → 注销自己 → 所有请求直连网络。
 * 浏览器（Safari/Chrome）不受影响，正常提供缓存加速。 */
const IS_APP_WEBVIEW = /;\s*wv\)/i.test(self.navigator && self.navigator.userAgent || "");

const CACHE = "qbjd-muse-v1";
const SHELL = ["./index.html", "./manifest.json", "./icon-192.png", "./icon-512.png"];

self.addEventListener("install", (e) => {
  if (IS_APP_WEBVIEW) {
    e.waitUntil((async () => {
      try {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      } catch (_) {}
      await self.registration.unregister().catch(() => {});
    })());
    return;   /* App 环境不安装缓存 */
  }
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  if (IS_APP_WEBVIEW) {
    e.waitUntil(self.registration.unregister().catch(() => {}));
    return;
  }
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  /* App 环境：绝不拦截任何请求，全部直连网络（彻底规避 WebView 挂起问题） */
  if (IS_APP_WEBVIEW) return;

  const url = new URL(e.request.url);

  /* 云端缩略图（卡片用，几十 KB）：缓存优先，二次打开回忆墙秒出；
     原图不缓存（看大图时按需加载，避免缓存撑爆）
     所有缓存操作都有兜底：任何异常直接回退网络请求，绝不挂起 */
  if (url.origin === "https://mjznyjsetuhklrklajem.supabase.co" &&
      url.pathname.includes("/storage/v1/object/public/photos/thumb_")) {
    e.respondWith((async () => {
      try {
        const hit = await caches.match(e.request);
        if (hit) return hit;
      } catch (_) { /* Cache API 不可用 → 直接走网络 */ }
      const res = await fetch(e.request);
      if (res && res.ok) {
        try {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        } catch (_) {}
      }
      return res;
    })().catch(() => fetch(e.request)));
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