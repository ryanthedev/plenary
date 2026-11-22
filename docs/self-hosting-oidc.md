# Self-Hosting Plenary with OIDC

Plenary supports any standards-compliant OpenID Connect (OIDC) provider via discovery (`/.well-known/openid-configuration`), Authorization Code Flow with **PKCE (`S256`)**, and JWKS (`RS256` / `ES256`) ID-token verification.

## Quick Start

Drop in three OIDC variables alongside your server URL and signing key:

```env
PUBLIC_URL=https://plenary.example.com
OIDC_REDIRECT_URI=https://plenary.example.com/auth/callback
COOKIE_KEY=<at-least-32-random-bytes>

OIDC_ISSUER_URL=https://auth.example.com
OIDC_CLIENT_ID=plenary
OIDC_CLIENT_SECRET=<your-client-secret>
```

Register `https://plenary.example.com/auth/callback` as an allowed Redirect URI in your identity provider.

> **Google Workspace SSO** (`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`) continues to work unchanged when `OIDC_ISSUER_URL` is not set.

## Environment Variables

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `OIDC_ISSUER_URL` | Yes | — | Issuer base URL (must use `https://` in production; `/.well-known/openid-configuration` is appended automatically). |
| `OIDC_CLIENT_ID` | Yes | — | OAuth 2.0 / OIDC client ID. |
| `OIDC_CLIENT_SECRET` | Yes | — | OAuth 2.0 / OIDC client secret. |
| `OIDC_REDIRECT_URI` | Prod | `http://localhost:8080/auth/callback` | Callback URL registered at your IdP (must match `PUBLIC_URL`'s origin). |
| `OIDC_SCOPES` | No | `openid email profile` | Space-separated OIDC scopes (`openid` is always included). |
| `OIDC_DISPLAY_NAME` | No | `SSO` | Display name for the provider and auto-provisioned tenant (e.g. `Okta`, `Pocket ID`). |
| `OIDC_TENANT_SLUG` | No | normalized issuer host + path hash | Short slug for issuer-bound tenancy (`oidc:<slug>`) and user IDs (`oidc:<slug>:<sub>`). |
| `OIDC_TENANT_DOMAIN` | No | `oidc:<slug>` | Explicit tenant domain binding configured by the operator (e.g. `acme.com`). |
| `OIDC_EMAIL_DOMAINS` | No | `OIDC_TENANT_DOMAIN` if DNS, else none | Comma-separated authoritative email domains allowed to claim email board invites (e.g. `acme.com,corp.example`). Emails outside this list are stripped (`email: null`). |
| `OIDC_ALLOWED_GROUPS` | No | — | Comma-separated group names required in the ID token's groups claim to sign in (optional membership gate). |
| `OIDC_GROUPS_CLAIM` | No | `groups` | ID token claim name inspected when `OIDC_ALLOWED_GROUPS` is set. |
| `OIDC_ADMIN_USERS` | No | — | Comma-separated OIDC `sub` values (or full `oidc:<slug>:<sub>` IDs) granted Unit admin on startup. |
| `OIDC_ALLOW_UNVERIFIED_EMAIL` | No | `0` | Set to `1` only for lab/dev IdPs (or Entra ID setups) that omit `email_verified: true`. Unverified emails are still stripped (`email: null`) and cannot claim invites. |
| `OIDC_ALLOW_HTTP_LOCALHOST` | No | `1` in local dev, `0` in prod | Set to `1` to allow `http://localhost` / `http://127.0.0.1` issuer URLs during local testing. |

## Security Model

- **Issuer-bound tenancy:** Unlike Google Workspace's verified `hd` claim, generic OIDC providers do not carry a Workspace domain claim and email domains can be spoofed. Plenary binds tenant membership strictly to the configured issuer (`oidc:<slug>` or operator-configured `OIDC_TENANT_DOMAIN`), including a digest of any issuer path so distinct realms/tenants on the same host never collide.
- **Membership boundary warning:** Without `OIDC_ALLOWED_GROUPS` (or IdP-side client assignment), every user who can authenticate to your OIDC client joins the tenant as a member. **Never** point `OIDC_ISSUER_URL` at an open public IdP (such as `https://accounts.google.com` — use `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` for Google Workspace instead).
- **Invite hijack protection:** Verified emails are only carried on `Identity.email` when their domain is explicitly authorized via `OIDC_EMAIL_DOMAINS` (or a DNS `OIDC_TENANT_DOMAIN`). All other addresses are stripped to `null`.
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

### Microsoft Entra ID (Azure AD)

```env
OIDC_ISSUER_URL=https://login.microsoftonline.com/<tenant-id>/v2.0
OIDC_CLIENT_ID=<application-client-id>
OIDC_CLIENT_SECRET=<client-secret-value>
OIDC_DISPLAY_NAME=Entra ID
OIDC_TENANT_SLUG=contoso
OIDC_REDIRECT_URI=https://plenary.example.com/auth/callback
```

In Entra ID: **App registrations → New registration**, add Web Redirect URI `https://plenary.example.com/auth/callback`, create a Client Secret, and under **Token configuration** include the `email` optional claim. Note: Entra ID v2.0 ID tokens may omit `email_verified`; if your tenant does not emit `email_verified: true`, set `OIDC_ALLOW_UNVERIFIED_EMAIL=1` (users will sign in via their Entra `sub` and issuer-bound tenant, while email invite claiming stays disabled).
