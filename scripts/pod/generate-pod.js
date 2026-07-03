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
const { api: printify, getShop, getShopByChannel } = require('./printify.js');
const { renderPrintFile, renderPreview } = require('./render-design.js');
const { claudeDraftDesigns, claudeEtsySeo } = require('./claude-copy.js');

const REPO = path.join(__dirname, '..', '..');
const QUEUE_FILE = path.join(__dirname, 'design-queue.json');
const RESOLVED_FILE = path.join(__dirname, 'resolved-products.json');
const PREVIEW_DIR = path.join(REPO, 'pod-designs', 'previews');
const PRINT_DIR = path.join(REPO, 'pod-designs', 'print');       // gitignored, regenerated
const POD_LOG = path.join(REPO, 'pod-products-log.jsonl');

// Product lineup. blueprintTitle must match the Printify catalog title.
// mode "contrast": fabric shows through — dark-color variants get the light
//   (white-text transparent) design, light-color variants get the dark design.
// mode "solid": full-surface print — one design on a brand-navy background.
// badge: sticker-style rounded rect so the kiss-cut follows a clean shape.
// sizes: array = exact size names; regex = match against the size option.
const PRODUCTS = [
  { key: 'tee', label: 'Premium Tee', blueprintTitle: 'Unisex Garment-Dyed T-shirt', mode: 'contrast', darkColors: /black|pepper|navy|ink|graphite/i, lightColors: /white|ivory|ash/i, sizes: ['S', 'M', 'L', 'XL', '2XL'], price: 2199 },
  { key: 'crewneck', label: 'Crewneck Sweatshirt', blueprintTitle: 'Unisex Heavy Blend™ Crewneck Sweatshirt', mode: 'contrast', darkColors: /black|navy|charcoal|dark chocolate/i, lightColors: /^white$|ash|sand|sport grey/i, sizes: ['S', 'M', 'L', 'XL', '2XL'], price: 2999 },
  { key: 'hoodie', label: 'Hoodie', blueprintTitle: 'Unisex Heavy Blend™ Hooded Sweatshirt', mode: 'contrast', darkColors: /black|navy|charcoal|dark chocolate/i, lightColors: /^white$|ash|sand|sport grey/i, sizes: ['S', 'M', 'L', 'XL', '2XL'], price: 3699 },
  { key: 'mug', label: 'Mug 11oz', blueprintTitle: 'Mug 11oz', mode: 'contrast', darkColors: null, lightColors: /.*/, sizes: null, price: 1599 },  // white-only blueprint, variants carry no color option
  { key: 'tote', label: 'Tote Bag', blueprintTitle: 'Tote Bag', mode: 'contrast', darkColors: /black|navy/i, lightColors: /natural|white|oyster|light/i, sizes: null, price: 2199 },
  // Full-surface products — design on solid brand navy:
  { key: 'poster', label: 'Poster 18x24', blueprintTitle: 'Matte Vertical Posters', mode: 'solid', sizes: /18.{0,3}[x×].{0,3}24/i, price: 2499 },
  { key: 'canvas', label: 'Canvas 16x20', blueprintTitle: 'Matte Canvas, Stretched, 1.25"', mode: 'solid', sizes: /16.{0,3}[x×].{0,3}20/i, price: 4999 },
  { key: 'journal', label: 'Hardcover Journal', blueprintTitle: 'Hardcover Journal Matte', mode: 'solid', sizes: null, price: 1999 },
  { key: 'stickers', label: 'Kiss-Cut Stickers', blueprintTitle: 'Kiss-Cut Stickers', mode: 'solid', badge: true, sizes: /3.{0,3}[x×].{0,3}3/i, price: 399 },
  { key: 'tumbler', label: 'Tumbler 20oz', blueprintTitle: 'Tumbler 20oz', mode: 'solid', sizes: null, price: 2999 },
  { key: 'pillow', label: 'Throw Pillow 18x18', blueprintTitle: 'Spun Polyester Square Pillow', mode: 'solid', sizes: /18.{0,3}[x×].{0,3}18/i, price: 2499 },
  { key: 'blanket', label: 'Plush Blanket 50x60', blueprintTitle: 'Velveteen Plush Blanket', mode: 'solid', sizes: /50.{0,3}[x×].{0,3}60/i, price: 4499 },
  { key: 'deskmat', label: 'Desk Mat', blueprintTitle: 'Desk Mat', mode: 'solid', sizes: null, price: 2199 },
  { key: 'phonecase', label: 'Phone Case', blueprintTitle: 'Tough Phone Cases', mode: 'solid', sizes: null, price: 2199 },
];
const NAVY_BG = '#101820';
const PREFERRED_PROVIDERS = ['Monster Digital', 'SwiftPOD', 'Print Geek', 'MyLocker', 'District Photo'];

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : fallback;
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

