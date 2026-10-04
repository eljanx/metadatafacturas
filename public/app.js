const $ = (s, r = document) => r.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const eur = (n) => (n == null ? '' : Number(n).toLocaleString('es-ES', { style: 'currency', currency: 'EUR' }));
const dateEs = (d) => (d ? d.split('-').reverse().join('/') : '');
const api = async (url, opts = {}) => {
  const r = await fetch(url, { ...opts, headers: opts.body && !(opts.body instanceof FormData) ? { 'Content-Type': 'application/json', ...opts.headers } : opts.headers, body: opts.body && !(opts.body instanceof FormData) ? JSON.stringify(opts.body) : opts.body });
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : null;
  if (!r.ok) throw new Error(data?.error || `Error ${r.status}`);
  return data;
};
function toast(msg, err = false) {
  const t = document.createElement('div'); t.className = `toast${err ? ' err' : ''}`; t.textContent = msg;
  $('#toasts').append(t); setTimeout(() => t.remove(), err ? 7000 : 3500);
}
const guard = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { toast(e.message, true); } };

const state = { rows: [], total: 0, stats: null, categories: [], app: null, settings: null, secrets: null, supplierId: '', open: null };
const REVIEW = { OK_IA: ['OK IA', 'b-ok'], CONVIENE_REVISAR: ['CONVIENE REVISAR', 'b-rev'], VALIDADA_MANUALMENTE: ['VALIDADA MANUALMENTE', 'b-man'] };
const TECH = { PENDIENTE: 'b-wait', PROCESANDO: 'b-wait', PROCESADO: 'b-ok', ERROR: 'b-err', POSIBLE_DUPLICADO: 'b-rev' };
const SOURCE = { upload: 'Subida', folder: 'Carpeta', drive: 'Drive' };

// ------------------------------------------------------------ pestañas
document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
function showTab(t) {
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === t));
  for (const s of ['facturas', 'proveedores', 'config']) $(`#tab-${s}`).hidden = s !== t;
  if (t === 'proveedores') loadSuppliers(); if (t === 'config') loadConfig();
  history.replaceState(null, '', `#${t === 'facturas' ? '' : t}`);
}

// ------------------------------------------------------------ estado general / banners
async function loadState() {
  state.app = await api('/api/state');
  const a = state.app; const chips = [];
  chips.push(`<span class="chip ${a.anthropic.configured ? 'good' : 'bad'}">IA: ${a.anthropic.configured ? esc(a.anthropic.model) : 'sin API key'}</span>`);
  chips.push(`<span class="chip ${a.drive.connected ? 'good' : ''}">Drive: ${a.drive.connected ? esc(a.drive.user || 'conectado') : 'no conectado'}</span>`);
  if (a.inbox_dir) chips.push(`<span class="chip good" title="${esc(a.inbox_dir)}">Carpeta local vigilada</span>`);
  $('#chips').innerHTML = chips.join('');
  const b = [];
  if (!a.anthropic.configured) b.push(`<p class="banner err">Falta la API Key de Anthropic: las facturas quedan en PENDIENTE hasta que la configures. <a href="#config" data-go="config">Ir a Configuración</a></p>`);
  if (!a.pharmacy_configured) b.push(`<p class="banner">Faltan los datos de la farmacia (NIF/CIF): sin ellos no se puede validar el destinatario y todas las facturas quedarán en CONVIENE REVISAR. <a href="#config" data-go="config">Completar datos</a></p>`);
  if (a.scan?.error) b.push(`<p class="banner err">Sincronización de carpetas: ${esc(a.scan.error)}</p>`);
  if (a.drive.error) b.push(`<p class="banner err">${esc(a.drive.error)}</p>`);
  $('#banners').innerHTML = b.join('');
  $('#xlsxDrive').hidden = !a.drive.connected;
  document.querySelectorAll('[data-go]').forEach((x) => x.addEventListener('click', (e) => { e.preventDefault(); showTab(x.dataset.go); }));
}

