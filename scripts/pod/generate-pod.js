#!/usr/bin/env node
// POD pipeline — Claude drafts original typography designs, code renders print
// files, Printify creates + publishes products to the Thrive Richly Pop-Up Store.
//
// Usage:
//   node scripts/pod/generate-pod.js --mode draft [--count 4]
//     Drafts designs with Claude, renders preview PNGs into pod-designs/previews/,
//     appends entries (approved: false) to design-queue.json. Nothing touches Printify.
//   node scripts/pod/generate-pod.js --mode mockups
//     Creates DRAFT products on Printify for every status="draft" design (not
//     customer-visible) and records real mockup image URLs for human review.
//   node scripts/pod/generate-pod.js --mode publish
//     Publishes every queue entry with approved=true: creates products first if
//     mockups mode was skipped, then makes them live on the Pop-Up Store.
//
// Required env (or .env): ANTHROPIC_API_KEY (draft), PRINTIFY_API_TOKEN (publish).
// Key values are never printed. Approval is a human decision — this script never
// sets approved=true itself.

const fs = require('fs');
const path = require('path');
const { api: printify, getShop } = require('./printify.js');
const { renderPrintFile, renderPreview } = require('./render-design.js');

const REPO = path.join(__dirname, '..', '..');
const QUEUE_FILE = path.join(__dirname, 'design-queue.json');
const RESOLVED_FILE = path.join(__dirname, 'resolved-products.json');
const PREVIEW_DIR = path.join(REPO, 'pod-designs', 'previews');
const PRINT_DIR = path.join(REPO, 'pod-designs', 'print');       // gitignored, regenerated
const POD_LOG = path.join(REPO, 'pod-products-log.jsonl');

// Product lineup. blueprintTitle must match the Printify catalog title.
// darkColors variants get the "light" design (white text); lightColors variants get
// the "dark" design (charcoal text) — so text always contrasts with the garment.
const PRODUCTS = [
  { key: 'tee', label: 'Premium Tee', blueprintTitle: 'Unisex Garment-Dyed T-shirt', darkColors: /black|pepper|navy|ink|graphite/i, lightColors: /white|ivory|ash/i, sizes: ['S', 'M', 'L', 'XL', '2XL'], price: 2199 },
  { key: 'crewneck', label: 'Crewneck Sweatshirt', blueprintTitle: 'Unisex Heavy Blend™ Crewneck Sweatshirt', darkColors: /black|navy|charcoal|dark chocolate/i, lightColors: /^white$|ash|sand|sport grey/i, sizes: ['S', 'M', 'L', 'XL', '2XL'], price: 2999 },
  { key: 'hoodie', label: 'Hoodie', blueprintTitle: 'Unisex Heavy Blend™ Hooded Sweatshirt', darkColors: /black|navy|charcoal|dark chocolate/i, lightColors: /^white$|ash|sand|sport grey/i, sizes: ['S', 'M', 'L', 'XL', '2XL'], price: 3699 },
  { key: 'mug', label: 'Mug 11oz', blueprintTitle: 'Mug 11oz', darkColors: null, lightColors: /.*/, sizes: null, price: 1599 },  // white-only blueprint, variants carry no color option
];
const PREFERRED_PROVIDERS = ['Monster Digital', 'SwiftPOD', 'Print Geek', 'MyLocker', 'District Photo'];

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

