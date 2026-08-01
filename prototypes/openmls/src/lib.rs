// Copyright 2026 Otto
// SPDX-License-Identifier: Apache-2.0

//! OpenMLS interoperability prototype for Otto private conversations.
//!
//! This crate is not linked into a release binary. It exercises the upstream
//! RFC 9420 state machine before the desktop integration is allowed to begin.

use openmls::prelude::*;
use openmls_basic_credential::SignatureKeyPair;
use openmls_rust_crypto::OpenMlsRustCrypto;
use openmls_traits::types::Ciphersuite;
use thiserror::Error;
use tls_codec::Deserialize;

pub const OTTO_CIPHERSUITE: Ciphersuite = Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;

#[derive(Debug, Error)]
pub enum PrototypeError {
    #[error("OpenMLS prototype failed: {0}")]
    OpenMls(String),
    #[error("unexpected MLS message type")]
    UnexpectedMessage,
}

pub struct PrototypeClient {
    pub provider: OpenMlsRustCrypto,
    pub signer: SignatureKeyPair,
    pub credential: CredentialWithKey,
}

impl PrototypeClient {
    pub fn new(identity: &[u8]) -> Result<Self, PrototypeError> {
        let provider = OpenMlsRustCrypto::default();
        let signer = SignatureKeyPair::new(OTTO_CIPHERSUITE.signature_algorithm())
            .map_err(|error| PrototypeError::OpenMls(error.to_string()))?;
        signer
            .store(provider.storage())
            .map_err(|error| PrototypeError::OpenMls(error.to_string()))?;
        let credential = CredentialWithKey {
            credential: BasicCredential::new(identity.to_vec()).into(),
            signature_key: signer.public().into(),
        };
        Ok(Self {
            provider,
            signer,
            credential,
        })
    }

    pub fn key_package(&self) -> Result<KeyPackageBundle, PrototypeError> {
        KeyPackage::builder()
            .build(
                OTTO_CIPHERSUITE,
                &self.provider,
                &self.signer,
                self.credential.clone(),
            )
            .map_err(|error| PrototypeError::OpenMls(error.to_string()))
    }
}

pub fn create_private_group(
    creator: &PrototypeClient,
    group_id: &[u8],
) -> Result<(MlsGroup, MlsGroupCreateConfig), PrototypeError> {
    let config = MlsGroupCreateConfig::builder()
        .ciphersuite(OTTO_CIPHERSUITE)
        .use_ratchet_tree_extension(true)
        .build();
    let group = MlsGroup::new_with_group_id(
        &creator.provider,
        &creator.signer,
        &config,
        GroupId::from_slice(group_id),
        creator.credential.clone(),
    )
    .map_err(|error| PrototypeError::OpenMls(error.to_string()))?;
    Ok((group, config))
}

pub fn add_client(
    group: &mut MlsGroup,
    creator: &PrototypeClient,
    joining: &PrototypeClient,
    config: &MlsGroupCreateConfig,
) -> Result<MlsGroup, PrototypeError> {
    let key_package = joining.key_package()?;
    let (_, welcome, _) = group
        .add_members(
            &creator.provider,
            &creator.signer,
            core::slice::from_ref(key_package.key_package()),
        )
        .map_err(|error| PrototypeError::OpenMls(error.to_string()))?;
    group
        .merge_pending_commit(&creator.provider)
        .map_err(|error| PrototypeError::OpenMls(error.to_string()))?;

    let welcome = MlsMessageIn::tls_deserialize_exact(
        welcome
            .to_bytes()
            .map_err(|error| PrototypeError::OpenMls(error.to_string()))?,
    )
    .map_err(|error| PrototypeError::OpenMls(error.to_string()))?;
    let welcome = match welcome.extract() {
        MlsMessageBodyIn::Welcome(welcome) => welcome,
        _ => return Err(PrototypeError::UnexpectedMessage),
    };
    join_from_welcome(joining, config, welcome)
}

fn join_from_welcome(
    joining: &PrototypeClient,
    config: &MlsGroupCreateConfig,
    welcome: Welcome,
) -> Result<MlsGroup, PrototypeError> {
    StagedWelcome::new_from_welcome(&joining.provider, config.join_config(), welcome, None)
        .map_err(|error| PrototypeError::OpenMls(error.to_string()))?
        .into_group(&joining.provider)
        .map_err(|error| PrototypeError::OpenMls(error.to_string()))
}

pub fn encrypt_application_message(
    group: &mut MlsGroup,
    sender: &PrototypeClient,
    plaintext: &[u8],
) -> Result<MlsMessageOut, PrototypeError> {
    group
        .create_message(&sender.provider, &sender.signer, plaintext)
        .map_err(|error| PrototypeError::OpenMls(error.to_string()))
}

