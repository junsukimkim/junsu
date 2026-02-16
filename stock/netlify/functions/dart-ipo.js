// stock/netlify/functions/dart-ipo.js
// DART 청약달력(지분증권) 파싱 + "공모주(비상장/상장 전) 위주" 필터
//
// 필터( mode=ipo 기본 ):
// 1) OpenDART corpCode.xml(Zip)에서 stock_code 있는 회사(=상장사) 제거
// 2) market_short === '기'(ETC) 중
//    - 종료(end)가 없거나(end_seen=false)
//    - 시작=종료(하루짜리)
//    -> 제거 (잡다한 유상/기타 청약 많이 줄어듦)
//
// 필요: Netlify 환경변수 OPENDART_KEY (OpenDART 인증키)
// OpenDART corpCode.xml: ZIP(biary) + stock_code 필드 설명은 공식 문서 참고 :contentReference[oaicite:1]{index=1}

const https = require("node:https");
const { inflateRawSync } = require("node:zlib");

const DART_CAL_URL = "https://dart.fss.or.kr/dsac008/main.do";
const OPENDART_CORPCODE_ZIP_URL = (key) =>
  `https://opendart.fss.or.kr/api/corpCode.xml?crtfc_key=${encodeURIComponent(key)}`;

function pad2(n) {
  const s = String(n);
  return s.length === 1 ? "0" + s : s;
}

function normName(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[()（）.,·]/g, "")
    .replace(/㈜|주식회사|\(주\)/g, "")
    .trim();
}

// ---------- fetch (Node fetch 있으면 사용, 없으면 https fallback) ----------
function fetchTextCompat(url, { method = "GET", headers = {}, body = null, maxRedirects = 3 } = {}) {
  if (typeof fetch === "function") {
    return fetch(url, {
      method,
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; NetlifyFunction/1.0)",
        "accept-encoding": "identity",
        ...headers,
      },
      body,
      redirect: "manual",
    }).then(async (res) => {
      if (res.status >= 300 && res.status < 400 && res.headers.get("location") && maxRedirects > 0) {
        const next = new URL(res.headers.get("location"), url).toString();
        return fetchTextCompat(next, { method: "GET", headers, body: null, maxRedirects: maxRedirects - 1 });
      }
      return { ok: res.ok, status: res.status, text: await res.text() };
    });
  }

  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      method,
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; NetlifyFunction/1.0)",
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
          fetchTextCompat(next, { method: "GET", headers, body: null, maxRedirects: maxRedirects - 1 })
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

function fetchBufferCompat(url, { method = "GET", headers = {}, body = null, maxRedirects = 3 } = {}) {
  if (typeof fetch === "function") {
    return fetch(url, {
      method,
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; NetlifyFunction/1.0)",
        "accept-encoding": "identity",
        ...headers,
      },
      body,
      redirect: "manual",
    }).then(async (res) => {
      if (res.status >= 300 && res.status < 400 && res.headers.get("location") && maxRedirects > 0) {
        const next = new URL(res.headers.get("location"), url).toString();
        return fetchBufferCompat(next, { method: "GET", headers, body: null, maxRedirects: maxRedirects - 1 });
      }
      const ab = await res.arrayBuffer();
      return { ok: res.ok, status: res.status, buf: Buffer.from(ab) };
    });
  }

  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      method,
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; NetlifyFunction/1.0)",
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
          fetchBufferCompat(next, { method: "GET", headers, body: null, maxRedirects: maxRedirects - 1 })
            .then(resolve)
            .catch(reject);
          return;
        }

        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          buf,
        });
      });
    });

    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

