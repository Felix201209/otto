use std::collections::HashMap;
use std::panic::{catch_unwind, AssertUnwindSafe};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use openmls::prelude::{
    tls_codec::{Deserialize, Serialize},
    BasicCredential, Ciphersuite, Credential, CredentialType, CredentialWithKey, KeyPackage,
    KeyPackageIn, MlsGroup, MlsGroupCreateConfig, MlsGroupJoinConfig, MlsMessageBodyIn,
    MlsMessageIn, ProcessedMessageContent, ProtocolVersion, StagedWelcome,
};
use openmls_basic_credential::SignatureKeyPair;
use openmls_rust_crypto::OpenMlsRustCrypto;
use openmls_traits::OpenMlsProvider;
use serde::Serialize as SerdeSerialize;

const CIPHERSUITE: Ciphersuite = Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;
const PROTOCOL: &str = "mls10-openmls-0.8";
const MAX_KEY_PACKAGE_BASE64: usize = 128 * 1024;
const MAX_WELCOME_BASE64: usize = 2 * 1024 * 1024;
const MAX_APPLICATION_BYTES: usize = 1024 * 1024;
const MAX_CIPHERTEXT_BASE64: usize = 2 * 1024 * 1024;

#[derive(Debug, SerdeSerialize)]
pub struct ExportedKeyPackage {
    pub protocol: &'static str,
    pub ciphersuite: &'static str,
    pub reference: String,
    pub key_package: String,
}

#[derive(Debug, SerdeSerialize)]
pub struct ExportedGroupState {
    pub protocol: &'static str,
    pub conversation_id: String,
    pub group_id: String,
    pub epoch: u64,
    pub member_count: usize,
}

#[derive(Debug, SerdeSerialize)]
pub struct ExportedMemberAdd {
    pub protocol: &'static str,
    pub conversation_id: String,
    pub group_id: String,
    pub epoch: u64,
    pub commit: String,
    pub welcome: String,
}

#[derive(Debug, SerdeSerialize)]
pub struct ExportedApplicationMessage {
    pub protocol: &'static str,
    pub conversation_id: String,
    pub group_id: String,
    pub epoch: u64,
    pub ciphertext: String,
}

#[derive(Debug)]
pub struct DecryptedApplicationMessage {
    pub protocol: &'static str,
    pub conversation_id: String,
    pub group_id: String,
    pub epoch: u64,
    pub sender_device_scope: String,
    pub plaintext: Vec<u8>,
}

struct DeviceIdentity {
    scope: String,
    credential_with_key: CredentialWithKey,
    signer: SignatureKeyPair,
}

/// Process-local OpenMLS kernel. Public RPC results never contain signature
/// private keys, HPKE init private keys, or provider storage contents.
///
/// Persistent encrypted group state is deliberately not enabled by this
/// foundation. Callers must treat process exit as MLS state loss until the OS
/// protected storage adapter lands; there is no plaintext fallback.
#[derive(Default)]
pub struct MlsKernel {
    provider: OpenMlsRustCrypto,
    identity: Option<DeviceIdentity>,
    available_key_packages: HashMap<String, KeyPackage>,
    groups: HashMap<String, MlsGroup>,
}

impl MlsKernel {
    pub fn initialize(&mut self, raw_scope: &str) -> Result<(), String> {
        let scope = validate_scope(raw_scope)?;
        if let Some(identity) = &self.identity {
            return if identity.scope == scope {
                Ok(())
            } else {
                Err("MLS kernel is initialized for another device scope; reset required".into())
            };
        }

        let credential = BasicCredential::new(scope.as_bytes().to_vec());
        let signer = SignatureKeyPair::new(CIPHERSUITE.signature_algorithm())
            .map_err(|error| format!("MLS signature key generation failed: {error}"))?;
        signer
            .store(self.provider.storage())
            .map_err(|error| format!("MLS signature key storage failed: {error}"))?;
        let credential_with_key = CredentialWithKey {
            credential: credential.into(),
            signature_key: signer.public().into(),
        };
        self.identity = Some(DeviceIdentity {
            scope,
            credential_with_key,
            signer,
        });
        Ok(())
    }

