// ─── ENVIRONMENT SWITCH ─────────────────────────────────────────────────────
// TEST_MODE = true  → пишем только в тестовый сценарий Make + тестовую папку Dropbox
// TEST_MODE = false → продакшн (оригинальный сценарий)
const TEST_MODE = false;

const ENV = {
  prod: {
    GET:    'https://hook.us2.make.com/bj7rkp54m58ktvgg5xewf7d9q7wpkwiw',
    SUBMIT: 'https://hook.us2.make.com/yhpis63d8gjb941ouh2t6jkw9f4iw28v',
    // Логирование открытий формы. Пока не заполнено — логирование просто выключено.
    LOG:    'https://hook.us2.make.com/snqik9c4p8r2i5xvcm5l48ietuaumi65',
    FOLDER: '/Artwork Orders',
  },
  test: {
    GET:    'https://hook.us2.make.com/ueh7ll5kvjqxxt9whr4bwd3mwn4vfiyl',
    SUBMIT: 'https://hook.us2.make.com/dq4b9ich5wdsdjidhk0smh6w9svh5uu2',
    LOG:    'https://hook.us2.make.com/snqik9c4p8r2i5xvcm5l48ietuaumi65',
    FOLDER: '/Artwork Orders TEST',
  },
};

const ACTIVE = TEST_MODE ? ENV.test : ENV.prod;

// ─── CONFIG ─────────────────────────────────────────────────────────────────
const CONFIG = {
  MAKE_GET_WEBHOOK:      ACTIVE.GET,
  MAKE_SUBMIT_WEBHOOK:   ACTIVE.SUBMIT,
  MAKE_VIEW_LOG_WEBHOOK: ACTIVE.LOG,
  DROPBOX_APP_KEY:       'swz1bzruuwvzkop',
  DROPBOX_APP_SECRET:    'bndcd2tbdztq3yh',
  DROPBOX_REFRESH_TOKEN: '5nl_-90oG0kAAAAAAAAAAYe9LQrN-pHIEo01fbfcgbjd9M6Fds4r3cao2RdT6kLu',
  DROPBOX_UPLOAD_FOLDER: ACTIVE.FOLDER,
  ALLOWED_EXTENSIONS:    ['ai', 'eps', 'png', 'pdf', 'csv', 'svg'],
  MAX_FILE_SIZE_MB:      100,
};

// Поля Airtable, в которых может лежать картинка варианта — проверяются по порядку.
// Первое найденное вложение выигрывает; если ничего нет — падаем на картинку продукта.
// Основное — "Variant Image": lookup в Sales Order Line Items через Product Variant.
const VARIANT_IMAGE_KEYS = [
  'Variant Image',                  // lookup: Product Variant → Front (from Product Color)
  'Front (from Product Color)',
  'Front',
  'Variant Photo',
];

const PRODUCT_IMAGE_KEYS = ['Product Image', 'Product Photo'];

// По какому полю резать карточки на цвета. Первое непустое выигрывает.
// В Airtable есть и Base Color, и Variant Color — если группировка пойдёт не по тому,
// поменяй порядок здесь, больше нигде править не нужно.
const COLOR_FIELD_PRIORITY = ['Variant Color', 'Base Color', 'Variant Name'];

// Порядок размеров для сортировки строки Size Breakdown
const SIZE_ORDER = ['OS','ONE SIZE','XXS','XS','S','M','L','XL','2XL','XXL','3XL','XXXL','4XL','5XL'];

function sizeRank(label) {
  const token = String(label).trim().split(/\s+/)[0].toUpperCase();
  const i = SIZE_ORDER.indexOf(token);
  return i === -1 ? SIZE_ORDER.length : i;
}

// ─── STATE ───────────────────────────────────────────────────────────────────
const state = {
  orderData:     null,
  productStates: [],   // per-product: { files, fileIdCounter, embellishment, status }
  expandedIndex: -1,
};

function createProductState() {
  return {
    files:         [],
    fileIdCounter: 0,
    embellishment:   null,
    placement:       '',
    additionalNotes: '',
    status:          'pending',
    skipped:         false,
    isReorder:       false,
    rightsConfirmed: false,
  };
}

