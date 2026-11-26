#!/usr/bin/env bash
# scripts/proxy-instance.sh — an isolated test instance (scripts/chief-instance.sh) with the front
# proxy's private listener on a loopback test address, for scripts/proxy-walk.mts and
# scripts/proxy-browser.mts door. Developer notes only: not for users.
#
#   scripts/proxy-instance.sh up      /tmp/chief-<name>   a new instance, then the proxy
#   scripts/proxy-instance.sh restart /tmp/chief-<name>   the same proxy settings again
#
# up starts a plain instance (its root must be new), then writes inside the root a test proxy
# token (proxy-token, 0600; the server gets only its SHA-256) and a TLS key and certificate
# (proxy-tls/, 0700/0600), and restarts the server with the proxy settings and the two test
# settings of server/testseams.ts: the listener on 127.0.0.3, for 127.0.0.2 only, and the route
# dump in <root>/routes.json. Fakes of systemctl, pnpm, tailscale and docker go first on the
# instance's PATH: a route that the walk calls must never reach the real ones.
set -euo pipefail
cd "$(dirname "$0")/.."
cmd=${1:-}; ROOT=${2:-}
[[ $ROOT =~ ^/tmp/chief-[a-z0-9-]+$ ]] || { echo "usage: $0 up|restart /tmp/chief-<name>" >&2; exit 2; }
case "$cmd" in
  up) scripts/chief-instance.sh up "$ROOT" >/dev/null ;;
  restart) ;;
  *) echo "usage: $0 up|restart /tmp/chief-<name>" >&2; exit 2 ;;
esac
for b in systemctl pnpm tailscale docker; do
  printf '#!/bin/sh\necho "[fake %s] refused in a proxy test instance" >&2\nexit 1\n' "$b" > "$ROOT/bin/$b"
  chmod 755 "$ROOT/bin/$b"
done
if [ ! -f "$ROOT/proxy-token" ]; then
  (umask 077; node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64url"))' > "$ROOT/proxy-token")
fi
if [ ! -f "$ROOT/proxy-tls/cert.pem" ]; then
  mkdir -p "$ROOT/proxy-tls"; chmod 700 "$ROOT/proxy-tls"
  openssl req -x509 -newkey ed25519 -nodes -days 30 -subj /CN=console \
    -keyout "$ROOT/proxy-tls/key.pem" -out "$ROOT/proxy-tls/cert.pem" 2>/dev/null
  chmod 600 "$ROOT/proxy-tls/key.pem" "$ROOT/proxy-tls/cert.pem"
fi
CONSOLE_PROXY_TOKEN_SHA256=$(node -e 'const t=require("fs").readFileSync(process.argv[1],"utf8");process.stdout.write(require("crypto").createHash("sha256").update(t).digest("hex"))' "$ROOT/proxy-token")
export CONSOLE_PROXY_TOKEN_SHA256
export CONSOLE_PROXY_FROM=10.0.0.2 CONSOLE_PROXY_NETWORK=10.0.0.0/16 CONSOLE_PROXY_PORT=${PROXY_TEST_PORT:-39443}
export CONSOLE_PROXY_TLS_DIR=$ROOT/proxy-tls CONSOLE_PROXY_TEST_ADDRESS=127.0.0.3,127.0.0.2 CONSOLE_ROUTE_DUMP=$ROOT/routes.json
scripts/chief-instance.sh restart "$ROOT"
grep -h "\[proxy\]" "$ROOT/log/server.log" | tail -1
