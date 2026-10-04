import Anthropic from '@anthropic-ai/sdk';
import { env } from './config.js';
import { getSecret } from './secrets.js';
import { effectiveModel } from './settings.js';
import { buildSchema } from './schema.js';
import { CATEGORIES } from './db.js';
import { redact } from './log.js';

export const PROMPT_VERSION = 'v1';
export const hasApiKey = () => !!getSecret('anthropic_api_key');

const SYSTEM = `Eres un asistente experto en facturas de compra españolas para una farmacia. Lees el documento adjunto (PDF o imagen) y devuelves SOLO datos estructurados según el esquema JSON.

Reglas estrictas:
- NUNCA inventes datos. Si un dato no aparece o no estás seguro, usa value = null.
- Extrae lo que está impreso en la factura, tal cual. Prioriza siempre los tipos de IVA y recargo indicados explícitamente; no los deduzcas por el tipo de producto.
- Fechas en formato ISO YYYY-MM-DD. Importes como números decimales con punto y sin símbolo de moneda. En abonos/rectificativas con importes negativos, usa números negativos.
- NIF/CIF/VAT sin espacios ni guiones. "supplier" es quien EMITE la factura; "customer" es el destinatario/cliente (no confundas ambos).
- confidence (0 a 1) es tu seguridad real en ese campo: 0.99 solo si es claramente legible y inequívoco; baja la confianza si hay texto borroso, cortado, varios valores posibles o dudas de interpretación. evidence: fragmento literal corto (máx. 80 caracteres) donde lo leíste. requires_review = true si recomiendas que una persona lo compruebe.
- Si hay varios valores posibles para un campo (p. ej. dos números de factura o dos totales), elige el más probable, baja su confianza y descríbelo en "ambiguities".
- taxes: un elemento por cada tipo impositivo distinto (IVA y, si aplica, recargo de equivalencia). re_rate/re_amount solo si la factura los muestra.
- document_quality: legible=false si no se puede leer con fiabilidad; complete=false si faltan páginas o la factura está cortada.
- is_invoice = false si el documento no es una factura (albarán, presupuesto, extracto, etc.).
- concept: descripción corta (máx. 12 palabras) de lo facturado. category: elige la más adecuada de: ${CATEGORIES.join(', ')}.
- lines (si el esquema las incluye): líneas de detalle cuando sea posible, máximo 40 (las más relevantes si hay más). Si no puedes extraerlas bien, devuelve un array vacío: es secundario.`;

let client = null; let clientKey = null;
function getClient() {
  const key = getSecret('anthropic_api_key');
  if (!key) throw new Error('Falta la API Key de Anthropic (Configuración → Anthropic).');
  if (!client || clientKey !== key) { client = new Anthropic({ apiKey: key, maxRetries: 3 }); clientKey = key; }
  return client;
}

function contentBlock(buffer, mime) {
  const data = buffer.toString('base64');
  if (mime === 'application/pdf') return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } };
  return { type: 'image', source: { type: 'base64', media_type: mime, data } };
}

async function call({ buffer, mime, includeLines, structured }) {
  const model = effectiveModel();
  const params = {
    model,
    max_tokens: 32000,
    system: SYSTEM,
    messages: [{
      role: 'user',
      content: [
        contentBlock(buffer, mime),
        { type: 'text', text: 'Extrae los datos de esta factura.' + (structured ? '' : `\n\nResponde ÚNICAMENTE con un objeto JSON válido que cumpla este esquema JSON:\n${JSON.stringify(buildSchema({ lines: includeLines }))}`) },
      ],
    }],
  };
  const output_config = {};
  if (!/haiku/.test(model)) output_config.effort = env.effort;
  if (structured) output_config.format = { type: 'json_schema', schema: buildSchema({ lines: includeLines }) };
  if (Object.keys(output_config).length) params.output_config = output_config;
  const t0 = Date.now();
  const msg = await getClient().messages.stream(params).finalMessage();
  return { msg, model, durationMs: Date.now() - t0 };
}

function parseJson(msg) {
  if (msg.stop_reason === 'refusal') throw new Error('El modelo rechazó procesar este documento.');
  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const start = text.indexOf('{'); const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('La respuesta de la IA no contiene JSON.');
  return JSON.parse(text.slice(start, end + 1));
}

/** Llama a Anthropic (solo backend) y devuelve el JSON bruto + metadatos. */
async function realExtract({ buffer, mime }) {
  let structured = true; let includeLines = true;
  let usageIn = 0; let usageOut = 0; let total = 0;
  for (let attempt = 0; attempt < 4; attempt++) {
    let res;
    try {
      res = await call({ buffer, mime, includeLines, structured });
    } catch (e) {
      // Esquema demasiado complejo para el modo estructurado: se reintenta con el esquema en el prompt.
      if (structured && e?.status === 400 && /schema|output_config|format/i.test(String(e.message))) { structured = false; continue; }
      throw new Error(redact(e?.message || e));
    }
    total += res.durationMs; usageIn += res.msg.usage?.input_tokens || 0; usageOut += res.msg.usage?.output_tokens || 0;
    if (res.msg.stop_reason === 'max_tokens') { includeLines = false; continue; } // JSON truncado: las líneas son secundarias
    try {
      return { raw: parseJson(res.msg), model: res.model, effort: env.effort, structured, input_tokens: usageIn, output_tokens: usageOut, duration_ms: total };
    } catch (e) {
      if (attempt === 3) throw new Error(`No se pudo interpretar la respuesta de la IA: ${redact(e.message)}`);
      structured = false;
    }
  }
  throw new Error('No se pudo obtener una extracción válida.');
}

let impl = realExtract;
export const extract = (args) => impl(args);
/** Solo para tests/demos: sustituye la llamada a Anthropic. */
export function setExtractor(fn) { impl = fn || realExtract; }
