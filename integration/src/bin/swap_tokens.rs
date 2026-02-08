//! Swap tokens using Miden AMM pools
//!
//! Usage:
//!     cargo run --bin swap_tokens -- [OPTIONS]
//!
//! Options:
//!     --pool-id <HEX>    Pool account ID (hex, 32 chars)
//!     --token-in <SYMBOL> Input token symbol (MILO, MELO, MUSDC)
//!     --amount <U64>     Amount of tokens to swap
//!     --wallet-id <HEX>  Wallet account ID (hex, 32 chars)
//!
//! Example:
//!     cargo run --bin swap_tokens -- --pool-id 0x23b414fcc35900103c828935971168 --token-in MILO --amount 1000 --wallet-id 0x596d2265efc9b21029638d388d590b

use std::str::FromStr;

use clap::Parser;
use miden_client::client::Client;
use miden_client::config::Endpoint;
use miden_client::errors::ClientError;
use miden_client::objects::AccountId;
use miden_client::transactions::TransactionRequestBuilder;

use milo_swap::milo_accounts::{
    MILO_FAUCET_ID_HEX, MELO_FAUCET_ID_HEX, MUSDC_FAUCET_ID_HEX,
    MILO_MUSDC_POOL_ACCOUNT_ID_HEX, MELO_MUSDC_POOL_ACCOUNT_ID_HEX,
};

#[derive(Parser, Debug)]
#[command(name = "swap_tokens")]
#[command(author, version, about, long_about = None)]
struct Args {
    /// Pool account ID (hex, 32 chars)
    #[arg(long)]
    pool_id: String,

    /// Input token symbol (MILO, MELO, MUSDC)
    #[arg(long)]
    token_in: String,

    /// Amount of tokens to swap
    #[arg(long)]
    amount: u64,

    /// Wallet account ID (hex, 32 chars)
    #[arg(long)]
    wallet_id: String,

    /// RPC endpoint (optional)
    #[arg(long, default_value = "http://127.0.0.1:57291")]
    rpc: String,
}

#[tokio::main]
async fn main() -> Result<(), ClientError> {
    tracing_subscriber::fmt::init();

    let args = Args::parse();

    println!("=== Milo Swap Token Exchange ===\n");

    // Parse account IDs
    let pool_id = AccountId::from_hex(&args.pool_id)
        .map_err(|e| ClientError::Error(e.to_string()))?;
    let wallet_id = AccountId::from_hex(&args.wallet_id)
        .map_err(|e| ClientError::Error(e.to_string()))?;

    println!("Pool ID: 0x{:?}", pool_id.to_hex());
    println!("Wallet ID: 0x{:?}", wallet_id.to_hex());
    println!("Swapping {} {} in pool 0x{:?}\n", args.amount, args.token_in, pool_id.to_hex());

    // Determine token IDs
    let (token_in_id, token_out_id) = match args.token_in.to_uppercase().as_str() {
        "MILO" => {
            let token_in = AccountId::from_hex(MILO_FAUCET_ID_HEX)
                .map_err(|e| ClientError::Error(e.to_string()))?;
            let token_out = if pool_id.to_hex() == MILO_MUSDC_POOL_ACCOUNT_ID_HEX {
                AccountId::from_hex(MUSDC_FAUCET_ID_HEX)
                    .map_err(|e| ClientError::Error(e.to_string()))?
            } else {
                AccountId::from_hex(MUSDC_FAUCET_ID_HEX)
                    .map_err(|e| ClientError::Error(e.to_string()))?
            };
            (token_in, token_out)
        },
        "MELO" => {
            let token_in = AccountId::from_hex(MELO_FAUCET_ID_HEX)
                .map_err(|e| ClientError::Error(e.to_string()))?;
            let token_out = if pool_id.to_hex() == MELO_MUSDC_POOL_ACCOUNT_ID_HEX {
                AccountId::from_hex(MUSDC_FAUCET_ID_HEX)
                    .map_err(|e| ClientError::Error(e.to_string()))?
            } else {
                AccountId::from_hex(MUSDC_FAUCET_ID_HEX)
                    .map_err(|e| ClientError::Error(e.to_string()))?
            };
            (token_in, token_out)
        },
        "MUSDC" => {
            let token_in = AccountId::from_hex(MUSDC_FAUCET_ID_HEX)
                .map_err(|e| ClientError::Error(e.to_string()))?;
            let token_out = if pool_id.to_hex() == MILO_MUSDC_POOL_ACCOUNT_ID_HEX {
                AccountId::from_hex(MILO_FAUCET_ID_HEX)
                    .map_err(|e| ClientError::Error(e.to_string()))?
            } else {
                AccountId::from_hex(MELO_FAUCET_ID_HEX)
                    .map_err(|e| ClientError::Error(e.to_string()))?
            };
            (token_in, token_out)
        },
        _ => {
            eprintln!("Unknown token: {}. Use MILO, MELO, or MUSDC", args.token_in);
            return Ok(());
        }
    };

    println!("Token In:  0x{:?}", token_in_id.to_hex());
    println!("Token Out: 0x{:?}", token_out_id.to_hex());

    // Initialize client
    let endpoint = Endpoint::new(args.rpc.parse().unwrap());
    let mut client = Client::new(endpoint, None, None, None);

    // Sync state
    println!("\nSyncing with Miden node...");
    client.sync_state().await?;

    // Get wallet account
    println!("Fetching wallet account...");
    let wallet_account = client.get_account(wallet_id).await?;

    // Check token balance
    println!("\nChecking token balances...");
    let balance_vault = wallet_account.account().vault();

    println!("Wallet has {} assets", balance_vault.len());

    // Check for the token
    let has_balance = balance_vault
        .iter()
        .any(|asset| {
            if let Some(fa) = asset.as_fungible() {
                fa.faucet_id() == token_in_id && fa.amount() >= args.amount
            } else {
                false
            }
        });

    if !has_balance {
        eprintln!("\n⚠️  Wallet doesn't have enough {} tokens!", args.token_in);
        eprintln!("   Please mint tokens first using the faucet.");
        return Ok(());
    }

    println!("✓ Sufficient balance found");

    // Create swap transaction
    println!("\nBuilding swap transaction...");

    let mut tx_builder = TransactionRequestBuilder::new();

    println!("\n⚠️  Swap transaction requires pool contract support.");
    println!("   This is a placeholder for the swap functionality.");
    println!("   Pool contract must implement the swap note logic.");

    println!("\n=== Swap Summary ===");
    println!("Input:  {} {}", args.amount, args.token_in);
    println!("Output: [To be calculated by pool]");
    println!("Pool:   0x{:?}", pool_id.to_hex());
    println!("Status: Pending pool implementation");

    Ok(())
}
