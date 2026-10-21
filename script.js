// Версия файла — видна в консоли при загрузке страницы.
// Если в консоли не та версия, что ожидаешь, значит залит старый файл или кеш.
const OH_VERSION = '2026-10-21 prod release: multi-location + re-order picker';

// ─── ENVIRONMENT SWITCH ─────────────────────────────────────────────────────
// TEST_MODE = true  → пишем только в тестовый сценарий Make + тестовую папку Dropbox
// TEST_MODE = false → продакшн (оригинальный сценарий)
const TEST_MODE = false;

const ENV = {
  prod: {
    GET:    'https://hook.us2.make.com/bj7rkp54m58ktvgg5xewf7d9q7wpkwiw',
    SUBMIT: 'https://hook.us2.make.com/yhpis63d8gjb941ouh2t6jkw9f4iw28v',
    LOG:    'https://hook.us2.make.com/snqik9c4p8r2i5xvcm5l48ietuaumi65',
    // Поиск прошлых Design Requests для re-order (сценарий «Artwork form design requests PROD»)
    DESIGN: 'https://hook.us2.make.com/tjm4l878pg9ju3737mpevhckdugbkxbx',
    FOLDER: '/Artwork Orders',
  },
  test: {
    GET:    'https://hook.us2.make.com/ueh7ll5kvjqxxt9whr4bwd3mwn4vfiyl',
    SUBMIT: 'https://hook.us2.make.com/dq4b9ich5wdsdjidhk0smh6w9svh5uu2',
    LOG:    'https://hook.us2.make.com/snqik9c4p8r2i5xvcm5l48ietuaumi65',
    DESIGN: 'https://hook.us2.make.com/4jlf5yntgjnxwef1q982urdcpis1xth5',
    FOLDER: '/Artwork Orders TEST',
  },
};

const ACTIVE = TEST_MODE ? ENV.test : ENV.prod;

