# Self-Hosting Plenary with OIDC, Google & Microsoft Entra ID

Plenary supports **simultaneous multi-provider SSO**: you can enable **Google Workspace**, **Microsoft Entra ID**, and a **Generic OIDC** provider independently or at the same time. Enabled providers are advertised by `GET /auth/providers`, selected via `GET /auth/login?provider=google|microsoft|oidc`, and share a single `OIDC_REDIRECT_URI` matching `PUBLIC_URL`'s origin.

Generic OIDC supports any standards-compliant OpenID Connect provider via discovery (`/.well-known/openid-configuration`), Authorization Code Flow with **PKCE (`S256`)**, and JWKS (`RS256` / `ES256`) ID-token verification.

## Quick Start

Drop in your server URL, signing key, and one or more identity providers:

```env
PUBLIC_URL=https://plenary.example.com
OIDC_REDIRECT_URI=https://plenary.example.com/auth/callback
COOKIE_KEY=<at-least-32-random-bytes>

# Generic OIDC (optional — can run alongside Google and/or Microsoft)
OIDC_ISSUER_URL=https://auth.example.com
OIDC_CLIENT_ID=plenary
OIDC_CLIENT_SECRET=<your-client-secret>

# Microsoft Entra ID native adapter (optional)
# MICROSOFT_CLIENT_ID=<entra-app-client-id>
# MICROSOFT_CLIENT_SECRET=<entra-client-secret>
# MICROSOFT_TENANT_ID=common

# Google Workspace SSO (optional)
# GOOGLE_CLIENT_ID=<google-client-id>
# GOOGLE_CLIENT_SECRET=<google-client-secret>
```

Register `https://plenary.example.com/auth/callback` as an allowed Redirect URI in each configured identity provider. Half-configured providers (for example, `MICROSOFT_CLIENT_ID` without `MICROSOFT_CLIENT_SECRET`) log a warning and remain off without preventing startup.

---

## Microsoft Entra ID (Native Multi-Tenant / Single-Tenant)

Set `MICROSOFT_CLIENT_ID` and `MICROSOFT_CLIENT_SECRET` (plus optional `MICROSOFT_TENANT_ID`) to use Plenary's built-in Microsoft Entra ID v2.0 OIDC adapter:

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `MICROSOFT_CLIENT_ID` | Yes | — | Entra App Registration Application (client) ID. |
| `MICROSOFT_CLIENT_SECRET` | Yes | — | Entra App Registration client secret value. |
| `MICROSOFT_TENANT_ID` | No | `common` | Accepted values: `common` (work/school + personal Microsoft accounts), `organizations` (work/school only; rejects personal MSA), `consumers` (personal MSA only), or a specific Entra tenant GUID (`UUID`). |

- **Identity & tenant mapping:** Verifies `RS256` tokens against `https://login.microsoftonline.com/<tenant>/discovery/v2.0/keys`, enforces `tid` and exact `iss` (`https://login.microsoftonline.com/<tid>/v2.0`), identifies users as `microsoft:<oid|sub>`, extracts email from `email` or `preferred_username` (unless `email_verified === false`), and assigns `domain` from the verified corporate email for work/school tenants.
- **When to use Generic OIDC for Entra instead:** If you need ID-token group gating (`OIDC_ALLOWED_GROUPS` / `OIDC_GROUPS_CLAIM`), `OIDC_TENANT_SLUG`, or `OIDC_ALLOW_UNVERIFIED_EMAIL=1`, configure Entra via `OIDC_ISSUER_URL=https://login.microsoftonline.com/<tenant-id>/v2.0` (see the Generic OIDC Entra example below).

---

## Verified Email & Domain Auto-Provisioning

| Variable | Default | Description |
| --- | --- | --- |
| `PLENARY_TRUST_VERIFIED_EMAIL` | `false` (unset) | Set to `1` or `true` to derive a corporate `domain` from verified non-consumer emails on **Google** accounts lacking an `hd` claim (`email_verified === true`) and personal **Microsoft MSA** accounts (`email_verified !== false`). Never applies to Generic OIDC (`OIDC_TENANT_DOMAIN` / `oidc:<slug>` governs Generic OIDC). Excluded consumer domains (never promoted to an org): `gmail.com`, `googlemail.com`, `outlook.com`, `hotmail.com`, `live.com`, `msn.com`, `yahoo.com`, `icloud.com`, `me.com`, `proton.me`, `protonmail.com`. |
| `PLENARY_AUTO_PROVISION_DOMAIN_ORGS` | `1` (enabled) | Set to `0` to disable automatic org creation on first corporate sign-in. When enabled, the first verified `google:` or `microsoft:` user for a corporate `domain` without an existing tenant atomically creates that tenant and receives initial Unit admin (recorded as an `autoProvisioned: true` `tenant.create` audit event). Subsequent users do not receive admin automatically. |