// ─── UTILITIES ───────────────────────────────────────────────────────────────
function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatFileSize(bytes) {
  if (bytes < 1024)        return bytes + ' B';
  if (bytes < 1048576)     return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

function formatDate(str) {
  if (!str) return '';
  try {
    return new Date(str).toLocaleDateString('en-GB', {
      day: 'numeric', month: 'short', year: 'numeric',
    });
  } catch { return str; }
}

function toNum(v) {
  if (v === null || v === undefined) return null;
  const n = parseFloat(String(v).replace(',', '.').replace(/[^\d.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

// Собирает ВСЕ числа из значения Airtable (lookup может вернуть массив значений).
function allNums(v) {
  const out = [];
  const walk = x => {
    if (x === null || x === undefined) return;
    if (Array.isArray(x)) { x.forEach(walk); return; }
    if (typeof x === 'object') return;
    const n = toNum(x);
    if (n !== null) out.push(n);
  };
  walk(v);
  return out;
}

// Достаёт первое вложение из значения Airtable.
// Понимает: строку-URL, массив строк, массив вложений, вложенные массивы (lookup).
function firstAttachment(v) {
  if (!v) return null;

  if (typeof v === 'string') {
    const s = v.trim();
    return s ? { url: s, thumb: s } : null;
  }

  if (Array.isArray(v)) {
    for (const item of v) {
      const found = firstAttachment(item);
      if (found) return found;
    }
    return null;
  }

  if (typeof v === 'object' && v.url) {
    return {
      url:   v.url,
      thumb: v.thumbnails?.large?.url || v.thumbnails?.small?.url || v.url,
    };
  }

  return null;
}

function pickAttachment(obj, keys) {
  for (const k of keys) {
    const found = firstAttachment(obj[k]);
    if (found) return found;
  }
  return null;
}

function firstString(v) {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) {
    for (const item of v) {
      const s = firstString(item);
      if (s) return s;
    }
    return '';
  }
  return String(v).trim();
}

// ─── DATA NORMALISATION ──────────────────────────────────────────────────────
function normaliseOrder(raw) {
  const rawProducts = Array.isArray(raw.products)
    ? raw.products
    : raw.products && typeof raw.products === 'object'
      ? [raw.products]
      : [];

  const products = rawProducts.map(p => {
    // product_name: new format sends array, old sends string
    const productName = Array.isArray(p['Product Name'])
      ? (p['Product Name'][0] || '')
      : (p.product_name || '');

    // Картинка: сначала вариант, потом продукт, потом плоские старые поля
    const img =
      pickAttachment(p, VARIANT_IMAGE_KEYS) ||
      pickAttachment(p, PRODUCT_IMAGE_KEYS) ||
      (p.photo_url ? { url: p.photo_url, thumb: p.thumbnail || p.photo_url } : null);

    const photoUrl  = img?.url   || '';
    const thumbnail = img?.thumb || '';

    // embellishment: new key is "Embelishment Types" (typo in source), old is embellishment_types
    const rawEmb = p['Embelishment Types'] ?? p.embellishment_types;
    const embellishmentTypes = Array.isArray(rawEmb)
      ? rawEmb.filter(t => t && t.trim() !== '')
      : [];

    const baseColor    = firstString(p['Base Color']    ?? p.Varible_Color);
    const variantColor = firstString(p['Variant Color']);
    const variantName  = firstString(p['Variant Name']  ?? p.Varible_Name);

    const colorByKey = {
      'Base Color':    baseColor,
      'Variant Color': variantColor,
      'Variant Name':  variantName,
    };
    const colorLabel = COLOR_FIELD_PRIORITY.map(k => colorByKey[k]).find(Boolean) || '';

    const qty = String(p.Quantity || p.quantity || '');

    // Размер строки заказа: сначала lookup Variant Size, иначе хвост Variant Name
    // ("Long Sleeve T-👕 - Forest - XL" → "XL")
    const nameParts = variantName.split(/\s*-\s*/).map(s => s.trim()).filter(Boolean);
    const sizeFromName = nameParts.length > 1 ? nameParts[nameParts.length - 1] : '';
    const sizeLabel = firstString(p['Variant Size'] ?? p.Size) || sizeFromName;

    // Готовая строка для Size Breakdown: своя, если Airtable её дал,
    // иначе собираем сами из размера и количества этой строки
    const sizeBreakdown = firstString(p['Size Breakdown']);
    const sizeLine = sizeBreakdown || (sizeLabel ? `${sizeLabel} ${qty}`.trim() : '');

    return {
      index:             parseInt(p.__IMTINDEX__ || p.index, 10) || 1,
      total:             parseInt(p.__IMTLENGTH__ || p.total,  10) || 1,
      productName,
      qty,
      baseColor,
      variantColor,
      variantName,
      colorLabel,
      sizeLabel,
      size:              sizeLine,
      lineItemId:        firstString(p['Line Item ID']),
      photoUrl,
      thumbnail,
      hasVariantImage:   !!pickAttachment(p, VARIANT_IMAGE_KEYS),
      recordId:          p.recordID || p.recordId || '',
      embellishmentTypes,
      leadTime:          firstString(p['Lead Time'] ?? p.lead_time),
      leadTimes:         allNums(p['Lead Time'] ?? p.lead_time),
      dielineUrl:        firstAttachment(p['Dieline'])?.url || '',
      dielineFilename:   Array.isArray(p['Dieline']) ? (p['Dieline'][0]?.filename || 'dieline') : 'dieline',
      artworkSubmission: p['Artwork Submission'] || p.artwork_submission || '',
    };
  });

  // ─── ГРУППИРОВКА: продукт + цвет ──────────────────────────────────────────
  // Одна карточка = один продукт в одном цвете.
  // Несколько строк заказа с одним цветом, но разными размерами — сливаются в одну карточку.
  const groups = [];
  const groupMap = {};

  products.forEach(p => {
    const colorKey = p.colorLabel.trim().toLowerCase();
    const key = p.productName.trim().toLowerCase() + '||' + colorKey;

    if (!groupMap[key]) {
      const g = {
        key,
        productName: p.productName,
        color:       p.colorLabel,
        baseColor:   p.baseColor,
        products:    [],
      };
      groupMap[key] = g;
      groups.push(g);
    }
    groupMap[key].products.push(p);
  });

  groups.forEach(g => {
    const vals = f => g.products.map(p => p[f]).filter(Boolean);

    // В Airtable встречаются дубли строк заказа: одинаковый Line Item ID,
    // разные recordID. Для количества и размеров считаем каждую строку один раз,
    // но recordID сохраняем все — иначе writeback пропустит запись-двойника.
    const seenLines = new Set();
    g.uniqueProducts = g.products.filter(p => {
      const key = p.lineItemId || `${p.sizeLabel}|${p.size}|${p.qty}`;
      if (seenLines.has(key)) return false;
      seenLines.add(key);
      return true;
    });
    g.duplicateCount = g.products.length - g.uniqueProducts.length;

    const uVals = f => g.uniqueProducts.map(p => p[f]).filter(Boolean);

    // QTY: суммируем, если все значения числовые, иначе перечисляем
    const qtyRaw  = uVals('qty');
    const qtyNums = qtyRaw.map(toNum).filter(n => n !== null);
    g.qty = (qtyNums.length && qtyNums.length === qtyRaw.length)
      ? String(qtyNums.reduce((a, b) => a + b, 0))
      : qtyRaw.join(' / ');

    g.variant = g.color;

    // Size Breakdown — только размеры этого цвета, в человеческом порядке
    g.size = [...new Set(uVals('size'))]
      .sort((a, b) => sizeRank(a) - sizeRank(b))
      .join(' / ');

    // Картинка: приоритет у варианта
    const withVariantImg = g.products.find(p => p.hasVariantImage && p.thumbnail);
    g.thumbnail = withVariantImg?.thumbnail || vals('thumbnail')[0] || '';
    g.photoUrl  = withVariantImg?.photoUrl  || vals('photoUrl')[0]  || '';

    // LEAD TIME: максимум по всем значениям всех вариантов группы
    // (lookup может вернуть массив — считаем все числа, не только первое)
    const ltNums = g.products.flatMap(p => p.leadTimes);
    g.leadTime = ltNums.length ? String(Math.max(...ltNums)) : (vals('leadTime')[0] || '');

    g.dielineUrl      = vals('dielineUrl')[0] || '';
    g.dielineFilename = vals('dielineFilename')[0] || 'dieline';

    g.embellishmentTypes = [...new Map(
      g.products.flatMap(p => p.embellishmentTypes).map(t => [t, t])
    ).values()];

    g.allSubmitted = g.products.every(p => p.artworkSubmission);

    // Имя папки Dropbox — с цветом, чтобы файлы разных колорвеев не смешивались
    g.folderLabel = [g.productName, g.color].filter(Boolean).join(' - ');
  });

  return {
    orderNumber:     raw.order_number || raw.orderNumber || '',
    orderDate:       formatDate(raw.order_date || raw.orderDate || ''),
    client:          raw.client_name  || raw.client  || raw.client_id  || '',
    shippingAddress: raw.shipping_address || raw.shippingAddress || '',
    formStatus:      raw.formStatus || raw.form_status || 'pending',
    groups,
  };
}

// ─── JSON REPAIR ──────────────────────────────────────────────────────────────
// Make.com sometimes outputs array objects without separating commas: }{ → },{
function repairJson(text) {
  return text.replace(/\}(\s*)\{/g, '},$1{');
}

// Многострочные поля Airtable (адрес, заметки) приходят с живыми переносами
// внутри строковых литералов — для JSON.parse это фатально. Экранируем их.
function escapeControlChars(text) {
  let out = '', inString = false, escaped = false;

  for (const ch of text) {
    if (escaped)      { out += ch; escaped = false; continue; }
    if (ch === '\\')  { out += ch; escaped = true;  continue; }
    if (ch === '"')   { out += ch; inString = !inString; continue; }

    if (inString && (ch === '\n' || ch === '\r' || ch === '\t')) {
      out += ch === '\n' ? '\\n' : ch === '\r' ? '\\r' : '\\t';
      continue;
    }
    out += ch;
  }
  return out;
}

// ─── VIEW LOGGING ─────────────────────────────────────────────────────────────
// Отправляет событие открытия формы в Make, который пишет комментарий в Airtable.
// Полностью fire-and-forget: любая ошибка гасится, на работу формы не влияет.
let _viewLogged = false;

async function fetchGeo() {
  const sources = [
    {
      url: 'https://ipwho.is/',
      map: d => ({
        ip:      d.ip,
        city:    d.city,
        region:  d.region,
        country: d.country,
        org:     d.connection?.isp || d.connection?.org || '',
      }),
    },
    {
      url: 'https://ipapi.co/json/',
      map: d => ({
        ip:      d.ip,
        city:    d.city,
        region:  d.region,
        country: d.country_name,
        org:     d.org || '',
      }),
    },
  ];

  for (const src of sources) {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 4000);
      const res = await fetch(src.url, { signal: controller.signal });
      clearTimeout(t);
      if (!res.ok) continue;
      const data = await res.json();
      const geo = src.map(data);
      if (geo.ip) return geo;
    } catch (err) {
      console.warn('[viewLog] geo lookup failed:', src.url, err);
    }
  }
  return { ip: '', city: '', region: '', country: '', org: '' };
}

async function logFormView(orderId, orderNumber) {
  if (_viewLogged) return;
  _viewLogged = true;

  if (!/^https?:\/\//.test(CONFIG.MAKE_VIEW_LOG_WEBHOOK)) {
    console.warn('[viewLog] webhook не настроен — логирование пропущено');
    return;
  }

  try {
    const geo = await fetchGeo();

    const location = [geo.city, geo.region, geo.country].filter(Boolean).join(', ');
    const details  = [
      location,
      geo.ip ? `IP ${geo.ip}` : 'IP unknown',
      geo.org,
    ].filter(Boolean).join(' · ');

    const payload = {
      orderId,
      orderNumber,
      event:       'Artwork form viewed',
      commentText: `Artwork form viewed — ${details}`,
      ip:          geo.ip,
      city:        geo.city,
      region:      geo.region,
      country:     geo.country,
      org:         geo.org,
      userAgent:   navigator.userAgent,
      pageUrl:     window.location.href,
    };

    console.log('[viewLog] payload:', payload);

    await fetch(CONFIG.MAKE_VIEW_LOG_WEBHOOK, {
      method:    'POST',
      headers:   { 'Content-Type': 'application/json' },
      body:      JSON.stringify(payload),
      keepalive: true,
    });
  } catch (err) {
    console.warn('[viewLog] failed:', err);
  }
}

// ─── STATE MACHINE ────────────────────────────────────────────────────────────
function setPageState(name) {
  document.querySelector('main').dataset.state = name;
}

// ─── ORDER LOADING ────────────────────────────────────────────────────────────
// Single network attempt: fetch + JSON-parse. Throws on any transient failure
// (network error, timeout, HTTP 5xx, malformed JSON) so the caller can retry.
async function fetchOrderPayload(orderId, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(
      CONFIG.MAKE_GET_WEBHOOK + '?orderId=' + encodeURIComponent(orderId),
      { signal: controller.signal }
    );

    if (!res.ok) throw new Error('HTTP ' + res.status);

    const text = await res.text();
    console.log('[loadOrder] raw webhook response:', text);

    try {
      return JSON.parse(escapeControlChars(repairJson(text)));
    } catch (parseErr) {
      throw new Error('Invalid JSON from webhook: ' + text.slice(0, 200));
    }
  } finally {
    clearTimeout(timeout);
  }
}

const LOAD_ORDER_MAX_ATTEMPTS = 3;
const LOAD_ORDER_TIMEOUT_MS   = 25000;

async function loadOrder() {
  setPageState('loading');

  const orderId = new URLSearchParams(window.location.search).get('orderId');

  if (!orderId) {
    showNotFound('This link is invalid — no order ID was found in the URL.', false);
    return;
  }

  let raw, lastErr;
  for (let attempt = 1; attempt <= LOAD_ORDER_MAX_ATTEMPTS; attempt++) {
    try {
      raw = await fetchOrderPayload(orderId, LOAD_ORDER_TIMEOUT_MS);
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      console.warn(`[loadOrder] attempt ${attempt}/${LOAD_ORDER_MAX_ATTEMPTS} failed:`, err);
      if (attempt < LOAD_ORDER_MAX_ATTEMPTS) {
        await new Promise(r => setTimeout(r, attempt * 1200));
      }
    }
  }

  if (lastErr) {
    console.error('[loadOrder] All attempts failed:', lastErr);
    showNotFound(
      (lastErr.name === 'AbortError'
        ? 'Unable to load order details — the request kept timing out.'
        : 'Unable to load order details: ' + lastErr.message
      ) + ' Please try again — if this keeps happening, contact your Openhouse manager.',
      true
    );
    return;
  }

  try {
    if (raw.error === 'not_found') {
      showNotFound('We couldn\'t find an order matching this link. Please contact your Openhouse manager.', false);
      return;
    }

    // ── DEBUG: доступно в консоли как __OH_RAW__ / __OH_KEYS__ ──────────────
    window.__OH_RAW__ = raw;
    const firstProduct = Array.isArray(raw.products) ? raw.products[0] : raw.products;
    window.__OH_KEYS__ = firstProduct ? Object.keys(firstProduct) : [];
    console.log('[debug] ключи первой строки заказа:', window.__OH_KEYS__);

    const data = normaliseOrder(raw);
    window.__OH_GROUPS__ = data.groups;
    console.table(data.groups.map(g => ({
      product:  g.productName,
      color:    g.color,
      lineItems: g.products.length,
      unique:   (g.uniqueProducts || g.products).length,
      dupes:    g.duplicateCount || 0,
      qty:      g.qty,
      size:     g.size,
      leadTime: g.leadTime,
      image:    g.thumbnail ? 'yes' : 'NO',
    })));

    // Логируем открытие до любых проверок статуса — иначе заказы,
    // по которым всё уже отправлено, никогда не попадут в лог
    logFormView(orderId, data.orderNumber);

    const hasAnyContent = data.orderNumber || data.client || data.groups.some(g => g.productName);
    if (!hasAnyContent) {
      showNotFound('We couldn\'t find an order matching this link. Please contact your Openhouse manager.', true);
      return;
    }

    if (data.formStatus === 'submitted') {
      showAlreadySubmitted(data.orderNumber);
      return;
    }

    if (data.groups.length > 0 && data.groups.every(g => g.allSubmitted)) {
      showAlreadySubmitted(data.orderNumber);
      return;
    }

    state.orderData = data;
    state.productStates = data.groups.map(g => {
      const ps = createProductState();
      if (g.allSubmitted) ps.status = 'submitted';
      return ps;
    });

    renderTopbarOrderNum(data.orderNumber);
    renderOrderDetails(data);
    renderProducts(data.groups);
    data.groups.forEach((g, i) => {
      if (g.allSubmitted) setProductStatus(i, 'submitted');
    });
    setPageState('form');

    const firstPending = state.productStates.findIndex(s => s.status !== 'submitted');
    if (firstPending !== -1) expandProduct(firstPending);

  } catch (err) {
    console.error('[loadOrder] Error processing order data:', err);
    showNotFound('Unable to load order details: ' + err.message, true);
  }
}

function showNotFound(msg, allowRetry) {
  document.getElementById('not-found-message').textContent = msg;
  const retryBtn = document.getElementById('retry-load-btn');
  if (retryBtn) retryBtn.hidden = !allowRetry;
  setPageState('not-found');
}

function showAlreadySubmitted(orderNum) {
  const el = document.getElementById('already-submitted-order');
  if (el) el.textContent = orderNum ? 'Order #' + orderNum : '';
  setPageState('already-submitted');
}

function showAllSubmitted() {
  const total = state.productStates.length;
  const orderNum = state.orderData.orderNumber;
  document.getElementById('all-submitted-body').textContent =
    `We've received your files for all ${total} product${total !== 1 ? 's' : ''} and will be in touch shortly.`;
  document.getElementById('all-submitted-order').textContent = orderNum ? 'Order #' + orderNum : '';
  setPageState('all-submitted');
}

// ─── RENDER ORDER ─────────────────────────────────────────────────────────────
function renderTopbarOrderNum(num) {
  const el = document.getElementById('topbar-order-num');
  if (el && num) el.textContent = '#' + num;
}

function renderOrderDetails(data) {
  const rows = [
    { label: 'Client',           value: data.client },
    { label: 'Shipping Address', value: data.shippingAddress },
    { label: 'Order Date',       value: data.orderDate },
  ];

  const html = `
    <div class="order-details-table">
      ${rows.map(r => `
        <div class="order-row">
          <span class="order-row__key">${esc(r.label)}</span>
          <span class="order-row__val">${esc(r.value) || '—'}</span>
        </div>
      `).join('')}
    </div>
  `;
  document.getElementById('order-details').innerHTML = html;
}

// ─── RENDER PRODUCTS ──────────────────────────────────────────────────────────
function renderProducts(groups) {
  const list = document.getElementById('products-list');
  list.innerHTML = '';
  groups.forEach((group, i) => {
    const card = buildProductCard(group, i);
    list.appendChild(card);
    initProductCard(card, i);
  });
  updateProductsCounter();
}

function buildProductCard(group, index) {
  const thumbHtml = group.thumbnail
    ? `<img src="${esc(group.thumbnail)}" alt="" class="product-card__thumb-img">`
    : `<span class="product-card__thumb-placeholder">IMG</span>`;

  const photoHtml = group.photoUrl
    ? `<img src="${esc(group.photoUrl)}" alt="${esc(group.productName)}" class="specs-photo__img">`
    : `<span class="specs-photo__placeholder">IMG</span>`;

  // Если в Airtable типов эмбеллишмента нет, блок целиком скрывается
  // и перестаёт быть обязательным — иначе форму нельзя отправить.
  const hasEmbellishment = group.embellishmentTypes.length > 0;

  const embBtns = group.embellishmentTypes.map(type =>
    `<button type="button" class="toggle-btn" data-value="${esc(type)}">${esc(type)}</button>`
  ).join('');

  // Цвет идёт в название карточки; эйбров сверху — только количество строк
  const cardTitle = [group.productName || 'Unnamed Product', group.color]
    .filter(Boolean)
    .join(' — ');

  const itemCount = (group.uniqueProducts || group.products).length;
  const counterHtml = itemCount > 1
    ? `<span class="product-card__counter">${itemCount} items</span>`
    : '';

  const card = document.createElement('div');
  card.className = 'product-card';
  card.dataset.index = index;
  card.dataset.status = 'pending';

  card.innerHTML = `
    <div class="product-card__header" role="button" tabindex="0" aria-expanded="false">
      <div class="product-card__thumb" aria-hidden="true">${thumbHtml}</div>
      <div class="product-card__info">
        ${counterHtml}
        <span class="product-card__name">${esc(cardTitle)}</span>
      </div>
      <span class="status-badge status-badge--pending">Pending</span>
      <svg class="product-card__chevron" aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="2,4 6,8 10,4"/>
      </svg>
    </div>

    <div class="product-card__body" hidden>

      <div class="product-specs">
        <span class="product-specs__label">Specs</span>
        <div class="specs-layout">
          <div class="specs-rows">
            <div class="spec-row">
              <span class="spec-row__key">QTY</span>
              <span class="spec-row__val">${esc(group.qty ? group.qty + ' units' : '—')}</span>
            </div>
            ${group.variant ? `<div class="spec-row">
              <span class="spec-row__key">Color</span>
              <span class="spec-row__val">${esc(group.variant)}</span>
            </div>` : ''}
            ${group.size ? `<div class="spec-row">
              <span class="spec-row__key">Size Breakdown</span>
              <span class="spec-row__val">${esc(group.size)}</span>
            </div>` : ''}
            <div class="spec-row">
              <span class="spec-row__key">Lead Time (From Proof Approval)</span>
              <span class="spec-row__val">${group.leadTime ? esc(group.leadTime) + (group.leadTime === '1' ? ' week' : ' weeks') : '—'}</span>
            </div>
          </div>
          <div class="specs-photo-wrap">
            <div class="specs-photo">${photoHtml}</div>
            ${group.dielineUrl ? `<a href="${esc(group.dielineUrl)}" download="${esc(group.dielineFilename)}" class="dieline-link" target="_blank">
              <svg width="11" height="11" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="7" y1="1" x2="7" y2="10"/><polyline points="3,6 7,10 11,6"/><line x1="2" y1="13" x2="12" y2="13"/></svg>
              Dieline
            </a>` : ''}
          </div>
        </div>
      </div>

      <div class="client-specs-section">
        <div class="client-specs-header">
          <span class="section-label">
            <span class="dot" aria-hidden="true"></span>
            Client Specs
          </span>
        </div>

        <div class="reorder-check" id="reorder-check-${index}">
          <label class="reorder-label" for="reorder-cb-${index}">
            <input type="checkbox" id="reorder-cb-${index}" class="reorder-cb">
            <span>This is a re-order — use my existing artwork</span>
          </label>
        </div>

        <div class="skip-banner" id="skip-banner-${index}" hidden>
          <p>Blank product selected — no artwork or embellishment will be applied.</p>
        </div>

        <div id="client-fields-${index}">

        <div class="field-group" id="field-files-${index}">
          <div class="field-label-row">
            <span class="field-label">Artwork File(s)</span>
            <span class="badge badge--required">Mandatory</span>
          </div>
          <div class="dropzone" id="dropzone-${index}" role="button" tabindex="0"
               aria-label="Upload artwork files — drag and drop or click to browse">
            <input type="file" id="file-input-${index}" multiple
                   accept=".ai,.eps,.png,.pdf,.csv,.svg"
                   aria-hidden="true" tabindex="-1">
            <svg class="dropzone__icon" aria-hidden="true" width="22" height="22"
                 viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
              <polyline points="17 8 12 3 7 8"/>
              <line x1="12" y1="3" x2="12" y2="15"/>
            </svg>
            <p class="dropzone__main">Drag &amp; drop files or browse</p>
            <p class="dropzone__types">AI &nbsp;·&nbsp; EPS &nbsp;·&nbsp; PNG &nbsp;·&nbsp; PDF &nbsp;·&nbsp; CSV &nbsp;·&nbsp; SVG &nbsp;·&nbsp; Max 100 MB each</p>
          </div>
          <ul class="file-list" id="file-list-${index}" aria-live="polite"></ul>
          <p class="field-hint">Vector files (AI, EPS) are preferred for best print quality.</p>
          <p class="field-error" id="error-files-${index}" role="alert" hidden></p>
        </div>

        ${hasEmbellishment ? `<div class="field-group" id="field-embellishment-${index}">
          <div class="field-label-row">
            <span class="field-label">Embellishment Type</span>
            <span class="badge badge--required">Mandatory</span>
          </div>
          <div class="toggle-group" role="group" aria-label="Select embellishment type">
            ${embBtns}
          </div>
          <p class="field-error" id="error-embellishment-${index}" role="alert" hidden></p>
        </div>` : ''}

        <div class="field-group" id="field-colors-${index}">
          <div class="field-label-row">
            <label class="field-label" for="input-colors-${index}">Embellishment Color</label>
            <span class="badge badge--optional">Optional</span>
          </div>
          <input type="text" id="input-colors-${index}"
                 placeholder="Enter Pantone or Hex values (e.g. PMS 186C, #C13B22)…"
                 autocomplete="off">
          <p class="field-hint">If you know Pantone or Hex values, enter them here. If not, we will match them for you.</p>
          <p class="field-error" id="error-colors-${index}" role="alert" hidden></p>
        </div>

        <div class="field-group" id="field-placement-${index}">
          <div class="field-label-row">
            <label class="field-label" for="input-placement-${index}">Placement Directions</label>
            <span class="badge badge--required">Mandatory</span>
          </div>
          <textarea id="input-placement-${index}" rows="4"
                    placeholder="Describe where you'd like the artwork placed on the product…"></textarea>
          <p class="field-hint">Examples: Centered, Maximum Size, Left Chest, Front Center 2" from top.</p>
          <p class="field-error" id="error-placement-${index}" role="alert" hidden></p>
        </div>

        <div class="field-group" id="field-notes-${index}">
          <div class="field-label-row">
            <label class="field-label" for="input-notes-${index}">Additional Notes</label>
            <span class="badge badge--optional">Optional</span>
          </div>
          <textarea id="input-notes-${index}" rows="3" maxlength="300"
                    placeholder="Any additional instructions or details for production…"></textarea>
          <p class="field-hint">Maximum 300 characters.</p>
          <p class="field-error" id="error-notes-${index}" role="alert" hidden></p>
        </div>

        </div><!-- /client-fields -->

        <div class="field-group rights-check" id="field-rights-${index}">
          <label class="reorder-label" for="rights-cb-${index}">
            <input type="checkbox" id="rights-cb-${index}" class="reorder-cb">
            <span>I own or have permission to use the artwork, logos, and trademarks in this file, and Openhouse may embellish them on this order.</span>
          </label>
          <p class="field-hint">Your artwork stays yours. We print what you approve and do not check files for third-party rights. If a claim arises from artwork you send us, it is your responsibility. We may decline any file.</p>
          <p class="field-error" id="error-rights-${index}" role="alert" hidden></p>
        </div>

        <div class="skip-confirm" id="skip-confirm-${index}" hidden>
          <p class="skip-confirm__title">Skip embellishment?</p>
          <p class="skip-confirm__body">The product will be placed without embellishment. Are you sure you want to continue?</p>
          <div class="skip-confirm__actions">
            <button type="button" class="skip-back-btn" id="skip-back-${index}">Back</button>
            <button type="button" class="skip-yes-btn"  id="skip-yes-${index}">Yes, Skip</button>
          </div>
        </div>

        <div class="product-card__footer" id="footer-${index}">
          <button type="button" class="skip-btn" id="skip-btn-${index}">Skip</button>
          <button type="button" class="submit-product-btn" id="submit-product-${index}" disabled>
            Submit Product
          </button>
        </div>

        <p class="field-error" id="error-global-${index}" role="alert" hidden style="margin-top:12px;text-align:right;"></p>
      </div>

    </div>
  `;

  return card;
}

// ─── INIT PRODUCT CARD ────────────────────────────────────────────────────────
function initProductCard(card, index) {
  const header = card.querySelector('.product-card__header');

  // Expand / collapse on click or keyboard
  header.addEventListener('click', () => toggleProduct(index));
  header.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleProduct(index); }
  });

  // Dropzone
  const dropzone  = card.querySelector(`#dropzone-${index}`);
  const fileInput = card.querySelector(`#file-input-${index}`);
  const fileList  = card.querySelector(`#file-list-${index}`);

  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
  });
  fileInput.addEventListener('change', e => { addFiles(index, e.target.files); fileInput.value = ''; });
  ['dragenter', 'dragover'].forEach(evt =>
    dropzone.addEventListener(evt, e => { e.preventDefault(); dropzone.classList.add('dragover'); })
  );
  ['dragleave', 'drop'].forEach(evt =>
    dropzone.addEventListener(evt, e => { e.preventDefault(); dropzone.classList.remove('dragover'); })
  );
  dropzone.addEventListener('drop', e => addFiles(index, e.dataTransfer.files));

  fileList.addEventListener('click', e => {
    const btn = e.target.closest('.file-remove-btn');
    if (btn) removeFile(index, Number(btn.dataset.id));
  });

  // Toggle buttons (embellishment)
  const toggleBtns = [...card.querySelectorAll('.toggle-btn')];
  toggleBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      toggleBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.productStates[index].embellishment = btn.dataset.value;
      clearFieldError(index, 'embellishment');
    });
  });
  if (toggleBtns.length === 1) toggleBtns[0].click();

  // Reorder checkbox
  const reorderCb = card.querySelector(`#reorder-cb-${index}`);
  reorderCb.addEventListener('change', () => {
    const isReorder = reorderCb.checked;
    state.productStates[index].isReorder = isReorder;

    if (isReorder) {
      card.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('active'));
      state.productStates[index].embellishment = null;
    } else if (toggleBtns.length > 0) {
      toggleBtns[0].click();
    }

    ['files', 'embellishment', 'placement'].forEach(field => {
      const fieldGroup = card.querySelector(`#field-${field}-${index}`);
      if (!fieldGroup) return;
      const badge = fieldGroup.querySelector('.badge');
      if (!badge) return;
      badge.textContent = isReorder ? 'Optional' : 'Mandatory';
      badge.classList.toggle('badge--optional', isReorder);
      badge.classList.toggle('badge--required', !isReorder);
      clearFieldError(index, field);
    });
  });

  // Rights confirmation — блокирует Submit, пока не отмечен
  const rightsCb = card.querySelector(`#rights-cb-${index}`);
  rightsCb.addEventListener('change', () => {
    state.productStates[index].rightsConfirmed = rightsCb.checked;
    if (rightsCb.checked) clearFieldError(index, 'rights');
    updateSubmitEnabled(index);
  });

  // Skip → show confirmation, hide footer
  card.querySelector(`#skip-btn-${index}`).addEventListener('click', () => {
    card.querySelector(`#skip-confirm-${index}`).removeAttribute('hidden');
    card.querySelector(`#footer-${index}`).setAttribute('hidden', '');
  });

  // Back → hide confirmation, show footer
  card.querySelector(`#skip-back-${index}`).addEventListener('click', () => {
    card.querySelector(`#skip-confirm-${index}`).setAttribute('hidden', '');
    card.querySelector(`#footer-${index}`).removeAttribute('hidden');
  });

  // Yes, Skip → confirm
  card.querySelector(`#skip-yes-${index}`).addEventListener('click', () => skipProduct(index));

  // Submit
  card.querySelector(`#submit-product-${index}`).addEventListener('click', () => submitProduct(index));
}

