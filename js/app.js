// 우리 가족 여행 플래너 & 가계부 — 메인 UI 컨트롤러
import { getAppConfig, saveAppConfig, isSupabaseConfigured } from "./config.js";
import { CURRENCY_PRESETS, getCurrencySymbol, HONGKONG_TRIP_ID } from "./seed-hongkong.js";
import {
  store,
  uid,
  verifyPin,
  changePin,
  getStoredPin,
  clearPin,
  loadAllData,
  subscribeRealtime,
  getModeLabel,
} from "./store.js";
import {
  renderTripMap,
  destroyMaps,
  getGoogleMapsSearchUrl,
  getGoogleMapsDirectionsUrl,
  calcDistanceKm,
} from "./maps.js";
import { compressImageFile, analyzeReceiptWithAI, guessWalletId } from "./receipt.js";
import { exportTripToExcel, exportGoogleMyMapsCsv } from "./export-excel.js";

// ============================================================
// 상태 관리
// ============================================================
const state = {
  db: { trips: [], itinerary: [], candidates: [], checklists: [], expenses: [] },
  dataSource: "local",
  activeTripId: null, // null이면 여행 보관함(Hub) 화면
  activeTab: "itinerary", // 'itinerary' | 'map' | 'budget' | 'prep'
  activeDayDate: null, // 'ALL' 또는 'YYYY-MM-DD'
  prepSubTab: "checklist", // 'checklist' | 'transport' | 'budget_table'
  mapEngine: "leaflet", // 'leaflet' | 'google'
  mapFilter: "all", // 'all' | 'candidates' | 'YYYY-MM-DD'
  candFilter: "all", // 'all' | 'pending' | 'central' | 'kowloon' | 'peak' | 'lantau'
  userLocation: null,
  selectedMapPin: null,
  pendingVoucherItemId: null,
};

// DOM 참조
const $ = (sel) => document.querySelector(sel);
const pinScreen = $("#pin-screen");
const appShell = $("#app-shell");
const mainContent = $("#main-content");
const bottomNav = $("#bottom-nav");
const appDialog = $("#app-dialog");
const dialogTitle = $("#dialog-title");
const dialogBody = $("#dialog-body");
const dialogFooter = $("#dialog-footer");

// ============================================================
// 유틸리티
// ============================================================
function esc(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtNum(n) {
  return Math.round(Number(n) || 0).toLocaleString("ko-KR");
}

function fmtMoney(n, decimals = 0) {
  const num = Number(n) || 0;
  return num.toLocaleString("ko-KR", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

let toastTimer = null;
function showToast(msg, duration = 2600) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), duration);
}

function getActiveTrip() {
  return state.db.trips.find((t) => t.id === state.activeTripId) || null;
}

function getTripDates(trip) {
  if (!trip) return [];
  const res = [];
  const start = new Date(`${trip.start_date}T00:00:00`);
  const end = new Date(`${trip.end_date}T00:00:00`);
  const days = ["일", "월", "화", "수", "목", "금", "토"];
  for (let d = new Date(start); d <= end && res.length < 31; d.setDate(d.getDate() + 1)) {
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    res.push({
      date: iso,
      label: `${d.getMonth() + 1}/${d.getDate()} (${days[d.getDay()]})`,
    });
  }
  return res;
}

function getDDayBadge(startDate, endDate) {
  const today = new Date();
  const ymd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const diff = Math.round((new Date(`${startDate}T00:00:00`) - new Date(`${ymd}T00:00:00`)) / 86400000);
  if (ymd >= startDate && ymd <= endDate) return { text: "여행 중 ✈️", cls: "badge-green" };
  if (diff > 0) return { text: `D-${diff}`, cls: "badge-teal" };
  return { text: `여행 완료`, cls: "badge-gray" };
}

function getCategoryBadge(cat) {
  const map = {
    항공: "badge-purple",
    이동: "badge-blue",
    식사: "badge-amber",
    간식: "badge-amber",
    숙소: "badge-teal",
    관광: "badge-green",
    쇼핑: "badge-rose",
    식비: "badge-amber",
    교통: "badge-blue",
    입장권: "badge-purple",
    기타: "badge-gray",
  };
  return map[cat] || "badge-gray";
}

function openDialog({ title, bodyHtml, footerHtml = "", onMount }) {
  dialogTitle.textContent = title;
  dialogBody.innerHTML = bodyHtml;
  dialogFooter.innerHTML = footerHtml;
  if (!appDialog.open) appDialog.showModal();
  if (onMount) onMount(dialogBody, dialogFooter);
}

function closeDialog() {
  if (appDialog.open) appDialog.close();
}

// Safari용 <dialog closedby="any"> 경량 폴백 (modern-web-guidance 준수)
if (!("closedBy" in HTMLDialogElement.prototype)) {
  const outside = (e, dialog) => {
    const r = dialog.getBoundingClientRect();
    return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
  };
  let pressedOutside = false;
  appDialog.addEventListener("pointerdown", (e) => {
    pressedOutside = outside(e, appDialog);
  });
  appDialog.addEventListener("pointerup", (e) => {
    if (pressedOutside && outside(e, appDialog)) appDialog.close();
  });
}
$("#dialog-close-btn").addEventListener("click", closeDialog);

// ============================================================
// 데이터 새로고침 & 초기화
// ============================================================
async function refreshData(silent = false) {
  const res = await loadAllData();
  state.db = res.db;
  state.dataSource = res.source;
  updateHeader();
  renderCurrentView();
  if (!silent) {
    if (res.source === "cloud") showToast("Supabase와 동기화되었습니다.");
    else if (res.error) showToast(`오프라인 캐시 표시 중 (${res.error})`, 3500);
  }
}

async function enterApp() {
  pinScreen.classList.add("hidden");
  appShell.classList.remove("hidden");
  await refreshData(true);

  // 여행이 1개(홍콩)뿐이면 바로 입장, 여러 개면 보관함 표시
  if (!state.activeTripId && state.db.trips.length === 1) {
    openTrip(state.db.trips[0].id);
  } else {
    renderCurrentView();
  }

  subscribeRealtime(() => {
    refreshData(true);
  });
}

function openTrip(tripId) {
  state.activeTripId = tripId;
  const trip = getActiveTrip();
  const dates = getTripDates(trip);
  const today = new Date().toISOString().slice(0, 10);
  const matchToday = dates.find((d) => d.date === today);
  state.activeDayDate = matchToday ? matchToday.date : dates[0]?.date || "ALL";
  state.activeTab = "itinerary";
  updateHeader();
  renderCurrentView();
}

function updateHeader() {
  const trip = getActiveTrip();
  const backBtn = $("#btn-back-hub");
  const fxBtn = $("#btn-fx-calc");
  const titleEl = $("#header-title");
  const metaEl = $("#header-meta");
  const syncBadge = $("#sync-badge");

  syncBadge.textContent =
    state.dataSource === "cloud"
      ? "☁️ 실시간 동기화"
      : state.dataSource === "offline-cache"
      ? "📡 오프라인 캐시"
      : "📱 로컬 모드";

  if (trip) {
    backBtn.classList.remove("hidden");
    fxBtn.classList.remove("hidden");
    bottomNav.classList.remove("hidden");
    titleEl.textContent = `${trip.flag || "✈️"} ${trip.title}`;
    const dday = getDDayBadge(trip.start_date, trip.end_date);
    metaEl.textContent = `${trip.start_date.slice(5)} ~ ${trip.end_date.slice(5)} · ${dday.text}`;
  } else {
    backBtn.classList.add("hidden");
    fxBtn.classList.add("hidden");
    bottomNav.classList.add("hidden");
    titleEl.textContent = "우리 가족 여행 보관함";
    metaEl.textContent = `총 ${state.db.trips.length}개의 여행`;
  }

  document.querySelectorAll(".nav-tab").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === state.activeTab);
  });
}

function renderCurrentView() {
  if (state.activeTab !== "map") destroyMaps();
  updateHeader();
  if (!state.activeTripId) {
    renderTripsHub();
    return;
  }
  switch (state.activeTab) {
    case "itinerary":
      renderItineraryTab();
      break;
    case "map":
      renderMapTab();
      break;
    case "budget":
      renderBudgetTab();
      break;
    case "prep":
      renderPrepTab();
      break;
  }
}

// ============================================================
// 0. 여행 보관함 (멀티 트립 Hub)
// ============================================================
function renderTripsHub() {
  const trips = state.db.trips;
  const html = `
    <div class="briefing-banner">
      <strong>👨‍👩‍👧‍👦 우리 가족 여행 허브</strong>
      <p>이번 홍콩 여행부터 다음 여행까지 일정·지도·영수증 가계부를 한곳에서 관리합니다.</p>
    </div>

    <div class="section-header">
      <h2 class="section-title">여행 목록 (${trips.length})</h2>
      <button type="button" class="btn btn-primary btn-sm" id="btn-new-trip">+ 새 여행 만들기</button>
    </div>

    ${trips
      .map((t) => {
        const dday = getDDayBadge(t.start_date, t.end_date);
        const itList = state.db.itinerary.filter((i) => i.trip_id === t.id);
        const doneCount = itList.filter((i) => i.completed).length;
        const expSum = state.db.expenses
          .filter((e) => e.trip_id === t.id)
          .reduce((s, e) => s + (Number(e.amount_krw) || 0), 0);
        const chkList = state.db.checklists.filter((c) => c.trip_id === t.id);
        const chkDone = chkList.filter((c) => c.status === "완료").length;

        return `
        <article class="trip-hub-card">
          <div class="trip-hub-top">
            <div style="display:flex;gap:12px;align-items:flex-start;flex:1;cursor:pointer;" data-open-trip="${esc(t.id)}">
              <div class="trip-flag">${esc(t.flag || "✈️")}</div>
              <div>
                <h3 class="trip-hub-title">${esc(t.title)}</h3>
                <div class="trip-hub-meta">${esc(t.destination)} · ${esc(t.start_date)} ~ ${esc(t.end_date)}</div>
                <div class="trip-hub-meta">기준통화: ${esc(t.currency)} (1${esc(t.currency)} = ${fmtNum(t.exchange_rate)}원)</div>
              </div>
            </div>
            <span class="badge ${dday.cls}">${dday.text}</span>
          </div>
          ${t.summary ? `<p style="font-size:12px;color:var(--text-muted);margin:10px 0 0;">${esc(t.summary)}</p>` : ""}
          <div class="trip-hub-stats" style="cursor:pointer;" data-open-trip="${esc(t.id)}">
            <div>
              <div class="stat-label">일정 진행</div>
              <div class="stat-value">${doneCount}/${itList.length}건</div>
            </div>
            <div>
              <div class="stat-label">준비 체크</div>
              <div class="stat-value">${chkDone}/${chkList.length}건</div>
            </div>
            <div>
              <div class="stat-label">기록된 지출</div>
              <div class="stat-value">${fmtNum(expSum)}원</div>
            </div>
          </div>
          <div style="display:flex;gap:8px;margin-top:12px;">
            <button type="button" class="btn btn-primary btn-sm" style="flex:1;" data-open-trip="${esc(t.id)}">여행 열기</button>
            <button type="button" class="btn btn-soft btn-sm" data-edit-trip="${esc(t.id)}">✏️ 정보 수정</button>
          </div>
        </article>`;
      })
      .join("")}
  `;

  mainContent.innerHTML = html;

  $("#btn-new-trip")?.addEventListener("click", () => openTripFormModal(null));
  mainContent.querySelectorAll("[data-open-trip]").forEach((el) => {
    el.addEventListener("click", () => openTrip(el.dataset.openTrip));
  });
  mainContent.querySelectorAll("[data-edit-trip]").forEach((el) => {
    el.addEventListener("click", () => {
      const trip = state.db.trips.find((t) => t.id === el.dataset.editTrip);
      openTripFormModal(trip);
    });
  });
}

