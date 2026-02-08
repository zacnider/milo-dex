//! Milo Swap - Token Mint CLI
//!
//! Mevcut faucet'lerden token mint etmek için basit CLI aracı
//!
//! Usage: cargo run --bin mint_tokens --release -- <TOKEN_SYMBOL> <AMOUNT> <RECIPIENT_ACCOUNT_ID>
//!
//! Örnek:
//!     cargo run --bin mint_tokens --release -- MILO 100 0x1234567890abcdef

use anyhow::{Context, Result};
use miden_client::store::TransactionFilter;
use miden_client::{
    Felt,
    account::{Account, NetworkId},
    asset::{FungibleAsset, TokenSymbol},
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
const KEYSTORE_PATH: &str = "keystore";
const STORE_PATH: &str = "store.sqlite3";

// Mevcut faucet ID'leri (bunlar zaten deploy edilmiş olmalı)
const KNOWN_FAUCETS: &[(&str, &str, u64)] = &[
    ("MILO", "0x5e8e88146824a4200e2b18de0ad670", 1_000_000_000),
    ("MELO", "0x0ebc079b56cc3920659055ebd56a96", 1_000_000_000),
    ("MUSDC", "0xee34300f31693c207ab206c064b421", 1_000_000),
];

type MidenClient = miden_client::Client<FilesystemKeyStore<StdRng>>;

#[tokio::main]
async fn main() -> Result<()> {
    println!("🚀 Milo Swap - Token Mint CLI\n");

    let args: Vec<String> = std::env::args().collect();
    
    if args.len() < 4 {
        println!("Kullanım: {} <TOKEN_SYMBOL> <AMOUNT> <RECIPIENT_ACCOUNT_ID>", args[0]);
        println!();
        println!("Mevcut Tokenlar:");
        for (symbol, id, decimals) in KNOWN_FAUCETS {
            println!("   {} (faucet: {}, decimals: {})", symbol, id, decimals);
        }
        println!();
        println!("Örnek:");
        println!("   {} MILO 100 0x1234567890abcdef", args[0]);
        return Ok(());
    }

    let token_symbol = args[1].to_uppercase();
    let amount: u64 = args[2].parse().context("Amount sayı olmalı")?;
    let recipient_id_hex = &args[3];

    println!("📝 Mint İsteği:");
    println!("   Token: {}", token_symbol);
    println!("   Amount: {}", amount);
    println!("   Recipient: {}", recipient_id_hex);
    println!();

    // Faucet bilgilerini bul
    let (faucet_id_hex, decimals) = KNOWN_FAUCETS.iter()
        .find(|(symbol, _, _)| *symbol == token_symbol)
        .map(|(_, id, dec)| (*id, *dec))
        .context("Token bulunamadı")?;

    // Minimum amount kontrolü
    let min_amount = decimals / 100; // 0.01 token minimum
    if amount < min_amount {
        println!("⚠️  Minimum amount: {} (decimals: {})", min_amount, decimals);
    }

    // Client'ı başlat
    let (mut client, keystore) = init_client().await?;

    // Faucet account'u al
    let faucet_id = miden_client::account::AccountId::from_hex(faucet_id_hex)
        .context("Geçersiz faucet ID")?;
    
    let faucet_account = client.get_account(faucet_id).await
        .context("Faucet hesabı alınamadı. Faucet deploy edilmiş olmalı!")?;

    println!("   ✅ Faucet hesabı bulundu: {}", faucet_id_hex);

    // Recipient account ID
    let recipient_id = miden_client::account::AccountId::from_hex(recipient_id_hex)
        .context("Geçersiz recipient ID")?;

    // Asset oluştur
    let asset = FungibleAsset::new(faucet_id, amount)
        .context("Asset oluşturulamadı")?;

    println!("   💰 Asset oluşturuldu: {} {}", amount, token_symbol);

    // Mint transaction oluştur
    println!("\n📤 Mint transaction gönderiliyor...");
    
    let tx_request = TransactionRequestBuilder::new()
        .build_mint_fungible_asset(asset, recipient_id, NoteType::Public, client.rng())
        .context("Mint tx oluşturulamadı")?;

    let tx_id = client
        .submit_new_transaction(faucet_id, tx_request)
        .await
        .context("Mint tx gönderilemedi")?;

    println!("   ✅ Transaction gönderildi: {}", tx_id.to_hex().chars().take(16).collect::<String>());

    // Transaction'ı bekle
    wait_for_transaction(&mut client, tx_id).await?;

    println!("\n🎉 Mint Başarılı!");
    println!("   Token: {}", token_symbol);
    println!("   Amount: {}", amount);
    println!("   Recipient: {}", recipient_id_hex);
    println!("\n💡 Not: Token'ları almak için recipient cüzdanını sync etmeli ve not'ları tüketmeli.");

    Ok(())
}

async fn init_client() -> Result<(MidenClient, FilesystemKeyStore<StdRng>)> {
    let timeout_ms = 60_000;
    let endpoint = Endpoint::testnet();
    let rpc_api = Arc::new(GrpcClient::new(&endpoint, timeout_ms));
    
    let keystore_path = PathBuf::from(KEYSTORE_PATH);
    
    if !keystore_path.exists() {
        fs::create_dir_all(&keystore_path)?;
        println!("   📁 Keystore klasörü oluşturuldu");
    }

    let keystore = FilesystemKeyStore::new(keystore_path)
        .context("Keystore oluşturulamadı")?;

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

async fn wait_for_transaction(
    client: &mut MidenClient,
    tx_id: miden_objects::transaction::TransactionId,
) -> Result<()> {
    println!("   ⏳ Transaction bekleniyor...");

    for i in 0..60 {
        let transactions = client.get_transactions(TransactionFilter::Ids(vec![tx_id])).await?;

        if !transactions.is_empty() {
            let tx = &transactions[0];
            if tx.details.output_notes.iter().next().is_some() {
                println!("   ✅ Transaction tamamlandı!");
                return Ok(());
            }
        }

        if i % 10 == 0 && i > 0 {
            println!("   ⏳ Hala bekleniyor... ({})", i);
        }

        sleep(Duration::from_secs(1)).await;
    }

    Err(anyhow::anyhow!("Transaction zaman aşımı"))
}