// ------------------------------------------------------------ tabla de facturas
const form = $('#filters');
const query = () => { const p = new URLSearchParams(new FormData(form)); if (state.supplierId) p.set('supplier_id', state.supplierId); for (const [k, v] of [...p]) if (!v) p.delete(k); return p; };

async function loadInvoices({ append = false } = {}) {
  const p = query(); p.set('limit', 50); p.set('offset', append ? state.rows.length : 0);
  const data = await api(`/api/invoices?${p}`);
  state.rows = append ? [...state.rows, ...data.rows] : data.rows; state.total = data.total; state.stats = data.stats;
  renderKpis(); renderTable();
  clearTimeout(loadInvoices.t);
  if (data.stats.in_progress > 0) loadInvoices.t = setTimeout(() => { loadInvoices().catch(() => {}); loadState().catch(() => {}); }, 3000);
}
function renderKpis() {
  const s = state.stats; const pct = s.done ? Math.round(((s.ok_ia + s.manual) / s.done) * 100) : 0;
  const setReview = (v) => { form.review.value = v; loadInvoices(); };
  $('#kpis').innerHTML = `
    <div class="kpi"><div class="v">${s.total}</div><div class="l">Facturas</div></div>
    <div class="kpi"><div class="v">${pct}%</div><div class="l">resueltas sin intervención (${s.ok_ia} OK IA)</div></div>
    <button class="kpi ${s.review ? 'attn' : ''}" data-r="CONVIENE_REVISAR"><div class="v">${s.review}</div><div class="l">CONVIENE REVISAR · ver</div></button>
    <div class="kpi"><div class="v">${s.in_progress}</div><div class="l">en proceso${s.errors ? ` · ${s.errors} con error` : ''}</div></div>
    <div class="kpi"><div class="v">${eur(s.amount_total)}</div><div class="l">importe procesado</div></div>`;
  $('#kpis [data-r]')?.addEventListener('click', () => setReview('CONVIENE_REVISAR'));
}
function reviewCell(r) {
  if (!r.review_status) return `<span class="badge b-wait">${r.tech_status === 'PROCESANDO' ? 'Procesando…' : 'En cola'}</span>`;
  const [label, cls] = REVIEW[r.review_status];
  const needs = r.review_status === 'CONVIENE_REVISAR';
  const reason = needs ? (r.review_reasons[0] || r.review_reason || '') : '';
  const more = r.review_reasons.length > 1 ? ` (+${r.review_reasons.length - 1} más)` : '';
  const url = r.document_url;
  return `<div class="revcell">
    ${needs ? `<a class="lupa" href="${esc(url)}" target="_blank" rel="noopener" title="Abrir la factura original" data-stop>🔍</a>` : url ? `<a class="doc" href="${esc(url)}" target="_blank" rel="noopener" title="Abrir documento" data-stop>📄</a>` : ''}
    <div><span class="badge ${cls}">${label}</span>${needs ? `<span class="reason" title="${esc(r.review_reasons.join('\n') || r.review_reason)}">${esc(reason)}${more}</span>` : ''}</div></div>`;
}
function renderTable() {
  $('#table tbody').innerHTML = state.rows.map((r) => `
    <tr data-id="${r.id}" class="${r.review_status === 'CONVIENE_REVISAR' ? 'needs' : ''}">
      <td>${reviewCell(r)}</td><td>${dateEs(r.invoice_date)}</td><td>${esc(r.invoice_number)}${r.doc_type && r.doc_type !== 'factura' ? `<small class="s">${esc(r.doc_type)}</small>` : ''}</td>
      <td>${esc(r.supplier_name || '—')}<small class="s">${esc(r.supplier_tax_id)}</small></td>
      <td class="num">${eur(r.base_total)}</td><td class="num">${eur(r.vat_total)}</td><td class="num">${r.re_total ? eur(r.re_total) : ''}</td><td class="num"><strong>${eur(r.total)}</strong></td>
      <td>${esc(r.category || '')}</td>
      <td><span class="badge ${TECH[r.tech_status]}">${r.tech_status.replace('_', ' ')}</span></td>
      <td>${SOURCE[r.source] || ''}<small class="s" title="${esc(r.original_filename)}">${esc(r.original_filename.slice(0, 26))}</small></td></tr>`).join('');
  $('#empty').hidden = state.rows.length > 0; $('#more').hidden = state.rows.length >= state.total;
  document.querySelectorAll('#table [data-stop]').forEach((a) => a.addEventListener('click', (e) => e.stopPropagation()));
  document.querySelectorAll('#table tbody tr').forEach((tr) => tr.addEventListener('click', () => openDrawer(Number(tr.dataset.id))));
}
form.addEventListener('input', () => { clearTimeout(form.t); form.t = setTimeout(() => guard(loadInvoices)(), 250); });
form.addEventListener('submit', (e) => e.preventDefault());
$('#clear').addEventListener('click', () => { form.reset(); state.supplierId = ''; $('#supplierFilter').innerHTML = ''; guard(loadInvoices)(); });
$('#more').addEventListener('click', guard(() => loadInvoices({ append: true })));
$('#scan').addEventListener('click', guard(async () => { const r = await api('/api/scan', { method: 'POST' }); toast(`Sincronizado: ${r.local + r.drive} factura(s) nueva(s)`); await loadInvoices(); await loadState(); }));
$('#xlsx').addEventListener('click', () => { const p = query(); p.delete('review'); p.delete('tech'); location.href = `/api/export.xlsx?${p}`; });
$('#xlsxDrive').addEventListener('click', guard(async () => { const p = Object.fromEntries(query()); delete p.review; delete p.tech; const r = await api('/api/export/drive', { method: 'POST', body: p }); toast('Excel subido a la carpeta de la gestoría'); if (r.url) window.open(r.url, '_blank', 'noopener'); }));

