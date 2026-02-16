// /stock/netlify/functions/dart-ipo.js
// Netlify Function (Node 18+)

const DART_CAL_URL = "https://dart.fss.or.kr/dsac008/main.do";
const KIND_LISTED_URL = "https://kind.krx.co.kr/corpgeneral/corpList.do?method=download&searchType=13";

// In-memory caches (warm lambda)
globalThis.__ipoCache ??= {
  form: null,                 // { action, yearSel, monthSel, hidden, cookie, fetchedAt }
  monthHtml: new Map(),       // key: "YYYY-MM" => { html, fetchedAt }
  listed: null,               // { set, fetchedAt, size }
};

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36";

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

function withTimeout(ms, promise, label = "timeout") {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(label), ms);
  return {
    signal: ctrl.signal,
    wrap: promise.finally(() => clearTimeout(t)),
  };
}

function decodeAny(buf, hint) {
  const tries = [];
  if (hint) tries.push(hint);
  tries.push("utf-8", "euc-kr", "cp949");

  for (const enc of tries) {
    try {
      return new TextDecoder(enc).decode(buf);
    } catch {}
  }
  return Buffer.from(buf).toString("utf8");
}

function stripTagsToLines(html) {
  // remove script/style
  html = html.replace(/<script[\s\S]*?<\/script>/gi, " ");
  html = html.replace(/<style[\s\S]*?<\/style>/gi, " ");
  // keep some breaks
  html = html.replace(/<br\s*\/?>/gi, "\n");
  html = html.replace(/<\/(div|p|li|tr|h\d)>/gi, "\n");
  // remove tags
  html = html.replace(/<[^>]+>/g, " ");
  // html entities minimal
  html = html
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));

  const lines = html
    .split(/\r?\n/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  return lines;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function normName(s) {
  return String(s || "")
    .replace(/\s+/g, "")
    .replace(/[()（）]/g, "")
    .trim();
}

function parseYMD(s) {
  // "YYYY-MM-DD" => {y,m,d}
  const [y, m, d] = String(s).split("-").map(Number);
  return { y, m, d };
}

function dateToIsoUTC(y, m, d) {
  return new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);
}

function kstTodayIso() {
  // Shift +9h then take UTC date part => KST date string
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10);
}

function kstEndOfNextMonthIso() {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const y = kst.getUTCFullYear();
  const m0 = kst.getUTCMonth(); // 0-based
  // last day of next month: month + 2, day 0
  const end = new Date(Date.UTC(y, m0 + 2, 0));
  return end.toISOString().slice(0, 10);
}

function monthsBetween(startIso, endIso) {
  const s = parseYMD(startIso);
  const e = parseYMD(endIso);
  const out = [];
  let y = s.y, m = s.m;
  while (y < e.y || (y === e.y && m <= e.m)) {
    out.push({ y, m });
    m += 1;
    if (m === 13) { m = 1; y += 1; }
  }
  return out;
}

async function fetchListedSet() {
  const cache = globalThis.__ipoCache;
  const TTL = 24 * 60 * 60 * 1000; // 24h

  if (cache.listed && (Date.now() - cache.listed.fetchedAt) < TTL) {
    return cache.listed;
  }

  // fetch KIND listed corp list (one shot)
  const { signal, wrap } = withTimeout(
    12000,
    fetch(KIND_LISTED_URL, { headers: { "user-agent": UA }, signal: undefined }),
    "listed-fetch-timeout"
  );

  let res;
  try {
    res = await fetch(KIND_LISTED_URL, { headers: { "user-agent": UA }, signal });
  } catch (e) {
    throw new Error("KIND 상장법인목록 불러오기 실패");
  }

  const ab = await res.arrayBuffer();
  const html = decodeAny(ab, "euc-kr");

  // Parse table rows:
  // First columns usually: 회사명, 종목코드, ...
  const set = new Set();

  const rowRe = /<tr[^>]*>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/gi;
  let m;
  while ((m = rowRe.exec(html))) {
    const nameRaw = m[1]
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/\s+/g, " ")
      .trim();
    if (!nameRaw || nameRaw === "회사명") continue;
    set.add(normName(nameRaw));
  }

  cache.listed = { set, fetchedAt: Date.now(), size: set.size };
  return cache.listed;
}

