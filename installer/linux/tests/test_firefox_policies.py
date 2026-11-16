"""Checks how install-passbundle.sh adds PassBundle's Firefox policies to
another vendor's policies file, and takes them back, and that it never
creates Firefox's system-wide policies file while a Firefox installation has
a policies file of its own, which that file would hide. It installs nothing:
it takes the script's own merge program and Firefox functions and runs them
on files in a temporary folder, so it's safe on any computer (tier 1 runs
it). Tier 2 (tests/test-install.sh) runs the whole script as root.

    python3 -I installer/linux/tests/test_firefox_policies.py
"""

import json
import re
import stat
import subprocess
import sys
import tempfile
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent.parent / "install-passbundle.sh"
TEXT = SCRIPT.read_text(encoding="utf-8")
found = re.search(r"<< 'PYTHON'\n(.*?)\nPYTHON\n", TEXT, re.S)
if not found:
    raise SystemExit("install-passbundle.sh has no Firefox merge program (between << 'PYTHON' and PYTHON)")
PROGRAM = found.group(1)
PASSWORD = ["PasswordManagerEnabled", "OfferToSaveLogins"]
CARD = "AutofillCreditCardEnabled"
ADDRESS = "AutofillAddressEnabled"

failures = 0


def check(name, ok):
    global failures
    print(("ok    " if ok else "FAIL  ") + name)
    if not ok:
        failures += 1


# Removed when the test ends.
temporary = tempfile.TemporaryDirectory(prefix="pb-firefox-")
folder = Path(temporary.name)
policies = folder / "firefox" / "policies" / "policies.json"
policies.parent.mkdir(parents=True)
added = folder / "passbundle" / "firefox-policies-added"


def merge(password="", card="", address=""):
    """Runs the program as the script does, with the options' flags."""
    return subprocess.run(
        [sys.executable, "-I", "-c", PROGRAM, str(policies), str(added), password, card, address],
        capture_output=True,
        text=True,
    )


def vendor(text, mode=0o640):
    policies.unlink(missing_ok=True)
    policies.write_text(text, encoding="utf-8")
    policies.chmod(mode)
    added.unlink(missing_ok=True)


def read():
    return json.loads(policies.read_text(encoding="utf-8"))


def listed():
    return added.read_text(encoding="utf-8").split() if added.exists() else None


def left_alone(run, before, *names):
    return (
        run.returncode == 0
        and run.stdout == ""
        and policies.read_bytes() == before
        and listed() is None
        and "left alone" in run.stderr
        and all(name in run.stderr for name in names)
    )


print("Another vendor's file")
original = '{\n "policies": {"DisableTelemetry": true, "Homepage": {"URL": "https://intranet.example.test", "Locked": true},\n "Authentication_Comment": "café"}\n}\n'
vendor(original)
theirs = json.loads(original)
run = merge("yes")
check("adds the password policies, says it changed something, and warns of nothing", run.returncode == 0 and run.stdout == "changed\n" and run.stderr == "")
check("both set to false", read()["policies"].get(PASSWORD[0]) is False and read()["policies"].get(PASSWORD[1]) is False)
check(
    "everything of theirs as it was, in its order, and ours after it",
    list(read()["policies"]) == list(theirs["policies"]) + PASSWORD
    and all(read()["policies"][key] == value for key, value in theirs["policies"].items()),
)
check("their file keeps its mode", stat.S_IMODE(policies.stat().st_mode) == 0o640)
check("it lists the policies it added", listed() == PASSWORD)
check("its list is readable by all and changed by its owner only", stat.S_IMODE(added.stat().st_mode) == 0o644)
check("no temporary file left next to theirs", sorted(p.name for p in policies.parent.iterdir()) == ["policies.json"])
before = policies.read_bytes()
run = merge("yes")
check("again with the same options: nothing changes", run.returncode == 0 and run.stdout == "" and policies.read_bytes() == before)

run = merge("yes", "yes")
check("card autofill too", run.stdout == "changed\n" and read()["policies"].get(CARD) is False and listed() == PASSWORD + [CARD])

run = merge("", "yes")
check(
    "the password manager kept: its two policies are taken back, card autofill stays",
    run.stdout == "changed\n"
    and not set(PASSWORD) & set(read()["policies"])
    and read()["policies"].get(CARD) is False
    and listed() == [CARD],
)

run = merge()
check("nothing asked for: the file is what they wrote", run.stdout == "changed\n" and read() == theirs)
check("and the list is gone", listed() is None)
check("their file still keeps its mode", stat.S_IMODE(policies.stat().st_mode) == 0o640)

