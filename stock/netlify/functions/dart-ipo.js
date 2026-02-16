// /stock/netlify/functions/dart-ipo.js
// Netlify Function: 공모주 청약 일정(오늘~다음달 말) + 증권사/균등 최소금액(가능하면) 반환
// 주의: 38 사이트는 EUC-KR 인코딩이 많아 TextDecoder('euc-kr')로 디코딩합니다.

function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    },
    body: JSON.stringify(obj),
  };
}

function stripTags(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function normName(s) {
  return String(s || "")
    .replace(/\s+/g, "")
    .replace(/[()［］\[\]{}]/g, "")
    .trim();
}

function parseDateRangeCell(cellText) {
  // 예: "2026.02.23~02.24" / "2026.02.23 ~ 02.24" / "2026.02.23~2026.02.24"
  const t = String(cellText || "").replace(/\s+/g, "");
  // start
  const m1 = t.match(/(\d{4})\.(\d{2})\.(\d{2})/);
  if (!m1) return null;
  const sy = m1[1], sm = m1[2], sd = m1[3];

  // end can be "MM.DD" or "YYYY.MM.DD"
  let ey = sy, em = sm, ed = sd;
  const after = t.slice(m1.index + m1[0].length);
  const m2full = after.match(/(\d{4})\.(\d{2})\.(\d{2})/);
  if (m2full) {
    ey = m2full[1]; em = m2full[2]; ed = m2full[3];
  } else {
    const m2short = after.match(/(\d{2})\.(\d{2})/);
    if (m2short) { em = m2short[1]; ed = m2short[2]; }
  }

  return {
    start: `${sy}-${sm}-${sd}`,
    end: `${ey}-${em}-${ed}`,
  };
}

function lastDayOfNextMonthISO(fromISO) {
  const [y, m, d] = fromISO.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  const end = new Date(dt.getFullYear(), dt.getMonth() + 2, 0);
  const yy = end.getFullYear();
  const mm = String(end.getMonth() + 1).padStart(2, "0");
  const dd = String(end.getDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

function inRange(s, e, from, to) {
  return !(e < from || s > to);
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; ipo-alarm/1.0)",
      "Accept": "text/html,application/xhtml+xml",
    },
  });
  if (!res.ok) throw new Error(`fetch fail ${res.status} ${url}`);

  const buf = await res.arrayBuffer();
  // EUC-KR 우선
  try {
    return new TextDecoder("euc-kr").decode(buf);
  } catch {
    return new TextDecoder("utf-8").decode(buf);
  }
}

