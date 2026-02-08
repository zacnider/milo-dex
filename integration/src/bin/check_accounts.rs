//! Check accounts script
//! Usage: cargo run --bin check_accounts --release

use anyhow::Result;
use miden_client::{
    account::AccountId,
    builder::ClientBuilder,
    keystore::FilesystemKeyStore,
    rpc::{Endpoint, GrpcClient},
};
use miden_client_sqlite_store::ClientBuilderSqliteExt;
use std::path::PathBuf;
use std::sync::Arc;

const KEYSTORE_PATH: &str = "keystore";
const STORE_PATH: &str = "store.sqlite3";

#[tokio::main]
async fn main() -> Result<()> {
    println!("🔍 Hesap kontrolü...\n");

    let timeout_ms = 30_000;
    let endpoint = Endpoint::testnet();
    let rpc_api = Arc::new(GrpcClient::new(&endpoint, timeout_ms));
    
    let keystore_path = PathBuf::from(KEYSTORE_PATH);
    let keystore = FilesystemKeyStore::new(keystore_path)?;

    let mut client = ClientBuilder::new()
        .rpc(rpc_api)
        .authenticator(Arc::new(keystore))
        .sqlite_store(STORE_PATH.into())
        .build()
        .await?;

    // Sync state
    println!("📡 State syncing...");
    client.sync_state().await?;
    println!("✅ Sync complete\n");

    // Check faucet accounts
    let faucets = vec![
        ("MILO", "0x01016c766df0b1207e0ed0ccdb6c77"),
        ("MELO", "0x953049b046bac52006d483fc75fa11"),
        ("MUSDC", "0xd64d825568d8ad202d8b59354cd603"),
    ];

    println!("📝 Faucet Hesapları:");
    for (name, id_hex) in &faucets {
        match AccountId::from_hex(id_hex) {
            Ok(id) => {
                match client.get_account(id).await {
                    Ok(account_record) => {
                        println!("   ✅ {}: {} - Mevcut", name, id.to_hex().chars().take(16).collect::<String>());
                        if let Some(account) = account_record {
                            println!("       Type: {:?}", account.account().account_type());
                        }
                    }
                    Err(e) => {
                        println!("   ❌ {}: {} - Bulunamadı: {}", name, id_hex, e);
                    }
                }
            }
            Err(e) => {
                println!("   ❌ {}: {} - Geçersiz ID: {}", name, id_hex, e);
            }
        }
    }

    // Check pool accounts
    let pools = vec![
        ("MILO/MUSDC", "0x84cd2c06de64a1100f23b32135925f"),
        ("MELO/MUSDC", "0x15ba39fa910dfd1053896fc2131b16"),
    ];

    println!("\n📝 Pool Hesapları:");
    for (name, id_hex) in &pools {
        match AccountId::from_hex(id_hex) {
            Ok(id) => {
                match client.get_account(id).await {
                    Ok(account_record) => {
                        println!("   ✅ {}: {} - Mevcut", name, id.to_hex().chars().take(16).collect::<String>());
                        if let Some(account) = account_record {
                            println!("       Type: {:?}", account.account().account_type());
                        }
                    }
                    Err(e) => {
                        println!("   ❌ {}: {} - Bulunamadı: {}", name, id_hex, e);
                    }
                }
            }
            Err(e) => {
                println!("   ❌ {}: {} - Geçersiz ID: {}", name, id_hex, e);
            }
        }
    }

    Ok(())
}
