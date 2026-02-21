//! Milo Swap Faucet API Server
//!
//! Gerçek on-chain minting yapan API sunucusu.
//! Faucet private key'ler keystore/ dizininde olmalı (setup_milo'dan).
//!
//! Kullanım:
//!     cd milo-swap && cargo run -p milo-faucet-server --release [PORT]
//!
//! Port: varsayılan 8084
//!
//! Mimarı:
//!   axum handler → mpsc::Sender<MintRequest> → worker thread (owns !Send Client)
//!                                            ← oneshot::Receiver<Result<..>>

mod faucet_ids;

use faucet_ids::{MELO_FAUCET_ID, MILO_FAUCET_ID, MUSDC_FAUCET_ID};

use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Json},
    routing::get,
    Router,
};
use miden_client::{
    account::AccountId,
    asset::FungibleAsset,
    builder::ClientBuilder,
    keystore::FilesystemKeyStore,
    note::NoteType,
    rpc::{Endpoint, GrpcClient},
    transaction::TransactionRequestBuilder,
};
use miden_client_sqlite_store::ClientBuilderSqliteExt;
use rand::rngs::StdRng;
use serde::Deserialize;
use serde_json::json;
use serde_json::Value as JsonValue;
use std::collections::HashMap;
use std::fs;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tower_http::cors::{Any, CorsLayer};

const KEYSTORE_PATH: &str = "keystore";
const STORE_PATH: &str = "faucet_store.sqlite3";
const MAX_DAILY_AMOUNT: u64 = 10_00000000; // 10 tokens × 10^8 decimals
const ADMIN_ACCOUNT_ID: &str = "0x9e96e636738fc9104ed2b971931cc7";

/// Tracks daily faucet usage per user+token
#[derive(Clone)]
struct RateLimitEntry {
    total_amount: u64,
    day: u32, // day number since epoch
}

fn current_day() -> u32 {
    (SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
        / 86400) as u32
}

/// Faucet configurations — symbol, faucet account ID, decimals
const FAUCETS: &[(&str, &str, u64)] = &[
    ("MILO", MILO_FAUCET_ID, 8),
    ("MELO", MELO_FAUCET_ID, 8),
    ("MUSDC", MUSDC_FAUCET_ID, 8),
];

// ---------------------------------------------------------------------------
// Worker ↔ axum channel types
// ---------------------------------------------------------------------------

/// Sent from axum handler → worker thread.
/// Every field is Send (oneshot::Sender<T> is Send when T: Send).
struct MintRequest {
    faucet_id_hex: String,
    recipient_id_hex: String,
    amount: u64,
    token_symbol: String,
    reply: tokio::sync::oneshot::Sender<Result<String, String>>,
}

// ---------------------------------------------------------------------------
// Axum shared state  (Send + Sync — no Miden client lives here)
// ---------------------------------------------------------------------------
#[derive(Clone)]
struct AppState {
    /// Channel to the worker thread that owns the Miden client
    mint_tx: Arc<std::sync::mpsc::Sender<MintRequest>>,
    /// Cached on-chain faucet status (populated at startup via worker)
    faucet_status: Arc<HashMap<String, bool>>,
    /// Rate limit tracker: key = "account_id:token_symbol"
    rate_limits: Arc<Mutex<HashMap<String, RateLimitEntry>>>,
}

// ---------------------------------------------------------------------------
// Query-param structs  (extra fields from frontend are silently ignored)
// ---------------------------------------------------------------------------
#[derive(Deserialize)]
struct PowParams {
    account_id: String,
    #[allow(dead_code)]
    amount: Option<String>,
    token_symbol: Option<String>,
}

