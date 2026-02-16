// netlify/functions/dart-ipo.js
// DART(OpenDART)로 "이번달 공모(청약) 일정"을 모아서 JSON으로 반환
// 호출 예: /.netlify/functions/dart-ipo?year=2026&month=02

const OPEN_DART_LIST = "https://opendart.fss.or.kr/api/list.json";
const OPEN_DART_ESTK = "https://opendart.fss.or.kr/api/estkRs.json";

function pad2(n) {
  return String(n).padStart(2, "0");
}

function ymdToISO(ymd) {
  if (!ymd) return "";
  // 20260220 -> 2026-02-20
  const m = String(ymd).match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!m) return "";
  return `${m[1]}-${m[2]}-${m[3]}`;
}

function parseAllYmds(text) {
  // "20260220~20260223", "2026.02.20 ~ 2026.02.23" 등에서 8자리 날짜 추출
  const s = String(text || "");
  const matches = s.match(/\b(20\d{2})[.\-/ ]?(0[1-9]|1[0-2])[.\-/ ]?(0[1-9]|[12]\d|3[01])\b/g);
  if (!matches) return [];
  // normalize -> YYYYMMDD
  const out = matches
    .map(t => t.replace(/[.\-/ ]/g, ""))
    .filter(x => /^\d{8}$/.test(x));
  // unique + sort
  return Array.from(new Set(out)).sort();
}

function monthRange(year, month) {
  // month: "02" or 2
  const y = Number(year);
  const m = Number(month);
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end = new Date(Date.UTC(y, m, 0)); // last day
  const startYmd = `${y}${pad2(m)}01`;
  const endYmd = `${y}${pad2(m)}${pad2(end.getUTCDate())}`;
  return { startYmd, endYmd, start, end };
}