function loadQueue() {
  return JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
}
function saveQueue(queue) {
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2) + '\n', 'utf8');
}
function appendPodLog(entry) {
  fs.appendFileSync(POD_LOG, JSON.stringify(entry) + '\n', 'utf8');
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---------- draft mode ----------

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

async function claudeDraftDesigns(count) {
  const key = loadKey('ANTHROPIC_API_KEY');
  const brandVoice = fs.readFileSync(path.join(REPO, 'brand-voice.md'), 'utf8');
  const existing = fs.existsSync(QUEUE_FILE)
    ? loadQueue().designs.map(d => d.quote_lines.join(' '))
    : [];

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-opus-4-8',
      max_tokens: 8000,
      thinking: { type: 'adaptive' },
      output_config: { format: { type: 'json_schema', schema: DESIGNS_SCHEMA } },
      system: `You write original typography designs for Thrive Richly merch (shirts, hoodies, mugs). Follow this brand voice document, especially its Red lines:\n\n${brandVoice}`,
      messages: [{
        role: 'user',
        content: `Write exactly ${count} merch designs. What SELLS in text merch (in priority order — mix the batch across these):
1. INSIDER HUMOR for the boring-investing tribe — inside jokes only index-fund/FIRE people get. The wearer signals "I'm one of us" with a smirk.
2. MONEY PUNS & WORDPLAY — genuinely clever puns sell year after year. Must land on first read.
3. ANTI-HUSTLE SARCASM — dry humor puncturing get-rich-quick culture ("my portfolio is boring and so am I" energy).
4. GIFTABLE WHOLESOME — something you'd gift a spouse/dad/friend who's good with money.
NEVER: earnest aspirational statements (they read as trying and do not sell), advice sentences, motivational-poster energy.
Rules: every line is YOUR original phrasing — never a quote by a famous person, never an attribution. Funny beats profound. No income claims, no specific dollar amounts, no emoji, no hashtags in quote_lines. quote_lines: 1-3 lines, max 22 characters per line, punchy. subline: optional tiny accent (e.g. "THRIVE RICHLY" or a dry 2-4 word punchline), or "". Avoid these existing designs: ${JSON.stringify(existing)}`,
      }],
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Claude API error ${res.status}: ${JSON.stringify(json)}`);
  if (json.stop_reason === 'refusal') throw new Error('Claude declined the drafting request (stop_reason: refusal).');
  const text = json.content.find(b => b.type === 'text');
  if (!text) throw new Error('No text block in Claude response.');
  return JSON.parse(text.text).designs;
}

async function runDraft(count) {
  const designs = await claudeDraftDesigns(count);
  fs.mkdirSync(PREVIEW_DIR, { recursive: true });
  const queue = loadQueue();
  for (const d of designs) {
    // Enforce the limits the schema can't express (API rejects maxItems/maxLength).
    d.quote_lines = d.quote_lines.slice(0, 3).map(l => l.trim().slice(0, 22)).filter(Boolean);
    if (!d.quote_lines.length) { console.log(`Skipping ${d.slug}: empty quote_lines`); continue; }
    d.subline = (d.subline || '').trim().slice(0, 36);
    if (queue.designs.some(q => q.slug === d.slug)) d.slug = `${d.slug}-${Date.now() % 10000}`;
    const previewLight = path.join(PREVIEW_DIR, `${d.slug}-garment.png`);
    const previewDark = path.join(PREVIEW_DIR, `${d.slug}-mug.png`);
    await renderPreview(d, 'light', previewLight);
    await renderPreview(d, 'dark', previewDark);
    queue.designs.push({
      slug: d.slug,
      quote_lines: d.quote_lines,
      subline: d.subline,
      caption: d.caption,
      approved: false,
      status: 'draft',
      createdAt: new Date().toISOString(),
    });
    console.log(`\n=== ${d.slug} ===`);
    d.quote_lines.forEach(l => console.log(`  ${l.toUpperCase()}`));
    if (d.subline) console.log(`  -- ${d.subline.toUpperCase()}`);
  }
  saveQueue(queue);
  console.log(`\n${designs.length} designs drafted. Previews in pod-designs/previews/. Set "approved": true in scripts/pod/design-queue.json for the ones to publish, then run mode=publish.`);
}

// ---------- publish mode ----------

async function resolveProducts() {
  if (fs.existsSync(RESOLVED_FILE)) {
    console.log('Using cached catalog resolution (scripts/pod/resolved-products.json).');
    return JSON.parse(fs.readFileSync(RESOLVED_FILE, 'utf8'));
  }
  console.log('Resolving blueprints/providers/variants from the Printify catalog...');
  const blueprints = await printify('GET', '/v1/catalog/blueprints.json');
  const resolved = [];
  for (const p of PRODUCTS) {
    const wanted = p.blueprintTitle.toLowerCase();
    const bp = blueprints.find(b => (b.title || '').toLowerCase() === wanted)
      || blueprints.find(b => (b.title || '').toLowerCase().includes(wanted));
    if (!bp) {
      const near = blueprints.filter(b => (b.title || '').toLowerCase().includes(wanted.split(' ').pop())).slice(0, 8).map(b => b.title);
      throw new Error(`Blueprint not found for "${p.blueprintTitle}". Near misses: ${JSON.stringify(near)}`);
    }
    const providers = await printify('GET', `/v1/catalog/blueprints/${bp.id}/print_providers.json`);
    if (!providers.length) throw new Error(`No print providers for blueprint "${bp.title}" (${bp.id}).`);
    const provider = PREFERRED_PROVIDERS.map(n => providers.find(pr => pr.title === n)).find(Boolean) || providers[0];
    const variants = await printify('GET', `/v1/catalog/blueprints/${bp.id}/print_providers/${provider.id}/variants.json`);
    const list = variants.variants || variants;
    const sizeOk = v => !p.sizes || p.sizes.includes(v.options?.size);
    const darkVariantIds = list.filter(v => sizeOk(v) && p.darkColors && p.darkColors.test(v.options?.color || '')).slice(0, 30).map(v => v.id);
    const lightVariantIds = list.filter(v => sizeOk(v) && p.lightColors && p.lightColors.test(v.options?.color || '')).slice(0, 30).map(v => v.id);
    if (!darkVariantIds.length && !lightVariantIds.length) {
      const colors = [...new Set(list.map(v => v.options?.color))].slice(0, 20);
      throw new Error(`No variants matched for "${bp.title}". Available colors: ${JSON.stringify(colors)}`);
    }
    resolved.push({
      key: p.key, label: p.label, price: p.price,
      blueprintId: bp.id, blueprintTitle: bp.title,
      providerId: provider.id, providerTitle: provider.title,
      darkVariantIds, lightVariantIds,
    });
    console.log(`  ${p.key}: "${bp.title}" (bp ${bp.id}) via ${provider.title} (${provider.id}), ${darkVariantIds.length} dark + ${lightVariantIds.length} light variants`);
  }
  fs.writeFileSync(RESOLVED_FILE, JSON.stringify(resolved, null, 2) + '\n', 'utf8');
  return resolved;
}

async function uploadPng(filePath) {
  const created = await printify('POST', '/v1/uploads/images.json', {
    file_name: path.basename(filePath),
    contents: fs.readFileSync(filePath).toString('base64'),
  });
  return created.id;
}

function productDescription(design) {
  const quote = design.quote_lines.join(' ');
  return `"${quote}" — an original Thrive Richly design for people quietly building wealth: simple money habits, no hype, no get-rich-quick.\n\nPrinted on demand. Check the size chart before ordering.`;
}

// Renders + uploads print files and creates one DRAFT product per PRODUCTS type.
// Draft products are visible only in the Printify dashboard, never to customers.
async function createDraftProducts(design, shop, products) {
  const files = {};
  for (const theme of ['light', 'dark']) {
    const file = path.join(PRINT_DIR, `${design.slug}-${theme}.png`);
    await renderPrintFile(design, theme, file);
    files[theme] = await uploadPng(file);
    console.log(`  uploaded ${theme} print file (image id ${files[theme]})`);
  }
  design.products = [];
  for (const p of products) {
    const title = `${design.quote_lines.join(' ')} · ${p.label}`;
    // Contrast rule: dark garments carry the light (white-text) design, light
    // garments carry the dark (charcoal-text) design.
    const darkIds = p.darkVariantIds || p.variantIds || [];
    const lightIds = p.lightVariantIds || [];
    const printAreas = [];
    if (darkIds.length) printAreas.push({ variant_ids: darkIds, placeholders: [{ position: 'front', images: [{ id: files.light, x: 0.5, y: 0.5, scale: 1, angle: 0 }] }] });
    if (lightIds.length) printAreas.push({ variant_ids: lightIds, placeholders: [{ position: 'front', images: [{ id: files.dark, x: 0.5, y: 0.5, scale: 1, angle: 0 }] }] });
    const created = await printify('POST', `/v1/shops/${shop.id}/products.json`, {
      title,
      description: productDescription(design),
      blueprint_id: p.blueprintId,
      print_provider_id: p.providerId,
      variants: [...darkIds, ...lightIds].map(id => ({ id, price: p.price, is_enabled: true })),
      print_areas: printAreas,
      tags: ['personal finance', 'money', 'motivation', 'wealth', 'saving', 'investing'],
    });
    const full = await printify('GET', `/v1/shops/${shop.id}/products/${created.id}.json`);
    const mockup = (full.images || []).find(i => i.is_default) || (full.images || [])[0];
    design.products.push({ key: p.key, title, productId: created.id, mockupUrl: mockup ? mockup.src : null });
    appendPodLog({
      timestamp: new Date().toISOString(),
      slug: design.slug,
      product: p.key,
      title,
      productId: created.id,
      price: p.price,
      mockupUrl: mockup ? mockup.src : null,
      status: 'created-draft',
    });
    console.log(`  ${p.key}: draft product created (${created.id}) mockup: ${mockup ? mockup.src : 'none yet'}`);
    await sleep(1500);
  }
}

async function runMockups() {
  const queue = loadQueue();
  const pending = queue.designs.filter(d => d.status === 'draft');
  if (!pending.length) { console.log('No designs with status "draft" in the queue.'); return; }
  const shop = await getShop();
  console.log(`Creating DRAFT products (not customer-visible) in shop "${shop.title}" (id ${shop.id}).`);
  const products = await resolveProducts();
  fs.mkdirSync(PRINT_DIR, { recursive: true });
  for (const design of pending) {
    console.log(`\n--- ${design.slug} ---`);
    try {
      await createDraftProducts(design, shop, products);
      design.status = 'mockups-ready';
    } catch (err) {
      design.status = 'failed';
      design.error = String(err.message || err);
      console.error(`  FAILED: ${design.error}`);
    }
    saveQueue(queue);
  }
  console.log('\nDone. Review mockup URLs in the queue/log, set "approved": true on keepers, then run mode=publish.');
}

async function runPublish() {
  const queue = loadQueue();
  const pending = queue.designs.filter(d => d.approved === true && (d.status === 'draft' || d.status === 'mockups-ready'));
  if (!pending.length) {
    console.log('No approved unpublished designs in the queue. Set "approved": true on the designs to publish.');
    return;
  }
  const shop = await getShop();
  console.log(`Publishing to shop "${shop.title}" (id ${shop.id}, channel ${shop.sales_channel}).`);
  const products = await resolveProducts();
  fs.mkdirSync(PRINT_DIR, { recursive: true });

  for (const design of pending) {
    console.log(`\n--- ${design.slug} ---`);
    try {
      if (!design.products || !design.products.length) await createDraftProducts(design, shop, products);
      let published = 0;
      for (const prod of design.products) {
        // A product deleted from the dashboard must not sink the whole design.
        try {
          await printify('POST', `/v1/shops/${shop.id}/products/${prod.productId}/publish.json`, {
            title: true, description: true, images: true, variants: true, tags: true, keyFeatures: true, shipping_template: true,
          });
          published++;
          appendPodLog({
            timestamp: new Date().toISOString(),
            slug: design.slug,
            product: prod.key,
            title: prod.title,
            productId: prod.productId,
            mockupUrl: prod.mockupUrl,
            status: 'published',
          });
          console.log(`  ${prod.key}: published (product ${prod.productId})`);
        } catch (err) {
          prod.publishError = String(err.message || err);
          console.error(`  ${prod.key}: publish FAILED (skipping) — ${prod.publishError}`);
        }
        await sleep(1500);
      }
      if (published === 0) throw new Error('No products could be published for this design.');
      design.status = 'published';
      design.publishedAt = new Date().toISOString();
    } catch (err) {
      design.status = 'failed';
      design.error = String(err.message || err);
      console.error(`  FAILED: ${design.error}`);
    }
    saveQueue(queue);
  }
  console.log('\nDone. Products are live on the Pop-Up Store; mockup URLs are in pod-products-log.jsonl.');
}

// Re-applies variants + print areas to already-published products (e.g. after a
// color-mapping change). Contrast rule is enforced product-wide.
async function runRefresh() {
  const queue = loadQueue();
  const live = queue.designs.filter(d => d.status === 'published' && d.products && d.products.length);
  if (!live.length) { console.log('No published designs to refresh.'); return; }
  const shop = await getShop();
  const products = await resolveProducts();
  const byKey = Object.fromEntries(products.map(p => [p.key, p]));
  fs.mkdirSync(PRINT_DIR, { recursive: true });
  for (const design of live) {
    console.log(`\n--- refreshing ${design.slug} ---`);
    const files = {};
    for (const theme of ['light', 'dark']) {
      const file = path.join(PRINT_DIR, `${design.slug}-${theme}.png`);
      await renderPrintFile(design, theme, file);
      files[theme] = await uploadPng(file);
    }
    for (const prod of design.products) {
      const p = byKey[prod.key];
      if (!p) { console.log(`  ${prod.key}: no config, skipped`); continue; }
      const printAreas = [];
      if (p.darkVariantIds.length) printAreas.push({ variant_ids: p.darkVariantIds, placeholders: [{ position: 'front', images: [{ id: files.light, x: 0.5, y: 0.5, scale: 1, angle: 0 }] }] });
      if (p.lightVariantIds.length) printAreas.push({ variant_ids: p.lightVariantIds, placeholders: [{ position: 'front', images: [{ id: files.dark, x: 0.5, y: 0.5, scale: 1, angle: 0 }] }] });
      try {
        await printify('PUT', `/v1/shops/${shop.id}/products/${prod.productId}.json`, {
          variants: [...p.darkVariantIds, ...p.lightVariantIds].map(id => ({ id, price: p.price, is_enabled: true })),
          print_areas: printAreas,
        });
        await printify('POST', `/v1/shops/${shop.id}/products/${prod.productId}/publish.json`, {
          title: true, description: true, images: true, variants: true, tags: true, keyFeatures: true, shipping_template: true,
        });
        appendPodLog({ timestamp: new Date().toISOString(), slug: design.slug, product: prod.key, productId: prod.productId, status: 'refreshed' });
        console.log(`  ${prod.key}: refreshed (${p.darkVariantIds.length} dark + ${p.lightVariantIds.length} light variants)`);
      } catch (err) {
        console.error(`  ${prod.key}: refresh FAILED — ${err.message}`);
      }
      await sleep(1500);
    }
  }
  console.log('\nRefresh complete.');
}

async function main() {
  const mode = arg('--mode', 'draft');
  const count = parseInt(arg('--count', '4'), 10);
  if (mode === 'draft') return runDraft(count);
  if (mode === 'mockups') return runMockups();
  if (mode === 'publish') return runPublish();
  if (mode === 'refresh') return runRefresh();
  throw new Error(`Unknown mode "${mode}" (use draft, mockups, publish, or refresh).`);
}

main().catch(e => { console.error(e.message || e); process.exit(1); });
