#!/bin/sh
set -e

# Clear ready flag from previous container runs
rm -f /tmp/ready

# Ensure we are inside apps/integrity-domain
DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"

echo "[hardhat-node] Starting Hardhat node on 0.0.0.0:8545..."
npx hardhat node --hostname 0.0.0.0 &
NODE_PID=$!

echo "[hardhat-node] Waiting for JSON-RPC node to be ready..."
until node -e 'fetch("http://127.0.0.1:8545", {method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({jsonrpc:"2.0",method:"eth_blockNumber",params:[],id:1})}).then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))' 2>/dev/null; do
  sleep 0.5
done
echo "[hardhat-node] JSON-RPC node is active and healthy!"

echo "[hardhat-node] Deploying MerkleAnchorRegistry..."
npx hardhat ignition deploy ignition/modules/MerkleAnchorRegistry.ts --network localhost --reset

echo "[hardhat-node] Exporting deployments to contracts-shared..."
npx hardhat export-deployments

echo "[hardhat-node] Ready! Local node is running and contracts are deployed."
touch /tmp/ready

# Handle SIGINT and SIGTERM gracefully
trap "kill -TERM $NODE_PID 2>/dev/null || true; exit 0" INT TERM

wait $NODE_PID
