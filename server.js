/**
 * server.js — Emotion Playlist 메인 API 서버 (Express)
 * ======================================================================================
 * 핵심 개념
 *   - "YouTube 실시간 검색" + "로컬 DB 폴백" 하이브리드
 *   - 로그인은 단순 쿠키(user) 기반(데모). JWT/세션으로 확장 가능.
 *   - 개인화 추천은 최근 경향/내 라벨/시청횟수/스킵/최애·유사 아티스트/설문 tone 가중치로 점수화.
 *
 * 프런트 사용 흐름
 *   - /api/signup, /api/login → 쿠키 세팅
 *   - /api/search → 검색 탭(무한스크롤: nextPageToken 사용)
 *   - /api/recs → 감정 테스트 결과/개인화 추천
 *   - /api/watch, /api/skip, /api/ratings → 재생/스킵/라벨 기록
 *   - /api/playlists... → 재생목록 CRUD/좋아요/공개피드
 */

import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import crypto from 'crypto';
import db from './db.js';

const app = express();

// ───────────────────────────────────────────────────────────────
// (0) 아티스트 유사도 맵 — 추천 점수 보정용
// ───────────────────────────────────────────────────────────────
const SIMILAR_ARTISTS = {
  'YOASOBI': ['Aimer', 'ずっと真夜中でいいのに。', 'ZUTOMAYO', '緑黄色社会'],
  'Official髭男dism': ['back number', 'Mrs. GREEN APPLE', 'King Gnu'],
  'BTS': ['SEVENTEEN', 'TXT', 'Stray Kids', 'ENHYPEN'],
  'IVE': ['NewJeans', 'LE SSERAFIM', 'STAYC'],
  'IU': ['태연', 'AKMU', '볼빨간사춘기'],
  'Metallica': ['Megadeth', 'Iron Maiden', 'Slayer'],
};

// ───────────────────────────────────────────────────────────────
// (1) YouTube API 상태
// ───────────────────────────────────────────────────────────────
const YT_KEY = process.env.YT_API_KEY || '';
let YT_QUOTA_EXCEEDED = false;

if (!YT_KEY) {
  console.warn('[WARN] YT_API_KEY 환경변수가 설정되어 있지 않습니다. YouTube 검색이 비활성화됩니다.');
} else {
  console.log('[INFO] YouTube 검색이 활성화되었습니다.');
}

// ───────────────────────────────────────────────────────────────
// (2) YouTube 검색 헬퍼 세트
// ───────────────────────────────────────────────────────────────

// 감정/장르/국가/세부감정/톤을 키워드 조합으로 변환 → 유튜브 검색 질의어
function buildYtQuery({ mood, genre, nation, subEmotion, tone }) {
  const words = [];

  // 2-1) 기본 감정 키워드
  if (mood === 'happy')      words.push('happy', 'feel good');
  else if (mood === 'sad')   words.push('sad', 'ballad');
  else if (mood === 'angry') words.push('rock', 'angry', 'hard');
  else if (mood === 'calm')  words.push('relax', 'chill', 'calm');
  else if (mood === 'energetic') words.push('upbeat', 'energy');

  // 2-2) 세부 감정(설문)
  const se = (subEmotion || '').toLowerCase();
  if (se) {
    if (se.includes('in_love') || /사랑/.test(subEmotion)) { words.push('love song', 'romantic', 'ballad'); }
    if (se.includes('travel') || /여행/.test(subEmotion)) { words.push('road trip', 'driving song', 'travel music'); }
    if (se.includes('excited') || /신난다/.test(subEmotion)) { words.push('upbeat', 'dance', 'party'); }

    if (se.includes('lonely') || /외로움/.test(subEmotion) || /그립다/.test(subEmotion)) { words.push('lonely', 'sad song', 'emotional ballad'); }
    if (se.includes('drained') || /아무것도 하기 싫다/.test(subEmotion)) { words.push('chill', 'lofi', 'relaxing'); }

    if (se.includes('unfair') || se.includes('annoyed') || se.includes('rage') ||
        /억울/.test(subEmotion) || /짜증/.test(subEmotion) || /스트레스를 풀고 싶다/.test(subEmotion)) {
      words.push('rock', 'metal', 'angry music');
    }

    if (se.includes('rest') || se.includes('organize') || se.includes('reflect') ||
        /쉬고 싶다/.test(subEmotion) || /차분하게 정리/.test(subEmotion) || /앞으로를 생각/.test(subEmotion)) {
      words.push('relaxing', 'acoustic', 'piano');
    }

    if (se.includes('achieve') || se.includes('explosion') || se.includes('selfdev') ||
        /해내고 싶다/.test(subEmotion) || /열정이 폭발/.test(subEmotion) || /자기계발/.test(subEmotion)) {
      words.push('motivation song', 'inspirational', 'energetic');
    }
  }

  // 2-3) tone(음악 분위기) 보정
  if (tone === 'boost')      words.push('feel good', 'uplifting', 'anthem');
  else if (tone === 'soothe') words.push('acoustic', 'piano', 'healing', 'calm');
  else if (tone === 'energy') words.push('upbeat', 'high energy', 'fast tempo', 'workout');
  else if (tone === 'breeze') words.push('chill', 'background music', 'easy listening');
  else if (tone === 'focus')  words.push('lofi', 'study music', 'concentration');

  // 2-4) 장르/국가 힌트
  if (genre === 'kpop' || nation === 'kr') {
    words.push('K-POP', 'kpop', 'Korean', 'idol', '아이돌', 'dance practice', 'performance video', 'MV');
  } else if (genre === 'jpop' || nation === 'jp') {
    words.push('J-POP', 'jpop', 'Japanese', '日本', 'ジャパン', '音楽', 'アニメ', 'anime song', 'ボカロ', 'vocaloid');
  } else if (genre === 'rock') {
    words.push('rock', 'metal');
  } else {
    words.push('pop music');
  }

  // MV 선호
  words.push('"official music video"');
  return words.join(' ');
}

