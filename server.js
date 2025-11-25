// server.js
import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import db from './db.js';

const app = express();

// ───────────────────────────────────────────────────────────────
// YouTube API 설정
// ───────────────────────────────────────────────────────────────
const YT_KEY = process.env.YT_API_KEY || '';
let YT_QUOTA_EXCEEDED = false; // ★ 쿼터 초과 여부 플래그

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

// mood / genre / nation → 검색 키워드 만들어주는 헬퍼 (기본 쿼리)
function buildYtQuery({ mood, genre, nation }) {
  const words = [];

  // 기본 감정
  if (mood === 'happy') words.push('happy', 'feel good');
  else if (mood === 'sad') words.push('sad', 'ballad');
  else if (mood === 'angry') words.push('rock', 'angry', 'hard');
  else if (mood === 'calm') words.push('relax', 'chill', 'calm');
  else if (mood === 'energetic') words.push('upbeat', 'energy');

  // 장르/국가별 키워드
  if (genre === 'kpop' || nation === 'kr') {
    words.push('K-POP', 'kpop', 'Korean');
  } else if (genre === 'jpop' || nation === 'jp') {
    words.push('J-POP', 'jpop', 'Japanese', '日本', 'ジャパン', '音楽');
  } else if (genre === 'rock') {
    words.push('rock', 'metal');
  } else {
    words.push('pop music');
  }

  // 너무 넓지 않도록 MV 위주
  words.push('"official music video"');

  return words.join(' ');
}

// "official music video" 키워드 제거용
function stripOfficialMvKeyword(q) {
  if (!q) return '';
  return q.replace(/"official music video"/gi, '').trim();
}

// “곡이 너무 적을 때” 사용할 fallback 쿼리들
function buildFallbackQueries({ mood, genre, nation, baseQuery }) {
  const qs = [];
  const noMv = stripOfficialMvKeyword(baseQuery);
  if (noMv) qs.push(noMv);

  // JPOP 쪽은 일본어/동기부여 키워드로 보강
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

  // 그래도 아무것도 없으면 baseQuery라도 한번 더 사용
  if (!qs.length && baseQuery) qs.push(baseQuery);

  // 중복 제거
  return [...new Set(qs)].filter(Boolean);
}

// YouTube search → 우리 트랙 포맷으로 매핑
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

// 제목을 보고 플레이리스트/믹스/BGM/Shorts 같은 영상인지 판별
function isPlaylistLike(track) {
  const t = `${track.title} ${track.original_title}`.toLowerCase();

  // 영어권 플레이리스트/믹스/모음집
  if (t.includes('playlist')) return true;
  if (t.includes('play list')) return true;
  if (t.includes('mix ')) return true;
  if (t.includes(' mega mix')) return true;
  if (t.includes('full album')) return true;
  if (t.includes('best of')) return true;
  if (t.includes('my favourite') || t.includes('my favorite')) return true;
  if (/\btop\s?\d+\b/.test(t)) return true; // top10, top 20 …
  if (/\b\d+\s*(songs|tracks|hits)\b/.test(t)) return true;

  // BGM / 공부용, 작업용 같은 느낌
  if (t.includes('bgm')) return true;
  if (t.includes('study music') || t.includes('study playlist')) return true;
  if (t.includes('sleep') && t.includes('music')) return true;
  if (t.includes('lofi hip hop radio')) return true;

  // 쇼츠 관련 키워드 (#shorts, ＃shorts 등)
  if (/#shorts\b/i.test(t)) return true;
  if (/＃shorts/i.test(t)) return true;
  if (/\bshorts\b/i.test(t) && t.includes('#')) return true;

  // 일본어: プレイリスト / 作業用 / BGM / メドレー 등
  if (/プレイリスト/i.test(t)) return true;
  if (/作業用/i.test(t)) return true;
  if (/睡眠用/i.test(t)) return true;
  if (/メドレー/i.test(t)) return true;
  if (/ヒット曲集/i.test(t)) return true;
  if (/名曲集/i.test(t)) return true;
  if (/bgm/i.test(t)) return true;

  return false;
}

// 제목/설명 안의 문자열을 보고 JPOP/KPOP 쪽 점수 주기
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

// ISO8601 duration → 초 단위 숫자로 변환 (PT3M15S → 195)
function parseIsoDurationToSeconds(iso) {
  const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso);
  if (!m) return null;
  const h = parseInt(m[1] || '0', 10);
  const min = parseInt(m[2] || '0', 10);
  const s = parseInt(m[3] || '0', 10);
  return h * 3600 + min * 60 + s;
}

