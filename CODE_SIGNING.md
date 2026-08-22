# Code signing (Azure Artifact Signing)

Halo ships unsigned, which is why Windows shows **SmartScreen** ("Windows
protected your PC") and Windows 11's **Smart App Control** can block the
installer outright. Signing the binaries with a Microsoft-managed certificate
removes the "unknown publisher" warning and is the long-term fix for the
download friction described on the landing page.

This repo's release workflow (`.github/workflows/release.yml`) has an optional
step that signs the Windows build with **Azure Artifact Signing** (the renamed
Azure Trusted Signing service). It runs automatically on every `git tag v*`
push, **but only when the `AZURE_*` secrets below are configured** — until
then, releases build and upload exactly as before.

## Why Azure Artifact Signing?

- No physical USB hardware token (HSM) required — signing happens in the cloud.
- No $300+/yr per-certificate fee from a third-party CA.
- The certificate is issued by a Microsoft-managed CA that Windows trusts.

The trade-off: it's a paid Azure service (billed per month) and the "Public
Trust" certificate profile requires an identity-validation step that can take a
few days.

## One-time setup (Azure portal)

1. **Create the signing account**
   - In the Azure portal, create a **Resource Group**, then an
     **Artifact Signing** (formerly "Trusted Signing") account in a supported
     region (e.g. East US).
2. **Create a certificate profile**
   - On the signing account, add a **Certificate Profile**.
   - Choose **Public Trust** for public distribution (this is what stops
     SmartScreen for your users). *Private Trust* only works inside your own
     tenant — useless for a public download.
   - Public Trust requires identity validation (typically 1–3 days).
3. **Note the three values you'll need**
   - Account name (e.g. `halo-signing`).
   - Profile name (e.g. `halo-public`).
   - Endpoint URL — region-based, e.g. `https://eus.codesigning.azure.net/`.
     It must match the region the account/profile were created in.
4. **Create a service principal**
   - In **Microsoft Entra ID → App registrations**, create a new app
     registration (this is your "service principal").
   - On the signing account or certificate profile, grant that app the
     **Artifact Signing Certificate Profile Signer** role.
5. **Allow GitHub to authenticate as that app**
   - Recommended: **OpenID Connect (OIDC)** with a federated credential —
     no expiring secret. Under the app registration → **Certificates &
     secrets → Federated credentials**, add one for your GitHub org/repo with
     the `Entity Type` "Branch" and the ref/commit you tag from.
   - Alternative: create a **client secret** (it expires; rotate it).

## Configure the GitHub repo

Go to **Settings → Secrets and variables → Actions** and add:

| Type      | Name                        | Value                              |
|-----------|-----------------------------|------------------------------------|
| Secret    | `AZURE_CLIENT_ID`           | App registration client ID         |
| Secret    | `AZURE_TENANT_ID`           | Entra ID tenant (directory) ID     |
| Secret    | `AZURE_SUBSCRIPTION_ID`     | Azure subscription ID              |
| Variable  | `AZURE_SIGNING_ENDPOINT`    | e.g. `https://eus.codesigning.azure.net/` |
| Variable  | `AZURE_SIGNING_ACCOUNT`     | Signing account name               |
| Variable  | `AZURE_SIGNING_PROFILE`     | Certificate profile name           |

If you chose the client-secret path instead of OIDC, also add
`AZURE_CLIENT_SECRET` as a secret and pass it to the `azure/login@v3` step as
`client-secret`.

## What gets signed

The workflow signs every `.exe` and `.dll` under `out/` after `npm run make`,
which covers:

- `Halo-Setup.exe` (the installer users download), and
- the packaged app binaries (`out/Halo-win32-x64/`).

## Caveats

- **Portable zip**: `Halo-Windows.zip` is produced *during* `make`, before the
  signing step runs, so the copy of the app inside the zip is unsigned. To
  sign that too, split the build: `electron-forge package` → sign
  `out/Halo-win32-x64` → `electron-forge make --skip-package`. Not wired up
  yet — do this only if portable-zip users report warnings.
- **Smart App Control**: code signing removes the "unknown publisher" block,
  but Smart App Control also uses download *reputation*. A brand-new,
  low-volume binary can still be flagged until enough users install it. Signing
  plus the "Installation Help" instructions on the landing page is the
  belt-and-suspenders approach.
- **macOS**: Artifact Signing is Windows-only. macOS warnings come from
  Gatekeeper and are resolved with Apple notarization (a separate flow, not
  covered here).
