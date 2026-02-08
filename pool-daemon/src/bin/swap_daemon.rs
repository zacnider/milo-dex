//! Swap Daemon - Consumes SWAP notes for pool accounts
//! Runs on port 8080

use anyhow::{Context, Result};
use axum::{
    extract::State,
    http::{header, Method, StatusCode},
    response::{IntoResponse, Json},
    routing::{get, post},
    Router,
};
use miden_client::{
    account::AccountId,
    asset::FungibleAsset,
    builder::ClientBuilder,
    keystore::FilesystemKeyStore,
    note::{create_p2id_note, NoteType},
    rpc::{Endpoint, GrpcClient},
    store::{InputNoteRecord, TransactionFilter},
    transaction::{OutputNote, TransactionRequestBuilder},
    Felt,
};
use miden_client_sqlite_store::ClientBuilderSqliteExt;
use rand::rngs::StdRng;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::time::sleep;
use tower_http::cors::{Any, CorsLayer};

type MidenClient = miden_client::Client<FilesystemKeyStore<StdRng>>;

const KEYSTORE_PATH: &str = "integration/keystore";
const STORE_PATH: &str = "integration/store.sqlite3";

// Tracked notes
#[derive(Debug, Clone, Serialize, Deserialize)]
struct TrackedNote {
    note_id: String,
    note_type: String,
    timestamp: u64,
}

// Shared state
#[derive(Clone)]
struct AppState {
    tracked_notes: Arc<Mutex<Vec<TrackedNote>>>,
    swap_info_map: Arc<Mutex<HashMap<String, SwapInfo>>>, // note_id -> swap_info
    pool_ids: Arc<Vec<AccountId>>,
    consume_tx: Arc<std::sync::mpsc::Sender<ConsumeRequest>>,
}

struct ConsumeRequest {
    pool_id_opt: Option<String>,
    swap_info_map: HashMap<String, SwapInfo>, // Clone of swap_info_map
    reply: tokio::sync::oneshot::Sender<Result<ConsumeResponse, String>>,
}

#[derive(Debug, Serialize, Deserialize)]
struct ConsumeResponse {
    consumed: usize,
    pool_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct TrackNoteRequest {
    note_id: String,
    note_type: String,
    pool_account_id: Option<String>,
    swap_info: Option<SwapInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SwapInfo {
    note_id: String,
    pool_account_id: String,
    sell_token_id: String,
    buy_token_id: String,
    amount_in: String,
    min_amount_out: String,
    user_account_id: String,
    timestamp: u64,
}

#[tokio::main]
async fn main() -> Result<()> {
    println!("🚀 Swap Daemon starting on port 8080...\n");

    // Load pool IDs
    let pools_json = fs::read_to_string("pools.json")
        .context("pools.json not found")?;
    let pools: serde_json::Value = serde_json::from_str(&pools_json)?;

    let milo_pool_id = AccountId::from_hex(pools["milo_musdc_pool_id"].as_str().unwrap())?;
    let melo_pool_id = AccountId::from_hex(pools["melo_musdc_pool_id"].as_str().unwrap())?;

    let pool_ids = vec![milo_pool_id, melo_pool_id];

    println!("📋 Monitoring pools:");
    println!("   - MILO/MUSDC: {}", milo_pool_id.to_hex());
    println!("   - MELO/MUSDC: {}", melo_pool_id.to_hex());
    println!();

    // Initialize client in worker thread
    let (consume_tx, consume_rx) = std::sync::mpsc::channel::<ConsumeRequest>();

    std::thread::spawn(move || {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            // Initialize client
            let mut client = match init_client().await {
                Ok(c) => c,
                Err(e) => {
                    eprintln!("❌ Failed to initialize client: {:?}", e);
                    return;
                }
            };

            println!("✅ Client initialized in worker thread\n");

            // Process consume requests
            loop {
                match consume_rx.recv() {
                    Ok(req) => {
                        let result = consume_pool_notes(&mut client, req.pool_id_opt, req.swap_info_map).await;
                        let _ = req.reply.send(result.map_err(|e| format!("{:?}", e)));
                    }
                    Err(_) => {
                        println!("Worker thread shutting down");
                        break;
                    }
                }
            }
        });
    });

    // Build app state
    let state = AppState {
        tracked_notes: Arc::new(Mutex::new(Vec::new())),
        swap_info_map: Arc::new(Mutex::new(HashMap::new())),
        pool_ids: Arc::new(pool_ids),
        consume_tx: Arc::new(consume_tx),
    };

