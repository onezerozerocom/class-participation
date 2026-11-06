import { api, isDemo } from "./api.js";

// ───────────────────────── 공통 도우미 ─────────────────────────
const app = document.getElementById("app");
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const byName = (a, b) => a.name.localeCompare(b.name, "ko", { numeric: true });

const STATUS = {
  stuck:    { emoji: "🔴", label: "막혔어요",        short: "막힘" },
  confused: { emoji: "🟡", label: "조금 헷갈려요",   short: "헷갈림" },
  good:     { emoji: "🟢", label: "잘 되고 있어요",  short: "순조로움" },
  done:     { emoji: "✅", label: "다 했어요",       short: "완료" },
  none:     { emoji: "⚪", label: "아직 선택 안 함", short: "미응답" },
};
const STATUS_ORDER = ["stuck", "confused", "none", "good", "done"];
const MARKS = ["①", "②", "③", "④", "⑤", "⑥"];

if (isDemo) $("#demo-banner").hidden = false;

// localStorage (체험 모드와 실제 모드를 분리해서 저장)
const NS = isDemo ? "cp-demo" : "cp-live";
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(`${NS}-${k}`)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`${NS}-${k}`, JSON.stringify(v)); } catch { /* 저장 불가 */ } },
};
const makeList = (key, idField) => ({
  all: () => store.get(key, []),
  find: (id) => store.get(key, []).find((x) => x[idField] === id),
  add: (item) => store.set(key, [item, ...store.get(key, []).filter((x) => x[idField] !== item[idField])].slice(0, 20)),
  remove: (id) => store.set(key, store.get(key, []).filter((x) => x[idField] !== id)),
});
const hosts = makeList("hosts", "room_id");            // 내가 만든 수업
const students = makeList("students", "participant_id"); // 내가 참여한 수업

function ago(iso) {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso)) / 1000));
  if (s < 10) return "방금";
  if (s < 60) return `${s}초`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}분` : `${Math.floor(m / 60)}시간 ${m % 60}분`;
}
// 경과 시간 표시는 5초마다 갱신
setInterval(() => $$("[data-since]").forEach((el) => (el.textContent = ago(el.dataset.since))), 5000);
const since = (iso) => `<span data-since="${iso}">${ago(iso)}</span>`;

function toast(msg, kind = "error") {
  const t = $("#toast");
  t.textContent = msg;
  t.className = `toast show ${kind}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.className = "toast"), 2800);
}

async function act(fn, btn) {
  if (btn) btn.disabled = true;
  try { return await fn(); }
  catch (e) { toast(e.message || String(e)); }
  finally { if (btn) btn.disabled = false; }
}

function noticeView(emoji, title, msg) {
  app.innerHTML = `
    <div class="notice card">
      <div class="big-emoji">${emoji}</div>
      <h2>${title}</h2>
      <p class="muted">${msg}</p>
      <a class="btn primary" href="#/">처음으로</a>
    </div>`;
}

// 방의 데이터를 읽고, 바뀔 때마다 다시 읽어 onData에 넘김
function liveRoom(roomId, onData, onConn) {
  let busy = false, again = false, timer = null, alive = true;
  const run = async () => {
    if (!alive) return;
    if (busy) { again = true; return; }
    busy = true;
    try {
      const d = await api.loadRoom(roomId);
      if (alive) onData(d);
    } catch (e) {
      console.error(e);
      onConn?.(false);
    } finally {
      busy = false;
      if (again) { again = false; run(); }
    }
  };
  const refresh = () => { clearTimeout(timer); timer = setTimeout(run, 60); };
  const unsub = api.subscribe(roomId, refresh, onConn);
  const poll = setInterval(run, 20000); // 실시간 연결이 끊겨도 20초마다는 갱신
  run();
  return () => { alive = false; unsub(); clearInterval(poll); clearTimeout(timer); };
}

const setConn = (ok) => {
  const el = $("#conn");
  if (!el) return;
  el.classList.toggle("on", ok);
  el.title = ok ? "실시간 연결됨" : "연결 끊김 — 다시 연결하는 중";
};

// 퀴즈 보기 목록 (교사·학생 공용)
function optionRows(q, answers, { mine, correct, showBars, clickable }) {
  const total = answers.length;
  return `<div class="opts">${q.options.map((text, i) => {
    const n = answers.filter((a) => a.choice === i).length;
    const pct = total ? Math.round((n / total) * 100) : 0;
    const cls = [
      "opt",
      mine === i && "mine",
      correct === i && "correct",
      correct != null && mine === i && correct !== i && "wrong",
      showBars && "bars",
    ].filter(Boolean).join(" ");
    return `<button class="${cls}" data-choice="${i}" style="--p:${showBars ? pct : 0}%" ${clickable ? "" : "disabled"}>
      <span class="opt-mark">${MARKS[i]}</span>
      <span class="opt-text">${esc(text)}</span>
      ${correct === i ? '<span class="opt-tag">정답</span>' : ""}
      ${mine === i ? '<span class="opt-tag mine-tag">내 답</span>' : ""}
      ${showBars ? `<span class="opt-count">${n}명 · ${pct}%</span>` : ""}
    </button>`;
  }).join("")}</div>`;
}

