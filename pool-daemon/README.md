# Pool Daemon Servers

Pool daemon servers handle note consumption for Milo Swap pools. These daemons run in the background and process DEPOSIT and SWAP notes sent to pool accounts.

## Architecture

The frontend creates custom notes with MASM scripts:
- **DEPOSIT notes** - Sent when users add liquidity
- **SWAP notes** - Sent when users perform token swaps

These notes need to be executed from the pool's perspective (consuming tokens, updating reserves, issuing LP tokens or swapped tokens back). The daemons handle this process.

## Components

### Swap Daemon (Port 8080)
Processes SWAP notes for token swaps.

**Endpoints:**
- `GET /health` - Health check
- `POST /track_note` - Track a new SWAP note
- `POST /consume` - Consume all tracked SWAP notes
- `GET /tracked_notes` - List tracked notes

### Liquidity Daemon (Port 8090)
Processes DEPOSIT notes for liquidity additions.

**Endpoints:**
- `GET /health` - Health check
- `POST /track_note` - Track a new DEPOSIT note
- `POST /consume_note` - Consume all tracked DEPOSIT notes
- `GET /tracked_notes` - List tracked notes

## Running the Daemons

### Build
```bash
cargo build --release --bin swap-daemon --bin liquidity-daemon
```

### Start Swap Daemon
```bash
./target/release/swap-daemon
```

### Start Liquidity Daemon
```bash
./target/release/liquidity-daemon
```

### Run Both in Background
```bash
# Swap daemon
./target/release/swap-daemon > swap-daemon.log 2>&1 &

# Liquidity daemon
./target/release/liquidity-daemon > liquidity-daemon.log 2>&1 &
```

## Frontend Integration

The frontend automatically calls these endpoints:

### For Liquidity Addition:
1. User creates DEPOSIT note via Extension Wallet
2. Frontend calls `POST http://localhost:8090/track_note`
3. After transaction commits, frontend calls `POST http://localhost:8090/consume_note`
4. Daemon consumes note from pool's perspective
5. Pool issues LP tokens back to user

### For Swaps:
1. User creates SWAP note via Extension Wallet
2. Frontend calls `POST http://localhost:8080/track_note`
3. After transaction commits, frontend calls `POST http://localhost:8080/consume`
4. Daemon consumes note from pool's perspective
5. Pool issues swapped tokens back to user

## Dependencies

The daemons require:
- `pools.json` - Pool account IDs (in project root)
- `integration/keystore` - Pool account keys
- `integration/store.sqlite3` - Synced blockchain state

## Troubleshooting

### Check if daemons are running
```bash
curl http://localhost:8080/health
curl http://localhost:8090/health
```

### View daemon logs
```bash
tail -f swap-daemon.log
tail -f liquidity-daemon.log
```

### Stop daemons
```bash
pkill swap-daemon
pkill liquidity-daemon
```

### Check tracked notes
```bash
curl http://localhost:8080/tracked_notes
curl http://localhost:8090/tracked_notes
```

## Development

The daemons use a worker thread pattern to handle the !Send MidenClient:
- Main thread runs the Axum HTTP server
- Worker thread owns the MidenClient
- Communication via channels (mpsc + oneshot)

This avoids the "Handler not Send" error when using async handlers with !Send types.
