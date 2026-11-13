// TubStore: every operation tubd performs on tubs. One operation at a time,
// so ports and folders never race.
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';
import { extractTubZip, RUN_GUIDE, tempDir, writeTubZip } from './archive.ts';
import { TubCompose, type ServiceStatus } from './compose.ts';
import { runGuide } from './guide.ts';
import { fixedHostPorts, lintTub, type LintIssue } from './lint.ts';
import { readMeta, TUB_NAME, type TubMeta } from './meta.ts';
import { builtImageName, buildOverride } from './override.ts';
import { run } from './run.ts';
import { allocatePort, StateFile, takenPorts, type InstanceState } from './state.ts';

export interface StoreConfig {
  /** Root folder; must be the same path inside and outside tubd's container. */
  dir: string;
  /** Host name or address used in tub URLs until a tub has a domain. */
  hostAddress: string;
  portRange: readonly [number, number];
}

export class TubError extends Error {
  readonly status: number;
  readonly issues?: LintIssue[];
  constructor(status: number, message: string, issues?: LintIssue[]) {
    super(message);
    this.status = status;
    this.issues = issues;
  }
}

export interface DeployResult {
  name: string;
  created: boolean;
  port?: number;
  url?: string;
  warnings: LintIssue[];
  built: string[];
}

export interface TubInfo {
  name: string;
  port?: number;
  url?: string;
  createdAt: string;
  services: ServiceStatus[];
}

/** Kept in place when a deploy replaces a tub's code. */
const KEEP_ON_UPDATE = new Set(['data', 'restore', '.env']);

export class TubStore {
  readonly tubsDir: string;
  readonly stateDir: string;
  private readonly cfg: StoreConfig;
  private readonly state: StateFile;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(cfg: StoreConfig) {
    this.cfg = cfg;
    this.tubsDir = path.join(cfg.dir, 'tubs');
    this.stateDir = path.join(cfg.dir, '.tubd');
    this.state = new StateFile(this.stateDir);
  }

