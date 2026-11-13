# Shebang tub — design

**Status:** decided by Braven in chat, 2026-11-13 (four question rounds).
Restore spike and tubd core built and tested the same day (see "Spike
results" and "tubd"). Routing, domains, the dashboard, MCP tools and
templates are not built yet.

## The idea

Stop building shared platform services (sherpage, sherbase, sherserve,
sherlink) that every app plugs into. Each app instead brings everything it
needs (its code, its database, its file storage, anything else such as MQTT
or Redis) in one folder, called a **tub**. A tub can be exported as one zip,
copied to another shebang instance or any Docker host, and run there with its
data, settings, secrets and internal connections intact.

**Shebang tubs is a framework, not Braven's platform** (Braven, 2026-11-13).
It is an easy way to build apps with agents, host them and package them, and
Braven's friends install and run it themselves. It is modular: no built-in
database, pages, docs, links or files service; each tub picks its own pieces
and any piece can be swapped.

**Shebang auth is the one shared service.** Braven hosts it himself, apart
from tubs (today's sherlock). It gives tub builders an easy, secure identity
provider so they don't have to run one. It is opt-in per tub: a tub can use
shebang auth, its own auth, or none.

**v1 retires at the transition.** When tubs work well, sherpage (including
blogs), sherlink, sherbase, sherserve and the docs site are removed. Only
auth is kept, moved out on its own. Until then v1 stays exactly as it is;
nothing is removed early.

## Terms

| Term | Meaning |
|---|---|
| **tub** | One app: a folder holding a plain `compose.yaml`, its source, its data and its secrets. The unit of deploy, export, backup and placement. Replaces Project as the main unit once v1 is migrated. |
| **tub zip** | The export of a tub: one file, readable without shebang. |
| **tubd** | The host daemon that owns Docker and runs tubs. The dash and the MCP call it; nothing else touches the Docker socket. |
| **template** | A short Markdown note that gives agents ideas for a tub of a given size. Guidance only. |

## Decisions

| # | Question | Decision |
|---|---|---|
| Runtime | Compose, Kubernetes or microVMs? | **Docker Compose**, one compose project per tub. Kubernetes stores data in cluster volumes, which breaks "one folder"; microVMs only pay off for untrusted code. |
| Q1 | Who writes tub code? | Braven and his agents only, for now. Ordinary `runc` containers. If other users arrive, switch the tub runtime to gVisor or Kata (`/dev/kvm` exists on braven-agents) without changing the tub format. |
| Q2 | Where do a tub's users live? | **Inside the tub**: each tub that needs users runs its own auth (for example GoTrue). Shebang auth (sherlock) is an optional identity provider ("Sign in with shebang") a tub can trust; it never manages the tub's users. Opt-in per tub (revised later the same day). |
| Q3 | Which parts of Supabase does a tub get? | Whatever the building agent judges best. No fixed set. |
| Q4 | What happens to v1 apps? | Leave them running unchanged until tubs work well. Then remove all of v1 except auth, which moves out on its own and stays hosted by Braven (revised later the same day). |
| Q5 | Where does the first instance run? | braven-agents (this VM). |
| Q6 | Do secrets travel? | Yes. One zip holds everything, including secrets and a README explaining how to run the tub without shebang. No lock-in. |
| Q7 | Is the zip encrypted? | Only if the user turns it on (`--encrypt`): AES-256 zip with a passphrase; `README.md` stays readable. Opens with 7-Zip, Keka or `7z x`. Default is a plain zip. |
| Q8 | Which images are in the zip? | Default: the images built for the tub's own services; public images are pinned by digest and pulled on first start. `--offline`: every image is bundled. |
| Q9 | How do agents deploy? | Deploy and import are the same action: send a zip. A deploy replaces code, images and compose but keeps the tub's data. An import brings data too. Agents keep source in git on their own machine and call `tub_deploy`. |
| Q10 | Public addresses | Each tub gets its own subdomain, created on request through the Cloudflare API, by the user in the dash or by an agent through MCP. A tub has no public record until someone asks for one. |
| Q11 | Templates | Markdown notes for inspiration only. Agents use the best tool for the job and may bundle anything (MQTT, Redis, niche images). |
| Q12 | Which domains? | Subdomains of `shebang.pro` only, for Braven's own instance. Each self-hosted instance configures its own zone and token. |
| Q13 | Who can make a domain go live? | Braven or any agent, directly, with the guardrails below. Recorded as a standing exception in the infra-changes skill. |
| Q14 | Non-web ports (MQTT 1883, game servers)? | LAN-only on this instance. Someone running a tub on their own host can set up their own port forward. Templates point agents at WebSocket variants (MQTT over WebSockets), which work through Cloudflare. |
| Q15 | Where does shebang tubs live? | Its own repo, `shebang-tubs` (this one), public and MIT-licensed like `shebang-mcp`. `sherbang` keeps v1 and later the standalone auth service. |
| Q16 | How do people install it? | tubd ships as a Docker image; install is one compose file (`compose.yaml` at the repo root). Works on Linux and on macOS with Docker Desktop. |
| Q17 | Language | TypeScript on Node 22, run directly (Node strips types), no build step. Chosen by the agent; Braven left it open. |
| Q18 | How does a self-hosted instance make a tub public? | Cloudflare Tunnel built in, as the default: no port forward, reverse proxy or fixed IP needed. The owner gives the instance a Cloudflare API token; tubd creates the tunnel and one DNS record per tub. Braven's instance may keep the A-record path through NPM. |
| Q19 | Owner sign-in | Every instance has a dashboard. The owner signs in with a local account created at install; "Sign in with shebang" is optional. Agents use an instance API key. |

## The tub folder

```
tubs/<name>/
  compose.yaml     # plain Docker Compose; the real definition
  tub.yaml         # shebang-only extras: public service + port, template used, export hooks
  .env             # every secret; compose reads it automatically
  services/<svc>/  # source + Dockerfile per built service
  data/            # all persistent state, bind-mounted (data/db, data/files, ...)
  restore/         # only in a zip: the database dump loaded on first start
  images/          # only in a zip: docker-save tarballs
  README.md        # how to run without shebang
```

`compose.yaml` must run with plain `docker compose up` on any Docker host.
Shebang never rewrites it. At run time tubd layers its own override file on
top for router labels, the shebang network, memory caps and the injected
`TUB_PUBLIC_URL`.

**What shebang checks.** tubd lints `compose.yaml` on deploy and blocks only
what breaks portability or collides with another tub:

- persistent data outside the tub folder (host paths outside `./`, or named
  volumes, which live in `/var/lib/docker` and would not travel);
- a fixed host port already used by another tub.

Everything else is at most a warning.

**Connections survive a move.** Services find each other by name on the
tub's own compose network (`db:5432`). Credentials are generated once when
the tub is created and stored in `.env`, so they travel with it. The only
values the host supplies are the ones it owns: the public URL and port
routing. Apps must read their public origin from `TUB_PUBLIC_URL` and never
hardcode a domain.

## Export and import

The zip is the tub folder with two substitutions:

- `data/db` (the live Postgres data directory) is replaced by a logical dump
  in `restore/`. A data directory is tied to the Postgres major version and
  CPU architecture (Braven's Mac and the pantry VM are arm64; this VM is
  x86), so the dump is the portable form.
- `images/` holds `docker save` output for the tub's own images (all images
  with `--offline`).

The tub restores itself, and dumps itself, with two compose services it
owns (see `tubs/examples/notes`):

- **`restore`**, a one-shot service that runs on every start after the
  tub's other setup (for a Supabase tub: after GoTrue has created its own
  tables). If its marker table `_tub.initialized` exists it does nothing; if
  `restore/` holds dumps it loads them; otherwise it applies the starting
  schema. App services wait for it to complete successfully.
