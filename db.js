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
  id TEXT PRIMARY KEY,          -- 'youtube:VIDEO_ID'
  source TEXT NOT NULL,         -- 'YouTube'
  title TEXT NOT NULL,
  original_title TEXT NOT NULL,
  artist TEXT NOT NULL,
  thumb TEXT NOT NULL,
  url TEXT NOT NULL
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
// --------------------
const seedTracks = [
  [
    'youtube:dQw4w9WgXcQ',
    'YouTube',
    'Rick Astley — Never Gonna Give You Up',
    'Rick Astley - Never Gonna Give You Up (Official Music Video)',
    'Rick Astley',
    'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    ['energetic', 'happy']
  ],
  [
    'youtube:ktvTqknDobU',
    'YouTube',
    'Queen — Bohemian Rhapsody',
    'Queen – Bohemian Rhapsody (Official Video Remastered)',
    'Queen',
    'https://i.ytimg.com/vi/ktvTqknDobU/hqdefault.jpg',
    'https://www.youtube.com/watch?v=ktvTqknDobU',
    ['energetic', 'sad']
  ],
  [
    'youtube:Zi_XLOBDo_Y',
    'YouTube',
    'Adele — Someone Like You',
    'Adele - Someone Like You (Official Music Video)',
    'Adele',
    'https://i.ytimg.com/vi/Zi_XLOBDo_Y/hqdefault.jpg',
    'https://www.youtube.com/watch?v=Zi_XLOBDo_Y',
    ['sad', 'calm']
  ],
  [
    'youtube:fLexgOxsZu0',
    'YouTube',
    'Pharrell Williams — Happy',
    'Pharrell Williams - Happy (Official Music Video)',
    'Pharrell Williams',
    'https://i.ytimg.com/vi/fLexgOxsZu0/hqdefault.jpg',
    'https://www.youtube.com/watch?v=fLexgOxsZu0',
    ['happy', 'energetic']
  ],
  [
    'youtube:V1Pl8CzNzCw',
    'YouTube',
    'Billie Eilish — bad guy',
    'Billie Eilish - bad guy',
    'Billie Eilish',
    'https://i.ytimg.com/vi/V1Pl8CzNzCw/hqdefault.jpg',
    'https://www.youtube.com/watch?v=V1Pl8CzNzCw',
    ['angry', 'energetic']
  ],
  [
    'youtube:RBumgq5yVrA',
    'YouTube',
    'Ed Sheeran — Photograph',
    'Ed Sheeran - Photograph (Official Music Video)',
    'Ed Sheeran',
    'https://i.ytimg.com/vi/RBumgq5yVrA/hqdefault.jpg',
    'https://www.youtube.com/watch?v=RBumgq5yVrA',
    ['calm', 'sad']
  ],
  [
    'youtube:OPf0YbXqDm0',
    'YouTube',
    'Mark Ronson — Uptown Funk (feat. Bruno Mars)',
    'Mark Ronson - Uptown Funk (Official Video) ft. Bruno Mars',
    'Mark Ronson',
    'https://i.ytimg.com/vi/OPf0YbXqDm0/hqdefault.jpg',
    'https://www.youtube.com/watch?v=OPf0YbXqDm0',
    ['energetic', 'happy']
  ],
  [
    'youtube:hLQl3WQQoQ0',
    'YouTube',
    'Adele — Someone Like You (Live at BRIT)',
    'Adele - Someone Like You (BRIT Awards 2011) Performance',
    'Adele',
    'https://i.ytimg.com/vi/hLQl3WQQoQ0/hqdefault.jpg',
    'https://www.youtube.com/watch?v=hLQl3WQQoQ0',
    ['sad']
  ],
  [
    'youtube:pXRviuL6vMY',
    'YouTube',
    'twenty one pilots — Stressed Out',
    'twenty one pilots: Stressed Out [OFFICIAL VIDEO]',
    'twenty one pilots',
    'https://i.ytimg.com/vi/pXRviuL6vMY/hqdefault.jpg',
    'https://www.youtube.com/watch?v=pXRviuL6vMY',
    ['angry', 'sad']
  ]
];

const insertTrack = db.prepare(`
  INSERT OR IGNORE INTO tracks
  (id, source, title, original_title, artist, thumb, url)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

const insertMood = db.prepare(`
  INSERT OR IGNORE INTO track_moods (track_id, mood)
  VALUES (?, ?)
`);

for (const t of seedTracks) {
  const [id, source, title, original_title, artist, thumb, url, moods] = t;
  insertTrack.run(id, source, title, original_title, artist, thumb, url);
  moods.forEach(m => insertMood.run(id, m));
}

if (process.argv.includes('--seed')) {
  console.log('DB initialized at', dbPath);
  process.exit(0);
}

export default db;
