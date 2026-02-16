// netlify/functions/dart-ipo.js
// DART 청약달력(지분증권)에서 월별 청약일정을 가져오되,
// OpenDART corpCode(고유번호) 데이터의 stock_code로 "상장사"를 판별하여
// 유상증자/상장사 청약을 최대한 제외(=IPO 위주)합니다.

const { inflateRawSync } = require("node:zlib");

const DART_CAL_URL = "https://dart.fss.or.kr/dsac008/main.do";
const OPENDART_CORPCODE_ZIP_URL = (key) =>
  `https://opendart.fss.or.kr/api/corpCode.xml?crtfc_key=${encodeURIComponent(key)}`;

// --------- 캐시(콜드스타트 줄이기) ----------
let corpIndexCache = null; // Map(normalizedName -> { corp_name, stock_code })
let corpIndexLoadedAt = 0;

function nowMs() {
  return Date.now();
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
  const txt = await res.text();
  return { ok: res.ok, status: res.status, text: txt };
}

async function fetchBuffer(url, options = {}) {
  const res = await fetch(url, {
    redirect: "follow",
    ...options,
    headers: {
      "user-agent":
        "Mozilla/5.0 (compatible; NetlifyFunction/1.0; +https://www.netlify.com/)",
      ...(options.headers || {}),
    },
  });
  const ab = await res.arrayBuffer();
  return { ok: res.ok, status: res.status, buf: Buffer.from(ab) };
}

// --------- ZIP에서 CORPCODE.xml 추출 (외부 라이브러리 없이) ----------
function extractFileFromZip(zipBuf, wantedName) {
  // ZIP EOCD 찾기 (끝에서 66KB 이내)
  const MAX_EOCD_SEARCH = 0x10000 + 22;
  const start = Math.max(0, zipBuf.length - MAX_EOCD_SEARCH);

  let eocd = -1;
  for (let i = zipBuf.length - 22; i >= start; i--) {
    if (zipBuf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
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
    const uncompSize = zipBuf.readUInt32LE(ptr + 24);
    const fileNameLen = zipBuf.readUInt16LE(ptr + 28);
    const extraLen = zipBuf.readUInt16LE(ptr + 30);
    const commentLen = zipBuf.readUInt16LE(ptr + 32);
    const localHeaderOffset = zipBuf.readUInt32LE(ptr + 42);

    const fileName = zipBuf
      .slice(ptr + 46, ptr + 46 + fileNameLen)
      .toString("utf8");

    ptr = ptr + 46 + fileNameLen + extraLen + commentLen;

    if (fileName !== wantedName) continue;

    // Local file header
    if (zipBuf.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
      throw new Error("ZIP local header not found");
    }
    const lfFileNameLen = zipBuf.readUInt16LE(localHeaderOffset + 26);
    const lfExtraLen = zipBuf.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + lfFileNameLen + lfExtraLen;

    const compData = zipBuf.slice(dataStart, dataStart + compSize);

    if (compMethod === 0) {
      // stored
      return compData.toString("utf8");
    }
    if (compMethod === 8) {
      // deflate
      const out = inflateRawSync(compData);
      // uncompSize는 참고용
      return out.toString("utf8");
    }
    throw new Error(`Unsupported ZIP compression method: ${compMethod}`);
  }

  throw new Error(`File not found in ZIP: ${wantedName}`);
}

async function loadCorpIndex(opendartKey) {
  // 7일 캐시 (너무 자주 다운받지 않게)
  const TTL = 7 * 24 * 60 * 60 * 1000;
  if (corpIndexCache && nowMs() - corpIndexLoadedAt < TTL) return corpIndexCache;

  const { ok, status, buf } = await fetchBuffer(OPENDART_CORPCODE_ZIP_URL(opendartKey));
  if (!ok) throw new Error(`OpenDART corpCode download failed: HTTP ${status}`);

  const xml = extractFileFromZip(buf, "CORPCODE.xml");

  // CORPCODE.xml의 list 안에 corp_name / stock_code가 있음 (공식 필드) :contentReference[oaicite:5]{index=5}
  // 간단 파서(정규식). XML이 크지만 서버리스에서 보통 처리 가능.
  const map = new Map();
  const re = /<list>\s*<corp_code>([^<]*)<\/corp_code>\s*<corp_name>([^<]*)<\/corp_name>[\s\S]*?<stock_code>([^<]*)<\/stock_code>[\s\S]*?<modify_date>([^<]*)<\/modify_date>\s*<\/list>/g;

  let m;
  while ((m = re.exec(xml)) !== null) {
    const corp_name = (m[2] || "").trim();
    const stock_code = (m[3] || "").trim();
    const key = normName(corp_name);
    if (!key) continue;

    // 중복명 대비: stock_code 있는 쪽을 우선 저장
    const prev = map.get(key);
    if (!prev) {
      map.set(key, { corp_name, stock_code });
    } else if (!prev.stock_code && stock_code) {
      map.set(key, { corp_name, stock_code });
    }
  }

  corpIndexCache = map;
  corpIndexLoadedAt = nowMs();
  return map;
}

// --------- DART 달력 HTML 가져오기 ----------
function pad2(n) {
  const x = String(n);
  return x.length === 1 ? "0" + x : x;
}

async function fetchDartCalendarHtml(year, month) {
  // DART는 폼 제출 방식일 수 있어 POST를 우선 시도
  const y = String(year);
  const m = pad2(month);

  const candidates = [
    { y: "selectYear", m: "selectMonth" },
    { y: "year", m: "month" },
    { y: "s_year", m: "s_month" },
  ];

  for (const c of candidates) {
    const body = new URLSearchParams();
    body.set(c.y, y);
    body.set(c.m, m);

    const r = await fetchText(DART_CAL_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });

    if (r.ok && r.text && r.text.includes("청약") && r.text.includes("달력")) {
      return r.text;
    }
  }

  // 마지막 fallback: GET
  const r2 = await fetchText(DART_CAL_URL);
  return r2.text;
}