// Submit доступен только если подтверждены права на артворк
// (или продукт помечен как blank через Skip — тогда артворка нет вовсе)
function updateSubmitEnabled(index) {
  const ps  = state.productStates[index];
  const btn = document.getElementById(`submit-product-${index}`);
  if (!ps || !btn) return;
  btn.disabled = !(ps.skipped || ps.rightsConfirmed);
}

// ─── EXPAND / COLLAPSE ────────────────────────────────────────────────────────
function toggleProduct(index) {
  if (state.expandedIndex === index) {
    collapseProduct(index);
  } else {
    if (state.expandedIndex !== -1) collapseProduct(state.expandedIndex);
    expandProduct(index);
  }
}

function expandProduct(index) {
  if (state.productStates[index]?.status === 'submitted' ||
      state.productStates[index]?.status === 'uploading') return;
  const card = getCard(index);
  if (!card) return;

  card.classList.add('is-open');
  card.querySelector('.product-card__header').setAttribute('aria-expanded', 'true');
  card.querySelector('.product-card__body').removeAttribute('hidden');
  state.expandedIndex = index;

  // Mark as in-progress if still pending
  if (state.productStates[index].status === 'pending') {
    setProductStatus(index, 'in-progress');
  }
}

function collapseProduct(index) {
  const card = getCard(index);
  if (!card) return;

  card.classList.remove('is-open');
  card.querySelector('.product-card__header').setAttribute('aria-expanded', 'false');
  card.querySelector('.product-card__body').setAttribute('hidden', '');
  if (state.expandedIndex === index) state.expandedIndex = -1;
}