function openTripFormModal(existingTrip) {
  const isEdit = Boolean(existingTrip);
  const t = existingTrip || {
    title: "",
    destination: "",
    flag: "🇯🇵",
    start_date: "",
    end_date: "",
    currency: "JPY",
    exchange_rate: 9.5,
    summary: "",
  };

  openDialog({
    title: isEdit ? "여행 정보 수정" : "새 여행 만들기",
    bodyHtml: `
      <form id="trip-form">
        <div class="field-row">
          <div class="field">
            <label>국기/아이콘</label>
            <input name="flag" value="${esc(t.flag)}" maxlength="4" />
          </div>
          <div class="field">
            <label>여행지 *</label>
            <input name="destination" value="${esc(t.destination)}" placeholder="예: 도쿄, 다낭" required />
          </div>
        </div>
        <div class="field">
          <label>여행 제목 *</label>
          <input name="title" value="${esc(t.title)}" placeholder="예: 오사카 가족여행 3박 4일" required />
        </div>
        <div class="field-row">
          <div class="field">
            <label>출발일 *</label>
            <input type="date" name="start_date" value="${esc(t.start_date)}" required />
          </div>
          <div class="field">
            <label>귀국일 *</label>
            <input type="date" name="end_date" value="${esc(t.end_date)}" required />
          </div>
        </div>
        <div class="field-row">
          <div class="field">
            <label>기준 통화</label>
            <select name="currency" id="trip-currency-sel">
              ${CURRENCY_PRESETS.map(
                (c) => `<option value="${c.code}" ${c.code === t.currency ? "selected" : ""}>${c.code} (${c.name})</option>`
              ).join("")}
            </select>
          </div>
          <div class="field">
            <label>적용 환율 (1단위당 원)</label>
            <input type="number" step="0.01" name="exchange_rate" id="trip-rate-inp" value="${esc(t.exchange_rate)}" required />
          </div>
        </div>
        <div class="field">
          <label>항공 · 숙소 · 구성원 요약</label>
          <textarea name="summary" rows="3" placeholder="숙소명, 항공편 시간, 가족 인원 등">${esc(t.summary || "")}</textarea>
        </div>
      </form>
    `,
    footerHtml: `
      ${isEdit ? `<button type="button" class="btn btn-danger btn-sm" id="btn-del-trip" style="margin-right:auto;">삭제</button>` : ""}
      <button type="button" class="btn btn-soft btn-sm" id="btn-cancel-trip">취소</button>
      <button type="submit" form="trip-form" class="btn btn-primary btn-sm">저장</button>
    `,
    onMount(body, footer) {
      const sel = body.querySelector("#trip-currency-sel");
      const rateInp = body.querySelector("#trip-rate-inp");
      sel.addEventListener("change", () => {
        const preset = CURRENCY_PRESETS.find((c) => c.code === sel.value);
        if (preset) rateInp.value = preset.defaultRate;
      });
      footer.querySelector("#btn-cancel-trip").addEventListener("click", closeDialog);
      footer.querySelector("#btn-del-trip")?.addEventListener("click", async () => {
        if (!confirm(`'${t.title}' 여행과 모든 일정을 삭제할까요?`)) return;
        await store.deleteTrip(t.id);
        if (state.activeTripId === t.id) state.activeTripId = null;
        closeDialog();
        await refreshData(true);
        showToast("여행이 삭제되었습니다.");
      });
      body.querySelector("#trip-form").addEventListener("submit", async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const payload = {
          title: fd.get("title").trim(),
          destination: fd.get("destination").trim(),
          flag: fd.get("flag").trim() || "✈️",
          start_date: fd.get("start_date"),
          end_date: fd.get("end_date"),
          currency: fd.get("currency"),
          exchange_rate: Number(fd.get("exchange_rate")) || 1,
          summary: fd.get("summary").trim(),
        };
        if (isEdit) {
          await store.saveTrip({ ...t, ...payload });
          showToast("여행 정보를 수정했습니다.");
        } else {
          const created = await store.createTripWithTemplate(payload);
          state.activeTripId = created.id;
          showToast("새 여행과 기본 체크리스트가 생성되었습니다!");
        }
        closeDialog();
        await refreshData(true);
      });
    },
  });
}

// ============================================================
// 1. 일정 탭
// ============================================================
function renderItineraryTab() {
  const trip = getActiveTrip();
  const dates = getTripDates(trip);
  const allItems = state.db.itinerary
    .filter((i) => i.trip_id === trip.id)
    .sort((a, b) => a.day_date.localeCompare(b.day_date) || a.sort_order - b.sort_order || (a.time_str || "").localeCompare(b.time_str || ""));

  const pendingUrgent = state.db.checklists
    .filter((c) => c.trip_id === trip.id && c.status !== "완료")
    .slice(0, 2);

  const visibleItems =
    state.activeDayDate === "ALL" ? allItems : allItems.filter((i) => i.day_date === state.activeDayDate);

  const nextTodo = visibleItems.find((i) => !i.completed && !i.skipped);
  const dday = getDDayBadge(trip.start_date, trip.end_date);

  const html = `
    <div class="briefing-banner">
      <strong>${dday.text === "여행 중 ✈️" ? "📌 지금 다음 일정" : `📌 출발 브리핑 (${dday.text})`}</strong>
      <p>
        ${
          dday.text === "여행 중 ✈️" && nextTodo
            ? `<b>${esc(nextTodo.time_str)} ${esc(nextTodo.title)}</b> — ${esc(nextTodo.transport || nextTodo.details || "")}`
            : pendingUrgent.length
            ? `미완료 준비: ${pendingUrgent.map((u) => `<b>${esc(u.title)}</b> (${esc(u.due_label)})`).join(" · ")}`
            : esc(trip.summary || "모든 일정 준비가 완료되었습니다!")
        }
      </p>
    </div>

    <div class="day-tabs" role="tablist">
      ${dates
        .map(
          (d, idx) => `
        <button type="button" class="day-chip ${state.activeDayDate === d.date ? "active" : ""}" data-day="${d.date}">
          Day ${idx + 1} · ${d.label}
        </button>`
        )
        .join("")}
      <button type="button" class="day-chip ${state.activeDayDate === "ALL" ? "active" : ""}" data-day="ALL">전체</button>
    </div>

    <div class="section-header" style="margin-top:4px;">
      <h2 class="section-title">
        ${state.activeDayDate === "ALL" ? `전체 일정 (${visibleItems.length}건)` : `${dates.find((d) => d.date === state.activeDayDate)?.label || ""} 일정 (${visibleItems.length}건)`}
      </h2>
      <button type="button" class="btn btn-primary btn-sm" id="btn-add-itinerary">+ 일정 추가</button>
    </div>

    ${
      visibleItems.length === 0
        ? `<div class="card" style="text-align:center;color:var(--text-muted);padding:28px 16px;">등록된 일정이 없습니다.<br/>위 <b>+ 일정 추가</b> 버튼으로 일정을 만들어 보세요!</div>`
        : visibleItems
            .map((item, idx) => {
              const mapQuery = item.map_query || item.address || item.title;
              const alts = Array.isArray(item.alternatives) ? item.alternatives : [];
              const photos = Array.isArray(item.photos) ? item.photos : [];
              const vouchers = Array.isArray(item.vouchers) ? item.vouchers : [];

              return `
              <article class="itinerary-card ${item.completed ? "is-done" : ""} ${item.skipped ? "is-skipped" : ""}">
                <div class="it-top">
                  <div class="it-time-group">
                    ${state.activeDayDate === "ALL" ? `<span class="badge badge-gray">${esc(item.day_label)}</span>` : ""}
                    <span class="it-time">${esc(item.time_str || "시간 미정")}</span>
                    <span class="badge ${getCategoryBadge(item.category)}">${esc(item.category)}</span>
                    ${
                      item.reservation_status && item.reservation_status !== "불필요"
                        ? `<span class="badge ${item.reservation_status === "완료" ? "badge-green" : item.reservation_status === "필수" ? "badge-rose" : "badge-amber"}">예약:${esc(item.reservation_status)}</span>`
                        : ""
                    }
                  </div>
                  <div style="display:flex;gap:4px;">
                    ${idx > 0 && state.activeDayDate !== "ALL" ? `<button type="button" class="btn btn-soft btn-sm" style="padding:4px 7px;min-height:28px;" data-move-up="${esc(item.id)}" aria-label="위로">↑</button>` : ""}
                    ${idx < visibleItems.length - 1 && state.activeDayDate !== "ALL" ? `<button type="button" class="btn btn-soft btn-sm" style="padding:4px 7px;min-height:28px;" data-move-down="${esc(item.id)}" aria-label="아래로">↓</button>` : ""}
                  </div>
                </div>

                <h3 class="it-title">${esc(item.title)}</h3>
                ${item.local_name ? `<div class="it-local">${esc(item.local_name)}${item.address ? ` · ${esc(item.address)}` : ""}</div>` : ""}
                ${item.details ? `<p class="it-details">${esc(item.details)}</p>` : ""}
                ${item.transport ? `<div style="font-size:12px;color:var(--primary-dark);font-weight:700;margin-bottom:6px;">🚇 이동: ${esc(item.transport)}</div>` : ""}

                ${
                  photos.length
                    ? `<div class="it-photos" data-gallery-group="${esc(item.title)}">${photos
                        .map((src, pIdx) => `<img src="${esc(src)}" alt="${esc(item.title)}" loading="lazy" data-zoom-img="${esc(src)}" data-zoom-idx="${pIdx}" />`)
                        .join("")}</div>`
                    : ""
                }

                ${
                  alts.length
                    ? alts
                        .map(
                          (alt, altIdx) => `
                        <div class="swap-box">
                          <span>💡 <b>대안:</b> ${esc(alt.title)}</span>
                          <button type="button" class="btn btn-amber btn-sm" style="min-height:30px;padding:4px 8px;" data-swap-item="${esc(item.id)}" data-swap-idx="${altIdx}">🔄 교체</button>
                        </div>`
                        )
                        .join("")
                    : ""
                }

                <div class="it-actions">
                  <button type="button" class="btn ${item.completed ? "btn-primary" : "btn-soft"} btn-sm" data-toggle-done="${esc(item.id)}">
                    ${item.completed ? "✅ 완료됨" : "⬜ 완료"}
                  </button>
                  <a class="btn btn-soft btn-sm" href="${getGoogleMapsSearchUrl(mapQuery)}" target="_blank" rel="noopener">📍 구글맵</a>
                  <a class="btn btn-soft btn-sm" href="${getGoogleMapsDirectionsUrl(mapQuery)}" target="_blank" rel="noopener">🧭 길찾기</a>
                  ${
                    item.local_name || item.address
                      ? `<button type="button" class="btn btn-soft btn-sm" data-taxi-card="${esc(item.id)}">🚕 기사님</button>`
                      : ""
                  }
                  <button type="button" class="btn btn-soft btn-sm" data-vouchers="${esc(item.id)}">
                    🎫 바우처${vouchers.length ? `(${vouchers.length})` : ""}
                  </button>
                  <button type="button" class="btn btn-soft btn-sm" data-edit-it="${esc(item.id)}">✏️ 수정</button>
                </div>
              </article>`;
            })
            .join("")
    }
  `;

  mainContent.innerHTML = html;

  // 이벤트 바인딩
  mainContent.querySelectorAll("[data-day]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.activeDayDate = btn.dataset.day;
      renderItineraryTab();
    });
  });

  $("#btn-add-itinerary")?.addEventListener("click", () => openItineraryModal(null));

  mainContent.querySelectorAll("[data-toggle-done]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const item = allItems.find((x) => x.id === btn.dataset.toggleDone);
      if (!item) return;
      await store.saveItinerary({ ...item, completed: !item.completed, skipped: false });
      await refreshData(true);
    });
  });

  mainContent.querySelectorAll("[data-move-up], [data-move-down]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const isUp = Boolean(btn.dataset.moveUp);
      const id = btn.dataset.moveUp || btn.dataset.moveDown;
      const idx = visibleItems.findIndex((x) => x.id === id);
      const swapIdx = isUp ? idx - 1 : idx + 1;
      if (idx < 0 || swapIdx < 0 || swapIdx >= visibleItems.length) return;
      const a = visibleItems[idx];
      const b = visibleItems[swapIdx];
      await store.saveItinerary({ ...a, sort_order: swapIdx + 1 });
      await store.saveItinerary({ ...b, sort_order: idx + 1 });
      await refreshData(true);
    });
  });

  mainContent.querySelectorAll("[data-swap-item]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const item = allItems.find((x) => x.id === btn.dataset.swapItem);
      const altIdx = Number(btn.dataset.swapIdx);
      const alt = item?.alternatives?.[altIdx];
      if (!item || !alt) return;
      if (!confirm(`'${item.title}' 일정을 대안 '${alt.title}'(으)로 교체할까요?`)) return;
      const prevAsAlt = {
        title: item.title,
        local_name: item.local_name,
        address: item.address,
        map_query: item.map_query,
        details: item.details,
      };
      const nextAlts = [...item.alternatives];
      nextAlts[altIdx] = prevAsAlt;
      await store.saveItinerary({
        ...item,
        title: alt.title,
        local_name: alt.local_name || "",
        address: alt.address || "",
        map_query: alt.map_query || alt.title,
        details: alt.details || item.details,
        alternatives: nextAlts,
      });
      await refreshData(true);
      showToast("대안 장소로 교체되었습니다!");
    });
  });

  mainContent.querySelectorAll("[data-taxi-card]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const item = allItems.find((x) => x.id === btn.dataset.taxiCard);
      if (!item) return;
      openTaxiCardModal(item.title, item.local_name, item.address);
    });
  });

  mainContent.querySelectorAll("[data-vouchers]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const item = allItems.find((x) => x.id === btn.dataset.vouchers);
      if (item) openVoucherModal(item);
    });
  });

  mainContent.querySelectorAll("[data-edit-it]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const item = allItems.find((x) => x.id === btn.dataset.editIt);
      if (item) openItineraryModal(item);
    });
  });

  mainContent.querySelectorAll("[data-zoom-img]").forEach((img) => {
    img.addEventListener("click", () => {
      const parent = img.closest(".it-photos");
      const groupImgs = parent ? Array.from(parent.querySelectorAll("img")).map((el) => el.dataset.zoomImg) : [img.dataset.zoomImg];
      const startIdx = Number(img.dataset.zoomIdx) || 0;
      openImageZoomModal(groupImgs, img.alt, startIdx);
    });
  });
}

