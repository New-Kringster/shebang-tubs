// notes app: a tiny Supabase-shaped gateway. Forwards /auth/v1/* to GoTrue
// and /rest/v1/* to PostgREST, and stores uploads under FILES_DIR.
import http from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const { PORT = '3000', AUTH_URL, REST_URL, ANON_KEY, FILES_DIR = '/data/files' } = process.env;

async function forward(req, res, base, prefix) {
  const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await readBody(req);
  const headers = { 'content-type': req.headers['content-type'] ?? 'application/json' };
  headers.authorization = req.headers.authorization ?? `Bearer ${ANON_KEY}`;
  if (req.headers.prefer) headers.prefer = req.headers.prefer;
  const upstream = await fetch(base + req.url.slice(prefix.length), { method: req.method, headers, body });
  res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'text/plain' });
  res.end(Buffer.from(await upstream.arrayBuffer()));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

http
  .createServer(async (req, res) => {
    try {
      if (req.url === '/health') return res.end('ok');
      if (req.url.startsWith('/auth/v1')) return await forward(req, res, AUTH_URL, '/auth/v1');
      if (req.url.startsWith('/rest/v1')) return await forward(req, res, REST_URL, '/rest/v1');
      const file = req.url.match(/^\/files\/([\w.-]+)$/);
      if (file) {
        const p = path.join(FILES_DIR, file[1]);
        if (req.method === 'PUT') {
          await mkdir(FILES_DIR, { recursive: true });
          await writeFile(p, await readBody(req));
          return res.end('stored');
        }
        return res.end(await readFile(p));
      }
      res.writeHead(404).end('not found');
    } catch (err) {
      res.writeHead(err.code === 'ENOENT' ? 404 : 502).end(String(err.message));
    }
  })
  .listen(Number(PORT), () => console.log(`notes app on :${PORT}`));
