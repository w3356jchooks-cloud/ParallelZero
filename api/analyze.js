const { randomUUID } = require('crypto');
const DEPTHS = [38, 38, 37, 37, 37, 37];
const MAX_DAILY_CALLS = 200;
const MAX_DAILY_USED = 198;
const ENGINE_URL = 'https://api.chessdrive.io/v1/engine';

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}
function utcDayKey(now = new Date()) { return now.toISOString().slice(0, 10); }
function scheduleStatus(now = new Date()) {
  const minuteOfDay = now.getUTCHours() * 60 + now.getUTCMinutes();
  return { paused: minuteOfDay >= 710 || minuteOfDay < 5 };
}
function validFen(fen) {
  if (typeof fen !== 'string' || fen.length > 120) return false;
  const fields = fen.trim().split(/\s+/);
  return fields.length === 6 &&
    /^[rnbqkpRNBQKP1-8/]+$/.test(fields[0]) && /^[wb]$/.test(fields[1]) &&
    /^(-|[KQkq]+)$/.test(fields[2]) && /^(-|[a-h][36])$/.test(fields[3]) &&
    /^\d+$/.test(fields[4]) && /^\d+$/.test(fields[5]);
}
function redisConfig() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url: url.replace(/\/$/, ''), token } : null;
}
async function redisCommand(command) {
  const config = redisConfig();
  if (!config) throw new Error('Persistent usage storage is not configured.');
  const response = await fetch(config.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command)
  });
  if (!response.ok) throw new Error(`Usage storage returned HTTP ${response.status}.`);
  const payload = await response.json();
  if (payload.error) throw new Error(payload.error);
  return payload.result;
}
async function getUsage(dayKey) {
  return Number((await redisCommand(['GET', `parallelzero:daily-calls:${dayKey}`])) || 0);
}
async function acquireBatchLock() {
  const lock = { key: 'parallelzero:global-batch-lock', token: randomUUID() };
  const result = await redisCommand(['SET', lock.key, lock.token, 'NX', 'EX', '75']);
  return result === 'OK' ? lock : null;
}
async function releasePositionLock(lock) {
  if (!lock) return;
  const script = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end";
  await redisCommand(['EVAL', script, '1', lock.key, lock.token]);
}
async function reserveBatchLimits(dayKey, now) {
  const dailyKey = `parallelzero:daily-calls:${dayKey}`;
  const minuteKey = `parallelzero:minute-calls:${now.toISOString().slice(0, 16)}`;
  const ttl = Math.max(60, Math.ceil((Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1
  ) - now.getTime()) / 1000) + 86400);
  const lua = [
    "local used = tonumber(redis.call('GET', KEYS[1]) or '0')",
    "local dailyCap = tonumber(ARGV[1])",
    "if used + 6 > dailyCap then return {-1, used, 0} end",
    "local nowMs = tonumber(ARGV[2])",
    "redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', nowMs - 60000)",
    "local recent = tonumber(redis.call('ZCARD', KEYS[2]))",
    "if recent + 6 > tonumber(ARGV[3]) then return {-2, used, recent} end",
    "local nextUsed = used + 6",
    "redis.call('SET', KEYS[1], nextUsed, 'EX', ARGV[4])",
    "for i = 1, 6 do redis.call('ZADD', KEYS[2], nowMs, ARGV[5] .. ':' .. i) end",
    "redis.call('EXPIRE', KEYS[2], 120)",
    "return {nextUsed, recent + 6, 0}"
  ].join('\n');
  const result = await redisCommand([
    'EVAL', lua, '2', dailyKey, minuteKey,
    String(MAX_DAILY_USED), String(now.getTime()), '20', String(ttl), randomUUID()
  ]);
  return { code: Number(result[0]), used: Number(result[1] || 0), recent: Number(result[2] || 0) };
}
function scoreForTurn(line, turn) {
  if (typeof line.mate === 'number') {
    const mate = turn === 'w' ? line.mate : -line.mate;
    if (mate > 0) return 100000 - Math.min(999, Math.abs(mate)) * 100;
    if (mate < 0) return -100000 + Math.min(999, Math.abs(mate)) * 100;
    return 0;
  }
  if (typeof line.cp === 'number') return turn === 'w' ? line.cp : -line.cp;
  return Number.NEGATIVE_INFINITY;
}
function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  if (!sorted.length) return Number.NEGATIVE_INFINITY;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
function labelScore(candidate) {
  if (candidate.mate !== null) {
    const mate = candidate.turn === 'w' ? candidate.mate : -candidate.mate;
    return mate > 0 ? `Mate in ${Math.abs(mate)}` : `Being mated in ${Math.abs(mate)}`;
  }
  if (candidate.cp !== null) {
    const cp = candidate.turn === 'w' ? candidate.cp : -candidate.cp;
    return `Evaluation ${cp >= 0 ? '+' : ''}${(cp / 100).toFixed(2)}`;
  }
  return 'Evaluation unavailable';
}
async function callCalculator(fen, depth, index, turn) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 65000);
  try {
    const response = await fetch(ENGINE_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.CHESSDRIVE_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ engine: 'stockfish', position: { fen }, depth, lines: 5 }),
      signal: controller.signal
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || payload.message || `ChessDrive HTTP ${response.status}`);
    const lines = Array.isArray(payload.lines) ? payload.lines : [];
    const topLine = lines.find(line => line.rank === 1) || lines[0] || {};
    const best = payload.best_move || {};
    const firstMove = Array.isArray(topLine.moves) ? topLine.moves[0] : null;
    const uci = (firstMove && firstMove.uci) || best.uci;
    const match = typeof uci === 'string' && uci.match(/^([a-h][1-8])([a-h][1-8])([qrbn])?$/);
    if (!match) throw new Error(`Calculator ${index + 1} returned no usable top move.`);
    const candidate = {
      calculator: index + 1, depth: Number(topLine.depth || payload.depth || depth),
      uci, from: match[1], to: match[2], promotion: match[3] || 'q',
      san: (firstMove && firstMove.san) || best.san || uci,
      cp: typeof topLine.cp === 'number' ? topLine.cp : null,
      mate: typeof topLine.mate === 'number' ? topLine.mate : null,
      wdl: topLine.wdl || null, turn
    };
    candidate.sideScore = scoreForTurn(candidate, turn);
    return candidate;
  } finally { clearTimeout(timeout); }
}
function chooseOverallWinner(candidates) {
  const groups = new Map();
  for (const candidate of candidates) {
    if (!groups.has(candidate.uci)) groups.set(candidate.uci, []);
    groups.get(candidate.uci).push(candidate);
  }
  const ranked = Array.from(groups.entries()).map(([uci, votes]) => ({
    uci, votes, voteCount: votes.length,
    score: median(votes.map(v => v.sideScore)),
    maxDepth: Math.max(...votes.map(v => v.depth)),
    firstCalculator: Math.min(...votes.map(v => v.calculator))
  }));
  ranked.sort((a, b) => b.score - a.score || b.voteCount - a.voteCount ||
    b.maxDepth - a.maxDepth || a.firstCalculator - b.firstCalculator || a.uci.localeCompare(b.uci));
  return ranked[0];
}

