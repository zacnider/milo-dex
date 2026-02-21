//! Swap Daemon - Consumes SWAP notes for pool accounts
//! Runs on port 8080
//! Features: TWAP Price Oracle, Dynamic Fee, Auto-Polling

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
    note::{create_p2id_note, NoteAttachment, NoteType},
    rpc::{Endpoint, GrpcClient},
    store::{AccountRecordData, InputNoteRecord, TransactionFilter},
    transaction::{OutputNote, TransactionRequestBuilder},
};
use miden_client_sqlite_store::ClientBuilderSqliteExt;
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

type MidenClient = miden_client::Client<FilesystemKeyStore>;

const KEYSTORE_PATH: &str = "integration/keystore";
const STORE_PATH: &str = "integration/swap_store.sqlite3";

// Tracked notes
#[derive(Debug, Clone, Serialize, Deserialize)]
struct TrackedNote {
    note_id: String,
    note_type: String,
    timestamp: u64,
}

// TWAP Price Oracle - price point recorded after each swap
#[derive(Debug, Clone, Serialize, Deserialize)]
struct PricePoint {
    timestamp: u64,
    pool_id: String,
    price: f64,
    reserve_a: u64,
    reserve_b: u64,
}

// Shared state
#[derive(Clone)]
struct AppState {
    tracked_notes: Arc<Mutex<Vec<TrackedNote>>>,
    swap_info_map: Arc<Mutex<HashMap<String, SwapInfo>>>,
    pool_ids: Arc<Vec<AccountId>>,
    consume_tx: Arc<std::sync::mpsc::Sender<ConsumeRequest>>,
    price_history: Arc<Mutex<Vec<PricePoint>>>,
    limit_orders: Arc<Mutex<Vec<LimitOrder>>>,
}

struct ConsumeRequest {
    pool_id_opt: Option<String>,
    swap_info_map: Arc<Mutex<HashMap<String, SwapInfo>>>,
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

// Limit Orders
#[derive(Debug, Clone, Serialize, Deserialize)]
struct LimitOrder {
    order_id: String,
    note_id: String,
    pool_id: String,
    user_account_id: String,
    sell_token_id: String,
    buy_token_id: String,
    amount_in: u64,
    target_price: f64,
    min_amount_out: u64,
    created_at: u64,
    expires_at: u64,
    status: String, // Pending, Filled, Expired, Cancelled
}

#[derive(Debug, Serialize, Deserialize)]
struct CreateLimitOrderRequest {
    note_id: String,
    pool_id: String,
    user_account_id: String,
    sell_token_id: String,
    buy_token_id: String,
    amount_in: String,
    target_price: f64,
    min_amount_out: String,
    expires_in_secs: u64,
    swap_info: SwapInfo,
}

#[derive(Debug, Deserialize)]
struct LimitOrdersQuery {
    user_id: String,
}

#[derive(Debug, Deserialize)]
struct CancelOrderRequest {
    order_id: String,
}

// Query params for TWAP endpoint
#[derive(Debug, Deserialize)]
struct TwapQuery {
    pool_id: String,
    window: Option<u64>,
}

// Query params for price history endpoint
#[derive(Debug, Deserialize)]
struct PriceHistoryQuery {
    pool_id: String,
    limit: Option<usize>,
}

// Query params for current fee endpoint
#[derive(Debug, Deserialize)]
struct CurrentFeeQuery {
    pool_id: String,
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

    // Shared state - create before worker thread
    let swap_info_map: Arc<Mutex<HashMap<String, SwapInfo>>> = Arc::new(Mutex::new(HashMap::new()));
    let price_history: Arc<Mutex<Vec<PricePoint>>> = Arc::new(Mutex::new(Vec::new()));
    let limit_orders: Arc<Mutex<Vec<LimitOrder>>> = Arc::new(Mutex::new(Vec::new()));

    // Initialize client in worker thread
    let (consume_tx, consume_rx) = std::sync::mpsc::channel::<ConsumeRequest>();
    let swap_info_map_worker = swap_info_map.clone();
    let price_history_worker = price_history.clone();
    let limit_orders_worker = limit_orders.clone();

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

