import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fact-'));
process.env.DATA_DIR = tmp;
process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key-not-real';
const { openDb, useDb, get, all } = await import('../server/db.js');
useDb(openDb(':memory:'));
const { setSettings } = await import('../server/settings.js');
const { setExtractor } = await import('../server/extractor.js');
const pipeline = await import('../server/pipeline.js');
const { rawInvoice, PHARMACY } = await import('./helpers.js');
const { createApp } = await import('../server/app.js');
const { scanLocal } = await import('../server/watcher.js');
const { buildWorkbook } = await import('../server/export.js');

setSettings({ pharmacy_legal_name: PHARMACY.legal_name, pharmacy_trade_name: PHARMACY.trade_name, pharmacy_tax_id: PHARMACY.tax_id, pharmacy_postal_code: PHARMACY.postal_code, inbox_dir: path.join(tmp, 'entrada') });
fs.mkdirSync(path.join(tmp, 'entrada'));

const pdf = (n) => Buffer.from(`%PDF-1.4\n% factura de prueba ${n}\n%%EOF`);
let responses = [];
let calls = 0;
setExtractor(async () => { calls++; return { raw: responses.shift(), model: 'test-model', effort: 'medium', structured: true, input_tokens: 10, output_tokens: 5, duration_ms: 1 }; });
const wait = async (id, status = ['PROCESADO', 'POSIBLE_DUPLICADO', 'ERROR']) => { for (let i = 0; i < 100; i++) { const r = get('SELECT * FROM invoices WHERE id=?', id); if (status.includes(r.tech_status)) return r; await new Promise((r2) => setTimeout(r2, 20)); } throw new Error('timeout'); };

test('flujo completo: ingesta → IA → validación → renombrado → archivo', async () => {
  responses = [rawInvoice()];
  const { invoiceId } = pipeline.ingest({ buffer: pdf(1), originalName: 'scan001.pdf', source: 'upload' });
  const inv = await wait(invoiceId);
  assert.equal(inv.tech_status, 'PROCESADO');
  assert.equal(inv.review_status, 'OK_IA');
  const file = get('SELECT * FROM files WHERE id=?', inv.file_id);
  assert.equal(file.processed_filename, '2026-09-15_Distribuciones_Farma_SA_FV-1001_121.00EUR.pdf');
  assert.ok(fs.existsSync(file.location) && file.location.includes(path.join('2026', '09')));
  assert.equal(file.work_path, null);
  assert.equal(file.document_url, `/api/files/${file.id}/content`);
  assert.equal(get('SELECT COUNT(*) n FROM invoice_taxes WHERE invoice_id=?', invoiceId).n, 1);
  const pr = get('SELECT * FROM processing_results WHERE invoice_id=?', invoiceId);
  assert.equal(pr.model, 'test-model');
});

test('mismo fichero → POSIBLE DUPLICADO sin llamar a la IA', async () => {
  const before = calls;
  const { invoiceId } = pipeline.ingest({ buffer: pdf(1), originalName: 'copia.pdf', source: 'upload' });
  const inv = await wait(invoiceId);
  assert.equal(inv.tech_status, 'POSIBLE_DUPLICADO');
  assert.equal(inv.review_status, 'CONVIENE_REVISAR');
  assert.equal(calls, before);
  assert.match(inv.review_reason, /idéntico/);
});

test('mismo proveedor y número en otro fichero → duplicado por contenido', async () => {
  responses = [rawInvoice()];
  const { invoiceId } = pipeline.ingest({ buffer: pdf(2), originalName: 'otra.pdf', source: 'upload' });
  const inv = await wait(invoiceId);
  assert.equal(inv.tech_status, 'POSIBLE_DUPLICADO');
  assert.match(inv.review_reason, /duplicada/);
});

test('carpeta local: detecta, procesa y mueve el fichero', async () => {
  responses = [rawInvoice({ base: 200, invoice_number: { value: 'FV-2002', confidence: 0.99, evidence: null, requires_review: false } })];
  const p = path.join(tmp, 'entrada', 'nueva.pdf');
  fs.writeFileSync(p, pdf(3)); fs.utimesSync(p, new Date(Date.now() - 10000), new Date(Date.now() - 10000));
  assert.equal(await scanLocal(), 1);
  const inv = await wait(all('SELECT id FROM invoices ORDER BY id DESC LIMIT 1')[0].id);
  assert.equal(inv.review_status, 'OK_IA');
  assert.equal(fs.existsSync(p), false);
  assert.equal(await scanLocal(), 0);
});

