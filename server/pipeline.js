import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, env } from './config.js';
import { all, get, run, tx } from './db.js';
import { getSettings } from './settings.js';
import { extract, hasApiKey, PROMPT_VERSION } from './extractor.js';
import { normalizeExtraction, flatValues, toNumber, toIsoDate, FIELD_MAP } from './normalize.js';
import { evaluate } from './validation.js';
import * as repo from './repo.js';
import * as drive from './drive.js';
import { sanitizeFilename, normalizeTaxId } from './util.js';
import { log, redact } from './log.js';

const INCOMING = path.join(DATA_DIR, 'incoming');
fs.mkdirSync(INCOMING, { recursive: true });
const MAX_PDF = 32 * 1024 * 1024; const MAX_IMG = 5 * 1024 * 1024;
const EXT = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png' };

export function detectType(buf) {
  if (buf.length > 4 && buf.subarray(0, 4).toString('latin1') === '%PDF') return 'application/pdf';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  return null;
}
export const archiveRoot = () => path.resolve(getSettings().archive_dir || path.join(DATA_DIR, 'archivo'));

// ---------------------------------------------------------------- ingesta
/** Registra un fichero nuevo (comprobación de tipo + hash) y lo deja PENDIENTE: el procesado es automático. */
export function ingest({ buffer, originalName, source, workPath = null, driveFileId = null, driveUrl = null }) {
  const mime = detectType(buffer);
  if (!mime) throw new Error(`«${originalName}»: formato no admitido (solo PDF, JPG o PNG).`);
  const hash = crypto.createHash('sha256').update(buffer).digest('hex');
  if (!workPath) {
    workPath = path.join(INCOMING, `${hash.slice(0, 12)}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.${EXT[mime]}`);
    fs.writeFileSync(workPath, buffer);
  }
  return tx(() => {
    const f = run('INSERT INTO files(original_filename,source,google_drive_file_id,hash,work_path,mime,size,document_url) VALUES (?,?,?,?,?,?,?,?)',
      originalName, source, driveFileId, hash, workPath, mime, buffer.length, driveUrl);
    const fileId = Number(f.lastInsertRowid);
    if (!driveUrl) run('UPDATE files SET document_url = ? WHERE id = ?', `/api/files/${fileId}/content`, fileId);
    const invoiceId = Number(run('INSERT INTO invoices(file_id, tech_status) VALUES (?, ?)', fileId, 'PENDIENTE').lastInsertRowid);
    setImmediate(kick);
    return { fileId, invoiceId, hash };
  });
}

// ---------------------------------------------------------------- cola
const running = new Set();
const forced = new Set(); // reprocesos explícitos: ignoran el aviso de duplicado por hash
export function kick() { pump().catch((e) => log.error('pump', e)); }
async function pump() {
  if (!hasApiKey()) return; // sin API key las facturas esperan PENDIENTES
  while (running.size < env.concurrency) {
    const ids = [...running];
    const next = get(`SELECT id FROM invoices WHERE tech_status='PENDIENTE' ${ids.length ? `AND id NOT IN (${ids.join(',')})` : ''} ORDER BY id LIMIT 1`);
    if (!next) break;
    running.add(next.id);
    processInvoice(next.id, { force: forced.delete(next.id) }).catch((e) => log.error(`factura ${next.id}`, e)).finally(() => { running.delete(next.id); kick(); });
  }
}
export function recoverOnStart() {
  run(`UPDATE invoices SET tech_status='PENDIENTE' WHERE tech_status='PROCESANDO'`);
  kick();
}
export const queueState = () => ({ running: running.size });

