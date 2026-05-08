// ─── CONFIG ─────────────────────────────────────────────────────────────────
const CONFIG = {
  MAKE_GET_WEBHOOK:    'https://hook.us2.make.com/bj7rkp54m58ktvgg5xewf7d9q7wpkwiw',
  MAKE_SUBMIT_WEBHOOK: 'https://hook.us2.make.com/yhpis63d8gjb941ouh2t6jkw9f4iw28v',
  ALLOWED_EXTENSIONS:  ['ai', 'eps', 'png', 'pdf'],
  MAX_FILE_SIZE_MB:    100,
};

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

    // photo + thumbnail: new format nests inside Product Image array
    const firstImg = Array.isArray(p['Product Image']) ? p['Product Image'][0] : null;
    const photoUrl = firstImg
      ? (firstImg.url || '')
      : (p.photo_url || '');
    const thumbnail = firstImg
      ? (firstImg.thumbnails?.large?.url || firstImg.thumbnails?.small?.url || firstImg.url || '')
      : (p.thumbnail || '');

    // embellishment: new key is "Embelishment Types" (typo in source), old is embellishment_types
    const rawEmb = p['Embelishment Types'] ?? p.embellishment_types;
    const embellishmentTypes = Array.isArray(rawEmb)
      ? rawEmb.filter(t => t && t.trim() !== '')
      : [];

    // variant: new keys use spaces, old used Varible_*
    const colorParts = [
      p['Base Color'] || p.Varible_Color,
      p['Variant Name']  || p.Varible_Name,
    ].filter(Boolean);

    return {
      index:             parseInt(p.__IMTINDEX__ || p.index, 10) || 1,
      total:             parseInt(p.__IMTLENGTH__ || p.total,  10) || 1,
      productName,
      qty:               String(p.Quantity || p.quantity || ''),
      variant:           colorParts.join(' / '),
      size:              p['Size Breakdown'] || p.Size || '',
      photoUrl,
      thumbnail,
      recordId:          p.recordID || p.recordId || '',
      embellishmentTypes,
      leadTime:          String(Array.isArray(p['Lead Time']) ? (p['Lead Time'][0] ?? '') : (p['Lead Time'] || p.lead_time || '')),
      dielineUrl:        Array.isArray(p['Dieline']) ? (p['Dieline'][0]?.url || '') : '',
      dielineFilename:   Array.isArray(p['Dieline']) ? (p['Dieline'][0]?.filename || 'dieline') : 'dieline',
      artworkSubmission: p['Artwork Submission'] || p.artwork_submission || '',
    };
  });

  const groups = [];
  const groupMap = {};
  products.forEach(p => {
    if (!groupMap[p.productName]) {
      const g = { productName: p.productName, products: [] };
      groupMap[p.productName] = g;
      groups.push(g);
    }
    groupMap[p.productName].products.push(p);
  });

  groups.forEach(g => {
    const vals = f => g.products.map(p => p[f]).filter(Boolean);
    g.qty              = vals('qty').join(' / ');
    g.variant          = [...new Set(vals('variant'))].join(' / ');
    g.size             = vals('size').join(' / ');
    g.thumbnail        = vals('thumbnail')[0] || '';
    g.photoUrl         = vals('photoUrl')[0] || '';
    g.leadTime         = vals('leadTime')[0] || '';
    g.dielineUrl       = vals('dielineUrl')[0] || '';
    g.dielineFilename  = vals('dielineFilename')[0] || 'dieline';
    g.embellishmentTypes = [...new Map(
      g.products.flatMap(p => p.embellishmentTypes).map(t => [t, t])
    ).values()];
    g.allSubmitted = g.products.every(p => p.artworkSubmission);
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

// ─── STATE MACHINE ────────────────────────────────────────────────────────────
function setPageState(name) {
  document.querySelector('main').dataset.state = name;
}

// ─── ORDER LOADING ────────────────────────────────────────────────────────────
async function loadOrder() {
  setPageState('loading');

  const orderId = new URLSearchParams(window.location.search).get('orderId');

  if (!orderId) {
    showNotFound('This link is invalid — no order ID was found in the URL.');
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(
      CONFIG.MAKE_GET_WEBHOOK + '?orderId=' + encodeURIComponent(orderId),
      { signal: controller.signal }
    );
    clearTimeout(timeout);

    if (!res.ok) throw new Error('HTTP ' + res.status);

    const text = await res.text();

    let raw;
    try { raw = JSON.parse(repairJson(text)); }
    catch (parseErr) {
      throw new Error('Invalid JSON from webhook: ' + text.slice(0, 200));
    }

    if (raw.error === 'not_found') {
      showNotFound('We couldn\'t find an order matching this link. Please contact your Openhouse manager.');
      return;
    }

    const data = normaliseOrder(raw);

    const hasAnyContent = data.orderNumber || data.client || data.groups.some(g => g.productName);
    if (!hasAnyContent) {
      showNotFound('We couldn\'t find an order matching this link. Please contact your Openhouse manager.');
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
    clearTimeout(timeout);
    console.error('[loadOrder] Error:', err);
    showNotFound(
      err.name === 'AbortError'
        ? 'Unable to load order details — the request timed out. Please refresh.'
        : 'Unable to load order details: ' + err.message
    );
  }
}

function showNotFound(msg) {
  document.getElementById('not-found-message').textContent = msg;
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

  const embBtns = group.embellishmentTypes.map(type =>
    `<button type="button" class="toggle-btn" data-value="${esc(type)}">${esc(type)}</button>`
  ).join('');

  const counterHtml = group.products.length > 1
    ? `<span class="product-card__counter">${group.products.length} items</span>`
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
        <span class="product-card__name">${esc(group.productName) || 'Unnamed Product'}</span>
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
              <span class="spec-row__key">Variant (Color, Type)</span>
              <span class="spec-row__val">${esc(group.variant)}</span>
            </div>` : ''}
            ${group.size ? `<div class="spec-row">
              <span class="spec-row__key">Size Breakdown</span>
              <span class="spec-row__val">${esc(group.size)}</span>
            </div>` : ''}
            <div class="spec-row">
              <span class="spec-row__key">Lead Time (From Proof Approval)</span>
              <span class="spec-row__val">${group.leadTime ? group.leadTime + (group.leadTime === '1' ? ' week' : ' weeks') : '—'}</span>
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
                   accept=".ai,.eps,.png,.pdf"
                   aria-hidden="true" tabindex="-1">
            <svg class="dropzone__icon" aria-hidden="true" width="22" height="22"
                 viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
              <polyline points="17 8 12 3 7 8"/>
              <line x1="12" y1="3" x2="12" y2="15"/>
            </svg>
            <p class="dropzone__main">Drag &amp; drop files or browse</p>
            <p class="dropzone__types">AI &nbsp;·&nbsp; EPS &nbsp;·&nbsp; PNG &nbsp;·&nbsp; PDF &nbsp;·&nbsp; Max 100 MB each</p>
          </div>
          <ul class="file-list" id="file-list-${index}" aria-live="polite"></ul>
          <p class="field-hint">Vector files (AI, EPS) are preferred for best print quality.</p>
          <p class="field-error" id="error-files-${index}" role="alert" hidden></p>
        </div>

        <div class="field-group" id="field-embellishment-${index}">
          <div class="field-label-row">
            <span class="field-label">Embellishment Type</span>
            <span class="badge badge--required">Mandatory</span>
          </div>
          <div class="toggle-group" role="group" aria-label="Select embellishment type">
            ${embBtns}
          </div>
          <p class="field-error" id="error-embellishment-${index}" role="alert" hidden></p>
        </div>

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
          <button type="button" class="submit-product-btn" id="submit-product-${index}">
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
  if (state.productStates[index]?.status === 'submitted') return;
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
    if (status === 'submitted') badge.textContent = '✓ Submitted';
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
      showFieldError(index, 'files', `"${file.name}" — only AI, EPS, PNG, PDF allowed.`);
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

  ['files', 'colors', 'placement', 'embellishment'].forEach(f => clearFieldError(index, f));

  if (ps.files.length === 0) {
    showFieldError(index, 'files', 'Please upload at least one artwork file.');
    valid = false;
  }

  const placement = (document.getElementById(`input-placement-${index}`)?.value || '').trim();
  if (!placement) {
    showFieldError(index, 'placement', 'Placement directions are required.');
    valid = false;
  } else if (placement.length < 5) {
    showFieldError(index, 'placement', 'Please provide more detail (at least 5 characters).');
    valid = false;
  }

  if (!ps.embellishment) {
    showFieldError(index, 'embellishment', 'Please select an embellishment type.');
    valid = false;
  }

  const notes = (document.getElementById(`input-notes-${index}`)?.value || '').trim();

  // Store values on state so submitProduct reads the same values
  ps.placement       = placement;
  ps.additionalNotes = notes;

  return valid;
}

// ─── FILE TO BASE64 ──────────────────────────────────────────────────────────
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
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
}

// ─── SUBMIT PRODUCT ───────────────────────────────────────────────────────────
async function submitProduct(index) {
  const ps = state.productStates[index];
  if (!ps.skipped && !validateProduct(index)) return;

  const group = state.orderData.groups[index];
  const btn   = document.getElementById(`submit-product-${index}`);
  const errEl = document.getElementById(`error-global-${index}`);

  btn.disabled    = true;
  btn.textContent = 'Submitting…';
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
    }));

    let payload;

    if (ps.skipped) {
      payload = {
        orderId,
        products: productList,
        skipped: true,
      };
    } else {
      const files = await Promise.all(
        ps.files.map(async item => {
          const data = await fileToBase64(item.file);
          if (!data) throw new Error(`File "${item.file.name}" produced empty data — please try again.`);
          return {
            name: item.file.name,
            mime: item.file.type || 'application/octet-stream',
            data,
          };
        })
      );

      const colors          = document.getElementById(`input-colors-${index}`)?.value.trim() || '';
      const placement       = ps.placement || '';
      const embellishment   = ps.embellishment;
      const additionalNotes = ps.additionalNotes || '';

      payload = {
        orderId,
        products: productList,
        colors, placement, embellishment, additionalNotes, files,
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
    btn.disabled    = false;
    btn.textContent = 'Submit Product';
    if (errEl) { errEl.textContent = 'Something went wrong. Please try again.'; errEl.removeAttribute('hidden'); }
  }
}

// ─── INIT ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', loadOrder);
