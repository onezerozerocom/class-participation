// 데이터 계층: Supabase 구현과 체험 모드(localStorage) 구현이 같은 모양의 API를 제공합니다.
//   api.rpc(name, args)          쓰기 (schema.sql의 함수와 이름·인자가 같음)
//   api.loadRoom(roomId)         방 전체 상태 읽기 → { room, participants, help, quiz, answers }
//   api.subscribe(roomId, cb)    방에 변화가 생기면 cb() 호출, 해제 함수 반환
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

export const isDemo = !SUPABASE_URL || !SUPABASE_ANON_KEY;

export const api = isDemo ? await makeDemoApi() : await makeSupabaseApi();

// ───────────────────────── Supabase ─────────────────────────
async function makeSupabaseApi() {
  const { createClient } = await import("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm");
  const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
    realtime: { params: { eventsPerSecond: 20 } },
  });

  const check = ({ data, error }) => {
    if (error) throw new Error(error.message);
    return data;
  };

  return {
    async rpc(name, args) {
      return check(await sb.rpc(name, args));
    },

    async loadRoom(roomId) {
      const room = check(await sb.from("rooms").select("*").eq("id", roomId).maybeSingle());
      if (!room) return null;
      const [participants, help, quiz, answers] = await Promise.all([
        sb.from("participants").select("*").eq("room_id", roomId).then(check),
        sb.from("help_requests").select("*").eq("room_id", roomId)
          .in("state", ["waiting", "helping"]).order("created_at").then(check),
        room.active_quiz_id
          ? sb.from("quizzes").select("*").eq("id", room.active_quiz_id).maybeSingle().then(check)
          : null,
        room.active_quiz_id
          ? sb.from("quiz_answers").select("*").eq("quiz_id", room.active_quiz_id).then(check)
          : [],
      ]);
      const doneCount = check(await sb.from("help_requests").select("id", { count: "exact", head: true })
        .eq("room_id", roomId).eq("state", "done").then((r) => ({ data: r.count, error: r.error })));
      return { room, participants, help, quiz, answers, doneCount };
    },

    subscribe(roomId, cb, onStatus) {
      const ch = sb.channel(`room-${roomId}`);
      const f = `room_id=eq.${roomId}`;
      ch.on("postgres_changes", { event: "*", schema: "public", table: "rooms", filter: `id=eq.${roomId}` }, cb)
        .on("postgres_changes", { event: "*", schema: "public", table: "participants", filter: f }, cb)
        .on("postgres_changes", { event: "*", schema: "public", table: "help_requests", filter: f }, cb)
        .on("postgres_changes", { event: "*", schema: "public", table: "quizzes", filter: f }, cb)
        .on("postgres_changes", { event: "*", schema: "public", table: "quiz_answers", filter: f }, cb)
        .subscribe((status) => {
          onStatus?.(status === "SUBSCRIBED");
          if (status === "SUBSCRIBED") cb(); // 재연결되면 놓친 변경을 다시 읽음
        });
      return () => sb.removeChannel(ch);
    },
  };
}

