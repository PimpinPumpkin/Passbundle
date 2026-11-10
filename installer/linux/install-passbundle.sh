#!/bin/sh
# Sets PassBundle up on a Linux machine: the app and browser policies.
#
# Run as root, typically from an RMM, with the app's bundle in a "passbundle"
# folder next to this script (the RMM package). It installs the app to
# /opt/passbundle with a desktop entry and icon, so it's in the applications
# menu, replacing an older one. For each browser (Chrome and Edge) it:
#   - force-installs the PassBundle extension (IDs are fixed in this script, never passed in),
#   - turns off the browser's own password saving and filling,
#   - optionally turns off card and address autofill,
#   - optionally gives the extension its server address and the client's
#     enrollment token, join secret, and organization key fingerprint, so
#     people join the client after they sign in (the extension asks first,
#     and checks the organization's key against the fingerprint). A PassBundle
#     extension loaded by hand gets the same settings, under PassBundle's own
#     ID, which is fixed in this script too and never force-installed.
# Firefox gets the same password, card, and address policies, and nothing
# else: no extension (ours isn't signed by Mozilla yet). The password ones are
# Firefox's PasswordManagerEnabled and OfferToSaveLogins, both off unless
# --keep-browser-password-manager. They go in Firefox's system-wide policies
# file (FIREFOX_POLICY below says which Firefox builds read it).
# Without the app's folder, it sets the policies only. The policies are a
# file of our own in each browser's managed policies folder; other vendors'
# files are left alone. Firefox reads only one policies file, so when another
# vendor's is there, ours are added to it (with python3, where the computer
# has it), and nothing of theirs is changed.
# The desktop agent isn't installed: on Linux it has no tray and no biometric
# unlock yet. Running it again changes nothing.
#
#   sudo ./install-passbundle.sh --browsers chrome,edge --disable-card-autofill
#   sudo ./install-passbundle.sh --server-url https://vault.example.com --enrollment-token <token> \
#     --join-secret <secret> --org-key <fingerprint>
#   (the MSP console's install command has all three)
#   sudo ./install-passbundle.sh --remove

set -eu

APP_SOURCE="$(cd "$(dirname "$0")" && pwd)/passbundle"
APP="/opt/passbundle"
APP_ID="com.passbundle.app"
DESKTOP_ENTRY="/usr/share/applications/$APP_ID.desktop"
ICON="/usr/share/icons/hicolor/256x256/apps/$APP_ID.png"
POLICY_FILE="passbundle.json"
# The app's own policy: the server it signs in to (docs/core.md, "Servers").
APP_POLICY="/etc/passbundle/policy.json"
CHROME_POLICIES="/etc/opt/chrome/policies/managed"
EDGE_POLICIES="/etc/opt/edge/policies/managed"
# Firefox's system-wide policies file, the one Mozilla documents for Linux.
# Firefox reads one policies file, so ours is written whole only where there's
# none or it's ours; another vendor's gets our policies added to it, and
# nothing of theirs is changed. Mozilla's docs say the Flatpak build can't read
# this file (it reads policies from a folder of its own under
# /var/lib/flatpak, which this script doesn't write); they don't say whether
# the Snap or a distribution's own Firefox package reads it.
FIREFOX_POLICY="/etc/firefox/policies/policies.json"
# The Firefox policies this script added to another vendor's policies file,
# one name per line, so that it takes back only those.
FIREFOX_ADDED="/etc/passbundle/firefox-policies-added"
# The only extensions this can ever force-install, the same as
# Install-PassBundle.ps1's. Placeholders until the store listings exist.
CHROME_EXTENSION="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
CHROME_UPDATE_URL="https://clients2.google.com/service/update2/crx"
EDGE_EXTENSION="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
EDGE_UPDATE_URL="https://edge.microsoft.com/extensionwebstorebase/v1/crx"
# PassBundle's own extension ID, which a Chrome or Edge build loaded by hand
# has (from the public key in its manifest; passbundle-clients' brand.json,
# extension.chromiumId). It gets the extension's settings, like the store
# IDs. It is never force-installed: it has no update URL. A browser gives this
# ID to anything loaded by hand with our public key, which takes developer
# mode and the person's own action on this machine; the same is true of a
# store ID. See DESIGN.md, "PassBundle's extension IDs".
OWN_EXTENSION="cenoidjoogmoieibpcokkafjnaabhokg"

