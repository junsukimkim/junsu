<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>공모 알림 (4인가족)</title>
  <link rel="manifest" href="manifest.webmanifest">
  <meta name="theme-color" content="#111111" />
  <link rel="stylesheet" href="styles.css" />
</head>
<body>
  <header class="header">
    <div class="title">
      <h1>공모 알림</h1>
      <p>가족 체크 + 캘린더(.ics) + 미리알림(단축어) + 자동 가져오기</p>
    </div>
    <nav class="tabs">
      <button class="tab active" data-tab="events">일정</button>
      <button class="tab" data-tab="family">가족</button>
      <button class="tab" data-tab="export">내보내기</button>
    </nav>
  </header>

  <main class="main">
    <!-- EVENTS -->
    <section id="tab-events" class="panel active">
      <div class="card">
        <h2>자동 가져오기</h2>
        <p class="muted">
          범위: <b>오늘 ~ 다음달 말</b> (이번달+다음달을 자동으로 합쳐서 보여줘요)
        </p>
        <div class="row">
          <button id="import-dart" type="button" class="btn primary">DART에서 일정 자동 채우기</button>
          <button id="clear-events" type="button" class="btn">가져온 일정 초기화</button>
        </div>
        <div id="import-status" class="muted" style="margin-top:8px;"></div>
        <small class="muted">
          * “증권사/균등 최소금액”은 보조 데이터(38 표)를 합쳐서 보여줍니다. 최종 확정은 공시로 확인하세요.
        </small>
      </div>

      <div class="card">
        <div class="row space">
          <h2>공모주 일정</h2>
          <small class="muted">가족별 체크(청약 완료/준비)를 눌러서 관리하세요.</small>
        </div>
        <div id="events-list" class="list"></div>
      </div>
    </section>

    <!-- FAMILY -->
    <section id="tab-family" class="panel">
      <div class="card">
        <h2>가족 관리</h2>
        <form id="family-form" class="form">
          <div class="row">
            <label>
              이름
              <input id="memberName" required placeholder="예: 엄마" />
            </label>
            <label>
              증권사 메모(선택)
              <input id="brokerNote" placeholder="예: 키움/미래에셋" />
            </label>
          </div>
          <button type="submit" class="btn primary">가족 추가</button>
        </form>
      </div>

      <div class="card">
        <h2>가족 목록</h2>
        <div id="family-list" class="list"></div>
        <small class="muted">기본 4명이 자동 생성돼요. 필요하면 이름만 바꿔도 OK.</small>
      </div>
    </section>

    <!-- EXPORT -->
    <section id="tab-export" class="panel">
      <div class="card">
        <h2>캘린더(.ics) 내보내기</h2>
        <p class="muted">
          iPhone에서 .ics 파일을 열면 캘린더로 가져오기 됩니다.
          일정 설명에 <b>증권사 + 균등 최소금액</b>을 넣어드려요.
        </p>
        <div class="row">
          <button id="export-cal" class="btn primary">캘린더(.ics) 다운로드</button>
          <button id="export-reminders-ics" class="btn">미리알림용(.ics) 다운로드(실험)</button>
        </div>
        <small class="muted">
          * “미리알림용 .ics”는 기기/설정에 따라 동작이 다를 수 있어요. 확실한 건 아래 단축어 방식.
        </small>
      </div>

      <div class="card">
        <h2>미리알림(아이폰 기본 앱) 추가</h2>
        <p class="muted">
          웹앱에서 미리알림 앱에 직접 추가는 iOS 보안 때문에 불가라서,
          <b>단축어(Shortcuts)</b> 1개만 만들어두면 버튼 한 번으로 자동 생성되게 할 수 있어요.
        </p>

        <div class="row">
          <button id="open-shortcut-help" class="btn primary">단축어 만들기 안내 보기</button>
          <button id="run-shortcut" class="btn">미리알림으로 추가(단축어 실행)</button>
        </div>

        <details class="details" id="shortcut-help" style="margin-top:10px;">
          <summary>단축어 만들기 (딱 1번만)</summary>
          <ol class="muted">
            <li>iPhone에서 <b>단축어</b> 앱 열기</li>
            <li><b>+</b> → ‘새 단축어’ 만들기</li>
            <li>이름을 정확히 <b>공모주 미리알림 추가</b> 로 설정</li>
            <li>동작 추가:
              <ul>
                <li><b>URL 내용 가져오기</b> (Get Contents of URL)</li>
                <li>URL: (단축어 입력으로 받을 예정) → “단축어 입력” 사용</li>
                <li>결과는 JSON</li>
              </ul>
            </li>
            <li>동작 추가:
              <ul>
                <li><b>반복</b> (Repeat with Each) — items 배열 반복</li>
                <li><b>미리알림 추가</b> (Add New Reminder)</li>
                <li>제목: “{회사명} 청약 준비”</li>
                <li>마감일: 시작일 - 1일</li>
                <li>메모: 증권사/균등금액</li>
              </ul>
            </li>
            <li>저장</li>
          </ol>
          <p class="muted">단축어가 한 번 만들어지면, 웹앱에서 “미리알림으로 추가” 버튼이 단축어를 실행합니다.</p>
        </details>
      </div>
    </section>
  </main>

  <script src="app.js"></script>
  <script>
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').catch(()=>{});
    }
  </script>
</body>
</html>