// ───────────────────────── 체험 모드 ─────────────────────────
// 실제 DB 대신 localStorage에 저장하고, BroadcastChannel로 같은 브라우저의 다른 탭에 변경을 알립니다.
async function makeDemoApi() {
  const KEY = "cp-demo-db";
  const bc = "BroadcastChannel" in window ? new BroadcastChannel("cp-demo") : null;
  const listeners = new Set();

  const empty = () => ({
    rooms: [], room_secrets: {}, participants: [], participant_secrets: {},
    help_requests: [], quizzes: [], quiz_secrets: {}, quiz_answers: [],
  });
  const read = () => {
    try { return JSON.parse(localStorage.getItem(KEY)) || empty(); } catch { return empty(); }
  };
  const notify = () => listeners.forEach((fn) => fn());
  const write = (db) => {
    localStorage.setItem(KEY, JSON.stringify(db));
    bc?.postMessage("changed");
    notify();
  };
  bc && (bc.onmessage = notify);
  window.addEventListener("storage", (e) => e.key === KEY && notify());

  const uuid = () => crypto.randomUUID();
  const now = () => new Date().toISOString();
  const fail = (msg) => { throw new Error(msg); };
  const checkHost = (db, room, key) => db.room_secrets[room] === key || fail("교사 권한이 없습니다");
  const checkP = (db, pid, key) => {
    const p = db.participants.find((x) => x.id === pid);
    if (!p || db.participant_secrets[pid] !== key) fail("참여 정보가 없습니다. 다시 입장하세요");
    return p;
  };
  const deleteRoomCascade = (db, roomId) => {
    db.rooms = db.rooms.filter((r) => r.id !== roomId);
    const pids = new Set(db.participants.filter((p) => p.room_id === roomId).map((p) => p.id));
    db.participants = db.participants.filter((p) => p.room_id !== roomId);
    db.help_requests = db.help_requests.filter((h) => h.room_id !== roomId);
    db.quizzes = db.quizzes.filter((q) => q.room_id !== roomId);
    db.quiz_answers = db.quiz_answers.filter((a) => a.room_id !== roomId);
    pids.forEach((id) => delete db.participant_secrets[id]);
    delete db.room_secrets[roomId];
  };

  const fns = {
    create_room(db, { p_title }) {
      const title = (p_title || "").trim().slice(0, 40) || fail("수업 이름을 입력하세요");
      let code;
      do code = String(Math.floor(Math.random() * 1e6)).padStart(6, "0");
      while (db.rooms.some((r) => r.code === code));
      const room = { id: uuid(), code, title, active_quiz_id: null, created_at: now() };
      const key = uuid().replaceAll("-", "");
      db.rooms.push(room);
      db.room_secrets[room.id] = key;
      return { room_id: room.id, code, host_key: key };
    },
    host_delete_room(db, { p_room, p_key }) {
      checkHost(db, p_room, p_key);
      deleteRoomCascade(db, p_room);
    },
    host_remove_participant(db, { p_room, p_key, p_pid }) {
      checkHost(db, p_room, p_key);
      db.participants = db.participants.filter((p) => !(p.id === p_pid && p.room_id === p_room));
      db.help_requests = db.help_requests.filter((h) => h.participant_id !== p_pid);
      db.quiz_answers = db.quiz_answers.filter((a) => a.participant_id !== p_pid);
      delete db.participant_secrets[p_pid];
    },
    host_reset_status(db, { p_room, p_key }) {
      checkHost(db, p_room, p_key);
      db.participants.filter((p) => p.room_id === p_room)
        .forEach((p) => Object.assign(p, { status: "none", updated_at: now() }));
    },
    host_set_help_state(db, { p_room, p_key, p_req, p_state }) {
      checkHost(db, p_room, p_key);
      ["waiting", "helping", "done"].includes(p_state) || fail("잘못된 상태");
      const h = db.help_requests.find((x) => x.id === p_req && x.room_id === p_room);
      if (!h) return;
      Object.assign(h, { state: p_state, updated_at: now() });
      const p = db.participants.find((x) => x.id === h.participant_id);
      if (p_state === "done" && p?.status === "stuck") Object.assign(p, { status: "good", updated_at: now() });
    },
    host_create_quiz(db, { p_room, p_key, p_question, p_options, p_correct }) {
      checkHost(db, p_room, p_key);
      if (!Array.isArray(p_options) || p_options.length < 2 || p_options.length > 6) fail("보기는 2~6개여야 합니다");
      const q = {
        id: uuid(), room_id: p_room, question: p_question.trim().slice(0, 200),
        kind: "choice", options: p_options, state: "open", correct: null, created_at: now(),
      };
      db.quizzes.push(q);
      db.quiz_secrets[q.id] = p_correct ?? null;
      db.rooms.find((r) => r.id === p_room).active_quiz_id = q.id;
      return q.id;
    },
    host_set_quiz_state(db, { p_room, p_key, p_quiz, p_state }) {
      checkHost(db, p_room, p_key);
      const room = db.rooms.find((r) => r.id === p_room);
      if (p_state === "ended") {
        if (room.active_quiz_id === p_quiz) room.active_quiz_id = null;
        return;
      }
      const q = db.quizzes.find((x) => x.id === p_quiz && x.room_id === p_room);
      if (!q) return;
      q.state = p_state;
      if (p_state === "revealed") q.correct = db.quiz_secrets[q.id];
    },
    join_room(db, { p_code, p_name }) {
      const room = db.rooms.find((r) => r.code === (p_code || "").trim()) || fail("참여 코드를 찾을 수 없습니다");
      const name = (p_name || "").trim().slice(0, 20) || fail("이름(번호)을 입력하세요");
      const p = { id: uuid(), room_id: room.id, name, status: "none", updated_at: now(), created_at: now() };
      const key = uuid().replaceAll("-", "");
      db.participants.push(p);
      db.participant_secrets[p.id] = key;
      return { room_id: room.id, participant_id: p.id, key, title: room.title, code: room.code, name };
    },
    set_status(db, { p_pid, p_key, p_status }) {
      Object.assign(checkP(db, p_pid, p_key), { status: p_status, updated_at: now() });
    },
    request_help(db, { p_pid, p_key, p_note }) {
      const p = checkP(db, p_pid, p_key);
      const note = (p_note || "").trim().slice(0, 100);
      const h = db.help_requests.find((x) => x.participant_id === p_pid && ["waiting", "helping"].includes(x.state));
      if (h) Object.assign(h, { note, updated_at: now() });
      else db.help_requests.push({
        id: uuid(), room_id: p.room_id, participant_id: p_pid, note,
        state: "waiting", created_at: now(), updated_at: now(),
      });
      Object.assign(p, { status: "stuck", updated_at: now() });
    },
    cancel_help(db, { p_pid, p_key }) {
      checkP(db, p_pid, p_key);
      db.help_requests.filter((x) => x.participant_id === p_pid && ["waiting", "helping"].includes(x.state))
        .forEach((h) => Object.assign(h, { state: "canceled", updated_at: now() }));
    },
    answer_quiz(db, { p_pid, p_key, p_quiz, p_choice }) {
      const p = checkP(db, p_pid, p_key);
      const q = db.quizzes.find((x) => x.id === p_quiz && x.room_id === p.room_id) || fail("퀴즈를 찾을 수 없습니다");
      if (q.state !== "open") fail("응답이 마감되었습니다");
      if (q.kind === "text") fail("객관식 퀴즈가 아닙니다");
      const a = db.quiz_answers.find((x) => x.quiz_id === p_quiz && x.participant_id === p_pid);
      if (a) Object.assign(a, { choice: p_choice, created_at: now() });
      else db.quiz_answers.push({ quiz_id: p_quiz, participant_id: p_pid, room_id: p.room_id, choice: p_choice, created_at: now() });
    },
    host_create_question(db, { p_room, p_key, p_question }) {
      checkHost(db, p_room, p_key);
      const question = (p_question || "").trim().slice(0, 200) || fail("질문을 입력하세요");
      const q = { id: uuid(), room_id: p_room, kind: "text", question, options: [], state: "open", correct: null, created_at: now() };
      db.quizzes.push(q);
      db.quiz_secrets[q.id] = null;
      db.rooms.find((r) => r.id === p_room).active_quiz_id = q.id;
      return q.id;
    },
    answer_text(db, { p_pid, p_key, p_quiz, p_text }) {
      const p = checkP(db, p_pid, p_key);
      const q = db.quizzes.find((x) => x.id === p_quiz && x.room_id === p.room_id) || fail("질문을 찾을 수 없습니다");
      if (q.state !== "open") fail("응답이 마감되었습니다");
      if (q.kind !== "text") fail("짧은 답 질문이 아닙니다");
      const text = (p_text || "").trim().slice(0, 200) || fail("답을 입력하세요");
      const a = db.quiz_answers.find((x) => x.quiz_id === p_quiz && x.participant_id === p_pid);
      if (a) Object.assign(a, { text, created_at: now() });
      else db.quiz_answers.push({ quiz_id: p_quiz, participant_id: p_pid, room_id: p.room_id, choice: null, text, created_at: now() });
    },
  };

  return {
    async rpc(name, args) {
      const db = read();
      const result = fns[name](db, args);
      write(db);
      return result ?? null;
    },
    async loadRoom(roomId) {
      const db = read();
      const room = db.rooms.find((r) => r.id === roomId);
      if (!room) return null;
      const quiz = room.active_quiz_id ? db.quizzes.find((q) => q.id === room.active_quiz_id) || null : null;
      return {
        room,
        participants: db.participants.filter((p) => p.room_id === roomId),
        help: db.help_requests
          .filter((h) => h.room_id === roomId && ["waiting", "helping"].includes(h.state))
          .sort((a, b) => a.created_at.localeCompare(b.created_at)),
        quiz,
        answers: quiz ? db.quiz_answers.filter((a) => a.quiz_id === quiz.id) : [],
        doneCount: db.help_requests.filter((h) => h.room_id === roomId && h.state === "done").length,
      };
    },
    subscribe(roomId, cb, onStatus) {
      listeners.add(cb);
      onStatus?.(true);
      return () => listeners.delete(cb);
    },
  };
}
