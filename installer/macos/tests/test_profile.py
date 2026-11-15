"""Checks make-profile.sh's configuration profiles: each is a valid profile
with what its options ask for and nothing else, the same options make the same
profile, and bad values are refused. Only an MDM installs a profile, so CI
reads them instead. Also checks the Mac, Linux, and Windows scripts name the
same extensions, and the same one of PassBundle's own as DESIGN.md, which is
never force-installed, and that each script that turns off Chrome's password
manager, card autofill, or address autofill turns off Firefox's too, with the
same options. It installs nothing.

    python3 installer/macos/tests/test_profile.py
"""

import itertools
import json
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


PAYLOAD_KEYS = {"PayloadType", "PayloadIdentifier", "PayloadUUID", "PayloadVersion", "PayloadDisplayName"}
# The browsers' own password manager, card autofill, and address autofill:
# the policies the scripts turn off. Firefox reads the same three names, and
# its password manager takes OfferToSaveLogins too.
TURNED_OFF = ("PasswordManagerEnabled", "AutofillCreditCardEnabled", "AutofillAddressEnabled")


def off(policies):
    """The policies that are set to false."""
    return {key for key, value in policies.items() if value is False}


def firefox_for(chrome_off):
    """What Firefox should have off, for what Chrome has off."""
    wanted = chrome_off & set(TURNED_OFF)
    return wanted | ({"OfferToSaveLogins"} if "PasswordManagerEnabled" in wanted else set())


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


# The least: both browsers, our extension forced, their password managers
# off, and Firefox's.
text, p = profile()
items = payloads(p)
check("a plain profile is a valid system profile", is_valid_profile(p))
check("it's com.passbundle.profile", p["PayloadIdentifier"] == "com.passbundle.profile")
check(
    "Chrome, Edge, and Firefox, nothing else",
    len(p["PayloadContent"]) == len(items)
    and set(items) == {"com.google.Chrome", "com.microsoft.Edge", "org.mozilla.firefox"},
)
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
firefox = items.get("org.mozilla.firefox", {})
check("Firefox reads enterprise policies from the profile", firefox.get("EnterprisePoliciesEnabled") is True)
check("Firefox password manager off", firefox.get("PasswordManagerEnabled") is False)
check("Firefox doesn't offer to save passwords", firefox.get("OfferToSaveLogins") is False)
check(
    "Firefox gets nothing else: no extension, no other preference",
    set(firefox) - PAYLOAD_KEYS == {"EnterprisePoliciesEnabled", "PasswordManagerEnabled", "OfferToSaveLogins"},
)
check("Firefox's payload is com.passbundle.profile.firefox", firefox.get("PayloadIdentifier") == "com.passbundle.profile.firefox")
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
    set(firefox) - PAYLOAD_KEYS
    == {
        "EnterprisePoliciesEnabled",
        "PasswordManagerEnabled",
        "OfferToSaveLogins",
        "AutofillCreditCardEnabled",
        "AutofillAddressEnabled",
    },
)
check("Firefox gets none of the extension's settings", not settings(firefox))
_, card_only = profile("--disable-card-autofill")
firefox = payloads(card_only).get("org.mozilla.firefox", {})
check("card only: Firefox card autofill off", firefox.get("AutofillCreditCardEnabled") is False)
check("card only: Firefox address autofill untouched", "AutofillAddressEnabled" not in firefox)
check("card only: Firefox password manager still off", firefox.get("PasswordManagerEnabled") is False)
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
check("one browser only, and Firefox untouched with nothing to turn off there", set(items) == {"com.microsoft.Edge"})
check("its password manager kept", "PasswordManagerEnabled" not in items["com.microsoft.Edge"])
check("its native-messaging hosts still from /Library only", items["com.microsoft.Edge"]["NativeMessagingUserLevelHosts"] is False)

_, p = profile("--keep-browser-password-manager", "--disable-address-autofill")
firefox = payloads(p).get("org.mozilla.firefox", {})
check(
    "password manager kept: Firefox gets only address autofill off",
    set(firefox) - PAYLOAD_KEYS == {"EnterprisePoliciesEnabled", "AutofillAddressEnabled"}
    and firefox["AutofillAddressEnabled"] is False,
)

# Firefox has off what Chrome and Edge have off, for every combination of the
# options that turn things off (and the browsers chosen, which Firefox isn't
# one of).
matched = 0
combinations = 0
for keep, card, address, browsers in itertools.product((False, True), (False, True), (False, True), ("chrome", "edge", "chrome,edge")):
    args = ["--browsers", browsers]
    args += ["--keep-browser-password-manager"] * keep + ["--disable-card-autofill"] * card + ["--disable-address-autofill"] * address
    _, p = profile(*args)
    items = payloads(p)
    for browser in [b for b in ("com.google.Chrome", "com.microsoft.Edge") if b in items]:
        combinations += 1
        firefox = items.get("org.mozilla.firefox", {})
        wanted = firefox_for(off(items[browser]))
        has = off(firefox)
        if has == wanted and (not wanted or firefox.get("EnterprisePoliciesEnabled") is True) and (wanted or not firefox):
            matched += 1
        else:
            print(f"      {' '.join(args)}: {browser} has {sorted(off(items[browser]))} off, Firefox {sorted(has)}")
check(f"Firefox has off what Chrome or Edge has off, for every combination ({matched} of {combinations})", matched == combinations == 32)

