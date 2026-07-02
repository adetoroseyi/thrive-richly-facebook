# thrive-richly-facebook
Automated daily motivational quote posting to Thrive Richly Facebook Page

## thrive-social — AI social media manager (Blotato)

A Claude Code skill that drafts on-brand content (Reels-first), generates video via the Blotato API, publishes with human approval, and logs every post with its live URL. It is additive — the existing workflows above are untouched.

**Invoke locally:** open a Claude Code session in this repo folder and run `/thrive-social` (skill lives at `.claude/skills/thrive-social/SKILL.md`).

**Invoke via GitHub Actions (queue mode — no Claude in CI):** posts are pre-drafted and human-approved into `scripts/thrive-social/post-queue.json` during a local session. Actions tab → "Thrive Social (Blotato queue runner)" → Run workflow publishes the next approved entry (rendering the Reel video at publish time). The cron schedule stays commented out in `.github/workflows/thrive-social.yml` until 10 posts have published cleanly; then uncomment it for 3×/week autopilot.

**API key:** set `BLOTATO_API_KEY` as an environment variable or in a local `.env` (never committed — see `.gitignore`). For Actions, add the repo secret `BLOTATO_API_KEY` (the only secret needed). A missing key fails loudly; the key value is never printed or logged.

**Approval / dry-run flow:** every post is dry-run first (`scripts/thrive-social/blotato.js publish ... --dry-run` shows the exact payload). Until `published-log.jsonl` contains 10 published posts, every live publish requires explicit human approval of the exact caption + visual.

**Log:** `published-log.jsonl` is append-only, one JSON line per published post: `timestamp`, `format`, `hook`, `caption`, `mediaUrl`, `postSubmissionId`, `publicUrl`, `status`.

**Voice:** `brand-voice.md` is the single source of voice truth — edit it to change how every post sounds.

## Burst Reels — fresh-content layer (Remotion + Blotato)

On-demand batches of fresh Reels: Claude drafts scripts at run time (so content reflects the current date and recent posts), Pexels supplies licensed b-roll, Google TTS voices it, Remotion renders 1080x1920 video free on the GitHub runner, and Blotato schedules 5-10 posts staggered across the day (9:00/12:00/15:00/18:00/21:00 UTC).

**Fan-out:** every reel (burst and queue) publishes to all four connected accounts — Facebook, Instagram (@thrive.richly), TikTok (@thrive.richly), and YouTube Shorts. Link/text posts stay Facebook-only. Platform account ids and per-platform target fields live in `scripts/thrive-social/blotato.js` (`PLATFORMS`).

**Invoke:** Actions tab → "Burst Reels" → Run workflow. `mode: draft` prints the scripts and captions without rendering or publishing (review first); `mode: publish` runs the full pipeline. Locally: `node scripts/burst/generate-burst.js --mode draft --count 5`.

**Secrets required:** `ANTHROPIC_API_KEY`, `PEXELS_API_KEY` (free at pexels.com/api), `GOOGLE_TTS_API_KEY`, `BLOTATO_API_KEY`. Scheduled posts are logged to `published-log.jsonl` with `status: "scheduled"`; Blotato publishes them at their slot times even with everything switched off.