function openTaxiCardModal(title, localName, address) {
  openDialog({
    title: "🚕 기사님 / 직원에게 보여주기",
    bodyHtml: `
      <div class="taxi-card-view">
        <div class="taxi-local-big">${esc(localName || title)}</div>
        ${address ? `<div class="taxi-addr-big">${esc(address)}</div>` : ""}
        <div class="taxi-kor-sub">한국어 일정: ${esc(title)}</div>
      </div>
    `,
    footerHtml: `
      <a class="btn btn-accent btn-sm" href="${getGoogleMapsSearchUrl(address || localName || title)}" target="_blank" rel="noopener">📍 구글맵 열기</a>
      <button type="button" class="btn btn-primary btn-sm" id="taxi-close">닫기</button>
    `,
    onMount(_, footer) {
      footer.querySelector("#taxi-close").addEventListener("click", closeDialog);
    },
  });
}

function openImageZoomModal(srcOrList, title = "사진 보기", startIndex = 0) {
  const list = Array.isArray(srcOrList) ? srcOrList.filter(Boolean) : [srcOrList].filter(Boolean);
  let idx = Math.max(0, Math.min(startIndex, list.length - 1));

  openDialog({
    title: title || "사진 보기",
    bodyHtml: `
      <img id="zoom-img-el" src="${esc(list[idx])}" alt="${esc(title)}" style="width:100%;max-height:65dvh;object-fit:contain;border-radius:12px;display:block;background:#0f172a;" />
      ${
        list.length > 1
          ? `<div class="gallery-nav">
               <button type="button" class="btn btn-soft btn-sm" id="zoom-prev">‹ 이전</button>
               <span class="gallery-counter" id="zoom-counter">${idx + 1} / ${list.length}</span>
               <button type="button" class="btn btn-soft btn-sm" id="zoom-next">다음 ›</button>
             </div>`
          : ""
      }
    `,
    footerHtml: `<button type="button" class="btn btn-primary btn-sm" id="img-close">닫기</button>`,
    onMount(body, footer) {
      footer.querySelector("#img-close").addEventListener("click", closeDialog);
      if (list.length > 1) {
        const imgEl = body.querySelector("#zoom-img-el");
        const cntEl = body.querySelector("#zoom-counter");
        const update = (next) => {
          idx = (next + list.length) % list.length;
          imgEl.src = list[idx];
          cntEl.textContent = `${idx + 1} / ${list.length}`;
        };
        body.querySelector("#zoom-prev").addEventListener("click", () => update(idx - 1));
        body.querySelector("#zoom-next").addEventListener("click", () => update(idx + 1));
      }
    },
  });
}

function openVoucherModal(item) {
  const vouchers = Array.isArray(item.vouchers) ? item.vouchers : [];
  openDialog({
    title: `🎫 바우처 · 예약증 (${item.title})`,
    bodyHtml: `
      <p style="font-size:13px;color:var(--text-muted);margin-top:0;">
        항공 E-티켓, 호텔 예약증, 디즈니·케이블카 QR 이미지를 첨부해 두면 줄 설 때 1초 만에 꺼내 볼 수 있습니다.
      </p>
      <div style="margin-bottom:12px;">
        <button type="button" class="btn btn-primary btn-block" id="btn-upload-voucher">📎 바우처 이미지/PDF 추가</button>
      </div>
      ${
        vouchers.length === 0
          ? `<div style="text-align:center;color:var(--text-muted);padding:18px 0;font-size:13px;">아직 첨부된 바우처가 없습니다.</div>`
          : vouchers
              .map(
                (v, i) => `
              <div class="card" style="padding:10px;margin-bottom:8px;">
                <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:6px;">
                  <strong style="font-size:13px;">${esc(v.name || `바우처 ${i + 1}`)}</strong>
                  <button type="button" class="btn btn-danger btn-sm" style="min-height:28px;padding:3px 8px;" data-del-voucher="${i}">삭제</button>
                </div>
                ${
                  v.type === "pdf" || String(v.url).endsWith(".pdf")
                    ? `<a href="${esc(v.url)}" target="_blank" rel="noopener" class="btn btn-soft btn-sm btn-block">📄 PDF 파일 열기</a>`
                    : `<img src="${esc(v.url)}" alt="${esc(v.name)}" style="width:100%;border-radius:10px;border:1px solid var(--border);" />`
                }
              </div>`
              )
              .join("")
      }
    `,
    footerHtml: `<button type="button" class="btn btn-soft btn-sm" id="voucher-close">닫기</button>`,
    onMount(body, footer) {
      footer.querySelector("#voucher-close").addEventListener("click", closeDialog);
      body.querySelector("#btn-upload-voucher").addEventListener("click", () => {
        state.pendingVoucherItemId = item.id;
        $("#voucher-file-input").value = "";
        $("#voucher-file-input").click();
      });
      body.querySelectorAll("[data-del-voucher]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const idx = Number(btn.dataset.delVoucher);
          const next = vouchers.filter((_, i) => i !== idx);
          await store.saveItinerary({ ...item, vouchers: next });
          await refreshData(true);
          openVoucherModal({ ...item, vouchers: next });
          showToast("바우처를 삭제했습니다.");
        });
      });
    },
  });
}

function openItineraryModal(existing) {
  const trip = getActiveTrip();
  const dates = getTripDates(trip);
  const isEdit = Boolean(existing);
  const defaultDate =
    state.activeDayDate && state.activeDayDate !== "ALL" ? state.activeDayDate : dates[0]?.date || trip.start_date;

  const it = existing || {
    day_date: defaultDate,
    time_str: "12:00",
    category: "관광",
    title: "",
    local_name: "",
    address: "",
    map_query: "",
    details: "",
    transport: "",
    reservation_status: "불필요",
    skipped: false,
  };

  openDialog({
    title: isEdit ? "일정 수정" : "새 일정 추가",
    bodyHtml: `
      <form id="it-form">
        <div class="field-row">
          <div class="field">
            <label>날짜</label>
            <select name="day_date">
              ${dates
                .map((d) => `<option value="${d.date}" ${d.date === it.day_date ? "selected" : ""}>${d.label}</option>`)
                .join("")}
            </select>
          </div>
          <div class="field">
            <label>시간</label>
            <input name="time_str" value="${esc(it.time_str)}" placeholder="예: 14:30" />
          </div>
        </div>
        <div class="field-row">
          <div class="field">
            <label>구분</label>
            <select name="category">
              ${["관광", "식사", "이동", "숙소", "항공", "쇼핑", "기타"]
                .map((c) => `<option value="${c}" ${c === it.category ? "selected" : ""}>${c}</option>`)
                .join("")}
            </select>
          </div>
          <div class="field">
            <label>예약 상태</label>
            <select name="reservation_status">
              ${["불필요", "권장", "필수", "완료"]
                .map((r) => `<option value="${r}" ${r === it.reservation_status ? "selected" : ""}>${r}</option>`)
                .join("")}
            </select>
          </div>
        </div>
        <div class="field">
          <label>일정 제목 *</label>
          <input name="title" value="${esc(it.title)}" placeholder="예: 점심: 딤섬스퀘어" required />
        </div>
        <div class="field">
          <label>현지어 / 영문 상호 (택시 카드용)</label>
          <input name="local_name" value="${esc(it.local_name || "")}" placeholder="예: 點心廣場 Dim Sum Square" />
        </div>
        <div class="field">
          <label>주소 / 구글맵 검색어</label>
          <input name="address" value="${esc(it.address || "")}" placeholder="예: 78 Jervois St, Sheung Wan, Hong Kong" />
        </div>
        <div class="field">
          <label>이동 수단</label>
          <input name="transport" value="${esc(it.transport || "")}" placeholder="예: MTR / 도보 / 택시" />
        </div>
        <div class="field">
          <label>상세 · 팁</label>
          <textarea name="details" rows="3">${esc(it.details || "")}</textarea>
        </div>
        ${
          isEdit
            ? `<label style="display:flex;align-items:center;gap:8px;font-size:13px;font-weight:700;">
                 <input type="checkbox" name="skipped" ${it.skipped ? "checked" : ""} /> 이 일정 건너뛰기(취소선)
               </label>`
            : ""
        }
      </form>
    `,
    footerHtml: `
      ${isEdit ? `<button type="button" class="btn btn-danger btn-sm" id="btn-del-it" style="margin-right:auto;">삭제</button>` : ""}
      <button type="button" class="btn btn-soft btn-sm" id="btn-cancel-it">취소</button>
      <button type="submit" form="it-form" class="btn btn-primary btn-sm">저장</button>
    `,
    onMount(body, footer) {
      footer.querySelector("#btn-cancel-it").addEventListener("click", closeDialog);
      footer.querySelector("#btn-del-it")?.addEventListener("click", async () => {
        if (!confirm("이 일정을 삭제할까요?")) return;
        await store.deleteItinerary(it.id);
        closeDialog();
        await refreshData(true);
        showToast("일정이 삭제되었습니다.");
      });
      body.querySelector("#it-form").addEventListener("submit", async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const dayDate = fd.get("day_date");
        const dayObj = dates.find((d) => d.date === dayDate);
        const sameDayCount = state.db.itinerary.filter((x) => x.trip_id === trip.id && x.day_date === dayDate).length;
        const addr = fd.get("address").trim();
        const localName = fd.get("local_name").trim();
        const title = fd.get("title").trim();

        const next = {
          ...(existing || {
            id: uid("it"),
            trip_id: trip.id,
            sort_order: sameDayCount + 1,
            alternatives: [],
            photos: [],
            vouchers: [],
            completed: false,
          }),
          day_date: dayDate,
          day_label: dayObj?.label || dayDate,
          time_str: fd.get("time_str").trim(),
          category: fd.get("category"),
          reservation_status: fd.get("reservation_status"),
          title,
          local_name: localName,
          address: addr,
          map_query: addr || localName || `${title} ${trip.destination}`,
          transport: fd.get("transport").trim(),
          details: fd.get("details").trim(),
          skipped: Boolean(fd.get("skipped")),
        };

        await store.saveItinerary(next);
        state.activeDayDate = dayDate;
        closeDialog();
        await refreshData(true);
        showToast(isEdit ? "일정이 수정되었습니다." : "새 일정이 추가되었습니다.");
      });
    },
  });
}

