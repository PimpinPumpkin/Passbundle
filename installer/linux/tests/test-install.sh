#!/bin/sh
# Tier 2 checks for install-passbundle.sh on Linux. Run with sudo on a
# disposable machine (CI runner or VM), with the app's bundle in a
# "passbundle" folder next to the install script and a display (DISPLAY) to
# open the app on. It writes machine policies and installs into /opt and
# /usr/share. It ends with the policies applied, for the browser check that follows.

set -u

here=$(cd "$(dirname "$0")" && pwd)
script="$here/../install-passbundle.sh"
app="/opt/passbundle"
entry="/usr/share/applications/com.passbundle.app.desktop"
icon="/usr/share/icons/hicolor/256x256/apps/com.passbundle.app.png"
chrome="/etc/opt/chrome/policies/managed"
edge="/etc/opt/edge/policies/managed"
foreign="$chrome/another-vendor.json"
person="${SUDO_USER:-runner}"
server_url="https://vault.example.test"
token="abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123456"
join_secret="QEFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaW1xdXl8"
org_key="gpfywOP9ms6QtlYF65DLr2GSIBBe-lYsna8wlVbDQYE"
failures=0

check() {
  name=$1
  shift
  if "$@" > /dev/null 2>&1; then
    echo "ok    $name"
  else
    echo "FAIL  $name"
    failures=$((failures + 1))
  fi
}

# Reads a policy file and checks one value, in Python's JSON (so the file must parse).
policy_is() { # file python-expression-of-p
  python3 -I -c "import json, sys; p = json.load(open(sys.argv[1])); sys.exit(0 if ($2) else 1)" "$1"
}

refuses() { # what-it-says args...
  says=$1
  shift
  out=$(sh "$script" "$@" 2>&1) && return 1
  printf '%s' "$out" | grep -q "$says"
}

echo "Refusals"
check "refuses without root" sh -c "sudo -u '$person' sh '$script' 2>&1 | grep -q 'Run this as root'"
check "refuses a server address without HTTPS" refuses "https://" --server-url http://vault.example.test
check "refuses a server address that would break out of the JSON" refuses "https://" --server-url 'https://x.test/","PasswordManagerEnabled":true,"x":"'
check "refuses an enrollment token of the wrong shape" refuses "43 letters" --enrollment-token short
check "refuses a browser it doesn't manage" refuses "chrome, edge" --browsers firefox
check "refuses an option it doesn't have" refuses "Unknown option" --surprise

# Another vendor already has a policy file. We must not touch it.
mkdir -p "$chrome"
printf '{ "ExtensionInstallForcelist": ["cccccccccccccccccccccccccccccccc;https://clients2.google.com/service/update2/crx"] }\n' > "$foreign"
foreign_before=$(cat "$foreign")

echo "Policies only, with no app next to the script"
alone=$(mktemp -d)
cp "$script" "$alone/"
out=$(sh "$alone/install-passbundle.sh" --disable-card-autofill 2>&1)
echo "$out"
check "says it set the policies only" sh -c "printf '%s' \"\$1\" | grep -q 'policies (no passbundle folder'" _ "$out"
check "warns that another file also force-installs" sh -c "printf '%s' \"\$1\" | grep -q 'another-vendor.json also force-installs'" _ "$out"
check "no app without its folder" test ! -e "$app"
check "Chrome forces our extension" policy_is "$chrome/passbundle.json" \
  'p["ExtensionInstallForcelist"] == ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa;https://clients2.google.com/service/update2/crx"]'
check "Edge forces our extension" policy_is "$edge/passbundle.json" \
  'p["ExtensionInstallForcelist"] == ["bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb;https://edge.microsoft.com/extensionwebstorebase/v1/crx"]'
check "Chrome password manager off" policy_is "$chrome/passbundle.json" 'p["PasswordManagerEnabled"] is False'
check "Edge password manager off" policy_is "$edge/passbundle.json" 'p["PasswordManagerEnabled"] is False'
check "Chrome card autofill off" policy_is "$chrome/passbundle.json" 'p["AutofillCreditCardEnabled"] is False'
check "address autofill untouched" policy_is "$chrome/passbundle.json" '"AutofillAddressEnabled" not in p'
check "no extension settings without the console's values" policy_is "$chrome/passbundle.json" '"3rdparty" not in p'
check "the policy files are root's and read-only" sh -c "[ \"\$(stat -c '%U:%G %a' '$chrome/passbundle.json')\" = 'root:root 644' ]"
check "the other vendor's file is untouched" sh -c "[ \"\$(cat '$foreign')\" = \"\$1\" ]" _ "$foreign_before"
rm -rf "$alone"

