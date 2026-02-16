// stock/netlify/functions/dart-ipo.js
// DART 청약달력(지분증권)에서 월별 청약 일정 파싱
// - "코" / "유" / "넥" / "기" 가 한 줄로 따로 나오는 경우까지 처리
// - mode=all : 필터 없이 달력 파싱 결과 그대로
// - mode=ipo : (현재는 가볍게) ETC(기)도 포함하되, 필터 로직은 추후 추가 가능
// - debug=1 : debug_lines_first_200 포함

const https = require("node:https");

const DART_CAL_URL = "https://dart.fss.or.kr/dsac008/main.do";

function pad2(n) {
  const s = String(n);
  return s.length === 1 ? "0" + s : s;
}

function fetchCompat(url, { method = "GET", headers = {}, body = null, maxRedirects = 3 } = {}) {
  // Node 18+면 fetch가 있음
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
      // redirect 처리
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

        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, text: buf.toString("utf8") });
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

  // DART는 폼 POST가 먹히는 경우가 많음
  const body = new URLSearchParams();
  body.set("selectYear", y);
  body.set("selectMonth", m);

  const r = await fetchCompat(DART_CAL_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  // 실패하면 GET fallback
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
  let pendingMarketShort = null; // "코"가 따로 한 줄로 나오는 경우를 위해

  const itemsMap = new Map();
  const startMap = new Map(); // key -> startDate

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
        itemsMap.set(key, {
          corp_name,
          market_short: ms,
          market: marketLong(ms),
          sbd_start: date,
          sbd_end: date,
        });
      } else {
        const it = itemsMap.get(key);
        it.sbd_start = date;
      }
    } else {
      const start = startMap.get(key) || date;
      if (!itemsMap.has(key)) {
        itemsMap.set(key, {
          corp_name,
          market_short: ms,
          market: marketLong(ms),
          sbd_start: start,
          sbd_end: date,
        });
      } else {
        const it = itemsMap.get(key);
        if (!it.sbd_start) it.sbd_start = start;
        it.sbd_end = date;
      }
    }
  }

  for (const line of lines) {
    // 1) 날짜
    const dm = line.match(reDay);
    if (dm) {
      currentDay = pad2(dm[1]);
      pendingMarketShort = null;
      continue;
    }
    if (!currentDay) continue;

    // 2) "코"만 단독으로 나오는 라인
    const mm = line.match(reMarketOnly);
    if (mm) {
      pendingMarketShort = mm[1];
      continue;
    }

    const date = `${y}-${m}-${currentDay}`;

    // 3) "코 아이씨에이치 [시작]" 같이 한 줄로 나오는 라인
    const both = line.match(reBoth);
    if (both) {
      const ms = both[1];
      const name = both[2].trim();
      const act = both[3];
      upsert(ms, name, act, date);
      pendingMarketShort = null;
      continue;
    }

    // 4) "아이씨에이치 [시작]" 이고, 직전에 "코" 라인이 있었던 경우
    const na = line.match(reNameActOnly);
    if (na && pendingMarketShort) {
      const name = na[1].trim();
      const act = na[2];
      upsert(pendingMarketShort, name, act, date);
      pendingMarketShort = null;
      continue;
    }

    // 그 외는 무시
  }

  return Array.from(itemsMap.values()).sort((a, b) =>
    (a.sbd_start || "").localeCompare(b.sbd_start || "")
  );
}

exports.handler = async (event) => {
  try {
    const qs = event.queryStringParameters || {};
    const year = qs.year || "2026";
    const month = qs.month || "01";
    const mode = (qs.mode || "all").toLowerCase(); // 일단 all 기본 (확인용)
    const debug = String(qs.debug || "") === "1";

    const html = await fetchDartCalendarHtml(year, month);
    const lines = htmlToLines(html);

    // 파싱
    let items = parseCalendarItems(lines, year, month);

    // mode=ipo는 나중에 더 정교하게 필터할 수 있음.
    // 일단은 지금 "0개 문제 해결"이 목적이라, ipo도 items 그대로 반환.
    // (필요하면 여기서 유상증자/상장사 필터를 추가로 끼워 넣으면 됨.)

    const out = {
      ok: true,
      source: "dart-dsac008",
      year: String(year),
      month: pad2(month),
      mode,
      count: items.length,
      items,
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
