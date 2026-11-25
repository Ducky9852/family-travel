// 앱 전역 설정 (GitHub Pages에 올려도 안전한 공개 설정만 저장)
// 주의: GEMINI_API_KEY 및 Supabase SERVICE_ROLE_KEY는 절대 여기에 넣지 마세요!

export const DEFAULT_CONFIG = {
  // 기존 Supabase 프로젝트 자동 연동 (ft_ 접두사 테이블로 사내 DB와 완전 분리)
  supabaseUrl: "https://hkvguhttmxclyaeskznk.supabase.co",
  supabaseAnonKey: "sb_publishable_qZvInHl5ds9HXTJ_cMF7-g_0P-SefMJ",

  // 선택: Google Maps JavaScript API 키 (미입력 시 무료 OSM 지도 + Google Maps 앱 길찾기 사용)
  // 프로덕션 배포 시 Google Cloud Console에서 반드시 HTTP 리퍼러 제한을 설정하세요!
  googleMapsApiKey: "",
  googleMapsMapId: "DEMO_MAP_ID",

  // 로컬 데모/오프라인 모드 기본 PIN (Supabase에 schema.sql 적용 시 DB의 ft_app_settings 값 사용)
  localFallbackPin: "2027",
};

const CONFIG_STORAGE_KEY = "family_travel_config_v1";

export function getAppConfig() {
  try {
    const saved = JSON.parse(localStorage.getItem(CONFIG_STORAGE_KEY) || "{}");
    return {
      ...DEFAULT_CONFIG,
      ...saved,
      supabaseUrl: saved.supabaseUrl || DEFAULT_CONFIG.supabaseUrl,
      supabaseAnonKey: saved.supabaseAnonKey || DEFAULT_CONFIG.supabaseAnonKey,
      googleMapsApiKey: saved.googleMapsApiKey || DEFAULT_CONFIG.googleMapsApiKey,
      googleMapsMapId: saved.googleMapsMapId || DEFAULT_CONFIG.googleMapsMapId,
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveAppConfig(partial) {
  const next = { ...getAppConfig(), ...partial };
  localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(next));
  return next;
}

export function isSupabaseConfigured(cfg = getAppConfig()) {
  return Boolean(cfg.supabaseUrl && cfg.supabaseAnonKey && cfg.supabaseUrl.startsWith("http"));
}
