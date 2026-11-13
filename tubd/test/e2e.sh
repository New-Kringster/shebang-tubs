#!/usr/bin/env bash
# End-to-end test of tubd with the notes example, through the real API in the
# real container. Ports: tubd 17070, tubs 21000-21099, plain run 21090.
#
#  1. deploy notes from source (tubd runs init, builds the app)
#  2. add a user, a note and a file
#  3. export plain and encrypted; deploy each as a new tub; check the data
#  4. a wrong passphrase is refused
#  5. redeploy notes with changed code: data stays, new code runs
#  6. a tub with a named volume is refused with the reason
#  7. the plain zip runs with only unzip, docker load and docker compose
#  8. delete needs ?confirm=<name>
set -euo pipefail

repo=$(cd "$(dirname "$0")/../.." && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp}/tubd-e2e.XXXXXX")
export TUBD_DIR="$work/root" TUBD_PORT=17070 TUBD_PORT_RANGE=21000-21099
api=http://127.0.0.1:$TUBD_PORT
email=e2e@example.com pass=e2e-pass-123
mkdir "$TUBD_DIR"

fail() { echo "FAIL: $*" >&2; exit 1; }
step() { echo "--- $*"; }
cleanup() {
  for t in notes notes-copy notes-enc; do
    curl -s -X DELETE "$api/v1/tubs/$t?confirm=$t" -H "authorization: Bearer ${KEY:-x}" >/dev/null 2>&1 || true
  done
  [ -d "$work/plain/notes" ] && (cd "$work/plain/notes" && COMPOSE_PROJECT_NAME=e2e-plain docker compose down >/dev/null 2>&1) || true
  (cd "$repo" && docker compose -p tubd-e2e down >/dev/null 2>&1) || true
  docker run --rm -v "$work:/w" alpine sh -c 'rm -rf /w/*' >/dev/null 2>&1 || true
  rmdir "$work" 2>/dev/null || true
}
trap cleanup EXIT