// videos API 로 영상 길이 가져오기
async function fetchDurations(videoIds) {
  const result = {};
  if (!videoIds.length) return result;

  // 한 번에 50개까지 가능하니까 배치로 쪼개기
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

// YouTube search 한 번 호출 (순수 raw 데이터)
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

  if (pageToken) {
    url.searchParams.set('pageToken', pageToken);
  }

  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text().catch(() => '');

    // ★ quotaExceeded 한 번 맞으면 더 이상 시도하지 않도록 플래그 On
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

// raw items → 매핑 + 중복제거 + 길이필터 + 랭킹
async function filterAndRankItems(rawItems, {
  genre,
  nation,
  limit,
  allowPlaylistLike = false,
  minSec = 0,
  maxSec = Infinity,
}) {
  let items = (rawItems || []).map(mapYtItemToTrack);

  // 중복 제거
  const seen = new Set();
  items = items.filter((t) => {
    if (!t.id) return false;
    if (seen.has(t.id)) return false;
    seen.add(t.id);
    return true;
  });

  // 길이 정보 가져와서 Shorts/너무 긴 영상 제거
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

  // JPOP/KPOP 가중치 후 정렬
  items = rankYouTubeItems(items, { genre, nation });

  if (typeof limit === 'number' && limit > 0) {
    items = items.slice(0, limit);
  }

  return items;
}

// 메인: 감정/장르/국가 기반으로 추천 검색
//  - /api/search : 기본(simple) 모드 (페이지네이션 유지)
//  - /api/recs   : rich 모드 (fallback 쿼리 + 필터 완화)
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

  // 1) 기본 검색 한 번 실행
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
    minSec: 80,          // 80초 미만(쇼츠) 제외
    maxSec: 20 * 60,     // 20분 초과(풀앨범/라이브) 제외
  });

  // /api/search(검색화면)에서는 rich 여부 상관없이 이 결과 + nextPageToken 그대로 반환
  const fromSearchEndpoint = !!(qOverride || pageToken);
  if (!rich || fromSearchEndpoint) {
    return {
      items,
      nextPageToken: data.nextPageToken || null,
    };
  }

  // ───────────── rich 모드: 추천(/api/recs)에서 결과가 너무 적을 때 보강 ─────────────
  if (items.length >= limit) {
    // 이미 원하는 개수 이상이면 그대로 사용
    return { items, nextPageToken: null };
  }

  // 2) fallback 쿼리들로 추가 검색 (여전히 regionCode 유지)
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
      nation,            // 우선은 국가 제한 유지
      pageToken: null,
      maxResults,
    });
    const filtered = await filterAndRankItems(dataF.items, {
      genre,
      nation,
      limit: limit * 2,
      allowPlaylistLike: false,
      minSec: 60,        // 약간 완화
      maxSec: 30 * 60,   // 30분까지 허용
    });
    extraItems = extraItems.concat(filtered);

    if (items.length + extraItems.length >= limit * 2) break;
  }

  // 3) 그래도 부족하면 regionCode 풀고, 플레이리스트도 허용
  if (items.length + extraItems.length < limit) {
    for (const fq of fallbackQs) {
      const dataF = await runYtSearch({
        q: fq,
        nation: null,     // 전세계
        pageToken: null,
        maxResults,
      });
      const filtered = await filterAndRankItems(dataF.items, {
        genre,
        nation,           // 랭킹에는 여전히 jp/kr 정보 반영
        limit: limit * 2,
        allowPlaylistLike: true,  // 이제는 playlist류도 허용
        minSec: 60,
        maxSec: 40 * 60,
      });
      extraItems = extraItems.concat(filtered);

      if (items.length + extraItems.length >= limit * 2) break;
    }
  }

  // 4) 기본 items + extraItems 합치고 중복 제거 + 최종 랭킹
  const merged = [];
  const seenIds = new Set();
  for (const t of [...items, ...extraItems]) {
    if (!t.id || seenIds.has(t.id)) continue;
    seenIds.add(t.id);
    merged.push(t);
  }

  const final = rankYouTubeItems(merged, { genre, nation }).slice(0, limit);

  return {
    items: final,
    nextPageToken: null,   // rich 모드는 페이지 개념 없음
  };
}