function getCard(index) {
  return document.querySelector(`.product-card[data-index="${index}"]`);
}

// ─── STATUS ───────────────────────────────────────────────────────────────────
function setProductStatus(index, status) {
  state.productStates[index].status = status;
  const card = getCard(index);
  if (!card) return;

  card.dataset.status = status;
  const badge = card.querySelector('.status-badge');
  if (badge) {
    badge.className = 'status-badge status-badge--' + status;
    if (status === 'submitted')        badge.textContent = '✓ Submitted';
    else if (status === 'uploading')   badge.textContent = 'Uploading…';
    else if (status === 'in-progress') badge.textContent = 'In Progress';
    else badge.textContent = 'Pending';
  }

  updateProductsCounter();
}

function updateProductsCounter() {
  const total     = state.productStates.length;
  const submitted = state.productStates.filter(s => s.status === 'submitted').length;
  const el = document.getElementById('products-counter');
  if (el) el.textContent = submitted > 0 ? submitted + ' of ' + total + ' submitted' : '';
}

// ─── FILE HANDLING ────────────────────────────────────────────────────────────
function addFiles(index, fileList) {
  const ps = state.productStates[index];
  let hasError = false;

  Array.from(fileList).forEach(file => {
    const ext = file.name.split('.').pop().toLowerCase();
    if (!CONFIG.ALLOWED_EXTENSIONS.includes(ext)) {
      showFieldError(index, 'files', `"${file.name}" — only AI, EPS, PNG, PDF, CSV, SVG allowed.`);
      hasError = true;
      return;
    }
    if (file.size > CONFIG.MAX_FILE_SIZE_MB * 1048576) {
      showFieldError(index, 'files', `"${file.name}" exceeds the 100 MB limit.`);
      hasError = true;
      return;
    }
    ps.files.push({ file, id: ++ps.fileIdCounter });
  });

  renderFileList(index);
  if (!hasError) clearFieldError(index, 'files');
}

