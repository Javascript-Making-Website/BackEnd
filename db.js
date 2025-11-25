// db.js
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, 'data');
const dbPath = path.join(dataDir, 'app.db');

fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(dbPath);

// 기본 설정 + 테이블 생성
db.exec(`
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS tracks (
  id TEXT PRIMARY KEY,          -- 'youtube:VIDEO_ID' 또는 임의의 seed id
  source TEXT NOT NULL,         -- 'YouTube'
  title TEXT NOT NULL,
  original_title TEXT NOT NULL,
  artist TEXT NOT NULL,
  thumb TEXT NOT NULL,
  url TEXT NOT NULL,
  genre TEXT NOT NULL,          -- kpop / jpop / pop / rock 등
  nation TEXT NOT NULL          -- kr / jp / us / etc
);

CREATE TABLE IF NOT EXISTS track_moods (
  track_id TEXT NOT NULL,
  mood TEXT NOT NULL,
  PRIMARY KEY (track_id, mood),
  FOREIGN KEY (track_id) REFERENCES tracks(id)
);

CREATE TABLE IF NOT EXISTS ratings (
  user_id INTEGER NOT NULL,
  track_id TEXT NOT NULL,
  mood TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (user_id, track_id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (track_id) REFERENCES tracks(id)
);

CREATE TABLE IF NOT EXISTS playlists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  is_public INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS playlist_items (
  playlist_id INTEGER NOT NULL,
  track_id TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (playlist_id, track_id),
  FOREIGN KEY (playlist_id) REFERENCES playlists(id),
  FOREIGN KEY (track_id) REFERENCES tracks(id)
);

CREATE TABLE IF NOT EXISTS watch_history (
  user_id INTEGER NOT NULL,
  track_id TEXT NOT NULL,
  played_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (track_id) REFERENCES tracks(id)
);
`);

// --------------------
// 더미 트랙 시드 데이터
//  - 장르: kpop / jpop / pop / rock 등
//  - nation: kr / jp / us / etc
//  - mood: happy / sad / calm / angry / energetic
// --------------------
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

  // ───────── 여기서부터 추가 더미 (심리테스트용 풀 확장) ─────────
  // 기본 전략:
  //  - 열정/자기계발/힘이 나는 → energetic + (happy/angry) 많이 배치
  //  - J-POP 쪽은 genre: 'jpop', nation: 'jp'
  //  - 실제 재생은 url 기준이라, 이미 있는 MV들을 재사용해도 동작은 OK

  // 🔥 energetic + jpop (열정/자기계발 분위기 보강)
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

  // 😀 happy 쪽 보강
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

  // 😢 sad 쪽 보강
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

  // 😡 angry / 열받을 때 듣는 락
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

  // 😌 calm / 힐링용 보강
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

const insertTrack = db.prepare(`
  INSERT OR IGNORE INTO tracks
  (id, source, title, original_title, artist, thumb, url, genre, nation)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertMood = db.prepare(`
  INSERT OR IGNORE INTO track_moods (track_id, mood)
  VALUES (?, ?)
`);

for (const t of seedTracks) {
  const [id, source, title, original_title, artist, thumb, url, moods, genre, nation] = t;
  insertTrack.run(id, source, title, original_title, artist, thumb, url, genre, nation);
  moods.forEach(m => insertMood.run(id, m));
}

if (process.argv.includes('--seed')) {
  console.log('DB initialized at', dbPath);
  process.exit(0);
}

export default db;
