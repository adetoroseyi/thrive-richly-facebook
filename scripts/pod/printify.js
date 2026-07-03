#!/usr/bin/env node
// Printify API client — flat, no dependencies (Node 20+, built-in fetch).
// Endpoints verified against https://developers.printify.com/openapi.json
//
// Usage:
//   node printify.js check          # verify token + list shops
//
// The token is read from PRINTIFY_API_TOKEN (process env first, then .env in the
// repo root, then ../.env). The token value is never printed or logged.

const fs = require('fs');
const path = require('path');

const BASE = 'https://api.printify.com';

function loadToken() {
  if (process.env.PRINTIFY_API_TOKEN && process.env.PRINTIFY_API_TOKEN.trim()) {
    return process.env.PRINTIFY_API_TOKEN.trim();
  }
  const candidates = [
    path.join(__dirname, '..', '..', '.env'),
    path.join(__dirname, '..', '..', '..', '.env'),
  ];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*PRINTIFY_API_TOKEN\s*=\s*(.+)\s*$/);
      if (m && m[1].trim()) return m[1].trim().replace(/^["']|["']$/g, '');
    }
  }
  console.error('PRINTIFY_API_TOKEN is not set. Add it to your .env or shell environment (do not paste it into chat), then re-run.');
  process.exit(1);
}

async function api(method, route, body) {
  const token = loadToken();
  // Printify rate-limits aggressively (e.g. publish: 200/30min). On 429, wait
  // and retry instead of failing the item — long runs graze the limit routinely.
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(BASE + route, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'User-Agent': 'thrive-richly-pod',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
    if (res.status === 429 && attempt <= 5) {
      const waitS = 70 * attempt;
      console.log(`  rate-limited (429) on ${method} ${route} — waiting ${waitS}s (attempt ${attempt}/5)`);
      await new Promise(r => setTimeout(r, waitS * 1000));
      continue;
    }
    if (!res.ok) {
      const err = new Error(`Printify API error ${res.status} on ${method} ${route}: ${JSON.stringify(json)}`);
      err.status = res.status;
      throw err;
    }
    return json;
  }
}

// Returns the shop to publish into. Prefers the Pop-Up storefront if several exist.
async function getShop() {
  const shops = await api('GET', '/v1/shops.json');
  if (!Array.isArray(shops) || shops.length === 0) {
    throw new Error('No Printify shops found on this account. Create the Pop-Up Store first.');
  }
  const popup = shops.find(s => /pop|storefront/i.test(s.sales_channel || ''));
  return popup || shops[0];
}

async function main() {
  const cmd = process.argv[2];
  if (cmd === 'check') {
    const shops = await api('GET', '/v1/shops.json');
    console.log('Token accepted. Shops on this account:');
    for (const s of shops) console.log(`  id=${s.id}  title="${s.title}"  channel=${s.sales_channel}`);
    return;
  }
  console.error('Unknown command. Available: check');
  process.exit(1);
}

if (require.main === module) {
  main().catch(e => { console.error(e.message || e); process.exit(1); });
}

module.exports = { api, loadToken, getShop };
