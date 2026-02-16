/* ===== 공모 알림 (vNext) =====
- 오늘~다음달 말: DART (이번달+다음달) 합치기
- 증권사/금액: Netlify Function ipo-meta로 보조 정보 합치기
- 수동 추가 폼 제거: 가져온 일정만 관리
*/

const LS_KEY = "ipo_app_vnext";

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
  return { members, events: [], metaCache: {} };
}

window.store = loadStore() || defaultStore();
saveStore(window.store);

function $(id) { return document.getElementById(id); }
function escHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, m => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[m]));
}
function norm(s) { return String(s ?? "").replace(/\s+/g, "").trim(); }
function pad2(n) { return String(n).padStart(2, "0"); }

function kstNowDate() {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return new Date(Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate()));
}
function ymd(d) {
  const yyyy = d.getUTCFullYear();
  const mm = pad2(d.getUTCMonth() + 1);
  const dd = pad2(d.getUTCDate());
  return `${yyyy}-${mm}-${dd}`;
}
function endOfNextMonthKST() {
  const base = kstNowDate();
  const y = base.getUTCFullYear();
  const m = base.getUTCMonth(); // 0-based
  // next month end = day 0 of month+2
  return new Date(Date.UTC(y, m + 2, 0));
}
function addDaysYMD(ymdStr, days) {
  const [y,m,d] = ymdStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m-1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return ymd(dt);
}

function fmtKRW(n) {
  if (n == null || Number.isNaN(Number(n))) return "";
  return Number(n).toLocaleString("ko-KR") + "원";
}

function stableEventId(e) {
  return "e-" + btoa(unescape(encodeURIComponent(`${e.corp_name}|${e.sbd_start}|${e.sbd_end}`))).replace(/=+$/,"");
}

/* ===== Tabs ===== */
function initTabs() {
  document.querySelectorAll(".tab").forEach(btn => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.tab;
      document.querySelectorAll(".tab").forEach(b => b.classList.toggle("active", b === btn));
      document.querySelectorAll(".panel").forEach(p => p.classList.toggle("active", p.id === `tab-${tab}`));
    });
  });
}

/* ===== Render family ===== */
function renderFamily() {
  const box = $("family-list");
  box.innerHTML = "";

  window.store.members.forEach(m => {
    const row = document.createElement("div");
    row.className = "item";
    row.innerHTML = `
      <div style="display:flex;justify-content:space-between;gap:10px;align-items:center;">
        <div>
          <div style="font-weight:700;">${escHtml(m.name)}</div>
          <div class="muted">${escHtml(m.brokerNote || "")}</div>
        </div>
        <div style="display:flex;gap:8px;align-items:center;">
          <button class="btn" data-act="rename" data-id="${escHtml(m.id)}">이름</button>
          <button class="btn" data-act="note" data-id="${escHtml(m.id)}">메모</button>
          <button class="btn" data-act="del" data-id="${escHtml(m.id)}">삭제</button>
        </div>
      </div>
    `;
    box.appendChild(row);
  });

  box.querySelectorAll("button").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      const act = btn.dataset.act;
      const m = window.store.members.find(x => x.id === id);
      if (!m) return;

      if (act === "del") {
        window.store.members = window.store.members.filter(x => x.id !== id);
        window.store.events.forEach(e => { if (e.perMember) delete e.perMember[id]; });
        saveStore(window.store);
        renderAll();
      } else if (act === "rename") {
        const newName = prompt("이름", m.name);
        if (newName && newName.trim()) {
          m.name = newName.trim();
          saveStore(window.store);
          renderAll();
        }
      } else if (act === "note") {
        const newNote = prompt("증권사 메모", m.brokerNote || "");
        if (newNote != null) {
          m.brokerNote = newNote.trim();
          saveStore(window.store);
          renderAll();
        }
      }
    });
  });
}

