//! Milo Swap Protocol - Complete Setup Script (v0.12 compatible)
//! MILO, MELO, MUSDC faucet'leri ve MILO/MUSDC, MELO/MUSDC pool'ları oluşturur
//!
//! Usage: cargo run --bin setup_milo --release

use anyhow::{Context, Result};
use miden_client::store::TransactionFilter;
use miden_client::{
    Felt,
    account::{
        Account, AccountBuilder, AccountStorageMode, AccountType, NetworkId,
    },
    asset::{FungibleAsset, TokenSymbol},
    auth::AuthSecretKey,
    builder::ClientBuilder,
    keystore::FilesystemKeyStore,
    rpc::{Endpoint, GrpcClient},
    transaction::{OutputNote, TransactionRequestBuilder},
    note::NoteType,
};
use miden_client_sqlite_store::ClientBuilderSqliteExt;
use miden_lib::account::{auth::AuthRpoFalcon512, faucets::BasicFungibleFaucet, wallets::BasicWallet};
use rand::RngCore;
use rand::rngs::StdRng;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tokio::time::sleep;

const RPC_HOST: &str = "rpc.testnet.miden.io";
const RPC_PORT: u16 = 443;
const KEYSTORE_PATH: &str = "keystore";
const STORE_PATH: &str = "store.sqlite3";
const KEYS_DIR: &str = "keys";

type MidenClient = miden_client::Client<FilesystemKeyStore<StdRng>>;

/// Main entry point
#[tokio::main]
async fn main() -> Result<()> {
    println!("🚀 Milo Swap Protocol - Setup Başlıyor...\n");

    // Clean up old files
    cleanup_old_files()?;

    // Initialize client
    let (mut client, keystore) = init_client().await?;

    // Step 1: Create user wallet
    println!("📝 Adım 1: User Wallet oluşturuluyor...");
    let (user_wallet, _user_key) = create_basic_account(&mut client, &keystore).await?;
    println!("   ✅ User Wallet ID: {}", user_wallet.id().to_hex());
    println!("   📍 Address: {}\n", user_wallet.id().to_bech32(NetworkId::Testnet));

    // Step 2: Create MILO faucet (max 10 billion tokens, 8 decimals → 10^18 raw)
    println!("📝 Adım 2: MILO Faucet oluşturuluyor...");
    let milo_faucet = create_token_faucet(&mut client, &keystore, "MILO", 1_000_000_000_000_000_000).await?;
    println!("   ✅ MILO Faucet ID: {}\n", milo_faucet.id().to_hex());

    // Step 3: Create MELO faucet (max 10 billion tokens)
    println!("📝 Adım 3: MELO Faucet oluşturuluyor...");
    let melo_faucet = create_token_faucet(&mut client, &keystore, "MELO", 1_000_000_000_000_000_000).await?;
    println!("   ✅ MELO Faucet ID: {}\n", melo_faucet.id().to_hex());

    // Step 4: Create MUSDC faucet (max 10 billion tokens)
    println!("📝 Adım 4: MUSDC Faucet oluşturuluyor...");
    let musdc_faucet = create_token_faucet(&mut client, &keystore, "MUSDC", 1_000_000_000_000_000_000).await?;
    println!("   ✅ MUSDC Faucet ID: {}\n", musdc_faucet.id().to_hex());

    // Step 5: Mint tokens to user wallet
    println!("📝 Adım 5: Token'lar Mint Ediliyor...");
    mint_tokens(&mut client, &user_wallet, &milo_faucet, &melo_faucet, &musdc_faucet).await?;
    println!();

    // Save accounts config
    save_accounts_config(&user_wallet, &milo_faucet, &melo_faucet, &musdc_faucet)?;

    println!("🎉 Setup Tamamlandı!");
    println!("\n📁 Oluşturulan Dosyalar:");
    println!("   - {} (keystore)", KEYSTORE_PATH);
    println!("   - {} (database)", STORE_PATH);
    println!("   - accounts.json (hesap ID'leri)");
    println!("   - keys/ (key yedekleri)");
    println!("\n📝 Sonraki Adımlar:");
    println!("   1. Pool contract'larını derle ve dağıt");
    println!("   2. Likidite eklemek için add_liquidity scriptini çalıştır");
    println!("   3. Swap işlemleri için swap scriptini kullan");

    Ok(())
}

