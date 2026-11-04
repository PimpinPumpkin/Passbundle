#!/usr/bin/env bash
# Starts a PassBundle image the way a fresh install would, on SQLite and on
# PostgreSQL, and checks it works: it's healthy, serves the branded web vault,
# makes an account, signs in, and still has the account after a restart. Then
# checks the client's address as the hosted service sets it up: behind a
# Cloudflare tunnel, the server believes CF-Connecting-IP only from the
# tunnel's own address, and a header anyone else sends changes nothing.
#   deploy/smoke.sh <image>
set -euo pipefail
image=$1
net=passbundle-smoke
edge=passbundle-smoke-edge
port=18080
cleanup() {
  docker rm -f passbundle-smoke passbundle-smoke-db > /dev/null 2>&1 || true
  docker network rm "$net" "$edge" > /dev/null 2>&1 || true
  docker volume rm passbundle-smoke-data > /dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup
docker network create "$net" > /dev/null

fail() {
  echo "smoke: $*" >&2
  docker logs passbundle-smoke 2>&1 | tail -40 >&2 || true
  exit 1
}

wait_healthy() {
  for _ in $(seq 1 60); do
    [ "$(docker inspect -f '{{.State.Health.Status}}' passbundle-smoke 2>/dev/null)" = healthy ] && return 0
    sleep 2
  done
  fail "never became healthy"
}

start() {
  docker run -d --name passbundle-smoke --network "$net" -p "127.0.0.1:$port:8080" \
    -v passbundle-smoke-data:/data \
    -e DOMAIN="http://localhost:$port" -e SIGNUPS_ALLOWED=true -e SIGNUPS_VERIFY=false \
    "$@" "$image" > /dev/null
  wait_healthy
}

api() { curl -fsS "http://127.0.0.1:$port$1" "${@:2}"; }

# An account, made and signed in to the way the apps do, with stand-in keys:
# the server stores them as opaque strings.
b64() { printf '%s' "$1" | base64 | tr -d '\n'; }
enc() { echo "2.$(b64 "$1-iv")|$(b64 "$1-ct")|$(b64 "$1-mac")"; }
email="smoke-$RANDOM@example.test"
hash=$(b64 "hash-$email")

make_account() {
  token=$(api /identity/accounts/register/send-verification-email -H 'Content-Type: application/json' \
    -d "{\"email\":\"$email\",\"name\":\"Smoke\",\"receiveMarketingEmails\":false}" | tr -d '"')
  api /identity/accounts/register/finish -H 'Content-Type: application/json' -d "{
    \"email\":\"$email\",\"emailVerificationToken\":\"$token\",\"masterPasswordHash\":\"$hash\",
    \"masterPasswordHint\":null,\"userSymmetricKey\":\"$(enc user-key)\",
    \"userAsymmetricKeys\":{\"publicKey\":\"$(b64 public-key)\",\"encryptedPrivateKey\":\"$(enc private-key)\"},
    \"kdf\":0,\"kdfIterations\":600000}" > /dev/null || fail "couldn't make an account"
}

sign_in() {
  access=$(api /identity/connect/token --data-urlencode grant_type=password --data-urlencode "username=$email" \
    --data-urlencode "password=$hash" --data-urlencode "scope=api offline_access" --data-urlencode client_id=web \
    --data-urlencode deviceType=10 --data-urlencode deviceIdentifier=3f8b6a2e-0d4c-4b61-9a37-5c0e00000001 \
    --data-urlencode deviceName=smoke | sed -E 's/.*"access_token":"([^"]+)".*/\1/') || fail "couldn't sign in"
  api /api/accounts/profile -H "Authorization: Bearer $access" | grep -q "\"email\":\"$email\"" || fail "no profile"
}

check() {
  local db=$1
  shift
  start "$@"
  api / | grep -q "PassBundle Web vault" || fail "$db: the web vault isn't PassBundle's"
  make_account
  sign_in
  docker restart passbundle-smoke > /dev/null
  wait_healthy
  sign_in
  echo "smoke: $db ok"
  docker rm -f passbundle-smoke > /dev/null
  docker volume rm passbundle-smoke-data > /dev/null
}

check SQLite

docker run -d --name passbundle-smoke-db --network "$net" -e POSTGRES_USER=passbundle \
  -e POSTGRES_PASSWORD=smoke -e POSTGRES_DB=passbundle \
  postgres:17-alpine@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24 > /dev/null
for _ in $(seq 1 30); do
  docker exec passbundle-smoke-db pg_isready -U passbundle > /dev/null 2>&1 && break
  sleep 1
done
email="smoke-pg-$RANDOM@example.test"
hash=$(b64 "hash-$email")
check PostgreSQL -e DATABASE_URL=postgresql://passbundle:smoke@passbundle-smoke-db/passbundle

# The client's address, as ops' hosting/compose.yaml sets it up: the tunnel
# has a fixed address on the stack's network, and the server believes the
# visitor's address (CF-Connecting-IP, which Cloudflare sets itself) only from
# there. Its stand-in here is a container at that address, with the image's
# own curl. Requests from anywhere else (this machine, through the published
# port) keep their own address, whatever headers they send.
tunnel_ip=172.31.250.2
docker network create --subnet 172.31.250.0/24 --ip-range 172.31.250.128/25 "$edge" > /dev/null
hosted=(-e DOMAIN=https://vault.example.com -e SIGNUPS_ALLOWED=true -e SIGNUPS_VERIFY=false)

# A public DOMAIN without IP_HEADER: the server refuses to start, and says what to set.
set +e
refused=$(timeout 60 docker run --rm --network "$edge" "${hosted[@]}" "$image" 2>&1)
code=$?
set -e
[ "$code" -ne 0 ] && [ "$code" -ne 124 ] || fail "started on a public DOMAIN without IP_HEADER (exit $code)"
echo "$refused" | grep -q "set IP_HEADER" || fail "refused without saying to set IP_HEADER: $refused"

docker run -d --name passbundle-smoke --network "$edge" -p "127.0.0.1:$port:8080" \
  -v passbundle-smoke-data:/data "${hosted[@]}" \
  -e IP_HEADER=CF-Connecting-IP -e IP_HEADER_TRUSTED_PROXIES="$tunnel_ip" "$image" > /dev/null
wait_healthy
email="smoke-ip-$RANDOM@example.test"
hash=$(b64 "hash-$email")
make_account
sign_in

# A sign-in request records the address the server believed, and answers with it.
ask() {
  printf '{"email":"%s","publicKey":"%s","deviceIdentifier":"3f8b6a2e-0d4c-4b61-9a37-5c0e00000001","accessCode":"smoke-access-code-0123456"}' \
    "$email" "$(head -c 294 /dev/urandom | base64 | tr -d '\n')"
}
seen() { sed -E 's/.*"requestIpAddress":"([^"]*)".*/\1/'; }
from_here=$(api /api/auth-requests -H 'Content-Type: application/json' -H 'Device-Type: 10' \
  -H 'CF-Connecting-IP: 203.0.113.9' -H 'X-Real-IP: 203.0.113.9' -H 'X-Forwarded-For: 203.0.113.9' -d "$(ask)" | seen)
[ -n "$from_here" ] && [ "$from_here" != 203.0.113.9 ] || fail "believed a forged address from outside the tunnel: $from_here"
through_tunnel() {
  docker run --rm --network "$edge" --ip "$tunnel_ip" --entrypoint curl "$image" -fsS \
    http://passbundle-smoke:8080/api/auth-requests -H 'Content-Type: application/json' -H 'Device-Type: 10' "$@" -d "$(ask)" | seen
}
visitor=$(through_tunnel -H 'CF-Connecting-IP: 198.51.100.23')
[ "$visitor" = 198.51.100.23 ] || fail "didn't take the visitor's address from the tunnel: $visitor"
other_header=$(through_tunnel -H 'X-Real-IP: 198.51.100.24')
[ "$other_header" = "$tunnel_ip" ] || fail "took the address from a header it wasn't told to: $other_header"
echo "smoke: client address ok (outside: $from_here, through the tunnel: $visitor)"