fail() {
  echo "$1" >&2
  exit 1
}

browsers="chrome edge"
card=""
address=""
keep_password_manager=""
server_url=""
token=""
join_secret=""
org_key=""
remove=""

# True when $1 has no newline, carriage return, or other control character.
plain() {
  case "$1" in
    *[[:cntrl:]]*) return 1 ;;
  esac
}

# True when all of $2 matches the extended regex $1. grep matches line by
# line, so without plain a value with a newline would pass if one line did.
matches() {
  plain "$2" && printf '%s' "$2" | grep -Eq "$1"
}

# A token, join secret, or key fingerprint: 32 bytes in unpadded base64url.
check_secret() {
  matches '^[A-Za-z0-9_-]{43}$' "$2" || fail "$1 should be 43 letters, digits, - or _ (from the MSP console)."
}

while [ $# -gt 0 ]; do
  case "$1" in
    --browsers)
      [ $# -ge 2 ] || fail "--browsers needs chrome, edge, or chrome,edge."
      plain "$2" || fail "--browsers takes chrome, edge, or chrome,edge."
      browsers=$(printf '%s' "$2" | tr ',' ' ')
      for b in $browsers; do
        case "$b" in
          chrome | edge) ;;
          *) fail "--browsers takes chrome, edge, or chrome,edge, not $b." ;;
        esac
      done
      shift
      ;;
    --disable-card-autofill) card=yes ;;
    --disable-address-autofill) address=yes ;;
    --keep-browser-password-manager) keep_password_manager=yes ;;
    --server-url)
      [ $# -ge 2 ] || fail "--server-url needs the server's address."
      # HTTPS only, and nothing that could break out of the policy's JSON.
      matches '^https://[A-Za-z0-9.-]+(:[0-9]+)?(/[A-Za-z0-9._~/-]*)?$' "$2" ||
        fail "--server-url must be an https:// address, such as https://vault.example.com"
      server_url=$(printf '%s' "$2" | sed 's:/*$::')
      shift
      ;;
    --enrollment-token)
      [ $# -ge 2 ] || fail "--enrollment-token needs the token."
      check_secret "The enrollment token" "$2"
      token=$2
      shift
      ;;
    --join-secret)
      [ $# -ge 2 ] || fail "--join-secret needs the secret."
      check_secret "The join secret" "$2"
      join_secret=$2
      shift
      ;;
    --org-key)
      [ $# -ge 2 ] || fail "--org-key needs the fingerprint."
      check_secret "The organization key fingerprint" "$2"
      org_key=$2
      shift
      ;;
    --remove) remove=yes ;;
    *) fail "Unknown option: $1" ;;
  esac
  shift
done

[ "$(id -u)" -eq 0 ] || fail "Run this as root (sudo, or the RMM's script step)."

# Set when anything was installed or replaced.
CHANGED=""

# Writes stdin to a root-owned file, readable by all, if it differs from what's there.
put_file() {
  tmp=$(mktemp)
  cat > "$tmp"
  if [ -f "$1" ] && cmp -s "$tmp" "$1"; then
    rm -f "$tmp"
    return 0
  fi
  mkdir -p "$(dirname "$1")"
  chown root:root "$tmp"
  chmod 644 "$tmp"
  mv "$tmp" "$1"
  CHANGED=yes
}

refresh_menus() {
  if command -v gtk-update-icon-cache > /dev/null 2>&1; then
    gtk-update-icon-cache -q -t /usr/share/icons/hicolor || true
  fi
  if command -v update-desktop-database > /dev/null 2>&1; then
    update-desktop-database -q /usr/share/applications || true
  fi
}

install_app() {
  for file in passbundle lib/libpassbundle_core.so lib/libapp.so "data/$APP_ID.png"; do
    [ -e "$APP_SOURCE/$file" ] ||
      fail "The passbundle folder next to this script is missing $file; use the one from the RMM package."
  done
  if [ -d "$APP" ] && diff -r "$APP_SOURCE" "$APP" > /dev/null 2>&1; then
    :
  else
    # Next to the old one first, so a failed copy leaves the old app working.
    staged="/opt/.passbundle.installing"
    rm -rf "$staged"
    cp -R "$APP_SOURCE" "$staged"
    chown -R root:root "$staged"
    chmod -R go-w,a+rX "$staged"
    pkill -x passbundle 2> /dev/null || true
    rm -rf "$APP"
    mv "$staged" "$APP"
    CHANGED=yes
  fi
  put_file "$ICON" < "$APP/data/$APP_ID.png"
  put_file "$DESKTOP_ENTRY" << EOF
[Desktop Entry]
Type=Application
Name=PassBundle
GenericName=Password Manager
Comment=Your passwords, on this computer and your others
Exec=$APP/passbundle
Icon=$APP_ID
Terminal=false
Categories=Utility;Security;
StartupWMClass=$APP_ID
EOF
  refresh_menus
}

