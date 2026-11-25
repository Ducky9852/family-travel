// 데이터 저장소 계층: Supabase 실시간 동기화 (ft_ 테이블 분리) + 오프라인 로컬 캐시
import { getAppConfig, isSupabaseConfigured } from "./config.js";
import { createHongKongSeed, DEFAULT_NEW_TRIP_CHECKLIST } from "./seed-hongkong.js";

const LOCAL_DB_KEY = "family_travel_local_db_v1";
const PIN_SESSION_KEY = "family_travel_pin_v1";

let supabaseMod = null;
let sbClient = null;
let cloudSchemaReady = true;
let currentPin = sessionStorage.getItem(PIN_SESSION_KEY) || localStorage.getItem(PIN_SESSION_KEY) || "";
let realtimeChannel = null;

async function loadSupabaseSdk() {
  if (!supabaseMod) {
    supabaseMod = await import("https://esm.sh/@supabase/supabase-js@2");
  }
  return supabaseMod;
}

export function getStoredPin() {
  return currentPin;
}

export function clearPin() {
  currentPin = "";
  sbClient = null;
  sessionStorage.removeItem(PIN_SESSION_KEY);
  localStorage.removeItem(PIN_SESSION_KEY);
  if (realtimeChannel) {
    try { realtimeChannel.unsubscribe(); } catch {}
    realtimeChannel = null;
  }
}

export function getModeLabel() {
  if (!isSupabaseConfigured()) return "로컬 브라우저 모드";
  return cloudSchemaReady ? "Supabase 실시간 동기화" : "Supabase SQL 적용 대기 (로컬 모드 동작 중)";
}

function createEmptyDb() {
  const seed = createHongKongSeed();
  return {
    trips: [seed.trip],
    itinerary: seed.itinerary,
    candidates: seed.candidates,
    checklists: seed.checklists,
    expenses: seed.expenses,
  };
}

function readLocalDb() {
  try {
    const raw = localStorage.getItem(LOCAL_DB_KEY);
    if (!raw) {
      const init = createEmptyDb();
      localStorage.setItem(LOCAL_DB_KEY, JSON.stringify(init));
      return init;
    }
    const parsed = JSON.parse(raw);
    if (!parsed.trips || !parsed.trips.length) {
      const init = createEmptyDb();
      localStorage.setItem(LOCAL_DB_KEY, JSON.stringify(init));
      return init;
    }
    return parsed;
  } catch {
    const init = createEmptyDb();
    localStorage.setItem(LOCAL_DB_KEY, JSON.stringify(init));
    return init;
  }
}

function writeLocalDb(db) {
  localStorage.setItem(LOCAL_DB_KEY, JSON.stringify(db));
}

async function getAuthedSupabase(pin = currentPin) {
  const cfg = getAppConfig();
  if (!isSupabaseConfigured(cfg)) return null;
  const { createClient } = await loadSupabaseSdk();
  sbClient = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
    global: {
      headers: pin ? { "x-family-pin": pin } : {},
    },
  });
  return sbClient;
}

export async function verifyPin(inputPin, remember = true) {
  const pin = String(inputPin || "").trim();
  const cfg = getAppConfig();

  if (isSupabaseConfigured(cfg) && navigator.onLine) {
    try {
      const client = await getAuthedSupabase("");
      const { data, error } = await client.rpc("ft_verify_family_pin", { input_pin: pin });
      if (error) {
        // 아직 Supabase에 schema.sql을 실행하지 않은 경우 로컬 폴백으로 즉시 입장 허용
        if (/ft_verify_family_pin|does not exist|schema cache|404/i.test(error.message)) {
          cloudSchemaReady = false;
          const expected = cfg.localFallbackPin || "2027";
          if (pin !== expected) return false;
          currentPin = pin;
        } else {
          throw new Error(`Supabase PIN 검증 오류: ${error.message}`);
        }
      } else {
        cloudSchemaReady = true;
        if (!data) return false;
        currentPin = pin;
        sbClient = await getAuthedSupabase(pin);
      }
    } catch (e) {
      // 네트워크 오류 등일 때 오프라인 폴백
      const expected = cfg.localFallbackPin || "2027";
      if (pin !== expected) return false;
      cloudSchemaReady = false;
      currentPin = pin;
    }
  } else {
    const expected = cfg.localFallbackPin || "2027";
    if (pin !== expected) return false;
    currentPin = pin;
  }

  sessionStorage.setItem(PIN_SESSION_KEY, pin);
  if (remember) {
    localStorage.setItem(PIN_SESSION_KEY, pin);
  } else {
    localStorage.removeItem(PIN_SESSION_KEY);
  }
  return true;
}

