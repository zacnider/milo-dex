//! Liquidity Daemon - Consumes P2ID DEPOSIT notes for pool accounts
//! Runs on port 8090
//! Pattern: Same as swap_daemon.rs (P2ID notes + metadata)

use anyhow::{Context, Result};
use axum::{
    extract::{Query, State},
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
    store::TransactionFilter,
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
    time::{Duration, Instant},
};
use tokio::time::sleep;
use tower_http::cors::{Any, CorsLayer};

type MidenClient = miden_client::Client<FilesystemKeyStore<StdRng>>;

const KEYSTORE_PATH: &str = "integration/keystore";
const STORE_PATH: &str = "integration/liquidity_store.sqlite3";

// Tracked notes
#[derive(Debug, Clone, Serialize, Deserialize)]
struct TrackedNote {
    note_id: String,
    note_type: String,
    timestamp: u64,
}

// Deposit info - metadata from frontend about P2ID deposit notes
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DepositInfo {
    note_id: String,
    pool_account_id: String,
    token_id: String,
    amount: String,
    user_account_id: String,
    min_lp_amount_out: String,
    timestamp: u64,
}

// Per-user deposit tracking
#[derive(Debug, Clone, Serialize, Deserialize)]
struct UserPoolDeposit {
    user_account_id: String,
    pool_account_id: String,
    total_deposited: u64,
    deposit_count: u32,
    last_deposit_time: u64,
}

const USER_DEPOSITS_FILE: &str = "user_deposits.json";

fn load_user_deposits() -> HashMap<String, UserPoolDeposit> {
    match fs::read_to_string(USER_DEPOSITS_FILE) {
        Ok(data) => serde_json::from_str(&data).unwrap_or_default(),
        Err(_) => HashMap::new(),
    }
}

fn save_user_deposits(deposits: &HashMap<String, UserPoolDeposit>) {
    let data = serde_json::to_string_pretty(deposits).unwrap_or_default();
    let _ = fs::write(USER_DEPOSITS_FILE, data);
}

// Query params for user_deposits endpoint
#[derive(Debug, Deserialize)]
struct UserDepositsQuery {
    user_id: String,
}

