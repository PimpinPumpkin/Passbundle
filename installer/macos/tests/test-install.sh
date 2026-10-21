#!/bin/sh
# Tier 2 checks for install-passbundle.sh. Run with sudo on a disposable Mac
# (CI runner or VM), with PassBundle.app next to the install script: it
# installs into /Applications and /Library, and starts the agent for whoever
# is logged in at the screen.

set -u

here=$(cd "$(dirname "$0")" && pwd)
script="$here/../install-passbundle.sh"
app="/Applications/PassBundle.app"
label="com.passbundle.agent"
launch_agent="/Library/LaunchAgents/$label.plist"
chrome_host="/Library/Google/Chrome/NativeMessagingHosts/$label.json"
edge_host="/Library/Microsoft/Edge/NativeMessagingHosts/$label.json"
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

user=$(stat -f %Su /dev/console)
uid=$(id -u "$user")
home=$(dscl . -read "/Users/$user" NFSHomeDirectory | awk '{print $2}')
echo "Logged in at the screen: $user ($uid)"

agent_pid() {
  pgrep -u "$uid" -x passbundle-agent | head -1
}

# Waits up to 20 seconds for a condition (launchd waits up to 10 to restart a job).
eventually() {
  i=0
  while [ $i -lt 40 ]; do
    if "$@" > /dev/null 2>&1; then return 0; fi
    sleep 0.5
    i=$((i + 1))
  done
  return 1
}

agent_running() { [ -n "$(agent_pid)" ]; }
agent_is() { [ "$(agent_pid)" = "$1" ]; }
agent_replaced() { p=$(agent_pid); [ -n "$p" ] && [ "$p" != "$1" ]; }
agent_stopped() { [ -z "$(agent_pid)" ]; }
socket_ready() { [ -S "$home/Library/Caches/$label/agent.sock" ]; }
app_running() { pgrep -u "$uid" -x passbundle; }

# A host manifest for our extensions only, pointing into the installed app.
host_ok() {
  python3 -I - "$1" "$app/Contents/MacOS/passbundle-agent-host" << 'EOF'
import json, sys
m = json.load(open(sys.argv[1]))
assert m["name"] == "com.passbundle.agent", m
assert m["path"] == sys.argv[2], m
assert m["type"] == "stdio", m
assert m["allowed_origins"] == [
    "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/",
    "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/",
], m
EOF
}

launch_agent_ok() {
  plutil -lint "$launch_agent" &&
    [ "$(plutil -extract Label raw "$launch_agent")" = "$label" ] &&
    [ "$(plutil -extract ProgramArguments.0 raw "$launch_agent")" = "$app/Contents/MacOS/passbundle-agent" ] &&
    [ "$(plutil -extract RunAtLoad raw "$launch_agent")" = true ] &&
    [ "$(plutil -extract KeepAlive.SuccessfulExit raw "$launch_agent")" = false ]
}

# launchd ignores a LaunchAgent others can write to.
root_owned() {
  [ "$(stat -f '%Su:%Sg %Lp' "$1")" = "root:wheel 644" ]
}

app_root_owned() {
  [ "$(stat -f %Su "$app")" = root ] && [ -z "$(find "$app" -perm -o+w -print -quit)" ]
}

echo "Refusals"
check "refuses without root" sh -c "sudo -u '$user' sh '$script' 2>&1 | grep -q 'Run this as root'"
check "refuses an unknown option" sh -c "! sh '$script' --surprise"

echo "Installing"
sh "$script" || failures=$((failures + 1))
check "the app is in Applications" test -x "$app/Contents/MacOS/passbundle"
check "with the agent inside" test -x "$app/Contents/MacOS/passbundle-agent"
check "and the native-messaging host" test -x "$app/Contents/MacOS/passbundle-agent-host"
check "and the core" test -f "$app/Contents/Frameworks/libpassbundle_core.dylib"
check "its signature holds" codesign --verify --deep --strict "$app"
check "only root can change it" app_root_owned
check "the agent starts at every login" launch_agent_ok
check "its LaunchAgent is root's and read-only" root_owned "$launch_agent"
check "Chrome can reach the agent, for our extension only" host_ok "$chrome_host"
check "Edge can reach the agent, for our extension only" host_ok "$edge_host"
check "the manifests are root's and read-only" root_owned "$chrome_host"
check "the agent is running for $user" eventually agent_running
check "launchd runs it" launchctl print "gui/$uid/$label"
check "it listens on its socket" eventually socket_ready
first=$(agent_pid)

echo "Again, with nothing new"
second_output=$(sh "$script")
echo "$second_output"
says_up_to_date() { printf '%s\n' "$second_output" | grep -q 'already installed and up to date'; }
check "says it's up to date" says_up_to_date
check "the agent keeps running, not restarted" agent_is "$first"

echo "The app"
launchctl asuser "$uid" sudo -u "$user" open "$app"
check "opens" eventually app_running
sleep 3
check "and stays open" app_running
pkill -u "$uid" -x passbundle

echo "The agent stopping unexpectedly"
kill -KILL "$first"
check "launchd starts it again" eventually agent_replaced "$first"

echo "A new version"
before=$(agent_pid)
source_app="$(dirname "$script")/PassBundle.app"
echo "a new build" > "$source_app/Contents/Resources/new-version.txt"
codesign --force --deep --sign - --preserve-metadata=entitlements "$source_app"
sh "$script" || failures=$((failures + 1))
check "the new app is in place" test -f "$app/Contents/Resources/new-version.txt"
check "its signature holds" codesign --verify --deep --strict "$app"
check "the agent restarted" eventually agent_replaced "$before"

echo "Removing"
sh "$script" --remove || failures=$((failures + 1))
check "the app is gone" test ! -e "$app"
check "the LaunchAgent is gone" test ! -e "$launch_agent"
check "the Chrome manifest is gone" test ! -e "$chrome_host"
check "the Edge manifest is gone" test ! -e "$edge_host"
check "the agent stopped" eventually agent_stopped
check "launchd no longer has it" sh -c "! launchctl print gui/$uid/$label"
check "removing again is fine" sh "$script" --remove

if [ "$failures" -gt 0 ]; then
  echo "$failures failed"
  exit 1
fi
echo "All passed"