export async function changePin(oldPin, newPin) {
  const cfg = getAppConfig();
  if (String(newPin).trim().length < 4) {
    throw new Error("PIN은 4자리 이상 입력해 주세요.");
  }
  if (isSupabaseConfigured(cfg) && cloudSchemaReady) {
    const client = await getAuthedSupabase(currentPin);
    const { data, error } = await client.rpc("ft_update_family_pin", {
      current_pin: oldPin,
      new_pin: String(newPin).trim(),
    });
    if (error || !data) throw new Error("현재 PIN이 일치하지 않거나 변경에 실패했습니다.");
    currentPin = String(newPin).trim();
    sbClient = await getAuthedSupabase(currentPin);
    sessionStorage.setItem(PIN_SESSION_KEY, currentPin);
    localStorage.setItem(PIN_SESSION_KEY, currentPin);
    return true;
  } else {
    if (oldPin !== (cfg.localFallbackPin || "2027")) {
      throw new Error("현재 PIN이 일치하지 않습니다.");
    }
    const { saveAppConfig } = await import("./config.js");
    saveAppConfig({ localFallbackPin: String(newPin).trim() });
    currentPin = String(newPin).trim();
    sessionStorage.setItem(PIN_SESSION_KEY, currentPin);
    localStorage.setItem(PIN_SESSION_KEY, currentPin);
    return true;
  }
}

export async function ensureInitialSeedInCloud() {
  const client = await getAuthedSupabase(currentPin);
  if (!client) return;
  const { data: existing, error } = await client.from("ft_trips").select("id").limit(1);
  if (error) throw new Error(`DB 조회 실패: ${error.message}`);
  if (existing && existing.length > 0) return;

  const seed = createHongKongSeed();
  await client.from("ft_trips").upsert(seed.trip);
  if (seed.itinerary.length) await client.from("ft_itinerary_items").upsert(seed.itinerary);
  if (seed.candidates.length) await client.from("ft_candidate_places").upsert(seed.candidates);
  if (seed.checklists.length) await client.from("ft_checklists").upsert(seed.checklists);
  if (seed.expenses.length) await client.from("ft_expenses").upsert(seed.expenses);
}

export async function loadAllData() {
  const cfg = getAppConfig();
  if (isSupabaseConfigured(cfg) && navigator.onLine) {
    try {
      await ensureInitialSeedInCloud();
      const client = await getAuthedSupabase(currentPin);
      const [tripsRes, itRes, candRes, chkRes, expRes] = await Promise.all([
        client.from("ft_trips").select("*").order("start_date", { ascending: false }),
        client.from("ft_itinerary_items").select("*").order("day_date").order("sort_order"),
        client.from("ft_candidate_places").select("*").order("name"),
        client.from("ft_checklists").select("*").order("sort_order"),
        client.from("ft_expenses").select("*").order("spent_at", { ascending: false }),
      ]);
      if (tripsRes.error) throw tripsRes.error;
      cloudSchemaReady = true;
      const db = {
        trips: tripsRes.data || [],
        itinerary: itRes.data || [],
        candidates: candRes.data || [],
        checklists: chkRes.data || [],
        expenses: expRes.data || [],
      };
      writeLocalDb(db);
      return { db, source: "cloud" };
    } catch (err) {
      cloudSchemaReady = false;
      console.warn("Supabase 로드 대기(로컬 캐시 사용):", err);
      return { db: readLocalDb(), source: "offline-cache", error: err.message };
    }
  }
  return { db: readLocalDb(), source: isSupabaseConfigured(cfg) ? "offline-cache" : "local" };
}

export async function subscribeRealtime(onChange) {
  const cfg = getAppConfig();
  if (!isSupabaseConfigured(cfg) || !cloudSchemaReady || !navigator.onLine) return;
  try {
    const client = await getAuthedSupabase(currentPin);
    if (realtimeChannel) {
      try { realtimeChannel.unsubscribe(); } catch {}
    }
    realtimeChannel = client
      .channel("family-travel-sync")
      .on("postgres_changes", { event: "*", schema: "public", table: "ft_trips" }, () => onChange())
      .on("postgres_changes", { event: "*", schema: "public", table: "ft_itinerary_items" }, () => onChange())
      .on("postgres_changes", { event: "*", schema: "public", table: "ft_candidate_places" }, () => onChange())
      .on("postgres_changes", { event: "*", schema: "public", table: "ft_expenses" }, () => onChange())
      .on("postgres_changes", { event: "*", schema: "public", table: "ft_checklists" }, () => onChange())
      .subscribe();
  } catch (err) {
    console.warn("Realtime 구독 건너뜀:", err);
  }
}