// --------- 달력에서 (일자, 코/유/넥/기, 회사명, 시작/종료) 파싱 ----------
function htmlToLines(html) {
  // script/style 제거 후 태그를 줄바꿈으로 치환
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

  // 진행중 [시작] 기록: key = market_short|corp_name
  const startMap = new Map();
  const itemsMap = new Map(); // key -> item

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
    const act = em[3]; // 시작/종료

    const date = `${y}-${m}-${currentDay}`;
    const key = `${market_short}|${corp_name}`;

    if (act === "시작") {
      startMap.set(key, date);
      if (!itemsMap.has(key)) {
        itemsMap.set(key, {
          corp_name,
          market_short,
          market:
            market_short === "유"
              ? "KOSPI"
              : market_short === "코"
              ? "KOSDAQ"
              : market_short === "넥"
              ? "KONEX"
              : "ETC",
          sbd_start: date,
          sbd_end: date,
        });
      } else {
        const it = itemsMap.get(key);
        it.sbd_start = date;
        if (!it.sbd_end) it.sbd_end = date;
      }
    } else {
      // 종료
      const start = startMap.get(key) || date;
      if (!itemsMap.has(key)) {
        itemsMap.set(key, {
          corp_name,
          market_short,
          market:
            market_short === "유"
              ? "KOSPI"
              : market_short === "코"
              ? "KOSDAQ"
              : market_short === "넥"
              ? "KONEX"
              : "ETC",
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

  return Array.from(itemsMap.values()).sort((a, b) =>
    (a.sbd_start || "").localeCompare(b.sbd_start || "")
  );
}

exports.handler = async (event) => {
  try {
    const qs = event.queryStringParameters || {};
    const year = qs.year || qs.y || "2026";
    const month = qs.month || qs.m || "01";

    // mode=ipo(기본) | all(전체)
    const mode = (qs.mode || "ipo").toLowerCase();

    const html = await fetchDartCalendarHtml(year, month);
    const lines = htmlToLines(html);
    let items = parseCalendarItems(lines, year, month);

    let filteredOut = [];
    let filterNote = null;

    if (mode !== "all") {
      const key = process.env.OPENDART_KEY;
      if (!key) {
        filterNote =
          "OPENDART_KEY 미설정: 상장사(유상증자 등) 필터를 적용하지 못해 전체가 표시됩니다.";
      } else {
        const corpIndex = await loadCorpIndex(key);

        const kept = [];
        for (const it of items) {
          const k = normName(it.corp_name);
          const info = corpIndex.get(k);

          // stock_code 있으면 "이미 상장"으로 보고 제외
          if (info && info.stock_code) {
            filteredOut.push({
              corp_name: it.corp_name,
              stock_code: info.stock_code,
              sbd_start: it.sbd_start,
              sbd_end: it.sbd_end,
            });
            continue;
          }
          kept.push(it);
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
      filtered_out_count: filteredOut.length,
      // 필요하면 프론트에서 표시할 수 있게 남겨둠(너무 길어지면 빼도 됨)
      filtered_out_preview: filteredOut.slice(0, 20),
      note: filterNote,
    };

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
      body: JSON.stringify(
        { ok: false, error: String(e?.message || e), stack: String(e?.stack || "") },
        null,
        2
      ),
    };
  }
};
