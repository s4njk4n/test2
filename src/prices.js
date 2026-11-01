'use strict';
// Converts a price in the shop's currency into an amount of a given token.
// Pegged stablecoins (AUDD = 1 AUD, USDC = 1 USD) and fixed rates need no price feed when the
// currencies line up; everything else uses CoinGecko with CryptoCompare as a fallback.
const settings = require('./db');
const { decMul, decDiv, roundDec } = require('./util');

const CG = (process.env.PRICE_API_COINGECKO || 'https://api.coingecko.com/api/v3').replace(/\/$/, '');
const CC = (process.env.PRICE_API_CRYPTOCOMPARE || 'https://min-api.cryptocompare.com').replace(/\/$/, '');
const FIATS = ['AUD', 'USD', 'EUR', 'GBP', 'NZD', 'CAD', 'SGD', 'JPY', 'INR', 'HKD', 'CHF'];
const CACHE_MS = 60_000;
let cache = { at: 0, key: '', data: null };

const num = x => { const n = Number(x); if (!isFinite(n) || n <= 0) throw new Error('bad price'); return n.toPrecision(15).replace(/\.?0+$/, '').replace(/e.*$/, '') ; };
const toDecStr = n => { const s = Number(n).toFixed(18); return s.replace(/\.?0+$/, '') || '0'; };

async function getJson(url) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 10000);
  try { const r = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json' } }); if (!r.ok) throw new Error('HTTP ' + r.status); return await r.json(); }
  finally { clearTimeout(t); }
}

// Returns { usd: { 'XDC': '0.03', 'FIAT:AUD': '0.65', 'cg:<id>': ..., 'ca:<addr>': ... } } — USD value of one unit.
async function fetchUsdValues(tokens) {
  const ids = new Set(['xdce-crowd-sale', 'usd-coin']);
  const contracts = new Set();
  for (const t of tokens) if (t.rate_mode === 'market') { if (t.coingecko_id) ids.add(t.coingecko_id); else if (t.address) contracts.add(t.address); }
  const key = [...ids, ...contracts].sort().join(',');
  if (cache.data && cache.key === key && Date.now() - cache.at < CACHE_MS) return cache.data;

  const vs = FIATS.map(f => f.toLowerCase()).join(',');
  const out = {};
  try {
    const p = await getJson(`${CG}/simple/price?ids=${[...ids].join(',')}&vs_currencies=${vs}`);
    const usdc = p['usd-coin'];
    if (!usdc || !usdc.usd) throw new Error('no usd-coin');
    for (const f of FIATS) if (usdc[f.toLowerCase()]) out['FIAT:' + f] = toDecStr(usdc.usd / usdc[f.toLowerCase()]);
    out['FIAT:USD'] = '1';
    for (const id of ids) if (p[id]?.usd) out['cg:' + id] = toDecStr(p[id].usd);
    if (contracts.size) {
      try {
        const tp = await getJson(`${CG}/simple/token_price/xdc-network?contract_addresses=${[...contracts].join(',')}&vs_currencies=usd`);
        for (const [a, v] of Object.entries(tp)) if (v.usd) out['ca:' + a.toLowerCase()] = toDecStr(v.usd);
      } catch {}
    }
  } catch (e) {
    // Fallback: CryptoCompare (XDC and fiat cross rates only)
    const p = await getJson(`${CC}/data/pricemulti?fsyms=XDC,USDC&tsyms=${FIATS.join(',')}`);
    if (!p.USDC || !p.USDC.USD) throw new Error('Price feeds unavailable');
    for (const f of FIATS) if (p.USDC[f]) out['FIAT:' + f] = toDecStr(p.USDC.USD / p.USDC[f]);
    out['FIAT:USD'] = '1';
    if (p.XDC?.USD) out['cg:xdce-crowd-sale'] = toDecStr(p.XDC.USD);
    out['cg:usd-coin'] = toDecStr(p.USDC.USD);
  }
  cache = { at: Date.now(), key, data: out };
  return out;
}

function usdOfCurrency(code, v) {
  if (code === 'XDC') return v['cg:xdce-crowd-sale'];
  return v['FIAT:' + code];
}
function usdOfToken(t, v) {
  if (t.rate_mode === 'peg') return v['FIAT:' + t.peg_currency];
  if (t.rate_mode === 'market') return t.coingecko_id ? v['cg:' + t.coingecko_id] : v['ca:' + t.address];
  return null;
}

// Does converting `priceCurrency` → token need a live price feed?
function needsFeed(token, priceCurrency) {
  if (token.rate_mode === 'fixed') return false;
  if (token.rate_mode === 'peg' && token.peg_currency === priceCurrency) return false;
  if (!token.address && priceCurrency === 'XDC') return false;
  return true;
}

// Returns the token amount (decimal string, rounded to 4 places or the token's decimals) for `price` in `priceCurrency`,
// plus the rate used (tokens per 1 unit of the price currency).
async function quote(price, priceCurrency, token) {
  let rate;
  if (token.rate_mode === 'fixed') rate = token.fixed_rate;
  else if (!needsFeed(token, priceCurrency)) rate = '1';
  else {
    const v = await fetchUsdValues([token]);
    const a = usdOfCurrency(priceCurrency, v), b = usdOfToken(token, v);
    if (!a || !b) throw new Error(`No exchange rate available for ${token.symbol} in ${priceCurrency}.`);
    rate = roundDec(decDiv(a, b), 12);
  }
  const places = Math.min(4, token.decimals);
  const amount = roundDec(decMul(price, rate), places);
  if (Number(amount) <= 0) throw new Error('Price too small to pay in ' + token.symbol);
  return { amount, rate };
}

// Can the CoinGecko feed price this contract? Used when adding a custom token.
async function marketPriceForContract(address) {
  try { const v = await fetchUsdValues([{ rate_mode: 'market', address }]); return v['ca:' + address] || null; } catch { return null; }
}

// Live USD price for a CoinGecko coin ID (e.g. "plugin"), or null if CoinGecko doesn't know it.
async function priceForCoingeckoId(id) {
  try { const v = await fetchUsdValues([{ rate_mode: 'market', coingecko_id: id }]); return v['cg:' + id] || null; } catch { return null; }
}
// Accepts "plugin" or a full CoinGecko page URL and returns the coin ID.
function parseCoingeckoId(text) {
  const t = String(text || '').trim();
  const m = /coingecko\.com\/(?:[a-z-]+\/)?coins\/([a-z0-9-]+)/i.exec(t);
  const id = (m ? m[1] : t).toLowerCase();
  return /^[a-z0-9-]{2,80}$/.test(id) ? id : null;
}
// "A$20.00 → ≈ 6,612.5 PLI" style example used to confirm a token's rate looks right.
async function example(token, priceCurrency, price = '20') {
  try { const q = await quote(price, priceCurrency, token); return { ok: true, amount: q.amount }; }
  catch (e) { return { ok: false, error: e.message }; }
}

module.exports = { quote, priceForCoingeckoId, parseCoingeckoId, example, needsFeed, marketPriceForContract, FIATS, fetchUsdValues, _reset: () => { cache = { at: 0, key: '', data: null }; } };
