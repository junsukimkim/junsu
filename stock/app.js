/* ====== 공모 알림 (4인가족) - app.js ====== */

const LS_KEY = "ipo_alarm_store_v4";
const API_DART = "/api/dart-ipo";     // stock/_redirects로 연결되어 있어야 함
// const API_META = "/api/ipo-meta";  // (나중에 증권사/최소금액 자동화할 때 사용)

function uid() {
  return (crypto?.randomUUID?.() ?? "id-" + Math.random().toString(16).slice(2));
}

function loadStore() {
  const raw = localStorage.getItem(LS_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function saveStore(store) {
  localStorage.setItem(LS_KEY, JSON.stringify(store));
}

function defaultStore() {
  const members = [
    { id: uid(), name: "아빠", brokerNote: "" },
    { id: uid(), name: "엄마", brokerNote: "" },
    { id: uid(), name: "자녀1", brokerNote: "" },
    { id: uid(), name: "자녀2", brokerNote: "" },
  ];
  return { members, events: [] };
}

/** 이벤트(공모 일정) 구조
 * {
 *   id: "dart:회사명:YYYY-MM-DD:YYYY-MM-DD",
 *   corp_name,
 *   market, market_short,
 *   sbd_start, sbd_end,
 *   underwriters: "",        // 수동 입력용(지금은 자동이 없을 수 있음)
 *   minDeposit: "",          // 수동 입력용(균등 최소금액)
 *   perMember: { [memberId]: boolean }
 * }
 */

let store = loadStore() ?? defaultStore();

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

/* ---------- Tabs ---------- */
function initTabs() {
  $$(".tab").forEach(btn => {
    btn.addEventListener("click", () => {
      $$(".tab").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      const tab = btn.dataset.tab;
      $$(".panel").forEach(p => p.classList.remove("active"));
      $(`#tab-${tab}`)?.classList.add("active");
    });
  });
}

/* ---------- Date helpers ---------- */
function pad2(n) { return String(n).padStart(2, "0"); }
function ymd(y, m, d) { return `${y}-${pad2(m)}-${pad2(d)}`; }

function parseYmd(s) {
  // "YYYY-MM-DD" -> Date (local)
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0);
}

function addDays(date, days) {
  const d = new Date(date.getTime());
  d.setDate(d.getDate() + days);
  return d;
}

function endOfNextMonth(now = new Date()) {
  const y = now.getFullYear();
  const m = now.getMonth() + 1; // 1-12
  let ny = y, nm = m + 1;
  if (nm === 13) { ny += 1; nm = 1; }
  // new Date(year, monthIndex+1, 0) == 마지막 날
  return new Date(ny, nm, 0, 23, 59, 59, 999);
}

function monthsBetween(fromDate, toDate) {
  // returns [{y,m}, ...] unique months covering the range
  const out = [];
  let y = fromDate.getFullYear();
  let m = fromDate.getMonth() + 1;
  const endY = toDate.getFullYear();
  const endM = toDate.getMonth() + 1;

  while (y < endY || (y === endY && m <= endM)) {
    out.push({ y, m });
    m += 1;
    if (m === 13) { m = 1; y += 1; }
  }
  return out;
}

function overlapsRange(evStart, evEnd, rangeStart, rangeEnd) {
  const a1 = parseYmd(evStart).getTime();
  const a2 = parseYmd(evEnd).getTime();
  const b1 = rangeStart.getTime();
  const b2 = rangeEnd.getTime();
  // 날짜 단위(시작/종료 포함)로 겹치면 true
  return !(a2 < b1 || a1 > b2);
}

/* ---------- Fetch helpers ---------- */
async function fetchJsonNoStore(url) {
  // iOS/PWA 캐시 때문에: cache:'no-store' + timestamp
  const sep = url.includes("?") ? "&" : "?";
  const bust = `${url}${sep}t=${Date.now()}`;
  const res = await fetch(bust, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

/* ---------- Render: Family ---------- */
function renderFamily() {
  const box = $("#family-list");
  if (!box) return;
  box.innerHTML = "";

  store.members.forEach(m => {
    const row = document.createElement("div");
    row.className = "row space";
    row.style.alignItems = "center";
    row.innerHTML = `
      <div>
        <b>${escapeHtml(m.name)}</b>
        <div class="muted" style="margin-top:4px;">${escapeHtml(m.brokerNote || "")}</div>
      </div>
      <div class="row" style="gap:8px;">
        <button class="btn" data-act="rename" data-id="${m.id}">이름</button>
        <button class="btn" data-act="broker" data-id="${m.id}">메모</button>
        <button class="btn" data-act="del" data-id="${m.id}">삭제</button>
      </div>
    `;
    box.appendChild(row);
  });

  // delegation
  box.querySelectorAll("button").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      const act = btn.dataset.act;

      if (act === "del") {
        store.members = store.members.filter(x => x.id !== id);
        store.events.forEach(e => { if (e.perMember) delete e.perMember[id]; });
        saveStore(store);
        renderAll();
        return;
      }

      const m = store.members.find(x => x.id === id);
      if (!m) return;

      if (act === "rename") {
        const newName = prompt("이름", m.name);
        if (newName && newName.trim()) {
          m.name = newName.trim();
          saveStore(store);
          renderAll();
        }
      } else if (act === "broker") {
        const newNote = prompt("증권사 메모", m.brokerNote || "");
        if (newNote !== null) {
          m.brokerNote = newNote.trim();
          saveStore(store);
          renderAll();
        }
      }
    });
  });
}

