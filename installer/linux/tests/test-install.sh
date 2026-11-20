#!/bin/sh
# Tier 2 checks for install-passbundle.sh on Linux. Run with sudo on a
# disposable machine (CI runner or VM), with the app's bundle in a
# "passbundle" folder next to the install script, a display (DISPLAY) to
# open the app on, and xdg-utils and desktop-file-utils. It writes machine
# policies and installs into /opt and /usr/share. It ends with the policies
# applied, for the browser check that follows.
#
#   sudo sh test-install.sh [passbundle_<version>_amd64.deb]
#
# With the app's .deb, made from the same folder (passbundle-apps,
# tools/linux-packages.sh), it also checks the package installs what the
# script does, and that the script and the package agree on who has the app
# (DESIGN.md, "Linux packages"). It installs and removes that package with apt.

set -u

here=$(cd "$(dirname "$0")" && pwd)
script="$here/../install-passbundle.sh"
app="/opt/passbundle"
entry="/usr/share/applications/com.passbundle.app.desktop"
# What update-desktop-database lists for each MIME type, links included.
mime_cache="/usr/share/applications/mimeinfo.cache"
icon="/usr/share/icons/hicolor/256x256/apps/com.passbundle.app.png"
chrome="/etc/opt/chrome/policies/managed"
edge="/etc/opt/edge/policies/managed"
firefox="/etc/firefox/policies/policies.json"
firefox_added="/etc/passbundle/firefox-policies-added"
foreign="$chrome/another-vendor.json"
deb="${1:-}"
if [ -n "$deb" ]; then
  deb=$(cd "$(dirname "$deb")" && pwd)/$(basename "$deb")
fi
person="${SUDO_USER:-runner}"
person_home=$(getent passwd "$person" | cut -d: -f6)
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

# Firefox reads /etc/firefox/policies/policies.json instead of a policies.json
# in its installation's own folder, so the script won't write it while one of
# the folders it looks in has one. This machine's own Firefox may have one: it
# goes aside for the test and comes back at the end, so the checks below see
# what the script does without one, and then with one of the test's own.
firefox_installs=$(sed -n 's/^FIREFOX_INSTALLS="\(.*\)"$/\1/p' "$script")
firefox_aside=$(mktemp -d)
for dir in $firefox_installs; do
  if [ -e "$dir/distribution/policies.json" ]; then
    echo "This machine's Firefox in $dir has its own policies.json; it's set aside until the end:"
    cat "$dir/distribution/policies.json"
    mkdir -p "$firefox_aside$dir"
    mv "$dir/distribution/policies.json" "$firefox_aside$dir/" || echo "couldn't set it aside, so the Firefox checks below will fail"
  fi
done

# Reads a policy file and checks one value, in Python's JSON (so the file must parse).
policy_is() { # file python-expression-of-p
  python3 -I -c "import json, sys; p = json.load(open(sys.argv[1])); sys.exit(0 if ($2) else 1)" "$1"
}

# Every path the app's install puts on the computer, with its type, owner,
# and mode, and each file's SHA-256: what the app's package installs too.
installed() {
  find "$app" "$entry" "$icon" -printf '%p %y %u:%g %m\n' 2> /dev/null | LC_ALL=C sort
  find "$app" "$entry" "$icon" -type f -exec sha256sum {} + 2> /dev/null | LC_ALL=C sort -k2
}