// ---------------------------------------------------------------- lectura / escritura de ficheros
async function readFileBytes(file) {
  for (const p of [file.work_path, file.location]) if (p && !p.startsWith('drive:') && fs.existsSync(p)) return fs.readFileSync(p);
  if (file.google_drive_file_id && drive.isConnected()) return drive.downloadFile(file.google_drive_file_id);
  throw new Error('No se encuentra el fichero original (¿se movió o borró?).');
}
function moveFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  let final = dest; let n = 2;
  while (fs.existsSync(final)) { const e = path.extname(dest); final = `${dest.slice(0, -e.length)}_${n++}${e}`; }
  try { fs.renameSync(src, final); } catch (e) { if (e.code !== 'EXDEV') throw e; fs.copyFileSync(src, final); fs.unlinkSync(src); }
  return final;
}
export function buildName(inv, ext) {
  const parts = [inv.invoice_date || 'SIN-FECHA', sanitizeFilename(inv.supplier_name, 40) || 'SIN-PROVEEDOR', sanitizeFilename(inv.invoice_number, 30) || 'SIN-NUMERO'];
  if (inv.total != null) parts.push(`${Number(inv.total).toFixed(2)}EUR`);
  return `${parts.join('_')}.${ext}`;
}

// ---------------------------------------------------------------- archivo + Drive
async function finalizeFile(invoiceId) {
  const inv = repo.getInvoice(invoiceId);
  const file = get('SELECT * FROM files WHERE id = ?', inv.file_id);
  const cfg = getSettings();
  const ext = EXT[file.mime] || 'pdf';
  const isDup = inv.tech_status === 'POSIBLE_DUPLICADO' && inv.duplicate_of && !inv.invoice_number;
  const name = (isDup ? 'DUPLICADO_' : '') + buildName(inv, ext);
  const driveReady = drive.isConnected();
  let syncError = null;
  try {
    if (file.google_drive_file_id && driveReady) {
      const dest = cfg.drive_processed_folder || null;
      const r = await drive.renameAndMove(file.google_drive_file_id, name, dest);
      run('UPDATE files SET processed_filename=?, document_url=?, location=? WHERE id=?', name, r.webViewLink, `drive:${dest || (r.parents || [])[0] || ''}`, file.id);
      if (file.work_path && fs.existsSync(file.work_path) && file.work_path.startsWith(INCOMING)) fs.unlinkSync(file.work_path);
      run('UPDATE files SET work_path = NULL WHERE id = ?', file.id);
    } else if (file.work_path && fs.existsSync(file.work_path)) {
      const sub = isDup ? 'duplicados' : inv.invoice_date ? inv.invoice_date.slice(0, 7).replace('-', '/') : 'sin-fecha';
      const dest = moveFile(file.work_path, path.join(archiveRoot(), sub, name));
      run('UPDATE files SET processed_filename=?, location=?, work_path=NULL WHERE id=?', path.basename(dest), dest, file.id);
    }
  } catch (e) { syncError = `No se pudo archivar: ${redact(e.message)}`; log.warn(syncError); }
  // Espejo en Drive de lo subido en local.
  const f2 = get('SELECT * FROM files WHERE id = ?', file.id);
  if (!syncError && !f2.google_drive_file_id && driveReady && cfg.drive_mirror && cfg.drive_processed_folder && f2.location && !f2.location.startsWith('drive:') && fs.existsSync(f2.location) && !isDup) {
    try {
      const up = await drive.uploadBuffer(fs.readFileSync(f2.location), f2.processed_filename, f2.mime, cfg.drive_processed_folder);
      run('UPDATE files SET google_drive_file_id=?, document_url=? WHERE id=?', up.id, up.webViewLink, f2.id);
    } catch (e) { syncError = `No se pudo subir a Google Drive: ${redact(e.message)}`; log.warn(syncError); }
  }
  run('UPDATE files SET sync_error = ? WHERE id = ?', syncError, file.id);
  await syncGestoria(invoiceId);
}

/** Copia a la carpeta compartida con la gestoría (idempotente; respeta el modo "solo OK"). */
export async function syncGestoria(invoiceId) {
  const cfg = getSettings();
  if (!cfg.drive_gestoria_folder || !drive.isConnected()) return;
  const inv = repo.getInvoice(invoiceId);
  const file = get('SELECT * FROM files WHERE id = ?', inv.file_id);
  if (!file.google_drive_file_id || file.gestoria_file_id || inv.tech_status !== 'PROCESADO') return;
  if (cfg.drive_gestoria_mode === 'ok_only' && !['OK_IA', 'VALIDADA_MANUALMENTE'].includes(inv.review_status)) return;
  try {
    const c = await drive.copyFile(file.google_drive_file_id, file.processed_filename, cfg.drive_gestoria_folder);
    run('UPDATE files SET gestoria_file_id = ? WHERE id = ?', c.id, file.id);
  } catch (e) { run('UPDATE files SET sync_error = ? WHERE id = ?', `No se pudo copiar a la carpeta de la gestoría: ${redact(e.message)}`, file.id); }
}