// ─── CONFIG ─────────────────────────────────────────────────────────────────
const CONFIG = {
  MAKE_GET_WEBHOOK:      ACTIVE.GET,
  MAKE_SUBMIT_WEBHOOK:   ACTIVE.SUBMIT,
  MAKE_VIEW_LOG_WEBHOOK: ACTIVE.LOG,
  MAKE_DESIGN_REQUESTS_WEBHOOK: ACTIVE.DESIGN,
  // Прокси для рендера PDF/.ai превью в браузере
  IMAGE_PROXY:           'https://wsrv.nl/?url=',
  DROPBOX_APP_KEY:       'swz1bzruuwvzkop',
  DROPBOX_APP_SECRET:    'bndcd2tbdztq3yh',
  DROPBOX_REFRESH_TOKEN: '5nl_-90oG0kAAAAAAAAAAYe9LQrN-pHIEo01fbfcgbjd9M6Fds4r3cao2RdT6kLu',
  DROPBOX_UPLOAD_FOLDER: ACTIVE.FOLDER,
  ALLOWED_EXTENSIONS:    ['ai', 'eps', 'png', 'pdf', 'csv', 'svg', 'psd'],
  MAX_FILE_SIZE_MB:      150,
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
    locations:       [{ files: [], fileIdCounter: 0 }],   // минимум одна локация
    reorderRequests:  null,   // null = ещё не запрашивали, [] = ничего не найдено
    reorderLoading:   false,
    reorderSelectedId: null,
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
      productRecIds:     Array.isArray(p['Products_new']) ? p['Products_new'].filter(Boolean) : [],
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

    // record id продуктов группы — по ним ищем прошлые Design Requests
    g.productRecIds = [...new Set(g.products.flatMap(p => p.productRecIds))];
    g.lineItemRecIds = [...new Set(g.products.map(p => p.recordId).filter(Boolean))];

    // Имя папки Dropbox — с цветом, чтобы файлы разных колорвеев не смешивались
    g.folderLabel = [g.productName, g.color].filter(Boolean).join(' - ');
  });

  return {
    orderNumber:     raw.order_number || raw.orderNumber || '',
    orderDate:       formatDate(raw.order_date || raw.orderDate || ''),
    client:          raw.client_name  || raw.client  || raw.client_id  || '',
    customerId:      firstString(raw.customer_id ?? raw.customerId),
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

// ─── RE-ORDER: ВЫБОР ПРОШЛОГО DESIGN REQUEST ─────────────────────────────────
// Стили инжектим из JS, чтобы не трогать style.css
function injectReorderStyles() {
  if (document.getElementById('oh-reorder-styles')) return;
  const st = document.createElement('style');
  st.id = 'oh-reorder-styles';
  st.textContent = `
    .reorder-picker__status { font-size: 13px; color: #8A8578; margin: 4px 0 12px; }
    .reorder-picker__empty  { font-size: 13px; color: #A8432B; margin: 4px 0 12px; }
    .reorder-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
                    gap: 12px; margin-top: 8px; }
    .rq-card { position: relative; border: 1px solid #DDD8CC; border-radius: 6px;
               background: #FCFBF7; padding: 10px; cursor: pointer; display: block;
               transition: border-color .15s, box-shadow .15s; }
    .rq-card:hover { border-color: #B5AE9C; }
    .rq-card.is-selected { border-color: #1A1A1A; box-shadow: 0 0 0 1px #1A1A1A inset; }
    .rq-card input { position: absolute; opacity: 0; pointer-events: none; }
    .rq-card__thumb { width: 100%; aspect-ratio: 1 / 1; background: #EAE7DF; border-radius: 4px;
                      display: flex; align-items: center; justify-content: center;
                      overflow: hidden; margin-bottom: 8px; }
    .rq-card__thumb img { width: 100%; height: 100%; object-fit: contain; }
    .rq-card__thumb span { font-size: 10px; letter-spacing: .08em; color: #A39C8A; }
    .rq-card__name { display: block; font-size: 13px; font-weight: 600; line-height: 1.3;
                     margin-bottom: 3px; }
    .rq-card__meta { display: block; font-size: 11px; color: #8A8578; line-height: 1.4; }
    .rq-card__link { display: inline-block; margin-top: 10px; padding: 6px 11px;
                     font-size: 10px; font-weight: 600; letter-spacing: .08em;
                     text-transform: uppercase; color: #1A1A1A;
                     background: #FCFBF7; border: 1px solid #1A1A1A; border-radius: 3px;
                     cursor: pointer; font-family: inherit; }
    .rq-card__link:hover { background: #1A1A1A; color: #FCFBF7; }

    /* Карточка без превью: только название, заказ и кнопка */
    .rq-card--compact { display: flex; flex-direction: column; justify-content: center;
                        min-height: 0; }
    .rq-card--compact .rq-card__name { font-size: 14px; }

    .product-card [hidden] { display: none !important; }
    .locations { margin-bottom: 4px; }
    .loc-item--first { margin: 0; }

    /* Дополнительная локация — отдельная карточка */
    .loc-item:not(.loc-item--first) {
      border: 1px solid #DDD8CC; border-radius: 6px; background: #FCFBF7;
      padding: 14px 18px 4px; margin-top: 14px; }
    .loc-price-note { margin: 0 0 14px; padding: 9px 12px;
                      background: #F2EFE7; border-left: 2px solid #A8432B;
                      border-radius: 0 3px 3px 0;
                      font-size: 12px; line-height: 1.45; color: #1A1A1A; }
    .loc-price-note strong { font-weight: 600; color: #A8432B; }
    .loc-item__head { display: flex; align-items: center; gap: 8px;
                      margin: 0 0 14px; padding-bottom: 10px;
                      border-bottom: 1px solid #EDE9DF; }
    .loc-title { font-size: 11px; letter-spacing: .1em; text-transform: uppercase;
                 color: #1A1A1A; font-weight: 600; }
    .loc-remove { margin-left: auto; background: none; border: 0; padding: 0;
                  cursor: pointer; font-family: inherit; font-size: 11px;
                  color: #8A8578; text-decoration: underline; }
    .loc-remove:hover { color: #A8432B; }

    /* Кнопка под последним Placement Directions */
    .loc-add { display: inline-flex; align-items: center; gap: 6px;
               margin: 2px 0 18px; padding: 8px 14px;
               background: #FCFBF7; border: 1px dashed #B5AE9C; border-radius: 4px;
               cursor: pointer; font-family: inherit; font-size: 11px; font-weight: 600;
               letter-spacing: .08em; text-transform: uppercase; color: #1A1A1A; }
    .loc-add span { font-size: 15px; line-height: 1; }
    .loc-add:hover { border-style: solid; border-color: #1A1A1A; }
    .loc-add[hidden] { display: none; }

    .ohm { position: fixed; inset: 0; z-index: 9999; display: flex;
           align-items: center; justify-content: center; padding: 14px; }
    .ohm[hidden] { display: none; }
    .ohm__backdrop { position: absolute; inset: 0; background: rgba(26,26,26,.62);
                     cursor: pointer; }
    .ohm__dialog { position: relative; display: flex; flex-direction: column;
                   width: min(1680px, 96vw); height: 94vh;
                   background: #FCFBF7; border: 1px solid #DDD8CC; border-radius: 8px;
                   box-shadow: 0 24px 64px rgba(0,0,0,.35); overflow: hidden; }
    .ohm__head { display: flex; align-items: flex-start; gap: 12px;
                 padding: 14px 16px; border-bottom: 1px solid #E6E1D6; }
    .ohm__title { font-size: 14px; font-weight: 600; margin: 0 0 2px; line-height: 1.3; }
    .ohm__meta { font-size: 11px; color: #8A8578; margin: 0; line-height: 1.4; }
    .ohm__close { margin-left: auto; display: inline-flex; align-items: center; gap: 6px;
                  padding: 7px 12px; border: 1px solid #1A1A1A; border-radius: 4px;
                  background: #FCFBF7; color: #1A1A1A; cursor: pointer;
                  font-family: inherit; font-size: 11px; font-weight: 600;
                  letter-spacing: .08em; text-transform: uppercase; line-height: 1; }
    .ohm__close span { font-size: 16px; line-height: 1; }
    .ohm__close:hover { background: #1A1A1A; color: #FCFBF7; }
    .ohm__body { flex: 1 1 auto; overflow: auto; padding: 14px; background: #F2EFE7;
                 display: flex; align-items: stretch; justify-content: center; }
    /* Пруф во всю ширину экрана: масштаб ограничен только окном браузера */
    .ohm__body img { display: block; width: 100%; max-width: none; height: auto;
                     align-self: flex-start; background: #FFF; cursor: zoom-in; }
    .ohm__loading { font-size: 12px; color: #8A8578; padding: 40px; }
    .ohm__frame { display: block; width: 100%; height: 100%; min-height: 0; border: 0;
                  background: #FFF; }
    .ohm__body--frame { padding: 0; overflow: hidden; }
    .ohm__linkbox { text-align: center; padding: 44px 20px; }
    .ohm__linkbox-t { font-size: 15px; font-weight: 600; margin: 0 0 6px; }
    .ohm__linkbox-b { font-size: 12px; color: #8A8578; line-height: 1.5;
                      margin: 0 auto 18px; max-width: 340px; }
    .ohm__btn { display: inline-block; padding: 10px 20px; font-size: 12px;
                letter-spacing: .04em; text-transform: uppercase;
                background: #1A1A1A; color: #FCFBF7; border-radius: 3px;
                text-decoration: none; }
    .ohm__btn:hover { background: #333; }
    .ohm__foot { display: flex; align-items: center; gap: 12px;
                 padding: 12px 16px; border-top: 1px solid #E6E1D6; }
    .ohm__note { font-size: 11px; color: #8A8578; margin: 0; }
    .ohm__open { margin-left: auto; font-size: 12px; text-decoration: underline;
                 color: #1A1A1A; white-space: nowrap; }
  `;
  document.head.appendChild(st);
}

// Превью пруфа: вложение рендерим напрямую, PDF/.ai — через прокси.
// Если пруф был отправлен ссылкой, картинки нет — показываем плейсхолдер и кнопку.
// Превью для карточки. Airtable-превью вложения — уже картинка, даже если
// сам файл PDF, поэтому прокси тут не нужен. Если превью нет — мокап заявки.
function proofThumbHtml(rq) {
  // превью вложения, иначе мокап заявки (лёгкий thumbnail, не полный файл)
  const src = rq.proofThumbUrl || rq.mockupThumb || rq.mockupUrl || '';
  if (!src) return '';   // нечего показать — карточка без картинки
  return `<div class="rq-card__thumb"><img src="${esc(src)}" alt="" loading="lazy"></div>`;
}

// ─── МОДАЛКА ПРОСМОТРА ПРУФА ─────────────────────────────────────────────────
let _ohModal = null;

function ensureProofModal() {
  if (_ohModal) return _ohModal;

  const el = document.createElement('div');
  el.className = 'ohm';
  el.id = 'oh-proof-modal';
  el.setAttribute('hidden', '');
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.innerHTML = `
    <div class="ohm__backdrop" data-ohm-close="1"></div>
    <div class="ohm__dialog">
      <div class="ohm__head">
        <div>
          <p class="ohm__title" id="ohm-title"></p>
          <p class="ohm__meta"  id="ohm-meta"></p>
        </div>
        <button type="button" class="ohm__close" data-ohm-close="1" aria-label="Close preview"><span aria-hidden="true">&times;</span>Close</button>
      </div>
      <div class="ohm__body" id="ohm-body"></div>
      <div class="ohm__foot">
        <p class="ohm__note" id="ohm-note"></p>
        <a class="ohm__open" id="ohm-open" target="_blank" rel="noopener">Open in a new tab</a>
      </div>
    </div>`;

  el.addEventListener('click', e => {
    if (e.target.closest('[data-ohm-close]')) closeProofModal();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !el.hasAttribute('hidden')) closeProofModal();
  });

  document.body.appendChild(el);
  _ohModal = el;
  return el;
}