test('error de IA → ERROR con lupa (CONVIENE REVISAR) y reproceso', async () => {
  setExtractor(async () => { throw new Error('boom'); });
  const { invoiceId } = pipeline.ingest({ buffer: pdf(4), originalName: 'rota.pdf', source: 'upload' });
  const inv = await wait(invoiceId);
  assert.equal(inv.tech_status, 'ERROR');
  assert.equal(inv.review_status, 'CONVIENE_REVISAR');
  assert.match(inv.review_reason, /boom/);
  setExtractor(async () => ({ raw: rawInvoice({ base: 300, invoice_number: { value: 'FV-3003', confidence: 0.99, evidence: null, requires_review: false } }), model: 'm', structured: true }));
  pipeline.reprocess(invoiceId);
  const again = await wait(invoiceId, ['PROCESADO']);
  assert.equal(again.review_status, 'OK_IA');
});

test('edición manual: corrige, revalida y deja trazabilidad (VALIDADA MANUALMENTE)', async () => {
  const bad = rawInvoice({ base: 400, invoice_number: { value: 'FV-4004', confidence: 0.99, evidence: null, requires_review: false }, totalField: { value: 487.2, confidence: 0.99, evidence: null, requires_review: false } });
  setExtractor(async () => ({ raw: bad, model: 'm', structured: true }));
  const { invoiceId } = pipeline.ingest({ buffer: pdf(5), originalName: 'cuadra-mal.pdf', source: 'upload' });
  const inv = await wait(invoiceId);
  assert.equal(inv.review_status, 'CONVIENE_REVISAR');
  assert.match(inv.review_reason, /3,20/);
  await assert.rejects(() => pipeline.applyEdit(invoiceId, { total: 'abc' }), /Número no válido/);
  const fixed = await pipeline.applyEdit(invoiceId, { total: 484 });
  assert.equal(fixed.review_status, 'VALIDADA_MANUALMENTE');
  assert.ok(fixed.edits.some((e) => e.field === 'total' && e.old_value === '487.2' && e.new_value === '484'));
  assert.match(fixed.processed_filename, /484\.00EUR/);
  assert.ok(fs.existsSync(get('SELECT location FROM files WHERE id=?', fixed.file_id).location));
});

test('marcar como revisada y exportar a Excel (excluye duplicados)', async () => {
  const dup = get(`SELECT id FROM invoices WHERE tech_status='POSIBLE_DUPLICADO' LIMIT 1`).id;
  const wb = await buildWorkbook({}, 'http://localhost');
  const ws = wb.getWorksheet('Facturas');
  const processed = get(`SELECT COUNT(*) n FROM invoices WHERE tech_status='PROCESADO'`).n;
  assert.equal(ws.rowCount, 1 + processed + 1); // cabecera + filas + totales
  const done = await pipeline.markReviewed(dup);
  assert.equal(done.review_status, 'VALIDADA_MANUALMENTE');
  assert.equal(done.tech_status, 'PROCESADO');
});

test('API: la subida acepta PDF/imagen, rechaza otros formatos y no expone secretos', async () => {
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    setExtractor(async () => ({ raw: rawInvoice({ base: 500, invoice_number: { value: 'FV-9', confidence: 0.99, evidence: null, requires_review: false } }), model: 'm', structured: true }));
    const form = new FormData();
    form.append('files', new Blob([pdf(6)], { type: 'application/pdf' }), 'ok.pdf');
    form.append('files', new Blob(['<html>'], { type: 'text/html' }), 'malo.pdf');
    const up = await (await fetch(`${base}/api/invoices/upload`, { method: 'POST', body: form })).json();
    assert.equal(up.results[0].ok, true);
    assert.equal(up.results[1].ok, false);
    const s = await (await fetch(`${base}/api/settings`)).text();
    assert.ok(!s.includes('sk-ant'));
    const doc = await fetch(`${base}/api/files/1/content`);
    assert.equal(doc.headers.get('content-type'), 'application/pdf');
    const list = await (await fetch(`${base}/api/invoices?review=CONVIENE_REVISAR`)).json();
    assert.ok(Array.isArray(list.rows) && list.stats.total > 0);
  } finally { server.close(); }
});