// ---------------------------------------------------------------- procesado
function contextFor(invoiceId, flat) {
  const s = getSettings();
  return {
    pharmacy: { legal_name: s.pharmacy_legal_name, trade_name: s.pharmacy_trade_name, tax_id: normalizeTaxId(s.pharmacy_tax_id), address: s.pharmacy_address, postal_code: s.pharmacy_postal_code },
    ok_threshold: s.ok_threshold, critical_min: s.critical_min, pharmacy_recargo: s.pharmacy_recargo,
    knownSupplier: repo.knownSupplier(flat.supplier_tax_id),
    duplicates: [],
  };
}

const INVOICE_COLS = ['doc_type', 'invoice_number', 'series', 'invoice_date', 'operation_date', 'due_date', 'rectified_invoice', 'customer_name', 'customer_tax_id', 'customer_address', 'currency', 'base_total', 'discounts_total', 'vat_total', 're_total', 'other_taxes_total', 'withholdings_total', 'total', 'payment_method', 'iban', 'installments', 'concept'];

function persist(invoiceId, doc, ev, { duplicates, manual = false, quality }) {
  const flat = flatValues(doc);
  const supplierId = repo.upsertSupplier(flat);
  const sup = supplierId ? get('SELECT * FROM suppliers WHERE id = ?', supplierId) : null;
  let catName = flat.category;
  if (sup?.default_category_id && (!manual) && (doc.fields.category.confidence < 0.9 || !catName)) catName = get('SELECT name FROM categories WHERE id = ?', sup.default_category_id).name;
  const catId = repo.categoryId(catName || 'Otros') ?? repo.categoryId('Otros');
  const meta = Object.fromEntries(Object.entries(doc.fields).map(([k, f]) => [k, { confidence: ev.effective_confidence[k] ?? f.confidence, model_confidence: f.confidence, evidence: f.evidence, requires_review: f.requires_review }]));
  meta._taxes = { confidence: doc.taxes.length ? Math.min(...doc.taxes.map((t) => t.confidence)) : null };
  meta._quality = quality || doc.quality;
  const dupId = duplicates[0]?.id ?? null;
  const tech = duplicates.length ? 'POSIBLE_DUPLICADO' : 'PROCESADO';
  let review = ev.review_status;
  if (manual) review = ev.reasons.length ? 'CONVIENE_REVISAR' : 'VALIDADA_MANUALMENTE';
  const sets = INVOICE_COLS.map((c) => `${c} = ?`).join(', ');
  run(`UPDATE invoices SET ${sets}, supplier_id=?, category_id=?, tech_status=?, review_status=?, review_reason=?, review_reasons=?, confidence_overall=?, field_meta=?, pharmacy_match=?, duplicate_of=?, error_message=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
    ...INVOICE_COLS.map((c) => flat[c] ?? null), supplierId, catId, tech, review, ev.reasons.join(' | ') || null, JSON.stringify(ev.reasons), ev.overall_confidence, JSON.stringify(meta), ev.pharmacy_match, dupId, invoiceId);
  repo.replaceTaxes(invoiceId, doc.taxes);
  return { review, tech };
}

export async function processInvoice(invoiceId, { force = false } = {}) {
  run(`UPDATE invoices SET tech_status='PROCESANDO', error_message=NULL WHERE id = ?`, invoiceId);
  const inv0 = get('SELECT * FROM invoices WHERE id = ?', invoiceId);
  const file = get('SELECT * FROM files WHERE id = ?', inv0.file_id);
  try {
    // Duplicado exacto por hash: no se gasta una llamada a la IA.
    if (!force) {
      const same = get(`SELECT i.id, f.original_filename FROM files f JOIN invoices i ON i.file_id=f.id WHERE f.hash = ? AND f.id <> ? AND i.tech_status IN ('PROCESADO','POSIBLE_DUPLICADO') ORDER BY i.id LIMIT 1`, file.hash, file.id);
      if (same) {
        const msg = `Posible factura duplicada: el fichero es idéntico al de la factura #${same.id} («${same.original_filename}»).`;
        run(`UPDATE invoices SET tech_status='POSIBLE_DUPLICADO', review_status='CONVIENE_REVISAR', review_reason=?, review_reasons=?, duplicate_of=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`, msg, JSON.stringify([msg]), same.id, invoiceId);
        await finalizeFile(invoiceId);
        return;
      }
    }
    const buffer = await readFileBytes(file);
    if (file.mime !== 'application/pdf' && buffer.length > MAX_IMG) throw new Error('La imagen supera los 5 MB admitidos por la IA; reduce su tamaño o usa PDF.');
    if (buffer.length > MAX_PDF) throw new Error('El PDF supera los 32 MB admitidos por la IA.');

    const res = await extract({ buffer, mime: file.mime, filename: file.original_filename });
    const doc = normalizeExtraction(res.raw);
    const preFlat = flatValues(doc);
    const ctx = contextFor(invoiceId, preFlat);
    const duplicates = repo.findDuplicates(invoiceId, preFlat, preFlat.supplier_tax_id);
    ctx.duplicates = duplicates.map((d) => d.message);
    const ev = evaluate(doc, ctx);
    tx(() => {
      persist(invoiceId, doc, ev, { duplicates });
      repo.replaceLines(invoiceId, doc.lines);
      run('INSERT INTO processing_results(invoice_id,model,effort,prompt_version,structured_output,raw_json,validations,review_status,confidence_overall,input_tokens,output_tokens,duration_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
        invoiceId, res.model, res.effort ?? null, PROMPT_VERSION, res.structured ? 1 : 0, JSON.stringify(res.raw), JSON.stringify({ issues: ev.issues, checks: ev.checks, effective_confidence: ev.effective_confidence, verified: ev.verified }), ev.review_status, ev.overall_confidence, res.input_tokens ?? null, res.output_tokens ?? null, res.duration_ms ?? null);
    });
    await finalizeFile(invoiceId);
  } catch (e) {
    const msg = redact(e?.message || e);
    log.error(`Error procesando factura ${invoiceId}: ${msg}`);
    run(`UPDATE invoices SET tech_status='ERROR', review_status='CONVIENE_REVISAR', error_message=?, review_reason=?, review_reasons=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`, msg, `Error de procesamiento: ${msg}`, JSON.stringify([`Error de procesamiento: ${msg}`]), invoiceId);
    run('INSERT INTO processing_results(invoice_id, model, prompt_version, error) VALUES (?,?,?,?)', invoiceId, null, PROMPT_VERSION, msg);
  }
}

