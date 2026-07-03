// Claude copywriting for the POD pipeline: design drafting + Etsy listing SEO.
// Flat fetch calls, no SDK. Key from ANTHROPIC_API_KEY (env or .env); never printed.

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');

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

async function claude(system, user, schema, maxTokens) {
  const key = loadKey('ANTHROPIC_API_KEY');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-opus-4-8',
      max_tokens: maxTokens,
      thinking: { type: 'adaptive' },
      output_config: { format: { type: 'json_schema', schema } },
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Claude API error ${res.status}: ${JSON.stringify(json)}`);
  if (json.stop_reason === 'refusal') throw new Error('Claude declined the request (stop_reason: refusal).');
  const text = json.content.find(b => b.type === 'text');
  if (!text) throw new Error('No text block in Claude response.');
  return JSON.parse(text.text);
}

const DESIGNS_SCHEMA = {
  type: 'object',
  properties: {
    designs: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          slug: { type: 'string', description: 'kebab-case id, e.g. "pay-yourself-first"' },
          quote_lines: {
            type: 'array',
            items: { type: 'string', description: 'One short line, MAX 22 characters' },
            description: 'The design text, split into 1-3 short lines (never more than 3) of max 22 chars each',
          },
          subline: { type: 'string', description: 'Small accent line under the quote (max 36 chars), or empty string' },
          caption: { type: 'string', description: 'Social caption for promoting this product later' },
        },
        required: ['slug', 'quote_lines', 'subline', 'caption'],
        additionalProperties: false,
      },
    },
  },
  required: ['designs'],
  additionalProperties: false,
};

async function claudeDraftDesigns(count, existing) {
  const brandVoice = fs.readFileSync(path.join(REPO, 'brand-voice.md'), 'utf8');
  const out = await claude(
    `You write original typography designs for Thrive Richly merch (shirts, hoodies, mugs). Follow this brand voice document, especially its Red lines:\n\n${brandVoice}`,
    `Write exactly ${count} merch designs. What SELLS in text merch (in priority order — mix the batch across these):
1. INSIDER HUMOR for the boring-investing tribe — inside jokes only index-fund/FIRE people get. The wearer signals "I'm one of us" with a smirk.
2. MONEY PUNS & WORDPLAY — genuinely clever puns sell year after year. Must land on first read.
3. ANTI-HUSTLE SARCASM — dry humor puncturing get-rich-quick culture ("my portfolio is boring and so am I" energy).
4. GIFTABLE WHOLESOME — something you'd gift a spouse/dad/friend who's good with money.
NEVER: earnest aspirational statements (they read as trying and do not sell), advice sentences, motivational-poster energy.
Rules: every line is YOUR original phrasing — never a quote by a famous person, never an attribution. Funny beats profound. No income claims, no specific dollar amounts, no emoji, no hashtags in quote_lines. quote_lines: 1-3 lines, max 22 characters per line, punchy. subline: optional tiny accent (e.g. "THRIVE RICHLY" or a dry 2-4 word punchline), or "". Avoid these existing designs: ${JSON.stringify(existing)}`,
    DESIGNS_SCHEMA,
    8000,
  );
  return out.designs;
}

const ETSY_SEO_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Etsy listing title, MAX 120 characters, comma-separated buyer-intent keyword phrases, most important first' },
    description: { type: 'string', description: 'Full Etsy listing description' },
    tags: { type: 'array', items: { type: 'string', description: 'One Etsy tag, MAX 20 characters, lowercase' }, description: 'Exactly 13 tags' },
  },
  required: ['title', 'description', 'tags'],
  additionalProperties: false,
};

async function claudeEtsySeo(design) {
  return claude(
    'You are an expert Etsy SEO copywriter for print-on-demand listings. You write titles, descriptions and tags that match what buyers actually type into Etsy search. You never use trademarked phrases, brand names you do not own, or claims you cannot back.',
    `Design text: "${design.quote_lines.join(' ')}"${design.subline ? ` (accent line: "${design.subline}")` : ''}.
It is a dry-humor personal-finance/investing design sold on shirts, mugs and stickers under the Thrive Richly brand.
Write:
- title: MAX 120 characters, comma-separated keyword phrases buyers search (humor + finance + gift angles, e.g. funny finance shirt, accountant gift, investor gift for him her). No emoji, no ALL CAPS words.
- description: 3 short paragraphs — (1) the joke and who it's for, (2) gift occasions it fits (birthday, Father's Day, coworker, graduation), (3) quality/care note ("printed on demand, check size chart"). Natural keyword use, no stuffing.
- tags: exactly 13, each MAX 20 characters including spaces, lowercase, no duplicates, mix of humor/finance/gift/recipient terms.`,
    ETSY_SEO_SCHEMA,
    4000,
  );
}

module.exports = { loadKey, claudeDraftDesigns, claudeEtsySeo };