function closeProofModal() {
  const el = document.getElementById('oh-proof-modal');
  if (!el) return;
  el.setAttribute('hidden', '');
  // выгружаем содержимое, чтобы не грузить фрейм в фоне
  const body = document.getElementById('ohm-body');
  if (body) body.innerHTML = '';
  document.body.style.overflow = '';
}

function openProofModal(rq) {
  ensureProofModal();

  const meta = [
    rq.orderNumber ? 'Order #' + rq.orderNumber : '',
    formatDate(rq.date) || '',
  ].filter(Boolean).join(' · ');

  document.getElementById('ohm-title').textContent = rq.requestName || 'Previous design';
  document.getElementById('ohm-meta').textContent  = meta;

  const openUrl = rq.proofFileUrl || rq.proofUrl || '';
  const openLink = document.getElementById('ohm-open');
  openLink.href = openUrl;
  openLink.hidden = !openUrl;

  const body = document.getElementById('ohm-body');
  const note = document.getElementById('ohm-note');
  body.classList.remove('ohm__body--frame');

  // Качество превью по убыванию:
  // 1) оригинал файла через прокси — самый крупный вариант (Airtable отдаёт
  //    для PDF только thumbnails до 512px, оригинал даёт полное разрешение)
  // 2) thumbnails.full / large от Airtable
  // 3) мокап заявки
  // Для PDF/AI/EPS Airtable даёт превью не крупнее 644px (full отсутствует),
  // поэтому документы всегда рендерим из оригинала через прокси на 2600px —
  // и для файла пруфа, и для мокапа, если в мокап положили PDF.
  const DOC = /pdf|postscript|illustrator|tiff/i;
  const viaProxy = url => url
    ? CONFIG.IMAGE_PROXY + encodeURIComponent(url) + '&w=2600&output=jpg'
    : '';

  const proofIsDoc  = DOC.test(rq.proofFileType || '');
  const mockupIsDoc = DOC.test(rq.mockupType || '');

  const primary =
       (proofIsDoc  && viaProxy(rq.proofFileUrl))
    || rq.proofFullUrl || rq.proofThumbUrl
    || (mockupIsDoc && viaProxy(rq.mockupOrigUrl))
    || rq.mockupFull || rq.mockupUrl || '';

  const fallback = rq.proofFullUrl || rq.proofThumbUrl || rq.mockupFull || rq.mockupUrl || '';

  if (primary) {
    body.innerHTML = `<img id="ohm-img" src="${esc(primary)}" alt="${esc(rq.requestName || 'Proof')}">`;
    note.textContent = rq.proofFromVendorFiles
      ? 'Approved proof file.'
      : (rq.proofFullUrl || rq.proofFileUrl)
        ? 'Preview of the approved proof.'
        : 'Product mockup from this design request.';

    // если прокси не отдал картинку — молча падаем на превью Airtable
    const img = document.getElementById('ohm-img');
    if (img && openUrl) {
      img.addEventListener('click', () => window.open(openUrl, '_blank', 'noopener'));
    }
    if (img && fallback && fallback !== primary) {
      img.addEventListener('error', () => {
        if (img.dataset.fellBack) return;
        img.dataset.fellBack = '1';
        img.src = fallback;
      }, { once: false });
    }
  } else if (rq.proofUrl) {
    // Пруф отправлен ссылкой — показываем страницу прямо в модалке
    body.classList.add('ohm__body--frame');
    body.innerHTML = `<iframe class="ohm__frame" src="${esc(rq.proofUrl)}"
      title="Proof preview"></iframe>`;
    note.textContent = 'Approved proof page. If it stays blank, open it in a new tab.';
  } else {
    body.innerHTML = `
      <div class="ohm__linkbox">
        <p class="ohm__linkbox-t">No preview available</p>
        <p class="ohm__linkbox-b">This design request has no proof file or link attached.</p>
      </div>`;
    note.textContent = '';
  }

  document.getElementById('oh-proof-modal').removeAttribute('hidden');
  document.body.style.overflow = 'hidden';
}

