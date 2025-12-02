/**
 * db.js — Emotion Playlist의 로컬 SQLite DB 초기화 파일 (better-sqlite3)
 * ======================================================================================
 * 역할
 *   1) data/app.db 파일을 생성/연결하고
 *   2) 서비스에 필요한 모든 테이블(users, tracks, track_moods, ratings, playlists, playlist_items,
 *      playlist_likes, watch_history, skips)을 만든 다음
 *   3) 오프라인/쿼터초과 상황에서도 검색·추천이 가능하도록 더미 트랙(seedTracks)을 넣는다.
 *
 * 선택 이유: better-sqlite3
 *   - Node에서 간단하고 빠른 동기 API, 트랜잭션 사용이 쉬움
 *   - 서버 규모가 작고 단일 프로세스일 때 운영이 간편
 *
 * 호출 타이밍
 *   - server.js에서 `import db from './db.js'` 하는 순간 즉시 실행된다(모듈 로드시 즉시 초기화).
 *   - CLI로 `node db.js --seed`만 따로 실행해도 초기화 후 종료한다.
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ESM 환경에서 __dirname 대체: 현재 파일 경로 → 디렉터리
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// DB 파일 경로: 프로젝트/backEnd/data/app.db
const dataDir = path.join(__dirname, 'data');
const dbPath = path.join(dataDir, 'app.db');

// data 폴더가 없으면 생성
fs.mkdirSync(dataDir, { recursive: true });

// DB 연결(파일이 없으면 생성). 모듈 전역에서 단일 연결로 사용.
const db = new Database(dbPath);

// ============================================================================
// PRAGMA + 스키마(테이블) 생성
//   - PRAGMA journal_mode=WAL : 동시성/성능 개선(쓰기 중에도 읽기 지연이 적음)
//   - 테이블 간 핵심 관계
//       users(1) — ratings(*), watch_history(*), skips(*), playlists(*)
//       playlists(1) — playlist_items(*), playlist_likes(*)
//       tracks(1) — track_moods(*), playlist_items(*)
//   - ratings/watch_history/skips는 track_id를 문자열로 저장(YouTube 실시간 결과도 기록 가능)
// ============================================================================
db.exec(`
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,        -- 로그인 식별자(쿠키에 저장)
  password_hash TEXT NOT NULL,          -- 비밀번호 SHA-256 해시(평문 저장 금지)
  email TEXT                             -- 선택
);

CREATE TABLE IF NOT EXISTS tracks (
  id TEXT PRIMARY KEY,                   -- 'youtube:VIDEO_ID' 또는 'seed:...' (문자열 PK)
  source TEXT NOT NULL,                  -- 'YouTube' 등 데이터 출처
  title TEXT NOT NULL,                   -- 화면에 보이는 최종 타이틀(채널 — 제목)
  original_title TEXT NOT NULL,          -- 원문 제목(랭킹/품질보정에 사용)
  artist TEXT NOT NULL,                  -- 채널명=가수명으로 간주
  thumb TEXT NOT NULL,                   -- 썸네일 URL
  url TEXT NOT NULL,                     -- 유튜브 URL
  genre TEXT NOT NULL,                   -- kpop/jpop/pop/rock...
  nation TEXT NOT NULL                   -- kr/jp/us/etc (랭킹/필터 보조)
);

CREATE TABLE IF NOT EXISTS track_moods (
  track_id TEXT NOT NULL,                -- tracks.id 참조
  mood TEXT NOT NULL,                    -- happy/sad/calm/angry/energetic
  PRIMARY KEY (track_id, mood),
  FOREIGN KEY (track_id) REFERENCES tracks(id)
);

CREATE TABLE IF NOT EXISTS ratings (
  user_id   INTEGER NOT NULL,            -- 누가
  track_id  TEXT    NOT NULL,            -- 어떤 곡(문자열 PK)
  mood      TEXT    NOT NULL,            -- 감정 라벨
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (user_id, track_id),       -- 같은 곡 라벨은 업서트
  FOREIGN KEY (user_id) REFERENCES users(id)
  -- track_id FK는 생략: 실시간 검색 결과(아직 tracks 미삽입)도 기록 가능하게 유연성 확보
);

CREATE TABLE IF NOT EXISTS playlists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,              -- 소유자
  title TEXT NOT NULL,                   -- 제목
  is_public INTEGER NOT NULL DEFAULT 0,  -- 공개/비공개
  theme_color TEXT NOT NULL DEFAULT '#22d3ee', -- 카드 색(프론트 스타일에 사용)
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS playlist_items (
  playlist_id INTEGER NOT NULL,
  track_id TEXT NOT NULL,                -- 어떤 곡이 목록에 들어갔는지
  position INTEGER NOT NULL DEFAULT 0,   -- 순서
  PRIMARY KEY (playlist_id, track_id),   -- 같은 곡 중복 방지
  FOREIGN KEY (playlist_id) REFERENCES playlists(id)
);

-- 재생목록 좋아요(공개 피드 인기순 정렬에 사용)
CREATE TABLE IF NOT EXISTS playlist_likes (
  user_id INTEGER NOT NULL,
  playlist_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (user_id, playlist_id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (playlist_id) REFERENCES playlists(id)
);

CREATE TABLE IF NOT EXISTS watch_history (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id   INTEGER NOT NULL,
  track_id  TEXT    NOT NULL,
  played_at INTEGER NOT NULL DEFAULT (strftime('%s','now')), -- 재생 시각(초 단위)
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- 스킵 기록(몇 초 듣고 넘겼는지). 추천에서 패널티로 반영.
CREATE TABLE IF NOT EXISTS skips (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id   INTEGER NOT NULL,
  track_id  TEXT    NOT NULL,
  seconds   INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);
`);

// ============================================================================
// 더미 트랙 시드 데이터
//  - 장르: kpop / jpop / pop / rock 등
//  - nation: kr / jp / us / etc
//  - mood: happy / sad / calm / angry / energetic
//  배열 형식: [id, source, title, original_title, artist, thumb, url, moods[], genre, nation]
// ============================================================================
const seedTracks = [
  // ───────── 기본 10곡 (기존) ─────────
  [
    'youtube:gdZLi9oWNZg',
    'YouTube',
    "BTS — Dynamite",
    "BTS (방탄소년단) 'Dynamite' Official MV",
    'BTS',
    'https://i.ytimg.com/vi/gdZLi9oWNZg/hqdefault.jpg',
    'https://www.youtube.com/watch?v=gdZLi9oWNZg',
    ['happy', 'energetic'],
    'kpop',
    'kr'
  ],
  [
    'youtube:6eEZ7DJMzuk',
    'YouTube',
    "IVE — LOVE DIVE",
    "IVE 아이브 'LOVE DIVE' MV",
    'IVE',
    'https://i.ytimg.com/vi/6eEZ7DJMzuk/hqdefault.jpg',
    'https://www.youtube.com/watch?v=6eEZ7DJMzuk',
    ['happy', 'energetic'],
    'kpop',
    'kr'
  ],
  [
    'youtube:TQ8WlA2GXbk',
    'YouTube',
    'Official髭男dism — Pretender',
    'Official髭男dism - Pretender [Official Video]',
    'Official髭男dism',
    'https://i.ytimg.com/vi/TQ8WlA2GXbk/hqdefault.jpg',
    'https://www.youtube.com/watch?v=TQ8WlA2GXbk',
    ['sad', 'calm'],
    'jpop',
    'jp'
  ],
  [
    'youtube:Q6iK6DjV_iE',
    'YouTube',
    'YOASOBI — 夜に駆ける',
    'YOASOBI「夜に駆ける」Official Music Video',
    'YOASOBI',
    'https://i.ytimg.com/vi/Q6iK6DjV_iE/hqdefault.jpg',
    'https://www.youtube.com/watch?v=Q6iK6DjV_iE',
    ['energetic'],
    'jpop',
    'jp'
  ],
  [
    'youtube:8xg3vE8Ie_E',
    'YouTube',
    'Taylor Swift — Love Story',
    'Taylor Swift - Love Story',
    'Taylor Swift',
    'https://i.ytimg.com/vi/8xg3vE8Ie_E/hqdefault.jpg',
    'https://www.youtube.com/watch?v=8xg3vE8Ie_E',
    ['happy', 'calm'],
    'pop',
    'us'
  ],
  [
    'youtube:RBumgq5yVrA',
    'YouTube',
    'Ed Sheeran — Photograph',
    'Ed Sheeran - Photograph (Official Music Video)',
    'Ed Sheeran',
    'https://i.ytimg.com/vi/RBumgq5yVrA/hqdefault.jpg',
    'https://www.youtube.com/watch?v=RBumgq5yVrA',
    ['sad', 'calm'],
    'pop',
    'uk'
  ],
  [
    'youtube:OPf0YbXqDm0',
    'YouTube',
    'Mark Ronson — Uptown Funk (feat. Bruno Mars)',
    'Mark Ronson - Uptown Funk (Official Video) ft. Bruno Mars',
    'Mark Ronson',
    'https://i.ytimg.com/vi/OPf0YbXqDm0/hqdefault.jpg',
    'https://www.youtube.com/watch?v=OPf0YbXqDm0',
    ['energetic', 'happy'],
    'pop',
    'us'
  ],
  [
    'youtube:d9h2oQxQv0c',
    'YouTube',
    'IU — Palette (feat. G-DRAGON)',
    'IU(아이유) _ Palette(팔레트) (Feat. G-DRAGON) MV',
    'IU',
    'https://i.ytimg.com/vi/d9h2oQxQv0c/hqdefault.jpg',
    'https://www.youtube.com/watch?v=d9h2oQxQv0c',
    ['calm', 'happy'],
    'kpop',
    'kr'
  ],
  [
    'youtube:pXRviuL6vMY',
    'YouTube',
    'twenty one pilots — Stressed Out',
    'twenty one pilots: Stressed Out [OFFICIAL VIDEO]',
    'twenty one pilots',
    'https://i.ytimg.com/vi/pXRviuL6vMY/hqdefault.jpg',
    'https://www.youtube.com/watch?v=pXRviuL6vMY',
    ['angry', 'sad'],
    'rock',
    'us'
  ],
  [
    'youtube:tAGnKpE4NCI',
    'YouTube',
    'Metallica — Nothing Else Matters',
    'Metallica: Nothing Else Matters (Official Music Video)',
    'Metallica',
    'https://i.ytimg.com/vi/tAGnKpE4NCI/hqdefault.jpg',
    'https://www.youtube.com/watch?v=tAGnKpE4NCI',
    ['calm', 'sad'],
    'rock',
    'us'
  ],

  // ───────── 추가 더미 (심리테스트용 풀 확장) ─────────

  // 🔥 energetic + jpop 보강
  [
    'seed:jpop_energy_01',
    'YouTube',
    'YOASOBI — 夜に駆ける (Energy Ver.)',
    'YOASOBI「夜に駆ける」Official Music Video',
    'YOASOBI',
    'https://i.ytimg.com/vi/Q6iK6DjV_iE/hqdefault.jpg',
    'https://www.youtube.com/watch?v=Q6iK6DjV_iE',
    ['energetic', 'happy'],
    'jpop',
    'jp'
  ],
  [
    'seed:jpop_energy_02',
    'YouTube',
    'YOASOBI — 夜に駆ける (Motivation Ver.)',
    'YOASOBI「夜に駆ける」Official Music Video',
    'YOASOBI',
    'https://i.ytimg.com/vi/Q6iK6DjV_iE/hqdefault.jpg',
    'https://www.youtube.com/watch?v=Q6iK6DjV_iE',
    ['energetic', 'angry'],
    'jpop',
    'jp'
  ],
  [
    'seed:jpop_energy_03',
    'YouTube',
    'Official髭男dism — Pretender (Upbeat Arrange)',
    'Official髭男dism - Pretender [Official Video]',
    'Official髭男dism',
    'https://i.ytimg.com/vi/TQ8WlA2GXbk/hqdefault.jpg',
    'https://www.youtube.com/watch?v=TQ8WlA2GXbk',
    ['energetic', 'happy'],
    'jpop',
    'jp'
  ],
  [
    'seed:jpop_energy_04',
    'YouTube',
    'Official髭男dism — Pretender (Study Motivation)',
    'Official髭男dism - Pretender [Official Video]',
    'Official髭男dism',
    'https://i.ytimg.com/vi/TQ8WlA2GXbk/hqdefault.jpg',
    'https://www.youtube.com/watch?v=TQ8WlA2GXbk',
    ['energetic', 'calm'],
    'jpop',
    'jp'
  ],
  [
    'seed:jpop_energy_05',
    'YouTube',
    'J-ENERGY — Focus & Grind',
    'YOASOBI「夜に駆ける」Official Music Video',
    'J-ENERGY',
    'https://i.ytimg.com/vi/Q6iK6DjV_iE/hqdefault.jpg',
    'https://www.youtube.com/watch?v=Q6iK6DjV_iE',
    ['energetic', 'angry'],
    'jpop',
    'jp'
  ],

  // 😀 happy 보강
  [
    'seed:happy_kpop_01',
    'YouTube',
    'BTS — Dynamite (Happy Morning Ver.)',
    "BTS (방탄소년단) 'Dynamite' Official MV",
    'BTS',
    'https://i.ytimg.com/vi/gdZLi9oWNZg/hqdefault.jpg',
    'https://www.youtube.com/watch?v=gdZLi9oWNZg',
    ['happy'],
    'kpop',
    'kr'
  ],
  [
    'seed:happy_kpop_02',
    'YouTube',
    'IVE — LOVE DIVE (Bright Ver.)',
    "IVE 아이브 'LOVE DIVE' MV",
    'IVE',
    'https://i.ytimg.com/vi/6eEZ7DJMzuk/hqdefault.jpg',
    'https://www.youtube.com/watch?v=6eEZ7DJMzuk',
    ['happy', 'energetic'],
    'kpop',
    'kr'
  ],
  [
    'seed:happy_pop_01',
    'YouTube',
    'Love Story — Road Trip Ver.',
    'Taylor Swift - Love Story',
    'Taylor Swift',
    'https://i.ytimg.com/vi/8xg3vE8Ie_E/hqdefault.jpg',
    'https://www.youtube.com/watch?v=8xg3vE8Ie_E',
    ['happy', 'calm'],
    'pop',
    'us'
  ],

  // 😢 sad 보강
  [
    'seed:sad_pop_01',
    'YouTube',
    'Photograph — Late Night Ver.',
    'Ed Sheeran - Photograph (Official Music Video)',
    'Ed Sheeran',
    'https://i.ytimg.com/vi/RBumgq5yVrA/hqdefault.jpg',
    'https://www.youtube.com/watch?v=RBumgq5yVrA',
    ['sad', 'calm'],
    'pop',
    'uk'
  ],
  [
    'seed:sad_rock_01',
    'YouTube',
    'Nothing Else Matters — Rainy Day Ver.',
    'Metallica: Nothing Else Matters (Official Music Video)',
    'Metallica',
    'https://i.ytimg.com/vi/tAGnKpE4NCI/hqdefault.jpg',
    'https://www.youtube.com/watch?v=tAGnKpE4NCI',
    ['sad', 'calm'],
    'rock',
    'us'
  ],

  // 😡 angry / 락
  [
    'seed:angry_rock_01',
    'YouTube',
    'Stressed Out — Rage Ver.',
    'twenty one pilots: Stressed Out [OFFICIAL VIDEO]',
    'twenty one pilots',
    'https://i.ytimg.com/vi/pXRviuL6vMY/hqdefault.jpg',
    'https://www.youtube.com/watch?v=pXRviuL6vMY',
    ['angry', 'energetic'],
    'rock',
    'us'
  ],
  [
    'seed:angry_rock_02',
    'YouTube',
    'Nothing Else Matters — Heavy Mood',
    'Metallica: Nothing Else Matters (Official Music Video)',
    'Metallica',
    'https://i.ytimg.com/vi/tAGnKpE4NCI/hqdefault.jpg',
    'https://www.youtube.com/watch?v=tAGnKpE4NCI',
    ['angry', 'sad'],
    'rock',
    'us'
  ],

  // 😌 calm / 힐링
  [
    'seed:calm_kpop_01',
    'YouTube',
    'IU — Palette (Night Chill Ver.)',
    'IU(아이유) _ Palette(팔레트) (Feat. G-DRAGON) MV',
    'IU',
    'https://i.ytimg.com/vi/d9h2oQxQv0c/hqdefault.jpg',
    'https://www.youtube.com/watch?v=d9h2oQxQv0c',
    ['calm'],
    'kpop',
    'kr'
  ],
  [
    'seed:calm_pop_01',
    'YouTube',
    'Love Story — Calm Piano Ver.',
    'Taylor Swift - Love Story',
    'Taylor Swift',
    'https://i.ytimg.com/vi/8xg3vE8Ie_E/hqdefault.jpg',
    'https://www.youtube.com/watch?v=8xg3vE8Ie_E',
    ['calm'],
    'pop',
    'us'
  ]
];

// 빠른 삽입을 위한 prepared statements (SQL 인젝션 방지/성능)
const insertTrack = db.prepare(`
  INSERT OR IGNORE INTO tracks
  (id, source, title, original_title, artist, thumb, url, genre, nation)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertMood = db.prepare(`
  INSERT OR IGNORE INTO track_moods (track_id, mood)
  VALUES (?, ?)
`);

// seed 주입: 중복은 무시(INSERT OR IGNORE)
for (const t of seedTracks) {
  const [id, source, title, original_title, artist, thumb, url, moods, genre, nation] = t;
  insertTrack.run(id, source, title, original_title, artist, thumb, url, genre, nation);
  moods.forEach(m => insertMood.run(id, m));
}

// 독립 실행 모드 지원: `node db.js --seed`
if (process.argv.includes('--seed')) {
  console.log('DB initialized at', dbPath);
  process.exit(0);
}

// server.js에서 사용할 DB 인스턴스 export
export default db;
