// tub.yaml: the shebang-only details of a tub. compose.yaml runs without it.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';

export interface TubMeta {
  name: string;
  template?: string;
  /** The service shebang publishes, and the container port it listens on. */
  public?: { service: string; port: number };
  export: {
    /** Services stopped while the dumps and files are copied. */
    quiesce: string[];
    /** Paths (relative to the tub) left out of the zip: live state carried another way. */
    exclude: string[];
  };
  /** Command run in the tub folder when it arrives without a .env (creates secrets). */
  init?: string[];
}

export const TUB_NAME = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/;

export class MetaError extends Error {}

export function parseMeta(text: string): TubMeta {
  const raw: unknown = parse(text);
  if (!isRecord(raw)) throw new MetaError('tub.yaml must be a mapping');
  const name = raw.name;
  if (typeof name !== 'string' || !TUB_NAME.test(name)) {
    throw new MetaError(`tub.yaml name must match ${TUB_NAME}`);
  }
  const meta: TubMeta = { name, export: { quiesce: [], exclude: [] } };
  if (typeof raw.template === 'string') meta.template = raw.template;

  if (raw.public !== undefined) {
    const pub = raw.public;
    if (!isRecord(pub) || typeof pub.service !== 'string' || !isPort(pub.port)) {
      throw new MetaError('tub.yaml public needs service (string) and port (1-65535)');
    }
    meta.public = { service: pub.service, port: pub.port };
  }

  if (raw.export !== undefined) {
    if (!isRecord(raw.export)) throw new MetaError('tub.yaml export must be a mapping');
    meta.export.quiesce = stringList(raw.export.quiesce, 'export.quiesce');
    meta.export.exclude = stringList(raw.export.exclude, 'export.exclude').map((p) => {
      const norm = path.posix.normalize(p).replace(/\/$/, '');
      if (norm.startsWith('..') || path.posix.isAbsolute(norm)) {
        throw new MetaError(`export.exclude path ${p} must stay inside the tub`);
      }
      return norm;
    });
  }

  if (raw.init !== undefined) meta.init = stringList(raw.init, 'init');
  return meta;
}

export async function readMeta(tubDir: string): Promise<TubMeta> {
  let text: string;
  try {
    text = await readFile(path.join(tubDir, 'tub.yaml'), 'utf8');
  } catch {
    throw new MetaError('tub.yaml is missing');
  }
  return parseMeta(text);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isPort(v: unknown): v is number {
  return Number.isInteger(v) && (v as number) > 0 && (v as number) < 65536;
}

function stringList(v: unknown, field: string): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || !v.every((s) => typeof s === 'string')) {
    throw new MetaError(`tub.yaml ${field} must be a list of strings`);
  }
  return v;
}
