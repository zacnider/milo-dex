# Milo Swap

A privacy AMM DEX built on [Miden](https://miden.xyz/) — a zk-rollup where transaction proofs are generated client-side.

**Live:** [https://milodex.xyz](https://milodex.xyz)

## Features

- **Token Swaps** — Swap between MILO, MELO & MUSDC with on-chain AMM pricing
- **Liquidity Pools** — Provide liquidity and track your positions
- **Token Faucet** — Claim testnet tokens (10 per token per day)
- **Portfolio** — View balances, deposits & pool positions
- **Privacy by Default** — All proofs generated locally in your browser via WASM

## Architecture

```
┌─────────────────────────────────────────────────┐
│                   Frontend                       │
│         React + Miden WASM Client                │
│        (client-side zk-proof generation)         │
└──────────┬──────────┬──────────┬────────────────┘
           │          │          │
     /api/swap   /api/liquidity  /api/faucet
           │          │          │
    ┌──────┴──┐ ┌─────┴───┐ ┌───┴──────┐
    │  Swap   │ │Liquidity│ │  Faucet  │
    │ Daemon  │ │ Daemon  │ │  Daemon  │
    │ :8080   │ │  :8090  │ │  :8084   │
    └────┬────┘ └────┬────┘ └────┬─────┘
         │           │           │
         └───────────┴───────────┘
                     │
           Miden Testnet RPC
```

### Tech Stack

- **Frontend:** React, TypeScript, Vite, Miden WASM Client
- **Backend:** Rust, axum, Miden Client SDK
- **Protocol:** P2ID (Pay-to-ID) note pattern for all token transfers
- **Infra:** Nginx reverse proxy, Let's Encrypt SSL, systemd

## Getting Started

### Prerequisites

- [Rust](https://rustup.rs/) (1.75+)
- [Node.js](https://nodejs.org/) (20+)
- [Miden Wallet](https://chromewebstore.google.com/detail/miden-wallet/ablmompanofnodfdkgchkpmphailefpb) browser extension

### Development Setup

```bash
# 1. Build daemons
cargo build --release --bin swap-daemon --bin liquidity-daemon
cargo build --release -p milo-faucet-server

# 2. Start daemons (each in a separate terminal)
cd pool-daemon && ../target/release/swap-daemon
cd pool-daemon && ../target/release/liquidity-daemon
./target/release/milo-faucet-server 8084

# 3. Start frontend
cd frontend && npm install && npm run dev
```

### Services

| Service | Port | Description |
|---------|------|-------------|
| Swap Daemon | 8080 | Handles token swap transactions |
| Liquidity Daemon | 8090 | Manages liquidity deposits & withdrawals |
| Faucet Daemon | 8084 | Mints testnet tokens to users |
| Frontend | 3000 | React SPA  |

## Token & Pool Configuration

### Tokens

| Token | Faucet ID | Decimals |
|-------|-----------|----------|
| MILO | `0x5e8e88146824a4200e2b18de0ad670` | 0 |
| MELO | `0x0ebc079b56cc3920659055ebd56a96` | 0 |
| MUSDC | `0xee34300f31693c207ab206c064b421` | 0 |
| MIDEN | `0x54bf4e12ef20082070758b022456c7` | 6 |

### Pools

| Pool | Pool Account ID |
|------|-----------------|
| MILO/MUSDC | `0x9f9200bc043df1104b0015778f1ff0` |
| MELO/MUSDC | `0x257f686cd6cf6f1061921936ad9f75` |

## Project Structure

```
milo-swap/
├── Cargo.toml                # Rust workspace root
├── frontend/                 # React frontend
│   └── src/
│       ├── config/api.ts     # API URL configuration (dev/prod)
│       ├── tokenRegistry.ts  # Token metadata & faucet IDs
│       ├── pages/            # Swap, Pools, Portfolio, Faucet pages
│       ├── hooks/            # useSwap, useLiquidity, usePoolStats
│       └── faucetClient.ts   # Faucet API client with PoW
├── pool-daemon/              # Swap & Liquidity daemons
│   └── src/bin/
│       ├── swap_daemon.rs    # Token swap engine
│       └── liquidity_daemon.rs # Liquidity management
├── faucet-server/            # Token faucet daemon
│   └── src/
│       ├── main.rs           # Faucet server with rate limiting
│       └── faucet_ids.rs     # Faucet account ID constants
├── contracts/                # MASM smart contracts
├── integration/              # Setup & integration scripts
└── public/                   # Static contract files
```

## How It Works

1. **Connect** your Miden Wallet browser extension
2. **Claim** testnet tokens from the Faucet tab
3. **Swap** tokens — your browser generates a zk-proof, creates a P2ID note, and the daemon consumes it
4. **Provide Liquidity** — deposit both tokens to a pool and track your position
5. **Withdraw** — remove your deposited liquidity proportionally

All transactions use Miden's note-based model. Every swap and deposit creates a P2ID (Pay-to-ID) note that is proven locally and submitted to the network.

## Deployment

The app is deployed at [milodex.xyz](https://milodex.xyz) with:

- Nginx serving the static frontend + reverse proxying API routes
- Three systemd services for the Rust daemons
- Let's Encrypt SSL certificate (auto-renewal)

## License

MIT