# The package that has a path, if any (what the script and the app ask).
package_of() {
  dpkg-query -S "$1" 2> /dev/null | sed -n '1s/:.*//p'
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
# A line break or other control character. grep checks line by line, so each
# address, token, and secret here has a line that would pass alone.
nl='
'
cr=$(printf '\r')
tab=$(printf '\t')
check "refuses a server address with a line break in it" refuses "https://" --server-url "$server_url$nl\"}, \"PasswordManagerEnabled\": true, \"x\": {\"y\": \""
check "refuses a server address with a carriage return and line break in it" refuses "https://" --server-url "https://x.test$cr$nl$server_url"
check "refuses an enrollment token with a line break in it" refuses "43 letters" --enrollment-token "$token$nl\", \"PasswordManagerEnabled\": true, \"x\": \""
check "refuses a join secret with a line break in it" refuses "43 letters" --join-secret "x$nl$join_secret"
check "refuses an organization key fingerprint with a line break after it" refuses "43 letters" --org-key "$org_key$nl"
check "refuses a browser list with a line break in it" refuses "chrome, edge" --browsers "chrome${nl}edge"
check "refuses a browser list with a tab in it" refuses "chrome, edge" --browsers "chrome${tab}edge"

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
check "Chrome takes native-messaging hosts from the machine only" policy_is "$chrome/passbundle.json" 'p["NativeMessagingUserLevelHosts"] is False'
check "Edge takes native-messaging hosts from the machine only" policy_is "$edge/passbundle.json" 'p["NativeMessagingUserLevelHosts"] is False'
check "Chrome card autofill off" policy_is "$chrome/passbundle.json" 'p["AutofillCreditCardEnabled"] is False'
check "address autofill untouched" policy_is "$chrome/passbundle.json" '"AutofillAddressEnabled" not in p'
check "Firefox password manager and card autofill off, and nothing else" policy_is "$firefox" \
  'p == {"policies": {"PasswordManagerEnabled": False, "OfferToSaveLogins": False, "AutofillCreditCardEnabled": False}}'
check "no extension settings without the console's values" policy_is "$chrome/passbundle.json" '"3rdparty" not in p'
check "our own extension ID is nowhere in them" sh -c "! grep -q cenoidjoogmoieibpcokkafjnaabhokg '$chrome/passbundle.json' '$edge/passbundle.json'"
check "the policy files are root's and read-only" sh -c "[ \"\$(stat -c '%U:%G %a' '$chrome/passbundle.json')\" = 'root:root 644' ]"
check "the other vendor's file is untouched" sh -c "[ \"\$(cat '$foreign')\" = \"\$1\" ]" _ "$foreign_before"
rm -rf "$alone"

echo "The app and everything from the MSP console"
sh "$script" --disable-card-autofill --disable-address-autofill --server-url "$server_url/" \
  --enrollment-token "$token" --join-secret "$join_secret" --org-key "$org_key" || failures=$((failures + 1))
check "the app is in /opt" test -x "$app/passbundle"
check "with its core" test -f "$app/lib/libpassbundle_core.so"
check "only root can change it" sh -c "[ \"\$(stat -c %U '$app')\" = root ] && [ -z \"\$(find '$app' -perm -o+w -print -quit)\" ]"
# %u: a passbundle:// link is the app's first argument.
check "it's in the applications menu" grep -qx "Exec=$app/passbundle %u" "$entry"
check "under its name" grep -qx "Name=PassBundle" "$entry"
check "the desktop entry is valid" desktop-file-validate "$entry"
check "with its icon" cmp -s "$icon" "$app/data/com.passbundle.app.png"
# passbundle:// links, Duo's way back at sign-in, open the installed app for
# everyone here: its entry takes them, the system's cache lists it, and
# xdg-mime gives it to the person.
check "it takes passbundle:// links" grep -qx "MimeType=x-scheme-handler/passbundle;" "$entry"
check "the system's cache lists it for passbundle:// links" grep -qx "x-scheme-handler/passbundle=com.passbundle.app.desktop;" "$mime_cache"
check "passbundle:// links open it for the person" sh -c "[ \"\$(sudo -H -u '$person' xdg-mime query default x-scheme-handler/passbundle)\" = com.passbundle.app.desktop ]"
ext='p["3rdparty"]["extensions"]'
check "Chrome extension gets the server address, without a trailing slash" policy_is "$chrome/passbundle.json" \
  "${ext}[\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"][\"environment\"] == {\"base\": \"$server_url\"}"
check "Chrome extension gets the enrollment token" policy_is "$chrome/passbundle.json" \
  "${ext}[\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"][\"enrollmentToken\"] == \"$token\""
check "Chrome extension gets the join secret" policy_is "$chrome/passbundle.json" \
  "${ext}[\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"][\"joinSecret\"] == \"$join_secret\""
check "Edge extension gets the organization key fingerprint" policy_is "$edge/passbundle.json" \
  "${ext}[\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\"][\"orgKeyFingerprint\"] == \"$org_key\""
# A build loaded by hand has our own ID, so the same settings go there too.
# Nothing force-installs it: it has no update URL.
everything="{\"environment\": {\"base\": \"$server_url\"}, \"enrollmentToken\": \"$token\", \"joinSecret\": \"$join_secret\", \"orgKeyFingerprint\": \"$org_key\"}"
check "a Chrome extension loaded by hand gets the same settings, and no other extension does" policy_is "$chrome/passbundle.json" \
  "$ext == {\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\": $everything, \"cenoidjoogmoieibpcokkafjnaabhokg\": $everything}"
check "an Edge extension loaded by hand gets the same settings, and no other extension does" policy_is "$edge/passbundle.json" \
  "$ext == {\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\": $everything, \"cenoidjoogmoieibpcokkafjnaabhokg\": $everything}"
check "Chrome still forces only its store extension" policy_is "$chrome/passbundle.json" \
  'p["ExtensionInstallForcelist"] == ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa;https://clients2.google.com/service/update2/crx"]'
check "Edge still forces only its store extension" policy_is "$edge/passbundle.json" \
  'p["ExtensionInstallForcelist"] == ["bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb;https://edge.microsoft.com/extensionwebstorebase/v1/crx"]'
check "Edge address autofill off" policy_is "$edge/passbundle.json" 'p["AutofillAddressEnabled"] is False'
check "Firefox password manager, card, and address autofill off" policy_is "$firefox" \
  'p == {"policies": {"PasswordManagerEnabled": False, "OfferToSaveLogins": False, "AutofillCreditCardEnabled": False, "AutofillAddressEnabled": False}}'
check "Firefox's policies are root's and read-only" sh -c "[ \"\$(stat -c '%U:%G %a' '$firefox')\" = 'root:root 644' ]"
check "the app gets the server, without a trailing slash, and the organization key fingerprint" policy_is /etc/passbundle/policy.json \
  "p == {\"ServerUrl\": \"$server_url\", \"OrgKeyFingerprint\": \"$org_key\"}"
check "the app's policy is root's and read-only" sh -c "[ \"\$(stat -c '%U:%G %a' /etc/passbundle/policy.json)\" = 'root:root 644' ]"
check "no package has the app" test -z "$(package_of "$app/passbundle")"
# What the app's package must install the same.
script_installed=$(installed)

echo "Again, with nothing new"
out=$(sh "$script" --disable-card-autofill --disable-address-autofill --server-url "$server_url/" \
  --enrollment-token "$token" --join-secret "$join_secret" --org-key "$org_key" 2>&1)
echo "$out"
check "nothing changed" sh -c "printf '%s' \"\$1\" | grep -q 'nothing changed'" _ "$out"

echo "Card and address autofill left as they are"
sh "$script" --server-url "$server_url/" --enrollment-token "$token" --join-secret "$join_secret" \
  --org-key "$org_key" > /dev/null || failures=$((failures + 1))
check "Chrome card autofill no longer set" policy_is "$chrome/passbundle.json" '"AutofillCreditCardEnabled" not in p'
check "Firefox keeps only its password manager off" policy_is "$firefox" \
  'p == {"policies": {"PasswordManagerEnabled": False, "OfferToSaveLogins": False}}'

echo "The browsers' password managers kept"
sh "$script" --keep-browser-password-manager --server-url "$server_url/" --enrollment-token "$token" \
  --join-secret "$join_secret" --org-key "$org_key" > /dev/null || failures=$((failures + 1))
check "Chrome password manager no longer set" policy_is "$chrome/passbundle.json" '"PasswordManagerEnabled" not in p'
check "our Firefox policies are gone" test ! -e "$firefox"

echo "Another vendor's Firefox policies"
# Firefox reads one policies file, so ours are added to theirs: only policies
# it doesn't have, and nothing of theirs changes. One of theirs is already off.
mkdir -p "$(dirname "$firefox")"
printf '{ "policies": { "DisableTelemetry": true, "OfferToSaveLogins": false } }\n' > "$firefox"
chmod 640 "$firefox"
out=$(sh "$script" --disable-card-autofill 2>&1)
echo "$out"
check "adds ours to theirs" policy_is "$firefox" \
  "p['policies'] == {'DisableTelemetry': True, 'OfferToSaveLogins': False, 'PasswordManagerEnabled': False, 'AutofillCreditCardEnabled': False}"
check "keeps their file's owner and mode" sh -c "[ \"\$(stat -c '%U:%G %a' '$firefox')\" = 'root:root 640' ]"
check "lists only the policies it added" sh -c "[ \"\$(cat '$firefox_added')\" = \"\$(printf 'PasswordManagerEnabled\nAutofillCreditCardEnabled')\" ]"
check "its list is root's and read-only" sh -c "[ \"\$(stat -c '%U:%G %a' '$firefox_added')\" = 'root:root 644' ]"
out=$(sh "$script" --disable-card-autofill 2>&1)
check "again, nothing changed" sh -c "printf '%s' \"\$1\" | grep -q 'nothing changed'" _ "$out"
sh "$script" --keep-browser-password-manager --disable-card-autofill > /dev/null || failures=$((failures + 1))
check "the password manager kept: takes back its own password policy, not theirs" policy_is "$firefox" \
  "p['policies'] == {'DisableTelemetry': True, 'OfferToSaveLogins': False, 'AutofillCreditCardEnabled': False}"
sh "$script" --remove > /dev/null || failures=$((failures + 1))
check "removing takes back the rest of ours, and leaves theirs" policy_is "$firefox" \
  "p == {'policies': {'DisableTelemetry': True, 'OfferToSaveLogins': False}}"
check "and their file's owner and mode" sh -c "[ \"\$(stat -c '%U:%G %a' '$firefox')\" = 'root:root 640' ]"
check "and its list is gone" test ! -e "$firefox_added"
printf '{ "policies": { "DisableTelemetry": true, } }\n' > "$firefox"
firefox_before=$(cat "$firefox")
out=$(sh "$script" --disable-card-autofill 2>&1)
check "a file that isn't JSON: says it leaves it alone" sh -c "printf '%s' \"\$1\" | grep -q 'policies.json is another vendor.*left alone'" _ "$out"
check "and leaves it alone" sh -c "[ \"\$(cat '$firefox')\" = \"\$1\" ]" _ "$firefox_before"
sh "$script" --remove > /dev/null || failures=$((failures + 1))
check "removing leaves it alone too" sh -c "[ \"\$(cat '$firefox')\" = \"\$1\" ]" _ "$firefox_before"
rm -f "$firefox"
sh "$script" --disable-card-autofill --disable-address-autofill --server-url "$server_url/" \
  --enrollment-token "$token" --join-secret "$join_secret" --org-key "$org_key" > /dev/null || failures=$((failures + 1))

echo "A Firefox installation with its own policies file"
# /usr/local/firefox is one of the folders the script looks in, and not where
# this machine's Firefox is.
installation="/usr/local/firefox"
if [ -e "$installation" ]; then
  echo "FAIL  $installation is already there, so these checks can't use it"
  failures=$((failures + 1))
else
  mkdir -p "$installation/distribution"
  printf '{ "policies": { "DisableAppUpdate": true } }\n' > "$installation/distribution/policies.json"
  installation_before=$(cat "$installation/distribution/policies.json")
  out=$(sh "$script" --disable-card-autofill --disable-address-autofill --server-url "$server_url/" \
    --enrollment-token "$token" --join-secret "$join_secret" --org-key "$org_key" 2>&1)
  echo "$out"
  check "says so, naming that file and what to set in it" sh -c "printf '%s' \"\$1\" | grep -q 'policies of its own in $installation/distribution/policies.json.*Set PasswordManagerEnabled, OfferToSaveLogins, AutofillCreditCardEnabled, AutofillAddressEnabled to false'" _ "$out"
  check "takes our system-wide Firefox file away, so Firefox reads theirs again" test ! -e "$firefox"
  check "leaves theirs as it was" sh -c "[ \"\$(cat '$installation/distribution/policies.json')\" = \"\$1\" ]" _ "$installation_before"
  sh "$script" --disable-card-autofill > /dev/null || failures=$((failures + 1))
  check "and doesn't write ours again" test ! -e "$firefox"
  check "Chrome's policies are still written" policy_is "$chrome/passbundle.json" 'p["PasswordManagerEnabled"] is False'
  rm -rf "$installation"
  sh "$script" --disable-card-autofill --disable-address-autofill --server-url "$server_url/" \
    --enrollment-token "$token" --join-secret "$join_secret" --org-key "$org_key" > /dev/null || failures=$((failures + 1))
  check "without it, ours is written again" policy_is "$firefox" 'p["policies"]["PasswordManagerEnabled"] is False'
fi

echo "The app"
sudo -u "$person" env DISPLAY="${DISPLAY:-:99}" "$app/passbundle" > /dev/null 2>&1 &
sleep 5
check "opens and stays open" pgrep -x passbundle
pkill -x passbundle

echo "A passbundle:// link"
# Opened as a browser hands one on, the link reaches the installed app, which
# leaves it in the person's data folder for the copy signing in and ends
# (passbundle-apps, core/src/two_step.rs, hand_over). In the background, in
# case it opens a window instead.
link="passbundle://duo-callback?code=c0de&state=InstallerTest"
handed="$person_home/.local/share/PassBundle/duo-callback.txt"
rm -f "$handed"
sudo -H -u "$person" env DISPLAY="${DISPLAY:-:99}" xdg-open "$link" > /dev/null 2>&1 &
waited=0
while [ ! -s "$handed" ] && [ "$waited" -lt 30 ]; do
  sleep 1
  waited=$((waited + 1))
done
check "a passbundle:// link reaches the installed app" sh -c "[ \"\$(cat '$handed')\" = '$link' ]"
pkill -x passbundle
rm -f "$handed"

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
check "nothing in the system's cache takes passbundle:// links" sh -c "! grep -q '^x-scheme-handler/passbundle=' '$mime_cache'"
check "nothing opens them for the person" sh -c "[ -z \"\$(sudo -H -u '$person' xdg-mime query default x-scheme-handler/passbundle)\" ]"
check "the icon is gone" test ! -e "$icon"
check "our Chrome policies are gone" test ! -e "$chrome/passbundle.json"
check "our Edge policies are gone" test ! -e "$edge/passbundle.json"
check "the app's policy is gone" test ! -e /etc/passbundle/policy.json
check "our Firefox policies are gone" test ! -e "$firefox"
check "and no list of Firefox policies is left" test ! -e "$firefox_added"
check "the other vendor's file is still there" sh -c "[ \"\$(cat '$foreign')\" = \"\$1\" ]" _ "$foreign_before"
check "removing again is fine" sh "$script" --remove
rm -f "$foreign"

if [ -n "$deb" ]; then
  echo "Installed by the app's .deb"
  check "the .deb installs" apt-get install -y -q "$deb"
  check "it installs what the script does: the same paths, owners, modes, and contents" \
    sh -c "[ \"\$1\" = \"\$2\" ]" _ "$(installed)" "$script_installed"
  check "the package has the app" test "$(package_of "$app/passbundle")" = passbundle
  check "the system's cache lists it for passbundle:// links" grep -qx "x-scheme-handler/passbundle=com.passbundle.app.desktop;" "$mime_cache"
  check "passbundle:// links open it for the person" sh -c "[ \"\$(sudo -H -u '$person' xdg-mime query default x-scheme-handler/passbundle)\" = com.passbundle.app.desktop ]"
  check "no policies come with it" sh -c "[ ! -e '$chrome/passbundle.json' ] && [ ! -e '$edge/passbundle.json' ] && [ ! -e /etc/passbundle ]"

  echo "The script, where the package has the app"
  out=$(sh "$script" --disable-card-autofill --server-url "$server_url/" --enrollment-token "$token" \
    --join-secret "$join_secret" --org-key "$org_key" 2>&1)
  echo "$out"
  check "says the package has the app, and leaves it alone" sh -c "printf '%s' \"\$1\" | grep -q 'came from the passbundle package, so apt updates and removes it'" _ "$out"
  check "the app is as the package installed it" sh -c "[ \"\$1\" = \"\$2\" ]" _ "$(installed)" "$script_installed"
  check "the package still has it" test "$(package_of "$app/passbundle")" = passbundle
  check "it still sets the browser policies" policy_is "$chrome/passbundle.json" 'p["PasswordManagerEnabled"] is False'
  check "and the app's policy" policy_is /etc/passbundle/policy.json "p == {\"ServerUrl\": \"$server_url\"}"
  out=$(sh "$script" --disable-card-autofill --server-url "$server_url/" --enrollment-token "$token" \
    --join-secret "$join_secret" --org-key "$org_key" 2>&1)
  check "again, nothing changed" sh -c "printf '%s' \"\$1\" | grep -q 'nothing changed'" _ "$out"
  out=$(sh "$script" --remove 2>&1)
  echo "$out"
  check "--remove says how to remove the package's app" sh -c "printf '%s' \"\$1\" | grep -q 'remove it with apt remove passbundle'" _ "$out"
  check "and leaves it" sh -c "[ \"\$1\" = \"\$2\" ]" _ "$(installed)" "$script_installed"
  check "and takes the policies away" sh -c "[ ! -e '$chrome/passbundle.json' ] && [ ! -e /etc/passbundle/policy.json ]"

  echo "Removing the package"
  sh "$script" --disable-card-autofill --server-url "$server_url/" > /dev/null || failures=$((failures + 1))
  check "the package removes" apt-get remove -y -q passbundle
  check "the app is gone" test ! -e "$app"
  check "the menu entry is gone" test ! -e "$entry"
  check "the icon is gone" test ! -e "$icon"
  check "its copyright file is gone" test ! -e /usr/share/doc/passbundle
  check "no package has the app" test -z "$(package_of "$app/passbundle")"
  check "nothing in the system's cache takes passbundle:// links" sh -c "! grep -q '^x-scheme-handler/passbundle=' '$mime_cache'"
  check "nothing opens them for the person" sh -c "[ -z \"\$(sudo -H -u '$person' xdg-mime query default x-scheme-handler/passbundle)\" ]"
  check "the script's app policy stays" policy_is /etc/passbundle/policy.json "p == {\"ServerUrl\": \"$server_url\"}"
  check "and its browser policies" policy_is "$chrome/passbundle.json" 'p["PasswordManagerEnabled"] is False'
  apt-get purge -y -q passbundle > /dev/null 2>&1
  check "purging it leaves the script's app policy too" test -f /etc/passbundle/policy.json

  echo "The package, where the script has the app"
  sh "$script" --disable-card-autofill > /dev/null || failures=$((failures + 1))
  check "the script installed the app" sh -c "[ \"\$1\" = \"\$2\" ]" _ "$(installed)" "$script_installed"
  out=$(apt-get install -y -q "$deb" 2>&1)
  status=$?
  printf '%s\n' "$out" | tail -n 5
  check "the package won't go over it" test "$status" -ne 0
  check "and says how to switch: the script's --remove, then the package" \
    sh -c "printf '%s' \"\$1\" | grep -q 'install-passbundle.sh' && printf '%s' \"\$1\" | grep -q -- '--remove'" _ "$out"
  check "the script's app is as it was" sh -c "[ \"\$1\" = \"\$2\" ]" _ "$(installed)" "$script_installed"
  check "and no package has it" test -z "$(package_of "$app/passbundle")"
  dpkg --purge passbundle > /dev/null 2>&1
  sh "$script" --remove > /dev/null || failures=$((failures + 1))
  check "the script removes its app again" test ! -e "$app"
fi

# This machine's own Firefox policies back where they were.
for dir in $firefox_installs; do
  if [ -e "$firefox_aside$dir/policies.json" ]; then
    mv "$firefox_aside$dir/policies.json" "$dir/distribution/policies.json"
  fi
done
rm -rf "$firefox_aside"

# Leave the policies applied for the browser check that follows.
sh "$script" --disable-card-autofill > /dev/null

if [ "$failures" -gt 0 ]; then
  echo "$failures failed"
  exit 1
fi
echo "All passed"