export function reprocess(invoiceId) {
  const inv = get('SELECT tech_status FROM invoices WHERE id = ?', invoiceId);
  if (!inv) throw Object.assign(new Error('Factura no encontrada'), { status: 404 });
  if (['PENDIENTE', 'PROCESANDO'].includes(inv.tech_status)) throw Object.assign(new Error('La factura ya se está procesando.'), { status: 409 });
  run(`UPDATE invoices SET tech_status='PENDIENTE' WHERE id=?`, invoiceId);
  run('INSERT INTO invoice_edits(invoice_id, field, note) VALUES (?,?,?)', invoiceId, 'reprocess', 'Reprocesada con IA');
  // force: un reproceso explícito ignora el aviso de duplicado por hash
  forced.add(invoiceId);
  kick();
}

// ---------------------------------------------------------------- edición manual
const EDITABLE = [...INVOICE_COLS, 'supplier_name', 'supplier_tax_id', 'category'];
const NUM = new Set(['base_total', 'discounts_total', 'vat_total', 're_total', 'other_taxes_total', 'withholdings_total', 'total', 'installments']);
const DATE = new Set(['invoice_date', 'operation_date', 'due_date']);
const bad = (m) => Object.assign(new Error(m), { status: 400 });

function docFromInvoice(inv) {
  const fields = {};
  for (const k of Object.keys(FIELD_MAP)) {
    const m = inv.field_meta[k] || {};
    const value = k === 'category' ? inv.category : k === 'is_invoice' ? true : inv[k] ?? null;
    fields[k] = { value, confidence: m.model_confidence ?? (value == null ? 0 : 1), evidence: m.evidence ?? null, requires_review: m.requires_review ?? false };
  }
  const tc = inv.field_meta._taxes?.confidence ?? 1;
  const taxes = inv.taxes.map((t) => ({ vat_rate: t.vat_rate, base: t.base, vat_amount: t.vat_amount, re_rate: t.re_rate, re_amount: t.re_amount, confidence: tc, requires_review: false }));
  return { fields, taxes, lines: [], quality: { legible: true, complete: true, notes: null }, ambiguities: [] };
}