---

## Entra ID Group Sync Status

Distinguish between what is live at runtime today and composable server modules awaiting wiring:

- **Live today in `server/main.js`:**
  1. Native Microsoft Entra ID OIDC sign-in (`MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_TENANT_ID`).
  2. ID-token group gating (`OIDC_ALLOWED_GROUPS` + `OIDC_GROUPS_CLAIM`) when Entra (or Okta, Keycloak, etc.) is configured as a Generic OIDC provider (`OIDC_ISSUER_URL`).
- **Implemented & unit-tested, not yet auto-mounted in `server/main.js`:**
  - Microsoft Graph → Plenary Teams directory sync (`server/ports/entra-directory.js`, `server/core/auth/entra-sync.js`, `server/adapters/driven/auth/entra-graph.js`, and `server/adapters/driving/entra-sync-http.js`, verified in `test/server/entra-sync.test.js`) provides `GET /tenants/:tenant/entra/groups` and `POST /tenants/:tenant/entra/sync` as composable server adapters, and is **not** wired into `server/main.js` yet (no Entra Graph sync environment variables are read by `server/main.js`).

---

## Generic OIDC Environment Variables

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `OIDC_ISSUER_URL` | Yes | — | Issuer base URL (must use `https://` in production; `/.well-known/openid-configuration` is appended automatically). |
| `OIDC_CLIENT_ID` | Yes | — | OAuth 2.0 / OIDC client ID. |
| `OIDC_CLIENT_SECRET` | Yes | — | OAuth 2.0 / OIDC client secret. |
| `OIDC_REDIRECT_URI` | Prod | `http://localhost:8080/auth/callback` | Callback URL registered at your IdP (must match `PUBLIC_URL`'s origin). Shared across all active SSO providers. |
| `OIDC_SCOPES` | No | `openid email profile` | Space-separated OIDC scopes (`openid` is always included). |
| `OIDC_DISPLAY_NAME` | No | `SSO` | Display name for the provider button and auto-provisioned tenant (e.g. `Okta`, `Pocket ID`). |
| `OIDC_TENANT_SLUG` | No | normalized issuer host + path hash | Short slug for issuer-bound tenancy (`oidc:<slug>`) and user IDs (`oidc:<slug>:<sub>`). |
| `OIDC_TENANT_DOMAIN` | No | `oidc:<slug>` | Explicit tenant domain binding configured by the operator (e.g. `acme.com`). |
| `OIDC_EMAIL_DOMAINS` | No | `OIDC_TENANT_DOMAIN` if DNS, else none | Comma-separated authoritative email domains allowed to claim email board invites (e.g. `acme.com,corp.example`). Emails outside this list are stripped (`email: null`). |
| `OIDC_ALLOWED_GROUPS` | No | — | Comma-separated group names required in the ID token's groups claim to sign in (optional membership gate). |
| `OIDC_GROUPS_CLAIM` | No | `groups` | ID token claim name inspected when `OIDC_ALLOWED_GROUPS` is set. |
| `OIDC_ADMIN_USERS` | No | — | Comma-separated OIDC `sub` values (or full `oidc:<slug>:<sub>` IDs) granted Unit admin on startup. |
| `OIDC_ALLOW_UNVERIFIED_EMAIL` | No | `0` | Set to `1` only for lab/dev IdPs (or Generic OIDC Entra ID setups) that omit `email_verified: true`. Unverified emails are still stripped (`email: null`) and cannot claim invites. |
| `OIDC_ALLOW_HTTP_LOCALHOST` | No | `1` in local dev, `0` in prod | Set to `1` to allow `http://localhost` / `http://127.0.0.1` issuer URLs during local testing. |

## Security Model

- **Issuer-bound tenancy:** Unlike Google Workspace's verified `hd` claim, generic OIDC providers do not carry a Workspace domain claim and email domains can be spoofed. Plenary binds generic OIDC tenant membership strictly to the configured issuer (`oidc:<slug>` or operator-configured `OIDC_TENANT_DOMAIN`), including a digest of any issuer path so distinct realms/tenants on the same host never collide.
- **Membership boundary warning:** Without `OIDC_ALLOWED_GROUPS` (or IdP-side client assignment), every user who can authenticate to your Generic OIDC client joins the tenant as a member. **Never** point `OIDC_ISSUER_URL` at an open public IdP (such as `https://accounts.google.com` — use `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` for Google Workspace instead).
- **Invite hijack protection:** Verified emails are only carried on `Identity.email` when their domain is explicitly authorized via `OIDC_EMAIL_DOMAINS` (or a DNS `OIDC_TENANT_DOMAIN`) for Generic OIDC, Google's verified `hd`, Microsoft work/school verified email, or `PLENARY_TRUST_VERIFIED_EMAIL=1`. All other addresses are stripped to `null`.
- **Strict verification:** Enforces PKCE (`S256`), `state` CSRF binding, `nonce` replay protection, exact `iss` match (OIDC Core §3.1.3.7), `aud`/`azp`, `exp`/`iat`/`nbf`, and `RS256`/`ES256` JWKS signature verification.
- **Verified emails:** Requires `email_verified === true` by default.
- **SSRF protection:** Rejects non-HTTPS endpoints in production, redirects on discovery/token/JWKS calls, and private/link-local/cloud-metadata IP literals.

---

## Provider Examples

### Pocket ID

```env
OIDC_ISSUER_URL=https://id.example.com
OIDC_CLIENT_ID=<pocket-id-client-id>
OIDC_CLIENT_SECRET=<pocket-id-client-secret>
OIDC_DISPLAY_NAME=Pocket ID
OIDC_REDIRECT_URI=https://plenary.example.com/auth/callback
```

In Pocket ID: create an OIDC Client with Callback URL `https://plenary.example.com/auth/callback` and PKCE enabled.

### Authentik

```env
OIDC_ISSUER_URL=https://authentik.example.com/application/o/plenary/
OIDC_CLIENT_ID=<authentik-client-id>
OIDC_CLIENT_SECRET=<authentik-client-secret>
OIDC_DISPLAY_NAME=Authentik
OIDC_REDIRECT_URI=https://plenary.example.com/auth/callback
```

In Authentik: create an **OAuth2/OpenID Provider** (Confidential client, signing key RS256 or ES256) with Redirect URI `https://plenary.example.com/auth/callback`, attached to an Application with slug `plenary`.

### Keycloak

```env
OIDC_ISSUER_URL=https://keycloak.example.com/realms/myorg
OIDC_CLIENT_ID=plenary
OIDC_CLIENT_SECRET=<keycloak-client-secret>
OIDC_DISPLAY_NAME=Keycloak
OIDC_TENANT_SLUG=myorg
OIDC_REDIRECT_URI=https://plenary.example.com/auth/callback
```

In Keycloak: create an OpenID Connect client with **Client authentication** ON, **Standard flow** ON, Valid redirect URI `https://plenary.example.com/auth/callback`, and PKCE Code Challenge Method `S256`.

### Okta

```env
OIDC_ISSUER_URL=https://your-org.okta.com/oauth2/default
OIDC_CLIENT_ID=<okta-client-id>
OIDC_CLIENT_SECRET=<okta-client-secret>
OIDC_DISPLAY_NAME=Okta
OIDC_REDIRECT_URI=https://plenary.example.com/auth/callback
```

In Okta: create an **OIDC - Web Application** with Grant Type **Authorization Code**, Sign-in redirect URI `https://plenary.example.com/auth/callback`, and assign users/groups.

### Auth0

```env
OIDC_ISSUER_URL=https://your-tenant.us.auth0.com
OIDC_CLIENT_ID=<auth0-client-id>
OIDC_CLIENT_SECRET=<auth0-client-secret>
OIDC_DISPLAY_NAME=Auth0
OIDC_REDIRECT_URI=https://plenary.example.com/auth/callback
```

In Auth0: create a **Regular Web Application** and add `https://plenary.example.com/auth/callback` to **Allowed Callback URLs**.

### Microsoft Entra ID via Generic OIDC (Group-Gated Single-Tenant)

Use Generic OIDC instead of `MICROSOFT_*` when you want ID-token group gating (`OIDC_ALLOWED_GROUPS` / `OIDC_GROUPS_CLAIM`) or `OIDC_TENANT_SLUG`:

```env
OIDC_ISSUER_URL=https://login.microsoftonline.com/<tenant-id>/v2.0
OIDC_CLIENT_ID=<application-client-id>
OIDC_CLIENT_SECRET=<client-secret-value>
OIDC_DISPLAY_NAME=Entra ID
OIDC_TENANT_SLUG=contoso
OIDC_ALLOWED_GROUPS=<group-object-id-or-name>
OIDC_REDIRECT_URI=https://plenary.example.com/auth/callback
```

In Entra ID: **App registrations → New registration**, add Web Redirect URI `https://plenary.example.com/auth/callback`, create a Client Secret, and under **Token configuration** include the `email` optional claim (and `groups` if using `OIDC_ALLOWED_GROUPS`). Note: Entra ID v2.0 ID tokens may omit `email_verified`; if your tenant does not emit `email_verified: true`, set `OIDC_ALLOW_UNVERIFIED_EMAIL=1` (users sign in via their Entra `sub` and issuer-bound tenant, while email invite claiming stays disabled).