function buildRequestCard(rq, index) {
  const meta = [
    rq.orderNumber ? 'Order #' + rq.orderNumber : '',
    formatDate(rq.date) || '',
  ].filter(Boolean).join(' · ');


  const hasPreview = rq.proofFullUrl || rq.proofThumbUrl || rq.mockupUrl || rq.proofUrl;
  const linkHtml = hasPreview
    ? `<button type="button" class="rq-card__link" data-rq-view="${esc(rq.id)}">View proof</button>`
    : '';

  const thumb = proofThumbHtml(rq);

  return `
    <label class="rq-card${thumb ? '' : ' rq-card--compact'}" data-id="${esc(rq.id)}">
      <input type="radio" name="reorder-request-${index}" value="${esc(rq.id)}">
      ${thumb}
      <span class="rq-card__name">${esc(rq.requestName || 'Previous design')}</span>
      <span class="rq-card__meta">${esc(meta)}</span>
      ${linkHtml}
    </label>
  `;
}

function renderReorderPicker(index) {
  const box = document.getElementById(`reorder-picker-${index}`);
  if (!box) return;
  const ps = state.productStates[index];

  if (ps.reorderLoading) {
    box.innerHTML = `<p class="reorder-picker__status">Looking up your previous designs…</p>`;
    return;
  }

  if (!Array.isArray(ps.reorderRequests)) { box.innerHTML = ''; return; }

  if (ps.reorderRequests.length === 0) {
    box.innerHTML = `<p class="reorder-picker__empty">We couldn't find any previously approved proofs for this product.<br>Please fill out the form below or contact us.</p>`;
    // Пруфов нет — возвращаем поля загрузки артворка и делаем их снова обязательными,
    // иначе клиент оказывается в тупике: выбрать нечего и загрузить некуда.
    setArtworkFieldsHidden(index, false);
    setArtworkFieldsRequired(index, true);
    box.removeAttribute('hidden');   // контейнер с сообщением должен остаться виден
    return;
  }

  box.innerHTML = `
    <div class="field-label-row">
      <span class="field-label">Select Previous Design</span>
      <span class="badge badge--required">Mandatory</span>
    </div>
    <div class="reorder-grid">
      ${ps.reorderRequests.map(rq => buildRequestCard(rq, index)).join('')}
    </div>
    <p class="field-error" id="error-reorder-${index}" role="alert" hidden></p>
  `;

  box.querySelectorAll('.rq-card').forEach(card => {
    card.addEventListener('click', () => {
      box.querySelectorAll('.rq-card').forEach(c => c.classList.remove('is-selected'));
      card.classList.add('is-selected');
      const input = card.querySelector('input');
      if (input) input.checked = true;
      ps.reorderSelectedId = card.dataset.id;
      clearFieldError(index, 'reorder');
      updateSubmitEnabled(index);
    });
    // клик по "View proof" открывает модалку и не выбирает карточку
    card.querySelectorAll('[data-rq-view]').forEach(btn =>
      btn.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        const rq = (ps.reorderRequests || []).find(x => x.id === btn.dataset.rqView);
        if (rq) openProofModal(rq);
      }));
  });
}

// Ответ вебхука принимаем в двух видах: либо готовый контракт
// (id/requestName/proofUrl...), либо сырые поля Airtable из агрегатора Make.
// Часть approval_link в Airtable сохранена как http:// — на HTTPS-странице
// такие ссылки помечаются небезопасными, поднимаем схему.
function httpsUrl(u) {
  const s = String(u || '').trim();
  return s.startsWith('http://') ? 'https://' + s.slice(7) : s;
}

// approval.byopenhouse.com закрыт для встраивания (X-Frame-Options: DENY,
// frame-ancestors 'none'), а artwork.byopenhouse.com — та же страница
// без ограничений. id в ссылках одинаковый, поэтому переписываем домен,
// чтобы пруф открывался внутри модалки, а не в отдельной вкладке.
function embeddableProofUrl(u) {
  const url = httpsUrl(u);
  if (!url) return '';
  const id = (url.match(/[?&]id=(rec\w+)/) || [])[1];
  return id ? 'https://artwork.byopenhouse.com/approval/?id=' + id : url;
}

