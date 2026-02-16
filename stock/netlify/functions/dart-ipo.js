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

  const eventRe = /(유|코|넥|기)\s+(.+?)\s*\[(시작|종료)\]/g;

  for (const line of lines) {
    // day 후보: 숫자만 있는 줄(1~31)
    if (/^\d{1,2}$/.test(line)) {
      const d = parseInt(line, 10);
      if (d >= 1 && d <= 31) {
        currentDay = d;
      }
      continue;
    }

    if (!currentDay) continue;

    // 한 줄에 이벤트가 여러 개 있을 수 있음
    let m;
    while ((m = eventRe.exec(line)) !== null) {
      const marketShort = m[1];
      const corpName = m[2].trim();
      const kind = m[3]; // 시작/종료

      const key = `${marketShort}|${corpName}`;
      const it =
        itemsMap.get(key) || {
          corp_name: corpName,
          market_short: marketShort,
          market: marketName(marketShort),
          sbd_start: null,
          sbd_end: null,
        };

      const date = ymdDash(year, month, currentDay);

      if (kind === "시작") it.sbd_start = date;
      if (kind === "종료") it.sbd_end = date;

      itemsMap.set(key, it);
    }

    // 다음 줄에서 또 날짜가 나오기 전까지 currentDay 유지
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
