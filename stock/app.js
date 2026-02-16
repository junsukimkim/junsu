const LS_KEY = "ipo_reminder_v1";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

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

let store = loadStore() ?? defaultStore();
saveStore(store);

// ---------- Tabs ----------
$$(".tab").forEach(btn => {
  btn.addEventListener("click", () => {
    $$(".tab").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");

    $$(".panel").forEach(p => p.classList.remove("active"));
    $("#tab-" + btn.dataset.tab).classList.add("active");
  });
});

// ---------- Render ----------
function fmtDate(yyyy_mm_dd) {
  return yyyy_mm_dd;
}

function ensureChecklists(event) {
  event.perMember ??= {};
  for (const m of store.members) {
    if (!event.perMember[m.id]) {
      event.perMember[m.id] = { cashChecked: false, applied: false };
    }
  }
}

function renderFamily() {
  const box = $("#family-list");
  box.innerHTML = "";

  store.members.forEach(m => {
    const el = document.createElement("div");
    el.className = "item";
    el.innerHTML = `
      <div class="left">
        <div><b>${escapeHtml(m.name)}</b></div>
        ${m.brokerNote ? `<div class="muted">${escapeHtml(m.brokerNote)}</div>` : `<div class="muted">증권사 메모 없음</div>`}
      </div>
      <div class="actions">
        <button class="small-btn" data-act="rename" data-id="${m.id}">이름수정</button>
        <button class="small-btn danger" data-act="del" data-id="${m.id}">삭제</button>
      </div>
    `;
    box.appendChild(el);
  });

  box.querySelectorAll("button").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      const act = btn.dataset.act;
      if (act === "del") {
        store.members = store.members.filter(x => x.id !== id);
        // 이벤트 체크리스트에서도 제거
        store.events.forEach(e => { if (e.perMember) delete e.perMember[id]; });
        saveStore(store);
        renderAll();
      } else if (act === "rename") {
        const m = store.members.find(x => x.id === id);
        if (!m) return;
        const newName = prompt("이름", m.name);
        if (newName && newName.trim()) {
          m.name = newName.trim();
          saveStore(store);
          renderAll();
        }
      }
    });
  });
}

function renderEvents() {
  const box = $("#events-list");
  box.innerHTML = "";

  const events = [...store.events].sort((a,b) => (a.startDate > b.startDate ? 1 : -1));

  events.forEach(e => {
    ensureChecklists(e);

    const el = document.createElement("div");
    el.className = "item";
    el.innerHTML = `
      <div class="left">
        <div><b>${escapeHtml(e.companyName)}</b> ${e.starred ? "⭐" : ""}</div>
        <div class="badge">청약 ${fmtDate(e.startDate)} ~ ${fmtDate(e.endDate)}</div>
        ${e.underwriters ? `<div class="muted">주간사: ${escapeHtml(e.underwriters)}</div>` : ""}
        ${e.memo ? `<div class="muted">메모: ${escapeHtml(e.memo)}</div>` : ""}
      </div>
      <div class="actions">
        <button class="small-btn" data-act="detail" data-id="${e.id}">상세/체크</button>
        <button class="small-btn" data-act="star" data-id="${e.id}">${e.starred ? "관심해제" : "관심"}</button>
        <button class="small-btn danger" data-act="del" data-id="${e.id}">삭제</button>
      </div>
    `;
    box.appendChild(el);
  });

  if (!events.length) {
    const empty = document.createElement("div");
    empty.className = "muted";
    empty.textContent = "아직 일정이 없어요. 위에서 하나 추가해봐!";
    box.appendChild(empty);
  }

  box.querySelectorAll("button").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      const act = btn.dataset.act;
      const e = store.events.find(x => x.id === id);
      if (!e) return;

      if (act === "del") {
        store.events = store.events.filter(x => x.id !== id);
        saveStore(store);
        renderAll();
      } else if (act === "star") {
        e.starred = !e.starred;
        saveStore(store);
        renderAll();
      } else if (act === "detail") {
        openEventModal(e);
      }
    });
  });
}

function renderAll() {
  // normalize
  store.events.forEach(ensureChecklists);
  saveStore(store);

  renderFamily();
  renderEvents();
}

renderAll();

// ---------- Forms ----------
$("#family-form").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const name = $("#memberName").value.trim();
  const brokerNote = $("#brokerNote").value.trim();
  if (!name) return;

  store.members.push({ id: uid(), name, brokerNote });
  // 기존 이벤트 체크리스트 슬롯 생성
  store.events.forEach(ensureChecklists);

  saveStore(store);
  $("#memberName").value = "";
  $("#brokerNote").value = "";
  renderAll();
});

