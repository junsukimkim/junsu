// stock/netlify/functions/ipo-meta.js
// 목적: 38 공모청약일정(표)에서 종목명 -> (주간사/공모가or희망가) 추출
// EUC-KR 디코딩 필요: TextDecoder(euc-kr) 시도, 실패하면 iconv-lite 시도

function decodeEucKr(buffer) {
  // 1) Node TextDecoder 시도
  try {
    const td = new TextDecoder("euc-kr");
    return td.decode(buffer);
  } catch (_) {}

  // 2) iconv-lite 시도 (프로젝트에 설치돼 있거나 Netlify 번들러가 포함한 경우)
  try {
    // eslint-disable-next-line global-require
    const iconv = require("iconv-lite");
    return iconv.decode(Buffer.from(buffer), "euc-kr");
  } catch (e) {
    // 마지막 fallback: latin1로라도 (깨질 수 있음)
    return Buffer.from(buffer).toString("latin1");
  }
}

function stripTags(html) {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|ul|ol|table|thead|tbody|tfoot|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function norm(s) {
  return String(s ?? "").replace(/\s+/g, "").trim();
}

function parsePriceToNumber(priceText) {
  // "17,000" -> 17000
  const m = String(priceText ?? "").match(/[\d,]+/);
  if (!m) return null;
  return Number(m[0].replaceAll(",", "")) || null;
}

function parseUpperFromRange(rangeText) {
  // "12,100~16,600" -> 16600
  const parts = String(rangeText ?? "").split("~").map(x => x.trim());
  if (parts.length === 2) return parsePriceToNumber(parts[1]);
  return parsePriceToNumber(rangeText);
}

async function fetchWithTimeout(url, ms=8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; IPOAlert/1.0)",
        "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
      },
    });
    return res;
  } finally {
    clearTimeout(t);
  }
}

function extractRows(html) {
  // table row 단위로 대충 파싱
  const rows = [];
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = trRe.exec(html))) {
    const tr = m[1];
    // td 목록
    const tds = [];
    const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let t;
    while ((t = tdRe.exec(tr))) {
      tds.push(t[1]);
    }
    if (tds.length >= 6) rows.push(tds);
  }
  return rows;
}

exports.handler = async (event) => {
  try {
    const namesParam = event.queryStringParameters?.names || "";
    const names = namesParam.split("|").map(s => s.trim()).filter(Boolean);
    if (names.length === 0) {
      return {
        statusCode: 200,
        headers: { "content-type":"application/json; charset=utf-8" },
        body: JSON.stringify({ ok:true, items:[] })
      };
    }

    const want = new Map(names.map(n => [norm(n), n]));
    const found = new Map();

    // 38 공모청약일정 페이지들(최대 3페이지)
    const urls = [
      "https://www.38.co.kr/html/fund/?o=k",
      "https://www.38.co.kr/html/fund/index.htm?o=k&page=2",
      "https://www.38.co.kr/html/fund/index.htm?o=k&page=3",
    ];

    for (const url of urls) {
      if (found.size >= want.size) break;

      const res = await fetchWithTimeout(url, 9000);
      if (!res.ok) continue;

      const ab = await res.arrayBuffer();
      const html = decodeEucKr(ab);

      const rows = extractRows(html);

      for (const cols of rows) {
        // cols 예상:
        // [종목명, 공모주일정, 확정공모가, 희망공모가, 청약경쟁률, 주간사, ...]
        const nameHtml = cols[0];
        const scheduleTxt = stripTags(cols[1] || "");
        const fixedPriceTxt = stripTags(cols[2] || "");
        const rangePriceTxt = stripTags(cols[3] || "");
        const brokersTxt = stripTags(cols[5] || "");

        const nameTxt = stripTags(nameHtml).split(" ")[0]; // 첫 단어가 종목명일 가능성이 큼
        const key = norm(nameTxt);

        if (!want.has(key)) continue;
        if (found.has(key)) continue;

        const fixed = parsePriceToNumber(fixedPriceTxt);
        const upper = parseUpperFromRange(rangePriceTxt);
        const offer = fixed ?? upper ?? null;

        // 균등 최소(추정): 최소청약 10주, 증거금률 50% 가정
        const minQty = 10;
        const depoRate = 0.5;
        const minDeposit = offer ? Math.round(offer * minQty * depoRate) : null;

        found.set(key, {
          corp_name: want.get(key),
          brokers: brokersTxt || "",
          offer_price_krw: offer,
          min_deposit_krw: minDeposit,
          min_deposit_note: offer
            ? `추정치(최소 ${minQty}주, 증거금 ${Math.round(depoRate*100)}% 가정)`
            : "공모가 미확정/표 정보 부족",
          source_hint: "38 공모청약일정(표)",
          schedule_hint: scheduleTxt || ""
        });
      }
    }

    const items = Array.from(found.values());

    return {
      statusCode: 200,
      headers: {
        "content-type":"application/json; charset=utf-8",
        "cache-control":"public, max-age=1800"
      },
      body: JSON.stringify({ ok:true, items })
    };
  } catch (e) {
    return {
      statusCode: 200,
      headers: { "content-type":"application/json; charset=utf-8" },
      body: JSON.stringify({ ok:false, error: String(e?.message || e) })
    };
  }
};