/* ===== Render events ===== */
function renderEvents() {
  const box = $("events-list");
  box.innerHTML = "";

  const today = ymd(kstNowDate());
  const end = ymd(endOfNextMonthKST());

  const events = (window.store.events || [])
    .filter(e => (e.sbd_end || "") >= today && (e.sbd_start || "") <= end)
    .sort((a,b) => String(a.sbd_start).localeCompare(String(b.sbd_start)));

  if (events.length === 0) {
    box.innerHTML = `<div class="muted">아직 가져온 일정이 없어요. 위 버튼을 눌러 자동 채우기!</div>`;
    return;
  }

  const memberIds = window.store.members.map(m => m.id);

  events.forEach(e => {
    if (!e.perMember) e.perMember = {};
    memberIds.forEach(id => { if (!e.perMember[id]) e.perMember[id] = { done:false }; });

    const brokers = e.brokers || "";
    const dep = e.min_deposit_krw ?? null;
    const depNote = e.min_deposit_note || "";
    const familyTotal = (dep != null) ? dep * window.store.members.length : null;

    const card = document.createElement("div");
    card.className = "item";
    card.innerHTML = `
      <div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start;">
        <div style="flex:1;">
          <div style="font-weight:800;font-size:16px;">${escHtml(e.corp_name)}</div>
          <div class="muted">청약: ${escHtml(e.sbd_start)} ~ ${escHtml(e.sbd_end)}</div>
          ${brokers ? `<div class="muted">증권사: ${escHtml(brokers)}</div>` : `<div class="muted">증권사: (불러오는 중/없음)</div>`}
          ${dep != null
            ? `<div class="muted">균등 최소(추정): <b>${escHtml(fmtKRW(dep))}</b> / 1인
               ${familyTotal != null ? ` · 4인합: <b>${escHtml(fmtKRW(familyTotal))}</b>` : ""}</div>`
            : `<div class="muted">균등 최소금액: (공모가 미확정/정보없음)</div>`
          }
          ${depNote ? `<div class="muted">${escHtml(depNote)}</div>` : ""}
        </div>
        <div style="display:flex;gap:8px;align-items:center;">
          <button class="btn" data-act="ics" data-id="${escHtml(e.id)}">캘린더</button>
        </div>
      </div>

      <div style="margin-top:10px;display:flex;flex-wrap:wrap;gap:10px;align-items:center;">
        ${window.store.members.map(m => {
          const checked = e.perMember?.[m.id]?.done ? "checked" : "";
          return `
            <label class="inline" style="gap:6px;">
              <input type="checkbox" data-act="done" data-eid="${escHtml(e.id)}" data-mid="${escHtml(m.id)}" ${checked} />
              ${escHtml(m.name)}
            </label>
          `;
        }).join("")}
      </div>
    `;

    box.appendChild(card);
  });

  // handlers
  box.querySelectorAll("input[type=checkbox][data-act=done]").forEach(cb => {
    cb.addEventListener("change", () => {
      const eid = cb.dataset.eid;
      const mid = cb.dataset.mid;
      const ev = window.store.events.find(x => x.id === eid);
      if (!ev) return;
      if (!ev.perMember) ev.perMember = {};
      if (!ev.perMember[mid]) ev.perMember[mid] = {};
      ev.perMember[mid].done = cb.checked;
      saveStore(window.store);
    });
  });

  box.querySelectorAll("button[data-act=ics]").forEach(btn => {
    btn.addEventListener("click", () => {
      const eid = btn.dataset.id;
      const ev = window.store.events.find(x => x.id === eid);
      if (!ev) return;
      downloadICS([ev], `공모_${ev.corp_name}_${ev.sbd_start}.ics`, { includeAlarms:true });
    });
  });
}

