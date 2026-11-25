// 오프라인 지원 Service Worker (비행기/지하철에서도 일정·체크리스트 열람 가능)
const CACHE_NAME = "family-travel-pwa-v1";
const CORE_ASSETS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./css/app.css",
  "./js/config.js",
  "./js/seed-hongkong.js",
  "./js/store.js",
  "./js/maps.js",
  "./js/receipt.js",
  "./js/export-excel.js",
  "./js/app.js",
  "./assets/icon-192.svg",
  "./assets/hongkong/soho_escalator.jpg",
  "./assets/hongkong/pmq.jpg",
  "./assets/hongkong/peak_tram.jpg",
  "./assets/hongkong/victoria_peak.jpg",
  "./assets/hongkong/ngong_ping_360.jpg",
  "./assets/hongkong/big_buddha.jpg",
  "./assets/hongkong/heritage_1881.jpg",
  "./assets/hongkong/victoria_harbour.jpg",
  "./assets/hongkong/dim_sum_hagao.jpg",
  "./assets/hongkong/egg_tart.jpg",
  "./assets/hongkong/milk_tea.jpg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);

  // Supabase API / 지오코딩 / 외부 API는 네트워크 우선
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        return response;
      })
      .catch(() => caches.match(request))
  );
});
