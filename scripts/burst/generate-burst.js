#!/usr/bin/env node
// Burst layer — fresh-content Reels: Claude drafts scripts at run time, Pexels
// provides licensed b-roll, Google TTS voices them, Remotion renders (free on the
// GitHub runner), Blotato publishes with staggered scheduled times across the day.
//
// Usage:
//   node scripts/burst/generate-burst.js --mode draft [--count 5]    # scripts + captions only, nothing rendered/published
//   node scripts/burst/generate-burst.js --mode publish [--count 5]  # full pipeline, schedules N reels via Blotato
//
// Required env (or .env): ANTHROPIC_API_KEY, PEXELS_API_KEY, GOOGLE_TTS_API_KEY, BLOTATO_API_KEY.
// Key values are never printed.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { api: blotato, appendLog, sleep, PLATFORMS } = require('../thrive-social/blotato.js');

const REPO = path.join(__dirname, '..', '..');
const REMOTION_DIR = path.join(REPO, 'remotion-burst');
const ASSETS_DIR = path.join(REMOTION_DIR, 'public', 'assets');
const OUT_DIR = path.join(REMOTION_DIR, 'out');
const LOG_FILE = path.join(REPO, 'published-log.jsonl');
const SLOT_HOURS_UTC = [9, 12, 15, 18, 21];

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : fallback;
}

function loadKey(name) {
  if (process.env[name] && process.env[name].trim()) return process.env[name].trim();
  for (const file of [path.join(REPO, '.env'), path.join(REPO, '..', '.env')]) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(new RegExp(`^\\s*${name}\\s*=\\s*(.+)\\s*$`));
      if (m && m[1].trim()) return m[1].trim().replace(/^["']|["']$/g, '');
    }
  }
  console.error(`${name} is not set. Add it to your environment or .env (do not paste it into chat), then re-run.`);
  process.exit(1);
}

const POSTS_SCHEMA = {
  type: 'object',
  properties: {
    posts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          hook: { type: 'string', description: 'First line of the caption; must work alone' },
          caption: { type: 'string', description: 'Full Facebook caption incl. hook, per the caption skeleton' },
          scenes: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                voiceover: { type: 'string', description: '1-2 spoken sentences for this scene' },
                broll_query: { type: 'string', description: 'Short stock-video search phrase, visual nouns only, e.g. "city sunrise timelapse"' },
              },
              required: ['voiceover', 'broll_query'],
              additionalProperties: false,
            },
          },
        },
        required: ['hook', 'caption', 'scenes'],
        additionalProperties: false,
      },
    },
  },
  required: ['posts'],
  additionalProperties: false,
};

async function claudeDraftPosts(count) {
  const key = loadKey('ANTHROPIC_API_KEY');
  const brandVoice = fs.readFileSync(path.join(REPO, 'brand-voice.md'), 'utf8');
  const recentHooks = fs.existsSync(LOG_FILE)
    ? fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').filter(Boolean).slice(-15)
        .map((l) => { try { return JSON.parse(l).hook; } catch { return null; } })
        .filter(Boolean)
    : [];

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-opus-4-8',
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      output_config: { format: { type: 'json_schema', schema: POSTS_SCHEMA } },
      system: `You are the social media manager for the Thrive Richly Facebook page. You draft short-form Reels (voiceover + stock b-roll). Follow this brand voice document exactly, especially its Red lines:\n\n${brandVoice}`,
      messages: [{
        role: 'user',
        content: `Today's date is ${new Date().toISOString().slice(0, 10)}. Draft exactly ${count} reach-focused Reels (no links, no product pitch — pure value). Each reel: exactly 4 scenes; each scene has a voiceover of 1-2 short spoken sentences (the four voiceovers together must flow as one 25-45 second script: hook, build, payoff, close) and a broll_query of concrete visual nouns for stock-footage search. Captions follow the caption skeleton from the brand voice doc. Every number must be real and verifiable math or omitted. Vary the archetypes; avoid repeating these recent hooks: ${JSON.stringify(recentHooks)}`,
      }],
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Claude API error ${res.status}: ${JSON.stringify(json)}`);
  if (json.stop_reason === 'refusal') throw new Error('Claude declined the drafting request (stop_reason: refusal).');
  const text = json.content.find((b) => b.type === 'text');
  if (!text) throw new Error('No text block in Claude response: ' + JSON.stringify(json.content.map((b) => b.type)));
  return JSON.parse(text.text).posts;
}

async function pexelsClip(query, dest) {
  const key = loadKey('PEXELS_API_KEY');
  const res = await fetch(
    `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&orientation=portrait&size=medium&per_page=5`,
    { headers: { Authorization: key } },
  );
  if (!res.ok) throw new Error(`Pexels error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  for (const video of data.videos || []) {
    const files = (video.video_files || [])
      .filter((f) => f.height > f.width && f.height >= 1280 && f.height <= 2560)
      .sort((a, b) => a.height - b.height);
    if (files.length === 0) continue;
    const dl = await fetch(files[0].link);
    if (!dl.ok) continue;
    fs.writeFileSync(dest, Buffer.from(await dl.arrayBuffer()));
    return true;
  }
  console.log(`  (no portrait b-roll found for "${query}" — scene will use a solid background)`);
  return false;
}

