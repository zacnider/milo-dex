//! Consume Pool P2ID Notes Script
//! Pool'ların bekleyen P2ID notlarını tüketir
//!
//! Usage: cargo run --bin consume_pool_notes --release

use anyhow::{Context, Result};
use miden_client::store::TransactionFilter;
use miden_client::{
    account::AccountId,
    builder::ClientBuilder,
    keystore::FilesystemKeyStore,
    rpc::{Endpoint, GrpcClient},
    transaction::TransactionRequestBuilder,
};
use miden_client_sqlite_store::ClientBuilderSqliteExt;
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::time::sleep;

const KEYSTORE_PATH: &str = "keystore";
const STORE_PATH: &str = "store.sqlite3";

type MidenClient = miden_client::Client<FilesystemKeyStore<rand::rngs::StdRng>>;

#[tokio::main]
async fn main() -> Result<()> {
    println!("🔍 Pool Not Tüketme\n");

    // Load pools.json
    if !PathBuf::from("pools.json").exists() {
        return Err(anyhow::anyhow!("pools.json bulunamadı!"));
    }

    let config_str = fs::read_to_string("pools.json")?;
    let config: serde_json::Value = serde_json::from_str(&config_str)?;

    let milo_pool_id_hex = config["milo_musdc_pool_id"].as_str().unwrap();
    let melo_pool_id_hex = config["melo_musdc_pool_id"].as_str().unwrap();

    // Initialize client
    let (mut client, keystore) = init_client().await?;

    // Sync state
    println!("🔄 Sync yapılıyor...");
    client.sync_state().await?;
    println!("   ✅ Sync tamamlandı\n");

    // Check MILO/MUSDC pool
    let milo_pool_id = AccountId::from_hex(milo_pool_id_hex)?;
    consume_pool_notes(&mut client, &keystore, milo_pool_id, "MILO/MUSDC").await?;

    // Check MELO/MUSDC pool  
    let melo_pool_id = AccountId::from_hex(melo_pool_id_hex)?;
    consume_pool_notes(&mut client, &keystore, melo_pool_id, "MELO/MUSDC").await?;

    println!("\n🎉 İşlem tamamlandı!");
    println!("💡 Vault bilgisi için tekrar check_pool_reserves çalıştırın.");

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

async fn consume_pool_notes(
    client: &mut MidenClient,
    keystore: &FilesystemKeyStore<rand::rngs::StdRng>,
    pool_id: AccountId,
    pool_name: &str,
) -> Result<()> {
    println!("🔍 {} Pool notları kontrol ediliyor...", pool_name);

    // Sync first
    client.sync_state().await?;
    sleep(Duration::from_secs(2)).await;
    client.sync_state().await?;

    // Get consumable notes for pool
    let notes = client.get_consumable_notes(Some(pool_id)).await?;

    if notes.is_empty() {
        println!("   ℹ️ Tüketilecek not yok.");
        return Ok(());
    }

    println!("   📝 {} not bulundu, tüketiliyor...", notes.len());

    // Consume each note
    let mut consumed = 0;
    for (note, _) in notes {
        println!("      - Not tüketiliyor: {}", note.id().to_hex().chars().take(16).collect::<String>());

        // Build transaction to consume the note
        let tx_request = TransactionRequestBuilder::new()
            .authenticated_input_notes([(note.id(), None)])
            .build()
            .context("Tx request oluşturulamadı")?;

        // Get the account to find auth key
        let account = client.get_account(pool_id).await?
            .context("Account bulunamadı")?;

        // Submit transaction
        let tx_id = client
            .submit_new_transaction(pool_id, tx_request)
            .await
            .context("Tx gönderilemedi")?;

        println!("         Tx: {}", tx_id.to_hex().chars().take(16).collect::<String>());

        // Wait for transaction
        if wait_for_transaction(client, tx_id).await.is_ok() {
            consumed += 1;
            println!("         ✅ Tüketildi!");
        } else {
            println!("         ⚠️ Tüketilemedi!");
        }

        sleep(Duration::from_secs(1)).await;
    }

    println!("   ✅ {} not tüketildi.\n", consumed);

    Ok(())
}

async fn wait_for_transaction(
    client: &mut MidenClient,
    tx_id: miden_objects::transaction::TransactionId,
) -> Result<()> {
    for _ in 0..60 {
        match client.get_transactions(TransactionFilter::Ids(vec![tx_id])).await {
            Ok(transactions) => {
                if !transactions.is_empty() {
                    return Ok(());
                }
            }
            Err(_) => {}
        }
        sleep(Duration::from_millis(500)).await;
    }
    Err(anyhow::anyhow!("Tx zaman aşımı"))
}
