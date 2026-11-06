-- =====================================================================
-- 실시간 수업 참여 도구 — Supabase 스키마
-- Supabase 대시보드 > SQL Editor 에 전체를 붙여넣고 Run 하세요.
--
-- 보안 설계
--  * 로그인 없이 동작합니다. 교사는 방을 만들 때 받은 host_key,
--    학생은 참여할 때 받은 participant key 로 자신을 증명합니다.
--  * 키는 *_secrets 테이블에만 저장되고, 이 테이블은 아무도 직접 읽을 수 없습니다.
--  * 모든 쓰기는 아래의 함수(RPC)로만 가능하고, 함수가 키를 검사합니다.
--  * 읽기는 누구나 가능합니다(이름/상태/질문 같은 수업용 정보만 저장).
--    그래서 이름은 실명 대신 "번호" 또는 "번호+이니셜"을 권장합니다.
-- =====================================================================

-- ---------- 테이블 ----------
create table if not exists public.rooms (
  id             uuid primary key default gen_random_uuid(),
  code           text not null unique,
  title          text not null check (char_length(title) between 1 and 40),
  active_quiz_id uuid,
  created_at     timestamptz not null default now()
);

create table if not exists public.room_secrets (
  room_id  uuid primary key references public.rooms(id) on delete cascade,
  host_key text not null
);

