// 듀얼 지도 엔진:
// 1) 기본 무료 지도: Leaflet (OpenStreetMap) + Nominatim 지오코딩 + Google Maps 앱 원터치 길찾기 딥링크
// 2) Google Maps 임베드 모드: 설정에 Google Maps JS API 키가 있을 때 전환 가능 (AdvancedMarkerElement + internalUsageAttributionIds 준수)
// ToS 준수: Google Maps 데이터는 비-Google 지도에 혼용하거나 장기 저장하지 않으며, 각 지도 엔진은 독립된 좌표 소스만 사용합니다.

import { getAppConfig } from "./config.js";

const DAY_COLORS = ["#0f766e", "#0284c7", "#d97706", "#7c3aed", "#db2777", "#059669"];
const OSM_GEO_CACHE_KEY = "family_travel_osm_geo_v1";

export function getGoogleMapsSearchUrl(query) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query || "")}`;
}

export function getGoogleMapsDirectionsUrl(query) {
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(query || "")}&travelmode=transit`;
}

// Haversine 거리 계산 (km)
export function calcDistanceKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// OpenStreetMap Nominatim 지오코딩 (Leaflet 전용)
function readOsmCache() {
  try {
    return JSON.parse(localStorage.getItem(OSM_GEO_CACHE_KEY) || "{}");
  } catch {
    return {};
  }
}

function writeOsmCache(cache) {
  try {
    localStorage.setItem(OSM_GEO_CACHE_KEY, JSON.stringify(cache));
  } catch {}
}

export async function geocodeOsm(query) {
  const q = String(query || "").trim();
  if (!q) return null;
  const cache = readOsmCache();
  if (cache[q]) return cache[q];

  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    const arr = await res.json();
    if (!arr || !arr.length) return null;
    const coords = { lat: parseFloat(arr[0].lat), lng: parseFloat(arr[0].lon) };
    cache[q] = coords;
    writeOsmCache(cache);
    return coords;
  } catch {
    return null;
  }
}

// Leaflet 동적 로드
let leafletLoaded = null;
function ensureLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  if (leafletLoaded) return leafletLoaded;

  leafletLoaded = new Promise((resolve, reject) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
    document.head.appendChild(link);

    const script = document.createElement("script");
    script.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
    script.onload = () => resolve(window.L);
    script.onerror = () => reject(new Error("Leaflet 지도를 불러오지 못했습니다."));
    document.head.appendChild(script);
  });
  return leafletLoaded;
}

