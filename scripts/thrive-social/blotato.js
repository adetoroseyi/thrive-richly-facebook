#!/usr/bin/env node
// thrive-social Blotato CLI — flat, no dependencies (Node 20+, built-in fetch).
// Endpoints per https://help.blotato.com/api/openapi-reference/publishing
//            and https://help.blotato.com/api/openapi-reference/video
//
// Usage:
//   node blotato.js check
//   node blotato.js templates [searchTerm]
//   node blotato.js video <templateId> <inputs.json> [--wait]
//   node blotato.js video-status <creationId>
//   node blotato.js upload <mediaUrl>
//   node blotato.js publish --caption-file <file> [--media <blotatoUrl>] [--reel] [--link <url>] [--dry-run]
//   node blotato.js post-status <postSubmissionId>
//
// The API key is read from BLOTATO_API_KEY (process env first, then .env in the
// repo root, then ../.env). The key value is never printed or logged.

const fs = require('fs');
const path = require('path');

const BASE = 'https://backend.blotato.com';
const ACCOUNT_ID = '39401';              // Blotato Facebook account (Oluwaseyi Adetoro)
const PAGE_ID = '216309642249176';       // Facebook Page: Thrive Richly
const LOG_FILE = path.join(__dirname, '..', '..', 'published-log.jsonl');

// YouTube titles are capped at 100 chars; derive one from the hook.
function youtubeTitle(hook) {
  const clean = (hook || 'Money habits that quietly build wealth').replace(/\s+/g, ' ').trim();
  return clean.length <= 95 ? clean : clean.slice(0, 92).trimEnd() + '...';
}

// Every connected Thrive Richly account (Blotato account ids from list-accounts).
// Reels fan out to all four; link/text posts stay Facebook-only.
// reelTarget(hook) returns the platform-specific target object for POST /v2/posts.
const PLATFORMS = {
  facebook: {
    accountId: ACCOUNT_ID,
    reelTarget: () => ({ targetType: 'facebook', pageId: PAGE_ID, mediaType: 'reel' }),
  },
  instagram: {
    accountId: '56571',                  // @thrive.richly
    reelTarget: () => ({ targetType: 'instagram', mediaType: 'reel' }),
  },
  tiktok: {
    accountId: '49190',                  // @thrive.richly
    reelTarget: () => ({
      targetType: 'tiktok',
      privacyLevel: 'PUBLIC_TO_EVERYONE',
      disabledComments: false,
      disabledDuet: false,
      disabledStitch: false,
      isBrandedContent: false,
      isYourBrand: true,
      isAiGenerated: true,               // honest: AI voiceover/imagery
    }),
  },
  youtube: {
    accountId: '42081',                  // Thrive Richly channel (verified 2026-07-02)
    reelTarget: (hook) => ({
      targetType: 'youtube',
      title: youtubeTitle(hook),
      privacyStatus: 'public',
      shouldNotifySubscribers: false,
    }),
  },
};

function loadApiKey() {
  if (process.env.BLOTATO_API_KEY && process.env.BLOTATO_API_KEY.trim()) {
    return process.env.BLOTATO_API_KEY.trim();
  }
  const candidates = [
    path.join(__dirname, '..', '..', '.env'),
    path.join(__dirname, '..', '..', '..', '.env'),
  ];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*BLOTATO_API_KEY\s*=\s*(.+)\s*$/);
      if (m && m[1].trim()) return m[1].trim().replace(/^["']|["']$/g, '');
    }
  }
  console.error('BLOTATO_API_KEY is not set. Add it to your .env or shell environment (do not paste it into chat), then re-run.');
  process.exit(1);
}