/* ===== Import logic ===== */
async function fetchJson(url) {
  const res = await fetch(url, { cache: "no-store" });
  const data = await res.json().catch(() => null);
  if (!data || data.ok !== true) {
    const msg = data?.error || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

async function importNextToNextMonth() {
  const status = $("import-status");
  status.textContent = "불러오는 중… (DART 일정 + 증권사/금액 합치는 중)";

  // 1) 이번달 + 다음달 DART 호출
  const base = kstNowDate(); // UTC date with KST day
  const y1 = base.getUTCFullYear();
  const m1 = base.getUTCMonth() + 1;
  const next = new Date(Date.UTC(y1, base.getUTCMonth() + 1, 1));
  const y2 = next.getUTCFullYear();
  const m2 = next.getUTCMonth() + 1;

  const a = await fetchJson(`/.netlify/functions/dart-ipo?year=${y1}&month=${pad2(m1)}`);
  const b = await fetchJson(`/.netlify/functions/dart-ipo?year=${y2}&month=${pad2(m2)}`);

  let items = [...(a.items || []), ...(b.items || [])];

  // 기간: 오늘~다음달 말
  const today = ymd(kstNowDate());
  const end = ymd(endOfNextMonthKST());
  items = items.filter(it => (it.sbd_end || "") >= today && (it.sbd_start || "") <= end);

  // 중복 제거
  const seen = new Set();
  items = items.filter(it => {
    const k = `${norm(it.corp_name)}|${it.sbd_start}|${it.sbd_end}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  // 2) 증권사/금액 메타 합치기
  // 이름 목록 생성
  const names = items.map(x => x.corp_name).filter(Boolean);

  // meta 캐시(로컬) 먼저 적용
  const metaCache = window.store.metaCache || {};
  const need = [];
  const meta = {};

  names.forEach(n => {
    const key = norm(n);
    const cached = metaCache[key];
    if (cached && cached.cached_at && (Date.now() - cached.cached_at) < 24*60*60*1000) {
      meta[key] = cached;
    } else {
      need.push(n);
    }
  });

  if (need.length > 0) {
    try {
      // names 파라미터는 | 로 연결
      const param = encodeURIComponent(need.join("|"));
      const m = await fetchJson(`/.netlify/functions/ipo-meta?names=${param}`);

      (m.items || []).forEach(x => {
        const key = norm(x.corp_name);
        meta[key] = x;
        metaCache[key] = { ...x, cached_at: Date.now() };
      });

      window.store.metaCache = metaCache;
    } catch (e) {
      console.warn("ipo-meta failed:", e);
      // 메타 실패해도 일정은 살림
    }
  }

  // 3) store.events로 병합(기존 체크리스트 보존)
  const byKey = new Map(window.store.events.map(ev => {
    const k = `${norm(ev.corp_name)}|${ev.sbd_start}|${ev.sbd_end}`;
    return [k, ev];
  }));

  const merged = [];
  for (const it of items) {
    const k = `${norm(it.corp_name)}|${it.sbd_start}|${it.sbd_end}`;
    const old = byKey.get(k);

    const extra = meta[norm(it.corp_name)] || null;

    const baseEvent = {
      id: old?.id || stableEventId(it),
      corp_name: it.corp_name,
      sbd_start: it.sbd_start,
      sbd_end: it.sbd_end,
      market: it.market || "",
      market_short: it.market_short || "",
      perMember: old?.perMember || {},
      brokers: extra?.brokers || old?.brokers || "",
      offer_price_krw: extra?.offer_price_krw ?? old?.offer_price_krw ?? null,
      min_deposit_krw: extra?.min_deposit_krw ?? old?.min_deposit_krw ?? null,
      min_deposit_note: extra?.min_deposit_note || old?.min_deposit_note || "",
      source_hint: extra?.source_hint || old?.source_hint || "",
    };

    merged.push(baseEvent);
  }

  // store에 반영
  window.store.events = merged;
  saveStore(window.store);
  renderAll();

  status.textContent = `완료! ${merged.length}개 (오늘~다음달 말)`;
}

function clearImportedEvents() {
  if (!confirm("가져온 일정을 전부 지울까요? (가족 체크도 같이 삭제됨)")) return;
  window.store.events = [];
  saveStore(window.store);
  renderAll();
  const status = $("import-status");
  if (status) status.textContent = "초기화 완료";
}

/* ===== ICS Export ===== */
function icsEscape(s) {
  return String(s ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

function downloadBlob(text, filename, mime="text/plain") {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function toICSDate(ymdStr) {
  return ymdStr.replaceAll("-", "");
}

function buildDescription(ev) {
  const lines = [];
  if (ev.brokers) lines.push(`증권사: ${ev.brokers}`);
  if (ev.min_deposit_krw != null) {
    lines.push(`균등 최소(추정): ${fmtKRW(ev.min_deposit_krw)} / 1인`);
    lines.push(`가족 ${window.store.members.length}인 합(추정): ${fmtKRW(ev.min_deposit_krw * window.store.members.length)}`);
  } else {
    lines.push(`균등 최소금액: 정보없음/미확정`);
  }
  if (ev.source_hint) lines.push(`출처: ${ev.source_hint}`);
  lines.push(`* 최종 확정은 공시/증권사 공지로 확인`);
  return lines.join("\n");
}

function downloadICS(events, filename, opts={includeAlarms:true}) {
  const now = new Date().toISOString().replace(/[-:]/g,"").split(".")[0] + "Z";
  let out = "";
  out += "BEGIN:VCALENDAR\r\n";
  out += "VERSION:2.0\r\n";
  out += "PRODID:-//IPO Alert//KO//\r\n";
  out += "CALSCALE:GREGORIAN\r\n";

  for (const ev of events) {
    const uidv = `${ev.id}@ipo-alert`;
    const start = toICSDate(ev.sbd_start); // all-day
    // all-day DTEND is next day (exclusive)
    const endExclusive = toICSDate(addDaysYMD(ev.sbd_end, 1));

    out += "BEGIN:VEVENT\r\n";
    out += `UID:${icsEscape(uidv)}\r\n`;
    out += `DTSTAMP:${now}\r\n`;
    out += `SUMMARY:${icsEscape(`${ev.corp_name} 청약`)}\r\n`;
    out += `DTSTART;VALUE=DATE:${start}\r\n`;
    out += `DTEND;VALUE=DATE:${endExclusive}\r\n`;
    out += `DESCRIPTION:${icsEscape(buildDescription(ev))}\r\n`;

    if (opts.includeAlarms) {
      // 3일 전, 1일 전 알림
      out += "BEGIN:VALARM\r\n";
      out += "ACTION:DISPLAY\r\n";
      out += "DESCRIPTION:공모주 청약 준비\r\n";
      out += "TRIGGER:-P3D\r\n";
      out += "END:VALARM\r\n";

      out += "BEGIN:VALARM\r\n";
      out += "ACTION:DISPLAY\r\n";
      out += "DESCRIPTION:공모주 청약 D-1\r\n";
      out += "TRIGGER:-P1D\r\n";
      out += "END:VALARM\r\n";
    }

    out += "END:VEVENT\r\n";
  }

  out += "END:VCALENDAR\r\n";
  downloadBlob(out, filename, "text/calendar");
}

function downloadRemindersICS(events, filename) {
  // VTODO 기반 (기기마다 import 동작 다를 수 있음)
  const now = new Date().toISOString().replace(/[-:]/g,"").split(".")[0] + "Z";
  let out = "";
  out += "BEGIN:VCALENDAR\r\n";
  out += "VERSION:2.0\r\n";
  out += "PRODID:-//IPO Alert Reminders//KO//\r\n";
  out += "CALSCALE:GREGORIAN\r\n";

  for (const ev of events) {
    const uidv = `${ev.id}-todo@ipo-alert`;
    const due = toICSDate(addDaysYMD(ev.sbd_start, -1)); // 시작 1일 전

    out += "BEGIN:VTODO\r\n";
    out += `UID:${icsEscape(uidv)}\r\n`;
    out += `DTSTAMP:${now}\r\n`;
    out += `SUMMARY:${icsEscape(`${ev.corp_name} 청약 준비`)}\r\n`;
    out += `DUE;VALUE=DATE:${due}\r\n`;
    out += `DESCRIPTION:${icsEscape(buildDescription(ev))}\r\n`;
    out += "END:VTODO\r\n";
  }

  out += "END:VCALENDAR\r\n";
  downloadBlob(out, filename, "text/calendar");
}

/* ===== Shortcuts runner ===== */
function runShortcutForReminders() {
  // 단축어 이름: "공모주 미리알림 추가" (index.html 안내와 동일해야 함)
  const shortcutName = "공모주 미리알림 추가";

  // 단축어에 넘길 입력: Netlify function URL 하나만 넘기는 방식이 가장 안정적
  // 단축어에서 "URL 내용 가져오기"로 가져오면 됨.
  const base = kstNowDate();
  const y1 = base.getUTCFullYear();
  const m1 = base.getUTCMonth() + 1;
  const next = new Date(Date.UTC(y1, base.getUTCMonth() + 1, 1));
  const y2 = next.getUTCFullYear();
  const m2 = next.getUTCMonth() + 1;

  const payload = {
    source: "webapp",
    range: "today_to_end_of_next_month",
    urls: [
      `/.netlify/functions/dart-ipo?year=${y1}&month=${pad2(m1)}`,
      `/.netlify/functions/dart-ipo?year=${y2}&month=${pad2(m2)}`,
      `/.netlify/functions/ipo-meta`
    ],
    // 단축어가 바로 쓸 수 있게 현재 store.events도 함께 전달(옵션)
    events: window.store.events || []
  };

  const text = encodeURIComponent(JSON.stringify(payload));
  const url = `shortcuts://run-shortcut?name=${encodeURIComponent(shortcutName)}&input=text&text=${text}`;
  window.location.href = url;
}

/* ===== Family add ===== */
function initFamilyForm() {
  const form = $("family-form");
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = $("memberName").value.trim();
    const note = $("brokerNote").value.trim();
    if (!name) return;

    window.store.members.push({ id: uid(), name, brokerNote: note });
    $("memberName").value = "";
    $("brokerNote").value = "";
    saveStore(window.store);
    renderAll();
  });
}

/* ===== Export buttons ===== */
function initExport() {
  $("export-cal").addEventListener("click", () => {
    const today = ymd(kstNowDate());
    const end = ymd(endOfNextMonthKST());
    const events = (window.store.events || []).filter(e => (e.sbd_end||"") >= today && (e.sbd_start||"") <= end);
    downloadICS(events, `공모주_캘린더_${today}_to_${end}.ics`, { includeAlarms:true });
  });

  $("export-reminders-ics").addEventListener("click", () => {
    const today = ymd(kstNowDate());
    const end = ymd(endOfNextMonthKST());
    const events = (window.store.events || []).filter(e => (e.sbd_end||"") >= today && (e.sbd_start||"") <= end);
    downloadRemindersICS(events, `공모주_미리알림_${today}_to_${end}.ics`);
  });

  $("open-shortcut-help").addEventListener("click", () => {
    const box = $("shortcut-help");
    box.open = true;
    box.scrollIntoView({ behavior: "smooth", block: "start" });
  });

  $("run-shortcut").addEventListener("click", () => {
    runShortcutForReminders();
  });
}

/* ===== Render all ===== */
function renderAll() {
  renderFamily();
  renderEvents();
}

/* ===== Boot ===== */
window.addEventListener("DOMContentLoaded", () => {
  initTabs();
  initFamilyForm();
  initExport();

  $("import-dart").addEventListener("click", importNextToNextMonth);
  $("clear-events").addEventListener("click", clearImportedEvents);

  renderAll();
});