function absUrl(base, href) {
  if (!href) return null;
  if (/^https?:\/\//i.test(href)) return href;
  if (href.startsWith("/")) return base.replace(/\/+$/, "") + href;
  return base.replace(/\/+$/, "") + "/" + href.replace(/^\/+/, "");
}

function pickUpperPrice(text) {
  // "10,000~12,000" -> 12000
  const t = String(text || "");
  const m = t.match(/(\d[\d,]*)\s*~\s*(\d[\d,]*)/);
  if (m) return Number(m[2].replace(/,/g, ""));
  const one = t.match(/(\d[\d,]*)/);
  if (one) return Number(one[1].replace(/,/g, ""));
  return null;
}

function pickInt(text) {
  const m = String(text || "").match(/(\d[\d,]*)/);
  if (!m) return null;
  return Number(m[1].replace(/,/g, ""));
}

function extractLabelValue(html, labels) {
  // <th>라벨</th><td>값</td> or <td class="td_tit">라벨</td><td>값</td>
  for (const label of labels) {
    const re1 = new RegExp(`${label}[\\s\\S]{0,120}?</t[hd]>[\\s\\S]{0,60}?<t[hd][^>]*>([\\s\\S]*?)<\\/t[hd]>`, "i");
    const m1 = html.match(re1);
    if (m1) return stripTags(m1[1]);

    const re2 = new RegExp(`${label}[\\s\\S]{0,120}?<td[^>]*>([\\s\\S]*?)<\\/td>`, "i");
    const m2 = html.match(re2);
    if (m2) return stripTags(m2[1]);
  }
  return "";
}

async function mapLimit(arr, limit, fn) {
  const out = new Array(arr.length);
  let i = 0;
  const workers = new Array(Math.min(limit, arr.length)).fill(0).map(async () => {
    while (i < arr.length) {
      const idx = i++;
      out[idx] = await fn(arr[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

exports.handler = async (event) => {
  try {
    const q = event.queryStringParameters || {};
    const from = q.from || new Date().toISOString().slice(0, 10);
    const to = q.to || lastDayOfNextMonthISO(from);

    // 38 공모주 청약일정 페이지(표)
    const BASE = "https://www.38.co.kr";
    const LIST_URL = "https://www.38.co.kr/html/fund/index.htm?o=k";

    // 간단 캐시(함수 웜 상태에서만)
    const now = Date.now();
    globalThis.__IPO_CACHE = globalThis.__IPO_CACHE || { at: 0, data: null };
    if (globalThis.__IPO_CACHE.data && now - globalThis.__IPO_CACHE.at < 60 * 1000) {
      // 60초 캐시
      const cached = globalThis.__IPO_CACHE.data;
      // 요청 범위만 다시 필터
      const filtered = cached.items.filter(x => inRange(x.sbd_start, x.sbd_end, from, to));
      return json(200, { ...cached, from, to, count: filtered.length, items: filtered, cached: true });
    }

    const html = await fetchText(LIST_URL);

    // "공모주 청약일정" 테이블만 뽑기
    const tableMatch = html.match(/<table[^>]*summary=["']공모주\s*청약일정["'][\s\S]*?<\/table>/i);
    if (!tableMatch) {
      return json(200, {
        ok: true,
        source_note: "38(공모주 청약일정) 테이블 미발견",
        from, to,
        count: 0,
        items: []
      });
    }

    const tableHtml = tableMatch[0];

    // rows
    const rows = Array.from(tableHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)).map(m => m[1]);
    const candidates = [];

    for (const rowHtml of rows) {
      const tds = Array.from(rowHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)).map(m => m[1]);
      if (tds.length < 3) continue;

      // 회사명 (index 1) 안에 <a href="...">회사명</a>
      const a = tds[1].match(/<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
      if (!a) continue;

      const detailHref = a[1];
      const corp = stripTags(a[2]);
      if (!corp) continue;

      // 청약일 (index 2)
      const dr = parseDateRangeCell(stripTags(tds[2]));
      if (!dr) continue;

      // 범위 필터 (겹치면 포함)
      if (!inRange(dr.start, dr.end, from, to)) continue;

      candidates.push({
        corp_name: corp,
        sbd_start: dr.start,
        sbd_end: dr.end,
        detail_url: absUrl(BASE, detailHref),
      });
    }

    // 중복 제거(회사+기간)
    const uniqMap = new Map();
    for (const c of candidates) {
      const key = `${normName(c.corp_name)}|${c.sbd_start}|${c.sbd_end}`;
      uniqMap.set(key, c);
    }
    let items = Array.from(uniqMap.values());

    // 각 회사 상세 페이지에서: 주간사/공모가/최소청약수량 등 최대한 뽑아 “균등 최소금액” 계산
    items = await mapLimit(items, 5, async (it) => {
      try {
        if (!it.detail_url) return it;

        const dh = await fetchText(it.detail_url);

        // 주간사/주관사
        let under = extractLabelValue(dh, ["주간사", "주관사", "대표주관회사", "인수인"]);
        let underwriters = [];
        if (under) {
          under = under.replace(/\s+/g, " ").trim();
          underwriters = under
            .split(/[\/,]|·|\||\s{2,}/g)
            .map(s => s.trim())
            .filter(Boolean);
        }

        // 공모가: 확정공모가 > 공모가 > 희망공모가액(상단)
        const fixedPriceTxt = extractLabelValue(dh, ["확정공모가"]);
        const offerPriceTxt = extractLabelValue(dh, ["공모가"]);
        const hopePriceTxt = extractLabelValue(dh, ["희망공모가액", "희망공모가"]);

        let price = null;
        let price_note = "";

        if (fixedPriceTxt) {
          price = pickUpperPrice(fixedPriceTxt);
          price_note = `확정공모가: ${fixedPriceTxt}`;
        } else if (offerPriceTxt) {
          price = pickUpperPrice(offerPriceTxt);
          price_note = `공모가: ${offerPriceTxt}`;
        } else if (hopePriceTxt) {
          price = pickUpperPrice(hopePriceTxt);
          price_note = `희망공모가(상단 추정): ${hopePriceTxt}`;
        }

        // 최소청약수량(가능하면)
        let minSharesTxt = extractLabelValue(dh, ["최소청약수량", "최소 청약수량", "균등배정 최소청약"]);
        if (!minSharesTxt) {
          const txt = stripTags(dh);
          const m = txt.match(/최소\s*청약\s*수량[^0-9]{0,20}(\d{1,5})\s*주/);
          if (m) minSharesTxt = `${m[1]}주`;
        }
        let minShares = pickInt(minSharesTxt);

        // 증거금율(없으면 50%)
        let depRateTxt = extractLabelValue(dh, ["청약증거금율", "청약 증거금율", "증거금율"]);
        let depRate = depRateTxt ? pickInt(depRateTxt) : 50;
        if (!depRate || depRate > 100) depRate = 50;

        // 균등 최소증거금(1인) = 공모가 * 최소청약수량 * (증거금율/100)
        let equal_min_deposit = null;
        if (price != null && minShares != null) {
          equal_min_deposit = Math.round(price * minShares * (depRate / 100));
        }

        return {
          corp_name: it.corp_name,
          sbd_start: it.sbd_start,
          sbd_end: it.sbd_end,
          underwriters,
          equal_min_deposit,
          price_note,
          source_note: "38 공모주 청약일정 + (상세페이지 매칭/추정)",
        };
      } catch {
        return {
          corp_name: it.corp_name,
          sbd_start: it.sbd_start,
          sbd_end: it.sbd_end,
          underwriters: [],
          equal_min_deposit: null,
          price_note: "",
          source_note: "38 공모주 청약일정(상세 정보 일부 실패)",
        };
      }
    });

    // “회사명만 중복” 제거(가장 빠른 일정 1개만)
    const byCorp = new Map();
    for (const it of items) {
      const k = normName(it.corp_name);
      const prev = byCorp.get(k);
      if (!prev) byCorp.set(k, it);
      else if (String(it.sbd_start) < String(prev.sbd_start)) byCorp.set(k, it);
    }
    items = Array.from(byCorp.values()).sort((a, b) => String(a.sbd_start).localeCompare(String(b.sbd_start)));

    const payload = {
      ok: true,
      from,
      to,
      count: items.length,
      items,
    };

    globalThis.__IPO_CACHE = { at: now, data: payload };
    return json(200, payload);
  } catch (err) {
    return json(200, { ok: false, error: String(err && err.message ? err.message : err) });
  }
};
