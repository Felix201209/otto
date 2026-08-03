use std::collections::{HashMap, HashSet};
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
use zeroize::{Zeroize, Zeroizing};

const CIPHERSUITE: Ciphersuite = Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;
const PROTOCOL: &str = "mls10-openmls-0.8";
const MAX_KEY_PACKAGE_BASE64: usize = 128 * 1024;
const MAX_AVAILABLE_KEY_PACKAGES: usize = 100;
const MAX_CONVERSATIONS: usize = 1_000;
const MAX_WELCOME_BASE64: usize = 2 * 1024 * 1024;
const MAX_APPLICATION_BYTES: usize = 1024 * 1024;
const MAX_CIPHERTEXT_BASE64: usize = 2 * 1024 * 1024;
const MAX_STATE_PLAINTEXT_BYTES: usize = 64 * 1024 * 1024;
const MAX_STATE_ENVELOPE_BYTES: usize = 96 * 1024 * 1024;
const MAX_PENDING_APPLICATIONS: usize = 1_000;
const MAX_PENDING_APPLICATION_BYTES: usize = 32 * 1024 * 1024;
const MAX_PENDING_RECEIVED_APPLICATIONS: usize = 1_000;
const MAX_PENDING_RECEIVED_APPLICATION_BYTES: usize = 32 * 1024 * 1024;
const MAX_PENDING_APPLICATION_STORAGE_BYTES: usize = 48 * 1024 * 1024;
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
    pub recipient_account_id: String,
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

#[derive(Clone, Debug, SerdeSerialize)]
pub struct ExportedPendingApplication {
    pub protocol: &'static str,
    pub event_id: String,
    pub conversation_id: String,
    pub peer_account_id: String,
    pub group_id: String,
    pub epoch: u64,
    pub ciphertext: String,
}

#[derive(Clone, Debug, SerdeSerialize)]
pub struct ExportedPendingReceivedApplication {
    pub protocol: &'static str,
    pub event_id: String,
    pub conversation_id: String,
    pub peer_account_id: String,
    pub sequence: u64,
    pub group_id: String,
    pub epoch: u64,
    pub sender_device_scope: String,
    pub plaintext: String,
    pub created_at: String,
}

#[derive(Debug)]
pub struct DecryptedApplicationMessage {
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
    #[serde(default)]
    pending_applications: Vec<PersistedPendingApplication>,
    #[serde(default)]
    conversation_routes: Vec<PersistedConversationRoute>,
    #[serde(default)]
    pending_received_applications: Vec<PersistedPendingReceivedApplication>,
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
    #[serde(default)]
    recipient_account_id: Option<String>,
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

#[derive(SerdeSerialize, SerdeDeserialize)]
#[serde(deny_unknown_fields)]
struct PersistedPendingApplication {
    event_id: String,
    conversation_id: String,
    peer_account_id: String,
    group_id: String,
    epoch: u64,
    ciphertext: String,
    created_order: u64,
}

#[derive(SerdeSerialize, SerdeDeserialize)]
#[serde(deny_unknown_fields)]
struct PersistedConversationRoute {
    conversation_id: String,
    peer_account_id: String,
}

#[derive(SerdeSerialize, SerdeDeserialize)]
#[serde(deny_unknown_fields)]
struct PersistedPendingReceivedApplication {
    event_id: String,
    conversation_id: String,
    peer_account_id: String,
    sequence: u64,
    group_id: String,
    epoch: u64,
    sender_device_scope: String,
    plaintext: String,
    created_at: String,
}

#[derive(Clone)]
struct PendingApplication {
    conversation_id: String,
    peer_account_id: String,
    group_id: String,
    epoch: u64,
    ciphertext: String,
    created_order: u64,
}

impl PendingApplication {
    fn export(&self, event_id: &str) -> ExportedPendingApplication {
        ExportedPendingApplication {
            protocol: PROTOCOL,
            event_id: event_id.to_string(),
            conversation_id: self.conversation_id.clone(),
            peer_account_id: self.peer_account_id.clone(),
            group_id: self.group_id.clone(),
            epoch: self.epoch,
            ciphertext: self.ciphertext.clone(),
        }
    }
}

#[derive(Clone)]
struct PendingMemberInvitation {
    group_id: String,
    epoch: u64,
    key_package_reference: String,
    recipient_account_id: Option<String>,
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
            recipient_account_id: self.recipient_account_id.clone().unwrap_or_default(),
            recipient_device_id: self.recipient_device_id.clone(),
            commit: self.commit.clone(),
            welcome: self.welcome.clone(),
        }
    }
}

#[derive(Clone)]
struct PendingReceivedApplication {
    conversation_id: String,
    peer_account_id: String,
    sequence: u64,
    group_id: String,
    epoch: u64,
    sender_device_scope: String,
    plaintext: Zeroizing<String>,
    created_at: String,
}