// Pool reserves response
#[derive(Debug, Serialize, Deserialize, Clone)]
struct PoolReservesResponse {
    pools: Vec<PoolReserveEntry>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct PoolReserveEntry {
    pool_id: String,
    pair: String,
    reserves: Vec<ReserveAsset>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct ReserveAsset {
    faucet_id: String,
    amount: String,
}

struct PoolReservesRequest {
    reply: tokio::sync::oneshot::Sender<Result<PoolReservesResponse, String>>,
}

// Worker message enum - consume, withdraw, or pool_reserves
enum WorkerRequest {
    Consume(ConsumeRequest),
    Withdraw(WithdrawWorkerRequest),
    PoolReserves(PoolReservesRequest),
}

// Shared state
#[derive(Clone)]
struct AppState {
    tracked_notes: Arc<Mutex<Vec<TrackedNote>>>,
    deposit_info_map: Arc<Mutex<HashMap<String, DepositInfo>>>,
    user_deposits: Arc<Mutex<HashMap<String, UserPoolDeposit>>>,
    worker_tx: Arc<std::sync::mpsc::Sender<WorkerRequest>>,
    trade_volumes: Arc<Mutex<HashMap<String, TradeVolume>>>,
}

struct ConsumeRequest {
    pool_id_opt: Option<String>,
    deposit_info_map: HashMap<String, DepositInfo>,
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
    deposit_info: Option<DepositInfo>,
}

#[derive(Debug, Serialize, Deserialize)]
struct WithdrawRequest {
    pool_account_id: String,
    user_account_id: String,
    lp_amount: String,
    min_token_a_out: String,
    min_token_b_out: String,
    token_a: Option<String>,
    token_b: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct WithdrawResponse {
    success: bool,
    tx_id: Option<String>,
    token_a_out: String,
    token_b_out: String,
    error: Option<String>,
}

// Withdraw worker request - sent to worker thread
struct WithdrawWorkerRequest {
    pool_id: AccountId,
    user_id: AccountId,
    lp_amount: u64,
    min_token_a_out: u64,
    min_token_b_out: u64,
    reply: tokio::sync::oneshot::Sender<Result<WithdrawResponse, String>>,
}

// Trade volume tracking
#[derive(Debug, Clone, Serialize, Deserialize)]
struct TradeVolume {
    pool_id: String,
    volume_24h: u64,
    fees_24h: u64,
    trades_24h: u32,
    last_updated: u64,
}

#[derive(Debug, Serialize, Deserialize)]
struct RecordTradeRequest {
    pool_id: String,
    amount_in: u64,
    amount_out: u64,
    fee_amount: u64,
}

#[tokio::main]
async fn main() -> Result<()> {
    println!("🚀 Liquidity Daemon starting on port 8090...\n");

    // Load pool IDs
    let pools_json = fs::read_to_string("pools.json")
        .context("pools.json not found")?;
    let pools: serde_json::Value = serde_json::from_str(&pools_json)?;

    let milo_pool_id = AccountId::from_hex(pools["milo_musdc_pool_id"].as_str().unwrap())?;
    let melo_pool_id = AccountId::from_hex(pools["melo_musdc_pool_id"].as_str().unwrap())?;

    println!("📋 Monitoring pools:");
    println!("   - MILO/MUSDC: {}", milo_pool_id.to_hex());
    println!("   - MELO/MUSDC: {}", melo_pool_id.to_hex());
    println!();

    // Load persisted user deposits
    let user_deposits: Arc<Mutex<HashMap<String, UserPoolDeposit>>> =
        Arc::new(Mutex::new(load_user_deposits()));
    println!("📦 Loaded {} user deposit record(s)", user_deposits.lock().unwrap().len());

    // Shared deposit_info_map - create before worker thread for auto-poll access
    let deposit_info_map: Arc<Mutex<HashMap<String, DepositInfo>>> = Arc::new(Mutex::new(HashMap::new()));

    // Initialize client in worker thread
    let (worker_tx, worker_rx) = std::sync::mpsc::channel::<WorkerRequest>();
    let user_deposits_worker = user_deposits.clone();
    let deposit_info_map_worker = deposit_info_map.clone();

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

            let mut last_poll = Instant::now();

            // Non-blocking event loop: HTTP requests + auto-poll
            loop {
                // Check for HTTP-triggered requests (non-blocking)
                match worker_rx.try_recv() {
                    Ok(WorkerRequest::Consume(req)) => {
                        let result = consume_pool_notes(&mut client, req.pool_id_opt, req.deposit_info_map, &user_deposits_worker, false,).await;
                        let _ = req.reply.send(result.map_err(|e| format!("{:?}", e)));
                        last_poll = Instant::now();
                    }
                    Ok(WorkerRequest::Withdraw(req)) => {
                        let result = execute_withdraw(&mut client, req.pool_id, req.user_id, req.lp_amount, req.min_token_a_out, req.min_token_b_out, &user_deposits_worker).await;
                        let _ = req.reply.send(result.map_err(|e| format!("{:?}", e)));
                        last_poll = Instant::now();
                    }
                    Ok(WorkerRequest::PoolReserves(req)) => {
                        let result = get_pool_reserves(&mut client).await;
                        let _ = req.reply.send(result.map_err(|e| format!("{:?}", e)));
                    }
                    Err(std::sync::mpsc::TryRecvError::Empty) => {
                        // No HTTP request pending
                    }
                    Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                        println!("Worker thread shutting down");
                        break;
                    }
                }

                // Auto-poll every 15 seconds
                if last_poll.elapsed() >= Duration::from_secs(15) {
                    let deposit_info = deposit_info_map_worker.lock().unwrap().clone();
                    let result = consume_pool_notes(&mut client, None, deposit_info, &user_deposits_worker, true).await;
                    if let Ok(ref resp) = result {
                        if resp.consumed > 0 {
                            println!("🔄 Auto-poll: consumed {} deposit note(s)", resp.consumed);
                        }
                    }
                    last_poll = Instant::now();
                }

                sleep(Duration::from_millis(100)).await;
            }
        });
    });

    // Initialize trade volumes for each pool
    let mut initial_volumes = HashMap::new();
    initial_volumes.insert(milo_pool_id.to_hex(), TradeVolume {
        pool_id: milo_pool_id.to_hex(),
        volume_24h: 0,
        fees_24h: 0,
        trades_24h: 0,
        last_updated: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs(),
    });
    initial_volumes.insert(melo_pool_id.to_hex(), TradeVolume {
        pool_id: melo_pool_id.to_hex(),
        volume_24h: 0,
        fees_24h: 0,
        trades_24h: 0,
        last_updated: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs(),
    });

    // Build app state
    let state = AppState {
        tracked_notes: Arc::new(Mutex::new(Vec::new())),
        deposit_info_map,
        user_deposits,
        worker_tx: Arc::new(worker_tx),
        trade_volumes: Arc::new(Mutex::new(initial_volumes)),
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
        .route("/consume_note", post(consume_handler))
        .route("/tracked_notes", get(list_tracked_notes_handler))
        .route("/withdraw", post(withdraw_handler))
        .route("/user_deposits", get(user_deposits_handler))
        .route("/record_trade", post(record_trade_handler))
        .route("/trade_volume", get(get_trade_volume_handler))
        .route("/apy", get(get_apy_handler))
        .route("/pool_reserves", get(pool_reserves_handler))
        .layer(cors)
        .with_state(state);

    // Start server
    let listener = tokio::net::TcpListener::bind("127.0.0.1:8090")
        .await
        .context("Failed to bind to port 8090")?;

    println!("🎯 Liquidity daemon listening on http://127.0.0.1:8090");
    println!("   Endpoints:");
    println!("   - GET  /health");
    println!("   - POST /track_note");
    println!("   - POST /consume");
    println!("   - POST /consume_note (alias)");
    println!("   - GET  /tracked_notes");
    println!("   - POST /withdraw");
    println!("   - GET  /user_deposits?user_id=<hex>");
    println!("   - POST /record_trade");
    println!("   - GET  /trade_volume");
    println!("   - GET  /apy");
    println!("   - GET  /pool_reserves");
    println!("   Auto-polling: every 15 seconds");
    println!();

    axum::serve(listener, app)
        .await
        .context("Server error")?;

    Ok(())
}

