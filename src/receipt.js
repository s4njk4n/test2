'use strict';
// PDF receipt / tax invoice, in the same style as XDC Proof (jsPDF + QR code to verify the payment).
const fs = require('node:fs');
const path = require('node:path');
const { jsPDF } = require('jspdf');
const QRCode = require('qrcode');
const S = require('./db');
const { formatUnits, money, toXdc, localDateTime, tzOffset } = require('./util');

// "98 765 432 109" → "ABN 98 765 432 109", but leave "ABN 98…" or "VAT GB123…" as typed.
const withLabel = (label, id) => (/^[A-Za-z]{2,}/.test(String(id).trim()) ? String(id).trim() : `${label || 'Tax ID'} ${String(id).trim()}`);
const FONT_DIR = process.env.SHOPBOT_FONTS || path.join(__dirname, '..', 'fonts');
const FONT_FILES = { NotoSans: 'NotoSans-Regular.ttf', NotoSansArabic: 'NotoSansArabic-Regular.ttf', NotoSansHebrew: 'NotoSansHebrew-Regular.ttf', NotoSansJP: 'NotoSansJP-Regular.ttf', NotoSansKR: 'NotoSansKR-Regular.ttf', NotoSansSC: 'NotoSansSC-Regular.ttf' };
const fontB64 = {};
function loadFont(fam) {
  if (fontB64[fam] !== undefined) return fontB64[fam];
  try { fontB64[fam] = fs.readFileSync(path.join(FONT_DIR, FONT_FILES[fam])).toString('base64'); } catch { fontB64[fam] = null; }
  return fontB64[fam];
}

const WINANSI_EXTRA = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';
const isWinAnsi = s => [...s].every(ch => { const c = ch.codePointAt(0); return c === 9 || (c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff) || WINANSI_EXTRA.includes(ch); });
const RE_ARABIC = /[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff\ufb50-\ufdff\ufe70-\ufeff]/, RE_HEBREW = /[\u0590-\u05ff\ufb1d-\ufb4f]/;
const RE_KANA = /[぀-ヿ]/, RE_HANGUL = /[가-힯ᄀ-ᇿ]/, RE_CJK = /[㐀-鿿豈-﫿]/;
function familyFor(str) {
  if (isWinAnsi(str)) return 'helvetica';
  if (RE_ARABIC.test(str)) return 'NotoSansArabic';
  if (RE_HEBREW.test(str)) return 'NotoSansHebrew';
  if (RE_KANA.test(str)) return 'NotoSansJP';
  if (RE_HANGUL.test(str)) return 'NotoSansKR';
  if (RE_CJK.test(str)) return 'NotoSansSC';
  return 'NotoSans';
}

class Writer {
  constructor(doc) { this.doc = doc; this.registered = new Set(); }
  // Chooses a font that can draw `str`; characters no available font has become "?".
  fam(str) {
    let f = familyFor(str);
    if (f === 'helvetica') return { f, s: str };
    if (!this.registered.has(f)) {
      const b64 = loadFont(f) || (f !== 'NotoSans' ? loadFont('NotoSans') : null);
      if (!b64) return { f: 'helvetica', s: [...str].map(ch => (isWinAnsi(ch) ? ch : '?')).join('') };
      if (!loadFont(f)) f = 'NotoSans';
      if (!this.registered.has(f)) { this.doc.addFileToVFS(f + '.ttf', loadFont(f)); this.doc.addFont(f + '.ttf', f, 'normal'); this.registered.add(f); }
    }
    const map = this.doc.internal.getFont(f, 'normal')?.metadata?.cmap?.unicode?.codeMap;
    const s = map ? [...str].map(ch => { const c = ch.codePointAt(0); return c <= 0x7e || map[c] ? ch : '?'; }).join('') : str;
    return { f, s };
  }
  text(str, x, y, { size = 10, bold = false, color = [40, 40, 60], align, maxWidth } = {}) {
    const d = this.doc; const { f, s } = this.fam(String(str ?? ''));
    d.setFont(f, bold && f === 'helvetica' ? 'bold' : 'normal'); d.setFontSize(size); d.setTextColor(...color);
    const lines = maxWidth ? d.splitTextToSize(s, maxWidth) : [s];
    lines.forEach((ln, i) => d.text(ln, x, y + i * size * 0.42, align ? { align } : undefined));
    d.setFont('helvetica', 'normal');
    return lines.length * size * 0.42;
  }
}

