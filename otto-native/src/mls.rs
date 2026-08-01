use std::collections::HashMap;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use openmls::prelude::{
    tls_codec::Serialize, BasicCredential, Ciphersuite, CredentialWithKey, KeyPackage,
};
use openmls_basic_credential::SignatureKeyPair;
use openmls_rust_crypto::OpenMlsRustCrypto;
use openmls_traits::OpenMlsProvider;
use serde::Serialize as SerdeSerialize;

const CIPHERSUITE: Ciphersuite = Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;
const PROTOCOL: &str = "mls10-openmls-0.8";

#[derive(Debug, SerdeSerialize)]
pub struct ExportedKeyPackage {
    pub protocol: &'static str,
    pub ciphersuite: &'static str,
    pub reference: String,
    pub key_package: String,
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
}
