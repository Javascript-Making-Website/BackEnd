// server.js
import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import db from './db.js';

const app = express();

// ───────────────────────────────────────────────────────────────
// 기본 미들웨어
// ───────────────────────────────────────────────────────────────
app.use(express.json());
app.use(cookieParser());

// CORS 허용: 정적 프론트(라이브서버 5500) + 예비(3000/5173)
const allowedOrigins = [
  'http://localhost:5500',
  'http://127.0.0.1:5500',
  'http://localhost:3000',
  'http://localhost:5173',
];

// 프리플라이트 포함 CORS 처리
const corsOptions = {
  origin(origin, cb) {
    // curl/서버-서버 호출 등 Origin 없는 경우 허용
    if (!origin) return cb(null, true);
    if (allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error(`CORS blocked: ${origin}`), false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
};
app.use(cors(corsOptions));
app.options('*', cors(corsOptions)); // preflight

// ───────────────────────────────────────────────────────────────
// 유틸 함수
// ───────────────────────────────────────────────────────────────
const getUser = (req) => {
  const name = req.cookies?.user || null;
  if (!name) return null;
  const row = db.prepare('SELECT * FROM users WHERE name = ?').get(name);
  return row || null;
};

const ensureUser = (name) => {
  db.prepare('INSERT OR IGNORE INTO users(name) VALUES(?)').run(name);
  return db.prepare('SELECT * FROM users WHERE name = ?').get(name);
};

// ───────────────────────────────────────────────────────────────
// 인증 관련 API
// ───────────────────────────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });

  const user = ensureUser(name);

  // 과제/테스트용: 프론트 JS에서 읽을 수 있게 httpOnly: false
  // 로컬호스트용이라 secure: false, 크로스탭 기본 호환을 위해 sameSite: 'lax'
  res.cookie('user', user.name, {
    httpOnly: false,
    sameSite: 'lax',
    secure: false,
  });

  res.json({ ok: true, user: user.name });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('user');
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const u = getUser(req);
  res.json({ user: u ? u.name : null });
});

// ───────────────────────────────────────────────────────────────
// 검색 & 추천
// ───────────────────────────────────────────────────────────────
app.get('/api/search', (req, res) => {
  const q = (req.query.q || '').toLowerCase();
  const mood = req.query.mood || null;

  const rows = db.prepare(`
    SELECT t.*, GROUP_CONCAT(tm.mood) AS moods
    FROM tracks t
    LEFT JOIN track_moods tm ON tm.track_id = t.id
    GROUP BY t.id
  `).all();

  const filtered = rows.filter(r => {
    const moods = (r.moods || '').split(',').filter(Boolean);
    const matchQ = !q || [r.title, r.original_title, r.artist].join(' ').toLowerCase().includes(q);
    const matchM = !mood || moods.includes(mood);
    return matchQ && matchM;
  });

  res.json({ items: filtered });
});

app.get('/api/recs', (req, res) => {
  const mood = req.query.mood || null;
  const user = getUser(req);
  const uid = user?.id;

  const rows = db.prepare(`
    SELECT t.*, GROUP_CONCAT(tm.mood) AS moods
    FROM tracks t
    LEFT JOIN track_moods tm ON tm.track_id = t.id
    GROUP BY t.id
  `).all();

  const ratingsMap = {};
  if (uid) {
    db.prepare('SELECT track_id, mood FROM ratings WHERE user_id = ?')
      .all(uid)
      .forEach(r => { ratingsMap[r.track_id] = r.mood; });
  }

  const score = (t) => {
    const moods = (t.moods || '').split(',').filter(Boolean);
    let s = 0;
    if (mood && moods.includes(mood)) s += 2;
    if (ratingsMap[t.id] && ratingsMap[t.id] === mood) s += 3;
    if (/official|mv|audio/i.test(t.original_title)) s += 0.5;
    return s;
  };

  const sorted = rows.sort((a, b) => score(b) - score(a));
  res.json({ items: sorted.slice(0, 20) });
});