// ───────────────────────── 라우터 ─────────────────────────
let cleanup = null;
function route() {
  cleanup?.();
  cleanup = null;
  document.title = "수업 참여 도구";
  const m = location.hash.match(/^#\/(t|s)\/([\w-]+)/);
  if (m?.[1] === "t") cleanup = teacherView(m[2]);
  else if (m?.[1] === "s") cleanup = studentView(m[2]);
  else homeView();
}
window.addEventListener("hashchange", route);

function go(hash) {
  // ?code=… 같은 주소 파라미터는 지우고 이동
  history.replaceState(null, "", location.pathname + hash);
  route();
}

// ───────────────────────── 첫 화면 ─────────────────────────
function homeView() {
  const code = (new URLSearchParams(location.search).get("code") || "").replace(/\D/g, "").slice(0, 6);
  const myHosts = hosts.all();
  const myJoins = students.all();

  app.innerHTML = `
    <div class="home">
      <header class="hero">
        <div class="hero-emoji">🙋</div>
        <h1>실시간 수업 참여</h1>
        <p class="muted">도움 요청 대기열 · 이해도 체크 · 퀴즈</p>
      </header>

      <div class="home-grid">
        <form id="join-form" class="card">
          <h2>학생으로 참여하기</h2>
          <label class="field">참여 코드
            <input id="join-code" class="code-input" inputmode="numeric" maxlength="6"
                   placeholder="000000" autocomplete="off" value="${code}" required />
          </label>
          <label class="field">이름 또는 번호
            <input id="join-name" maxlength="20" placeholder="예: 12번" autocomplete="off" required />
          </label>
          <p class="hint">실명 대신 <b>번호</b>나 <b>번호+이니셜</b>을 써 주세요.</p>
          <button class="btn primary big">입장하기</button>
          ${myJoins.length ? `
            <div class="recent">
              <div class="recent-title">최근 참여한 수업</div>
              ${myJoins.map((s) => `
                <a class="recent-item" href="#/s/${s.participant_id}">
                  <span><b>${esc(s.title)}</b> <span class="muted">· ${esc(s.name)}</span></span>
                  <span class="muted">다시 들어가기 →</span>
                </a>`).join("")}
            </div>` : ""}
        </form>

        <form id="create-form" class="card">
          <h2>선생님: 수업 방 만들기</h2>
          <label class="field">수업 이름
            <input id="room-title" maxlength="40" placeholder="예: 2반 정보 – 반복문 실습" autocomplete="off" required />
          </label>
          <button class="btn primary big">방 만들기</button>
          ${myHosts.length ? `
            <div class="recent">
              <div class="recent-title">내가 만든 수업</div>
              ${myHosts.map((h) => `
                <a class="recent-item" href="#/t/${h.room_id}">
                  <span><b>${esc(h.title)}</b> <span class="muted">· 코드 ${h.code}</span></span>
                  <span class="muted">열기 →</span>
                </a>`).join("")}
            </div>` : ""}
        </form>
      </div>
    </div>`;

  const codeInput = $("#join-code");
  codeInput.addEventListener("input", () => (codeInput.value = codeInput.value.replace(/\D/g, "").slice(0, 6)));
  (code ? $("#join-name") : codeInput).focus();

  $("#join-form").addEventListener("submit", (e) => {
    e.preventDefault();
    act(async () => {
      const r = await api.rpc("join_room", { p_code: codeInput.value, p_name: $("#join-name").value });
      students.add(r);
      go(`#/s/${r.participant_id}`);
    }, e.submitter);
  });

  $("#create-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const title = $("#room-title").value.trim();
    act(async () => {
      const r = await api.rpc("create_room", { p_title: title });
      hosts.add({ ...r, title, created_at: new Date().toISOString() });
      go(`#/t/${r.room_id}`);
    }, e.submitter);
  });
}