// ============================================================
// 2. 지도 · 후보 탭 (Leaflet 무료지도 + Google Maps 임베드 전환 + 딥링크)
// ============================================================
async function renderMapTab() {
  const trip = getActiveTrip();
  const dates = getTripDates(trip);
  const cfg = getAppConfig();
  const hasGoogleKey = Boolean(cfg.googleMapsApiKey);

  const allItems = state.db.itinerary.filter((i) => i.trip_id === trip.id);
  const allCandidates = state.db.candidates.filter((c) => c.trip_id === trip.id);

  const mapItems =
    state.mapFilter === "candidates"
      ? []
      : state.mapFilter === "all"
      ? allItems
      : allItems.filter((i) => i.day_date === state.mapFilter);

  const mapCands =
    state.mapFilter === "all" || state.mapFilter === "candidates" ? allCandidates : [];

  const html = `
    <div class="map-toolbar">
      <div style="display:flex;gap:6px;">
        <button type="button" class="btn btn-sm ${state.mapEngine === "leaflet" ? "btn-primary" : "btn-soft"}" id="btn-engine-osm">🗺️ 무료 지도</button>
        <button type="button" class="btn btn-sm ${state.mapEngine === "google" && hasGoogleKey ? "btn-accent" : "btn-soft"}" id="btn-engine-gmap">
          🌐 Google Maps${hasGoogleKey ? "" : " (키 설정)"}
        </button>
      </div>
      <button type="button" class="btn btn-soft btn-sm" id="btn-my-loc">📍 내 위치</button>
    </div>

    <div class="day-tabs" style="padding-bottom:6px;">
      <button type="button" class="day-chip ${state.mapFilter === "all" ? "active" : ""}" data-mfilter="all">전체 보기</button>
      <button type="button" class="day-chip ${state.mapFilter === "candidates" ? "active" : ""}" data-mfilter="candidates">★ 후보만</button>
      ${dates
        .map(
          (d, idx) =>
            `<button type="button" class="day-chip ${state.mapFilter === d.date ? "active" : ""}" data-mfilter="${d.date}">Day ${idx + 1}</button>`
        )
        .join("")}
    </div>

    <div id="trip-map-box" class="map-container"></div>
    <div id="map-status-line" class="map-status">지도를 준비하고 있습니다...</div>
    <div id="map-pin-preview"></div>

    <div class="section-header">
      <h2 class="section-title">★ 후보 식당 · 여행지 (${allCandidates.length})</h2>
      <div style="display:flex;gap:6px;">
        <button type="button" class="btn btn-soft btn-sm" id="btn-export-mymaps" title="Google My Maps 일괄 가져오기용 CSV">📥 구글맵 CSV</button>
        <button type="button" class="btn btn-primary btn-sm" id="btn-add-cand">+ 후보 추가</button>
      </div>
    </div>

    <div class="day-tabs" style="padding-bottom:8px;">
      ${[
        ["all", `전체 (${allCandidates.length})`],
        ["pending", "✨ 대기 후보만"],
        ["central", "셩완·센트럴"],
        ["kowloon", "침사추이·조던·몽콕"],
        ["peak", "피크·완차이"],
        ["lantau", "디즈니·옹핑"],
      ]
        .map(
          ([k, label]) =>
            `<button type="button" class="day-chip ${state.candFilter === k ? "active" : ""}" data-cfilter="${k}">${label}</button>`
        )
        .join("")}
    </div>

    <div id="candidate-list">
      ${allCandidates
        .filter((c) => {
          const area = `${c.area || ""} ${c.address || ""}`;
          if (state.candFilter === "pending") return !c.is_added;
          if (state.candFilter === "central") return /셩완|센트럴|소호|Central|Sheung Wan/i.test(area);
          if (state.candFilter === "kowloon") return /침사추이|조던|몽콕|Jordan|Tsim Sha Tsui|Mong Kok/i.test(area);
          if (state.candFilter === "peak") return /피크|완차이|Peak|Wan Chai/i.test(area);
          if (state.candFilter === "lantau") return /디즈니|옹핑|란터우|Disney|Lantau/i.test(area);
          return true;
        })
        .map((c) => {
          const query = c.map_query || c.address || `${c.name} ${trip.destination}`;
          const sym = getCurrencySymbol(trip.currency);
          return `
          <article class="card">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">
              <div>
                <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:4px;">
                  <span class="badge ${c.category === "식당" ? "badge-amber" : "badge-teal"}">${esc(c.category)}</span>
                  ${c.area ? `<span class="badge badge-gray">${esc(c.area)}</span>` : ""}
                  ${c.is_added ? `<span class="badge badge-green">일정 반영됨</span>` : `<span class="badge badge-blue">대기 후보</span>`}
                  ${c.reservation && c.reservation !== "불필요" ? `<span class="badge badge-rose">예약:${esc(c.reservation)}</span>` : ""}
                </div>
                <h3 style="margin:0;font-size:15px;font-weight:800;">${esc(c.name)}</h3>
                ${c.local_name ? `<div style="font-size:12px;color:var(--text-muted);">${esc(c.local_name)}</div>` : ""}
              </div>
              ${
                c.est_price_local
                  ? `<div style="text-align:right;flex-shrink:0;">
                       <div style="font-weight:800;font-size:13px;color:var(--primary-dark);">1인 ${sym}${fmtNum(c.est_price_local)}</div>
                       <div style="font-size:11px;color:var(--text-muted);">약 ${fmtNum(c.est_price_local * trip.exchange_rate)}원</div>
                     </div>`
                  : ""
              }
            </div>
            ${c.recommended_menu ? `<div style="font-size:13px;margin-top:6px;">🍽️ <b>추천:</b> ${esc(c.recommended_menu)}</div>` : ""}
            ${c.memo ? `<div style="font-size:12px;color:#334155;margin-top:6px;white-space:pre-line;line-height:1.5;background:var(--surface-soft);padding:8px 10px;border-radius:10px;">${esc(c.memo)}</div>` : ""}
            ${
              c.photo
                ? `<div class="it-photos">${String(c.photo)
                    .split("|")
                    .filter(Boolean)
                    .map((src, pIdx) => `<img src="${esc(src)}" alt="${esc(c.name)}" loading="lazy" data-zoom-img="${esc(src)}" data-zoom-idx="${pIdx}" />`)
                    .join("")}</div>`
                : ""
            }
            <div class="it-actions">
              <a class="btn btn-accent btn-sm" href="${getGoogleMapsSearchUrl(query)}" target="_blank" rel="noopener">📍 구글맵</a>
              <a class="btn btn-soft btn-sm" href="${getGoogleMapsDirectionsUrl(query)}" target="_blank" rel="noopener">🧭 길찾기</a>
              <button type="button" class="btn btn-primary btn-sm" data-cand-to-it="${esc(c.id)}">🗓️ 일정에 넣기</button>
              ${c.local_name || c.address ? `<button type="button" class="btn btn-soft btn-sm" data-cand-taxi="${esc(c.id)}">🚕 기사님</button>` : ""}
              <button type="button" class="btn btn-soft btn-sm" data-edit-cand="${esc(c.id)}">✏️</button>
            </div>
          </article>`;
        })
        .join("")}
    </div>
  `;

  mainContent.innerHTML = html;

  // 버튼 이벤트
  $("#btn-engine-osm").addEventListener("click", () => {
    state.mapEngine = "leaflet";
    renderMapTab();
  });
  $("#btn-engine-gmap").addEventListener("click", () => {
    if (!getAppConfig().googleMapsApiKey) {
      showToast("설정에서 Google Maps API 키를 입력하면 구글맵을 직접 띄울 수 있습니다.", 3500);
      openSettingsModal();
      return;
    }
    state.mapEngine = "google";
    renderMapTab();
  });
  $("#btn-my-loc").addEventListener("click", () => {
    if (!navigator.geolocation) return showToast("이 기기에서 GPS를 지원하지 않습니다.");
    showToast("현재 위치를 확인하는 중...");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        state.userLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        showToast("현재 위치를 지도에 표시했습니다!");
        renderMapTab();
      },
      () => showToast("위치 권한이 거부되었습니다. 브라우저 설정을 확인해 주세요.")
    );
  });

  mainContent.querySelectorAll("[data-mfilter]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.mapFilter = btn.dataset.mfilter;
      renderMapTab();
    });
  });

  mainContent.querySelectorAll("[data-cfilter]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.candFilter = btn.dataset.cfilter;
      renderMapTab();
    });
  });

  $("#btn-add-cand").addEventListener("click", () => openCandidateModal(null));
  $("#btn-export-mymaps")?.addEventListener("click", () => {
    exportGoogleMyMapsCsv({ trip, candidates: allCandidates });
    showToast("CSV 다운로드 완료! Google My Maps에서 '가져오기'로 한 번에 등록하세요.", 4000);
  });
  mainContent.querySelectorAll("[data-edit-cand]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const c = allCandidates.find((x) => x.id === btn.dataset.editCand);
      if (c) openCandidateModal(c);
    });
  });
  mainContent.querySelectorAll("[data-cand-taxi]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const c = allCandidates.find((x) => x.id === btn.dataset.candTaxi);
      if (c) openTaxiCardModal(c.name, c.local_name, c.address);
    });
  });
  mainContent.querySelectorAll("[data-cand-to-it]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const c = allCandidates.find((x) => x.id === btn.dataset.candToIt);
      if (c) openAddCandidateToItineraryModal(c);
    });
  });
  mainContent.querySelectorAll("[data-zoom-img]").forEach((img) => {
    img.addEventListener("click", () => {
      const parent = img.closest(".it-photos");
      const groupImgs = parent ? Array.from(parent.querySelectorAll("img")).map((el) => el.dataset.zoomImg) : [img.dataset.zoomImg];
      const startIdx = Number(img.dataset.zoomIdx) || 0;
      openImageZoomModal(groupImgs, img.alt, startIdx);
    });
  });

  // 지도 렌더링
  const mapEl = $("#trip-map-box");
  const statusEl = $("#map-status-line");
  const previewEl = $("#map-pin-preview");

  try {
    await renderTripMap(mapEl, {
      engine: state.mapEngine,
      destination: trip.destination,
      items: mapItems,
      candidates: mapCands,
      dayDates: dates.map((d) => d.date),
      userLoc: state.userLocation,
      onStatus: (txt) => {
        if (statusEl) statusEl.textContent = txt;
      },
      onSelectPin: (target, coords) => {
        const distTxt = state.userLocation
          ? ` · 내 위치에서 약 ${calcDistanceKm(state.userLocation.lat, state.userLocation.lng, coords.lat, coords.lng).toFixed(1)}km`
          : "";
        previewEl.innerHTML = `
          <div class="card" style="border:2px solid var(--primary);background:#f0fdfa;">
            <div style="font-size:12px;color:var(--primary-dark);font-weight:700;">${esc(target.sub)}${distTxt}</div>
            <div style="font-size:16px;font-weight:800;margin:3px 0 8px;">${esc(target.title)}</div>
            <div style="display:flex;gap:6px;flex-wrap:wrap;">
              <a class="btn btn-accent btn-sm" href="${getGoogleMapsSearchUrl(target.query)}" target="_blank" rel="noopener">📍 구글맵 열기</a>
              <a class="btn btn-primary btn-sm" href="${getGoogleMapsDirectionsUrl(target.query)}" target="_blank" rel="noopener">🧭 구글맵 길찾기</a>
            </div>
          </div>
        `;
      },
    });
  } catch (err) {
    if (statusEl) statusEl.textContent = `지도 로드 오류: ${err.message}`;
  }
}

function openAddCandidateToItineraryModal(cand) {
  const trip = getActiveTrip();
  const dates = getTripDates(trip);
  openDialog({
    title: `🗓️ '${cand.name}' 일정에 넣기`,
    bodyHtml: `
      <form id="cand-to-it-form">
        <div class="field-row">
          <div class="field">
            <label>어느 날에 넣을까요?</label>
            <select name="day_date">
              ${dates
                .map((d) => `<option value="${d.date}" ${d.date === cand.planned_day_date ? "selected" : ""}>${d.label}</option>`)
                .join("")}
            </select>
          </div>
          <div class="field">
            <label>시간</label>
            <input name="time_str" value="12:30" />
          </div>
        </div>
      </form>
    `,
    footerHtml: `
      <button type="button" class="btn btn-soft btn-sm" id="c2i-cancel">취소</button>
      <button type="submit" form="cand-to-it-form" class="btn btn-primary btn-sm">일정에 추가</button>
    `,
    onMount(body, footer) {
      footer.querySelector("#c2i-cancel").addEventListener("click", closeDialog);
      body.querySelector("#cand-to-it-form").addEventListener("submit", async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const dayDate = fd.get("day_date");
        const dayObj = dates.find((d) => d.date === dayDate);
        const count = state.db.itinerary.filter((i) => i.trip_id === trip.id && i.day_date === dayDate).length;

        await store.saveItinerary({
          id: uid("it"),
          trip_id: trip.id,
          day_date: dayDate,
          day_label: dayObj?.label || dayDate,
          time_str: fd.get("time_str").trim(),
          sort_order: count + 1,
          category: cand.category === "식당" || cand.category === "카페/간식" ? "식사" : "관광",
          title: cand.name,
          local_name: cand.local_name || "",
          address: cand.address || "",
          map_query: cand.map_query || cand.address || cand.name,
          details: [cand.recommended_menu ? `추천: ${cand.recommended_menu}` : "", cand.memo].filter(Boolean).join("\n"),
          transport: "",
          reservation_status: cand.reservation || "불필요",
          alternatives: [],
          photos: cand.photo ? String(cand.photo).split("|").filter(Boolean) : [],
          vouchers: [],
          completed: false,
          skipped: false,
        });
        await store.saveCandidate({ ...cand, is_added: true });
        closeDialog();
        await refreshData(true);
        showToast(`${dayObj?.label || dayDate} 일정에 추가했습니다!`);
      });
    },
  });
}

function openCandidateModal(existing) {
  const trip = getActiveTrip();
  const isEdit = Boolean(existing);
  const c = existing || {
    category: "식당",
    name: "",
    local_name: "",
    area: "",
    address: "",
    recommended_menu: "",
    est_price_local: 0,
    reservation: "불필요",
    memo: "",
    is_added: false,
  };

  openDialog({
    title: isEdit ? "후보 장소 수정" : "새 후보 식당·여행지 추가",
    bodyHtml: `
      <form id="cand-form">
        <div class="field-row">
          <div class="field">
            <label>분류</label>
            <select name="category">
              ${["식당", "카페/간식", "관광", "쇼핑", "야경/쇼"]
                .map((x) => `<option value="${x}" ${x === c.category ? "selected" : ""}>${x}</option>`)
                .join("")}
            </select>
          </div>
          <div class="field">
            <label>지역</label>
            <input name="area" value="${esc(c.area || "")}" placeholder="예: 셩완, 침사추이" />
          </div>
        </div>
        <div class="field">
          <label>장소명 *</label>
          <input name="name" value="${esc(c.name)}" placeholder="예: 카우키 소고기 국수" required />
        </div>
        <div class="field">
          <label>현지어 / 영문명</label>
          <input name="local_name" value="${esc(c.local_name || "")}" placeholder="예: 九記牛腩 Kau Kee" />
        </div>
        <div class="field">
          <label>주소 또는 구글맵 검색어</label>
          <input name="address" value="${esc(c.address || "")}" placeholder="예: 21 Gough St, Central, Hong Kong" />
        </div>
        <div class="field-row">
          <div class="field">
            <label>1인 예상 금액 (${esc(trip.currency)})</label>
            <input type="number" step="0.1" name="est_price_local" value="${esc(c.est_price_local || 0)}" />
          </div>
          <div class="field">
            <label>예약 필요 여부</label>
            <select name="reservation">
              ${["불필요", "권장", "필수"]
                .map((r) => `<option value="${r}" ${r === c.reservation ? "selected" : ""}>${r}</option>`)
                .join("")}
            </select>
          </div>
        </div>
        <div class="field">
          <label>추천 메뉴 / 볼거리</label>
          <input name="recommended_menu" value="${esc(c.recommended_menu || "")}" />
        </div>
        <div class="field">
          <label>메모</label>
          <textarea name="memo" rows="2">${esc(c.memo || "")}</textarea>
        </div>
      </form>
    `,
    footerHtml: `
      ${isEdit ? `<button type="button" class="btn btn-danger btn-sm" id="btn-del-cand" style="margin-right:auto;">삭제</button>` : ""}
      <button type="button" class="btn btn-soft btn-sm" id="btn-cancel-cand">취소</button>
      <button type="submit" form="cand-form" class="btn btn-primary btn-sm">저장</button>
    `,
    onMount(body, footer) {
      footer.querySelector("#btn-cancel-cand").addEventListener("click", closeDialog);
      footer.querySelector("#btn-del-cand")?.addEventListener("click", async () => {
        if (!confirm("이 후보 장소를 삭제할까요?")) return;
        await store.deleteCandidate(c.id);
        closeDialog();
        await refreshData(true);
        showToast("후보 장소가 삭제되었습니다.");
      });
      body.querySelector("#cand-form").addEventListener("submit", async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const name = fd.get("name").trim();
        const addr = fd.get("address").trim();
        const localName = fd.get("local_name").trim();
        await store.saveCandidate({
          ...(existing || { id: uid("cand"), trip_id: trip.id, photo: "", is_added: false }),
          category: fd.get("category"),
          area: fd.get("area").trim(),
          name,
          local_name: localName,
          address: addr,
          map_query: addr || localName || `${name} ${trip.destination}`,
          est_price_local: Number(fd.get("est_price_local")) || 0,
          reservation: fd.get("reservation"),
          recommended_menu: fd.get("recommended_menu").trim(),
          memo: fd.get("memo").trim(),
        });
        closeDialog();
        await refreshData(true);
        showToast("후보 장소가 저장되었습니다.");
      });
    },
  });
}

