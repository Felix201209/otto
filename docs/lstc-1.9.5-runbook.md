# Otto 1.9.5 LSTC Release Runbook

Last updated: 2026-07-25.

This runbook records the current recovery state for the 1.9.5 LSTC release. It
does not mark the release complete. Use it to finish the remaining privileged
steps without losing production data or publishing assets to the wrong update
source.

## Source State

Local branch:

```bash
release/1.9.5-lstc-v194
```

Current local HEAD is intentionally not hard-coded here because this runbook is
itself part of the release branch. Before publishing or deploying, use:

```bash
git rev-parse HEAD
```

Important local commits after `v1.9.4`:

- `5bdbfa3d` starts 1.9.5 from the v1.9.4 feature baseline and restores desktop avatars from v1.9.2.
- `bef20aba` fixes packaged desktop enterprise login startup.
- `7aca1452` migrates legacy enterprise auth sessions so old raw session tokens keep working through the schema-7 session table.
- `64f6da2d` replaces the SheetJS CDN tarball with a registry `xlsx` dependency for reproducible LSTC installs.
- `e4e2f9e5` makes data-analysis binary preflight fail loudly instead of treating stderr as success.
- `aebed850` adds platform install hints for data-analysis binaries.
- `bee20332` requires `release/latest.json` in the desktop release gate when a Windows installer exists.
- `3f704d76` merges the remote `internal` packaged grep fallback into core.
- `0498447c` fixes the GitHub release workflow to publish LSTC assets to `Felix201209/otto-releases` with a 160 MB installer limit.
- `25c2e99` adds this runbook for the remaining privileged release and deployment steps.
- `7d7e690` records the target-server canary result and production handoff state.

## Verified Local Artifacts

Windows desktop installer:

```text
packages/desktop/release/Otto-Setup-1.9.5-win-x64.exe
sha256 e145248c02b698d3573a0d06c64e20bbe7b48c874465010afd89d4adbd0ccc1f
```

Windows update manifest:

```text
packages/desktop/release/latest.json
# Regenerate after the final source commit so sourceCommit is current:
# node packages/desktop/scripts/make-latest-json.mjs ... or the checked recovery generator.
```

Server deployment package:

```text
deliverables/otto-enterprise-oneclick-v1.9.5-ae492c9641a5.tar.gz
# Regenerate after the final source commit with: npm run bundle:enterprise
# Verify sha256 with: sha256sum deliverables/otto-enterprise-oneclick-v1.9.5-ae492c9641a5.tar.gz
buildCommit ae492c9641a52f21f11882260b5da526cbbe7935
```

The Windows installer is not code-signed because no signing certificate was
available in the build environment. Do not claim signed Windows distribution.

## GitHub Release Path

Full-platform desktop release requires the macOS GitHub Actions runner. The
local Windows machine cannot build the required macOS DMG artifacts.

Required before dispatching the workflow:

1. Push local branch `release/1.9.5-lstc-v194` to `Felix201209/otto`.
2. Ensure the repository has `OTTO_RELEASES_TOKEN` if `GITHUB_TOKEN` cannot write to `Felix201209/otto-releases`.
3. Run `.github/workflows/release.yml` with `version=1.9.5`, `draft=true`, `prerelease=false`.
4. Verify the draft release assets are in `Felix201209/otto-releases`, not only `Felix201209/otto`.
5. Verify `latest.json` contains `mac-arm64`, `mac-x64`, and `win-x64` entries whose sha256 and sizes match the uploaded assets.

Do not publish the release if `latest.json` is missing or if it points to any
withdrawn 1.9.3 or 1.9.4 asset.

## Production Server State

Server host checked: `59.110.154.44`.

Current observed service before deployment:

```text
otto-enterprise.service active
version 1.9.4
buildCommit b1b4567ba5e392884e31f4cf2851e87940cc6860
ExecStart /usr/local/bin/node /opt/otto-enterprise/releases/v1.9.4-b1b4567ba5e3-2a6e66b/run.mjs
data dir /var/lib/otto-enterprise
```

Uploaded but not deployed:

```text
/tmp/otto-enterprise-oneclick-v1.9.5-ae492c9641a5.tar.gz
/tmp/otto-v195-deploy-root.sh
# Verify the uploaded tarball against the current local sha256 before running sudo.
```

The SSH user `king` can log in but cannot write `/opt/otto-enterprise` and cannot
read `/var/lib/otto-enterprise/data.db` without sudo/root. The tested passwords
`King2026`, `King0603`, and `060603` did not pass sudo/root authentication, and
`sudo -n` reports that a password is required. Formal deployment therefore
requires valid sudo/root credentials.

A non-privileged canary on the target server passed with the uploaded 1.9.5 package:

```text
version 1.9.5
buildCommit ae492c9641a52f21f11882260b5da526cbbe7935
schemaVersion 7
db connected
port 127.0.0.1:17777
data temporary under /tmp
```

The production service was checked after the canary and remained active on 1.9.4:

```text
version 1.9.4
buildCommit b1b4567ba5e392884e31f4cf2851e87940cc6860
schemaVersion 7
db connected
```

After privileged access is available, run:

```bash
sudo bash /tmp/otto-v195-deploy-root.sh
```

The uploaded script backs up `data.db`, starts a canary against a copied database,
switches the systemd drop-in only after canary health passes, and rolls back the
drop-in plus `data.db` if post-start health does not report 1.9.5.

## Post-Deployment Verification

After deployment, verify all of the following:

```bash
systemctl is-active otto-enterprise
curl -fsS http://127.0.0.1:7778/enterprise/health
curl -k -fsS https://59.110.154.44:7777/enterprise/health
```

Expected health fields:

```text
version/appVersion: 1.9.5
buildCommit: ae492c9641a52f21f11882260b5da526cbbe7935
schemaVersion: 7
db: connected
```

Then verify enterprise login with a real enterprise account or an explicitly
authorized temporary smoke account. Do not mutate the production database without
explicit authorization and a rollback plan.