/// Clean up old files
fn cleanup_old_files() -> Result<()> {
    // Store silmiyoruz - mevcut hesapları koruyoruz!
    // Sadece WAL/SHM dosyalarını temizleyelim
    if let Some(db_path) = STORE_PATH.strip_suffix(".sqlite3") {
        if Path::new(&format!("{}-wal", db_path)).exists() {
            fs::remove_file(format!("{}-wal", db_path))?;
        }
        if Path::new(&format!("{}-shm", db_path)).exists() {
            fs::remove_file(format!("{}-shm", db_path))?;
        }
    }

    if !Path::new(KEYS_DIR).exists() {
        fs::create_dir_all(KEYS_DIR)?;
        println!("   📁 {} klasörü oluşturuldu", KEYS_DIR);
    }

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
        .context("Client oluşturulamadı")?;

    Ok((client, keystore))
}

/// Creates a basic regular account
pub async fn create_basic_account(
    client: &mut MidenClient,
    keystore: &FilesystemKeyStore<StdRng>,
) -> Result<(Account, AuthSecretKey), miden_client::ClientError> {
    let mut init_seed = [0_u8; 32];
    client.rng().fill_bytes(&mut init_seed);
    
    let key_pair = AuthSecretKey::new_rpo_falcon512();
    
    let builder = AccountBuilder::new(init_seed)
        .account_type(AccountType::RegularAccountUpdatableCode)
        .storage_mode(AccountStorageMode::Public)
        .with_auth_component(AuthRpoFalcon512::new(key_pair.public_key().to_commitment()))
        .with_component(BasicWallet);
    
    let account = builder.build().unwrap();
    // true = blockchain'e commit et, false = sadece local kaydet
    client.add_account(&account, true).await?;
    
    keystore.add_key(&key_pair).unwrap();
    
    client.sync_state().await?;
    Ok((account, key_pair))
}

/// Creates a fungible token faucet
pub async fn create_token_faucet(
    client: &mut MidenClient,
    keystore: &FilesystemKeyStore<StdRng>,
    symbol: &str,
    max_supply: u64,
) -> Result<Account, miden_client::ClientError> {
    let mut init_seed = [0u8; 32];
    client.rng().fill_bytes(&mut init_seed);
    
    let key_pair = AuthSecretKey::new_rpo_falcon512();
    let token_symbol = TokenSymbol::new(symbol)
        .unwrap_or_else(|err| panic!("{} token symbol oluşturulamadı: {:?}", symbol, err));
    let max_supply_felt = Felt::new(max_supply);

    let builder = AccountBuilder::new(init_seed)
        .account_type(AccountType::FungibleFaucet)
        .storage_mode(AccountStorageMode::Public)
        .with_auth_component(AuthRpoFalcon512::new(key_pair.public_key().to_commitment()))
        .with_component(BasicFungibleFaucet::new(token_symbol, 8, max_supply_felt).unwrap());
    
    let account = builder.build().unwrap();
    // true = blockchain'e commit et, false = sadece local kaydet
    client.add_account(&account, true).await?;
    
    keystore.add_key(&key_pair).unwrap();
    
    client.sync_state().await?;
    Ok(account)
}

