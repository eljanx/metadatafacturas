import { checkTaxId, normalizeTaxId, nameSimilarity, round2, fmtEur, fmtPct } from './util.js';

// Motor automático de confianza: combina confianza del modelo, campos obligatorios,
// validaciones matemáticas y fiscales, identidad de proveedor, destinatario y duplicidad.
// Función pura (sin BD): recibe el "doc" normalizado y un contexto, devuelve la decisión.

export const LABELS = {
  supplier_name: 'el proveedor', supplier_tax_id: 'el CIF/NIF del proveedor', invoice_number: 'el número de factura',
  invoice_date: 'la fecha de factura', customer_name: 'el destinatario', customer_tax_id: 'el NIF/CIF del destinatario',
  base_total: 'la base imponible', vat_total: 'el IVA', re_total: 'el recargo de equivalencia', total: 'el total de la factura',
};
const STANDARD_VAT = [0, 2, 4, 5, 7.5, 10, 21];
const BOOST_ID = 0.97;
const BOOST_AMOUNT = 0.96;

const val = (doc, k) => doc.fields[k]?.value ?? null;
const conf = (doc, k) => doc.fields[k]?.confidence ?? 0;
const num = (v) => (v == null ? 0 : Number(v));

/** Rellena con código lo que se puede derivar del desglose (no inventa: solo suma). */
export function deriveMissing(doc) {
  const notes = [];
  const taxes = doc.taxes;
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  if (taxes.length) {
    if (val(doc, 'base_total') == null && taxes.every((t) => t.base != null)) {
      doc.fields.base_total = { value: round2(taxes.reduce((a, t) => a + t.base, 0)), confidence: mean(taxes.map((t) => t.confidence)), evidence: 'Suma del desglose fiscal', requires_review: false };
      notes.push('base_total derivada del desglose');
    }
    if (val(doc, 'vat_total') == null && taxes.every((t) => t.vat_amount != null)) {
      doc.fields.vat_total = { value: round2(taxes.reduce((a, t) => a + t.vat_amount, 0)), confidence: mean(taxes.map((t) => t.confidence)), evidence: 'Suma del desglose fiscal', requires_review: false };
      notes.push('vat_total derivado del desglose');
    }
    if (val(doc, 're_total') == null && taxes.some((t) => t.re_amount != null)) {
      doc.fields.re_total = { value: round2(taxes.reduce((a, t) => a + num(t.re_amount), 0)), confidence: mean(taxes.map((t) => t.confidence)), evidence: 'Suma del desglose fiscal', requires_review: false };
      notes.push('re_total derivado del desglose');
    }
  }
  return notes;
}

export function checkMath(doc) {
  const base = val(doc, 'base_total'); const vat = val(doc, 'vat_total'); const total = val(doc, 'total');
  if (base == null || vat == null || total == null) return { ok: null, reason: 'incompleto' };
  const extras = num(val(doc, 're_total')) + num(val(doc, 'other_taxes_total')) - num(val(doc, 'withholdings_total'));
  const expected = round2(base + vat + extras);
  const tol = 0.05 + 0.01 * Math.max(1, doc.taxes.length);
  const diff = round2(total - expected);
  if (Math.abs(diff) <= tol) return { ok: true, expected, diff };
  // Algunos proveedores indican un descuento global que no está incluido en la base.
  const disc = num(val(doc, 'discounts_total'));
  if (disc) {
    const alt = round2(expected - Math.abs(disc));
    if (Math.abs(round2(total - alt)) <= tol) return { ok: true, expected: alt, diff: round2(total - alt), note: 'descuento global aplicado' };
  }
  return { ok: false, expected, diff };
}