/* ---------- Render: Events ---------- */
function renderEvents() {
  const box = $("#events-list");
  if (!box) return;
  box.innerHTML = "";

  if (!store.events.length) {
    box.innerHTML = `<div class="muted">아직 일정이 없어요. 위에서 “DART에서 일정 자동 채우기”를 눌러주세요.</div>`;
    return;
  }

  // 정렬: 시작일 오름차순
  const events = [...store.events].sort((a, b) => (a.sbd_start || "").localeCompare(b.sbd_start || ""));

  events.forEach(ev => {
    const card = document.createElement("div");
    card.className = "card";
    card.style.marginBottom = "12px";

    const under = ev.underwriters?.trim() ? ev.underwriters.trim() : "(없음/미입력)";
    const dep = ev.minDeposit?.trim() ? ev.minDeposit.trim() : "(공모가 미확정/미입력)";

    const memberChecks = store.members.map(m => {
      const checked = !!(ev.perMember && ev.perMember[m.id]);
      return `
        <label class="inline" style="gap:8px;">
          <input type="checkbox" data-act="mcheck" data-eid="${ev.id}" data-mid="${m.id}" ${checked ? "checked" : ""} />
          ${escapeHtml(m.name)}
        </label>
      `;
    }).join("");

    card.innerHTML = `
      <div class="row space" style="align-items:flex-start;">
        <div style="min-width:220px;">
          <div style="font-size:18px; font-weight:700;">${escapeHtml(ev.corp_name)}</div>
          <div class="muted" style="margin-top:6px;">청약: <b>${escapeHtml(ev.sbd_start)}</b> ~ <b>${escapeHtml(ev.sbd_end)}</b></div>
          <div class="muted" style="margin-top:6px;">증권사: ${escapeHtml(under)}</div>
          <div class="muted" style="margin-top:6px;">균등 최소금액: ${escapeHtml(dep)}</div>
        </div>

        <div class="row" style="gap:8px; align-items:center;">
          <button class="btn" data-act="ics" data-eid="${ev.id}">캘린더</button>
          <button class="btn" data-act="edit" data-eid="${ev.id}">정보수정</button>
          <button class="btn" data-act="del" data-eid="${ev.id}">삭제</button>
        </div>
      </div>

      <div class="row" style="margin-top:12px; flex-wrap:wrap; gap:14px;">
        ${memberChecks}
      </div>
    `;

    box.appendChild(card);
  });

  // delegation for buttons + checkboxes
  box.querySelectorAll("button").forEach(btn => {
    btn.addEventListener("click", () => {
      const act = btn.dataset.act;
      const eid = btn.dataset.eid;
      const ev = store.events.find(x => x.id === eid);
      if (!ev) return;

      if (act === "del") {
        store.events = store.events.filter(x => x.id !== eid);
        saveStore(store);
        renderAll();
        return;
      }
      if (act === "edit") {
        const u = prompt("증권사(주간사/가능 증권사) — 예: 미래에셋, NH, 키움", ev.underwriters || "");
        if (u === null) return;
        const d = prompt("균등 최소금액 — 예: 500,000원 (모르면 비워두기)", ev.minDeposit || "");
        if (d === null) return;
        ev.underwriters = u.trim();
        ev.minDeposit = d.trim();
        saveStore(store);
        renderAll();
        return;
      }
      if (act === "ics") {
        downloadICS([ev], ($("#calName")?.value || "공모 알림"), `공모알림_${safeFile(ev.corp_name)}.ics`);
      }
    });
  });

  box.querySelectorAll('input[type="checkbox"][data-act="mcheck"]').forEach(chk => {
    chk.addEventListener("change", () => {
      const eid = chk.dataset.eid;
      const mid = chk.dataset.mid;
      const ev = store.events.find(x => x.id === eid);
      if (!ev) return;
      ev.perMember = ev.perMember || {};
      ev.perMember[mid] = chk.checked;
      saveStore(store);
    });
  });
}