async function tts(text, dest) {
  const key = loadKey('GOOGLE_TTS_API_KEY');
  const res = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${key}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      input: { text },
      voice: { languageCode: 'en-US', name: 'en-US-Neural2-D' },
      audioConfig: { audioEncoding: 'MP3', speakingRate: 1.0 },
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Google TTS error ${res.status}: ${JSON.stringify(json)}`);
  fs.writeFileSync(dest, Buffer.from(json.audioContent, 'base64'));
}

function renderReel(postIndex, scenes) {
  const props = {
    scenes: scenes.map((s) => ({
      video: s.hasVideo ? `assets/p${postIndex}s${s.index}.mp4` : '',
      audio: `assets/p${postIndex}s${s.index}.mp3`,
      text: s.voiceover,
    })),
    sceneDurations: scenes.map(() => 3), // replaced by calculateMetadata at render time
  };
  const propsPath = path.join(REMOTION_DIR, `props-p${postIndex}.json`);
  fs.writeFileSync(propsPath, JSON.stringify(props));
  const outPath = path.join(OUT_DIR, `reel-${postIndex}.mp4`);
  execFileSync('npx', ['remotion', 'render', 'BurstReel', outPath, `--props=${propsPath}`], {
    cwd: REMOTION_DIR,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  return outPath;
}

async function blotatoUpload(filePath) {
  const created = await blotato('POST', '/v2/media/uploads', {
    filename: path.basename(filePath),
    mimeType: 'video/mp4',
  });
  const put = await fetch(created.presignedUrl, {
    method: 'PUT',
    headers: { 'content-type': 'video/mp4' },
    body: fs.readFileSync(filePath),
  });
  if (!put.ok) throw new Error(`Presigned upload failed ${put.status}: ${await put.text()}`);
  return created.publicUrl;
}

function scheduleTimes(count) {
  const times = [];
  const now = Date.now() + 10 * 60 * 1000; // nothing sooner than 10 min out
  let day = 0;
  while (times.length < count) {
    for (const h of SLOT_HOURS_UTC) {
      if (times.length >= count) break;
      const t = new Date();
      t.setUTCDate(t.getUTCDate() + day);
      t.setUTCHours(h, 0, 0, 0);
      if (t.getTime() > now) times.push(t.toISOString());
    }
    day++;
  }
  return times;
}

async function schedulePost(platformKey, post, mediaUrl, scheduledTime) {
  const p = PLATFORMS[platformKey];
  const created = await blotato('POST', '/v2/posts', {
    post: {
      accountId: p.accountId,
      content: { text: post.caption, platform: platformKey, mediaUrls: [mediaUrl] },
      target: p.reelTarget(post.hook),
    },
    scheduledTime,
  });
  return created.postSubmissionId || created.id;
}

async function main() {
  const mode = arg('--mode', 'draft');
  const count = parseInt(arg('--count', '5'), 10);

  console.log(`Burst run: mode=${mode} count=${count}`);
  const posts = await claudeDraftPosts(count);
  console.log(`Claude drafted ${posts.length} reels:`);
  posts.forEach((p, i) => {
    console.log(`\n===== Reel ${i + 1} =====`);
    console.log(`Hook: ${p.hook}`);
    console.log(`Caption:\n${p.caption}`);
    p.scenes.forEach((s, j) => console.log(`  Scene ${j + 1}: [${s.broll_query}] "${s.voiceover}"`));
  });

  if (mode !== 'publish') {
    console.log('\nDRAFT MODE — nothing rendered, uploaded, or scheduled.');
    return;
  }

  fs.mkdirSync(ASSETS_DIR, { recursive: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const times = scheduleTimes(posts.length);

  for (let i = 0; i < posts.length; i++) {
    const post = posts[i];
    console.log(`\n--- Building reel ${i + 1}/${posts.length} ---`);
    const scenes = [];
    for (let j = 0; j < post.scenes.length; j++) {
      const s = post.scenes[j];
      const hasVideo = await pexelsClip(s.broll_query, path.join(ASSETS_DIR, `p${i}s${j}.mp4`));
      await tts(s.voiceover, path.join(ASSETS_DIR, `p${i}s${j}.mp3`));
      scenes.push({ index: j, voiceover: s.voiceover, hasVideo });
    }
    const outPath = renderReel(i, scenes);
    console.log(`Rendered: ${outPath}`);
    const mediaUrl = await blotatoUpload(outPath);
    console.log(`Uploaded to Blotato: ${mediaUrl}`);
    // Fan out to every connected platform. One platform failing must not stop
    // the others — record the failure in the log and keep going.
    for (const platformKey of Object.keys(PLATFORMS)) {
      const logEntry = {
        timestamp: new Date().toISOString(),
        format: 'reel',
        source: 'burst',
        platform: platformKey,
        hook: post.hook,
        caption: post.caption,
        mediaUrl,
        postSubmissionId: null,
        scheduledTime: times[i],
        publicUrl: null,
        status: 'scheduled',
      };
      try {
        logEntry.postSubmissionId = await schedulePost(platformKey, post, mediaUrl, times[i]);
        console.log(`  ${platformKey}: scheduled for ${times[i]} (postSubmissionId=${logEntry.postSubmissionId})`);
      } catch (err) {
        logEntry.status = 'schedule-failed';
        logEntry.error = String(err.message || err);
        console.error(`  ${platformKey}: scheduling FAILED — ${logEntry.error}`);
      }
      appendLog(logEntry);
      await sleep(2000); // stay under Blotato rate limits
    }
  }
  console.log(`\nDone: ${posts.length} reels scheduled across ${times[0]} … ${times[times.length - 1]}.`);
  console.log('Live URLs appear once Facebook publishes each one; check with: node scripts/thrive-social/blotato.js post-status <id>');
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
