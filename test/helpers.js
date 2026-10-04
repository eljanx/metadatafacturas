// Factoría de documentos de prueba (salida "bruta" de la IA) para tests y demo.
const f = (value, confidence = 0.99, evidence = null, requires_review = false) => ({ value, confidence, evidence, requires_review });
export function rawInvoice(o = {}) {
  const base = o.base ?? 100; const rate = o.rate ?? 21; const vat = Math.round(base * rate) / 100;
  const re = o.re ? Math.round(base * o.re) / 100 : null;
  const total = o.total ?? Math.round((base + vat + (re || 0)) * 100) / 100;
  return {
    is_invoice: f(true), document_quality: { legible: true, complete: true, notes: null }, ambiguities: [],
    document: { doc_type: f(o.doc_type ?? 'factura'), invoice_number: o.invoice_number ?? f('FV-1001'), series: f(null, 0.9), invoice_date: o.invoice_date ?? f('2026-09-15'), operation_date: f(null), due_date: f('2026-10-15'), rectified_invoice_number: f(null) },
    supplier: { name: o.supplier_name ?? f('Distribuciones Farma SA'), trade_name: f(null), tax_id: o.supplier_tax_id ?? f('A58818501'), address: f('C/ Mayor 1'), postal_code: f('28001'), city: f('Madrid'), province: f('Madrid'), country: f('ES') },
    customer: { name: o.customer_name ?? f('FARMACIA GARCIA LOPEZ SL'), tax_id: o.customer_tax_id ?? f('B12345674'), address: f('C/ Sol 5, 28013 Madrid') },
    amounts: { currency: f('EUR'), base_total: f(base), discounts_total: f(null), vat_total: f(vat), re_total: f(re), other_taxes_total: f(null), withholdings_total: f(null), total: o.totalField ?? f(total) },
    taxes: o.taxes ?? [{ vat_rate: f(rate), base: f(base), vat_amount: f(vat), re_rate: f(o.re ?? null), re_amount: f(re) }],
    payment: { method: f('Transferencia'), iban: f(null), installments: f(1) },
    concept: f('Medicamentos septiembre'), category: f('Medicamentos', 0.95),
    lines: [{ description: 'Ibuprofeno 600', reference: '123', quantity: 10, unit_price: 10, discount: null, base: 100, vat_rate: 21, re_amount: null, total: 121 }],
    ...o.extra,
  };
}
export const PHARMACY = { legal_name: 'Farmacia García López SL', trade_name: 'Farmacia García', tax_id: 'B12345674', address: 'C/ Sol 5', postal_code: '28013' };