    // Setup CORS
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        .allow_headers([header::CONTENT_TYPE]);

    // Build router
    let app = Router::new()
        .route("/health", get(health_handler))
        .route("/track_note", post(track_note_handler))
        .route("/consume", post(consume_handler))
        .route("/tracked_notes", get(list_tracked_notes_handler))
        .layer(cors)
        .with_state(state);

    // Start server
    let listener = tokio::net::TcpListener::bind("127.0.0.1:8080")
        .await
        .context("Failed to bind to port 8080")?;

    println!("🎯 Swap daemon listening on http://127.0.0.1:8080");
    println!("   Endpoints:");
    println!("   - GET  /health");
    println!("   - POST /track_note");
    println!("   - POST /consume");
    println!("   - GET  /tracked_notes");
    println!();

    axum::serve(listener, app)
        .await
        .context("Server error")?;

    Ok(())
}

async fn health_handler() -> impl IntoResponse {
    Json(serde_json::json!({
        "status": "healthy",
        "daemon": "swap-daemon",
        "port": 8080
    }))
}

async fn track_note_handler(
    State(state): State<AppState>,
    Json(payload): Json<TrackNoteRequest>,
) -> impl IntoResponse {
    println!("📝 Tracking note: {} (type: {})", payload.note_id, payload.note_type);

    let tracked = TrackedNote {
        note_id: payload.note_id.clone(),
        note_type: payload.note_type.clone(),
        timestamp: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs(),
    };

    state.tracked_notes.lock().unwrap().push(tracked);

    // Store swap info if provided (for P2ID swaps)
    let has_swap_info = if let Some(ref swap_info) = payload.swap_info {
        println!("   💾 Storing swap info for note: {}", payload.note_id);
        println!("      Sell: {} -> Buy: {}", swap_info.sell_token_id, swap_info.buy_token_id);
        println!("      Amount in: {}, Min out: {}", swap_info.amount_in, swap_info.min_amount_out);
        state.swap_info_map.lock().unwrap().insert(payload.note_id.clone(), swap_info.clone());
        true
    } else {
        false
    };

    (StatusCode::OK, Json(serde_json::json!({
        "success": true,
        "note_id": payload.note_id,
        "has_swap_info": has_swap_info
    })))
}

async fn consume_handler(
    State(state): State<AppState>,
    Json(payload): Json<serde_json::Value>,
) -> impl IntoResponse {
    println!("🔄 Consume request received");

    let pool_id_opt = payload.get("pool_account_id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    // Clone swap_info_map for worker thread
    let swap_info_map = state.swap_info_map.lock().unwrap().clone();

    // Send to worker thread
    let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
    let req = ConsumeRequest {
        pool_id_opt,
        swap_info_map,
        reply: reply_tx,
    };

    if state.consume_tx.send(req).is_err() {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({
                "error": "Worker thread not available"
            }))
        );
    }

    // Wait for response
    match tokio::time::timeout(Duration::from_secs(120), reply_rx).await {
        Ok(Ok(Ok(response))) => {
            println!("✅ Consumed {} note(s)", response.consumed);
            (StatusCode::OK, Json(serde_json::json!(response)))
        }
        Ok(Ok(Err(e))) => {
            eprintln!("❌ Consume error: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "error": e
                }))
            )
        }
        Ok(Err(_)) => {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "error": "Worker thread dropped reply channel"
                }))
            )
        }
        Err(_) => {
            (
                StatusCode::REQUEST_TIMEOUT,
                Json(serde_json::json!({
                    "error": "Consume operation timed out"
                }))
            )
        }
    }
}

async fn list_tracked_notes_handler(State(state): State<AppState>) -> impl IntoResponse {
    let notes = state.tracked_notes.lock().unwrap().clone();
    Json(serde_json::json!({
        "tracked_notes": notes,
        "count": notes.len()
    }))
}

async fn init_client() -> Result<MidenClient> {
    let timeout_ms = 30_000;
    let endpoint = Endpoint::testnet();
    let rpc_api = Arc::new(GrpcClient::new(&endpoint, timeout_ms));

    let keystore_path = PathBuf::from(KEYSTORE_PATH);
    let keystore = FilesystemKeyStore::new(keystore_path)
        .context("Failed to create keystore")?;

    let client = ClientBuilder::new()
        .rpc(rpc_api)
        .authenticator(Arc::new(keystore.clone()))
        .in_debug_mode(true.into())
        .sqlite_store(STORE_PATH.into())
        .build()
        .await
        .context("Failed to build client")?;

    Ok(client)
}

