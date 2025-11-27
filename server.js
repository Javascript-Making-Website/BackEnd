// server.js
import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import crypto from 'crypto';
import db from './db.js';

const app = express();

// ───────────────────────────────────────────────────────────────
// YouTube API 설정
// ───────────────────────────────────────────────────────────────
const YT_KEY = process.env.YT_API_KEY || '';
let YT_QUOTA_EXCEEDED = false; // 쿼터 초과 여부 플래그

if (!YT_KEY) {
  console.warn(
    '[WARN] YT_API_KEY 환경변수가 설정되어 있지 않습니다. YouTube 검색이 비활성화됩니다.',
  );
} else {
  console.log('[INFO] YouTube 검색이 활성화되었습니다.');
}

// ───────────────────────────────────────────────────────────────
// YouTube 헬퍼들
// ───────────────────────────────────────────────────────────────

// mood / genre / nation → 검색 키워드 만들어주는 헬퍼
function buildYtQuery({ mood, genre, nation }) {
  const words = [];

  if (mood === 'happy') words.push('happy', 'feel good');
  else if (mood === 'sad') words.push('sad', 'ballad');
  else if (mood === 'angry') words.push('rock', 'angry', 'hard');
  else if (mood === 'calm') words.push('relax', 'chill', 'calm');
  else if (mood === 'energetic') words.push('upbeat', 'energy');

  if (genre === 'kpop' || nation === 'kr') {
    words.push('K-POP', 'kpop', 'Korean');
  } else if (genre === 'jpop' || nation === 'jp') {
    words.push('J-POP', 'jpop', 'Japanese', '日本', 'ジャパン', '音楽');
  } else if (genre === 'rock') {
    words.push('rock', 'metal');
  } else {
    words.push('pop music');
  }

  words.push('"official music video"');
  return words.join(' ');
}

function stripOfficialMvKeyword(q) {
  if (!q) return '';
  return q.replace(/"official music video"/gi, '').trim();
}

function buildFallbackQueries({ mood, genre, nation, baseQuery }) {
  const qs = [];
  const noMv = stripOfficialMvKeyword(baseQuery);
  if (noMv) qs.push(noMv);

  if (genre === 'jpop' || nation === 'jp') {
    if (mood === 'energetic' || mood === 'angry') {
      qs.push('J-POP 元気 ソング');
      qs.push('JPOP アップテンポ 曲');
      qs.push('Japanese rock upbeat');
      qs.push('日本 モチベーション 曲');
    } else if (mood === 'happy') {
      qs.push('J-POP ハッピー ソング');
      qs.push('JPOP pop song');
      qs.push('日本 明るい 曲');
    } else if (mood === 'sad') {
      qs.push('J-POP バラード');
      qs.push('日本 切ない 曲');
    } else if (mood === 'calm') {
      qs.push('J-POP 癒し ソング');
      qs.push('日本 リラックス 音楽');
    }
  }

  if (!qs.length && baseQuery) qs.push(baseQuery);
  return [...new Set(qs)].filter(Boolean);
}

function mapYtItemToTrack(item) {
  const id = item.id?.videoId;
  const sn = item.snippet || {};
  const title = sn.title || '';
  const channel = sn.channelTitle || '';
  const thumb =
    sn.thumbnails?.high?.url ||
    sn.thumbnails?.medium?.url ||
    sn.thumbnails?.default?.url ||
    '';

  return {
    id: 'youtube:' + id,
    source: 'YouTube',
    title: `${channel} — ${title}`,
    original_title: title,
    artist: channel,
    thumb,
    url: `https://www.youtube.com/watch?v=${id}`,
  };
}

