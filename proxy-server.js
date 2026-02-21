#!/usr/bin/env node
/**
 * CORS Proxy Server for Miden RPC
 * Proxies gRPC-web requests to rpc.testnet.miden.io via HTTP/1.1
 *
 * Usage: node proxy-server.js [port]
 * Default port: 8085
 */

const http = require('http');
const https = require('https');
const url = require('url');

const PORT = process.argv[2] || 8085;
const RPC_TARGET = 'rpc.testnet.miden.io';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-grpc-web, x-user-agent, grpc-timeout',
  'Access-Control-Expose-Headers': 'grpc-status, grpc-message, grpc-status-details-bin',
  'Access-Control-Max-Age': '86400',
};

// Headers to strip before forwarding upstream
const STRIP_HEADERS = new Set([
  'host', 'connection', 'keep-alive', 'upgrade',
  'transfer-encoding', 'te', 'trailer', 'proxy-connection',
  'accept', 'accept-encoding', 'accept-language',
]);

function handleRequest(req, res) {
  const parsedUrl = url.parse(req.url, true);

  // OPTIONS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  // Health check
  if (parsedUrl.pathname === '/health') {
    res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', proxy: 'miden-rpc-proxy' }));
    return;
  }

  // Proxy RPC via HTTPS/1.1 upstream
  if (parsedUrl.pathname.startsWith('/rpc') || parsedUrl.pathname === '/') {
    const targetPath = parsedUrl.pathname === '/' ? '/rpc.Api/SyncState' : parsedUrl.pathname;
    console.log(`📡 Proxying: ${req.method} https://${RPC_TARGET}${targetPath}`);

    // Buffer request body
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);

      // Build upstream headers
      const upstreamHeaders = {
        'Content-Type': req.headers['content-type'] || 'application/grpc-web+proto',
        'Content-Length': body.length,
      };

      // Forward x-grpc-web and other relevant headers
      for (const [key, value] of Object.entries(req.headers)) {
        const lk = key.toLowerCase();
        if (!STRIP_HEADERS.has(lk) && !lk.startsWith('access-control-')) {
          upstreamHeaders[key] = value;
        }
      }

      const options = {
        hostname: RPC_TARGET,
        port: 443,
        path: targetPath,
        method: req.method,
        headers: upstreamHeaders,
        rejectUnauthorized: false,
      };

      const proxyReq = https.request(options, (proxyRes) => {
        // Build response headers with CORS
        const responseHeaders = { ...CORS_HEADERS };
        for (const [key, value] of Object.entries(proxyRes.headers)) {
          const lk = key.toLowerCase();
          // Don't duplicate CORS headers, keep upstream grpc headers
          if (!lk.startsWith('access-control-')) {
            responseHeaders[key] = value;
          }
        }

        res.writeHead(proxyRes.statusCode, responseHeaders);
        proxyRes.pipe(res);
      });

      proxyReq.on('error', (err) => {
        console.error('❌ Upstream error:', err.message);
        res.writeHead(502, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Proxy error', message: err.message }));
      });

      proxyReq.end(body);
    });
    return;
  }

  // 404
  res.writeHead(404, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found', path: parsedUrl.pathname }));
}

const server = http.createServer(handleRequest);

server.listen(PORT, () => {
  console.log(`
🚀 Miden RPC Proxy Server Started
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📡 Proxy Target: https://${RPC_TARGET}
🌐 Local URL:   http://localhost:${PORT}/rpc.Api/...

Usage Examples:
  - SyncState:   http://localhost:${PORT}/rpc.Api/SyncState
  - GetAccount:  http://localhost:${PORT}/rpc.Api/GetAccount
  - Health:      http://localhost:${PORT}/health

⚠️  Note: This proxy adds CORS headers and handles SSL for browser access
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  `);
});

server.on('error', (error) => {
  console.error('❌ Server error:', error.message);
  process.exit(1);
});

process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down proxy server...');
  server.close(() => {
    console.log('👋 Proxy server stopped');
    process.exit(0);
  });
});
