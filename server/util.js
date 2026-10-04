// Utilidades puras: NIF/CIF, similitud de nombres, formato.

export function normalizeTaxId(v) {
  if (v == null) return null;
  let s = String(v).toUpperCase().replace(/[\s.\-_/]/g, '');
  s = s.replace(/^(NIF|CIF|NIE|VAT|IVA)[:]?/, '');
  if (/^ES[A-Z0-9]{9}$/.test(s)) s = s.slice(2);
  return s || null;
}

const NIF_LETTERS = 'TRWAGMYFPDXBNJZSQVHLCKE';

/** Devuelve 'nif' | 'nie' | 'cif' | 'eu-vat' | 'unknown', y valid=true si pasa el dígito de control. */
export function checkTaxId(raw) {
  const id = normalizeTaxId(raw);
  if (!id) return { kind: 'unknown', valid: false, id };
  if (/^\d{8}[A-Z]$/.test(id)) {
    return { kind: 'nif', valid: NIF_LETTERS[Number(id.slice(0, 8)) % 23] === id[8], id };
  }
  if (/^[XYZ]\d{7}[A-Z]$/.test(id)) {
    const n = Number('XYZ'.indexOf(id[0]) + id.slice(1, 8));
    return { kind: 'nie', valid: NIF_LETTERS[n % 23] === id[8], id };
  }
  if (/^[KLM]\d{7}[A-Z]$/.test(id)) {
    return { kind: 'nif', valid: NIF_LETTERS[Number(id.slice(1, 8)) % 23] === id[8], id };
  }
  if (/^[ABCDEFGHJNPQRSUVW]\d{7}[0-9A-J]$/.test(id)) {
    const d = id.slice(1, 8).split('').map(Number);
    let sum = 0;
    d.forEach((x, i) => {
      if (i % 2 === 0) { const t = x * 2; sum += Math.floor(t / 10) + (t % 10); } else sum += x;
    });
    const ctrl = (10 - (sum % 10)) % 10;
    const last = id[8];
    const letter = 'JABCDEFGHI'[ctrl];
    const letterOnly = 'PQRSNW'.includes(id[0]);
    const digitOnly = 'ABEH'.includes(id[0]);
    const ok = letterOnly ? last === letter : digitOnly ? last === String(ctrl) : last === letter || last === String(ctrl);
    return { kind: 'cif', valid: ok, id };
  }
  if (/^[A-Z]{2}[A-Z0-9]{8,12}$/.test(id) && !id.startsWith('ES')) return { kind: 'eu-vat', valid: false, id };
  return { kind: 'unknown', valid: false, id };
}

const strip = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const STOP = new Set([
  'de', 'del', 'la', 'el', 'los', 'las', 'y', 'e', 'en', 'sl', 'sa', 'slu', 'sau', 'sll', 'cb', 'scp', 'sc', 'coop',
  'slp', 'farmacia', 'oficina', 'lda', 'lcdo', 'lcda', 'dr', 'dra', 'don', 'dona', 'sociedad', 'limitada', 'anonima',
]);
export function nameTokens(s) {
  if (!s) return [];
  return strip(s).replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((t) => t && !STOP.has(t));
}
/** Similitud 0..1: tokens compartidos / tokens del nombre más corto. */
export function nameSimilarity(a, b) {
  const A = new Set(nameTokens(a)); const B = new Set(nameTokens(b));
  if (!A.size || !B.size) return 0;
  let common = 0;
  for (const t of A) if (B.has(t)) common++;
  return common / Math.min(A.size, B.size);
}

export const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
export const fmtEur = (n) => `${Number(n).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
export const fmtPct = (c) => `${Math.round(c * 100)} %`;

export function extractDriveFolderId(input) {
  if (!input) return null;
  const s = String(input).trim();
  let m = s.match(/\/folders\/([\w-]{10,})/);
  if (m) return m[1];
  m = s.match(/[?&]id=([\w-]{10,})/);
  if (m) return m[1];
  if (/^[\w-]{10,}$/.test(s)) return s;
  return null;
}

export function sanitizeFilename(s, max = 60) {
  return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\w.\- ]+/g, '').trim().replace(/\s+/g, '_').slice(0, max);
}