// ============================================================
// 3. 가계부 탭 (영수증 AI + 예산 비교 + 지갑별 잔액 + 정산 리포트)
// ============================================================
function calcBudgetTotals(trip) {
  const localPlan = (trip.budget_plan?.local_items || []).reduce(
    (s, it) => s + (Number(it.adult_qty) * Number(it.adult_price) + Number(it.child_qty) * Number(it.child_price)),
    0
  );
  const localPlanKrw = Math.round(localPlan * (Number(trip.exchange_rate) || 1));
  const krwPlan = (trip.budget_plan?.krw_items || []).reduce((s, it) => s + (Number(it.total_krw) || 0), 0);
  return { localPlan, localPlanKrw, krwPlan, totalPlanKrw: localPlanKrw + krwPlan };
}

function renderBudgetTab() {
  const trip = getActiveTrip();
  const sym = getCurrencySymbol(trip.currency);
  const expenses = state.db.expenses
    .filter((e) => e.trip_id === trip.id)
    .sort((a, b) => String(b.spent_at || "").localeCompare(String(a.spent_at || "")));

  const totals = calcBudgetTotals(trip);
  const totalSpentKrw = expenses.reduce((s, e) => s + (Number(e.amount_krw) || 0), 0);
  const localSpent = expenses
    .filter((e) => e.currency === trip.currency)
    .reduce((s, e) => s + (Number(e.amount_local) || 0), 0);
  const pct = totals.totalPlanKrw > 0 ? Math.min(100, Math.round((totalSpentKrw / totals.totalPlanKrw) * 100)) : 0;
  const remainingKrw = totals.totalPlanKrw - totalSpentKrw;

  // 카테고리별 집계
  const catSpent = {};
  for (const e of expenses) {
    const k = e.category === "간식" ? "식비" : e.category || "기타";
    catSpent[k] = (catSpent[k] || 0) + (Number(e.amount_krw) || 0);
  }
  const catPlan = {};
  for (const it of trip.budget_plan?.local_items || []) {
    const amt = (Number(it.adult_qty) * Number(it.adult_price) + Number(it.child_qty) * Number(it.child_price)) * trip.exchange_rate;
    catPlan[it.category] = (catPlan[it.category] || 0) + amt;
  }
  for (const it of trip.budget_plan?.krw_items || []) {
    catPlan[it.category] = (catPlan[it.category] || 0) + (Number(it.total_krw) || 0);
  }
  const allCats = Array.from(new Set([...Object.keys(catPlan), ...Object.keys(catSpent)]));

  // 지갑별 잔액 계산
  const wallets = trip.wallets || [];
  const walletMap = Object.fromEntries(wallets.map((w) => [w.id, w]));

  const html = `
    <section class="budget-hero">
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <span style="font-size:12px;opacity:0.85;">총 실제 지출 (현지 + 원화)</span>
        <span class="badge badge-teal">${pct}% 사용</span>
      </div>
      <div class="budget-hero-amount">${fmtNum(totalSpentKrw)}원</div>
      <div style="font-size:12px;opacity:0.88;">
        현지 지출: <b>${sym}${fmtMoney(localSpent, 1)}</b> · 예상 총예산: ${fmtNum(totals.totalPlanKrw)}원
      </div>
      <div class="progress-track">
        <div class="progress-fill ${pct > 100 ? "over" : pct > 80 ? "warn" : ""}" style="width:${pct}%;"></div>
      </div>
      <div style="display:flex;justify-content:space-between;font-size:12px;opacity:0.9;">
        <span>${remainingKrw >= 0 ? `남은 예산: ${fmtNum(remainingKrw)}원` : `예산 초과: +${fmtNum(Math.abs(remainingKrw))}원`}</span>
        <span>환율 1${esc(trip.currency)} = ${fmtNum(trip.exchange_rate)}원</span>
      </div>
    </section>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px;">
      <button type="button" class="btn btn-amber" id="btn-budget-camera">📷 영수증 자동등록</button>
      <button type="button" class="btn btn-primary" id="btn-budget-manual">✏️ 직접 지출입력</button>
    </div>

    <div class="section-header">
      <h2 class="section-title">👛 결제수단 · 지갑 잔액</h2>
      <button type="button" class="btn btn-soft btn-sm" id="btn-edit-wallets">초기액/충전 수정</button>
    </div>
    <div class="wallet-grid">
      ${wallets
        .map((w) => {
          const spentLocal = expenses
            .filter((e) => e.wallet_id === w.id && e.currency === w.currency)
            .reduce((s, e) => s + (Number(e.amount_local) || 0), 0);
          const spentKrw = expenses
            .filter((e) => e.wallet_id === w.id)
            .reduce((s, e) => s + (Number(e.amount_krw) || 0), 0);
          const isKrwWallet = w.currency === "KRW";
          const bal = Number(w.initial_local || 0) - spentLocal;
          const wSym = getCurrencySymbol(w.currency);
          return `
          <div class="wallet-card">
            <div class="wallet-name">${w.type === "cash" ? "💵" : w.type === "octopus" ? "🐙" : "💳"} ${esc(w.name)}</div>
            <div class="wallet-bal" style="color:${!isKrwWallet && bal < 0 ? "var(--danger)" : "var(--text)"};">
              ${isKrwWallet ? `${fmtNum(spentKrw)}원 사용` : `${wSym}${fmtMoney(bal, 1)}`}
            </div>
            <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">
              ${isKrwWallet ? "누적 결제액" : `충전 ${wSym}${fmtNum(w.initial_local)} / 사용 ${wSym}${fmtMoney(spentLocal, 1)}`}
            </div>
          </div>`;
        })
        .join("")}
    </div>

    ${
      allCats.length
        ? `<div class="card">
            <div style="font-weight:800;font-size:14px;margin-bottom:10px;">📊 카테고리별 예산 대비 지출</div>
            ${allCats
              .map((cat) => {
                const p = Math.round(catPlan[cat] || 0);
                const s = Math.round(catSpent[cat] || 0);
                const r = p > 0 ? Math.min(100, Math.round((s / p) * 100)) : s > 0 ? 100 : 0;
                return `
                <div style="margin-bottom:8px;">
                  <div style="display:flex;justify-content:space-between;font-size:12px;">
                    <b>${esc(cat)}</b>
                    <span>${fmtNum(s)}원 ${p > 0 ? `/ ${fmtNum(p)}원 (${r}%)` : ""}</span>
                  </div>
                  <div class="progress-track light">
                    <div class="progress-fill ${s > p && p > 0 ? "over" : r > 80 ? "warn" : ""}" style="width:${r}%;"></div>
                  </div>
                </div>`;
              })
              .join("")}
          </div>`
        : ""
    }

    <div style="display:flex;gap:8px;margin-bottom:12px;">
      <button type="button" class="btn btn-soft btn-sm" style="flex:1;" id="btn-recap-report">📈 여행 정산 리포트</button>
      <button type="button" class="btn btn-soft btn-sm" style="flex:1;" id="btn-export-xlsx">📥 엑셀(.xlsx) 내보내기</button>
    </div>

    <div class="section-header">
      <h2 class="section-title">🧾 지출 내역 (${expenses.length}건)</h2>
    </div>

    ${
      expenses.length === 0
        ? `<div class="card" style="text-align:center;color:var(--text-muted);padding:24px;">아직 지출 내역이 없습니다.<br/>하단 <b>📷 영수증 버튼</b>을 눌러 첫 영수증을 찍어보세요!</div>`
        : expenses
            .map((e) => {
              const wName = walletMap[e.wallet_id]?.name || e.wallet_id || "";
              const eSym = getCurrencySymbol(e.currency);
              return `
              <div class="expense-row">
                ${
                  e.receipt_url
                    ? `<img class="expense-thumb" src="${esc(e.receipt_url)}" alt="영수증" data-zoom-img="${esc(e.receipt_url)}" />`
                    : `<div class="expense-thumb-placeholder">🧾</div>`
                }
                <div style="flex:1;min-width:0;">
                  <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:6px;">
                    <strong style="font-size:14px;">${esc(e.merchant)}</strong>
                    <div style="text-align:right;flex-shrink:0;">
                      <div style="font-weight:800;font-size:14px;color:var(--primary-dark);">${fmtNum(e.amount_krw)}원</div>
                      ${e.currency !== "KRW" ? `<div style="font-size:11px;color:var(--text-muted);">${eSym}${fmtMoney(e.amount_local, 1)}</div>` : ""}
                    </div>
                  </div>
                  <div style="display:flex;gap:5px;flex-wrap:wrap;margin:4px 0;">
                    <span class="badge ${getCategoryBadge(e.category)}">${esc(e.category)}</span>
                    ${wName ? `<span class="badge badge-gray">${esc(wName)}</span>` : ""}
                    ${e.day_date ? `<span style="font-size:11px;color:var(--text-muted);">${esc(e.day_date)}</span>` : ""}
                  </div>
                  ${e.items_summary ? `<div style="font-size:12px;color:#334155;">${esc(e.items_summary)}</div>` : ""}
                  ${e.memo ? `<div style="font-size:11px;color:var(--text-muted);margin-top:2px;">메모: ${esc(e.memo)}</div>` : ""}
                  <div style="margin-top:6px;">
                    <button type="button" class="btn btn-soft btn-sm" style="min-height:28px;padding:3px 9px;" data-edit-exp="${esc(e.id)}">✏️ 수정</button>
                  </div>
                </div>
              </div>`;
            })
            .join("")
    }
  `;

  mainContent.innerHTML = html;

  $("#btn-budget-camera").addEventListener("click", openReceiptChooserModal);
  $("#btn-budget-manual").addEventListener("click", () => openExpenseFormModal(null));
  $("#btn-edit-wallets").addEventListener("click", openWalletsModal);
  $("#btn-recap-report").addEventListener("click", openRecapReportModal);
  $("#btn-export-xlsx").addEventListener("click", async () => {
    showToast("엑셀 파일을 생성하는 중...");
    try {
      await exportTripToExcel({
        trip,
        itinerary: state.db.itinerary.filter((i) => i.trip_id === trip.id),
        candidates: state.db.candidates.filter((c) => c.trip_id === trip.id),
        expenses,
        checklists: state.db.checklists.filter((c) => c.trip_id === trip.id),
      });
      showToast("엑셀 파일이 다운로드되었습니다!");
    } catch (err) {
      showToast(`엑셀 내보내기 실패: ${err.message}`, 3500);
    }
  });

  mainContent.querySelectorAll("[data-edit-exp]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const e = expenses.find((x) => x.id === btn.dataset.editExp);
      if (e) openExpenseFormModal(e);
    });
  });
  mainContent.querySelectorAll("[data-zoom-img]").forEach((img) => {
    img.addEventListener("click", () => openImageZoomModal(img.dataset.zoomImg, "영수증 원본"));
  });
}

function openReceiptChooserModal() {
  if (!getActiveTrip()) {
    showToast("먼저 여행을 선택해 주세요.");
    return;
  }
  openDialog({
    title: "📷 영수증 가계부 등록",
    bodyHtml: `
      <p style="font-size:13px;color:var(--text-muted);margin-top:0;">
        영수증을 찍거나 앨범에서 고르면 <b>Gemini AI</b>가 가게명·현지 금액·원화 환산·카테고리·품목을 자동으로 채워줍니다.
      </p>
      <div style="display:flex;flex-direction:column;gap:10px;">
        <button type="button" class="btn btn-amber btn-block" id="rc-camera">📸 카메라로 영수증 촬영</button>
        <button type="button" class="btn btn-primary btn-block" id="rc-gallery">🖼️ 앨범에서 영수증 사진 선택</button>
        <button type="button" class="btn btn-soft btn-block" id="rc-manual">✏️ 사진 없이 직접 입력</button>
      </div>
    `,
    footerHtml: `<button type="button" class="btn btn-soft btn-sm" id="rc-close">닫기</button>`,
    onMount(body, footer) {
      footer.querySelector("#rc-close").addEventListener("click", closeDialog);
      body.querySelector("#rc-camera").addEventListener("click", () => {
        closeDialog();
        $("#receipt-file-input").value = "";
        $("#receipt-file-input").click();
      });
      body.querySelector("#rc-gallery").addEventListener("click", () => {
        closeDialog();
        $("#receipt-gallery-input").value = "";
        $("#receipt-gallery-input").click();
      });
      body.querySelector("#rc-manual").addEventListener("click", () => {
        closeDialog();
        openExpenseFormModal(null);
      });
    },
  });
}

