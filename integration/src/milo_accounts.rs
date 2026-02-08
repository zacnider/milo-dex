//! Milo Swap Protocol - Account IDs Configuration
//! Bu dosya tüm account ID'lerini tek noktada tutar.
//! Güncelleme yaparken sadece bu dosyayı değiştirin.
//!
//! Last Updated: 2026-02-03 - Clean configuration
//! ============================================================
//!
//! ÖNEMLI: Tüm keyler milo-swap/keystore/ dizininde saklanmaktadır.
//! Key ID'leri: 0 = MILO/MUSDC pool, 1 = MELO/MUSDC pool, 2+ = faucet owner

// ============ USER WALLET ============
/// User wallet for all operations (hex format)
pub const USER_WALLET_ID_HEX: &str = "0x596d2265efc9b21029638d388d590b";
/// User wallet address (for P2ID notes - base58 format)
pub const USER_WALLET_ADDRESS: &str = "mtst1az438wgle3ljjyrfwryg402ddcp7psqs";

// ============ TOKEN FAUCETS ============
/// MILO Token Faucet ID (Orange color token)
pub const MILO_FAUCET_ID_HEX: &str = "0x5e8e88146824a4200e2b18de0ad670";
/// MELO Token Faucet ID (Green color token)
pub const MELO_FAUCET_ID_HEX: &str = "0x0ebc079b56cc3920659055ebd56a96";
/// MUSDC Token Faucet ID (Blue - USDC stablecoin)
pub const MUSDC_FAUCET_ID_HEX: &str = "0xee34300f31693c207ab206c064b421";

// ============ LIQUIDITY POOLS ============
/// MILO/MUSDC Pool Account ID
pub const MILO_MUSDC_POOL_ACCOUNT_ID_HEX: &str = "0x23b414fcc35900103c828935971168";
/// MELO/MUSDC Pool Account ID
pub const MELO_MUSDC_POOL_ACCOUNT_ID_HEX: &str = "0x2d3344829cfa171073659d41e8aee1";

// ============ POOL KEY IDs (For signing transactions) ============
/// Key ID 0: MILO/MUSDC Pool signing key
pub const KEY_ID_MILO_MUSDC_POOL: u8 = 0;
/// Key ID 1: MELO/MUSDC Pool signing key
pub const KEY_ID_MELO_MUSDC_POOL: u8 = 1;

// ============ DEFAULT MINT AMOUNTS ============
/// Default amount for MILO minting (50,000 tokens)
pub const DEFAULT_MILO_AMOUNT: u64 = 50_000;
/// Default amount for MELO minting (50,000 tokens)
pub const DEFAULT_MELO_AMOUNT: u64 = 50_000;
/// Default amount for MUSDC minting (100,000 tokens - stablecoin)
pub const DEFAULT_MUSDC_AMOUNT: u64 = 100_000;

// ============ INITIAL LIQUIDITY AMOUNTS ============
/// Amount of MILO tokens for initial pool liquidity
pub const MILO_LIQUIDITY_AMOUNT: u64 = 50_000;
/// Amount of MELO tokens for initial pool liquidity
pub const MELO_LIQUIDITY_AMOUNT: u64 = 50_000;
/// Amount of MUSDC tokens for initial pool liquidity
pub const MUSDC_LIQUIDITY_AMOUNT: u64 = 100_000;

// ============ HELPER FUNCTIONS ============

/// Get faucet ID by token symbol (case insensitive)
pub fn get_faucet_id_by_symbol(symbol: &str) -> Option<&'static str> {
    match symbol.to_uppercase().as_str() {
        "MILO" => Some(MILO_FAUCET_ID_HEX),
        "MELO" => Some(MELO_FAUCET_ID_HEX),
        "MUSDC" => Some(MUSDC_FAUCET_ID_HEX),
        _ => None,
    }
}

/// Get pool ID by trading pair (returns (base_pool_id, quote_pool_id))
pub fn get_pool_id_by_pair(base_symbol: &str, quote_symbol: &str) -> Option<&'static str> {
    let base = base_symbol.to_uppercase();
    let quote = quote_symbol.to_uppercase();
    
    match (base.as_str(), quote.as_str()) {
        ("MILO", "MUSDC") => Some(MILO_MUSDC_POOL_ACCOUNT_ID_HEX),
        ("MELO", "MUSDC") => Some(MELO_MUSDC_POOL_ACCOUNT_ID_HEX),
        _ => None,
    }
}

/// Get pool key ID by token pair
pub fn get_pool_key_id_by_pair(base_symbol: &str, quote_symbol: &str) -> Option<u8> {
    let base = base_symbol.to_uppercase();
    let quote = quote_symbol.to_uppercase();
    
    match (base.as_str(), quote.as_str()) {
        ("MILO", "MUSDC") => Some(KEY_ID_MILO_MUSDC_POOL),
        ("MELO", "MUSDC") => Some(KEY_ID_MELO_MUSDC_POOL),
        _ => None,
    }
}