/* ---------- Import (Today ~ end of next month) ---------- */
async function importDartRange() {
  const status = $("#import-status");
  const now = new Date();
  const rangeStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const rangeEnd = endOfNextMonth(now);

  const months = monthsBetween(rangeStart, rangeEnd);
  const label = `${rangeStart.getFullYear()}-${pad2(rangeStart.getMonth()+1)}-${pad2(rangeStart.getDate())} ~ ${rangeEnd.getFullYear()}-${pad2(rangeEnd.getMonth()+1)}-${pad2(rangeEnd.getDate())}`;

  try {
    status.textContent = `불러오는 중… (${label})`;

    // 월별로 가져오기
    const allItems = [];
    for (const { y, m } of months) {
      const mm = pad2(m);
      const json = await fetchJsonNoStore(`${API_DART}?year=${y}&month=${mm}`);
      const items = Array.isArray(json.items) ? json.items : [];
      allItems.push(...items);
    }

    // 범위 필터 + 중복 제거
    const seen = new Set();
    const filtered = allItems
      .filter(it => it && it.corp_name && it.sbd_start && it.sbd_end)
      .filter(it => overlapsRange(it.sbd_start, it.sbd_end, rangeStart, rangeEnd))
      .filter(it => {
        const key = `${it.corp_name}|${it.sbd_start}|${it.sbd_end}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

    // upsert
    const before = store.events.length;
    const byId = new Map(store.events.map(e => [e.id, e]));

    for (const it of filtered) {
      const id = `dart:${it.corp_name}:${it.sbd_start}:${it.sbd_end}`;
      const existing = byId.get(id);

      if (existing) {
        existing.market = it.market || existing.market;
        existing.market_short = it.market_short || existing.market_short;
        existing.sbd_start = it.sbd_start;
        existing.sbd_end = it.sbd_end;
      } else {
        const perMember = {};
        store.members.forEach(m => { perMember[m.id] = false; });

        store.events.push({
          id,
          source: "dart",
          corp_name: it.corp_name,
          market_short: it.market_short || "",
          market: it.market || "",
          sbd_start: it.sbd_start,
          sbd_end: it.sbd_end,
          underwriters: "",
          minDeposit: "",
          perMember
        });
      }
    }

    saveStore(store);
    renderEvents();

    const addedOrUpdated = store.events.length - before; // 대략(새로 추가된 개수)
    status.textContent = `완료! ${filtered.length}개 반영됨 (범위: ${label})`;

  } catch (err) {
    console.error(err);
    status.textContent = `가져오기 실패: ${err?.message || String(err)}`;
    alert(`DART 가져오기 실패: ${err?.message || String(err)}`);
  }
}

/* ---------- Export: ICS ---------- */
function formatICSDate(ymdStr) {
  // all-day: YYYYMMDD
  return ymdStr.replaceAll("-", "");
}

function nextDayYMD(ymdStr) {
  const d = parseYmd(ymdStr);
  const nd = addDays(d, 1);
  const y = nd.getFullYear();
  const m = nd.getMonth() + 1;
  const day = nd.getDate();
  return ymd(y, m, day);
}

function escapeICS(s) {
  return String(s || "")
    .replaceAll("\\", "\\\\")
    .replaceAll("\n", "\\n")
    .replaceAll(",", "\\,")
    .replaceAll(";", "\\;");
}

function buildICS(events, calName) {
  const lines = [];
  lines.push("BEGIN:VCALENDAR");
  lines.push("VERSION:2.0");
  lines.push("PRODID:-//ipo-alarm//KR//EN");
  lines.push("CALSCALE:GREGORIAN");
  lines.push("METHOD:PUBLISH");
  lines.push(`X-WR-CALNAME:${escapeICS(calName)}`);

  const dtstamp = new Date().toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";

  for (const ev of events) {
    const title = `[공모] ${ev.corp_name} 청약`;
    const desc = [
      `회사: ${ev.corp_name}`,
      `청약: ${ev.sbd_start} ~ ${ev.sbd_end}`,
      `증권사: ${ev.underwriters?.trim() ? ev.underwriters.trim() : "(없음/미입력)"}`,
      `균등 최소금액: ${ev.minDeposit?.trim() ? ev.minDeposit.trim() : "(공모가 미확정/미입력)"}`,
      "",
      "※ 최종 정보는 공시로 확인"
    ].join("\n");

    const dtStart = formatICSDate(ev.sbd_start);
    // iCalendar DTEND is exclusive for all-day events
    const dtEnd = formatICSDate(nextDayYMD(ev.sbd_end));

    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${escapeICS(ev.id)}@ipo-alarm`);
    lines.push(`DTSTAMP:${dtstamp}`);
    lines.push(`SUMMARY:${escapeICS(title)}`);
    lines.push(`DESCRIPTION:${escapeICS(desc)}`);
    lines.push(`DTSTART;VALUE=DATE:${dtStart}`);
    lines.push(`DTEND;VALUE=DATE:${dtEnd}`);
    lines.push("END:VEVENT");
  }

  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
}

function downloadTextFile(content, filename, mime = "text/plain") {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function downloadICS(events, calName, filename) {
  const ics = buildICS(events, calName);
  downloadTextFile(ics, filename, "text/calendar;charset=utf-8");
}

/* ---------- Export: Reminders text (for Shortcuts) ---------- */
function buildRemindersText(events) {
  // 단축어에서: 텍스트를 줄 단위로 쪼개서 미리알림 생성하면 편함
  const lines = [];
  const sorted = [...events].sort((a, b) => (a.sbd_start || "").localeCompare(b.sbd_start || ""));
  for (const ev of sorted) {
    lines.push(`[공모] ${ev.corp_name} (${ev.sbd_start}~${ev.sbd_end})`);
    lines.push(`- 증권사: ${ev.underwriters?.trim() ? ev.underwriters.trim() : "(없음/미입력)"}`);
    lines.push(`- 균등 최소금액: ${ev.minDeposit?.trim() ? ev.minDeposit.trim() : "(공모가 미확정/미입력)"}`);
    lines.push("");
  }
  return lines.join("\n").trim();
}

async function copyToClipboard(text) {
  await navigator.clipboard.writeText(text);
}

/* ---------- “완전 초기화” ---------- */
async function hardReset() {
  // 1) localStorage 제거
  localStorage.removeItem(LS_KEY);

  // 2) 서비스워커 unregister
  if ("serviceWorker" in navigator) {
    try {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(r => r.unregister()));
    } catch {}
  }

  // 3) Cache Storage 제거
  if (window.caches) {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    } catch {}
  }

  // 4) 새로고침
  location.reload();
}

