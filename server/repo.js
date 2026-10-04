import { all, get, run, tx } from './db.js';

export const REVIEW_LABEL = { OK_IA: 'OK IA', CONVIENE_REVISAR: 'CONVIENE REVISAR', VALIDADA_MANUALMENTE: 'VALIDADA MANUALMENTE' };

const BASE_SELECT = `
SELECT i.*, s.name AS supplier_name, s.tax_id AS supplier_tax_id, s.trade_name AS supplier_trade_name,
       c.name AS category, f.original_filename, f.processed_filename, f.source, f.document_url,
       f.google_drive_file_id, f.hash, f.location, f.sync_error
FROM invoices i
JOIN files f ON f.id = i.file_id
LEFT JOIN suppliers s ON s.id = i.supplier_id
LEFT JOIN categories c ON c.id = i.category_id`;

function where(q = {}) {
  const w = []; const p = [];
  if (q.review) { w.push('i.review_status = ?'); p.push(q.review); }
  if (q.tech) { w.push('i.tech_status = ?'); p.push(q.tech); }
  if (q.category_id) { w.push('i.category_id = ?'); p.push(Number(q.category_id)); }
  if (q.supplier_id) { w.push('i.supplier_id = ?'); p.push(Number(q.supplier_id)); }
  if (q.from) { w.push('i.invoice_date >= ?'); p.push(q.from); }
  if (q.to) { w.push('i.invoice_date <= ?'); p.push(q.to); }
  if (q.q) {
    const like = `%${String(q.q).toLowerCase()}%`;
    w.push(`(lower(coalesce(s.name,'')) LIKE ? OR lower(coalesce(s.tax_id,'')) LIKE ? OR lower(coalesce(i.invoice_number,'')) LIKE ? OR lower(f.original_filename) LIKE ? OR lower(coalesce(i.concept,'')) LIKE ?)`);
    p.push(like, like, like, like, like);
  }
  if (q.export) w.push(`i.tech_status = 'PROCESADO'`);
  return { sql: w.length ? ` WHERE ${w.join(' AND ')}` : '', p };
}

export function listInvoices(q = {}, { limit = 50, offset = 0 } = {}) {
  const { sql, p } = where(q);
  const rows = all(`${BASE_SELECT}${sql} ORDER BY COALESCE(i.invoice_date, substr(i.created_at,1,10)) DESC, i.id DESC LIMIT ? OFFSET ?`, ...p, limit, offset);
  const total = get(`SELECT COUNT(*) n FROM invoices i JOIN files f ON f.id=i.file_id LEFT JOIN suppliers s ON s.id=i.supplier_id${sql}`, ...p).n;
  return { rows: rows.map(shape), total };
}
export const listForExport = (q) => all(`${BASE_SELECT}${where({ ...q, export: true }).sql} ORDER BY i.invoice_date, i.id`, ...where({ ...q, export: true }).p).map(shape);

function shape(r) {
  return { ...r, review_reasons: r.review_reasons ? JSON.parse(r.review_reasons) : [], field_meta: r.field_meta ? JSON.parse(r.field_meta) : {} };
}
export function getInvoice(id) {
  const r = get(`${BASE_SELECT} WHERE i.id = ?`, id);
  if (!r) return null;
  const inv = shape(r);
  inv.taxes = all('SELECT * FROM invoice_taxes WHERE invoice_id = ? ORDER BY id', id);
  inv.lines = all('SELECT * FROM invoice_lines WHERE invoice_id = ? ORDER BY position', id);
  inv.edits = all('SELECT * FROM invoice_edits WHERE invoice_id = ? ORDER BY id DESC', id);
  inv.processing = all('SELECT id, model, effort, prompt_version, structured_output, review_status, confidence_overall, input_tokens, output_tokens, duration_ms, error, created_at FROM processing_results WHERE invoice_id = ? ORDER BY id DESC LIMIT 5', id);
  return inv;
}

export function upsertSupplier(f) {
  const tax = f.supplier_tax_id || null;
  const name = f.supplier_name || null;
  if (!tax && !name) return null;
  const existing = tax ? get('SELECT * FROM suppliers WHERE tax_id = ?', tax) : get('SELECT * FROM suppliers WHERE tax_id IS NULL AND name = ?', name);
  const cols = { name, trade_name: f.supplier_trade_name, address: f.supplier_address, postal_code: f.supplier_postal_code, city: f.supplier_city, province: f.supplier_province, country: f.supplier_country };
  if (existing) {
    // No machacamos datos ya guardados del proveedor con valores nulos.
    for (const [k, v] of Object.entries(cols)) if (v != null && !existing[k]) run(`UPDATE suppliers SET ${k} = ? WHERE id = ?`, v, existing.id);
    return existing.id;
  }
  return Number(run('INSERT INTO suppliers(name,trade_name,tax_id,address,postal_code,city,province,country) VALUES (?,?,?,?,?,?,?,?)', cols.name, cols.trade_name, tax, cols.address, cols.postal_code, cols.city, cols.province, cols.country).lastInsertRowid);
}
export const knownSupplier = (taxId) => (taxId ? get('SELECT * FROM suppliers WHERE tax_id = ?', taxId) : null);
export const categoryId = (name) => (name ? get('SELECT id FROM categories WHERE name = ?', name)?.id ?? null : null);