// Google Maps JS API 동적 부트스트랩 로더 (공식 importLibrary 방식)
let gmapsReadyKey = "";
function ensureGoogleMapsLoader(apiKey) {
  if (window.google?.maps?.importLibrary && gmapsReadyKey === apiKey) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const existing = document.querySelector("script[data-gmp-loader='true']");
    if (existing) existing.remove();

    const cbName = "__gmpInitCb_" + Date.now();
    window[cbName] = () => {
      gmapsReadyKey = apiKey;
      delete window[cbName];
      resolve();
    };
    const s = document.createElement("script");
    s.dataset.gmpLoader = "true";
    s.async = true;
    s.defer = true;
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&v=weekly&language=ko&region=KR&loading=async&callback=${cbName}`;
    s.onerror = () => reject(new Error("Google Maps JS API 로드 실패 (API 키를 확인하세요)."));
    document.head.appendChild(s);
  });
}

let activeLeafletMap = null;
let activeGoogleMap = null;

export function destroyMaps() {
  if (activeLeafletMap) {
    activeLeafletMap.remove();
    activeLeafletMap = null;
  }
  activeGoogleMap = null;
}

/**
 * 지도 렌더링 통합 컨트롤러
 * @param {HTMLElement} container - 명시적 높이가 지정된 DOM 컨테이너
 * @param {object} opts - { engine: 'leaflet'|'google', destination, items, candidates, dayDates, userLoc, onSelectPin, onStatus }
 */
export async function renderTripMap(container, opts) {
  destroyMaps();
  container.innerHTML = "";
  const cfg = getAppConfig();
  const engine = opts.engine === "google" && cfg.googleMapsApiKey ? "google" : "leaflet";

  if (engine === "google") {
    return renderGoogleMap(container, opts, cfg);
  }
  return renderLeafletMap(container, opts);
}

async function renderLeafletMap(container, opts) {
  const { destination, items, candidates, dayDates, userLoc, onSelectPin, onStatus } = opts;
  const L = await ensureLeaflet();

  // 목적지 기본 중심 조회
  onStatus?.("지도 위치 찾는 중...");
  const destCenter = (await geocodeOsm(destination || "Hong Kong")) || { lat: 22.3027, lng: 114.1772 };

  const map = L.map(container, { zoomControl: true }).setView([destCenter.lat, destCenter.lng], 12);
  activeLeafletMap = map;

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(map);

  const bounds = [];
  const pins = [];

  if (userLoc) {
    L.circleMarker([userLoc.lat, userLoc.lng], {
      radius: 8,
      color: "#2563eb",
      fillColor: "#3b82f6",
      fillOpacity: 0.9,
      weight: 3,
    })
      .addTo(map)
      .bindPopup("<strong>📍 현재 내 위치</strong>");
    bounds.push([userLoc.lat, userLoc.lng]);
  }

  // 표시 대상 수집 (중복 쿼리 최소화)
  const targets = [
    ...items.map((it) => ({
      kind: "itinerary",
      id: it.id,
      title: it.title,
      sub: `${it.day_label} ${it.time_str || ""}`,
      query: it.map_query || it.address || it.title,
      dayIndex: Math.max(0, dayDates.indexOf(it.day_date)),
      raw: it,
    })),
    ...candidates.map((c) => ({
      kind: "candidate",
      id: c.id,
      title: `★ ${c.name}`,
      sub: `${c.category} · ${c.area || ""}`,
      query: c.map_query || c.address || c.name,
      dayIndex: -1,
      raw: c,
    })),
  ];

  // 캐시된 핀은 즉시 표시, 미캐시 핀은 속도 제한을 지켜 순차 지오코딩
  const cache = readOsmCache();
  let geocodedCount = 0;

  const addPin = (t, coords) => {
    const color = t.kind === "candidate" ? "#f59e0b" : DAY_COLORS[t.dayIndex % DAY_COLORS.length];
    const label = t.kind === "candidate" ? "★" : `D${t.dayIndex + 1}`;
    const icon = L.divIcon({
      className: "custom-map-pin",
      html: `<div style="background:${color};color:#fff;width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:11px;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,0.3);">${label}</div>`,
      iconSize: [28, 28],
      iconAnchor: [14, 14],
    });

    const marker = L.marker([coords.lat, coords.lng], { icon }).addTo(map);
    marker.on("click", () => onSelectPin?.(t, coords));
    bounds.push([coords.lat, coords.lng]);
    pins.push({ target: t, coords });
  };

  const uncached = [];
  for (const t of targets) {
    if (cache[t.query]) {
      addPin(t, cache[t.query]);
    } else {
      uncached.push(t);
    }
  }

  if (bounds.length > 0) {
    map.fitBounds(bounds, { padding: [30, 30], maxZoom: 15 });
  }

  if (uncached.length === 0) {
    onStatus?.(`무료 지도(OSM) · 총 ${pins.length}개 장소 표시됨`);
    return { engine: "leaflet", pins };
  }

  onStatus?.(`장소 위치 확인 중... (${pins.length}/${targets.length})`);
  // 백그라운드 순차 지오코딩 (Nominatim 정책 준수: 요청 간 짧은 간격)
  for (const t of uncached.slice(0, 18)) {
    if (activeLeafletMap !== map) break; // 탭 이동 시 중단
    const coords = await geocodeOsm(t.query);
    if (coords && activeLeafletMap === map) {
      addPin(t, coords);
      geocodedCount++;
      if (bounds.length > 1) {
        map.fitBounds(bounds, { padding: [30, 30], maxZoom: 14 });
      }
    }
    onStatus?.(`무료 지도(OSM) · ${pins.length}개 장소 표시됨`);
    await new Promise((r) => setTimeout(r, 350));
  }
  return { engine: "leaflet", pins };
}

async function renderGoogleMap(container, opts, cfg) {
  const { destination, items, candidates, dayDates, userLoc, onSelectPin, onStatus } = opts;
  onStatus?.("Google Maps 불러오는 중...");
  await ensureGoogleMapsLoader(cfg.googleMapsApiKey);

  const { Map } = await window.google.maps.importLibrary("maps");
  const { AdvancedMarkerElement, PinElement } = await window.google.maps.importLibrary("marker");
  const { Place } = await window.google.maps.importLibrary("places");
  const { LatLngBounds } = await window.google.maps.importLibrary("core");

  // 목적지 중심을 Places API (New) Text Search로 조회 (하드코딩 금지 준수)
  let center = { lat: 22.3027, lng: 114.1772 };
  try {
    const { places } = await Place.searchByText({
      textQuery: destination || "Hong Kong",
      fields: ["location"],
      maxResultCount: 1,
    });
    if (places?.[0]?.location) {
      center = { lat: places[0].location.lat(), lng: places[0].location.lng() };
    }
  } catch (e) {
    console.warn("Places 목적지 조회 폴백:", e);
  }

  const map = new Map(container, {
    center,
    zoom: 12,
    mapId: cfg.googleMapsMapId || "DEMO_MAP_ID",
    internalUsageAttributionIds: ["gmp_git_agentskills_v1"],
    mapTypeControl: false,
    streetViewControl: false,
  });
  activeGoogleMap = map;

  const bounds = new LatLngBounds();
  const pins = [];

  if (userLoc) {
    const userPin = new PinElement({
      background: "#2563eb",
      borderColor: "#ffffff",
      glyphColor: "#ffffff",
      glyphText: "나",
    });
    new AdvancedMarkerElement({
      map,
      position: { lat: userLoc.lat, lng: userLoc.lng },
      title: "현재 내 위치",
      content: userPin,
    });
    bounds.extend({ lat: userLoc.lat, lng: userLoc.lng });
  }

  const targets = [
    ...items.map((it) => ({
      kind: "itinerary",
      id: it.id,
      title: it.title,
      sub: `${it.day_label} ${it.time_str || ""}`,
      query: it.map_query || it.address || it.title,
      dayIndex: Math.max(0, dayDates.indexOf(it.day_date)),
      raw: it,
    })),
    ...candidates.map((c) => ({
      kind: "candidate",
      id: c.id,
      title: `★ ${c.name}`,
      sub: `${c.category} · ${c.area || ""}`,
      query: c.map_query || c.address || c.name,
      dayIndex: -1,
      raw: c,
    })),
  ];

  onStatus?.(`Google Maps 장소 검색 중... (0/${Math.min(targets.length, 15)})`);

  for (const t of targets.slice(0, 15)) {
    if (activeGoogleMap !== map) break;
    try {
      const { places } = await Place.searchByText({
        textQuery: t.query,
        fields: ["location", "displayName"],
        maxResultCount: 1,
      });
      const loc = places?.[0]?.location;
      if (!loc || activeGoogleMap !== map) continue;

      const coords = { lat: loc.lat(), lng: loc.lng() };
      const color = t.kind === "candidate" ? "#f59e0b" : DAY_COLORS[t.dayIndex % DAY_COLORS.length];
      const glyphText = t.kind === "candidate" ? "★" : `D${t.dayIndex + 1}`;
      const pinEl = new PinElement({
        background: color,
        borderColor: "#ffffff",
        glyphColor: "#ffffff",
        glyphText,
      });

      const marker = new AdvancedMarkerElement({
        map,
        position: coords,
        title: t.title,
        content: pinEl,
      });
      marker.addListener("click", () => onSelectPin?.(t, coords));
      bounds.extend(coords);
      pins.push({ target: t, coords });
      onStatus?.(`Google Maps · ${pins.length}개 장소 표시됨`);
    } catch (err) {
      console.warn("Google Place 검색 실패:", t.query, err);
    }
  }

  if (pins.length > 0) {
    map.fitBounds(bounds);
  }
  return { engine: "google", pins };
}
