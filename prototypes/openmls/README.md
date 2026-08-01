# Otto OpenMLS prototype

This isolated crate validates the RFC 9420 building blocks selected for Otto:
device credentials, one group per private conversation, multi-device member
addition, application-message encryption, epoch updates, and member removal.

It is deliberately outside the desktop packaging path. Passing these tests
does not enable E2EE and does not satisfy the external-audit release gate.

Run:

```shell
cargo test --manifest-path prototypes/openmls/Cargo.toml --locked
```
