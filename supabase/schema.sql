-- ============================================================
-- 우리 가족 여행 플래너 & 가계부 — Supabase DB 스키마 + PIN 보안 RLS
-- 모든 테이블/함수에 ft_ 접두사를 사용해 기존 프로젝트의 다른 테이블과 100% 분리됩니다.
-- Supabase Dashboard → SQL Editor에 전체 붙여넣기 후 Run 하세요.
-- ============================================================

-- 1. 앱 설정 (가족 PIN 저장 — 직접 읽기 차단, RPC 함수로만 검증)
CREATE TABLE IF NOT EXISTS ft_app_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 초기 가족 PIN 설정 (기본값: '2027' — 입장 후 앱 설정에서 변경 가능)
INSERT INTO ft_app_settings (key, value)
VALUES ('family_pin', '{"pin": "2027"}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- PIN 검증 헬퍼 함수 (모든 ft_ 테이블 RLS에서 호출)
CREATE OR REPLACE FUNCTION public.ft_check_family_pin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (current_setting('request.headers', true)::json ->> 'x-family-pin'),
    ''
  ) = COALESCE(
    (SELECT value ->> 'pin' FROM public.ft_app_settings WHERE key = 'family_pin'),
    ''
  );
$$;

-- 프론트엔드에서 PIN 로그인 시 호출하는 RPC
CREATE OR REPLACE FUNCTION public.ft_verify_family_pin(input_pin TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT input_pin = COALESCE(
    (SELECT value ->> 'pin' FROM public.ft_app_settings WHERE key = 'family_pin'),
    ''
  );
$$;

-- 프론트엔드에서 PIN 변경 시 호출하는 RPC (현재 PIN 확인 필수)
CREATE OR REPLACE FUNCTION public.ft_update_family_pin(current_pin TEXT, new_pin TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF length(trim(new_pin)) < 4 THEN
    RETURN FALSE;
  END IF;
  IF current_pin <> COALESCE((SELECT value ->> 'pin' FROM public.ft_app_settings WHERE key = 'family_pin'), '') THEN
    RETURN FALSE;
  END IF;
  UPDATE public.ft_app_settings
  SET value = jsonb_build_object('pin', trim(new_pin)), updated_at = NOW()
  WHERE key = 'family_pin';
  RETURN TRUE;
END;
$$;

-- 2. 여행 마스터 (멀티 트립)
CREATE TABLE IF NOT EXISTS ft_trips (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  destination TEXT NOT NULL,
  flag TEXT DEFAULT '✈️',
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  currency TEXT NOT NULL DEFAULT 'HKD',
  exchange_rate NUMERIC(10, 2) NOT NULL DEFAULT 190,
  summary TEXT DEFAULT '',
  members JSONB NOT NULL DEFAULT '[]'::jsonb,
  wallets JSONB NOT NULL DEFAULT '[]'::jsonb,
  transport_info JSONB NOT NULL DEFAULT '{}'::jsonb,
  budget_plan JSONB NOT NULL DEFAULT '{}'::jsonb,
  photo_credits JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. 일정표 항목
CREATE TABLE IF NOT EXISTS ft_itinerary_items (
  id TEXT PRIMARY KEY,
  trip_id TEXT NOT NULL REFERENCES ft_trips(id) ON DELETE CASCADE,
  day_date DATE NOT NULL,
  day_label TEXT NOT NULL,
  time_str TEXT DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  category TEXT NOT NULL DEFAULT '관광',
  title TEXT NOT NULL,
  local_name TEXT DEFAULT '',
  address TEXT DEFAULT '',
  map_query TEXT DEFAULT '',
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  details TEXT DEFAULT '',
  transport TEXT DEFAULT '',
  reservation_status TEXT DEFAULT '불필요',
  alternatives JSONB NOT NULL DEFAULT '[]'::jsonb,
  photos JSONB NOT NULL DEFAULT '[]'::jsonb,
  vouchers JSONB NOT NULL DEFAULT '[]'::jsonb,
  completed BOOLEAN NOT NULL DEFAULT FALSE,
  skipped BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ft_itinerary_trip_day ON ft_itinerary_items(trip_id, day_date, sort_order);

-- 4. 후보 식당 / 여행지 (구글맵 연동 버킷리스트)
CREATE TABLE IF NOT EXISTS ft_candidate_places (
  id TEXT PRIMARY KEY,
  trip_id TEXT NOT NULL REFERENCES ft_trips(id) ON DELETE CASCADE,
  category TEXT NOT NULL DEFAULT '식당',
  name TEXT NOT NULL,
  local_name TEXT DEFAULT '',
  area TEXT DEFAULT '',
  address TEXT DEFAULT '',
  map_query TEXT DEFAULT '',
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  recommended_menu TEXT DEFAULT '',
  est_price_local NUMERIC(12, 2) DEFAULT 0,
  reservation TEXT DEFAULT '불필요',
  memo TEXT DEFAULT '',
  photo TEXT DEFAULT '',
  planned_day_date DATE,
  meal_type TEXT DEFAULT '',
  is_added BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ft_candidates_trip ON ft_candidate_places(trip_id);

-- 5. 가계부 지출 (영수증 AI 자동 등록 + 수동 등록)
CREATE TABLE IF NOT EXISTS ft_expenses (
  id TEXT PRIMARY KEY,
  trip_id TEXT NOT NULL REFERENCES ft_trips(id) ON DELETE CASCADE,
  spent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  day_date DATE,
  merchant TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '식비',
  amount_local NUMERIC(12, 2) NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'HKD',
  exchange_rate NUMERIC(10, 2) NOT NULL DEFAULT 190,
  amount_krw INTEGER NOT NULL DEFAULT 0,
  wallet_id TEXT DEFAULT 'card',
  items_summary TEXT DEFAULT '',
  memo TEXT DEFAULT '',
  receipt_url TEXT DEFAULT '',
  ai_raw JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ft_expenses_trip ON ft_expenses(trip_id, spent_at DESC);

-- 6. 준비 체크리스트 & 현지 준비 순서
CREATE TABLE IF NOT EXISTS ft_checklists (
  id TEXT PRIMARY KEY,
  trip_id TEXT NOT NULL REFERENCES ft_trips(id) ON DELETE CASCADE,
  group_type TEXT NOT NULL DEFAULT 'prep',
  sort_order INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL,
  due_label TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT '예정',
  memo TEXT DEFAULT '',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ft_checklists_trip ON ft_checklists(trip_id, group_type, sort_order);

-- ============================================================
-- Row Level Security (RLS) 활성화 — 가족 PIN 헤더 검증
-- ============================================================
ALTER TABLE ft_app_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE ft_trips ENABLE ROW LEVEL SECURITY;
ALTER TABLE ft_itinerary_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE ft_candidate_places ENABLE ROW LEVEL SECURITY;
ALTER TABLE ft_expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE ft_checklists ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ft_deny_direct_settings" ON ft_app_settings;
CREATE POLICY "ft_deny_direct_settings" ON ft_app_settings FOR ALL USING (FALSE);

DROP POLICY IF EXISTS "ft_pin_trips" ON ft_trips;
CREATE POLICY "ft_pin_trips" ON ft_trips FOR ALL USING (public.ft_check_family_pin()) WITH CHECK (public.ft_check_family_pin());

DROP POLICY IF EXISTS "ft_pin_itinerary" ON ft_itinerary_items;
CREATE POLICY "ft_pin_itinerary" ON ft_itinerary_items FOR ALL USING (public.ft_check_family_pin()) WITH CHECK (public.ft_check_family_pin());

DROP POLICY IF EXISTS "ft_pin_candidates" ON ft_candidate_places;
CREATE POLICY "ft_pin_candidates" ON ft_candidate_places FOR ALL USING (public.ft_check_family_pin()) WITH CHECK (public.ft_check_family_pin());

DROP POLICY IF EXISTS "ft_pin_expenses" ON ft_expenses;
CREATE POLICY "ft_pin_expenses" ON ft_expenses FOR ALL USING (public.ft_check_family_pin()) WITH CHECK (public.ft_check_family_pin());

DROP POLICY IF EXISTS "ft_pin_checklists" ON ft_checklists;
CREATE POLICY "ft_pin_checklists" ON ft_checklists FOR ALL USING (public.ft_check_family_pin()) WITH CHECK (public.ft_check_family_pin());

-- ============================================================
-- Storage 버킷 (영수증 사진 & 바우처 파일 저장)
-- ============================================================
INSERT INTO storage.buckets (id, name, public)
VALUES ('travel-files', 'travel-files', TRUE)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "ft_travel_files_read" ON storage.objects;
CREATE POLICY "ft_travel_files_read" ON storage.objects
  FOR SELECT USING (bucket_id = 'travel-files');

DROP POLICY IF EXISTS "ft_travel_files_insert" ON storage.objects;
CREATE POLICY "ft_travel_files_insert" ON storage.objects
  FOR INSERT WITH CHECK (bucket_id = 'travel-files' AND public.ft_check_family_pin());

DROP POLICY IF EXISTS "ft_travel_files_delete" ON storage.objects;
CREATE POLICY "ft_travel_files_delete" ON storage.objects
  FOR DELETE USING (bucket_id = 'travel-files' AND public.ft_check_family_pin());
