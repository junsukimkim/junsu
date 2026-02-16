/* stock/app.js
   공모 알림 (4인가족) - 단일 파일
   기능:
   - 일정 추가/삭제
   - 가족 추가/이름변경/삭제
   - 가족별 체크리스트(예수금/청약완료)
   - .ics 내보내기(관심/전체)
   - DART 원클릭 가져오기 (/.netlify/functions/dart-ipo?year=YYYY&month=MM&mode=ipo)
*/

const LS_KEY = "ipo4_store_v4";

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

function normalizeEvent(ev) {
  ev.id = ev.id || uid();
  ev.companyName = String(ev.companyName || "").trim();
  ev.startDate = String(ev.startDate || "");
  ev.endDate = String(ev.endDate || "");
  ev.underwriters = String(ev.underwriters || "");
  ev.memo = String(ev.memo || "");
  ev.starred = !!ev.starred;
  ev.perMember = ev.perMember || {};
  return ev;
}

function ensureEventPerMember(ev, members) {
  ev.perMember = ev.perMember || {};
  for (const m of members) {
    if (!ev.perMember[m.id]) {
      ev.perMember[m.id] = { funded: false, applied: false };
    } else {
      ev.perMember[m.id].funded = !!ev.perMember[m.id].funded;
      ev.perMember[m.id].applied = !!ev.perMember[m.id].applied;
    }
  }
}

// ===== store 초기화 =====
let store = loadStore() || defaultStore();
store.members = store.members || [];
store.events = (store.events || []).map(normalizeEvent);

// 콘솔에서도 확인 가능하게
window.store = store;

// ===== DOM helper =====
const $ = (sel) => document.querySelector(sel);

// ===== 렌더 =====
function renderAll() {
  // 모든 이벤트에 멤버 체크리스트 보정
  for (const ev of store.events) ensureEventPerMember(ev, store.members);

  renderEvents();
  renderFamily();
}

function renderEvents() {
  const eventsList = $("#events-list");
  if (!eventsList) return;

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
              <input type="checkbox"
                     data-act="chk"
                     data-eid="${esc(ev.id)}"
                     data-mid="${esc(m.id)}"
                     data-key="funded"
                     ${st.funded ? "checked" : ""} />
              예수금
            </label>
            <label class="inline">
              <input type="checkbox"
                     data-act="chk"
                     data-eid="${esc(ev.id)}"
                     data-mid="${esc(m.id)}"
                     data-key="applied"
                     ${st.applied ? "checked" : ""} />
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
  const familyList = $("#family-list");
  if (!familyList) return;

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

// ===== ICS =====
function icsEscape(s) {
  return String(s ?? "")
    .replaceAll("\\", "\\\\")
    .replaceAll("\n", "\\n")
    .replaceAll(",", "\\,")
    .replaceAll(";", "\\;");
}

function toIcsDate(ymd) {
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

  for (const ev0 of events) {
    const ev = normalizeEvent({ ...ev0 });
    const start = ymdToDate(ev.startDate);
    const end = ymdToDate(ev.endDate);
    if (!start || !end) continue;

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

// ===== DART fetch (아이폰 안전: 절대 URL + JSON 파싱 안전) =====
async function fetchDartIpo(year, month, mode = "ipo") {
  const y = String(year);
  const m = String(month).padStart(2, "0");
  const params = new URLSearchParams({
    year: y,
    month: m,
    mode: String(mode || "ipo"),
  });

  // ✅ 절대 URL로 만들어 Safari에서 "expected pattern" 오류를 최대한 방지
  const url = new URL(`/.netlify/functions/dart-ipo?${params.toString()}`, window.location.origin).toString();

  let res;
  try {
    res = await fetch(url, { cache: "no-store" });
  } catch (e) {
    // Safari에서 URL/네트워크 문제면 여기로 옴
    throw new Error(`네트워크 호출 실패: ${e?.message || e}`);
  }

  const text = await res.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`서버 응답이 JSON이 아님 (HTTP ${res.status})\n${text.slice(0, 200)}`);
  }

  if (!res.ok || data.ok === false) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }

  return data;
}

