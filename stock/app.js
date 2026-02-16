/* 공모 알림 app.js (v3)
 * - “수동 일정 추가” 제거: 자동 가져오기 + 가족 체크 중심
 * - 범위: 오늘~다음달 말
 * - 중복 방지: (회사명+시작+종료) 키로 upsert
 * - 미리알림: iOS 공유(Share sheet)로 Reminders에 추가
 */

const LS_KEY = "ipo_app_v3";

function uid() {
  return (crypto?.randomUUID?.() ?? ("id-" + Math.random().toString(16).slice(2)));
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

let store = loadStore() || defaultStore();
saveStore(store);

/* ---------- date helpers ---------- */
function pad2(n) { return String(n).padStart(2, "0"); }

function kstTodayISO() {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10);
}

function endOfNextMonthISO() {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const y = kst.getUTCFullYear();
  const m = kst.getUTCMonth(); // 0-based after shift
  // next month end: month+2, day 0
  const end = new Date(Date.UTC(y, m + 2, 0));
  return end.toISOString().slice(0, 10);
}

function isoToIcsDate(iso) {
  // YYYY-MM-DD -> YYYYMMDD
  return iso.replaceAll("-", "");
}

function addDaysISO(iso, days) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function formatMoneyKRW(n) {
  if (n == null || Number.isNaN(n)) return "";
  try { return Number(n).toLocaleString("ko-KR"); } catch { return String(n); }
}

/* ---------- tabs ---------- */
document.querySelectorAll(".tab").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(x => x.classList.remove("active"));
    btn.classList.add("active");
    const tab = btn.dataset.tab;
    document.querySelectorAll(".panel").forEach(p => p.classList.remove("active"));
    document.getElementById("tab-" + tab)?.classList.add("active");
  });
});

/* ---------- modal (optional) ---------- */
const modal = document.getElementById("modal");
const modalClose = document.getElementById("modal-close");
modalClose?.addEventListener("click", () => hideModal());
function showModal(title, html) {
  document.getElementById("modal-title").textContent = title || "상세";
  document.getElementById("modal-body").innerHTML = html;
  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");
}
function hideModal() {
  modal.classList.add("hidden");
  modal.setAttribute("aria-hidden", "true");
}

/* ---------- render ---------- */
function renderAll() {
  renderFamily();
  renderEvents();
}
renderAll();

/* ---------- family ---------- */
const familyForm = document.getElementById("family-form");
familyForm?.addEventListener("submit", (e) => {
  e.preventDefault();
  const nameEl = document.getElementById("memberName");
  const noteEl = document.getElementById("brokerNote");
  const name = (nameEl.value || "").trim();
  const note = (noteEl.value || "").trim();
  if (!name) return;
  store.members.push({ id: uid(), name, brokerNote: note });
  saveStore(store);
  nameEl.value = "";
  noteEl.value = "";
  renderAll();
});

