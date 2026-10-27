# Set up sign in with Microsoft Entra ID

For an organization's owners and admins, or its IT provider's admins. About 15 minutes. You need an Entra role that can register applications (Application Developer or higher) and, to grant consent for everyone, Cloud Application Administrator or higher. How it works and what it checks: DESIGN.md, "Sign in with Microsoft Entra ID".

Single sign-on proves who someone is. Their master password still unlocks their items, so PassBundle can't open them without it.

## 1. Register an app in Entra

From Microsoft's "Register an application in Microsoft Entra ID":

1. Sign in to the [Microsoft Entra admin center](https://entra.microsoft.com). If you manage several tenants, switch to the organization's own with the Settings icon in the top menu.
2. Go to **Entra ID**, **App registrations**, and choose **New registration**.
3. **Name:** PassBundle (people may see it when they sign in).
4. **Supported account types:** single tenant (accounts in this organizational directory only).
5. **Redirect URI:** choose **Web**, and paste the redirect URI from PassBundle's Single sign-on page (the organization's Settings, Single sign-on). It looks like `https://vault.passbundle.com/identity/connect/oidc-signin`.
6. Choose **Register**.
7. On the app's **Overview** page, copy the **Application (client) ID** and the **Directory (tenant) ID**.

## 2. Make a client secret

1. In the app, open **Certificates & secrets**, **Client secrets**, and choose **New client secret**.
2. Describe it ("PassBundle sign-in") and choose when it expires. Microsoft recommends less than 12 months.
3. Copy its **Value** right away (Entra shows it once). Not the Secret ID.
4. Put a reminder in your calendar a few weeks before it expires: make a new secret, paste it into PassBundle, then delete the old one. Sign-in stops when the secret expires.

## 3. Ask for the email claim and xms_edov

PassBundle recognizes people by their Entra object ID, never their email. The email is used once, for someone you invited who has no PassBundle account yet, and only when it's vouched for: Microsoft's `xms_edov` claim says the email's domain is verified, or, when it doesn't say, the email is at a domain you verify in PassBundle (step 5) and the person isn't a guest in your tenant.

1. In the app, open **Token configuration** and choose **Add optional claim**.
2. Choose **ID**, tick **email**, and add it. If Entra offers to add the Microsoft Graph email permission, accept.
3. Add **xms_edov** the same way. If it isn't in the list, open **Manifest** and add `{ "name": "xms_edov", "essential": false }` to `optionalClaims`, `idToken`, then save. (The portal may warn that it doesn't recognize the claim; Microsoft lists it in its "Optional claims reference".)

## 4. Grant consent, and choose who may sign in

1. In the app, open **API permissions**. Microsoft Graph's **User.Read** is there by default; `openid`, `profile`, and `email` are what PassBundle asks for. Choose **Grant admin consent for** your organization, so people aren't asked to consent the first time.
2. Optional, recommended: go to **Entra ID**, **Enterprise apps**, open PassBundle, and in **Properties** set **Assignment required?** to **Yes**. Then in **Users and groups**, add the people or groups who may sign in. Everyone else is refused by Microsoft before they reach PassBundle.

## 5. Turn it on in PassBundle

