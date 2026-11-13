#!/usr/bin/env node
// Creates a fresh notes tub's secrets: .env and the vault root key.
// Usage: node init.mjs [tub-dir] [app-port]. Refuses to overwrite.
import { randomBytes, createHmac } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const dir = path.resolve(process.argv[2] ?? path.dirname(new URL(import.meta.url).pathname));
const port = process.argv[3] ?? '8080';
if (existsSync(path.join(dir, '.env'))) throw new Error(`${dir}/.env exists; not overwriting`);

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwtSecret = randomBytes(32).toString('hex');
const unsigned = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ role: 'anon', iss: 'supabase', iat: 1700000000, exp: 4102444800 })}`;
const anonKey = `${unsigned}.${createHmac('sha256', jwtSecret).update(unsigned).digest('base64url')}`;

writeFileSync(
  path.join(dir, '.env'),
  [
    `POSTGRES_PASSWORD=${randomBytes(24).toString('hex')}`,
    `JWT_SECRET=${jwtSecret}`,
    `ANON_KEY=${anonKey}`,
    `APP_PORT=${port}`,
    `TUB_PUBLIC_URL=http://localhost:${port}`,
  ].join('\n') + '\n',
  { mode: 0o600 },
);
mkdirSync(path.join(dir, 'data', 'files'), { recursive: true });
mkdirSync(path.join(dir, 'restore'), { recursive: true });
writeFileSync(path.join(dir, 'data', 'pgsodium_root.key'), randomBytes(32).toString('hex'));
console.log(`initialized ${dir}`);
