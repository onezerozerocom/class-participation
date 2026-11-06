# 🙋 실시간 수업 참여 도구 (Supabase Realtime)

수업 중 **도움 요청 대기열**, **이해도(진행 상태) 체크**, **퀴즈**를 실시간으로 주고받는 웹앱입니다.
실습 시간에 "누가 막혀 있는지"를 교사 화면 한 장으로 볼 수 있습니다.
빌드 도구 없이 HTML + JavaScript + Supabase(CDN)만으로 동작합니다.

**👉 바로 사용하기: https://onezerozerocom.github.io/class-participation/**

> 배포: `public` 폴더 내용이 `gh-pages` 브랜치로 GitHub Pages에 올라갑니다. 고친 뒤 다시 배포하려면
> `git subtree push --prefix public origin gh-pages` 를 실행하세요.

| 화면 | 기능 |
|---|---|
| 학생 | 참여 코드 + 번호로 입장 → 내 상태(🟢 잘 됨 / 🟡 헷갈림 / 🔴 막힘 / ✅ 완료) 선택, **선생님 도와주세요** 요청(메모 가능, 대기 순번 표시), 퀴즈 응답 |
| 교사 | 참여 코드·QR 크게 보기, 상태 요약 막대, 학생 카드(막힌 학생 먼저 정렬), 도움 요청 대기열(가는 중 → 해결), 새 요청 알림음, 퀴즈 출제(O/X·4지선다·이해도 1~5)와 실시간 응답 막대그래프, 정답 공개, 수업 종료 |

| 사용 기능 | 역할 |
|---|---|
| Supabase Database (Postgres) | 수업 방·학생·요청·퀴즈 저장 |
| Supabase **Realtime** (`postgres_changes`) | 표가 바뀌면 모든 화면이 즉시 갱신 |
| RPC 함수 + RLS | 로그인 없이도 교사/학생 권한을 키로 확인 |

## 폴더 구조

```
public/
  index.html   화면 뼈대
  style.css    디자인 (다크모드·모바일 지원)
  app.js       화면(첫 화면·학생·교사) 로직
  api.js       데이터 계층 — Supabase 구현 + 체험 모드 구현
  config.js    ← 내 Supabase 주소·키 입력
supabase/
  schema.sql   테이블, 보안 정책, RPC 함수, Realtime 설정
```

## 1. 체험 모드로 바로 실행 (Supabase 없이)

`config.js`가 비어 있으면 **체험 모드**로 동작합니다. 데이터는 브라우저(localStorage)에만 저장되고,
**같은 브라우저의 탭끼리** 실시간으로 연결됩니다.

```bash
python -m http.server 5510 --directory public
```

http://localhost:5510 → **방 만들기** → 교사 화면 위쪽의 **＋ 학생 탭 열기**로 학생 탭을 여러 개 띄워 보세요.

> ES 모듈을 쓰기 때문에 파일을 더블클릭(`file://`)하면 동작하지 않습니다. 꼭 로컬 서버로 여세요.

## 2. Supabase 연결하기 (여러 기기에서 함께 쓰기)

1. https://supabase.com 에서 새 프로젝트를 만듭니다. Region은 `Northeast Asia (Seoul)`.
2. 왼쪽 메뉴 **SQL Editor**에 [`supabase/schema.sql`](supabase/schema.sql) 전체를 붙여넣고 **Run**.
   (테이블·보안 정책·함수가 만들어지고 Realtime 발행 목록에도 자동으로 추가됩니다.)
3. **Project Settings → API**에서 `Project URL`과 `anon public` 키를 복사해 `public/config.js`에 붙여넣습니다.
   ```js
   export const SUPABASE_URL = "https://xxxx.supabase.co";
   export const SUPABASE_ANON_KEY = "eyJ...";
   ```
4. 다시 열면 위쪽의 "체험 모드" 안내가 사라집니다. 교사 화면 상단의 초록 점(●)이 실시간 연결 상태입니다.

> `anon` 키는 공개되어도 괜찮은 키입니다. `service_role` 키는 절대 넣지 마세요.

## 3. 배포 (학생 기기에서 접속)

`public` 폴더를 Netlify(드래그 앤 드롭), Vercel, GitHub Pages 중 아무 곳에나 올리면 됩니다.
교사 화면의 **참여 코드**를 누르면 프로젝터용 큰 코드와 QR이 나오고, QR은 `주소?code=123456`으로 바로 연결됩니다.

## 동작 원리

```
rooms              수업 방 (6자리 참여 코드, 진행 중인 퀴즈)
participants       학생 (이름/번호, 상태)
help_requests      도움 요청 (waiting → helping → done / canceled)
quizzes            퀴즈 (보기, 상태 open → closed → revealed)
quiz_answers       학생 응답
*_secrets          교사 키·학생 키·공개 전 정답 (아무도 직접 읽을 수 없음)
```

- **로그인이 없습니다.** 방을 만들면 교사 키, 입장하면 학생 키를 받아 그 브라우저에 저장합니다.
  모든 쓰기는 `schema.sql`의 함수(`create_room`, `request_help`, `answer_quiz` …)로만 가능하고, 함수가 키를 검사합니다.
- **실시간 갱신:** 각 화면은 자기 방(`room_id`)의 변경을 Realtime으로 구독하고, 변경 알림이 오면 방 상태를 다시 읽습니다.
  연결이 끊겨도 20초마다 다시 읽기 때문에 화면이 오래 멈춰 있지 않습니다.
- **정답 보호:** 정답은 `quiz_secrets`에만 있다가 **정답 공개**를 누를 때 `quizzes.correct`로 복사됩니다.
- 교사 화면은 **방을 만든 브라우저에서만** 열립니다. 다른 컴퓨터에서 이어서 하려면 새 방을 만드세요.

## 개인정보 관련

- 저장하는 정보는 **이름(번호), 상태, 도움 요청 메모, 퀴즈 응답**뿐이고, 이 정보는 참여 코드를 아는 사람이 읽을 수 있는 수준으로 공개됩니다.
  그러니 **실명 대신 번호나 번호+이니셜**을 쓰도록 안내하세요.
- 수업이 끝나면 **수업 종료**를 눌러 방을 지우세요. 학생 목록·요청·응답이 모두 삭제됩니다.
  남은 오래된 방은 `schema.sql` 맨 아래의 정리 SQL로 한꺼번에 지울 수 있습니다.

## 더 해볼 만한 것

- Realtime **Presence**로 "지금 접속 중인 학생" 표시
- 지난 퀴즈 결과를 모아 CSV로 내보내기 (데이터 분석 수업 자료로!)
- 도움 요청 평균 대기 시간, 자주 막히는 지점(메모) 통계