function isPlaylistLike(track) {
  const t = `${track.title} ${track.original_title}`.toLowerCase();

  if (t.includes('playlist')) return true;
  if (t.includes('play list')) return true;
  if (t.includes('mix ')) return true;
  if (t.includes(' mega mix')) return true;
  if (t.includes('full album')) return true;
  if (t.includes('best of')) return true;
  if (t.includes('my favourite') || t.includes('my favorite')) return true;
  if (/\btop\s?\d+\b/.test(t)) return true;
  if (/\b\d+\s*(songs|tracks|hits)\b/.test(t)) return true;

  if (t.includes('bgm')) return true;
  if (t.includes('study music') || t.includes('study playlist')) return true;
  if (t.includes('sleep') && t.includes('music')) return true;
  if (t.includes('lofi hip hop radio')) return true;

  if (/#shorts\b/i.test(t)) return true;
  if (/＃shorts/i.test(t)) return true;
  if (/\bshorts\b/i.test(t) && t.includes('#')) return true;

  if (/プレイリスト/i.test(t)) return true;
  if (/作業用/i.test(t)) return true;
  if (/睡眠用/i.test(t)) return true;
  if (/メドレー/i.test(t)) return true;
  if (/ヒット曲集/i.test(t)) return true;
  if (/名曲集/i.test(t)) return true;

  return false;
}

function rankYouTubeItems(items, { genre, nation }) {
  return [...items].sort(
    (a, b) => score(b, genre, nation) - score(a, genre, nation),
  );

  function score(t, genre, nation) {
    const text = `${t.title} ${t.original_title}`.toLowerCase();
    let s = 0;

    const hasJapanese = /[ぁ-んァ-ン一-龯]/.test(
      t.title + t.original_title,
    );
    const hasKorean = /[가-힣]/.test(t.title + t.original_title);

    if (genre === 'jpop') {
      if (hasJapanese) s += 4;
      if (text.includes('j-pop') || text.includes('jpop')) s += 3;
      if (hasKorean || text.includes('k-pop') || text.includes('kpop')) s -= 3;
    } else if (genre === 'kpop') {
      if (hasKorean) s += 4;
      if (text.includes('k-pop') || text.includes('kpop')) s += 3;
      if (hasJapanese || text.includes('j-pop') || text.includes('jpop')) s -= 2;
    }

    if (nation === 'jp' && hasJapanese) s += 2;
    if (nation === 'kr' && hasKorean) s += 2;

    if (/official/.test(text)) s += 0.5;
    return s;
  }
}

function parseIsoDurationToSeconds(iso) {
  const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso);
  if (!m) return null;
  const h = parseInt(m[1] || '0', 10);
  const min = parseInt(m[2] || '0', 10);
  const s = parseInt(m[3] || '0', 10);
  return h * 3600 + min * 60 + s;
}

async function fetchDurations(videoIds) {
  const result = {};
  if (!videoIds.length) return result;

  for (let i = 0; i < videoIds.length; i += 50) {
    const batch = videoIds.slice(i, i + 50);
    const url = new URL('https://www.googleapis.com/youtube/v3/videos');
    url.searchParams.set('key', YT_KEY);
    url.searchParams.set('part', 'contentDetails');
    url.searchParams.set('id', batch.join(','));

    const res = await fetch(url);
    if (!res.ok) continue;

    const data = await res.json();
    (data.items || []).forEach((it) => {
      const id = it.id;
      const iso = it.contentDetails?.duration;
      const sec = iso ? parseIsoDurationToSeconds(iso) : null;
      if (sec != null) result[id] = sec;
    });
  }

  return result;
}

async function runYtSearch({ q, nation, pageToken, maxResults }) {
  if (!YT_KEY || YT_QUOTA_EXCEEDED) {
    throw new Error('YouTube API disabled or quota exceeded');
  }

  const url = new URL('https://www.googleapis.com/youtube/v3/search');
  url.searchParams.set('key', YT_KEY);
  url.searchParams.set('part', 'snippet');
  url.searchParams.set('type', 'video');
  url.searchParams.set('maxResults', String(maxResults));
  url.searchParams.set('q', q);
  url.searchParams.set('videoEmbeddable', 'true');
  url.searchParams.set('safeSearch', 'moderate');

  if (nation === 'kr') url.searchParams.set('regionCode', 'KR');
  else if (nation === 'jp') url.searchParams.set('regionCode', 'JP');

  if (pageToken) url.searchParams.set('pageToken', pageToken);

  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text().catch(() => '');

    if (res.status === 403 && /quota/i.test(text)) {
      YT_QUOTA_EXCEEDED = true;
      console.warn(
        '[WARN] YouTube API quota exceeded. 오늘 남은 시간 동안은 DB/더미 데이터만 사용합니다.',
      );
    }

    throw new Error('YouTube API error: ' + res.status + ' ' + text);
  }
  return res.json();
}

