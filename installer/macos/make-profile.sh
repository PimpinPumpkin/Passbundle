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
#     and checks the organization's key against the fingerprint).
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
# The profile's identity, fixed so a new profile replaces the old one.
PROFILE="com.passbundle.profile"
PROFILE_UUID="AB9F110B-7156-4A6E-ADFD-888DD9FD0935"
CHROME_UUID="93B8F60B-D521-4DE9-A3ED-FA3344774246"
EDGE_UUID="FE508B21-38FB-452C-955B-5438E249A6EE"
CHROME_SETTINGS_UUID="283E62E3-1035-4C9A-9A6A-17C26AE62BBA"
EDGE_SETTINGS_UUID="FC9C684E-85E4-429D-97A3-E8235C4EA8F0"
AGENT_UUID="BD47697A-955E-4F2F-944A-697C68BC198E"

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
      # HTTPS only, and nothing that could break out of the profile's XML.
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

text() {
  printf '\t\t\t<key>%s</key>\n\t\t\t<string>%s</string>\n' "$1" "$2"
}

# A browser's policies: our extension forced, and its password manager off.
browser() {
  payload_start "$1" "$2" "$3" "$4"
  printf '\t\t\t<key>ExtensionInstallForcelist</key>\n\t\t\t<array>\n\t\t\t\t<string>%s;%s</string>\n\t\t\t</array>\n' "$5" "$6"
  [ -n "$keep_password_manager" ] || off PasswordManagerEnabled
  [ -z "$card" ] || off AutofillCreditCardEnabled
  [ -z "$address" ] || off AutofillAddressEnabled
  payload_end
}

# What the browser hands our extension (chrome.storage.managed).
extension_settings() {
  payload_start "$1.extensions.$2" "$3" "$4" "$5"
  if [ -n "$server_url" ]; then
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
	<string>Installs the PassBundle browser extension in Chrome and Edge, turns off their own password managers, and sets up the PassBundle desktop agent.</string>
	<key>PayloadContent</key>
	<array>
EOF
for b in $browsers; do
  case "$b" in
    chrome)
      browser com.google.Chrome chrome "$CHROME_UUID" "Chrome" "$CHROME_EXTENSION" "$CHROME_UPDATE_URL"
      [ -z "$server_url$token$join_secret$org_key" ] ||
        extension_settings com.google.Chrome "$CHROME_EXTENSION" chrome-extension "$CHROME_SETTINGS_UUID" "PassBundle in Chrome"
      ;;
    edge)
      browser com.microsoft.Edge edge "$EDGE_UUID" "Edge" "$EDGE_EXTENSION" "$EDGE_UPDATE_URL"
      [ -z "$server_url$token$join_secret$org_key" ] ||
        extension_settings com.microsoft.Edge "$EDGE_EXTENSION" edge-extension "$EDGE_SETTINGS_UUID" "PassBundle in Edge"
      ;;
  esac
done
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
