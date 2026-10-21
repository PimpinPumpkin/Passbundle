"""Checks make-profile.sh's configuration profiles: each is a valid profile
with what its options ask for and nothing else, the same options make the same
profile, and bad values are refused. Only an MDM installs a profile, so CI
reads them instead. Also checks the Mac scripts and the Windows script name
the same extensions.

    python3 installer/macos/tests/test_profile.py
"""

import plistlib
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
MAKE = HERE.parent / "make-profile.sh"
INSTALL = HERE.parent / "install-passbundle.sh"
WINDOWS = HERE.parent.parent / "windows" / "Install-PassBundle.ps1"

CHROME = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
EDGE = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
TOKEN = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123456"
JOIN = "QEFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaW1xdXl8"
ORG_KEY = "gpfywOP9ms6QtlYF65DLr2GSIBBe-lYsna8wlVbDQYE"

failures = 0


def check(name, ok):
    global failures
    print(("ok    " if ok else "FAIL  ") + name)
    if not ok:
        failures += 1


def make(*args):
    return subprocess.run(["sh", str(MAKE), *args], capture_output=True, text=True)


def profile(*args):
    run = make(*args)
    if run.returncode != 0:
        raise SystemExit(f"make-profile.sh {' '.join(args)} failed: {run.stderr}")
    return run.stdout, plistlib.loads(run.stdout.encode())


def payloads(p):
    return {item["PayloadType"]: item for item in p["PayloadContent"]}


def is_valid_profile(p):
    if p.get("PayloadType") != "Configuration" or p.get("PayloadScope") != "System":
        return False
    seen = {p["PayloadUUID"]}
    for item in p["PayloadContent"]:
        for key in ("PayloadType", "PayloadIdentifier", "PayloadUUID", "PayloadVersion"):
            if key not in item:
                return False
        if item["PayloadUUID"] in seen:
            return False
        seen.add(item["PayloadUUID"])
        if not item["PayloadIdentifier"].startswith(p["PayloadIdentifier"] + "."):
            return False
    return True


# The least: both browsers, our extension forced, their password managers off.
text, p = profile()
items = payloads(p)
check("a plain profile is a valid system profile", is_valid_profile(p))
check("it's com.passbundle.profile", p["PayloadIdentifier"] == "com.passbundle.profile")
check("Chrome and Edge, nothing else", set(items) == {"com.google.Chrome", "com.microsoft.Edge"})
check(
    "Chrome forces our extension",
    items["com.google.Chrome"]["ExtensionInstallForcelist"]
    == [f"{CHROME};https://clients2.google.com/service/update2/crx"],
)
check(
    "Edge forces our extension",
    items["com.microsoft.Edge"]["ExtensionInstallForcelist"]
    == [f"{EDGE};https://edge.microsoft.com/extensionwebstorebase/v1/crx"],
)
check("Chrome password manager off", items["com.google.Chrome"]["PasswordManagerEnabled"] is False)
check("Edge password manager off", items["com.microsoft.Edge"]["PasswordManagerEnabled"] is False)
check("card autofill untouched", "AutofillCreditCardEnabled" not in items["com.google.Chrome"])
check("address autofill untouched", "AutofillAddressEnabled" not in items["com.google.Chrome"])
check("the same options make the same profile", make().stdout == text)

# Everything the MSP console's install command gives.
_, p = profile(
    "--disable-card-autofill",
    "--disable-address-autofill",
    "--server-url",
    "https://vault.example.test/",
    "--enrollment-token",
    TOKEN,
    "--join-secret",
    JOIN,
    "--org-key",
    ORG_KEY,
)
items = payloads(p)
chrome_ext = items.get(f"com.google.Chrome.extensions.{CHROME}", {})
edge_ext = items.get(f"com.microsoft.Edge.extensions.{EDGE}", {})
check("a full profile is a valid system profile", is_valid_profile(p))
check("Chrome card autofill off", items["com.google.Chrome"]["AutofillCreditCardEnabled"] is False)
check("Edge address autofill off", items["com.microsoft.Edge"]["AutofillAddressEnabled"] is False)
check(
    "Chrome extension gets the server address, without a trailing slash",
    chrome_ext.get("environment") == {"base": "https://vault.example.test"},
)
check("Chrome extension gets the enrollment token", chrome_ext.get("enrollmentToken") == TOKEN)
check("Edge extension gets the enrollment token", edge_ext.get("enrollmentToken") == TOKEN)
check("Chrome extension gets the join secret", chrome_ext.get("joinSecret") == JOIN)
check("Edge extension gets the organization key fingerprint", edge_ext.get("orgKeyFingerprint") == ORG_KEY)
check(
    "the agent gets the server address",
    items.get("com.passbundle.agent", {}).get("ServerUrl") == "https://vault.example.test",
)

_, p = profile("--keep-browser-password-manager", "--browsers", "edge")
items = payloads(p)
check("one browser only", set(items) == {"com.microsoft.Edge"})
check("its password manager kept", "PasswordManagerEnabled" not in items["com.microsoft.Edge"])

# Refused, before anything is written.
for args, why in [
    (["--server-url", "http://vault.example.test"], "a server address without HTTPS"),
    (["--server-url", 'https://x.test/"/><key>'], "a server address that would break out of the XML"),
    (["--enrollment-token", "short"], "an enrollment token of the wrong shape"),
    (["--join-secret", TOKEN + "x"], "a join secret of the wrong shape"),
    (["--browsers", "firefox"], "a browser it doesn't manage"),
    (["--surprise"], "an option it doesn't have"),
]:
    run = make(*args)
    check(f"refuses {why}", run.returncode != 0 and run.stdout == "")

# One set of extension IDs: the Mac scripts' and the Windows script's.
windows = WINDOWS.read_text(encoding="utf-8")
ids = set(re.findall(r'Id = "([a-p]{32})"', windows))
for script in (MAKE, INSTALL):
    text = script.read_text(encoding="utf-8")
    check(
        f"{script.name} names the Windows script's extensions",
        ids == {CHROME, EDGE} and f'CHROME_EXTENSION="{CHROME}"' in text and f'EDGE_EXTENSION="{EDGE}"' in text,
    )

if failures:
    print(f"{failures} failed")
    sys.exit(1)
print("All passed")
