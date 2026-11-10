"""Checks how install-passbundle.sh adds PassBundle's Firefox policies to
another vendor's policies file, and takes them back. It installs nothing: it
takes the script's own merge program and runs it on files in a temporary
folder, so it's safe on any computer (tier 1 runs it). Tier 2
(tests/test-install.sh) runs the whole script as root.

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
found = re.search(r"<< 'PYTHON'\n(.*?)\nPYTHON\n", SCRIPT.read_text(encoding="utf-8"), re.S)
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

if failures:
    print(f"{failures} failed")
    sys.exit(1)
print("All passed")