function removeFile(index, id) {
  state.productStates[index].files = state.productStates[index].files.filter(f => f.id !== id);
  renderFileList(index);
}

function renderFileList(index) {
  const ul = document.getElementById('file-list-' + index);
  ul.innerHTML = '';
  state.productStates[index].files.forEach(({ file, id }) => {
    const li = document.createElement('li');
    li.innerHTML =
      `<span class="file-list__name" title="${esc(file.name)}">${esc(file.name)}</span>` +
      `<span class="file-list__size">${formatFileSize(file.size)}</span>` +
      `<button type="button" class="file-remove-btn" aria-label="Remove ${esc(file.name)}" data-id="${id}">×</button>`;
    ul.appendChild(li);
  });
}

// ─── VALIDATION ───────────────────────────────────────────────────────────────
function showFieldError(index, field, message) {
  const group = document.getElementById(`field-${field}-${index}`);
  const el    = document.getElementById(`error-${field}-${index}`);
  if (group) group.classList.add('has-error');
  if (el)    { el.textContent = message; el.removeAttribute('hidden'); }
}

function clearFieldError(index, field) {
  const group = document.getElementById(`field-${field}-${index}`);
  const el    = document.getElementById(`error-${field}-${index}`);
  if (group) group.classList.remove('has-error');
  if (el)    { el.setAttribute('hidden', ''); el.textContent = ''; }
}

