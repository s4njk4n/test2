'use strict';
// Per-user conversation state (what the bot is waiting for the user to type next).
const { db } = require('./db');

function get(userId) {
  const r = db.prepare('SELECT state, data, updated_at FROM sessions WHERE user_id = ?').get(userId);
  if (!r || !r.state) return { state: null, data: {} };
  if (Date.now() - r.updated_at > 60 * 60_000) return { state: null, data: {} };   // forget stale prompts after an hour
  try { return { state: r.state, data: JSON.parse(r.data || '{}') }; } catch { return { state: r.state, data: {} }; }
}
function set(userId, state, data = {}) {
  db.prepare('INSERT INTO sessions(user_id, state, data, updated_at) VALUES (?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET state=excluded.state, data=excluded.data, updated_at=excluded.updated_at')
    .run(userId, state, JSON.stringify(data), Date.now());
}
const clear = userId => db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);

module.exports = { get, set, clear };