create table if not exists public.participants (
  id         uuid primary key default gen_random_uuid(),
  room_id    uuid not null references public.rooms(id) on delete cascade,
  name       text not null check (char_length(name) between 1 and 20),
  status     text not null default 'none'
             check (status in ('none', 'good', 'confused', 'stuck', 'done')),
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists participants_room_idx on public.participants(room_id);

create table if not exists public.participant_secrets (
  participant_id uuid primary key references public.participants(id) on delete cascade,
  key            text not null
);

create table if not exists public.help_requests (
  id             uuid primary key default gen_random_uuid(),
  room_id        uuid not null references public.rooms(id) on delete cascade,
  participant_id uuid not null references public.participants(id) on delete cascade,
  note           text not null default '' check (char_length(note) <= 100),
  state          text not null default 'waiting'
                 check (state in ('waiting', 'helping', 'done', 'canceled')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists help_room_idx on public.help_requests(room_id, state);

create table if not exists public.quizzes (
  id         uuid primary key default gen_random_uuid(),
  room_id    uuid not null references public.rooms(id) on delete cascade,
  kind       text not null default 'choice' check (kind in ('choice', 'text')), -- 객관식 / 짧은 답
  question   text not null check (char_length(question) between 1 and 200),
  options    jsonb not null,               -- ["보기1", "보기2", ...] (짧은 답은 [])
  state      text not null default 'open' check (state in ('open', 'closed', 'revealed')),
  correct    int,                          -- 정답 공개 전에는 null
  created_at timestamptz not null default now()
);
create index if not exists quizzes_room_idx on public.quizzes(room_id);

create table if not exists public.quiz_secrets (
  quiz_id uuid primary key references public.quizzes(id) on delete cascade,
  correct int                               -- null 이면 정답 없는 설문형
);

create table if not exists public.quiz_answers (
  quiz_id        uuid not null references public.quizzes(id) on delete cascade,
  participant_id uuid not null references public.participants(id) on delete cascade,
  room_id        uuid not null references public.rooms(id) on delete cascade,
  choice         int,                      -- 객관식 답 (보기 번호)
  text           text check (char_length(text) <= 200), -- 짧은 답
  created_at     timestamptz not null default now(),
  primary key (quiz_id, participant_id)
);

-- 이전 버전의 schema.sql을 이미 실행했다면 아래가 새 열을 추가해 줍니다 (처음 실행이면 아무 일도 안 함)
alter table public.quizzes add column if not exists kind text not null default 'choice'
  check (kind in ('choice', 'text'));
alter table public.quiz_answers add column if not exists text text check (char_length(text) <= 200);
alter table public.quiz_answers alter column choice drop not null;
create index if not exists answers_room_idx on public.quiz_answers(room_id);

-- ---------- 권한 / RLS ----------
alter table public.rooms               enable row level security;
alter table public.room_secrets        enable row level security;
alter table public.participants        enable row level security;
alter table public.participant_secrets enable row level security;
alter table public.help_requests       enable row level security;
alter table public.quizzes             enable row level security;
alter table public.quiz_secrets        enable row level security;
alter table public.quiz_answers        enable row level security;

-- 비밀 테이블: 정책이 없으므로 anon/authenticated 는 아무것도 못 함 + 권한 자체도 회수
revoke all on public.room_secrets, public.participant_secrets, public.quiz_secrets
  from anon, authenticated;

-- 공개 테이블: 읽기만 허용 (쓰기는 RPC 함수로만)
revoke insert, update, delete on public.rooms, public.participants, public.help_requests,
  public.quizzes, public.quiz_answers from anon, authenticated;

drop policy if exists "read rooms" on public.rooms;
create policy "read rooms" on public.rooms for select to anon, authenticated using (true);
drop policy if exists "read participants" on public.participants;
create policy "read participants" on public.participants for select to anon, authenticated using (true);
drop policy if exists "read help" on public.help_requests;
create policy "read help" on public.help_requests for select to anon, authenticated using (true);
drop policy if exists "read quizzes" on public.quizzes;
create policy "read quizzes" on public.quizzes for select to anon, authenticated using (true);
drop policy if exists "read answers" on public.quiz_answers;
create policy "read answers" on public.quiz_answers for select to anon, authenticated using (true);

-- ---------- 내부 도우미 ----------
create or replace function public._check_host(p_room uuid, p_key text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from room_secrets where room_id = p_room and host_key = p_key) then
    raise exception '교사 권한이 없습니다';
  end if;
end $$;

create or replace function public._check_participant(p_pid uuid, p_key text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_room uuid;
begin
  select p.room_id into v_room
    from participants p join participant_secrets s on s.participant_id = p.id
   where p.id = p_pid and s.key = p_key;
  if v_room is null then raise exception '참여 정보가 없습니다. 다시 입장하세요'; end if;
  return v_room;
end $$;

create or replace function public._new_key()
returns text language sql as $$
  select replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')
$$;

revoke execute on function public._check_host(uuid, text)        from public, anon, authenticated;
revoke execute on function public._check_participant(uuid, text) from public, anon, authenticated;
revoke execute on function public._new_key()                     from public, anon, authenticated;

-- ---------- 교사용 RPC ----------
create or replace function public.create_room(p_title text)
returns json language plpgsql security definer set search_path = public as $$
declare v_code text; v_room uuid; v_key text := _new_key();
begin
  if coalesce(trim(p_title), '') = '' then raise exception '수업 이름을 입력하세요'; end if;
  loop
    v_code := lpad(floor(random() * 1000000)::int::text, 6, '0');
    exit when not exists (select 1 from rooms where code = v_code);
  end loop;
  insert into rooms (code, title) values (v_code, left(trim(p_title), 40)) returning id into v_room;
  insert into room_secrets (room_id, host_key) values (v_room, v_key);
  return json_build_object('room_id', v_room, 'code', v_code, 'host_key', v_key);
end $$;

create or replace function public.host_delete_room(p_room uuid, p_key text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform _check_host(p_room, p_key);
  delete from rooms where id = p_room;
end $$;

create or replace function public.host_remove_participant(p_room uuid, p_key text, p_pid uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform _check_host(p_room, p_key);
  delete from participants where id = p_pid and room_id = p_room;
end $$;

create or replace function public.host_reset_status(p_room uuid, p_key text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform _check_host(p_room, p_key);
  update participants set status = 'none', updated_at = now() where room_id = p_room;
end $$;

create or replace function public.host_set_help_state(p_room uuid, p_key text, p_req uuid, p_state text)
returns void language plpgsql security definer set search_path = public as $$
declare v_pid uuid;
begin
  perform _check_host(p_room, p_key);
  if p_state not in ('waiting', 'helping', 'done') then raise exception '잘못된 상태'; end if;
  update help_requests set state = p_state, updated_at = now()
   where id = p_req and room_id = p_room
   returning participant_id into v_pid;
  -- 해결되면 '막혔어요' 상태를 '잘 되고 있어요'로 바꿔 줌
  if p_state = 'done' and v_pid is not null then
    update participants set status = 'good', updated_at = now()
     where id = v_pid and status = 'stuck';
  end if;
end $$;

create or replace function public.host_create_quiz(
  p_room uuid, p_key text, p_question text, p_options jsonb, p_correct int)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_quiz uuid; v_n int;
begin
  perform _check_host(p_room, p_key);
  if jsonb_typeof(p_options) <> 'array' then raise exception '보기 형식이 잘못되었습니다'; end if;
  v_n := jsonb_array_length(p_options);
  if v_n < 2 or v_n > 6 then raise exception '보기는 2~6개여야 합니다'; end if;
  if p_correct is not null and (p_correct < 0 or p_correct >= v_n) then
    raise exception '정답 번호가 잘못되었습니다';
  end if;
  insert into quizzes (room_id, question, options)
    values (p_room, left(trim(p_question), 200), p_options) returning id into v_quiz;
  insert into quiz_secrets (quiz_id, correct) values (v_quiz, p_correct);
  update rooms set active_quiz_id = v_quiz where id = p_room;
  return v_quiz;
end $$;

-- p_state: 'open' | 'closed' | 'revealed' | 'ended'(화면에서 내리기)
create or replace function public.host_set_quiz_state(p_room uuid, p_key text, p_quiz uuid, p_state text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform _check_host(p_room, p_key);
  if p_state = 'ended' then
    update rooms set active_quiz_id = null where id = p_room and active_quiz_id = p_quiz;
    return;
  end if;
  if p_state not in ('open', 'closed', 'revealed') then raise exception '잘못된 상태'; end if;
  update quizzes q set state = p_state,
         correct = case when p_state = 'revealed'
                        then (select correct from quiz_secrets where quiz_id = q.id)
                        else q.correct end
   where q.id = p_quiz and q.room_id = p_room;
end $$;

-- ---------- 학생용 RPC ----------
create or replace function public.join_room(p_code text, p_name text)
returns json language plpgsql security definer set search_path = public as $$
declare v_room rooms; v_pid uuid; v_key text := _new_key(); v_name text := left(trim(p_name), 20);
begin
  select * into v_room from rooms where code = trim(p_code);
  if v_room.id is null then raise exception '참여 코드를 찾을 수 없습니다'; end if;
  if coalesce(v_name, '') = '' then raise exception '이름(번호)을 입력하세요'; end if;
  if (select count(*) from participants where room_id = v_room.id) >= 200 then
    raise exception '참여 인원이 가득 찼습니다';
  end if;
  insert into participants (room_id, name) values (v_room.id, v_name) returning id into v_pid;
  insert into participant_secrets (participant_id, key) values (v_pid, v_key);
  return json_build_object('room_id', v_room.id, 'participant_id', v_pid, 'key', v_key,
                           'title', v_room.title, 'code', v_room.code, 'name', v_name);
end $$;

create or replace function public.set_status(p_pid uuid, p_key text, p_status text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform _check_participant(p_pid, p_key);
  if p_status not in ('none', 'good', 'confused', 'stuck', 'done') then raise exception '잘못된 상태'; end if;
  update participants set status = p_status, updated_at = now() where id = p_pid;
end $$;

create or replace function public.request_help(p_pid uuid, p_key text, p_note text)
returns void language plpgsql security definer set search_path = public as $$
declare v_room uuid; v_note text := left(coalesce(trim(p_note), ''), 100);
begin
  v_room := _check_participant(p_pid, p_key);
  update help_requests set note = v_note, updated_at = now()
   where participant_id = p_pid and state in ('waiting', 'helping');
  if not found then
    insert into help_requests (room_id, participant_id, note) values (v_room, p_pid, v_note);
  end if;
  update participants set status = 'stuck', updated_at = now() where id = p_pid;
end $$;

create or replace function public.cancel_help(p_pid uuid, p_key text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform _check_participant(p_pid, p_key);
  update help_requests set state = 'canceled', updated_at = now()
   where participant_id = p_pid and state in ('waiting', 'helping');
end $$;

create or replace function public.answer_quiz(p_pid uuid, p_key text, p_quiz uuid, p_choice int)
returns void language plpgsql security definer set search_path = public as $$
declare v_room uuid; v_q quizzes;
begin
  v_room := _check_participant(p_pid, p_key);
  select * into v_q from quizzes where id = p_quiz and room_id = v_room;
  if v_q.id is null then raise exception '퀴즈를 찾을 수 없습니다'; end if;
  if v_q.state <> 'open' then raise exception '응답이 마감되었습니다'; end if;
  if v_q.kind <> 'choice' then raise exception '객관식 퀴즈가 아닙니다'; end if;
  if p_choice < 0 or p_choice >= jsonb_array_length(v_q.options) then raise exception '잘못된 보기'; end if;
  insert into quiz_answers (quiz_id, participant_id, room_id, choice)
    values (p_quiz, p_pid, v_room, p_choice)
  on conflict (quiz_id, participant_id) do update set choice = excluded.choice, created_at = now();
end $$;

-- ---------- 짧은 답(서술형) 질문 ----------
create or replace function public.host_create_question(p_room uuid, p_key text, p_question text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_quiz uuid;
begin
  perform _check_host(p_room, p_key);
  if coalesce(trim(p_question), '') = '' then raise exception '질문을 입력하세요'; end if;
  insert into quizzes (room_id, kind, question, options)
    values (p_room, 'text', left(trim(p_question), 200), '[]'::jsonb) returning id into v_quiz;
  insert into quiz_secrets (quiz_id, correct) values (v_quiz, null);
  update rooms set active_quiz_id = v_quiz where id = p_room;
  return v_quiz;
end $$;

create or replace function public.answer_text(p_pid uuid, p_key text, p_quiz uuid, p_text text)
returns void language plpgsql security definer set search_path = public as $$
declare v_room uuid; v_q quizzes; v_text text := left(coalesce(trim(p_text), ''), 200);
begin
  v_room := _check_participant(p_pid, p_key);
  select * into v_q from quizzes where id = p_quiz and room_id = v_room;
  if v_q.id is null then raise exception '질문을 찾을 수 없습니다'; end if;
  if v_q.state <> 'open' then raise exception '응답이 마감되었습니다'; end if;
  if v_q.kind <> 'text' then raise exception '짧은 답 질문이 아닙니다'; end if;
  if v_text = '' then raise exception '답을 입력하세요'; end if;
  insert into quiz_answers (quiz_id, participant_id, room_id, text)
    values (p_quiz, p_pid, v_room, v_text)
  on conflict (quiz_id, participant_id) do update set text = excluded.text, created_at = now();
end $$;

grant execute on function
  public.host_create_question(uuid, text, text),
  public.answer_text(uuid, text, uuid, text),
  public.create_room(text),
  public.host_delete_room(uuid, text),
  public.host_remove_participant(uuid, text, uuid),
  public.host_reset_status(uuid, text),
  public.host_set_help_state(uuid, text, uuid, text),
  public.host_create_quiz(uuid, text, text, jsonb, int),
  public.host_set_quiz_state(uuid, text, uuid, text),
  public.join_room(text, text),
  public.set_status(uuid, text, text),
  public.request_help(uuid, text, text),
  public.cancel_help(uuid, text),
  public.answer_quiz(uuid, text, uuid, int)
to anon, authenticated;

-- ---------- Realtime ----------
-- 삭제 이벤트도 room_id 필터로 받을 수 있도록 이전 행 전체를 기록
alter table public.participants  replica identity full;
alter table public.help_requests replica identity full;
alter table public.quiz_answers  replica identity full;

do $$
declare t text;
begin
  foreach t in array array['rooms', 'participants', 'help_requests', 'quizzes', 'quiz_answers'] loop
    if not exists (select 1 from pg_publication_tables
                    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- ---------- (선택) 오래된 수업 정리 ----------
-- 수업이 끝난 방은 교사 화면의 [수업 종료]로 지울 수 있습니다.
-- 남아 있는 오래된 방을 한꺼번에 지우려면 아래를 실행하세요.
-- delete from public.rooms where created_at < now() - interval '7 days';