async function runDraft(count) {
  const existing = fs.existsSync(QUEUE_FILE)
    ? loadQueue().designs.map(d => d.quote_lines.join(' '))
    : [];
  const designs = await claudeDraftDesigns(count, existing);
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
  const failures = [];
  for (const p of PRODUCTS) {
    try {
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
    const sizeOk = v => {
      if (!p.sizes) return true;
      const size = v.options?.size || '';
      return Array.isArray(p.sizes) ? p.sizes.includes(size) : p.sizes.test(size);
    };
    let darkVariants = [], lightVariants = [];
    if (p.mode === 'contrast') {
      darkVariants = list.filter(v => sizeOk(v) && p.darkColors && p.darkColors.test(v.options?.color || '')).slice(0, 30);
      lightVariants = list.filter(v => sizeOk(v) && p.lightColors && p.lightColors.test(v.options?.color || '')).slice(0, 30);
    } else {
      lightVariants = list.filter(sizeOk).slice(0, 30);   // solid mode: one design, all matched variants
    }
    const sample = darkVariants[0] || lightVariants[0];
    if (!sample) {
      const colors = [...new Set(list.map(v => v.options?.color))].slice(0, 20);
      const sizes = [...new Set(list.map(v => v.options?.size))].slice(0, 20);
      throw new Error(`No variants matched for "${bp.title}". Colors: ${JSON.stringify(colors)} Sizes: ${JSON.stringify(sizes)}`);
    }
    // Print placeholder for this product (pixel dimensions of the print area).
    const ph = (sample.placeholders || []).find(x => x.position === 'front') || (sample.placeholders || [])[0] || {};
    resolved.push({
      key: p.key, label: p.label, price: p.price, mode: p.mode, badge: !!p.badge,
      blueprintId: bp.id, blueprintTitle: bp.title,
      providerId: provider.id, providerTitle: provider.title,
      position: ph.position || 'front', printW: ph.width || null, printH: ph.height || null,
      darkVariantIds: darkVariants.map(v => v.id),
      lightVariantIds: lightVariants.map(v => v.id),
    });
    console.log(`  ${p.key}: "${bp.title}" (bp ${bp.id}) via ${provider.title} (${provider.id}), ${darkVariants.length} dark + ${lightVariants.length} light variants, print ${ph.width}x${ph.height}@${ph.position}`);
    } catch (err) {
      failures.push(`${p.key}: ${err.message}`);
      console.error(`  ${p.key}: RESOLUTION FAILED — ${err.message}`);
    }
  }
  if (failures.length) {
    throw new Error(`Catalog resolution failed for ${failures.length} product(s) — fix PRODUCTS config:\n${failures.join('\n')}`);
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

// Renders + uploads the print file a product needs, sized to its print placeholder.
// Cache avoids re-uploading identical renders across products sharing dimensions.
async function renderAndUpload(design, theme, p, cache) {
  const w = p.printW || 4500, h = p.printH || 5400;
  const solid = p.mode === 'solid';
  const key = `${theme}@${w}x${h}${solid ? '+solid' : ''}${p.badge ? '+badge' : ''}`;
  if (!cache[key]) {
    const file = path.join(PRINT_DIR, `${design.slug}-${key.replace(/[^a-z0-9]+/gi, '-')}.png`);
    await renderPrintFile(design, theme, file, {
      width: w, height: h,
      background: solid ? NAVY_BG : null,
      badge: p.badge,
    });
    cache[key] = await uploadPng(file);
    console.log(`  uploaded ${key} (image id ${cache[key]})`);
  }
  return cache[key];
}

// Builds the variants + print_areas payload pieces for one product config.
async function buildProductPayload(design, p, cache) {
  const printAreas = [];
  let variantIds = [];
  if (p.mode === 'solid') {
    const img = await renderAndUpload(design, 'light', p, cache);
    variantIds = p.lightVariantIds;
    printAreas.push({ variant_ids: variantIds, placeholders: [{ position: p.position, images: [{ id: img, x: 0.5, y: 0.5, scale: 1, angle: 0 }] }] });
  } else {
    // Contrast rule: dark garments carry the light (white-text) design, light
    // garments carry the dark (charcoal-text) design.
    if (p.darkVariantIds.length) {
      const img = await renderAndUpload(design, 'light', p, cache);
      printAreas.push({ variant_ids: p.darkVariantIds, placeholders: [{ position: p.position, images: [{ id: img, x: 0.5, y: 0.5, scale: 1, angle: 0 }] }] });
    }
    if (p.lightVariantIds.length) {
      const img = await renderAndUpload(design, 'dark', p, cache);
      printAreas.push({ variant_ids: p.lightVariantIds, placeholders: [{ position: p.position, images: [{ id: img, x: 0.5, y: 0.5, scale: 1, angle: 0 }] }] });
    }
    variantIds = [...p.darkVariantIds, ...p.lightVariantIds];
  }
  return {
    variants: variantIds.map(id => ({ id, price: p.price, is_enabled: true })),
    print_areas: printAreas,
  };
}

// Creates one DRAFT product per PRODUCTS type. Draft products are visible only
// in the Printify dashboard, never to customers.
async function createDraftProducts(design, shop, products) {
  const cache = {};
  design.products = design.products || [];
  for (const p of products) {
    if (design.products.some(existing => existing.key === p.key)) continue;   // already created
    const title = `${design.quote_lines.join(' ')} · ${p.label}`;
    const payload = await buildProductPayload(design, p, cache);
    const created = await printify('POST', `/v1/shops/${shop.id}/products.json`, {
      title,
      description: productDescription(design),
      blueprint_id: p.blueprintId,
      print_provider_id: p.providerId,
      variants: payload.variants,
      print_areas: payload.print_areas,
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
// color-mapping change) AND creates + publishes any product types added to
// PRODUCTS since the design first shipped.
async function runRefresh() {
  const queue = loadQueue();
  const shop = await getShop();

  // 0) Sync with the dashboard — it is the source of truth for what is live.
  // The user publishes/deletes from the Printify UI: deleted products are
  // dropped here; a design with any visible product is treated as published.
  console.log('Syncing queue with Printify dashboard state...');
  for (const design of queue.designs.filter(d => d.products && d.products.length)) {
    const kept = [];
    let anyVisible = false;
    for (const prod of design.products) {
      try {
        const full = await printify('GET', `/v1/shops/${shop.id}/products/${prod.productId}.json`);
        if (full.visible) anyVisible = true;
        kept.push(prod);
      } catch (err) {
        if (err.status === 404) { console.log(`  ${design.slug}/${prod.key}: deleted in dashboard — dropped from queue`); continue; }
        kept.push(prod);   // transient error: keep and let the main loop deal with it
      }
      await sleep(300);
    }
    design.products = kept;
    if (anyVisible && design.status !== 'published') {
      design.status = 'published';
      design.publishedAt = design.publishedAt || new Date().toISOString();
      console.log(`  ${design.slug}: published from dashboard — status synced`);
    }
  }
  saveQueue(queue);

  const live = queue.designs.filter(d => d.status === 'published' && d.products && d.products.length);
  if (!live.length) { console.log('No published designs to refresh.'); return; }
  const products = await resolveProducts();
  const byKey = Object.fromEntries(products.map(p => [p.key, p]));
  fs.mkdirSync(PRINT_DIR, { recursive: true });
  for (const design of live) {
    console.log(`\n--- refreshing ${design.slug} ---`);
    const cache = {};
    // 1) Update products that already exist. If Printify rejects the in-place
    // update (validation quirks, or the product was deleted from the dashboard),
    // replace it: create fresh, publish, delete the old listing.
    for (const prod of design.products) {
      const p = byKey[prod.key];
      if (!p) { console.log(`  ${prod.key}: no config, skipped`); continue; }
      const payload = await buildProductPayload(design, p, cache);
      try {
        await printify('PUT', `/v1/shops/${shop.id}/products/${prod.productId}.json`, payload);
        await printify('POST', `/v1/shops/${shop.id}/products/${prod.productId}/publish.json`, {
          title: true, description: true, images: true, variants: true, tags: true, keyFeatures: true, shipping_template: true,
        });
        appendPodLog({ timestamp: new Date().toISOString(), slug: design.slug, product: prod.key, productId: prod.productId, status: 'refreshed' });
        console.log(`  ${prod.key}: refreshed`);
      } catch (err) {
        console.log(`  ${prod.key}: in-place update rejected (${err.status || '?'}) — replacing product`);
        try {
          const created = await printify('POST', `/v1/shops/${shop.id}/products.json`, {
            title: prod.title || `${design.quote_lines.join(' ')} · ${p.label}`,
            description: productDescription(design),
            blueprint_id: p.blueprintId,
            print_provider_id: p.providerId,
            variants: payload.variants,
            print_areas: payload.print_areas,
            tags: ['personal finance', 'money', 'motivation', 'wealth', 'saving', 'investing'],
          });
          await printify('POST', `/v1/shops/${shop.id}/products/${created.id}/publish.json`, {
            title: true, description: true, images: true, variants: true, tags: true, keyFeatures: true, shipping_template: true,
          });
          try { await printify('DELETE', `/v1/shops/${shop.id}/products/${prod.productId}.json`); } catch { /* already gone */ }
          const full = await printify('GET', `/v1/shops/${shop.id}/products/${created.id}.json`);
          const mockup = (full.images || []).find(i => i.is_default) || (full.images || [])[0];
          const oldId = prod.productId;
          prod.productId = created.id;
          prod.mockupUrl = mockup ? mockup.src : prod.mockupUrl;
          appendPodLog({ timestamp: new Date().toISOString(), slug: design.slug, product: prod.key, productId: created.id, replacedProductId: oldId, mockupUrl: prod.mockupUrl, status: 'replaced' });
          console.log(`  ${prod.key}: replaced (new product ${created.id}, old ${oldId} deleted)`);
        } catch (err2) {
          console.error(`  ${prod.key}: replace FAILED — ${err2.message}`);
        }
      }
      await sleep(1500);
    }
    // 2) Create + publish product types this design doesn't have yet.
    const missing = products.filter(p => !design.products.some(prod => prod.key === p.key));
    for (const p of missing) {
      const title = `${design.quote_lines.join(' ')} · ${p.label}`;
      try {
        const payload = await buildProductPayload(design, p, cache);
        const created = await printify('POST', `/v1/shops/${shop.id}/products.json`, {
          title,
          description: productDescription(design),
          blueprint_id: p.blueprintId,
          print_provider_id: p.providerId,
          variants: payload.variants,
          print_areas: payload.print_areas,
          tags: ['personal finance', 'money', 'motivation', 'wealth', 'saving', 'investing'],
        });
        await printify('POST', `/v1/shops/${shop.id}/products/${created.id}/publish.json`, {
          title: true, description: true, images: true, variants: true, tags: true, keyFeatures: true, shipping_template: true,
        });
        const full = await printify('GET', `/v1/shops/${shop.id}/products/${created.id}.json`);
        const mockup = (full.images || []).find(i => i.is_default) || (full.images || [])[0];
        design.products.push({ key: p.key, title, productId: created.id, mockupUrl: mockup ? mockup.src : null });
        appendPodLog({ timestamp: new Date().toISOString(), slug: design.slug, product: p.key, title, productId: created.id, price: p.price, mockupUrl: mockup ? mockup.src : null, status: 'published' });
        console.log(`  ${p.key}: NEW product published (${created.id})`);
      } catch (err) {
        console.error(`  ${p.key}: create FAILED — ${err.message}`);
      }
      await sleep(1500);
    }
    saveQueue(queue);
  }
  console.log('\nRefresh complete.');
}

// ---------- etsy mode: curated hero batch as DRAFTS in the Etsy-connected shop ----------
// Etsy is a search engine: listings get Claude-drafted SEO titles/descriptions/tags.
// Products are created as drafts (no listing fee, invisible); the user reviews and
// batch-publishes from the Printify dashboard — same convention as the Pop-Up store.

const ETSY_PRODUCT_KEYS = ['tee', 'mug', 'stickers'];
const ETSY_MAX_DESIGNS = 4;

async function runEtsy() {
  const queue = loadQueue();
  const published = queue.designs.filter(d => d.status === 'published');
  if (!published.length) throw new Error('No published designs to list on Etsy.');
  const flagged = published.filter(d => d.featured === true);
  const designs = (flagged.length ? flagged : published)
    .sort((a, b) => String(b.publishedAt || '').localeCompare(String(a.publishedAt || '')))
    .slice(0, ETSY_MAX_DESIGNS);

  const shop = await getShopByChannel(/etsy/i);
  console.log(`Creating Etsy DRAFT listings in "${shop.title}" (id ${shop.id}, channel ${shop.sales_channel}).`);
  const products = (await resolveProducts()).filter(p => ETSY_PRODUCT_KEYS.includes(p.key));
  fs.mkdirSync(PRINT_DIR, { recursive: true });

  for (const design of designs) {
    console.log(`\n--- ${design.slug} ---`);
    design.etsyProducts = design.etsyProducts || [];
    try {
      const seo = await claudeEtsySeo(design);
      const tags = [...new Set(seo.tags.map(t => t.trim().toLowerCase().slice(0, 20)).filter(Boolean))].slice(0, 13);
      const cache = {};
      for (const p of products) {
        if (design.etsyProducts.some(e => e.key === p.key)) { console.log(`  ${p.key}: already exists, skipped`); continue; }
        const title = `${seo.title} | ${p.label}`.slice(0, 140);
        const payload = await buildProductPayload(design, p, cache);
        const created = await printify('POST', `/v1/shops/${shop.id}/products.json`, {
          title,
          description: seo.description,
          blueprint_id: p.blueprintId,
          print_provider_id: p.providerId,
          variants: payload.variants,
          print_areas: payload.print_areas,
          tags,
        });
        design.etsyProducts.push({ key: p.key, title, productId: created.id });
        appendPodLog({ timestamp: new Date().toISOString(), shop: 'etsy', slug: design.slug, product: p.key, title, productId: created.id, price: p.price, status: 'etsy-draft' });
        console.log(`  ${p.key}: Etsy draft created (${created.id})`);
        await sleep(1500);
      }
    } catch (err) {
      console.error(`  FAILED: ${err.message}`);
    }
    saveQueue(queue);
  }
  console.log('\nDone. Review the drafts in the Printify dashboard (Etsy store) and batch-publish the keepers — each published listing costs Etsy\'s $0.20 fee.');
}

async function main() {
  const mode = arg('--mode', 'draft');
  const count = parseInt(arg('--count', '4'), 10);
  if (mode === 'draft') return runDraft(count);
  if (mode === 'mockups') return runMockups();
  if (mode === 'publish') return runPublish();
  if (mode === 'refresh') return runRefresh();
  if (mode === 'etsy') return runEtsy();
  throw new Error(`Unknown mode "${mode}" (use draft, mockups, publish, refresh, or etsy).`);
}

main().catch(e => { console.error(e.message || e); process.exit(1); });