// "official music video" 제거 버전(폴백 질의 만들 때 사용)
function stripOfficialMvKeyword(q) {
  if (!q) return '';
  return q.replace(/"official music video"/gi, '').trim();
}

// 초기 결과가 약하면 국가/언어별 키워드로 대체 질의 세트 생성
function buildFallbackQueries({ mood, genre, nation, baseQuery }) {
  const qs = [];
  const noMv = stripOfficialMvKeyword(baseQuery);
  if (noMv) qs.push(noMv);

  const g =
    genre ||
    (nation === 'jp' ? 'jpop'
     : nation === 'kr' ? 'kpop'
     : null);

  if (g === 'jpop' || nation === 'jp') {
    if (mood === 'energetic' || mood === 'angry') {
      qs.push('J-POP 元気 ソング','JPOP アップテンポ 曲','Japanese rock upbeat','日本 モチベーション 曲');
    } else if (mood === 'happy') {
      qs.push('J-POP ハッピー ソング','JPOP pop song','日本 明るい 曲');
    } else if (mood === 'sad') {
      qs.push('J-POP バラード','日本 切ない 曲');
    } else if (mood === 'calm') {
      qs.push('J-POP 癒し ソング','日本 リラックス 音楽');
    }
  }
  else if (g === 'kpop' || nation === 'kr') {
    if (mood === 'energetic' || mood === 'happy') {
      qs.push('K-POP 댄스곡','kpop upbeat songs','아이돌 댄스 노래');
    } else if (mood === 'sad' || mood === 'calm') {
      qs.push('K-POP 발라드','kpop ballad','슬픈 발라드 추천');
    } else if (mood === 'angry') {
      qs.push('K-POP rock band','kpop 밴드 사운드');
    }
  }
  else if (g === 'rock') {
    if (mood === 'happy' || mood === 'energetic') {
      qs.push('upbeat rock songs','motivational rock music','fast rock metal');
    } else if (mood === 'sad' || mood === 'calm') {
      qs.push('rock ballad songs','emotional rock ballad');
    } else if (mood === 'angry') {
      qs.push('angry rock songs','heavy metal songs');
    }
  }
  else {
    if (mood === 'happy' || mood === 'energetic') {
      qs.push('feel good pop songs','upbeat pop music');
    } else if (mood === 'sad' || mood === 'calm') {
      qs.push('sad pop ballad','emotional pop songs');
    } else if (mood === 'angry') {
      qs.push('angry alternative rock','dark pop rock');
    }
  }

  if (!qs.length && baseQuery) qs.push(baseQuery);
  return [...new Set(qs)].filter(Boolean);
}