    pub fn create_key_package(&mut self, raw_scope: &str) -> Result<ExportedKeyPackage, String> {
        let scope = validate_scope(raw_scope)?;
        let identity = self
            .identity
            .as_ref()
            .ok_or_else(|| "MLS kernel is not initialized".to_string())?;
        if identity.scope != scope {
            return Err("MLS device scope does not match initialized identity".into());
        }

        let bundle = KeyPackage::builder()
            .build(
                CIPHERSUITE,
                &self.provider,
                &identity.signer,
                identity.credential_with_key.clone(),
            )
            .map_err(|error| format!("MLS key package generation failed: {error}"))?;
        let key_package = bundle.key_package().clone();
        let reference = hex::encode(
            key_package
                .hash_ref(self.provider.crypto())
                .map_err(|error| format!("MLS key package reference failed: {error}"))?
                .as_slice(),
        );
        let serialized = key_package
            .tls_serialize_detached()
            .map_err(|error| format!("MLS key package serialization failed: {error}"))?;
        if self
            .available_key_packages
            .insert(reference.clone(), key_package)
            .is_some()
        {
            return Err("MLS key package reference collision".into());
        }
        Ok(ExportedKeyPackage {
            protocol: PROTOCOL,
            ciphersuite: "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
            reference,
            key_package: BASE64.encode(serialized),
        })
    }

    pub fn consume_key_package(&mut self, reference: &str) -> Result<(), String> {
        if self.identity.is_none() {
            return Err("MLS kernel is not initialized".into());
        }
        if !is_sha256(reference) {
            return Err("MLS key package reference is invalid".into());
        }
        self.available_key_packages
            .remove(reference)
            .ok_or_else(|| "MLS key package is missing or already consumed".to_string())?;
        Ok(())
    }

    pub fn create_group(
        &mut self,
        raw_scope: &str,
        raw_conversation_id: &str,
    ) -> Result<ExportedGroupState, String> {
        let scope = validate_scope(raw_scope)?;
        let conversation_id = validate_conversation_id(raw_conversation_id)?;
        self.require_identity(&scope)?;
        if self.groups.contains_key(&conversation_id) {
            return Err("MLS conversation group already exists".into());
        }
        let identity = self.identity.as_ref().expect("identity checked above");
        let config = MlsGroupCreateConfig::builder()
            .ciphersuite(CIPHERSUITE)
            .use_ratchet_tree_extension(true)
            .build();
        let group = MlsGroup::new(
            &self.provider,
            &identity.signer,
            &config,
            identity.credential_with_key.clone(),
        )
        .map_err(|error| format!("MLS group creation failed: {error}"))?;
        let state = export_group_state(&conversation_id, &group);
        self.groups.insert(conversation_id, group);
        Ok(state)
    }

    pub fn add_member(
        &mut self,
        raw_scope: &str,
        raw_conversation_id: &str,
        encoded_key_package: &str,
    ) -> Result<ExportedMemberAdd, String> {
        let scope = validate_scope(raw_scope)?;
        let conversation_id = validate_conversation_id(raw_conversation_id)?;
        self.require_identity(&scope)?;
        let serialized = decode_base64(
            "MLS key package",
            encoded_key_package,
            MAX_KEY_PACKAGE_BASE64,
        )?;
        let key_package = KeyPackageIn::tls_deserialize_exact(serialized)
            .map_err(|error| format!("MLS key package decoding failed: {error}"))?
            .validate(self.provider.crypto(), ProtocolVersion::Mls10)
            .map_err(|error| format!("MLS key package verification failed: {error}"))?;
        if key_package.ciphersuite() != CIPHERSUITE {
            return Err("MLS key package ciphersuite is incompatible".into());
        }
        validate_member_credential(key_package.leaf_node().credential(), &scope)?;

        let identity = self.identity.as_ref().expect("identity checked above");
        let group = self
            .groups
            .get_mut(&conversation_id)
            .ok_or_else(|| "MLS conversation group is missing".to_string())?;
        if group.pending_commit().is_some() {
            return Err("MLS member change is already pending".into());
        }
        let group_id = BASE64.encode(group.group_id().as_slice());
        let epoch = group.epoch().as_u64();
        let (commit, welcome, _) = group
            .add_members(&self.provider, &identity.signer, &[key_package])
            .map_err(|error| format!("MLS member add failed: {error}"))?;
        Ok(ExportedMemberAdd {
            protocol: PROTOCOL,
            conversation_id,
            group_id,
            epoch,
            commit: BASE64.encode(
                commit
                    .to_bytes()
                    .map_err(|error| format!("MLS commit serialization failed: {error}"))?,
            ),
            welcome: BASE64.encode(
                welcome
                    .to_bytes()
                    .map_err(|error| format!("MLS Welcome serialization failed: {error}"))?,
            ),
        })
    }