async function filterAndRankItems(
  rawItems,
  {
    genre,
    nation,
    limit,
    allowPlaylistLike = false,
    minSec = 0,
    maxSec = Infinity,
  },
) {
  let items = (rawItems || []).map(mapYtItemToTrack);

  const seen = new Set();
  items = items.filter((t) => {
    if (!t.id) return false;
    if (seen.has(t.id)) return false;
    seen.add(t.id);
    return true;
  });

  const ids = items.map((t) => t.id.replace('youtube:', ''));
  const durations = await fetchDurations(ids);

  items = items.filter((t) => {
    if (!allowPlaylistLike && isPlaylistLike(t)) return false;

    const sec = durations[t.id.replace('youtube:', '')];
    if (sec != null) {
      if (sec < minSec) return false;
      if (sec > maxSec) return false;
    }
    return true;
  });

  items = rankYouTubeItems(items, { genre, nation });

  if (typeof limit === 'number' && limit > 0) {
    items = items.slice(0, limit);
  }
  return items;
}

async function searchYouTubeTracks({
  mood,
  genre,
  nation,
  limit = 20,
  qOverride,
  pageToken,
  rich = false,
}) {
  if (!YT_KEY || YT_QUOTA_EXCEEDED) {
    throw new Error('YT_API disabled or quota exceeded');
  }

  const baseQuery = qOverride || buildYtQuery({ mood, genre, nation });
  const maxResults = Math.min(limit * 3, 50);

  const data = await runYtSearch({
    q: baseQuery,
    nation,
    pageToken,
    maxResults,
  });

  let items = await filterAndRankItems(data.items, {
    genre,
    nation,
    limit,
    allowPlaylistLike: false,
    minSec: 80,
    maxSec: 20 * 60,
  });

  const fromSearchEndpoint = !!(qOverride || pageToken);
  if (!rich || fromSearchEndpoint) {
    return {
      items,
      nextPageToken: data.nextPageToken || null,
    };
  }

  if (items.length >= limit) {
    return { items, nextPageToken: null };
  }

  const fallbackQs = buildFallbackQueries({
    mood,
    genre,
    nation,
    baseQuery,
  });

  let extraItems = [];
  for (const fq of fallbackQs) {
    const dataF = await runYtSearch({
      q: fq,
      nation,
      pageToken: null,
      maxResults,
    });
    const filtered = await filterAndRankItems(dataF.items, {
      genre,
      nation,
      limit: limit * 2,
      allowPlaylistLike: false,
      minSec: 60,
      maxSec: 30 * 60,
    });
    extraItems = extraItems.concat(filtered);

    if (items.length + extraItems.length >= limit * 2) break;
  }

  if (items.length + extraItems.length < limit) {
    for (const fq of fallbackQs) {
      const dataF = await runYtSearch({
        q: fq,
        nation: null,
        pageToken: null,
        maxResults,
      });
      const filtered = await filterAndRankItems(dataF.items, {
        genre,
        nation,
        limit: limit * 2,
        allowPlaylistLike: true,
        minSec: 60,
        maxSec: 40 * 60,
      });
      extraItems = extraItems.concat(filtered);

      if (items.length + extraItems.length >= limit * 2) break;
    }
  }

  const merged = [];
  const seenIds = new Set();
  for (const t of [...items, ...extraItems]) {
    if (!t.id || seenIds.has(t.id)) continue;
    seenIds.add(t.id);
    merged.push(t);
  }

  const final = rankYouTubeItems(merged, { genre, nation }).slice(0, limit);
  return { items: final, nextPageToken: null };
}

// ───────────────────────────────────────────────────────────────
// 기본 미들웨어
// ───────────────────────────────────────────────────────────────
app.use(express.json());
app.use(cookieParser());

const allowedOrigins = [
  'http://localhost:5500',
  'http://127.0.0.1:5500',
  'http://localhost:3000',
  'http://localhost:5173',
];

