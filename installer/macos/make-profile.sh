#!/bin/sh
# Writes PassBundle's configuration profile for Macs, for the MSP to upload to
# their MDM: macOS takes managed settings only from a profile the MDM installs.
# It sets what Install-PassBundle.ps1 sets on Windows. For Chrome and Edge, it:
#   - force-installs the PassBundle extension (IDs are fixed here, never passed in),
#   - turns off the browser's own password saving and filling,
#   - optionally turns off card and address autofill,
#   - optionally gives the extension its server address and the client's
#     enrollment token, join secret, and organization key fingerprint, so
#     people join the client after they sign in (the extension asks first,
#     and checks the organization's key against the fingerprint). A PassBundle
#     extension loaded by hand gets the same settings, under PassBundle's own
#     ID, which is fixed here too and never force-installed.
# Firefox gets the same password, card, and address policies, in a payload
# for its own preference domain, and nothing else: no extension (ours isn't
# signed by Mozilla yet). The password ones are Firefox's
# PasswordManagerEnabled and OfferToSaveLogins, both off unless
# --keep-browser-password-manager.
# It also gives the desktop agent its server address.
# The same options make the same profile, so the MDM replaces it in place.
#
#   ./make-profile.sh --disable-card-autofill > PassBundle.mobileconfig
#   ./make-profile.sh --browsers edge > PassBundle.mobileconfig
#   ./make-profile.sh --server-url https://vault.example.com --enrollment-token <token> \
#     --join-secret <secret> --org-key <fingerprint> > PassBundle.mobileconfig
#   (the MSP console's install command has all three)

set -eu

# The only extensions this can ever force-install, the same as
# Install-PassBundle.ps1's. Placeholders until the store listings exist.
CHROME_EXTENSION="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
CHROME_UPDATE_URL="https://clients2.google.com/service/update2/crx"
EDGE_EXTENSION="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
EDGE_UPDATE_URL="https://edge.microsoft.com/extensionwebstorebase/v1/crx"
# PassBundle's own extension ID, which a Chrome or Edge build loaded by hand
# has (from the public key in its manifest; passbundle-clients' brand.json,
# extension.chromiumId). It gets the extension's settings, like the store
# IDs. It is never force-installed: it has no update URL. See DESIGN.md,
# "PassBundle's extension IDs".
OWN_EXTENSION="cenoidjoogmoieibpcokkafjnaabhokg"
# The profile's identity, fixed so a new profile replaces the old one.
PROFILE="com.passbundle.profile"
PROFILE_UUID="AB9F110B-7156-4A6E-ADFD-888DD9FD0935"
CHROME_UUID="93B8F60B-D521-4DE9-A3ED-FA3344774246"
EDGE_UUID="FE508B21-38FB-452C-955B-5438E249A6EE"
CHROME_SETTINGS_UUID="283E62E3-1035-4C9A-9A6A-17C26AE62BBA"
EDGE_SETTINGS_UUID="FC9C684E-85E4-429D-97A3-E8235C4EA8F0"
CHROME_OWN_SETTINGS_UUID="415C06B6-7A10-40EE-9360-8E99B4DA4303"
EDGE_OWN_SETTINGS_UUID="1BE97439-229F-41FA-9320-1521CF8CB6D4"
AGENT_UUID="BD47697A-955E-4F2F-944A-697C68BC198E"
FIREFOX_UUID="474AE330-7ED7-4B3B-B65D-3420FE6D4DFB"

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
      # HTTPS only, and nothing that could break out of the profile's XML.
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
    *) fail "Unknown option: $1" ;;
  esac
  shift
done

# A payload of managed preferences for one preference domain.
payload_start() {
  cat << EOF
		<dict>
			<key>PayloadType</key>
			<string>$1</string>
			<key>PayloadIdentifier</key>
			<string>$PROFILE.$2</string>
			<key>PayloadUUID</key>
			<string>$3</string>
			<key>PayloadVersion</key>
			<integer>1</integer>
			<key>PayloadDisplayName</key>
			<string>$4</string>
EOF
}

payload_end() {
  printf '\t\t</dict>\n'
}

off() {
  printf '\t\t\t<key>%s</key>\n\t\t\t<false/>\n' "$1"
}

# The options' values are checked again where they go into the profile: one
# line each, with no control characters.
one_line() { # key value
  plain "$1$2" || fail "$1 has to be on one line, with no control characters."
}

text() {
  one_line "$1" "$2"
  printf '\t\t\t<key>%s</key>\n\t\t\t<string>%s</string>\n' "$1" "$2"
}