function validateProduct(index) {
  const ps = state.productStates[index];
  let valid = true;

  ['files', 'colors', 'placement', 'embellishment', 'rights'].forEach(f => clearFieldError(index, f));

  const placement = (document.getElementById(`input-placement-${index}`)?.value || '').trim();

  if (!ps.isReorder) {
    if (ps.files.length === 0) {
      showFieldError(index, 'files', 'Please upload at least one artwork file.');
      valid = false;
    }

    if (!placement) {
      showFieldError(index, 'placement', 'Placement directions are required.');
      valid = false;
    } else if (placement.length < 5) {
      showFieldError(index, 'placement', 'Please provide more detail (at least 5 characters).');
      valid = false;
    }

    const hasEmbellishment =
      (state.orderData?.groups[index]?.embellishmentTypes || []).length > 0;

    if (hasEmbellishment && !ps.embellishment) {
      showFieldError(index, 'embellishment', 'Please select an embellishment type.');
      valid = false;
    }

    if (!ps.rightsConfirmed) {
      showFieldError(index, 'rights', 'Please confirm you have the rights to use this artwork.');
      valid = false;
    }
  }

  const notes = (document.getElementById(`input-notes-${index}`)?.value || '').trim();

  // Store values on state so submitProduct reads the same values
  ps.placement       = placement;
  ps.additionalNotes = notes;

  return valid;
}

