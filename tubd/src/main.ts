// tubd entry point. Configured by environment:
//   TUBD_DIR           root folder (required, absolute; same path inside and outside the container)
//   TUBD_PORT          API port (default 7070)
//   TUBD_HOST_ADDRESS  host name used in tub URLs (default localhost)
//   TUBD_PORT_RANGE    host ports handed to tubs (default 20000-20999)
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { createHandler } from './api.ts';
import { TubStore } from './store.ts';

const dir = process.env.TUBD_DIR;
if (!dir || !path.isAbsolute(dir)) {
  console.error('TUBD_DIR must be set to an absolute path');
  process.exit(1);
}
const [lo, hi] = (process.env.TUBD_PORT_RANGE ?? '20000-20999').split('-').map(Number);
if (!(lo > 0 && hi >= lo && hi < 65536)) {
  console.error('TUBD_PORT_RANGE must look like 20000-20999');
  process.exit(1);
}

const store = new TubStore({ dir, hostAddress: process.env.TUBD_HOST_ADDRESS ?? 'localhost', portRange: [lo, hi] });
await store.init();
const apiKey = await loadOrCreateKey(path.join(store.stateDir, 'api-key'));

const port = Number(process.env.TUBD_PORT ?? 7070);
http.createServer(createHandler(store, apiKey)).listen(port, () => {
  console.log(`tubd listening on :${port}; tubs in ${store.tubsDir}; API key in ${path.join(store.stateDir, 'api-key')}`);
});

/** The instance API key: created on first start, readable only by its owner. */
async function loadOrCreateKey(file: string): Promise<string> {
  try {
    return (await readFile(file, 'utf8')).trim();
  } catch {
    const key = `tubd_${randomBytes(32).toString('base64url')}`;
    await writeFile(file, key + '\n', { mode: 0o600 });
    // The file is root-owned when tubd runs in Docker, so show the key once here.
    console.log(`created API key (shown once; also in ${file}): ${key}`);
    return key;
  }
}