async function handleReceiptFileSelected(file) {
  const trip = getActiveTrip();
  if (!file || !trip) return;

  openDialog({
    title: "🤖 영수증 AI 분석 중...",
    bodyHtml: `<div style="text-align:center;padding:24px 10px;">
      <div style="font-size:38px;margin-bottom:10px;">🧾✨</div>
      <div style="font-weight:700;margin-bottom:6px;">사진을 압축하고 영수증을 읽는 중입니다...</div>
      <div style="font-size:12px;color:var(--text-muted);">가게명, 금액, 환율, 품목을 자동으로 추출합니다.</div>
    </div>`,
  });

  try {
    const compressed = await compressImageFile(file);
    const [receiptUrl, aiRes] = await Promise.all([
      store.uploadFile(compressed.blob, `receipts/${trip.id}`, "jpg"),
      analyzeReceiptWithAI({
        base64: compressed.base64,
        mimeType: compressed.mimeType,
        defaultCurrency: trip.currency,
        tripContext: `${trip.title} (${trip.destination}, ${trip.start_date}~${trip.end_date})`,
      }),
    ]);

    const d = aiRes.ok ? aiRes.data : {};
    const currency = d.currency || trip.currency;
    const rate = currency === "KRW" ? 1 : currency === trip.currency ? Number(trip.exchange_rate) : (CURRENCY_PRESETS.find((c) => c.code === currency)?.defaultRate || trip.exchange_rate);
    const amountLocal = Number(d.amount) || 0;
    const amountKrw = currency === "KRW" ? Math.round(amountLocal) : Math.round(amountLocal * rate);

    const draft = {
      merchant: d.merchant || "",
      category: d.category || "식비",
      currency,
      amount_local: amountLocal,
      exchange_rate: rate,
      amount_krw: amountKrw,
      day_date: d.date && d.date >= trip.start_date && d.date <= trip.end_date ? d.date : state.activeDayDate !== "ALL" && state.activeDayDate ? state.activeDayDate : trip.start_date,
      wallet_id: guessWalletId(d.payment_hint, trip.wallets || []),
      items_summary: d.items_summary || "",
      memo: "",
      receipt_url: receiptUrl,
      ai_raw: aiRes.ok ? d : null,
      _aiBanner: aiRes.ok
        ? { type: "ok", text: "✨ Gemini AI가 영수증을 자동 인식했습니다! 내용만 3초 확인 후 저장하세요." }
        : { type: "warn", text: `⚠️ ${aiRes.message}` },
    };

    openExpenseFormModal(null, draft);
  } catch (err) {
    closeDialog();
    showToast(`영수증 처리 오류: ${err.message}`, 3500);
  }
}

function openExpenseFormModal(existing, draft = null) {
  const trip = getActiveTrip();
  const dates = getTripDates(trip);
  const wallets = trip.wallets || [];
  const isEdit = Boolean(existing);

  const e = existing || draft || {
    merchant: "",
    category: "식비",
    currency: trip.currency,
    amount_local: "",
    exchange_rate: trip.exchange_rate,
    amount_krw: 0,
    day_date: state.activeDayDate && state.activeDayDate !== "ALL" ? state.activeDayDate : trip.start_date,
    wallet_id: wallets[0]?.id || "card",
    items_summary: "",
    memo: "",
    receipt_url: "",
    ai_raw: null,
  };

  openDialog({
    title: isEdit ? "지출 수정" : draft ? "영수증 인식 결과 확인" : "지출 직접 입력",
    bodyHtml: `
      ${draft?._aiBanner ? `<div class="ai-status-box ${draft._aiBanner.type}">${esc(draft._aiBanner.text)}</div>` : ""}
      ${e.receipt_url ? `<img src="${esc(e.receipt_url)}" class="receipt-preview" alt="영수증 미리보기" />` : ""}
      <form id="exp-form">
        <div class="field">
          <label>가게명 / 항목 *</label>
          <input name="merchant" value="${esc(e.merchant)}" placeholder="예: 딤섬스퀘어" required />
        </div>
        <div class="field-row">
          <div class="field">
            <label>통화</label>
            <select name="currency" id="exp-currency">
              ${CURRENCY_PRESETS.map(
                (c) => `<option value="${c.code}" ${c.code === e.currency ? "selected" : ""}>${c.code} (${c.symbol})</option>`
              ).join("")}
            </select>
          </div>
          <div class="field">
            <label>결제 금액 *</label>
            <input type="number" step="0.01" name="amount_local" id="exp-amount" value="${esc(e.currency === "KRW" && !e.amount_local ? e.amount_krw : e.amount_local)}" required />
          </div>
        </div>
        <div class="field-row">
          <div class="field">
            <label>적용 환율</label>
            <input type="number" step="0.01" name="exchange_rate" id="exp-rate" value="${esc(e.exchange_rate)}" />
          </div>
          <div class="field">
            <label>원화 환산 (원)</label>
            <input type="number" name="amount_krw" id="exp-krw" value="${esc(e.amount_krw)}" />
          </div>
        </div>
        <div class="field-row">
          <div class="field">
            <label>카테고리</label>
            <select name="category">
              ${["식비", "간식", "교통", "입장권", "쇼핑", "숙소", "항공", "기타"]
                .map((c) => `<option value="${c}" ${c === e.category ? "selected" : ""}>${c}</option>`)
                .join("")}
            </select>
          </div>
          <div class="field">
            <label>결제 수단 (지갑)</label>
            <select name="wallet_id">
              ${wallets
                .map((w) => `<option value="${esc(w.id)}" ${w.id === e.wallet_id ? "selected" : ""}>${esc(w.name)}</option>`)
                .join("")}
            </select>
          </div>
        </div>
        <div class="field">
          <label>여행 일자</label>
          <select name="day_date">
            ${dates.map((d) => `<option value="${d.date}" ${d.date === e.day_date ? "selected" : ""}>${d.label}</option>`).join("")}
          </select>
        </div>
        <div class="field">
          <label>품목 요약</label>
          <input name="items_summary" value="${esc(e.items_summary || "")}" placeholder="예: 하가우, 시우마이, 밀크티" />
        </div>
        <div class="field">
          <label>메모</label>
          <input name="memo" value="${esc(e.memo || "")}" />
        </div>
      </form>
    `,
    footerHtml: `
      ${isEdit ? `<button type="button" class="btn btn-danger btn-sm" id="btn-del-exp" style="margin-right:auto;">삭제</button>` : ""}
      <button type="button" class="btn btn-soft btn-sm" id="btn-cancel-exp">취소</button>
      <button type="submit" form="exp-form" class="btn btn-primary btn-sm">가계부 저장</button>
    `,
    onMount(body, footer) {
      const curEl = body.querySelector("#exp-currency");
      const amtEl = body.querySelector("#exp-amount");
      const rateEl = body.querySelector("#exp-rate");
      const krwEl = body.querySelector("#exp-krw");

      const recalc = () => {
        const cur = curEl.value;
        const amt = Number(amtEl.value) || 0;
        const rate = cur === "KRW" ? 1 : Number(rateEl.value) || 0;
        krwEl.value = Math.round(amt * rate);
      };
      curEl.addEventListener("change", () => {
        if (curEl.value === "KRW") rateEl.value = 1;
        else if (curEl.value === trip.currency) rateEl.value = trip.exchange_rate;
        else {
          const p = CURRENCY_PRESETS.find((c) => c.code === curEl.value);
          if (p) rateEl.value = p.defaultRate;
        }
        recalc();
      });
      amtEl.addEventListener("input", recalc);
      rateEl.addEventListener("input", recalc);

      footer.querySelector("#btn-cancel-exp").addEventListener("click", closeDialog);
      footer.querySelector("#btn-del-exp")?.addEventListener("click", async () => {
        if (!confirm("이 지출 내역을 삭제할까요?")) return;
        await store.deleteExpense(e.id);
        closeDialog();
        await refreshData(true);
        showToast("지출 내역이 삭제되었습니다.");
      });

      body.querySelector("#exp-form").addEventListener("submit", async (ev) => {
        ev.preventDefault();
        const fd = new FormData(ev.target);
        const cur = fd.get("currency");
        const amtLocal = Number(fd.get("amount_local")) || 0;
        const rate = cur === "KRW" ? 1 : Number(fd.get("exchange_rate")) || 1;
        const krw = Number(fd.get("amount_krw")) || Math.round(amtLocal * rate);

        await store.saveExpense({
          ...(existing || {
            id: uid("exp"),
            trip_id: trip.id,
            spent_at: new Date().toISOString(),
            receipt_url: e.receipt_url || "",
            ai_raw: e.ai_raw || null,
          }),
          merchant: fd.get("merchant").trim(),
          currency: cur,
          amount_local: cur === "KRW" ? 0 : amtLocal,
          exchange_rate: rate,
          amount_krw: Math.round(krw),
          category: fd.get("category"),
          wallet_id: fd.get("wallet_id"),
          day_date: fd.get("day_date"),
          items_summary: fd.get("items_summary").trim(),
          memo: fd.get("memo").trim(),
        });
        closeDialog();
        state.activeTab = "budget";
        await refreshData(true);
        showToast("가계부에 저장되었습니다!");
      });
    },
  });
}

function openWalletsModal() {
  const trip = getActiveTrip();
  const wallets = trip.wallets || [];
  openDialog({
    title: "👛 지갑 초기액 · 충전액 수정",
    bodyHtml: `
      <form id="wallets-form">
        <p style="font-size:12px;color:var(--text-muted);margin-top:0;">
          ATM 현금 인출이나 옥토퍼스 추가 충전을 했을 때 여기 금액을 올리면 남은 잔액이 자동 계산됩니다.
        </p>
        ${wallets
          .map(
            (w, idx) => `
          <div class="field">
            <label>${esc(w.name)} (${esc(w.currency)})</label>
            <input type="number" step="0.1" name="w_${idx}" value="${esc(w.initial_local || 0)}" />
            ${w.memo ? `<div style="font-size:11px;color:var(--text-muted);margin-top:2px;">${esc(w.memo)}</div>` : ""}
          </div>`
          )
          .join("")}
      </form>
    `,
    footerHtml: `
      <button type="button" class="btn btn-soft btn-sm" id="w-cancel">취소</button>
      <button type="submit" form="wallets-form" class="btn btn-primary btn-sm">저장</button>
    `,
    onMount(body, footer) {
      footer.querySelector("#w-cancel").addEventListener("click", closeDialog);
      body.querySelector("#wallets-form").addEventListener("submit", async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const nextWallets = wallets.map((w, idx) => ({
          ...w,
          initial_local: Number(fd.get(`w_${idx}`)) || 0,
        }));
        await store.saveTrip({ ...trip, wallets: nextWallets });
        closeDialog();
        await refreshData(true);
        showToast("지갑 잔액 기준을 업데이트했습니다.");
      });
    },
  });
}

function openRecapReportModal() {
  const trip = getActiveTrip();
  const expenses = state.db.expenses.filter((e) => e.trip_id === trip.id);
  const itinerary = state.db.itinerary.filter((i) => i.trip_id === trip.id);
  const totals = calcBudgetTotals(trip);
  const spent = expenses.reduce((s, e) => s + (Number(e.amount_krw) || 0), 0);
  const doneIt = itinerary.filter((i) => i.completed).length;

  const byDay = {};
  for (const e of expenses) {
    const k = e.day_date || "기타";
    byDay[k] = (byDay[k] || 0) + (Number(e.amount_krw) || 0);
  }

  openDialog({
    title: `📈 ${trip.title} 정산 리포트`,
    bodyHtml: `
      <div class="card" style="background:var(--surface-soft);">
        <div style="font-size:13px;color:var(--text-muted);">총 예산 대비 실제 지출</div>
        <div style="font-size:22px;font-weight:900;color:var(--primary-dark);margin:4px 0;">${fmtNum(spent)}원</div>
        <div style="font-size:12px;">예산 ${fmtNum(totals.totalPlanKrw)}원 대비 <b>${totals.totalPlanKrw ? Math.round((spent / totals.totalPlanKrw) * 100) : 0}%</b></div>
        <div style="font-size:12px;margin-top:4px;">완료된 일정: <b>${doneIt} / ${itinerary.length}건</b> · 영수증 기록: <b>${expenses.length}건</b></div>
      </div>

      <h3 style="font-size:14px;margin:12px 0 8px;">일자별 지출 합계</h3>
      <table class="mini-table">
        <thead><tr><th>날짜</th><th style="text-align:right;">지출액 (원)</th></tr></thead>
        <tbody>
          ${Object.entries(byDay)
            .sort()
            .map(([d, amt]) => `<tr><td>${esc(d)}</td><td style="text-align:right;font-weight:700;">${fmtNum(amt)}원</td></tr>`)
            .join("")}
        </tbody>
      </table>
    `,
    footerHtml: `<button type="button" class="btn btn-primary btn-sm" id="recap-close">닫기</button>`,
    onMount(_, footer) {
      footer.querySelector("#recap-close").addEventListener("click", closeDialog);
    },
  });
}