function addItemsToStore(items) {
  const existing = new Set((store.events || []).map(e => `${e.companyName}|${e.startDate}|${e.endDate}`));

  let added = 0;
  for (const it of (items || [])) {
    const companyName = String(it.corp_name || "").trim();
    const startDate = String(it.sbd_start || "");
    const endDate = String(it.sbd_end || "");
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
      perMember: {},
    });
    ensureEventPerMember(ev, store.members);

    store.events.push(ev);
    existing.add(key);
    added++;
  }

  return added;
}

// ===== DOM 이벤트 바인딩 =====
document.addEventListener("DOMContentLoaded", () => {
  // 탭
  const tabs = document.querySelectorAll(".tab");
  const panels = document.querySelectorAll(".panel");

  function setActiveTab(tabName) {
    tabs.forEach(b => b.classList.toggle("active", b.dataset.tab === tabName));
    panels.forEach(p => p.classList.toggle("active", p.id === `tab-${tabName}`));
  }

  tabs.forEach(b => b.addEventListener("click", () => setActiveTab(b.dataset.tab)));

  // DART 입력 기본값
  const dartYear = $("#dart-year");
  const dartMonth = $("#dart-month");
  const dartBtn = $("#import-dart");
  const dartStatus = $("#import-status");

  if (dartYear && !dartYear.value) dartYear.value = String(new Date().getFullYear());
  if (dartMonth && !dartMonth.value) dartMonth.value = String(new Date().getMonth() + 1);

  dartBtn?.addEventListener("click", async () => {
    try {
      dartBtn.disabled = true;
      if (dartStatus) dartStatus.textContent = "불러오는 중…";

      const year = parseInt(dartYear?.value || "", 10);
      const month = parseInt(dartMonth?.value || "", 10);

      if (!year || !month || month < 1 || month > 12) {
        throw new Error("Year/Month를 확인해 주세요.");
      }

      // 기본: mode=ipo (유상증자 섞임을 서버에서 최대한 제거)
      const data = await fetchDartIpo(year, month, "ipo");

      const added = addItemsToStore(data.items);
      saveStore(store);
      renderAll();

      let msg = `완료! ${added}개 추가됨 (${year}-${String(month).padStart(2, "0")})`;
      if (data.filtered_out_count) msg += ` · 제외 ${data.filtered_out_count}개`;
      if (data.note) msg += ` · ${data.note}`;

      if (dartStatus) dartStatus.textContent = msg;
    } catch (e) {
      console.error(e);
      if (dartStatus) dartStatus.textContent = `실패: ${e.message || e}`;
      alert(`DART 가져오기 실패: ${e.message || e}`);
    } finally {
      dartBtn.disabled = false;
    }
  });

  // 수동 이벤트 추가
  const eventForm = $("#event-form");
  eventForm?.addEventListener("submit", (e) => {
    e.preventDefault();

    const companyName = $("#companyName")?.value?.trim();
    const startDate = $("#startDate")?.value;
    const endDate = $("#endDate")?.value;
    const underwriters = $("#underwriters")?.value?.trim() || "";
    const memo = $("#memo")?.value?.trim() || "";
    const starred = !!$("#starred")?.checked;

    if (!companyName || !startDate || !endDate) return;

    const ev = normalizeEvent({
      id: uid(),
      companyName,
      startDate,
      endDate,
      underwriters,
      memo,
      starred,
      perMember: {},
    });
    ensureEventPerMember(ev, store.members);

    store.events.push(ev);
    saveStore(store);
    renderAll();

    eventForm.reset();
    if ($("#starred")) $("#starred").checked = true;
  });

  // 일정 리스트 액션
  const eventsList = $("#events-list");
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

  // 체크박스
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
  const familyForm = $("#family-form");
  familyForm?.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = $("#memberName")?.value?.trim();
    const brokerNote = $("#brokerNote")?.value?.trim() || "";
    if (!name) return;

    const m = { id: uid(), name, brokerNote };
    store.members.push(m);

    store.events.forEach(ev => ensureEventPerMember(ev, store.members));
    saveStore(store);
    renderAll();
    familyForm.reset();
  });

  // 가족 액션
  const familyList = $("#family-list");
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

  // ICS 내보내기
  const exportStarredBtn = $("#export-starred");
  const exportAllBtn = $("#export-all");
  const calNameInput = $("#calName");

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

  // 최초 렌더
  renderAll();
});