#[derive(Deserialize)]
struct GetTokensParams {
    account_id: String,
    #[allow(dead_code)]
    is_private_note: Option<String>,
    asset_amount: Option<String>,
    challenge: String,
    #[allow(dead_code)]
    nonce: String,
    token_symbol: Option<String>,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Parse an account-ID that arrives as "0x…" or raw hex digits.
/// Bech32 (mtst1…) is NOT supported — frontend must send the hex wallet ID.
fn parse_account_id(s: &str) -> Result<AccountId, String> {
    let hex = if s.starts_with("0x") || s.starts_with("0X") {
        s.to_owned()
    } else if s.chars().all(|c| c.is_ascii_hexdigit()) && !s.is_empty() {
        format!("0x{}", s)
    } else {
        return Err(
            "account_id must be hex (0x…). Send the wallet ID, not the bech32 address."
                .to_string(),
        );
    };
    AccountId::from_hex(&hex).map_err(|e| format!("Invalid account ID: {}", e))
}

fn generate_challenge() -> String {
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let mut bytes = [0u8; 32];
    bytes[0..8].copy_from_slice(&ts.to_le_bytes());
    for i in 8..32 {
        bytes[i] = (ts as u8) ^ (i as u8);
    }
    hex::encode(bytes)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    let port: u16 = args.get(1).and_then(|p| p.parse().ok()).unwrap_or(8084);

    println!("🚀 Milo Swap Faucet API Server Başlıyor…");
    println!("   Keystore : {}", KEYSTORE_PATH);
    println!("   Store    : {}", STORE_PATH);

    // Store persists across restarts (contains faucet accounts & sync state)
    let store_exists = std::path::Path::new(STORE_PATH).exists();
    println!("   💾 Store: {}", if store_exists { "mevcut (reusing)" } else { "yeni oluşturulacak" });

    // Ensure keystore dir exists and report key count
    if !std::path::Path::new(KEYSTORE_PATH).exists() {
        fs::create_dir_all(KEYSTORE_PATH).ok();
    }
    let key_count = fs::read_dir(KEYSTORE_PATH)
        .map(|it| it.filter(|e| e.is_ok()).count())
        .unwrap_or(0);
    println!("📂 Keystore'da {} key dosyası var", key_count);
    if key_count == 0 {
        println!("⚠️  Keystore boş — minting çalışmayacak.");
    }

    // ── channels ────────────────────────────────────────────────────────
    // health: worker → main   (faucet-status map, sent once at startup)
    // mint:   main   → worker (one request at a time; processed sequentially)
    let (health_tx, health_rx) = std::sync::mpsc::channel::<HashMap<String, bool>>();
    let (mint_tx, mint_rx) = std::sync::mpsc::channel::<MintRequest>();

    // ── worker thread ── owns the !Send Miden client ────────────────────
    std::thread::spawn(move || {
        // Own tokio runtime for this thread; block_on drives each future
        // to completion before we move on — no concurrent access to client.
        let rt = tokio::runtime::Runtime::new().expect("tokio runtime failed");

        // ── build Miden client ──────────────────────────────────────────
        println!("\n🔧 Miden client başlatılıyor… (worker)");
        let mut client = rt.block_on(async {
            let endpoint = Endpoint::testnet();
            let rpc_api = Arc::new(GrpcClient::new(&endpoint, 60_000));
            let keystore = Arc::new(
                FilesystemKeyStore::<StdRng>::new(PathBuf::from(KEYSTORE_PATH))
                    .expect("Keystore oluşturulamadı"),
            );
            ClientBuilder::new()
                .rpc(rpc_api)
                .authenticator(keystore)
                .sqlite_store(STORE_PATH.into())
                .build()
                .await
                .expect("Miden client oluşturulamadı")
        });
        println!("   ✅ client hazır");

        // ── verify each faucet on-chain ──────────────────────────────────
        println!("\n🔍 Faucet hesapları kontrol ediliyor…");
        let status_map = rt.block_on(async {
            let mut m = HashMap::new();
            for (sym, id_hex, _) in FAUCETS {
                print!("   {} … ", sym);
                let ok = match AccountId::from_hex(id_hex) {
                    Ok(id) => client.import_account_by_id(id).await.is_ok(),
                    Err(_) => false,
                };
                println!("{}", if ok { "✅ aktif" } else { "❌ bulunamadı" });
                m.insert(sym.to_string(), ok);
            }
            m
        });

        // Store already contains sync state from integration/store.sqlite3
        // No need to sync_state() on every restart (avoids MMR bug)

        // Send health results back to main thread so axum can start
        health_tx.send(status_map).expect("main dropped health_rx");

        // ── mint request loop ────────────────────────────────────────────
        println!("🔄 Worker: mint istekleri beklenyor…");
        loop {
            let req = match mint_rx.recv() {
                Ok(r) => r,
                Err(_) => {
                    println!("🔄 Worker: channel kapatıldı, çıkıyor.");
                    break;
                }
            };

            // Destructure so the async block only borrows the fields it needs;
            // `reply` stays outside and is used after block_on returns.
            let MintRequest {
                faucet_id_hex,
                recipient_id_hex,
                amount,
                token_symbol,
                reply,
            } = req;

            println!(
                "   🔄 Worker: mint {} {} → {}",
                amount, token_symbol, recipient_id_hex
            );

            let result: Result<String, String> = rt.block_on(async {
                let faucet_id = AccountId::from_hex(&faucet_id_hex)
                    .map_err(|e| format!("bad faucet_id: {}", e))?;
                let recipient_id = parse_account_id(&recipient_id_hex)?;

                let asset =
                    FungibleAsset::new(faucet_id, amount).map_err(|e| format!("asset: {}", e))?;

                let tx_request = TransactionRequestBuilder::new()
                    .build_mint_fungible_asset(
                        asset,
                        recipient_id,
                        NoteType::Public,
                        client.rng(),
                    )
                    .map_err(|e| format!("build mint tx: {}", e))?;

                client
                    .submit_new_transaction(faucet_id, tx_request)
                    .await
                    .map(|tx_id| tx_id.to_hex())
                    .map_err(|e| format!("{:?}", e))
            });

            match &result {
                Ok(tx_id) => println!("   ✅ Worker: tx {}…", &tx_id[..16.min(tx_id.len())]),
                Err(e) => println!("   ❌ Worker: {}", e),
            }

            reply.send(result).ok();
        }
    });

    // ── wait for worker's health-check results ──────────────────────────
    let faucet_status = health_rx
        .recv()
        .expect("Worker thread crashed before health check");

    let state = AppState {
        mint_tx: Arc::new(mint_tx),
        faucet_status: Arc::new(faucet_status),
        rate_limits: Arc::new(Mutex::new(HashMap::new())),
    };

    // ── axum router ─────────────────────────────────────────────────────
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = Router::new()
        .route("/", get(|| async { "Milo Faucet API — /health /pow /get_tokens" }))
        .route("/health", get(health_handler))
        .route("/pow", get(pow_handler))
        .route("/get_tokens", get(get_tokens_handler))
        .layer(cors)
        .with_state(state);

    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    println!("\n🌐 http://{}", addr);
    println!("🛑 Ctrl+C ile dur\n");

    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async fn health_handler(State(state): State<AppState>) -> impl IntoResponse {
    let faucets: Vec<JsonValue> = FAUCETS
        .iter()
        .map(|(sym, id, decimals)| {
            let active = state.faucet_status.get(*sym).copied().unwrap_or(false);
            json!({
                "symbol": sym,
                "faucet_id": id,
                "status": if active { "active" } else { "not_found" },
                "decimals": decimals,
            })
        })
        .collect();
    Json(json!({ "status": "ok", "faucets": faucets }))
}

async fn pow_handler(
    Query(params): Query<PowParams>,
    State(state): State<AppState>,
) -> (StatusCode, Json<JsonValue>) {
    let token = params
        .token_symbol
        .as_deref()
        .unwrap_or("MILO")
        .to_uppercase();

    if !state.faucet_status.get(&token).copied().unwrap_or(false) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": format!("Faucet {} not available", token) })),
        );
    }

