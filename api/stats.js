/**
 * POM 知识库 — Vercel Serverless Function: /api/stats
 *
 * GET  /api/stats?days=7  — 读取最近 N 天访问统计
 * POST /api/stats         — 写入一条访问记录（body: { visit: {...} }）
 *
 * 环境变量（Vercel Dashboard → Settings → Environment Variables）：
 *   GITHUB_TOKEN — fine-grained PAT
 *   GITHUB_REPO  — 如 yikezhong1/pom-knowledge-base
 */

const GH_BASE = () => `https://api.github.com/repos/${process.env.GITHUB_REPO}/contents`;
const GH_HEADERS = () => ({
  'Authorization': `token ${process.env.GITHUB_TOKEN}`,
  'User-Agent': 'pom-vercel',
  'Content-Type': 'application/json',
  'Accept': 'application/vnd.github.v3+json',
});

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
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

export default async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (!process.env.GITHUB_TOKEN || !process.env.GITHUB_REPO) {
    return res.status(500).json({ error: 'Server not configured' });
  }

  try {
    /* ===== POST /api/stats — 写入统计 ===== */
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

    /* ===== GET /api/stats?days=N — 读取统计 ===== */
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
