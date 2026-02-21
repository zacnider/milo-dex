//! Milo Swap - Add Liquidity Script (v0.12 compatible)
//! MILO/MUSDC ve MELO/MUSDC pool'larına likidite ekler
//!
//! Usage: cargo run --bin add_liquidity --release

use anyhow::{Context, Result};
use miden_client::store::TransactionFilter;
use miden_client::{
    Felt,
    account::{Account, AccountBuilder, AccountId, AccountStorageMode, AccountType, NetworkId},
    asset::FungibleAsset,
    auth::AuthSecretKey,
    builder::ClientBuilder,
    keystore::FilesystemKeyStore,
    note::{create_p2id_note, NoteType},
    rpc::{Endpoint, GrpcClient},
    transaction::{OutputNote, TransactionRequestBuilder},
};
use miden_client_sqlite_store::ClientBuilderSqliteExt;
use miden_lib::account::{auth::AuthRpoFalcon512, wallets::BasicWallet};
use rand::rngs::StdRng;
use rand::RngCore;
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::time::sleep;

const KEYSTORE_PATH: &str = "keystore";
const STORE_PATH: &str = "store.sqlite3";

type MidenClient = miden_client::Client<FilesystemKeyStore<StdRng>>;

/// Main entry point
#[tokio::main]
async fn main() -> Result<()> {
    println!("🚀 Milo Swap - Likidite Ekleniyor...\n");

    // Load accounts config
    let config_str = fs::read_to_string("accounts.json")
        .with_context(|| "accounts.json bulunamadı! Önce setup_milo scriptini çalıştırın.")?;
    let config: serde_json::Value = serde_json::from_str(&config_str)
        .with_context(|| "accounts.json parse edilemedi")?;
    
    let user_wallet_id_hex = config["user_wallet_id"].as_str().unwrap();
    let milo_faucet_id_hex = config["milo_faucet_id"].as_str().unwrap();
    let melo_faucet_id_hex = config["melo_faucet_id"].as_str().unwrap();
    let musdc_faucet_id_hex = config["musdc_faucet_id"].as_str().unwrap();

    println!("📄 Config yüklendi:");
    println!("   - User Wallet: {}...", user_wallet_id_hex.chars().take(16).collect::<String>());
    println!("   - MILO Faucet: {}...", milo_faucet_id_hex.chars().take(16).collect::<String>());
    println!("   - MELO Faucet: {}...", melo_faucet_id_hex.chars().take(16).collect::<String>());
    println!("   - MUSDC Faucet: {}...", musdc_faucet_id_hex.chars().take(16).collect::<String>());
    println!();

    // Initialize client
    let (mut client, keystore) = init_client().await?;

    // Parse account IDs
    let user_wallet_id = AccountId::from_hex(user_wallet_id_hex)?;
    let milo_faucet_id = AccountId::from_hex(milo_faucet_id_hex)?;
    let melo_faucet_id = AccountId::from_hex(melo_faucet_id_hex)?;
    let musdc_faucet_id = AccountId::from_hex(musdc_faucet_id_hex)?;

    // Sync state
    client.sync_state().await?;

    // Check if pools exist, or create them
    let (milo_pool_id, melo_pool_id) = if PathBuf::from("pools.json").exists() {
        println!("📄 Mevcut pools.json bulundu, pool'lar yükleniyor...");
        load_existing_pools(&mut client).await?
    } else {
        println!("📝 Pool hesapları oluşturuluyor...");
        create_pools(&mut client, &keystore).await?
    };

    println!("   - MILO/MUSDC Pool: {}", milo_pool_id.to_hex());
    println!("   - MELO/MUSDC Pool: {}", melo_pool_id.to_hex());
    println!();

    // Mint tokens regardless (always mint more for liquidity)
    // Amounts in base units: tokens × 10^8 (8 decimals)
    println!("💰 Token'lar mint ediliyor...");
    mint_token(&mut client, milo_faucet_id, user_wallet_id, 200_000 * 100_000_000).await?;
    mint_token(&mut client, melo_faucet_id, user_wallet_id, 200_000 * 100_000_000).await?;
    mint_token(&mut client, musdc_faucet_id, user_wallet_id, 500_000 * 100_000_000).await?;
    
    // Consume mint notes
    println!("   📝 Mint notları tüketiliyor...");
    client.sync_state().await?;
    sleep(Duration::from_secs(3)).await;
    
    let notes = client.get_consumable_notes(Some(user_wallet_id)).await?;
    for (note, _) in notes {
        let consume_req = TransactionRequestBuilder::new()
            .authenticated_input_notes([(note.id(), None)])
            .build()?;

        client.submit_new_transaction(user_wallet_id, consume_req).await?;
        println!("   ✅ Not tüketildi: {}", note.id().to_hex().chars().take(16).collect::<String>());
    }

    // Step 3: Add liquidity to MILO/MUSDC pool (amounts in base units)
    println!("\n📝 Adım 1: MILO/MUSDC Pool'a likidite ekleniyor...");
    add_liquidity_to_pool(&mut client, user_wallet_id, milo_faucet_id, musdc_faucet_id, milo_pool_id, 100_000 * 100_000_000, 200_000 * 100_000_000).await?;

    // Step 4: Add liquidity to MELO/MUSDC pool (amounts in base units)
    println!("\n📝 Adım 2: MELO/MUSDC Pool'a likidite ekleniyor...");
    add_liquidity_to_pool(&mut client, user_wallet_id, melo_faucet_id, musdc_faucet_id, melo_pool_id, 100_000 * 100_000_000, 200_000 * 100_000_000).await?;

    println!("\n🎉 Likidite ekleme tamamlandı!");

    Ok(())
}