export function checkTaxes(doc) {
  const problems = []; let sound = true;
  const tol = 0.02;
  const base = val(doc, 'base_total'); const vat = val(doc, 'vat_total'); const re = val(doc, 're_total');
  doc.taxes.forEach((t, i) => {
    const tag = doc.taxes.length > 1 ? ` (bloque ${i + 1})` : '';
    let rate = t.vat_rate;
    if (t.base == null || t.vat_amount == null) { problems.push(`Desglose de IVA incompleto${tag}.`); sound = false; return; }
    if (rate == null) {
      const implied = t.base ? round2((t.vat_amount / t.base) * 100) : null;
      const std = implied == null ? null : STANDARD_VAT.find((s) => Math.abs(s - implied) < 0.05);
      if (std == null) { problems.push(`No se distingue el tipo de IVA${tag}.`); sound = false; return; }
      rate = std;
    }
    const expected = round2((t.base * rate) / 100);
    if (Math.abs(expected - t.vat_amount) > tol) {
      problems.push(`La cuota de IVA${tag} no cuadra: ${fmtEur(t.base)} × ${rate} % = ${fmtEur(expected)}, la factura indica ${fmtEur(t.vat_amount)}.`);
      sound = false;
    }
    if (t.re_rate != null && t.re_amount != null) {
      const expRe = round2((t.base * t.re_rate) / 100);
      if (Math.abs(expRe - t.re_amount) > tol) {
        problems.push(`El recargo de equivalencia${tag} no cuadra: ${fmtEur(t.base)} × ${t.re_rate} % = ${fmtEur(expRe)}, la factura indica ${fmtEur(t.re_amount)}.`);
        sound = false;
      }
    } else if (t.re_rate != null || t.re_amount != null) {
      problems.push(`Recargo de equivalencia incompleto${tag}.`); sound = false;
    }
  });
  if (doc.taxes.length) {
    const tolSum = 0.02 * doc.taxes.length + 0.03;
    const sb = doc.taxes.every((t) => t.base != null) ? round2(doc.taxes.reduce((a, t) => a + t.base, 0)) : null;
    const sv = doc.taxes.every((t) => t.vat_amount != null) ? round2(doc.taxes.reduce((a, t) => a + t.vat_amount, 0)) : null;
    const sr = round2(doc.taxes.reduce((a, t) => a + num(t.re_amount), 0));
    if (sb != null && base != null && Math.abs(sb - base) > tolSum) { problems.push(`La suma de bases del desglose (${fmtEur(sb)}) difiere de la base total (${fmtEur(base)}).`); sound = false; }
    if (sv != null && vat != null && Math.abs(sv - vat) > tolSum) { problems.push(`La suma de cuotas de IVA (${fmtEur(sv)}) difiere del IVA total (${fmtEur(vat)}).`); sound = false; }
    if (re != null && Math.abs(sr - re) > tolSum) { problems.push(`La suma de recargos (${fmtEur(sr)}) difiere del recargo total (${fmtEur(re)}).`); sound = false; }
  }
  return { ok: doc.taxes.length ? sound : null, problems };
}

export function checkPharmacy(doc, pharmacy) {
  if (!pharmacy?.tax_id) {
    return { status: 'unconfigured', reason: 'Faltan los datos de la farmacia en Configuración: no se puede validar el destinatario.' };
  }
  const phId = normalizeTaxId(pharmacy.tax_id);
  const cId = val(doc, 'customer_tax_id');
  const cName = val(doc, 'customer_name');
  const names = [pharmacy.legal_name, pharmacy.trade_name].filter(Boolean);
  const sim = names.length && cName ? Math.max(...names.map((n) => nameSimilarity(cName, n))) : 0;
  if (cId) {
    if (cId === phId) return { status: 'match', similarity: sim };
    return { status: 'mismatch', similarity: sim, reason: `El NIF/CIF del destinatario (${cId}) no coincide con el de la farmacia (${phId}).` };
  }
  if (!cName) return { status: 'unknown', reason: 'No se ha podido identificar al destinatario de la factura.' };
  const cp = String(val(doc, 'customer_address') || '').match(/\b\d{5}\b/)?.[0];
  const cpOk = !cp || !pharmacy.postal_code || cp === pharmacy.postal_code;
  if (sim >= 0.75 && cpOk) return { status: 'match', similarity: sim, weak: true };
  if (sim >= 0.4 || (sim >= 0.75 && !cpOk)) return { status: 'unknown', similarity: sim, reason: 'No se distingue con seguridad si el destinatario es la farmacia (sin NIF/CIF en la factura).' };
  return { status: 'mismatch', similarity: sim, reason: `El destinatario «${cName}» no parece corresponder a la farmacia.` };
}