    pub fn merge_pending_commit(
        &mut self,
        raw_scope: &str,
        raw_conversation_id: &str,
    ) -> Result<ExportedGroupState, String> {
        let scope = validate_scope(raw_scope)?;
        let conversation_id = validate_conversation_id(raw_conversation_id)?;
        self.require_identity(&scope)?;
        let group = self
            .groups
            .get_mut(&conversation_id)
            .ok_or_else(|| "MLS conversation group is missing".to_string())?;
        if group.pending_commit().is_none() {
            return Err("MLS pending commit is missing".into());
        }
        group
            .merge_pending_commit(&self.provider)
            .map_err(|error| format!("MLS pending commit merge failed: {error}"))?;
        Ok(export_group_state(&conversation_id, group))
    }

    pub fn join_group(
        &mut self,
        raw_scope: &str,
        raw_conversation_id: &str,
        key_package_reference: &str,
        expected_group_id: &str,
        encoded_welcome: &str,
    ) -> Result<ExportedGroupState, String> {
        let scope = validate_scope(raw_scope)?;
        let conversation_id = validate_conversation_id(raw_conversation_id)?;
        self.require_identity(&scope)?;
        if self.groups.contains_key(&conversation_id) {
            return Err("MLS conversation group already exists".into());
        }
        if !is_sha256(key_package_reference)
            || !self
                .available_key_packages
                .contains_key(key_package_reference)
        {
            return Err("MLS key package is missing or already consumed".into());
        }
        let expected_group_id = decode_base64("MLS group id", expected_group_id, 128)?;
        let serialized = decode_base64("MLS Welcome", encoded_welcome, MAX_WELCOME_BASE64)?;
        let welcome = match MlsMessageIn::tls_deserialize_exact(serialized)
            .map_err(|error| format!("MLS Welcome decoding failed: {error}"))?
            .extract()
        {
            MlsMessageBodyIn::Welcome(welcome) => welcome,
            _ => return Err("MLS message is not a Welcome".into()),
        };
        let config = MlsGroupJoinConfig::builder()
            .use_ratchet_tree_extension(true)
            .build();
        let staged = StagedWelcome::new_from_welcome(&self.provider, &config, welcome, None)
            .map_err(|error| format!("MLS Welcome staging failed: {error}"))?;
        // OpenMLS consumes the matching HPKE init private key while staging a
        // Welcome. From this point the public KeyPackage must also be retired,
        // even if an application-level group binding check fails afterwards.
        self.available_key_packages.remove(key_package_reference);
        if staged.group_context().protocol_version() != ProtocolVersion::Mls10
            || staged.group_context().ciphersuite() != CIPHERSUITE
        {
            return Err("MLS Welcome protocol or ciphersuite is incompatible".into());
        }
        if staged.group_context().group_id().as_slice() != expected_group_id.as_slice() {
            return Err("MLS Welcome group id does not match conversation".into());
        }
        for member in staged.members() {
            validate_member_credential(&member.credential, &scope)?;
        }
        let group = staged
            .into_group(&self.provider)
            .map_err(|error| format!("MLS Welcome join failed: {error}"))?;
        let state = export_group_state(&conversation_id, &group);
        self.groups.insert(conversation_id, group);
        Ok(state)
    }

