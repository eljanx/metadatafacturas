import ExcelJS from 'exceljs';
import { listForExport } from './repo.js';
import { all } from './db.js';
import { REVIEW_LABEL } from './repo.js';

const EUR = '#,##0.00 "€"';
const absUrl = (u, base) => (u && u.startsWith('/') ? base + u : u);

export async function buildWorkbook(filters = {}, baseUrl = '') {
  const rows = listForExport(filters);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Facturas Farmacia'; wb.created = new Date();
  const head = (ws) => { ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } }; ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E79' } }; ws.views = [{ state: 'frozen', ySplit: 1 }]; };

  const ws = wb.addWorksheet('Facturas');
  ws.columns = [
    { header: 'Fecha factura', key: 'invoice_date', width: 13 }, { header: 'Nº factura', key: 'invoice_number', width: 18 },
    { header: 'Tipo', key: 'doc_type', width: 13 }, { header: 'Proveedor', key: 'supplier_name', width: 32 },
    { header: 'CIF proveedor', key: 'supplier_tax_id', width: 14 }, { header: 'Base imponible', key: 'base_total', width: 15, style: { numFmt: EUR } },
    { header: 'IVA', key: 'vat_total', width: 13, style: { numFmt: EUR } }, { header: 'Recargo equiv.', key: 're_total', width: 14, style: { numFmt: EUR } },
    { header: 'Otros impuestos', key: 'other_taxes_total', width: 14, style: { numFmt: EUR } }, { header: 'Retenciones', key: 'withholdings_total', width: 13, style: { numFmt: EUR } },
    { header: 'Total', key: 'total', width: 14, style: { numFmt: EUR } }, { header: 'Categoría', key: 'category', width: 20 },
    { header: 'Concepto', key: 'concept', width: 36 }, { header: 'Forma de pago', key: 'payment_method', width: 16 },
    { header: 'IBAN', key: 'iban', width: 26 }, { header: 'Vencimiento', key: 'due_date', width: 13 },
    { header: 'Estado revisión', key: 'review', width: 22 }, { header: 'Motivo de revisión', key: 'review_reason', width: 50 },
    { header: 'Archivo', key: 'processed_filename', width: 40 }, { header: 'Enlace al documento', key: 'link', width: 22 },
  ];
  head(ws);
  for (const r of rows) {
    const row = ws.addRow({ ...r, review: REVIEW_LABEL[r.review_status] || '', link: 'Abrir' });
    const url = absUrl(r.document_url, baseUrl);
    if (url) row.getCell('link').value = { text: 'Abrir', hyperlink: url };
    if (r.review_status === 'CONVIENE_REVISAR') row.getCell('review').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFE699' } };
  }
  const n = ws.rowCount;
  if (n > 1) {
    const t = ws.addRow({ supplier_name: 'TOTAL' });
    for (const k of ['base_total', 'vat_total', 're_total', 'other_taxes_total', 'withholdings_total', 'total']) {
      const col = ws.getColumn(k).letter; t.getCell(k).value = { formula: `SUBTOTAL(109,${col}2:${col}${n})` };
    }
    t.font = { bold: true };
  }
  ws.autoFilter = { from: 'A1', to: { row: 1, column: ws.columns.length } };

  const wt = wb.addWorksheet('Desglose fiscal');
  wt.columns = [
    { header: 'Fecha factura', key: 'invoice_date', width: 13 }, { header: 'Nº factura', key: 'invoice_number', width: 18 }, { header: 'Proveedor', key: 'supplier_name', width: 32 },
    { header: '% IVA', key: 'vat_rate', width: 9 }, { header: 'Base', key: 'base', width: 14, style: { numFmt: EUR } }, { header: 'Cuota IVA', key: 'vat_amount', width: 14, style: { numFmt: EUR } },
    { header: '% Recargo', key: 're_rate', width: 10 }, { header: 'Cuota recargo', key: 're_amount', width: 14, style: { numFmt: EUR } },
  ];
  head(wt);
  const ids = rows.map((r) => r.id);
  const byId = new Map(rows.map((r) => [r.id, r]));
  if (ids.length) for (const t of all(`SELECT * FROM invoice_taxes WHERE invoice_id IN (${ids.map(() => '?').join(',')}) ORDER BY invoice_id, id`, ...ids)) {
    const r = byId.get(t.invoice_id); wt.addRow({ ...t, invoice_date: r.invoice_date, invoice_number: r.invoice_number, supplier_name: r.supplier_name });
  }

  const wc = wb.addWorksheet('Resumen por categoría');
  wc.columns = [{ header: 'Categoría', key: 'c', width: 26 }, { header: 'Nº facturas', key: 'n', width: 12 }, { header: 'Base', key: 'b', width: 15, style: { numFmt: EUR } }, { header: 'IVA', key: 'v', width: 14, style: { numFmt: EUR } }, { header: 'Total', key: 't', width: 15, style: { numFmt: EUR } }];
  head(wc);
  const cats = new Map();
  for (const r of rows) { const c = cats.get(r.category || 'Sin categoría') || { c: r.category || 'Sin categoría', n: 0, b: 0, v: 0, t: 0 }; c.n++; c.b += r.base_total || 0; c.v += r.vat_total || 0; c.t += r.total || 0; cats.set(c.c, c); }
  [...cats.values()].sort((a, b) => b.t - a.t).forEach((c) => wc.addRow(c));
  return wb;
}