// ============================================================
// 4. 준비 · 정보 탭 (체크리스트 / 옥토퍼스 계산기 & 교통 / 예산표)
// ============================================================
function renderPrepTab() {
  const trip = getActiveTrip();
  const segHtml = `
    <div class="seg-tabs">
      <button type="button" class="seg-tab ${state.prepSubTab === "checklist" ? "active" : ""}" data-prep="checklist">✅ 체크리스트</button>
      <button type="button" class="seg-tab ${state.prepSubTab === "transport" ? "active" : ""}" data-prep="transport">🚇 교통·옥토퍼스</button>
      <button type="button" class="seg-tab ${state.prepSubTab === "budget_table" ? "active" : ""}" data-prep="budget_table">📋 예산표·출처</button>
    </div>
  `;

  if (state.prepSubTab === "checklist") {
    renderChecklistSub(trip, segHtml);
  } else if (state.prepSubTab === "transport") {
    renderTransportSub(trip, segHtml);
  } else {
    renderBudgetTableSub(trip, segHtml);
  }
}

function bindPrepSegTabs() {
  mainContent.querySelectorAll("[data-prep]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.prepSubTab = btn.dataset.prep;
      renderPrepTab();
    });
  });
}

function renderChecklistSub(trip, segHtml) {
  const all = state.db.checklists
    .filter((c) => c.trip_id === trip.id)
    .sort((a, b) => a.sort_order - b.sort_order);
  const prep = all.filter((c) => c.group_type !== "local_step");
  const localSteps = all.filter((c) => c.group_type === "local_step");

  const renderRow = (c) => {
    const cls = c.status === "완료" ? "badge-green" : c.status === "진행중" ? "badge-amber" : "badge-gray";
    return `
      <div class="check-item">
        <button type="button" class="status-cycle-btn ${cls}" data-cycle-chk="${esc(c.id)}" title="눌러서 상태 변경">
          ${esc(c.status)}
        </button>
        <div style="flex:1;min-width:0;">
          <div style="font-weight:700;font-size:14px;${c.status === "완료" ? "text-decoration:line-through;color:var(--text-muted);" : ""}">
            ${esc(c.title)}
          </div>
          ${c.due_label ? `<div style="font-size:12px;color:var(--primary-dark);font-weight:600;margin-top:2px;">⏰ ${esc(c.due_label)}</div>` : ""}
          ${c.memo ? `<div style="font-size:12px;color:var(--text-muted);margin-top:2px;">${esc(c.memo)}</div>` : ""}
        </div>
        <button type="button" class="btn btn-soft btn-sm" style="min-height:30px;padding:4px 8px;" data-edit-chk="${esc(c.id)}">✏️</button>
      </div>`;
  };

  mainContent.innerHTML = `
    ${segHtml}
    <div class="section-header">
      <h2 class="section-title">예약 · 준비 체크리스트 (${prep.filter((c) => c.status === "완료").length}/${prep.length})</h2>
      <button type="button" class="btn btn-primary btn-sm" id="btn-add-chk">+ 항목 추가</button>
    </div>
    ${prep.map(renderRow).join("")}

    ${
      localSteps.length
        ? `<div class="section-header" style="margin-top:18px;">
             <h2 class="section-title">환전 · 옥토퍼스 준비 순서 (${localSteps.filter((c) => c.status === "완료").length}/${localSteps.length})</h2>
           </div>
           ${localSteps.map(renderRow).join("")}`
        : ""
    }
  `;

  bindPrepSegTabs();

  mainContent.querySelectorAll("[data-cycle-chk]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const c = all.find((x) => x.id === btn.dataset.cycleChk);
      if (!c) return;
      const order = ["예정", "진행중", "완료"];
      const nextStatus = order[(order.indexOf(c.status) + 1) % order.length];
      await store.saveChecklist({ ...c, status: nextStatus });
      await refreshData(true);
    });
  });

  $("#btn-add-chk").addEventListener("click", () => openChecklistModal(null));
  mainContent.querySelectorAll("[data-edit-chk]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const c = all.find((x) => x.id === btn.dataset.editChk);
      if (c) openChecklistModal(c);
    });
  });
}

function openChecklistModal(existing) {
  const trip = getActiveTrip();
  const isEdit = Boolean(existing);
  const c = existing || { group_type: "prep", title: "", due_label: "", status: "예정", memo: "" };

  openDialog({
    title: isEdit ? "체크리스트 수정" : "체크리스트 추가",
    bodyHtml: `
      <form id="chk-form">
        <div class="field-row">
          <div class="field">
            <label>구분</label>
            <select name="group_type">
              <option value="prep" ${c.group_type === "prep" ? "selected" : ""}>예약·준비 체크</option>
              <option value="local_step" ${c.group_type === "local_step" ? "selected" : ""}>현지 준비 순서</option>
            </select>
          </div>
          <div class="field">
            <label>상태</label>
            <select name="status">
              ${["예정", "진행중", "완료"].map((s) => `<option value="${s}" ${s === c.status ? "selected" : ""}>${s}</option>`).join("")}
            </select>
          </div>
        </div>
        <div class="field">
          <label>할 일 *</label>
          <input name="title" value="${esc(c.title)}" required />
        </div>
        <div class="field">
          <label>기한 / 시점</label>
          <input name="due_label" value="${esc(c.due_label || "")}" placeholder="예: 출발 2주 전" />
        </div>
        <div class="field">
          <label>메모</label>
          <textarea name="memo" rows="2">${esc(c.memo || "")}</textarea>
        </div>
      </form>
    `,
    footerHtml: `
      ${isEdit ? `<button type="button" class="btn btn-danger btn-sm" id="btn-del-chk" style="margin-right:auto;">삭제</button>` : ""}
      <button type="button" class="btn btn-soft btn-sm" id="btn-cancel-chk">취소</button>
      <button type="submit" form="chk-form" class="btn btn-primary btn-sm">저장</button>
    `,
    onMount(body, footer) {
      footer.querySelector("#btn-cancel-chk").addEventListener("click", closeDialog);
      footer.querySelector("#btn-del-chk")?.addEventListener("click", async () => {
        await store.deleteChecklist(c.id);
        closeDialog();
        await refreshData(true);
        showToast("항목이 삭제되었습니다.");
      });
      body.querySelector("#chk-form").addEventListener("submit", async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const count = state.db.checklists.filter((x) => x.trip_id === trip.id).length;
        await store.saveChecklist({
          ...(existing || { id: uid("chk"), trip_id: trip.id, sort_order: count + 1 }),
          group_type: fd.get("group_type"),
          status: fd.get("status"),
          title: fd.get("title").trim(),
          due_label: fd.get("due_label").trim(),
          memo: fd.get("memo").trim(),
        });
        closeDialog();
        await refreshData(true);
        showToast("체크리스트를 저장했습니다.");
      });
    },
  });
}

// 옥토퍼스 카드 종류별 비용/환불 규칙 (엑셀 수식 동일 반영)
const OCTOPUS_RULES = {
  "On-Loan 아동": { fare: "아동 (성인의 약 절반)", cardCost: 50, refund: 50 },
  "On-Loan 성인": { fare: "성인", cardCost: 50, refund: 50 },
  "투어리스트 옥토퍼스": { fare: "성인", cardCost: 39, refund: 0 },
  "트래블로그 터치": { fare: "성인", cardCost: 0, refund: 0 },
};

function renderTransportSub(trip, segHtml) {
  const info = trip.transport_info || {};
  const members = info.octopus_members || [];
  const passes = info.passes || [];
  const routes = info.routes || [];

  // 옥토퍼스 자동 합계 계산
  let cardSum = 0;
  let topupSum = 0;
  let refundSum = 0;
  for (const m of members) {
    const rule = OCTOPUS_RULES[m.card_type] || OCTOPUS_RULES["트래블로그 터치"];
    cardSum += rule.cardCost;
    topupSum += Number(m.initial_topup) || 0;
    refundSum += rule.refund;
  }
  const cashNeededHkd = cardSum + topupSum;
  const cashNeededKrw = Math.round(cashNeededHkd * (Number(trip.exchange_rate) || 190));

  mainContent.innerHTML = `
    ${segHtml}

    ${
      members.length
        ? `<div class="card">
            <h3 style="margin:0 0 6px;font-size:15px;">🐙 옥토퍼스 카드 자동 계산기</h3>
            <p style="font-size:12px;color:var(--text-muted);margin:0 0 10px;">
              카드 종류나 첫 충전 금액을 바꾸면 도착 직후 필요한 현금이 자동 계산됩니다.
            </p>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px;">
              <div style="background:#f0fdfa;padding:10px;border-radius:10px;">
                <div style="font-size:11px;color:var(--primary-dark);">도착 직후 필요 현금</div>
                <div style="font-size:18px;font-weight:900;color:var(--primary-dark);">HK$${fmtNum(cashNeededHkd)}</div>
                <div style="font-size:11px;color:var(--text-muted);">약 ${fmtNum(cashNeededKrw)}원</div>
              </div>
              <div style="background:#f8fafc;padding:10px;border-radius:10px;">
                <div style="font-size:11px;color:var(--text-muted);">카드·보증금 / 첫 충전</div>
                <div style="font-size:14px;font-weight:800;">HK$${cardSum} + HK$${topupSum}</div>
                <div style="font-size:11px;color:var(--success);">귀국 환불 보증금: HK$${refundSum}</div>
              </div>
            </div>

            ${members
              .map((m, idx) => {
                const rule = OCTOPUS_RULES[m.card_type] || OCTOPUS_RULES["트래블로그 터치"];
                return `
                <div style="padding:10px 0;border-top:1px solid var(--border);">
                  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
                    <strong>${esc(m.name)}${m.age ? ` (만 ${m.age}세)` : ""}</strong>
                    <span class="badge badge-blue">${esc(rule.fare)}</span>
                  </div>
                  <div class="field-row" style="margin-bottom:4px;">
                    <select data-oct-type="${idx}" style="padding:7px 8px;border:1px solid var(--border);border-radius:8px;font-size:12px;">
                      ${Object.keys(OCTOPUS_RULES)
                        .map((k) => `<option value="${k}" ${k === m.card_type ? "selected" : ""}>${k}</option>`)
                        .join("")}
                    </select>
                    <input type="number" data-oct-topup="${idx}" value="${esc(m.initial_topup)}" placeholder="첫 충전 HKD" style="padding:7px 8px;border:1px solid var(--border);border-radius:8px;font-size:12px;" />
                  </div>
                  <div style="font-size:11px;color:var(--text-muted);">
                    카드·보증금 HK$${rule.cardCost} (환불 HK$${rule.refund}) · ${esc(m.memo || "")}
                  </div>
                </div>`;
              })
              .join("")}
          </div>`
        : ""
    }

    ${
      passes.length
        ? `<div class="card">
            <h3 style="margin:0 0 4px;font-size:15px;">🚆 교통 · 패스 비교</h3>
            <div style="font-size:12px;color:var(--primary-dark);font-weight:700;margin-bottom:8px;">${esc(info.headline || "")}</div>
            ${passes
              .map(
                (p) => `
              <div style="padding:9px 0;border-top:1px solid var(--border);">
                <div style="display:flex;justify-content:space-between;gap:8px;align-items:center;">
                  <strong style="font-size:13px;">${esc(p.option)}</strong>
                  <span style="font-size:12px;font-weight:800;">${esc(p.recommendation)}</span>
                </div>
                <div style="font-size:12px;color:var(--primary-dark);margin-top:2px;">${esc(p.price)}</div>
                <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">${esc(p.condition)} · ${esc(p.pros_cons)}</div>
              </div>`
              )
              .join("")}
          </div>`
        : ""
    }

    ${
      routes.length
        ? `<div class="card">
            <h3 style="margin:0 0 8px;font-size:15px;">🧭 일자별 이동 동선</h3>
            <table class="mini-table">
              <thead><tr><th>날짜</th><th>구간 / 수단</th><th>소요</th></tr></thead>
              <tbody>
                ${routes
                  .map(
                    (r) => `
                  <tr>
                    <td style="white-space:nowrap;font-weight:700;">${esc(r.day)}</td>
                    <td><b>${esc(r.route)}</b><br/><span style="color:var(--text-muted);">${esc(r.mode)}${r.memo ? ` · ${esc(r.memo)}` : ""}</span></td>
                    <td style="white-space:nowrap;">${esc(r.duration)}</td>
                  </tr>`
                  )
                  .join("")}
              </tbody>
            </table>
          </div>`
        : `<div class="card" style="text-align:center;color:var(--text-muted);">교통 정보가 아직 등록되지 않았습니다.</div>`
    }
  `;

  bindPrepSegTabs();

  const saveOctopus = async () => {
    const updated = members.map((m, idx) => ({
      ...m,
      card_type: mainContent.querySelector(`[data-oct-type="${idx}"]`)?.value || m.card_type,
      initial_topup: Number(mainContent.querySelector(`[data-oct-topup="${idx}"]`)?.value) || 0,
    }));
    await store.saveTrip({
      ...trip,
      transport_info: { ...info, octopus_members: updated },
    });
    await refreshData(true);
  };

  mainContent.querySelectorAll("[data-oct-type], [data-oct-topup]").forEach((el) => {
    el.addEventListener("change", saveOctopus);
  });
}

