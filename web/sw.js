/* 英语生词本 Service Worker：缓存优先，支持离线使用 */
var CACHE = "vocab-web-v5";

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (cache) {
      return cache.addAll([
        "./index.html",
        "./style.css",
        "./app.js",
        "./manifest.json",
        "./icon.svg",
        "./data/meta.js",
        "./data/words.js",
        "./data/articles1.js",
        "./data/articles2.js",
        "./data/articles3.js",
        "./data/articles4.js",
        "./data/dict_a.js", "./data/dict_b.js", "./data/dict_c.js",
        "./data/dict_d.js", "./data/dict_e.js", "./data/dict_f.js",
        "./data/dict_g.js", "./data/dict_h.js", "./data/dict_i.js",
        "./data/dict_j.js", "./data/dict_k.js", "./data/dict_l.js",
        "./data/dict_m.js", "./data/dict_n.js", "./data/dict_o.js",
        "./data/dict_p.js", "./data/dict_q.js", "./data/dict_r.js",
        "./data/dict_s.js", "./data/dict_t.js", "./data/dict_u.js",
        "./data/dict_v.js", "./data/dict_w.js", "./data/dict_x.js",
        "./data/dict_y.js", "./data/dict_z.js"
      ]);
    })
  );
  self.skipWaiting();
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; })
        .map(function (k) { return caches.delete(k); }));
    })
  );
  self.clients.claim();
});

self.addEventListener("fetch", function (e) {
  if (e.request.method !== "GET") return;
  e.respondWith(
    caches.match(e.request).then(function (hit) {
      if (hit) return hit;
      return fetch(e.request).then(function (res) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
        return res;
      }).catch(function () { return caches.match("./index.html"); });
    })
  );
});
