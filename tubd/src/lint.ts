// Checks a tub's resolved compose config before it runs. Blocks only what
// breaks moving the tub or collides with another tub; the rest is advice.
import path from 'node:path';
import type { TubMeta } from './meta.ts';

/** The parts of `docker compose config --format json` this module reads. */
export interface ComposeConfig {
  services: Record<string, ComposeService>;
}
export interface ComposeService {
  image?: string;
  build?: unknown;
  ports?: { published?: string | number; target: number; protocol?: string }[];
  volumes?: { type: string; source?: string; target: string }[];
  privileged?: boolean;
  network_mode?: string;
}

export interface LintIssue {
  level: 'error' | 'warning';
  service?: string;
  message: string;
}

export interface LintInput {
  tubDir: string;
  config: ComposeConfig;
  meta: TubMeta;
  /** Host ports already held, mapped to who holds them. */
  takenPorts: ReadonlyMap<number, string>;
}

export function lintTub({ tubDir, config, meta, takenPorts }: LintInput): LintIssue[] {
  const issues: LintIssue[] = [];
  const services = config.services ?? {};

  if (meta.public && !(meta.public.service in services)) {
    issues.push({ level: 'error', message: `tub.yaml public.service "${meta.public.service}" is not in compose.yaml` });
  }
  for (const s of meta.export.quiesce) {
    if (!(s in services)) issues.push({ level: 'error', message: `tub.yaml export.quiesce lists unknown service "${s}"` });
  }

  for (const [name, svc] of Object.entries(services)) {
    for (const v of svc.volumes ?? []) {
      if (v.type === 'volume') {
        issues.push({
          level: 'error',
          service: name,
          message: `named volume at ${v.target} lives inside Docker and would not travel with the tub; bind-mount a folder under ./data instead`,
        });
      } else if (v.type === 'bind' && v.source) {
        const rel = path.relative(tubDir, v.source);
        if (rel.startsWith('..') || path.isAbsolute(rel)) {
          issues.push({
            level: 'error',
            service: name,
            message: `bind mount ${v.source} is outside the tub folder, so it would not travel with the tub`,
          });
        }
      }
    }

    // The public service's ports are replaced by tubd's own mapping.
    if (name !== meta.public?.service) {
      for (const p of svc.ports ?? []) {
        const host = Number(p.published);
        if (!host) continue;
        const holder = takenPorts.get(host);
        if (holder) {
          issues.push({ level: 'error', service: name, message: `host port ${host} is already used by ${holder}` });
        }
      }
    }

    if (svc.privileged) issues.push({ level: 'warning', service: name, message: 'runs privileged' });
    if (svc.network_mode === 'host') {
      issues.push({ level: 'warning', service: name, message: 'uses the host network, so its ports can collide with other tubs' });
    }
  }
  return issues;
}

/** Host ports a tub's non-public services publish. */
export function fixedHostPorts(config: ComposeConfig, meta: TubMeta): number[] {
  const out: number[] = [];
  for (const [name, svc] of Object.entries(config.services ?? {})) {
    if (name === meta.public?.service) continue;
    for (const p of svc.ports ?? []) {
      const host = Number(p.published);
      if (host) out.push(host);
    }
  }
  return out;
}