    pub fn encrypt_application(
        &mut self,
        raw_scope: &str,
        raw_conversation_id: &str,
        plaintext: &[u8],
    ) -> Result<ExportedApplicationMessage, String> {
        let scope = validate_scope(raw_scope)?;
        let conversation_id = validate_conversation_id(raw_conversation_id)?;
        self.require_identity(&scope)?;
        if plaintext.is_empty() || plaintext.len() > MAX_APPLICATION_BYTES {
            return Err("MLS application plaintext size is invalid".into());
        }
        let identity = self.identity.as_ref().expect("identity checked above");
        let group = self
            .groups
            .get_mut(&conversation_id)
            .ok_or_else(|| "MLS conversation group is missing".to_string())?;
        if group.pending_commit().is_some() {
            return Err("MLS group has an unmerged pending commit".into());
        }
        group.set_aad(conversation_aad(&conversation_id));
        let epoch = group.epoch().as_u64();
        let group_id = BASE64.encode(group.group_id().as_slice());
        let message = group
            .create_message(&self.provider, &identity.signer, plaintext)
            .map_err(|error| format!("MLS application encrypt failed: {error}"))?;
        Ok(ExportedApplicationMessage {
            protocol: PROTOCOL,
            conversation_id,
            group_id,
            epoch,
            ciphertext: BASE64.encode(
                message
                    .to_bytes()
                    .map_err(|error| format!("MLS ciphertext serialization failed: {error}"))?,
            ),
        })
    }

    pub fn decrypt_application(
        &mut self,
        raw_scope: &str,
        raw_conversation_id: &str,
        encoded_ciphertext: &str,
    ) -> Result<DecryptedApplicationMessage, String> {
        let scope = validate_scope(raw_scope)?;
        let conversation_id = validate_conversation_id(raw_conversation_id)?;
        self.require_identity(&scope)?;
        let serialized = decode_base64(
            "MLS application ciphertext",
            encoded_ciphertext,
            MAX_CIPHERTEXT_BASE64,
        )?;
        let message = MlsMessageIn::tls_deserialize_exact(serialized)
            .map_err(|error| format!("MLS application ciphertext decoding failed: {error}"))?
            .try_into_protocol_message()
            .map_err(|error| format!("MLS application message type failed: {error}"))?;
        let processed = {
            let group = self
                .groups
                .get_mut(&conversation_id)
                .ok_or_else(|| "MLS conversation group is missing".to_string())?;
            if group.pending_commit().is_some() {
                return Err("MLS group has an unmerged pending commit".into());
            }
            catch_unwind(AssertUnwindSafe(|| {
                group.process_message(&self.provider, message)
            }))
        };
        let processed = match processed {
            Ok(Ok(processed)) => processed,
            Ok(Err(error)) => return Err(format!("MLS application decrypt failed: {error}")),
            Err(_) => {
                // OpenMLS 0.8.1 contains debug assertions on some malformed
                // ciphertext paths. A panic may leave the receive ratchet in
                // an unknown state, so quarantine only this conversation and
                // keep the native process alive instead of attempting reuse.
                self.groups.remove(&conversation_id);
                return Err(
                    "MLS application decrypt failed; conversation state quarantined".into(),
                );
            }
        };
        if processed.aad() != conversation_aad(&conversation_id) {
            return Err("MLS application conversation binding is invalid".into());
        }
        let sender_device_scope = validate_member_credential(processed.credential(), &scope)?;
        let group_id = BASE64.encode(processed.group_id().as_slice());
        let epoch = processed.epoch().as_u64();
        match processed.into_content() {
            ProcessedMessageContent::ApplicationMessage(application) => {
                Ok(DecryptedApplicationMessage {
                    protocol: PROTOCOL,
                    conversation_id,
                    group_id,
                    epoch,
                    sender_device_scope,
                    plaintext: application.into_bytes(),
                })
            }
            _ => Err("MLS message is not application data".into()),
        }
    }

    pub fn reset(&mut self, raw_scope: &str) -> Result<(), String> {
        let scope = validate_scope(raw_scope)?;
        let identity = self
            .identity
            .as_ref()
            .ok_or_else(|| "MLS kernel is not initialized".to_string())?;
        if identity.scope != scope {
            return Err("MLS device scope does not match initialized identity".into());
        }
        // Replacing the provider drops every private key and pending package in
        // one operation. No secret material is serialized during reset.
        *self = Self::default();
        Ok(())
    }

    fn require_identity(&self, scope: &str) -> Result<(), String> {
        let identity = self
            .identity
            .as_ref()
            .ok_or_else(|| "MLS kernel is not initialized".to_string())?;
        if identity.scope != scope {
            return Err("MLS device scope does not match initialized identity".into());
        }
        Ok(())
    }
}

