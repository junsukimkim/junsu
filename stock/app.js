/* 공모 알림 - app.js (copy & paste) */

const LS_KEY = "ipo_alarm_store_v4";
const SHORTCUT_NAME = "공모주 미리알림 추가"; // iOS 단축어 이름(이름이 정확히 같아야 함)

const $ = (sel) => document.querySelector(sel);

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
  return {
    members,
    // events: 자동 가져오기 결과만 저장 (수동 추가 없음)
    events: [],
    lastImport: null
  };
}

function normName(s) {
  return String(s || "")
    .replace(/\s+/g, "")
    .replace(/[()［］\[\]{}]/g, "")
    .trim();
}

function eventKey(e) {
  return `${normName(e.corp_name)}|${e.sbd_start}|${e.sbd_end}`;
}

function fmtDate(iso) {
  // iso: YYYY-MM-DD
  return iso;
}

function fmtMoneyKRW(n) {
  if (n == null || Number.isNaN(Number(n))) return "(정보없음)";
  const v = Math.round(Number(n));
  return v.toLocaleString("ko-KR") + "원";
}

function todaySeoulISO() {
  // 브라우저(사용자) 로컬 기준으로 YYYY-MM-DD
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function endOfNextMonthISO() {
  const d = new Date();
  const y = d.getFullYear();
  const m = d.getMonth(); // 0-based
  // next month end: month+2, day=0 => last day of (month+1)
  const end = new Date(y, m + 2, 0);
  const yy = end.getFullYear();
  const mm = String(end.getMonth() + 1).padStart(2, "0");
  const dd = String(end.getDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

function overlapsRange(start, end, from, to) {
  // inclusive dates
  return !(end < from || start > to);
}

function dedupeAndMergeChecks(oldEvents, newEvents) {
  // 1) 중복 제거(회사+기간 기준)
  const map = new Map();
  for (const e of newEvents) {
    map.set(eventKey(e), e);
  }
  let merged = Array.from(map.values());

  // 2) “회사명만 같은데 날짜가 밀려서 2번 들어오는” 케이스 방지:
  //    같은 corp_name이 여러 개면 가장 빠른 것 1개만 남김 (원하면 이 블록 삭제 가능)
  const byCorp = new Map();
  for (const e of merged) {
    const k = normName(e.corp_name);
    const prev = byCorp.get(k);
    if (!prev) byCorp.set(k, e);
    else {
      // 더 이른 시작일 우선
      if (String(e.sbd_start) < String(prev.sbd_start)) byCorp.set(k, e);
    }
  }
  merged = Array.from(byCorp.values());

  // 3) 기존 체크(perMember) 유지
  const oldMap = new Map(oldEvents.map(e => [eventKey(e), e]));
  for (const e of merged) {
    const old = oldMap.get(eventKey(e));
    if (old?.perMember) e.perMember = old.perMember;
    if (typeof e.starred === "undefined") e.starred = true;
  }

  // 정렬
  merged.sort((a, b) => String(a.sbd_start).localeCompare(String(b.sbd_start)));
  return merged;
}

function downloadText(filename, text) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 200);
}

/* ===== ICS (Calendar) ===== */

function icsEscape(s) {
  return String(s || "")
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

function ymdToICSDate(ymd) {
  // YYYY-MM-DD -> YYYYMMDD
  return ymd.replace(/-/g, "");
}

function addDaysISO(ymd, days) {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + days);
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

function buildEventDescription(e, members) {
  const brokers = e.underwriters && e.underwriters.length ? e.underwriters.join(", ") : "(정보없음)";
  const per = fmtMoneyKRW(e.equal_min_deposit);
  const total = (e.equal_min_deposit != null) ? fmtMoneyKRW(e.equal_min_deposit * members.length) : "(정보없음)";
  const lines = [
    `회사: ${e.corp_name}`,
    `청약: ${e.sbd_start} ~ ${e.sbd_end}`,
    `증권사: ${brokers}`,
    `균등 최소증거금(1인): ${per}`,
    `4인가족 총 필요(참고): ${total}`,
    e.price_note ? `가격/근거: ${e.price_note}` : "",
    e.source_note ? `출처: ${e.source_note}` : ""
  ].filter(Boolean);
  return lines.join("\n");
}

function buildICS(calName, events, members) {
  const now = new Date();
  const dtstamp =
    now.getUTCFullYear().toString().padStart(4, "0") +
    String(now.getUTCMonth() + 1).padStart(2, "0") +
    String(now.getUTCDate()).padStart(2, "0") + "T" +
    String(now.getUTCHours()).padStart(2, "0") +
    String(now.getUTCMinutes()).padStart(2, "0") +
    String(now.getUTCSeconds()).padStart(2, "0") + "Z";

  let out = "";
  out += "BEGIN:VCALENDAR\n";
  out += "VERSION:2.0\n";
  out += "PRODID:-//IPO Alarm//KR//EN\n";
  out += "CALSCALE:GREGORIAN\n";
  out += `X-WR-CALNAME:${icsEscape(calName)}\n`;

  for (const e of events) {
    const uidStr = `${eventKey(e)}@ipo-alarm`;
    const dtstart = ymdToICSDate(e.sbd_start);
    const dtend = ymdToICSDate(addDaysISO(e.sbd_end, 1)); // DTEND는 보통 종료 다음날(종일 일정)
    const summary = `[공모주] ${e.corp_name} 청약`;
    const desc = buildEventDescription(e, members);

    out += "BEGIN:VEVENT\n";
    out += `UID:${icsEscape(uidStr)}\n`;
    out += `DTSTAMP:${dtstamp}\n`;
    out += `SUMMARY:${icsEscape(summary)}\n`;
    out += `DTSTART;VALUE=DATE:${dtstart}\n`;
    out += `DTEND;VALUE=DATE:${dtend}\n`;
    out += `DESCRIPTION:${icsEscape(desc)}\n`;
    out += "END:VEVENT\n";
  }

  out += "END:VCALENDAR\n";
  return out;
}

/* ===== iOS Reminders (Shortcuts) ===== */

function buildShortcutPayload(e, members) {
  // 단축어로 넘길 JSON (단축어에서 파싱해서 미리알림 생성)
  const brokers = e.underwriters && e.underwriters.length ? e.underwriters.join(", ") : "(정보없음)";
  const per = fmtMoneyKRW(e.equal_min_deposit);
  const total = (e.equal_min_deposit != null) ? fmtMoneyKRW(e.equal_min_deposit * members.length) : "(정보없음)";

  // 알림은 “청약 시작 전날”로 추천(원하면 단축어에서 변경)
  const due = addDaysISO(e.sbd_start, -1);

  return {
    title: `[공모주] ${e.corp_name} 청약`,
    dueDate: due,
    notes:
      `청약: ${e.sbd_start} ~ ${e.sbd_end}\n` +
      `증권사: ${brokers}\n` +
      `균등 최소증거금(1인): ${per}\n` +
      `4인가족 총 필요(참고): ${total}\n` +
      (e.price_note ? `가격/근거: ${e.price_note}\n` : "") +
      (e.source_note ? `출처: ${e.source_note}\n` : ""),
  };
}

function openShortcutRun(payloadObj) {
  const text = JSON.stringify(payloadObj);
  const url =
    "shortcuts://run-shortcut" +
    `?name=${encodeURIComponent(SHORTCUT_NAME)}` +
    `&input=text` +
    `&text=${encodeURIComponent(text)}`;
  location.href = url;
}

/* ===== UI Rendering ===== */

let store = loadStore() || defaultStore();

function renderTabs() {
  document.querySelectorAll(".tab").forEach(btn => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.tab;
      document.querySelectorAll(".tab").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      document.querySelectorAll(".panel").forEach(p => p.classList.remove("active"));
      document.querySelector(`#tab-${tab}`)?.classList.add("active");
    });
  });
}