function extractFormSpec(initHtml) {
  // find the first <form> that contains both year/month selects (년/월 option list)
  const forms = initHtml.match(/<form[\s\S]*?<\/form>/gi) || [];
  let target = null;

  for (const f of forms) {
    if (f.includes("2016년") && f.includes("2026년") && f.includes("1월") && f.includes("12월")) {
      target = f;
      break;
    }
  }
  if (!target) target = forms[0] || "";

  const actionMatch = target.match(/action\s*=\s*["']([^"']+)["']/i);
  const action = actionMatch ? actionMatch[1] : "/dsac008/main.do";

  // selects
  const selects = target.match(/<select[\s\S]*?<\/select>/gi) || [];
  let yearSel = null;
  let monthSel = null;

  for (const sel of selects) {
    if (sel.includes("2016년") && sel.includes("2026년")) yearSel = sel;
    if (sel.includes("1월") && sel.includes("12월")) monthSel = sel;
  }

  const getSelectName = (selHtml) => {
    const m = selHtml?.match(/name\s*=\s*["']([^"']+)["']/i);
    return m ? m[1] : null;
  };

  const yearName = getSelectName(yearSel);
  const monthName = getSelectName(monthSel);

  // hidden inputs
  const hidden = {};
  const hidRe = /<input[^>]+type\s*=\s*["']hidden["'][^>]*>/gi;
  const hids = target.match(hidRe) || [];
  for (const inp of hids) {
    const nm = inp.match(/name\s*=\s*["']([^"']+)["']/i);
    const vm = inp.match(/value\s*=\s*["']([^"']*)["']/i);
    if (nm) hidden[nm[1]] = vm ? vm[1] : "";
  }

  return { action, yearName, monthName, hidden };
}

function pickOptionValue(selectHtml, labelWanted) {
  // labelWanted: "2026년" / "3월"
  // returns option value or fallback numeric
  if (!selectHtml) return null;

  const optRe = /<option([^>]*)>([\s\S]*?)<\/option>/gi;
  let m;
  while ((m = optRe.exec(selectHtml))) {
    const attrs = m[1] || "";
    const label = (m[2] || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    if (label === labelWanted) {
      const v = attrs.match(/value\s*=\s*["']([^"']+)["']/i);
      return v ? v[1] : labelWanted.replace(/[^\d]/g, "");
    }
  }
  // fallback
  return labelWanted.replace(/[^\d]/g, "");
}

async function ensureFormSession() {
  const cache = globalThis.__ipoCache;
  const TTL = 10 * 60 * 1000; // 10 min

  if (cache.form && (Date.now() - cache.form.fetchedAt) < TTL) {
    return cache.form;
  }

  // GET once to acquire cookie + form spec
  const { signal } = withTimeout(8000, Promise.resolve(), "dart-init-timeout");
  const res = await fetch(DART_CAL_URL, { headers: { "user-agent": UA }, signal });
  const setCookie = res.headers.get("set-cookie") || "";
  const ab = await res.arrayBuffer();
  const html = decodeAny(ab, "euc-kr");

  const spec = extractFormSpec(html);

  cache.form = {
    ...spec,
    cookie: setCookie,
    fetchedAt: Date.now(),
    // keep selects in case option-value needed (we re-extract from html again)
    _initHtml: html,
  };

  return cache.form;
}

async function fetchDsac008MonthHtml(y, m) {
  const cache = globalThis.__ipoCache;
  const key = `${y}-${pad2(m)}`;
  const TTL = 5 * 60 * 1000; // 5 min

  const hit = cache.monthHtml.get(key);
  if (hit && (Date.now() - hit.fetchedAt) < TTL) return hit.html;

  const form = await ensureFormSession();

  // action might be relative
  const actionUrl = form.action.startsWith("http")
    ? form.action
    : `https://dart.fss.or.kr${form.action.startsWith("/") ? "" : "/"}${form.action}`;

  // Use initHtml selects to find option values
  const initHtml = form._initHtml || "";
  const yearSelMatch = initHtml.match(/<select[\s\S]*?2016년[\s\S]*?<\/select>/i);
  const monthSelMatch = initHtml.match(/<select[\s\S]*?1월[\s\S]*?<\/select>/i);
  const yearSel = yearSelMatch ? yearSelMatch[0] : null;
  const monthSel = monthSelMatch ? monthSelMatch[0] : null;

  const yearLabel = `${y}년`;
  const monthLabel = `${Number(m)}월`;

  const yearVal = pickOptionValue(yearSel, yearLabel);
  const monthVal = pickOptionValue(monthSel, monthLabel);

  const bodyObj = { ...(form.hidden || {}) };
  if (form.yearName) bodyObj[form.yearName] = yearVal;
  if (form.monthName) bodyObj[form.monthName] = monthVal;

  const body = new URLSearchParams(bodyObj).toString();

  const { signal } = withTimeout(9000, Promise.resolve(), "dart-post-timeout");
  const res = await fetch(actionUrl, {
    method: "POST",
    headers: {
      "user-agent": UA,
      "content-type": "application/x-www-form-urlencoded",
      "referer": DART_CAL_URL,
      "cookie": form.cookie || "",
    },
    body,
    signal,
  });

  const ab = await res.arrayBuffer();
  const html = decodeAny(ab, "euc-kr");

  cache.monthHtml.set(key, { html, fetchedAt: Date.now() });
  return html;
}

function parseCalendarItemsFromHtml(html, y, m) {
  const lines = stripTagsToLines(html);

  const rec = new Map(); // corp -> {corp_name, market_short, startDay, endDay}
  const isMarket = (s) => ["코", "유", "코넥", "기"].includes(s);

  function findDayBackward(idx) {
    for (let k = 1; k <= 4; k++) {
      const s = lines[idx - k];
      if (!s) continue;
      if (/^\d{1,2}$/.test(s)) return Number(s);
      if (/^\d{2}$/.test(s)) return Number(s);
    }
    return null;
  }

  for (let i = 0; i < lines.length; i++) {
    const t = lines[i];
    const start = t.endsWith("[시작]");
    const end = t.endsWith("[종료]");
    if (!start && !end) continue;

    const corp = t.replace(/\s*\[(시작|종료)\]\s*$/, "").trim();
    const day = findDayBackward(i);
    const market_short = isMarket(lines[i - 1]) ? lines[i - 1] : "";

    if (!corp || !day) continue;

    const cur = rec.get(corp) || { corp_name: corp, market_short, startDay: null, endDay: null };
    if (!cur.market_short && market_short) cur.market_short = market_short;

    if (start) cur.startDay = day;
    if (end) cur.endDay = day;

    rec.set(corp, cur);
  }

  const items = [];
  for (const r of rec.values()) {
    const sd = r.startDay ?? r.endDay;
    const ed = r.endDay ?? r.startDay;
    if (!sd || !ed) continue;

    const sbd_start = `${y}-${pad2(m)}-${pad2(sd)}`;
    const sbd_end = `${y}-${pad2(m)}-${pad2(ed)}`;

    items.push({
      corp_name: r.corp_name,
      market_short: r.market_short || "",
      market: r.market_short === "코" ? "KOSDAQ" : (r.market_short === "유" ? "KOSPI" : "ETC"),
      sbd_start,
      sbd_end,
    });
  }

  // sort
  items.sort((a, b) => a.sbd_start.localeCompare(b.sbd_start));
  return { items, debug_lines_first_200: lines.slice(0, 200) };
}

function inRange(item, startIso, endIso) {
  // overlap check by string compare (ISO date)
  return !(item.sbd_end < startIso || item.sbd_start > endIso);
}

exports.handler = async (event) => {
  try {
    const q = event.queryStringParameters || {};

    // Mode:
    // 1) range=next (default): today~end of next month (KST)
    // 2) year/month: specific month
    // 3) start/end: custom range
    let startIso, endIso, rangeLabel;

    if (q.year && q.month) {
      const y = Number(q.year);
      const m = Number(q.month);
      startIso = `${y}-${pad2(m)}-01`;
      // end of month
      const end = new Date(Date.UTC(y, m, 0));
      endIso = end.toISOString().slice(0, 10);
      rangeLabel = `${y}-${pad2(m)}`;
    } else if (q.start && q.end) {
      startIso = q.start;
      endIso = q.end;
      rangeLabel = `${startIso}~${endIso}`;
    } else {
      // default range=next
      startIso = kstTodayIso();
      endIso = kstEndOfNextMonthIso();
      rangeLabel = "오늘~다음달 말";
    }

    const months = monthsBetween(startIso, endIso);

    // Fetch listed set once (for filtering out already-listed companies)
    let listed = null;
    let listedErr = null;
    try {
      listed = await fetchListedSet();
    } catch (e) {
      listedErr = e?.message || "listed fetch error";
    }

    let rawCount = 0;
    let excluded_listed = 0;
    const out = [];
    let debugAny = null;

    for (const ym of months) {
      const html = await fetchDsac008MonthHtml(ym.y, ym.m);
      const parsed = parseCalendarItemsFromHtml(html, ym.y, ym.m);
      debugAny ??= parsed.debug_lines_first_200;

      for (const it of parsed.items) {
        rawCount++;
        if (!inRange(it, startIso, endIso)) continue;

        if (listed?.set) {
          if (listed.set.has(normName(it.corp_name))) {
            excluded_listed++;
            continue;
          }
        }
        out.push(it);
      }
    }

    // Dedup by corp+start+end
    const uniq = new Map();
    for (const it of out) uniq.set(`${it.corp_name}|${it.sbd_start}|${it.sbd_end}`, it);

    const items = Array.from(uniq.values()).sort((a, b) => a.sbd_start.localeCompare(b.sbd_start));

    const resp = {
      ok: true,
      source: "dart-dsac008 + listed-filter(per-month-cache-fixed)",
      range_label: rangeLabel,
      start: startIso,
      end: endIso,
      count: items.length,
      raw_count: rawCount,
      excluded_listed,
      listed_set_size: listed?.size || 0,
      listed_filter_stale: false,
      items,
    };

    // debug=1 이면 라인 200개 같이 줌
    if (q.debug === "1") {
      resp.debug_lines_first_200 = debugAny || [];
      resp.debug = { listed_err: listedErr };
    }

    return json(200, resp);
  } catch (e) {
    return json(500, { ok: false, error: e?.message || String(e) });
  }
};
