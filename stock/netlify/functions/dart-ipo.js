// stock/netlify/functions/dart-ipo.js
// DART 청약달력(지분증권) 파싱 + 공모주(상장 전) 위주 필터
//
// mode=all : 달력 그대로
// mode=ipo : 상장사(stock_code 존재) 제거 + ETC(기) 잡음 일부 제거
//
// Timeout 방지:
// - OpenDART CORPCODE.xml 전체를 Set으로 만들지 않음(너무 느림)
// - "이번 달에 나온 회사들"만 CORPCODE.xml에서 찾아서 상장사 여부 판단(빠름)
// - CORPCODE.xml은 메모리 캐시(재사용)

const https = require("node:https");
const { inflateRawSync } = require("node:zlib");

const DART_CAL_URL = "https://dart.fss.or.kr/dsac008/main.do";
const OPENDART_CORPCODE_ZIP_URL = (key) =>
  `https://opendart.fss.or.kr/api/corpCode.xml?crtfc_key=${encodeURIComponent(key)}`;

// ---------- util ----------
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

// ---------- fetch fallback ----------
function fetchTextCompat(url, { method = "GET", headers = {}, body = null, maxRedirects = 2 } = {}) {
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

function fetchBufferCompat(url, { method = "GET", headers = {}, body = null, maxRedirects = 2 } = {}) {
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

// ---------- CORPCODE.xml 캐시 ----------
let corpXmlCache = null;
let corpXmlLoadedAt = 0;

async function getCorpXml(opendartKey) {
  const TTL = 7 * 24 * 60 * 60 * 1000; // 7일(웜 인스턴스 기준)
  if (corpXmlCache && (Date.now() - corpXmlLoadedAt) < TTL) return corpXmlCache;

  const r = await fetchBufferCompat(OPENDART_CORPCODE_ZIP_URL(opendartKey));
  if (!r.ok) throw new Error(`OpenDART corpCode download failed: HTTP ${r.status}`);

  const xml = extractFileFromZip(r.buf, "CORPCODE.xml");
  corpXmlCache = xml;
  corpXmlLoadedAt = Date.now();
  return xml;
}

// "이번 달 회사들"만 상장사인지 찾기 (빠르게 끝내기)
async function findListedTargets(opendartKey, targetNormSet, timeBudgetMs = 12000) {
  const started = Date.now();
  const xml = await getCorpXml(opendartKey);

  const remaining = new Set(targetNormSet);
  const listedFound = new Set();

  // CORPCODE.xml은 corp_name 다음에 stock_code가 거의 붙어 있어서, 이 정규식이 제일 빠름
  const re = /<corp_name>([^<]*)<\/corp_name>\s*<stock_code>([^<]*)<\/stock_code>/g;

  let m;
  while ((m = re.exec(xml)) !== null) {
    if (Date.now() - started > timeBudgetMs) break; // 시간 예산 초과 시 중단(크래시 방지)

    const corp_name = (m[1] || "").trim();
    const stock_code = (m[2] || "").trim();

    if (!stock_code || stock_code.length !== 6) continue;

    const nn = normName(corp_name);
    if (remaining.has(nn)) {
      listedFound.add(nn);
      remaining.delete(nn);
      if (remaining.size === 0) break; // 다 찾으면 즉시 종료
    }
  }

  return { listedFound, partial: remaining.size > 0 };
}

// ---------- DART 달력 ----------
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
          end_seen: false,
        });
      } else {
        itemsMap.get(key).sbd_start = date;
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
    const mode = (qs.mode || "ipo").toLowerCase();
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
        const targetNormSet = new Set(allItems.map((it) => normName(it.corp_name)));
        const { listedFound, partial } = await findListedTargets(key, targetNormSet, 12000);

        if (partial) {
          note = "상장사 필터가 시간 예산 때문에 일부만 적용됐어요(그래도 크래시는 안 나게 함). 새로고침 후 다시 시도하면 더 잘 걸러집니다.";
        }

        // 1) 상장사 제거 (대한광통신 같은 애들 여기서 빠짐)
        items = items.filter((it) => {
          const nn = normName(it.corp_name);
          if (listedFound.has(nn)) {
            filtered_listed++;
            return false;
          }
          return true;
        });

        // 2) ETC(기) 잡음 제거: 종료가 없거나 / 하루짜리(시작=종료) 제거
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