- **`export`**, in compose profile `tub-export`, which writes the dumps
  into `restore/`. Shebang runs it with
  `docker compose --profile tub-export run --rm export`; so can anyone
  without shebang.

A plain-Postgres tub can instead use the image's first-start init folder
(`/docker-entrypoint-initdb.d`). That doesn't work for Supabase auth: the
`auth` tables only reach their current shape when GoTrue migrates them on
start, so user rows can only load after that. So running a tub outside
shebang is:

```
unzip <name>.tub.zip -d <name> && cd <name>
docker load -i images/<svc>.tar      # once per image
docker compose up -d
```

Import into shebang is the same steps, done by tubd. Export pauses the tub's
app services (not the database) for the dump and file copy, so the database
and files match; downtime is seconds.

**Backups** are a nightly export of every tub, run by the existing backup
timer. One format serves both purposes.

## Identity: sherlock as the IdP

A tub that needs users runs its own GoTrue, v2.196.0 or later (the first
version with custom OIDC providers through the admin API; v1's stack runs
v2.189.0, which is fine for sherlock itself). Wiring, done by tubd when a
tub with auth gets a domain:

1. Register an OAuth client for the tub in sherlock (the Stage 8 OAuth
   server) with redirect `https://<tub>.shebang.pro/auth/v1/callback`.