function normaliseRequest(rq) {
  if (!rq || typeof rq !== 'object') return null;

  // Файл пруфа: сначала Unsigned Proof (старый формат), иначе утверждённый PDF,
  // который страница аппрува сама выгружает в Vendor Production Files.
  // Это полноценный документ — он рендерится чётко, в отличие от сжатого мокапа.
  const pickPdfFirst = arr => Array.isArray(arr)
    ? (arr.find(a => /pdf/i.test(a?.type || a?.filename || '')) || arr.find(a => a?.url) || null)
    : null;

  const unsignedRaw = rq['Unsigned Proof'] ?? rq.unsignedProof;
  const vendorRaw   = rq['Vendor Production Files'] ?? rq.vendorProductionFiles;
  const fromVendor  = !firstAttachment(unsignedRaw) && !!firstAttachment(vendorRaw);
  const proofRaw    = fromVendor ? vendorRaw : unsignedRaw;

  const proofItem  = fromVendor ? pickPdfFirst(vendorRaw) : (Array.isArray(proofRaw) ? proofRaw[0] : null);
  const attachment = proofItem
    ? { url: proofItem.url, thumb: proofItem.thumbnails?.large?.url || proofItem.thumbnails?.small?.url || '' }
    : firstAttachment(proofRaw);
  // Мокап может прийти из поля самой заявки или из лукапа со строки заказа
  // (через связь Digital proof) — берём первое поле с "mockup" в имени,
  // где реально лежит вложение. Так не важно, как назван лукап.
  const mockupRaw = [rq['Product mockup: High-res'], rq.mockup,
    ...Object.keys(rq).filter(k => /mockup/i.test(k)).map(k => rq[k])]
    .find(v => firstAttachment(v));
  const mockup = firstAttachment(mockupRaw);

  // Airtable рендерит превью и для PDF — берём самое крупное из доступных
  const att = proofItem;
  const fullUrl = att?.thumbnails?.full?.url || att?.thumbnails?.large?.url || '';

  const mk = Array.isArray(mockupRaw) ? mockupRaw[0] : null;
  const mockupFull = mk?.thumbnails?.full?.url || mk?.thumbnails?.large?.url || mk?.url || '';
  const mockupType = mk?.type || (/\.(pdf|ai|eps)$/i.test(mk?.filename || '') ? 'application/pdf' : '');
  const fileName = att?.filename || '';

  const sentAsLinkRaw = rq.sentAsLink ?? rq['Proof Sent As Link'];

  return {
    id:            firstString(rq.id ?? rq.recordID ?? rq.recordId),
    requestName:   firstString(rq.requestName ?? rq['Request Name']),
    orderNumber:   firstString(rq.orderNumber ?? rq['Order']),
    productName:   firstString(rq.productName ?? rq['Product Name']),
    date:          firstString(rq.date ?? rq['Order Date']),
    proofFileName: fileName || firstString(rq.proofFileName),
    sentAsLink:    sentAsLinkRaw === true || sentAsLinkRaw === 'checked',
    proofUrl:      embeddableProofUrl(firstString(rq.proofUrl ?? rq.approval_link ?? rq['approval_link'])),
    proofFileUrl:  firstString(rq.proofFileUrl) || attachment?.url   || '',
    proofThumbUrl: firstString(rq.proofThumbUrl) || attachment?.thumb || '',
    proofFullUrl:  firstString(rq.proofFullUrl)  || fullUrl           || '',
    mockupUrl:     mockup?.url   || '',
    mockupThumb:   mockup?.thumb || '',
    mockupFull:    mockupFull,
    mockupType:    mockupType,
    mockupOrigUrl: mk?.url || '',
    proofFileType: firstString(att?.type) || (/\.pdf$/i.test(att?.filename || '') ? 'application/pdf' : ''),
    proofFromVendorFiles: fromVendor,
  };
}

async function loadReorderRequests(index) {
  const ps    = state.productStates[index];
  const group = state.orderData.groups[index];

  if (Array.isArray(ps.reorderRequests)) { renderReorderPicker(index); return; }

  if (!/^https?:\/\//.test(CONFIG.MAKE_DESIGN_REQUESTS_WEBHOOK)) {
    console.warn('[reorder] webhook не настроен — выбор прошлых дизайнов пропущен');
    ps.reorderRequests = [];
    renderReorderPicker(index);
    updateSubmitEnabled(index);
    return;
  }

  ps.reorderLoading = true;
  renderReorderPicker(index);
  updateSubmitEnabled(index);

  try {
    const res = await fetch(CONFIG.MAKE_DESIGN_REQUESTS_WEBHOOK, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        orderId:        new URLSearchParams(window.location.search).get('orderId') || '',
        orderNumber:    state.orderData.orderNumber,
        customerId:     state.orderData.customerId,
        productName:    group.productName,
        productRecIds:  group.productRecIds,
        lineItemRecIds: group.lineItemRecIds,
      }),
    });

    if (!res.ok) throw new Error('HTTP ' + res.status);

    const text = await res.text();
    console.log('[reorder] raw response:', text);

    let data = {};
    try { data = JSON.parse(escapeControlChars(repairJson(text))); }
    catch { throw new Error('Invalid JSON from design requests webhook'); }

    const list = Array.isArray(data) ? data
               : Array.isArray(data.requests) ? data.requests
               : [];

    // приводим к единому виду и отбрасываем записи без пруфа и без id
    ps.reorderRequests = list
      .map(normaliseRequest)
      .filter(rq => rq && rq.id && (rq.proofUrl || rq.proofFileUrl || rq.proofThumbUrl));

  } catch (err) {
    console.error('[reorder] lookup failed:', err);
    ps.reorderRequests = [];
  } finally {
    ps.reorderLoading = false;
    renderReorderPicker(index);
    updateSubmitEnabled(index);
  }
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

        <div class="field-group" id="reorder-picker-${index}" hidden></div>

        <div class="skip-banner" id="skip-banner-${index}" hidden>
          <p>Blank product selected — no artwork or embellishment will be applied.</p>
        </div>

        <div id="client-fields-${index}">

        <div class="locations" id="locations-${index}">
          <div id="loc-list-${index}"></div>
          <button type="button" class="loc-add" id="loc-add-${index}">
            <span aria-hidden="true">+</span> Add Location
          </button>
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