async fn health_handler() -> impl IntoResponse {
    Json(serde_json::json!({
        "status": "healthy",
        "daemon": "liquidity-daemon",
        "port": 8090
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

    // Store deposit info if provided (for P2ID deposits)
    let has_deposit_info = if let Some(ref deposit_info) = payload.deposit_info {
        println!("   💾 Storing deposit info for note: {}", payload.note_id);
        println!("      Token: {}", deposit_info.token_id);
        println!("      Amount: {}", deposit_info.amount);
        println!("      User: {}", deposit_info.user_account_id);
        state.deposit_info_map.lock().unwrap().insert(payload.note_id.clone(), deposit_info.clone());
        true
    } else {
        false
    };

    (StatusCode::OK, Json(serde_json::json!({
        "success": true,
        "note_id": payload.note_id,
        "has_deposit_info": has_deposit_info
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

    // Clone deposit_info_map for worker thread
    let deposit_info_map = state.deposit_info_map.lock().unwrap().clone();

    // Send to worker thread
    let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
    let req = ConsumeRequest {
        pool_id_opt,
        deposit_info_map,
        reply: reply_tx,
    };

    if state.worker_tx.send(WorkerRequest::Consume(req)).is_err() {
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
    deposit_info_map: HashMap<String, DepositInfo>,
    user_deposits: &Arc<Mutex<HashMap<String, UserPoolDeposit>>>,
    auto_poll: bool,
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
        if !auto_poll {
            println!("🔍 Checking pool: {}...", pool_id.to_hex().chars().take(16).collect::<String>());
        }

        // Sync state
        if !auto_poll {
            println!("   🔄 Syncing state...");
        }
        match tokio::time::timeout(Duration::from_secs(45), client.sync_state()).await {
            Ok(Ok(_)) => {
                if !auto_poll { println!("   ✅ Sync completed"); }
            }
            Ok(Err(e)) => {
                if !auto_poll {
                    println!("   ⚠️  Sync failed: {:?}", e);
                    println!("   ⏩ Continuing anyway to check local store");
                }
            }
            Err(_) => {
                if !auto_poll {
                    println!("   ⚠️  Sync timeout");
                    println!("   ⏩ Continuing with stale data");
                }
            }
        }

        // Get consumable P2ID notes for pool
        let notes = client.get_consumable_notes(Some(*pool_id)).await?;

        if !auto_poll || !notes.is_empty() {
            println!("   📝 Found {} consumable P2ID note(s)", notes.len());
        }

        if notes.is_empty() {
            if !auto_poll { println!("   ℹ️  No consumable notes found"); }
            continue;
        }

        for (note, _) in notes {
            let note_id = note.id();
            let note_id_hex = note_id.to_hex();
            println!("      🔄 Processing P2ID note: {}", note_id_hex.chars().take(16).collect::<String>());

            // Check if this note has deposit info
            let deposit_info = deposit_info_map.get(&note_id_hex);

            if let Some(info) = deposit_info {
                println!("         💧 Deposit note detected:");
                println!("            Token: {}", info.token_id);
                println!("            Amount: {}", info.amount);
                println!("            User: {}", info.user_account_id);
            } else {
                println!("         📝 Regular P2ID note (no deposit info) - consuming...");
            }

            // Consume the P2ID note (pool receives tokens)
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

                            // Track deposit per user if deposit_info exists
                            if let Some(info) = deposit_info {
                                let amount: u64 = info.amount.parse().unwrap_or(0);
                                if amount > 0 {
                                    let key = format!("{}:{}", info.user_account_id, pool_id.to_hex());
                                    let now = std::time::SystemTime::now()
                                        .duration_since(std::time::UNIX_EPOCH)
                                        .unwrap()
                                        .as_secs();
                                    let mut deps = user_deposits.lock().unwrap();
                                    let entry = deps.entry(key).or_insert(UserPoolDeposit {
                                        user_account_id: info.user_account_id.clone(),
                                        pool_account_id: pool_id.to_hex(),
                                        total_deposited: 0,
                                        deposit_count: 0,
                                        last_deposit_time: 0,
                                    });
                                    entry.total_deposited += amount;
                                    entry.deposit_count += 1;
                                    entry.last_deposit_time = now;
                                    println!("         💾 User deposit tracked: {} total for {}",
                                        entry.total_deposited, info.user_account_id);
                                    save_user_deposits(&deps);
                                }
                            }
                        }
                        Ok(Err(e)) => {
                            println!("         ⚠️  Wait failed: {:?}", e);
                        }
                        Err(_) => {
                            println!("         ⚠️  Wait timeout (tx may still succeed)");
                            total_consumed += 1;

                            // Also track on timeout since tx may succeed
                            if let Some(info) = deposit_info {
                                let amount: u64 = info.amount.parse().unwrap_or(0);
                                if amount > 0 {
                                    let key = format!("{}:{}", info.user_account_id, pool_id.to_hex());
                                    let now = std::time::SystemTime::now()
                                        .duration_since(std::time::UNIX_EPOCH)
                                        .unwrap()
                                        .as_secs();
                                    let mut deps = user_deposits.lock().unwrap();
                                    let entry = deps.entry(key).or_insert(UserPoolDeposit {
                                        user_account_id: info.user_account_id.clone(),
                                        pool_account_id: pool_id.to_hex(),
                                        total_deposited: 0,
                                        deposit_count: 0,
                                        last_deposit_time: 0,
                                    });
                                    entry.total_deposited += amount;
                                    entry.deposit_count += 1;
                                    entry.last_deposit_time = now;
                                    save_user_deposits(&deps);
                                }
                            }
                        }
                    }
                }
                Err(e) => {
                    println!("         ❌ Submit failed: {:?}", e);
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

/// Execute withdrawal: read pool reserves, calculate proportional amounts,
/// create P2ID notes from pool to user for both tokens
/// Enforces per-user deposit limits to prevent draining
async fn execute_withdraw(
    client: &mut MidenClient,
    pool_id: AccountId,
    user_id: AccountId,
    lp_amount: u64,
    _min_token_a_out: u64,
    _min_token_b_out: u64,
    user_deposits: &Arc<Mutex<HashMap<String, UserPoolDeposit>>>,
) -> Result<WithdrawResponse> {
    println!("   🔄 Executing withdrawal...");
    println!("      Pool: {}", pool_id.to_hex());
    println!("      User: {}", user_id.to_hex());
    println!("      LP Amount requested: {}", lp_amount);

    // Check user's tracked deposits - limit withdrawal to what they deposited
    let deposit_key = format!("{}:{}", user_id.to_hex(), pool_id.to_hex());
    let max_withdrawal = {
        let deps = user_deposits.lock().unwrap();
        deps.get(&deposit_key).map(|d| d.total_deposited).unwrap_or(0)
    };

    if max_withdrawal == 0 {
        return Err(anyhow::anyhow!(
            "No tracked deposits found for user {} in pool {}. You can only withdraw what you deposited.",
            user_id.to_hex(), pool_id.to_hex()
        ));
    }

    // Clamp lp_amount to user's max withdrawal
    let actual_lp_amount = lp_amount.min(max_withdrawal);
    println!("      User max withdrawal: {}", max_withdrawal);
    println!("      Actual LP amount: {}", actual_lp_amount);

    // Sync state
    client.sync_state().await?;

    // Read pool account and vault
    let pool_account = client.get_account(pool_id).await?
        .ok_or_else(|| anyhow::anyhow!("Pool account not found"))?;
    let pool_vault = pool_account.account().vault();

    // Get all fungible assets in pool vault (these are the reserves)
    let mut token_reserves: Vec<(AccountId, u64)> = Vec::new();
    for asset in pool_vault.assets() {
        if let miden_client::asset::Asset::Fungible(fungible_asset) = asset {
            let faucet_id = fungible_asset.faucet_id();
            let amount: u64 = fungible_asset.amount().try_into()?;
            println!("      Reserve: {} = {}", faucet_id.to_hex(), amount);
            token_reserves.push((faucet_id, amount));
        }
    }

    if token_reserves.len() < 2 {
        return Err(anyhow::anyhow!("Pool must have at least 2 token reserves, found {}", token_reserves.len()));
    }

    let (token_a_faucet, reserve_a) = token_reserves[0];
    let (token_b_faucet, reserve_b) = token_reserves[1];
    let total_liquidity = reserve_a + reserve_b;

    if total_liquidity == 0 {
        return Err(anyhow::anyhow!("Pool has no liquidity"));
    }

    // Calculate proportional amounts using clamped amount
    let token_a_out = ((actual_lp_amount as u128) * (reserve_a as u128) / (total_liquidity as u128)) as u64;
    let token_b_out = ((actual_lp_amount as u128) * (reserve_b as u128) / (total_liquidity as u128)) as u64;

    println!("      Token A out: {} (faucet: {})", token_a_out, token_a_faucet.to_hex());
    println!("      Token B out: {} (faucet: {})", token_b_out, token_b_faucet.to_hex());

    if token_a_out == 0 && token_b_out == 0 {
        return Err(anyhow::anyhow!("Calculated output amounts are both 0"));
    }

    let mut last_tx_id = String::new();

    // Create P2ID note from pool to user for token A
    if token_a_out > 0 {
        println!("      📤 Creating P2ID note for token A...");
        let asset_a = FungibleAsset::new(token_a_faucet, token_a_out)?;
        let note_a = create_p2id_note(
            pool_id,
            user_id,
            vec![asset_a.into()],
            NoteType::Public,
            Felt::new(0),
            client.rng(),
        )?;

        let tx_a = TransactionRequestBuilder::new()
            .own_output_notes(vec![OutputNote::Full(note_a)])
            .build()?;

        let tx_id_a = client.submit_new_transaction(pool_id, tx_a).await?;
        last_tx_id = tx_id_a.to_hex();
        println!("      📤 Token A tx submitted: {}", last_tx_id.chars().take(16).collect::<String>());

        match tokio::time::timeout(Duration::from_secs(30), wait_for_transaction(client, tx_id_a)).await {
            Ok(Ok(_)) => println!("      ✅ Token A sent to user!"),
            Ok(Err(e)) => println!("      ⚠️  Token A wait failed: {:?}", e),
            Err(_) => println!("      ⚠️  Token A wait timeout (tx may still succeed)"),
        }

        sleep(Duration::from_secs(1)).await;
    }

    // Create P2ID note from pool to user for token B
    if token_b_out > 0 {
        println!("      📤 Creating P2ID note for token B...");

        // Re-sync state after first tx
        client.sync_state().await?;

        let asset_b = FungibleAsset::new(token_b_faucet, token_b_out)?;
        let note_b = create_p2id_note(
            pool_id,
            user_id,
            vec![asset_b.into()],
            NoteType::Public,
            Felt::new(0),
            client.rng(),
        )?;

        let tx_b = TransactionRequestBuilder::new()
            .own_output_notes(vec![OutputNote::Full(note_b)])
            .build()?;

        let tx_id_b = client.submit_new_transaction(pool_id, tx_b).await?;
        last_tx_id = tx_id_b.to_hex();
        println!("      📤 Token B tx submitted: {}", last_tx_id.chars().take(16).collect::<String>());

        match tokio::time::timeout(Duration::from_secs(30), wait_for_transaction(client, tx_id_b)).await {
            Ok(Ok(_)) => println!("      ✅ Token B sent to user!"),
            Ok(Err(e)) => println!("      ⚠️  Token B wait failed: {:?}", e),
            Err(_) => println!("      ⚠️  Token B wait timeout (tx may still succeed)"),
        }
    }

    // Deduct withdrawn amount from user's tracked deposits
    {
        let mut deps = user_deposits.lock().unwrap();
        if let Some(entry) = deps.get_mut(&deposit_key) {
            let withdrawn = token_a_out + token_b_out;
            if withdrawn >= entry.total_deposited {
                entry.total_deposited = 0;
            } else {
                entry.total_deposited -= withdrawn;
            }
            println!("      💾 User deposit updated: {} remaining", entry.total_deposited);
            save_user_deposits(&deps);
        }
    }

    println!("   ✅ Withdrawal complete!");

    Ok(WithdrawResponse {
        success: true,
        tx_id: Some(last_tx_id),
        token_a_out: token_a_out.to_string(),
        token_b_out: token_b_out.to_string(),
        error: None,
    })
}

// Withdraw handler - processes LP token withdrawal
async fn withdraw_handler(
    State(state): State<AppState>,
    Json(payload): Json<WithdrawRequest>,
) -> impl IntoResponse {
    println!("🔄 Withdraw request: {} LP from pool {}", payload.lp_amount, payload.pool_account_id);
    println!("   User: {}", payload.user_account_id);

    // Parse IDs and amounts
    let pool_id = match AccountId::from_hex(&payload.pool_account_id) {
        Ok(id) => id,
        Err(e) => {
            return (StatusCode::BAD_REQUEST, Json(serde_json::json!(WithdrawResponse {
                success: false,
                tx_id: None,
                token_a_out: "0".to_string(),
                token_b_out: "0".to_string(),
                error: Some(format!("Invalid pool account ID: {:?}", e)),
            })));
        }
    };

    let user_id = match AccountId::from_hex(&payload.user_account_id) {
        Ok(id) => id,
        Err(e) => {
            return (StatusCode::BAD_REQUEST, Json(serde_json::json!(WithdrawResponse {
                success: false,
                tx_id: None,
                token_a_out: "0".to_string(),
                token_b_out: "0".to_string(),
                error: Some(format!("Invalid user account ID: {:?}", e)),
            })));
        }
    };

    let lp_amount: u64 = payload.lp_amount.parse().unwrap_or(0);
    let min_token_a_out: u64 = payload.min_token_a_out.parse().unwrap_or(0);
    let min_token_b_out: u64 = payload.min_token_b_out.parse().unwrap_or(0);

    if lp_amount == 0 {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!(WithdrawResponse {
            success: false,
            tx_id: None,
            token_a_out: "0".to_string(),
            token_b_out: "0".to_string(),
            error: Some("LP amount must be greater than 0".to_string()),
        })));
    }

    // Send to worker thread
    let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
    let req = WithdrawWorkerRequest {
        pool_id,
        user_id,
        lp_amount,
        min_token_a_out,
        min_token_b_out,
        reply: reply_tx,
    };

    if state.worker_tx.send(WorkerRequest::Withdraw(req)).is_err() {
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!(WithdrawResponse {
            success: false,
            tx_id: None,
            token_a_out: "0".to_string(),
            token_b_out: "0".to_string(),
            error: Some("Worker thread not available".to_string()),
        })));
    }

    // Wait for response
    match tokio::time::timeout(Duration::from_secs(120), reply_rx).await {
        Ok(Ok(Ok(response))) => {
            println!("✅ Withdraw processed: {} tokenA, {} tokenB", response.token_a_out, response.token_b_out);
            (StatusCode::OK, Json(serde_json::json!(response)))
        }
        Ok(Ok(Err(e))) => {
            eprintln!("❌ Withdraw error: {}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!(WithdrawResponse {
                success: false,
                tx_id: None,
                token_a_out: "0".to_string(),
                token_b_out: "0".to_string(),
                error: Some(e),
            })))
        }
        _ => {
            (StatusCode::REQUEST_TIMEOUT, Json(serde_json::json!(WithdrawResponse {
                success: false,
                tx_id: None,
                token_a_out: "0".to_string(),
                token_b_out: "0".to_string(),
                error: Some("Timeout".to_string()),
            })))
        }
    }
}

// Get user deposits for a specific user
async fn user_deposits_handler(
    State(state): State<AppState>,
    Query(query): Query<UserDepositsQuery>,
) -> impl IntoResponse {
    let deposits = state.user_deposits.lock().unwrap();
    let user_deps: Vec<&UserPoolDeposit> = deposits
        .values()
        .filter(|d| d.user_account_id == query.user_id)
        .collect();

    Json(serde_json::json!({
        "user_id": query.user_id,
        "deposits": user_deps
    }))
}

// Record a trade for volume tracking
async fn record_trade_handler(
    State(state): State<AppState>,
    Json(payload): Json<RecordTradeRequest>,
) -> impl IntoResponse {
    println!("📊 Recording trade: {} volume, {} fee for pool {}",
        payload.amount_in, payload.fee_amount, payload.pool_id);

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();

    let mut volumes = state.trade_volumes.lock().unwrap();

    if let Some(volume) = volumes.get_mut(&payload.pool_id) {
        if now - volume.last_updated > 86400 {
            volume.volume_24h = 0;
            volume.fees_24h = 0;
            volume.trades_24h = 0;
        }

        volume.volume_24h += payload.amount_in;
        volume.fees_24h += payload.fee_amount;
        volume.trades_24h += 1;
        volume.last_updated = now;

        println!("   Updated: volume_24h={}, fees_24h={}, trades_24h={}",
            volume.volume_24h, volume.fees_24h, volume.trades_24h);
    } else {
        volumes.insert(payload.pool_id.clone(), TradeVolume {
            pool_id: payload.pool_id.clone(),
            volume_24h: payload.amount_in,
            fees_24h: payload.fee_amount,
            trades_24h: 1,
            last_updated: now,
        });
    }

    (StatusCode::OK, Json(serde_json::json!({
        "success": true,
        "pool_id": payload.pool_id
    })))
}

// Get trade volume for pools
async fn get_trade_volume_handler(
    State(state): State<AppState>,
) -> impl IntoResponse {
    let volumes = state.trade_volumes.lock().unwrap();
    let volume_list: Vec<&TradeVolume> = volumes.values().collect();

    Json(serde_json::json!({
        "volumes": volume_list
    }))
}

// Calculate and return APY for each pool
async fn get_apy_handler(
    State(state): State<AppState>,
) -> impl IntoResponse {
    let volumes = state.trade_volumes.lock().unwrap();

    let pools_json = match fs::read_to_string("pools.json") {
        Ok(json) => json,
        Err(_) => {
            return Json(serde_json::json!({
                "error": "Could not load pool configuration"
            }));
        }
    };

    let pools: serde_json::Value = match serde_json::from_str(&pools_json) {
        Ok(p) => p,
        Err(_) => {
            return Json(serde_json::json!({
                "error": "Invalid pool configuration"
            }));
        }
    };

    let mut apy_data: Vec<serde_json::Value> = Vec::new();

    // MILO/MUSDC pool APY
    let milo_pool_id = pools["milo_musdc_pool_id"].as_str().unwrap_or("");
    if let Some(volume) = volumes.get(milo_pool_id) {
        let tvl: u64 = 600000;
        let daily_fee_rate = if tvl > 0 {
            volume.fees_24h as f64 / tvl as f64
        } else {
            0.0
        };
        let apy = ((1.0 + daily_fee_rate).powf(365.0) - 1.0) * 100.0;

        apy_data.push(serde_json::json!({
            "pool": "MILO/MUSDC",
            "pool_id": milo_pool_id,
            "apy": format!("{:.2}", apy),
            "volume_24h": volume.volume_24h,
            "fees_24h": volume.fees_24h,
            "trades_24h": volume.trades_24h,
            "tvl": tvl
        }));
    }

    // MELO/MUSDC pool APY
    let melo_pool_id = pools["melo_musdc_pool_id"].as_str().unwrap_or("");
    if let Some(volume) = volumes.get(melo_pool_id) {
        let tvl: u64 = 600000;
        let daily_fee_rate = if tvl > 0 {
            volume.fees_24h as f64 / tvl as f64
        } else {
            0.0
        };
        let apy = ((1.0 + daily_fee_rate).powf(365.0) - 1.0) * 100.0;

        apy_data.push(serde_json::json!({
            "pool": "MELO/MUSDC",
            "pool_id": melo_pool_id,
            "apy": format!("{:.2}", apy),
            "volume_24h": volume.volume_24h,
            "fees_24h": volume.fees_24h,
            "trades_24h": volume.trades_24h,
            "tvl": tvl
        }));
    }

    Json(serde_json::json!({
        "pools": apy_data
    }))
}

// Pool reserves handler - returns reserves for all pools
async fn pool_reserves_handler(
    State(state): State<AppState>,
) -> impl IntoResponse {
    println!("📊 Pool reserves request received");

    let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
    let req = PoolReservesRequest {
        reply: reply_tx,
    };

    if state.worker_tx.send(WorkerRequest::PoolReserves(req)).is_err() {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({
                "error": "Worker thread not available"
            }))
        );
    }

    match tokio::time::timeout(Duration::from_secs(60), reply_rx).await {
        Ok(Ok(Ok(response))) => {
            (StatusCode::OK, Json(serde_json::json!(response)))
        }
        Ok(Ok(Err(e))) => {
            eprintln!("❌ Pool reserves error: {}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({
                "error": e
            })))
        }
        _ => {
            (StatusCode::REQUEST_TIMEOUT, Json(serde_json::json!({
                "error": "Timeout"
            })))
        }
    }
}