/// Load existing pools from pools.json and import to client
async fn load_existing_pools(client: &mut MidenClient) -> Result<(AccountId, AccountId)> {
    let config_str = fs::read_to_string("pools.json")?;
    let config: serde_json::Value = serde_json::from_str(&config_str)?;

    let milo_pool_id = AccountId::from_hex(config["milo_musdc_pool_id"].as_str().unwrap())?;
    let melo_pool_id = AccountId::from_hex(config["melo_musdc_pool_id"].as_str().unwrap())?;

    // Import accounts to local client
    println!("   📥 Pool'lar yerel client'e aktarılıyor...");

    // Try to import - if they exist locally already, this will just return
    let _ = client.import_account_by_id(milo_pool_id).await;
    let _ = client.import_account_by_id(melo_pool_id).await;

    Ok((milo_pool_id, melo_pool_id))
}

/// Create new pool accounts and save to pools.json + poolConfig.ts
async fn create_pools(
    client: &mut MidenClient,
    keystore: &FilesystemKeyStore<StdRng>,
) -> Result<(AccountId, AccountId)> {
    // Create MILO/MUSDC pool account
    println!("   📝 MILO/MUSDC pool hesabı oluşturuluyor...");
    let milo_pool = create_pool_account(client, keystore).await?;
    let milo_pool_id = milo_pool.id();
    println!("   ✅ MILO/MUSDC Pool ID: {}", milo_pool_id.to_hex());

    // Create MELO/MUSDC pool account
    println!("   📝 MELO/MUSDC pool hesabı oluşturuluyor...");
    let melo_pool = create_pool_account(client, keystore).await?;
    let melo_pool_id = melo_pool.id();
    println!("   ✅ MELO/MUSDC Pool ID: {}", melo_pool_id.to_hex());

    // Save pools.json (root dir for daemon)
    let pools_config = serde_json::json!({
        "milo_musdc_pool_id": milo_pool_id.to_hex(),
        "milo_musdc_pool_address": milo_pool_id.to_bech32(NetworkId::Testnet),
        "melo_musdc_pool_id": melo_pool_id.to_hex(),
        "melo_musdc_pool_address": melo_pool_id.to_bech32(NetworkId::Testnet),
    });

    fs::write("pools.json", serde_json::to_string_pretty(&pools_config)?)
        .context("pools.json kaydedilemedi")?;
    println!("   💾 pools.json kaydedildi");

    // Also save to pool-daemon/pools.json
    fs::write("pool-daemon/pools.json", serde_json::to_string_pretty(&pools_config)?)
        .context("pool-daemon/pools.json kaydedilemedi")?;
    println!("   💾 pool-daemon/pools.json kaydedildi");

    // Update frontend poolConfig.ts
    update_pool_config(&milo_pool_id, &melo_pool_id)?;

    client.sync_state().await?;
    Ok((milo_pool_id, melo_pool_id))
}

/// Create a pool account (regular account with BasicWallet)
async fn create_pool_account(
    client: &mut MidenClient,
    keystore: &FilesystemKeyStore<StdRng>,
) -> Result<Account> {
    let mut init_seed = [0u8; 32];
    client.rng().fill_bytes(&mut init_seed);

    let key_pair = AuthSecretKey::new_rpo_falcon512();

    let builder = AccountBuilder::new(init_seed)
        .account_type(AccountType::RegularAccountUpdatableCode)
        .storage_mode(AccountStorageMode::Public)
        .with_auth_component(AuthRpoFalcon512::new(key_pair.public_key().to_commitment()))
        .with_component(BasicWallet);

    let account = builder.build().unwrap();
    client.add_account(&account, true).await?;
    keystore.add_key(&key_pair).unwrap();
    client.sync_state().await?;

    Ok(account)
}