// ─── ЛОКАЦИИ НАНЕСЕНИЯ ───────────────────────────────────────────────────────

// Текст клиента не экранируем: подчёркивания внутри слова (logo_front.ai)
// разметку не включают, а обратные слэши испортили бы вид в обычном поле
function mdText(str) {
  return String(str || '').trim();
}

// Сводка по локациям для одной длинной текстовой колонки в Airtable.
// Формат — markdown: при включённом rich text в поле заголовки станут
// жирными, а ссылки кликабельными; без rich text текст тоже читается.
function buildLocationsSummary(locations) {
  if (!Array.isArray(locations) || locations.length === 0) return '';

  const blocks = locations.map(l => {
    const lines = [];
    const where = l.placement ? ` — ${mdText(l.placement)}` : '';
    lines.push(`**Location ${l.location}**${where}`);
    if (l.fileNames && l.fileNames.length) lines.push(`Files: ${l.fileNames.map(mdText).join(', ')}`);
    if (l.dropboxUrl) lines.push(`Dropbox: ${l.dropboxUrl}`);
    return lines.join('\n');
  });

  const header = locations.length > 1
    ? `${locations.length} locations\n\n`
    : '';
  return header + blocks.join('\n\n');
}
const MAX_LOCATIONS = 6;

function locationHtml(index, loc) {
  const n = loc + 1;
  const extra = loc > 0;

  // Первая локация выглядит как обычная форма: без рамки, заголовка и подсказки.
  // Дополнительные — в своей рамке, с подсказкой о цене и кнопкой удаления.
  const head = extra ? `
      <p class="loc-price-note">Each additional location is <strong>$3 per unit</strong>. You'll receive an invoice soon.</p>
      <div class="loc-item__head">
        <span class="loc-title">Location ${n}</span>
        <button type="button" class="loc-remove" data-loc-remove="${loc}"
                aria-label="Remove location ${n}">Remove</button>
      </div>` : '';

  return `
    <div class="loc-item${extra ? '' : ' loc-item--first'}" id="loc-item-${index}-${loc}">
      ${head}
      <div class="field-group" id="field-files-${loc}-${index}">
        <div class="field-label-row">
          <span class="field-label">Artwork File(s)</span>
          <span class="badge badge--required">Mandatory</span>
        </div>
        <div class="dropzone" id="dropzone-${index}-${loc}" role="button" tabindex="0"
             aria-label="Upload artwork files${extra ? ' for location ' + n : ''}">
          <input type="file" id="file-input-${index}-${loc}" multiple
                 accept=".ai,.eps,.png,.pdf,.csv,.svg,.psd"
                 aria-hidden="true" tabindex="-1">
          <svg class="dropzone__icon" aria-hidden="true" width="22" height="22"
               viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
            <polyline points="17 8 12 3 7 8"/>
            <line x1="12" y1="3" x2="12" y2="15"/>
          </svg>
          <p class="dropzone__main">Drag &amp; drop files or browse</p>
          <p class="dropzone__types">AI &nbsp;·&nbsp; EPS &nbsp;·&nbsp; PNG &nbsp;·&nbsp; PDF &nbsp;·&nbsp; CSV &nbsp;·&nbsp; SVG &nbsp;·&nbsp; PSD &nbsp;·&nbsp; Max 150 MB each</p>
        </div>
        <ul class="file-list" id="file-list-${index}-${loc}" aria-live="polite"></ul>
        <p class="field-hint">Vector files (AI, EPS) are preferred for best print quality.</p>
        <p class="field-error" id="error-files-${loc}-${index}" role="alert" hidden></p>
      </div>

      <div class="field-group" id="field-placement-${loc}-${index}">
        <div class="field-label-row">
          <label class="field-label" for="input-placement-${index}-${loc}">Placement Directions</label>
          <span class="badge badge--required">Mandatory</span>
        </div>
        <textarea id="input-placement-${index}-${loc}" rows="3"
                  placeholder="Describe where you'd like the artwork placed on the product…"></textarea>
        <p class="field-hint">Examples: Centered, Maximum Size, Left Chest, Front Center 2" from top.</p>
        <p class="field-error" id="error-placement-${loc}-${index}" role="alert" hidden></p>
      </div>
    </div>`;
}

// Переносим введённый текст из полей в состояние — до любой перерисовки,
// иначе при добавлении или удалении локации текст пропадёт или съедет.
function syncLocations(index) {
  const ps = state.productStates[index];
  if (!ps) return;
  ps.locations.forEach((l, i) => {
    const p = document.getElementById(`input-placement-${index}-${i}`);
    if (p) l.placement = p.value;
  });
}

function renderLocations(index) {
  const ps   = state.productStates[index];
  const list = document.getElementById(`loc-list-${index}`);
  const card = getCard(index);
  if (!ps || !list || !card) return;

  list.innerHTML = ps.locations.map((_, i) => locationHtml(index, i)).join('');

  ps.locations.forEach((l, i) => {
    const p = document.getElementById(`input-placement-${index}-${i}`);
    if (p && l.placement) p.value = l.placement;
    initLocation(card, index, i);
    renderFileList(index, i);
  });

  const addBtn = document.getElementById(`loc-add-${index}`);
  if (addBtn) addBtn.hidden = ps.locations.length >= MAX_LOCATIONS;
}

