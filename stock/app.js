/* 공모 알림 (4인가족) - app.js
   기능:
   - 일정 추가/삭제
   - 가족 추가/이름변경/삭제
   - 가족별 체크리스트(예수금 확인 / 청약 완료)
   - .ics 내보내기(관심/전체)
   - DART 청약달력 원클릭 가져오기 (/api/dart-ipo or /.netlify/functions/dart-ipo)
*/

const LS_KEY = "ipo4_store_v3";

function uid() {
  return (crypto?.randomUUID?.() ?? ("id-" + Math.random().toString(16).slice(2)));
}
function loadStore() {
  const raw = localStorage.getItem(LS_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
function saveStore(s) {
  localStorage.setItem(LS_KEY, JSON.stringify(s));
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
function esc(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
function ymdToDate(ymd) {
  // "YYYY-MM-DD"
  const [y, m, d] = (ymd || "").split("-").map(n => parseInt(n, 10));
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}
function dateToYMD(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function ensureEventPerMember(ev, members) {
  ev.perMember = ev.perMember || {};
  for (const m of members) {
    if (!ev.perMember[m.id]) {
      ev.perMember[m.id] = {
        funded: false,   // 예수금 확인
        applied: false,  // 청약 완료
      };
    } else {
      ev.perMember[m.id].funded = !!ev.perMember[m.id].funded;
      ev.perMember[m.id].applied = !!ev.perMember[m.id].applied;
    }
  }
}
function normalizeEvent(ev) {
  // 필드 안전장치
  ev.companyName = String(ev.companyName || "").trim();
  ev.startDate = String(ev.startDate || "");
  ev.endDate = String(ev.endDate || "");
  ev.underwriters = String(ev.underwriters || "");
  ev.memo = String(ev.memo || "");
  ev.starred = !!ev.starred;
  ev.perMember = ev.perMember || {};
  return ev;
}

// store 초기화
let store = loadStore() || defaultStore();
store.members = store.members || [];
store.events = (store.events || []).map(normalizeEvent);

// 개발자도구에서 보고 싶으면 콘솔에서 window.store 확인 가능
window.store = store;

// DOM refs
const $ = (sel) => document.querySelector(sel);
const tabs = document.querySelectorAll(".tab");
const panels = document.querySelectorAll(".panel");

const eventForm = $("#event-form");
const eventsList = $("#events-list");

const familyForm = $("#family-form");
const familyList = $("#family-list");

const exportStarredBtn = $("#export-starred");
const exportAllBtn = $("#export-all");
const calNameInput = $("#calName");

const dartYear = $("#dart-year");
const dartMonth = $("#dart-month");
const dartBtn = $("#import-dart");
const dartStatus = $("#import-status");

// 초기: 년/월 기본값 세팅
(function initDartInputs() {
  const now = new Date();
  if (dartYear) dartYear.value = String(now.getFullYear());
  if (dartMonth) dartMonth.value = String(now.getMonth() + 1);
})();

// 탭 전환
function setActiveTab(tabName) {
  tabs.forEach(b => b.classList.toggle("active", b.dataset.tab === tabName));
  panels.forEach(p => p.classList.toggle("active", p.id === `tab-${tabName}`));
}
tabs.forEach(b => b.addEventListener("click", () => setActiveTab(b.dataset.tab)));

// 렌더
function renderAll() {
  // 모든 이벤트에 멤버 체크리스트 보정
  for (const ev of store.events) ensureEventPerMember(ev, store.members);

  renderEvents();
  renderFamily();
}
function renderEvents() {
  const arr = [...store.events].sort((a, b) => {
    const da = a.startDate || "9999-99-99";
    const db = b.startDate || "9999-99-99";
    if (da !== db) return da.localeCompare(db);
    return (a.companyName || "").localeCompare(b.companyName || "");
  });

  if (!arr.length) {
    eventsList.innerHTML = `<div class="muted">등록된 일정이 없어요.</div>`;
    return;
  }

  eventsList.innerHTML = arr.map(ev => {
    const star = ev.starred ? "⭐" : "☆";
    const range = `${esc(ev.startDate)} ~ ${esc(ev.endDate)}`;
    const uw = ev.underwriters ? `<div class="muted">주간사: ${esc(ev.underwriters)}</div>` : "";
    const memo = ev.memo ? `<div class="muted">메모: ${esc(ev.memo)}</div>` : "";

    const membersHtml = store.members.map(m => {
      const st = ev.perMember?.[m.id] || { funded: false, applied: false };
      return `
        <div class="row space" style="align-items:center;">
          <div>
            <b>${esc(m.name)}</b>
            ${m.brokerNote ? `<small class="muted">(${esc(m.brokerNote)})</small>` : ""}
          </div>
          <div class="row" style="gap:10px;">
            <label class="inline">
              <input type="checkbox" data-act="chk" data-eid="${esc(ev.id)}" data-mid="${esc(m.id)}" data-key="funded" ${st.funded ? "checked" : ""} />
              예수금
            </label>
            <label class="inline">
              <input type="checkbox" data-act="chk" data-eid="${esc(ev.id)}" data-mid="${esc(m.id)}" data-key="applied" ${st.applied ? "checked" : ""} />
              청약완료
            </label>
          </div>
        </div>
      `;
    }).join("");

    return `
      <div class="item" data-eid="${esc(ev.id)}">
        <div class="row space">
          <div>
            <div style="display:flex; gap:8px; align-items:center;">
              <button class="icon-btn" type="button" data-act="star" data-eid="${esc(ev.id)}" aria-label="star">${star}</button>
              <b>${esc(ev.companyName)}</b>
              <small class="muted">${range}</small>
            </div>
            ${uw}
            ${memo}
          </div>
          <div class="row" style="gap:8px;">
            <button class="btn" type="button" data-act="del" data-eid="${esc(ev.id)}">삭제</button>
          </div>
        </div>

        <div class="muted" style="margin-top:10px; font-weight:600;">가족 체크</div>
        <div class="list" style="margin-top:6px;">
          ${membersHtml}
        </div>
      </div>
    `;
  }).join("");
}
function renderFamily() {
  if (!store.members.length) {
    familyList.innerHTML = `<div class="muted">가족이 없어요. 추가해 주세요.</div>`;
    return;
  }

  familyList.innerHTML = store.members.map(m => {
    return `
      <div class="item">
        <div class="row space">
          <div>
            <b>${esc(m.name)}</b>
            ${m.brokerNote ? `<div class="muted">${esc(m.brokerNote)}</div>` : `<div class="muted">메모 없음</div>`}
          </div>
          <div class="row" style="gap:8px;">
            <button class="btn" type="button" data-act="rename-member" data-id="${esc(m.id)}">이름변경</button>
            <button class="btn" type="button" data-act="del-member" data-id="${esc(m.id)}">삭제</button>
          </div>
        </div>
      </div>
    `;
  }).join("");
}

// 이벤트 추가(수동)
eventForm?.addEventListener("submit", (e) => {
  e.preventDefault();

  const companyName = $("#companyName").value.trim();
  const startDate = $("#startDate").value;
  const endDate = $("#endDate").value;
  const underwriters = $("#underwriters").value.trim();
  const memo = $("#memo").value.trim();
  const starred = $("#starred").checked;

  if (!companyName || !startDate || !endDate) return;

  const ev = normalizeEvent({
    id: uid(),
    companyName,
    startDate,
    endDate,
    underwriters,
    memo,
    starred,
    perMember: {}
  });
  ensureEventPerMember(ev, store.members);

  store.events.push(ev);
  saveStore(store);
  renderAll();

  eventForm.reset();
  $("#starred").checked = true;
});

// events 클릭 핸들링(삭제/별/체크)
eventsList?.addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;

  const act = btn.dataset.act;
  const eid = btn.dataset.eid;
  if (!act || !eid) return;

  const ev = store.events.find(x => x.id === eid);
  if (!ev) return;

  if (act === "del") {
    if (!confirm("이 일정을 삭제할까요?")) return;
    store.events = store.events.filter(x => x.id !== eid);
    saveStore(store);
    renderAll();
  } else if (act === "star") {
    ev.starred = !ev.starred;
    saveStore(store);
    renderAll();
  }
});

// 체크박스 변경 핸들링
eventsList?.addEventListener("change", (e) => {
  const input = e.target;
  if (!(input instanceof HTMLInputElement)) return;
  if (input.dataset.act !== "chk") return;

  const eid = input.dataset.eid;
  const mid = input.dataset.mid;
  const key = input.dataset.key;
  if (!eid || !mid || !key) return;

  const ev = store.events.find(x => x.id === eid);
  if (!ev) return;

  ev.perMember = ev.perMember || {};
  ev.perMember[mid] = ev.perMember[mid] || { funded: false, applied: false };
  ev.perMember[mid][key] = input.checked;

  saveStore(store);
});

// 가족 추가
familyForm?.addEventListener("submit", (e) => {
  e.preventDefault();
  const name = $("#memberName").value.trim();
  const brokerNote = $("#brokerNote").value.trim();
  if (!name) return;

  const m = { id: uid(), name, brokerNote };
  store.members.push(m);

  // 모든 이벤트에 체크리스트 추가
  store.events.forEach(ev => ensureEventPerMember(ev, store.members));

  saveStore(store);
  renderAll();
  familyForm.reset();
});

// 가족 리스트 액션
familyList?.addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;

  const act = btn.dataset.act;
  const id = btn.dataset.id;
  if (!act || !id) return;

  if (act === "del-member") {
    const m = store.members.find(x => x.id === id);
    if (!m) return;
    if (!confirm(`${m.name} 삭제할까요? (모든 일정의 체크도 같이 삭제됨)`)) return;

    store.members = store.members.filter(x => x.id !== id);
    store.events.forEach(ev => { if (ev.perMember) delete ev.perMember[id]; });

    saveStore(store);
    renderAll();
  }

  if (act === "rename-member") {
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

// ICS 생성
function icsEscape(s) {
  return String(s ?? "")
    .replaceAll("\\", "\\\\")
    .replaceAll("\n", "\\n")
    .replaceAll(",", "\\,")
    .replaceAll(";", "\\;");
}
function toIcsDate(ymd) {
  // all-day: YYYYMMDD
  return String(ymd).replaceAll("-", "");
}
function downloadText(filename, text) {
  const blob = new Blob([text], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
function buildIcs(events, calName) {
  const dtstamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";

  const lines = [];
  lines.push("BEGIN:VCALENDAR");
  lines.push("VERSION:2.0");
  lines.push("PRODID:-//ipo4//calendar//KO");
  lines.push("CALSCALE:GREGORIAN");
  lines.push(`X-WR-CALNAME:${icsEscape(calName || "공모 알림")}`);

  for (const ev of events) {
    const start = ymdToDate(ev.startDate);
    const end = ymdToDate(ev.endDate);
    if (!start || !end) continue;

    // all-day 이벤트는 DTEND가 "다음날"이어야 함
    const dtStart = toIcsDate(ev.startDate);
    const endPlus = new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1);
    const dtEnd = toIcsDate(dateToYMD(endPlus));

    const summary = `${ev.companyName} 청약`;
    const descParts = [];
    if (ev.underwriters) descParts.push(`주간사: ${ev.underwriters}`);
    if (ev.memo) descParts.push(`메모: ${ev.memo}`);
    const desc = descParts.join("\\n");

    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${icsEscape(ev.id)}@ipo4`);
    lines.push(`DTSTAMP:${dtstamp}`);
    lines.push(`SUMMARY:${icsEscape(summary)}`);
    lines.push(`DTSTART;VALUE=DATE:${dtStart}`);
    lines.push(`DTEND;VALUE=DATE:${dtEnd}`);
    if (desc) lines.push(`DESCRIPTION:${icsEscape(desc)}`);
    lines.push("END:VEVENT");
  }

  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
}

exportStarredBtn?.addEventListener("click", () => {
  const calName = calNameInput?.value?.trim() || "공모 알림";
  const events = store.events.filter(e => e.starred);
  const ics = buildIcs(events, calName);
  downloadText("ipo-starred.ics", ics);
});

exportAllBtn?.addEventListener("click", () => {
  const calName = calNameInput?.value?.trim() || "공모 알림";
  const ics = buildIcs(store.events, calName);
  downloadText("ipo-all.ics", ics);
});

// DART 원클릭 가져오기
async function fetchDartIpo(year, month) {
  const y = encodeURIComponent(String(year));
  const m = encodeURIComponent(String(month).padStart(2, "0"));

  // 1) 짧은 주소 먼저
  let res = await fetch(`/api/dart-ipo?year=${y}&month=${m}`);
  if (res.ok) return await res.json();

  // 2) fallback (redirects가 아직이면)
  res = await fetch(`/.netlify/functions/dart-ipo?year=${y}&month=${m}`);
  return await res.json();
}

dartBtn?.addEventListener("click", async () => {
  try {
    dartBtn.disabled = true;
    if (dartStatus) dartStatus.textContent = "불러오는 중…";

    const year = parseInt(dartYear?.value || "", 10);
    const month = parseInt(dartMonth?.value || "", 10);
    if (!year || !month || month < 1 || month > 12) {
      throw new Error("Year/Month를 확인해 주세요.");
    }

    const data = await fetchDartIpo(year, month);
    if (!data.ok) throw new Error(data.error || "DART 가져오기 실패");

    const existing = new Set(
      (store.events || []).map(e => `${e.companyName}|${e.startDate}|${e.endDate}`)
    );

    let added = 0;
    for (const it of (data.items || [])) {
      const companyName = String(it.corp_name || "").trim();
      const startDate = it.sbd_start;
      const endDate = it.sbd_end;
      if (!companyName || !startDate || !endDate) continue;

      const key = `${companyName}|${startDate}|${endDate}`;
      if (existing.has(key)) continue;

      const ev = normalizeEvent({
        id: uid(),
        companyName,
        startDate,
        endDate,
        underwriters: "",
        memo: `출처: DART 청약달력 (${it.market_short || ""})`,
        starred: true,
        perMember: {}
      });
      ensureEventPerMember(ev, store.members);

      store.events.push(ev);
      existing.add(key);
      added++;
    }

    saveStore(store);
    renderAll();

    if (dartStatus) dartStatus.textContent = `완료! ${added}개 추가됨 (${year}-${String(month).padStart(2,"0")})`;
  } catch (e) {
    console.error(e);
    if (dartStatus) dartStatus.textContent = `실패: ${e.message || e}`;
    alert(`DART 가져오기 실패: ${e.message || e}`);
  } finally {
    dartBtn.disabled = false;
  }
});

// 첫 렌더
renderAll();
