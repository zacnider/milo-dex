//! Common helper functions for Milo swap protocol scripts

use std::sync::Arc;

use anyhow::{Context, Result};
use miden_client::{
    account::{
        component::{AuthRpoFalcon512, BasicWallet},
        Account, AccountStorageMode, AccountType,
    },
    auth::{AuthSecretKey, PublicKeyCommitment},
    builder::ClientBuilder,
    crypto::rpo_falcon512::SecretKey,
    keystore::FilesystemKeyStore,
    rpc::{Endpoint, GrpcClient},
    Client,
    transaction::TransactionRequestBuilder,
};
use miden_client_sqlite_store::ClientBuilderSqliteExt;
use miden_objects::account::AccountBuilder;
use rand::rngs::StdRng;

/// Test setup configuration containing initialized client and keystore
pub struct ClientSetup {
    pub client: Client<FilesystemKeyStore<StdRng>>,
    pub keystore: Arc<FilesystemKeyStore<StdRng>>,
}

/// Initializes test infrastructure with client and keystore
pub async fn setup_client() -> Result<ClientSetup> {
    // Initialize RPC connection to testnet
    // Using official Miden Testnet RPC
    let endpoint = Endpoint::testnet();
    let timeout_ms = 300_000; // Increased timeout to 300 seconds (5 minutes)
    let rpc_client = Arc::new(GrpcClient::new(&endpoint, timeout_ms));

    // Initialize keystore - use main project keystore (absolute path)
    let keystore_path = std::path::PathBuf::from("/Users/nihataltuntas/Desktop/projeler/milo/milo-swap/keystore");
    let keystore = Arc::new(
        FilesystemKeyStore::<StdRng>::new(keystore_path)
            .context("Failed to initialize keystore")?,
    );

    let store_path = std::path::PathBuf::from("./store.sqlite3");

    let client = ClientBuilder::new()
        .rpc(rpc_client)
        .sqlite_store(store_path)
        .authenticator(keystore.clone())
        .in_debug_mode(true.into())
        .build()
        .await
        .context("Failed to build Miden client")?;

    Ok(ClientSetup { client, keystore })
}

/// Creates a basic wallet account with authentication
/// Returns the account and optionally the seed phrase (if export_seed is true)
pub async fn create_basic_wallet_account(
    client: &mut Client<FilesystemKeyStore<StdRng>>,
    keystore: Arc<FilesystemKeyStore<StdRng>>,
) -> Result<Account> {
    create_basic_wallet_account_with_seed(client, keystore, false).await.map(|(acc, _)| acc)
}

/// Creates a basic wallet account with authentication and optionally exports seed phrase
/// Returns (account, seed_phrase_option)
pub async fn create_basic_wallet_account_with_seed(
    client: &mut Client<FilesystemKeyStore<StdRng>>,
    keystore: Arc<FilesystemKeyStore<StdRng>>,
    export_seed: bool,
) -> Result<(Account, Option<String>)> {
    // Generate 12-word BIP39 mnemonic (16 bytes entropy = 128 bits = 12 words)
    // This matches Miden wallet extension standard
    let mut entropy = [0_u8; 16];
    rand::RngCore::fill_bytes(&mut client.rng(), &mut entropy);

    let mnemonic = bip39::Mnemonic::from_entropy(&entropy)
        .map_err(|e| anyhow::anyhow!("Failed to generate mnemonic: {}", e))?;
    
    let seed_phrase = if export_seed {
        Some(mnemonic.to_string())
    } else {
        None
    };

    // Derive 64-byte seed from mnemonic (BIP39 standard), take first 32 bytes for AccountBuilder
    let seed_bytes = mnemonic.to_seed("");
    let mut init_seed = [0_u8; 32];
    init_seed.copy_from_slice(&seed_bytes[..32]);

    let key_pair = SecretKey::with_rng(client.rng());

    let builder = AccountBuilder::new(init_seed)
        .account_type(AccountType::RegularAccountUpdatableCode)
        .storage_mode(AccountStorageMode::Public)
        .with_auth_component(AuthRpoFalcon512::new(PublicKeyCommitment::from(
            key_pair.public_key().to_commitment(),
        )))
        .with_component(BasicWallet);

    let account = builder
        .build()
        .context("Failed to build basic wallet account")?;

    client
        .add_account(&account, false)
        .await
        .context("Failed to add account to client")?;

    keystore
        .add_key(&AuthSecretKey::RpoFalcon512(key_pair))
        .context("Failed to add key to keystore")?;

    Ok((account, seed_phrase))
}

/// Deploys an account to the network so it can be fetched by other clients.
pub async fn deploy_account(
    client: &mut Client<FilesystemKeyStore<StdRng>>,
    account: &Account,
) -> Result<()> {
    // Use an empty transaction to deploy the account to the node.
    // This matches the approach used by zoroswap spawn_faucets.
    let tx_request = TransactionRequestBuilder::new()
        .build()
        .context("Failed to build deploy transaction")?;

    client
        .submit_new_transaction(account.id(), tx_request)
        .await
        .context("Failed to submit deploy transaction")?;

    Ok(())
}