/** Aplica correcciones manuales, revalida con las reglas deterministas y guarda la trazabilidad. */
export async function applyEdit(invoiceId, patch) {
  const inv = repo.getInvoice(invoiceId);
  if (!inv) throw Object.assign(new Error('Factura no encontrada'), { status: 404 });
  if (['PENDIENTE', 'PROCESANDO'].includes(inv.tech_status)) throw Object.assign(new Error('La factura se está procesando.'), { status: 409 });
  const doc = docFromInvoice(inv);
  const changes = [];
  const touch = (k, v) => {
    const old = doc.fields[k].value;
    if ((old ?? null) === (v ?? null)) return;
    changes.push({ field: k, old, value: v });
    doc.fields[k] = { value: v ?? null, confidence: 1, evidence: 'Corregido manualmente', requires_review: false };
  };
  for (const [k, raw] of Object.entries(patch)) {
    if (k === 'taxes' || k === 'category_id') continue;
    if (!EDITABLE.includes(k)) throw bad(`Campo no editable: ${k}`);
    let v = raw === '' ? null : raw;
    if (NUM.has(k)) { v = toNumber(v); if (raw !== '' && raw != null && v == null) throw bad(`Número no válido en ${k}`); }
    else if (DATE.has(k)) { if (v != null) { v = toIsoDate(v); if (!v) throw bad(`Fecha no válida en ${k} (usa AAAA-MM-DD)`); } }
    else if (k.endsWith('tax_id')) v = normalizeTaxId(v);
    else if (typeof v === 'string') v = v.trim() || null;
    touch(k, v);
  }
  if (patch.category_id != null) { const name = get('SELECT name FROM categories WHERE id = ?', Number(patch.category_id))?.name; if (!name) throw bad('Categoría no válida'); touch('category', name); }
  if (Array.isArray(patch.taxes)) {
    const taxes = patch.taxes.map((t) => ({ vat_rate: toNumber(t.vat_rate), base: toNumber(t.base), vat_amount: toNumber(t.vat_amount), re_rate: toNumber(t.re_rate), re_amount: toNumber(t.re_amount), confidence: 1, requires_review: false }))
      .filter((t) => t.base != null || t.vat_amount != null || t.vat_rate != null);
    changes.push({ field: 'taxes', old: JSON.stringify(inv.taxes.map(({ vat_rate, base, vat_amount, re_rate, re_amount }) => ({ vat_rate, base, vat_amount, re_rate, re_amount }))), value: JSON.stringify(taxes.map(({ confidence, requires_review, ...t }) => t)) });
    doc.taxes = taxes;
  }
  if (!changes.length) throw bad('No hay cambios que guardar.');
  const flat = flatValues(doc);
  const duplicates = repo.findDuplicates(invoiceId, flat, flat.supplier_tax_id);
  const ctx = contextFor(invoiceId, flat);
  ctx.duplicates = duplicates.map((d) => d.message);
  const ev = evaluate(doc, ctx);
  tx(() => {
    const { review } = persist(invoiceId, doc, ev, { duplicates, manual: true, quality: { legible: true, complete: true, notes: null } });
    for (const c of changes) run('INSERT INTO invoice_edits(invoice_id, field, old_value, new_value, note) VALUES (?,?,?,?,?)', invoiceId, c.field, c.old == null ? null : String(c.old), c.value == null ? null : String(c.value), 'Edición manual');
    run('INSERT INTO invoice_edits(invoice_id, field, old_value, new_value, note) VALUES (?,?,?,?,?)', invoiceId, 'review_status', inv.review_status, review, ev.reasons.join(' | ') || 'Validaciones correctas tras la corrección');
    if (review === 'VALIDADA_MANUALMENTE') run('UPDATE invoices SET reviewed_at=CURRENT_TIMESTAMP WHERE id=?', invoiceId);
    const nameChange = changes.find((c) => c.field === 'supplier_name');
    if (nameChange) run('UPDATE suppliers SET name = ? WHERE id = (SELECT supplier_id FROM invoices WHERE id = ?)', nameChange.value, invoiceId);
    if (changes.some((c) => c.field === 'category')) {
      const sid = get('SELECT supplier_id FROM invoices WHERE id=?', invoiceId).supplier_id;
      if (sid) run('UPDATE suppliers SET default_category_id = (SELECT category_id FROM invoices WHERE id=?) WHERE id=?', invoiceId, sid);
    }
  });
  await renameStored(invoiceId);
  await syncGestoria(invoiceId);
  return repo.getInvoice(invoiceId);
}