// ───────────────────────────────────────────────────────────────
// 기본 미들웨어
// ───────────────────────────────────────────────────────────────
app.use(express.json());
app.use(cookieParser());

// CORS 허용
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
app.get('/api/search', async (req, res) => {
  const qRaw = (req.query.q || '').toString();
  const mood = (req.query.mood || '').toString() || null;
  const genre = (req.query.genre || '').toString() || null;
  const nation = (req.query.nation || '').toString() || null;
  const pageToken = (req.query.pageToken || '').toString() || null;

  const hasFilterOnly = !qRaw && (mood || genre || nation);

  // 1) YouTube 검색 우선
  if (YT_KEY && !YT_QUOTA_EXCEEDED && (qRaw || genre || nation || mood)) {
    try {
      // 🔹 검색어(q)가 있으면: 기존처럼 페이지네이션 있는 기본 모드
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
        // 🔹 검색어는 없고 필터(mood/genre/nation)만 있을 때: rich 모드로 빵빵하게
        const { items } = await searchYouTubeTracks({
          mood,
          genre,
          nation,
          limit: 50,
          rich: true,      // 추천과 같은 공격적인 모드
        });

        if (items && items.length) {
          return res.json({ items, nextPageToken: null });
        }
      }
    } catch (e) {
      console.error('/api/search YouTube 실패, DB로 폴백:', e);
    }
  }

  // 2) 폴백: 로컬 DB 검색
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

  // 1) YouTube 추천 (API 키 존재 시, rich 모드 ON)
  if (YT_KEY && !YT_QUOTA_EXCEEDED) {
    try {
      const { items } = await searchYouTubeTracks({
        mood,
        genre,
        nation,
        limit: 20,
        rich: true,   // 추천에서는 공격적으로 여러 쿼리 + 필터완화
      });

      if (items && items.length) {
        return res.json({ items });
      }
    } catch (e) {
      console.error('/api/recs YouTube 실패, DB로 폴백:', e);
    }
  }

  // 2) 폴백: 기존 DB 기반 추천
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
// 재생목록
// ───────────────────────────────────────────────────────────────
app.get('/api/playlists', (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: 'login required' });

  const lists = db
    .prepare(
      `
      SELECT * FROM playlists
      WHERE user_id = ?
      ORDER BY created_at DESC
    `,
    )
    .all(user.id);

  const itemsStmt = db.prepare(
    `
      SELECT pi.track_id, t.title, t.artist, t.thumb, t.source
      FROM playlist_items pi
      JOIN tracks t ON t.id = pi.track_id
      WHERE pi.playlist_id = ?
      ORDER BY position ASC
    `,
  );

  const data = lists.map((pl) => ({
    ...pl,
    items: itemsStmt.all(pl.id),
  }));

  res.json({ items: data });
});

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

app.get('/api/playlists/public', (req, res) => {
  const lists = db
    .prepare(
      `
      SELECT id, user_id, title, is_public, created_at
      FROM playlists
      WHERE is_public = 1
      ORDER BY created_at DESC
    `,
    )
    .all();

  res.json({ items: lists });
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
