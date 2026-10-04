import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeExtraction } from '../server/normalize.js';
import { evaluate } from '../server/validation.js';
import { rawInvoice, PHARMACY } from './helpers.js';

const ctx = (o = {}) => ({ pharmacy: PHARMACY, ok_threshold: 0.95, critical_min: 0.9, duplicates: [], today: new Date('2026-10-01'), ...o });
const run = (raw, c) => evaluate(normalizeExtraction(raw), ctx(c));
const f = (value, confidence = 0.99, evidence = null, requires_review = false) => ({ value, confidence, evidence, requires_review });

test('factura limpia → OK IA', () => {
  const r = run(rawInvoice());
  assert.deepEqual(r.reasons, []);
  assert.equal(r.review_status, 'OK_IA');
  assert.ok(r.overall_confidence >= 0.95);
});

test('con recargo de equivalencia y varios tipos de IVA → OK IA', () => {
  const r = run(rawInvoice({ base: 150, rate: 10, re: 1.4, taxes: [
    { vat_rate: f(10), base: f(100), vat_amount: f(10), re_rate: f(1.4), re_amount: f(1.4) },
    { vat_rate: f(4), base: f(50), vat_amount: f(2), re_rate: f(0.5), re_amount: f(0.25) },
  ], totalField: f(163.65), extra: { amounts: { currency: f('EUR'), base_total: f(150), discounts_total: f(null), vat_total: f(12), re_total: f(1.65), other_taxes_total: f(null), withholdings_total: f(null), total: f(163.65) } } }));
  assert.deepEqual(r.reasons, []);
});

test('el total no cuadra → CONVIENE REVISAR con la diferencia concreta', () => {
  const r = run(rawInvoice({ totalField: f(124.2) }));
  assert.equal(r.review_status, 'CONVIENE_REVISAR');
  assert.match(r.reasons.join(' '), /difiere 3,20 €/);
});

test('confianza baja en número de factura → motivo con el campo concreto', () => {
  const r = run(rawInvoice({ invoice_number: f('FV-1OO1', 0.7, 'Factura n.º FV-1OO1') }));
  assert.equal(r.review_status, 'CONVIENE_REVISAR');
  assert.match(r.reasons[0], /el número de factura/);
  assert.match(r.reasons[0], /70 %/);
});

test('la IA marca requires_review en un campo crítico no verificable', () => {
  const r = run(rawInvoice({ invoice_date: f('2026-09-15', 0.99, null, true) }));
  assert.match(r.reasons.join(' '), /fecha de factura/);
});

test('un CIF con dígito de control válido compensa una confianza algo baja', () => {
  const r = run(rawInvoice({ supplier_tax_id: f('A58818501', 0.8) }));
  assert.equal(r.review_status, 'OK_IA');
});

test('CIF con dígito de control inválido → revisar', () => {
  const r = run(rawInvoice({ supplier_tax_id: f('A58818502', 0.99) }));
  assert.match(r.reasons.join(' '), /dígito de control/);
});

test('destinatario con otro NIF → no parece la farmacia', () => {
  const r = run(rawInvoice({ customer_tax_id: f('A58818501') }));
  assert.match(r.reasons.join(' '), /no coincide con el de la farmacia/);
});

test('farmacia sin configurar → no se puede validar el destinatario', () => {
  const r = run(rawInvoice(), { pharmacy: {} });
  assert.match(r.reasons.join(' '), /Faltan los datos de la farmacia/);
});

test('duplicado → CONVIENE REVISAR + posible duplicado', () => {
  const r = run(rawInvoice(), { duplicates: ['Posible factura duplicada: ...'] });
  assert.equal(r.possible_duplicate, true);
  assert.equal(r.review_status, 'CONVIENE_REVISAR');
});

test('documento incompleto o no factura → revisar', () => {
  const raw = rawInvoice(); raw.document_quality = { legible: true, complete: false, notes: 'falta la última página' };
  assert.match(run(raw).reasons.join(' '), /incompleta.*última página/);
  const raw2 = rawInvoice(); raw2.is_invoice = f(false, 0.95);
  assert.match(run(raw2).reasons.join(' '), /no parece una factura/);
});

test('cuota de IVA incoherente con base × tipo', () => {
  const r = run(rawInvoice({ taxes: [{ vat_rate: f(21), base: f(100), vat_amount: f(12), re_rate: f(null), re_amount: f(null) }] }));
  assert.match(r.reasons.join(' '), /cuota de IVA.*no cuadra/);
});

test('sin tipo de IVA pero deducible de forma exacta → sin dudas', () => {
  const r = run(rawInvoice({ taxes: [{ vat_rate: f(null), base: f(100), vat_amount: f(21), re_rate: f(null), re_amount: f(null) }] }));
  assert.equal(r.review_status, 'OK_IA');
});

test('rectificativa sin factura original → revisar; abono con importes negativos cuadra', () => {
  const raw = rawInvoice({ doc_type: 'abono', base: -100, total: -121 });
  raw.document.invoice_number = f('AB-7');
  assert.match(run(raw).reasons.join(' '), /relacionar con la factura original/);
  raw.document.rectified_invoice_number = f('FV-1001');
  assert.equal(run(raw).review_status, 'OK_IA');
});

test('las líneas imperfectas no provocan revisión', () => {
  const raw = rawInvoice(); raw.lines = [];
  assert.equal(run(raw).review_status, 'OK_IA');
});

test('recargo de equivalencia exigido por la farmacia y ausente → revisar', () => {
  const r = run(rawInvoice(), { pharmacy_recargo: true });
  assert.match(r.reasons.join(' '), /recargo de equivalencia/);
});