// ------------------------------------------------------------ subida
const drop = $('#drop');
async function upload(files) {
  if (!files.length) return;
  const fd = new FormData(); [...files].forEach((f) => fd.append('files', f));
  const r = await api('/api/invoices/upload', { method: 'POST', body: fd });
  const ok = r.results.filter((x) => x.ok).length;
  if (ok) toast(`${ok} factura(s) recibida(s). ${r.queued ? 'Se procesan automáticamente.' : 'Quedan pendientes hasta configurar la API Key.'}`);
  r.results.filter((x) => !x.ok).forEach((x) => toast(x.error, true));
  await loadInvoices();
}
$('#file').addEventListener('change', (e) => guard(upload)(e.target.files).finally(() => { e.target.value = ''; }));
['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => guard(upload)(e.dataTransfer.files));

// ------------------------------------------------------------ detalle / edición
const FIELDS = [
  ['doc_type', 'Tipo', 'select'], ['invoice_number', 'Nº factura'], ['series', 'Serie'], ['invoice_date', 'Fecha factura', 'date'], ['operation_date', 'Fecha operación', 'date'], ['due_date', 'Vencimiento', 'date'],
  ['rectified_invoice', 'Factura rectificada'], ['supplier_name', 'Proveedor'], ['supplier_tax_id', 'CIF proveedor'], ['customer_name', 'Destinatario'], ['customer_tax_id', 'CIF destinatario'], ['currency', 'Moneda'],
  ['base_total', 'Base imponible', 'num'], ['discounts_total', 'Descuentos', 'num'], ['vat_total', 'IVA', 'num'], ['re_total', 'Recargo equivalencia', 'num'], ['other_taxes_total', 'Otros impuestos', 'num'],
  ['withholdings_total', 'Retenciones', 'num'], ['total', 'Total factura', 'num'], ['payment_method', 'Forma de pago'], ['iban', 'IBAN'], ['concept', 'Concepto'],
];
const DOC_TYPES = [['factura', 'Factura'], ['rectificativa', 'Rectificativa'], ['abono', 'Abono'], ['simplificada', 'Simplificada'], ['otro', 'Otro']];

async function openDrawer(id) {
  const inv = await api(`/api/invoices/${id}`); state.open = inv;
  const crit = state.settings?.settings?.critical_min ?? 0.9;
  const cf = (k) => { const c = inv.field_meta[k]?.confidence; return c == null || inv.review_status === 'VALIDADA_MANUALMENTE' && c === 1 ? '' : `<span class="cf ${c < crit ? 'low' : ''}" title="${esc(inv.field_meta[k]?.evidence || '')}">${Math.round(c * 100)}%</span>`; };
  const input = ([k, label, type]) => `<label><span class="lb">${label}${inv[k] == null ? '' : cf(k)}</span>${
    type === 'select' ? `<select name="${k}">${DOC_TYPES.map(([v, l]) => `<option value="${v}" ${inv[k] === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`
      : `<input name="${k}" type="${type === 'date' ? 'date' : 'text'}" ${type === 'num' ? 'inputmode="decimal"' : ''} value="${esc(inv[k] ?? '')}">`}</label>`;
  const [label, cls] = inv.review_status ? REVIEW[inv.review_status] : [inv.tech_status, 'b-wait'];
  const busy = ['PENDIENTE', 'PROCESANDO'].includes(inv.tech_status);
  const d = $('#drawer'); d.hidden = false;
  d.innerHTML = `
    <header><h2 style="flex:1">Factura #${inv.id} <span class="badge ${cls}">${label}</span> <span class="badge ${TECH[inv.tech_status]}">${inv.tech_status.replace('_', ' ')}</span></h2><button class="ghost" id="close">✕</button></header>
    <div class="actions">
      <a class="lupa" style="width:auto;padding:0 14px;gap:6px;font-size:14px;font-weight:600" href="${esc(inv.document_url)}" target="_blank" rel="noopener">🔍 Abrir factura</a>
      <button class="ghost" id="reproc" ${busy ? 'disabled' : ''}>↻ Reprocesar con IA</button>
      <button class="ghost" id="reviewed" ${busy || inv.tech_status === 'ERROR' || inv.review_status === 'VALIDADA_MANUALMENTE' ? 'disabled' : ''}>✔ Marcar como revisada</button>
      <button class="primary" id="save" ${busy ? 'disabled' : ''}>Guardar cambios</button>
      <button class="danger" id="del">Eliminar</button>
    </div>
    ${inv.review_status === 'CONVIENE_REVISAR' ? `<div class="reasons"><strong>Qué conviene revisar:</strong><ul>${inv.review_reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul></div>` : ''}
    ${inv.review_status === 'VALIDADA_MANUALMENTE' && inv.review_reasons.length ? `<p class="muted">Motivo original de revisión: ${esc(inv.review_reasons.join(' · '))}</p>` : ''}
    ${inv.sync_error ? `<div class="reasons err">${esc(inv.sync_error)}</div>` : ''}
    <form id="edit"><div class="grid">${FIELDS.map(input).join('')}
      <label>Categoría<select name="category_id">${state.categories.map((c) => `<option value="${c.id}" ${c.id === inv.category_id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label></div>
    <h3>Desglose fiscal</h3>
    <table class="mini" id="taxes"><thead><tr><th>% IVA</th><th>Base</th><th>Cuota IVA</th><th>% Recargo</th><th>Cuota recargo</th><th></th></tr></thead><tbody></tbody></table>
    <button type="button" class="ghost" id="addTax" style="margin-top:6px">+ Añadir tipo</button></form>
    <h3>Archivo</h3><p>${esc(inv.processed_filename || inv.original_filename)}<br><span class="muted">Origen: ${SOURCE[inv.source]} · original: ${esc(inv.original_filename)} · ${esc(inv.location || '')}<br>hash ${esc(inv.hash.slice(0, 16))}…</span></p>
    ${inv.lines.length ? `<h3>Líneas (${inv.lines.length})</h3><div class="tablewrap" style="max-height:240px"><table class="mini"><thead><tr><th>Descripción</th><th>Ref.</th><th>Cant.</th><th>Precio</th><th>Dto</th><th>Base</th><th>IVA</th><th>Total</th></tr></thead><tbody>${inv.lines.map((l) => `<tr><td>${esc(l.description)}</td><td>${esc(l.reference)}</td><td>${l.quantity ?? ''}</td><td>${l.unit_price ?? ''}</td><td>${l.discount ?? ''}</td><td>${l.base ?? ''}</td><td>${l.vat_rate ?? ''}</td><td>${l.total ?? ''}</td></tr>`).join('')}</tbody></table></div>` : ''}
    <h3>Trazabilidad</h3>
    ${inv.processing.length ? `<p class="muted">Último procesado: modelo ${esc(inv.processing[0].model || '—')}${inv.processing[0].input_tokens ? ` · ${inv.processing[0].input_tokens}→${inv.processing[0].output_tokens} tokens` : ''}${inv.confidence_overall != null ? ` · confianza media críticos ${Math.round(inv.confidence_overall * 100)}%` : ''}${inv.processing[0].error ? ` · error: ${esc(inv.processing[0].error)}` : ''}</p>` : ''}
    ${inv.edits.length ? `<table class="mini"><tbody>${inv.edits.map((e) => `<tr><td>${esc(e.created_at)}</td><td>${esc(e.field)}</td><td>${esc(e.old_value ?? '')} → ${esc(e.new_value ?? '')}</td><td>${esc(e.note ?? '')}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">Sin correcciones manuales.</p>'}`;
  const tb = $('#taxes tbody');
  const addTax = (t = {}) => { const tr = document.createElement('tr'); tr.innerHTML = ['vat_rate', 'base', 'vat_amount', 're_rate', 're_amount'].map((k) => `<td><input data-k="${k}" value="${esc(t[k] ?? '')}"></td>`).join('') + '<td><button type="button" class="ghost" title="Quitar">✕</button></td>'; tr.querySelector('button').onclick = () => tr.remove(); tb.append(tr); };
  (inv.taxes.length ? inv.taxes : []).forEach(addTax);
  $('#addTax').onclick = () => addTax();
  $('#close').onclick = closeDrawer;
  $('#reproc').onclick = guard(async () => { await api(`/api/invoices/${id}/reprocess`, { method: 'POST' }); toast('Reprocesando con IA…'); closeDrawer(); await loadInvoices(); });
  $('#reviewed').onclick = guard(async () => { await api(`/api/invoices/${id}/mark-reviewed`, { method: 'POST' }); toast('Marcada como revisada'); closeDrawer(); await loadInvoices(); });
  $('#del').onclick = guard(async () => { if (!confirm('¿Eliminar esta factura de la base de datos? (el fichero archivado no se borra)')) return; await api(`/api/invoices/${id}`, { method: 'DELETE' }); closeDrawer(); await loadInvoices(); });
  $('#save').onclick = guard(async () => {
    const patch = {}; const fd = new FormData($('#edit'));
    for (const [k, v] of fd) { if (k === 'category_id') { if (Number(v) !== inv.category_id) patch[k] = Number(v); } else if (String(inv[k] ?? '') !== v) patch[k] = v; }
    const taxes = [...tb.querySelectorAll('tr')].map((tr) => Object.fromEntries([...tr.querySelectorAll('input')].map((i) => [i.dataset.k, i.value.trim() === '' ? null : i.value.trim()])));
    const before = inv.taxes.map((t) => ({ vat_rate: t.vat_rate, base: t.base, vat_amount: t.vat_amount, re_rate: t.re_rate, re_amount: t.re_amount }));
    const norm = (a) => JSON.stringify(a.map((t) => Object.fromEntries(Object.entries(t).map(([k, v]) => [k, v == null ? null : Number(String(v).replace(',', '.'))]))));
    if (norm(taxes) !== norm(before)) patch.taxes = taxes;
    const out = await api(`/api/invoices/${id}`, { method: 'PATCH', body: patch });
    toast(out.review_status === 'VALIDADA_MANUALMENTE' ? 'Guardado: validaciones correctas → VALIDADA MANUALMENTE' : 'Guardado, pero aún hay dudas: revisa los motivos', out.review_status !== 'VALIDADA_MANUALMENTE');
    await loadInvoices(); await openDrawer(id);
  });
}
function closeDrawer() { $('#drawer').hidden = true; state.open = null; }
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeDrawer(); closeModal(); } });

// ------------------------------------------------------------ proveedores
async function loadSuppliers() {
  const rows = await api('/api/suppliers');
  $('#suppliers tbody').innerHTML = rows.map((s) => `<tr data-id="${s.id}"><td>${esc(s.name)}</td><td>${esc(s.tax_id)}</td><td>${esc(s.city)}</td><td class="num">${s.invoices}</td><td class="num">${eur(s.total)}</td><td class="num">${s.to_review || ''}</td></tr>`).join('') || '<tr><td colspan="6" class="muted center">Aún no hay proveedores.</td></tr>';
  document.querySelectorAll('#suppliers tbody tr[data-id]').forEach((tr) => tr.addEventListener('click', () => {
    state.supplierId = tr.dataset.id; $('#supplierFilter').innerHTML = `<span class="chip">Proveedor: ${esc(tr.children[0].textContent)}</span>`; showTab('facturas'); guard(loadInvoices)();
  }));
}

// ------------------------------------------------------------ configuración
const closeModal = () => { $('#modal').hidden = true; };
async function loadConfig() {
  const [cfg, state2] = await Promise.all([api('/api/settings'), loadState()]);
  state.settings = cfg; const s = cfg.settings; const sec = cfg.secrets; const drv = state.app.drive;
  const inp = (k, label, extra = '') => `<label>${label}<input name="${k}" value="${esc(s[k] ?? '')}" ${extra}></label>`;
  const secBadge = (x) => x.configured ? `<span class="chip good">configurada${x.source === 'env' ? ' (variable de entorno)' : ''}</span>` : '<span class="chip bad">sin configurar</span>';
  const folder = (k, label) => `<label>${label}<input name="${k}" data-folder="${k}" value="${esc(s[k])}" placeholder="Pega la URL de la carpeta de Drive o su ID"></label><button type="button" class="ghost" data-pick="${k}" ${drv.connected ? '' : 'disabled'}>Examinar…</button>`;
  $('#config').innerHTML = `
  <form class="cfg" data-save><h2>Datos de la farmacia</h2><p class="muted">Sirven para validar automáticamente que la factura es de tu farmacia.</p>
    <div class="grid">${inp('pharmacy_legal_name', 'Razón social')}${inp('pharmacy_trade_name', 'Nombre comercial')}${inp('pharmacy_tax_id', 'NIF/CIF')}${inp('pharmacy_address', 'Dirección')}${inp('pharmacy_postal_code', 'Código postal')}${inp('pharmacy_city', 'Ciudad')}${inp('pharmacy_province', 'Provincia')}</div>
    <div class="row"><label class="check"><input type="checkbox" name="pharmacy_recargo" ${s.pharmacy_recargo ? 'checked' : ''}> La farmacia está en recargo de equivalencia (revisar facturas sin recargo)</label><button class="primary">Guardar</button></div></form>

  <form class="cfg" data-save-secrets><h2>Anthropic (IA) ${secBadge(sec.anthropic_api_key)}</h2>
    <p class="muted">La clave solo se guarda en el servidor (nunca vuelve al navegador ni se escribe en logs). Si la defines con la variable de entorno <code>ANTHROPIC_API_KEY</code>, esa tiene prioridad.</p>
    <div class="row"><label>API Key<input type="password" name="anthropic_api_key" autocomplete="off" placeholder="${sec.anthropic_api_key.configured ? '•••••••• (déjalo vacío para no cambiarla)' : 'sk-ant-…'}"></label>
    <button class="primary">Guardar clave</button></div></form>
  <form class="cfg" data-save><div class="row"><label>Modelo (vacío = ${esc(cfg.model_default)})<input name="anthropic_model" value="${esc(s.anthropic_model)}" placeholder="${esc(cfg.model_default)}"></label><button class="primary">Guardar modelo</button></div>
    <p class="muted">Debe ser un modelo multimodal que lea PDF e imágenes. También se cambia con la variable <code>ANTHROPIC_MODEL</code>.</p></form>

  <form class="cfg" data-save><h2>Automatización</h2>
    <div class="grid">${inp('ok_threshold', 'Umbral OK IA (confianza media de campos críticos)', 'type="number" step="0.01" min="0.5" max="1"')}${inp('critical_min', 'Mínimo individual por campo crítico', 'type="number" step="0.01" min="0.5" max="1"')}</div>
    <p class="muted">Una factura es OK IA solo si la media supera el umbral <em>y</em> cada campo crítico supera su mínimo, los cálculos cuadran y el destinatario es la farmacia. Valores conservadores por defecto: 0,95 y 0,90.</p><div class="row"><button class="primary">Guardar</button></div></form>

  <form class="cfg" data-save><h2>Carpeta local</h2>
    <p class="muted">El servidor vigila esta carpeta (la de este ordenador) y procesa lo que aparezca; los ficheros procesados se mueven y renombran en la carpeta de archivo. Un navegador no puede vigilar carpetas, por eso lo hace la aplicación.</p>
    <div class="row">${`<label>Carpeta de entrada<input name="inbox_dir" value="${esc(s.inbox_dir)}" placeholder="/ruta/a/facturas-entrada"></label><label>Carpeta de archivo (por defecto data/archivo)<input name="archive_dir" value="${esc(s.archive_dir)}" placeholder="data/archivo"></label>`}<button class="primary">Guardar</button></div></form>

  <form class="cfg" data-save><h2>Google Drive ${drv.connected ? `<span class="chip good">conectado: ${esc(drv.user || '')}</span>` : '<span class="chip">no conectado</span>'}</h2>
    ${drv.configured ? '' : `<p class="muted">Primero crea credenciales OAuth («Aplicación web») en Google Cloud con la API de Drive, y pega aquí el ID y el secreto de cliente (o usa GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET). URI de redirección: <code>${esc(location.origin)}/api/drive/callback</code></p>`}
    <div class="row" id="gcreds"><label>Client ID ${secBadge(sec.google_client_id)}<input name="g_id" autocomplete="off" placeholder="…apps.googleusercontent.com"></label><label>Client secret ${secBadge(sec.google_client_secret)}<input name="g_secret" type="password" autocomplete="off"></label><button type="button" class="ghost" id="saveG">Guardar credenciales</button></div>
    <div class="row">${drv.connected ? '<button type="button" class="ghost" id="gdis">Desconectar Drive</button>' : `<button type="button" class="primary" id="gcon" ${drv.configured ? '' : 'disabled'}>Conectar con Google Drive</button>`}</div>
    <div class="row">${folder('drive_inbox_folder', 'Carpeta de entrada de facturas')}</div>
    <div class="row">${folder('drive_processed_folder', 'Carpeta destino / facturas procesadas')}</div>
    <div class="row">${folder('drive_gestoria_folder', 'Carpeta compartida con la gestoría')}</div>
    <div class="row"><label class="check"><input type="checkbox" name="drive_mirror" ${s.drive_mirror ? 'checked' : ''}> Subir también a Drive (carpeta procesadas) lo recibido por subida manual o carpeta local</label>
      <label>Copiar a la gestoría<select name="drive_gestoria_mode"><option value="all" ${s.drive_gestoria_mode === 'all' ? 'selected' : ''}>Todas las facturas procesadas</option><option value="ok_only" ${s.drive_gestoria_mode === 'ok_only' ? 'selected' : ''}>Solo OK IA o validadas</option></select></label><button class="primary">Guardar</button></div></form>`;

  document.querySelectorAll('form[data-save]').forEach((f) => f.addEventListener('submit', guard(async (e) => {
    e.preventDefault(); const patch = {};
    for (const el of f.elements) if (el.name && !el.name.startsWith('g_') && !el.name.includes('api_key')) patch[el.name] = el.type === 'checkbox' ? el.checked : el.value;
    await api('/api/settings', { method: 'PUT', body: patch }); toast('Guardado'); await loadConfig();
  })));
  $('form[data-save-secrets]').addEventListener('submit', guard(async (e) => {
    e.preventDefault(); const v = e.target.anthropic_api_key.value.trim(); if (!v) return toast('Escribe la API Key', true);
    await api('/api/secrets', { method: 'PUT', body: { anthropic_api_key: v } }); toast('API Key guardada en el servidor'); await loadConfig(); loadInvoices();
  }));
  $('#saveG').onclick = guard(async () => { const body = {}; if ($('[name=g_id]').value.trim()) body.google_client_id = $('[name=g_id]').value; if ($('[name=g_secret]').value.trim()) body.google_client_secret = $('[name=g_secret]').value; await api('/api/secrets', { method: 'PUT', body }); toast('Credenciales guardadas'); await loadConfig(); });
  $('#gcon')?.addEventListener('click', guard(async () => { location.href = (await api('/api/drive/auth-url')).url; }));
  $('#gdis')?.addEventListener('click', guard(async () => { await api('/api/drive/disconnect', { method: 'POST' }); await loadConfig(); }));
  document.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', () => pickFolder(b.dataset.pick)));
}
async function pickFolder(key) {
  const stack = [{ id: 'root', name: 'Mi unidad' }]; const m = $('#modal'); m.hidden = false;
  const render = guard(async () => {
    const cur = stack.at(-1); const folders = await api(`/api/drive/folders?parent=${encodeURIComponent(cur.id)}`);
    m.innerHTML = `<div><h2>${stack.map((s) => esc(s.name)).join(' / ')}</h2><div class="actions">${stack.length > 1 ? '<button class="ghost" id="up">↑ Subir</button>' : ''}${cur.id !== 'root' ? '<button class="primary" id="use">Usar esta carpeta</button>' : ''}<button class="ghost" id="cancel">Cancelar</button></div>
      <div class="folderlist">${folders.map((f) => `<button class="ghost" data-id="${esc(f.id)}" data-name="${esc(f.name)}">📁 ${esc(f.name)}</button>`).join('') || '<p class="muted">Sin subcarpetas.</p>'}</div></div>`;
    $('#cancel').onclick = closeModal; $('#up')?.addEventListener('click', () => { stack.pop(); render(); });
    $('#use')?.addEventListener('click', () => { document.querySelector(`[name=${key}]`).value = cur.id; closeModal(); toast(`Carpeta «${cur.name}» seleccionada: pulsa Guardar`); });
    m.querySelectorAll('[data-id]').forEach((b) => b.addEventListener('click', () => { stack.push({ id: b.dataset.id, name: b.dataset.name }); render(); }));
  });
  render();
}

// ------------------------------------------------------------ arranque
(async () => {
  try {
    state.categories = await api('/api/categories');
    $('[name=category_id]', form).innerHTML += state.categories.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
    state.settings = await api('/api/settings');
    await loadState(); await loadInvoices();
    const h = location.hash.slice(1); if (['proveedores', 'config'].includes(h)) showTab(h);
    if (new URLSearchParams(location.search).get('drive') === 'connected') { toast('Google Drive conectado'); showTab('config'); }
    setInterval(() => loadState().catch(() => {}), 30000);
  } catch (e) { toast(e.message, true); }
})();