async fn consume_pool_notes(
    client: &mut MidenClient,
    pool_id_opt: Option<String>,
    swap_info_map: HashMap<String, SwapInfo>,
) -> Result<ConsumeResponse> {
    // Load pool IDs
    let pools_json = fs::read_to_string("pools.json")?;
    let pools: serde_json::Value = serde_json::from_str(&pools_json)?;

    let pool_ids = if let Some(pool_id_hex) = pool_id_opt {
        vec![AccountId::from_hex(&pool_id_hex)?]
    } else {
        vec![
            AccountId::from_hex(pools["milo_musdc_pool_id"].as_str().unwrap())?,
            AccountId::from_hex(pools["melo_musdc_pool_id"].as_str().unwrap())?,
        ]
    };

    let mut total_consumed = 0;

    for pool_id in &pool_ids {
        println!("🔍 Checking pool: {}...", pool_id.to_hex().chars().take(16).collect::<String>());

        // Sync state
        println!("   🔄 Syncing state...");
        match tokio::time::timeout(Duration::from_secs(45), client.sync_state()).await {
            Ok(Ok(_)) => println!("   ✅ Sync completed"),
            Ok(Err(e)) => {
                println!("   ⚠️  Sync failed: {:?}", e);
                println!("   ⏩ Continuing anyway to check local store");
            }
            Err(_) => {
                println!("   ⚠️  Sync timeout");
                println!("   ⏩ Continuing with stale data");
            }
        }

        // Get consumable P2ID notes for pool
        let notes = client.get_consumable_notes(Some(*pool_id)).await?;
        println!("   📝 Found {} consumable P2ID note(s)", notes.len());

        if notes.is_empty() {
            println!("   ℹ️  No consumable notes found");
            continue;
        }

        for (note, _) in notes {
            let note_id = note.id();
            let note_id_hex = note_id.to_hex();
            println!("      🔄 Processing P2ID note: {}", note_id_hex.chars().take(16).collect::<String>());

            // Check if this is a swap note (has swap_info)
            let swap_info = swap_info_map.get(&note_id_hex);

            if let Some(info) = swap_info {
                println!("         💱 Swap note detected:");
                println!("            Sell: {} -> Buy: {}", info.sell_token_id, info.buy_token_id);
                println!("            Amount in: {}, Min out: {}", info.amount_in, info.min_amount_out);

                // Execute P2ID swap
                match execute_p2id_swap(client, *pool_id, note, note_id, info).await {
                    Ok(_) => {
                        total_consumed += 1;
                        println!("         ✅ Swap executed!");
                    }
                    Err(e) => {
                        println!("         ❌ Swap failed: {:?}", e);
                    }
                }
            } else {
                // Regular P2ID note (not a swap) - just consume it
                println!("         📝 Regular P2ID note - consuming...");

                let tx_request = TransactionRequestBuilder::new()
                    .authenticated_input_notes([(note_id, None)])
                    .build()?;

                match client.submit_new_transaction(*pool_id, tx_request).await {
                    Ok(tx_id) => {
                        println!("         📤 Tx submitted: {}", tx_id.to_hex().chars().take(16).collect::<String>());

                        match tokio::time::timeout(
                            Duration::from_secs(30),
                            wait_for_transaction(client, tx_id)
                        ).await {
                            Ok(Ok(_)) => {
                                total_consumed += 1;
                                println!("         ✅ Consumed!");
                            }
                            Ok(Err(e)) => {
                                println!("         ⚠️  Wait failed: {:?}", e);
                            }
                            Err(_) => {
                                println!("         ⚠️  Wait timeout (tx may still succeed)");
                                total_consumed += 1;
                            }
                        }
                    }
                    Err(e) => {
                        println!("         ❌ Submit failed: {:?}", e);
                    }
                }
            }

            sleep(Duration::from_secs(1)).await;
        }
    }

    Ok(ConsumeResponse {
        consumed: total_consumed,
        pool_id: None,
    })
}