/// Mint tokens to user wallet
async fn mint_tokens(
    client: &mut MidenClient,
    user_wallet: &Account,
    milo_faucet: &Account,
    melo_faucet: &Account,
    musdc_faucet: &Account,
) -> Result<()> {
    client.sync_state().await?;

    // Mint MILO (500,000 tokens × 10^8 decimals = 50 trillion raw units)
    println!("   💰 500,000 MILO mint ediliyor...");
    let milo_amount = 500_000u64 * 100_000_000; // 500K tokens in base units
    let milo_asset = FungibleAsset::new(milo_faucet.id(), milo_amount)
        .context("MILO asset oluşturulamadı")?;

    let tx_request = TransactionRequestBuilder::new()
        .build_mint_fungible_asset(milo_asset, user_wallet.id(), NoteType::Public, client.rng())
        .context("MILO Mint tx oluşturulamadı")?;

    let tx_id = client
        .submit_new_transaction(milo_faucet.id(), tx_request)
        .await
        .context("MILO Mint tx gönderilemedi")?;

    wait_for_transaction(client, tx_id).await?;
    println!("   ✅ 500,000 MILO mint edildi");

    // Mint MELO (500,000 tokens × 10^8 decimals)
    println!("   💰 500,000 MELO mint ediliyor...");
    let melo_amount = 500_000u64 * 100_000_000; // 500K tokens in base units
    let melo_asset = FungibleAsset::new(melo_faucet.id(), melo_amount)
        .context("MELO asset oluşturulamadı")?;

    let tx_request = TransactionRequestBuilder::new()
        .build_mint_fungible_asset(melo_asset, user_wallet.id(), NoteType::Public, client.rng())
        .context("MELO Mint tx oluşturulamadı")?;

    let tx_id = client
        .submit_new_transaction(melo_faucet.id(), tx_request)
        .await
        .context("MELO Mint tx gönderilemedi")?;

    wait_for_transaction(client, tx_id).await?;
    println!("   ✅ 500,000 MELO mint edildi");

    // Mint MUSDC (1,000,000 tokens × 10^8 decimals)
    println!("   💰 1,000,000 MUSDC mint ediliyor...");
    let musdc_amount = 1_000_000u64 * 100_000_000; // 1M tokens in base units
    let musdc_asset = FungibleAsset::new(musdc_faucet.id(), musdc_amount)
        .context("MUSDC asset oluşturulamadı")?;

    let tx_request = TransactionRequestBuilder::new()
        .build_mint_fungible_asset(musdc_asset, user_wallet.id(), NoteType::Public, client.rng())
        .context("MUSDC Mint tx oluşturulamadı")?;

    let tx_id = client
        .submit_new_transaction(musdc_faucet.id(), tx_request)
        .await
        .context("MUSDC Mint tx gönderilemedi")?;

    wait_for_transaction(client, tx_id).await?;
    println!("   ✅ 1,000,000 MUSDC mint edildi");

    // Sync and consume notes
    client.sync_state().await?;
    sleep(Duration::from_secs(3)).await;

    let notes = client.get_consumable_notes(Some(user_wallet.id())).await?;
    println!("   📝 {} not bulundu, tüketiliyor...", notes.len());

    for (note, _) in notes {
        let consume_req = TransactionRequestBuilder::new()
            .authenticated_input_notes([(note.id(), None)])
            .build()?;

        client.submit_new_transaction(user_wallet.id(), consume_req).await?;
        println!("   ✅ Not tüketildi: {}", note.id().to_hex().chars().take(16).collect::<String>());
    }

    Ok(())
}

/// Wait for a transaction to complete
async fn wait_for_transaction(
    client: &mut MidenClient,
    tx_id: miden_objects::transaction::TransactionId,
) -> Result<()> {
    println!("   ⏳ Tx bekleniyor: {}...", 
        tx_id.to_hex().chars().take(16).collect::<String>());

    for _ in 0..30 {
        let transactions = client.get_transactions(TransactionFilter::Ids(vec![tx_id])).await?;

        if !transactions.is_empty() {
            let tx = &transactions[0];
            let has_outputs = tx.details.output_notes.iter().next().is_some();
            if has_outputs {
                println!("   ✅ Tx tamamlandı!");
                return Ok(());
            }
        }

        sleep(Duration::from_secs(2)).await;
    }

    Err(anyhow::anyhow!("Tx zaman aşımı"))
}

/// Save accounts config to JSON
fn save_accounts_config(
    user_wallet: &Account,
    milo_faucet: &Account,
    melo_faucet: &Account,
    musdc_faucet: &Account,
) -> Result<()> {
    #[derive(serde::Serialize)]
    struct Config {
        user_wallet_id: String,
        user_wallet_address: String,
        milo_faucet_id: String,
        milo_faucet_address: String,
        melo_faucet_id: String,
        melo_faucet_address: String,
        musdc_faucet_id: String,
        musdc_faucet_address: String,
    }

    let config = Config {
        user_wallet_id: user_wallet.id().to_hex(),
        user_wallet_address: user_wallet.id().to_bech32(NetworkId::Testnet),
        milo_faucet_id: milo_faucet.id().to_hex(),
        milo_faucet_address: milo_faucet.id().to_bech32(NetworkId::Testnet),
        melo_faucet_id: melo_faucet.id().to_hex(),
        melo_faucet_address: melo_faucet.id().to_bech32(NetworkId::Testnet),
        musdc_faucet_id: musdc_faucet.id().to_hex(),
        musdc_faucet_address: musdc_faucet.id().to_bech32(NetworkId::Testnet),
    };

    let config_data = serde_json::to_string_pretty(&config)
        .context("Config serileştirilemedi")?;

    fs::write("accounts.json", config_data)
        .context("Config kaydedilemedi")?;

    println!("   💾 Hesap config kaydedildi: accounts.json");

    // Also update faucet-server/src/faucet_ids.rs
    update_faucet_server_ids(milo_faucet.id().to_hex(), melo_faucet.id().to_hex(), musdc_faucet.id().to_hex())?;

    // Also update frontend/src/tokenRegistry.ts
    update_frontend_registry(user_wallet.id().to_hex(), user_wallet.id().to_bech32(NetworkId::Testnet), milo_faucet.id().to_hex(), melo_faucet.id().to_hex(), musdc_faucet.id().to_hex())?;

    Ok(())
}

