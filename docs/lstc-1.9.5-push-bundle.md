# Push Bundle For 1.9.5 LSTC

Use this only when the local machine that produced the release branch does not
have GitHub push credentials.

Bundle file:

```text
deliverables/otto-v1.9.5-lstc-v194-2fca2a2.bundle
sha256 47e5e8c1903c1e76adc690e49bbec65a836b191d03beb0fe20fb9fb2dc11eeec
```

The bundle contains `HEAD` at:

```text
2fca2a2684fc6e7ebaa1de30c17a1925ac998732
```

It requires the repository to already contain `v1.9.4`:

```text
2a6e66b09dfd60539e9f8b27cfcc40e2b8ceccfd
```

On a machine with GitHub push credentials:

```bash
git clone git@github.com:Felix201209/otto.git otto-1.9.5-push
cd otto-1.9.5-push
git fetch --tags origin
git bundle verify /path/to/otto-v1.9.5-lstc-v194-2fca2a2.bundle
git fetch /path/to/otto-v1.9.5-lstc-v194-2fca2a2.bundle HEAD:release/1.9.5-lstc-v194
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