function renderFamily() {
  const box = $("#family-list");
  if (!box) return;
  box.innerHTML = "";

  store.members.forEach(m => {
    const row = document.createElement("div");
    row.className = "item";

    row.innerHTML = `
      <div class="row space" style="gap:10px;">
        <div>
          <b>${m.name}</b>
          <div class="muted" style="margin-top:4px;">${m.brokerNote ? `메모: ${m.brokerNote}` : ""}</div>
        </div>
        <div class="row" style="gap:8px;">
          <button class="btn" data-act="rename" data-id="${m.id}">이름</button>
          <button class="btn" data-act="note" data-id="${m.id}">메모</button>
          <button class="btn" data-act="del" data-id="${m.id}">삭제</button>
        </div>
      </div>
    `;
    box.appendChild(row);
  });

  box.querySelectorAll("button").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      const act = btn.dataset.act;

      if (act === "del") {
        store.members = store.members.filter(x => x.id !== id);
        // 체크 정보에서도 제거
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
      } else if (act === "note") {
        const m = store.members.find(x => x.id === id);
        if (!m) return;
        const newNote = prompt("증권사 메모(선택)", m.brokerNote || "");
        if (newNote != null) {
          m.brokerNote = newNote.trim();
          saveStore(store);
          renderAll();
        }
      }
    });
  });
}