export async function markReviewed(invoiceId) {
  const inv = repo.getInvoice(invoiceId);
  if (!inv) throw Object.assign(new Error('Factura no encontrada'), { status: 404 });
  if (!['PROCESADO', 'POSIBLE_DUPLICADO'].includes(inv.tech_status)) throw bad('Solo se pueden marcar como revisadas facturas ya procesadas. Reprocésala o edítala.');
  tx(() => {
    run(`UPDATE invoices SET review_status='VALIDADA_MANUALMENTE', tech_status='PROCESADO', reviewed_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?`, invoiceId);
    run('INSERT INTO invoice_edits(invoice_id, field, old_value, new_value, note) VALUES (?,?,?,?,?)', invoiceId, 'review_status', inv.review_status, 'VALIDADA_MANUALMENTE', inv.review_reason || 'Marcada como revisada');
  });
  await syncGestoria(invoiceId);
  return repo.getInvoice(invoiceId);
}

/** Renombra el fichero archivado (local y/o Drive) cuando cambian los datos que forman su nombre. */
async function renameStored(invoiceId) {
  const inv = repo.getInvoice(invoiceId);
  const file = get('SELECT * FROM files WHERE id = ?', inv.file_id);
  if (!file.processed_filename || !inv.invoice_number && !inv.supplier_name) return;
  const name = buildName(inv, EXT[file.mime] || 'pdf');
  if (name === file.processed_filename) return;
  try {
    let finalName = name;
    if (file.location && !file.location.startsWith('drive:') && fs.existsSync(file.location)) {
      const dest = moveFile(file.location, path.join(path.dirname(file.location), name));
      finalName = path.basename(dest);
      run('UPDATE files SET location=? WHERE id=?', dest, file.id);
    }
    if (file.google_drive_file_id && drive.isConnected()) await drive.renameAndMove(file.google_drive_file_id, finalName, null);
    run('UPDATE files SET processed_filename=? WHERE id=?', finalName, file.id);
  } catch (e) { run('UPDATE files SET sync_error=? WHERE id=?', `No se pudo renombrar el archivo: ${redact(e.message)}`, file.id); }
}

/** Elimina el registro (no borra el fichero archivado). */
export function deleteInvoice(invoiceId) {
  const inv = get('SELECT file_id FROM invoices WHERE id = ?', invoiceId);
  if (!inv) throw Object.assign(new Error('Factura no encontrada'), { status: 404 });
  tx(() => {
    run('UPDATE invoices SET duplicate_of = NULL WHERE duplicate_of = ?', invoiceId);
    run('DELETE FROM invoices WHERE id = ?', invoiceId);
    run('DELETE FROM files WHERE id = ?', inv.file_id);
  });
}