print("Their own values")
vendor('{"policies": {"PasswordManagerEnabled": true, "OfferToSaveLogins": false}}\n')
run = merge("yes", "", "yes")
check("a policy they set to true stays true, with a warning", read()["policies"][PASSWORD[0]] is True and "PasswordManagerEnabled to true" in run.stderr)
check("a policy they set to false stays, and isn't listed as ours", read()["policies"][PASSWORD[1]] is False and PASSWORD[1] not in listed())
check("only what it added is listed", listed() == [ADDRESS])
run = merge()
check(
    "taking back leaves both of theirs",
    read() == {"policies": {"PasswordManagerEnabled": True, "OfferToSaveLogins": False}} and listed() is None,
)

vendor('{"policies": {}}\n')
merge("yes")
data = read()
data["policies"]["OfferToSaveLogins"] = True
policies.write_text(json.dumps(data), encoding="utf-8")
run = merge("yes")
check("one it added that they later set to true stays theirs", read()["policies"]["OfferToSaveLogins"] is True and listed() == [PASSWORD[0]])
merge()
check("and stays when the rest is taken back", read() == {"policies": {"OfferToSaveLogins": True}})

print("A list that names other policies")
vendor('{"policies": {"DisableTelemetry": false}}\n')
added.parent.mkdir(exist_ok=True)
added.write_text("DisableTelemetry\nPasswordManagerEnabled\n", encoding="utf-8")
merge()
check(
    "it takes back only its own four, never another policy the list names",
    read() == {"policies": {"DisableTelemetry": False}} and listed() is None,
)

print("Files it leaves alone")
for name, text in [
    ("isn't JSON", '{"policies": {"DisableTelemetry": true,}}\n'),
    ("has NaN in it", '{"policies": {"DisableTelemetry": NaN}}\n'),
    ("has a number too big to write back", '{"policies": {"Big": 1e400}}\n'),
    ("has no policies", '{"other": {}}\n'),
    ("has policies that aren't an object", '{"policies": ["PasswordManagerEnabled"]}\n'),
    ("is a list", "[]\n"),
    ("starts with a byte-order mark", '﻿{"policies": {}}\n'),
]:
    vendor(text)
    before = policies.read_bytes()
    check(f"a file that {name}, with a warning naming what to set", left_alone(merge("yes", "yes"), before, *PASSWORD, CARD))

target = folder / "elsewhere.json"
target.write_text('{"policies": {}}\n', encoding="utf-8")
policies.unlink()
policies.symlink_to(target)
run = merge("yes")
check(
    "a link to a file elsewhere, and the file it points to",
    policies.is_symlink() and target.read_text(encoding="utf-8") == '{"policies": {}}\n' and "left alone" in run.stderr and run.stdout == "",
)
policies.unlink()

print("A Firefox installation with a policies file of its own")
# Firefox on Linux reads /etc/firefox/policies/policies.json instead of the
# one in its installation's distribution folder whenever the first exists, so
# the script must never create it while an installation has one. These run
# the script's own Firefox functions in a shell, with its paths moved into a
# temporary folder and a stand-in for put_file, which makes files root's.
INSTALLS = re.findall(r'^FIREFOX_INSTALLS="([^"]*)"$', TEXT, re.M)
INSTALLS = INSTALLS[0].split() if len(INSTALLS) == 1 else []
check(
    "it looks in the folders Linux puts Firefox in",
    {
        "/usr/lib/firefox",
        "/usr/lib64/firefox",
        "/usr/lib/firefox-esr",
        "/usr/lib64/firefox-esr",
        "/opt/firefox",
        "/usr/local/firefox",
        "/usr/lib/firefox-beta",
        "/usr/lib/firefox-nightly",
        "/usr/lib/firefox-devedition",
        "/snap/firefox/current/usr/lib/firefox",
    }
    <= set(INSTALLS),
)


def shell_function(name):
    if name == "firefox_merge_program":
        pattern = r"^firefox_merge_program\(\) \{\n.*?^PYTHON\n\}"
    else:
        pattern = rf"^{name}\(\) \{{.*?^\}}"
    found = re.search(pattern, TEXT, re.M | re.S)
    if not found:
        raise SystemExit(f"install-passbundle.sh has no {name} function")
    return found.group(0)


FUNCTIONS = "\n".join(
    shell_function(name)
    for name in (
        "firefox_policy",
        "firefox_policy_is_ours",
        "firefox_names",
        "firefox_merge_program",
        "merge_firefox_policy",
        "remove_firefox_policy",
        "firefox_install_policies",
        "install_firefox_policy",
    )
)
root = folder / "computer"
if " " in str(root):
    raise SystemExit(f"the temporary folder {root} has a space in it, which the script's folder list can't take")
