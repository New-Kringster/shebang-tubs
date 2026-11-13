// Instance state: which host port each tub holds. Kept in <tubs>/.tubd so the
// tub folders themselves stay free of anything host-specific.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface TubRecord {
  port?: number;
  /** Host ports the tub's other services publish (LAN-only services such as MQTT). */
  fixedPorts: number[];
  createdAt: string;
}

export interface InstanceState {
  tubs: Record<string, TubRecord>;
}

export class StateFile {
  private readonly file: string;
  constructor(stateDir: string) {
    this.file = path.join(stateDir, 'state.json');
  }

  async read(): Promise<InstanceState> {
    try {
      return JSON.parse(await readFile(this.file, 'utf8')) as InstanceState;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { tubs: {} };
      throw err;
    }
  }

  async write(state: InstanceState): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(state, null, 2) + '\n');
    await rename(tmp, this.file);
  }
}

/** Every host port held by a tub other than `except`, mapped to its holder. */
export function takenPorts(state: InstanceState, except?: string): Map<number, string> {
  const taken = new Map<number, string>();
  for (const [name, rec] of Object.entries(state.tubs)) {
    if (name === except) continue;
    if (rec.port !== undefined) taken.set(rec.port, `tub ${name}`);
    for (const p of rec.fixedPorts) taken.set(p, `tub ${name}`);
  }
  return taken;
}

export function allocatePort(
  state: InstanceState,
  range: readonly [number, number],
  alsoTaken: ReadonlySet<number> = new Set(),
): number {
  const taken = takenPorts(state);
  for (let p = range[0]; p <= range[1]; p++) {
    if (!taken.has(p) && !alsoTaken.has(p)) return p;
  }
  throw new Error(`no free port in ${range[0]}-${range[1]}`);
}