// ===== DART 원클릭 가져오기 (app.js 맨 아래에 붙여넣기) =====
(function attachDartImport() {
  function $(id) { return document.getElementById(id); }

  function norm(s) {
    return (s || "").toString().replace(/\s+/g, "").trim();
  }

  function existsEvent(store, corp, s, e) {
    const a = norm(corp);
    return (store.events || []).some(ev =>
      norm(ev.companyName) === a &&
      String(ev.startDate) === String(s) &&
      String(ev.endDate) === String(e)
    );
  }

  async function importFromDart() {
    const statusEl = $("import-status");
    const yEl = $("dart-year");
    const mEl = $("dart-month");

    if (!statusEl || !yEl || !mEl) {
      alert("import UI 요소를 못 찾았어요. index.html에 dart-year/dart-month/import-status가 있는지 확인!");
      return;
    }

    const year = String(parseInt(yEl.value, 10) || new Date().getFullYear());
    const month = String(parseInt(mEl.value, 10) || (new Date().getMonth() + 1));

    statusEl.textContent = "불러오는 중…";

    // ✅ 같은 도메인에서 Netlify Function 호출
    const url = `/.netlify/functions/dart-ipo?year=${encodeURIComponent(year)}&month=${encodeURIComponent(month)}`;

    let data;
    try {
      const res = await fetch(url, { cache: "no-store" });
      // Netlify가 200으로 내려주는 경우가 많아서 status만 믿지 말고 JSON도 확인
      data = await res.json();
      if (!data || data.ok !== true) {
        throw new Error(data?.error || `가져오기 실패 (HTTP ${res.status})`);
      }
    } catch (err) {
      console.error(err);
      statusEl.textContent = "";
      alert("DART 가져오기 실패: " + (err?.message || err));
      return;
    }

    // store가 전역에 없을 수도 있으니 최대한 안전하게 가져오기
    // (너 기존 코드가 var store = ... 형태면 아래가 그대로 잡힘)
    try {
      if (typeof store === "undefined") {
        alert("store 변수를 찾을 수 없어요. app.js에서 store 초기화가 먼저 되어야 해요.");
        statusEl.textContent = "";
        return;
      }

      if (!store.events) store.events = [];

      let added = 0;
      for (const it of (data.items || [])) {
        const corp = it.corp_name;
        const s = it.sbd_start;
        const e = it.sbd_end;

        if (!corp || !s || !e) continue;
        if (existsEvent(store, corp, s, e)) continue; // 중복 방지

        store.events.push({
          id: (typeof uid === "function") ? uid() : ("id-" + Math.random().toString(16).slice(2)),
          companyName: corp,
          startDate: s,
          endDate: e,
          underwriters: "", // DART 달력엔 주간사 정보가 없어서 비워둠
          memo: "DART 자동 가져오기",
          starred: true, // 기본: 관심(⭐) 포함
          perMember: {} // 가족 체크리스트용
        });
        added++;
      }

      if (typeof saveStore === "function") saveStore(store);
      if (typeof renderAll === "function") renderAll();

      statusEl.textContent = `완료! ${added}개 추가됨 (${year}-${String(month).padStart(2, "0")})`;
    } catch (e) {
      console.error(e);
      statusEl.textContent = "";
      alert("추가 처리 중 오류: " + (e?.message || e));
    }
  }

  window.addEventListener("DOMContentLoaded", () => {
    const btn = document.getElementById("import-dart");
    if (!btn) return;

    // 중복 바인딩 방지
    if (btn.dataset.bound === "1") return;
    btn.dataset.bound = "1";

    btn.addEventListener("click", importFromDart);
  });
})();