async function buildReceipt(o) {
  const st = S.all(); const tz = st.timezone || 'UTC';
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const w = new Writer(doc);
  const ink = [33, 30, 70], soft = [110, 110, 130], line = [215, 215, 228];
  const isTaxInvoice = st.tax_enabled && o.tax_amount && st.tax_id;
  const title = isTaxInvoice ? 'Tax invoice' : 'Receipt';
  const cur = o.price_currency;
  const m = v => money(v, cur);

  // Header
  let y = 22;
  const seller = st.business_name || st.shop_name || 'Shop';
  y += w.text(seller, 15, y, { size: 18, bold: true, color: ink, maxWidth: 120 });
  y += 1;
  const sellerLines = [st.business_address, st.tax_id ? withLabel(st.tax_id_label, st.tax_id) : '', st.business_email, st.business_website].filter(Boolean);
  for (const l of sellerLines) y += w.text(l, 15, y + 2, { size: 9.5, color: soft, maxWidth: 120 });
  w.text(title, 195, 22, { size: 20, bold: true, color: ink, align: 'right' });
  w.text('PAID', 195, 30, { size: 11, bold: true, color: [22, 140, 90], align: 'right' });

  // Meta
  y = Math.max(y + 8, 48);
  doc.setDrawColor(...line); doc.line(15, y, 195, y); y += 7;
  const metaLeft = [['Invoice no.', o.invoice_no], ['Order', o.ref], ['Date', `${localDateTime(o.paid_at || o.created_at, tz).slice(0, 16)} (${tz}, UTC${tzOffset(o.paid_at || o.created_at, tz)})`]];
  const billTo = [o.inv_name || o.buyer_name || 'Customer', o.inv_tax_id ? withLabel(st.tax_id_label, o.inv_tax_id) : '', o.inv_address, o.inv_email, o.buyer_username ? '@' + o.buyer_username + ' (Telegram)' : ''].filter(Boolean);
  let ly = y;
  for (const [k, v] of metaLeft) { w.text(k, 15, ly, { size: 9, color: soft }); ly += w.text(v, 42, ly, { size: 9.5, color: ink, maxWidth: 70 }) + 1.5; }
  w.text('Bill to', 120, y, { size: 9, color: soft });
  let ry = y + 4.5;
  for (const b of billTo) ry += w.text(b, 120, ry, { size: 9.5, color: ink, maxWidth: 75 }) + 0.8;
  y = Math.max(ly, ry) + 6;

  // Items table
  doc.setFillColor(244, 243, 251); doc.rect(15, y - 5, 180, 8, 'F');
  w.text('Description', 18, y, { size: 9, bold: true, color: ink });
  w.text('Qty', 125, y, { size: 9, bold: true, color: ink, align: 'right' });
  w.text('Unit price', 160, y, { size: 9, bold: true, color: ink, align: 'right' });
  w.text('Amount', 192, y, { size: 9, bold: true, color: ink, align: 'right' });
  y += 8;
  const h = w.text(o.product_name, 18, y, { size: 10, color: ink, maxWidth: 95 });
  w.text(String(o.qty), 125, y, { size: 10, color: ink, align: 'right' });
  w.text(m(o.unit_price), 160, y, { size: 10, color: ink, align: 'right' });
  w.text(m(o.subtotal), 192, y, { size: 10, color: ink, align: 'right' });
  y += Math.max(h, 5) + 3;
  doc.line(15, y, 195, y); y += 6;

  const row = (label, value, bold = false) => { w.text(label, 160, y, { size: bold ? 11 : 10, bold, color: ink, align: 'right' }); w.text(value, 192, y, { size: bold ? 11 : 10, bold, color: ink, align: 'right' }); y += bold ? 7 : 6; };
  if (o.tax_amount && !o.tax_inclusive) { row('Subtotal', m(o.subtotal)); row(`${o.tax_name} (${o.tax_rate}%)`, m(o.tax_amount)); }
  row(`Total ${cur}`, m(o.total), true);
  if (o.tax_amount && o.tax_inclusive) { w.text(`Total includes ${o.tax_name} of ${m(o.tax_amount)}`, 192, y, { size: 9, color: soft, align: 'right' }); y += 6; }

  // Payment
  y += 6;
  w.text('Payment', 15, y, { size: 12, bold: true, color: ink }); y += 2;
  doc.line(15, y, 195, y); y += 6;
  const amount = `${formatUnits(o.paid_raw || o.amount_raw, o.token_decimals)} ${o.token_symbol}`;
  const rateLine = o.rate && o.rate !== '1' && cur !== o.token_symbol ? `1 ${cur} = ${Number(o.rate).toLocaleString('en-US', { maximumSignificantDigits: 8 })} ${o.token_symbol} at time of order` : '';
  const pay = [['Amount paid', amount], rateLine ? ['Exchange rate', rateLine] : null, ['Network', 'XDC Network (chain 50)'],
    o.token_address ? ['Token contract', toXdc(o.token_address)] : null,
    ['Transaction', o.tx_hash], ['From', o.payer ? toXdc(o.payer) : '—'], ['To', toXdc(st.receiving_address)],
    o.block_number ? ['Block', `${Number(o.block_number).toLocaleString('en-US')}${o.block_time ? ' · ' + localDateTime(o.block_time, tz) : ''}`] : null].filter(Boolean);
  const qrTop = y - 2;
  for (const [k, v] of pay) { w.text(k, 15, y, { size: 9, color: soft }); y += w.text(v, 45, y, { size: 9, color: ink, maxWidth: 104 }) + 1.6; }
  if (o.tx_hash) {
    const url = 'https://xdcscan.com/tx/' + o.tx_hash;
    const png = await QRCode.toDataURL(url, { margin: 1, width: 220 });
    doc.addImage(png, 'PNG', 165, qrTop, 30, 30);
    w.text('Scan to verify payment', 180, qrTop + 34, { size: 7.5, color: soft, align: 'center' });
    y = Math.max(y, qrTop + 38);
  }
  if (o.status === 'refunded') {
    y += 4; w.text(`Refunded${o.refunded_at ? ' on ' + localDateTime(o.refunded_at, tz).slice(0, 10) : ''}${o.refund_tx ? ' · ' + o.refund_tx : ''}`, 15, y, { size: 10, bold: true, color: [190, 60, 60], maxWidth: 180 });
    y += 8;
  }

  // Footer
  let fy = 270;
  if (st.receipt_footer) fy -= w.text(st.receipt_footer, 105, fy - 8, { size: 9, color: soft, align: 'center', maxWidth: 170 });
  if (st.powered_by) w.text('Payment verified on the XDC Network · Made with XDC ShopBot · xdcoutpost.xyz', 105, 285, { size: 7.5, color: [150, 150, 165], align: 'center' });

  return { buffer: Buffer.from(doc.output('arraybuffer')), filename: `${title.replace(/\s/g, '_')}_${o.invoice_no || o.ref}.pdf`, type: 'application/pdf' };
}

module.exports = { buildReceipt };
