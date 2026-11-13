// Runs an external command (docker, 7z, init scripts) and collects its output.
import { spawn } from 'node:child_process';

export class RunError extends Error {
  readonly code: number | null;
  readonly stderr: string;
  constructor(cmd: string, code: number | null, stderr: string) {
    super(`${cmd} exited ${code}: ${stderr.trim().split('\n').slice(-5).join('\n')}`);
    this.code = code;
    this.stderr = stderr;
  }
}

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** Written to stdin, then stdin is closed. Used for passphrases, never argv. */
  input?: string;
}

export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => (out += d));
    child.stderr.on('data', (d: Buffer) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new RunError(`${cmd} ${args[0] ?? ''}`, code, err || out))));
    child.stdin.end(opts.input ?? '');
  });
}
