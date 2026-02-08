//! Check Pool Status Script
//! Pool'ların durumunu kontrol eder
//!
//! Usage: cargo run --bin check_pool_reserves --release

use anyhow::{Context, Result};
use miden_client::account::AccountId;
use miden_client::{
    builder::ClientBuilder,
    keystore::FilesystemKeyStore,
    rpc::{Endpoint, GrpcClient},
};
use miden_client_sqlite_store::ClientBuilderSqliteExt;
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;

const KEYSTORE_PATH: &str = "keystore";
const STORE_PATH: &str = "store.sqlite3";

type MidenClient = miden_client::Client<FilesystemKeyStore<rand::rngs::StdRng>>;

#[tokio::main]
async fn main() -> Result<()> {
    println!("🔍 Pool Kontrol\n");

    // Load pools.json
    if !PathBuf::from("pools.json").exists() {
        return Err(anyhow::anyhow!("pools.json bulunamadı!"));
    }

    let config_str = fs::read_to_string("pools.json")?;
    let config: serde_json::Value = serde_json::from_str(&config_str)?;

    let milo_pool_id_hex = config["milo_musdc_pool_id"].as_str().unwrap();
    let melo_pool_id_hex = config["melo_musdc_pool_id"].as_str().unwrap();

    println!("📄 Pool ID'leri:");
    println!("   - MILO/MUSDC: {}", milo_pool_id_hex);
    println!("   - MELO/MUSDC: {}", melo_pool_id_hex);
    println!();
    println!("🔗 Explorer Linkleri:");
    println!("   - MILO/MUSDC: https://testnet.midenscan.com/account/{}", milo_pool_id_hex);
    println!("   - MELO/MUSDC: https://testnet.midenscan.com/account/{}", melo_pool_id_hex);
    println!();

    // Initialize client
    let (mut client, _keystore) = init_client().await?;

    // Sync state
    println!("🔄 Sync yapılıyor...");
    client.sync_state().await?;
    println!("   ✅ Sync tamamlandı\n");

    // Check MILO/MUSDC pool
    let milo_pool_id = AccountId::from_hex(milo_pool_id_hex)?;
    check_pool(&mut client, milo_pool_id, "MILO/MUSDC").await?;

    // Check MELO/MUSDC pool
    let melo_pool_id = AccountId::from_hex(melo_pool_id_hex)?;
    check_pool(&mut client, melo_pool_id, "MELO/MUSDC").await?;

    Ok(())
}

async fn init_client() -> Result<(MidenClient, FilesystemKeyStore<rand::rngs::StdRng>)> {
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

async fn check_pool(
    client: &mut MidenClient,
    pool_id: AccountId,
    pool_name: &str,
) -> Result<()> {
    println!("🔍 {} Pool kontrol ediliyor...", pool_name);

    // Try to import account first
    let import_result = client.import_account_by_id(pool_id).await;
    match import_result {
        Ok(_) => println!("   ✅ Account import edildi"),
        Err(e) => println!("   ⚠️ Import hatası: {:?}", e),
    }

    // Get account details
    match client.get_account(pool_id).await {
        Ok(Some(_account)) => {
            println!("   ✅ Account blockchain'de MEVCUT");
            println!("      ID: {}", pool_id.to_hex());
        }
        Ok(None) => {
            println!("   ❌ Account blockchain'de BULUNAMADI!");
            println!("   💡 Bu, pool'un henüz deploy edilmediğini gösterir.");
            println!("      Önce setup_milo çalıştırın.");
        }
        Err(e) => {
            println!("   ❌ Hata: {:?}", e);
        }
    }

    println!();
    Ok(())
}