function renderEvents() {
  const box = $("#events-list");
  if (!box) return;
  box.innerHTML = "";

  if (!store.events.length) {
    box.innerHTML = `<div class="muted">아직 일정이 없습니다. 위에서 “공모주 일정 자동 채우기”를 눌러주세요.</div>`;
    return;
  }

  store.events.forEach(e => {
    const item = document.createElement("div");
    item.className = "item";

    const brokers = e.underwriters && e.underwriters.length ? e.underwriters.join(", ") : "(정보없음)";
    const per = fmtMoneyKRW(e.equal_min_deposit);
    const total = (e.equal_min_deposit != null) ? fmtMoneyKRW(e.equal_min_deposit * store.members.length) : "(정보없음)";

    if (!e.perMember) e.perMember = {};

    const checksHtml = store.members.map(m => {
      const checked = e.perMember[m.id] ? "checked" : "";
      return `
        <label class="inline" style="gap:8px;">
          <input type="checkbox" data-mid="${m.id}" data-ek="${eventKey(e)}" ${checked} />
          ${m.name}
        </label>
      `;
    }).join("");

    item.innerHTML = `
      <div class="row space" style="align-items:flex-start; gap:10px;">
        <div style="min-width:180px;">
          <div style="font-size:18px; font-weight:700;">${e.corp_name}</div>
          <div class="muted" style="margin-top:6px;">청약: ${fmtDate(e.sbd_start)} ~ ${fmtDate(e.sbd_end)}</div>
          <div class="muted" style="margin-top:6px;">증권사: ${brokers}</div>
          <div class="muted" style="margin-top:6px;">균등 최소증거금(1인): <b>${per}</b></div>
          <div class="muted" style="margin-top:6px;">가족 합계(참고): <b>${total}</b></div>
        </div>

        <div class="row" style="gap:8px; flex-wrap:wrap; justify-content:flex-end;">
          <button class="btn" data-act="ics" data-ek="${eventKey(e)}">캘린더</button>
          <button class="btn" data-act="rem" data-ek="${eventKey(e)}">미리알림</button>
        </div>
      </div>

      <div style="margin-top:12px; display:flex; flex-wrap:wrap; gap:14px;">
        ${checksHtml}
      </div>
    `;

    box.appendChild(item);
  });

  // 체크 저장
  box.querySelectorAll('input[type="checkbox"][data-mid]').forEach(chk => {
    chk.addEventListener("change", () => {
      const mid = chk.dataset.mid;
      const ek = chk.dataset.ek;
      const ev = store.events.find(x => eventKey(x) === ek);
      if (!ev) return;
      if (!ev.perMember) ev.perMember = {};
      if (chk.checked) ev.perMember[mid] = true;
      else delete ev.perMember[mid];
      saveStore(store);
    });
  });

  // 캘린더/미리알림 버튼
  box.querySelectorAll("button[data-act]").forEach(btn => {
    btn.addEventListener("click", () => {
      const act = btn.dataset.act;
      const ek = btn.dataset.ek;
      const ev = store.events.find(x => eventKey(x) === ek);
      if (!ev) return;

      if (act === "ics") {
        const ics = buildICS("공모 알림", [ev], store.members);
        downloadText(`ipo_${ev.corp_name}_${ev.sbd_start}.ics`, ics);
      } else if (act === "rem") {
        const payload = buildShortcutPayload(ev, store.members);
        openShortcutRun(payload);
      }
    });
  });
}

