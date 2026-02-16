// stock/netlify/functions/dart-ipo.js
// DART 청약달력(지분증권) dsac008에서 "코 XXX [시작/종료]"를 텍스트로 스캔해서 월별 일정 추출

function pad2(n) {
  return String(n).padStart(2, "0");
}
function ymdDash(y, m, d) {
  return `${y}-${pad2(m)}-${pad2(d)}`;
}
function marketName(short) {
  if (short === "유") return "KOSPI";
  if (short === "코") return "KOSDAQ";
  if (short === "넥") return "KONEX";
  if (short === "기") return "ETC";
  return "UNKNOWN";
}

async function fetchCalendarHtml(year, month) {
  const url = "https://dart.fss.or.kr/dsac008/main.do";

  // dsac008은 년/월 선택 후 "검색"과 동일한 POST가 가장 안정적
  const body = new URLSearchParams({
    selectYear: String(year),
    selectMonth: String(month), // "2" 처럼 숫자도 OK
  }).toString();

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "Mozilla/5.0",
    },
    body,
  });

  if (!res.ok) throw new Error(`Failed to fetch dsac008: ${res.status}`);
  return await res.text();
}

function htmlToLines(html) {
  // script/style 제거 후 태그를 줄바꿈으로 치환 -> 텍스트 라인 만들기
  let t = html
    .replace(/<script[\s\S]*?<\/script>/gi, "\n")
    .replace(/<style[\s\S]*?<\/style>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(td|th|tr|li|div|p|h\d|span)>/gi, "\n")
    .replace(/<[^>]+>/g, "\n")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\r/g, "");

  // 줄 정리
  return t
    .split("\n")
    .map((s) =>
      s
        .replace(/^[\*\-•\u2022]\s*/g, "") // 앞의 불릿 제거
        .replace(/\s+/g, " ")
        .trim()
    )
    .filter(Boolean);
}

function parseByTextScan(html, year, month) {
  const lines = htmlToLines(html);

  const itemsMap = new Map();
  let currentDay = null;
  let currentMarket = null;

  const marketSet = new Set(["유", "코", "넥", "기"]);
  const dayRe = /^\d{1,2}$/; // "2", "02" 둘 다 허용
  const corpRe = /^(.+?)\s*\[(시작|종료)\]$/; // "케이뱅크 [시작]" 형태

  for (const line of lines) {
    // 1) 날짜 라인
    if (dayRe.test(line)) {
      const d = parseInt(line, 10);
      if (d >= 1 && d <= 31) {
        currentDay = d;
      }
      continue;
    }

    // 2) 시장 라인(유/코/넥/기) - 한 글자만 있는 줄로 내려옴
    if (marketSet.has(line)) {
      currentMarket = line;
      continue;
    }

    // 3) 회사명 [시작/종료] 라인
    if (!currentDay || !currentMarket) continue;

    const m = line.match(corpRe);
    if (!m) continue;

    const corpName = m[1].trim();
    const kind = m[2]; // 시작/종료

    const key = `${currentMarket}|${corpName}`;
    const it =
      itemsMap.get(key) || {
        corp_name: corpName,
        market_short: currentMarket,
        market: marketName(currentMarket),
        sbd_start: null,
        sbd_end: null,
      };

    const date = ymdDash(year, month, currentDay);
    if (kind === "시작") it.sbd_start = date;
    if (kind === "종료") it.sbd_end = date;

    itemsMap.set(key, it);
  }

  // 시작/종료 한쪽만 있으면 같은 날로 채우기
  const items = [...itemsMap.values()].map((it) => {
    if (!it.sbd_start && it.sbd_end) it.sbd_start = it.sbd_end;
    if (it.sbd_start && !it.sbd_end) it.sbd_end = it.sbd_start;
    return it;
  });

  // 정렬
  items.sort((a, b) => {
    const da = a.sbd_start || "9999-99-99";
    const db = b.sbd_start || "9999-99-99";
    if (da !== db) return da.localeCompare(db);
    return a.corp_name.localeCompare(b.corp_name);
  });

  return { items, debugLines: lines.slice(0, 200) };
}


exports.handler = async (event) => {
  try {
    const qs = event.queryStringParameters || {};
    const now = new Date();

    const year = parseInt(qs.year || now.getFullYear(), 10);
    const month = parseInt(qs.month || now.getMonth() + 1, 10);
    const debug = qs.debug === "1";

    if (!(year >= 2016 && year <= 2100)) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ ok: false, error: "year 범위가 이상함" }),
      };
    }
    if (!(month >= 1 && month <= 12)) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ ok: false, error: "month 범위가 이상함" }),
      };
    }

    const html = await fetchCalendarHtml(year, month);
    const { items, debugLines } = parseByTextScan(html, year, month);

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      },
      body: JSON.stringify(
        {
          ok: true,
          source: "dart-dsac008",
          year: String(year),
          month: pad2(month),
          count: items.length,
          items,
          ...(debug ? { debug_lines_first_200: debugLines } : {}),
        },
        null,
        2
      ),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ ok: false, error: String(err?.message || err) }),
    };
  }
};

