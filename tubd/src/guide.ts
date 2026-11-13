// HOW-TO-RUN.md: put in every export so a tub runs without shebang.
import type { TubMeta } from './meta.ts';

export function runGuide(meta: TubMeta, opts: { encrypted: boolean; offline: boolean; hasExport: boolean }): string {
  const n = meta.name;
  const open = opts.encrypted
    ? `7z x ${n}.tub.zip -o${n} && cd ${n}`
    : `unzip ${n}.tub.zip -d ${n} && cd ${n}`;
  const q = meta.export.quiesce.join(' ');
  return `# ${n}

A shebang tub: one app with its database, files and secrets, in plain Docker
Compose. It runs on any machine with Docker Compose 2.24.4 or later. You
don't need shebang.
${opts.encrypted ? `
Everything except this file is AES-256 encrypted. Open it with 7-Zip, Keka or
\`7z x\` (the stock macOS unzipper and Linux \`unzip\` can't open it).
` : ''}
## Run it

\`\`\`
${open}
for f in images/*.tar; do docker load -i "$f"; done
docker compose up -d
\`\`\`
${meta.public ? `
The app is the \`${meta.public.service}\` service on container port
${meta.public.port}; see its \`ports:\` in compose.yaml for the host port.
` : ''}
If the tub came with saved data, it loads on first start, which takes a few
seconds longer.

## What's in here

- \`compose.yaml\`: every service.
- \`.env\`: every secret and setting. Keep it private.
- \`data/\`: persistent files.
- \`restore/\`: saved database data, loaded once on first start.
- \`images/\`: ${opts.offline ? 'every image the tub uses (offline export)' : "the images built for this tub; public images download on first start"}.
- \`tub.yaml\`: details only shebang reads.

## Save it again

${opts.hasExport ? `\`\`\`
${q ? `docker compose stop ${q}\n` : ''}docker compose --profile tub-export run --rm export
${q ? `docker compose start ${q}\n` : ''}\`\`\`

then zip` : `Stop it, then zip`} the folder, leaving out ${meta.export.exclude.map((e) => `\`${e}\``).join(', ') || 'nothing'}.
`;
}
