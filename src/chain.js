'use strict';
// XDC JSON-RPC access with automatic failover between the configured endpoints.
const settings = require('./db');

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const CHAIN_ID = 50;
let preferred = 0;
const health = { lastOk: 0, lastError: '', lastErrorAt: 0, url: '' };

function urls() {
  const list = settings.get('rpc_urls');
  return (Array.isArray(list) && list.length ? list : ['https://rpc.plugin.global/xdcmainnet']).filter(Boolean);
}

async function rpcAt(url, method, params, timeoutMs = 12000) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'POST', signal: ctrl.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    if (!res.ok) throw new Error(`HTTP ${res.status}${res.status === 429 ? ' (rate limited)' : ''}`);
    const body = await res.json();
    if (body.error) throw new Error(body.error.message || JSON.stringify(body.error));
    return body.result;
  } finally { clearTimeout(t); }
}

async function rpc(method, params = []) {
  const list = urls(); let lastErr;
  for (let i = 0; i < list.length; i++) {
    const idx = (preferred + i) % list.length;
    try {
      const r = await rpcAt(list[idx], method, params);
      preferred = idx; health.lastOk = Date.now(); health.url = list[idx];
      return r;
    } catch (e) { lastErr = e; }
  }
  health.lastError = `${method}: ${lastErr?.message || lastErr}`; health.lastErrorAt = Date.now();
  throw new Error(health.lastError);
}

const hexToBig = h => BigInt(h);
const toHex = n => '0x' + BigInt(n).toString(16);
const blockNumber = async () => Number(await rpc('eth_blockNumber'));
const getBlock = (n, full = false) => rpc('eth_getBlockByNumber', [toHex(n), full]);
const getLogs = filter => rpc('eth_getLogs', [filter]);
const getTx = hash => rpc('eth_getTransactionByHash', [hash]);
const getReceipt = hash => rpc('eth_getTransactionReceipt', [hash]);
const ethCall = (to, data) => rpc('eth_call', [{ to, data }, 'latest']);

const blockTimes = new Map();
async function blockTime(n) {
  if (blockTimes.has(n)) return blockTimes.get(n);
  const b = await getBlock(n, false);
  const t = b ? Number(b.timestamp) * 1000 : Date.now();
  blockTimes.set(n, t);
  if (blockTimes.size > 2000) blockTimes.delete(blockTimes.keys().next().value);
  return t;
}

// ABI string/bytes32 decoding for name() and symbol()
function decodeString(hex) {
  if (!hex || hex === '0x') return null;
  const h = hex.slice(2);
  if (h.length === 64) return Buffer.from(h, 'hex').toString('utf8').replace(/\0+$/, '') || null;   // bytes32 style
  try {
    const off = Number(BigInt('0x' + h.slice(0, 64))) * 2;
    const len = Number(BigInt('0x' + h.slice(off, off + 64)));
    return Buffer.from(h.slice(off + 64, off + 64 + len * 2), 'hex').toString('utf8');
  } catch { return null; }
}
// Reads an XRC-20 token's name, symbol and decimals straight from the chain.
async function readToken(address) {
  const [name, symbol, decimals] = await Promise.all([
    ethCall(address, '0x06fdde03').then(decodeString).catch(() => null),
    ethCall(address, '0x95d89b41').then(decodeString).catch(() => null),
    ethCall(address, '0x313ce567').then(h => (h && h !== '0x' ? Number(BigInt(h)) : null)).catch(() => null),
  ]);
  if (decimals === null || !symbol || decimals > 36) return null;
  return { name: (name || symbol).slice(0, 40), symbol: symbol.replace(/[^\p{L}\p{N}._-]/gu, '').slice(0, 12) || 'TOKEN', decimals };
}

async function chainId() { return Number(await rpc('eth_chainId')); }

// Decodes Transfer logs and native transfers into a common shape.
function parseTransferLog(log) {
  return {
    tx_hash: log.transactionHash.toLowerCase(), log_index: Number(log.logIndex),
    token_address: log.address.toLowerCase(),
    from: '0x' + log.topics[1].slice(26).toLowerCase(), to: '0x' + log.topics[2].slice(26).toLowerCase(),
    amount_raw: hexToBig(log.data && log.data !== '0x' ? log.data.slice(0, 66) : '0x0').toString(),
    block_number: Number(log.blockNumber),
  };
}
const addrTopic = a => '0x' + '0'.repeat(24) + a.slice(2).toLowerCase();

module.exports = { rpc, rpcAt, blockNumber, getBlock, getLogs, getTx, getReceipt, ethCall, blockTime, readToken, chainId, parseTransferLog, addrTopic, TRANSFER_TOPIC, CHAIN_ID, health, toHex, urls };