const corsOptions = {
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    if (allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error(`CORS blocked: ${origin}`), false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
};
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// ───────────────────────────────────────────────────────────────
// 유틸 함수
// ───────────────────────────────────────────────────────────────
function hashPassword(pw) {
  return crypto.createHash('sha256').update(pw).digest('hex');
}

const getUser = (req) => {
  const username = req.cookies?.user || null;
  if (!username) return null;
  const row = db
    .prepare('SELECT id, username, email FROM users WHERE username = ?')
    .get(username);
  return row || null;
};

const playlistItemsStmt = db.prepare(`
  SELECT pi.track_id, t.title, t.artist, t.thumb, t.source
  FROM playlist_items pi
  JOIN tracks t ON t.id = pi.track_id
  WHERE pi.playlist_id = ?
  ORDER BY pi.position ASC
`);

// ───────────────────────────────────────────────────────────────
// 인증 관련 API (회원가입 + 로그인)
// ───────────────────────────────────────────────────────────────

// 회원가입
app.post('/api/signup', (req, res) => {
  try {
    const { username, password, email } = req.body || {};

    if (!username || !password) {
      return res.status(400).json({ error: 'username & password required' });
    }

    // 아이디 중복 체크
    const exist = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (exist) {
      return res.status(409).json({ error: '이미 사용 중인 아이디입니다.' });
    }

    const password_hash = hashPassword(password);

    const r = db.prepare(`
      INSERT INTO users (username, password_hash, email)
      VALUES (?, ?, ?)
    `).run(username, password_hash, email || null);

    // 가입 후 바로 로그인 상태로 만들어주기
    res.cookie('user', username, {
      httpOnly: false,
      sameSite: 'lax',
      secure: false,
    });

    return res.json({
      ok: true,
      user: {
        id: r.lastInsertRowid,
        username,
        email: email || null,
      },
    });
  } catch (err) {
    console.error('SIGNUP ERROR:', err);  // ★ 콘솔에서 실제 에러 확인
    return res
      .status(500)
      .json({ error: String(err.message || err || 'internal error') });  // ★ 에러 내용을 그대로 내려줌
  }
});


// 로그인
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'username & password required' });
  }

  const user = db
    .prepare('SELECT * FROM users WHERE username = ?')
    .get(username);

  if (!user) {
    return res
      .status(401)
      .json({ error: '아이디 또는 비밀번호가 올바르지 않습니다.' });
  }

  const hash = hashPassword(password);
  if (hash !== user.password_hash) {
    return res
      .status(401)
      .json({ error: '아이디 또는 비밀번호가 올바르지 않습니다.' });
  }

  res.cookie('user', user.username, {
    httpOnly: false,
    sameSite: 'lax',
    secure: false,
  });

  res.json({ ok: true, user: user.username });
});

// 로그아웃
app.post('/api/logout', (req, res) => {
  res.clearCookie('user');
  res.json({ ok: true });
});

// 현재 로그인 유저
app.get('/api/me', (req, res) => {
  const u = getUser(req);
  // 프론트(auth.js)는 문자열만 기대하므로 username만 넘겨줌
  res.json({ user: u ? u.username : null });
});

// ───────────────────────────────────────────────────────────────
// 검색 & 추천
// ───────────────────────────────────────────────────────────────
app.get('/api/search', async (req, res) => {
  const qRaw = (req.query.q || '').toString();
  const mood = (req.query.mood || '').toString() || null;
  const genre = (req.query.genre || '').toString() || null;
  const nation = (req.query.nation || '').toString() || null;
  const pageToken = (req.query.pageToken || '').toString() || null;

  const hasFilterOnly = !qRaw && (mood || genre || nation);

  if (YT_KEY && !YT_QUOTA_EXCEEDED && (qRaw || genre || nation || mood)) {
    try {
      if (qRaw) {
        const { items, nextPageToken } = await searchYouTubeTracks({
          mood,
          genre,
          nation,
          limit: 50,
          qOverride: qRaw,
          pageToken,
          rich: false,
        });

        if (items && items.length) {
          return res.json({ items, nextPageToken });
        }
      } else if (hasFilterOnly) {
        const { items } = await searchYouTubeTracks({
          mood,
          genre,
          nation,
          limit: 50,
          rich: true,
        });

        if (items && items.length) {
          return res.json({ items, nextPageToken: null });
        }
      }
    } catch (e) {
      console.error('/api/search YouTube 실패, DB로 폴백:', e);
    }
  }

  const q = qRaw.toLowerCase();
  const rows = db
    .prepare(
      `
    SELECT t.*, GROUP_CONCAT(tm.mood) AS moods
    FROM tracks t
    LEFT JOIN track_moods tm ON tm.track_id = t.id
    GROUP BY t.id
  `,
    )
    .all();

  const filtered = rows.filter((r) => {
    const moods = (r.moods || '').split(',').filter(Boolean);
    const matchQ =
      !q ||
      [r.title, r.original_title, r.artist].join(' ').toLowerCase().includes(q);
    const matchM = !mood || moods.includes(mood);
    return matchQ && matchM;
  });

  res.json({ items: filtered, nextPageToken: null });
});