    println!("📩 /pow  token={}  account={}", token, params.account_id);

    (
        StatusCode::OK,
        Json(json!({
            "challenge": generate_challenge(),
            "target": 1000u64,
            "timestamp": SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs(),
        })),
    )
}

/// **GET /get_tokens** — dispatches a mint request to the worker thread and
/// awaits the on-chain transaction result via a oneshot channel.
async fn get_tokens_handler(
    Query(params): Query<GetTokensParams>,
    State(state): State<AppState>,
) -> (StatusCode, Json<JsonValue>) {
    let token = params
        .token_symbol
        .as_deref()
        .unwrap_or("MILO")
        .to_uppercase();

    println!(
        "💰 /get_tokens  token={}  account={}  amount={:?}",
        token, params.account_id, params.asset_amount
    );

    // ── validate token ──────────────────────────────────────────────────
    if !state.faucet_status.get(&token).copied().unwrap_or(false) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": format!("Faucet {} not available", token) })),
        );
    }

    let faucet_id_hex = match FAUCETS.iter().find(|(s, _, _)| *s == token) {
        Some((_, id, _)) => *id,
        None => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": format!("Unknown token {}", token) })),
            )
        }
    };

    // ── validate recipient ──────────────────────────────────────────────
    if let Err(e) = parse_account_id(&params.account_id) {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": e })));
    }

    // ── parse amount ────────────────────────────────────────────────────
    let amount: u64 = match params.asset_amount.as_deref().unwrap_or("100").parse() {
        Ok(a) if a > 0 => a,
        Ok(_) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "amount must be > 0" })),
            )
        }
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": format!("bad amount: {}", e) })),
            )
        }
    };

    // ── rate limit check (admin is exempt) ────────────────────────────
    let normalized_id = if params.account_id.starts_with("0x") || params.account_id.starts_with("0X") {
        params.account_id.to_lowercase()
    } else {
        format!("0x{}", params.account_id.to_lowercase())
    };
    let is_admin = normalized_id == ADMIN_ACCOUNT_ID.to_lowercase();

    if !is_admin {
        let rate_key = format!("{}:{}", normalized_id, token);
        let today = current_day();
        let mut limits = state.rate_limits.lock().unwrap();
        let entry = limits.entry(rate_key).or_insert(RateLimitEntry {
            total_amount: 0,
            day: today,
        });

        // Reset if new day
        if entry.day != today {
            entry.total_amount = 0;
            entry.day = today;
        }

        if entry.total_amount + amount > MAX_DAILY_AMOUNT {
            let remaining = MAX_DAILY_AMOUNT.saturating_sub(entry.total_amount);
            return (
                StatusCode::TOO_MANY_REQUESTS,
                Json(json!({
                    "error": format!(
                        "Daily limit reached for {}. Max {} per day. Remaining today: {}",
                        token, MAX_DAILY_AMOUNT, remaining
                    )
                })),
            );
        }

        // Reserve the amount
        entry.total_amount += amount;
    }

    println!(
        "   💎 mint {} {} → {}{}",
        amount, token, params.account_id,
        if is_admin { " (ADMIN)" } else { "" }
    );

    // ── send mint request to worker thread ──────────────────────────────
    let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();

    if state
        .mint_tx
        .send(MintRequest {
            faucet_id_hex: faucet_id_hex.to_string(),
            recipient_id_hex: params.account_id,
            amount,
            token_symbol: token.clone(),
            reply: reply_tx,
        })
        .is_err()
    {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "Worker thread is down" })),
        );
    }

    // ── await response from worker ──────────────────────────────────────
    match reply_rx.await {
        Ok(Ok(tx_id)) => {
            println!("   ✅ tx: {}…", &tx_id[..16.min(tx_id.len())]);
            (
                StatusCode::OK,
                Json(json!({
                    "tx_id": tx_id,
                    "note_id": tx_id,
                    "faucet_id": faucet_id_hex,
                    "amount": amount,
                    "token_symbol": token,
                    "status": "success",
                    "message": "Minted. Wait ~10 s then click Consume Notes."
                })),
            )
        }
        Ok(Err(e)) => {
            println!("   ❌ mint error: {}", e);
            let hint = if e.contains("key") || e.contains("sign") || e.contains("auth") {
                "Faucet private key missing in keystore/"
            } else {
                "Check server logs"
            };
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": e, "hint": hint })),
            )
        }
        Err(_) => {
            println!("   ❌ Worker dropped reply channel");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "Worker thread crashed during mint" })),
            )
        }
    }
}