# A browser's policies: our extension forced, and its password manager off.
browser() {
  payload_start "$1" "$2" "$3" "$4"
  printf '\t\t\t<key>ExtensionInstallForcelist</key>\n\t\t\t<array>\n\t\t\t\t<string>%s;%s</string>\n\t\t\t</array>\n' "$5" "$6"
  # Native-messaging hosts from /Library only, not one a program running as
  # the person put in ~/Library (enrollment hands it the user key).
  off NativeMessagingUserLevelHosts
  [ -n "$keep_password_manager" ] || off PasswordManagerEnabled
  [ -z "$card" ] || off AutofillCreditCardEnabled
  [ -z "$address" ] || off AutofillAddressEnabled
  payload_end
}

# What the browser hands our extension (chrome.storage.managed): the store's
# extension, and a build loaded by hand, which has our own ID.
extension_settings() {
  payload_start "$1.extensions.$2" "$3" "$4" "$5"
  if [ -n "$server_url" ]; then
    one_line base "$server_url"
    printf '\t\t\t<key>environment</key>\n\t\t\t<dict>\n\t\t\t\t<key>base</key>\n\t\t\t\t<string>%s</string>\n\t\t\t</dict>\n' "$server_url"
  fi
  [ -z "$token" ] || text enrollmentToken "$token"
  [ -z "$join_secret" ] || text joinSecret "$join_secret"
  [ -z "$org_key" ] || text orgKeyFingerprint "$org_key"
  payload_end
}

cat << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>PayloadType</key>
	<string>Configuration</string>
	<key>PayloadIdentifier</key>
	<string>$PROFILE</string>
	<key>PayloadUUID</key>
	<string>$PROFILE_UUID</string>
	<key>PayloadVersion</key>
	<integer>1</integer>
	<key>PayloadScope</key>
	<string>System</string>
	<key>PayloadDisplayName</key>
	<string>PassBundle</string>
	<key>PayloadOrganization</key>
	<string>PassBundle</string>
	<key>PayloadDescription</key>
	<string>Installs the PassBundle browser extension in Chrome and Edge, turns off the password managers built into Chrome, Edge, and Firefox, and sets up the PassBundle desktop agent.</string>
	<key>PayloadContent</key>
	<array>
EOF
for b in $browsers; do
  case "$b" in
    chrome)
      browser com.google.Chrome chrome "$CHROME_UUID" "Chrome" "$CHROME_EXTENSION" "$CHROME_UPDATE_URL"
      if [ -n "$server_url$token$join_secret$org_key" ]; then
        extension_settings com.google.Chrome "$CHROME_EXTENSION" chrome-extension "$CHROME_SETTINGS_UUID" "PassBundle in Chrome"
        extension_settings com.google.Chrome "$OWN_EXTENSION" chrome-own-extension "$CHROME_OWN_SETTINGS_UUID" "PassBundle in Chrome, loaded by hand"
      fi
      ;;
    edge)
      browser com.microsoft.Edge edge "$EDGE_UUID" "Edge" "$EDGE_EXTENSION" "$EDGE_UPDATE_URL"
      if [ -n "$server_url$token$join_secret$org_key" ]; then
        extension_settings com.microsoft.Edge "$EDGE_EXTENSION" edge-extension "$EDGE_SETTINGS_UUID" "PassBundle in Edge"
        extension_settings com.microsoft.Edge "$OWN_EXTENSION" edge-own-extension "$EDGE_OWN_SETTINGS_UUID" "PassBundle in Edge, loaded by hand"
      fi
      ;;
  esac
done
# Firefox reads its policies from its own preference domain once enterprise
# policies are on there (EnterprisePoliciesEnabled). Its password manager is
# two policies, and it takes the card and address autofill policies under
# the same names as Chrome and Edge.
if [ -z "$keep_password_manager" ] || [ -n "$card$address" ]; then
  payload_start org.mozilla.firefox firefox "$FIREFOX_UUID" "Firefox"
  printf '\t\t\t<key>EnterprisePoliciesEnabled</key>\n\t\t\t<true/>\n'
  if [ -z "$keep_password_manager" ]; then
    off PasswordManagerEnabled
    off OfferToSaveLogins
  fi
  [ -z "$card" ] || off AutofillCreditCardEnabled
  [ -z "$address" ] || off AutofillAddressEnabled
  payload_end
fi
if [ -n "$server_url" ]; then
  payload_start com.passbundle.agent agent "$AGENT_UUID" "PassBundle desktop agent"
  text ServerUrl "$server_url"
  payload_end
fi
cat << EOF
	</array>
</dict>
</plist>
EOF