fn export_group_state(conversation_id: &str, group: &MlsGroup) -> ExportedGroupState {
    ExportedGroupState {
        protocol: PROTOCOL,
        conversation_id: conversation_id.to_string(),
        group_id: BASE64.encode(group.group_id().as_slice()),
        epoch: group.epoch().as_u64(),
        member_count: group.members().count(),
    }
}

fn validate_conversation_id(raw: &str) -> Result<String, String> {
    let conversation_id = raw.trim();
    if conversation_id.is_empty()
        || conversation_id.len() > 200
        || !conversation_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
    {
        return Err("MLS conversation id is invalid".into());
    }
    Ok(conversation_id.to_string())
}

fn decode_base64(label: &str, encoded: &str, max_encoded_len: usize) -> Result<Vec<u8>, String> {
    if encoded.is_empty() || encoded.len() > max_encoded_len {
        return Err(format!("{label} size is invalid"));
    }
    BASE64
        .decode(encoded)
        .map_err(|_| format!("{label} is not valid base64"))
}

fn conversation_aad(conversation_id: &str) -> Vec<u8> {
    format!("otto-mls-v1/{conversation_id}").into_bytes()
}

fn validate_member_credential(
    credential: &Credential,
    local_scope: &str,
) -> Result<String, String> {
    if credential.credential_type() != CredentialType::Basic {
        return Err("MLS member credential type is unsupported".into());
    }
    let member_scope = std::str::from_utf8(credential.serialized_content())
        .map_err(|_| "MLS member credential is not valid UTF-8")?;
    let member_scope = validate_scope(member_scope)?;
    let mut local_parts = local_scope.split('/');
    let mut member_parts = member_scope.split('/');
    if local_parts.next() != member_parts.next() || local_parts.next() != member_parts.next() {
        return Err("MLS member credential is outside the local trust domain".into());
    }
    Ok(member_scope)
}