function addLocation(index) {
  const ps = state.productStates[index];
  if (ps.locations.length >= MAX_LOCATIONS) return;
  syncLocations(index);
  ps.locations.push({ files: [], fileIdCounter: 0 });
  renderLocations(index);
  // переводим фокус на новую локацию, чтобы клиент сразу её увидел
  document.getElementById(`loc-item-${index}-${ps.locations.length - 1}`)
    ?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function removeLocation(index, loc) {
  const ps = state.productStates[index];
  if (loc < 1 || loc >= ps.locations.length) return;   // первую удалить нельзя
  syncLocations(index);
  ps.locations.splice(loc, 1);
  renderLocations(index);
}

function initLocation(card, index, loc) {
  const dropzone  = card.querySelector(`#dropzone-${index}-${loc}`);
  const fileInput = card.querySelector(`#file-input-${index}-${loc}`);
  const fileList  = card.querySelector(`#file-list-${index}-${loc}`);
  if (!dropzone || !fileInput || !fileList) return;

  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
  });
  fileInput.addEventListener('change', e => { addFiles(index, loc, e.target.files); fileInput.value = ''; });

  ['dragenter', 'dragover'].forEach(evt =>
    dropzone.addEventListener(evt, e => { e.preventDefault(); dropzone.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach(evt =>
    dropzone.addEventListener(evt, e => { e.preventDefault(); dropzone.classList.remove('dragover'); }));
  dropzone.addEventListener('drop', e => addFiles(index, loc, e.dataTransfer.files));

  fileList.addEventListener('click', e => {
    const btn = e.target.closest('.file-remove-btn');
    if (btn) removeFile(index, loc, Number(btn.dataset.id));
  });
}

// ─── INIT PRODUCT CARD ────────────────────────────────────────────────────────
function initProductCard(card, index) {
  const header = card.querySelector('.product-card__header');

  // Expand / collapse on click or keyboard
  header.addEventListener('click', () => toggleProduct(index));
  header.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleProduct(index); }
  });

  // Локации нанесения: рендер и кнопки +/-
  renderLocations(index);
  card.querySelector(`#loc-add-${index}`)?.addEventListener('click', () => addLocation(index));
  card.querySelector(`#loc-list-${index}`)?.addEventListener('click', e => {
    const btn = e.target.closest('[data-loc-remove]');
    if (btn) removeLocation(index, Number(btn.dataset.locRemove));
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

    setArtworkFieldsRequired(index, !isReorder);
    clearFieldError(index, 'embellishment');
    (state.productStates[index].locations || []).forEach((_, i) =>
      ['files', 'placement'].forEach(f => clearFieldError(index, `${f}-${i}`)));

    // При re-order артворк берётся из прошлого пруфа: файлы, цвет нанесения
    // и placement скрываем, вместо них — выбор прошлого Design Request.
    // Additional Notes тоже скрываем; остаётся только подтверждение прав.
    setReorderFieldsHidden(index, isReorder);

    if (isReorder) {
      loadReorderRequests(index);
    } else {
      state.productStates[index].reorderSelectedId = null;
      clearFieldError(index, 'reorder');
      renderReorderPicker(index);
    }

    updateSubmitEnabled(index);
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

// Переключает бейджи Mandatory/Optional у полей артворка
function setArtworkFieldsRequired(index, required) {
  const ids = ['embellishment'];
  (state.productStates[index]?.locations || []).forEach((_, i) => {
    ids.push(`files-${i}`, `placement-${i}`);
  });

  ids.forEach(field => {
    const group = document.getElementById(`field-${field}-${index}`);
    if (!group) return;
    const badge = group.querySelector('.badge');
    if (!badge) return;
    badge.textContent = required ? 'Mandatory' : 'Optional';
    badge.classList.toggle('badge--required', required);
    badge.classList.toggle('badge--optional', !required);
  });
}

// При re-order прячем поля загрузки артворка и показываем контейнер выбора
function setArtworkFieldsHidden(index, hidden) {
  const toggle = el => {
    if (!el) return;
    if (hidden) el.setAttribute('hidden', '');
    else        el.removeAttribute('hidden');
  };

  // поля продукта
  ['colors', 'embellishment', 'notes'].forEach(f =>
    toggle(document.getElementById(`field-${f}-${index}`)));

  // блок локаций целиком и, на всякий случай, каждое его поле отдельно —
  // чтобы правила display в style.css не могли перебить скрытие контейнера
  toggle(document.getElementById(`locations-${index}`));
  (state.productStates[index]?.locations || []).forEach((_, i) => {
    toggle(document.getElementById(`field-files-${i}-${index}`));
    toggle(document.getElementById(`field-placement-${i}-${index}`));
  });
}

function setReorderFieldsHidden(index, isReorder) {
  setArtworkFieldsHidden(index, isReorder);

  const picker = document.getElementById(`reorder-picker-${index}`);
  if (picker) {
    if (isReorder) picker.removeAttribute('hidden');
    else           picker.setAttribute('hidden', '');
  }
}

// Submit доступен только если подтверждены права на артворк
// (или продукт помечен как blank через Skip — тогда артворка нет вовсе)
function updateSubmitEnabled(index) {
  const ps  = state.productStates[index];
  const btn = document.getElementById(`submit-product-${index}`);
  if (!ps || !btn) return;
  if (ps.skipped) { btn.disabled = false; return; }

  // при re-order ещё нужен выбранный прошлый дизайн (если он вообще нашёлся)
  const needsPick = ps.isReorder
    && (ps.reorderLoading
        || (Array.isArray(ps.reorderRequests)
            && ps.reorderRequests.length > 0
            && !ps.reorderSelectedId));

  btn.disabled = !ps.rightsConfirmed || needsPick;
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
function addFiles(index, loc, fileList) {
  const slot = state.productStates[index].locations[loc];
  if (!slot) return;
  let hasError = false;

  Array.from(fileList).forEach(file => {
    const ext = file.name.split('.').pop().toLowerCase();
    if (!CONFIG.ALLOWED_EXTENSIONS.includes(ext)) {
      showFieldError(index, `files-${loc}`, `"${file.name}" — only AI, EPS, PNG, PDF, CSV, SVG, PSD allowed.`);
      hasError = true;
      return;
    }
    if (file.size > CONFIG.MAX_FILE_SIZE_MB * 1048576) {
      showFieldError(index, `files-${loc}`, `"${file.name}" exceeds the 150 MB limit.`);
      hasError = true;
      return;
    }
    slot.files.push({ file, id: ++slot.fileIdCounter });
  });

  renderFileList(index, loc);
  if (!hasError) clearFieldError(index, `files-${loc}`);
}

function removeFile(index, loc, id) {
  const slot = state.productStates[index].locations[loc];
  if (!slot) return;
  slot.files = slot.files.filter(f => f.id !== id);
  renderFileList(index, loc);
}

function renderFileList(index, loc) {
  const ul = document.getElementById(`file-list-${index}-${loc}`);
  if (!ul) return;
  ul.innerHTML = '';
  (state.productStates[index].locations[loc]?.files || []).forEach(({ file, id }) => {
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

  ['colors', 'embellishment', 'rights', 'reorder'].forEach(f => clearFieldError(index, f));
  ps.locations.forEach((_, i) =>
    ['files', 'placement'].forEach(f => clearFieldError(index, `${f}-${i}`)));

  // Считываем поля всех локаций в состояние
  ps.locations.forEach((l, i) => {
    l.placement = (document.getElementById(`input-placement-${index}-${i}`)?.value || '').trim();
  });

  // Если по продукту не нашлось ни одного пруфа, re-order невозможен —
  // требуем артворк как при обычной заявке
  const noProofs = Array.isArray(ps.reorderRequests) && ps.reorderRequests.length === 0;
  const reorderActive = ps.isReorder && !noProofs;

  if (!reorderActive) {
    ps.locations.forEach((l, i) => {
      if (l.files.length === 0) {
        showFieldError(index, `files-${i}`, 'Please upload at least one artwork file.');
        valid = false;
      }
      if (!l.placement) {
        showFieldError(index, `placement-${i}`, 'Placement directions are required.');
        valid = false;
      } else if (l.placement.length < 5) {
        showFieldError(index, `placement-${i}`, 'Please provide more detail (at least 5 characters).');
        valid = false;
      }
    });

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

  if (ps.isReorder
      && Array.isArray(ps.reorderRequests)
      && ps.reorderRequests.length > 0
      && !ps.reorderSelectedId) {
    showFieldError(index, 'reorder', 'Please select which previous design to reuse.');
    valid = false;
  }

  const notes = (document.getElementById(`input-notes-${index}`)?.value || '').trim();

  // Совместимость со старым пейлоадом: первая локация едет и в плоских полях
  ps.placement       = ps.locations[0]?.placement || '';
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
  card.querySelector(`#reorder-picker-${index}`).setAttribute('hidden', '');
  card.querySelector(`#locations-${index}`)?.setAttribute('hidden', '');
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
        locationCount: 0,
        locationsSummary: '',
      };
    } else {
      const card  = getCard(index);
      const badge = card?.querySelector('.status-badge');
      const baseLabel = group.folderLabel || group.productName;
      const multi = ps.locations.length > 1;

      // Файлы каждой локации кладём в свою подпапку, чтобы на производстве
      // было видно, что к какому месту нанесения относится
      const totalFiles = ps.locations.reduce((a, l) => a + l.files.length, 0);
      let done = 0;
      const locationsPayload = [];

      for (let li = 0; li < ps.locations.length; li++) {
        const l = ps.locations[li];
        const folder = multi ? `${baseLabel}/Location ${li + 1}` : baseLabel;
        let locUrl = '';

        for (const item of l.files) {
          done++;
          if (badge) badge.textContent = `Uploading ${done} of ${totalFiles}…`;
          locUrl = await uploadFileToDropbox(item.file, orderId, folder);
        }

        locationsPayload.push({
          location:  li + 1,
          placement: l.placement || '',
          dropboxUrl: locUrl,
          fileNames: l.files.map(f => f.file.name),
        });
      }

      const dropboxUrl = locationsPayload[0]?.dropboxUrl || '';

      const selectedRequest = (ps.reorderRequests || [])
        .find(rq => rq.id === ps.reorderSelectedId);

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
        locationCount:    ps.locations.length,
        locations:        locationsPayload,
        locationsSummary: buildLocationsSummary(locationsPayload),
        reorderRequestId:   ps.reorderSelectedId || '',
        reorderRequestName: selectedRequest?.requestName || '',
        reorderProofUrl:    selectedRequest?.proofUrl || selectedRequest?.proofFileUrl || '',
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
  console.log('[OPENHOUSE] script.js version:', OH_VERSION);
  if (TEST_MODE) console.warn('[OPENHOUSE] TEST MODE — Dropbox folder:', CONFIG.DROPBOX_UPLOAD_FOLDER);
  injectReorderStyles();
  loadOrder();
  document.getElementById('retry-load-btn')?.addEventListener('click', loadOrder);
});
