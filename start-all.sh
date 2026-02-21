#!/bin/bash
# Start all services for Milo Swap development

# Create logs directory if it doesn't exist
mkdir -p logs

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Function to check if a port is in use
check_port() {
    if lsof -i:$1 > /dev/null 2>&1; then
        echo -e "${YELLOW}⚠️  Port $1 is already in use${NC}"
        return 1
    fi
    return 0
}

# Check required ports
echo "📦 Checking ports..."

if check_port 8085; then
    echo "✅ Port 8085 (RPC Proxy): Free"
else
    echo -e "${RED}❌ Please stop the existing service on port 8085${NC}"
    exit 1
fi

if check_port 8084; then
    echo "✅ Port 8084 (Faucet): Free"
else
    echo -e "${YELLOW}⚠️  Port 8084 is in use (faucet-server may already be running)${NC}"
fi

if check_port 3000; then
    echo "✅ Port 3000 (Frontend): Free"
else
    echo -e "${YELLOW}⚠️  Port 3000 is in use (frontend may already be running)${NC}"
fi

echo ""
echo "📋 Starting services..."
echo ""

# Start proxy server in background
echo -e "${GREEN}🔧 Starting RPC Proxy Server on port 8085...${NC}"
node proxy-server.js > logs/proxy.log 2>&1 &
PROXY_PID=$!
echo "   Proxy PID: $PROXY_PID"

# Wait for proxy to start
sleep 2

# Check if proxy started successfully
if ps -p $PROXY_PID > /dev/null 2>&1; then
    echo -e "   ${GREEN}✅ Proxy server started${NC}"
else
    echo -e "   ${RED}❌ Failed to start proxy server${NC}"
    cat logs/proxy.log 2>/dev/null || true
    exit 1
fi

echo ""
echo -e "${GREEN}🎉 All services started!${NC}"
echo ""
echo "📝 Services:"
echo "   • RPC Proxy:  http://localhost:8085"
echo "   • Faucet:    http://localhost:8084"
echo "   • Frontend:  http://localhost:3000"
echo ""
echo "📝 Logs:"
echo "   • Proxy:  tail -f logs/proxy.log"
echo ""
echo "🛑 To stop all services:"
echo "   kill $PROXY_PID"
echo ""

# Keep script running for Ctrl+C handling
trap "echo '🛑 Stopping services...'; kill $PROXY_PID 2>/dev/null; exit" INT
wait
