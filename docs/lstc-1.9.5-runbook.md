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

Current local HEAD:

```text
0498447c2a379e335b899b476396df4c6ec8b50e
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

## Verified Local Artifacts

Windows desktop installer:

```text
packages/desktop/release/Otto-Setup-1.9.5-win-x64.exe
sha256 e145248c02b698d3573a0d06c64e20bbe7b48c874465010afd89d4adbd0ccc1f
```

Windows update manifest:

```text
packages/desktop/release/latest.json
sha256 950fb9416e184b6b39b4dbfa748bc0c03f2f937d91b63cbeab2325242c73e975
```

Server deployment package:

```text
deliverables/otto-enterprise-oneclick-v1.9.5-ae492c9641a5.tar.gz
sha256 8e4416ac0a59e7251822b3baad867726d4f45835d0dc89bdd69afc405d3afa1c
sourceCommit 0498447c2a379e335b899b476396df4c6ec8b50e
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
