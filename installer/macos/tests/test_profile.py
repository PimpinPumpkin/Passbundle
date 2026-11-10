"""Checks make-profile.sh's configuration profiles: each is a valid profile
with what its options ask for and nothing else, the same options make the same
profile, and bad values are refused. Only an MDM installs a profile, so CI
reads them instead. Also checks the Mac, Linux, and Windows scripts name the
same extensions, and the same one of PassBundle's own as DESIGN.md, which is
never force-installed.

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
LINUX = HERE.parent.parent / "linux" / "install-passbundle.sh"
WINDOWS = HERE.parent.parent / "windows" / "Install-PassBundle.ps1"
DESIGN = HERE.parent.parent.parent / "DESIGN.md"

CHROME = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
EDGE = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
# PassBundle's own ID, which a build loaded by hand has (DESIGN.md,
# "PassBundle's extension IDs"). It gets the extension's settings and is
# never force-installed.
OWN = "cenoidjoogmoieibpcokkafjnaabhokg"
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


def forced(p):
    """Every extension ID the profile force-installs, in any payload."""
    return sorted(
        entry.split(";")[0]
        for item in p["PayloadContent"]
        for entry in item.get("ExtensionInstallForcelist", [])
    )


SETTINGS = {"environment", "enrollmentToken", "joinSecret", "orgKeyFingerprint"}


def settings(item):
    """An extension's settings, without the payload's own keys."""
    return {key: value for key, value in item.items() if key in SETTINGS}


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
check("it forces our two store extensions and nothing else", forced(p) == [CHROME, EDGE])
check("our own ID isn't in a profile with nothing for the extension", OWN not in text)
check("Chrome password manager off", items["com.google.Chrome"]["PasswordManagerEnabled"] is False)
check("Edge password manager off", items["com.microsoft.Edge"]["PasswordManagerEnabled"] is False)
# A program running as the person could put its own com.passbundle.agent in ~/Library.
for browser in ("com.google.Chrome", "com.microsoft.Edge"):
    check(
        f"{browser} takes native-messaging hosts from /Library only",
        items[browser]["NativeMessagingUserLevelHosts"] is False,
    )
check("card autofill untouched", "AutofillCreditCardEnabled" not in items["com.google.Chrome"])
check("address autofill untouched", "AutofillAddressEnabled" not in items["com.google.Chrome"])
check("Firefox untouched without the card and address options", "org.mozilla.firefox" not in items)
check("the same options make the same profile", make().stdout == text)

# Everything the MSP console's install command gives.
full_text, p = profile(
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
chrome_own = items.get(f"com.google.Chrome.extensions.{OWN}", {})
edge_own = items.get(f"com.microsoft.Edge.extensions.{OWN}", {})
check("a full profile is a valid system profile", is_valid_profile(p))
check(
    "its payloads are the browsers, the extension under its store ID and our own, Firefox, and the agent",
    len(p["PayloadContent"]) == len(items)
    and set(items)
    == {
        "com.google.Chrome",
        "com.microsoft.Edge",
        f"com.google.Chrome.extensions.{CHROME}",
        f"com.google.Chrome.extensions.{OWN}",
        f"com.microsoft.Edge.extensions.{EDGE}",
        f"com.microsoft.Edge.extensions.{OWN}",
        "org.mozilla.firefox",
        "com.passbundle.agent",
    },
)
check("Chrome card autofill off", items["com.google.Chrome"]["AutofillCreditCardEnabled"] is False)
check("Edge address autofill off", items["com.microsoft.Edge"]["AutofillAddressEnabled"] is False)
firefox = items.get("org.mozilla.firefox", {})
check("Firefox reads enterprise policies", firefox.get("EnterprisePoliciesEnabled") is True)
check("Firefox card autofill off", firefox.get("AutofillCreditCardEnabled") is False)
check("Firefox address autofill off", firefox.get("AutofillAddressEnabled") is False)
check(
    "Firefox gets nothing else",
    set(firefox) - {"PayloadType", "PayloadIdentifier", "PayloadUUID", "PayloadVersion", "PayloadDisplayName"}
    == {"EnterprisePoliciesEnabled", "AutofillCreditCardEnabled", "AutofillAddressEnabled"},
)
_, card_only = profile("--disable-card-autofill")
firefox = payloads(card_only).get("org.mozilla.firefox", {})
check("card only: Firefox card autofill off", firefox.get("AutofillCreditCardEnabled") is False)
check("card only: Firefox address autofill untouched", "AutofillAddressEnabled" not in firefox)
check(
    "Chrome extension gets the server address, without a trailing slash",
    chrome_ext.get("environment") == {"base": "https://vault.example.test"},
)
check("Chrome extension gets the enrollment token", chrome_ext.get("enrollmentToken") == TOKEN)
check("Edge extension gets the enrollment token", edge_ext.get("enrollmentToken") == TOKEN)
check("Chrome extension gets the join secret", chrome_ext.get("joinSecret") == JOIN)
check("Edge extension gets the organization key fingerprint", edge_ext.get("orgKeyFingerprint") == ORG_KEY)
# A build loaded by hand has our own ID, so the same settings go there too.
everything = {
    "environment": {"base": "https://vault.example.test"},
    "enrollmentToken": TOKEN,
    "joinSecret": JOIN,
    "orgKeyFingerprint": ORG_KEY,
}
check("Chrome's store extension gets all four settings", settings(chrome_ext) == everything)
check("a Chrome extension loaded by hand gets the same settings", settings(chrome_own) == everything)
check("an Edge extension loaded by hand gets the same settings", settings(edge_own) == settings(edge_ext) == everything)
check("our own ID is never force-installed", forced(p) == [CHROME, EDGE])
check("our own ID is in the profile for those settings only", full_text.count(OWN) == 2)
check(
    "the agent gets the server address",
    items.get("com.passbundle.agent", {}).get("ServerUrl") == "https://vault.example.test",
)

_, p = profile("--keep-browser-password-manager", "--browsers", "edge")
items = payloads(p)
check("one browser only", set(items) == {"com.microsoft.Edge"})
check("its password manager kept", "PasswordManagerEnabled" not in items["com.microsoft.Edge"])
check("its native-messaging hosts still from /Library only", items["com.microsoft.Edge"]["NativeMessagingUserLevelHosts"] is False)

_, p = profile("--browsers", "edge", "--enrollment-token", TOKEN)
items = payloads(p)
check(
    "one browser's extension settings only, under its store ID and our own",
    len(p["PayloadContent"]) == len(items)
    and set(items)
    == {"com.microsoft.Edge", f"com.microsoft.Edge.extensions.{EDGE}", f"com.microsoft.Edge.extensions.{OWN}"},
)
check(
    "with only a token, both get only the token",
    settings(items[f"com.microsoft.Edge.extensions.{EDGE}"])
    == settings(items[f"com.microsoft.Edge.extensions.{OWN}"])
    == {"enrollmentToken": TOKEN},
)
check("and Edge forces only its store extension", forced(p) == [EDGE])

# Refused, before anything is written.
for args, why in [
    (["--server-url", "http://vault.example.test"], "a server address without HTTPS"),
    (["--server-url", 'https://x.test/"/><key>'], "a server address that would break out of the XML"),
    (["--enrollment-token", "short"], "an enrollment token of the wrong shape"),
    (["--join-secret", TOKEN + "x"], "a join secret of the wrong shape"),
    (["--browsers", "firefox"], "a browser it doesn't manage"),
    (["--surprise"], "an option it doesn't have"),
    # A line break or other control character. grep checks line by line, so each
    # address, token, and secret here has a line that would pass alone.
    (["--server-url", "https://vault.example.test\n</string><key>x</key><string>"], "a server address with a line break in it"),
    (["--server-url", "https://x.test\r\nhttps://vault.example.test"], "a server address with a carriage return and line break in it"),
    (["--enrollment-token", TOKEN + "\n</string><key>x</key><string>"], "an enrollment token with a line break in it"),
    (["--join-secret", "x\n" + JOIN], "a join secret with a line break in it"),
    (["--org-key", ORG_KEY + "\n"], "an organization key fingerprint with a line break after it"),
    (["--browsers", "chrome\nedge"], "a browser list with a line break in it"),
    (["--browsers", "chrome\tedge"], "a browser list with a tab in it"),
]:
    run = make(*args)
    check(f"refuses {why}", run.returncode != 0 and run.stdout == "")

# One set of extension IDs: the Mac and Linux scripts' and the Windows script's.
windows = WINDOWS.read_text(encoding="utf-8")
ids = set(re.findall(r'Id = "([a-p]{32})"', windows))
for script in (MAKE, INSTALL, LINUX):
    text = script.read_text(encoding="utf-8")
    check(
        f"{script.parent.name}/{script.name} names the Windows script's extensions",
        ids == {CHROME, EDGE} and f'CHROME_EXTENSION="{CHROME}"' in text and f'EDGE_EXTENSION="{EDGE}"' in text,
    )

# One ID of our own, for a build loaded by hand: DESIGN.md's, written once in
# each script, and nowhere near a force-install list or an update URL.
design = DESIGN.read_text(encoding="utf-8")
check(
    "DESIGN.md gives our own Chrome and Edge ID",
    re.findall(r"^- \*\*Chrome and Edge:\*\* `([a-p]{32})`", design, re.M) == [OWN],
)
for script, declaration, name in (
    (MAKE, r'^OWN_EXTENSION="([a-p]{32})"$', "OWN_EXTENSION"),
    (INSTALL, r'^OWN_EXTENSION="([a-p]{32})"$', "OWN_EXTENSION"),
    (LINUX, r'^OWN_EXTENSION="([a-p]{32})"$', "OWN_EXTENSION"),
    (WINDOWS, r'^\$OwnExtension = "([a-p]{32})"$', "$OwnExtension"),
):
    text = script.read_text(encoding="utf-8")
    where = f"{script.parent.name}/{script.name}"
    check(
        f"{where} has DESIGN.md's ID of our own, written once",
        re.findall(declaration, text, re.M) == [OWN] and text.count(OWN) == 1,
    )
    check(
        f"{where} never puts our own ID in a force-install list",
        not [
            line
            for line in text.splitlines()
            if name.lower() in line.lower() and re.search(r"forcelist|update_?url", line, re.I)
        ],
    )
    # Every extension ID in the script is one of the three reviewed ones.
    check(
        f"{where} names those three extensions and no other",
        set(re.findall(r"(?<![a-z])[a-p]{32}(?![a-z])", text)) == {CHROME, EDGE, OWN},
    )

if failures:
    print(f"{failures} failed")
    sys.exit(1)
print("All passed")