system = root / "etc" / "firefox" / "policies" / "policies.json"
system_added = root / "etc" / "passbundle" / "firefox-policies-added"


def install(password="", card="", address=""):
    """Runs the script's install_firefox_policy, as install_policies does."""
    program = "\n".join(
        [
            "set -eu",
            f'FIREFOX_POLICY="{system}"',
            f'FIREFOX_ADDED="{system_added}"',
            'FIREFOX_INSTALLS="' + " ".join(f"{root}{path}" for path in INSTALLS) + '"',
            'CHANGED=""',
            'put_file() { mkdir -p "$(dirname "$1")"; cat > "$1"; CHANGED=yes; }',
            FUNCTIONS,
            'install_firefox_policy "$1" "$2" "$3"',
            'printf "%s" "$CHANGED"',
        ]
    )
    return subprocess.run(["sh", "-c", program, "sh", password, card, address], capture_output=True, text=True)


def installation_policy(path, text='{"policies": {"DisableAppUpdate": true}}\n'):
    file = root / path.lstrip("/") / "distribution" / "policies.json"
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text(text, encoding="utf-8")
    return file


def clean():
    for file in sorted(root.rglob("*"), reverse=True):
        file.rmdir() if file.is_dir() and not file.is_symlink() else file.unlink()


def blocked(run, *files):
    return (
        run.returncode == 0
        and not system.exists()
        and all(str(file) in run.stderr for file in files)
        and "doesn't write that file" in run.stderr
    )


root.mkdir()
run = install("yes")
check(
    "with no installation's own file, it writes the system-wide one",
    run.returncode == 0 and run.stdout == "yes" and json.loads(system.read_text(encoding="utf-8")) == {"policies": {"PasswordManagerEnabled": False, "OfferToSaveLogins": False}},
)
clean()
(root / "usr" / "lib" / "firefox" / "distribution").mkdir(parents=True)
(root / "usr" / "lib" / "firefox" / "distribution" / "distribution.ini").write_text("[Global]\n", encoding="utf-8")
run = install("yes")
check("a distribution folder without a policies file doesn't stop it", run.returncode == 0 and system.exists())
clean()

stopped = 0
for path in INSTALLS:
    file = installation_policy(path)
    before = file.read_bytes()
    run = install("yes", "yes")
    if blocked(run, file) and all(name in run.stderr for name in PASSWORD + [CARD]) and file.read_bytes() == before and run.stdout == "":
        stopped += 1
    else:
        print(f"      {path}: {run.stderr.strip()}")
    clean()
check(
    f"a policies file in any of those installations stops it, untouched, with a warning naming it and what to set ({stopped} of {len(INSTALLS)})",
    stopped == len(INSTALLS) > 0,
)

install("yes")
file = installation_policy("/opt/firefox")
run = install("yes")
check("ours, written before an installation had its own, is taken away, which lets Firefox read theirs again", blocked(run, file) and run.stdout == "yes")
clean()

file = installation_policy("/usr/lib/firefox-esr")
vendor_text = '{"policies": {"DisableTelemetry": true}}\n'
system.parent.mkdir(parents=True)
system.write_text(vendor_text, encoding="utf-8")
run = install("yes")
check(
    "another vendor's system-wide file, which Firefox already reads instead, still gets ours added",
    run.returncode == 0
    and json.loads(system.read_text(encoding="utf-8"))["policies"] == {"DisableTelemetry": True, "PasswordManagerEnabled": False, "OfferToSaveLogins": False},
)
run = install()
check("and taken back", run.returncode == 0 and system.read_text(encoding="utf-8") == '{\n  "policies": {\n    "DisableTelemetry": true\n  }\n}\n')
check("its own file stays as it was", file.read_text(encoding="utf-8") == '{"policies": {"DisableAppUpdate": true}}\n')
clean()

install("yes")
installation_policy("/usr/lib/firefox")
run = install()
check("nothing asked for: ours is taken away, with no warning", run.returncode == 0 and not system.exists() and run.stderr == "")
clean()

link = root / "usr" / "local" / "firefox" / "distribution" / "policies.json"
link.parent.mkdir(parents=True)
link.symlink_to(root / "nowhere.json")
check("a link there counts, even a broken one", blocked(install("yes"), link))
clean()

if failures:
    print(f"{failures} failed")
    sys.exit(1)
print("All passed")