impl PendingReceivedApplication {
    fn export(&self, event_id: &str) -> ExportedPendingReceivedApplication {
        ExportedPendingReceivedApplication {
            protocol: PROTOCOL,
            event_id: event_id.to_string(),
            conversation_id: self.conversation_id.clone(),
            peer_account_id: self.peer_account_id.clone(),
            sequence: self.sequence,
            group_id: self.group_id.clone(),
            epoch: self.epoch,
            sender_device_scope: self.sender_device_scope.clone(),
            plaintext: self.plaintext.to_string(),
            created_at: self.created_at.clone(),
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
    pending_applications: HashMap<String, PendingApplication>,
    conversation_routes: HashMap<String, String>,
    pending_received_applications: HashMap<String, PendingReceivedApplication>,
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
                recipient_account_id: invitation.recipient_account_id.clone(),
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
        let pending_applications = self
            .pending_applications
            .iter()
            .map(|(event_id, application)| PersistedPendingApplication {
                event_id: event_id.clone(),
                conversation_id: application.conversation_id.clone(),
                peer_account_id: application.peer_account_id.clone(),
                group_id: application.group_id.clone(),
                epoch: application.epoch,
                ciphertext: application.ciphertext.clone(),
                created_order: application.created_order,
            })
            .collect();
        let conversation_routes = self
            .conversation_routes
            .iter()
            .map(
                |(conversation_id, peer_account_id)| PersistedConversationRoute {
                    conversation_id: conversation_id.clone(),
                    peer_account_id: peer_account_id.clone(),
                },
            )
            .collect();
        let pending_received_applications = self
            .pending_received_applications
            .iter()
            .map(
                |(event_id, application)| PersistedPendingReceivedApplication {
                    event_id: event_id.clone(),
                    conversation_id: application.conversation_id.clone(),
                    peer_account_id: application.peer_account_id.clone(),
                    sequence: application.sequence,
                    group_id: application.group_id.clone(),
                    epoch: application.epoch,
                    sender_device_scope: application.sender_device_scope.clone(),
                    plaintext: application.plaintext.to_string(),
                    created_at: application.created_at.clone(),
                },
            )
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
            pending_applications,
            conversation_routes,
            pending_received_applications,
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
            || !self.pending_applications.is_empty()
            || !self.conversation_routes.is_empty()
            || !self.pending_received_applications.is_empty()
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

        if snapshot.available_key_packages.len() > MAX_AVAILABLE_KEY_PACKAGES {
            return Err("MLS restored KeyPackage inventory exceeds its limit".into());
        }
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

        if snapshot.groups.len() > MAX_CONVERSATIONS {
            return Err("MLS restored conversation inventory exceeds its limit".into());
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
            let recipient_account_id = pending
                .recipient_account_id
                .as_deref()
                .map(validate_account_id)
                .transpose()?;
            if !is_sha256(&pending.key_package_reference)
                || recipient_account_id.as_deref() == scope.split('/').nth(2)
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
                        recipient_account_id,
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

        if snapshot.conversation_routes.len() > groups.len() {
            return Err("MLS restored conversation route limit is invalid".into());
        }
        let mut conversation_routes = HashMap::new();
        for route in snapshot.conversation_routes {
            let conversation_id = validate_conversation_id(&route.conversation_id)?;
            let peer_account_id = validate_account_id(&route.peer_account_id)?;
            if scope.split('/').nth(2) == Some(peer_account_id.as_str()) {
                return Err("MLS restored conversation route peer is invalid".into());
            }
            let group = groups
                .get(&conversation_id)
                .ok_or_else(|| "MLS restored conversation route group is missing".to_string())?;
            require_direct_peer_binding(group, &scope, &peer_account_id)?;
            if conversation_routes
                .insert(conversation_id, peer_account_id)
                .is_some()
            {
                return Err("MLS restored state contains duplicate conversation routes".into());
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

        if snapshot.pending_applications.len() > MAX_PENDING_APPLICATIONS {
            return Err("MLS restored application outbox exceeds its item limit".into());
        }
        let mut pending_application_bytes = 0usize;
        let mut pending_application_orders = HashSet::new();
        let mut pending_applications = HashMap::new();
        let local_account_id = scope
            .split('/')
            .nth(2)
            .ok_or_else(|| "MLS decrypted state device scope is invalid".to_string())?;
        for pending in snapshot.pending_applications {
            let conversation_id = validate_conversation_id(&pending.conversation_id)?;
            let peer_account_id = validate_account_id(&pending.peer_account_id)?;
            if peer_account_id == local_account_id {
                return Err("MLS restored application outbox peer is invalid".into());
            }
            decode_base64(
                "MLS restored pending application",
                &pending.ciphertext,
                MAX_CIPHERTEXT_BASE64,
            )?;
            pending_application_bytes = pending_application_bytes
                .checked_add(pending.ciphertext.len())
                .ok_or_else(|| "MLS restored application outbox size overflow".to_string())?;
            if pending_application_bytes > MAX_PENDING_APPLICATION_BYTES {
                return Err("MLS restored application outbox exceeds its size limit".into());
            }
            if pending.created_order == 0
                || !pending_application_orders
                    .insert((conversation_id.clone(), pending.created_order))
            {
                return Err("MLS restored application outbox order is invalid".into());
            }
            let group = groups
                .get(&conversation_id)
                .ok_or_else(|| "MLS restored pending application group is missing".to_string())?;
            if !group_contains_account(group, &scope, &peer_account_id)? {
                return Err("MLS restored application outbox peer binding is invalid".into());
            }
            match conversation_routes.get(&conversation_id) {
                Some(bound_peer) if bound_peer != &peer_account_id => {
                    return Err("MLS restored application outbox route is inconsistent".into())
                }
                None => {
                    require_direct_peer_binding(group, &scope, &peer_account_id)?;
                    conversation_routes.insert(conversation_id.clone(), peer_account_id.clone());
                }
                _ => {}
            }
            if BASE64.encode(group.group_id().as_slice()) != pending.group_id
                || group.epoch().as_u64() != pending.epoch
            {
                return Err("MLS restored pending application state is inconsistent".into());
            }
            let event_id = validate_application_event_id(&pending.event_id)?;
            if pending_applications
                .insert(
                    event_id,
                    PendingApplication {
                        conversation_id,
                        peer_account_id,
                        group_id: pending.group_id,
                        epoch: pending.epoch,
                        ciphertext: pending.ciphertext,
                        created_order: pending.created_order,
                    },
                )
                .is_some()
            {
                return Err("MLS restored pending application identity is invalid".into());
            }
        }

        if snapshot.pending_received_applications.len() > MAX_PENDING_RECEIVED_APPLICATIONS {
            return Err("MLS restored application inbox exceeds its item limit".into());
        }
        let mut pending_received_application_bytes = 0usize;
        let mut pending_received_sequences = HashSet::new();
        let mut pending_received_applications = HashMap::new();
        for pending in snapshot.pending_received_applications {
            let event_id = validate_application_event_id(&pending.event_id)?;
            let conversation_id = validate_conversation_id(&pending.conversation_id)?;
            let peer_account_id = validate_account_id(&pending.peer_account_id)?;
            let sender_device_scope = validate_scope(&pending.sender_device_scope)?;
            validate_created_at(&pending.created_at)?;
            if pending.sequence == 0
                || transport_cursors
                    .get(&conversation_id)
                    .copied()
                    .unwrap_or(0)
                    < pending.sequence
                || sender_device_scope.split('/').nth(2) != Some(peer_account_id.as_str())
                || !pending_received_sequences.insert((conversation_id.clone(), pending.sequence))
            {
                return Err("MLS restored application inbox binding is invalid".into());
            }
            validate_member_scope(&sender_device_scope, &scope)?;
            let plaintext = Zeroizing::new(decode_base64(
                "MLS restored received application",
                &pending.plaintext,
                1_398_104,
            )?);
            if plaintext.is_empty() || plaintext.len() > MAX_APPLICATION_BYTES {
                return Err("MLS restored application inbox plaintext size is invalid".into());
            }
            pending_received_application_bytes = pending_received_application_bytes
                .checked_add(pending.plaintext.len())
                .ok_or_else(|| "MLS restored application inbox size overflow".to_string())?;
            if pending_received_application_bytes > MAX_PENDING_RECEIVED_APPLICATION_BYTES {
                return Err("MLS restored application inbox exceeds its size limit".into());
            }
            let group = groups
                .get(&conversation_id)
                .ok_or_else(|| "MLS restored application inbox group is missing".to_string())?;
            if conversation_routes.get(&conversation_id) != Some(&peer_account_id)
                || BASE64.encode(group.group_id().as_slice()) != pending.group_id
                || group.epoch().as_u64() < pending.epoch
            {
                return Err("MLS restored application inbox state is inconsistent".into());
            }
            if pending_received_applications
                .insert(
                    event_id,
                    PendingReceivedApplication {
                        conversation_id,
                        peer_account_id,
                        sequence: pending.sequence,
                        group_id: pending.group_id,
                        epoch: pending.epoch,
                        sender_device_scope,
                        plaintext: Zeroizing::new(pending.plaintext),
                        created_at: pending.created_at,
                    },
                )
                .is_some()
            {
                return Err("MLS restored application inbox identity is invalid".into());
            }
        }
        if pending_application_bytes
            .checked_add(pending_received_application_bytes)
            .ok_or_else(|| "MLS restored pending application size overflow".to_string())?
            > MAX_PENDING_APPLICATION_STORAGE_BYTES
        {
            return Err("MLS restored pending applications exceed the combined size limit".into());
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
            pending_applications,
            conversation_routes,
            pending_received_applications,
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
        if self.available_key_packages.len() >= MAX_AVAILABLE_KEY_PACKAGES {
            return Err("MLS KeyPackage inventory limit reached".into());
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

    pub fn list_key_packages(&self, raw_scope: &str) -> Result<Vec<ExportedKeyPackage>, String> {
        let scope = validate_scope(raw_scope)?;
        self.require_identity(&scope)?;
        let mut packages = self
            .available_key_packages
            .iter()
            .map(|(reference, key_package)| {
                let serialized = key_package
                    .tls_serialize_detached()
                    .map_err(|error| format!("MLS key package serialization failed: {error}"))?;
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
        if self.groups.len() >= MAX_CONVERSATIONS {
            return Err("MLS conversation inventory limit reached".into());
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
        let recipient_account_id = validate_account_id(
            member_scope
                .split('/')
                .nth(2)
                .ok_or_else(|| "MLS member account identity is missing".to_string())?,
        )?;
        if scope.split('/').nth(2) == Some(recipient_account_id.as_str()) {
            return Err("MLS direct-session recipient account is invalid".into());
        }
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
            recipient_account_id: Some(recipient_account_id),
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
        raw_peer_account_id: &str,
    ) -> Result<ExportedGroupState, String> {
        let scope = validate_scope(raw_scope)?;
        let conversation_id = validate_conversation_id(raw_conversation_id)?;
        let peer_account_id = validate_account_id(raw_peer_account_id)?;
        self.require_identity(&scope)?;
        if scope.split('/').nth(2) == Some(peer_account_id.as_str()) {
            return Err("MLS conversation route peer is invalid".into());
        }
        let invitation = self
            .pending_invitations
            .get(&conversation_id)
            .ok_or_else(|| "MLS pending invitation state is missing".to_string())?;
        if invitation.recipient_account_id.as_deref() != Some(peer_account_id.as_str()) {
            return Err(
                "MLS pending invitation lacks a verified peer binding; security state reset is required"
                    .into(),
            );
        }
        if self
            .conversation_routes
            .get(&conversation_id)
            .is_some_and(|bound_peer| bound_peer != &peer_account_id)
        {
            return Err("MLS conversation route conflicts with the pending invitation".into());
        }
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
        self.conversation_routes
            .insert(conversation_id, peer_account_id);
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
        let current = self
            .transport_cursors
            .get(&conversation_id)
            .copied()
            .unwrap_or(0);
        if sequence <= current {
            return Err("MLS transport cursor must move forwards".into());
        }
        self.transport_cursors.insert(conversation_id, sequence);
        Ok(sequence)
    }

    pub fn receive_transport_commit(
        &mut self,
        raw_scope: &str,
        raw_conversation_id: &str,
        raw_peer_account_id: &str,
        encoded_commit: &str,
        sequence: u64,
        raw_expected_group_id: &str,
        expected_epoch: u64,
        raw_sender_device_id: &str,
    ) -> Result<ExportedGroupState, String> {
        let scope = validate_scope(raw_scope)?;
        let conversation_id = validate_conversation_id(raw_conversation_id)?;
        let peer_account_id = validate_account_id(raw_peer_account_id)?;
        let expected_group_id = decode_base64("MLS group id", raw_expected_group_id, 128)?;
        let sender_device_id = validate_device_id(raw_sender_device_id)?;
        let serialized = decode_base64("MLS Commit", encoded_commit, MAX_WELCOME_BASE64)?;
        self.require_identity(&scope)?;
        if scope.split('/').nth(2) == Some(peer_account_id.as_str()) {
            return Err("MLS Commit peer account is invalid".into());
        }
        if self.conversation_routes.get(&conversation_id) != Some(&peer_account_id) {
            return Err("MLS Commit peer binding is invalid".into());
        }
        let current_cursor = self
            .transport_cursors
            .get(&conversation_id)
            .copied()
            .unwrap_or(0);
        if sequence == 0 || sequence <= current_cursor {
            return Err("MLS Commit transport event was already processed".into());
        }

        let message = MlsMessageIn::tls_deserialize_exact(serialized)
            .map_err(|error| format!("MLS Commit decoding failed: {error}"))?
            .try_into_protocol_message()
            .map_err(|error| format!("MLS Commit message type failed: {error}"))?;
        let current_member_scopes = {
            let group = self
                .groups
                .get(&conversation_id)
                .ok_or_else(|| "MLS conversation group is missing".to_string())?;
            if group.pending_commit().is_some() {
                return Err("MLS group has an unmerged pending commit".into());
            }
            let next_epoch = group
                .epoch()
                .as_u64()
                .checked_add(1)
                .ok_or_else(|| "MLS group epoch is exhausted".to_string())?;
            if group.group_id().as_slice() != expected_group_id.as_slice()
                || expected_epoch != next_epoch
            {
                return Err("MLS Commit does not advance the active group epoch".into());
            }
            require_direct_peer_binding(group, &scope, &peer_account_id)?;
            group_member_scopes(group, &scope)?
        };

        let processed = {
            let group = self
                .groups
                .get_mut(&conversation_id)
                .ok_or_else(|| "MLS conversation group is missing".to_string())?;
            catch_unwind(AssertUnwindSafe(|| {
                group.process_message(&self.provider, message)
            }))
        };
        let processed = match processed {
            Ok(Ok(processed)) => processed,
            Ok(Err(error)) => {
                self.quarantine_conversation(&conversation_id);
                return Err(format!(
                    "MLS Commit processing failed: {error}; conversation state quarantined"
                ));
            }
            Err(_) => {
                self.quarantine_conversation(&conversation_id);
                return Err("MLS Commit processing failed; conversation state quarantined".into());
            }
        };

        let authenticated_commit = (|| -> Result<_, String> {
            if processed.aad() != conversation_aad(&conversation_id)
                || processed.group_id().as_slice() != expected_group_id.as_slice()
                || processed.epoch().as_u64().checked_add(1) != Some(expected_epoch)
            {
                return Err("MLS Commit security binding is invalid".into());
            }
            let sender_scope = validate_member_credential(processed.credential(), &scope)?;
            if sender_scope.split('/').nth(2) != Some(peer_account_id.as_str())
                || sender_scope.rsplit('/').next() != Some(sender_device_id.as_str())
            {
                return Err("MLS Commit sender binding is invalid".into());
            }
            let staged = match processed.into_content() {
                ProcessedMessageContent::StagedCommitMessage(staged) => staged,
                _ => return Err("MLS message is not a Commit".into()),
            };
            if staged.epoch().as_u64() != expected_epoch
                || staged.self_removed()
                || staged.queued_proposals().next().is_some()
            {
                return Err(
                    "MLS direct-session Commit contains an unsupported membership or proposal change"
                        .into(),
                );
            }
            let update_scope = staged
                .update_path_leaf_node()
                .ok_or_else(|| "MLS Commit update path is missing".to_string())
                .and_then(|leaf| validate_member_credential(leaf.credential(), &scope))?;
            if update_scope != sender_scope {
                return Err("MLS Commit update identity is invalid".into());
            }
            Ok(staged)
        })();

        let staged = match authenticated_commit {
            Ok(staged) => staged,
            Err(error) => {
                self.quarantine_conversation(&conversation_id);
                return Err(format!("{error}; conversation state quarantined"));
            }
        };

        let merged = (|| -> Result<ExportedGroupState, String> {
            let group = self
                .groups
                .get_mut(&conversation_id)
                .ok_or_else(|| "MLS conversation group is missing".to_string())?;
            group
                .merge_staged_commit(&self.provider, *staged)
                .map_err(|error| format!("MLS Commit merge failed: {error}"))?;
            let updated_member_scopes = group_member_scopes(group, &scope)?;
            if updated_member_scopes != current_member_scopes
                || group.group_id().as_slice() != expected_group_id.as_slice()
                || group.epoch().as_u64() != expected_epoch
            {
                return Err(
                    "MLS Commit changed the direct-session membership or security binding".into(),
                );
            }
            require_direct_peer_binding(group, &scope, &peer_account_id)?;
            Ok(export_group_state(&conversation_id, group))
        })();
        let merged = match merged {
            Ok(merged) => merged,
            Err(error) => {
                self.quarantine_conversation(&conversation_id);
                return Err(format!("{error}; conversation state quarantined"));
            }
        };
        self.transport_cursors.insert(conversation_id, sequence);
        Ok(merged)
    }

    pub fn receive_transport_application(
        &mut self,
        raw_scope: &str,
        raw_conversation_id: &str,
        raw_peer_account_id: &str,
        raw_event_id: &str,
        encoded_ciphertext: &str,
        sequence: u64,
        raw_expected_group_id: &str,
        expected_epoch: u64,
        raw_sender_device_id: &str,
        raw_created_at: &str,
    ) -> Result<ExportedPendingReceivedApplication, String> {
        let scope = validate_scope(raw_scope)?;
        let conversation_id = validate_conversation_id(raw_conversation_id)?;
        let peer_account_id = validate_account_id(raw_peer_account_id)?;
        let event_id = validate_application_event_id(raw_event_id)?;
        let expected_group_id = decode_base64("MLS group id", raw_expected_group_id, 128)?;
        let sender_device_id = validate_device_id(raw_sender_device_id)?;
        let created_at = validate_created_at(raw_created_at)?;
        self.require_identity(&scope)?;
        if self.conversation_routes.get(&conversation_id) != Some(&peer_account_id) {
            return Err("MLS application inbox peer binding is invalid".into());
        }
        if let Some(pending) = self.pending_received_applications.get(&event_id) {
            if pending.conversation_id == conversation_id
                && pending.peer_account_id == peer_account_id
                && pending.sequence == sequence
            {
                return Ok(pending.export(&event_id));
            }
            return Err("MLS application inbox event identity conflicts".into());
        }
        let current = self
            .transport_cursors
            .get(&conversation_id)
            .copied()
            .unwrap_or(0);
        if sequence == 0 || sequence <= current {
            return Err("MLS transport application event was already processed".into());
        }
        if self.pending_received_applications.len() >= MAX_PENDING_RECEIVED_APPLICATIONS {
            return Err("MLS application inbox item limit reached".into());
        }
        if self
            .pending_received_applications
            .values()
            .any(|application| {
                application.conversation_id == conversation_id && application.sequence == sequence
            })
        {
            return Err("MLS application inbox sequence conflicts".into());
        }
        let pending_bytes = self.pending_received_applications.values().try_fold(
            0usize,
            |total, application| {
                total
                    .checked_add(application.plaintext.len())
                    .ok_or_else(|| "MLS application inbox size overflow".to_string())
            },
        )?;
        let outbox_bytes =
            self.pending_applications
                .values()
                .try_fold(0usize, |total, application| {
                    total
                        .checked_add(application.ciphertext.len())
                        .ok_or_else(|| "MLS pending application size overflow".to_string())
                })?;
        if pending_bytes
            .checked_add(encoded_ciphertext.len())
            .ok_or_else(|| "MLS application inbox size overflow".to_string())?
            > MAX_PENDING_RECEIVED_APPLICATION_BYTES
        {
            return Err("MLS application inbox size limit reached".into());
        }
        if pending_bytes
            .checked_add(outbox_bytes)
            .and_then(|total| total.checked_add(encoded_ciphertext.len()))
            .ok_or_else(|| "MLS pending application size overflow".to_string())?
            > MAX_PENDING_APPLICATION_STORAGE_BYTES
        {
            return Err("MLS pending application combined size limit reached".into());
        }
        let group = self
            .groups
            .get(&conversation_id)
            .ok_or_else(|| "MLS conversation group is missing".to_string())?;
        require_direct_peer_binding(group, &scope, &peer_account_id)?;
        if group.group_id().as_slice() != expected_group_id.as_slice()
            || group.epoch().as_u64() != expected_epoch
        {
            return Err("MLS application event does not match active group state".into());
        }
        let mut decrypted =
            self.decrypt_application(&scope, &conversation_id, encoded_ciphertext)?;
        if decrypted.group_id != raw_expected_group_id
            || decrypted.epoch != expected_epoch
            || decrypted.sender_device_scope.split('/').nth(2) != Some(peer_account_id.as_str())
            || decrypted.sender_device_scope.rsplit('/').next() != Some(sender_device_id.as_str())
        {
            self.groups.remove(&conversation_id);
            self.conversation_routes.remove(&conversation_id);
            return Err(
                "MLS application sender conflicts with the direct-session peer; conversation state quarantined"
                    .into(),
            );
        }
        let plaintext = BASE64.encode(&decrypted.plaintext);
        decrypted.plaintext.zeroize();
        let pending = PendingReceivedApplication {
            conversation_id: conversation_id.clone(),
            peer_account_id,
            sequence,
            group_id: decrypted.group_id,
            epoch: decrypted.epoch,
            sender_device_scope: decrypted.sender_device_scope,
            plaintext: Zeroizing::new(plaintext),
            created_at,
        };
        let exported = pending.export(&event_id);
        if self
            .pending_received_applications
            .insert(event_id, pending)
            .is_some()
        {
            return Err("MLS application inbox identity collision".into());
        }
        self.transport_cursors.insert(conversation_id, sequence);
        Ok(exported)
    }

    pub fn list_pending_received_applications(
        &self,
        raw_scope: &str,
        raw_conversation_id: &str,
        raw_peer_account_id: &str,
    ) -> Result<Vec<ExportedPendingReceivedApplication>, String> {
        let scope = validate_scope(raw_scope)?;
        let conversation_id = validate_conversation_id(raw_conversation_id)?;
        let peer_account_id = validate_account_id(raw_peer_account_id)?;
        self.require_identity(&scope)?;
        if self.conversation_routes.get(&conversation_id) != Some(&peer_account_id) {
            return Err("MLS application inbox peer binding is invalid".into());
        }
        let mut pending = self
            .pending_received_applications
            .iter()
            .filter(|(_, application)| {
                application.conversation_id == conversation_id
                    && application.peer_account_id == peer_account_id
            })
            .map(|(event_id, application)| application.export(event_id))
            .collect::<Vec<_>>();
        pending.sort_by(|left, right| {
            left.sequence
                .cmp(&right.sequence)
                .then_with(|| left.event_id.cmp(&right.event_id))
        });
        Ok(pending)
    }

    pub fn acknowledge_received_application(
        &mut self,
        raw_scope: &str,
        raw_conversation_id: &str,
        raw_peer_account_id: &str,
        raw_event_id: &str,
    ) -> Result<(), String> {
        let scope = validate_scope(raw_scope)?;
        let conversation_id = validate_conversation_id(raw_conversation_id)?;
        let peer_account_id = validate_account_id(raw_peer_account_id)?;
        let event_id = validate_application_event_id(raw_event_id)?;
        self.require_identity(&scope)?;
        let pending = self
            .pending_received_applications
            .get(&event_id)
            .ok_or_else(|| "MLS received application is missing".to_string())?;
        if pending.conversation_id != conversation_id || pending.peer_account_id != peer_account_id
        {
            return Err("MLS received application conversation binding is invalid".into());
        }
        self.pending_received_applications.remove(&event_id);
        Ok(())
    }

    pub fn list_conversation_peers(&self, raw_scope: &str) -> Result<Vec<String>, String> {
        let scope = validate_scope(raw_scope)?;
        self.require_identity(&scope)?;
        let mut peers = self
            .conversation_routes
            .values()
            .cloned()
            .collect::<HashSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        peers.sort();
        Ok(peers)
    }

    pub fn bind_conversation_peer(
        &mut self,
        raw_scope: &str,
        raw_conversation_id: &str,
        raw_peer_account_id: &str,
    ) -> Result<bool, String> {
        let scope = validate_scope(raw_scope)?;
        let conversation_id = validate_conversation_id(raw_conversation_id)?;
        let peer_account_id = validate_account_id(raw_peer_account_id)?;
        self.require_identity(&scope)?;
        if scope.split('/').nth(2) == Some(peer_account_id.as_str()) {
            return Err("MLS conversation route peer is invalid".into());
        }
        if let Some(bound_peer) = self.conversation_routes.get(&conversation_id) {
            return if bound_peer == &peer_account_id {
                Ok(false)
            } else {
                Err("MLS conversation route conflicts with the requested peer".into())
            };
        }
        let group = self
            .groups
            .get(&conversation_id)
            .ok_or_else(|| "MLS conversation group is missing".to_string())?;
        if group.pending_commit().is_some() {
            return Err("MLS conversation route cannot bind a pending group".into());
        }
        require_direct_peer_binding(group, &scope, &peer_account_id)?;
        self.conversation_routes
            .insert(conversation_id, peer_account_id);
        Ok(true)
    }

    pub fn join_group(
        &mut self,
        raw_scope: &str,
        raw_conversation_id: &str,
        raw_peer_account_id: &str,
        key_package_reference: &str,
        expected_group_id: &str,
        encoded_welcome: &str,
    ) -> Result<ExportedGroupState, String> {
        let scope = validate_scope(raw_scope)?;
        let conversation_id = validate_conversation_id(raw_conversation_id)?;
        let peer_account_id = validate_account_id(raw_peer_account_id)?;
        self.require_identity(&scope)?;
        if scope.split('/').nth(2) == Some(peer_account_id.as_str()) {
            return Err("MLS conversation route peer is invalid".into());
        }
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
            let member_scope = validate_member_credential(&member.credential, &scope)?;
            let member_account_id = member_scope
                .split('/')
                .nth(2)
                .ok_or_else(|| "MLS member account identity is missing".to_string())?;
            if member_account_id != scope.split('/').nth(2).unwrap_or_default()
                && member_account_id != peer_account_id
            {
                return Err("MLS direct group contains an unexpected account".into());
            }
        }
        if !staged.members().any(|member| {
            validate_member_credential(&member.credential, &scope)
                .ok()
                .and_then(|member_scope| member_scope.split('/').nth(2).map(str::to_string))
                .as_deref()
                == Some(peer_account_id.as_str())
        }) {
            return Err("MLS Welcome does not contain the expected peer account".into());
        }
        let group = staged
            .into_group(&self.provider)
            .map_err(|error| format!("MLS Welcome join failed: {error}"))?;
        let state = export_group_state(&conversation_id, &group);
        self.groups.insert(conversation_id.clone(), group);
        self.conversation_routes
            .insert(conversation_id, peer_account_id);
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

    pub fn encrypt_transport_application(
        &mut self,
        raw_scope: &str,
        raw_conversation_id: &str,
        raw_peer_account_id: &str,
        plaintext: &[u8],
    ) -> Result<ExportedPendingApplication, String> {
        let scope = validate_scope(raw_scope)?;
        let conversation_id = validate_conversation_id(raw_conversation_id)?;
        let peer_account_id = validate_account_id(raw_peer_account_id)?;
        self.require_identity(&scope)?;
        if scope.split('/').nth(2) == Some(peer_account_id.as_str()) {
            return Err("MLS application outbox peer is invalid".into());
        }
        let group = self
            .groups
            .get(&conversation_id)
            .ok_or_else(|| "MLS group is missing".to_string())?;
        if self.conversation_routes.get(&conversation_id) != Some(&peer_account_id) {
            return Err("MLS application outbox conversation route is invalid".into());
        }
        if !group_contains_account(group, &scope, &peer_account_id)? {
            return Err("MLS application outbox peer binding is invalid".into());
        }
        require_direct_peer_binding(group, &scope, &peer_account_id)?;
        if self.pending_applications.len() >= MAX_PENDING_APPLICATIONS {
            return Err("MLS application outbox item limit reached".into());
        }
        let pending_bytes =
            self.pending_applications
                .values()
                .try_fold(0usize, |total, application| {
                    total
                        .checked_add(application.ciphertext.len())
                        .ok_or_else(|| "MLS application outbox size overflow".to_string())
                })?;
        let inbox_bytes = self.pending_received_applications.values().try_fold(
            0usize,
            |total, application| {
                total
                    .checked_add(application.plaintext.len())
                    .ok_or_else(|| "MLS pending application size overflow".to_string())
            },
        )?;
        if pending_bytes
            .checked_add(MAX_CIPHERTEXT_BASE64)
            .ok_or_else(|| "MLS application outbox size overflow".to_string())?
            > MAX_PENDING_APPLICATION_BYTES
        {
            return Err("MLS application outbox size limit reached".into());
        }
        if pending_bytes
            .checked_add(inbox_bytes)
            .and_then(|total| total.checked_add(MAX_CIPHERTEXT_BASE64))
            .ok_or_else(|| "MLS pending application size overflow".to_string())?
            > MAX_PENDING_APPLICATION_STORAGE_BYTES
        {
            return Err("MLS pending application combined size limit reached".into());
        }
        let event_id = loop {
            let mut random = [0u8; 32];
            OsRng.fill_bytes(&mut random);
            let candidate = format!("mls-{}", hex::encode(random));
            if !self.pending_applications.contains_key(&candidate) {
                break candidate;
            }
        };
        let created_order = self
            .pending_applications
            .values()
            .filter(|application| application.conversation_id == conversation_id)
            .map(|application| application.created_order)
            .max()
            .unwrap_or(0)
            .checked_add(1)
            .ok_or_else(|| "MLS application outbox order overflow".to_string())?;
        let encrypted = self.encrypt_application(&scope, &conversation_id, plaintext)?;
        let pending = PendingApplication {
            conversation_id,
            peer_account_id,
            group_id: encrypted.group_id,
            epoch: encrypted.epoch,
            ciphertext: encrypted.ciphertext,
            created_order,
        };
        let exported = pending.export(&event_id);
        if self
            .pending_applications
            .insert(event_id, pending)
            .is_some()
        {
            return Err("MLS application outbox identity collision".into());
        }
        Ok(exported)
    }

    pub fn list_pending_applications(
        &self,
        raw_scope: &str,
        raw_conversation_id: &str,
        raw_peer_account_id: &str,
    ) -> Result<Vec<ExportedPendingApplication>, String> {
        let scope = validate_scope(raw_scope)?;
        let conversation_id = validate_conversation_id(raw_conversation_id)?;
        let peer_account_id = validate_account_id(raw_peer_account_id)?;
        self.require_identity(&scope)?;
        if self.pending_applications.values().any(|application| {
            application.conversation_id == conversation_id
                && application.peer_account_id != peer_account_id
        }) {
            return Err("MLS application outbox peer binding is invalid".into());
        }
        let mut pending = self
            .pending_applications
            .iter()
            .filter(|(_, application)| {
                application.conversation_id == conversation_id
                    && application.peer_account_id == peer_account_id
            })
            .map(|(event_id, application)| application.export(event_id))
            .collect::<Vec<_>>();
        pending.sort_by(|left, right| {
            let left_order = self.pending_applications[&left.event_id].created_order;
            let right_order = self.pending_applications[&right.event_id].created_order;
            left_order
                .cmp(&right_order)
                .then_with(|| left.event_id.cmp(&right.event_id))
        });
        Ok(pending)
    }

    pub fn list_pending_application_peers(&self, raw_scope: &str) -> Result<Vec<String>, String> {
        let scope = validate_scope(raw_scope)?;
        self.require_identity(&scope)?;
        let mut peers = self
            .pending_applications
            .values()
            .map(|application| application.peer_account_id.clone())
            .collect::<HashSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        peers.sort();
        Ok(peers)
    }

    pub fn acknowledge_pending_application(
        &mut self,
        raw_scope: &str,
        raw_conversation_id: &str,
        raw_peer_account_id: &str,
        raw_event_id: &str,
    ) -> Result<(), String> {
        let scope = validate_scope(raw_scope)?;
        let conversation_id = validate_conversation_id(raw_conversation_id)?;
        let peer_account_id = validate_account_id(raw_peer_account_id)?;
        self.require_identity(&scope)?;
        let event_id = validate_application_event_id(raw_event_id)?;
        let pending = self
            .pending_applications
            .get(&event_id)
            .ok_or_else(|| "MLS pending application is missing".to_string())?;
        if pending.conversation_id != conversation_id || pending.peer_account_id != peer_account_id
        {
            return Err("MLS pending application conversation binding is invalid".into());
        }
        self.pending_applications.remove(&event_id);
        Ok(())
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

    fn quarantine_conversation(&mut self, conversation_id: &str) {
        self.groups.remove(conversation_id);
        self.pending_invitations.remove(conversation_id);
        self.transport_cursors.remove(conversation_id);
        self.conversation_routes.remove(conversation_id);
        self.pending_applications
            .retain(|_, pending| pending.conversation_id != conversation_id);
        self.pending_received_applications
            .retain(|_, pending| pending.conversation_id != conversation_id);
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

fn group_contains_account(
    group: &MlsGroup,
    local_scope: &str,
    account_id: &str,
) -> Result<bool, String> {
    for member in group.members() {
        let member_scope = validate_member_credential(&member.credential, local_scope)?;
        if member_scope.split('/').nth(2) == Some(account_id) {
            return Ok(true);
        }
    }
    Ok(false)
}

fn require_direct_peer_binding(
    group: &MlsGroup,
    local_scope: &str,
    peer_account_id: &str,
) -> Result<(), String> {
    let local_account_id = local_scope
        .split('/')
        .nth(2)
        .ok_or_else(|| "MLS local account identity is missing".to_string())?;
    let mut contains_local = false;
    let mut contains_peer = false;
    for member in group.members() {
        let member_scope = validate_member_credential(&member.credential, local_scope)?;
        match member_scope.split('/').nth(2) {
            Some(account_id) if account_id == local_account_id => contains_local = true,
            Some(account_id) if account_id == peer_account_id => contains_peer = true,
            _ => return Err("MLS direct group contains an unexpected account".into()),
        }
    }
    if !contains_local || !contains_peer {
        return Err("MLS direct group peer binding is invalid".into());
    }
    Ok(())
}

fn group_member_scopes(group: &MlsGroup, local_scope: &str) -> Result<HashSet<String>, String> {
    group
        .members()
        .map(|member| validate_member_credential(&member.credential, local_scope))
        .collect()
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

fn validate_account_id(raw: &str) -> Result<String, String> {
    let account_id = raw.trim();
    if account_id.is_empty()
        || account_id.len() > 200
        || !account_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
    {
        return Err("MLS account id is invalid".into());
    }
    Ok(account_id.to_string())
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
    validate_member_scope(member_scope, local_scope)
}

fn validate_member_scope(member_scope: &str, local_scope: &str) -> Result<String, String> {
    let member_scope = validate_scope(member_scope)?;
    let mut local_parts = local_scope.split('/');
    let mut member_parts = member_scope.split('/');
    if local_parts.next() != member_parts.next() || local_parts.next() != member_parts.next() {
        return Err("MLS member credential is outside the local trust domain".into());
    }
    Ok(member_scope)
}

fn validate_created_at(raw: &str) -> Result<String, String> {
    let created_at = raw.trim();
    if created_at.is_empty()
        || created_at.len() > 100
        || !created_at.is_ascii()
        || created_at.bytes().any(|byte| byte.is_ascii_control())
    {
        return Err("MLS application creation time is invalid".into());
    }
    Ok(created_at.to_string())
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

fn validate_application_event_id(raw: &str) -> Result<String, String> {
    let event_id = raw.trim();
    let digest = event_id
        .strip_prefix("mls-")
        .ok_or_else(|| "MLS application event id is invalid".to_string())?;
    if !is_sha256(digest) {
        return Err("MLS application event id is invalid".into());
    }
    Ok(event_id.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use openmls::prelude::{
        tls_codec::Deserialize, KeyPackageIn, LeafNodeParameters, ProtocolVersion,
    };

    fn established_direct_group() -> (
        MlsKernel,
        MlsKernel,
        &'static str,
        &'static str,
        &'static str,
        String,
    ) {
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
            .merge_pending_commit(alice_scope, conversation, "bob")
            .unwrap();
        bob.join_group(
            bob_scope,
            conversation,
            "alice",
            &bob_key_package.reference,
            &committed.group_id,
            &invitation.welcome,
        )
        .unwrap();
        (
            alice,
            bob,
            alice_scope,
            bob_scope,
            conversation,
            committed.group_id,
        )
    }

    fn create_self_update_commit(kernel: &mut MlsKernel, conversation: &str) -> String {
        let identity = kernel.identity.as_ref().unwrap();
        let group = kernel.groups.get_mut(conversation).unwrap();
        group.set_aad(conversation_aad(conversation));
        let commit = group
            .self_update(
                &kernel.provider,
                &identity.signer,
                LeafNodeParameters::default(),
            )
            .unwrap()
            .into_commit();
        let encoded = BASE64.encode(commit.to_bytes().unwrap());
        group.merge_pending_commit(&kernel.provider).unwrap();
        encoded
    }

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
            .merge_pending_commit(alice_scope, conversation, "bob")
            .unwrap();
        assert_eq!(committed.epoch, 1);

        let joined = bob
            .join_group(
                bob_scope,
                conversation,
                "alice",
                &bob_key_package.reference,
                &committed.group_id,
                &invitation.welcome,
            )
            .unwrap();
        assert_eq!(joined.group_id, committed.group_id);
        assert_eq!(joined.epoch, committed.epoch);
        alice.conversation_routes.remove(conversation);
        assert!(alice
            .list_conversation_peers(alice_scope)
            .unwrap()
            .is_empty());
        assert!(alice
            .bind_conversation_peer(alice_scope, conversation, "bob")
            .unwrap());
        assert!(!alice
            .bind_conversation_peer(alice_scope, conversation, "bob")
            .unwrap());
        assert!(alice
            .bind_conversation_peer(alice_scope, conversation, "mallory")
            .is_err());
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
    fn remote_update_commit_atomically_advances_epoch_cursor_and_persisted_state() {
        let state_key = BASE64.encode([11u8; 32]);
        let (mut alice, mut bob, alice_scope, bob_scope, conversation, group_id) =
            established_direct_group();
        bob.configure_persistence(bob_scope, &state_key).unwrap();
        let commit = create_self_update_commit(&mut alice, conversation);

        let updated = bob
            .receive_transport_commit(
                bob_scope,
                conversation,
                "alice",
                &commit,
                9,
                &group_id,
                2,
                "alice-device",
            )
            .unwrap();
        assert_eq!(updated.epoch, 2);
        assert_eq!(updated.member_count, 2);
        assert_eq!(bob.transport_cursor(bob_scope, conversation).unwrap(), 9);
        assert!(bob
            .receive_transport_commit(
                bob_scope,
                conversation,
                "alice",
                &commit,
                9,
                &group_id,
                2,
                "alice-device",
            )
            .unwrap_err()
            .contains("already processed"));

        let snapshot = bob.export_encrypted_state(bob_scope).unwrap();
        let mut restored = MlsKernel::default();
        restored
            .configure_persistence(bob_scope, &state_key)
            .unwrap();
        restored
            .restore_encrypted_state(bob_scope, &snapshot)
            .unwrap();
        let restored_group = restored
            .inspect_group(bob_scope, conversation)
            .unwrap()
            .unwrap();
        assert_eq!(restored_group.epoch, 2);
        assert_eq!(
            restored.transport_cursor(bob_scope, conversation).unwrap(),
            9
        );

        let encrypted = alice
            .encrypt_application(alice_scope, conversation, b"after remote commit")
            .unwrap();
        let received = restored
            .receive_transport_application(
                bob_scope,
                conversation,
                "alice",
                &format!("mls-{}", "9".repeat(64)),
                &encrypted.ciphertext,
                10,
                &group_id,
                2,
                "alice-device",
                "2026-08-03T00:00:00.000Z",
            )
            .unwrap();
        assert_eq!(
            BASE64.decode(received.plaintext).unwrap(),
            b"after remote commit"
        );
    }

    #[test]
    fn remote_commit_tampering_quarantines_without_advancing_cursor() {
        let (mut alice, mut bob, _, bob_scope, conversation, group_id) = established_direct_group();
        let commit = create_self_update_commit(&mut alice, conversation);
        let mut tampered = BASE64.decode(commit).unwrap();
        *tampered.last_mut().unwrap() ^= 1;

        let error = bob
            .receive_transport_commit(
                bob_scope,
                conversation,
                "alice",
                &BASE64.encode(tampered),
                1,
                &group_id,
                2,
                "alice-device",
            )
            .unwrap_err();
        assert!(error.contains("quarantined"));
        assert!(bob
            .inspect_group(bob_scope, conversation)
            .unwrap()
            .is_none());
        assert_eq!(bob.transport_cursor(bob_scope, conversation).unwrap(), 0);
    }

    #[test]
    fn remote_commit_rejects_a_substituted_sender_device() {
        let (mut alice, mut bob, _, bob_scope, conversation, group_id) = established_direct_group();
        let commit = create_self_update_commit(&mut alice, conversation);

        let error = bob
            .receive_transport_commit(
                bob_scope,
                conversation,
                "alice",
                &commit,
                1,
                &group_id,
                2,
                "substituted-device",
            )
            .unwrap_err();
        assert!(error.contains("sender binding is invalid"));
        assert!(error.contains("quarantined"));
        assert!(bob
            .inspect_group(bob_scope, conversation)
            .unwrap()
            .is_none());
        assert_eq!(bob.transport_cursor(bob_scope, conversation).unwrap(), 0);
    }

    #[test]
    fn remote_commit_quarantines_direct_session_membership_changes() {
        let (mut alice, mut bob, alice_scope, bob_scope, conversation, group_id) =
            established_direct_group();
        let bob_state_key = BASE64.encode([13u8; 32]);
        bob.configure_persistence(bob_scope, &bob_state_key)
            .unwrap();
        bob.encrypt_transport_application(
            bob_scope,
            conversation,
            "alice",
            b"must be removed with quarantined state",
        )
        .unwrap();
        let charlie_scope = "server-a/org-a/charlie/charlie-device";
        let mut charlie = MlsKernel::default();
        charlie.initialize(charlie_scope).unwrap();
        let charlie_key_package = charlie.create_key_package(charlie_scope).unwrap();
        alice
            .groups
            .get_mut(conversation)
            .unwrap()
            .set_aad(conversation_aad(conversation));
        let invitation = alice
            .add_member(alice_scope, conversation, &charlie_key_package.key_package)
            .unwrap();

        let error = bob
            .receive_transport_commit(
                bob_scope,
                conversation,
                "alice",
                &invitation.commit,
                1,
                &group_id,
                2,
                "alice-device",
            )
            .unwrap_err();
        assert!(error.contains("unsupported membership or proposal change"));
        assert!(error.contains("quarantined"));
        assert!(bob
            .inspect_group(bob_scope, conversation)
            .unwrap()
            .is_none());
        assert!(bob
            .list_pending_application_peers(bob_scope)
            .unwrap()
            .is_empty());

        let snapshot = bob.export_encrypted_state(bob_scope).unwrap();
        let mut restored = MlsKernel::default();
        restored
            .configure_persistence(bob_scope, &bob_state_key)
            .unwrap();
        restored
            .restore_encrypted_state(bob_scope, &snapshot)
            .unwrap();
        assert!(restored
            .inspect_group(bob_scope, conversation)
            .unwrap()
            .is_none());
        assert!(restored
            .list_pending_application_peers(bob_scope)
            .unwrap()
            .is_empty());
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
            .merge_pending_commit(alice_scope, conversation, "bob")
            .unwrap();

        let wrong_group_id = BASE64.encode([0u8; 16]);
        assert!(bob
            .join_group(
                bob_scope,
                conversation,
                "alice",
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
                "alice",
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
            .merge_pending_commit(alice_scope, conversation, "bob")
            .unwrap();
        bob.join_group(
            bob_scope,
            conversation,
            "alice",
            &bob_key_package.reference,
            &committed.group_id,
            &invitation.welcome,
        )
        .unwrap();
        let before_restart = alice
            .encrypt_application(alice_scope, conversation, b"before restart")
            .unwrap();
        let received_before_restart = bob
            .receive_transport_application(
                bob_scope,
                conversation,
                "alice",
                &format!("mls-{}", "1".repeat(64)),
                &before_restart.ciphertext,
                7,
                &committed.group_id,
                committed.epoch,
                "alice-device",
                "2026-08-02T00:00:00.000Z",
            )
            .unwrap();
        assert_eq!(
            BASE64.decode(received_before_restart.plaintext).unwrap(),
            b"before restart"
        );
        assert_eq!(bob.transport_cursor(bob_scope, conversation).unwrap(), 7);

        let alice_snapshot = alice.export_encrypted_state(alice_scope).unwrap();
        let bob_snapshot = bob.export_encrypted_state(bob_scope).unwrap();
        assert!(!alice_snapshot.contains(alice_scope));
        assert!(!alice_snapshot.contains("before restart"));
        assert!(!bob_snapshot.contains("before restart"));

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
        let received = restored_bob
            .receive_transport_application(
                bob_scope,
                conversation,
                "alice",
                &format!("mls-{}", "2".repeat(64)),
                &after_restart.ciphertext,
                8,
                &committed.group_id,
                committed.epoch,
                "alice-device",
                "2026-08-02T00:01:00.000Z",
            )
            .unwrap();
        assert_eq!(BASE64.decode(received.plaintext).unwrap(), b"after restart");
        let pending_received = restored_bob
            .list_pending_received_applications(bob_scope, conversation, "alice")
            .unwrap();
        assert_eq!(pending_received.len(), 2);
        assert_eq!(pending_received[0].sequence, 7);
        assert_eq!(pending_received[1].sequence, 8);
        restored_bob
            .acknowledge_received_application(
                bob_scope,
                conversation,
                "alice",
                &pending_received[0].event_id,
            )
            .unwrap();
        assert_eq!(
            restored_bob
                .list_pending_received_applications(bob_scope, conversation, "alice")
                .unwrap()
                .len(),
            1
        );
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
            .merge_pending_commit(alice_scope, conversation, "bob")
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
            "alice",
            &bob_key_package.reference,
            &committed.group_id,
            &invitation.welcome,
        )
        .unwrap();
    }

    #[test]
    fn encrypted_snapshot_restores_and_acknowledges_the_application_outbox() {
        let alice_scope = "server-a/org-a/alice/alice-device";
        let bob_scope = "server-a/org-a/bob/bob-device";
        let conversation = "conversation-outbox";
        let alice_state_key = BASE64.encode([13u8; 32]);
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
        let committed = alice
            .merge_pending_commit(alice_scope, conversation, "bob")
            .unwrap();
        bob.join_group(
            bob_scope,
            conversation,
            "alice",
            &bob_key_package.reference,
            &committed.group_id,
            &invitation.welcome,
        )
        .unwrap();

        assert!(alice
            .encrypt_transport_application(alice_scope, conversation, "alice", b"invalid route")
            .unwrap_err()
            .contains("peer is invalid"));
        assert!(alice
            .encrypt_transport_application(alice_scope, conversation, "mallory", b"invalid route")
            .unwrap_err()
            .contains("conversation route"));

        let queued = alice
            .encrypt_transport_application(alice_scope, conversation, "bob", b"survive restart")
            .unwrap();
        let queued_second = alice
            .encrypt_transport_application(alice_scope, conversation, "bob", b"second message")
            .unwrap();
        assert!(queued.event_id.starts_with("mls-"));
        assert!(is_sha256(&queued.event_id[4..]));
        let before_restart = alice
            .list_pending_applications(alice_scope, conversation, "bob")
            .unwrap();
        assert_eq!(before_restart.len(), 2);
        assert_eq!(before_restart[0].event_id, queued.event_id);
        assert_eq!(before_restart[1].event_id, queued_second.event_id);
        assert_eq!(
            alice.list_pending_application_peers(alice_scope).unwrap(),
            vec!["bob".to_string()]
        );
        assert!(alice
            .acknowledge_pending_application(
                alice_scope,
                "another-conversation",
                "bob",
                &queued.event_id,
            )
            .unwrap_err()
            .contains("conversation binding"));

        let snapshot = alice.export_encrypted_state(alice_scope).unwrap();
        assert!(!snapshot.contains("survive restart"));
        let mut restored = MlsKernel::default();
        restored
            .configure_persistence(alice_scope, &alice_state_key)
            .unwrap();
        restored
            .restore_encrypted_state(alice_scope, &snapshot)
            .unwrap();
        let replay = restored
            .list_pending_applications(alice_scope, conversation, "bob")
            .unwrap();
        assert_eq!(replay.len(), 2);
        assert_eq!(replay[0].event_id, queued.event_id);
        assert_eq!(replay[0].ciphertext, queued.ciphertext);
        assert_eq!(replay[1].event_id, queued_second.event_id);
        assert_eq!(
            restored.pending_applications[&replay[0].event_id].created_order,
            1
        );
        assert_eq!(
            restored.pending_applications[&replay[1].event_id].created_order,
            2
        );
        let decrypted = bob
            .decrypt_application(bob_scope, conversation, &replay[0].ciphertext)
            .unwrap();
        assert_eq!(decrypted.plaintext, b"survive restart");
        let decrypted = bob
            .decrypt_application(bob_scope, conversation, &replay[1].ciphertext)
            .unwrap();
        assert_eq!(decrypted.plaintext, b"second message");

        restored
            .acknowledge_pending_application(alice_scope, conversation, "bob", &queued.event_id)
            .unwrap();
        restored
            .acknowledge_pending_application(
                alice_scope,
                conversation,
                "bob",
                &queued_second.event_id,
            )
            .unwrap();
        assert!(restored
            .list_pending_applications(alice_scope, conversation, "bob")
            .unwrap()
            .is_empty());
        assert!(restored
            .list_pending_application_peers(alice_scope)
            .unwrap()
            .is_empty());
    }
}