/**
 * @param doc    documento normalizado (normalize.js)
 * @param ctx    { pharmacy, ok_threshold, critical_min, pharmacy_recargo, duplicates:[string], knownSupplier, today }
 */
export function evaluate(doc, ctx) {
  const reasons = []; const issues = [];
  const add = (code, field, message) => { reasons.push(message); issues.push({ code, field, message }); };
  const today = ctx.today || new Date();
  const okThreshold = ctx.ok_threshold ?? 0.95;
  const criticalMin = ctx.critical_min ?? 0.9;

  const derivedNotes = deriveMissing(doc);
  const eff = {}; // confianza efectiva por campo crítico
  const verified = new Set(); // campos verificados por reglas deterministas

  // --- Documento
  if (val(doc, 'is_invoice') === false && conf(doc, 'is_invoice') >= 0.6) add('not_invoice', 'is_invoice', 'El documento no parece una factura.');
  if (!doc.quality.legible) add('illegible', null, `El documento es ilegible o de mala calidad${doc.quality.notes ? `: ${doc.quality.notes}` : '.'}`);
  if (!doc.quality.complete) add('incomplete', null, `La factura parece estar incompleta o cortada${doc.quality.notes ? `: ${doc.quality.notes}` : '.'}`);
  for (const a of doc.ambiguities) add('ambiguity', a.field, `Hay varios valores posibles${a.field ? ` para ${a.field}` : ''}: ${a.description}`);

  const docType = val(doc, 'doc_type');
  const simplified = docType === 'simplificada';
  const rectifying = docType === 'rectificativa' || docType === 'abono';
  if (rectifying && !val(doc, 'rectified_invoice')) add('rectified_unlinked', 'rectified_invoice', 'Es una rectificativa/abono y no se ha podido relacionar con la factura original.');
  const cur = val(doc, 'currency');
  if (cur && String(cur).toUpperCase() !== 'EUR' && cur !== '€') add('currency', 'currency', `La factura está en una moneda distinta del euro (${cur}).`);

  // --- Proveedor: CIF
  const sid = checkTaxId(val(doc, 'supplier_tax_id'));
  if (sid.id) {
    if (sid.kind === 'unknown') add('supplier_tax_id_format', 'supplier_tax_id', `El CIF/NIF del proveedor («${sid.id}») no tiene un formato reconocible.`);
    else if (['nif', 'nie', 'cif'].includes(sid.kind) && !sid.valid) add('supplier_tax_id_checksum', 'supplier_tax_id', `El CIF del proveedor («${sid.id}») no supera el dígito de control: posible error de lectura.`);
    else if (sid.valid) verified.add('supplier_tax_id');
  }
  if (sid.id && ctx.pharmacy?.tax_id && sid.id === normalizeTaxId(ctx.pharmacy.tax_id)) add('supplier_is_pharmacy', 'supplier_tax_id', 'El proveedor tiene el mismo NIF que la farmacia (¿es una factura emitida?).');
  const ks = ctx.knownSupplier;
  if (ks?.name && val(doc, 'supplier_name') && nameSimilarity(val(doc, 'supplier_name'), ks.name) < 0.4 && nameSimilarity(val(doc, 'supplier_name'), ks.trade_name || '') < 0.4) {
    add('supplier_mismatch', 'supplier_name', `El nombre del proveedor («${val(doc, 'supplier_name')}») no coincide con el registrado para ese CIF («${ks.name}»).`);
  }

  // --- Destinatario / farmacia
  const ph = simplified && !val(doc, 'customer_tax_id') && !val(doc, 'customer_name')
    ? { status: 'unknown', reason: 'Factura simplificada sin destinatario: no se puede acreditar que sea de la farmacia.' }
    : checkPharmacy(doc, ctx.pharmacy);
  if (ph.status !== 'match') add(`pharmacy_${ph.status}`, 'customer_tax_id', ph.reason);
  const cid = checkTaxId(val(doc, 'customer_tax_id'));
  if (ph.status === 'match' && !ph.weak && cid.id) verified.add('customer_tax_id');

  // --- Fecha
  const date = val(doc, 'invoice_date');
  if (date) {
    const d = new Date(`${date}T00:00:00Z`);
    if (d - today > 7 * 864e5) add('date_future', 'invoice_date', `La fecha de factura (${date}) es posterior a hoy.`);
    else if (today - d > 4 * 365 * 864e5) add('date_old', 'invoice_date', `La fecha de factura (${date}) es muy antigua; conviene comprobarla.`);
  }

  // --- Importes
  const math = checkMath(doc);
  const taxCheck = checkTaxes(doc);
  if (math.ok === false) add('math', 'total', `El total calculado (${fmtEur(math.expected)}) difiere ${fmtEur(Math.abs(math.diff))} del total indicado.`);
  for (const p of taxCheck.problems) add('tax', 'vat_total', p);
  const amountsVerified = math.ok === true && taxCheck.ok !== false;
  if (amountsVerified) for (const k of ['base_total', 'vat_total', 'total']) verified.add(k);
  const hasRe = doc.taxes.some((t) => num(t.re_amount) > 0) || num(val(doc, 're_total')) > 0;
  if (amountsVerified && hasRe) verified.add('re_total');
  if (ctx.pharmacy_recargo && doc.taxes.some((t) => num(t.vat_rate) > 0 || (t.vat_rate == null && num(t.vat_amount) > 0)) && !hasRe) {
    add('re_missing', 're_total', 'La farmacia está en recargo de equivalencia y la factura no indica recargo.');
  }

  // --- Campos críticos: presentes y con confianza suficiente (individual y media)
  const critical = ['supplier_name', 'supplier_tax_id', 'invoice_number', 'invoice_date', 'base_total', 'vat_total', 'total'];
  critical.push(val(doc, 'customer_tax_id') || !val(doc, 'customer_name') ? 'customer_tax_id' : 'customer_name');
  if (hasRe) critical.push('re_total');
  const lowConf = [];
  for (const k of critical) {
    const f = doc.fields[k];
    if (f.value == null) {
      if (k === 'customer_tax_id' && simplified) continue;
      if (k === 'customer_tax_id' && ph.status !== 'match') { eff[k] = 0; continue; } // ya explicado en la comprobación de destinatario
      add('missing', k, `No se ha podido identificar ${LABELS[k]}.`); eff[k] = 0; continue;
    }
    let c = f.confidence; let rr = f.requires_review;
    const isVerified = verified.has(k) && (k === 'customer_tax_id' || c >= (['supplier_tax_id'].includes(k) ? 0.75 : 0.8));
    if (isVerified) { c = Math.max(c, ['supplier_tax_id', 'customer_tax_id'].includes(k) ? BOOST_ID : BOOST_AMOUNT); rr = false; }
    eff[k] = c;
    if (c < criticalMin || rr) {
      const why = c < criticalMin ? `confianza ${fmtPct(c)}` : 'la IA lo marcó como dudoso';
      add('low_confidence', k, `Hay dudas sobre ${LABELS[k]} (${why})${f.evidence ? `: «${String(f.evidence).slice(0, 80)}»` : '.'}`);
      lowConf.push(k);
    }
  }
  const effValues = Object.values(eff);
  const overall = effValues.length ? effValues.reduce((a, b) => a + b, 0) / effValues.length : 0;
  if (!lowConf.length && overall < okThreshold) add('low_overall', null, `La confianza media de los campos críticos (${fmtPct(overall)}) no alcanza el umbral configurado (${fmtPct(okThreshold)}).`);

  // --- Duplicados
  for (const d of ctx.duplicates || []) add('duplicate', 'invoice_number', d);

  const unique = [...new Set(reasons)];
  const isDup = (ctx.duplicates || []).length > 0;
  return {
    review_status: unique.length ? 'CONVIENE_REVISAR' : 'OK_IA',
    reasons: unique,
    issues,
    overall_confidence: Math.round(overall * 1000) / 1000,
    effective_confidence: eff,
    verified: [...verified],
    checks: { math, taxes: taxCheck, pharmacy: ph, supplier_tax_id: sid, derived: derivedNotes },
    pharmacy_match: ph.status === 'match' ? 1 : ph.status === 'unconfigured' ? null : 0,
    possible_duplicate: isDup,
  };
}