2. Register sherlock in the tub's GoTrue as provider `custom:shebang`
   (issuer `https://auth.shebang.pro/auth/v1`), authenticating with
   `client_secret_post`. Sherlock's GoTrue mis-decodes `client_secret_basic`
   (lesson `supabase-oauth-server-self-hosted-gotchas`), and the proxy
   already advertises only `client_secret_post`.
3. When the tub's domain changes, update the redirect URI in sherlock.

The provider config lives in the tub's own database, so it travels in the
zip. A moved tub keeps trusting sherlock at `shebang.pro`; OIDC works from
anywhere, and re-registering with a different instance's sherlock would
break the link between existing users and their identities.

## Domains and routing

**Self-hosted instances (Q18):** Cloudflare Tunnel. tubd runs `cloudflared`
for the instance, and giving a tub a domain adds one tunnel route and one
CNAME to the tunnel, using the owner's own Cloudflare token and zone. The
rest of this section is Braven's own instance, which can use either path.

Ingress today: Cloudflare proxied record → home IP → UDM forwards 443 → Nginx
Proxy Manager on newmain → a port on braven-agents. For tubs:

1. **Once:** one NPM proxy host `*.shebang.pro` → the tub router (Caddy or
   Traefik, decided at build time) on braven-agents. NPM matches exact
   hosts before wildcards, so existing hosts are unaffected. One anchor
   record (for example `edge.shebang.pro`, A → home IP). Both done by the
   infra-changes instance with Braven's approval.
2. **Per tub, on request:** a proxied CNAME `<tub>.shebang.pro` → the
   anchor (`tub_set_domain` in MCP, or the dash). An IP change then means
   editing one record.
3. tubd points the router at the tub, injects `TUB_PUBLIC_URL`, and
   updates the sherlock redirect.

Without a record, a tub is reachable on the LAN at
`192.168.1.83:<port tubd assigns>`.

**DNS guardrails** (the conditions of the Q13 grant):

- A dedicated Cloudflare token with DNS edit on the `shebang.pro` zone only,
  not the admin `$CLOUDFLARE_API_TOKEN`.
- tubd creates, edits and deletes only records it created, each marked with
  the Cloudflare record comment `shebang-tub:<name>`.
- It refuses names that already exist and names v1 uses (`dash`, `auth`,
  `api`, `docs`, `sl`, `p`, `f`, `db`, plus the anchor).

## Templates

Short Markdown notes (Q11) that agents read for ideas, never a fixed set of
pieces: agents use the best tool for each job. Starting set, with rough idle
memory from today's containers:

| Template | Shape | Idle |
|---|---|---|
| small | Node + plain Postgres (beadreader's shape) | ~100 MB |
| standard | Node + `supabase/postgres` + GoTrue with sherlock sign-in + PostgREST | ~250 MB |
| full | standard + Storage + Realtime + a worker | ~400 MB |

Each template sets a default memory cap per service; agents may change it.

## tubd

The program that runs an instance's tubs (`tubd/`). It runs in a container
with the Docker socket and the instance folder `TUBD_DIR` mounted at the same
path inside and out, so the bind mounts in a tub's compose file resolve on
the host.

```
$TUBD_DIR/
  tubs/<name>/            each tub, exactly as in its zip (plus live data/db)
  .tubd/state.json        host port per tub, ports its other services hold
  .tubd/overrides/        the compose file tubd layers on each tub
  .tubd/api-key           the instance API key (also printed once at first start)
  .tubd/staging/, exports/
```

HTTP API, all routes behind `Authorization: Bearer <instance key>`:

| Route | Does |
|---|---|
| `GET /v1/tubs`, `GET /v1/tubs/:name` | list, with each service's state |
| `PUT /v1/tubs/:name` (zip body, `x-tub-passphrase` if encrypted) | **deploy**: a new name imports the zip, data and all; an existing name replaces code and images but keeps `data/`, `restore/` and `.env` (new `.env` keys are added) |
| `POST /v1/tubs/:name/export` (`{offline?, passphrase?}`) | the tub zip |
| `POST /v1/tubs/:name/start`, `/stop` | |
| `GET /v1/tubs/:name/logs?service=&tail=` | |
| `DELETE /v1/tubs/:name?confirm=:name` | stops it and deletes its folder, data and images |

How deploy works: unzip to staging, load `images/*.tar`, run `tub.yaml`
`init` if the tub has no `.env` (the notes example creates its secrets this
way), give it a host port, check it, then move it into place and start it.
The check refuses named volumes, bind mounts outside the tub, and host ports
another tub holds; privileged services and host networking are warnings.
Nothing is registered or changed when the check fails.

**Image names.** Every image a tub builds is renamed `tub-<name>-<service>`
in tubd's override, so two copies of one tub never share an image (the test
updates one copy and checks the other is unchanged). On export the image is
also tagged with the name the tub's own compose file uses, so
`docker compose up` outside tubd finds it. On deploy, an image that came in
the zip is retagged for the new tub and not rebuilt; a source-only zip is
built.

**The public port.** The override replaces the public service's `ports:`
with `!override` (Compose 2.24.4+) to map tubd's assigned port
(default range 20000-20999). The tub's other host ports (LAN services such as
MQTT) stay as the tub wrote them, and the check keeps them from colliding.

**Data folder ownership.** A tub's `data/` arrives owned by whoever unpacked
it. Services that write there take it over at start: the notes app's
entrypoint `chown`s its folder as root, then drops to the `node` user with
`su-exec`. Templates should say so.

Not built yet: the dashboard and local owner account (Q19), Cloudflare
Tunnel and domains (Q18), the `tub_*` MCP tools, memory caps, digest pinning
of public images, and nightly export backups.

## Measured context (2026-11-13)

- v1's Supabase stack runs on braven-agents (Execution.md Stage 1), not
  newmain as Decision 1 above says. Its 11 containers idle at ~630 MB; the
  per-tub core (Postgres, PostgREST, GoTrue, Storage, Realtime) ~320 MB;
  Postgres alone ~67 MB. `docker stats`, idle.
- Image sizes: `supabase/postgres` 1.24 GB, `storage-api` 862 MB, the dash
  image 214 MB. Hence the default of bundling only a tub's own images.

## Spike results (2026-11-13)

Built `tubs/examples/notes` (standard shape: Node gateway + `supabase/postgres`
17.6.1.136 + GoTrue v2.197.0 + PostgREST v14.12) and `tools/tub.py`
(`export [--offline] [--encrypt]`, `import`). `tubs/examples/notes/test/roundtrip.sh`
starts a fresh tub, adds a user, a note (RLS-owned) and a file, exports plain
and encrypted, imports both as separate projects, and checks sign-in with the
original password, the same user id, the note, the file, anon denied, a wrong
password rejected, and a restart that keeps the data without re-restoring.
**PASS**, 2 m 50 s. Also checked by hand: the README's three commands alone
(no `tub.py`) bring the tub up with its data.

