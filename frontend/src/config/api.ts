// API base URLs - automatically detects production vs development
const isDev = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

export const SWAP_DAEMON_URL = isDev ? 'http://localhost:8080' : '/api/swap';
export const LIQUIDITY_DAEMON_URL = isDev ? 'http://localhost:8090' : '/api/liquidity';
export const FAUCET_URL = isDev ? 'http://localhost:8084' : '/api/faucet';
