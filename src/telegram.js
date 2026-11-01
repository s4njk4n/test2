'use strict';
// Minimal Telegram Bot API client. JSON for normal calls, multipart for file uploads.
const API = (process.env.TELEGRAM_API || 'https://api.telegram.org').replace(/\/$/, '');
let TOKEN = process.env.BOT_TOKEN || '';
const setToken = t => { TOKEN = t; };

class TgError extends Error { constructor(desc, code, params) { super(desc); this.code = code; this.params = params; } }

async function call(method, params = {}, { timeoutMs = 40000, tries = 3 } = {}) {
  for (let attempt = 1; ; attempt++) {
    const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const isForm = params instanceof FormData;
      const res = await fetch(`${API}/bot${TOKEN}/${method}`, {
        method: 'POST', signal: ctrl.signal,
        headers: isForm ? undefined : { 'content-type': 'application/json' },
        body: isForm ? params : JSON.stringify(params),
      });
      const body = await res.json().catch(() => ({ ok: false, description: 'Bad response ' + res.status }));
      if (body.ok) return body.result;
      if (body.error_code === 429 && attempt < tries) { await new Promise(r => setTimeout(r, ((body.parameters?.retry_after) || 2) * 1000)); continue; }
      throw new TgError(body.description || 'Telegram error', body.error_code, body.parameters);
    } catch (e) {
      if (e instanceof TgError) throw e;
      if (attempt >= tries) throw new TgError('Network error talking to Telegram: ' + (e.message || e), 0);
      await new Promise(r => setTimeout(r, 1000 * attempt));
    } finally { clearTimeout(timer); }
  }
}

const kb = rows => ({ inline_keyboard: rows.filter(Boolean).map(r => r.filter(Boolean)) });
const btn = (text, data) => ({ text, callback_data: data });
const urlBtn = (text, url) => ({ text, url });
const copyBtn = (text, copy) => ({ text, copy_text: { text: String(copy) } });

function send(chatId, text, { keyboard, html = true, preview = false, replyTo } = {}) {
  const p = { chat_id: chatId, text, link_preview_options: { is_disabled: !preview } };
  if (html) p.parse_mode = 'HTML';
  if (keyboard) p.reply_markup = keyboard;
  if (replyTo) p.reply_parameters = { message_id: replyTo, allow_sending_without_reply: true };
  return call('sendMessage', p);
}
async function edit(chatId, messageId, text, { keyboard, html = true } = {}) {
  try {
    return await call('editMessageText', { chat_id: chatId, message_id: messageId, text, parse_mode: html ? 'HTML' : undefined, reply_markup: keyboard || { inline_keyboard: [] }, link_preview_options: { is_disabled: true } });
  } catch (e) { if (/not modified/i.test(e.message)) return null; throw e; }
}
async function editCaption(chatId, messageId, caption, keyboard) {
  try { return await call('editMessageCaption', { chat_id: chatId, message_id: messageId, caption, parse_mode: 'HTML', reply_markup: keyboard || { inline_keyboard: [] } }); }
  catch (e) { if (/not modified/i.test(e.message)) return null; throw e; }
}
function answer(callbackId, text, alert = false) { return call('answerCallbackQuery', { callback_query_id: callbackId, text, show_alert: alert }).catch(() => {}); }

function form(fields) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue;
    if (v && v.buffer instanceof Buffer) f.append(k, new Blob([v.buffer], { type: v.type || 'application/octet-stream' }), v.filename);
    else f.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  return f;
}
function sendPhoto(chatId, photo, caption, keyboard) {   // photo: file_id string or { buffer, filename }
  if (typeof photo === 'string') return call('sendPhoto', { chat_id: chatId, photo, caption, parse_mode: 'HTML', reply_markup: keyboard });
  return call('sendPhoto', form({ chat_id: chatId, photo, caption, parse_mode: 'HTML', reply_markup: keyboard }), { timeoutMs: 60000 });
}
function sendDocument(chatId, doc, caption, keyboard) {   // doc: file_id string or { buffer, filename, type }
  if (typeof doc === 'string') return call('sendDocument', { chat_id: chatId, document: doc, caption, parse_mode: 'HTML', reply_markup: keyboard });
  return call('sendDocument', form({ chat_id: chatId, document: doc, caption, parse_mode: 'HTML', reply_markup: keyboard }), { timeoutMs: 120000 });
}
async function downloadFile(fileId, maxBytes = 5 * 1024 * 1024) {
  const f = await call('getFile', { file_id: fileId });
  if (f.file_size && f.file_size > maxBytes) throw new Error('File is too large.');
  const res = await fetch(`${API}/file/bot${TOKEN}/${f.file_path}`);
  if (!res.ok) throw new Error('Download failed: ' + res.status);
  return Buffer.from(await res.arrayBuffer());
}
const getUpdates = (offset, timeout = 30) => call('getUpdates', { offset, timeout, allowed_updates: ['message', 'callback_query'] }, { timeoutMs: (timeout + 15) * 1000, tries: 1 });
const getMe = () => call('getMe', {}, { tries: 2, timeoutMs: 15000 });
const setCommands = (commands, scope) => call('setMyCommands', { commands, scope }).catch(() => {});

module.exports = { call, send, edit, editCaption, answer, sendPhoto, sendDocument, downloadFile, getUpdates, getMe, setCommands, kb, btn, urlBtn, copyBtn, setToken, TgError };