1. On the organization's **Settings**, **Single sign-on** page, paste the Directory (tenant) ID, the Application (client) ID, and the client secret's Value.
2. Choose an **SSO identifier**: what people type to find this sign-in, such as `acme-dental`.
3. Tick **Turn on single sign-on** and **Save**. PassBundle checks that Microsoft knows the tenant.
4. Under **Email domains**, add each domain your people's emails are at. PassBundle shows a TXT record for each one; add it to the domain's DNS (at the domain itself, often written `@`, alongside Microsoft 365's own `MS=` record), then choose **Verify**. DNS changes can take a while to show. A domain belongs to one organization.

Now people can sign in: on the sign-in page, they type their email and choose **Use single sign-on**. With a verified domain, they go straight to Microsoft; otherwise they type the SSO identifier. The page also shows a link that starts the sign-in, for an intranet page or a bookmark.

## 6. Optional: require it

Policies, **Require single sign-on**, makes members sign in with it. It needs single sign-on on and the **Single organization** policy. Owners and your IT provider's staff can always sign in with their passwords, and account recovery keeps working.

Before you turn it on, the policy's dialog (and the Single sign-on page) lists the members who aren't linked yet. They aren't locked out: their open sessions end at their next refresh, and when they next sign in with their email and master password (and two-step login, if they use it), PassBundle asks them to link their Microsoft account first, in the web vault. Then Microsoft signs them in and their master password unlocks. The same happens to anyone you unlink while it's on, and to anyone who joins later. Two cases do lock someone out until you act: someone who is also on another IT provider's staff (make them an owner or remove them), and someone turned off in Entra before they linked.

While it's on, the tenant can't change: a new tenant unlinks everyone. Turn the policy off first.

An API key (the command-line tool's) still signs in without single sign-on. With the policy on, the Single sign-on page offers **Replace members' API keys**, so members' old keys stop working; they get a new one from their account settings after signing in with single sign-on.

## Two-step login for admins

Where the organization requires two-step login for admins, a sign-in with its single sign-on counts for its admins and custom roles (not owners, nor your IT provider's staff), because Microsoft asks for MFA. That's yours to set: require MFA for the PassBundle app with Conditional Access (or security defaults). PassBundle can't see it from the usual ID token; when a token does say how someone signed in (`amr`) and that had no MFA, PassBundle asks them to set up two-step login, as after a password.

## Who can sign in

- **Someone invited who has no account yet** (by email, or by provisioning from Entra): they sign in with Microsoft, then choose a master password. Their email must be vouched for (step 3 or 5).
- **Members who already have an account**: they link it themselves. In their vault, they open the organization's menu, choose **Link SSO**, confirm their master password, pick their Microsoft account, and confirm the link on the page that names it. With single sign-on required, PassBundle asks them to when they next sign in with their password. After that, Microsoft signs them in and their email doesn't matter. Their account is emailed whenever it's linked, and leaving the organization unlinks it.
- **Accounts in no organization at a verified domain**: the same way, with Link SSO; they sign in to their own vault.
- **Never:** people who aren't members (they're told so), your IT provider's staff (they use their master password), or an account already linked to a different Microsoft account. To relink someone whose Microsoft account was recreated, unlink them under **Linked accounts**; they're signed out everywhere and link again the same way.

A verified domain vouches for emails at it from the tenant in your settings, whichever that is: keep the tenant ID right, and only let people you trust manage the organization's settings.

## When something goes wrong

The sign-in page says what PassBundle refused, and the organization's event log (Reporting, Event logs) has every sign-in and refusal with the reason. Microsoft's own errors (AADSTS codes, from its "Microsoft Entra authentication and authorization error codes"):

| What you see | Usually means |
|---|---|
| AADSTS50011, the redirect URI doesn't match | The redirect URI in Entra isn't exactly the one on PassBundle's page (step 1.5). |
| AADSTS700016, application not found in the directory | The client ID is wrong, or the app is in another tenant than the tenant ID. |
| AADSTS7000215, invalid client secret | You pasted the Secret ID, or the secret expired. Make a new one (step 2). |
| "This server can't read the organization's single sign-on client secret anymore" | The server's RSA key (`rsa_key.pem`) changed since the secret was saved. Paste the secret again on the Single sign-on page (or make a new one, step 2). |
| AADSTS50105, not assigned to a role for the application | Assignment is required and this person isn't assigned (step 4.2). |
| AADSTS65001, the user or administrator hasn't consented | Grant admin consent (step 4.1). |
| "Microsoft didn't confirm that ... is yours" | Their email's domain isn't verified in PassBundle and the token has no `xms_edov`, or `xms_edov` is false, or they're a guest without `xms_edov` (steps 3 and 5). |
| "... already has a PassBundle account" | They link it themselves: sign in with the email and master password, then link (PassBundle asks if single sign-on is required; otherwise Link SSO in the organization's menu). |
| "... isn't a member of ..." | Invite them first (Members, or provisioning from Entra). |

## Checking it with a real tenant

Not done yet: PassBundle's tests use a stand-in for Entra. With a Microsoft 365 developer tenant, check:

- [ ] Steps 1 to 5 as written; the setup page's steps match what Entra shows.
- [ ] A member with an account uses Link SSO: Microsoft shows its account picker (`prompt=select_account`), the linking page names the right Microsoft account, they get the email, then sign in with Microsoft and unlock with their master password.
- [ ] Someone invited without an account signs in with Microsoft and sets a master password.
- [ ] The ID token carries `email` and `xms_edov` after step 3 (the event log says "not vouched for" when it doesn't).
- [ ] A user not assigned to the app (with Assignment required) is refused by Microsoft with AADSTS50105, and PassBundle shows it.
- [ ] A wrong secret is refused with AADSTS7000215; an expired or deleted one too.
- [ ] Require single sign-on: a member's password sign-in goes to Microsoft; the owner's doesn't. A member not linked yet is taken through linking after their password (and two-step login), then signs in with Microsoft.
- [ ] Account recovery: reset a member's master password; they sign in with Microsoft and unlock with the new one.
- [ ] Conditional Access (for example, requiring MFA for the app) applies at Microsoft's sign-in, with nothing to change here. Whether the ID token carries `amr` with `mfa` after it.
- [ ] A guest (B2B) user in the tenant, invited to the organization: links only by their own invited email.