$("#event-form").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const companyName = $("#companyName").value.trim();
  const startDate = $("#startDate").value;
  const endDate = $("#endDate").value;
  if (!companyName || !startDate || !endDate) return;

  const event = {
    id: uid(),
    companyName,
    startDate,
    endDate,
    underwriters: $("#underwriters").value.trim(),
    memo: $("#memo").value.trim(),
    starred: $("#starred").checked,
    perMember: {}
  };
  ensureChecklists(event);
  store.events.push(event);
  saveStore(store);

  ev.target.reset();
  $("#starred").checked = true;
  renderAll();
});

// ---------- Modal (detail/checklist) ----------
const modal = $("#modal");
$("#modal-close").addEventListener("click", closeModal);
modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });

function closeModal() {
  modal.classList.add("hidden");
  modal.setAttribute("aria-hidden", "true");
  $("#modal-body").innerHTML = "";
}

function openEventModal(event) {
  $("#modal-title").textContent = event.companyName;
  const body = $("#modal-body");
  body.innerHTML = `
    <div class="muted">청약 ${event.startDate} ~ ${event.endDate}</div>
    <div class="hr"></div>
    <div class="muted">가족 체크리스트</div>
    <div id="checklist"></div>
  `;

  const list = body.querySelector("#checklist");
  list.innerHTML = "";

  store.members.forEach(m => {
    const s = event.perMember?.[m.id] ?? { cashChecked:false, applied:false };

    const row = document.createElement("div");
    row.className = "item";
    row.innerHTML = `
      <div class="left">
        <div><b>${escapeHtml(m.name)}</b></div>
        ${m.brokerNote ? `<div class="muted">${escapeHtml(m.brokerNote)}</div>` : ""}
        <div class="checkbox-row">
          <label class="inline">
            <input type="checkbox" data-k="cashChecked" ${s.cashChecked ? "checked":""}/>
            예수금 확인
          </label>
          <label class="inline">
            <input type="checkbox" data-k="applied" ${s.applied ? "checked":""}/>
            청약 완료
          </label>
        </div>
      </div>
    `;

    row.querySelectorAll("input[type=checkbox]").forEach(cb => {
      cb.addEventListener("change", () => {
        const k = cb.dataset.k;
        event.perMember[m.id][k] = cb.checked;
        saveStore(store);
        renderEvents(); // list 반영
      });
    });

    list.appendChild(row);
  });

  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");
}

// ---------- ICS Export ----------
$("#export-starred").addEventListener("click", () => exportICS(true));
$("#export-all").addEventListener("click", () => exportICS(false));

function exportICS(onlyStarred) {
  const calName = ($("#calName").value || "공모 알림").trim();
  const selected = store.events.filter(e => onlyStarred ? e.starred : true);
  if (!selected.length) {
    alert("내보낼 일정이 없어요.");
    return;
  }

  const ics = buildICS(calName, selected);
  downloadText(`${calName.replace(/\s+/g,'_')}.ics`, ics, "text/calendar;charset=utf-8");
}

function buildICS(calName, events) {
  const now = new Date();
  const dtstamp = toICSUTC(now);

  const lines = [];
  lines.push("BEGIN:VCALENDAR");
  lines.push("VERSION:2.0");
  lines.push("PRODID:-//IPO Reminder//KO//EN");
  lines.push("CALSCALE:GREGORIAN");
  lines.push(`X-WR-CALNAME:${escapeICS(calName)}`);
  lines.push("X-WR-TIMEZONE:Asia/Seoul");

  for (const e of events) {
    // 1) 기간 표시(올데이)
    lines.push(...eventAllDayBlock(e, dtstamp));

    // 2) 알림용 3개 이벤트(각 1개 VALARM)
    lines.push(...reminderEventBlock(e, dtstamp, "dminus1", "청약 D-1", "내일 청약 시작", minusDaysAt(e.startDate, 1, 21, 0)));
    lines.push(...reminderEventBlock(e, dtstamp, "dday_am", "청약 시작", "오늘 청약 시작", atTime(e.startDate, 8, 30)));
    lines.push(...reminderEventBlock(e, dtstamp, "dday_pm", "마감 임박", "오늘 청약 마감 임박", atTime(e.endDate, 14, 50)));
  }

  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
}

