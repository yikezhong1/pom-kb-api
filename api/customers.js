/**
 * POM 知识库 — Aliyun FC Function: /api/customers
 *
 * GET  /customers — 读取客户档案
 * POST /customers — 客户档案操作（body: { action: 'add'|'delete'|'update', record/index }）
 *
 * P0-2 加固（2026-08-12）：
 *   1. 令牌校验：所有请求必须带 Authorization: Bearer <API_TOKEN>，否则 401；
 *   2. CORS 限制：仅放行知识库站点域名与本地服务，禁 '*'；
 *   3. 限流：按客户端 IP 记忆计数（FC 多实例下为尽力而为），读 60/分钟、写 30/分钟，超了 429；
 *   4. 客户数据落库改为私有备份仓库（CUSTOMERS_REPO），不再写公开仓库，消除 P0-1 复露。
 */

const API_TOKEN = () => process.env.API_TOKEN || '';
const ALLOWED_ORIGINS = ['https://yikezhong1.github.io', 'http://localhost:8899'];
const CUSTOMERS_REPO = () => process.env.CUSTOMERS_REPO || 'yikezhong1/pom-knowledge-base-backup';

const GH_BASE = () => `https://api.github.com/repos/${CUSTOMERS_REPO()}/contents`;
const GH_HEADERS = () => ({
  'Authorization': `token ${process.env.GITHUB_TOKEN}`,
  'User-Agent': 'pom-kb-api',
  'Content-Type': 'application/json',
  'Accept': 'application/vnd.github.v3+json',
});

// 简单限流：按客户端 IP 记忆计数（FC 多实例/冷启动下非全局，仅抬高滥用门槛）
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

  if (!process.env.GITHUB_TOKEN || !process.env.CUSTOMERS_REPO) {
    return res.status(500).json({ error: 'Server not configured' });
  }

  const ip = clientIp(req);
  const kind = req.method === 'GET' ? 'read' : 'write';
  if (rateLimited(ip, kind)) {
    return res.status(429).json({ error: 'Too many requests' });
  }

  try {
    /* ===== GET /customers — 读取 ===== */
    if (req.method === 'GET') {
      const data = await ghGet('customers.json');
      const customers = (data && data.content) || { records: [] };
      return res.status(200).json(customers);
    }

    /* ===== POST /customers — 增/删/改 ===== */
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
