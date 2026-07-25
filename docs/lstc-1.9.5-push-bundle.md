# Push Bundle For 1.9.5 LSTC

Use this only when the local machine that produced the release branch does not
have GitHub push credentials.

The release owner should use the newest `deliverables/*.bundle` file handed off
with the release notes, plus its reported SHA256. Do not commit the exact bundle
commit or bundle hash into this file; doing so makes the instructions
self-referential and stale as soon as this document changes.

It requires the repository to already contain `v1.9.4`:

```text
2a6e66b09dfd60539e9f8b27cfcc40e2b8ceccfd
```

On a machine with GitHub push credentials:

```bash
git clone git@github.com:Felix201209/otto.git otto-1.9.5-push
cd otto-1.9.5-push
git fetch --tags origin
git bundle verify /path/to/otto-v1.9.5-lstc-v194-<commit>.bundle
git fetch /path/to/otto-v1.9.5-lstc-v194-<commit>.bundle HEAD:release/1.9.5-lstc-v194
git checkout release/1.9.5-lstc-v194
git log --oneline v1.9.4..HEAD
git push origin release/1.9.5-lstc-v194
```

After pushing, run `.github/workflows/release.yml` with:

```text
version=1.9.5
draft=true
prerelease=false
```

Before pushing, compare `git log --oneline v1.9.4..HEAD` with the release
handoff notes. If the document was edited after the bundle was generated,
regenerate the bundle only when those documentation edits must also be pushed to
GitHub.
