// stock/netlify/functions/dart-ipo.js
// DART 청약달력(dsac008)에서 "청약(지분증권)" 일정 파싱
// + KIND 상장사 목록으로 필터링(상장사 유상증자/권리 등 제거)
// + ✅ 월별 캐시 키 분리 (YYYY-MM) : "2월 HTML을 3월에 재사용" 버그 방지

export const handler = async (event) => {
  // CORS
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: corsHeaders(),
      body: "",
    };
  }

  try {
    const url = new URL(event.rawUrl || "https://example.com");
    const year = (url.searchParams.get("year") || "").trim();
    const month = (url.searchParams.get("month") || "").trim();

    const { y, m } = normalizeYearMonth(year, month);

    // 1) DART 달력 HTML 가져오기(✅ YYYY-MM 캐시)
    const html = await getDsac008Html(y, m);

    // 2) HTML -> text lines -> 일정 파싱
    const lines = htmlToLines(html);
    const rawItems = parseDsac008LinesToItems(lines, y, m); // {corp_name, market_short, market, sbd_start, sbd_end}

    // 3) KIND 상장사 목록 가져오기(✅ 하루 캐시)
    const listedSet = await getKindListedNameSet();

    // 4) 상장사 제거 => "공모(비상장)" 성격만 남기기
    let excluded_listed = 0;
    const items = rawItems.filter((it) => {
      if (listedSet.has(normalizeCorpName(it.corp_name))) {
        excluded_listed += 1;
        return false;
      }
      return true;
    });

    return json(200, {
      ok: true,
      source: "dart-dsac008 + kind-listed-filter(euc-kr)",
      year: String(y),
      month: String(m).padStart(2, "0"),
      count: items.length,
      excluded_listed,
      listed_filter_stale: false,
      listed_set_size: listedSet.size,
      items,
      debug: {
        raw_count: rawItems.length,
      },
    });
  } catch (err) {
    return json(500, {
      ok: false,
      error: String(err?.message || err),
    });
  }
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  };
}

function json(statusCode, obj) {
  return {
    statusCode,
    headers: corsHeaders(),
    body: JSON.stringify(obj),
  };
}

function normalizeYearMonth(yearStr, monthStr) {
  // 기본값: 한국시간 기준 "이번달"
  const nowKst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  let y = parseInt(yearStr, 10);
  let m = parseInt(monthStr, 10);

  if (!Number.isFinite(y) || y < 2015 || y > 2100) y = nowKst.getUTCFullYear();
  if (!Number.isFinite(m) || m < 1 || m > 12) m = nowKst.getUTCMonth() + 1;

  return { y, m };
}

/* -----------------------------
 *  ✅ DART HTML 월별 캐시
 * ----------------------------- */
const DSAC008_CACHE = new Map(); // key "YYYY-MM" -> { html, ts }
const DSAC008_TTL_MS = 10 * 60 * 1000; // 10분

function ymKey(y, m) {
  return `${y}-${String(m).padStart(2, "0")}`;
}

async function getDsac008Html(y, m) {
  const key = ymKey(y, m);
  const now = Date.now();
  const hit = DSAC008_CACHE.get(key);
  if (hit && now - hit.ts < DSAC008_TTL_MS) {
    return hit.html;
  }
  const html = await fetchDsac008HtmlFromDart(y, m);
  DSAC008_CACHE.set(key, { html, ts: now });
  return html;
}

async function fetchDsac008HtmlFromDart(y, m) {
  // DART 청약달력(지분증권)
  // ✅ 이 URL은 브라우저에서 year/month 바꿔도 동작하는 형태로 맞춤
  const mm = String(m).padStart(2, "0");
  const u = `https://dart.fss.or.kr/dsac008/main.do?selectYear=${encodeURIComponent(
    y
  )}&selectMonth=${encodeURIComponent(mm)}`;

  const html = await fetchText(u, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (compatible; ipo-bot/1.0; +https://netlify.app)",
      accept: "text/html,application/xhtml+xml",
    },
    timeoutMs: 12000,
  });

  if (!html || html.length < 2000) {
    throw new Error("DART HTML too small / blocked");
  }
  return html;
}