function eventAllDayBlock(e, dtstamp) {
  const uidBase = `${e.id}-period@iporeminder.local`;
  const start = toICSDate(e.startDate);
  const endExclusive = toICSDate(addDays(e.endDate, 1)); // 올데이 DTEND는 다음날
  const summary = `청약 기간: ${e.companyName}`;
  const desc = [
    e.underwriters ? `주간사/증권사: ${e.underwriters}` : "",
    e.memo ? `메모: ${e.memo}` : "",
    "※ 최종 일정은 공식 공지로 확인"
  ].filter(Boolean).join("\\n");

  return [
    "BEGIN:VEVENT",
    `UID:${uidBase}`,
    `DTSTAMP:${dtstamp}`,
    `SUMMARY:${escapeICS(summary)}`,
    `DESCRIPTION:${escapeICS(desc)}`,
    `DTSTART;VALUE=DATE:${start}`,
    `DTEND;VALUE=DATE:${endExclusive}`,
    "END:VEVENT"
  ];
}

function reminderEventBlock(e, dtstamp, kind, titlePrefix, bodyPrefix, dateObj) {
  // dateObj는 JS Date(로컬) -> Asia/Seoul로 '표시용' 생성
  const uidBase = `${e.id}-${kind}@iporeminder.local`;
  const start = toICSLocalSeoul(dateObj);
  const summary = `${titlePrefix}: ${e.companyName}`;
  const desc = [
    `${bodyPrefix} — ${e.companyName}`,
    e.underwriters ? `주간사/증권사: ${e.underwriters}` : "",
    e.memo ? `메모: ${e.memo}` : "",
    "체크리스트: 가족별 예수금 확인/청약 완료"
  ].filter(Boolean).join("\\n");

  return [
    "BEGIN:VEVENT",
    `UID:${uidBase}`,
    `DTSTAMP:${dtstamp}`,
    `SUMMARY:${escapeICS(summary)}`,
    `DESCRIPTION:${escapeICS(desc)}`,
    `DTSTART;TZID=Asia/Seoul:${start}`,
    `DURATION:PT5M`,
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    `DESCRIPTION:${escapeICS(summary)}`,
    "TRIGGER:-PT0M",
    "END:VALARM",
    "END:VEVENT"
  ];
}

// ---------- Date helpers ----------
function atTime(yyyy_mm_dd, hh, mm) {
  const d = new Date(`${yyyy_mm_dd}T00:00:00`);
  d.setHours(hh, mm, 0, 0);
  return d;
}

function minusDaysAt(yyyy_mm_dd, days, hh, mm) {
  const d = atTime(yyyy_mm_dd, hh, mm);
  d.setDate(d.getDate() - days);
  return d;
}

function addDays(yyyy_mm_dd, add) {
  const d = new Date(`${yyyy_mm_dd}T00:00:00`);
  d.setDate(d.getDate() + add);
  return d.toISOString().slice(0,10);
}

function toICSDate(yyyy_mm_dd) {
  return yyyy_mm_dd.replaceAll("-", "");
}

function toICSUTC(d) {
  // YYYYMMDDTHHMMSSZ
  const pad = (n) => String(n).padStart(2,"0");
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth()+1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

function toICSLocalSeoul(d) {
  // 로컬 시간을 그대로 YYYYMMDDTHHMMSS 로 출력 (TZID=Asia/Seoul 사용)
  const pad = (n) => String(n).padStart(2,"0");
  return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

// ---------- Utils ----------
function downloadText(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (m) => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[m]));
}

function escapeICS(s) {
  return String(s)
    .replaceAll("\\", "\\\\")
    .replaceAll("\n", "\\n")
    .replaceAll(",", "\\,")
    .replaceAll(";", "\\;");
}
document.querySelector("#import-dart")?.addEventListener("click", async () => {
  const year = String(document.querySelector("#dart-year")?.value || "").trim();
  const month = String(document.querySelector("#dart-month")?.value || "").trim().padStart(2, "0");
  const statusEl = document.querySelector("#dart-status");

  try {
    if (statusEl) statusEl.textContent = "가져오는 중…";

    // _redirects 안 썼으면 아래 줄을 이걸로 바꿔:
    // const r = await fetch(`/.netlify/functions/dart-ipo?year=${year}&month=${month}`);
    const r = await fetch(`/api/dart-ipo?year=${year}&month=${month}`);

    const data = await r.json();
    if (!data.ok) throw new Error(data.error || "import failed");

    const existingKey = new Set((store.events || []).map(e => `${e.companyName}|${e.startDate}`));
    let added = 0;

    for (const it of data.items || []) {
      const key = `${it.companyName}|${it.startDate}`;
      if (existingKey.has(key)) continue;

      const memoParts = [];
      if (it.payDate) memoParts.push(`납입: ${it.payDate}`);
      if (it.underwriters) memoParts.push(`주관: ${it.underwriters}`);
      if (it.dartViewerUrl) memoParts.push(`DART: ${it.dartViewerUrl}`);

      const ev = {
        id: uid(),
        companyName: it.companyName,
        startDate: it.startDate,
        endDate: it.endDate,
        underwriters: it.underwriters || "",
        memo: memoParts.join(" | "),
        starred: true,
        perMember: {}
      };

      ensureChecklists(ev);

      store.events.push(ev);
      existingKey.add(key);
      added++;
    }

    saveStore(store);
    renderAll();

    if (statusEl) statusEl.textContent = `완료: ${added}개 추가됨`;
  } catch (err) {
    console.error(err);
    if (statusEl) statusEl.textContent = `실패: ${err.message || err}`;
    alert(`DART 가져오기 실패: ${err.message || err}`);
  }
});

