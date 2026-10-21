#!/bin/sh
# Sets PassBundle up on a Mac: the app and its desktop agent.
#
# Run as root, typically from an RMM's or MDM's script step, with
# PassBundle.app next to this script (the RMM package). It:
#   - installs PassBundle.app to /Applications, replacing an older one (the
#     agent is inside it, an app of its own: Contents/Helpers/PassBundle Agent.app),
#   - starts the desktop agent at every login (a LaunchAgent), and now for
#     whoever is at the screen,
#   - lets Chrome and Edge reach the agent, for our extension only (the
#     native-messaging host).
# Browser policies and the agent's settings come from a configuration profile
# that the MDM installs (make-profile.sh writes it): macOS takes managed
# settings only from a profile. New versions come from running this again
# with the new app; the agent doesn't update itself on macOS, since replacing
# one program inside the app would break the app's signature.
# Running it again with the same app changes nothing.
#
#   sudo ./install-passbundle.sh
#   sudo ./install-passbundle.sh --remove

set -eu

APP_SOURCE="$(cd "$(dirname "$0")" && pwd)/PassBundle.app"
APP="/Applications/PassBundle.app"
# The agent and the native-messaging host, in the app's helper.
HELPER="Contents/Helpers/PassBundle Agent.app/Contents/MacOS"
# The agent's launchd label, and the native-messaging host's name:
# brand.json's nativeMessagingHost, as in Install-PassBundle.ps1.
LABEL="com.passbundle.agent"
LAUNCH_AGENT="/Library/LaunchAgents/$LABEL.plist"
HOST_DIRS="/Library/Google/Chrome/NativeMessagingHosts /Library/Microsoft/Edge/NativeMessagingHosts"
# The only extensions that may reach the agent. Placeholders until the store
# listings exist, the same as Install-PassBundle.ps1's.
CHROME_EXTENSION="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
EDGE_EXTENSION="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
PROGRAMS="passbundle passbundle-agent passbundle-agent-host"
# What the app's bundle ID is, for macOS's list of what starts at login.
APP_ID="com.passbundle.app"

fail() {
  echo "$1" >&2
  exit 1
}

# The person logged in at the screen, if anyone: their agent starts now.
console_user() {
  user=$(stat -f %Su /dev/console 2>/dev/null || true)
  case "$user" in
    "" | root | loginwindow | _mbsetupuser) return 1 ;;
  esac
  echo "$user"
}

stop_programs() {
  for program in $PROGRAMS; do
    pkill -x "$program" 2>/dev/null || true
  done
}

# Set when anything was installed or replaced, to restart the agent.
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
  chown root:wheel "$tmp"
  chmod 644 "$tmp"
  mv "$tmp" "$1"
  CHANGED=yes
}

install_app() {
  for program in "Contents/MacOS/passbundle" "$HELPER/passbundle-agent" "$HELPER/passbundle-agent-host"; do
    [ -x "$APP_SOURCE/$program" ] ||
      fail "PassBundle.app next to this script is missing $program; use the app from the RMM package."
  done
  [ -f "$APP_SOURCE/Contents/Frameworks/libpassbundle_core.dylib" ] ||
    fail "PassBundle.app next to this script is missing its core; use the app from the RMM package."
  if [ -d "$APP" ] && diff -rq "$APP_SOURCE" "$APP" > /dev/null 2>&1; then
    return 0
  fi
  # Next to the old one first, so a failed copy leaves the old app working.
  staged="/Applications/.PassBundle.app.installing"
  rm -rf "$staged"
  ditto "$APP_SOURCE" "$staged"
  chown -R root:wheel "$staged"
  chmod -R go-w "$staged"
  stop_programs
  rm -rf "$APP"
  mv "$staged" "$APP"
  CHANGED=yes
}

install_launch_agent() {
  put_file "$LAUNCH_AGENT" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>$LABEL</string>
	<key>ProgramArguments</key>
	<array>
		<string>$APP/$HELPER/passbundle-agent</string>
	</array>
	<key>AssociatedBundleIdentifiers</key>
	<string>$APP_ID</string>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<dict>
		<key>SuccessfulExit</key>
		<false/>
	</dict>
	<key>LimitLoadToSessionType</key>
	<string>Aqua</string>
	<key>ProcessType</key>
	<string>Interactive</string>
</dict>
</plist>
EOF
}

install_hosts() {
  for dir in $HOST_DIRS; do
    put_file "$dir/$LABEL.json" << EOF
{
  "name": "$LABEL",
  "description": "PassBundle desktop agent",
  "path": "$APP/$HELPER/passbundle-agent-host",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$CHROME_EXTENSION/",
    "chrome-extension://$EDGE_EXTENSION/"
  ]
}
EOF
  done
}

# Starts the agent for whoever is at the screen, or restarts it after a change.
start_agent() {
  user=$(console_user) || {
    echo "Nobody is logged in at the screen; the agent starts at the next login."
    return 0
  }
  uid=$(id -u "$user")
  if launchctl print "gui/$uid/$LABEL" > /dev/null 2>&1; then
    [ -n "$CHANGED" ] || return 0
    launchctl bootout "gui/$uid/$LABEL" 2> /dev/null || true
  fi
  if launchctl bootstrap "gui/$uid" "$LAUNCH_AGENT"; then
    echo "Started the PassBundle desktop agent for $user."
  else
    echo "Couldn't start the agent for $user now; it starts at their next login."
  fi
}

remove() {
  if user=$(console_user); then
    launchctl bootout "gui/$(id -u "$user")/$LABEL" 2> /dev/null || true
  fi
  stop_programs
  rm -f "$LAUNCH_AGENT"
  for dir in $HOST_DIRS; do
    rm -f "$dir/$LABEL.json"
  done
  rm -rf "$APP" "/Applications/.PassBundle.app.installing"
  echo "Removed PassBundle and its desktop agent. Remove the configuration profile from the MDM."
}

[ "$(id -u)" -eq 0 ] || fail "Run this as root (sudo, or the RMM's script step)."

case "${1:-}" in
  --remove)
    remove
    exit 0
    ;;
  "") ;;
  *) fail "Unknown option: $1 (the only one is --remove)" ;;
esac

[ -d "$APP_SOURCE" ] || fail "No PassBundle.app next to this script; the RMM package has it."
install_app
install_launch_agent
install_hosts
start_agent
if [ -n "$CHANGED" ]; then
  echo "Installed PassBundle to $APP; its desktop agent starts at every login."
else
  echo "PassBundle is already installed and up to date."
fi
