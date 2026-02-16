// stock/netlify/functions/dart-ipo.js
// 목적: DART 청약달력(지분증권)에서 월간 청약을 가져오되,
//      KIND(거래소) 상장법인목록을 이용해 "이미 상장된 회사(유상증자 등)"를 최대한 제외.

const https = require("https");
const http = require("http");

const DART_CAL_URL = "https://dart.fss.or.kr/dsac008/main.do";
const KIND_LIST_URL = "https://kind.krx.co.kr/corpgeneral/corpList.do?method=download&searchType=13";

// ---- simple in-memory cache (works on warm lambda) ----
let LISTED_CACHE = {
  ts: 0,
  set: null,
};
const LISTED_TTL_MS = 12 * 60 * 60 * 1000; // 12h

function pad2(n) {
  const x = String(n);
  return x.length === 1 ? "0" + x : x;
}

function safeJson(statusCode, obj) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "cache-control": "no-store",
    },
    body: JSON.stringify(obj),
  };
}

function requestText(url, { method = "GET", headers = {}, body = null, timeoutMs = 12000, maxRedirects = 3 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === "https:" ? https : http;

    const req = lib.request(
      {
        method,
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        headers: {
          "user-agent":
            "Mozilla/5.0 (compatible; NetlifyFunction/1.0; +https://www.netlify.com/)",
          "accept-language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
          ...headers,
        },
      },
      (res) => {
        const status = res.statusCode || 0;

        // handle redirects
        if (
          status >= 300 &&
          status < 400 &&
          res.headers.location &&
          maxRedirects > 0
        ) {
          const next = new URL(res.headers.location, url).toString();
          res.resume();
          requestText(next, { method, headers, body, timeoutMs, maxRedirects: maxRedirects - 1 })
            .then(resolve)
            .catch(reject);
          return;
        }

        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve({ status, headers: res.headers, text: data }));
      }
    );

    req.on("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error("timeout")));

    if (body) req.write(body);
    req.end();
  });
}

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function htmlToLines(html) {
  if (!html) return [];
  let x = html;

  // remove scripts/styles
  x = x.replace(/<script[\s\S]*?<\/script>/gi, " ");
  x = x.replace(/<style[\s\S]*?<\/style>/gi, " ");

  // add newlines on common block breaks
  x = x.replace(/<br\s*\/?>/gi, "\n");
  x = x.replace(/<\/(tr|td|th|div|p|li|h1|h2|h3|h4|h5|h6)>/gi, "\n");

  // strip all tags -> newline
  x = x.replace(/<[^>]+>/g, "\n");

  // decode entities
  x = decodeEntities(x);

  // normalize
  return x
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

function cleanCorpName(name) {
  if (!name) return "";
  return String(name)
    .replace(/\s+/g, " ")
    .replace(/^\s+|\s+$/g, "")
    .replace(/\(주\)|㈜|주식회사/g, "")
    .trim();
}

function normName(name) {
  // 비교용: 공백/특수문자/중점 등 제거
  return cleanCorpName(name)
    .replace(/\s+/g, "")
    .replace(/[·•ㆍ\.\,\(\)\[\]\{\}\-_/\\'"“”‘’]/g, "")
    .toUpperCase();
}

function marketFromShort(s) {
  if (s === "유") return "KOSPI";
  if (s === "코") return "KOSDAQ";
  if (s === "넥") return "KONEX";
  return "ETC";
}

function parseDartCalendar(lines, year, month) {
  let day = null;
  let pendingMarket = null;
  const map = new Map();

  function setEvent(corpNameRaw, marketShort, kind) {
    if (!day) return;
    const corp_name = cleanCorpName(corpNameRaw);
    const key = normName(corp_name);
    if (!key) return;

    const iso = `${year}-${pad2(month)}-${pad2(day)}`;

    const cur =
      map.get(key) ||
      {
        corp_name,
        market_short: marketShort,
        market: marketFromShort(marketShort),
        sbd_start: null,
        sbd_end: null,
      };

    // keep latest clean name
    cur.corp_name = corp_name || cur.corp_name;
    cur.market_short = cur.market_short || marketShort;
    cur.market = marketFromShort(cur.market_short);

    if (kind === "시작") cur.sbd_start = iso;
    if (kind === "종료") cur.sbd_end = iso;

    map.set(key, cur);
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // day marker: 1~31 or 01~31
    if (/^\d{1,2}$/.test(line)) {
      const n = parseInt(line, 10);
      if (n >= 1 && n <= 31) day = n;
      continue;
    }

    // format A: "코 아이씨에이치 [시작]"
    let m = line.match(/^([유코넥기])\s+(.+?)\s*\[(시작|종료)\]$/);
    if (m) {
      setEvent(m[2], m[1], m[3]);
      pendingMarket = null;
      continue;
    }

    // format B: market on its own line ("코"), then "아이씨에이치 [시작]"
    if (/^[유코넥기]$/.test(line)) {
      pendingMarket = line;
      continue;
    }

    m = line.match(/^(.+?)\s*\[(시작|종료)\]$/);
    if (m && pendingMarket) {
      setEvent(m[1], pendingMarket, m[2]);
      pendingMarket = null;
      continue;
    }
  }

  // keep only complete ranges
  return Array.from(map.values()).filter((x) => x.sbd_start && x.sbd_end);
}

function parseKindListedSet(html) {
  // KIND "download" is HTML table disguised as xls
  const set = new Set();
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rm;
  while ((rm = rowRe.exec(html)) !== null) {
    const row = rm[1];
    if (!row || row.indexOf("<td") === -1) continue;

    const cells = Array.from(row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)).map((m) => {
      const raw = m[1]
        .replace(/<br\s*\/?>/gi, " ")
        .replace(/<[^>]+>/g, " ");
      return decodeEntities(raw).replace(/\s+/g, " ").trim();
    });

    if (cells.length < 2) continue;

    // detect which cell is stock code (6 digits)
    let nameCell = cells[0];
    if (/^\d{6}$/.test(cells[0]) && cells[1]) nameCell = cells[1];
    else if (/^\d{6}$/.test(cells[1]) && cells[0]) nameCell = cells[0];

    const key = normName(nameCell);
    if (key) set.add(key);
  }
  return set;
}

async function getListedSet() {
  const now = Date.now();
  if (LISTED_CACHE.set && now - LISTED_CACHE.ts < LISTED_TTL_MS) {
    return { set: LISTED_CACHE.set, stale: false };
  }

  // if we have something cached, keep it as fallback even if refresh fails
  const fallback = LISTED_CACHE.set;

  try {
    const r = await requestText(KIND_LIST_URL, { timeoutMs: 9000 });
    if (r.status !== 200 || !r.text) throw new Error(`KIND HTTP ${r.status}`);
    const set = parseKindListedSet(r.text);
    LISTED_CACHE = { ts: now, set };
    return { set, stale: false };
  } catch (e) {
    if (fallback) return { set: fallback, stale: true };
    return { set: null, stale: true };
  }
}

exports.handler = async (event) => {
  try {
    const qs = event.queryStringParameters || {};
    const now = new Date();

    const year = String(qs.year || now.getFullYear());
    const monthRaw = qs.month || String(now.getMonth() + 1);
    const month = parseInt(monthRaw, 10);

    if (!/^\d{4}$/.test(year) || !(month >= 1 && month <= 12)) {
      return safeJson(200, { ok: false, error: "Bad year/month" });
    }

    // ---- fetch DART calendar ----
    // DART 페이지가 폼 제출 구조라서 POST로도 보내고, 혹시 무시되면 기본 페이지라도 파싱되게 함.
    const body = new URLSearchParams({
      selectYear: year,
      selectMonth: pad2(month),
    }).toString();

    const dartRes = await requestText(DART_CAL_URL, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
      },
      body,
      timeoutMs: 12000,
    });

    if (dartRes.status !== 200 || !dartRes.text) {
      return safeJson(200, { ok: false, error: `DART HTTP ${dartRes.status}` });
    }

    const lines = htmlToLines(dartRes.text);
    const rawItems = parseDartCalendar(lines, year, month);

    // ---- listed-company filter via KIND ----
    const listedInfo = await getListedSet();
    const listedSet = listedInfo.set;

    let items = rawItems;
    let excluded_listed = 0;

    if (listedSet) {
      const before = items.length;
      items = items.filter((it) => !listedSet.has(normName(it.corp_name)));
      excluded_listed = before - items.length;
    }

    return safeJson(200, {
      ok: true,
      source: "dart-dsac008 + kind-listed-filter",
      year,
      month: pad2(month),
      count: items.length,
      excluded_listed,
      listed_filter_stale: listedInfo.stale, // true면 KIND 목록 갱신 실패(캐시 사용 or 미적용)
      items,
    });
  } catch (e) {
    // 절대 throw로 죽지 않게: 502 방지
    return safeJson(200, {
      ok: false,
      error: String(e && e.message ? e.message : e),
    });
  }
};