# The options' values are checked again where they go into a policy file: one
# line each, with no control characters.
one_line() { # name value
  plain "$1$2" || fail "$1 has to be on one line, with no control characters."
}

# One extension's settings, by its ID.
extension_entry() { # extension
  printf '\n      "%s": {' "$1"
  sep=""
  if [ -n "$server_url" ]; then
    one_line base "$server_url"
    printf '\n        "environment": { "base": "%s" }' "$server_url"
    sep=","
  fi
  for pair in "enrollmentToken=$token" "joinSecret=$join_secret" "orgKeyFingerprint=$org_key"; do
    name=${pair%%=*}
    value=${pair#*=}
    [ -n "$value" ] || continue
    one_line "$name" "$value"
    printf '%s\n        "%s": "%s"' "$sep" "$name" "$value"
    sep=","
  done
  printf '\n      }'
}

# What the browser hands our extension (chrome.storage.managed): the store's
# extension, and a build loaded by hand, which has our own ID.
extension_settings() { # store-extension
  [ -n "$server_url$token$join_secret$org_key" ] || return 0
  printf ',\n  "3rdparty": {\n    "extensions": {'
  extension_entry "$1"
  printf ','
  extension_entry "$OWN_EXTENSION"
  printf '\n    }\n  }'
}

policy() { # extension update-url
  printf '{\n  "ExtensionInstallForcelist": ["%s;%s"]' "$1" "$2"
  # Native-messaging hosts from the machine only, not one a program running
  # as the person put in their own profile (enrollment hands it the user key).
  printf ',\n  "NativeMessagingUserLevelHosts": false'
  [ -n "$keep_password_manager" ] || printf ',\n  "PasswordManagerEnabled": false'
  [ -z "$card" ] || printf ',\n  "AutofillCreditCardEnabled": false'
  [ -z "$address" ] || printf ',\n  "AutofillAddressEnabled": false'
  extension_settings "$1"
  printf '\n}\n'
}

# Firefox's policies file as this script writes it for the options given:
# its password manager off unless kept, and card and address autofill as the
# options say. Prints nothing when there's nothing to turn off.
firefox_policy() { # password card address
  [ -n "$1$2$3" ] || return 0
  printf '{\n  "policies": {'
  sep=""
  if [ -n "$1" ]; then
    printf '\n    "PasswordManagerEnabled": false,\n    "OfferToSaveLogins": false'
    sep=","
  fi
  if [ -n "$2" ]; then
    printf '%s\n    "AutofillCreditCardEnabled": false' "$sep"
    sep=","
  fi
  [ -z "$3" ] || printf '%s\n    "AutofillAddressEnabled": false' "$sep"
  printf '\n  }\n}\n'
}

# True when Firefox's policies file is one this script wrote, for any options
# (an earlier version's, with card and address autofill only, included).
firefox_policy_is_ours() {
  [ -f "$FIREFOX_POLICY" ] || return 1
  for p in "" yes; do
    for c in "" yes; do
      for a in "" yes; do
        [ -n "$p$c$a" ] || continue
        if firefox_policy "$p" "$c" "$a" | cmp -s - "$FIREFOX_POLICY"; then
          return 0
        fi
      done
    done
  done
  return 1
}

# The names of the Firefox policies the options ask for, for a message.
firefox_names() { # password card address
  names=""
  [ -z "$1" ] || names="PasswordManagerEnabled, OfferToSaveLogins"
  [ -z "$2" ] || names="${names:+$names, }AutofillCreditCardEnabled"
  [ -z "$3" ] || names="${names:+$names, }AutofillAddressEnabled"
  printf '%s' "$names"
}

# Run by merge_firefox_policy, with python3 -I: arguments are another vendor's
# policies file, FIREFOX_ADDED, and the three options ("yes" or empty). It
# adds each policy the options ask for that the file doesn't have, set to
# false, and lists it in FIREFOX_ADDED. A policy the file already has is
# theirs and stays as it is. It takes back each listed policy the options no
# longer ask for, if it's still false. It writes nothing else: the rest of the
# file keeps its values, in its order, with its owner and mode. A file it
# can't read as Firefox's policies is left alone, with a warning. It prints
# "changed" when it wrote anything.
firefox_merge_program() {
  cat << 'PYTHON'
import json
import os
import sys
import tempfile

path, added_path = sys.argv[1], sys.argv[2]
password, card, address = (flag == "yes" for flag in sys.argv[3:6])
wanted = {
    "PasswordManagerEnabled": password,
    "OfferToSaveLogins": password,
    "AutofillCreditCardEnabled": card,
    "AutofillAddressEnabled": address,
}
asked = ", ".join(name for name in wanted if wanted[name])


def warn(message):
    print("Warning: " + message, file=sys.stderr)


def leave_alone(why):
    if asked:
        warn(f"{path} is another vendor's, and {why}, so it's left alone. Set {asked} to false in it to turn them off in Firefox.")
    elif added:
        warn(f"{path} is another vendor's, and {why}, so PassBundle's policies stay in it: {', '.join(added)}.")
    sys.exit(0)


def replace(target, text, mode, owner=None):
    """Writes text next to target, then moves it into place."""
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(target), prefix=".passbundle-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        if owner:
            os.chown(tmp, *owner)
        os.chmod(tmp, mode)
        os.replace(tmp, target)
    except BaseException:
        os.unlink(tmp)
        raise


def save_added(names):
    if names:
        folder = os.path.dirname(added_path)
        if not os.path.isdir(folder):
            os.mkdir(folder, 0o755)
            os.chmod(folder, 0o755)
        replace(added_path, "".join(name + "\n" for name in names), 0o644)
    elif os.path.lexists(added_path):
        os.remove(added_path)


def refuse_constant(name):
    raise ValueError(name + " isn't JSON")


try:
    with open(added_path, encoding="utf-8") as f:
        added = [name for name in f.read().split() if name in wanted]
except FileNotFoundError:
    added = []

if os.path.islink(path) or not os.path.isfile(path):
    leave_alone("it isn't a plain file")
info = os.stat(path)
try:
    with open(path, encoding="utf-8") as f:
        doc = json.loads(f.read(), parse_constant=refuse_constant)
except (OSError, ValueError, RecursionError):
    leave_alone("it isn't JSON this script can read")
policies = doc.get("policies") if isinstance(doc, dict) else None
if not isinstance(policies, dict):
    leave_alone('it has no "policies" for Firefox')

changed = False
keep = []
for name, on in wanted.items():
    ours = name in added
    if on and name not in policies:
        policies[name] = False
        changed = True
        keep.append(name)
    elif on and policies[name] is False:
        if ours:
            keep.append(name)
    elif on:
        warn(f"{path} sets {name} to {json.dumps(policies[name])}, another vendor's choice, so it's left that way.")
    elif ours and policies.get(name) is False:
        del policies[name]
        changed = True

if changed:
    try:
        text = json.dumps(doc, indent=2, ensure_ascii=False, allow_nan=False) + "\n"
    except ValueError:
        leave_alone("it has a number JSON can't write")
    # Listed before the file has them, so a policy added is never left unlisted.
    save_added([name for name in wanted if name in added or name in keep])
    replace(path, text, info.st_mode & 0o7777, (info.st_uid, info.st_gid))
if changed or keep != added:
    save_added(keep)
    print("changed")
PYTHON
}

# Adds the Firefox policies the options ask for to another vendor's policies
# file, and takes back the ones this script added that they no longer ask for
# (all of them, when none is asked for). Reading and writing JSON takes a
# parser, which a POSIX shell doesn't have, so this uses python3; without it,
# the file is left alone.
merge_firefox_policy() { # password card address
  if ! command -v python3 > /dev/null 2>&1; then
    if [ -n "$1$2$3" ]; then
      echo "Warning: $FIREFOX_POLICY is another vendor's, and adding to it takes python3, which this computer doesn't have, so it's left alone. Set $(firefox_names "$1" "$2" "$3") to false in it to turn them off in Firefox." >&2
    elif [ -f "$FIREFOX_ADDED" ]; then
      echo "Warning: taking PassBundle's policies out of $FIREFOX_POLICY takes python3, which this computer doesn't have, so they stay in it. $FIREFOX_ADDED lists them." >&2
    fi
    return 0
  fi
  if ! merged=$(python3 -I -c "$(firefox_merge_program)" "$FIREFOX_POLICY" "$FIREFOX_ADDED" "$1" "$2" "$3"); then
    echo "Warning: couldn't finish changing $FIREFOX_POLICY; python3 says why above." >&2
    return 0
  fi
  [ "$merged" != changed ] || CHANGED=yes
}

# Takes Firefox's policies file away if it's ours, or takes this script's
# policies back out of another vendor's.
remove_firefox_policy() {
  if firefox_policy_is_ours; then
    rm -f "$FIREFOX_POLICY" "$FIREFOX_ADDED"
    rmdir "$(dirname "$FIREFOX_POLICY")" 2> /dev/null || true
    CHANGED=yes
  elif [ -f "$FIREFOX_POLICY" ] && [ -f "$FIREFOX_ADDED" ]; then
    merge_firefox_policy "" "" ""
  else
    rm -f "$FIREFOX_ADDED"
  fi
}

# A list policy set in two files is the browser's pick of one, so say so.
warn_about_others() {
  for other in "$1"/*.json; do
    if [ ! -f "$other" ] || [ "$other" = "$1/$POLICY_FILE" ]; then
      continue
    fi
    if grep -q '"ExtensionInstallForcelist"' "$other"; then
      echo "Warning: $other also force-installs extensions; the browser uses only one file's list. Put ours in it, or theirs in $1/$POLICY_FILE." >&2
    fi
  done
}

install_policies() {
  # Not piped: put_file has to run in this shell to say it changed something.
  written=$(mktemp)
  for b in $browsers; do
    case "$b" in
      chrome)
        policy "$CHROME_EXTENSION" "$CHROME_UPDATE_URL" > "$written"
        put_file "$CHROME_POLICIES/$POLICY_FILE" < "$written"
        warn_about_others "$CHROME_POLICIES"
        ;;
      edge)
        policy "$EDGE_EXTENSION" "$EDGE_UPDATE_URL" > "$written"
        put_file "$EDGE_POLICIES/$POLICY_FILE" < "$written"
        warn_about_others "$EDGE_POLICIES"
        ;;
    esac
  done
  # Firefox: its password manager, and card and address autofill, as the
  # options say.
  firefox_password=yes
  [ -z "$keep_password_manager" ] || firefox_password=""
  if [ -z "$firefox_password$card$address" ]; then
    remove_firefox_policy
  elif [ -f "$FIREFOX_POLICY" ] && ! firefox_policy_is_ours; then
    merge_firefox_policy "$firefox_password" "$card" "$address"
  else
    firefox_policy "$firefox_password" "$card" "$address" > "$written"
    put_file "$FIREFOX_POLICY" < "$written"
    rm -f "$FIREFOX_ADDED"
  fi
  # The app signs in to the organization's server without asking.
  if [ -n "$server_url" ]; then
    one_line ServerUrl "$server_url"
    printf '{\n  "ServerUrl": "%s"\n}\n' "$server_url" > "$written"
    put_file "$APP_POLICY" < "$written"
  fi
  rm -f "$written"
}

if [ -n "$remove" ]; then
  pkill -x passbundle 2> /dev/null || true
  rm -rf "$APP" "/opt/.passbundle.installing"
  rm -f "$DESKTOP_ENTRY" "$ICON" "$CHROME_POLICIES/$POLICY_FILE" "$EDGE_POLICIES/$POLICY_FILE" "$APP_POLICY"
  remove_firefox_policy
  rmdir "$(dirname "$APP_POLICY")" 2> /dev/null || true
  refresh_menus
  echo "Removed PassBundle and its browser policies."
  exit 0
fi

if [ -d "$APP_SOURCE" ]; then
  install_app
fi
install_policies
if [ -z "$CHANGED" ]; then
  echo "PassBundle is already set up; nothing changed."
elif [ -d "$APP_SOURCE" ]; then
  echo "Installed PassBundle to $APP and set the browser policies."
else
  echo "Set the browser policies (no passbundle folder next to this script, so no app)."
fi