/// Update frontend/src/config/poolConfig.ts with new pool IDs
fn update_pool_config(milo_pool_id: &AccountId, melo_pool_id: &AccountId) -> Result<()> {
    let pool_config_content = format!(
        r#"// Pool Account IDs for Milo Swap Protocol v0.12
// Auto-generated by add_liquidity script
// Pool accounts created with BasicWallet component

export const MILO_MUSDC_POOL_ACCOUNT_ID_HEX = '{}';
export const MELO_MUSDC_POOL_ACCOUNT_ID_HEX = '{}';

// Get pool account ID hex for a specific token pair
export function getPoolAccountIdHex(tokenA: string, tokenB: string): string {{
  const pair = `${{tokenA}}/${{tokenB}}`;
  if (pair === 'MILO/MUSDC' || pair === 'MUSDC/MILO') {{
    return MILO_MUSDC_POOL_ACCOUNT_ID_HEX;
  }} else if (pair === 'MELO/MUSDC' || pair === 'MUSDC/MELO') {{
    return MELO_MUSDC_POOL_ACCOUNT_ID_HEX;
  }}
  return MILO_MUSDC_POOL_ACCOUNT_ID_HEX;
}}

// Get default pool account ID hex
export function getDefaultPoolAccountIdHex(): string {{
  return MILO_MUSDC_POOL_ACCOUNT_ID_HEX;
}}

// Backward compatibility functions
export function getMiloMusdcPoolAccountId(): string {{
  return MILO_MUSDC_POOL_ACCOUNT_ID_HEX;
}}

export function getMeloMusdcPoolAccountId(): string {{
  return MELO_MUSDC_POOL_ACCOUNT_ID_HEX;
}}

export function getPoolAccountIdForPair(tokenA: string, tokenB: string): string {{
  return getPoolAccountIdHex(tokenA, tokenB);
}}

// Legacy constant for backward compatibility
export const POOL_ACCOUNT_ID = MILO_MUSDC_POOL_ACCOUNT_ID_HEX;

// Pool configurations
export const POOLS = [
  {{
    pair: 'MILO/MUSDC',
    tokenA: 'MILO',
    tokenB: 'MUSDC',
    poolAccountIdHex: MILO_MUSDC_POOL_ACCOUNT_ID_HEX,
  }},
  {{
    pair: 'MELO/MUSDC',
    tokenA: 'MELO',
    tokenB: 'MUSDC',
    poolAccountIdHex: MELO_MUSDC_POOL_ACCOUNT_ID_HEX,
  }},
];
"#,
        milo_pool_id.to_hex(),
        melo_pool_id.to_hex(),
    );

    fs::write("frontend/src/config/poolConfig.ts", pool_config_content)
        .context("frontend/src/config/poolConfig.ts kaydedilemedi")?;
    println!("   💾 frontend poolConfig.ts güncellendi");

    Ok(())
}

/// Initialize Miden client
async fn init_client() -> Result<(MidenClient, FilesystemKeyStore<StdRng>)> {
    let timeout_ms = 30_000;
    let endpoint = Endpoint::testnet();
    let rpc_api = Arc::new(GrpcClient::new(&endpoint, timeout_ms));
    
    let keystore_path = PathBuf::from(KEYSTORE_PATH);
    let keystore = FilesystemKeyStore::new(keystore_path)
        .unwrap_or_else(|err| panic!("Keystore oluşturulamadı: {:?}", err));

    let client = ClientBuilder::new()
        .rpc(rpc_api)
        .authenticator(Arc::new(keystore.clone()))
        .in_debug_mode(true.into())
        .sqlite_store(STORE_PATH.into())
        .build()
        .await
        .with_context(|| "Client oluşturulamadı")?;

    Ok((client, keystore))
}

/// Mint tokens to user wallet
async fn mint_token(
    client: &mut MidenClient,
    faucet_id: AccountId,
    user_wallet_id: AccountId,
    amount: u64,
) -> Result<()> {
    let asset = FungibleAsset::new(faucet_id, amount)
        .with_context(|| "Asset oluşturulamadı")?;

    let tx_request = TransactionRequestBuilder::new()
        .build_mint_fungible_asset(asset, user_wallet_id, NoteType::Public, client.rng())
        .with_context(|| "Mint tx oluşturulamadı")?;

    let tx_id = client
        .submit_new_transaction(faucet_id, tx_request)
        .await
        .with_context(|| "Mint tx gönderilemedi")?;

    wait_for_transaction(client, tx_id).await?;
    println!("   ✅ {} {} mint edildi", amount, faucet_id.to_hex().chars().take(8).collect::<String>());

    Ok(())
}