/** Busca posibles duplicados por proveedor+nº factura y por proveedor+fecha+total. */
export function findDuplicates(invoiceId, f, taxId) {
  const out = [];
  if (!taxId) return out;
  const ignore = invoiceId ?? -1;
  const label = (r) => `factura #${r.id}${r.invoice_number ? ` (${r.invoice_number})` : ''}`;
  if (f.invoice_number) {
    const sameNum = all(`SELECT i.id, i.invoice_number, i.doc_type FROM invoices i JOIN suppliers s ON s.id=i.supplier_id
      WHERE s.tax_id = ? AND upper(replace(i.invoice_number,' ','')) = upper(replace(?,' ','')) AND i.id <> ? AND i.tech_status IN ('PROCESADO','POSIBLE_DUPLICADO')`, taxId, f.invoice_number, ignore)
      .filter((r) => (r.doc_type === 'rectificativa' || r.doc_type === 'abono') === (f.doc_type === 'rectificativa' || f.doc_type === 'abono'));
    for (const r of sameNum) out.push({ id: r.id, message: `Posible factura duplicada: el mismo proveedor ya tiene el nº ${f.invoice_number} en la ${label(r)}.` });
  }
  if (f.invoice_date && f.total != null) {
    const sameAmt = all(`SELECT i.id, i.invoice_number FROM invoices i JOIN suppliers s ON s.id=i.supplier_id
      WHERE s.tax_id = ? AND i.invoice_date = ? AND abs(i.total - ?) < 0.005 AND i.id <> ? AND i.tech_status IN ('PROCESADO','POSIBLE_DUPLICADO')`, taxId, f.invoice_date, f.total, ignore);
    for (const r of sameAmt) {
      const msg = `Posible factura duplicada: misma fecha e importe (${f.total} €) que la ${label(r)} del mismo proveedor.`;
      if (!out.some((o) => o.id === r.id)) out.push({ id: r.id, message: msg });
    }
  }
  return out;
}

export function replaceTaxes(invoiceId, taxes) {
  run('DELETE FROM invoice_taxes WHERE invoice_id = ?', invoiceId);
  for (const t of taxes) run('INSERT INTO invoice_taxes(invoice_id,vat_rate,base,vat_amount,re_rate,re_amount) VALUES (?,?,?,?,?,?)', invoiceId, t.vat_rate ?? null, t.base ?? null, t.vat_amount ?? null, t.re_rate ?? null, t.re_amount ?? null);
}
export function replaceLines(invoiceId, lines) {
  run('DELETE FROM invoice_lines WHERE invoice_id = ?', invoiceId);
  for (const l of lines) run('INSERT INTO invoice_lines(invoice_id,position,description,reference,quantity,unit_price,discount,base,vat_rate,re_amount,total) VALUES (?,?,?,?,?,?,?,?,?,?,?)', invoiceId, l.position, l.description, l.reference, l.quantity, l.unit_price, l.discount, l.base, l.vat_rate, l.re_amount, l.total);
}

export function stats(q = {}) {
  const { sql, p } = where({ ...q, review: undefined, tech: undefined });
  const from = `FROM invoices i JOIN files f ON f.id=i.file_id LEFT JOIN suppliers s ON s.id=i.supplier_id LEFT JOIN categories c ON c.id=i.category_id${sql}`;
  const count = (extra) => get(`SELECT COUNT(*) n ${from}${sql ? ' AND' : ' WHERE'} ${extra}`, ...p).n;
  const done = count(`i.tech_status IN ('PROCESADO','POSIBLE_DUPLICADO')`);
  return {
    total: get(`SELECT COUNT(*) n ${from}`, ...p).n,
    ok_ia: count(`i.review_status='OK_IA'`),
    review: count(`i.review_status='CONVIENE_REVISAR'`),
    manual: count(`i.review_status='VALIDADA_MANUALMENTE'`),
    in_progress: count(`i.tech_status IN ('PENDIENTE','PROCESANDO')`),
    errors: count(`i.tech_status='ERROR'`),
    duplicates: count(`i.tech_status='POSIBLE_DUPLICADO'`),
    done,
    amount_total: get(`SELECT COALESCE(SUM(i.total),0) v ${from}${sql ? ' AND' : ' WHERE'} i.tech_status='PROCESADO'`, ...p).v,
    by_category: all(`SELECT COALESCE(c.name,'Sin categoría') name, COUNT(*) n, COALESCE(SUM(i.total),0) total ${from}${sql ? ' AND' : ' WHERE'} i.tech_status='PROCESADO' GROUP BY 1 ORDER BY total DESC`, ...p),
  };
}
export const suppliersSummary = () => all(`
  SELECT s.id, s.name, s.tax_id, s.city, COUNT(i.id) invoices, COALESCE(SUM(CASE WHEN i.tech_status='PROCESADO' THEN i.total END),0) total,
         SUM(CASE WHEN i.review_status='CONVIENE_REVISAR' THEN 1 ELSE 0 END) to_review
  FROM suppliers s LEFT JOIN invoices i ON i.supplier_id = s.id GROUP BY s.id ORDER BY total DESC`);
export { tx };