What it found:

- **Bind mounts hide image content.** A named volume is seeded from the
  image on first use; a bind-mounted folder is not. Mounting `./data/...`
  over `/etc/postgresql-custom` hid the image's config includes and Postgres
  refused to start. Mount only the file that must persist
  (`pgsodium_root.key`, generated by the tub's `init.mjs`). The compose lint
  should warn when a bind mount covers a non-empty image path.
- **The vault/pgsodium root key is state.** It must travel with the data or
  vault secrets become unreadable; it lives in `data/` and goes in the zip.
- **Copying v1's init SQL is not safe.** v1's `roles.sql` sets a password for
  `supabase_functions_admin`, which only exists with v1's edge-functions
  script; first-start setup failed halfway. Templates must list each init
  file a component needs.
- **Restore order for Supabase:** structure of app schemas (skipping the
  `public` schema entry the fresh database already has), then `auth` rows,
  then app rows, as the `supabase_admin` superuser with triggers paused,
  `--exit-on-error` on every step. Identity sequences carry over (the next
  note after import got id 2).
- **Sizes:** default zip 56 MB (the 167 MB app image compresses); encrypted
  54 MB; `--offline` 452 MB (adds `supabase/postgres` at 1.27 GB unpacked).
- **Encryption:** 7-Zip AES-256 with the README stored plain; 15 of 16
  entries encrypted; a wrong passphrase is refused; `.env` keeps mode 600.
  The passphrase goes to 7z on stdin, never argv. 7-Zip 24.09 was installed
  on braven-agents for this (`apt install 7zip`).
- **`COMPOSE_PROJECT_NAME`** overrides the file's `name:`, which is how two
  copies of one tub run side by side on one host.

Known gaps, for tubd: public images are pinned by tag, not yet by digest;
`data/files` must be writable by the container's user (uid 1000 here), which
can differ on another host; tubd's override needs Compose `!reset` to drop
the base file's `ports:`; `tub.py` errors are raw tracebacks.

## Build order

1. **Restore spike** (riskiest piece first). **Done 2026-11-13; see
   "Spike results".** Hand-build a standard-template
   tub, sign a user in, export, import into a fresh folder, and confirm the
   user can still sign in, both under tubd-style steps and with plain
   `docker compose up`. The open risk: restoring the `auth` schema into a
   fresh `supabase/postgres` before GoTrue runs its own migrations.
2. tubd core: deploy/export/start/stop/logs/remove over HTTP, with the
   check. **Done 2026-11-13; see "tubd" and "Testing".**
3. Dashboard with the local owner account (Q19).
4. Router, Cloudflare Tunnel and per-tub domains (Q18; Braven's instance
   may use the NPM path, through the infra-changes instance).
5. Shebang auth wiring for tubs that opt in.
6. MCP `tub_*` tools and the template notes.
7. Nightly export backups.

## Testing

- `cd tubd && npm test`: unit tests for the tub.yaml parser, the check, the
  override file, port allocation and `.env` merging. `npx tsc` typechecks.
- `tubd/test/e2e.sh`: builds and starts tubd in Docker, then through the
  API deploys the notes example from source, adds a user, a note and a file,
  exports plain and encrypted zips, deploys each as a new tub and checks the
  user signs in with the same id and sees the same data, refuses a wrong or
  missing passphrase, redeploys changed code (data kept, new code live, the
  copy unchanged), refuses a tub with a named volume, runs the plain zip with
  only `unzip`, `docker load` and `docker compose`, and checks delete needs
  `?confirm=` and removes the folder and image. 4 to 5 minutes.
  2026-11-13: PASS on 4 of 5 runs. The one failure (an encrypted export
  that wasn't encrypted, before the test checked export status codes) wasn't
  reproduced; the test now prints the API's error if it happens again.

## Not now

Tubs from untrusted users; domains other than `shebang.pro` on Braven's
instance; public non-web
ports on this instance; multi-host placement (a tub moves between hosts by
export and import when this is needed); migrating v1 apps into tubs.