  async init(): Promise<void> {
    for (const d of [this.tubsDir, this.stateDir, path.join(this.stateDir, 'overrides'), path.join(this.stateDir, 'staging')]) {
      await mkdir(d, { recursive: true });
    }
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private tubDir(name: string): string {
    return path.join(this.tubsDir, name);
  }
  private overrideFile(name: string): string {
    return path.join(this.stateDir, 'overrides', `${name}.yaml`);
  }
  private url(port: number | undefined): string | undefined {
    return port === undefined ? undefined : `http://${this.cfg.hostAddress}:${port}`;
  }
  private compose(name: string, dir: string, port: number | undefined): TubCompose {
    const env: Record<string, string> = {};
    const url = this.url(port);
    if (url) env.TUB_PUBLIC_URL = url;
    return new TubCompose(name, dir, this.overrideFile(name), env);
  }

  private async known(name: string): Promise<InstanceState> {
    if (!TUB_NAME.test(name)) throw new TubError(400, `tub names must match ${TUB_NAME}`);
    const state = await this.state.read();
    if (!state.tubs[name]) throw new TubError(404, `no tub named ${name}`);
    return state;
  }

  list(): Promise<TubInfo[]> {
    return this.exclusive(async () => {
      const state = await this.state.read();
      return Promise.all(Object.keys(state.tubs).sort().map((n) => this.info(n, state)));
    });
  }

  get(name: string): Promise<TubInfo> {
    return this.exclusive(async () => this.info(name, await this.known(name)));
  }

  private async info(name: string, state: InstanceState): Promise<TubInfo> {
    const rec = state.tubs[name];
    let services: ServiceStatus[] = [];
    try {
      services = await this.compose(name, this.tubDir(name), rec.port).ps();
    } catch {
      /* folder or compose problem: report no services */
    }
    return { name, port: rec.port, url: this.url(rec.port), createdAt: rec.createdAt, services };
  }

  /**
   * Deploy a tub zip. A new name imports it, data and all. An existing name
   * replaces its code and images but keeps its data/, restore/ and .env
   * (new keys in the zip's .env are added).
   */
  deploy(name: string, zip: string, passphrase?: string): Promise<DeployResult> {
    return this.exclusive(async () => {
      if (!TUB_NAME.test(name)) throw new TubError(400, `tub names must match ${TUB_NAME}`);
      const state = await this.state.read();
      const live = this.tubDir(name);
      const existing = state.tubs[name] !== undefined && existsSync(live);
      const staging = path.join(this.stateDir, 'staging', `${name}-${randomBytes(4).toString('hex')}`);
      try {
        await extractTubZip(zip, staging, passphrase);
        await rm(path.join(staging, RUN_GUIDE), { force: true });
        let meta: TubMeta;
        try {
          meta = await readMeta(staging);
        } catch (err) {
          throw new TubError(400, (err as Error).message);
        }
        const loaded = await loadImages(path.join(staging, 'images'));
        await rm(path.join(staging, 'images'), { recursive: true, force: true });

        if (existing) {
          const merged = mergeEnv(await readText(path.join(live, '.env')), await readText(path.join(staging, '.env')));
          await rm(path.join(staging, '.env'), { force: true }); // so the 0600 mode applies
          await writeFile(path.join(staging, '.env'), merged, { mode: 0o600 });
        } else if (!existsSync(path.join(staging, '.env')) && meta.init?.length) {
          await run(meta.init[0], meta.init.slice(1), { cwd: staging });
        }

        const buildServices = await buildServicesOf(staging);
        const port = meta.public
          ? (state.tubs[name]?.port ?? allocatePort(state, this.cfg.portRange))
          : undefined;
        await writeFile(this.overrideFile(name), buildOverride(name, meta, port, buildServices));

        const config = await this.compose(name, staging, port).config();
        const issues = lintTub({ tubDir: staging, config, meta, takenPorts: takenPorts(state, name) });
        const errors = issues.filter((i) => i.level === 'error');
        if (errors.length) throw new TubError(422, 'the tub did not pass checks', errors);

        if (existing) {
          for (const entry of await readdir(live)) {
            if (!KEEP_ON_UPDATE.has(entry)) await rm(path.join(live, entry), { recursive: true, force: true });
          }
          for (const entry of await readdir(staging)) {
            if (!KEEP_ON_UPDATE.has(entry) || entry === '.env') {
              await rm(path.join(live, entry), { recursive: true, force: true });
              await rename(path.join(staging, entry), path.join(live, entry));
            }
          }
          await mkdir(path.join(live, 'restore'), { recursive: true });
        } else {
          await mkdir(path.join(staging, 'restore'), { recursive: true });
          await rename(staging, live);
        }

        state.tubs[name] = {
          port,
          fixedPorts: fixedHostPorts(config, meta),
          createdAt: state.tubs[name]?.createdAt ?? new Date().toISOString(),
        };
        await this.state.write(state);

        // Images that arrived in the zip become this tub's images; the rest are built.
        const fromZip = new Set<string>();
        for (const svc of buildServices) {
          const ref = loaded.get(svc);
          if (ref) {
            await run('docker', ['tag', ref, builtImageName(name, svc)]);
            fromZip.add(svc);
          }
        }
        const compose = this.compose(name, live, port);
        const toBuild = buildServices.filter((s) => !fromZip.has(s));
        if (toBuild.length) await compose.build(toBuild);
        await compose.up();

        return {
          name,
          created: !existing,
          port,
          url: this.url(port),
          warnings: issues.filter((i) => i.level === 'warning'),
          built: toBuild,
        };
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
    });
  }

  /** Export a tub to a zip under .tubd/exports. The caller deletes it when done. */
  export(name: string, opts: { offline?: boolean; passphrase?: string } = {}): Promise<string> {
    return this.exclusive(async () => {
      const state = await this.known(name);
      const dir = this.tubDir(name);
      const meta = await readMeta(dir);
      const compose = this.compose(name, dir, state.tubs[name].port);
      const hasExport = 'export' in (await compose.config(['tub-export'])).services;

      const running = new Set((await compose.ps()).filter((s) => s.state === 'running').map((s) => s.service));
      const paused = meta.export.quiesce.filter((s) => running.has(s));
      const extras = await tempDir('tubd-export-');
      try {
        if (hasExport) {
          if (paused.length) await compose.stop(paused);
          await mkdir(path.join(dir, 'restore'), { recursive: true });
          await compose.runOnce('tub-export', 'export');
        }
        await mkdir(path.join(extras, 'images'));
        await saveImages(name, dir, meta, path.join(extras, 'images'), opts.offline ?? false, compose);
        await writeFile(
          path.join(extras, RUN_GUIDE),
          runGuide(meta, { encrypted: !!opts.passphrase, offline: !!opts.offline, hasExport }),
        );
        const exportsDir = path.join(this.stateDir, 'exports');
        await mkdir(exportsDir, { recursive: true });
        const out = path.join(exportsDir, `${name}-${Date.now()}.tub.zip`);
        await writeTubZip({ tubDir: dir, out, exclude: meta.export.exclude, extrasDir: extras, passphrase: opts.passphrase });
        return out;
      } finally {
        if (paused.length) await compose.start(paused);
        await rm(extras, { recursive: true, force: true });
      }
    });
  }

  start(name: string): Promise<void> {
    return this.exclusive(async () => {
      const state = await this.known(name);
      await this.compose(name, this.tubDir(name), state.tubs[name].port).up();
    });
  }

  stop(name: string): Promise<void> {
    return this.exclusive(async () => {
      const state = await this.known(name);
      await this.compose(name, this.tubDir(name), state.tubs[name].port).stop();
    });
  }

  logs(name: string, service: string | undefined, tail: number): Promise<string> {
    return this.exclusive(async () => {
      const state = await this.known(name);
      return this.compose(name, this.tubDir(name), state.tubs[name].port).logs(service, tail);
    });
  }

  /** Stops the tub and deletes its folder and data. Not reversible. */
  remove(name: string): Promise<void> {
    return this.exclusive(async () => {
      const state = await this.known(name);
      await this.compose(name, this.tubDir(name), state.tubs[name].port).down().catch(() => undefined);
      const built = await buildServicesOf(this.tubDir(name)).catch(() => []);
      for (const svc of built) {
        await run('docker', ['image', 'rm', builtImageName(name, svc)]).catch(() => undefined);
      }
      await rm(this.tubDir(name), { recursive: true, force: true });
      await rm(this.overrideFile(name), { force: true });
      delete state.tubs[name];
      await this.state.write(state);
    });
  }
}

/** Services in a tub's own compose.yaml that build an image from source. */
async function buildServicesOf(dir: string): Promise<string[]> {
  const raw = parse(await readFile(path.join(dir, 'compose.yaml'), 'utf8')) as { services?: Record<string, { build?: unknown }> };
  return Object.entries(raw.services ?? {})
    .filter(([, s]) => s && s.build !== undefined)
    .map(([n]) => n);
}

/** The name an image has in the tub's own compose.yaml, used outside tubd. */
async function baseImageName(dir: string, meta: TubMeta, service: string): Promise<string> {
  const raw = parse(await readFile(path.join(dir, 'compose.yaml'), 'utf8')) as {
    name?: string;
    services?: Record<string, { image?: string }>;
  };
  return raw.services?.[service]?.image ?? `${raw.name ?? meta.name}-${service}`;
}

/**
 * images/<service>.tar for every built service, tagged with the tub's own
 * compose name so `docker compose up` finds it outside tubd. Offline exports
 * also carry every public image as images/pulled-<n>.tar.
 */
async function saveImages(tub: string, dir: string, meta: TubMeta, out: string, offline: boolean, compose: TubCompose) {
  for (const svc of await buildServicesOf(dir)) {
    const base = await baseImageName(dir, meta, svc);
    await run('docker', ['tag', builtImageName(tub, svc), base]);
    await run('docker', ['save', '-o', path.join(out, `${svc}.tar`), base]);
  }
  if (offline) {
    const { pulled } = await compose.images();
    let i = 0;
    for (const img of pulled) await run('docker', ['save', '-o', path.join(out, `pulled-${i++}.tar`), img]);
  }
}

/** Loads images/*.tar; returns service name -> loaded image for <service>.tar files. */
async function loadImages(dir: string): Promise<Map<string, string>> {
  const loaded = new Map<string, string>();
  if (!existsSync(dir)) return loaded;
  for (const f of (await readdir(dir)).filter((f) => f.endsWith('.tar')).sort()) {
    const out = await run('docker', ['load', '-i', path.join(dir, f)]);
    const ref = /Loaded image(?: ID)?: (\S+)/.exec(out)?.[1];
    if (ref && !f.startsWith('pulled-')) loaded.set(f.slice(0, -4), ref);
  }
  return loaded;
}

async function readText(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return '';
  }
}

/** Live values win; keys only the incoming file has are appended. */
export function mergeEnv(live: string, incoming: string): string {
  const key = (l: string) => /^\s*([A-Za-z_][A-Za-z0-9_]*)=/.exec(l)?.[1];
  const have = new Set(live.split('\n').map(key).filter(Boolean));
  const added = incoming.split('\n').filter((l) => {
    const k = key(l);
    return k !== undefined && !have.has(k);
  });
  const base = live.endsWith('\n') || live === '' ? live : live + '\n';
  return added.length ? base + added.join('\n') + '\n' : base;
}
