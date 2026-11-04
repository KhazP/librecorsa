/*
 * Asset cache for repeat visits: circuits, car models, textures and sounds (tens of MB) are served from the browser's
 * cache after the first visit instead of downloading again. Registered by src/lib/service-worker.ts in production
 * builds only, as `sw.js?v=<build id>`: each deploy installs a new worker with a new cache and deletes the old ones,
 * so a visit never mixes files from two builds.
 */
const VERSION = new URL(self.location.href).searchParams.get("v") || "dev";
const CACHE = `librecorsa-assets-${VERSION}`;
const PREFIX = "librecorsa-assets-";
/** Folders (under the site's base path) whose files are content of this build: models, textures, sounds, track data */
const ASSET_PATH = /\/(tracks|cars|amr26|gt3|audio)\/[^?#]+\.(glb|gltf|bin|webp|png|jpg|jpeg|ktx2|ogg|wav|mp3|json)$/i;

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key.startsWith(PREFIX) && key !== CACHE) await caches.delete(key);
      }
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || req.headers.has("range")) return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || !ASSET_PATH.test(url.pathname)) return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      const res = await fetch(req);
      // Whole, successful same-origin responses only (a 206 or an error page must never be served again)
      if (res.ok && res.status === 200 && res.type === "basic") event.waitUntil(cache.put(req, res.clone()).catch(() => {}));
      return res;
    })()
  );
});
