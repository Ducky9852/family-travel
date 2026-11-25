// 영수증 이미지 압축 + Supabase Edge Function(Gemini 3.8 Flash) 자동 파싱
import { getAppConfig, isSupabaseConfigured } from "./config.js";
import { getStoredPin } from "./store.js";

/**
 * 모바일 촬영 사진(3~8MB)을 1280px 이하 JPEG로 압축해 데이터·속도·인식률 최적화
 */
export async function compressImageFile(file, maxWidth = 1280, quality = 0.8) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      let { width, height } = img;
      if (width > maxWidth) {
        height = Math.round((height * maxWidth) / width);
        width = maxWidth;
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, width, height);
      canvas.toBlob(
        (blob) => {
          if (!blob) return reject(new Error("이미지 압축 실패"));
          const reader = new FileReader();
          reader.onloadend = () => {
            const dataUrl = reader.result;
            const base64 = dataUrl.split(",")[1];
            resolve({ blob, dataUrl, base64, mimeType: "image/jpeg" });
          };
          reader.readAsDataURL(blob);
        },
        "image/jpeg",
        quality
      );
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("이미지를 불러올 수 없습니다."));
    };
    img.src = url;
  });
}

/**
 * 영수증 이미지를 Supabase Edge Function(parse-receipt)으로 보내 Gemini 3.8 Flash 분석 수행
 */
export async function analyzeReceiptWithAI({ base64, mimeType, defaultCurrency, tripContext }) {
  const cfg = getAppConfig();
  if (!isSupabaseConfigured(cfg)) {
    return {
      ok: false,
      fallback: true,
      message: "Supabase가 아직 연결되지 않아 영수증 사진만 첨부했습니다. 금액과 가게명을 직접 입력해 주세요.",
    };
  }

  const endpoint = `${cfg.supabaseUrl.replace(/\/$/, "")}/functions/v1/parse-receipt`;
  const resp = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: cfg.supabaseAnonKey,
      Authorization: `Bearer ${cfg.supabaseAnonKey}`,
      "x-family-pin": getStoredPin(),
    },
    body: JSON.stringify({
      imageBase64: base64,
      mimeType,
      defaultCurrency,
      tripContext,
    }),
  });

  const payload = await resp.json().catch(() => ({}));
  if (!resp.ok || !payload.ok) {
    return {
      ok: false,
      fallback: true,
      message: payload.error || `영수증 AI 분석 실패 (HTTP ${resp.status}). 아래에서 직접 수정해 저장할 수 있습니다.`,
    };
  }

  return { ok: true, data: payload.data };
}

/**
 * AI가 추출한 결제수단 힌트를 여행 지갑 ID에 자동 매칭
 */
export function guessWalletId(paymentHint = "", wallets = []) {
  const h = String(paymentHint || "").toLowerCase();
  if (h.includes("octopus") || h.includes("八達通")) {
    const oct = wallets.find((w) => w.type === "octopus");
    if (oct) return oct.id;
  }
  if (h.includes("cash") || h.includes("현금") || h.includes("現金")) {
    const cash = wallets.find((w) => w.type === "cash");
    if (cash) return cash.id;
  }
  const travelCard = wallets.find((w) => w.id === "travellog") || wallets[0];
  return travelCard ? travelCard.id : "card";
}
