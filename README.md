# Milo DEX

A fully-featured decentralized exchange built on the [Miden](https://miden.io/) blockchain, implementing a constant-product AMM with privacy swaps, limit orders, multi-hop routing, a TWAP price oracle, and dynamic fees.

**Live:** [milodex.xyz](https://milodex.xyz)

## Architecture

```
                     ┌──────────────────┐
                     │  React Frontend  │
                     │   (Vite + WASM)  │
                     └───────┬──────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
     ┌────────▼──────┐ ┌────▼───────┐ ┌────▼───────┐
     │ Swap Daemon   │ │ Liquidity  │ │  Faucet    │
     │ :8080         │ │ Daemon     │ │  Server    │
     │               │ │ :8090      │ │  :8084     │
     └────────┬──────┘ └────┬───────┘ └────┬───────┘
              │             │              │
              └─────────────┼──────────────┘
                            │
                   ┌────────▼─────────┐
                   │  Miden Testnet   │
                   │  (ZK Rollup)     │
                   └──────────────────┘
```

The frontend communicates with three Rust backend daemons over REST. All on-chain operations go through the Miden SDK, which produces zero-knowledge proofs client-side (WASM) or daemon-side (native Rust).

## Features

### Trading
- **Market swaps** with constant-product AMM (`x * y = k`)
- **Limit orders** with target price and configurable expiry (1h / 24h / 7d)
- **Multi-hop routing** for pairs without a direct pool (e.g. MILO -> MUSDC -> MELO)
- **Privacy mode** using Miden's private P2ID notes (toggle on/off per swap)
- **Slippage protection** with user-configurable tolerance
- **Real-time price charts** (TradingView lightweight-charts)

### Liquidity
- **Add / remove liquidity** to AMM pools
- **LP share tracking** per user per pool
- **Pool statistics** (TVL, 24h volume, 24h fees, APY)

### Advanced
- **TWAP price oracle** — time-weighted average price recorded after every swap, queryable with custom windows
- **Dynamic fees** — swap fee adjusts based on recent price volatility (5 bps low / 10 bps normal / 30 bps high)
- **Auto-polling daemons** — swap and liquidity daemons continuously poll for new notes every 15s
- **Worker heartbeat** — daemons log a heartbeat every 60s for monitoring

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | React 19, TypeScript, Vite |
| Wallet | `@miden-sdk/miden-wallet-adapter` (browser extension) |
| Blockchain SDK | `@miden-sdk/miden-sdk` 0.13 (WASM) |
| Backend daemons | Rust, Axum, Tokio |
| Miden client | `miden-client` + `miden-protocol` 0.13 |
| Smart contracts | Miden Assembly (MASM) |
| Database | SQLite (daemon state), localStorage (frontend metadata) |
| Charts | lightweight-charts 5.1 |

## Project Structure

```
milo-swap/
├── frontend/                   # React application
│   └── src/
│       ├── pages/              # Home, Trade, Pools, Portfolio, Faucet
│       ├── hooks/              # useP2IDSwap, useLiquidity, usePoolStats, ...
│       ├── lib/                # P2IDSwap, P2IDDeposit, AppWallet, crypto
│       ├── config/             # tokenRegistry, poolConfig, api endpoints
│       └── components/         # Shared UI components
│
├── pool-daemon/                # Rust backend daemons
│   └── src/bin/
│       ├── swap_daemon.rs      # Swap processing, TWAP, dynamic fees, limit orders
│       └── liquidity_daemon.rs # Deposit processing, LP tracking, pool reserves
│
├── faucet-server/              # Testnet token faucet
│   └── src/main.rs             # Mint tokens with rate limiting
│
├── contracts/                  # Miden Assembly smart contracts
│   └── milo-pool/
│       ├── milo-pool.masm      # Pool account contract (receive, swap, deposit, withdraw)
│       ├── SWAP.masm           # Swap note script (AMM calculation on-chain)
│       ├── DEPOSIT.masm        # Deposit note script
│       └── WITHDRAW.masm       # Withdraw note script
│
├── integration/                # Setup and utility scripts (Rust)
│   └── src/bin/                # setup_milo, add_liquidity, swap_tokens, etc.
│
├── pools.json                  # Active pool account IDs
├── proxy-server.js             # CORS proxy for Miden RPC
└── start-all.sh                # Launch all services locally
```

## Tokens

| Symbol | Name | Faucet ID | Decimals |
|--------|------|-----------|----------|
| MILO | Milo Token | `0x6c9dc9f00ccc7e2005a83d7aa307db` | 8 |
| MELO | Melo Token | `0xbde6a12c78fab7205b85d43e59ac81` | 8 |
| MUSDC | Milo USDC | `0x5f97ba94b0d6912053db274d357659` | 8 |
| MIDEN | Miden Network | `0x37d5977a8e16d8205a360820f0230f` | 6 |

## Pools

| Pair | Pool Account ID | Routing |
|------|-----------------|---------|
| MILO / MUSDC | `0x70e4a5ff036fe21004c953d8b7c99c` | Direct |
| MELO / MUSDC | `0x02db2e36774d1f107f406d62dffb74` | Direct |
| MILO / MELO | — | Multi-hop via MUSDC |

## Getting Started

### Prerequisites

- [Rust](https://rustup.rs/) (stable)
- [Node.js](https://nodejs.org/) 18+
- [Miden browser extension wallet](https://docs.miden.io/)

### Local Development

```bash
# 1. Start the CORS proxy (required for Miden RPC from browser)
node proxy-server.js            # :8085

# 2. Start the faucet server
cargo run -p faucet-server --release -- 8084

# 3. Start the swap daemon
cargo run -p pool-daemon --bin swap-daemon --release   # :8080

# 4. Start the liquidity daemon
cargo run -p pool-daemon --bin liquidity-daemon --release  # :8090

# 5. Start the frontend
cd frontend && npm install && npm run dev              # :3000
```

Or use the convenience script:

```bash
./start-all.sh
```

### Production Deployment

The production setup uses Nginx as a reverse proxy:

```nginx
location /api/swap/ {
    proxy_pass http://localhost:8080/;
}
location /api/liquidity/ {
    proxy_pass http://localhost:8090/;
}
location /api/faucet/ {
    proxy_pass http://localhost:8084/;
}
```

The frontend auto-detects the environment and routes API calls accordingly (`localhost` for dev, `/api/*` for production).

## API Reference

### Swap Daemon (`:8080`)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/health` | Health check |
| `POST` | `/track_note` | Register a swap note for processing |
| `POST` | `/consume` | Manually trigger note consumption |
| `GET` | `/tracked_notes` | List tracked swap notes |
| `GET` | `/twap?pool_id=<hex>&window=3600` | TWAP price over time window |
| `GET` | `/price_history?pool_id=<hex>&limit=100` | Recent price points |
| `GET` | `/current_fee?pool_id=<hex>` | Current dynamic fee for pool |
| `POST` | `/limit_order` | Place a limit order |
| `GET` | `/limit_orders?user_id=<hex>` | List user's limit orders |
| `POST` | `/cancel_limit_order` | Cancel a pending limit order |

### Liquidity Daemon (`:8090`)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/health` | Health check |
| `POST` | `/track_note` | Register a deposit note |
| `POST` | `/consume` | Manually trigger note consumption |
| `GET` | `/pool_reserves` | Current reserves for all pools |
| `GET` | `/user_deposits?user_id=<hex>` | User's deposit history |
| `POST` | `/record_trade` | Record trade for volume tracking |
| `GET` | `/trade_volume` | 24h trade volumes |
| `GET` | `/apy` | Pool APY calculations |

### Faucet Server (`:8084`)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/health` | Health check |
| `GET` | `/faucets` | List available faucets |
| `POST` | `/get_tokens` | Claim testnet tokens (rate limited) |

## How Swaps Work

1. **User initiates swap** in the frontend — selects tokens, amount, and slippage tolerance.
2. **Frontend creates a P2ID note** sending the sell token to the pool account, then submits it via the Miden wallet extension.
3. **Frontend calls `/track_note`** on the swap daemon with swap metadata (buy token, min output, user address).
4. **Swap daemon auto-polls** every 15s, finds the consumable note, and matches it with tracked swap info.
5. **Daemon executes an atomic transaction**: consumes the user's input note and creates a P2ID output note back to the user with the calculated swap amount (after dynamic fee).
6. **User's wallet picks up** the output note and the swapped tokens appear in their balance.

## Smart Contracts

The pool contract (`milo-pool.masm`) manages on-chain pool state:

| Storage Slot | Purpose |
|-------------|---------|
| `0x0002` | Asset mapping (token A and B faucet IDs) |
| `0x0003` | Pool state (liabilities, reserve, reserve with slippage) |
| `0x0004` | User deposits / LP shares |
| `0x0005` | Curve parameters |
| `0x0006` | Fee configuration (swap, backstop, protocol) |

Exported functions: `receive_asset`, `move_asset_to_note`, `bounce_asset`, `deposit`, `set_pool_state`, `get_pool_state`.

## ID Reference

All canonical token and pool IDs are maintained in:
- **Frontend:** [`frontend/src/config/tokenRegistry.ts`](frontend/src/config/tokenRegistry.ts)
- **Pools:** [`pools.json`](pools.json)
- **Faucet:** [`faucet-server/src/main.rs`](faucet-server/src/main.rs)

## Links

- [Miden Documentation](https://docs.miden.io/)
- [Miden SDK](https://github.com/0xPolygonMiden/miden-sdk)
- [Miden Testnet Explorer](https://testnet.miden.io/)
