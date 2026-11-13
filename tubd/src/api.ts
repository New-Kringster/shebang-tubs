// tubd's HTTP API. Every route except /health needs the instance API key.
//
//   GET    /v1/tubs                     list tubs with service states
//   GET    /v1/tubs/:name               one tub
//   PUT    /v1/tubs/:name               deploy a tub zip (body); header x-tub-passphrase if encrypted
//   POST   /v1/tubs/:name/start|stop
//   POST   /v1/tubs/:name/export        JSON {offline?, passphrase?} -> the zip
//   GET    /v1/tubs/:name/logs?service=&tail=
//   DELETE /v1/tubs/:name?confirm=:name deletes the tub and its data
import { createHash, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { PassphraseError, tempDir } from './archive.ts';
import { TubError, type TubStore } from './store.ts';

const MAX_UPLOAD = 4 * 1024 ** 3;

export function createHandler(store: TubStore, apiKey: string) {
  const keyHash = sha256(apiKey);

  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://tubd');
    try {
      if (url.pathname === '/health') return send(res, 200, { ok: true });
      if (!authorized(req, keyHash)) return send(res, 401, { error: 'unauthorized' });

      if (url.pathname === '/v1/tubs' && req.method === 'GET') return send(res, 200, await store.list());

      const m = /^\/v1\/tubs\/([^/]+)(?:\/(start|stop|export|logs))?$/.exec(url.pathname);
      if (!m) return send(res, 404, { error: 'not_found' });
      const [, name, action] = m;

      if (!action && req.method === 'GET') return send(res, 200, await store.get(name));
      if (!action && req.method === 'PUT') {
        const dir = await tempDir('tubd-upload-');
        try {
          const zip = path.join(dir, 'upload.zip');
          await receive(req, zip);
          const pass = header(req, 'x-tub-passphrase');
          return send(res, 200, await store.deploy(name, zip, pass));
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      }
      if (!action && req.method === 'DELETE') {
        if (url.searchParams.get('confirm') !== name) {
          return send(res, 400, { error: 'confirm_required', message: `add ?confirm=${name} to delete this tub and all its data` });
        }
        await store.remove(name);
        return send(res, 200, { removed: name });
      }
      if (action === 'start' && req.method === 'POST') return send(res, 200, (await store.start(name), { started: name }));
      if (action === 'stop' && req.method === 'POST') return send(res, 200, (await store.stop(name), { stopped: name }));
      if (action === 'logs' && req.method === 'GET') {
        const tail = Math.min(Number(url.searchParams.get('tail') ?? 200) || 200, 5000);
        const text = await store.logs(name, url.searchParams.get('service') ?? undefined, tail);
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end(text);
      }
      if (action === 'export' && req.method === 'POST') {
        const body = (await readJson(req)) as { offline?: boolean; passphrase?: string };
        const file = await store.export(name, { offline: body.offline === true, passphrase: body.passphrase || undefined });
        try {
          res.writeHead(200, {
            'content-type': 'application/zip',
            'content-disposition': `attachment; filename="${name}.tub.zip"`,
          });
          await pipeline(createReadStream(file), res);
        } finally {
          await rm(file, { force: true });
        }
        return;
      }
      return send(res, 405, { error: 'method_not_allowed' });
    } catch (err) {
      if (res.headersSent) return res.destroy(err as Error);
      if (err instanceof TubError) return send(res, err.status, { error: err.message, issues: err.issues });
      if (err instanceof PassphraseError) return send(res, 400, { error: err.message });
      console.error(err);
      return send(res, 500, { error: (err as Error).message });
    }
  };
}

function sha256(s: string): Buffer {
  return createHash('sha256').update(s).digest();
}

function authorized(req: IncomingMessage, keyHash: Buffer): boolean {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
  return !!m && timingSafeEqual(sha256(m[1]), keyHash);
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v || undefined;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body) + '\n');
}

async function receive(req: IncomingMessage, file: string): Promise<void> {
  let size = 0;
  req.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > MAX_UPLOAD) req.destroy(new TubError(413, 'upload too large'));
  });
  await pipeline(req, createWriteStream(file));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 64 * 1024) throw new TubError(413, 'body too large');
  }
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new TubError(400, 'body must be JSON');
  }
}