// ───────────────────────── 학생 화면 ─────────────────────────
function studentView(pid) {
  const me = students.find(pid);
  if (!me) { noticeView("🔑", "참여 정보가 없어요", "참여 코드로 다시 입장해 주세요."); return null; }
  const K = { p_pid: pid, p_key: me.key };

  app.innerHTML = `
    <header class="topbar">
      <div class="tb-title"><span id="conn" class="conn"></span><b>${esc(me.title)}</b>
        <span class="muted">코드 ${me.code}</span></div>
      <div class="tb-right"><span class="chip">👤 ${esc(me.name)}</span>
        <button class="btn ghost small" id="leave">나가기</button></div>
    </header>
    <main class="student">
      <section class="card">
        <h2>지금 내 상태는?</h2>
        <div class="status-btns">
          ${["good", "confused", "stuck", "done"].map((s) => `
            <button class="status-btn s-${s}" data-status="${s}">
              <span class="emoji">${STATUS[s].emoji}</span>${STATUS[s].label}
            </button>`).join("")}
        </div>
      </section>

      <section class="card" id="quiz-card" hidden></section>

      <section class="card help-card">
        <h2>🙋 선생님 도와주세요</h2>
        <div id="help-state"></div>
        <input id="help-note" maxlength="100" autocomplete="off"
               placeholder="어디서 막혔나요? (선택) 예: 3번 문제에서 오류가 나요" />
        <div class="row">
          <button class="btn danger big" id="help-btn">도움 요청하기</button>
          <button class="btn big" id="help-cancel" hidden>요청 취소</button>
        </div>
      </section>
    </main>`;

  let data = null;
  const note = $("#help-note");
  const myReq = () => data?.help.find((h) => h.participant_id === pid);

  $$(".status-btn").forEach((b) => b.addEventListener("click", () => {
    $$(".status-btn").forEach((x) => x.classList.toggle("selected", x === b)); // 먼저 화면에 반영
    act(() => api.rpc("set_status", { ...K, p_status: b.dataset.status }));
  }));
  $("#help-btn").addEventListener("click", (e) => {
    const editing = !!myReq();
    act(async () => {
      await api.rpc("request_help", { ...K, p_note: note.value });
      toast(editing ? "메모를 고쳤어요" : "도움 요청을 보냈어요. 선생님이 곧 오실 거예요!", "ok");
    }, e.currentTarget);
  });
  $("#help-cancel").addEventListener("click", (e) =>
    act(async () => { await api.rpc("cancel_help", K); note.value = ""; }, e.currentTarget));
  const submitText = (btn) => {
    const ta = $("#text-answer");
    if (!ta || !data?.quiz) return;
    if (!ta.value.trim()) { toast("답을 입력해 주세요"); ta.focus(); return; }
    act(async () => {
      await api.rpc("answer_text", { ...K, p_quiz: data.quiz.id, p_text: ta.value });
      toast("제출했어요!", "ok");
    }, btn);
  };
  $("#quiz-card").addEventListener("keydown", (e) => {
    if (e.target.id === "text-answer" && e.key === "Enter" && (e.ctrlKey || e.metaKey)) submitText($("#text-submit"));
  });
  $("#quiz-card").addEventListener("click", (e) => {
    const sub = e.target.closest("#text-submit");
    if (sub) { submitText(sub); return; }
    const b = e.target.closest("[data-choice]");
    if (!b || b.disabled || !data?.quiz) return;
    $$("#quiz-card .opt").forEach((x) => x.classList.toggle("mine", x === b));
    act(() => api.rpc("answer_quiz", { ...K, p_quiz: data.quiz.id, p_choice: +b.dataset.choice }));
  });
  $("#leave").addEventListener("click", () => {
    if (!confirm("이 기기에서 수업을 나갈까요?\n(다시 들어오려면 참여 코드로 새로 입장해야 해요)")) return;
    students.remove(pid);
    go("#/");
  });

  function render(d) {
    if (!d) {
      students.remove(pid);
      stop();
      noticeView("👋", "수업이 끝났어요", "선생님이 수업 방을 닫았어요. 수고했어요!");
      return;
    }
    const p = d.participants.find((x) => x.id === pid);
    if (!p) {
      students.remove(pid);
      stop();
      noticeView("🚪", "참여 목록에서 빠졌어요", "필요하면 참여 코드로 다시 입장해 주세요.");
      return;
    }
    data = d;
    $$(".status-btn").forEach((b) => b.classList.toggle("selected", b.dataset.status === p.status));

    // 도움 요청
    const req = myReq();
    const helpState = $("#help-state");
    if (!req) {
      helpState.innerHTML = "";
      $("#help-btn").textContent = "도움 요청하기";
      $("#help-btn").className = "btn danger big";
      $("#help-cancel").hidden = true;
    } else {
      if (!note.value && document.activeElement !== note) note.value = req.note;
      const waiting = d.help.filter((h) => h.state === "waiting");
      helpState.innerHTML = req.state === "helping"
        ? `<div class="help-banner coming">🏃 선생님이 가는 중이에요!</div>`
        : `<div class="help-banner waiting">대기 <b>${waiting.indexOf(req) + 1}</b>번째
             <span class="muted">· 기다린 시간 ${since(req.created_at)}</span></div>`;
      $("#help-btn").textContent = "메모 고치기";
      $("#help-btn").className = "btn big";
      $("#help-cancel").hidden = false;
    }

    // 퀴즈
    const card = $("#quiz-card");
    const q = d.quiz;
    card.hidden = !q;
    if (!q) { card.innerHTML = ""; card.dataset.key = ""; return; }

    if (q.kind === "text") {
      const myA = d.answers.find((a) => a.participant_id === pid);
      const open = q.state === "open";
      // 입력 중인 글이 지워지지 않도록, 질문이나 상태가 바뀔 때만 칸을 새로 그림
      const key = `${q.id}:${q.state}`;
      if (card.dataset.key !== key) {
        card.dataset.key = key;
        card.innerHTML = `
          <h2>💬 선생님 질문</h2>
          <div class="quiz-q">${esc(q.question)}</div>
          <div class="quiz-head" id="text-head"></div>
          <textarea id="text-answer" rows="3" maxlength="200" placeholder="짧게 적어 주세요 (200자까지)"
                    ${open ? "" : "disabled"}>${esc(myA?.text ?? "")}</textarea>
          ${open ? '<button class="btn primary big" id="text-submit">제출하기</button>' : ""}
          <ul class="text-answers wall" id="text-wall" hidden></ul>`;
      }
      const ta = $("#text-answer");
      if (myA && !ta.value && document.activeElement !== ta) ta.value = myA.text;
      $("#text-head").textContent =
        open ? (myA ? "✅ 제출 완료! 마감 전까지는 고쳐서 다시 낼 수 있어요" : "생각을 짧게 적어 주세요")
        : q.state === "closed" ? "⏸ 응답이 마감되었어요"
        : "📢 친구들의 답이 공개되었어요 (이름 없이)";
      if ($("#text-submit")) $("#text-submit").textContent = myA ? "고쳐서 다시 내기" : "제출하기";
      const wall = $("#text-wall");
      wall.hidden = q.state !== "revealed";
      if (!wall.hidden) {
        wall.innerHTML = [...d.answers].sort((a, b) => a.created_at.localeCompare(b.created_at)).map((a) =>
          `<li class="${a.participant_id === pid ? "mine" : ""}"><span>${esc(a.text)}</span>${a.participant_id === pid ? '<span class="opt-tag">내 답</span>' : ""}</li>`,
        ).join("") || '<li class="empty">응답이 없어요</li>';
      }
      return;
    }
    card.dataset.key = "";
    const mine = d.answers.find((a) => a.participant_id === pid)?.choice;
    const revealed = q.state === "revealed";
    const correct = revealed ? q.correct : null;
    let head;
    if (q.state === "open") head = mine == null ? "답을 골라 주세요" : "응답 완료! 마감 전까지는 바꿀 수 있어요";
    else if (q.state === "closed") head = "⏸ 응답이 마감되었어요. 결과를 기다려 주세요";
    else if (correct == null) head = "📊 결과가 공개되었어요";
    else if (mine == null) head = "응답하지 않았어요. 정답을 확인해 보세요";
    else head = mine === correct ? "🎉 정답이에요!" : "😅 아쉬워요! 정답을 확인해 보세요";
    card.innerHTML = `
      <h2>📝 퀴즈</h2>
      <div class="quiz-q">${esc(q.question)}</div>
      <div class="quiz-head ${revealed && correct != null ? (mine === correct ? "ok" : "no") : ""}">${head}</div>
      ${optionRows(q, d.answers, { mine, correct, showBars: revealed, clickable: q.state === "open" })}`;
  }

  const stop = liveRoom(me.room_id, render, setConn);
  return stop;
}