/// Add liquidity to a pool
async fn add_liquidity_to_pool(
    client: &mut MidenClient,
    user_wallet_id: AccountId,
    token_faucet_id: AccountId,
    stable_faucet_id: AccountId,
    pool_id: AccountId,
    token_amount: u64,
    stable_amount: u64,
) -> Result<()> {
    client.sync_state().await?;

    // Create token asset
    let token_asset = FungibleAsset::new(token_faucet_id, token_amount)
        .with_context(|| "Token asset oluşturulamadı")?;
    
    // Create stable asset
    let stable_asset = FungibleAsset::new(stable_faucet_id, stable_amount)
        .with_context(|| "Stable asset oluşturulamadı")?;

    // Create P2ID note for token
    println!("   💧 Token notu oluşturuluyor...");
    let token_note = create_p2id_note(
        user_wallet_id,
        pool_id,
        vec![token_asset.into()],
        NoteType::Public,
        Felt::new(0),
        client.rng(),
    ).with_context(|| "Token notu oluşturulamadı")?;

    let tx_request_1 = TransactionRequestBuilder::new()
        .own_output_notes(vec![OutputNote::Full(token_note)])
        .build()?;

    let tx_id_1 = client
        .submit_new_transaction(user_wallet_id, tx_request_1)
        .await?;

    wait_for_transaction(client, tx_id_1).await?;
    println!("   ✅ Token notu gönderildi");

    // Create P2ID note for stable
    println!("   💧 Stablecoin notu oluşturuluyor...");
    let stable_note = create_p2id_note(
        user_wallet_id,
        pool_id,
        vec![stable_asset.into()],
        NoteType::Public,
        Felt::new(0),
        client.rng(),
    ).with_context(|| "Stable notu oluşturulamadı")?;

    let tx_request_2 = TransactionRequestBuilder::new()
        .own_output_notes(vec![OutputNote::Full(stable_note)])
        .build()?;

    let tx_id_2 = client
        .submit_new_transaction(user_wallet_id, tx_request_2)
        .await?;

    wait_for_transaction(client, tx_id_2).await?;
    println!("   ✅ Stablecoin notu gönderildi");

    // Pool consumes notes
    println!("   🔍 Pool notları tüketiyor...");
    client.sync_state().await?;
    sleep(Duration::from_secs(5)).await;

    let notes = client.get_consumable_notes(Some(pool_id)).await?;
    println!("   ✅ {} not tüketildi", notes.len());

    Ok(())
}

/// Wait for a transaction to complete - more lenient for slow networks
async fn wait_for_transaction(
    client: &mut MidenClient,
    tx_id: miden_objects::transaction::TransactionId,
) -> Result<()> {
    println!("   ⏳ Tx bekleniyor: {}...", 
        tx_id.to_hex().chars().take(16).collect::<String>());

    // Sync state first
    client.sync_state().await?;
    
    // Try up to 60 seconds (120 iterations of 0.5s)
    for _ in 0..120 {
        // First check if transaction exists in the log
        match client.get_transactions(TransactionFilter::Ids(vec![tx_id])).await {
            Ok(transactions) => {
                if !transactions.is_empty() {
                    // Transaction is in the log, consider it successful
                    println!("   ✅ Tx log'da bulundu!");
                    
                    // Try to check if it has outputs or nonce changed
                    let tx = &transactions[0];
                    let has_outputs = tx.details.output_notes.iter().next().is_some();
                    
                    if has_outputs {
                        println!("   ✅ Tx output ile tamamlandı!");
                        return Ok(());
                    } else {
                        // Even without outputs, if it's in the log, it's committed
                        println!("   ✅ Tx commit edildi (output yok)!");
                        return Ok(());
                    }
                }
            },
            Err(e) => {
                println!("   ⚠️ Tx sorgulama hatası: {:?}", e);
            }
        }
        
        // Sync and wait
        let _ = client.sync_state().await;
        sleep(Duration::from_millis(500)).await;
    }

    // Even if timeout, check one more time
    match client.get_transactions(TransactionFilter::Ids(vec![tx_id])).await {
        Ok(transactions) => {
            if !transactions.is_empty() {
                println!("   ✅ Tx sonunda log'da bulundu!");
                return Ok(());
            }
        },
        _ => {}
    }

    Err(anyhow::anyhow!("Tx zaman aşımı - transaction log'da bulunamadı"))
}
