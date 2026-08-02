use std::collections::HashMap;
use std::panic::{catch_unwind, AssertUnwindSafe};

use aes_gcm::aead::rand_core::RngCore;
use aes_gcm::aead::{Aead, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use openmls::prelude::{
    tls_codec::{Deserialize, Serialize},
    BasicCredential, Ciphersuite, Credential, CredentialType, CredentialWithKey, GroupId,
    KeyPackage, KeyPackageIn, MlsGroup, MlsGroupCreateConfig, MlsGroupJoinConfig, MlsMessageBodyIn,
    MlsMessageIn, ProcessedMessageContent, ProtocolVersion, StagedWelcome,
};
use openmls_basic_credential::SignatureKeyPair;
use openmls_rust_crypto::OpenMlsRustCrypto;
use openmls_traits::OpenMlsProvider;
use serde::{Deserialize as SerdeDeserialize, Serialize as SerdeSerialize};
use zeroize::Zeroizing;

const CIPHERSUITE: Ciphersuite = Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;
const PROTOCOL: &str = "mls10-openmls-0.8";
const MAX_KEY_PACKAGE_BASE64: usize = 128 * 1024;
const MAX_WELCOME_BASE64: usize = 2 * 1024 * 1024;
const MAX_APPLICATION_BYTES: usize = 1024 * 1024;
const MAX_CIPHERTEXT_BASE64: usize = 2 * 1024 * 1024;
const MAX_STATE_PLAINTEXT_BYTES: usize = 64 * 1024 * 1024;
const MAX_STATE_ENVELOPE_BYTES: usize = 96 * 1024 * 1024;
const STATE_CIPHER: &str = "aes-256-gcm";

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

#[derive(Clone, Debug, SerdeSerialize)]
pub struct ExportedMemberAdd {
    pub protocol: &'static str,
    pub conversation_id: String,
    pub group_id: String,
    pub epoch: u64,
    pub key_package_reference: String,
    pub recipient_device_id: String,
    pub commit: String,
    pub welcome: String,
}

#[derive(Debug, SerdeSerialize)]
pub struct ExportedGroupInspection {
    pub protocol: &'static str,
    pub conversation_id: String,
    pub group_id: String,
    pub epoch: u64,
    pub member_count: usize,
    pub pending_commit: bool,
    pub pending_invitation: Option<ExportedMemberAdd>,
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

#[derive(SerdeSerialize, SerdeDeserialize)]
#[serde(deny_unknown_fields)]
struct EncryptedStateEnvelope {
    format: u8,
    cipher: String,
    nonce: String,
    ciphertext: String,
}

#[derive(SerdeSerialize, SerdeDeserialize)]
#[serde(deny_unknown_fields)]
struct PersistedMlsState {
    format: u8,
    device_scope: String,
    signature_public_key: String,
    storage: Vec<PersistedStorageEntry>,
    available_key_packages: Vec<PersistedKeyPackage>,
    groups: Vec<PersistedGroup>,
    #[serde(default)]
    pending_invitations: Vec<PersistedPendingInvitation>,
    #[serde(default)]
    transport_cursors: Vec<PersistedTransportCursor>,
}

#[derive(SerdeSerialize, SerdeDeserialize)]
#[serde(deny_unknown_fields)]
struct PersistedStorageEntry {
    key: String,
    value: String,
}

#[derive(SerdeSerialize, SerdeDeserialize)]
#[serde(deny_unknown_fields)]
struct PersistedKeyPackage {
    reference: String,
    key_package: String,
}

#[derive(SerdeSerialize, SerdeDeserialize)]
#[serde(deny_unknown_fields)]
struct PersistedGroup {
    conversation_id: String,
    group_id: String,
}

#[derive(SerdeSerialize, SerdeDeserialize)]
#[serde(deny_unknown_fields)]
struct PersistedPendingInvitation {
    conversation_id: String,
    group_id: String,
    epoch: u64,
    key_package_reference: String,
    recipient_device_id: String,
    commit: String,
    welcome: String,
}

#[derive(SerdeSerialize, SerdeDeserialize)]
#[serde(deny_unknown_fields)]
struct PersistedTransportCursor {
    conversation_id: String,
    sequence: u64,
}

#[derive(Clone)]
struct PendingMemberInvitation {
    group_id: String,
    epoch: u64,
    key_package_reference: String,
    recipient_device_id: String,
    commit: String,
    welcome: String,
}

impl PendingMemberInvitation {
    fn export(&self, conversation_id: &str) -> ExportedMemberAdd {
        ExportedMemberAdd {
            protocol: PROTOCOL,
            conversation_id: conversation_id.to_string(),
            group_id: self.group_id.clone(),
            epoch: self.epoch,
            key_package_reference: self.key_package_reference.clone(),
            recipient_device_id: self.recipient_device_id.clone(),
            commit: self.commit.clone(),
            welcome: self.welcome.clone(),
        }
    }
}

struct DeviceIdentity {
    scope: String,
    credential_with_key: CredentialWithKey,
    signer: SignatureKeyPair,
}

/// Process-local OpenMLS kernel. Public RPC results never contain signature
/// private keys, HPKE init private keys, or provider storage contents.
///
/// Persistent state is exported only as an authenticated encrypted snapshot.
/// The caller must keep its separate state-encryption key in OS secure storage;
/// there is no plaintext persistence fallback.
#[derive(Default)]
pub struct MlsKernel {
    provider: OpenMlsRustCrypto,
    identity: Option<DeviceIdentity>,
    available_key_packages: HashMap<String, KeyPackage>,
    groups: HashMap<String, MlsGroup>,
    pending_invitations: HashMap<String, PendingMemberInvitation>,
    transport_cursors: HashMap<String, u64>,
    persistence_scope: Option<String>,
    persistence_key: Option<Zeroizing<Vec<u8>>>,
}

impl MlsKernel {
    pub fn configure_persistence(
        &mut self,
        raw_scope: &str,
        encoded_key: &str,
    ) -> Result<(), String> {
        let scope = validate_scope(raw_scope)?;
        if let Some(identity) = &self.identity {
            if identity.scope != scope {
                return Err("MLS persistence scope does not match initialized identity".into());
            }
        }
        if let Some(configured_scope) = &self.persistence_scope {
            if configured_scope != &scope {
                return Err("MLS persistence is configured for another device scope".into());
            }
        }
        let key = decode_base64("MLS persistence key", encoded_key, 128)?;
        if key.len() != 32 {
            return Err("MLS persistence key must contain exactly 32 bytes".into());
        }
        if let Some(configured_key) = &self.persistence_key {
            return if configured_key.as_slice() == key.as_slice() {
                Ok(())
            } else {
                Err("MLS persistence key is already configured".into())
            };
        }
        self.persistence_scope = Some(scope);
        self.persistence_key = Some(Zeroizing::new(key));
        Ok(())
    }

    pub fn export_encrypted_state(&self, raw_scope: &str) -> Result<String, String> {
        let scope = validate_scope(raw_scope)?;
        self.require_identity(&scope)?;
        let key = self.persistence_key(&scope)?;
        let identity = self.identity.as_ref().expect("identity checked above");
        let storage = self
            .provider
            .storage()
            .values
            .read()
            .map_err(|_| "MLS persistence storage lock is poisoned")?
            .iter()
            .map(|(key, value)| PersistedStorageEntry {
                key: BASE64.encode(key),
                value: BASE64.encode(value),
            })
            .collect();
        let available_key_packages = self
            .available_key_packages
            .iter()
            .map(|(reference, key_package)| {
                let serialized = key_package.tls_serialize_detached().map_err(|error| {
                    format!("MLS persisted KeyPackage serialization failed: {error}")
                })?;
                Ok(PersistedKeyPackage {
                    reference: reference.clone(),
                    key_package: BASE64.encode(serialized),
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        let groups = self
            .groups
            .iter()
            .map(|(conversation_id, group)| PersistedGroup {
                conversation_id: conversation_id.clone(),
                group_id: BASE64.encode(group.group_id().as_slice()),
            })
            .collect();
        let pending_invitations = self
            .pending_invitations
            .iter()
            .map(|(conversation_id, invitation)| PersistedPendingInvitation {
                conversation_id: conversation_id.clone(),
                group_id: invitation.group_id.clone(),
                epoch: invitation.epoch,
                key_package_reference: invitation.key_package_reference.clone(),
                recipient_device_id: invitation.recipient_device_id.clone(),
                commit: invitation.commit.clone(),
                welcome: invitation.welcome.clone(),
            })
            .collect();
        let transport_cursors = self
            .transport_cursors
            .iter()
            .map(|(conversation_id, sequence)| PersistedTransportCursor {
                conversation_id: conversation_id.clone(),
                sequence: *sequence,
            })
            .collect();
        let snapshot = PersistedMlsState {
            format: 1,
            device_scope: scope.clone(),
            signature_public_key: BASE64.encode(identity.signer.public()),
            storage,
            available_key_packages,
            groups,
            pending_invitations,
            transport_cursors,
        };
        let plaintext = Zeroizing::new(
            serde_json::to_vec(&snapshot)
                .map_err(|error| format!("MLS state serialization failed: {error}"))?,
        );
        if plaintext.len() > MAX_STATE_PLAINTEXT_BYTES {
            return Err("MLS state snapshot exceeds the configured size limit".into());
        }
        let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
        let mut nonce_bytes = [0u8; 12];
        OsRng.fill_bytes(&mut nonce_bytes);
        let nonce = Nonce::from_slice(&nonce_bytes);
        let ciphertext = cipher
            .encrypt(
                nonce,
                aes_gcm::aead::Payload {
                    msg: plaintext.as_slice(),
                    aad: persistence_aad(&scope).as_bytes(),
                },
            )
            .map_err(|_| "MLS state encryption failed")?;
        serde_json::to_string(&EncryptedStateEnvelope {
            format: 1,
            cipher: STATE_CIPHER.to_string(),
            nonce: BASE64.encode(nonce_bytes),
            ciphertext: BASE64.encode(ciphertext),
        })
        .map_err(|error| format!("MLS state envelope serialization failed: {error}"))
    }

    pub fn restore_encrypted_state(
        &mut self,
        raw_scope: &str,
        encrypted_state: &str,
    ) -> Result<(), String> {
        let scope = validate_scope(raw_scope)?;
        if self.identity.is_some()
            || !self.groups.is_empty()
            || !self.available_key_packages.is_empty()
            || !self.pending_invitations.is_empty()
            || !self.transport_cursors.is_empty()
        {
            return Err("MLS state restore requires a pristine kernel".into());
        }
        if encrypted_state.is_empty() || encrypted_state.len() > MAX_STATE_ENVELOPE_BYTES {
            return Err("MLS encrypted state size is invalid".into());
        }
        let key = self.persistence_key(&scope)?;
        let envelope: EncryptedStateEnvelope = serde_json::from_str(encrypted_state)
            .map_err(|_| "MLS encrypted state envelope is invalid")?;
        if envelope.format != 1 || envelope.cipher != STATE_CIPHER {
            return Err("MLS encrypted state format or cipher is unsupported".into());
        }
        let nonce = decode_base64("MLS state nonce", &envelope.nonce, 64)?;
        if nonce.len() != 12 {
            return Err("MLS state nonce must contain exactly 12 bytes".into());
        }
        let ciphertext = decode_base64(
            "MLS state ciphertext",
            &envelope.ciphertext,
            MAX_STATE_ENVELOPE_BYTES,
        )?;
        let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
        let plaintext = Zeroizing::new(
            cipher
                .decrypt(
                    Nonce::from_slice(&nonce),
                    aes_gcm::aead::Payload {
                        msg: &ciphertext,
                        aad: persistence_aad(&scope).as_bytes(),
                    },
                )
                .map_err(|_| "MLS encrypted state decrypt or authentication failed")?,
        );
        if plaintext.len() > MAX_STATE_PLAINTEXT_BYTES {
            return Err("MLS decrypted state exceeds the configured size limit".into());
        }
        let snapshot: PersistedMlsState = serde_json::from_slice(&plaintext)
            .map_err(|_| "MLS decrypted state payload is invalid")?;
        if snapshot.format != 1 || snapshot.device_scope != scope {
            return Err("MLS decrypted state device scope is invalid".into());
        }

        let provider = OpenMlsRustCrypto::default();
        {
            let mut values = provider
                .storage()
                .values
                .write()
                .map_err(|_| "MLS restored storage lock is poisoned")?;
            for entry in snapshot.storage {
                let stored_key =
                    decode_base64("MLS stored key", &entry.key, MAX_STATE_PLAINTEXT_BYTES)?;
                let stored_value =
                    decode_base64("MLS stored value", &entry.value, MAX_STATE_PLAINTEXT_BYTES)?;
                if values.insert(stored_key, stored_value).is_some() {
                    return Err("MLS restored storage contains duplicate keys".into());
                }
            }
        }
        let signature_public_key = decode_base64(
            "MLS signature public key",
            &snapshot.signature_public_key,
            256,
        )?;
        let signer = SignatureKeyPair::read(
            provider.storage(),
            &signature_public_key,
            CIPHERSUITE.signature_algorithm(),
        )
        .ok_or_else(|| "MLS restored signature key is missing".to_string())?;
        let credential_with_key = CredentialWithKey {
            credential: BasicCredential::new(scope.as_bytes().to_vec()).into(),
            signature_key: signer.public().into(),
        };

        let mut available_key_packages = HashMap::new();
        for persisted in snapshot.available_key_packages {
            if !is_sha256(&persisted.reference) {
                return Err("MLS restored KeyPackage reference is invalid".into());
            }
            let serialized = decode_base64(
                "MLS restored KeyPackage",
                &persisted.key_package,
                MAX_KEY_PACKAGE_BASE64,
            )?;
            let key_package = KeyPackageIn::tls_deserialize_exact(serialized)
                .map_err(|_| "MLS restored KeyPackage decoding failed")?
                .validate(provider.crypto(), ProtocolVersion::Mls10)
                .map_err(|_| "MLS restored KeyPackage verification failed")?;
            if key_package.ciphersuite() != CIPHERSUITE {
                return Err("MLS restored KeyPackage ciphersuite is incompatible".into());
            }
            validate_member_credential(key_package.leaf_node().credential(), &scope)?;
            let reference = hex::encode(
                key_package
                    .hash_ref(provider.crypto())
                    .map_err(|_| "MLS restored KeyPackage reference failed")?
                    .as_slice(),
            );
            if reference != persisted.reference
                || available_key_packages
                    .insert(reference, key_package)
                    .is_some()
            {
                return Err("MLS restored KeyPackage reference is inconsistent".into());
            }
        }

        let mut groups = HashMap::new();
        for persisted in snapshot.groups {
            let conversation_id = validate_conversation_id(&persisted.conversation_id)?;
            let group_id = decode_base64("MLS restored group id", &persisted.group_id, 128)?;
            let group = MlsGroup::load(provider.storage(), &GroupId::from_slice(&group_id))
                .map_err(|_| "MLS restored group storage is invalid")?
                .ok_or_else(|| "MLS restored group is missing".to_string())?;
            if group.ciphersuite() != CIPHERSUITE
                || group.group_id().as_slice() != group_id.as_slice()
            {
                return Err("MLS restored group identity is inconsistent".into());
            }
            for member in group.members() {
                validate_member_credential(&member.credential, &scope)?;
            }
            if groups.insert(conversation_id, group).is_some() {
                return Err("MLS restored state contains duplicate conversations".into());
            }
        }

        let mut pending_invitations = HashMap::new();
        for pending in snapshot.pending_invitations {
            let conversation_id = validate_conversation_id(&pending.conversation_id)?;
            if !is_sha256(&pending.key_package_reference)
                || validate_device_id(&pending.recipient_device_id).is_err()
                || decode_base64("MLS restored pending group id", &pending.group_id, 128)?
                    .is_empty()
                || decode_base64(
                    "MLS restored pending commit",
                    &pending.commit,
                    MAX_WELCOME_BASE64,
                )?
                .is_empty()
                || decode_base64(
                    "MLS restored pending Welcome",
                    &pending.welcome,
                    MAX_WELCOME_BASE64,
                )?
                .is_empty()
            {
                return Err("MLS restored pending invitation is invalid".into());
            }
            let group = groups
                .get(&conversation_id)
                .ok_or_else(|| "MLS restored pending invitation group is missing".to_string())?;
            if group.pending_commit().is_none()
                || BASE64.encode(group.group_id().as_slice()) != pending.group_id
                || group.epoch().as_u64() != pending.epoch
            {
                return Err("MLS restored pending invitation state is inconsistent".into());
            }
            if pending_invitations
                .insert(
                    conversation_id,
                    PendingMemberInvitation {
                        group_id: pending.group_id,
                        epoch: pending.epoch,
                        key_package_reference: pending.key_package_reference,
                        recipient_device_id: pending.recipient_device_id,
                        commit: pending.commit,
                        welcome: pending.welcome,
                    },
                )
                .is_some()
            {
                return Err("MLS restored state contains duplicate pending invitations".into());
            }
        }

        let mut transport_cursors = HashMap::new();
        for cursor in snapshot.transport_cursors {
            let conversation_id = validate_conversation_id(&cursor.conversation_id)?;
            if cursor.sequence == 0
                || transport_cursors
                    .insert(conversation_id, cursor.sequence)
                    .is_some()
            {
                return Err("MLS restored transport cursor is invalid".into());
            }
        }

        let persistence_key = self
            .persistence_key
            .take()
            .ok_or_else(|| "MLS persistence key is not configured".to_string())?;
        let persistence_scope = self
            .persistence_scope
            .take()
            .ok_or_else(|| "MLS persistence scope is not configured".to_string())?;
        *self = Self {
            provider,
            identity: Some(DeviceIdentity {
                scope,
                credential_with_key,
                signer,
            }),
            available_key_packages,
            groups,
            pending_invitations,
            transport_cursors,
            persistence_scope: Some(persistence_scope),
            persistence_key: Some(persistence_key),
        };
        Ok(())
    }

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

    pub fn list_key_packages(
        &self,
        raw_scope: &str,
    ) -> Result<Vec<ExportedKeyPackage>, String> {
        let scope = validate_scope(raw_scope)?;
        self.require_identity(&scope)?;
        let mut packages = self
            .available_key_packages
            .iter()
            .map(|(reference, key_package)| {
                let serialized = key_package.tls_serialize_detached().map_err(|error| {
                    format!("MLS key package serialization failed: {error}")
                })?;
                Ok(ExportedKeyPackage {
                    protocol: PROTOCOL,
                    ciphersuite: "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
                    reference: reference.clone(),
                    key_package: BASE64.encode(serialized),
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        packages.sort_by(|left, right| left.reference.cmp(&right.reference));
        Ok(packages)
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
        let member_scope =
            validate_member_credential(key_package.leaf_node().credential(), &scope)?;
        let recipient_device_id = validate_device_id(
            member_scope
                .rsplit('/')
                .next()
                .ok_or_else(|| "MLS member device identity is missing".to_string())?,
        )?;
        let key_package_reference = hex::encode(
            key_package
                .hash_ref(self.provider.crypto())
                .map_err(|error| format!("MLS key package reference failed: {error}"))?
                .as_slice(),
        );

        let identity = self.identity.as_ref().expect("identity checked above");
        if self.pending_invitations.contains_key(&conversation_id) {
            return Err("MLS pending invitation state already exists".into());
        }
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
        let pending = PendingMemberInvitation {
            group_id,
            epoch,
            key_package_reference,
            recipient_device_id,
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
        };
        let exported = pending.export(&conversation_id);
        if self
            .pending_invitations
            .insert(conversation_id, pending)
            .is_some()
        {
            return Err("MLS pending invitation state already exists".into());
        }
        Ok(exported)
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
        let state = export_group_state(&conversation_id, group);
        self.pending_invitations.remove(&conversation_id);
        Ok(state)
    }

    pub fn inspect_group(
        &self,
        raw_scope: &str,
        raw_conversation_id: &str,
    ) -> Result<Option<ExportedGroupInspection>, String> {
        let scope = validate_scope(raw_scope)?;
        let conversation_id = validate_conversation_id(raw_conversation_id)?;
        self.require_identity(&scope)?;
        let Some(group) = self.groups.get(&conversation_id) else {
            return Ok(None);
        };
        Ok(Some(ExportedGroupInspection {
            protocol: PROTOCOL,
            conversation_id: conversation_id.clone(),
            group_id: BASE64.encode(group.group_id().as_slice()),
            epoch: group.epoch().as_u64(),
            member_count: group.members().count(),
            pending_commit: group.pending_commit().is_some(),
            pending_invitation: self
                .pending_invitations
                .get(&conversation_id)
                .map(|invitation| invitation.export(&conversation_id)),
        }))
    }

    pub fn transport_cursor(
        &self,
        raw_scope: &str,
        raw_conversation_id: &str,
    ) -> Result<u64, String> {
        let scope = validate_scope(raw_scope)?;
        let conversation_id = validate_conversation_id(raw_conversation_id)?;
        self.require_identity(&scope)?;
        Ok(*self.transport_cursors.get(&conversation_id).unwrap_or(&0))
    }

    pub fn acknowledge_transport_event(
        &mut self,
        raw_scope: &str,
        raw_conversation_id: &str,
        sequence: u64,
    ) -> Result<u64, String> {
        let scope = validate_scope(raw_scope)?;
        let conversation_id = validate_conversation_id(raw_conversation_id)?;
        self.require_identity(&scope)?;
        if sequence == 0 {
            return Err("MLS transport cursor is invalid".into());
        }
        let current = self.transport_cursors.get(&conversation_id).copied().unwrap_or(0);
        if sequence <= current {
            return Err("MLS transport cursor must move forwards".into());
        }
        self.transport_cursors.insert(conversation_id, sequence);
        Ok(sequence)
    }

    pub fn decrypt_transport_application(
        &mut self,
        raw_scope: &str,
        raw_conversation_id: &str,
        encoded_ciphertext: &str,
        sequence: u64,
    ) -> Result<DecryptedApplicationMessage, String> {
        let scope = validate_scope(raw_scope)?;
        let conversation_id = validate_conversation_id(raw_conversation_id)?;
        self.require_identity(&scope)?;
        let current = self.transport_cursors.get(&conversation_id).copied().unwrap_or(0);
        if sequence == 0 || sequence <= current {
            return Err("MLS transport application event was already processed".into());
        }
        let decrypted = self.decrypt_application(&scope, &conversation_id, encoded_ciphertext)?;
        self.transport_cursors.insert(conversation_id, sequence);
        Ok(decrypted)
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

    fn persistence_key(&self, scope: &str) -> Result<&[u8], String> {
        if self.persistence_scope.as_deref() != Some(scope) {
            return Err("MLS persistence scope is not configured".into());
        }
        self.persistence_key
            .as_deref()
            .map(|key| key.as_slice())
            .ok_or_else(|| "MLS persistence key is not configured".to_string())
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

fn validate_device_id(raw: &str) -> Result<String, String> {
    let device_id = raw.trim();
    if device_id.is_empty()
        || device_id.len() > 200
        || !device_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
    {
        return Err("MLS device id is invalid".into());
    }
    Ok(device_id.to_string())
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

fn persistence_aad(scope: &str) -> String {
    format!("otto-mls-state-v1/{scope}")
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
        assert_eq!(invitation.key_package_reference, bob_key_package.reference);
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

    #[test]
    fn encrypted_snapshots_restore_two_device_ratchets_after_restart() {
        let alice_scope = "server-a/org-a/alice/alice-device";
        let bob_scope = "server-a/org-a/bob/bob-device";
        let conversation = "conversation-a";
        let alice_state_key = BASE64.encode([7u8; 32]);
        let bob_state_key = BASE64.encode([9u8; 32]);
        let mut alice = MlsKernel::default();
        let mut bob = MlsKernel::default();
        alice
            .configure_persistence(alice_scope, &alice_state_key)
            .unwrap();
        bob.configure_persistence(bob_scope, &bob_state_key)
            .unwrap();
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
        bob.join_group(
            bob_scope,
            conversation,
            &bob_key_package.reference,
            &committed.group_id,
            &invitation.welcome,
        )
        .unwrap();
        let before_restart = alice
            .encrypt_application(alice_scope, conversation, b"before restart")
            .unwrap();
        bob.decrypt_transport_application(
            bob_scope,
            conversation,
            &before_restart.ciphertext,
            7,
        )
        .unwrap();
        assert_eq!(bob.transport_cursor(bob_scope, conversation).unwrap(), 7);

        let alice_snapshot = alice.export_encrypted_state(alice_scope).unwrap();
        let bob_snapshot = bob.export_encrypted_state(bob_scope).unwrap();
        assert!(!alice_snapshot.contains(alice_scope));
        assert!(!alice_snapshot.contains("before restart"));

        let mut restored_alice = MlsKernel::default();
        let mut restored_bob = MlsKernel::default();
        restored_alice
            .configure_persistence(alice_scope, &alice_state_key)
            .unwrap();
        restored_bob
            .configure_persistence(bob_scope, &bob_state_key)
            .unwrap();
        restored_alice
            .restore_encrypted_state(alice_scope, &alice_snapshot)
            .unwrap();
        restored_bob
            .restore_encrypted_state(bob_scope, &bob_snapshot)
            .unwrap();
        assert_eq!(
            restored_bob
                .transport_cursor(bob_scope, conversation)
                .unwrap(),
            7
        );

        let after_restart = restored_alice
            .encrypt_application(alice_scope, conversation, b"after restart")
            .unwrap();
        let decrypted = restored_bob
            .decrypt_transport_application(
                bob_scope,
                conversation,
                &after_restart.ciphertext,
                8,
            )
            .unwrap();
        assert_eq!(decrypted.plaintext, b"after restart");
        assert_eq!(
            restored_bob
                .transport_cursor(bob_scope, conversation)
                .unwrap(),
            8
        );
        assert!(restored_bob
            .acknowledge_transport_event(bob_scope, conversation, 7)
            .unwrap_err()
            .contains("forwards"));

        let mut wrong_key = MlsKernel::default();
        wrong_key
            .configure_persistence(alice_scope, &BASE64.encode([8u8; 32]))
            .unwrap();
        assert!(wrong_key
            .restore_encrypted_state(alice_scope, &alice_snapshot)
            .unwrap_err()
            .contains("decrypt"));
        assert!(wrong_key.create_key_package(alice_scope).is_err());
    }

    #[test]
    fn encrypted_snapshot_restores_a_pending_member_commit() {
        let alice_scope = "server-a/org-a/alice/alice-device";
        let bob_scope = "server-a/org-a/bob/bob-device";
        let conversation = "conversation-pending";
        let alice_state_key = BASE64.encode([11u8; 32]);
        let mut alice = MlsKernel::default();
        let mut bob = MlsKernel::default();
        alice
            .configure_persistence(alice_scope, &alice_state_key)
            .unwrap();
        alice.initialize(alice_scope).unwrap();
        bob.initialize(bob_scope).unwrap();
        let bob_key_package = bob.create_key_package(bob_scope).unwrap();
        alice.create_group(alice_scope, conversation).unwrap();
        let invitation = alice
            .add_member(alice_scope, conversation, &bob_key_package.key_package)
            .unwrap();

        let snapshot = alice.export_encrypted_state(alice_scope).unwrap();
        let mut restored_alice = MlsKernel::default();
        restored_alice
            .configure_persistence(alice_scope, &alice_state_key)
            .unwrap();
        restored_alice
            .restore_encrypted_state(alice_scope, &snapshot)
            .unwrap();
        let inspection = restored_alice
            .inspect_group(alice_scope, conversation)
            .unwrap()
            .unwrap();
        assert!(inspection.pending_commit);
        let restored_invitation = inspection.pending_invitation.unwrap();
        assert_eq!(restored_invitation.commit, invitation.commit);
        assert_eq!(restored_invitation.welcome, invitation.welcome);
        assert_eq!(
            restored_invitation.key_package_reference,
            bob_key_package.reference
        );
        let committed = restored_alice
            .merge_pending_commit(alice_scope, conversation)
            .unwrap();
        let inspection = restored_alice
            .inspect_group(alice_scope, conversation)
            .unwrap()
            .unwrap();
        assert!(!inspection.pending_commit);
        assert!(inspection.pending_invitation.is_none());
        bob.join_group(
            bob_scope,
            conversation,
            &bob_key_package.reference,
            &committed.group_id,
            &invitation.welcome,
        )
        .unwrap();
    }
}
