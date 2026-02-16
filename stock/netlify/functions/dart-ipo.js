// stock/netlify/functions/dart-ipo.js
// Netlify Function: /.netlify/functions/dart-ipo?mode=next2months
//
// 핵심:
// 1) DART 청약달력(dsac008)은 월 선택이 GET로 잘 안 먹는 경우가 있어 POST로 시도
// 2) 이번달+다음달을 합쳐서 "오늘~다음달 말"만 반환
// 3) 상장사(유증/추가발행 등) 섞이는 문제는 KIND 상장사 목록으로 필터링
// 4) 증권사/균등최소금액은 '보조 데이터'라 비어있을 수 있음 (안 깨지게 best-effort)

const DART_URL = "https://dart.fss.or.kr/dsac008/main.do";
const KIND_LIST_URL = "https://kind.krx.co.kr/corpgeneral/corpList.do?method=download";
const AUX_38_URL = "https://www.38.co.kr/html/fund/?o=k";

let LISTED_CACHE = { ts: 0, set: null };
let AUX_CACHE = { ts: 0, map: null };

function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    },
    body: JSON.stringify(obj),
  };
}

function pad2(n) { return String(n).padStart(2, "0"); }

function kstNow() {
  const now = new Date();
  return new Date(now.getTime() + 9 * 60 * 60 * 1000);
}

function kstTodayISO() {
  return kstNow().toISOString().slice(0, 10);
}

function endOfNextMonthISO() {
  const k = kstNow();
  const y = k.getUTCFullYear();
  const m = k.getUTCMonth();
  const end = new Date(Date.UTC(y, m + 2, 0));
  return end.toISOString().slice(0, 10);
}

function ymFromISO(iso) {
  // YYYY-MM-DD -> {y, m}
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  return { y, m };
}

function nextMonth(y, m) {
  // m: 1-12
  const nm = m + 1;
  if (nm <= 12) return { y, m: nm };
  return { y: y + 1, m: 1 };
}

async function fetchWithTimeout(url, opts = {}, ms = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal, redirect: "follow" });
    return res;
  } finally {
    clearTimeout(t);
  }
}

function stripTags(html) {
  return String(html || "")
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, " ")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|td|th|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"');
}