// YouTube Search API item → 우리 트랙 포맷
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

// 감상 목적이 아닌 영상(플리·직캠·공연·방송·챌린지·학습BGM·Shorts 등) 필터
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

  // 랜덤플레이/챌린지/직캠/댄스/방송 등
  if (t.includes('random play dance')) return true;
  if (t.includes('랜덤플레이')) return true;
  if (t.includes('랜덤플레이댄스')) return true;
  if (t.includes('randplay')) return true;
  if (t.includes('랜플')) return true;

  if (t.includes('challenge')) return true;
  if (t.includes('챌린지')) return true;

  if (t.includes('dance')) return true;
  if (t.includes('안무')) return true;
  if (t.includes('댄스')) return true;

  if (t.includes('직캠')) return true;
  if (t.includes('풀캠')) return true;
  if (t.includes('fancam')) return true;

  if (t.includes('KBS')) return true;
  if (t.includes('SBS')) return true;
  if (t.includes('MBC')) return true;
  if (t.includes('스브스')) return true;
  if (t.includes('SM C&C Entertainment')) return true;

  if (t.includes('practice')) return true;
  if (t.includes('연습실')) return true;
  if (t.includes('practice video')) return true;

  if (t.includes('live')) return true;
  if (t.includes('performance')) return true;
  if (t.includes('공연')) return true;

  if (t.includes('cover')) return true;
  if (t.includes('커버')) return true;

  // 일본어 버전
  if (t.includes('ダンス')) return true;
  if (t.includes('ライブ')) return true;
  if (t.includes('カバー')) return true;
  if (t.includes('パフォーマンス')) return true;
  
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

// 간단 랭킹: 장르/국가 언어 힌트 + 'official' 가산
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

// ISO8601 PT#H#M#S → 초
function parseIsoDurationToSeconds(iso) {
  const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso);
  if (!m) return null;
  const h = parseInt(m[1] || '0', 10);
  const min = parseInt(m[2] || '0', 10);
  const s = parseInt(m[3] || '0', 10);
  return h * 3600 + min * 60 + s;
}

// 여러 영상의 길이 조회(50개씩 배치) — 너무 짧거나 긴 영상 제외에 사용
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

// YouTube Search API 호출(지역/페이징/최대개수 반영)
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

// 검색 결과 정제(중복·비감상영상·길이 필터) → 랭킹 → 상위 limit개
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

  // 중복 제거
  const seen = new Set();
  items = items.filter((t) => {
    if (!t.id) return false;
    if (seen.has(t.id)) return false;
    seen.add(t.id);
    return true;
  });

  // 길이 가져오기
  const ids = items.map((t) => t.id.replace('youtube:', ''));
  const durations = await fetchDurations(ids);

  // 필터링
  items = items.filter((t) => {
    if (!allowPlaylistLike && isPlaylistLike(t)) return false;

    const sec = durations[t.id.replace('youtube:', '')];
    if (sec != null) {
      if (sec < minSec) return false;
      if (sec > maxSec) return false;
    }
    return true;
  });

  // 랭크
  items = rankYouTubeItems(items, { genre, nation });

  // 자르기
  if (typeof limit === 'number' && limit > 0) {
    items = items.slice(0, limit);
  }
  return items;
}

