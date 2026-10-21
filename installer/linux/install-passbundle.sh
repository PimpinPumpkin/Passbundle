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
#     and checks the organization's key against the fingerprint).
# Without the app's folder, it sets the policies only. The policies are a
# file of our own in each browser's managed policies folder; other vendors'
# files are left alone. The desktop agent isn't installed: on Linux it has no
# tray and no biometric unlock yet. Running it again changes nothing.
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
CHROME_POLICIES="/etc/opt/chrome/policies/managed"
EDGE_POLICIES="/etc/opt/edge/policies/managed"
# The only extensions this can ever force-install, the same as
# Install-PassBundle.ps1's. Placeholders until the store listings exist.
CHROME_EXTENSION="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
CHROME_UPDATE_URL="https://clients2.google.com/service/update2/crx"
EDGE_EXTENSION="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
EDGE_UPDATE_URL="https://edge.microsoft.com/extensionwebstorebase/v1/crx"

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

# A token, join secret, or key fingerprint: 32 bytes in unpadded base64url.
check_secret() {
  printf '%s' "$2" | grep -Eq '^[A-Za-z0-9_-]{43}$' || fail "$1 should be 43 letters, digits, - or _ (from the MSP console)."
}

while [ $# -gt 0 ]; do
  case "$1" in
    --browsers)
      [ $# -ge 2 ] || fail "--browsers needs chrome, edge, or chrome,edge."
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
      printf '%s' "$2" | grep -Eq '^https://[A-Za-z0-9.-]+(:[0-9]+)?(/[A-Za-z0-9._~/-]*)?$' ||
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

# What the browser hands our extension (chrome.storage.managed).
extension_settings() {
  [ -n "$server_url$token$join_secret$org_key" ] || return 0
  printf ',\n  "3rdparty": {\n    "extensions": {\n      "%s": {' "$1"
  sep=""
  if [ -n "$server_url" ]; then
    printf '\n        "environment": { "base": "%s" }' "$server_url"
    sep=","
  fi
  for pair in "enrollmentToken=$token" "joinSecret=$join_secret" "orgKeyFingerprint=$org_key"; do
    name=${pair%%=*}
    value=${pair#*=}
    [ -n "$value" ] || continue
    printf '%s\n        "%s": "%s"' "$sep" "$name" "$value"
    sep=","
  done
  printf '\n      }\n    }\n  }'
}

policy() { # extension update-url
  printf '{\n  "ExtensionInstallForcelist": ["%s;%s"]' "$1" "$2"
  [ -n "$keep_password_manager" ] || printf ',\n  "PasswordManagerEnabled": false'
  [ -z "$card" ] || printf ',\n  "AutofillCreditCardEnabled": false'
  [ -z "$address" ] || printf ',\n  "AutofillAddressEnabled": false'
  extension_settings "$1"
  printf '\n}\n'
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
  rm -f "$written"
}

if [ -n "$remove" ]; then
  pkill -x passbundle 2> /dev/null || true
  rm -rf "$APP" "/opt/.passbundle.installing"
  rm -f "$DESKTOP_ENTRY" "$ICON" "$CHROME_POLICIES/$POLICY_FILE" "$EDGE_POLICIES/$POLICY_FILE"
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