// Get pool reserves from on-chain state
async fn get_pool_reserves(client: &mut MidenClient) -> Result<PoolReservesResponse> {
    let pools_json = fs::read_to_string("pools.json")?;
    let pools: serde_json::Value = serde_json::from_str(&pools_json)?;

    let pool_configs = vec![
        ("MILO/MUSDC", pools["milo_musdc_pool_id"].as_str().unwrap()),
        ("MELO/MUSDC", pools["melo_musdc_pool_id"].as_str().unwrap()),
    ];

    client.sync_state().await?;

    let mut entries = Vec::new();

    for (pair_name, pool_id_hex) in pool_configs {
        let pool_id = AccountId::from_hex(pool_id_hex)?;

        match client.get_account(pool_id).await? {
            Some(pool_account) => {
                let pool_vault = pool_account.account().vault();
                let mut reserves = Vec::new();

                for asset in pool_vault.assets() {
                    if let miden_client::asset::Asset::Fungible(fungible_asset) = asset {
                        let amount: u64 = fungible_asset.amount().try_into()?;
                        reserves.push(ReserveAsset {
                            faucet_id: fungible_asset.faucet_id().to_hex(),
                            amount: amount.to_string(),
                        });
                    }
                }

                entries.push(PoolReserveEntry {
                    pool_id: pool_id_hex.to_string(),
                    pair: pair_name.to_string(),
                    reserves,
                });
            }
            None => {
                println!("   ⚠️  Pool {} not found in local store", pool_id_hex);
            }
        }
    }

    Ok(PoolReservesResponse { pools: entries })
}