// ───────────────────────── 교사 화면 ─────────────────────────
function teacherView(roomId) {
  const host = hosts.find(roomId);
  if (!host) {
    noticeView("🔒", "교사 권한이 없어요", "수업 방을 만든 기기(브라우저)에서만 교사 화면을 열 수 있어요.");
    return null;
  }
  const H = { p_room: roomId, p_key: host.host_key };
  const joinUrl = `${location.origin}${location.pathname}?code=${host.code}`;
  let data = null;
  let seenHelp = null; // 이미 본 도움 요청 id (새 요청 알림용)
  let sortMode = store.get("sort", "num");
  let soundOn = store.get("sound", true);
  let qKind = "text";                            // 새로 낼 문제 종류: 짧은 답(기본) / 객관식
  let hideNames = store.get("hide-names", false); // 짧은 답 목록에서 이름 숨기기 (화면 공유할 때)

  app.innerHTML = `
    <header class="topbar">
      <div class="tb-title"><span id="conn" class="conn"></span><b>${esc(host.title)}</b></div>
      <button class="code-chip" id="code-chip" title="크게 보기 (학생 접속 안내)">
        참여 코드 <b>${host.code.slice(0, 3)} ${host.code.slice(3)}</b> <span class="muted">⤢</span>
      </button>
      <div class="tb-right">
        ${isDemo ? `<a class="btn ghost small" href="${joinUrl}" target="_blank">＋ 학생 탭 열기</a>` : ""}
        <button class="btn ghost small" id="sound-btn"></button>
        <a class="btn ghost small" href="#/">처음으로</a>
        <button class="btn danger small" id="end-btn">수업 종료</button>
      </div>
    </header>

    <main class="teacher">
      <section class="card summary" id="summary"></section>

      <section class="card board">
        <div class="card-head">
          <h2>학생 현황 <span class="muted" id="board-count"></span></h2>
          <div class="row">
            <div class="seg" id="sort-seg">
              <button data-sort="num">번호순</button><button data-sort="status">막힌 학생 먼저</button>
            </div>
            <button class="btn small" id="reset-btn" title="모든 학생의 상태를 '미응답'으로">상태 초기화</button>
          </div>
        </div>
        <div class="grid" id="grid"></div>
      </section>

      <section class="card queue">
        <div class="card-head">
          <h2>🙋 도움 요청 <span class="badge" id="queue-badge"></span></h2>
          <span class="muted small" id="done-count"></span>
        </div>
        <ol class="queue-list" id="queue"></ol>
      </section>

      <section class="card quiz">
        <div class="card-head"><h2>📝 퀴즈 · 질문</h2></div>
        <form id="quiz-form">
          <div class="seg kind-seg" id="kind-seg">
            <button type="button" data-kind="text">짧은 답 질문</button><button type="button" data-kind="choice">객관식 퀴즈 · 설문</button>
          </div>
          <div class="tpls">
            <button type="button" class="btn small" data-tpl="ox">O / X</button>
            <button type="button" class="btn small" data-tpl="four">4지선다</button>
            <button type="button" class="btn small" data-tpl="check">이해도 1~5</button>
          </div>
          <textarea id="q-question" rows="2" maxlength="200"
                    placeholder="질문 (비워 두면 '화면의 문제에 답하세요')"></textarea>
          <div id="choice-fields">
            <div id="q-options"></div>
            <div class="row between">
              <button type="button" class="btn small ghost" id="q-add">＋ 보기 추가</button>
              <span class="hint">○ 정답을 고르세요 (안 고르면 설문형)</span>
            </div>
          </div>
          <p class="hint" id="text-hint" hidden>학생들이 한두 문장(200자까지)으로 답해요. 공개하면 학생 화면에 <b>이름 없이</b> 모든 답이 보여요.</p>
          <button class="btn primary big" id="q-start">퀴즈 시작</button>
        </form>
        <div id="quiz-live" hidden></div>
      </section>
    </main>

    <dialog id="join-dlg" class="join-dlg">
      <div class="jd-title">${esc(host.title)}</div>
      <div class="jd-label">참여 코드</div>
      <div class="jd-code">${host.code.slice(0, 3)} ${host.code.slice(3)}</div>
      <div id="jd-qr" class="jd-qr"></div>
      <div class="jd-url">${esc(joinUrl)}</div>
      ${isDemo ? '<p class="hint">체험 모드: 같은 브라우저의 다른 탭에서만 참여할 수 있어요.</p>' : ""}
      <form method="dialog"><button class="btn big">닫기</button></form>
    </dialog>`;

  // ── 상단 버튼
  const soundBtn = $("#sound-btn");
  const paintSound = () => (soundBtn.textContent = soundOn ? "🔔 알림음 켬" : "🔕 알림음 끔");
  paintSound();
  soundBtn.addEventListener("click", () => { soundOn = !soundOn; store.set("sound", soundOn); paintSound(); if (soundOn) beep(); });

  $("#code-chip").addEventListener("click", async () => {
    $("#join-dlg").showModal();
    const box = $("#jd-qr");
    if (box.innerHTML) return;
    try {
      const qrcode = await loadQr();
      const qr = qrcode(0, "M");
      qr.addData(joinUrl);
      qr.make();
      box.innerHTML = qr.createSvgTag({ cellSize: 8, margin: 2, scalable: true });
    } catch { box.hidden = true; }
  });

  $("#end-btn").addEventListener("click", (e) => {
    if (!confirm("수업을 종료할까요?\n학생 목록·도움 요청·퀴즈 기록이 모두 삭제되고 학생 화면도 닫힙니다.")) return;
    act(async () => {
      await api.rpc("host_delete_room", H);
      hosts.remove(roomId);
      go("#/");
      toast("수업을 종료했어요", "ok");
    }, e.currentTarget);
  });

  // ── 학생 현황
  const paintSort = () => $$("#sort-seg button").forEach((b) => b.classList.toggle("on", b.dataset.sort === sortMode));
  paintSort();
  $("#sort-seg").addEventListener("click", (e) => {
    const b = e.target.closest("[data-sort]");
    if (!b) return;
    sortMode = b.dataset.sort;
    store.set("sort", sortMode);
    paintSort();
    render(data);
  });
  $("#reset-btn").addEventListener("click", (e) => {
    if (!confirm("모든 학생의 상태를 '미응답'으로 되돌릴까요?\n(새 활동을 시작할 때 쓰면 좋아요)")) return;
    act(() => api.rpc("host_reset_status", H), e.currentTarget);
  });
  $("#grid").addEventListener("click", (e) => {
    const b = e.target.closest("[data-remove]");
    if (!b) return;
    const p = data?.participants.find((x) => x.id === b.dataset.remove);
    if (!p || !confirm(`'${p.name}' 학생을 참여 목록에서 내보낼까요?`)) return;
    act(() => api.rpc("host_remove_participant", { ...H, p_pid: p.id }));
  });

  // ── 도움 요청
  $("#queue").addEventListener("click", (e) => {
    const b = e.target.closest("[data-help]");
    if (b) act(() => api.rpc("host_set_help_state", { ...H, p_req: b.dataset.help, p_state: b.dataset.state }), b);
  });

  // ── 퀴즈 만들기
  const TEMPLATES = {
    ox: { options: ["O", "X"] },
    four: { options: ["1", "2", "3", "4"] },
    check: {
      question: "지금 배운 내용을 얼마나 이해했나요?",
      options: ["1 · 전혀 모르겠어요", "2 · 조금 알 것 같아요", "3 · 보통이에요", "4 · 거의 이해했어요", "5 · 완벽해요"],
      noCorrect: true,
    },
  };
  const optBox = $("#q-options");
  const readOpts = () => $$(".opt-input", optBox).map((i) => i.value);
  const readCorrect = () => {
    const r = $("input[name=correct]:checked", optBox);
    return r ? +r.value : null;
  };
  function paintOpts(opts, correct = null) {
    optBox.innerHTML = opts.map((v, i) => `
      <div class="opt-row">
        <label class="opt-radio" title="정답으로 지정"><input type="radio" name="correct" value="${i}" ${correct === i ? "checked" : ""}>
          <span>${MARKS[i]}</span></label>
        <input class="opt-input" maxlength="60" value="${esc(v)}" placeholder="보기 ${i + 1}" />
        <button type="button" class="btn small ghost" data-del="${i}" ${opts.length <= 2 ? "disabled" : ""} title="보기 삭제">×</button>
      </div>`).join("");
    $("#q-add").disabled = opts.length >= 6;
  }
  paintOpts(TEMPLATES.four.options);
  // 같은 정답 버튼을 다시 누르면 선택 해제 (설문형으로)
  optBox.addEventListener("mousedown", (e) => {
    const r = e.target.closest(".opt-radio")?.querySelector("input");
    if (r) r.dataset.was = r.checked ? "1" : "";
  });
  optBox.addEventListener("click", (e) => {
    const r = e.target.closest(".opt-radio input");
    if (r && r.dataset.was === "1") { r.checked = false; r.dataset.was = ""; }
    const del = e.target.closest("[data-del]");
    if (del) {
      const opts = readOpts();
      let c = readCorrect();
      const i = +del.dataset.del;
      opts.splice(i, 1);
      if (c === i) c = null; else if (c > i) c--;
      paintOpts(opts, c);
    }
  });
  $("#q-add").addEventListener("click", () => {
    const opts = readOpts();
    paintOpts([...opts, ""], readCorrect());
    $$(".opt-input", optBox).at(-1).focus();
  });
  $(".tpls").addEventListener("click", (e) => {
    const t = TEMPLATES[e.target.closest("[data-tpl]")?.dataset.tpl];
    if (!t) return;
    if (t.question) $("#q-question").value = t.question;
    paintOpts(t.options);
  });
  const paintKind = () => {
    const text = qKind === "text";
    $$("#kind-seg button").forEach((b) => b.classList.toggle("on", b.dataset.kind === qKind));
    $(".tpls").hidden = text;
    $("#choice-fields").hidden = text;
    $("#text-hint").hidden = !text;
    $("#q-question").placeholder = text
      ? "학생에게 물어볼 질문 (예: 오늘 수업에서 가장 헷갈렸던 부분은?)"
      : "질문 (비워 두면 '화면의 문제에 답하세요')";
    $("#q-start").textContent = text ? "질문 보내기" : "퀴즈 시작";
  };
  paintKind();
  $("#kind-seg").addEventListener("click", (e) => {
    const b = e.target.closest("[data-kind]");
    if (!b) return;
    qKind = b.dataset.kind;
    paintKind();
    $("#q-question").focus();
  });

  $("#quiz-form").addEventListener("submit", (e) => {
    e.preventDefault();
    if (qKind === "text") {
      const question = $("#q-question").value.trim();
      if (!question) { toast("질문을 입력해 주세요"); $("#q-question").focus(); return; }
      act(async () => {
        await api.rpc("host_create_question", { ...H, p_question: question });
        $("#q-question").value = "";
      }, e.submitter);
      return;
    }
    const question = $("#q-question").value.trim() || "화면의 문제에 답하세요";
    const options = readOpts().map((v, i) => v.trim() || String(i + 1));
    const correct = readCorrect();
    act(async () => {
      const id = await api.rpc("host_create_quiz", { ...H, p_question: question, p_options: options, p_correct: correct });
      // 정답은 공개 전까지 서버의 비밀 테이블에만 있으므로, 교사 화면 표시용으로 이 기기에도 기억해 둠
      const answersKey = store.get("quiz-correct", {});
      answersKey[id] = correct;
      store.set("quiz-correct", answersKey);
      $("#q-question").value = "";
    }, e.submitter);
  });

  // ── 진행 중인 퀴즈
  $("#quiz-live").addEventListener("change", (e) => {
    if (e.target.id !== "hide-names") return;
    hideNames = e.target.checked;
    store.set("hide-names", hideNames);
    render(data);
  });
  $("#quiz-live").addEventListener("click", (e) => {
    const b = e.target.closest("[data-qstate]");
    if (b && data?.quiz) act(() => api.rpc("host_set_quiz_state", { ...H, p_quiz: data.quiz.id, p_state: b.dataset.qstate }), b);
  });

  // ── 그리기
  function render(d) {
    if (d === null) {
      hosts.remove(roomId);
      stop();
      noticeView("👋", "종료된 수업이에요", "이 수업 방은 이미 닫혔어요.");
      return;
    }
    if (!d) return;
    data = d;
    const ps = d.participants;
    const reqOf = new Map(d.help.map((h) => [h.participant_id, h]));
    const nameOf = new Map(ps.map((p) => [p.id, p.name]));
    const waiting = d.help.filter((h) => h.state === "waiting");

    // 새 도움 요청 알림
    const ids = new Set(d.help.map((h) => h.id));
    if (seenHelp && soundOn && waiting.some((h) => !seenHelp.has(h.id))) beep();
    seenHelp = ids;
    document.title = waiting.length ? `(${waiting.length}) 🙋 ${host.title}` : `${host.title} – 수업 참여`;

    // 요약
    const counts = Object.fromEntries(STATUS_ORDER.map((s) => [s, ps.filter((p) => p.status === s).length]));
    $("#summary").innerHTML = `
      <div class="sum-stats">
        <div class="sum-total">참여 <b>${ps.length}</b>명</div>
        ${STATUS_ORDER.map((s) => `
          <div class="sum-item s-${s}"><span>${STATUS[s].emoji} ${STATUS[s].short}</span><b>${counts[s]}</b></div>`).join("")}
        <div class="sum-item help"><span>🙋 도움 대기</span><b>${waiting.length}</b></div>
      </div>
      <div class="stackbar">${ps.length ? STATUS_ORDER.filter((s) => counts[s]).map((s) => `
        <div class="seg-bar s-${s}" style="flex:${counts[s]}" title="${STATUS[s].label} ${counts[s]}명">
          ${Math.round((counts[s] / ps.length) * 100)}%</div>`).join("") : '<div class="seg-bar seg-empty">아직 참여한 학생이 없어요</div>'}
      </div>`;

    // 학생 카드
    const sorted = [...ps].sort(byName);
    if (sortMode === "status") {
      sorted.sort((a, b) => {
        const ra = reqOf.has(a.id) ? -1 : 0, rb = reqOf.has(b.id) ? -1 : 0;
        return ra - rb || STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || byName(a, b);
      });
    }
    const answered = new Set(d.answers.map((a) => a.participant_id));
    $("#board-count").textContent = `${ps.length}명`;
    $("#grid").innerHTML = sorted.length ? sorted.map((p) => {
      const r = reqOf.get(p.id);
      const showTime = p.status === "stuck" || p.status === "confused";
      return `
        <div class="tile s-${p.status} ${r ? "has-help" : ""}" title="${esc(p.name)} · ${STATUS[p.status].label}">
          <button class="tile-x" data-remove="${p.id}" title="목록에서 내보내기">×</button>
          <div class="tile-name">${esc(p.name)}</div>
          <div class="tile-status">${STATUS[p.status].emoji} ${STATUS[p.status].short}${showTime ? ` · ${since(p.updated_at)}` : ""}</div>
          ${r ? `<div class="tile-help ${r.state}">${r.state === "helping" ? "🏃 가는 중" : `🙋 ${since(r.created_at)}`}</div>` : ""}
          ${d.quiz ? `<div class="tile-quiz ${answered.has(p.id) ? "on" : ""}" title="${answered.has(p.id) ? "퀴즈 응답함" : "퀴즈 미응답"}"></div>` : ""}
        </div>`;
    }).join("") : `<div class="empty">학생들이 참여 코드 <b>${host.code}</b>로 들어오면 여기에 나타나요.</div>`;

    // 대기열 (가는 중 → 대기 순)
    const queue = [...d.help].sort((a, b) =>
      (a.state === "helping" ? 0 : 1) - (b.state === "helping" ? 0 : 1) || a.created_at.localeCompare(b.created_at));
    $("#queue-badge").textContent = waiting.length || "";
    $("#done-count").textContent = d.doneCount ? `해결 ${d.doneCount}건` : "";
    $("#queue").innerHTML = queue.length ? queue.map((h) => `
      <li class="q-item ${h.state}">
        <div class="q-num">${h.state === "helping" ? "🏃" : waiting.indexOf(h) + 1}</div>
        <div class="q-body">
          <div class="q-name">${esc(nameOf.get(h.participant_id) ?? "?")}</div>
          ${h.note ? `<div class="q-note">“${esc(h.note)}”</div>` : ""}
          <div class="q-time muted">${since(h.created_at)} 전 요청${h.state === "helping" ? " · 가는 중" : ""}</div>
        </div>
        <div class="q-actions">
          ${h.state === "waiting"
            ? `<button class="btn small" data-help="${h.id}" data-state="helping">가는 중</button>`
            : `<button class="btn small ghost" data-help="${h.id}" data-state="waiting">대기로</button>`}
          <button class="btn small primary" data-help="${h.id}" data-state="done">해결 ✓</button>
        </div>
      </li>`).join("") : `<li class="empty">도움 요청이 없어요 👍</li>`;

    // 퀴즈
    const q = d.quiz;
    $("#quiz-form").hidden = !!q;
    const live = $("#quiz-live");
    live.hidden = !q;
    if (q) {
      const correct = q.correct ?? store.get("quiz-correct", {})[q.id] ?? null;
      const missing = sorted.filter((p) => !answered.has(p.id)).sort(byName);
      const isText = q.kind === "text";
      const stateLabel = { open: "응답 받는 중", closed: "응답 마감", revealed: isText ? "학생에게 공개됨" : "결과 공개됨" }[q.state];
      const textList = isText ? `
        <ul class="text-answers">${[...d.answers].sort((a, b) => a.created_at.localeCompare(b.created_at)).map((a) => `
          <li>${hideNames ? "" : `<b>${esc(nameOf.get(a.participant_id) ?? "?")}</b>`}<span>${esc(a.text)}</span></li>`).join("")
          || '<li class="empty">아직 응답이 없어요</li>'}
        </ul>` : "";
      live.innerHTML = `
        <div class="quiz-q">${isText ? "💬 " : ""}${esc(q.question)}</div>
        <div class="quiz-meta">
          <span class="pill ${q.state}">${stateLabel}</span>
          <span>응답 <b>${d.answers.length}</b> / ${ps.length}명</span>
          ${isText ? `<label class="check small"><input type="checkbox" id="hide-names" ${hideNames ? "checked" : ""}> 이름 숨기기</label>` : ""}
        </div>
        <div class="progress"><div style="width:${ps.length ? (d.answers.length / ps.length) * 100 : 0}%"></div></div>
        ${isText ? textList : optionRows(q, d.answers, { correct, showBars: true, clickable: false })}
        ${missing.length && q.state !== "revealed"
          ? `<div class="missing"><span class="muted">미응답</span> ${missing.map((p) => esc(p.name)).join(", ")}</div>` : ""}
        <div class="row wrap">
          ${q.state === "open" ? `<button class="btn primary" data-qstate="closed">응답 마감</button>` : ""}
          ${q.state === "closed" ? `
            <button class="btn" data-qstate="open">다시 받기</button>
            <button class="btn primary" data-qstate="revealed">${isText ? "학생에게 공개" : correct == null ? "결과 공개" : "정답 공개"}</button>` : ""}
          <button class="btn ghost" data-qstate="ended">${q.state === "revealed" ? "새로 만들기" : "취소하기"}</button>
        </div>`;
    }
  }

  const stop = liveRoom(roomId, render, setConn);
  return stop;
}

// ───────────────────────── 기타 ─────────────────────────
let audioCtx;
function beep() {
  try {
    audioCtx ||= new AudioContext();
    const t = audioCtx.currentTime;
    [880, 1175].forEach((f, i) => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t + i * 0.15);
      g.gain.exponentialRampToValueAtTime(0.2, t + i * 0.15 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.15 + 0.3);
      o.connect(g).connect(audioCtx.destination);
      o.start(t + i * 0.15);
      o.stop(t + i * 0.15 + 0.32);
    });
  } catch { /* 소리 재생 불가 */ }
}
// 브라우저 정책상 소리는 사용자가 한 번 클릭한 뒤에 날 수 있음
document.addEventListener("pointerdown", () => audioCtx?.state === "suspended" && audioCtx.resume());

function loadQr() {
  return (loadQr.p ||= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js";
    s.onload = () => resolve(window.qrcode);
    s.onerror = reject;
    document.head.append(s);
  }));
}

route();