function renderAll() {
  renderFamily();
  renderEvents();
}

/* ===== Import (오늘~다음달 말) ===== */

async function importIpoRange() {
  const statusEl = $("#import-status");
  if (statusEl) statusEl.textContent = "불러오는 중...";

  const from = todaySeoulISO();
  const to = endOfNextMonthISO();

  try {
    const url = `/.netlify/functions/dart-ipo?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    if (!data || !data.ok) {
      throw new Error(data?.error || "알 수 없는 오류");
    }

    // 새 이벤트 배열 구성
    const incoming = (data.items || []).map(x => ({
      corp_name: x.corp_name,
      sbd_start: x.sbd_start,
      sbd_end: x.sbd_end,
      underwriters: Array.isArray(x.underwriters) ? x.underwriters : (x.underwriters ? String(x.underwriters).split(",").map(s => s.trim()).filter(Boolean) : []),
      equal_min_deposit: (x.equal_min_deposit != null) ? Number(x.equal_min_deposit) : null,
      price_note: x.price_note || "",
      source_note: x.source_note || "자동 가져오기",
      starred: true,
      perMember: {} // 아래 merge에서 기존 체크 유지됨
    })).filter(e => overlapsRange(e.sbd_start, e.sbd_end, from, to));

    // “자동 가져오기 결과는 교체” + 중복 제거 + 체크 유지
    store.events = dedupeAndMergeChecks(store.events, incoming);
    store.lastImport = { from, to, at: new Date().toISOString(), count: store.events.length };
    saveStore(store);

    renderAll();
    if (statusEl) statusEl.textContent = `완료! ${store.events.length}개 (범위: ${from} ~ ${to})`;
  } catch (err) {
    console.error(err);
    if (statusEl) statusEl.textContent = `가져오기 실패: ${err.message || err}`;
    alert(`가져오기 실패: ${err.message || err}`);
  }
}

function wireUI() {
  renderTabs();

  $("#import-ipo")?.addEventListener("click", importIpoRange);

  $("#reset-import")?.addEventListener("click", () => {
    if (!confirm("가져온 일정(체크 포함)을 모두 지울까요?")) return;
    store.events = [];
    store.lastImport = null;
    saveStore(store);
    renderAll();
    const statusEl = $("#import-status");
    if (statusEl) statusEl.textContent = "초기화 완료";
  });

  // family form
  $("#family-form")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = $("#memberName")?.value?.trim();
    const note = $("#brokerNote")?.value?.trim() || "";
    if (!name) return;

    store.members.push({ id: uid(), name, brokerNote: note });
    $("#memberName").value = "";
    $("#brokerNote").value = "";

    saveStore(store);
    renderAll();
  });

  // export ics
  $("#export-all")?.addEventListener("click", () => {
    const calName = $("#calName")?.value?.trim() || "공모 알림";
    const ics = buildICS(calName, store.events, store.members);
    downloadText(`ipo_calendar_${todaySeoulISO()}.ics`, ics);
  });
}

/* ===== Start ===== */
wireUI();
renderAll();

/* ===== iOS 단축어 만들기(사용자 안내용, 코드 실행과 무관)
단축어 앱에서 새 단축어 만들고 "공모주 미리알림 추가"로 이름 지정.

동작(추천):
1) 동작 추가: "Get Text from Input" (입력 받기)
2) 동작 추가: "Get Dictionary from Input" (입력: 위 텍스트)
3) 동작 추가: "Add New Reminder"
   - Title: Dictionary의 title
   - Notes: Dictionary의 notes
   - Due Date: Dictionary의 dueDate
   - List: 원하는 목록(예: 미리알림)
끝.
*/
