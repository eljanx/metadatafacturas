import { normalizeTaxId } from './util.js';
import { CATEGORIES } from './db.js';

// Convierte la salida de la IA (anidada) al modelo plano "doc" que usan validación, BD y UI.
export const FIELD_MAP = {
  doc_type: ['document', 'doc_type'], invoice_number: ['document', 'invoice_number'], series: ['document', 'series'],
  invoice_date: ['document', 'invoice_date'], operation_date: ['document', 'operation_date'],
  due_date: ['document', 'due_date'], rectified_invoice: ['document', 'rectified_invoice_number'],
  supplier_name: ['supplier', 'name'], supplier_trade_name: ['supplier', 'trade_name'],
  supplier_tax_id: ['supplier', 'tax_id'], supplier_address: ['supplier', 'address'],
  supplier_postal_code: ['supplier', 'postal_code'], supplier_city: ['supplier', 'city'],
  supplier_province: ['supplier', 'province'], supplier_country: ['supplier', 'country'],
  customer_name: ['customer', 'name'], customer_tax_id: ['customer', 'tax_id'], customer_address: ['customer', 'address'],
  currency: ['amounts', 'currency'], base_total: ['amounts', 'base_total'], discounts_total: ['amounts', 'discounts_total'],
  vat_total: ['amounts', 'vat_total'], re_total: ['amounts', 're_total'],
  other_taxes_total: ['amounts', 'other_taxes_total'], withholdings_total: ['amounts', 'withholdings_total'],
  total: ['amounts', 'total'], payment_method: ['payment', 'method'], iban: ['payment', 'iban'],
  installments: ['payment', 'installments'], concept: ['concept'], category: ['category'], is_invoice: ['is_invoice'],
};
const NUMERIC = new Set(['base_total', 'discounts_total', 'vat_total', 're_total', 'other_taxes_total', 'withholdings_total', 'total', 'installments']);
const DATES = new Set(['invoice_date', 'operation_date', 'due_date']);

export function toNumber(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let s = String(v).replace(/[€\s]|EUR/gi, '');
  if (s.includes(',') && s.includes('.')) s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  else if (s.includes(',')) s = s.replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
export function toIsoDate(v) {
  if (!v) return null;
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) { const d = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/); if (d) m = [0, d[3], d[2].padStart(2, '0'), d[1].padStart(2, '0')]; }
  if (!m) return null;
  const dt = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (dt.getUTCFullYear() !== +m[1] || dt.getUTCMonth() !== +m[2] - 1 || dt.getUTCDate() !== +m[3]) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

const emptyField = () => ({ value: null, confidence: 0, evidence: null, requires_review: true });
function cleanField(name, f) {
  const out = { ...emptyField(), ...(f && typeof f === 'object' ? f : {}) };
  out.confidence = Math.min(1, Math.max(0, Number(out.confidence) || 0));
  out.requires_review = !!out.requires_review;
  let v = out.value;
  if (v === '' || v === undefined) v = null;
  if (NUMERIC.has(name)) v = toNumber(v);
  else if (DATES.has(name)) { const d = toIsoDate(v); if (v != null && d == null) { out.requires_review = true; out.confidence = Math.min(out.confidence, 0.5); } v = d; }
  else if (name.endsWith('tax_id')) v = normalizeTaxId(v);
  else if (name === 'iban') v = v == null ? null : String(v).replace(/\s/g, '').toUpperCase();
  else if (name === 'category') v = CATEGORIES.includes(v) ? v : null;
  else if (typeof v === 'string') v = v.trim() || null;
  out.value = v;
  return out;
}

export function normalizeExtraction(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const fields = {};
  for (const [name, p] of Object.entries(FIELD_MAP)) {
    let node = r; for (const k of p) node = node?.[k];
    fields[name] = cleanField(name, node);
  }
  const taxes = (Array.isArray(r.taxes) ? r.taxes : []).map((t) => {
    const f = (k) => cleanField('base_total', t?.[k]);
    const parts = { vat_rate: f('vat_rate'), base: f('base'), vat_amount: f('vat_amount'), re_rate: f('re_rate'), re_amount: f('re_amount') };
    const present = Object.values(parts).filter((p) => p.value != null);
    return {
      vat_rate: parts.vat_rate.value, base: parts.base.value, vat_amount: parts.vat_amount.value,
      re_rate: parts.re_rate.value, re_amount: parts.re_amount.value,
      confidence: present.length ? Math.min(...present.map((p) => p.confidence)) : 0,
      requires_review: present.some((p) => p.requires_review),
    };
  }).filter((t) => t.base != null || t.vat_amount != null || t.vat_rate != null);
  const lines = (Array.isArray(r.lines) ? r.lines : []).map((l, i) => ({
    position: i + 1, description: l?.description ?? null, reference: l?.reference ?? null,
    quantity: toNumber(l?.quantity), unit_price: toNumber(l?.unit_price), discount: toNumber(l?.discount),
    base: toNumber(l?.base), vat_rate: toNumber(l?.vat_rate), re_amount: toNumber(l?.re_amount), total: toNumber(l?.total),
  }));
  const q = r.document_quality || {};
  return {
    fields, taxes, lines,
    quality: { legible: q.legible !== false, complete: q.complete !== false, notes: q.notes ?? null },
    ambiguities: (Array.isArray(r.ambiguities) ? r.ambiguities : []).filter((a) => a?.description),
  };
}

/** Campos planos {nombre: valor} para guardar en la tabla invoices. */
export const flatValues = (doc) => Object.fromEntries(Object.entries(doc.fields).map(([k, f]) => [k, f.value]));