function normalizeLines(text) {
  return stripTags(text)
    .split(/\r?\n/)
    .map(s => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function detectMarket(short) {
  if (short === "코") return "KOSDAQ";
  if (short === "유") return "KOSPI";
  return "ETC";
}

function parseDsac008Marks(lines, year, month) {
  // lines: visible text tokens
  // Output: marks = [{corp_name, market_short, type:'start'|'end', date:'YYYY-MM-DD'}]
  const mm = pad2(month);
  const marks = [];

  let currentDay = null;

  for (let i = 0; i < lines.length; i++) {
    const tok = lines[i];

    // day tokens: "1" or "02" etc
    if (/^\d{1,2}$/.test(tok)) {
      const d = Number(tok);
      if (d >= 1 && d <= 31) currentDay = d;
      continue;
    }
    if (/^\d{2}$/.test(tok)) {
      const d = Number(tok);
      if (d >= 1 && d <= 31) currentDay = d;
      continue;
    }

    // event tokens often look like: "코 아이씨에이치 [시작]" or "기 케이뱅크 [종료]"
    // sometimes bullet/extra chars may exist; we keep robust
    const m = tok.match(/^(코|유|기)\s+(.+?)\s+\[(시작|종료)\]$/);
    if (m && currentDay) {
      const market_short = m[1];
      const corp_name = m[2].trim();
      const type = (m[3] === "시작") ? "start" : "end";
      const date = `${year}-${mm}-${pad2(currentDay)}`;
      marks.push({ corp_name, market_short, type, date });
      continue;
    }

    // Some lines may embed multiple events; split by " ]" patterns by scanning
    // Example: "코 A [종료] 기 B [시작] ..."
    if (currentDay && (tok.includes("[시작]") || tok.includes("[종료]"))) {
      // Replace with separators then parse pieces
      const expanded = tok
        .replace(/\s+\[/g, " [")
        .replace(/\]\s+/g, "]\n");
      const parts = expanded.split("\n").map(s => s.trim()).filter(Boolean);
      for (const p of parts) {
        const mm2 = p.match(/^(코|유|기)\s+(.+?)\s+\[(시작|종료)\]$/);
        if (mm2) {
          const market_short = mm2[1];
          const corp_name = mm2[2].trim();
          const type = (mm2[3] === "시작") ? "start" : "end";
          const date = `${year}-${mm}-${pad2(currentDay)}`;
          marks.push({ corp_name, market_short, type, date });
        }
      }
    }
  }

  return marks;
}

function pairMarksToEvents(marks) {
  // group by corp_name
  const by = new Map();
  for (const mk of marks) {
    if (!mk.corp_name) continue;
    const arr = by.get(mk.corp_name) || [];
    arr.push(mk);
    by.set(mk.corp_name, arr);
  }

  const events = [];
  for (const [corp, arr] of by.entries()) {
    arr.sort((a, b) => a.date.localeCompare(b.date));
    let currentStart = null;
    let market_short = arr.find(x => x.market_short)?.market_short || "기";

    for (const mk of arr) {
      market_short = mk.market_short || market_short;
      if (mk.type === "start") {
        currentStart = mk.date;
      } else {
        // end
        if (currentStart) {
          events.push({
            corp_name: corp,
            market_short,
            market: detectMarket(market_short),
            sbd_start: currentStart,
            sbd_end: mk.date,
          });
          currentStart = null;
        } else {
          events.push({
            corp_name: corp,
            market_short,
            market: detectMarket(market_short),
            sbd_start: mk.date,
            sbd_end: mk.date,
          });
        }
      }
    }

    if (currentStart) {
      events.push({
        corp_name: corp,
        market_short,
        market: detectMarket(market_short),
        sbd_start: currentStart,
        sbd_end: currentStart,
      });
    }
  }

  // dedupe
  const seen = new Set();
  const out = [];
  for (const e of events) {
    const k = `${e.corp_name}__${e.sbd_start}__${e.sbd_end}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out;
}

async function fetchDsac008Month(year, month) {
  // Try POST first (most likely correct)
  const body = new URLSearchParams({
    selectYear: String(year),
    selectMonth: pad2(month),
  }).toString();

  const res = await fetchWithTimeout(DART_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
      "referer": DART_URL,
      "user-agent": "Mozilla/5.0 (compatible; ipo-alarm/1.0)",
    },
    body,
  }, 12000);

  const buf = await res.arrayBuffer();
  const text = new TextDecoder("utf-8").decode(buf);
  return { ok: res.ok, status: res.status, text };
}

async function getListedSet() {
  const now = Date.now();
  if (LISTED_CACHE.set && (now - LISTED_CACHE.ts) < 24 * 60 * 60 * 1000) {
    return { set: LISTED_CACHE.set, stale: false };
  }

  const res = await fetchWithTimeout(KIND_LIST_URL, {
    headers: {
      "user-agent": "Mozilla/5.0 (compatible; ipo-alarm/1.0)",
      "referer": "https://kind.krx.co.kr/",
    }
  }, 12000);

  const buf = await res.arrayBuffer();

  // KIND download is usually EUC-KR
  let html = "";
  try {
    html = new TextDecoder("euc-kr").decode(buf);
  } catch {
    html = new TextDecoder("utf-8").decode(buf);
  }

  // Extract corp names from td cells; first column often 회사명
  const set = new Set();
  const rows = html.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  for (const r of rows) {
    const tds = r.match(/<td[\s\S]*?<\/td>/gi);
    if (!tds || tds.length === 0) continue;
    // first td text
    const name = stripTags(tds[0]).replace(/\s+/g, " ").trim();
    if (name && name !== "회사명") set.add(name);
  }

  LISTED_CACHE = { ts: now, set };
  return { set, stale: false };
}

async function getAuxMap38() {
  const now = Date.now();
  if (AUX_CACHE.map && (now - AUX_CACHE.ts) < 6 * 60 * 60 * 1000) {
    return { map: AUX_CACHE.map, stale: false };
  }

  // best-effort: do not fail the whole function
  try {
    const res = await fetchWithTimeout(AUX_38_URL, {
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; ipo-alarm/1.0)",
        "referer": "https://www.38.co.kr/",
      }
    }, 12000);

    const buf = await res.arrayBuffer();

    // 38 is often EUC-KR
    let html = "";
    try { html = new TextDecoder("euc-kr").decode(buf); }
    catch { html = new TextDecoder("utf-8").decode(buf); }

    // Parse first table header to locate indices
    const tableMatch = html.match(/<table[\s\S]*?<\/table>/i);
    if (!tableMatch) throw new Error("no table");
    const table = tableMatch[0];

    const headerRow = (table.match(/<tr[\s\S]*?<\/tr>/i) || [])[0] || "";
    const headers = (headerRow.match(/<th[\s\S]*?<\/th>/gi) || []).map(h => stripTags(h).trim());

    const idxName = headers.findIndex(h => /종목|기업|회사/.test(h));
    const idxUw = headers.findIndex(h => /주간사|대표주관|인수/.test(h));
    const idxMin = headers.findIndex(h => /균등|최소/.test(h));

    // If we can't detect, return empty map
    if (idxName < 0) {
      AUX_CACHE = { ts: now, map: new Map() };
      return { map: AUX_CACHE.map, stale: false };
    }

    const map = new Map();
    const rows = table.match(/<tr[\s\S]*?<\/tr>/gi) || [];
    for (const r of rows.slice(1)) {
      const cells = (r.match(/<td[\s\S]*?<\/td>/gi) || []).map(td => stripTags(td).replace(/\s+/g, " ").trim());
      if (!cells || cells.length === 0) continue;

      const name = (cells[idxName] || "").trim();
      if (!name) continue;

      const underwriters = (idxUw >= 0 ? (cells[idxUw] || "").trim() : "");
      const minRaw = (idxMin >= 0 ? (cells[idxMin] || "").trim() : "");

      const minDeposit = parseMoneyToInt(minRaw);
      map.set(name, { underwriters, min_deposit: minDeposit });
    }

    AUX_CACHE = { ts: now, map };
    return { map, stale: false };

  } catch {
    AUX_CACHE = { ts: now, map: new Map() };
    return { map: AUX_CACHE.map, stale: true };
  }
}

function parseMoneyToInt(s) {
  const t = String(s || "").replace(/\s+/g, "");
  if (!t) return null;

  // examples: "250,000", "25만원", "1.2억" etc (best-effort)
  let num = null;

  if (t.includes("억")) {
    // "1.2억" -> 120,000,000
    const v = parseFloat(t.replace(/[^\d.]/g, ""));
    if (!Number.isNaN(v)) num = Math.round(v * 100000000);
  } else if (t.includes("만원")) {
    const v = parseFloat(t.replace(/[^\d.]/g, ""));
    if (!Number.isNaN(v)) num = Math.round(v * 10000);
  } else {
    const digits = t.replace(/[^\d]/g, "");
    if (digits) num = Number(digits);
  }

  if (!num || Number.isNaN(num) || num <= 0) return null;
  return num;
}

exports.handler = async (event) => {
  try {
    const qs = event.queryStringParameters || {};
    const mode = (qs.mode || "next2months").toLowerCase();
    const debug = qs.debug === "1";

    const today = kstTodayISO();
    const endNext = endOfNextMonthISO();
    const { y: y1, m: m1 } = ymFromISO(today);
    const { y: y2, m: m2 } = nextMonth(y1, m1);

    const monthsToFetch = (mode === "next2months")
      ? [{ year: y1, month: m1 }, { year: y2, month: m2 }]
      : (() => {
          const year = Number(qs.year);
          const month = Number(qs.month);
          if (!year || !month) return [{ year: y1, month: m1 }];
          return [{ year, month }];
        })();

    // fetch DART months
    const monthTexts = [];
    for (const ym of monthsToFetch) {
      const r = await fetchDsac008Month(ym.year, ym.month);
      if (!r.ok) {
        return json(200, {
          ok: false,
          error: `DART fetch failed: HTTP ${r.status}`,
        });
      }
      monthTexts.push({ ...ym, text: r.text });
    }

    // stale detection: if month html identical, it's likely month switching failed -> warn + skip duplicates
    let warn = "";
    if (monthTexts.length === 2) {
      const a = monthTexts[0].text;
      const b = monthTexts[1].text;
      if (a && b && a.length === b.length && a === b) {
        warn = "다음달 화면을 못 불러온 것 같아요(응답이 동일). 중복 방지로 다음달은 제외했어요.";
        monthTexts.pop(); // keep only first
      }
    }

    // parse marks
    let allMarks = [];
    for (const mt of monthTexts) {
      const lines = normalizeLines(mt.text);
      const marks = parseDsac008Marks(lines, mt.year, mt.month);
      allMarks = allMarks.concat(marks);
      if (debug) {
        // keep a small portion if needed
      }
    }

    let rawEvents = pairMarksToEvents(allMarks);

    // range filter
    rawEvents = rawEvents.filter(e => e.sbd_start <= endNext && e.sbd_end >= today);

    // listed filter
    const listed = await getListedSet();
    const before = rawEvents.length;
    const filtered = rawEvents.filter(e => !listed.set.has(e.corp_name));
    const excluded_listed = before - filtered.length;

    // aux data (optional)
    const aux = await getAuxMap38();
    const items = filtered.map(e => {
      const extra = aux.map.get(e.corp_name);
      return {
        ...e,
        underwriters: extra?.underwriters || "",
        min_deposit: extra?.min_deposit || null,
      };
    });

    return json(200, {
      ok: true,
      source: "dart-dsac008 + kind-listed-filter + range(today~end-next-month)",
      range: { from: today, to: endNext },
      count: items.length,
      excluded_listed,
      aux_stale: aux.stale || false,
      warn: warn || undefined,
      items,
      ...(debug ? { debug_months: monthsToFetch } : {}),
    });

  } catch (err) {
    return json(200, {
      ok: false,
      error: err?.message || String(err),
    });
  }
};
