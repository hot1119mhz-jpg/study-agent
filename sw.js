/* STUDY AGENT service worker
 * 方針：同一オリジンのGETは「ネットワーク優先・失敗/タイムアウト時はキャッシュ」。
 * これにより questions.json や app.js を更新すると、オンラインで開いた時点で最新版が使われ、
 * オフライン時は最後に取得した版で動く。古い questions.json が残り続ける問題を避けるため。
 * ファイル構成を変えたときは CACHE のバージョンを上げる。
 */
var CACHE_PREFIX = 'study-agent-' + encodeURIComponent(self.registration.scope) + '-';
var CACHE = CACHE_PREFIX + 'v0.4.3';
var ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './questions.json',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png'
];
var NETWORK_TIMEOUT_MS = 4000;

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE)
      .then(function (cache) { return cache.addAll(ASSETS.map(function (u) { return new Request(u, { cache: 'reload' }); })); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.filter(function (k) { return k.indexOf(CACHE_PREFIX) === 0 && k !== CACHE; })
          .map(function (k) { return caches.delete(k); }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin || !url.href.startsWith(self.registration.scope)) return;
  event.respondWith(networkFirst(req, url, event));
});

function cacheKey(url) {
  // クエリを無視し、ディレクトリ URL は index.html に寄せる
  var u = url.origin + url.pathname;
  return u.endsWith('/') ? u + 'index.html' : u;
}

function networkFirst(req, url, event) {
  var key = cacheKey(url);
  var fromNetwork = fetch(new Request(url.origin + url.pathname, { cache: 'no-store', credentials: 'same-origin' }))
    .then(function (res) {
      if (res && res.ok) {
        var copy = res.clone();
        return caches.open(CACHE).then(function (c) { return c.put(key, copy); })
          .catch(function () { /* キャッシュ失敗でもオンラインの応答は使う */ })
          .then(function () { return res; });
      }
      return res;
    });

  // タイムアウトでキャッシュを返した後も、取得・保存が完了するまで生存させる。
  event.waitUntil(fromNetwork.catch(function () {}));
  var timeoutId;
  var timeout = new Promise(function (_, reject) { timeoutId = setTimeout(function () { reject(new Error('timeout')); }, NETWORK_TIMEOUT_MS); });

  return Promise.race([fromNetwork, timeout])
    .then(function (res) {
      clearTimeout(timeoutId);
      if (res && res.ok) return res;
      return fromCache(key, req).then(function (hit) { return hit || res; });
    })
    .catch(function () {
      clearTimeout(timeoutId);
      return fromCache(key, req).then(function (hit) {
        return hit || new Response('オフラインのため読み込めません', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      });
    });
}

function fromCache(key, req) {
  return caches.open(CACHE).then(function (c) {
    return c.match(key).then(function (hit) {
      if (hit) return hit;
      if (req.mode === 'navigate') return c.match(new URL('./index.html', self.registration.scope).href);
      return null;
    });
  });
}
