// /stock/netlify/functions/dart-ipo.js
// DART "청약 달력(지분증권)" 페이지(dsac008)를 긁어서
// 월별 청약 [시작]/[종료]를 items로 변환합니다.

function pad2(n) {
  return String(n).padStart(2, "0");
}

function ymdDash(y, m, d) {
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

function ymdCompact(y, m, d) {
  return `${y}${pad2(m)}${pad2(d)}`;
}

function stripTags(s) {
  return String(s).replace(/<[^>]*>/g, "");
}

function marketName(short) {
  // 페이지에 보이는 약어 기준: 유(유가), 코(코스닥), 넥(코넥스), 기(기타)
  if (short === "유") return "KOSPI";
  if (short === "코") return "KOSDAQ";
  if (short === "넥") return "KONEX";
  if (short === "기") return "ETC";
  return "UNKNOWN";
}

async function fetchCalendarHtml(year, month) {
  const url = "https://dart.fss.or.kr/dsac008/main.do";
  const y = String(year);
  const m = pad2(month);

  // 1) GET with query (될 수도 있음)
  const tryGet = async (params) => {
    const qs = new URLSearchParams(params).toString();
    const res = await fetch(`${url}?${qs}`, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    if (!res.ok) return null;
    return await res.text();
  };

  // 2) POST form (대부분 이런 방식이 먹힘)
  const tryPost = async (params) => {
    const body = new URLSearchParams(params).toString();
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "Mozilla/5.0",
      },
      body,
    });
    if (!res.ok) return null;
    return await res.text();
  };

  const candidates = [
    // 흔히 쓰는 키들부터 시도
    { selectYear: y, selectMonth: m },
    { year: y, month: m },
    { searchYear: y, searchMonth: m },
    { sYear: y, sMonth: m },
    { currentPage: "1", selectYear: y, selectMonth: m },
  ];

  // 먼저 POST로 여러 번 시도
  for (const c of candidates) {
    const html = await tryPost(c);
    if (html && html.includes("청약") && html.includes("달력")) return html;
  }

  // 안 되면 GET도 시도
  for (const c of candidates) {
    const html = await tryGet(c);
    if (html && html.includes("청약") && html.includes("달력")) return html;
  }

  // 최후: 그냥 기본 페이지
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`Failed to fetch dsac008: ${res.status}`);
  return await res.text();
}

function parseItemsFromHtml(html, year, month) {
  // 캘린더는 td 안에 "일자 + a태그(회사 [시작]/[종료])" 구조인 경우가 많음
  const tdRe = /<td\b[^>]*>([\s\S]*?)<\/td>/gi;
  const aRe = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;

  const map = new Map();

  let td;
  while ((td = tdRe.exec(html)) !== null) {
    const cell = td[1];

    // 셀 안에서 "일자"로 보이는 숫자 하나 찾기(1~31)
    const dayMatch = stripTags(cell).match(/\b([0-3]?\d)\b/);
    if (!dayMatch) continue;

    const day = parseInt(dayMatch[1], 10);
    if (!(day >= 1 && day <= 31)) continue;

    let a;
    while ((a = aRe.exec(cell)) !== null) {
      const href = a[1];
      const text = stripTags(a[2]).replace(/\s+/g, " ").trim();

      // 예: "기 케이뱅크 [시작]"
      const m = text.match(/^(유|코|넥|기)\s+(.+?)\s*\[(시작|종료)\]/);
      if (!m) continue;

      const marketShort = m[1];
      const corpName = m[2].trim();
      const status = m[3]; // 시작/종료

      const key = `${marketShort}|${corpName}`;
      const item =
        map.get(key) ||
        {
          corp_name: corpName,
          market_short: marketShort,
          market: marketName(marketShort),
          sbd_start: null,
          sbd_end: null,
          sbd_start_ymd: null,
          sbd_end_ymd: null,
          links: [],
        };

      const startDash = ymdDash(year, month, day);
      const startYmd = ymdCompact(year, month, day);

      if (status === "시작") {
        item.sbd_start = startDash;
        item.sbd_start_ymd = startYmd;
      } else if (status === "종료") {
        item.sbd_end = startDash;
        item.sbd_end_ymd = startYmd;
      }

      const rcpNoMatch = href.match(/rcpNo=(\d{14})/);
      if (rcpNoMatch) {
        const rcpNo = rcpNoMatch[1];
        const url = `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${rcpNo}`;
        // 중복 방지
        if (!item.links.some((x) => x.rcpNo === rcpNo)) {
          item.links.push({ type: "dart_viewer", rcpNo, url });
        }
      }

      map.set(key, item);
    }
  }

  // 정리: 시작/종료가 하나만 있으면 같은 날로 채움
  const items = [...map.values()].map((it) => {
    const out = { ...it };
    if (!out.sbd_start && out.sbd_end) {
      out.sbd_start = out.sbd_end;
      out.sbd_start_ymd = out.sbd_end_ymd;
    }
    if (out.sbd_start && !out.sbd_end) {
      out.sbd_end = out.sbd_start;
      out.sbd_end_ymd = out.sbd_start_ymd;
    }
    out.sbd = out.sbd_start && out.sbd_end ? `${out.sbd_start}~${out.sbd_end}` : "";
    return out;
  });

  // 정렬
  items.sort((a, b) => {
    const da = a.sbd_start_ymd || "99999999";
    const db = b.sbd_start_ymd || "99999999";
    if (da !== db) return da.localeCompare(db);
    return a.corp_name.localeCompare(b.corp_name);
  });

  return items;
}

exports.handler = async (event) => {
  try {
    const qs = event.queryStringParameters || {};
    const now = new Date();

    const year = parseInt(qs.year || now.getFullYear(), 10);
    const month = parseInt(qs.month || now.getMonth() + 1, 10);

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
    const items = parseItemsFromHtml(html, year, month);

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      },
      body: JSON.stringify({
        ok: true,
        source: "dart-dsac008",
        year: String(year),
        month: pad2(month),
        count: items.length,
        items,
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ ok: false, error: String(err?.message || err) }),
    };
  }
};
