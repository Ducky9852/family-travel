// Supabase Edge Function: 영수증 이미지 → Gemini 3.8 Flash 자동 파싱
// 배포: supabase functions deploy parse-receipt --no-verify-jwt
// 비밀키 등록: supabase secrets set GEMINI_API_KEY=발급받은키

import { createClient } from "npm:@supabase/supabase-js@2";
import { GoogleGenAI } from "npm:@google/genai@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-family-pin",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const RECEIPT_SCHEMA = {
  type: "object",
  properties: {
    merchant: {
      type: "string",
      description: "가게/상호명 (한국어 병기 가능, 예: 딤섬스퀘어 Dim Sum Square)",
    },
    date: {
      type: "string",
      description: "결제 날짜 YYYY-MM-DD (알 수 없으면 빈 문자열)",
    },
    time: {
      type: "string",
      description: "결제 시각 HH:MM 24시간 형식 (알 수 없으면 빈 문자열)",
    },
    amount: {
      type: "number",
      description: "최종 결제 총액 숫자 (봉사료/세금 포함 최종 합계)",
    },
    currency: {
      type: "string",
      description: "통화 ISO 코드 (예: HKD, KRW, JPY, USD, EUR, THB)",
    },
    category: {
      type: "string",
      enum: ["식비", "간식", "교통", "입장권", "쇼핑", "숙소", "항공", "기타"],
      description: "지출 카테고리",
    },
    payment_hint: {
      type: "string",
      description: "영수증에 적힌 결제 수단 힌트 (예: CASH, OCTOPUS, VISA, MASTERCARD 등)",
    },
    items_summary: {
      type: "string",
      description: "구매 품목 한국어 간단 요약 (예: 하가우, 시우마이, 밀크티 외 2건)",
    },
    confidence: {
      type: "number",
      description: "인식 신뢰도 0~1",
    },
  },
  required: ["merchant", "amount", "currency", "category", "items_summary"],
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // 1. 가족 PIN 검증 (외부인의 Gemini API 무단 호출 차단)
    const familyPin = req.headers.get("x-family-pin") || "";
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    const supabase = createClient(supabaseUrl, supabaseAnonKey);
    const { data: pinOk, error: pinErr } = await supabase.rpc("ft_verify_family_pin", {
      input_pin: familyPin,
    });

    if (pinErr || !pinOk) {
      return new Response(
        JSON.stringify({ error: "가족 PIN 인증에 실패했습니다." }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 2. 요청 바디 파싱
    const { imageBase64, mimeType = "image/jpeg", defaultCurrency = "HKD", tripContext = "" } =
      await req.json();

    if (!imageBase64) {
      return new Response(
        JSON.stringify({ error: "영수증 이미지 데이터가 없습니다." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const geminiApiKey = Deno.env.get("GEMINI_API_KEY");
    if (!geminiApiKey) {
      return new Response(
        JSON.stringify({ error: "서버에 GEMINI_API_KEY가 설정되지 않았습니다." }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 3. Gemini 3.8 Flash Interactions API 호출 (이미지 이해 + JSON 구조화 출력)
    const ai = new GoogleGenAI({ apiKey: geminiApiKey });
    const prompt = [
      "당신은 해외 가족여행 영수증 가계부 정리 도우미입니다.",
      `현재 여행 컨텍스트: ${tripContext || "해외여행"} (기본 통화: ${defaultCurrency}).`,
      "영수증 이미지를 정확히 읽고 최종 결제 총액(Total/합계, 10% Service Charge 등 포함 금액), 가게명, 날짜/시각, 통화, 카테고리, 구매 품목 요약을 JSON으로 추출하세요.",
      "숫자는 절대 추측하지 말고 영수증에 적힌 값을 그대로 읽으세요. 통화 표기가 '$'만 있고 홍콩/현지 영수증이면 기본 통화를 사용하세요.",
      "품목 요약은 한국어로 알기 쉽게 짧게 정리하세요.",
    ].join("\n");

    const interaction = await ai.interactions.create({
      model: "gemini-3.8-flash",
      store: false,
      input: [
        { type: "text", text: prompt },
        {
          type: "image",
          data: imageBase64,
          mime_type: mimeType,
        },
      ],
      response_format: {
        type: "text",
        mime_type: "application/json",
        schema: RECEIPT_SCHEMA,
      },
    });

    const rawText = interaction.output_text || "{}";
    const parsed = JSON.parse(rawText);

    return new Response(JSON.stringify({ ok: true, data: parsed }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("parse-receipt error:", err);
    return new Response(
      JSON.stringify({
        error: "영수증 분석 중 오류가 발생했습니다.",
        detail: err instanceof Error ? err.message : String(err),
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