async function api(method, route, body) {
  const key = loadApiKey();
  const res = await fetch(BASE + route, {
    method,
    headers: { 'blotato-api-key': key, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) {
    const err = new Error(`Blotato API error ${res.status} on ${method} ${route}: ${JSON.stringify(json)}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : undefined;
}
function has(flag) { return process.argv.includes(flag); }

function appendLog(entry) {
  fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n', 'utf8');
  console.log(`Logged to ${path.relative(process.cwd(), LOG_FILE)}`);
}

async function main() {
  const cmd = process.argv[2];

  if (cmd === 'check') {
    loadApiKey();
    const t = await api('GET', '/v2/videos/templates');
    const count = Array.isArray(t) ? t.length : (t.items ? t.items.length : '?');
    console.log(`API key loaded from environment and accepted by Blotato. ${count} video templates available.`);
    return;
  }

  if (cmd === 'templates') {
    const search = process.argv[3];
    const route = search ? `/v2/videos/templates?search=${encodeURIComponent(search)}` : '/v2/videos/templates';
    const t = await api('GET', route);
    const list = Array.isArray(t) ? t : (t.items || []);
    for (const tpl of list) {
      console.log(`${tpl.id}  ${tpl.name || tpl.title || ''}`);
    }
    console.log(`(${list.length} templates)`);
    return;
  }

  if (cmd === 'video') {
    const templateId = process.argv[3];
    const inputsFile = process.argv[4];
    if (!templateId || !inputsFile) { console.error('Usage: video <templateId> <inputs.json> [--wait]'); process.exit(1); }
    const inputs = JSON.parse(fs.readFileSync(inputsFile, 'utf8'));
    const created = await api('POST', '/v2/videos/from-templates', {
      templateId, inputs, render: true,
    });
    const inner = created.item || created.video || created.creation || created;
    const creationId = inner.id || inner.creationId || inner.videoId;
    if (!creationId) {
      console.error('Could not find creation id in API response:');
      console.error(JSON.stringify(created, null, 2));
      process.exit(1);
    }
    console.log(`Video creation started: id=${creationId} status=${inner.status || 'unknown'}`);
    if (!has('--wait')) return;
    for (let i = 0; i < 120; i++) {          // up to ~30 min
      await sleep(15000);
      const raw = await api('GET', `/v2/videos/creations/${creationId}`);
      const s = raw.item || raw;
      console.log(`  [${new Date().toISOString()}] status=${s.status}`);
      if (s.status === 'done') { console.log(`mediaUrl: ${s.mediaUrl}`); return; }
      if (s.status && s.status.includes('failed') || s.status === 'insufficient-credits') {
        console.error(`Video generation failed: ${s.status} ${s.error || ''}`); process.exit(1);
      }
    }
    console.error('Timed out waiting for video. Check later with: video-status ' + creationId);
    process.exit(1);
  }

  if (cmd === 'video-status') {
    const s = await api('GET', `/v2/videos/creations/${process.argv[3]}`);
    console.log(JSON.stringify(s, null, 2));
    return;
  }

  if (cmd === 'upload') {
    const r = await api('POST', '/v2/media', { url: process.argv[3] });
    console.log(`Blotato media URL: ${r.url}`);
    return;
  }

  if (cmd === 'publish') {
    const captionFile = arg('--caption-file');
    if (!captionFile) { console.error('publish requires --caption-file <file>'); process.exit(1); }
    const text = fs.readFileSync(captionFile, 'utf8').trim();
    const media = arg('--media');
    const isReel = has('--reel');
    const link = arg('--link');

    const target = { targetType: 'facebook', pageId: PAGE_ID };
    if (isReel) target.mediaType = 'reel';
    if (link) target.link = link;

    const payload = {
      post: {
        accountId: ACCOUNT_ID,
        content: {
          text,
          platform: 'facebook',
          mediaUrls: media ? [media] : [],
        },
        target,
      },
    };

    if (has('--dry-run')) {
      console.log('DRY RUN — nothing was published. Exact payload that would be sent to POST /v2/posts:');
      console.log(JSON.stringify(payload, null, 2));
      return;
    }

    const created = await api('POST', '/v2/posts', payload);
    const id = created.postSubmissionId || created.id;
    console.log(`Post submitted: postSubmissionId=${id}`);

    let finalStatus = 'in-progress', publicUrl = null;
    for (let i = 0; i < 40; i++) {           // up to ~10 min
      await sleep(15000);
      const s = await api('GET', `/v2/posts/${id}`);
      console.log(`  [${new Date().toISOString()}] status=${s.status}`);
      if (s.status === 'published') { finalStatus = 'published'; publicUrl = s.publicUrl; break; }
      if (s.status === 'failed') { console.error(`Publish failed: ${s.errorMessage || 'no error message'}`); process.exit(1); }
    }

    appendLog({
      timestamp: new Date().toISOString(),
      format: isReel ? 'reel' : (media ? 'image' : 'text'),
      hook: text.split('\n')[0],
      caption: text,
      mediaUrl: media || null,
      postSubmissionId: id,
      publicUrl,
      status: finalStatus,
    });
    if (publicUrl) console.log(`LIVE URL: ${publicUrl}`);
    else console.log('Post accepted but still processing — check later with: post-status ' + id);
    return;
  }

  if (cmd === 'post-status') {
    const s = await api('GET', `/v2/posts/${process.argv[3]}`);
    console.log(JSON.stringify(s, null, 2));
    return;
  }

  console.error('Unknown command. See usage at the top of this file.');
  process.exit(1);
}

if (require.main === module) {
  main().catch(e => { console.error(e.message || e); process.exit(1); });
}

module.exports = { api, loadApiKey, appendLog, sleep, ACCOUNT_ID, PAGE_ID, LOG_FILE, PLATFORMS, youtubeTitle };