call() { curl -s -H "authorization: Bearer $KEY" "$@"; }
deploy() { # name zip [passphrase]
  call -X PUT --data-binary "@$2" ${3:+-H "x-tub-passphrase: $3"} "$api/v1/tubs/$1"
}
wait_up() { for _ in $(seq 120); do curl -sf "http://localhost:$1/health" >/dev/null && return; sleep 1; done; fail "port $1 never came up"; }
token() {
  curl -s -X POST "http://localhost:$1/auth/v1/token?grant_type=password" -H 'content-type: application/json' \
    -d "{\"email\":\"$email\",\"password\":\"$pass\"}"
}
verify() { # label port expected-notes-json
  wait_up "$2"
  local r tok; r=$(token "$2")
  [ "$(jq -r .user.id <<<"$r")" = "$uid" ] || fail "$1: sign-in failed or user id changed: $r"
  tok=$(jq -r .access_token <<<"$r")
  [ "$(curl -s "http://localhost:$2/rest/v1/notes?order=id" -H "authorization: Bearer $tok" | jq -c 'map(.body)')" = "$3" ] || fail "$1: notes"
  [ "$(curl -s "http://localhost:$2/rest/v1/notes" | jq length)" = 0 ] || fail "$1: anon can read notes"
  [ "$(curl -s "http://localhost:$2/files/seed.txt")" = 'seed file' ] || fail "$1: file"
  echo "ok   $1"
}
pack() { # src-dir out.zip
  (cd "$1" && 7z a -tzip -bso0 -bsp0 "$2" . '-x!data' '-x!restore' '-x!.env' '-x!images') >/dev/null
}

step "start tubd"
(cd "$repo" && docker compose -p tubd-e2e up -d --build >/dev/null 2>&1)
for _ in $(seq 60); do curl -sf "$api/health" >/dev/null && break; sleep 1; done
KEY=$(docker compose -p tubd-e2e -f "$repo/compose.yaml" exec -T tubd cat "$TUBD_DIR/.tubd/api-key")
[ "$(curl -s -o /dev/null -w '%{http_code}' "$api/v1/tubs")" = 401 ] || fail "API answered without a key"

step "1. deploy from source"
cp -r "$repo/examples/notes" "$work/src"
pack "$work/src" "$work/src.zip"
r=$(deploy notes "$work/src.zip")
[ "$(jq -r .created <<<"$r")" = true ] || fail "deploy: $r"
port=$(jq -r .port <<<"$r")
wait_up "$port"
echo "ok   notes on port $port, built: $(jq -c .built <<<"$r")"

step "2. seed"
curl -s -X POST "http://localhost:$port/auth/v1/signup" -H 'content-type: application/json' \
  -d "{\"email\":\"$email\",\"password\":\"$pass\"}" >/dev/null
uid=$(token "$port" | jq -r .user.id)
tok=$(token "$port" | jq -r .access_token)
curl -sf -X POST "http://localhost:$port/rest/v1/notes" -H "authorization: Bearer $tok" -H 'content-type: application/json' \
  -d '{"body":"seed note"}' >/dev/null || fail "seed note"
curl -sf -X PUT "http://localhost:$port/files/seed.txt" --data-binary 'seed file' >/dev/null || fail "seed file"
verify notes "$port" '["seed note"]'

step "3. export and import"
export_to() { # out.zip json-body
  local code; code=$(call -X POST "$api/v1/tubs/notes/export" -o "$1" -w '%{http_code}' -d "$2")
  [ "$code" = 200 ] || fail "export returned $code: $(head -c 500 "$1")"
}
export_to "$work/plain.zip" '{}'
export_to "$work/enc.zip" '{"passphrase":"correct horse"}'
7z l -slt "$work/enc.zip" | grep -q '^Encrypted = +' || fail "encrypted export is not encrypted"
r=$(deploy notes-copy "$work/plain.zip")
[ "$(jq -c .built <<<"$r")" = '[]' ] || fail "import rebuilt images instead of using the zip's: $r"
verify notes-copy "$(jq -r .port <<<"$r")" '["seed note"]'

step "4. passphrase"
[ "$(deploy notes-enc "$work/enc.zip" wrong | jq -r .error)" = "wrong passphrase, or the zip is damaged" ] || fail "wrong passphrase accepted"
[ "$(deploy notes-enc "$work/enc.zip" | jq -r .error)" = "this tub zip is encrypted; a passphrase is needed" ] || fail "missing passphrase accepted"
r=$(deploy notes-enc "$work/enc.zip" 'correct horse')
verify notes-enc "$(jq -r .port <<<"$r")" '["seed note"]'

step "5. code update keeps data"
sed -i "s#if (req.url === '/health') return res.end('ok');#if (req.url === '/health') return res.end('ok');\n      if (req.url === '/version') return res.end('v2');#" "$work/src/services/app/server.mjs"
pack "$work/src" "$work/src2.zip"
r=$(deploy notes "$work/src2.zip")
[ "$(jq -r .created <<<"$r")" = false ] && [ "$(jq -r .port <<<"$r")" = "$port" ] || fail "update: $r"
verify notes-updated "$port" '["seed note"]'
[ "$(curl -s "http://localhost:$port/version")" = v2 ] || fail "new code is not running"
# The copy built from the same source must not have picked up the new image.
[ "$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$(call "$api/v1/tubs/notes-copy" | jq -r .port)/version")" = 404 ] \
  || fail "notes-copy changed when notes was updated"
echo "ok   /version is v2 on notes only"

step "6. lint"
mkdir -p "$work/bad/svc" && cd "$work/bad"
printf 'name: bad\npublic: { service: web, port: 80 }\n' > tub.yaml
printf 'services:\n  web:\n    image: nginx:alpine\n    volumes: [store:/usr/share/nginx/html]\nvolumes:\n  store:\n' > compose.yaml
7z a -tzip -bso0 -bsp0 "$work/bad.zip" . >/dev/null
cd "$work"
r=$(deploy bad "$work/bad.zip")
jq -e '.issues[0].message | test("named volume")' <<<"$r" >/dev/null || fail "named volume not refused: $r"
[ "$(call "$api/v1/tubs/bad" | jq -r .error)" = "no tub named bad" ] || fail "refused tub was registered"
echo "ok   named volume refused"

step "7. runs without shebang"
mkdir "$work/plain" && cd "$work/plain"
grep -q 'docker compose up -d' <(unzip -p "$work/plain.zip" HOW-TO-RUN.md) || fail "HOW-TO-RUN.md missing the run steps"
unzip -q "$work/plain.zip" -d notes && cd notes
for f in images/*.tar; do docker load -i "$f" >/dev/null; done
APP_PORT=21090 COMPOSE_PROJECT_NAME=e2e-plain docker compose up -d >/dev/null 2>&1
verify plain-compose 21090 '["seed note"]'
cd "$work"

step "8. delete"
[ "$(call -X DELETE "$api/v1/tubs/notes-copy" | jq -r .error)" = confirm_required ] || fail "delete without confirm"
[ "$(call -X DELETE "$api/v1/tubs/notes-copy?confirm=notes-copy" | jq -r .removed)" = notes-copy ] || fail "delete"
[ ! -e "$TUBD_DIR/tubs/notes-copy" ] || fail "folder left behind"
! docker image inspect tub-notes-copy-app >/dev/null 2>&1 || fail "image left behind"
echo "ok   deleted"

echo PASS