echo "The app and everything from the MSP console"
sh "$script" --disable-card-autofill --disable-address-autofill --server-url "$server_url/" \
  --enrollment-token "$token" --join-secret "$join_secret" --org-key "$org_key" || failures=$((failures + 1))
check "the app is in /opt" test -x "$app/passbundle"
check "with its core" test -f "$app/lib/libpassbundle_core.so"
check "only root can change it" sh -c "[ \"\$(stat -c %U '$app')\" = root ] && [ -z \"\$(find '$app' -perm -o+w -print -quit)\" ]"
check "it's in the applications menu" grep -qx "Exec=$app/passbundle" "$entry"
check "under its name" grep -qx "Name=PassBundle" "$entry"
check "the desktop entry is valid" desktop-file-validate "$entry"
check "with its icon" cmp -s "$icon" "$app/data/com.passbundle.app.png"
ext='p["3rdparty"]["extensions"]'
check "Chrome extension gets the server address, without a trailing slash" policy_is "$chrome/passbundle.json" \
  "${ext}[\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"][\"environment\"] == {\"base\": \"$server_url\"}"
check "Chrome extension gets the enrollment token" policy_is "$chrome/passbundle.json" \
  "${ext}[\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"][\"enrollmentToken\"] == \"$token\""
check "Chrome extension gets the join secret" policy_is "$chrome/passbundle.json" \
  "${ext}[\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"][\"joinSecret\"] == \"$join_secret\""
check "Edge extension gets the organization key fingerprint" policy_is "$edge/passbundle.json" \
  "${ext}[\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\"][\"orgKeyFingerprint\"] == \"$org_key\""
check "Edge address autofill off" policy_is "$edge/passbundle.json" 'p["AutofillAddressEnabled"] is False'
check "the app gets the server, without a trailing slash" policy_is /etc/passbundle/policy.json "p == {\"ServerUrl\": \"$server_url\"}"
check "the app's policy is root's and read-only" sh -c "[ \"\$(stat -c '%U:%G %a' /etc/passbundle/policy.json)\" = 'root:root 644' ]"

echo "Again, with nothing new"
out=$(sh "$script" --disable-card-autofill --disable-address-autofill --server-url "$server_url/" \
  --enrollment-token "$token" --join-secret "$join_secret" --org-key "$org_key" 2>&1)
echo "$out"
check "nothing changed" sh -c "printf '%s' \"\$1\" | grep -q 'nothing changed'" _ "$out"

echo "The app"
sudo -u "$person" env DISPLAY="${DISPLAY:-:99}" "$app/passbundle" > /dev/null 2>&1 &
sleep 5
check "opens and stays open" pgrep -x passbundle
pkill -x passbundle

echo "A new version"
source_app="$(dirname "$script")/passbundle"
echo "a new build" > "$source_app/data/new-version.txt"
sh "$script" --disable-card-autofill || failures=$((failures + 1))
check "the new app is in place" test -f "$app/data/new-version.txt"
rm -f "$source_app/data/new-version.txt"

echo "Removing"
sh "$script" --remove || failures=$((failures + 1))
check "the app is gone" test ! -e "$app"
check "the menu entry is gone" test ! -e "$entry"
check "the icon is gone" test ! -e "$icon"
check "our Chrome policies are gone" test ! -e "$chrome/passbundle.json"
check "our Edge policies are gone" test ! -e "$edge/passbundle.json"
check "the app's policy is gone" test ! -e /etc/passbundle/policy.json
check "the other vendor's file is still there" sh -c "[ \"\$(cat '$foreign')\" = \"\$1\" ]" _ "$foreign_before"
check "removing again is fine" sh "$script" --remove
rm -f "$foreign"

# Leave the policies applied for the browser check that follows.
sh "$script" --disable-card-autofill > /dev/null

if [ "$failures" -gt 0 ]; then
  echo "$failures failed"
  exit 1
fi
echo "All passed"