pub fn decrypt_application_message(
    group: &mut MlsGroup,
    recipient: &PrototypeClient,
    message: MlsMessageOut,
) -> Result<Vec<u8>, PrototypeError> {
    let incoming = MlsMessageIn::tls_deserialize_exact(
        message
            .to_bytes()
            .map_err(|error| PrototypeError::OpenMls(error.to_string()))?,
    )
    .map_err(|error| PrototypeError::OpenMls(error.to_string()))?;
    let protocol = incoming
        .try_into_protocol_message()
        .map_err(|error| PrototypeError::OpenMls(error.to_string()))?;
    let processed = group
        .process_message(&recipient.provider, protocol)
        .map_err(|error| PrototypeError::OpenMls(error.to_string()))?;
    match processed.into_content() {
        ProcessedMessageContent::ApplicationMessage(application) => Ok(application.into_bytes()),
        _ => Err(PrototypeError::UnexpectedMessage),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn deserialize_welcome(bytes: &[u8]) -> Welcome {
        let message = MlsMessageIn::tls_deserialize_exact(bytes.to_vec()).unwrap();
        match message.extract() {
            MlsMessageBodyIn::Welcome(welcome) => welcome,
            _ => panic!("expected an MLS Welcome"),
        }
    }

    fn merge_commit(group: &mut MlsGroup, recipient: &PrototypeClient, message: MlsMessageOut) {
        let incoming = MlsMessageIn::tls_deserialize_exact(message.to_bytes().unwrap()).unwrap();
        let processed = group
            .process_message(
                &recipient.provider,
                incoming.try_into_protocol_message().unwrap(),
            )
            .unwrap();
        match processed.into_content() {
            ProcessedMessageContent::StagedCommitMessage(commit) => group
                .merge_staged_commit(&recipient.provider, *commit)
                .unwrap(),
            _ => panic!("expected a staged MLS commit"),
        }
    }

    #[test]
    fn two_devices_join_and_exchange_authenticated_messages() {
        let alice = PrototypeClient::new(b"tenant-a/account-alice/device-1").unwrap();
        let bob = PrototypeClient::new(b"tenant-a/account-bob/device-1").unwrap();
        let (mut alice_group, config) =
            create_private_group(&alice, b"otto-private-conversation-1").unwrap();
        let mut bob_group = add_client(&mut alice_group, &alice, &bob, &config).unwrap();

        assert_eq!(alice_group.epoch(), bob_group.epoch());
        assert_eq!(alice_group.members().count(), 2);
        assert_eq!(bob_group.members().count(), 2);

        let encrypted =
            encrypt_application_message(&mut alice_group, &alice, b"hello from Otto").unwrap();
        let plaintext = decrypt_application_message(&mut bob_group, &bob, encrypted).unwrap();
        assert_eq!(plaintext, b"hello from Otto");
    }

    #[test]
    fn multiple_devices_rotate_epoch_and_exclude_a_removed_device() {
        let alice = PrototypeClient::new(b"tenant-a/account-alice/device-1").unwrap();
        let bob = PrototypeClient::new(b"tenant-a/account-bob/device-1").unwrap();
        let bob_phone = PrototypeClient::new(b"tenant-a/account-bob/device-2").unwrap();
        let (mut alice_group, config) =
            create_private_group(&alice, b"otto-private-conversation-2").unwrap();

        let bob_key_package = bob.key_package().unwrap();
        let bob_phone_key_package = bob_phone.key_package().unwrap();
        let (_, welcome, _) = alice_group
            .add_members(
                &alice.provider,
                &alice.signer,
                &[
                    bob_key_package.key_package().clone(),
                    bob_phone_key_package.key_package().clone(),
                ],
            )
            .unwrap();
        let welcome_bytes = welcome.to_bytes().unwrap();
        alice_group.merge_pending_commit(&alice.provider).unwrap();
        let mut bob_group =
            join_from_welcome(&bob, &config, deserialize_welcome(&welcome_bytes)).unwrap();
        let mut bob_phone_group =
            join_from_welcome(&bob_phone, &config, deserialize_welcome(&welcome_bytes)).unwrap();

        assert_eq!(alice_group.members().count(), 3);
        assert_eq!(alice_group.epoch(), bob_group.epoch());
        assert_eq!(alice_group.epoch(), bob_phone_group.epoch());

        let epoch_before_rotation = alice_group.epoch();
        let (update, welcome, _) = bob_phone_group
            .self_update(
                &bob_phone.provider,
                &bob_phone.signer,
                LeafNodeParameters::default(),
            )
            .unwrap()
            .into_contents();
        assert!(welcome.is_none());
        merge_commit(&mut alice_group, &alice, update.clone());
        merge_commit(&mut bob_group, &bob, update);
        bob_phone_group
            .merge_pending_commit(&bob_phone.provider)
            .unwrap();
        assert!(alice_group.epoch() > epoch_before_rotation);
        assert_eq!(alice_group.epoch(), bob_group.epoch());
        assert_eq!(alice_group.epoch(), bob_phone_group.epoch());

        let bob_index = bob_phone_group
            .members()
            .find(|member| {
                member.credential.serialized_content()
                    == bob.credential.credential.serialized_content()
            })
            .expect("Bob device must be a group member")
            .index;
        let (remove, welcome, _) = bob_phone_group
            .remove_members(&bob_phone.provider, &bob_phone.signer, &[bob_index])
            .unwrap();
        assert!(welcome.is_none());
        merge_commit(&mut alice_group, &alice, remove.clone());
        merge_commit(&mut bob_group, &bob, remove);
        bob_phone_group
            .merge_pending_commit(&bob_phone.provider)
            .unwrap();

        assert!(!bob_group.is_active());
        assert_eq!(alice_group.members().count(), 2);
        assert_eq!(bob_phone_group.members().count(), 2);
        assert!(bob_group
            .create_message(&bob.provider, &bob.signer, b"removed device")
            .is_err());

        let encrypted =
            encrypt_application_message(&mut alice_group, &alice, b"message after device removal")
                .unwrap();
        assert_eq!(
            decrypt_application_message(&mut bob_phone_group, &bob_phone, encrypted).unwrap(),
            b"message after device removal",
        );
    }
}
