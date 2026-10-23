# Event streaming

What an organization's security tools receive when PassBundle sends them its events, and how to set up each kind of receiver. The design and its reasons are in DESIGN.md, "Sending events to security tools".

An organization's owners and admins set it up under Reporting > Event streaming in its admin console. An MSP's admins also have Event streaming in the MSP console, for a feed of every client's events and the MSP's own activity.

## The event

Every destination gets the same event, as JSON (or, for syslog, optionally CEF):

```json
{
  "id": "0f1c2e3d-7a8b-4c5d-9e0f-1a2b3c4d5e6f",
  "time": "2026-10-23T18:04:05.123456Z",
  "type": 1503,
  "name": "Removed a member",
  "category": "member",
  "severity": "medium",
  "organization": { "id": "5b1e…", "name": "Contoso" },
  "actor": { "type": "user", "id": "9c2d…", "email": "admin@contoso.example" },
  "target": { "type": "member", "id": "77aa…", "userId": "41f0…", "email": "left@contoso.example" },
  "device": { "type": 9, "name": "Chrome" },
  "ip": "203.0.113.7",
  "msp": { "id": "e3b9…", "name": "Northwind IT" }
}
```

| Field | What it is |
|---|---|
| `id` | The event's id. An event can arrive more than once; use this to drop repeats. |
| `time` | When it happened, in UTC (RFC 3339). Events may arrive out of order. |
| `type` | The event type's code (below). Stable: write rules against it. |
| `name` | The type in words. Can be reworded; don't match on it. |
| `category` | `user`, `item`, `folder`, `group`, `member`, `organization`, `policy`, `msp`, or `test`. |
| `severity` | `low`, `medium`, or `high`: how much a security team usually cares. |
| `organization` | The organization's id and name. |
| `actor` | Who did it: `{"type": "user", "id", "email"}`, or `{"type": "system"}` when no person did: `{"type": "system", "name": "scim"}` for provisioning from the directory, with the directory's address as `ip`. |
| `target` | What it was about, when there is something: `member` (with `userId` and `email`), `item`, `folder` (a shared folder), `group`, or `policy` (with `policyType`), each by `id`. MSP activity uses `person` with an `email`. |
| `device` | The app it came from: upstream's device type number and its name. |
| `ip` | The address the request came from, as the server saw it. |
| `msp` | Only in an MSP's feed: the MSP. |
| `action`, `detail` | Only for MSP activity: the activity's name (such as `staff_access_changed`) and its detail in words. Events about destinations (below) have a `detail` too. |
| `count`, `lastTime`, `targets`, `ips` | Only on a merged event (below): how many it stands for, when the last happened, and up to 20 different targets and addresses among them. |
| `changes` | Only on events about destinations (1690 to 1693): what changed (below). |

### Merged events

