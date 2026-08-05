# Desktop release and real-device acceptance

This checklist covers issues #247, #250, #251, #252, #256, #257 and the desktop packaging part of #269.

## Local checks

Run from the repository root after npm ci:

    npm run release:gate --workspace=packages/desktop
    npm run runtime:verify:win --workspace=packages/desktop
    npm run runtime:verify:mac --workspace=packages/desktop
    npm run acceptance:weak-resource --workspace=packages/desktop
    npm run test --workspace=packages/desktop -- packages/desktop/scripts/verify-release-signing.test.mjs

Runtime checks require Python, Node, docx, jinja2, markdown and LibreOffice under the declared vendor/runtime/<platform>-<arch> root before a full document-capable installer is accepted.

## Signing and notarization

release:signing:check is fail-closed. Official release mode requires Windows Authenticode inputs and macOS Developer ID/notarization inputs. Missing credentials stop the workflow before publication. Local simulation only checks the policy and explicitly reports that no signature was created or validated.

Never place certificates, private keys, passwords or notarization receipts in the repository. Real evidence still requires platform runners and credentials: Windows Authenticode verification; macOS codesign, Gatekeeper and stapler validation.

## Update, rollback and weak-device evidence

The update manifest gate checks names, sizes, SHA-256 and mirror URLs. The updater re-verifies the downloaded file immediately before installation and records rollback receipts. Real-device evidence must include source commit, package hashes, OS/build, device class, memory peak, crash count, offline resume, update and rollback results.

The low4gb benchmark is synthetic and local-only; it is not proof of Windows 10/11 or macOS Intel/ARM acceptance. Physical devices are still required for sleep/wake, offline, long-task, notification, document-generation and upgrade/rollback runs.