_, p = profile("--browsers", "edge", "--enrollment-token", TOKEN)
items = payloads(p)
check(
    "one browser's extension settings only, under its store ID and our own (and Firefox's password manager off)",
    len(p["PayloadContent"]) == len(items)
    and set(items)
    == {
        "com.microsoft.Edge",
        f"com.microsoft.Edge.extensions.{EDGE}",
        f"com.microsoft.Edge.extensions.{OWN}",
        "org.mozilla.firefox",
    },
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

# Firefox's policies wherever Chrome's are, under the same options. The Mac
# profile is checked above, for every combination. Linux: the file the script
# writes for Chrome and the one it writes whole for Firefox, from the script's
# own functions, for every combination, and the options reaching both the same
# way (installer/linux/tests/test_firefox_policies.py checks adding them to
# another vendor's file, and that a Firefox installation's own policies file
# stops the script writing its own). Windows can't run here, so its lines are
# read.
linux = LINUX.read_text(encoding="utf-8")


def function(text, name):
    """A shell function's definition, from its name to its closing brace."""
    found = re.search(rf"^{name}\(\) \{{.*?^\}}", text, re.M | re.S)
    return found.group(0) if found else "false"


def shell(*lines):
    run = subprocess.run(["sh", "-c", "\n".join(lines)], capture_output=True, text=True)
    return run.stdout if run.returncode == 0 else None


matched = 0
for keep, card, address in itertools.product(("", "yes"), repeat=3):
    chrome = shell(
        "extension_settings() { :; }",
        function(linux, "policy"),
        f'keep_password_manager="{keep}" card="{card}" address="{address}"',
        f'policy "{CHROME}" "https://clients2.google.com/service/update2/crx"',
    )
    firefox = shell(function(linux, "firefox_policy"), f'firefox_policy "{"" if keep else "yes"}" "{card}" "{address}"')
    try:
        chrome_off = off(json.loads(chrome))
        firefox_policies = json.loads(firefox)["policies"] if firefox else {}
    except (TypeError, ValueError, KeyError):
        continue
    if off(firefox_policies) == firefox_for(chrome_off) and set(firefox_policies) == off(firefox_policies):
        matched += 1
check(
    f"linux/install-passbundle.sh: Firefox's file has off what Chrome's has off, and nothing else, for every combination ({matched} of 8)",
    matched == 8,
)
check(
    "linux/install-passbundle.sh: Firefox's password policies follow --keep-browser-password-manager, as Chrome's and Edge's do",
    'firefox_password=yes\n  [ -z "$keep_password_manager" ] || firefox_password=""' in linux
    and 'install_firefox_policy "$firefox_password" "$card" "$address"' in linux
    and 'firefox_policy "$1" "$2" "$3" > "$firefox_written"' in function(linux, "install_firefox_policy")
    and 'merge_firefox_policy "$1" "$2" "$3"' in function(linux, "install_firefox_policy"),
)
merge = re.search(r"<< 'PYTHON'\n(.*?)\nPYTHON\n", linux, re.S)
check(
    "linux/install-passbundle.sh: adding to another vendor's file takes the same four policies from the same options",
    bool(merge)
    and 'wanted = {\n    "PasswordManagerEnabled": password,\n    "OfferToSaveLogins": password,\n'
    '    "AutofillCreditCardEnabled": card,\n    "AutofillAddressEnabled": address,\n}' in merge.group(1),
)
check(
    "linux/install-passbundle.sh: Firefox's file is only Mozilla's system-wide one",
    re.findall(r'^FIREFOX_POLICY="([^"]*)"$', linux, re.M) == ["/etc/firefox/policies/policies.json"],
)

start = windows.find("# Firefox: its password manager")
windows_firefox = windows[start:] if start >= 0 else ""
check(
    "windows/Install-PassBundle.ps1: Firefox's policies go under Mozilla's key",
    '$FirefoxRoot = "HKLM:\\SOFTWARE\\Policies\\Mozilla\\Firefox"' in windows
    and '$FirefoxPasswordPolicies = @("PasswordManagerEnabled", "OfferToSaveLogins")' in windows,
)
check(
    "windows/Install-PassBundle.ps1: Firefox's password policies are off unless -KeepBrowserPasswordManager, as Chrome's and Edge's are",
    'if (-not $KeepBrowserPasswordManager) { Set-Dword $root "PasswordManagerEnabled" 0 }' in windows
    and bool(
        re.search(
            r'foreach \(\$name in \$FirefoxPasswordPolicies\) \{\s*'
            r'if \(\$KeepBrowserPasswordManager\) \{ Remove-OwnAutofillPolicy "Firefox" \$FirefoxRoot \$name \}\s*'
            r'else \{ Set-OwnAutofillPolicy "Firefox" \$FirefoxRoot \$name \}',
            windows_firefox,
        )
    ),
)
check(
    "windows/Install-PassBundle.ps1: Firefox's card and address autofill follow the same options as Chrome's and Edge's",
    "Set-AutofillPolicies $browser $root" in windows and 'Set-AutofillPolicies "Firefox" $FirefoxRoot' in windows_firefox,
)
check(
    "windows/Install-PassBundle.ps1: -Remove takes back all four of Firefox's",
    'foreach ($name in $FirefoxPasswordPolicies + @("AutofillCreditCardEnabled", "AutofillAddressEnabled")) {\n'
    '    Remove-OwnAutofillPolicy "Firefox" $FirefoxRoot $name' in windows_firefox,
)
# Nothing installs an extension in Firefox: ours isn't signed by Mozilla yet.
for script in (MAKE, LINUX, WINDOWS):
    check(
        f"{script.parent.name}/{script.name} installs no Firefox extension",
        not re.search(r"ExtensionSettings|\"Extensions\"|moz-extension|\.xpi", script.read_text(encoding="utf-8")),
    )

if failures:
    print(f"{failures} failed")
    sys.exit(1)
print("All passed")
