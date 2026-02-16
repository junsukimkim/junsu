// stock/netlify/functions/dart-ipo.js
// DART 청약달력(지분증권) 파싱 + (mode=ipo) 상장사(stock_code 존재) 제외 필터
// 필요 환경변수: OPENDART_KEY (OpenDART 인증키)
// 테스트:
//  - mode=all : DART 달력 그대로
//  - mode=ipo : 상장사 제외(유상증자/권리공모 대부분 제거)

const https = require("node:https");

const DART_CAL_URL = "https://dart.fss.or.kr/dsac008/main.do";
const OPENDART_LIST_URL = "https://opendart.fss.or.kr/api/list.json";

function pad2(n) {
  const s = String(n);
  return s.length === 1 ? "0" + s : s;
}

function lastDayOfMonth(year, month) {
  return new Date(Number(year), Number(month), 0).getDate(); // month 1~12
}

function normName(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[()（）.,·]/g, "")
    .replace(/㈜|주식회사|\(주\)/g, "")
    .trim();
}

function fetchCompat(url, { method = "GET", headers = {}, body = null, maxRedirects = 3 } = {}) {
  // Node 18+면 fetch 사용
  if (typeof fetch === "function") {
    return fetch(url, {
      method,
      headers: {
        "user-agent":
          "Mozilla/5.0 (compatible; NetlifyFunction/1.0; +https://www.netlify.com/)",
        "accept-encoding": "identity",
        ...headers,
      },
      body,
      redirect: "manual",
    }).then(async (res) => {
      if (res.status >= 300 && res.status < 400 && res.headers.get("location") && maxRedirects > 0) {
        const next = new URL(res.headers.get("location"), url).toString();
        return fetchCompat(next, { method: "GET", headers, body: null, maxRedirects: maxRedirects - 1 });
      }
      return { ok: res.ok, status: res.status, text: await res.text() };
    });
  }

  // fetch 없으면 https fallback
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      method,
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: {
        "user-agent":
          "Mozilla/5.0 (compatible; NetlifyFunction/1.0; +https://www.netlify.com/)",
        "accept-encoding": "identity",
        ...headers,
      },
    };

    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on("data", (d) => chunks.push(d));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        const loc = res.headers.location;

        if (res.statusCode >= 300 && res.statusCode < 400 && loc && maxRedirects > 0) {
          const next = new URL(loc, url).toString();
          fetchCompat(next, { method: "GET", headers, body: null, maxRedirects: maxRedirects - 1 })
            .then(resolve)
            .catch(reject);
          return;
        }

        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          text: buf.toString("utf8"),
        });
      });
    });

    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function fetchDartCalendarHtml(year, month) {
  const y = String(year);
  const m = pad2(month);

  const body = new URLSearchParams();
  body.set("selectYear", y);
  body.set("selectMonth", m);

  const r = await fetchCompat(DART_CAL_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!r.ok || !r.text) {
    const r2 = await fetchCompat(DART_CAL_URL, { method: "GET" });
    return r2.text || "";
  }
  return r.text;
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
  let pendingMarketShort = null;

  const itemsMap = new Map();
  const startMap = new Map();

  const reDay = /^(\d{1,2})$/;
  const reMarketOnly = /^(코|유|넥|기)$/;
  const reNameActOnly = /^(.+?)\s*\[(시작|종료)\]$/;
  const reBoth = /^(코|유|넥|기)\s*(.+?)\s*\[(시작|종료)\]$/;

  function marketLong(ms) {
    return ms === "유" ? "KOSPI" : ms === "코" ? "KOSDAQ" : ms === "넥" ? "KONEX" : "ETC";
  }

  function upsert(ms, corp_name, act, date) {
    const key = `${ms}|${corp_name}`;

    if (act === "시작") {
      startMap.set(key, date);
      if (!itemsMap.has(key)) {
        itemsMap.set(key, { corp_name, market_short: ms, market: marketLong(ms), sbd_start: date, sbd_end: date });
      } else {
        itemsMap.get(key).sbd_start = date;
      }
    } else {
      const start = startMap.get(key) || date;
      if (!itemsMap.has(key)) {
        itemsMap.set(key, { corp_name, market_short: ms, market: marketLong(ms), sbd_start: start, sbd_end: date });
      } else {
        const it = itemsMap.get(key);
        if (!it.sbd_start) it.sbd_start = start;
        it.sbd_end = date;
      }
    }
  }

  for (const line of lines) {
    const dm = line.match(reDay);
    if (dm) {
      currentDay = pad2(dm[1]);
      pendingMarketShort = null;
      continue;
    }
    if (!currentDay) continue;

    const mm = line.match(reMarketOnly);
    if (mm) {
      pendingMarketShort = mm[1];
      continue;
    }

    const date = `${y}-${m}-${currentDay}`;

    const both = line.match(reBoth);
    if (both) {
      upsert(both[1], both[2].trim(), both[3], date);
      pendingMarketShort = null;
      continue;
    }

    const na = line.match(reNameActOnly);
    if (na && pendingMarketShort) {
      upsert(pendingMarketShort, na[1].trim(), na[2], date);
      pendingMarketShort = null;
      continue;
    }
  }

  return Array.from(itemsMap.values()).sort((a, b) =>
    (a.sbd_start || "").localeCompare(b.sbd_start || "")
  );
}

