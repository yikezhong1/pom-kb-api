/**
 * POM 知识库 — Aliyun FC Function: /api/stats
 *
 * GET  /stats?days=7  — 读取最近 N 天访问统计
 * POST /stats         — 写入一条访问记录（body: { visit: {...} }）
 *
 * P0-2 加固（2026-08-12）：
 *   1. 令牌校验：所有请求必须带 Authorization: Bearer <API_TOKEN>，否则 401；
 *   2. CORS 限制：仅放行知识库站点域名与本地服务，禁 '*'；
 *   3. 限流：按客户端 IP 记忆计数，写 30/分钟、读 60/分钟，超了 429。
 *   （统计落库仍为公开仓库 GITHUB_REPO，访客统计本就是公开展示用途；仅锁写接口防刷。）
 */

const API_TOKEN = () => process.env.API_TOKEN || '';
const ALLOWED_ORIGINS = ['https://yikezhong1.github.io', 'http://localhost:8899'];

const GH_BASE = () => `https://api.github.com/repos/${process.env.GITHUB_REPO}/contents`;
const GH_HEADERS = () => ({
  'Authorization': `token ${process.env.GITHUB_TOKEN}`,
  'User-Agent': 'pom-kb-api',
  'Content-Type': 'application/json',
  'Accept': 'application/vnd.github.v3+json',
});

const RATE = { read: 60, write: 30, windowMs: 60000 };
const hits = new Map();
function rateLimited(ip, kind) {
  const now = Date.now();
  const key = ip + ':' + kind;
  const rec = hits.get(key);
  if (!rec || now - rec.t > RATE.windowMs) { hits.set(key, { t: now, n: 1 }); return false; }
  rec.n++;
  if (rec.n > RATE[kind]) return true;
  return false;
}

function setCors(res, req) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function checkAuth(req, res) {
  const auth = req.headers.authorization || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m || m[1] !== API_TOKEN()) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

async function ghGet(filePath) {
  const res = await fetch(`${GH_BASE()}/${filePath}`, { headers: GH_HEADERS() });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET ${filePath} failed: ${res.status}`);
  const data = await res.json();
  let parsed = null;
  if (data.content) {
    try { parsed = JSON.parse(Buffer.from(data.content, 'base64').toString()); } catch (e) { parsed = null; }
  }
  return { content: parsed, sha: data.sha };
}

async function ghPut(filePath, obj, sha, message) {
  const content = Buffer.from(JSON.stringify(obj)).toString('base64');
  const body = { message, content };
  if (sha) body.sha = sha;
  const res = await fetch(`${GH_BASE()}/${filePath}`, {
    method: 'PUT',
    headers: GH_HEADERS(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PUT ${filePath} failed: ${res.status} ${text}`);
  }
  return res.json();
}

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'] || '';
  const first = xff.split(',')[0].trim();
  return first || req.connection.remoteAddress || 'unknown';
}

export default async function handler(req, res) {
  setCors(res, req);

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (!checkAuth(req, res)) return;

  if (!process.env.GITHUB_TOKEN || !process.env.GITHUB_REPO) {
    return res.status(500).json({ error: 'Server not configured' });
  }

  const ip = clientIp(req);
  const kind = req.method === 'GET' ? 'read' : 'write';
  if (rateLimited(ip, kind)) {
    return res.status(429).json({ error: 'Too many requests' });
  }

  try {
    /* ===== POST /stats — 写入统计 ===== */
    if (req.method === 'POST') {
      const { visit } = req.body || {};
      if (!visit || !visit.time) return res.status(400).json({ error: 'Missing visit data' });
      if (!/^\d{4}-\d{2}-\d{2}/.test(visit.time)) return res.status(400).json({ error: 'Invalid time format' });

      const visitStr = JSON.stringify(visit);
      if (visitStr.length > 2000) return res.status(400).json({ error: 'Visit data too large' });

      const date = visit.time.slice(0, 10);
      const filePath = `stats/${date}.json`;

      const existing = await ghGet(filePath);
      const visits = (existing && existing.content) || [];
      visits.push(visit);

      await ghPut(filePath, visits, existing ? existing.sha : null, `stats: ${date}`);
      return res.status(200).json({ ok: true });
    }

    /* ===== GET /stats?days=N — 读取统计 ===== */
    if (req.method === 'GET') {
      const days = Math.min(parseInt(req.query.days || '7', 10), 30);
      const results = [];

      for (let i = 0; i < days; i++) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const dateStr = d.getFullYear() + '-' +
          String(d.getMonth() + 1).padStart(2, '0') + '-' +
          String(d.getDate()).padStart(2, '0');
        const filePath = `stats/${dateStr}.json`;

        const data = await ghGet(filePath);
        results.push({ date: dateStr, visits: (data && data.content) || [] });
      }

      return res.status(200).json({ results });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
