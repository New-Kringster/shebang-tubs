// Tub zips, via 7-Zip: plain, or AES-256 with only HOW-TO-RUN.md readable.
// Passphrases go to 7z on stdin, never on the command line.
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { run } from './run.ts';

export const RUN_GUIDE = 'HOW-TO-RUN.md';

export interface ZipInput {
  tubDir: string;
  out: string;
  /** Paths relative to tubDir to leave out. */
  exclude: string[];
  /** A folder whose contents are added at the zip root too (images/, the guide). */
  extrasDir: string;
  passphrase?: string;
}

export async function writeTubZip({ tubDir, out, exclude, extrasDir, passphrase }: ZipInput): Promise<void> {
  await rm(out, { force: true });
  const crypt = passphrase ? ['-mem=AES256', '-p'] : [];
  const input = passphrase ? passphrase + '\n' : undefined;
  const skip = [...exclude, 'images', RUN_GUIDE].map((p) => `-x!${p}`);
  await run('7z', ['a', '-tzip', '-bso0', '-bsp0', ...crypt, out, '.', ...skip], { cwd: tubDir, input });
  await run('7z', ['a', '-tzip', '-bso0', '-bsp0', ...crypt, out, '.', `-x!${RUN_GUIDE}`], { cwd: extrasDir, input });
  // The guide stays readable so an encrypted zip still explains how to open it.
  await run('7z', ['a', '-tzip', '-bso0', '-bsp0', out, RUN_GUIDE], { cwd: extrasDir });
}

export async function isEncrypted(zip: string): Promise<boolean> {
  const listing = await run('7z', ['l', '-slt', zip]);
  return /^Encrypted = \+$/m.test(listing);
}

export class PassphraseError extends Error {}

export async function extractTubZip(zip: string, dest: string, passphrase?: string): Promise<void> {
  if (await isEncrypted(zip)) {
    if (!passphrase) throw new PassphraseError('this tub zip is encrypted; a passphrase is needed');
    try {
      // Without -p, 7z asks for the passphrase and reads it from stdin.
      await run('7z', ['x', '-y', '-bso0', '-bsp0', `-o${dest}`, zip], { input: passphrase + '\n' });
    } catch {
      throw new PassphraseError('wrong passphrase, or the zip is damaged');
    }
  } else {
    await run('7z', ['x', '-y', '-bso0', '-bsp0', `-o${dest}`, zip]);
  }
}

export async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}