app.get('/api/recs', async (req, res) => {
  const mood = (req.query.mood || '').toString() || null;
  const genre = (req.query.genre || '').toString() || null;
  const nation = (req.query.nation || '').toString() || null;
  const user = getUser(req);
  const uid = user?.id;

  if (YT_KEY && !YT_QUOTA_EXCEEDED) {
    try {
      const { items } = await searchYouTubeTracks({
        mood,
        genre,
        nation,
        limit: 20,
        rich: true,
      });

      if (items && items.length) {
        return res.json({ items });
      }
    } catch (e) {
      console.error('/api/recs YouTube 실패, DB로 폴백:', e);
    }
  }

  const rows = db
    .prepare(
      `
      SELECT t.*, GROUP_CONCAT(tm.mood) AS moods
      FROM tracks t
      LEFT JOIN track_moods tm ON tm.track_id = t.id
      GROUP BY t.id
    `,
    )
    .all();

  const ratingsMap = {};
  if (uid) {
    db.prepare('SELECT track_id, mood FROM ratings WHERE user_id = ?')
      .all(uid)
      .forEach((r) => {
        ratingsMap[r.track_id] = r.mood;
      });
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
  if (!trackId || !mood)
    return res.status(400).json({ error: 'trackId & mood required' });

  if (!user) {
    return res.json({ ok: true, anonymous: true });
  }

  db.prepare(
    `
      INSERT INTO ratings (user_id, track_id, mood, created_at)
      VALUES (?, ?, ?, strftime('%s','now'))
      ON CONFLICT(user_id, track_id)
      DO UPDATE SET mood = excluded.mood, created_at = excluded.created_at
    `,
  ).run(user.id, trackId, mood);

  res.json({ ok: true });
});

app.post('/api/watch', (req, res) => {
  const user = getUser(req);
  const { trackId } = req.body || {};
  if (!trackId) return res.status(400).json({ error: 'trackId required' });

  if (!user) {
    return res.json({ ok: true, anonymous: true });
  }

  db.prepare(
    `
      INSERT INTO watch_history (user_id, track_id, played_at)
      VALUES (?, ?, strftime('%s','now'))
    `,
  ).run(user.id, trackId);

  res.json({ ok: true });
});

// ───────────────────────────────────────────────────────────────
// 재생목록 + 좋아요
// ───────────────────────────────────────────────────────────────

// 내 재생목록
app.get('/api/playlists', (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: 'login required' });

  const lists = db
    .prepare(
      `
      SELECT
        p.*,
        (SELECT COUNT(*) FROM playlist_likes pl WHERE pl.playlist_id = p.id) AS likes,
        EXISTS(
          SELECT 1 FROM playlist_likes pl2
          WHERE pl2.playlist_id = p.id AND pl2.user_id = ?
        ) AS liked
      FROM playlists p
      WHERE p.user_id = ?
      ORDER BY p.created_at DESC
    `,
    )
    .all(user.id, user.id);

  const data = lists.map((pl) => ({
    ...pl,
    liked: !!pl.liked,
    is_public: !!pl.is_public,
    items: playlistItemsStmt.all(pl.id),
  }));

  res.json({ items: data });
});

// 재생목록 생성
app.post('/api/playlists', (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: 'login required' });

  const { title, isPublic } = req.body || {};
  if (!title) return res.status(400).json({ error: 'title required' });

  const r = db
    .prepare(
      `
      INSERT INTO playlists (user_id, title, is_public, created_at)
      VALUES (?, ?, ?, strftime('%s','now'))
    `,
    )
    .run(user.id, title, isPublic ? 1 : 0);

  res.json({ ok: true, id: r.lastInsertRowid });
});