function renderFamily() {
  const box = document.getElementById("family-list");
  if (!box) return;

  box.innerHTML = "";
  store.members.forEach(m => {
    const row = document.createElement("div");
    row.className = "item";
    row.innerHTML = `
      <div class="grow">
        <b>${escapeHtml(m.name)}</b>
        <div class="muted">${escapeHtml(m.brokerNote || "")}</div>
      </div>
      <div class="row">
        <button class="btn" data-act="rename" data-id="${m.id}">이름변경</button>
        <button class="btn" data-act="del" data-id="${m.id}">삭제</button>
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
        // 이벤트 체크리스트에서도 제거
        store.events.forEach(ev => { if (ev.perMember) delete ev.perMember[id]; });
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

/* ---------- events ---------- */
function eventKey(ev) {
  return `${ev.companyName}__${ev.startDate}__${ev.endDate}`;
}

function renderEvents() {
  const box = document.getElementById("events-list");
  if (!box) return;

  const today = kstTodayISO();
  const endNext = endOfNextMonthISO();

  const list = [...store.events]
    .filter(ev => ev.startDate <= endNext && ev.endDate >= today) // range intersection
    .sort((a, b) => (a.startDate || "").localeCompare(b.startDate || ""));

  if (list.length === 0) {
    box.innerHTML = `<div class="muted">가져온 일정이 없어요. 위 버튼으로 불러와 보세요.</div>`;
    return;
  }

  box.innerHTML = "";
  list.forEach(ev => {
    const minStr = ev.minDeposit ? `${formatMoneyKRW(ev.minDeposit)}원` : "(정보없음)";
    const uwStr = ev.underwriters ? ev.underwriters : "(정보없음)";
    const famCount = store.members.length;
    const totalMin = ev.minDeposit ? (ev.minDeposit * famCount) : null;

    const card = document.createElement("div");
    card.className = "item";
    card.innerHTML = `
      <div class="grow">
        <div class="row space">
          <div>
            <b style="font-size:18px;">${escapeHtml(ev.companyName)}</b>
            <div class="muted">청약: ${escapeHtml(ev.startDate)} ~ ${escapeHtml(ev.endDate)}</div>
          </div>
          <div class="row">
            <button class="btn" data-act="ics" data-id="${ev.id}">캘린더</button>
            <button class="btn" data-act="share" data-id="${ev.id}">미리알림</button>
            <button class="btn" data-act="detail" data-id="${ev.id}">상세</button>
          </div>
        </div>

        <div class="muted">증권사: ${escapeHtml(uwStr)}</div>
        <div class="muted">균등 최소금액(1인): ${escapeHtml(minStr)}</div>
        <div class="muted">4인가족 기준 최소합계: ${totalMin ? (formatMoneyKRW(totalMin) + "원") : "(계산불가)"}</div>

        <div class="row" style="margin-top:10px; gap:10px; flex-wrap:wrap;">
          ${store.members.map(m => {
            const checked = !!(ev.perMember?.[m.id]?.done);
            return `
              <label class="inline" style="gap:8px;">
                <input type="checkbox" data-act="memberDone" data-evid="${ev.id}" data-mid="${m.id}" ${checked ? "checked" : ""}/>
                <span>${escapeHtml(m.name)}</span>
              </label>
            `;
          }).join("")}
        </div>
      </div>
    `;
    box.appendChild(card);
  });

  // handlers
  box.querySelectorAll("button").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      const act = btn.dataset.act;
      const ev = store.events.find(x => x.id === id);
      if (!ev) return;

      if (act === "ics") {
        downloadSingleICS(ev);
      } else if (act === "share") {
        shareToReminders(ev);
      } else if (act === "detail") {
        const minStr = ev.minDeposit ? `${formatMoneyKRW(ev.minDeposit)}원` : "(정보없음)";
        const uwStr = ev.underwriters ? ev.underwriters : "(정보없음)";
        showModal(ev.companyName, `
          <div class="muted" style="line-height:1.6;">
            <div><b>청약</b>: ${escapeHtml(ev.startDate)} ~ ${escapeHtml(ev.endDate)}</div>
            <div><b>증권사</b>: ${escapeHtml(uwStr)}</div>
            <div><b>균등 최소금액(1인)</b>: ${escapeHtml(minStr)}</div>
            <hr style="opacity:.2; margin:12px 0;" />
            <div class="muted">미리알림으로 넣을 땐 “미리알림” 버튼 → iOS 공유창에서 미리알림 선택.</div>
          </div>
        `);
      }
    });
  });

  box.querySelectorAll("input[type=checkbox][data-act=memberDone]").forEach(chk => {
    chk.addEventListener("change", () => {
      const evid = chk.dataset.evid;
      const mid = chk.dataset.mid;
      const ev = store.events.find(x => x.id === evid);
      if (!ev) return;

      ev.perMember = ev.perMember || {};
      ev.perMember[mid] = ev.perMember[mid] || {};
      ev.perMember[mid].done = chk.checked;

      saveStore(store);
    });
  });
}

/* ---------- import (today~end of next month) ---------- */
const importBtn = document.getElementById("import-dart");
const resetBtn = document.getElementById("reset-import");
const importStatus = document.getElementById("import-status");

importBtn?.addEventListener("click", async () => {
  try {
    setStatus("불러오는 중…");
    importBtn.disabled = true;

    const res = await fetch("/.netlify/functions/dart-ipo?mode=next2months", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    if (!data.ok) {
      setStatus(`실패: ${escapeHtml(data.error || "unknown error")}`);
      importBtn.disabled = false;
      return;
    }

    const items = Array.isArray(data.items) ? data.items : [];
    const today = kstTodayISO();
    const endNext = endOfNextMonthISO();

    let added = 0, updated = 0, skipped = 0;

    for (const it of items) {
      const companyName = String(it.corp_name || "").trim();
      const startDate = String(it.sbd_start || "").slice(0, 10);
      const endDate = String(it.sbd_end || "").slice(0, 10);
      if (!companyName || !startDate || !endDate) { skipped++; continue; }

      // keep only range
      if (!(startDate <= endNext && endDate >= today)) { skipped++; continue; }

      const underwriters = (it.underwriters ? String(it.underwriters) : "").trim();
      const minDeposit = (typeof it.min_deposit === "number" && it.min_deposit > 0) ? it.min_deposit : null;

      // upsert by key
      const tempKey = `${companyName}__${startDate}__${endDate}`;
      let ev = store.events.find(e => eventKey(e) === tempKey);

      if (ev) {
        ev.underwriters = underwriters || ev.underwriters || "";
        ev.minDeposit = minDeposit ?? ev.minDeposit ?? null;
        ev.source = "import";
        updated++;
      } else {
        ev = {
          id: uid(),
          companyName,
          startDate,
          endDate,
          underwriters: underwriters || "",
          minDeposit: minDeposit ?? null,
          source: "import",
          perMember: {},
        };
        // init perMember
        store.members.forEach(m => (ev.perMember[m.id] = { done: false }));
        store.events.push(ev);
        added++;
      }
    }

    // (Optional) de-dup hard safety
    store.events = dedupeEvents(store.events);

    saveStore(store);
    renderAll();

    let msg = `완료! ${added}개 추가, ${updated}개 업데이트 (오늘~다음달 말)`;
    if (data.warn) msg += ` / 주의: ${data.warn}`;
    setStatus(msg);

  } catch (err) {
    setStatus(`가져오기 실패: ${escapeHtml(err?.message || String(err))}`);
  } finally {
    importBtn.disabled = false;
  }
});

resetBtn?.addEventListener("click", () => {
  const ok = confirm("가져온 일정(자동 import)만 전부 삭제할까요?");
  if (!ok) return;
  store.events = store.events.filter(e => e.source !== "import");
  saveStore(store);
  renderAll();
  setStatus("가져온 일정을 초기화했어요.");
});

function setStatus(text) {
  if (importStatus) importStatus.textContent = text || "";
}

function dedupeEvents(events) {
  const seen = new Set();
  const out = [];
  for (const ev of events) {
    const k = eventKey(ev);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(ev);
  }
  return out;
}

/* ---------- export ICS ---------- */
document.getElementById("export-upcoming")?.addEventListener("click", () => {
  const today = kstTodayISO();
  const endNext = endOfNextMonthISO();
  const list = store.events.filter(ev => ev.startDate <= endNext && ev.endDate >= today);
  downloadICS(list, (document.getElementById("calName")?.value || "공모 알림").trim(), "ipo-upcoming.ics");
});

document.getElementById("export-all")?.addEventListener("click", () => {
  downloadICS(store.events, (document.getElementById("calName")?.value || "공모 알림").trim(), "ipo-all.ics");
});

function icsEscape(s) {
  return String(s || "")
    .replaceAll("\\", "\\\\")
    .replaceAll("\n", "\\n")
    .replaceAll(",", "\\,")
    .replaceAll(";", "\\;");
}

function buildEventDescription(ev) {
  const uw = ev.underwriters ? ev.underwriters : "(정보없음)";
  const min = ev.minDeposit ? `${formatMoneyKRW(ev.minDeposit)}원` : "(정보없음)";
  return [
    `회사: ${ev.companyName}`,
    `청약: ${ev.startDate} ~ ${ev.endDate}`,
    `증권사: ${uw}`,
    `균등 최소금액(1인): ${min}`,
    ``,
    `* 일정/조건은 참고용. 최종은 공시/증권사 공지 확인.`,
  ].join("\n");
}

function downloadSingleICS(ev) {
  downloadICS([ev], "공모 알림", `${safeFileName(ev.companyName)}-${ev.startDate}.ics`);
}

function downloadICS(events, calName, filename) {
  const lines = [];
  lines.push("BEGIN:VCALENDAR");
  lines.push("VERSION:2.0");
  lines.push("PRODID:-//IPO Alarm//KR//EN");
  lines.push(`X-WR-CALNAME:${icsEscape(calName || "공모 알림")}`);

  for (const ev of (events || [])) {
    if (!ev?.companyName || !ev?.startDate || !ev?.endDate) continue;

    // all-day event spanning start~end (inclusive) => DTEND = end+1
    const dtStart = isoToIcsDate(ev.startDate);
    const dtEndEx = isoToIcsDate(addDaysISO(ev.endDate, 1));

    const summary = `${ev.companyName} 청약`;
    const desc = buildEventDescription(ev);

    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${icsEscape(ev.id || uid())}`);
    lines.push(`DTSTAMP:${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}`);
    lines.push(`SUMMARY:${icsEscape(summary)}`);
    lines.push(`DESCRIPTION:${icsEscape(desc)}`);
    lines.push(`DTSTART;VALUE=DATE:${dtStart}`);
    lines.push(`DTEND;VALUE=DATE:${dtEndEx}`);

    // 1-day-before reminder
    lines.push("BEGIN:VALARM");
    lines.push("TRIGGER:-P1D");
    lines.push("ACTION:DISPLAY");
    lines.push(`DESCRIPTION:${icsEscape(summary)}`);
    lines.push("END:VALARM");

    lines.push("END:VEVENT");
  }

  lines.push("END:VCALENDAR");

  const blob = new Blob([lines.join("\r\n")], { type: "text/calendar;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename || "ipo.ics";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1500);
}

/* ---------- reminders (share) ---------- */
async function shareToReminders(ev) {
  const uw = ev.underwriters ? ev.underwriters : "(정보없음)";
  const min = ev.minDeposit ? `${formatMoneyKRW(ev.minDeposit)}원` : "(정보없음)";
  const text = [
    `[공모주] ${ev.companyName}`,
    `청약: ${ev.startDate} ~ ${ev.endDate}`,
    `증권사: ${uw}`,
    `균등 최소금액(1인): ${min}`,
  ].join("\n");

  try {
    if (navigator.share) {
      await navigator.share({ title: `[공모주] ${ev.companyName}`, text });
      return;
    }
  } catch (e) {
    // user cancelled share: ignore
    return;
  }

  // fallback: copy
  try {
    await navigator.clipboard.writeText(text);
    alert("공유 기능이 없어 클립보드에 복사했어요.\n미리알림 앱에 붙여넣기 하면 됩니다.");
  } catch {
    alert(text);
  }
}

/* ---------- utils ---------- */
function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function safeFileName(s) {
  return String(s || "event")
    .replace(/[\/\\?%*:|"<>]/g, "-")
    .slice(0, 60);
}
