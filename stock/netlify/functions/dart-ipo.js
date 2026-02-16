// netlify/functions/dart-ipo.js
// DART 청약달력(지분증권) + (옵션) OpenDART list.json으로 '상장사(stock_code 존재)' 제거

const DART_CAL_URL = "https://dart.fss.or.kr/dsac008/main.do";
const OPENDART_LIST_URL = "https://opendart.fss.or.kr/api/list.json";

function pad2(n) {
  const s = String(n);
  return s.length === 1 ? "0" + s : s;
}

function lastDayOfMonth(year, month) {
  return new Date(Number(year), Number(month), 0).getDate(); // month는 1~12
}

function normName(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[()（）.,·]/g, "")
    .replace(/㈜|주식회사|\(주\)/g, "")
    .trim();
}

async function fetchText(url, options = {}) {
  const res = await fetch(url, {
    redirect: "follow",
    ...options,
    headers: {
      "user-agent":
        "Mozilla/5.0 (compatible; NetlifyFunction/1.0; +https://www.netlify.com/)",
      ...(options.headers || {}),
    },
  });
  return { ok: res.ok, status: res.status, text: await res.text() };
}

function htmlToLines(html) {
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, "\n")
    .replace(/<style[\s\S]*?<\/style>/gi, "\n")
    .replace(/<[^>]+>/g, "\n");

  return cleaned
    .split("\n")
    .map((s) => s.replace(/\u00a0/g, " ").trim())
    .filter(Boolean);
}

function parseCalendarItems(lines, year, month) {
  const y = String(year);
  const m = pad2(month);

  let currentDay = null;
  const startMap = new Map();
  const itemsMap = new Map();

  const reDay = /^(\d{1,2})$/;
  const reEvt = /^(코|유|넥|기)\s*(.+?)\s*\[(시작|종료)\]$/;

  for (const line of lines) {
    const dm = line.match(reDay);
    if (dm) {
      currentDay = pad2(dm[1]);
      continue;
    }

    const em = line.match(reEvt);
    if (!em || !currentDay) continue;

    const market_short = em[1];
    const corp_name = em[2].trim();
    const act = em[3];

    const date = `${y}-${m}-${currentDay}`;
    const key = `${market_short}|${corp_name}`;

    const market =
      market_short === "유"
        ? "KOSPI"
        : market_short === "코"
        ? "KOSDAQ"
        : market_short === "넥"
        ? "KONEX"
        : "ETC";

    if (act === "시작") {
      startMap.set(key, date);
      if (!itemsMap.has(key)) {
        itemsMap.set(key, { corp_name, market_short, market, sbd_start: date, sbd_end: date });
      } else {
        itemsMap.get(key).sbd_start = date;
      }
    } else {
      const start = startMap.get(key) || date;
      if (!itemsMap.has(key)) {
        itemsMap.set(key, { corp_name, market_short, market, sbd_start: start, sbd_end: date });
      } else {
        const it = itemsMap.get(key);
        if (!it.sbd_start) it.sbd_start = start;
        it.sbd_end = date;
      }
    }
  }

  return Array.from(itemsMap.values()).sort((a, b) =>
    (a.sbd_start || "").localeCompare(b.sbd_start || "")
  );
}

async function fetchDartCalendarHtml(year, month) {
  const y = String(year);
  const m = pad2(month);

  // DART는 폼 제출일 수 있어 POST 우선
  const body = new URLSearchParams();
  body.set("selectYear", y);
  body.set("selectMonth", m);

  const r = await fetchText(DART_CAL_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });

  if (r.ok && r.text) return r.text;

  // fallback
  const r2 = await fetchText(DART_CAL_URL);
  return r2.text;
}

async function fetchOpenDartListedSet(opendartKey, year, month, targetNamesNormSet) {
  // list.json은 corp_code 없이도 기간조회 가능하지만 3개월 제한이 있어요(월단위면 OK). :contentReference[oaicite:3]{index=3}
  const bgn_de = `${year}${pad2(month)}01`;
  const end_de = `${year}${pad2(month)}${pad2(lastDayOfMonth(year, month))}`;

  const listed = new Set();

  // 발행공시 위주로 줄이기: pblntf_ty=C (issuance). :contentReference[oaicite:4]{index=4}
  const page_count = 100;
  let page_no = 1;
  let safetyPages = 0;

  while (true) {
    safetyPages++;
    if (safetyPages > 50) break; // 과도한 호출 방지

    const qs = new URLSearchParams({
      crtfc_key: opendartKey,
      bgn_de,
      end_de,
      pblntf_ty: "C",
      page_no: String(page_no),
      page_count: String(page_count),
    });

    const url = `${OPENDART_LIST_URL}?${qs.toString()}`;
    const r = await fetchText(url);
    if (!r.ok) break;

    let data;
    try { data = JSON.parse(r.text); } catch { break; }

    if (data.status !== "000") break;

    const list = Array.isArray(data.list) ? data.list : [];
    for (const row of list) {
      const corp_name = row.corp_name;
      const stock_code = row.stock_code; // 상장사면 들어옴 :contentReference[oaicite:5]{index=5}
      if (!corp_name) continue;
      if (!stock_code) continue; // stock_code 없으면 비상장/기타법인 가능성

      const nn = normName(corp_name);
      if (targetNamesNormSet.has(nn)) listed.add(nn);
    }

    const total_page = Number(data.total_page || 0);
    if (!total_page || page_no >= total_page) break;
    page_no++;
  }

  return listed;
}

exports.handler = async (event) => {
  try {
    const qs = event.queryStringParameters || {};
    const year = qs.year || "2026";
    const month = qs.month || "01";
    const mode = (qs.mode || "ipo").toLowerCase(); // ipo(기본) / all

    const html = await fetchDartCalendarHtml(year, month);
    const lines = htmlToLines(html);
    let items = parseCalendarItems(lines, year, month);

    // 기본: all이면 그대로 반환
    let filtered_out = [];
    let note = null;

    if (mode !== "all") {
      const key = process.env.OPENDART_KEY;
      if (!key) {
        note = "OPENDART_KEY 미설정: 유상증자(상장사) 필터를 적용하지 못해 전체가 표시될 수 있어요.";
      } else {
        const targets = new Set(items.map(it => normName(it.corp_name)));
        const listedSet = await fetchOpenDartListedSet(key, year, month, targets);

        const kept = [];
        for (const it of items) {
          const nn = normName(it.corp_name);
          if (listedSet.has(nn)) {
            filtered_out.push(it);
            continue;
          }
          kept.push(it);
        }
        items = kept;
      }
    }

    return {
      statusCode: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "access-control-allow-origin": "*",
      },
      body: JSON.stringify(
        {
          ok: true,
          source: "dart-dsac008",
          year: String(year),
          month: pad2(month),
          mode,
          count: items.length,
          items,
          filtered_out_count: filtered_out.length,
          filtered_out_preview: filtered_out.slice(0, 20),
          note,
        },
        null,
        2
      ),
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ ok: false, error: String(e?.message || e) }, null, 2),
    };
  }
};
