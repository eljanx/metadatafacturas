// Demo SIN llamar a Anthropic: el extractor está simulado y se cargan facturas ficticias
// para ver la interfaz. Uso: node --disable-warning=ExperimentalWarning scripts/demo.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'facturas-demo-'));
process.env.DATA_DIR = dir;
process.env.ANTHROPIC_API_KEY ||= 'demo-no-se-usa';
process.env.PORT ||= '3100';
const { setSettings } = await import('../server/settings.js');
const { setExtractor } = await import('../server/extractor.js');
const { ingest, recoverOnStart } = await import('../server/pipeline.js');
const { createApp } = await import('../server/app.js');
const { rawInvoice, PHARMACY } = await import('../test/helpers.js');

setSettings({ pharmacy_legal_name: PHARMACY.legal_name, pharmacy_trade_name: PHARMACY.trade_name, pharmacy_tax_id: PHARMACY.tax_id, pharmacy_postal_code: PHARMACY.postal_code, pharmacy_address: PHARMACY.address, pharmacy_city: 'Madrid', pharmacy_province: 'Madrid' });
const f = (value, confidence = 0.99, evidence = null, requires_review = false) => ({ value, confidence, evidence, requires_review });
const SCEN = {
  ok1: () => rawInvoice({ base: 1520.4, rate: 4, invoice_number: f('FV-23452'), invoice_date: f('2026-09-03') }),
  ok2: () => rawInvoice({ base: 310, rate: 21, re: 5.2, supplier_name: f('Cofares Sociedad Cooperativa'), supplier_tax_id: f('F28067866'), invoice_number: f('2026/8841'), invoice_date: f('2026-09-10') }),
  ok3: () => rawInvoice({ base: 48.2, supplier_name: f('Telefónica de España SAU'), supplier_tax_id: f('A82018474'), invoice_number: f('TE-99120'), invoice_date: f('2026-09-12'), extra: { category: f('Telefonía'), concept: f('Línea fija y datos agosto') } }),
  total: () => rawInvoice({ base: 640, invoice_number: f('A-5521'), invoice_date: f('2026-09-18'), totalField: f(779.2), supplier_name: f('Alliance Healthcare España SA'), supplier_tax_id: f('A28027753') }),
  numero: () => rawInvoice({ base: 215.5, invoice_number: f('FV-8O17', 0.62, 'Factura n.º FV-8O17 (borroso)'), invoice_date: f('2026-09-20'), supplier_name: f('Laboratorios Norte SL'), supplier_tax_id: f('B28000156') }),
  otraFarmacia: () => rawInvoice({ base: 99, invoice_number: f('77'), invoice_date: f('2026-09-21'), customer_tax_id: f('B28000156'), customer_name: f('FARMACIA OTRA SL') }),
};
setExtractor(async ({ buffer }) => {
  await new Promise((r) => setTimeout(r, 800));
  const key = buffer.toString().match(/ESCENARIO:(\w+)/)[1];
  return { raw: SCEN[key](), model: 'demo (simulado)', structured: true, input_tokens: 0, output_tokens: 0, duration_ms: 800 };
});
for (const key of [...Object.keys(SCEN), 'ok1']) ingest({ buffer: Buffer.from(`%PDF-1.4\n%ESCENARIO:${key} ${Math.random()}\n%%EOF`), originalName: `escaneo_${key}.pdf`, source: 'upload' });
recoverOnStart();
createApp().listen(Number(process.env.PORT), '127.0.0.1', () => console.log(`Demo en http://127.0.0.1:${process.env.PORT}  (datos en ${dir})`));