/// Execute a P2ID swap: consume user's note, calculate output, send tokens back
async fn execute_p2id_swap(
    client: &mut MidenClient,
    pool_id: AccountId,
    _note: InputNoteRecord,
    note_id: miden_objects::note::NoteId,
    swap_info: &SwapInfo,
) -> Result<()> {
    // Parse swap parameters
    let user_account_id = AccountId::from_hex(&swap_info.user_account_id)?;
    let sell_token_id = AccountId::from_hex(&swap_info.sell_token_id)?;
    let buy_token_id = AccountId::from_hex(&swap_info.buy_token_id)?;
    let amount_in: u64 = swap_info.amount_in.parse()?;
    let min_amount_out: u64 = swap_info.min_amount_out.parse()?;

    println!("         📊 Swap parameters:");
    println!("            User: {}...", user_account_id.to_hex().chars().take(16).collect::<String>());
    println!("            Sell token: {}...", sell_token_id.to_hex().chars().take(12).collect::<String>());
    println!("            Buy token: {}...", buy_token_id.to_hex().chars().take(12).collect::<String>());
    println!("            Amount in: {}, Min out: {}", amount_in, min_amount_out);

    // Step 1: Consume user's P2ID note (pool receives tokens)
    println!("         📥 Step 1: Consuming user's P2ID note...");
    let consume_tx = TransactionRequestBuilder::new()
        .authenticated_input_notes([(note_id, None)])
        .build()?;

    let consume_tx_id = client.submit_new_transaction(pool_id, consume_tx).await?;
    println!("         📤 Consume tx submitted: {}", consume_tx_id.to_hex().chars().take(16).collect::<String>());

    // Wait for consume transaction
    wait_for_transaction(client, consume_tx_id).await?;
    println!("         ✅ User tokens consumed by pool");

    // Step 2: Read pool reserves and calculate swap output using AMM formula
    println!("         📊 Reading pool reserves...");
    client.sync_state().await?;

    let pool_account = client.get_account(pool_id).await?
        .ok_or_else(|| anyhow::anyhow!("Pool account not found"))?;
    let pool_vault = pool_account.account().vault();

    // Find reserves for sell and buy tokens
    let mut reserve_in: u64 = 0;
    let mut reserve_out: u64 = 0;

    for asset in pool_vault.assets() {
        if let miden_client::asset::Asset::Fungible(fungible_asset) = asset {
            let asset_faucet_id = fungible_asset.faucet_id();
            let asset_amount: u64 = fungible_asset.amount().try_into()?;

            if asset_faucet_id == sell_token_id {
                reserve_in = asset_amount;
                println!("            Reserve IN (sell token): {}", reserve_in);
            } else if asset_faucet_id == buy_token_id {
                reserve_out = asset_amount;
                println!("            Reserve OUT (buy token): {}", reserve_out);
            }
        }
    }

    if reserve_in == 0 || reserve_out == 0 {
        return Err(anyhow::anyhow!("Pool reserves not found for token pair"));
    }

    // Constant product AMM formula with 0.1% fee
    // amount_out = (amount_in * 999 * reserve_out) / (reserve_in * 1000 + amount_in * 999)
    let amount_in_with_fee = (amount_in as u128) * 999;
    let numerator = amount_in_with_fee * (reserve_out as u128);
    let denominator = (reserve_in as u128) * 1000 + amount_in_with_fee;
    let amount_out = (numerator / denominator) as u64;

    println!("         🧮 AMM calculation:");
    println!("            Amount in: {}", amount_in);
    println!("            Reserve in: {}, Reserve out: {}", reserve_in, reserve_out);
    println!("            Amount out: {}", amount_out);

    if amount_out < min_amount_out {
        return Err(anyhow::anyhow!("Output {} less than minimum {}", amount_out, min_amount_out));
    }

    // Step 3: Create P2ID note back to user with swapped tokens
    println!("         📤 Step 2: Creating P2ID note with swapped tokens for user...");

    let output_asset = FungibleAsset::new(buy_token_id, amount_out)?;

    let output_note = create_p2id_note(
        pool_id,
        user_account_id,
        vec![output_asset.into()],
        NoteType::Public,
        Felt::new(0),
        client.rng(),
    )?;

    let output_tx = TransactionRequestBuilder::new()
        .own_output_notes(vec![OutputNote::Full(output_note)])
        .build()?;

    let output_tx_id = client.submit_new_transaction(pool_id, output_tx).await?;
    println!("         📤 Output tx submitted: {}", output_tx_id.to_hex().chars().take(16).collect::<String>());

    // Wait for output transaction
    wait_for_transaction(client, output_tx_id).await?;
    println!("         ✅ Swapped tokens sent to user!");

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
    Err(anyhow::anyhow!("Transaction timeout"))
}