// 재생목록에 트랙 추가
app.post('/api/playlist/items', (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: 'login required' });

  const { playlistId, trackId, position } = req.body || {};
  if (!playlistId || !trackId) {
    return res
      .status(400)
      .json({ error: 'playlistId & trackId required' });
  }

  db.prepare(
    `
      INSERT OR IGNORE INTO playlist_items (playlist_id, track_id, position)
      VALUES (?, ?, ?)
    `,
  ).run(playlistId, trackId, position || 0);

  res.json({ ok: true });
});

// 재생목록에서 트랙 삭제
app.delete('/api/playlist/items', (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: 'login required' });

  const { playlistId, trackId } = req.body || {};
  if (!playlistId || !trackId) {
    return res
      .status(400)
      .json({ error: 'playlistId & trackId required' });
  }

  db.prepare(
    `
      DELETE FROM playlist_items
      WHERE playlist_id = ? AND track_id = ?
    `,
  ).run(playlistId, trackId);

  res.json({ ok: true });
});

// 특정 재생목록 상세
app.get('/api/playlists/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid id' });

  const pl = db
    .prepare(
      `
      SELECT
        p.*,
        u.username AS owner_name,
        (SELECT COUNT(*) FROM playlist_likes pl WHERE pl.playlist_id = p.id) AS likes
      FROM playlists p
      JOIN users u ON u.id = p.user_id
      WHERE p.id = ?
    `,
    )
    .get(id);

  if (!pl) return res.status(404).json({ error: 'not found' });

  const items = playlistItemsStmt.all(id);

  res.json({
    ...pl,
    is_public: !!pl.is_public,
    items,
  });
});

// 재생목록 좋아요 토글
app.post('/api/playlists/:id/like', (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: 'login required' });

  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid id' });

  const exists = db
    .prepare('SELECT 1 FROM playlists WHERE id = ?')
    .get(id);
  if (!exists) return res.status(404).json({ error: 'not found' });

  const likedRow = db
    .prepare(
      `SELECT 1 FROM playlist_likes WHERE user_id = ? AND playlist_id = ?`,
    )
    .get(user.id, id);

  if (likedRow) {
    db.prepare(
      `DELETE FROM playlist_likes WHERE user_id = ? AND playlist_id = ?`,
    ).run(user.id, id);
  } else {
    db.prepare(
      `
      INSERT INTO playlist_likes (user_id, playlist_id, created_at)
      VALUES (?, ?, strftime('%s','now'))
    `,
    ).run(user.id, id);
  }

  const likes = db
    .prepare(
      `SELECT COUNT(*) AS cnt FROM playlist_likes WHERE playlist_id = ?`,
    )
    .get(id).cnt;

  res.json({ ok: true, liked: !likedRow, likes });
});

// 공개 재생목록 (최근 / 인기)
app.get('/api/playlists/public', (req, res) => {
  const sort = req.query.sort === 'popular' ? 'popular' : 'recent';
  const limit = Number(req.query.limit || 20) || 20;

  const orderBy =
    sort === 'popular'
      ? 'likes DESC, p.created_at DESC'
      : 'p.created_at DESC';

  const lists = db
    .prepare(
      `
      SELECT
        p.id,
        p.user_id,
        p.title,
        p.is_public,
        p.created_at,
        u.username AS owner_name,
        (SELECT COUNT(*) FROM playlist_likes pl WHERE pl.playlist_id = p.id) AS likes
      FROM playlists p
      JOIN users u ON u.id = p.user_id
      WHERE p.is_public = 1
      ORDER BY ${orderBy}
      LIMIT ?
    `,
    )
    .all(limit);

  const items = lists.map((pl) => ({
    ...pl,
    is_public: !!pl.is_public,
    items: playlistItemsStmt.all(pl.id),
  }));

  res.json({ items });
});

// ───────────────────────────────────────────────────────────────
// 헬스체크 & 에러 핸들러
// ───────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true }));

app.use((err, _req, res, _next) => {
  console.error(err?.stack || err?.message || err);
  res
    .status(500)
    .json({ error: String(err?.message || err || 'internal error') });
});

// ───────────────────────────────────────────────────────────────
// 서버 시작
// ───────────────────────────────────────────────────────────────
const PORT = 3001;
app.listen(PORT, () => {
  console.log(`Emotion Playlist API running at http://localhost:${PORT}`);
});