async function fetchText(url, { headers = {}, timeoutMs = 10000 } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);

  try {
    const res = await fetch(url, { headers, signal: ac.signal });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} fetching ${url}`);
    }
    const buf = await res.arrayBuffer();

    // DART는 보통 UTF-8
    const text = new TextDecoder("utf-8").decode(buf);
    return text;
  } finally {
    clearTimeout(t);
  }
}

/* -----------------------------
 *  ✅ KIND 상장사 목록 캐시
 * ----------------------------- */
let KIND_LISTED_CACHE = null; // { set, ts }
const KIND_TTL_MS = 24 * 60 * 60 * 1000; // 24시간

async function getKindListedNameSet() {
  const now = Date.now();
  if (KIND_LISTED_CACHE && now - KIND_LISTED_CACHE.ts < KIND_TTL_MS) {
    return KIND_LISTED_CACHE.set;
  }

  // KIND 상장법인 목록 다운로드 (엑셀처럼 보이지만 실제로는 HTML 테이블인 경우 많음)
  const url = "https://kind.krx.co.kr/corpgeneral/corpList.do?method=download";

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 15000);

  try {
    const res = await fetch(url, {
      headers: {
        "user-agent":
          "Mozilla/5.0 (compatible; ipo-bot/1.0; +https://netlify.app)",
        accept: "*/*",
      },
      signal: ac.signal,
    });

    if (!res.ok) throw new Error(`KIND corpList HTTP ${res.status}`);

    const buf = await res.arrayBuffer();

    // ✅ KIND 다운로드는 EUC-KR인 경우가 많음
    // Netlify Node 런타임은 보통 euc-kr 디코딩 가능(Full ICU)
    let text;
    try {
      text = new TextDecoder("euc-kr").decode(buf);
    } catch {
      // fallback
      text = new TextDecoder("utf-8").decode(buf);
    }

    const set = parseKindCorpListToNameSet(text);
    KIND_LISTED_CACHE = { set, ts: now };
    return set;
  } finally {
    clearTimeout(t);
  }
}

function parseKindCorpListToNameSet(text) {
  const set = new Set();

  // corpList download가 HTML인 경우를 가정하고 <tr> 단위로 파싱
  const rows = text.split(/<\/tr>/i);
  for (const row of rows) {
    const tds = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) =>
      stripHtml(m[1])
    );
    if (!tds || tds.length < 2) continue;

    const name = normalizeCorpName(tds[0]);
    if (!name) continue;
    if (name === "회사명" || name.includes("회사명")) continue;

    set.add(name);
  }

  return set;
}

/* -----------------------------
 *  HTML -> lines -> 일정 파싱
 * ----------------------------- */
function htmlToLines(html) {
  // script/style 제거
  let s = html
    .replace(/<script[\s\S]*?<\/script>/gi, "\n")
    .replace(/<style[\s\S]*?<\/style>/gi, "\n");

  // 줄바꿈이 될만한 태그들 처리
  s = s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(li|p|div|tr|td|th|h\d)>/gi, "\n");

  // 태그 제거
  s = stripHtml(s);

  // 공백 정리
  s = s.replace(/\r/g, "\n");
  s = s.replace(/[ \t]+/g, " ");
  s = s.replace(/\n{2,}/g, "\n");

  const lines = s
    .split("\n")
    .map((x) => x.trim())
    .filter((x) => x.length > 0);

  return lines;
}

function stripHtml(input) {
  return decodeHtmlEntities(String(input || ""))
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtmlEntities(s) {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16))
    )
    .replace(/&#([0-9]+);/g, (_, num) =>
      String.fromCharCode(parseInt(num, 10))
    );
}

function parseDsac008LinesToItems(lines, y, m) {
  // lines 흐름 중 숫자(1~31)를 현재 날짜로 보고,
  // "코/유/기" 같은 마켓 표식 다음에 "회사명 [시작/종료]" 패턴을 잡는다.
  let currentDay = null;
  let lastMarketShort = null;

  const startMap = new Map(); // corp -> { start, market_short, market }
  const endMap = new Map(); // corp -> end

  for (const token of lines) {
    // 날짜(일)
    if (/^\d{1,2}$/.test(token)) {
      const d = parseInt(token, 10);
      if (d >= 1 && d <= 31) {
        currentDay = d;
      }
      continue;
    }

    // 마켓(짧은 표기)
    if (token === "코" || token === "유" || token === "기" || token === "콘") {
      lastMarketShort = token;
      continue;
    }

    // 회사명 [시작]/[종료]
    // 예: "케이뱅크 [시작]"
    const mm = token.match(/^(.+?)\s*\[(시작|종료)\]$/);
    if (mm && currentDay) {
      const corpName = normalizeCorpName(mm[1]);
      const type = mm[2]; // 시작/종료
      const date = formatDate(y, m, currentDay);

      const market_short = lastMarketShort || "";
      const market = marketFromShort(market_short);

      if (type === "시작") {
        startMap.set(corpName, {
          sbd_start: date,
          market_short,
          market,
        });
      } else {
        endMap.set(corpName, date);
      }
    }
  }

  // 합치기
  const items = [];
  for (const [corp_name, st] of startMap.entries()) {
    const sbd_start = st.sbd_start;
    const sbd_end = endMap.get(corp_name) || sbd_start;

    items.push({
      corp_name,
      market_short: st.market_short || "",
      market: st.market || "",
      sbd_start,
      sbd_end,
    });
  }

  // 날짜순 정렬
  items.sort((a, b) => (a.sbd_start < b.sbd_start ? -1 : a.sbd_start > b.sbd_start ? 1 : 0));

  return items;
}

function marketFromShort(short) {
  if (short === "코") return "KOSDAQ";
  if (short === "유") return "KOSPI";
  if (short === "콘") return "KONEX";
  if (short === "기") return "ETC";
  return "";
}

function formatDate(y, m, d) {
  const yy = String(y);
  const mm = String(m).padStart(2, "0");
  const dd = String(d).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

function normalizeCorpName(name) {
  return String(name || "")
    .replace(/\s+/g, " ")
    .replace(/\u00A0/g, " ")
    .trim();
}
