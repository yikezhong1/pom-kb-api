/**
 * POM 知识库 — Vercel Serverless Function: /api/customers
 *
 * GET  /api/customers — 读取客户档案
 * POST /api/customers — 客户档案操作（body: { action: 'add'|'delete'|'update', record/index }）
 *
 * 环境变量同 stats.js
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
    /* ===== GET /api/customers — 读取 ===== */
    if (req.method === 'GET') {
      const data = await ghGet('customers.json');
      const customers = (data && data.content) || { records: [] };
      return res.status(200).json(customers);
    }

    /* ===== POST /api/customers — 增/删/改 ===== */
    if (req.method === 'POST') {
      const body = req.body || {};
      const action = body.action || 'add';

      if (!['add', 'delete', 'update'].includes(action)) {
        return res.status(400).json({ error: 'Invalid action' });
      }

      const existing = await ghGet('customers.json');
      const customers = (existing && existing.content) || { records: [] };
      if (!customers.records) customers.records = [];

      if (action === 'add') {
        if (!body.record || !body.record.customerName) {
          return res.status(400).json({ error: 'Missing customerName' });
        }
        if (JSON.stringify(body.record).length > 10000) {
          return res.status(400).json({ error: 'Record too large' });
        }
        customers.records.push(body.record);
      } else if (action === 'delete') {
        if (typeof body.index !== 'number' || body.index < 0) {
          return res.status(400).json({ error: 'Invalid index' });
        }
        if (customers.records[body.index]) {
          customers.records[body.index].deleted = true;
        }
      } else if (action === 'update') {
        if (typeof body.index !== 'number' || body.index < 0 || !body.record) {
          return res.status(400).json({ error: 'Invalid index or record' });
        }
        if (customers.records[body.index]) {
          const wasDeleted = customers.records[body.index].deleted;
          customers.records[body.index] = { ...body.record, deleted: wasDeleted };
        }
      }

      await ghPut('customers.json', customers, existing ? existing.sha : null, `customers: ${action}`);
      return res.status(200).json({ ok: true, records: customers.records });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