async function fetchListedSetFromOpenDart(opendartKey, year, month, targetNormSet) {
  const bgn_de = `${year}${pad2(month)}01`;
  const end_de = `${year}${pad2(month)}${pad2(lastDayOfMonth(year, month))}`;

  const listed = new Set();

  const page_count = 100;
  let page_no = 1;
  const MAX_PAGES = 10; // 안전장치(과호출 방지)

  while (page_no <= MAX_PAGES) {
    const qs = new URLSearchParams({
      crtfc_key: opendartKey,
      bgn_de,
      end_de,
      // 발행공시(issuance) 위주로 좁힘
      pblntf_ty: "C",
      page_no: String(page_no),
      page_count: String(page_count),
    });

    const url = `${OPENDART_LIST_URL}?${qs.toString()}`;
    const r = await fetchCompat(url, { method: "GET" });
    if (!r.ok) break;

    let data;
    try { data = JSON.parse(r.text); } catch { break; }
    if (data.status !== "000") break;

    const list = Array.isArray(data.list) ? data.list : [];
    for (const row of list) {
      const corp_name = row.corp_name;
      const stock_code = row.stock_code; // 상장사면 보통 존재
      if (!corp_name) continue;
      if (!stock_code) continue;

      const nn = normName(corp_name);
      if (targetNormSet.has(nn)) listed.add(nn);
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
    const mode = (qs.mode || "ipo").toLowerCase(); // 기본은 ipo로!
    const debug = String(qs.debug || "") === "1";

    const html = await fetchDartCalendarHtml(year, month);
    const lines = htmlToLines(html);
    const allItems = parseCalendarItems(lines, year, month);

    let items = allItems;
    let filtered_out = [];
    let note = null;

    if (mode === "ipo") {
      const key = process.env.OPENDART_KEY;
      if (!key) {
        note = "OPENDART_KEY 미설정이라 '상장사 제외 필터'를 못 했어요. Netlify 환경변수에 OPENDART_KEY를 넣어주세요.";
      } else {
        const targetNormSet = new Set(allItems.map(it => normName(it.corp_name)));
        const listedSet = await fetchListedSetFromOpenDart(key, year, month, targetNormSet);

        const kept = [];
        for (const it of allItems) {
          const nn = normName(it.corp_name);
          if (listedSet.has(nn)) {
            filtered_out.push(it); // 상장사 -> 유상증자/권리공모 가능성이 높아 제외
          } else {
            kept.push(it);
          }
        }
        items = kept;
      }
    }

    const out = {
      ok: true,
      source: "dart-dsac008",
      year: String(year),
      month: pad2(month),
      mode,
      count: items.length,
      items,
      count_all: allItems.length,
      filtered_out_count: filtered_out.length,
      note,
    };

    if (debug) out.debug_lines_first_200 = lines.slice(0, 200);

    return {
      statusCode: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "access-control-allow-origin": "*",
      },
      body: JSON.stringify(out, null, 2),
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ ok: false, error: String(e?.message || e) }, null, 2),
    };
  }
};
