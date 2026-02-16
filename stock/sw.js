/* ====== service worker (cache-safe) ====== */

const CACHE_VERSION = "v4"; // 올릴 때마다 숫자 바꾸면 캐시가 확실히 갈림
const STATIC_CACHE = `ipo-alarm-static-${CACHE_VERSION}`;

const STATIC_ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.webmanifest"
];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(STATIC_CACHE).then(cache => cache.addAll(STATIC_ASSETS)).catch(()=>{})
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => (k.startsWith("ipo-alarm-static-") && k !== STATIC_CACHE) ? caches.delete(k) : null));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // ✅ API/Functions 는 절대 캐시하지 않음 (0개/중복/구버전 문제 방지)
  if (url.pathname.startsWith("/.netlify/functions/") || url.pathname.startsWith("/api/")) {
    return; // browser does network fetch normally
  }

  // 정적 파일은 cache-first
  event.respondWith((async () => {
    const cached = await caches.match(event.request);
    if (cached) return cached;

    try {
      const res = await fetch(event.request);
      const cache = await caches.open(STATIC_CACHE);
      cache.put(event.request, res.clone()).catch(()=>{});
      return res;
    } catch (e) {
      // offline fallback: index
      const fallback = await caches.match("./index.html");
      return fallback || new Response("offline");
    }
  })());
});