// 상위 레벨 검색: 기본 질의 → 부족하면 폴백 질의들 시도 → 병합/랭킹
async function searchYouTubeTracks({
  mood,
  genre,
  nation,
  subEmotion,
  tone,
  limit = 20,
  qOverride,
  pageToken,
  rich = false,
}) {
  if (!YT_KEY || YT_QUOTA_EXCEEDED) {
    throw new Error('YT_API disabled or quota exceeded');
  }

  const baseQuery = qOverride || buildYtQuery({ mood, genre, nation, subEmotion, tone });
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
// (3) 기본 미들웨어 & CORS
// ───────────────────────────────────────────────────────────────
app.use(express.json());       // JSON 본문 파싱
app.use(cookieParser());       // 쿠키 파싱

const allowedOrigins = [
  'http://localhost:5500',
  'http://127.0.0.1:5500',
  'http://localhost:3000',
  'http://localhost:5173',
];

// credentials:true → 쿠키 인증 허용. 프론트 세션 유지에 필요.
const corsOptions = {
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    if (allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error(`CORS blocked: ${origin}`), false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type'],
};
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// ───────────────────────────────────────────────────────────────
// (4) 유틸 함수
// ───────────────────────────────────────────────────────────────
function hashPassword(pw) {
  // 데모 단계: 단순 SHA-256. (실서비스는 salt/스트레칭/JWT 권장)
  return crypto.createHash('sha256').update(pw).digest('hex');
}

const getUser = (req) => {
  // user 쿠키를 username으로 사용 → DB에서 id/username/email 조회
  const username = req.cookies?.user || null;
  if (!username) return null;
  const row = db
    .prepare('SELECT id, username, email FROM users WHERE username = ?')
    .get(username);
  return row || null;
};

// 재생목록 상세 조회용 공용 쿼리(다수 API에서 재사용)
const playlistItemsStmt = db.prepare(`
  SELECT pi.track_id, t.title, t.artist, t.thumb, t.source
  FROM playlist_items pi
  JOIN tracks t ON t.id = pi.track_id
  WHERE pi.playlist_id = ?
  ORDER BY pi.position ASC
`);

// ───────────────────────────────────────────────────────────────
// (5) 인증 관련 API (회원가입 + 로그인 + 로그아웃 + 현재유저)
// ───────────────────────────────────────────────────────────────

// 회원가입: 중복체크 → 해시 저장 → 로그인 상태 쿠키 세팅
app.post('/api/signup', (req, res) => {
  try {
    const { username, password, email } = req.body || {};

    if (!username || !password) {
      return res.status(400).json({ error: 'username & password required' });
    }

    const exist = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (exist) {
      return res.status(409).json({ error: '이미 사용 중인 아이디입니다.' });
    }

    const password_hash = hashPassword(password);

    const r = db.prepare(`
      INSERT INTO users (username, password_hash, email)
      VALUES (?, ?, ?)
    `).run(username, password_hash, email || null);

    // 데모: httpOnly false. (실서비스에서는 true 권장)
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
    console.error('SIGNUP ERROR:', err);  // 콘솔에서 실제 에러 확인
    return res
      .status(500)
      .json({ error: String(err.message || err || 'internal error') });
  }
});


// 로그인: 사용자 조회 → 해시 비교 → 성공 시 쿠키 세팅
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

// 로그아웃: user 쿠키 제거
app.post('/api/logout', (req, res) => {
  res.clearCookie('user');
  res.json({ ok: true });
});

// 현재 로그인 유저: 프론트 auth.js는 문자열만 기대 → username만 반환
app.get('/api/me', (req, res) => {
  const u = getUser(req);
  res.json({ user: u ? u.username : null });
});

// ───────────────────────────────────────────────────────────────
// (6) 검색 & 추천
// ───────────────────────────────────────────────────────────────

// 검색: YouTube 우선(rich:false → pageToken 유지), 실패시 로컬 DB 폴백
app.get('/api/search', async (req, res) => {
  const qRaw      = (req.query.q      || '').toString();
  const mood      = (req.query.mood   || '').toString() || null;
  const genre     = (req.query.genre  || '').toString() || null;
  const nation    = (req.query.nation || '').toString() || null;
  const pageToken = (req.query.pageToken || '').toString() || null;

  // 감정 테스트에서 넘어오는 tone / sub 도 같이 받기(선택)
  const subEmotion = (req.query.sub   || '').toString() || null;
  const tone       = (req.query.tone  || '').toString() || null;

  // 1) YouTube 우선
  if (YT_KEY && !YT_QUOTA_EXCEEDED && (qRaw || mood || genre || nation || subEmotion || tone)) {
    try {
      const opts = {
        mood,
        genre,
        nation,
        subEmotion,
        tone,
        limit: 50,
        rich: false,          // 검색 탭은 항상 페이지네이션 모드
        pageToken,
      };

      if (qRaw) {
        // 검색어가 있을 때만 qOverride 사용
        opts.qOverride = qRaw;
      }

      const { items, nextPageToken } = await searchYouTubeTracks(opts);

      if (items && items.length) {
        return res.json({
          items,
          nextPageToken: nextPageToken || null,  // 그대로 프론트로
        });
      }
    } catch (e) {
      console.error('/api/search YouTube 실패, DB로 폴백:', e);
    }
  }

  // 2) DB 폴백 (간단 텍스트 포함여부 + mood 매칭)
  const q = qRaw.toLowerCase();
  const rows = db
    .prepare(`
      SELECT t.*, GROUP_CONCAT(tm.mood) AS moods
      FROM tracks t
      LEFT JOIN track_moods tm ON tm.track_id = t.id
      GROUP BY t.id
    `)
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

// 추천: 개인화 지표(최근경향/라벨/시청/스킵/아티스트/톤) + YouTube rich 검색 + DB 병합
app.get('/api/recs', async (req, res) => {
  const mood   = (req.query.mood   || '').toString() || null;  // 감정 테스트 결과 mood
  const genre  = (req.query.genre  || '').toString() || null;
  const nation = (req.query.nation || '').toString() || null;
  const sub    = (req.query.sub    || '').toString() || null;
  const tone   = (req.query.tone   || '').toString() || null;
  const user   = getUser(req);
  const uid    = user?.id;

  // 개인화 통계 컨테이너
  let trendMood = null;          // 최근 감정 경향 (1번 + 6번)
  let watchCountMap = {};        // 트랙별 시청 횟수 (2번)
  let ratingsMap = {};           // 트랙별 감정 평가 (2번)
  let skipMap = {};              // 스킵 패널티 (3번)
  let topArtist = null;          // 제일 많이 들은 아티스트 (5번)
  let similarArtistSet = new Set();

  if (uid) {
    // 최근 시청 40개 기준 mood / artist 통계
    const recent = db.prepare(`
      SELECT
        wh.track_id,
        tm.mood       AS track_mood,
        t.artist      AS artist
      FROM watch_history wh
      LEFT JOIN track_moods tm ON tm.track_id = wh.track_id
      LEFT JOIN tracks      t  ON t.id        = wh.track_id
      WHERE wh.user_id = ?
      ORDER BY wh.played_at DESC
      LIMIT 40
    `).all(uid);

    const moodCounts   = {};
    const artistCounts = {};

    for (const r of recent) {
      if (r.track_mood) {
        moodCounts[r.track_mood] = (moodCounts[r.track_mood] || 0) + 1;
      }
      if (r.artist) {
        artistCounts[r.artist] = (artistCounts[r.artist] || 0) + 1;
      }
      if (r.track_id) {
        watchCountMap[r.track_id] = (watchCountMap[r.track_id] || 0) + 1;
      }
    }

    // trendMood = 최근에 가장 많이 들은 감정 (최소 3회 이상일 때만 신뢰)
    let bestMood = null;
    let bestCnt  = 0;
    for (const [m, c] of Object.entries(moodCounts)) {
      if (c > bestCnt) {
        bestMood = m;
        bestCnt  = c;
      }
    }
    if (bestCnt >= 3) {
      trendMood = bestMood;
    }

    // topArtist = 가장 많이 들은 아티스트
    let bestArtist = null;
    let bestArtistCnt = 0;
    for (const [a, c] of Object.entries(artistCounts)) {
      if (c > bestArtistCnt) {
        bestArtist    = a;
        bestArtistCnt = c;
      }
    }
    topArtist = bestArtist || null;

    if (topArtist && SIMILAR_ARTISTS[topArtist]) {
      SIMILAR_ARTISTS[topArtist].forEach((name) => similarArtistSet.add(name));
    }

    // 사용자가 직접 남긴 감정 라벨
    db.prepare('SELECT track_id, mood FROM ratings WHERE user_id = ?')
      .all(uid)
      .forEach((r) => { ratingsMap[r.track_id] = r.mood; });

    // 스킵 기록(곡별 횟수)
    db.prepare(`
      SELECT track_id, COUNT(*) AS cnt
      FROM skips
      WHERE user_id = ?
      GROUP BY track_id
    `).all(uid).forEach((r) => {
      skipMap[r.track_id] = r.cnt;
    });
  }

  // 감정 테스트 결과(mood)와 최근 경향(trendMood) 중 우선 사용
  const effectiveMood = mood || trendMood || null;

  // 1) 유튜브 후보 (rich:true → 부족하면 폴백 질의 적극 시도)
  let ytItems = [];
  if (YT_KEY && !YT_QUOTA_EXCEEDED) {
    try {
      const { items } = await searchYouTubeTracks({
        mood: effectiveMood,
        genre,
        nation,
        subEmotion: sub,
        tone,
        limit: 20,
        rich: true,
      });
      ytItems = items || [];
    } catch (e) {
      console.error('/api/recs YouTube 실패, DB로 폴백 준비:', e);
    }
  }

  // 2) DB 후보 + 개인화 점수 함수
  const rows = db.prepare(`
    SELECT t.*, GROUP_CONCAT(tm.mood) AS moods
    FROM tracks t
    LEFT JOIN track_moods tm ON tm.track_id = t.id
    GROUP BY t.id
  `).all();

  const score = (t) => {
    const moods = (t.moods || '').split(',').filter(Boolean);
    let s = 0;

    // (6) 설문 mood
    if (mood && moods.includes(mood)) s += 2;

    // (1 + 6) 최근 청취 경향 trendMood
    if (trendMood && moods.includes(trendMood)) s += 1.5;

    // (tone) 설문에서 선택한 음악 분위기 가중치
    if (tone) {
      if (tone === 'boost')   { if (moods.includes('happy')) s += 1.0; if (moods.includes('energetic')) s += 1.0; }
      else if (tone === 'soothe') { if (moods.includes('sad')) s += 1.0; if (moods.includes('calm')) s += 1.0; }
      else if (tone === 'energy') { if (moods.includes('energetic')) s += 1.5; if (moods.includes('happy')) s += 0.5; }
      else if (tone === 'breeze') { if (moods.includes('calm')) s += 0.8; if (moods.includes('happy')) s += 0.4; }
      else if (tone === 'focus')  { if (moods.includes('calm')) s += 1.2; }
    }

    // (2) 내가 라벨한 경험 + 일치 보너스
    if (ratingsMap[t.id]) {
      s += 1;
      if (mood && ratingsMap[t.id] === mood) s += 2;
    }

    // (2) 시청횟수 보너스(최대 +2)
    const wc = watchCountMap[t.id] || 0;
    if (wc > 0) {
      s += Math.min(2, 0.5 * wc);
    }

    // (5) 아티스트 기반 가산점
    if (topArtist && t.artist === topArtist) {
      s += 1.5; // 최애 아티스트
    }
    if (similarArtistSet.size && similarArtistSet.has(t.artist)) {
      s += 1;   // 비슷한 아티스트
    }

    // (3) 스킵 패널티 – 많이 스킵한 곡이면 점수 깎기 (최대 -3)
    const sc = skipMap[t.id] || 0;
    if (sc > 0) {
      s -= Math.min(3, sc * 1.5);
    }

    // 기존 품질 보정: official / mv / audio 키워드 약간 플러스
    if (/official|mv|audio/i.test(t.original_title || t.originalTitle || '')) {
      s += 0.5;
    }

    return s;
  };

  const sortedDb = rows.sort((a, b) => score(b) - score(a));

  // 3) YouTube + DB 결과 병합
  const MIN_RECS = 15;

  // 유튜브 결과가 충분하면 그대로
  if (ytItems.length >= MIN_RECS) {
    return res.json({ items: ytItems });
  }

  // 부족하면 DB로 채워 20개까지
  let merged = [...ytItems];
  const seen = new Set(ytItems.map((t) => String(t.id)));

  for (const t of sortedDb) {
    if (merged.length >= 20) break;
    if (seen.has(String(t.id))) continue;
    merged.push(t);
    seen.add(String(t.id));
  }

  if (merged.length) {
    return res.json({ items: merged });
  }

  // 정말 없으면 DB TOP 20
  return res.json({ items: sortedDb.slice(0, 20) });
});

// ───────────────────────────────────────────────────────────────
// (7) 감정 라벨 & 시청 & 스킵 기록
// ───────────────────────────────────────────────────────────────
app.post('/api/ratings', (req, res) => {
  const user = getUser(req);
  const { trackId, mood } = req.body || {};
  if (!trackId || !mood)
    return res.status(400).json({ error: 'trackId & mood required' });

  if (!user) {
    // 비로그인도 UX는 동일하게 ok 처리(추천에는 반영되지 않음)
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


app.post('/api/skip', (req, res) => {
  const user = getUser(req);
  const { trackId, seconds } = req.body || {};
  if (!trackId) return res.status(400).json({ error: 'trackId required' });

  // 비로그인 유저는 그냥 무시(익명)
  if (!user) {
    return res.json({ ok: true, anonymous: true });
  }

  const sec = Math.max(0, Math.round(Number(seconds) || 0));

  db.prepare(`
    INSERT INTO skips (user_id, track_id, seconds, created_at)
    VALUES (?, ?, ?, strftime('%s','now'))
  `).run(user.id, trackId, sec);

  res.json({ ok: true });
});

// ───────────────────────────────────────────────────────────────
// (8) 재생목록 + 좋아요
// ───────────────────────────────────────────────────────────────

// 내 재생목록 목록(좋아요 수/내가 좋아요 눌렀는지 포함, 각 목록의 아이템까지 포함)
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

// 재생목록 생성(테마색 옵션 포함)
app.post('/api/playlists', (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: 'login required' });

  const { title, isPublic, themeColor } = req.body || {};
  if (!title) return res.status(400).json({ error: 'title required' });

  const r = db
    .prepare(
      `
      INSERT INTO playlists (user_id, title, is_public, theme_color, created_at)
      VALUES (?, ?, ?, ?, strftime('%s','now'))
    `,
    )
    .run(user.id, title, isPublic ? 1 : 0, themeColor || '#22d3ee');

  res.json({ ok: true, id: r.lastInsertRowid });
});


// 재생목록에 트랙 추가(중복 무시)
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

// 재생목록 삭제(소유자 확인 + 연관 레코드 정리)
app.delete('/api/playlists/:id', (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: 'login required' });

  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid id' });

  // 내가 만든 재생목록인지 확인
  const pl = db
    .prepare('SELECT id, user_id FROM playlists WHERE id = ?')
    .get(id);

  if (!pl) {
    return res.status(404).json({ error: 'not found' });
  }
  if (pl.user_id !== user.id) {
    return res.status(403).json({ error: 'forbidden' });
  }

  // 트랜잭션으로 items/likes → playlists 순으로 삭제
  const tx = db.transaction((playlistId) => {
    db.prepare('DELETE FROM playlist_items WHERE playlist_id = ?').run(playlistId);
    db.prepare('DELETE FROM playlist_likes WHERE playlist_id = ?').run(playlistId);
    db.prepare('DELETE FROM playlists WHERE id = ?').run(playlistId);
  });

  try {
    tx(id);
    return res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/playlists/:id ERROR', err);
    return res.status(500).json({ error: 'internal error' });
  }
});

// 재생목록 테마 색 변경(HEX #RRGGBB)
app.patch('/api/playlists/:id/theme', (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: 'login required' });

  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid id' });

  const pl = db
    .prepare('SELECT id, user_id FROM playlists WHERE id = ?')
    .get(id);

  if (!pl) return res.status(404).json({ error: 'not found' });
  if (pl.user_id !== user.id) {
    return res.status(403).json({ error: 'forbidden' });
  }

  let { themeColor } = req.body || {};
  if (typeof themeColor !== 'string' || !themeColor.trim()) {
    return res.status(400).json({ error: 'themeColor required' });
  }
  themeColor = themeColor.trim();

  // 간단 HEX 검증
  if (!/^#[0-9a-fA-F]{6}$/.test(themeColor)) {
    return res.status(400).json({ error: 'invalid color' });
  }

  db.prepare(
    `UPDATE playlists SET theme_color = ? WHERE id = ?`
  ).run(themeColor, id);

  return res.json({ ok: true, themeColor });
});


// 공개 재생목록 피드(최근/인기)
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
        p.theme_color,
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

// 특정 재생목록 상세(소유자 이름/좋아요 수 포함)
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


// ───────────────────────────────────────────────────────────────
// (9) 헬스체크 & 에러 핸들러 & 서버 시작
// ───────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true }));

app.use((err, _req, res, _next) => {
  console.error(err?.stack || err?.message || err);
  res
    .status(500)
    .json({ error: String(err?.message || err || 'internal error') });
});

const PORT = 3001;
app.listen(PORT, () => {
  console.log(`Emotion Playlist API running at http://localhost:${PORT}`);
});
