# shebang tubs

Host apps built by agents, and move them anywhere. Each app is a **tub**: one
folder with a plain `compose.yaml`, its own database, files, secrets and any
other service it needs. A tub exports to one zip that runs on another shebang
tubs instance, or on any machine with Docker Compose, with its data intact.

Nothing is built in that you can't swap: a tub picks its own database, auth
and storage. Shebang auth ("Sign in with shebang") is an optional identity
provider a tub can use instead of running its own.

> Early. The tub format and tubd's core work and are tested; the dashboard,
> public domains (Cloudflare Tunnel) and MCP tools are next. See
> [docs/design.md](docs/design.md).

## Install

Needs Docker with Compose 2.24.4 or later.

```
git clone <this repo> shebang-tubs && cd shebang-tubs
TUBD_DIR=$HOME/tubs docker compose up -d
docker compose logs tubd    # shows the instance API key once
```

The API listens on `127.0.0.1:7070`. Tubs get host ports from 20000-20999.

## Use

```
KEY=tubd_...    # from the log, or $TUBD_DIR/.tubd/api-key

# Deploy a tub: a new name imports it; an existing name updates its code and keeps its data.
(cd examples/notes && 7z a -tzip ../../notes.zip . '-x!data' '-x!restore' '-x!.env')
curl -X PUT --data-binary @notes.zip -H "authorization: Bearer $KEY" localhost:7070/v1/tubs/notes

# Export it (add "passphrase" to encrypt, "offline": true to bundle every image).
curl -X POST -d '{}' -H "authorization: Bearer $KEY" localhost:7070/v1/tubs/notes/export -o notes.tub.zip
```

Every export carries `HOW-TO-RUN.md`: unzip, `docker load` the images,
`docker compose up -d`. No shebang needed.

## What makes a folder a tub

- `compose.yaml` that runs with plain `docker compose up`.
- All persistent state under the tub folder (bind mounts like `./data/...`,
  never named volumes), so it travels in the zip.
- `tub.yaml` with the details only tubd reads: the public service and port,
  an `init` command that creates secrets, and how to export.
- If it has a database, a `restore` service that loads `restore/` on first
  start and an `export` service (profile `tub-export`) that writes it.

[examples/notes](examples/notes) is a complete one: Node, Supabase Postgres,
Supabase Auth and PostgREST.

## Develop

```
cd tubd && npm install
npm test          # unit tests
npx tsc           # typecheck
test/e2e.sh       # full round trip in Docker, about 5 minutes
```

## License

MIT
