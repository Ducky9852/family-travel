# ✈️ 우리 가족 여행 플래너 & 영수증 자동 가계부 (PWA)

GitHub Pages에 올려 스마트폰 홈 화면에 앱처럼 설치(PWA)하고, **Supabase 실시간 동기화**와 **Gemini 3.8 Flash 영수증 자동 인식**으로 여행 중 일정 수정·가계부 기록·구글맵 길찾기를 한 번에 해결하는 가족 전용 여행 관리 웹앱입니다.

---

## 주요 기능

- **멀티 트립 보관함**: 2027 홍콩 가족여행 초기 데이터 탑재 + 앞으로의 새 여행을 무제한 추가(통화·환율·기본 체크리스트 자동 세팅)
- **가족 PIN 잠금 보안**: GitHub Pages에 올려도 가족 PIN(기본 `2027`, 변경 가능)을 모르면 Supabase RLS가 모든 데이터 읽기/쓰기와 AI 영수증 호출을 차단
- **모바일 일정 관리**: 일자별 타임라인, 순서 변경, 완료/건너뛰기, 대안 식당 원터치 교체, 택시 기사님 보여주기(초대형 현지어/주소), 일정별 바우처/QR 첨부
- **영수증 사진 → 자동 가계부**: 하단 📷 버튼으로 영수증을 찍으면 Gemini 3.8 Flash가 가게명·현지 금액·원화 환산·카테고리·품목을 자동 입력 + 예산 대비 진행률 + 지갑별 잔액(현금/트래블로그/아이들 옥토퍼스) 추적
- **듀얼 지도 + 구글맵 연동**: 무료 인터랙티브 지도(Leaflet/OSM) 기본 제공 + Google Maps JS API 키 입력 시 Google Maps 직접 전환 + 모든 장소 카드에서 Google Maps 앱 원터치 길찾기
- **준비·교통·옥토퍼스 계산기**: 예약 체크리스트, 환전·옥토퍼스 준비 순서, 구성원별 옥토퍼스 카드 자동 계산기
- **오프라인 PWA + 엑셀 백업**: 비행기/지하철 오프라인 캐시 지원 + 여행 종료 후 전체 일정/가계부 `.xlsx` 다운로드

---

## Supabase 연동 가이드 (5분 완료)

### 1단계. DB 테이블 · PIN 보안 RLS · Storage 생성
1. [Supabase Dashboard](https://supabase.com/dashboard) → 내 프로젝트 → **SQL Editor** 이동
2. [`supabase/schema.sql`](./supabase/schema.sql) 내용을 전체 복사 → 붙여넣기 → **Run** 클릭
3. 초기 가족 PIN은 `2027`입니다. (입장 후 앱 내 ⚙️ 설정에서 변경 가능)

### 2단계. 영수증 자동 인식 Edge Function 배포 (Gemini 3.8 Flash)
로컬 터미널에서 Supabase CLI로 배포합니다:
```bash
supabase login
supabase link --project-ref <내_프로젝트_REF>
supabase secrets set GEMINI_API_KEY=<발급받은_Gemini_API_키>
supabase functions deploy parse-receipt --no-verify-jwt
```
> `--no-verify-jwt`를 사용하지만, 함수 내부에서 `x-family-pin` 헤더로 가족 PIN을 검증하므로 외부인의 무단 호출이 차단됩니다.

### 3단계. 프론트엔드에 Supabase 연결
- 방법 A (추천): [`js/config.js`](./js/config.js)의 `supabaseUrl`, `supabaseAnonKey`에 내 프로젝트 값을 넣고 GitHub에 푸시하면, 가족 누구나 링크만 열면 바로 연결됩니다.
- 방법 B: 앱 실행 후 ⚙️ **설정** 화면에서 직접 URL과 Anon Key를 입력해도 됩니다.

---

## GitHub Pages 배포 방법

```bash
git init
git add .
git commit -m "우리 가족 여행 플래너 초기 버전"
git branch -M main
git remote add origin https://github.com/<본인ID>/family-travel.git
git push -u origin main
```
이후 GitHub 리포지토리 → **Settings → Pages → Branch: `main` / `/ (root)` → Save** 클릭.  
1~2분 뒤 `https://<본인ID>.github.io/family-travel/`에서 열리고, 모바일 Safari/Chrome에서 **홈 화면에 추가**하면 앱처럼 사용할 수 있습니다.