document.addEventListener("DOMContentLoaded", () => {
  const btn = document.getElementById("import-dart");
  const status = document.getElementById("import-status");
  if (!btn) return;

  btn.addEventListener("click", async () => {
    try {
      btn.disabled = true;
      if (status) status.textContent = "불러오는 중…";

      // 원하는 년/월로 바꾸고 싶으면 여기만 수정
      const year = "2026";
      const month = "02";

      const res = await fetch(`/api/dart-ipo?year=${year}&month=${month}`);
      const data = await res.json();

      if (!data.ok) throw new Error(data.error || "import failed");

      // ✅ 너 앱이 store/events 구조일 때
      window.store = window.store || { events: [] };

      const existing = new Set((store.events || []).map(e => `${e.companyName}|${e.startDate}|${e.endDate}`));
      let added = 0;

      for (const it of data.items || []) {
        const companyName = it.corp_name;
        const startDate = it.sbd_start;
        const endDate = it.sbd_end;

        const key = `${companyName}|${startDate}|${endDate}`;
        if (existing.has(key)) continue;

        const ev = {
          id: (typeof uid === "function") ? uid() : crypto.randomUUID(),
          companyName,
          startDate,
          endDate,
          market: it.market,
          memo: `DART 청약달력 (${it.market_short})`,
          starred: true,
          perMember: {}
        };

        store.events.push(ev);
        existing.add(key);
        added++;
      }

      // 저장/리렌더 (너 앱에 함수가 있으면 사용)
      if (typeof saveStore === "function") saveStore(store);
      else localStorage.setItem("store", JSON.stringify(store));

      if (typeof renderAll === "function") renderAll();

      if (status) status.textContent = `완료! ${added}개 추가됨`;
    } catch (e) {
      console.error(e);
      if (status) status.textContent = `실패: ${e.message || e}`;
      alert(`가져오기 실패: ${e.message || e}`);
    } finally {
      btn.disabled = false;
    }
  });
});

// ===== DART 원클릭 가져오기 =====
document.addEventListener("DOMContentLoaded", () => {
  const btn = document.getElementById("import-dart");
  const status = document.getElementById("import-status");
  if (!btn) return;

  btn.addEventListener("click", async () => {
    try {
      btn.disabled = true;
      if (status) status.textContent = "DART에서 불러오는 중…";

      // 1) 가져올 년/월 (기본: 이번 달)
      const now = new Date();
      const year = String(now.getFullYear());
      const month = String(now.getMonth() + 1).padStart(2, "0");

      // 2) API 호출 (redirects가 안 됐으면 아래 줄을 functions로 바꿔도 됨)
      const res = await fetch(`/api/dart-ipo?year=${year}&month=${month}`);
      // const res = await fetch(`/.netlify/functions/dart-ipo?year=${year}&month=${month}`);

      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "가져오기 실패");

      // 3) 중복 방지용 키
      const existing = new Set(
        (store.events || []).map(e => `${e.title}|${e.start}|${e.end}`)
      );

      let added = 0;

      // 4) items -> store.events로 변환
      for (const it of (data.items || [])) {
        const title = `${it.corp_name} 청약 (${it.market_short})`;
        const start = it.sbd_start; // "YYYY-MM-DD"
        const end = it.sbd_end;

        const key = `${title}|${start}|${end}`;
        if (existing.has(key)) continue;

        const ev = {
          id: uid(),
          title,
          start,   // 네 앱이 쓰는 필드명이 startDate면 알려줘. 맞춰줄게.
          end,
          note: `출처: DART 청약달력`,
          perMember: {} // 가족별 체크리스트 구조 유지
        };

        store.events.push(ev);
        existing.add(key);
        added++;
      }

      saveStore(store);
      renderAll();

      if (status) status.textContent = `완료! ${added}개 추가됨 (${year}-${month})`;
      if (added === 0 && status) status.textContent += " (추가할 새 일정이 없거나 0건일 수 있음)";
    } catch (e) {
      console.error(e);
      if (status) status.textContent = `실패: ${e.message || e}`;
      alert(`DART 가져오기 실패: ${e.message || e}`);
    } finally {
      btn.disabled = false;
    }
  });
});
