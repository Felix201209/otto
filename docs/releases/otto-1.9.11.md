# Otto 1.9.11

This is a small transition update built from the latest release-eligible `internal` source.

## Included

- Refined the desktop UI, organization tree ordering, inbox, and unread-message reminders.
- Improved private-deployment server selection, tenant usage reporting, and enterprise onboarding.
- Improved Feishu message reliability, signed execution receipts, and federation staging support.
- Kept Windows in-app updates on the domestic HTTPS update mirror with size and SHA-256 verification.

## Release scope

- This release does not enable unfinished E2EE or SQLCipher work from open draft branches.
- The Windows installer is not Authenticode-signed and may show an unknown-publisher warning.
- The enterprise one-click package is an unsigned transition artifact with a published SHA-256 checksum.
- The macOS arm64 and x64 transition packages are unsigned and not notarized; Gatekeeper may require an explicit manual override on first launch.