function addDaysUTC(date, days) {
  const d = new Date(date.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function dateOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart <= bEnd && aEnd >= bStart;
}

async function fetchJSON(url, params) {
  const qs = new URLSearchParams(params);
  const r = await fetch(`${url}?${qs.toString()}`, {
    headers: { "User-Agent": "ipo-reminder/1.0 (netlify function)" },
  });
  const text = await r.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Upstream returned non-JSON: ${text.slice(0, 200)}`);
  }
  return json;
}

exports.handler = async (event) => {
  try {
    const apiKey = process.env.DART_API_KEY;
    if (!apiKey) {
      return {
        statusCode: 500,
        body: JSON.stringify({ ok: false, error: "Missing env DART_API_KEY" }),
      };
    }

    const year = (event.queryStringParameters?.year || "").trim();
    const month = (event.queryStringParameters?.month || "").trim();
    if (!/^\d{4}$/.test(year) || !/^\d{1,2}$|^\d{2}$/.test(month)) {
      return {
        statusCode: 400,
        body: JSON.stringify({ ok: false, error: "Use ?year=YYYY&month=MM" }),
      };
    }

    const { startYmd, endYmd, start, end } = monthRange(year, month);

    // ⚠️ list.json은 corp_code 없이 조회할 때 검색기간이 3개월로 제한됨
    // 그래서 "이번달"을 기준으로 과거 90일~월말까지로 잡음. :contentReference[oaicite:2]{index=2}
    const listStart = addDaysUTC(start, -90);
    const listStartYmd = `${listStart.getUTCFullYear()}${pad2(listStart.getUTCMonth() + 1)}${pad2(listStart.getUTCDate())}`;

    // 1) 공시검색(list): 발행공시(C) + 증권신고(지분증권)(C001) :contentReference[oaicite:3]{index=3}
    // - corp_cls=E(기타법인)로 걸면 “상장사 유상증자”가 많이 빠져서 IPO에 좀 더 가까워짐
    const listParams = {
      crtfc_key: apiKey,
      bgn_de: listStartYmd,
      end_de: endYmd,
      pblntf_ty: "C",
      pblntf_detail_ty: "C001",
      corp_cls: "E",
      last_reprt_at: "Y",
      page_no: "1",
      page_count: "100",
      sort: "date",
      sort_mth: "desc",
    };

    const first = await fetchJSON(OPEN_DART_LIST, listParams);
    if (first.status !== "000" && first.status !== "013") {
      // 013 = 조회 데이터 없음 :contentReference[oaicite:4]{index=4}
      return { statusCode: 502, body: JSON.stringify({ ok: false, error: first.message, status: first.status }) };
    }
    if (first.status === "013") {
      return {
        statusCode: 200,
        headers: { "Cache-Control": "public, max-age=300" },
        body: JSON.stringify({ ok: true, year, month: pad2(month), items: [], note: "no_disclosures" }),
      };
    }

    const totalPage = Number(first.total_page || 1);
    const pagesToFetch = Math.min(totalPage, 5); // 안전장치(요청 폭주 방지)
    const disclosures = [...(first.list || [])];

    for (let p = 2; p <= pagesToFetch; p++) {
      const page = await fetchJSON(OPEN_DART_LIST, { ...listParams, page_no: String(p) });
      if (page.status === "000") disclosures.push(...(page.list || []));
    }

    // 2) estkRs: corp_code + 기간으로 “청약기일(sbd), 납입기일(pymd), 인수인(주관사)” 등을 얻음 :contentReference[oaicite:5]{index=5}
    // estkRs는 corp_code가 필수라서 list에서 나온 회사만 대상으로 조회함. :contentReference[oaicite:6]{index=6}
    const uniqCorp = new Map(); // corp_code -> {corp_code, corp_name}
    for (const d of disclosures) {
      if (d?.corp_code) uniqCorp.set(d.corp_code, { corp_code: d.corp_code, corp_name: d.corp_name || "" });
    }

    const items = [];
    for (const { corp_code, corp_name } of uniqCorp.values()) {
      const estk = await fetchJSON(OPEN_DART_ESTK, {
        crtfc_key: apiKey,
        corp_code,
        bgn_de: listStartYmd,
        end_de: endYmd,
      });

      if (estk.status !== "000") continue;

      const groups = Array.isArray(estk.group) ? estk.group : [];
      // 일반사항에서 sbd/pymd 추출
      const general = groups.find(g => String(g.title || "").includes("일반사항"));
      const generalList = Array.isArray(general?.list) ? general.list : [];
      // 인수인정보에서 주관사(actnmn) 추출
      const underGroup = groups.find(g => String(g.title || "").includes("인수인정보"));
      const underList = Array.isArray(underGroup?.list) ? underGroup.list : [];

      const underwriters = Array.from(
        new Set(
          underList
            .map(x => (x?.actnmn || "").trim())
            .filter(Boolean)
        )
      ).join(", ");

      for (const row of generalList) {
        const sbd = row?.sbd || "";
        const pymd = row?.pymd || "";
        const rceptNo = row?.rcept_no || "";

        const ymds = parseAllYmds(sbd);
        if (!ymds.length) continue;

        const evStartYmd = ymds[0];
        const evEndYmd = ymds[ymds.length - 1];

        const evStart = new Date(Date.UTC(Number(evStartYmd.slice(0, 4)), Number(evStartYmd.slice(4, 6)) - 1, Number(evStartYmd.slice(6, 8))));
        const evEnd = new Date(Date.UTC(Number(evEndYmd.slice(0, 4)), Number(evEndYmd.slice(4, 6)) - 1, Number(evEndYmd.slice(6, 8))));

        // "이번달"과 겹치는 청약만 포함
        if (!dateOverlap(evStart, evEnd, start, end)) continue;

        items.push({
          companyName: row?.corp_name || corp_name,
          startDate: ymdToISO(evStartYmd),
          endDate: ymdToISO(evEndYmd),
          payDate: ymdToISO(parseAllYmds(pymd)[0] || ""),
          corpCode: corp_code,
          rceptNo,
          underwriters,
          dartViewerUrl: rceptNo ? `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${rceptNo}` : "",
          source: "OpenDART estkRs",
        });
      }
    }

    // 정렬 + 중복 제거(회사명+시작일)
    const seen = new Set();
    const clean = items
      .sort((a, b) => (a.startDate || "").localeCompare(b.startDate || ""))
      .filter(x => {
        const k = `${x.companyName}|${x.startDate}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        // 캐시(같은 달은 자주 안 바뀜): 10분 캐시
        "Cache-Control": "public, max-age=600",
      },
      body: JSON.stringify({ ok: true, year, month: pad2(month), items: clean }),
    };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: String(e) }) };
  }
};