What apps report (item views, shows, copies, and fills, 1107 to 1114 and 1117 to 1132; exports, 1007 and 1602; notice clicks, 1522) and failed logins (1005, 1006), which anyone can make many of, are merged while they wait: one event per type, person, and minute, with `count`, `lastTime` (when the last one happened; `time` is the first), and `targets` and `ips` (up to 20 different ones each). The `id` is the first event's. An event that's already being sent takes no more; the next ones start another. Count with `count` (1 when it's missing). The event log keeps every one.

### Events about destinations

Adding, changing, or removing a destination (1690 to 1692, or 9170 to 9172 for an MSP's), and the server turning one off (1693, or 9173), go to the other destinations with the destination as `target` and what changed:

```json
{
  "type": 1691,
  "name": "Changed a place events are sent",
  "severity": "high",
  "target": {
    "type": "eventDestination",
    "id": "3f0e…",
    "name": "SOC webhook",
    "kind": "webhook",
    "shownTarget": "https://collector.example/…",
    "enabled": false
  },
  "changes": ["turned off"],
  "detail": "Changed: turned off. It's off."
}
```

`changes` lists `name`, `settings`, `where it sends`, `new signing secret`, `turned on`, and `turned off`; `enabled` says whether it's on now. A 1693 is by no one (`"actor": {"type": "system"}`) and its `detail` says why, such as "The server turned this destination off. It answered HTTP 410." For an MSP's destinations, `detail` names the destination, its id, and what changed. Never a URL's path, a token, or a secret.

Never in an event: item or folder names, anything inside the vault, passwords, keys, or tokens. The server can't read the vault, and an event says nothing the event log doesn't already keep.

### Types

Organization events use upstream's codes; 1190, 1191, and 1690 to 1693 are PassBundle's.

| Code | Name | Severity |
|---|---|---|
| 1000 | Logged in | low |
| 1001 | Changed their master password | medium |
| 1002 | Updated two-step login | medium |
| 1003 | Turned off two-step login | high |
| 1004 | Recovered their account with a two-step recovery code | high |
| 1005 | Failed to log in: wrong password | medium |
| 1006 | Failed to log in: wrong two-step code | medium |
| 1007 | Exported their vault | high |
| 1010 | Asked to approve a new device | low |
| 1100 | Created an item | low |
| 1101 | Edited an item | low |
| 1102 | Deleted an item for good | medium |
| 1103, 1104 | Added or deleted an attachment | low |
| 1105 | Moved an item to the organization | low |
| 1106 | Changed an item's shared folders | low |
| 1107 | Viewed an item | low |
| 1108 to 1113, 1117 to 1132 | Showed or copied a password, hidden field, card code or number, or another sensitive field | low |
| 1114 | Filled an item | low |
| 1115, 1116 | Moved an item to the trash, or restored it | low |
| 1190, 1191 | Cleared an item's history, or deleted a past version | medium |
| 1300, 1301, 1302 | Created, edited, or deleted a shared folder | low, low, medium |
| 1400, 1401, 1402 | Created, edited, or deleted a group | low, low, medium |
| 1500, 1501 | Invited or confirmed a member | low |
| 1502 | Edited a member's role or access | high |
| 1503 | Removed a member | medium |
| 1504 | Changed a member's groups | low |
| 1506, 1507 | Enrolled in, or withdrew from, account recovery | low, medium |
| 1508 | Reset a member's master password | high |
| 1511, 1512 | Revoked or restored a member | medium, low |
| 1513, 1514 | Approved or denied a device for a member | medium, low |
| 1515 | Deleted a member's account | high |
| 1516 | Left the organization | low |
| 1519 | Reset a member's two-step login | high |
| 1600 | Edited the organization's settings | medium |
| 1601 | Purged the organization's vault | high |
| 1602 | Exported the organization's vault | high |
| 1690 | Added a place events are sent | high |
| 1691 | Changed a place events are sent | high |
| 1692 | Removed a place events are sent | high |
| 1693 | The server stopped sending to a place events are sent | high |
| 1700 | Changed a policy | medium |
| 9000 | Test event (the Test button) | low |

An MSP's feed also gets its activity log:

| Code | Name |
|---|---|
| 9100, 9101, 9102 | Created the MSP; added a client; a client stopped being managed by the MSP (high) |
| 9110 to 9116 | Staff: invited, joined, invitation cancelled, role changed (high), technician's access changed (high), removed, added |
| 9120 to 9126 | Joining: a member confirmed in a client, joined with an install command, install command replaced, its email domains changed, joining defaults and clients' own settings |
| 9130, 9131 | Default policies changed; a client put back on a default |
| 9140 to 9143 | Templates shared, changed, stopped; a client's templates folder |
| 9150, 9151 | Site rules added or removed |
| 9160, 9161, 9162 | Script access: token made (high), revoked, used from a new address |
| 9165 to 9168 | Provisioning from Microsoft Entra ID: token made (high), replaced (high), revoked; people the directory added let in |
| 9170 to 9173 | The MSP's own destinations: added, changed, removed, stopped by the server (all high) |
| 9199 | Other MSP activity, with its `action` |

## Webhook

Each event is one HTTPS `POST` of the event's JSON, with `Content-Type: application/json` and three headers, signed the [Standard Webhooks](https://www.standardwebhooks.com/) way, so its libraries can check them:

- `webhook-id`: the event's id.
- `webhook-timestamp`: when it was sent, in seconds since 1970.
- `webhook-signature`: `v1,` and the base64 HMAC-SHA256 of `<webhook-id>.<webhook-timestamp>.<body>`, keyed with the bytes of the signing secret after `whsec_` (base64).

The signing secret is shown once: when the destination is added, when a new one is made (New secret), and when the webhook is pointed at another host. A receiver should check the signature against the raw body, refuse timestamps more than a few minutes old, and drop an id it has already seen. Any 2xx answer means delivered. Anything else is retried; 410 Gone stops the destination. Redirects aren't followed.

A receiver has 5 seconds to connect and 10 to answer, and should answer within 5. A slower answer still counts as delivered, but the destination is then slow: it's sent to less often (from 10 seconds to 10 minutes apart) until it's quick again, and the console says "Slow" and why. The same goes for one that takes more than a second an event over a turn. Slow is never failing: only failures (no answer, or anything but 2xx) are retried as failures, and only a day of them (or 410 Gone) turns a destination off.

When someone turns a destination off, removes it, or points it somewhere else, it gets one last event first (type 1691 or 1692, or 9171 or 9172 for an MSP's feed) with a `detail` saying so.

Checking a request in Node:

```js
import { createHmac, timingSafeEqual } from "node:crypto";

function verify(headers, rawBody, secret) {
  const id = headers["webhook-id"];
  const timestamp = Number(headers["webhook-timestamp"]);
  if (Math.abs(Date.now() / 1000 - timestamp) > 300) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${rawBody}`).digest();
  return headers["webhook-signature"].split(" ").some((entry) => {
    const [version, signature] = entry.split(",");
    const given = Buffer.from(signature ?? "", "base64");
    return version === "v1" && given.length === expected.length && timingSafeEqual(given, expected);
  });
}
```

For a collector that wants its own token in a header (many HTTP log collectors do), set **Header** to its name, such as `Authorization`, and **Header value** to what the collector gives you. A token that's part of the collector's URL can stay in the URL: the console only ever shows the URL's scheme and host, and the URL field is masked (with a button to show what's typed). Any change to the URL, the header's name, or the certificate authority asks for the header's value again, and a change to the certificate authority asks for the URL again too. What a receiver answers is shown with the URL's tokens and path taken out.

If a test says it couldn't connect or complete TLS, check the host and port, that it's reachable from the PassBundle server, and its certificate. That message is the same for every cause before a connection is made, and comes 16 seconds after the test started whatever the cause; the server's log has the details. One test runs at a time per organization and per person.

## Syslog over TLS

One RFC 5424 message per event, framed by octet counting as RFC 5425 describes (the message's length in bytes, a space, then the message), over TLS. The default port is 6514.

```
<109>1 2026-10-23T18:04:05.123456Z vault.passbundle.com passbundle - 1503 - {"id":"0f1c…","type":1503,…}
```

- **PRI:** facility 13 (log audit), with severity 6 (informational) for low events, 5 (notice) for medium, and 4 (warning) for high.
- **HOSTNAME:** the PassBundle server's host. **APP-NAME:** `passbundle`. **MSGID:** the event type's code. No structured data, and no byte order mark, so the message parses as JSON.
- **Message:** the event's JSON, or CEF.

CEF (version 0) puts the vendor and product `PassBundle`, the server's version, the event type as the signature id, the name, and a severity (3 low, 5 medium, 7 high) in the header, then:

| Key | Holds |
|---|---|
| `rt` | The event's time, in milliseconds since 1970 |
| `externalId` | The event's id |
| `cat`, `act` | The category and the name |
| `suid`, `suser` | Who acted: their id and email (`suser=system` when no person did) |
| `src` | The address |
| `requestClientApplication` | The app's name |
| `duid`, `duser` | The member the event was about: their user id and email |
| `cs1` to `cs6` | `organizationId`, `organizationName`, `targetType`, `targetId`, `mspId`, `mspName`, each labeled in `csNLabel` |
| `cn1` | The device type number, labeled `deviceType` |

The collector's certificate must be valid for the host name or address entered. For a collector whose certificate comes from a company's own certificate authority, paste that CA's certificate (PEM) into **Certificate authority**. A collector that doesn't take TLS can sit behind a relay that does (rsyslog or syslog-ng with a TLS input that forwards to it).

## Microsoft Sentinel

PassBundle sends to a custom table through Azure Monitor's Logs Ingestion API. In Azure:

1. **A table:** in the Log Analytics workspace Sentinel uses, create a custom table (DCR-based), for example `PassBundleEvents_CL`, with these columns. Creating it in the portal also creates the data collection rule; use `source` as the transformation.

   | Column | Type |
   |---|---|
   | TimeGenerated | datetime |
   | EventId, EventName, Category, Severity | string |
   | EventType | int |
   | OrganizationId, OrganizationName | string |
   | ActorType, ActorId, ActorEmail | string |
   | TargetType, TargetId, TargetUserId, TargetEmail | string |
   | IpAddress, DeviceName | string |
   | DeviceType | int |
   | MspId, MspName, Action, Detail | string |

2. **The rule:** note its **immutable ID** (`dcr-…`), its **logs ingestion endpoint** (in the rule's JSON view) or a data collection endpoint's, and the **stream** its stream declarations name (it starts with `Custom-`).
3. **An app registration** with a client secret, given the **Monitoring Metrics Publisher** role on the data collection rule.
4. In PassBundle, add a **Microsoft Sentinel** destination with the directory (tenant) ID, the application (client) ID and its secret, the endpoint, the rule's immutable ID, and the stream.

PassBundle signs in as the app (client credentials, scope `https://monitor.azure.com//.default`), keeps the token until shortly before it expires, and uploads events in batches under the API's 1 MB limit. Changing the tenant, the app, or the endpoint asks for the client secret again. Sentinel trusts the system's certificate authorities only. A self-hosted server in Azure Government or Azure in China sets `EVENT_STREAMING_AZURE_LOGIN_URL`, `EVENT_STREAMING_AZURE_SCOPE`, and `EVENT_STREAMING_AZURE_INGEST_SUFFIX` in its environment (the admin page shows them but can't change them). The server starts only if they're https and Microsoft's: `https://login.microsoftonline.us` or `https://login.chinacloudapi.cn` (or `.com`, or `login.partner.microsoftonline.cn`), a scope on `monitor.azure.us` or `monitor.azure.cn`, and an ingestion domain under one of those, such as `.ingest.monitor.azure.us`.

Another way, without an app registration: a webhook to an Azure Function that checks the signature and writes to the table. A Logic App's HTTP trigger can't check an HMAC signature on its own, so don't use one alone.

## Huntress, Blumira, and others

- **Huntress Managed SIEM** collects syslog with its agent on a computer at the site. Add a syslog source for PassBundle in Huntress, then a **Syslog over TLS** destination pointing at that computer's address and the port Huntress listens on. If its listener doesn't take TLS, put a TLS relay in front of it (above). PassBundle's hosted service reaches it only if that address is reachable from the internet.
- **Blumira:** add an HTTP ingestion source in Blumira, then a **Webhook** destination with the URL Blumira gives you; if it also gives a token for the Authorization header, set **Header** to `Authorization` with that value. For Blumira's sensor instead, use **Syslog over TLS** to the sensor.
- **Anything else** that takes HTTPS JSON (with or without a token header) or syslog over TLS works the same way. Use **Test** to send a sample event (type 9000) and check that it arrives.

## Self-hosted servers

- Events are sent only while the event log is on (`ORG_EVENTS_ENABLED`, on by default). Someone in several organizations logs in once per organization in the event log, so an MSP's feed gets an admin's login once for each client.
- Destinations must be public addresses (IPv6: global unicast only). For security tools on the server's own network, the server's admin lists them in `EVENT_STREAMING_ALLOWED_NETWORKS`: networks, addresses, or host names, separated by commas, each with an optional port, such as `10.20.0.0/16, 192.168.1.20:6514, [fd00::5]:443, siem.corp.example:443`. A host name entry lets that name reach private addresses; loopback needs a loopback entry of its own (`127.0.0.1`). Link-local addresses, cloud metadata services, and whatever `HTTP_REQUEST_BLOCK_REGEX` matches are refused anyway.
- The destinations' secrets are encrypted with a key derived from `rsa_key.pem` in the data folder. Back the data folder up, and keep that backup apart from the database's (another place, other credentials): someone with both could read the secrets. A database restored without it signs everyone out, and every destination asks for its secrets again.
- Each person can set up destinations in at most 20 organizations and MSPs; another admin can add more there. The server shares its sending time fairly between the people who set destinations up, and sends to at most two of one person's at a time, so one person's slow destinations can't hold up anyone else's.
- Apps report events (views, copies, exports) through `/events/collect`: at most 500 a request, and 30 requests in a row and then one every 2 seconds per person (429 past that).
- `EVENT_STREAMING_AZURE_TEST` and `EVENT_STREAMING_AZURE_CA_FILE` are for a test stand-in: the first lets Sentinel's settings name any https host and allows the second, which replaces the certificate authorities Sentinel's sign-in and uploads trust. Leave both unset.