/* ---------- Events: Family form ---------- */
function initFamilyForm() {
  const form = $("#family-form");
  if (!form) return;

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = $("#memberName").value.trim();
    const note = $("#brokerNote").value.trim();
    if (!name) return;

    const m = { id: uid(), name, brokerNote: note };
    store.members.push(m);

    // 기존 이벤트에도 체크칸 추가
    store.events.forEach(ev => {
      ev.perMember = ev.perMember || {};
      ev.perMember[m.id] = false;
    });

    saveStore(store);
    form.reset();
    renderAll();
  });
}

/* ---------- Buttons ---------- */
function initButtons() {
  $("#import-dart-range")?.addEventListener("click", importDartRange);

  $("#reset-store")?.addEventListener("click", async () => {
    const ok = confirm("정말 완전 초기화할까요?\n(저장된 일정/체크/캐시가 모두 삭제되고 새로고침됩니다)");
    if (!ok) return;
    await hardReset();
  });

  $("#export-all")?.addEventListener("click", () => {
    const calName = $("#calName")?.value || "공모 알림";
    downloadICS(store.events, calName, "공모알림_전체.ics");
  });

  $("#copy-reminders-text")?.addEventListener("click", async () => {
    const box = $("#copy-status");
    try {
      const text = buildRemindersText(store.events);
      if (!text) {
        box.textContent = "복사할 일정이 없어요.";
        return;
      }
      await copyToClipboard(text);
      box.textContent = "복사 완료! (미리알림 단축어에서 붙여넣어 사용하세요)";
    } catch (e) {
      box.textContent = "복사 실패(브라우저 권한 문제일 수 있어요).";
    }
  });
}

/* ---------- Util ---------- */
function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function safeFile(s) {
  return String(s || "event").replace(/[\\/:*?"<>|]/g, "_");
}

/* ---------- Render all ---------- */
function renderAll() {
  renderFamily();
  renderEvents();
}

/* ---------- Init ---------- */
document.addEventListener("DOMContentLoaded", () => {
  initTabs();
  initFamilyForm();
  initButtons();
  renderAll();
});
