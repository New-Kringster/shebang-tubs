// Docker Compose for one tub: its own compose.yaml plus tubd's override,
// under the project name tub-<name>.
import path from 'node:path';
import type { ComposeConfig } from './lint.ts';
import { run } from './run.ts';

export interface ServiceStatus {
  service: string;
  state: string;
  health: string;
  exitCode: number;
}

export class TubCompose {
  readonly project: string;
  private readonly tubDir: string;
  private readonly overrideFile: string;
  private readonly env: Record<string, string>;

  constructor(name: string, tubDir: string, overrideFile: string, env: Record<string, string>) {
    this.project = `tub-${name}`;
    this.tubDir = tubDir;
    this.overrideFile = overrideFile;
    this.env = env;
  }

  private exec(args: string[], input?: string): Promise<string> {
    const base = ['compose', '-p', this.project, '-f', path.join(this.tubDir, 'compose.yaml'), '-f', this.overrideFile];
    return run('docker', [...base, ...args], { cwd: this.tubDir, env: this.env, input });
  }

  async config(profiles: string[] = []): Promise<ComposeConfig> {
    const p = profiles.flatMap((x) => ['--profile', x]);
    return JSON.parse(await this.exec([...p, 'config', '--format', 'json'])) as ComposeConfig;
  }

  /** Starts every service. Never builds: missing images are built by build() first. */
  up(): Promise<string> {
    return this.exec(['up', '-d', '--remove-orphans', '--no-build']);
  }
  build(services: string[]): Promise<string> {
    return this.exec(['build', ...services]);
  }
  stop(services: string[] = []): Promise<string> {
    return this.exec(['stop', ...services]);
  }
  start(services: string[] = []): Promise<string> {
    return this.exec(['start', ...services]);
  }
  down(): Promise<string> {
    return this.exec(['down', '--remove-orphans']);
  }
  runOnce(profile: string, service: string): Promise<string> {
    return this.exec(['--profile', profile, 'run', '--rm', service]);
  }
  logs(service: string | undefined, tail: number): Promise<string> {
    return this.exec(['logs', '--no-color', '--tail', String(tail), ...(service ? [service] : [])]);
  }

  async ps(): Promise<ServiceStatus[]> {
    const out = await this.exec(['ps', '-a', '--format', 'json']);
    // Compose prints one JSON object per line (older versions: one array).
    const rows: Record<string, unknown>[] = out.trim().startsWith('[')
      ? JSON.parse(out)
      : out.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    return rows.map((r) => ({
      service: String(r.Service),
      state: String(r.State),
      health: String(r.Health ?? ''),
      exitCode: Number(r.ExitCode ?? 0),
    }));
  }

  /** Images this tub uses, split into the ones it builds and the public ones it pulls. */
  async images(): Promise<{ built: string[]; pulled: string[] }> {
    const cfg = await this.config();
    const built = new Set<string>();
    const pulled = new Set<string>();
    for (const [name, svc] of Object.entries(cfg.services)) {
      if (svc.build) built.add(svc.image ?? `${this.project}-${name}`);
      else if (svc.image) pulled.add(svc.image);
    }
    return { built: [...built], pulled: [...pulled] };
  }
}