            // Import pool accounts from network and sync state
            println!("🔄 Importing pool accounts and syncing...");
            if let Ok(pools_data) = fs::read_to_string("pools.json") {
                if let Ok(pools_val) = serde_json::from_str::<serde_json::Value>(&pools_data) {
                    for key in &["milo_musdc_pool_id", "melo_musdc_pool_id"] {
                        if let Some(id_hex) = pools_val[key].as_str() {
                            if let Ok(pool_id) = AccountId::from_hex(id_hex) {
                                match client.import_account_by_id(pool_id).await {
                                    Ok(_) => println!("   ✅ Pool {} imported", id_hex),
                                    Err(e) => println!("   ⚠️  Pool {} import failed: {:?}", id_hex, e),
                                }
                            }
                        }
                    }
                }
            }
            match client.sync_state().await {
                Ok(_) => println!("   ✅ State synced"),
                Err(e) => println!("   ⚠️  Sync error: {:?}", e),
            }

            let mut last_poll = Instant::now();

            // Non-blocking event loop: HTTP requests + auto-poll
            loop {
                // Check for HTTP-triggered consume requests (non-blocking)
                match consume_rx.try_recv() {
                    Ok(req) => {
                        let result = consume_pool_notes(
                            &mut client, req.pool_id_opt, &req.swap_info_map,
                            &price_history_worker, false,
                        ).await;
                        let _ = req.reply.send(result.map_err(|e| format!("{:?}", e)));
                        last_poll = Instant::now(); // Reset poll timer after HTTP request
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
                    let result = consume_pool_notes(
                        &mut client, None, &swap_info_map_worker,
                        &price_history_worker, true,
                    ).await;
                    if let Ok(ref resp) = result {
                        if resp.consumed > 0 {
                            println!("🔄 Auto-poll: consumed {} note(s)", resp.consumed);
                        }
                    }

                    // Check limit orders
                    check_limit_orders(
                        &mut client,
                        &limit_orders_worker,
                        &swap_info_map_worker,
                        &price_history_worker,
                    ).await;

                    last_poll = Instant::now();
                }

                sleep(Duration::from_millis(100)).await;
            }
        });
    });

    // Build app state
    let state = AppState {
        tracked_notes: Arc::new(Mutex::new(Vec::new())),
        swap_info_map,
        pool_ids: Arc::new(pool_ids),
        consume_tx: Arc::new(consume_tx),
        price_history,
        limit_orders,
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
        .route("/twap", get(twap_handler))
        .route("/price_history", get(price_history_handler))
        .route("/current_fee", get(current_fee_handler))
        .route("/limit_order", post(create_limit_order_handler))
        .route("/limit_orders", get(list_limit_orders_handler))
        .route("/cancel_limit_order", post(cancel_limit_order_handler))
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
    println!("   - GET  /twap?pool_id=<hex>&window=3600");
    println!("   - GET  /price_history?pool_id=<hex>&limit=100");
    println!("   - GET  /current_fee?pool_id=<hex>");
    println!("   - POST /limit_order");
    println!("   - GET  /limit_orders?user_id=<hex>");
    println!("   - POST /cancel_limit_order");
    println!("   Auto-polling: every 15 seconds (swaps + limit orders)");
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

    // Send to worker thread
    let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
    let req = ConsumeRequest {
        pool_id_opt,
        swap_info_map: state.swap_info_map.clone(),
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

// TWAP endpoint - Time-Weighted Average Price
async fn twap_handler(
    State(state): State<AppState>,
    Query(query): Query<TwapQuery>,
) -> impl IntoResponse {
    let window = query.window.unwrap_or(3600);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let cutoff = now.saturating_sub(window);

    let history = state.price_history.lock().unwrap();
    let points: Vec<&PricePoint> = history.iter()
        .filter(|p| p.pool_id == query.pool_id && p.timestamp >= cutoff)
        .collect();

    if points.is_empty() {
        return Json(serde_json::json!({
            "pool_id": query.pool_id,
            "twap": null,
            "window": window,
            "data_points": 0,
            "message": "No price data available for this pool"
        }));
    }

    // Calculate TWAP: sum(price_i * duration_i) / total_duration
    let mut weighted_sum = 0.0f64;
    let mut total_duration = 0u64;

    for i in 0..points.len() {
        let duration = if i + 1 < points.len() {
            points[i + 1].timestamp - points[i].timestamp
        } else {
            now - points[i].timestamp
        };
        let duration = duration.max(1);
        weighted_sum += points[i].price * duration as f64;
        total_duration += duration;
    }

    let twap = if total_duration > 0 {
        weighted_sum / total_duration as f64
    } else {
        points.last().map(|p| p.price).unwrap_or(0.0)
    };

    Json(serde_json::json!({
        "pool_id": query.pool_id,
        "twap": twap,
        "window": window,
        "data_points": points.len(),
        "latest_price": points.last().map(|p| p.price),
        "oldest_timestamp": points.first().map(|p| p.timestamp),
        "newest_timestamp": points.last().map(|p| p.timestamp),
    }))
}

// Price history endpoint - returns recent price points for charting
async fn price_history_handler(
    State(state): State<AppState>,
    Query(query): Query<PriceHistoryQuery>,
) -> impl IntoResponse {
    let limit = query.limit.unwrap_or(100);

    let history = state.price_history.lock().unwrap();
    let points: Vec<&PricePoint> = history.iter()
        .filter(|p| p.pool_id == query.pool_id)
        .rev()
        .take(limit)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();

    Json(serde_json::json!({
        "pool_id": query.pool_id,
        "prices": points,
        "count": points.len()
    }))
}

// Current fee endpoint - returns the dynamic fee for a pool
async fn current_fee_handler(
    State(state): State<AppState>,
    Query(query): Query<CurrentFeeQuery>,
) -> impl IntoResponse {
    let history = state.price_history.lock().unwrap();
    let (fee_bps, fee_pct) = calculate_dynamic_fee(&history, &query.pool_id);

    Json(serde_json::json!({
        "pool_id": query.pool_id,
        "fee_bps": fee_bps,
        "fee_percent": fee_pct,
        "fee_description": format!("{}%", fee_pct)
    }))
}

/// Calculate dynamic fee based on price volatility
/// Returns (fee_basis_points, fee_percent)
/// - Low volatility: 5 bps (0.05%)
/// - Normal: 10 bps (0.1%)
/// - High volatility: 30 bps (0.3%)
fn calculate_dynamic_fee(price_history: &[PricePoint], pool_id: &str) -> (u64, f64) {
    let recent: Vec<f64> = price_history.iter()
        .filter(|p| p.pool_id == pool_id)
        .rev()
        .take(10)
        .map(|p| p.price)
        .collect();

    if recent.len() < 2 {
        return (10, 0.1); // Default 0.1% (10 bps)
    }

    // Calculate price change standard deviation
    let changes: Vec<f64> = recent.windows(2)
        .map(|w| ((w[0] - w[1]) / w[1]).abs())
        .collect();

    let mean = changes.iter().sum::<f64>() / changes.len() as f64;
    let variance = changes.iter()
        .map(|c| (c - mean).powi(2))
        .sum::<f64>() / changes.len() as f64;
    let std_dev = variance.sqrt();

    if std_dev < 0.001 {
        (5, 0.05)   // Low volatility: 0.05%
    } else if std_dev < 0.01 {
        (10, 0.1)   // Normal: 0.1%
    } else {
        (30, 0.3)   // High volatility: 0.3%
    }
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
    swap_info_map: &Arc<Mutex<HashMap<String, SwapInfo>>>,
    price_history: &Arc<Mutex<Vec<PricePoint>>>,
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

            // Check if this is a swap note (has swap_info)
            let swap_info = swap_info_map.lock().unwrap().get(&note_id_hex).cloned();

            if let Some(info) = swap_info {
                println!("         💱 Swap note detected:");
                println!("            Sell: {} -> Buy: {}", info.sell_token_id, info.buy_token_id);
                println!("            Amount in: {}, Min out: {}", info.amount_in, info.min_amount_out);

                // Execute P2ID swap
                match execute_p2id_swap(client, *pool_id, note, &info, price_history).await {
                    Ok(_) => {
                        total_consumed += 1;
                        // Remove swap_info to prevent re-processing
                        swap_info_map.lock().unwrap().remove(&note_id_hex);
                        println!("         ✅ Swap executed! (note removed from tracking)");
                    }
                    Err(e) => {
                        println!("         ❌ Swap failed: {:?}", e);
                        // On state mismatch, sync state and skip remaining notes in this cycle
                        let err_str = format!("{:?}", e);
                        if err_str.contains("initial state commitment") {
                            println!("         🔄 State mismatch - syncing and retrying next cycle");
                            let _ = client.sync_state().await;
                            break;
                        }
                    }
                }
            } else if !auto_poll {
                // Regular P2ID note (not a swap) - only consume via HTTP request, not auto-poll
                println!("         📝 Regular P2ID note - consuming...");

                let input_note: miden_protocol::note::Note = note.try_into()
                    .map_err(|e| anyhow::anyhow!("Failed to convert note: {:?}", e))?;
                let tx_request = TransactionRequestBuilder::new()
                    .input_notes([(input_note, None)])
                    .build()?;

                match client.submit_new_transaction(*pool_id, tx_request).await {
                    Ok(tx_id) => {
                        let tx_id: miden_protocol::transaction::TransactionId = tx_id;
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
            } else {
                // Auto-poll: skip unknown notes (no swap_info)
                println!("         ⏩ Skipping unknown note (no swap info) during auto-poll");
            }

            sleep(Duration::from_secs(1)).await;
        }
    }

    Ok(ConsumeResponse {
        consumed: total_consumed,
        pool_id: None,
    })
}

/// Execute a P2ID swap: consume user's note + send swapped tokens in a single atomic TX
/// Uses dynamic fee based on price volatility and records price point for TWAP
async fn execute_p2id_swap(
    client: &mut MidenClient,
    pool_id: AccountId,
    note: InputNoteRecord,
    swap_info: &SwapInfo,
    price_history: &Arc<Mutex<Vec<PricePoint>>>,
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

    // Step 1: Read pool reserves BEFORE consumption
    println!("         📊 Reading pool reserves...");
    client.sync_state().await?;

    let pool_account = client.get_account(pool_id).await?
        .ok_or_else(|| anyhow::anyhow!("Pool account not found"))?;
    let pool_account_inner = match pool_account.account_data() {
        AccountRecordData::Full(acc) => acc,
        _ => return Err(anyhow::anyhow!("Pool account is not fully loaded")),
    };
    let pool_vault = pool_account_inner.vault();

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

    // Step 2: Calculate dynamic fee based on price volatility
    let pool_id_hex = pool_id.to_hex();
    let (fee_bps, fee_pct) = {
        let history = price_history.lock().unwrap();
        calculate_dynamic_fee(&history, &pool_id_hex)
    };
    println!("         💰 Dynamic fee: {} bps ({}%)", fee_bps, fee_pct);

    // Step 3: AMM calculation with dynamic fee
    // fee_bps: 5 = 0.05%, 10 = 0.1%, 30 = 0.3%
    // Formula: amount_out = (amount_in * (10000 - fee_bps) * reserve_out) / (reserve_in * 10000 + amount_in * (10000 - fee_bps))
    let fee_multiplier = 10000u128 - fee_bps as u128;
    let amount_in_with_fee = (amount_in as u128) * fee_multiplier;
    let numerator = amount_in_with_fee * (reserve_out as u128);
    let denominator = (reserve_in as u128) * 10000 + amount_in_with_fee;
    let amount_out = (numerator / denominator) as u64;

    println!("         🧮 AMM calculation:");
    println!("            Amount in: {}", amount_in);
    println!("            Reserve in: {}, Reserve out: {}", reserve_in, reserve_out);
    println!("            Fee: {} bps ({}%)", fee_bps, fee_pct);
    println!("            Amount out: {}", amount_out);

    if amount_out < min_amount_out {
        return Err(anyhow::anyhow!("Output {} less than minimum {}", amount_out, min_amount_out));
    }

    // Step 4: Create P2ID output note for user with swapped tokens
    let output_asset = FungibleAsset::new(buy_token_id, amount_out)?;

    let output_note = create_p2id_note(
        pool_id,
        user_account_id,
        vec![output_asset.into()],
        NoteType::Public,
        NoteAttachment::default(),
        client.rng(),
    )?;

    // Step 5: Single atomic TX - consume input note + create output note
    println!("         ⚡ Executing atomic swap (consume + send in single TX)...");

    let input_note: miden_protocol::note::Note = note.try_into()
        .map_err(|e| anyhow::anyhow!("Failed to convert note: {:?}", e))?;

    let tx_request = TransactionRequestBuilder::new()
        .input_notes([(input_note, None)])
        .own_output_notes(vec![OutputNote::Full(output_note)])
        .build()?;

    let tx_id: miden_protocol::transaction::TransactionId = client.submit_new_transaction(pool_id, tx_request).await?;
    println!("         📤 Atomic swap TX submitted: {}", tx_id.to_hex().chars().take(16).collect::<String>());

    wait_for_transaction(client, tx_id).await?;
    println!("         ✅ Atomic swap complete! Tokens sent to user.");

    // Step 6: Record price point for TWAP oracle
    let new_reserve_in = reserve_in + amount_in;
    let new_reserve_out = reserve_out - amount_out;
    let price = new_reserve_out as f64 / new_reserve_in as f64;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();

    {
        let mut history = price_history.lock().unwrap();
        history.push(PricePoint {
            timestamp: now,
            pool_id: pool_id_hex,
            price,
            reserve_a: new_reserve_in,
            reserve_b: new_reserve_out,
        });

        // Cleanup: keep only last 24 hours of data
        let cutoff = now.saturating_sub(86400);
        history.retain(|p| p.timestamp >= cutoff);
    }

    println!("         📈 Price recorded: {:.6} (reserves: {} / {})", price, new_reserve_in, new_reserve_out);

    Ok(())
}

// === Limit Order Handlers ===

async fn create_limit_order_handler(
    State(state): State<AppState>,
    Json(payload): Json<CreateLimitOrderRequest>,
) -> impl IntoResponse {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();

    let order_id = format!("LO-{}-{}", &payload.note_id[..16.min(payload.note_id.len())], now);
    let amount_in: u64 = payload.amount_in.parse().unwrap_or(0);
    let min_amount_out: u64 = payload.min_amount_out.parse().unwrap_or(0);

    let order = LimitOrder {
        order_id: order_id.clone(),
        note_id: payload.note_id.clone(),
        pool_id: payload.pool_id.clone(),
        user_account_id: payload.user_account_id.clone(),
        sell_token_id: payload.sell_token_id.clone(),
        buy_token_id: payload.buy_token_id.clone(),
        amount_in,
        target_price: payload.target_price,
        min_amount_out,
        created_at: now,
        expires_at: now + payload.expires_in_secs,
        status: "Pending".to_string(),
    };

    println!("📋 Limit order created: {}", order_id);
    println!("   Target price: {}, Amount: {}, Expires: {}s",
        payload.target_price, amount_in, payload.expires_in_secs);

    // Store the swap info for when the order triggers
    state.swap_info_map.lock().unwrap().insert(payload.note_id.clone(), payload.swap_info);
    state.limit_orders.lock().unwrap().push(order);

    (StatusCode::OK, Json(serde_json::json!({
        "success": true,
        "order_id": order_id,
    })))
}

async fn list_limit_orders_handler(
    State(state): State<AppState>,
    Query(query): Query<LimitOrdersQuery>,
) -> impl IntoResponse {
    let orders = state.limit_orders.lock().unwrap();
    let user_orders: Vec<&LimitOrder> = orders.iter()
        .filter(|o| o.user_account_id == query.user_id)
        .collect();

    Json(serde_json::json!({
        "orders": user_orders,
        "count": user_orders.len()
    }))
}

async fn cancel_limit_order_handler(
    State(state): State<AppState>,
    Json(payload): Json<CancelOrderRequest>,
) -> impl IntoResponse {
    let mut orders = state.limit_orders.lock().unwrap();
    if let Some(order) = orders.iter_mut().find(|o| o.order_id == payload.order_id && o.status == "Pending") {
        order.status = "Cancelled".to_string();
        println!("❌ Limit order cancelled: {}", payload.order_id);
        (StatusCode::OK, Json(serde_json::json!({
            "success": true,
            "order_id": payload.order_id,
            "status": "Cancelled"
        })))
    } else {
        (StatusCode::NOT_FOUND, Json(serde_json::json!({
            "success": false,
            "error": "Order not found or already processed"
        })))
    }
}

/// Check pending limit orders against current pool prices
/// Execute orders when the price condition is met
async fn check_limit_orders(
    client: &mut MidenClient,
    limit_orders: &Arc<Mutex<Vec<LimitOrder>>>,
    swap_info_map: &Arc<Mutex<HashMap<String, SwapInfo>>>,
    price_history: &Arc<Mutex<Vec<PricePoint>>>,
) {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();

    // Get pending orders
    let pending_orders: Vec<LimitOrder> = {
        let mut orders = limit_orders.lock().unwrap();
        // Mark expired orders
        for order in orders.iter_mut() {
            if order.status == "Pending" && order.expires_at < now {
                order.status = "Expired".to_string();
                println!("⏰ Limit order expired: {}", order.order_id);
            }
        }
        orders.iter().filter(|o| o.status == "Pending").cloned().collect()
    };

    if pending_orders.is_empty() {
        return;
    }

    // Check each pending order
    for order in &pending_orders {
        let pool_id = match AccountId::from_hex(&order.pool_id) {
            Ok(id) => id,
            Err(_) => continue,
        };

        // Read current pool reserves
        let pool_account = match client.get_account(pool_id).await {
            Ok(Some(acc)) => acc,
            _ => continue,
        };

        let pool_account_inner = match pool_account.account_data() {
            AccountRecordData::Full(acc) => acc,
            _ => continue,
        };
        let pool_vault = pool_account_inner.vault();
        let sell_token_id = match AccountId::from_hex(&order.sell_token_id) {
            Ok(id) => id,
            Err(_) => continue,
        };
        let buy_token_id = match AccountId::from_hex(&order.buy_token_id) {
            Ok(id) => id,
            Err(_) => continue,
        };

        let mut reserve_in: u64 = 0;
        let mut reserve_out: u64 = 0;

        for asset in pool_vault.assets() {
            if let miden_client::asset::Asset::Fungible(fa) = asset {
                let amount: u64 = match fa.amount().try_into() {
                    Ok(a) => a,
                    Err(_) => continue,
                };
                if fa.faucet_id() == sell_token_id {
                    reserve_in = amount;
                } else if fa.faucet_id() == buy_token_id {
                    reserve_out = amount;
                }
            }
        }

        if reserve_in == 0 || reserve_out == 0 {
            continue;
        }

        // Calculate AMM output at current reserves
        let (fee_bps, _) = {
            let history = price_history.lock().unwrap();
            calculate_dynamic_fee(&history, &order.pool_id)
        };
        let fee_multiplier = 10000u128 - fee_bps as u128;
        let amount_in_with_fee = (order.amount_in as u128) * fee_multiplier;
        let numerator = amount_in_with_fee * (reserve_out as u128);
        let denominator = (reserve_in as u128) * 10000 + amount_in_with_fee;
        let potential_output = (numerator / denominator) as u64;

        // Check if output meets the order's min_amount_out
        if potential_output >= order.min_amount_out {
            println!("🎯 Limit order {} triggered! Output: {} >= min: {}",
                order.order_id, potential_output, order.min_amount_out);

            // Get swap info for this note
            let swap_info = swap_info_map.lock().unwrap().get(&order.note_id).cloned();
            if let Some(info) = swap_info {
                // Find the consumable note
                match client.get_consumable_notes(Some(pool_id)).await {
                    Ok(notes) => {
                        for (note, _) in notes {
                            if note.id().to_hex() == order.note_id {
                                match execute_p2id_swap(client, pool_id, note, &info, price_history).await {
                                    Ok(_) => {
                                        println!("✅ Limit order {} filled!", order.order_id);
                                        let mut orders = limit_orders.lock().unwrap();
                                        if let Some(o) = orders.iter_mut().find(|o| o.order_id == order.order_id) {
                                            o.status = "Filled".to_string();
                                        }
                                    }
                                    Err(e) => {
                                        println!("❌ Limit order {} execution failed: {:?}", order.order_id, e);
                                    }
                                }
                                break;
                            }
                        }
                    }
                    Err(e) => {
                        println!("❌ Failed to get consumable notes for limit order: {:?}", e);
                    }
                }
            }
        }
    }
}

async fn wait_for_transaction(
    client: &mut MidenClient,
    tx_id: miden_protocol::transaction::TransactionId,
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
