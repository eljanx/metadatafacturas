import { CATEGORIES } from './db.js';

// JSON Schema estricto para la extracción. Cada campo relevante devuelve
// value / confidence / evidence / requires_review. value = null cuando no hay seguridad.
const nullable = (inner) => ({ anyOf: [inner, { type: 'null' }] });
const field = (inner) => ({
  type: 'object',
  properties: {
    value: nullable(inner),
    confidence: { type: 'number' },
    evidence: nullable({ type: 'string' }),
    requires_review: { type: 'boolean' },
  },
  required: ['value', 'confidence', 'evidence', 'requires_review'],
  additionalProperties: false,
});
const S = () => field({ type: 'string' });
const N = () => field({ type: 'number' });
const obj = (props) => ({ type: 'object', properties: props, required: Object.keys(props), additionalProperties: false });

export const DOC_TYPES = ['factura', 'rectificativa', 'abono', 'simplificada', 'otro'];

export function buildSchema({ lines = true } = {}) {
  const props = {
    is_invoice: field({ type: 'boolean' }),
    document_quality: obj({
      legible: { type: 'boolean' },
      complete: { type: 'boolean' },
      notes: nullable({ type: 'string' }),
    }),
    ambiguities: {
      type: 'array',
      items: obj({ field: { type: 'string' }, description: { type: 'string' } }),
    },
    document: obj({
      doc_type: field({ type: 'string', enum: DOC_TYPES }),
      invoice_number: S(), series: S(), invoice_date: S(), operation_date: S(), due_date: S(),
      rectified_invoice_number: S(),
    }),
    supplier: obj({
      name: S(), trade_name: S(), tax_id: S(), address: S(), postal_code: S(), city: S(), province: S(), country: S(),
    }),
    customer: obj({ name: S(), tax_id: S(), address: S() }),
    amounts: obj({
      currency: S(), base_total: N(), discounts_total: N(), vat_total: N(), re_total: N(),
      other_taxes_total: N(), withholdings_total: N(), total: N(),
    }),
    taxes: {
      type: 'array',
      items: obj({ vat_rate: N(), base: N(), vat_amount: N(), re_rate: N(), re_amount: N() }),
    },
    payment: obj({ method: S(), iban: S(), installments: field({ type: 'integer' }) }),
    concept: S(),
    category: field({ type: 'string', enum: CATEGORIES }),
  };
  if (lines) {
    props.lines = {
      type: 'array',
      items: obj({
        description: nullable({ type: 'string' }), reference: nullable({ type: 'string' }),
        quantity: nullable({ type: 'number' }), unit_price: nullable({ type: 'number' }),
        discount: nullable({ type: 'number' }), base: nullable({ type: 'number' }),
        vat_rate: nullable({ type: 'number' }), re_amount: nullable({ type: 'number' }),
        total: nullable({ type: 'number' }),
      }),
    };
  }
  return obj(props);
}
