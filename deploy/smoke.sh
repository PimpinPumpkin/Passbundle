#!/usr/bin/env bash
# Starts a PassBundle image the way a fresh install would, on SQLite and on
# PostgreSQL, and checks it works: it's healthy, serves the branded web vault,
# makes an account, signs in, and still has the account after a restart.
#   deploy/smoke.sh <image>
set -euo pipefail
image=$1
net=passbundle-smoke
port=18080
cleanup() {
  docker rm -f passbundle-smoke passbundle-smoke-db > /dev/null 2>&1 || true
  docker network rm "$net" > /dev/null 2>&1 || true
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
  -e POSTGRES_PASSWORD=smoke -e POSTGRES_DB=passbundle postgres:17-alpine > /dev/null
for _ in $(seq 1 30); do
  docker exec passbundle-smoke-db pg_isready -U passbundle > /dev/null 2>&1 && break
  sleep 1
done
email="smoke-pg-$RANDOM@example.test"
hash=$(b64 "hash-$email")
check PostgreSQL -e DATABASE_URL=postgresql://passbundle:smoke@passbundle-smoke-db/passbundle
