'use strict';
// Loads KEY=value pairs from the .env file next to the app (created by setup, readable only by its owner).
const fs = require('node:fs');
const path = require('node:path');
const ENV_PATH = process.env.SHOPBOT_ENV || path.join(__dirname, '..', '.env');

function load() {
  try {
    for (const line of fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
    }
  } catch {}
}
function write(values) {
  const cur = {};
  try { for (const line of fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/)) { const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line); if (m) cur[m[1]] = m[2]; } } catch {}
  Object.assign(cur, values);
  fs.writeFileSync(ENV_PATH, Object.entries(cur).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 });
  try { fs.chmodSync(ENV_PATH, 0o600); } catch {}
}
load();
module.exports = { load, write, ENV_PATH };