module.exports = async function handler(req, res) {
  if (req.method === 'GET') {
    const schedule = scheduleStatus();
    if (!process.env.CHESSDRIVE_API_KEY || !redisConfig()) {
      return json(res, 200, { available: false, configMissing: true, paused: schedule.paused });
    }
    try {
      const used = await getUsage(utcDayKey());
      return json(res, 200, {
        available: !schedule.paused && used < MAX_DAILY_USED, paused: schedule.paused,
        usedCalls: used, remainingCalls: Math.max(0, MAX_DAILY_CALLS - used),
        analysesRemaining: Math.floor(Math.max(0, MAX_DAILY_USED - used) / 6),
        dailyCallBudget: MAX_DAILY_CALLS, reservedCalls: 2
      });
    } catch (error) { return json(res, 503, { available: false, error: error.message }); }
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return json(res, 405, { error: 'Method not allowed.' });
  }
  if (!process.env.CHESSDRIVE_API_KEY) return json(res, 503, { error: 'ChessDrive API key is not configured on the backend.' });
  if (!redisConfig()) return json(res, 503, { error: 'Persistent daily usage storage is not configured. Add the Upstash Redis environment variables before analyzing.' });
  if (scheduleStatus().paused) return json(res, 503, { error: 'ParallelZero is in its scheduled global pause. It reopens at 00:05 UTC.' });

  const fen = req.body && req.body.fen;
  if (!validFen(fen)) return json(res, 400, { error: 'A valid six-field FEN position is required.' });
  const turn = fen.trim().split(/\s+/)[1];
  const dayKey = utcDayKey();
  let lock = null;
  let used;
  let dailyLimitReached = false;
  try {
    lock = await acquireBatchLock();
    if (!lock) return json(res, 429, { error: 'All six calculator slots are busy analyzing another position. Please wait for that batch to finish.' });
    const reservation = await reserveBatchLimits(dayKey, new Date());
    used = reservation.used;
    dailyLimitReached = reservation.code === -1;
    if (reservation.code === -2) {
      await releasePositionLock(lock).catch(() => {});
      return json(res, 429, { error: 'ChessDrive free-plan limit: ParallelZero is keeping within 20 requests per rolling minute. Please wait before retrying.' });
    }
  } catch (error) {
    await releasePositionLock(lock).catch(() => {});
    return json(res, 503, { error: `Could not reserve API usage safely: ${error.message}` });
  }
  if (dailyLimitReached) {
    await releasePositionLock(lock).catch(() => {});
    const currentUsed = await getUsage(dayKey).catch(() => MAX_DAILY_USED);
    return json(res, 429, {
      error: 'Daily analysis budget reached. ParallelZero stops with its final two API calls reserved.',
      remainingCalls: Math.max(0, MAX_DAILY_CALLS - currentUsed)
    });
  }

  let settled;
  try {
    settled = await Promise.allSettled(DEPTHS.map((depth, index) => callCalculator(fen, depth, index, turn)));
  } finally {
    await releasePositionLock(lock).catch(() => {});
  }
  const failures = settled.map((result, index) => result.status === 'rejected'
    ? { calculator: index + 1, error: result.reason && result.reason.message ? result.reason.message : 'Unknown API error' }
    : null).filter(Boolean);
  if (failures.length) return json(res, 502, {
    error: `The six-calculator batch was incomplete (${6 - failures.length}/6 succeeded). No move was played.`,
    failures, usedCalls: used
  });

  const candidates = settled.map(result => result.value);
  const winner = chooseOverallWinner(candidates);
  const selected = winner.votes[0];
  return json(res, 200, {
    move: { uci: selected.uci, from: selected.from, to: selected.to, promotion: selected.promotion, san: selected.san },
    selection: {
      scoreLabel: labelScore(selected), votes: winner.voteCount, comparedMoves: candidates.length,
      method: 'Median side-to-move evaluation; then vote count, depth, and stable tie-breaks.',
      candidateGroups: new Set(candidates.map(c => c.uci)).size
    },
    calculators: candidates.map(({ calculator, depth, uci, san, cp, mate, wdl }) =>
      ({ calculator, depth, uci, san, cp, mate, wdl })),
    usage: { usedCalls: used, remainingCalls: Math.max(0, MAX_DAILY_CALLS - used),
      analysesRemaining: Math.floor(Math.max(0, MAX_DAILY_USED - used) / 6) }
  });
};
