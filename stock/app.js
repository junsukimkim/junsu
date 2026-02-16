(() => {
  "use strict";

  const LS_KEY = "ipo_family_store_v5";
  const SHORTCUT_NAME = "공모주 미리알림 추가";

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));

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
    return { members, events: [], meta: { lastImport: null } };
  }

  function ensureStore() {
    const st = loadStore();
    if (st && st.members && st.events) return st;
    const fresh = defaultStore();
    saveStore(fresh);
    return fresh;
  }

  const store = ensureStore();

  // ---- Date helpers (KST for UI only) ----
  function fmtDate(d) {
    // d: "YYYY-MM-DD"
    return d;
  }

  function eventKeyFromItem(it) {
    return `${it.corp_name}|${it.sbd_start}|${it.sbd_end}`;
  }

  function normalizeStr(s) {
    return String(s ?? "").trim();
  }

  // ---- Tabs ----
  function wireTabs() {
    $$(".tab").forEach(btn => {
      btn.addEventListener("click", () => {
        $$(".tab").forEach(x => x.classList.remove("active"));
        $$(".panel").forEach(x => x.classList.remove("active"));
        btn.classList.add("active");
        $(`#tab-${btn.dataset.tab}`).classList.add("active");
      });
    });
  }

  // ---- Render: Family ----
  function renderFamily() {
    const box = $("#family-list");
    if (!box) return;

    if (!store.members?.length) store.members = defaultStore().members;

    box.innerHTML = "";
    store.members.forEach(m => {
      const row = document.createElement("div");
      row.className = "row space";
      row.style.alignItems = "center";
      row.innerHTML = `
        <div>
          <b>${escapeHtml(m.name)}</b>
          <div class="muted" style="font-size:12px">${escapeHtml(m.brokerNote || "")}</div>
        </div>
        <div class="row" style="gap:8px">
          <button class="btn" data-act="rename" data-id="${m.id}" type="button">이름변경</button>
          <button class="btn" data-act="del" data-id="${m.id}" type="button">삭제</button>
        </div>
      `;
      box.appendChild(row);
    });

    box.querySelectorAll("button").forEach(btn => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.id;
        const act = btn.dataset.act;

        if (act === "del") {
          if (store.members.length <= 1) {
            alert("가족은 최소 1명은 있어야 해요.");
            return;
          }
          store.members = store.members.filter(x => x.id !== id);
          store.events.forEach(e => { if (e.perMember) delete e.perMember[id]; });
          saveStore(store);
          renderAll();
          return;
        }

        if (act === "rename") {
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

  function wireFamilyForm() {
    const form = $("#family-form");
    if (!form) return;
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const name = normalizeStr($("#memberName")?.value);
      const note = normalizeStr($("#brokerNote")?.value);
      if (!name) return;

      store.members.push({ id: uid(), name, brokerNote: note });
      $("#memberName").value = "";
      $("#brokerNote").value = "";
      saveStore(store);
      renderAll();
    });
  }

  // ---- Render: Events ----
  function renderEvents() {
    const box = $("#events-list");
    if (!box) return;

    const events = (store.events || []).slice().sort((a, b) => (a.sbd_start || "").localeCompare(b.sbd_start || ""));
    box.innerHTML = "";

    if (!events.length) {
      box.innerHTML = `<div class="muted">아직 일정이 없어요. 위에서 “DART에서 일정 자동 채우기”를 눌러주세요.</div>`;
      return;
    }

    events.forEach(ev => {
      const card = document.createElement("div");
      card.className = "card";
      card.style.marginBottom = "12px";

      const brokers = ev.underwriters ? ev.underwriters : "(불러오는 중/없음)";
      const equalMin = ev.equal_min ? ev.equal_min : "(공모가 미확정/정보없음)";

      card.innerHTML = `
        <div class="row space" style="align-items:flex-start">
          <div style="min-width: 180px">
            <div style="font-size:18px"><b>${escapeHtml(ev.corp_name)}</b></div>
            <div class="muted">청약: ${escapeHtml(fmtDate(ev.sbd_start))} ~ ${escapeHtml(fmtDate(ev.sbd_end))}</div>
            <div class="muted">증권사: ${escapeHtml(brokers)}</div>
            <div class="muted"><b>균등 최소금액</b>: ${escapeHtml(equalMin)}</div>
          </div>

          <div class="row" style="gap:8px; flex-wrap:wrap; justify-content:flex-end">
            <button class="btn" data-act="ics" data-id="${ev.id}" type="button">캘린더</button>
            <button class="btn" data-act="rem" data-id="${ev.id}" type="button">미리알림</button>
            <button class="btn" data-act="del" data-id="${ev.id}" type="button">삭제</button>
          </div>
        </div>

        <div class="row" style="gap:16px; margin-top:10px; flex-wrap:wrap;">
          ${store.members.map(m => {
            const checked = !!(ev.perMember && ev.perMember[m.id]);
            return `
              <label class="inline" style="gap:8px;">
                <input type="checkbox" data-act="chk" data-eid="${ev.id}" data-mid="${m.id}" ${checked ? "checked" : ""} />
                ${escapeHtml(m.name)}
              </label>
            `;
          }).join("")}
        </div>
      `;

      box.appendChild(card);
    });

    // Bind buttons + checkboxes
    box.querySelectorAll("button").forEach(btn => {
      btn.addEventListener("click", async () => {
        const id = btn.dataset.id;
        const act = btn.dataset.act;
        const ev = store.events.find(x => x.id === id);
        if (!ev) return;

        if (act === "del") {
          store.events = store.events.filter(x => x.id !== id);
          saveStore(store);
          renderAll();
          return;
        }

        if (act === "ics") {
          downloadIcs([ev], $("#calName")?.value || "공모 알림");
          return;
        }

        if (act === "rem") {
          openReminderShortcut(ev);
          return;
        }
      });
    });

    box.querySelectorAll('input[type="checkbox"][data-act="chk"]').forEach(chk => {
      chk.addEventListener("change", () => {
        const eid = chk.dataset.eid;
        const mid = chk.dataset.mid;
        const ev = store.events.find(x => x.id === eid);
        if (!ev) return;
        if (!ev.perMember) ev.perMember = {};
        ev.perMember[mid] = chk.checked;
        saveStore(store);
      });
    });
  }

  function openReminderShortcut(ev) {
    // iOS Shortcuts URL scheme
    // 단축어가 없으면 iOS가 그냥 실패할 수 있으니 안내 메시지도 띄움
    const payload = [
      `[공모주] ${ev.corp_name}`,
      `청약: ${ev.sbd_start} ~ ${ev.sbd_end}`,
      `증권사: ${ev.underwriters || "(없음/미정)"}`,
      `균등 최소금액: ${ev.equal_min || "(미정)"}`,
      `메모: ${ev.memo || ""}`,
    ].join("\n");

    const url =
      `shortcuts://run-shortcut?name=${encodeURIComponent(SHORTCUT_NAME)}&input=text&text=${encodeURIComponent(payload)}`;

    // iOS에서만 의미 있음
    try {
      window.location.href = url;
      setTimeout(() => {
        alert("단축어가 없으면 실행이 안 돼요.\n내보내기 탭에서 ‘단축어 만들기’ 안내대로 한 번만 만들어 주세요.");
      }, 800);
    } catch {
      alert("미리알림 호출 실패. (아이폰/아이패드 + 단축어 필요)");
    }
  }

  // ---- Import (DART Range: today ~ end of next month) ----
  function wireImport() {
    const btn = $("#import-dart-range");
    const reset = $("#reset-imported");
    if (btn) {
      btn.addEventListener("click", () => importDartRange());
    }
    if (reset) {
      reset.addEventListener("click", () => {
        if (!confirm("가져온 일정을 전부 삭제할까요?")) return;
        store.events = [];
        store.meta.lastImport = null;
        saveStore(store);
        renderAll();
        $("#import-status").textContent = "초기화 완료.";
      });
    }
  }

  async function importDartRange() {
    const status = $("#import-status");
    status.textContent = "불러오는 중...";

    try {
      const res = await fetch(`/.netlify/functions/dart-ipo?range=next`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "unknown");

      const items = Array.isArray(data.items) ? data.items : [];
      const added = upsertEvents(items);

      store.meta.lastImport = { at: new Date().toISOString(), range: data.range_label || "today~nextMonthEnd" };
      saveStore(store);
      renderAll();

      status.textContent = `완료! ${added}개 추가/갱신됨 (${data.range_label || ""})`;
    } catch (e) {
      status.textContent = "";
      alert(`DART 가져오기 실패: ${e.message || e}`);
    }
  }

  function upsertEvents(items) {
    const byKey = new Map();
    store.events.forEach(ev => {
      if (ev.key) byKey.set(ev.key, ev);
      else byKey.set(eventKeyFromItem(ev), ev);
    });

    let changed = 0;

    for (const it of items) {
      const key = eventKeyFromItem(it);
      const exists = byKey.get(key);

      if (exists) {
        // 갱신 (체크는 유지)
        exists.corp_name = it.corp_name;
        exists.sbd_start = it.sbd_start;
        exists.sbd_end = it.sbd_end;
        exists.market = it.market || exists.market;
        exists.market_short = it.market_short || exists.market_short;
        exists.underwriters = it.underwriters || exists.underwriters || "";
        exists.equal_min = it.equal_min || exists.equal_min || "";
        exists.memo = it.memo || exists.memo || "";
        exists.starred = true;
        exists.source = "dart";
        exists.key = key;
        changed++;
      } else {
        const ev = {
          id: uid(),
          key,
          source: "dart",
          corp_name: it.corp_name,
          market_short: it.market_short || "",
          market: it.market || "",
          sbd_start: it.sbd_start,
          sbd_end: it.sbd_end,
          underwriters: it.underwriters || "",
          equal_min: it.equal_min || "",
          memo: it.memo || "",
          starred: true,
          perMember: {}
        };
        store.events.push(ev);
        byKey.set(key, ev);
        changed++;
      }
    }

    // 중복 제거(혹시 모를)
    const uniq = new Map();
    store.events.forEach(ev => uniq.set(ev.key || eventKeyFromItem(ev), ev));
    store.events = Array.from(uniq.values());

    // 멤버 체크 키 정리
    store.events.forEach(ev => {
      if (!ev.perMember) ev.perMember = {};
      // 없는 멤버 id는 제거
      Object.keys(ev.perMember).forEach(mid => {
        if (!store.members.find(m => m.id === mid)) delete ev.perMember[mid];
      });
    });

    return changed;
  }

  // ---- Export ICS ----
  function wireExport() {
    const btnStar = $("#export-starred");
    const btnAll = $("#export-all");

    if (btnStar) {
      btnStar.addEventListener("click", () => {
        const calName = $("#calName")?.value || "공모 알림";
        const evs = (store.events || []).filter(e => e.starred);
        if (!evs.length) return alert("⭐ 일정이 없어요.");
        downloadIcs(evs, calName);
      });
    }

    if (btnAll) {
      btnAll.addEventListener("click", () => {
        const calName = $("#calName")?.value || "공모 알림";
        const evs = (store.events || []);
        if (!evs.length) return alert("일정이 없어요.");
        downloadIcs(evs, calName);
      });
    }
  }

  function toIcsDate(dateStr) {
    // all-day: YYYYMMDD
    return dateStr.replaceAll("-", "");
  }

  function addDays(dateStr, days) {
    const [y, m, d] = dateStr.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + days);
    const yy = dt.getUTCFullYear();
    const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(dt.getUTCDate()).padStart(2, "0");
    return `${yy}-${mm}-${dd}`;
  }

  function escapeIcsText(s) {
    return String(s ?? "")
      .replace(/\\/g, "\\\\")
      .replace(/\n/g, "\\n")
      .replace(/,/g, "\\,")
      .replace(/;/g, "\\;");
  }

  function downloadIcs(events, calName) {
    const now = new Date();
    const dtstamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");

    const lines = [];
    lines.push("BEGIN:VCALENDAR");
    lines.push("VERSION:2.0");
    lines.push("PRODID:-//IPO Family//KR//EN");
    lines.push("CALSCALE:GREGORIAN");
    lines.push(`X-WR-CALNAME:${escapeIcsText(calName)}`);

    for (const ev of events) {
      const uidv = `${ev.id}@ipo-family`;
      const start = toIcsDate(ev.sbd_start);
      // all-day DTEND must be next day
      const endNext = toIcsDate(addDays(ev.sbd_end, 1));

      const summary = `[공모주] ${ev.corp_name} 청약`;
      const desc = [
        `청약: ${ev.sbd_start} ~ ${ev.sbd_end}`,
        `증권사: ${ev.underwriters || "(없음/미정)"}`,
        `균등 최소금액: ${ev.equal_min || "(미정)"}`,
        ev.memo ? `메모: ${ev.memo}` : ""
      ].filter(Boolean).join("\n");

      lines.push("BEGIN:VEVENT");
      lines.push(`UID:${escapeIcsText(uidv)}`);
      lines.push(`DTSTAMP:${dtstamp}`);
      lines.push(`SUMMARY:${escapeIcsText(summary)}`);
      lines.push(`DESCRIPTION:${escapeIcsText(desc)}`);
      lines.push(`DTSTART;VALUE=DATE:${start}`);
      lines.push(`DTEND;VALUE=DATE:${endNext}`);
      lines.push("END:VEVENT");
    }

    lines.push("END:VCALENDAR");

    const blob = new Blob([lines.join("\r\n")], { type: "text/calendar;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ipo_${Date.now()}.ics`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  // ---- Util ----
  function escapeHtml(s) {
    return String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  // ---- Init ----
  function renderAll() {
    renderEvents();
    renderFamily();
  }

  function init() {
    wireTabs();
    wireFamilyForm();
    wireImport();
    wireExport();
    renderAll();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