/// Update faucet-server/src/faucet_ids.rs
fn update_faucet_server_ids(milo_id: String, melo_id: String, musdc_id: String) -> Result<()> {
    let faucet_ids_content = format!(
        r#"//! Auto-generated faucet IDs - DO NOT EDIT MANUALLY
//! Bu dosya setup_milo scripti çalıştırıldığında güncellenir

pub const MILO_FAUCET_ID: &str = "{}";
pub const MELO_FAUCET_ID: &str = "{}";
pub const MUSDC_FAUCET_ID: &str = "{}";
"#,
        milo_id, melo_id, musdc_id
    );

    fs::write("faucet-server/src/faucet_ids.rs", faucet_ids_content)
        .context("faucet-server/src/faucet_ids.rs kaydedilemedi")?;

    println!("   💾 Faucet IDs güncellendi: faucet-server/src/faucet_ids.rs");
    Ok(())
}

/// Update frontend/src/tokenRegistry.ts
fn update_frontend_registry(user_wallet_id: String, user_wallet_address: String, milo_id: String, melo_id: String, musdc_id: String) -> Result<()> {
    let registry_content = format!(
        r#"// Auto-generated token registry - Updated with real faucet IDs
// Generated from setup_milo execution
import {{ FAUCET_URL }} from './config/api';

export interface TokenInfo {{
  symbol: string;
  name: string;
  faucetId: string;
  decimals: number;
  logo: string;
  color: string;
  faucetApiUrl?: string;
  legacyFaucetIds?: string[];
}}

export const CONFIG: {{ apiUrl: string; faucetServerUrl: string; userWalletId: string; userWalletAddress: string; tokens: Record<string, TokenInfo> }} = {{
  apiUrl: FAUCET_URL,
  faucetServerUrl: FAUCET_URL,
  userWalletId: '{}',
  userWalletAddress: '{}',
  tokens: {{
    MILO: {{
      symbol: 'MILO',
      name: 'Milo Token',
      faucetId: '{}',
      decimals: 8,
      logo: '/tokens/milo.svg',
      color: '#6366f1',
      faucetApiUrl: FAUCET_URL,
    }},
    MELO: {{
      symbol: 'MELO',
      name: 'Melo Token',
      faucetId: '{}',
      decimals: 8,
      logo: '/tokens/melo.svg',
      color: '#10b981',
      faucetApiUrl: FAUCET_URL,
    }},
    MUSDC: {{
      symbol: 'MUSDC',
      name: 'Milo USDC',
      faucetId: '{}',
      decimals: 8,
      logo: '/tokens/usdc.svg',
      color: '#2563eb',
      faucetApiUrl: FAUCET_URL,
    }},
    MIDEN: {{
      symbol: 'MIDEN',
      name: 'Miden Network',
      faucetId: '0x54bf4e12ef20082070758b022456c7',
      decimals: 6,
      logo: '/tokens/miden.svg',
      color: '#ff6b35',
    }},
  }},
}};

export const TOKEN_LIST = Object.values(CONFIG.tokens);
export const TOKEN_SYMBOLS = TOKEN_LIST.map((t) => t.symbol);

// Helper function to get token metadata by faucet ID
export function getTokenMetadata(faucetId: string): {{ symbol: string; decimals: number }} | undefined {{
  const normalizedFaucetId = faucetId.toLowerCase().replace(/^0x/, '');
  for (const token of TOKEN_LIST) {{
    const tokenFaucetId = token.faucetId.toLowerCase().replace(/^0x/, '');
    if (tokenFaucetId === normalizedFaucetId) {{
      return {{ symbol: token.symbol, decimals: token.decimals }};
    }}
  }}
  return undefined;
}}

// Helper function to get token by symbol
export function getTokenBySymbol(symbol: string) {{
  const upperSymbol = symbol.toUpperCase();
  return TOKEN_LIST.find(t => t.symbol.toUpperCase() === upperSymbol);
}}
"#,
        user_wallet_id, user_wallet_address, milo_id, melo_id, musdc_id
    );

    fs::write("frontend/src/tokenRegistry.ts", registry_content)
        .context("frontend/src/tokenRegistry.ts kaydedilemedi")?;

    println!("   💾 Frontend registry güncellendi: frontend/src/tokenRegistry.ts");
    Ok(())
}