// ───────────────────────────────────────────────────────────────
// 감정 라벨 & 시청 기록
// ───────────────────────────────────────────────────────────────
app.post('/api/ratings', (req, res) => {
  const user = getUser(req);
  const { trackId, mood } = req.body || {};
  if (!trackId || !mood) return res.status(400).json({ error: 'trackId & mood required' });

  if (!user) {
    // 비로그인: DB 저장 없이 성공 응답 (프론트는 로컬에 저장/표시)
    return res.json({ ok: true, anonymous: true });
  }

  db.prepare(`
    INSERT INTO ratings (user_id, track_id, mood, created_at)
    VALUES (?, ?, ?, strftime('%s','now'))
    ON CONFLICT(user_id, track_id)
    DO UPDATE SET mood = excluded.mood, created_at = excluded.created_at
  `).run(user.id, trackId, mood);

  res.json({ ok: true });
});

app.post('/api/watch', (req, res) => {
  const user = getUser(req);
  const { trackId } = req.body || {};
  if (!trackId) return res.status(400).json({ error: 'trackId required' });

  if (!user) {
    // 비로그인: DB 저장 없이 성공 응답
    return res.json({ ok: true, anonymous: true });
  }

  db.prepare(`
    INSERT INTO watch_history (user_id, track_id, played_at)
    VALUES (?, ?, strftime('%s','now'))
  `).run(user.id, trackId);

  res.json({ ok: true });
});

// ───────────────────────────────────────────────────────────────
// 재생목록
// ───────────────────────────────────────────────────────────────
app.get('/api/playlists', (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: 'login required' });

  const lists = db.prepare(`
    SELECT * FROM playlists
    WHERE user_id = ?
    ORDER BY created_at DESC
  `).all(user.id);

  const itemsStmt = db.prepare(`
    SELECT pi.track_id, t.title, t.artist, t.thumb, t.source
    FROM playlist_items pi
    JOIN tracks t ON t.id = pi.track_id
    WHERE pi.playlist_id = ?
    ORDER BY position ASC
  `);

  const data = lists.map(pl => ({
    ...pl,
    items: itemsStmt.all(pl.id)
  }));

  res.json({ items: data });
});

app.post('/api/playlists', (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: 'login required' });

  const { title, isPublic } = req.body || {};
  if (!title) return res.status(400).json({ error: 'title required' });

  const r = db.prepare(`
    INSERT INTO playlists (user_id, title, is_public, created_at)
    VALUES (?, ?, ?, strftime('%s','now'))
  `).run(user.id, title, isPublic ? 1 : 0);

  res.json({ ok: true, id: r.lastInsertRowid });
});

app.post('/api/playlist/items', (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: 'login required' });

  const { playlistId, trackId, position } = req.body || {};
  if (!playlistId || !trackId) {
    return res.status(400).json({ error: 'playlistId & trackId required' });
  }

  db.prepare(`
    INSERT OR IGNORE INTO playlist_items (playlist_id, track_id, position)
    VALUES (?, ?, ?)
  `).run(playlistId, trackId, position || 0);

  res.json({ ok: true });
});

app.delete('/api/playlist/items', (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: 'login required' });

  const { playlistId, trackId } = req.body || {};
  if (!playlistId || !trackId) {
    return res.status(400).json({ error: 'playlistId & trackId required' });
  }

  db.prepare(`
    DELETE FROM playlist_items
    WHERE playlist_id = ? AND track_id = ?
  `).run(playlistId, trackId);

  res.json({ ok: true });
});

app.get('/api/playlists/public', (req, res) => {
  const lists = db.prepare(`
    SELECT id, user_id, title, is_public, created_at
    FROM playlists
    WHERE is_public = 1
    ORDER BY created_at DESC
  `).all();

  res.json({ items: lists });
});

// ───────────────────────────────────────────────────────────────
// 헬스체크 & 에러 핸들러
// ───────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true }));

// 공통 에러 핸들러 (CORS 에러 메시지 등)
app.use((err, _req, res, _next) => {
  console.error(err?.stack || err?.message || err);
  res.status(500).json({ error: String(err?.message || err || 'internal error') });
});

// ───────────────────────────────────────────────────────────────
// 서버 시작
// ───────────────────────────────────────────────────────────────
const PORT = 3001;
app.listen(PORT, () => {
  console.log(`Emotion Playlist API running at http://localhost:${PORT}`);
});
