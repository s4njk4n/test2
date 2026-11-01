'use strict';
// Small shared helpers. Money is always handled as BigInt base units or exact decimal strings,
// never as floating point, so amounts on receipts and in matching are exact.

const crypto = require('node:crypto');

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// "12.5" → 12500000n with 6 decimals. Throws on anything that isn't a plain non-negative decimal.
function parseUnits(str, decimals) {
  const s = String(str).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error('Not a number: ' + str);
  const [i, f = ''] = s.split('.');
  if (f.length > decimals) {
    // round half up at the token's precision
    const keep = f.slice(0, decimals), next = Number(f[decimals]);
    let v = BigInt(i + keep.padEnd(decimals, '0'));
    if (next >= 5) v += 1n;
    return v;
  }
  return BigInt(i + f.padEnd(decimals, '0'));
}

// 12500000n, 6 → "12.5". minFrac pads trailing zeros (e.g. 2 for money).
function formatUnits(value, decimals, minFrac = 0) {
  let v = BigInt(value);
  const neg = v < 0n; if (neg) v = -v;
  const base = 10n ** BigInt(decimals);
  const int = (v / base).toString();
  let frac = decimals ? (v % base).toString().padStart(decimals, '0').replace(/0+$/, '') : '';
  if (frac.length < minFrac) frac = frac.padEnd(minFrac, '0');
  return (neg ? '-' : '') + withCommas(int) + (frac ? '.' + frac : '');
}
function withCommas(intStr) { return intStr.replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
function plain(str) { return String(str).replace(/,/g, ''); }

// Decimal arithmetic on strings via scaled BigInt (scale 18 is plenty for prices and rates).
const SCALE = 18n, ONE = 10n ** SCALE;
const dec = s => parseUnits(String(s), 18);
function decMul(a, b) { return (dec(a) * dec(b)) / ONE; }          // returns scaled BigInt
function decDiv(a, b) { const d = dec(b); if (d === 0n) throw new Error('Divide by zero'); return (dec(a) * ONE) / d; }
function roundDec(scaled, places) {                                   // scaled BigInt → string with `places` decimals, half up
  const f = 10n ** (SCALE - BigInt(places));
  let q = scaled / f; if ((scaled % f) * 2n >= f) q += 1n;
  return plain(formatUnits(q, places, places));
}

// Money for humans: "A$20.00", "20.00 USD", "612.5 XDC".
const FIAT_SYMBOLS = { AUD: 'A$', USD: 'US$', EUR: '€', GBP: '£', NZD: 'NZ$', CAD: 'C$', SGD: 'S$', JPY: '¥', INR: '₹', HKD: 'HK$' };
function money(amountStr, currency) {
  const n = String(amountStr);
  const [i, f = ''] = n.split('.');
  const body = withCommas(i) + '.' + f.padEnd(2, '0');
  if (FIAT_SYMBOLS[currency]) return FIAT_SYMBOLS[currency] + body;
  return body + ' ' + currency;
}

function normAddress(a) {
  if (!a) return null;
  let s = String(a).trim();
  if (/^xdc/i.test(s)) s = '0x' + s.slice(3);
  return /^0x[0-9a-fA-F]{40}$/.test(s) ? s.toLowerCase() : null;
}
const toXdc = a => a ? 'xdc' + a.slice(2) : a;
// Finds an address in a QR payload or pasted text (plain address or payment link).
function extractAddress(text) {
  const m = String(text || '').match(/(?:^|[^0-9a-z])(xdc|0x)([0-9a-f]{40})(?![0-9a-f])/i);
  return m ? '0x' + m[2].toLowerCase() : null;
}
const isTxHash = s => /^0x[0-9a-fA-F]{64}$/.test(String(s || '').trim());

function randomCode(len = 6, alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789') {
  const bytes = crypto.randomBytes(len); let out = '';
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}
const randomInt = (min, max) => crypto.randomInt(min, max + 1);

// Dates in the seller's time zone.
function localParts(ms, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return p;
}
function localDate(ms, tz) { const p = localParts(ms, tz); return `${p.year}-${p.month}-${p.day}`; }
function localDateTime(ms, tz) { const p = localParts(ms, tz); return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`; }
function tzOffset(ms, tz) {                                   // "+11:00"
  const p = localParts(ms, tz);
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  const diff = Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
  const sign = diff >= 0 ? '+' : '-', a = Math.abs(diff);
  return `${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}
function localIso(ms, tz) { const p = localParts(ms, tz); return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${tzOffset(ms, tz)}`; }
function humanDateTime(ms, tz) {
  return new Intl.DateTimeFormat('en-AU', { timeZone: tz, day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(ms));
}
function humanTime(ms, tz) {
  return new Intl.DateTimeFormat('en-AU', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(new Date(ms));
}
function validTimeZone(tz) { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; } }
// Start of the local day containing `ms`, as epoch ms (works across DST).
function startOfLocalDay(ms, tz) {
  const p = localParts(ms, tz);
  const guess = Date.UTC(+p.year, +p.month - 1, +p.day);
  const off = (() => { const o = tzOffset(guess, tz); const s = o[0] === '-' ? -1 : 1; return s * (+o.slice(1, 3) * 60 + +o.slice(4)) * 60000; })();
  let t = guess - off;
  if (localDate(t, tz) !== `${p.year}-${p.month}-${p.day}`) t += (localDate(t, tz) < `${p.year}-${p.month}-${p.day}` ? 3600000 : -3600000);
  return t;
}

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  // Guard against spreadsheet formula injection from customer-supplied text.
  const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d/.test(s) ? "'" + s : s;
  return /[",\n\r]/.test(safe) ? '"' + safe.replace(/"/g, '""') + '"' : safe;
}
const csvRow = arr => arr.map(csvCell).join(',');

const sleep = ms => new Promise(r => setTimeout(r, ms));
function truncate(s, n) { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

module.exports = {
  escapeHtml, parseUnits, formatUnits, withCommas, plain, decMul, decDiv, roundDec, dec, money, FIAT_SYMBOLS,
  normAddress, toXdc, extractAddress, isTxHash, randomCode, randomInt,
  localDate, localDateTime, localIso, humanDateTime, humanTime, validTimeZone, startOfLocalDay, tzOffset,
  csvRow, csvCell, sleep, truncate,
};