export function uid(prefix = "id") {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

async function upsertRow(tableName, localKey, row) {
  const db = readLocalDb();
  const list = db[localKey] || [];
  const idx = list.findIndex((x) => x.id === row.id);
  if (idx >= 0) list[idx] = { ...list[idx], ...row };
  else list.push(row);
  db[localKey] = list;
  writeLocalDb(db);

  const cfg = getAppConfig();
  if (isSupabaseConfigured(cfg) && cloudSchemaReady && navigator.onLine) {
    const client = await getAuthedSupabase(currentPin);
    const { error } = await client.from(tableName).upsert(row);
    if (error) throw new Error(`저장 오류(${tableName}): ${error.message}`);
  }
  return row;
}

async function deleteRow(tableName, localKey, id) {
  const db = readLocalDb();
  db[localKey] = (db[localKey] || []).filter((x) => x.id !== id);
  writeLocalDb(db);

  const cfg = getAppConfig();
  if (isSupabaseConfigured(cfg) && cloudSchemaReady && navigator.onLine) {
    const client = await getAuthedSupabase(currentPin);
    const { error } = await client.from(tableName).delete().eq("id", id);
    if (error) throw new Error(`삭제 오류(${tableName}): ${error.message}`);
  }
}

export const store = {
  async saveTrip(trip) {
    return upsertRow("ft_trips", "trips", { ...trip, updated_at: new Date().toISOString() });
  },
  async createTripWithTemplate(tripInput) {
    const tripId = uid("trip");
    const trip = {
      id: tripId,
      title: tripInput.title,
      destination: tripInput.destination,
      flag: tripInput.flag || "✈️",
      start_date: tripInput.start_date,
      end_date: tripInput.end_date,
      currency: tripInput.currency || "JPY",
      exchange_rate: Number(tripInput.exchange_rate) || 100,
      summary: tripInput.summary || "",
      members: tripInput.members || [
        { name: "아빠", age: null, type: "adult" },
        { name: "엄마", age: null, type: "adult" },
        { name: "서준", age: 12, type: "adult" },
        { name: "루리", age: 10, type: "child" },
      ],
      wallets: [
        { id: "travellog", name: "트래블로그", type: "card", initial_local: 0, currency: tripInput.currency || "JPY", memo: "해외 결제용 카드" },
        { id: "cash", name: `현지 현금 (${tripInput.currency || "JPY"})`, type: "cash", initial_local: 0, currency: tripInput.currency || "JPY", memo: "" },
        { id: "card", name: "신용카드", type: "card", initial_local: 0, currency: "KRW", memo: "" },
      ],
      transport_info: { headline: "교통 메모", note: "", passes: [], routes: [], octopus_members: [] },
      budget_plan: { local_items: [], krw_items: [] },
      photo_credits: [],
    };
    await this.saveTrip(trip);

    for (let i = 0; i < DEFAULT_NEW_TRIP_CHECKLIST.length; i++) {
      const tpl = DEFAULT_NEW_TRIP_CHECKLIST[i];
      await this.saveChecklist({
        id: uid("chk"),
        trip_id: tripId,
        group_type: "prep",
        sort_order: i + 1,
        ...tpl,
      });
    }
    return trip;
  },
  async deleteTrip(tripId) {
    const db = readLocalDb();
    db.trips = db.trips.filter((t) => t.id !== tripId);
    db.itinerary = db.itinerary.filter((x) => x.trip_id !== tripId);
    db.candidates = db.candidates.filter((x) => x.trip_id !== tripId);
    db.checklists = db.checklists.filter((x) => x.trip_id !== tripId);
    db.expenses = db.expenses.filter((x) => x.trip_id !== tripId);
    writeLocalDb(db);

    const cfg = getAppConfig();
    if (isSupabaseConfigured(cfg) && cloudSchemaReady && navigator.onLine) {
      const client = await getAuthedSupabase(currentPin);
      const { error } = await client.from("ft_trips").delete().eq("id", tripId);
      if (error) throw new Error(`여행 삭제 실패: ${error.message}`);
    }
  },
  saveItinerary(item) {
    return upsertRow("ft_itinerary_items", "itinerary", { ...item, updated_at: new Date().toISOString() });
  },
  deleteItinerary(id) {
    return deleteRow("ft_itinerary_items", "itinerary", id);
  },
  saveCandidate(item) {
    return upsertRow("ft_candidate_places", "candidates", { ...item, updated_at: new Date().toISOString() });
  },
  deleteCandidate(id) {
    return deleteRow("ft_candidate_places", "candidates", id);
  },
  saveExpense(item) {
    return upsertRow("ft_expenses", "expenses", item);
  },
  deleteExpense(id) {
    return deleteRow("ft_expenses", "expenses", id);
  },
  saveChecklist(item) {
    return upsertRow("ft_checklists", "checklists", { ...item, updated_at: new Date().toISOString() });
  },
  deleteChecklist(id) {
    return deleteRow("ft_checklists", "checklists", id);
  },
  async uploadFile(blob, folder = "receipts", ext = "jpg") {
    const cfg = getAppConfig();
    if (isSupabaseConfigured(cfg) && cloudSchemaReady && navigator.onLine) {
      const client = await getAuthedSupabase(currentPin);
      const filePath = `${folder}/${Date.now()}-${Math.random().toString(36).slice(2, 7)}.${ext}`;
      const { error } = await client.storage.from("travel-files").upload(filePath, blob, {
        contentType: blob.type || "image/jpeg",
        upsert: false,
      });
      if (!error) {
        const { data } = client.storage.from("travel-files").getPublicUrl(filePath);
        return data.publicUrl;
      }
      console.warn("Storage 업로드 실패, 로컬 DataURL 폴백:", error.message);
    }
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  },
};