function renderBudgetTableSub(trip, segHtml) {
  const sym = getCurrencySymbol(trip.currency);
  const totals = calcBudgetTotals(trip);
  const localItems = trip.budget_plan?.local_items || [];
  const krwItems = trip.budget_plan?.krw_items || [];
  const credits = trip.photo_credits || [];

  mainContent.innerHTML = `
    ${segHtml}
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
        <h3 style="margin:0;font-size:15px;">📋 예상 예산표</h3>
        <button type="button" class="btn btn-soft btn-sm" id="btn-edit-rate">환율 변경 (1${esc(trip.currency)}=${fmtNum(trip.exchange_rate)}원)</button>
      </div>
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px;">
        현지 경비 소계: <b>${sym}${fmtNum(totals.localPlan)} (${fmtNum(totals.localPlanKrw)}원)</b><br/>
        원화 결제 소계: <b>${fmtNum(totals.krwPlan)}원</b><br/>
        총 예상 경비: <b style="color:var(--primary-dark);font-size:15px;">${fmtNum(totals.totalPlanKrw)}원</b>
      </div>
      ${
        localItems.length
          ? `<table class="mini-table">
              <thead><tr><th>현지 경비 항목</th><th style="text-align:right;">${esc(trip.currency)}</th><th style="text-align:right;">원화</th></tr></thead>
              <tbody>
                ${localItems
                  .map((it) => {
                    const local = it.adult_qty * it.adult_price + it.child_qty * it.child_price;
                    return `<tr><td><b>${esc(it.name)}</b><br/><span style="color:var(--text-muted);">${esc(it.memo || "")}</span></td><td style="text-align:right;white-space:nowrap;">${sym}${fmtNum(local)}</td><td style="text-align:right;white-space:nowrap;">${fmtNum(local * trip.exchange_rate)}원</td></tr>`;
                  })
                  .join("")}
              </tbody>
            </table>`
          : ""
      }
      ${
        krwItems.length
          ? `<h4 style="font-size:13px;margin:14px 0 6px;">원화 결제 항목</h4>
            <table class="mini-table">
              <thead><tr><th>항목</th><th style="text-align:right;">합계 (원)</th></tr></thead>
              <tbody>
                ${krwItems
                  .map((it) => `<tr><td><b>${esc(it.name)}</b></td><td style="text-align:right;font-weight:700;">${fmtNum(it.total_krw)}원</td></tr>`)
                  .join("")}
              </tbody>
            </table>`
          : ""
      }
    </div>

    ${
      credits.length
        ? `<div class="card">
            <h3 style="margin:0 0 8px;font-size:14px;">📸 사진 출처 (Wikimedia Commons)</h3>
            ${credits
              .map(
                (c) =>
                  `<div style="font-size:11px;color:var(--text-muted);margin-bottom:4px;">• <b>${esc(c.title)}</b> — ${esc(c.author)} (${esc(c.license)}) <a href="${esc(c.url)}" target="_blank" rel="noopener">원본</a></div>`
              )
              .join("")}
          </div>`
        : ""
    }
  `;

  bindPrepSegTabs();
  $("#btn-edit-rate")?.addEventListener("click", openFxCalcModal);
}

// ============================================================
// 5. 상단 유틸리티: 환율 계산기 & 설정 모달
// ============================================================
function openFxCalcModal() {
  const trip = getActiveTrip();
  if (!trip) return;
  const sym = getCurrencySymbol(trip.currency);

  openDialog({
    title: `💱 간편 환율 계산기 (${trip.currency} ↔ KRW)`,
    bodyHtml: `
      <div class="field">
        <label>적용 환율 (1 ${esc(trip.currency)} 당 원화)</label>
        <div style="display:flex;gap:8px;">
          <input type="number" step="0.01" id="fx-rate" value="${esc(trip.exchange_rate)}" />
          <button type="button" class="btn btn-soft btn-sm" id="fx-save-rate" style="white-space:nowrap;">여행 환율 저장</button>
        </div>
      </div>
      <div class="field">
        <label>현지 금액 (${esc(trip.currency)})</label>
        <input type="number" step="0.1" id="fx-local" placeholder="예: 150" autofocus />
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px;">
        ${[50, 100, 200, 300, 500, 1000]
          .map((v) => `<button type="button" class="btn btn-soft btn-sm" data-fx-quick="${v}">${sym}${v}</button>`)
          .join("")}
      </div>
      <div class="field">
        <label>원화 금액 (KRW)</label>
        <input type="number" id="fx-krw" placeholder="예: 28500" />
      </div>
    `,
    footerHtml: `<button type="button" class="btn btn-primary btn-sm" id="fx-close">닫기</button>`,
    onMount(body, footer) {
      const rateEl = body.querySelector("#fx-rate");
      const localEl = body.querySelector("#fx-local");
      const krwEl = body.querySelector("#fx-krw");

      const fromLocal = () => {
        const r = Number(rateEl.value) || 0;
        const l = Number(localEl.value) || 0;
        krwEl.value = l ? Math.round(l * r) : "";
      };
      const fromKrw = () => {
        const r = Number(rateEl.value) || 1;
        const k = Number(krwEl.value) || 0;
        localEl.value = k ? (k / r).toFixed(1) : "";
      };

      localEl.addEventListener("input", fromLocal);
      krwEl.addEventListener("input", fromKrw);
      rateEl.addEventListener("input", fromLocal);

      body.querySelectorAll("[data-fx-quick]").forEach((btn) => {
        btn.addEventListener("click", () => {
          localEl.value = btn.dataset.fxQuick;
          fromLocal();
        });
      });

      body.querySelector("#fx-save-rate").addEventListener("click", async () => {
        const nextRate = Number(rateEl.value);
        if (!nextRate || nextRate <= 0) return;
        await store.saveTrip({ ...trip, exchange_rate: nextRate });
        await refreshData(true);
        showToast(`환율이 1${trip.currency} = ${nextRate}원으로 저장되었습니다.`);
      });
      footer.querySelector("#fx-close").addEventListener("click", closeDialog);
    },
  });
}

function openSettingsModal() {
  const cfg = getAppConfig();
  openDialog({
    title: "⚙️ 앱 · Supabase · 지도 설정",
    bodyHtml: `
      <form id="settings-form">
        <div style="font-size:12px;background:#f0fdfa;padding:10px;border-radius:10px;margin-bottom:12px;color:var(--primary-dark);">
          현재 상태: <b>${getModeLabel()}</b><br/>
          Supabase URL과 Anon Key를 입력하면 가족 모든 기기에서 실시간 동기화 및 영수증 AI 분석이 동작합니다.
        </div>

        <div class="field">
          <label>Supabase Project URL</label>
          <input name="supabaseUrl" value="${esc(cfg.supabaseUrl)}" placeholder="https://xxxx.supabase.co" />
        </div>
        <div class="field">
          <label>Supabase Anon Public Key</label>
          <input name="supabaseAnonKey" value="${esc(cfg.supabaseAnonKey)}" placeholder="eyJhbGciOi..." />
        </div>

        <hr style="border:none;border-top:1px solid var(--border);margin:14px 0;" />

        <div class="field">
          <label>Google Maps JS API Key (선택 — 미입력 시 무료 OSM 지도 + 구글맵 길찾기 사용)</label>
          <input name="googleMapsApiKey" value="${esc(cfg.googleMapsApiKey)}" placeholder="Google Maps API 키 입력" />
          <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">
            무료 프로토타입 키는 <a href="https://mapsplatform.google.com/maps-demo-key?utm_campaign=gmp_git_agentskills_v1" target="_blank" rel="noopener">Maps Demo Key</a>에서 발급 가능합니다. 프로덕션 키는 반드시 HTTP 리퍼러 제한을 설정하세요.
          </div>
        </div>
        <div class="field">
          <label>Google Maps Map ID (AdvancedMarker용)</label>
          <input name="googleMapsMapId" value="${esc(cfg.googleMapsMapId || "DEMO_MAP_ID")}" placeholder="DEMO_MAP_ID" />
        </div>

        <button type="submit" class="btn btn-primary btn-block">설정 저장 및 동기화</button>
      </form>

      ${
        getStoredPin()
          ? `<hr style="border:none;border-top:1px solid var(--border);margin:16px 0;" />
            <form id="pin-change-form">
              <div style="font-weight:800;font-size:14px;margin-bottom:8px;">🔒 가족 PIN 변경</div>
              <div class="field-row">
                <div class="field">
                  <label>현재 PIN</label>
                  <input type="password" inputmode="numeric" name="oldPin" required />
                </div>
                <div class="field">
                  <label>새 PIN (4자리 이상)</label>
                  <input type="password" inputmode="numeric" name="newPin" minlength="4" required />
                </div>
              </div>
              <button type="submit" class="btn btn-soft btn-block">PIN 변경하기</button>
            </form>
            <div style="margin-top:12px;display:flex;gap:8px;">
              <button type="button" class="btn btn-danger btn-sm" style="flex:1;" id="btn-lock-app">🔐 앱 잠그기</button>
            </div>`
          : ""
      }
    `,
    footerHtml: `<button type="button" class="btn btn-soft btn-sm" id="set-close">닫기</button>`,
    onMount(body, footer) {
      footer.querySelector("#set-close").addEventListener("click", closeDialog);

      body.querySelector("#settings-form").addEventListener("submit", async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        saveAppConfig({
          supabaseUrl: fd.get("supabaseUrl").trim(),
          supabaseAnonKey: fd.get("supabaseAnonKey").trim(),
          googleMapsApiKey: fd.get("googleMapsApiKey").trim(),
          googleMapsMapId: fd.get("googleMapsMapId").trim() || "DEMO_MAP_ID",
        });
        closeDialog();
        updatePinScreenDesc();
        if (getStoredPin()) {
          await refreshData(false);
        } else {
          showToast("설정이 저장되었습니다. PIN을 입력해 입장해 주세요.");
        }
      });

      body.querySelector("#pin-change-form")?.addEventListener("submit", async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        try {
          await changePin(fd.get("oldPin"), fd.get("newPin"));
          showToast("가족 PIN이 변경되었습니다!");
          e.target.reset();
        } catch (err) {
          showToast(err.message, 3200);
        }
      });

      body.querySelector("#btn-lock-app")?.addEventListener("click", () => {
        clearPin();
        closeDialog();
        appShell.classList.add("hidden");
        pinScreen.classList.remove("hidden");
        $("#pin-input").value = "";
        showToast("앱이 잠겼습니다.");
      });
    },
  });
}

// ============================================================
// 전역 이벤트 및 앱 시작
// ============================================================
function updatePinScreenDesc() {
  $("#pin-mode-desc").textContent = isSupabaseConfigured()
    ? "☁️ Supabase 연동됨 · 가족 PIN을 입력해 동기화된 여행을 열어주세요."
    : "📱 로컬 모드 · 가족 PIN을 입력해 홍콩 여행 일정을 바로 체험하세요.";
}

$("#pin-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("#pin-input");
  const errEl = $("#pin-error");
  const btn = $("#pin-submit-btn");
  errEl.textContent = "";
  btn.disabled = true;
  btn.textContent = "확인 중...";
  try {
    const ok = await verifyPin(input.value, true);
    if (!ok) {
      errEl.textContent = "PIN이 일치하지 않습니다. 다시 확인해 주세요.";
      input.select();
    } else {
      await enterApp();
    }
  } catch (err) {
    errEl.textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = "입장하기";
  }
});

$("#pin-open-settings").addEventListener("click", openSettingsModal);
$("#btn-settings").addEventListener("click", openSettingsModal);
$("#btn-fx-calc").addEventListener("click", openFxCalcModal);
$("#btn-refresh").addEventListener("click", () => refreshData(false));
$("#btn-back-hub").addEventListener("click", () => {
  state.activeTripId = null;
  renderCurrentView();
});

document.querySelectorAll(".nav-tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    state.activeTab = btn.dataset.tab;
    renderCurrentView();
  });
});

$("#btn-quick-receipt").addEventListener("click", openReceiptChooserModal);

$("#receipt-file-input").addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  if (file) handleReceiptFileSelected(file);
});
$("#receipt-gallery-input").addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  if (file) handleReceiptFileSelected(file);
});

$("#voucher-file-input").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  const itemId = state.pendingVoucherItemId;
  const trip = getActiveTrip();
  if (!file || !itemId || !trip) return;
  const item = state.db.itinerary.find((x) => x.id === itemId);
  if (!item) return;

  showToast("바우처를 업로드하는 중...");
  try {
    let url = "";
    const isPdf = file.type === "application/pdf";
    if (isPdf) {
      url = await store.uploadFile(file, `vouchers/${trip.id}`, "pdf");
    } else {
      const comp = await compressImageFile(file, 1600, 0.85);
      url = await store.uploadFile(comp.blob, `vouchers/${trip.id}`, "jpg");
    }
    const nextVouchers = [...(item.vouchers || []), { name: file.name, url, type: isPdf ? "pdf" : "image" }];
    await store.saveItinerary({ ...item, vouchers: nextVouchers });
    await refreshData(true);
    openVoucherModal({ ...item, vouchers: nextVouchers });
    showToast("바우처가 첨부되었습니다!");
  } catch (err) {
    showToast(`바우처 업로드 실패: ${err.message}`, 3500);
  }
});

// Service Worker 등록 (PWA 오프라인 캐시)
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  });
}

// 초기 부팅
updatePinScreenDesc();
if (getStoredPin()) {
  enterApp().catch(() => {
    clearPin();
    pinScreen.classList.remove("hidden");
    appShell.classList.add("hidden");
  });
}