// ─── DROPBOX UPLOAD ───────────────────────────────────────────────────────────
// HTTP headers must be ASCII — Unicode-escape any non-ASCII chars in the JSON arg
function asciiJson(obj) {
  return JSON.stringify(obj).replace(/[^\x00-\x7F]/g, c =>
    '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')
  );
}

let _dropboxTokenCache = { token: null, expiresAt: 0 };

async function getDropboxAccessToken() {
  const now = Date.now();
  if (_dropboxTokenCache.token && now < _dropboxTokenCache.expiresAt) {
    return _dropboxTokenCache.token;
  }
  const res = await fetch('https://api.dropbox.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: CONFIG.DROPBOX_REFRESH_TOKEN,
      client_id:     CONFIG.DROPBOX_APP_KEY,
      client_secret: CONFIG.DROPBOX_APP_SECRET,
    }),
  });
  if (!res.ok) throw new Error('Failed to refresh Dropbox token: ' + await res.text());
  const data = await res.json();
  _dropboxTokenCache.token     = data.access_token;
  _dropboxTokenCache.expiresAt = now + (data.expires_in - 300) * 1000;
  return data.access_token;
}

async function uploadFileToDropbox(file, orderId, productName) {
  const token        = await getDropboxAccessToken();
  const safeId       = String(orderId).replace(/[^\w\-]/g, '_').slice(0, 50);
  const safeName     = productName.replace(/[^\w\-]/g, '_').trim().slice(0, 60) || 'product';
  const safeFileName = file.name.replace(/[^\w.\-]/g, '_');
  const folderPath   = `${CONFIG.DROPBOX_UPLOAD_FOLDER}/${safeId}/${safeName}`;
  const path         = `${folderPath}/${Date.now()}_${safeFileName}`;

  // Create folder before upload — ignore 409 (folder already exists)
  await fetch('https://api.dropboxapi.com/2/files/create_folder_v2', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({ path: folderPath, autorename: false }),
  });

  const uploadRes = await fetch('https://content.dropboxapi.com/2/files/upload', {
    method: 'POST',
    headers: {
      'Authorization':    'Bearer ' + token,
      'Dropbox-API-Arg':  asciiJson({ path, mode: 'add', autorename: true, mute: true }),
      'Content-Type':     'application/octet-stream',
    },
    body: file,
  });

  if (!uploadRes.ok) {
    const txt = await uploadRes.text();
    console.error('[Dropbox upload] path:', path);
    console.error('[Dropbox upload] status:', uploadRes.status, 'response:', txt);
    throw new Error(`Dropbox upload failed for "${file.name}": ${txt.slice(0, 300)}`);
  }

  const uploaded = await uploadRes.json();

  const linkRes = await fetch('https://api.dropboxapi.com/2/sharing/create_shared_link_with_settings', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      path: folderPath,
      settings: { requested_visibility: 'public' },
    }),
  });

  if (!linkRes.ok) {
    const errBody = await linkRes.json().catch(() => ({}));
    // Dropbox returns this error when a link already exists for the path — reuse it
    const existing = errBody?.error?.shared_link_already_exists?.metadata?.url;
    if (existing) return existing.replace('?dl=0', '?dl=1');

    // URL not embedded in error — fetch the existing link via list_shared_links
    const listRes = await fetch('https://api.dropboxapi.com/2/sharing/list_shared_links', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: folderPath, direct_only: true }),
    });
    if (listRes.ok) {
      const listData = await listRes.json();
      const link = listData.links?.[0]?.url;
      if (link) return link.replace('?dl=0', '?dl=1');
    }

    throw new Error(`Failed to create Dropbox link for "${file.name}"`);
  }

  const linkData = await linkRes.json();
  return linkData.url.replace('?dl=0', '?dl=1');
}

