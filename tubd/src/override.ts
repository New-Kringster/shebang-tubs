// The compose file tubd layers on top of a tub's own compose.yaml. It never
// edits the tub's file. It does two things:
// - gives every service the tub builds an image name unique to this tub, so
//   two copies of one tub can't overwrite each other's images;
// - replaces the public service's port mapping with the port tubd assigned.
import type { TubMeta } from './meta.ts';

export function builtImageName(tub: string, service: string): string {
  return `tub-${tub}-${service}`.toLowerCase();
}

export function buildOverride(
  tub: string,
  meta: TubMeta,
  hostPort: number | undefined,
  buildServices: readonly string[],
): string {
  const services = new Map<string, string[]>();
  const add = (svc: string, line: string) => services.set(svc, [...(services.get(svc) ?? []), line]);
  for (const svc of buildServices) add(svc, `    image: ${builtImageName(tub, svc)}`);
  if (meta.public && hostPort !== undefined) {
    // `!override` (Compose 2.24.4+) replaces the base file's list instead of merging.
    add(meta.public.service, `    ports: !override\n      - "${hostPort}:${meta.public.port}"`);
  }
  if (services.size === 0) return 'services: {}\n';
  const lines = ['# Written by tubd. Not part of the tub; regenerated on every deploy.', 'services:'];
  for (const [svc, body] of services) lines.push(`  ${JSON.stringify(svc)}:`, ...body);
  return lines.join('\n') + '\n';
}