fn validate_scope(raw: &str) -> Result<String, String> {
    let scope = raw.trim();
    if scope.len() < 7
        || scope.len() > 512
        || scope.contains(char::is_whitespace)
        || scope.split('/').count() != 4
        || scope.split('/').any(|part| part.is_empty())
    {
        return Err("MLS device scope is invalid".into());
    }
    Ok(scope.to_string())
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[cfg(test)]
mod tests {
    use super::*;
    use openmls::prelude::{tls_codec::Deserialize, KeyPackageIn, ProtocolVersion};

    #[test]
    fn another_device_scope_requires_an_explicit_reset() {
        let mut kernel = MlsKernel::default();
        kernel.initialize("server-a/org-a/alice/device-a").unwrap();
        assert!(kernel
            .initialize("server-a/org-a/alice/device-b")
            .unwrap_err()
            .contains("reset required"));
    }

    #[test]
    fn reset_does_not_accept_an_unrelated_scope() {
        let mut kernel = MlsKernel::default();
        kernel.initialize("server-a/org-a/alice/device-a").unwrap();
        assert!(kernel.reset("server-b/org-a/alice/device-a").is_err());
        assert!(kernel
            .create_key_package("server-a/org-a/alice/device-a")
            .is_ok());
    }

    #[test]
    fn exported_key_package_is_valid_mls_1_0() {
        let mut kernel = MlsKernel::default();
        let scope = "server-a/org-a/alice/device-a";
        kernel.initialize(scope).unwrap();
        let exported = kernel.create_key_package(scope).unwrap();
        let serialized = BASE64.decode(exported.key_package).unwrap();
        let parsed = KeyPackageIn::tls_deserialize_exact(serialized).unwrap();
        let verified = parsed
            .validate(kernel.provider.crypto(), ProtocolVersion::Mls10)
            .expect("exported package must pass OpenMLS signature validation");
        let reference = hex::encode(
            verified
                .hash_ref(kernel.provider.crypto())
                .unwrap()
                .as_slice(),
        );
        assert_eq!(reference, exported.reference);
    }

    #[test]
    fn two_devices_join_and_exchange_an_authenticated_application_message() {
        let alice_scope = "server-a/org-a/alice/alice-device";
        let bob_scope = "server-a/org-a/bob/bob-device";
        let conversation = "conversation-a";
        let mut alice = MlsKernel::default();
        let mut bob = MlsKernel::default();
        alice.initialize(alice_scope).unwrap();
        bob.initialize(bob_scope).unwrap();

        let bob_key_package = bob.create_key_package(bob_scope).unwrap();
        let created = alice.create_group(alice_scope, conversation).unwrap();
        assert_eq!(created.epoch, 0);

        let invitation = alice
            .add_member(alice_scope, conversation, &bob_key_package.key_package)
            .unwrap();
        assert_eq!(invitation.epoch, 0);
        assert!(!invitation.commit.is_empty());
        assert!(alice
            .encrypt_application(alice_scope, conversation, b"must wait for commit")
            .unwrap_err()
            .contains("pending commit"));
        let committed = alice
            .merge_pending_commit(alice_scope, conversation)
            .unwrap();
        assert_eq!(committed.epoch, 1);

        let joined = bob
            .join_group(
                bob_scope,
                conversation,
                &bob_key_package.reference,
                &committed.group_id,
                &invitation.welcome,
            )
            .unwrap();
        assert_eq!(joined.group_id, committed.group_id);
        assert_eq!(joined.epoch, committed.epoch);
        assert!(bob
            .consume_key_package(&bob_key_package.reference)
            .unwrap_err()
            .contains("already consumed"));

        let encrypted = alice
            .encrypt_application(alice_scope, conversation, b"hello from alice")
            .unwrap();
        let plaintext = bob
            .decrypt_application(bob_scope, conversation, &encrypted.ciphertext)
            .unwrap();
        assert_eq!(plaintext.plaintext, b"hello from alice");
        assert_eq!(plaintext.sender_device_scope, alice_scope);
        assert_eq!(plaintext.group_id, committed.group_id);

        assert!(bob
            .decrypt_application(bob_scope, conversation, &encrypted.ciphertext)
            .unwrap_err()
            .contains("decrypt"));

        let mut tampered = BASE64
            .decode(
                alice
                    .encrypt_application(alice_scope, conversation, b"tamper me")
                    .unwrap()
                    .ciphertext,
            )
            .unwrap();
        let last = tampered.last_mut().unwrap();
        *last ^= 1;
        assert!(bob
            .decrypt_application(bob_scope, conversation, &BASE64.encode(tampered))
            .is_err());
        assert!(bob
            .decrypt_application(bob_scope, conversation, &encrypted.ciphertext)
            .unwrap_err()
            .contains("group is missing"));
    }

    #[test]
    fn mismatched_welcome_group_binding_retires_the_one_time_key_package() {
        let alice_scope = "server-a/org-a/alice/alice-device";
        let bob_scope = "server-a/org-a/bob/bob-device";
        let conversation = "conversation-a";
        let mut alice = MlsKernel::default();
        let mut bob = MlsKernel::default();
        alice.initialize(alice_scope).unwrap();
        bob.initialize(bob_scope).unwrap();
        let bob_key_package = bob.create_key_package(bob_scope).unwrap();
        alice.create_group(alice_scope, conversation).unwrap();
        let invitation = alice
            .add_member(alice_scope, conversation, &bob_key_package.key_package)
            .unwrap();
        let committed = alice
            .merge_pending_commit(alice_scope, conversation)
            .unwrap();

        let wrong_group_id = BASE64.encode([0u8; 16]);
        assert!(bob
            .join_group(
                bob_scope,
                conversation,
                &bob_key_package.reference,
                &wrong_group_id,
                &invitation.welcome,
            )
            .unwrap_err()
            .contains("does not match"));
        assert!(bob
            .join_group(
                bob_scope,
                conversation,
                &bob_key_package.reference,
                &committed.group_id,
                &invitation.welcome,
            )
            .unwrap_err()
            .contains("already consumed"));
    }

    #[test]
    fn member_key_packages_cannot_cross_server_or_organization_boundaries() {
        let alice_scope = "server-a/org-a/alice/alice-device";
        let outside_scope = "server-a/org-b/mallory/mallory-device";
        let mut alice = MlsKernel::default();
        let mut outside = MlsKernel::default();
        alice.initialize(alice_scope).unwrap();
        outside.initialize(outside_scope).unwrap();
        let outside_key_package = outside.create_key_package(outside_scope).unwrap();
        alice.create_group(alice_scope, "conversation-a").unwrap();
        assert!(alice
            .add_member(
                alice_scope,
                "conversation-a",
                &outside_key_package.key_package,
            )
            .unwrap_err()
            .contains("outside the local trust domain"));
    }
}