// ---------- ZIP에서 CORPCODE.xml 추출 ----------
function extractFileFromZip(zipBuf, wantedName) {
  const MAX_EOCD_SEARCH = 0x10000 + 22;
  const start = Math.max(0, zipBuf.length - MAX_EOCD_SEARCH);

  let eocd = -1;
  for (let i = zipBuf.length - 22; i >= start; i--) {
    if (zipBuf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("ZIP EOCD not found");

  const cdSize = zipBuf.readUInt32LE(eocd + 12);
  const cdOffset = zipBuf.readUInt32LE(eocd + 16);

  let ptr = cdOffset;
  const cdEnd = cdOffset + cdSize;

  while (ptr < cdEnd) {
    if (zipBuf.readUInt32LE(ptr) !== 0x02014b50) break;

    const compMethod = zipBuf.readUInt16LE(ptr + 10);
    const compSize = zipBuf.readUInt32LE(ptr + 20);
    const fileNameLen = zipBuf.readUInt16LE(ptr + 28);
    const extraLen = zipBuf.readUInt16LE(ptr + 30);
    const commentLen = zipBuf.readUInt16LE(ptr + 32);
    const localHeaderOffset = zipBuf.readUInt32LE(ptr + 42);

    const fileName = zipBuf.slice(ptr + 46, ptr + 46 + fileNameLen).toString("utf8");
    ptr = ptr + 46 + fileNameLen + extraLen + commentLen;

    if (fileName !== wantedName) continue;

    if (zipBuf.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
      throw new Error("ZIP local header not found");
    }
    const lfFileNameLen = zipBuf.readUInt16LE(localHeaderOffset + 26);
    const lfExtraLen = zipBuf.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + lfFileNameLen + lfExtraLen;

    const compData = zipBuf.slice(dataStart, dataStart + compSize);

    if (compMethod === 0) return compData.toString("utf8"); // stored
    if (compMethod === 8) return inflateRawSync(compData).toString("utf8"); // deflate
    throw new Error(`Unsupported ZIP compression method: ${compMethod}`);
  }

  throw new Error(`File not found in ZIP: ${wantedName}`);
}

// ---------- OpenDART 상장사 이름 Set 캐시 ----------
let listedNameSetCache = null;
let listedNameSetLoadedAt = 0;

async function loadListedNameSet(opendartKey) {
  const TTL = 7 * 24 * 60 * 60 * 1000; // 7일
  if (listedNameSetCache && (Date.now() - listedNameSetLoadedAt) < TTL) {
    return listedNameSetCache;
  }

  const r = await fetchBufferCompat(OPENDART_CORPCODE_ZIP_URL(opendartKey));
  if (!r.ok) throw new Error(`OpenDART corpCode download failed: HTTP ${r.status}`);

  const xml = extractFileFromZip(r.buf, "CORPCODE.xml");

  // corp_name + stock_code만 뽑아서 "stock_code 있는 회사"를 상장사로 간주
  // (공식 문서에 stock_code: 상장회사인 경우 종목코드(6자리) 명시) :contentReference[oaicite:2]{index=2}
  const set = new Set();
  const re = /<list>[\s\S]*?<corp_name>([^<]*)<\/corp_name>[\s\S]*?<stock_code>([^<]*)<\/stock_code>[\s\S]*?<\/list>/g;

  let m;
  while ((m = re.exec(xml)) !== null) {
    const corp_name = (m[1] || "").trim();
    const stock_code = (m[2] || "").trim();
    if (!corp_name) continue;
    if (!stock_code) continue;
    if (stock_code.length !== 6) continue;

    set.add(normName(corp_name));
  }

  listedNameSetCache = set;
  listedNameSetLoadedAt = Date.now();
  return set;
}

// ---------- DART 달력 HTML ----------
async function fetchDartCalendarHtml(year, month) {
  const y = String(year);
  const m = pad2(month);

  const body = new URLSearchParams();
  body.set("selectYear", y);
  body.set("selectMonth", m);

  const r = await fetchTextCompat(DART_CAL_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!r.ok || !r.text) {
    const r2 = await fetchTextCompat(DART_CAL_URL, { method: "GET" });
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

// ---------- 달력 파싱 (코/유/넥/기 단독 라인 + 회사명[시작/종료] 라인 지원) ----------
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
        itemsMap.set(key, {
          corp_name,
          market_short: ms,
          market: marketLong(ms),
          sbd_start: date,
          sbd_end: date,
          end_seen: false, // 종료를 실제로 봤는지
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
          end_seen: true,
        });
      } else {
        const it = itemsMap.get(key);
        if (!it.sbd_start) it.sbd_start = start;
        it.sbd_end = date;
        it.end_seen = true;
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

// ---------- handler ----------
exports.handler = async (event) => {
  try {
    const qs = event.queryStringParameters || {};
    const year = qs.year || "2026";
    const month = qs.month || "01";
    const mode = (qs.mode || "ipo").toLowerCase(); // 앱은 그대로 mode=ipo 호출하면 됨
    const debug = String(qs.debug || "") === "1";

    const html = await fetchDartCalendarHtml(year, month);
    const lines = htmlToLines(html);
    const allItems = parseCalendarItems(lines, year, month);

    let items = allItems;
    let filtered_listed = 0;
    let filtered_etc_noise = 0;
    let note = null;

    if (mode === "ipo") {
      const key = process.env.OPENDART_KEY;
      if (!key) {
        note = "OPENDART_KEY 미설정이라 상장사(유상증자 등) 필터를 못 했어요.";
      } else {
        const listedSet = await loadListedNameSet(key);

        // 1) 상장사 제거
        const tmp = [];
        for (const it of items) {
          const nn = normName(it.corp_name);
          if (listedSet.has(nn)) {
            filtered_listed++;
            continue;
          }
          tmp.push(it);
        }
        items = tmp;

        // 2) ETC(기) 잡음 제거: 종료 없거나(시작만) / 하루짜리 제거
        items = items.filter((it) => {
          if (it.market_short !== "기") return true;
          if (!it.end_seen) { filtered_etc_noise++; return false; }
          if (it.sbd_start === it.sbd_end) { filtered_etc_noise++; return false; }
          return true;
        });
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
      filtered_listed,
      filtered_etc_noise,
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