// ─── SKIP PRODUCT ────────────────────────────────────────────────────────────
function skipProduct(index) {
  state.productStates[index].skipped = true;
  const card = getCard(index);
  card.querySelector(`#skip-confirm-${index}`).setAttribute('hidden', '');
  card.querySelector(`#footer-${index}`).removeAttribute('hidden');
  card.querySelector(`#skip-btn-${index}`).setAttribute('hidden', '');
  card.querySelector(`#skip-banner-${index}`).removeAttribute('hidden');
  card.querySelector(`#client-fields-${index}`).setAttribute('hidden', '');
  card.querySelector(`#reorder-check-${index}`).setAttribute('hidden', '');
  card.querySelector(`#field-rights-${index}`).setAttribute('hidden', '');
  updateSubmitEnabled(index);
}

// ─── SUBMIT PRODUCT ───────────────────────────────────────────────────────────
async function submitProduct(index) {
  const ps = state.productStates[index];
  if (!ps.skipped && !validateProduct(index)) return;

  const group = state.orderData.groups[index];
  const btn   = document.getElementById(`submit-product-${index}`);
  const errEl = document.getElementById(`error-global-${index}`);

  // Защита от отправки в непрописанный тестовый вебхук
  if (!/^https?:\/\//.test(CONFIG.MAKE_SUBMIT_WEBHOOK)) {
    if (errEl) {
      errEl.textContent = 'Test submit webhook is not configured — paste the cloned Make webhook into ENV.test.SUBMIT.';
      errEl.removeAttribute('hidden');
    }
    return;
  }

  btn.disabled = true;
  setProductStatus(index, 'uploading');
  collapseProduct(index);
  if (errEl) errEl.setAttribute('hidden', '');

  try {
    const orderId = state.orderData.orderNumber;
    if (!orderId) throw new Error('Missing order ID — cannot submit.');

    group.products.forEach(p => {
      if (!p.recordId) throw new Error(`Missing recordId for "${p.productName}".`);
    });

    const productList = group.products.map(p => ({
      recordId:     p.recordId,
      productIndex: p.index,
      productName:  p.productName,
      baseColor:    p.baseColor,
      variantColor: p.variantColor,
      variantName:  p.variantName,
      size:         p.size,
    }));

    let payload;

    if (ps.skipped) {
      payload = {
        orderId,
        products: productList,
        productName: group.productName,
        color:       group.color,
        variant:     group.variant,
        skipped: true,
        isReorder: ps.isReorder,
      };
    } else {
      let dropboxUrl = '';
      const card  = getCard(index);
      const badge = card?.querySelector('.status-badge');
      for (let i = 0; i < ps.files.length; i++) {
        if (badge) badge.textContent = `Uploading ${i + 1} of ${ps.files.length}…`;
        const item = ps.files[i];
        dropboxUrl = await uploadFileToDropbox(item.file, orderId, group.folderLabel || group.productName);
      }

      const colors          = document.getElementById(`input-colors-${index}`)?.value.trim() || '';
      const placement       = ps.placement || '';
      const embellishment   = ps.embellishment;
      const additionalNotes = ps.additionalNotes || '';

      payload = {
        orderId,
        products: productList,
        productName: group.productName,
        color:       group.color,
        variant:     group.variant,
        skipped: false,
        isReorder: ps.isReorder,
        colors, placement, embellishment, additionalNotes,
        dropboxUrl,
      };
    }

    const response = await fetch(CONFIG.MAKE_SUBMIT_WEBHOOK, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });

    if (!response.ok) throw new Error('HTTP ' + response.status);

    setProductStatus(index, 'submitted');
    collapseProduct(index);

    const allDone = state.productStates.every(s => s.status === 'submitted');
    if (allDone) {
      showAllSubmitted();
      return;
    }

    // Auto-open next non-submitted product
    const next = state.productStates.findIndex((s, i) => i !== index && s.status !== 'submitted');
    if (next !== -1) expandProduct(next);

  } catch (err) {
    console.error('[submitProduct]', err);
    setProductStatus(index, 'in-progress');
    expandProduct(index);
    btn.textContent = 'Submit Product';
    updateSubmitEnabled(index);
    if (errEl) { errEl.textContent = 'Something went wrong. Please try again.'; errEl.removeAttribute('hidden'); }
  }
}

// ─── DROPBOX TOKEN TEST ───────────────────────────────────────────────────────
async function testDropboxToken() {
  try {
    const token = await getDropboxAccessToken();
    const res = await fetch('https://api.dropboxapi.com/2/users/get_current_account', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token },
    });
    if (res.ok) {
      const data = await res.json();
      const msg = `✅ Dropbox token OK\nAccount: ${data.name?.display_name}\nEmail: ${data.email}`;
      console.log(msg, data);
      alert(msg);
    } else {
      const txt = await res.text();
      const msg = `❌ Dropbox token INVALID (HTTP ${res.status})\n${txt.slice(0, 300)}`;
      console.error(msg);
      alert(msg);
    }
  } catch (err) {
    const msg = `❌ Request failed: ${err.message}`;
    console.error(msg);
    alert(msg);
  }
}

// ─── INIT ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  if (TEST_MODE) console.warn('[OPENHOUSE] TEST MODE — Dropbox folder:', CONFIG.DROPBOX_UPLOAD_FOLDER);
  loadOrder();
  document.getElementById('retry-load-btn')?.addEventListener('click', loadOrder);
});
