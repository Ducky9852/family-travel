// 여행 전체 데이터를 엑셀(.xlsx)로 내보내기 (SheetJS 동적 로드)

let xlsxPromise = null;
function loadXlsx() {
  if (!xlsxPromise) {
    xlsxPromise = import("https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs");
  }
  return xlsxPromise;
}

export async function exportTripToExcel({ trip, itinerary, candidates, expenses, checklists }) {
  const XLSX = await loadXlsx();
  const wb = XLSX.utils.book_new();

  // 1. 여행 요약
  const totalKrw = expenses.reduce((s, e) => s + (Number(e.amount_krw) || 0), 0);
  const summaryRows = [
    ["항목", "내용"],
    ["여행명", trip.title],
    ["여행지", trip.destination],
    ["기간", `${trip.start_date} ~ ${trip.end_date}`],
    ["기본 통화 / 환율", `${trip.currency} (1 ${trip.currency} = ${trip.exchange_rate}원)`],
    ["요약", trip.summary || ""],
    ["총 실제 지출 (원)", totalKrw],
    ["내보낸 시각", new Date().toLocaleString("ko-KR")],
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summaryRows), "여행요약");

  // 2. 일정표
  const itRows = [
    ["날짜", "요일", "시간", "구분", "일정", "현지어명", "주소", "상세·팁", "이동", "예약", "완료여부"],
    ...itinerary.map((i) => [
      i.day_date,
      i.day_label,
      i.time_str,
      i.category,
      i.title,
      i.local_name || "",
      i.address || "",
      i.details || "",
      i.transport || "",
      i.reservation_status || "",
      i.completed ? "완료" : i.skipped ? "건너뜀" : "예정",
    ]),
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(itRows), "일정표");

  // 3. 가계부 (영수증 내역)
  const walletMap = Object.fromEntries((trip.wallets || []).map((w) => [w.id, w.name]));
  const expRows = [
    ["결제일시", "여행일자", "카테고리", "가게명", "통화", "현지금액", "적용환율", "원화금액", "결제수단", "품목요약", "메모", "영수증링크"],
    ...expenses.map((e) => [
      e.spent_at ? new Date(e.spent_at).toLocaleString("ko-KR") : "",
      e.day_date || "",
      e.category,
      e.merchant,
      e.currency,
      Number(e.amount_local) || 0,
      Number(e.exchange_rate) || 0,
      Number(e.amount_krw) || 0,
      walletMap[e.wallet_id] || e.wallet_id || "",
      e.items_summary || "",
      e.memo || "",
      e.receipt_url && e.receipt_url.startsWith("http") ? e.receipt_url : e.receipt_url ? "(앱 내 저장됨)" : "",
    ]),
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(expRows), "가계부");

  // 4. 후보 식당·장소
  const candRows = [
    ["분류", "장소명", "현지어명", "지역", "주소", "추천메뉴", `1인예산(${trip.currency})`, "예약", "메모", "일정반영"],
    ...candidates.map((c) => [
      c.category,
      c.name,
      c.local_name || "",
      c.area || "",
      c.address || "",
      c.recommended_menu || "",
      Number(c.est_price_local) || 0,
      c.reservation || "",
      c.memo || "",
      c.is_added ? "반영됨" : "후보",
    ]),
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(candRows), "후보장소");

  // 5. 체크리스트
  const chkRows = [
    ["구분", "순서", "항목", "기한/시점", "상태", "메모"],
    ...checklists.map((c) => [
      c.group_type === "local_step" ? "현지준비순서" : "출발전체크",
      c.sort_order,
      c.title,
      c.due_label || "",
      c.status,
      c.memo || "",
    ]),
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(chkRows), "체크리스트");

  const safeName = (trip.title || "family_trip").replace(/[\\/:*?"<>|]/g, "_");
  XLSX.writeFile(wb, `${safeName}_${trip.start_date}.xlsx`);
}

/**
 * Google My Maps (https://www.google.com/maps/d/) "가져오기(Import)"용 CSV 다운로드
 * CSV 1개를 올리면 후보 + 주요 장소 전체가 내 구글맵 "홍콩여행" 지도에 한 번에 저장됩니다.
 */
export function exportGoogleMyMapsCsv({ trip, candidates }) {
  const csvEsc = (v) => `"${String(v ?? "").replace(/"/g, '""').replace(/[\r\n|<>`{}]/g, " ")}"`;
  const headers = ["Name", "Category", "Area", "Address", "Menu", "Note"];
  const rows = [
    headers.join(","),
    ...candidates.map((c) => {
      const addr = c.address || `${c.local_name || c.name}, ${trip.destination}`;
      return [
        c.name,
        c.category,
        c.area || "",
        addr,
        c.recommended_menu || "",
        (c.memo || "").replace(/\r?\n/g, " / "),
      ]
        .map(csvEsc)
        .join(",");
    }),
  ];
  const blob = new Blob([rows.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const safeName = (trip.destination || "trip").replace(/[\\/:*?"<>|]/g, "_");
  a.href = url;
  a.download = `${safeName}_mymaps.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
