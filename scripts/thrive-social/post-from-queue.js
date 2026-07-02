#!/usr/bin/env node
// thrive-social queue runner — no Claude, no dependencies. Needs only BLOTATO_API_KEY.
// Posts the next approved entry from post-queue.json: generates the video if the
// entry is a reel, publishes via Blotato, appends published-log.jsonl, and marks
// the entry posted. Run with --dry-run to print what would happen without any API calls.
//
// The queue is refilled locally with the thrive-social Claude skill; every entry
// must have "approved": true (set only after a human approved the exact caption) —
// this runner refuses to publish anything else.

const fs = require('fs');
const path = require('path');
const { api, appendLog, sleep, PAGE_ID, PLATFORMS } = require('./blotato.js');

const QUEUE_FILE = path.join(__dirname, 'post-queue.json');
const DRY_RUN = process.argv.includes('--dry-run');

function saveQueue(queue) {
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2) + '\n', 'utf8');
}

async function generateReelVideo(entry) {
  const created = await api('POST', '/v2/videos/from-templates', {
    templateId: entry.templateId,
    inputs: entry.videoInputs,
    render: true,
  });
  const inner = created.item || created;
  const creationId = inner.id || inner.creationId;
  if (!creationId) throw new Error('No creation id in response: ' + JSON.stringify(created));
  console.log(`Video creation started: ${creationId}`);
  let transientErrors = 0;
  for (let i = 0; i < 120; i++) {          // up to ~30 min
    await sleep(15000);
    let s;
    try {
      const raw = await api('GET', `/v2/videos/creations/${creationId}`);
      s = raw.item || raw;
      transientErrors = 0;
    } catch (err) {
      // Blotato occasionally 500s mid-render (e.g. storage bad gateway). Tolerate
      // transient errors and keep polling; only give up if they persist.
      transientErrors++;
      console.log(`  [${new Date().toISOString()}] transient poll error (${transientErrors}/10): ${err.message}`);
      if (transientErrors >= 10) throw err;
      continue;
    }
    console.log(`  [${new Date().toISOString()}] video status=${s.status}`);
    if (s.status === 'done') return s.mediaUrl;
    if (/failed/.test(s.status) || s.status === 'insufficient-credits') {
      throw new Error(`Video generation failed: ${s.status} ${s.error || ''}`);
    }
  }
  throw new Error('Timed out waiting for video generation.');
}

async function main() {
  const queue = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
  const entry = queue.posts.find(p => p.status === 'queued' && p.approved === true);
  if (!entry) {
    const unapproved = queue.posts.filter(p => p.status === 'queued' && !p.approved).length;
    console.log(`No approved queued posts (${unapproved} awaiting approval). Refill the queue locally with the thrive-social skill.`);
    return;
  }

  console.log(`Next post: queueId=${entry.id} format=${entry.format}`);
  console.log('--- caption ---');
  console.log(entry.caption);
  console.log('---------------');

  if (DRY_RUN) {
    console.log('DRY RUN — no video generated, nothing published.');
    return;
  }

  try {
    let mediaUrl = entry.mediaUrl || null;
    if (entry.format === 'reel' && !mediaUrl) {
      mediaUrl = await generateReelVideo(entry);
      console.log(`mediaUrl: ${mediaUrl}`);
    }

    // Reels fan out to every connected platform; link/text posts stay Facebook-only
    // (a link in an Instagram/TikTok caption is not clickable — pointless there).
    const isReel = entry.format === 'reel';
    const platformKeys = isReel ? Object.keys(PLATFORMS) : ['facebook'];
    const results = [];
    for (const key of platformKeys) {
      const p = PLATFORMS[key];
      let target;
      if (isReel) {
        target = p.reelTarget(entry.caption.split('\n')[0]);
      } else {
        target = { targetType: 'facebook', pageId: PAGE_ID };
        if (entry.link) target.link = entry.link;
      }
      try {
        const created = await api('POST', '/v2/posts', {
          post: {
            accountId: p.accountId,
            content: { text: entry.caption, platform: key, mediaUrls: mediaUrl ? [mediaUrl] : [] },
            target,
          },
        });
        results.push({ platform: key, postSubmissionId: created.postSubmissionId || created.id });
        console.log(`  ${key}: submitted (postSubmissionId=${results[results.length - 1].postSubmissionId})`);
      } catch (err) {
        results.push({ platform: key, error: String(err.message || err) });
        console.error(`  ${key}: submit FAILED — ${err.message}`);
      }
      await sleep(2000);
    }
    if (results.every(r => r.error)) {
      throw new Error('All platform submissions failed: ' + JSON.stringify(results));
    }

    // Poll only the Facebook submission for the live URL (it drives the approval
    // ramp count); other platforms are logged as submitted with their ids.
    const fb = results.find(r => r.platform === 'facebook' && r.postSubmissionId);
    let publicUrl = null, finalStatus = 'in-progress', pollErrors = 0;
    if (fb) {
      for (let i = 0; i < 40; i++) {          // up to ~10 min
        await sleep(15000);
        let s;
        try {
          s = await api('GET', `/v2/posts/${fb.postSubmissionId}`);
          pollErrors = 0;
        } catch (err) {
          pollErrors++;
          console.log(`  [${new Date().toISOString()}] transient poll error (${pollErrors}/10): ${err.message}`);
          if (pollErrors >= 10) throw err;
          continue;
        }
        console.log(`  [${new Date().toISOString()}] facebook post status=${s.status}`);
        if (s.status === 'published') { finalStatus = 'published'; publicUrl = s.publicUrl; break; }
        if (s.status === 'failed') throw new Error(`Facebook publish failed: ${s.errorMessage || 'no error message'}`);
      }
    }

    for (const r of results) {
      appendLog({
        timestamp: new Date().toISOString(),
        format: entry.format,
        platform: r.platform,
        hook: entry.caption.split('\n')[0],
        caption: entry.caption,
        mediaUrl,
        postSubmissionId: r.postSubmissionId || null,
        publicUrl: r.platform === 'facebook' ? publicUrl : null,
        status: r.error ? 'submit-failed' : (r.platform === 'facebook' ? finalStatus : 'submitted'),
        error: r.error,
        queueId: entry.id,
      });
    }
    entry.status = 'posted';
    entry.postedAt = new Date().toISOString();
    entry.publicUrl = publicUrl;
    entry.platforms = results;
    saveQueue(queue);
    console.log(publicUrl ? `LIVE URL: ${publicUrl}` : 'Accepted — check per-platform status with: blotato.js post-status <id>');
  } catch (err) {
    // Mark failed so a broken entry never blocks the queue or re-posts on the next run.
    entry.status = 'failed';
    entry.error = String(err.message || err);
    saveQueue(queue);
    throw err;
  }
}

main().catch(e => { console.error(e.message || e); process.exit(1); });
