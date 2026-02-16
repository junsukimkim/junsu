// stock/netlify/functions/dart-ipo.js
// DART 청약달력(지분증권) -> 월간 일정 파싱
// KIND 상장법인목록(다운로드) -> 상장사(=유상증자 등) 최대한 제거
//
// 핵심 수정: KIND 파일은 EUC-KR/CP949 인코딩이라 "buffer로 받고" TextDecoder('euc-kr')로 디코딩해야 매칭됨.

const https = require("https");
const http = require("http");
const { TextDecoder } = require("util");

const DART_CAL_URL = "https://dart.fss.or.kr/dsac008/main.do";
// searchType 없이 전체 다운로드 시도 (KOSPI/KOSDAQ/KONEX 포함 가능성이 높음)
const KIND_LIST_URL = "https://kind.krx.co.kr/corpgeneral/corpList.do?method=download";

let LISTED_CACHE = { ts: 0, set: null };
const LISTED_TTL_MS = 12 * 60 * 60 * 1000; // 12h

function pad2(n) {
  const s = String(n);
  return s.length === 1 ? "0" + s : s;
}

function safeJson(obj, statusCode = 200) {
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

function requestBuffer(url, { method = "GET", headers = {}, body = null, timeoutMs = 12000, maxRedirects = 3 } = {}) {
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

        // redirects
        if (status >= 300 && status < 400 && res.headers.location && maxRedirects > 0) {
          const next = new URL(res.headers.location, url).toString();
          res.resume();
          requestBuffer(next, { method, headers, body, timeoutMs, maxRedirects: maxRedirects - 1 })
            .then(resolve)
            .catch(reject);
          return;
        }

        const chunks = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () => resolve({ status, headers: res.headers, buf: Buffer.concat(chunks) }));
      }
    );

    req.on("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error("timeout")));
    if (body) req.write(body);
    req.end();
  });
}

function requestTextUtf8(url, opts) {
  return requestBuffer(url, opts).then((r) => ({
    status: r.status,
    headers: r.headers,
    text: r.buf.toString("utf8"),
  }));
}

function decodeKIND(buf) {
  // KIND 다운로드는 보통 euc-kr/cp949 계열
  try {
    return new TextDecoder("euc-kr").decode(buf);
  } catch {
    // 혹시 런타임에서 euc-kr 미지원이면 일단 utf8로라도
    return buf.toString("utf8");
  }
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

  x = x.replace(/<script[\s\S]*?<\/script>/gi, " ");
  x = x.replace(/<style[\s\S]*?<\/style>/gi, " ");
  x = x.replace(/<br\s*\/?>/gi, "\n");
  x = x.replace(/<\/(tr|td|th|div|p|li|h1|h2|h3|h4|h5|h6)>/gi, "\n");
  x = x.replace(/<[^>]+>/g, "\n");
  x = decodeEntities(x);

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
      map.get(key) || {
        corp_name,
        market_short: marketShort,
        market: marketFromShort(marketShort),
        sbd_start: null,
        sbd_end: null,
      };

    cur.corp_name = corp_name || cur.corp_name;
    cur.market_short = cur.market_short || marketShort;
    cur.market = marketFromShort(cur.market_short);

    if (kind === "시작") cur.sbd_start = iso;
    if (kind === "종료") cur.sbd_end = iso;

    map.set(key, cur);
  }

  for (const line of lines) {
    if (/^\d{1,2}$/.test(line)) {
      const n = parseInt(line, 10);
      if (n >= 1 && n <= 31) day = n;
      continue;
    }

    let m = line.match(/^([유코넥기])\s+(.+?)\s*\[(시작|종료)\]$/);
    if (m) {
      setEvent(m[2], m[1], m[3]);
      pendingMarket = null;
      continue;
    }

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

  return Array.from(map.values()).filter((x) => x.sbd_start && x.sbd_end);
}

function parseKindListedSet(html) {
  // KIND 다운로드는 "엑셀처럼 보이는 HTML 테이블" 형태가 흔함
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

    // 보통 "회사명 / 종목코드 / 업종 ..." 순서인데 케이스별로 섞일 수 있어 방어적으로 처리
    let name = cells[0];
    if (/^\d{6}$/.test(cells[0]) && cells[1]) name = cells[1];
    else if (/^\d{6}$/.test(cells[1]) && cells[0]) name = cells[0];

    const key = normName(name);
    if (key) set.add(key);
  }

  return set;
}

async function getListedSet() {
  const now = Date.now();
  if (LISTED_CACHE.set && now - LISTED_CACHE.ts < LISTED_TTL_MS) {
    return { set: LISTED_CACHE.set, stale: false, size: LISTED_CACHE.set.size };
  }

  const fallback = LISTED_CACHE.set;

  try {
    const r = await requestBuffer(KIND_LIST_URL, { timeoutMs: 10000 });
    if (r.status !== 200 || !r.buf || r.buf.length < 1000) throw new Error(`KIND HTTP ${r.status}`);

    const html = decodeKIND(r.buf);

    const set = parseKindListedSet(html);

    // sanity check: 너무 작으면 파싱 실패로 간주
    if (set.size < 500) throw new Error(`KIND parse too small: ${set.size}`);

    LISTED_CACHE = { ts: now, set };
    return { set, stale: false, size: set.size };
  } catch (e) {
    if (fallback) return { set: fallback, stale: true, size: fallback.size, err: String(e.message || e) };
    return { set: null, stale: true, size: 0, err: String(e.message || e) };
  }
}

exports.handler = async (event) => {
  try {
    const qs = event.queryStringParameters || {};
    const year = String(qs.year || new Date().getFullYear());
    const month = parseInt(String(qs.month || new Date().getMonth() + 1), 10);
    const debug = String(qs.debug || "") === "1";

    if (!/^\d{4}$/.test(year) || !(month >= 1 && month <= 12)) {
      return safeJson({ ok: false, error: "Bad year/month" });
    }

    // DART: POST로 월 선택
    const body = new URLSearchParams({
      selectYear: year,
      selectMonth: pad2(month),
    }).toString();

    const dartRes = await requestTextUtf8(DART_CAL_URL, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
      },
      body,
      timeoutMs: 12000,
    });

    if (dartRes.status !== 200 || !dartRes.text) {
      return safeJson({ ok: false, error: `DART HTTP ${dartRes.status}` });
    }

    const lines = htmlToLines(dartRes.text);
    const rawItems = parseDartCalendar(lines, year, month);

    const listedInfo = await getListedSet();
    const listedSet = listedInfo.set;

    let excluded_listed = 0;
    let items = rawItems;

    let matched_listed = [];
    if (listedSet) {
      const before = items.length;
      matched_listed = items
        .map((it) => it.corp_name)
        .filter((nm) => listedSet.has(normName(nm)));

      items = items.filter((it) => !listedSet.has(normName(it.corp_name)));
      excluded_listed = before - items.length;
    }

    const out = {
      ok: true,
      source: "dart-dsac008 + kind-listed-filter(euc-kr)",
      year,
      month: pad2(month),
      count: items.length,
      excluded_listed,
      listed_filter_stale: listedInfo.stale,
      listed_set_size: listedInfo.size,
      items,
    };

    if (debug) {
      out.debug = {
        listed_err: listedInfo.err || null,
        matched_listed_first_50: matched_listed.slice(0, 50),
        raw_count: rawItems.length,
      };
    }

    return safeJson(out);
  } catch (e) {
    return safeJson({ ok: false, error: String(e && e.message ? e.message : e) });
  }
};
