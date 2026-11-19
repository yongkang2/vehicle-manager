# Microsoft work account sign-in (development)

This optional integration binds a verified Microsoft work identity to an existing local account on this computer. Team member IDs, permissions, history and device approval continue to use the existing workflow. Each new computer needs its own local account, binding and team device approval. This version does not automatically discover shared-folder paths or merge accounts by email.

## Application registration

The application publisher must supply an app registration in a directory they can manage. For employees of another organization, select **Accounts in any organizational directory** (multitenant). Employees do not need permission to create registrations in their employer's directory. Their organization can still require administrator consent or block this application.

Under **Authentication > Add a platform > Mobile and desktop applications**, register the exact callback used by this installation:

- `http://localhost:4410/api/microsoft/callback`
- `http://127.0.0.1:4410/api/microsoft/callback`

Use the origin displayed in the browser. Microsoft may require adding the HTTP IP-literal URI through the app manifest. Localhost redirect ports are treated specially by Microsoft; IP-literal ports must match the registration. If the launcher chooses another port, register the resulting IP-literal callback or open the application using localhost. Development through the Vite proxy is not supported by this flow; test the built application directly on its local service port.

Configure these environment variables before starting the application:

```powershell
$env:VEHICLE_MANAGER_MICROSOFT_CLIENT_ID = '<application-client-id>'
# Optional: restrict authentication to the company's directory ID.
$env:VEHICLE_MANAGER_MICROSOFT_TENANT_ID = '<company-tenant-id>'
```

Without a tenant restriction, organizational accounts from multiple directories are accepted for verification; access still requires binding to an existing local account and existing team/device approval. Personal Microsoft accounts are rejected. No client secret belongs in a portable/public client. Only `openid` and `profile` are requested; no mail, Teams messages, files or directory-wide access is requested. The application does not persist Microsoft access or refresh tokens.

## User workflow

1. Sign in or register with the existing local account.
2. Open **Personal workspace**, select **Bind Microsoft work account**, confirm the local password, and choose the company account on Microsoft's page.
3. Later, select **Sign in with Microsoft** on the login screen. An unbound identity receives guidance to bind through a local account first.

One Microsoft identity binds to one local account per installation, and one local account binds to one Microsoft identity. Binding replacement/unbinding is outside this first version. Binding requires a still-valid originating local session. The flow expires after five minutes; starting another flow in the same browser supersedes the previous browser cookie. Cancelled, expired and invalid responses cannot grant a session. Microsoft MFA and consent are controlled by Microsoft and the employer.

Offline work continues through the existing local password and approved device. The displayed verification time is the last online authentication, not proof of the account's current employment status. Local password login remains available online as well: this optional binding does not enforce company-only access or immediate company revocation. Existing local/SMB trust limitations remain. Microsoft bindings are local security settings; do not copy a data directory to another computer, and do not include them in shared business snapshots/backups.

## Validation boundary

Automated tests cover cryptographic token validation, binding uniqueness, originating-session checks, unconfigured behavior and callback rejection. Real company consent, MFA, browser SSO and a complete Microsoft callback need a real publisher registration and company account; simulated tests do not establish those capabilities. No publisher registration or client ID is supplied in the repository.

References: [Multitenant apps](https://learn.microsoft.com/en-us/entra/identity-platform/single-and-multi-tenant-apps), [desktop registration](https://learn.microsoft.com/en-us/entra/identity-platform/scenario-desktop-app-registration), [ID token claims](https://learn.microsoft.com/en-us/entra/identity-platform/id-token-claims-reference).
