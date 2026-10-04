# Facturas Farmacia

Gestión **automática** de las facturas de compra de una farmacia en España. Hace solo esto, y lo hace sin intervención:

`recibir → procesar con IA → extraer y validar → guardar → OK IA / CONVIENE REVISAR → renombrar → archivar → Excel para la gestoría → consultar`

No es un ERP ni un programa contable. No hay botón «Procesar»: cada factura que entra se procesa sola; solo las marcadas **CONVIENE REVISAR** piden atención, y se revisan con **un clic en la 🔍** (abre el documento original).

## Arrancar

```bash
npm install
export ANTHROPIC_API_KEY=sk-ant-...      # o configúrala desde la pantalla Configuración
npm start                                 # http://127.0.0.1:3000
npm test                                  # 28 tests (validación, pipeline, API, Excel)
node --disable-warning=ExperimentalWarning scripts/demo.js   # demo con IA SIMULADA (no llama a Anthropic)
```

Requiere Node ≥ 22.13 (usa `node:sqlite`, sin dependencias nativas). Primer uso: rellena **Configuración → Datos de la farmacia** (sin NIF/CIF no se puede validar el destinatario y todo quedará en CONVIENE REVISAR) y la API Key.

## Windows: INSTALAR / ACTUALIZAR / ARRANCAR

Tres `.bat` con doble clic (instrucciones para la persona usuaria en `LEEME-WINDOWS.txt`):

- **INSTALAR.bat** — instala Node.js si falta (winget), `npm install` y lanza el asistente `scripts/configurar.js`, que pide y **comprueba** la API Key de Anthropic, opcionalmente las credenciales de Google Drive y un token de GitHub, y los guarda en `.env` (fuera de git).
- **ACTUALIZAR.bat** — descarga la última versión de la rama y copia los ficheros **sin tocar** `.env`, `data/` ni `node_modules/`, y reinstala dependencias. El repositorio es **privado**, por eso usa el `GITHUB_TOKEN` de `.env` (fine-grained, solo lectura de *Contents*); si el repositorio se hiciera público no haría falta.
- **ARRANCAR.bat** — arranca el servidor, abre `http://localhost:3000` y lo reinicia solo si se cae. Hay que dejar la ventana abierta.

> Los `.bat` no se han podido ejecutar en Windows desde el entorno de desarrollo (sí el asistente y la carga de `.env` en Linux). Si algo falla en tu equipo, copia el mensaje de la ventana.

## Fuentes de facturas

| Fuente | Cómo funciona |
|---|---|
| Subida manual | Arrastrar o seleccionar varios PDF/JPG/PNG. Se valida el tipo real del fichero (no solo la extensión). |
| Carpeta local | Un navegador **no puede** vigilar carpetas, así que lo hace el backend: sondea `inbox_dir` (la carpeta del equipo donde corre la app) cada `POLL_INTERVAL_SEC` s. Los ficheros procesados se **mueven y renombran** a `archive_dir` (`data/archivo/AAAA/MM/`). Solo sirve si la app corre en el mismo equipo/servidor que la carpeta. |
| Google Drive | OAuth con permiso `drive`. Carpeta de entrada, de procesadas y compartida con la gestoría: se pueden elegir con el explorador o **pegando la URL** (se extrae el Folder ID). En Drive el fichero se renombra y mueve a «procesadas» y se copia a la carpeta de la gestoría (todas, o solo OK IA/validadas). |

## Cómo decide OK IA / CONVIENE REVISAR (`server/validation.js`)

La IA devuelve JSON con esquema estricto: por campo `value` (null si no hay seguridad), `confidence`, `evidence`, `requires_review`. Después el código —no la IA— decide:

- **Campos críticos** (proveedor, CIF proveedor, nº factura, fecha, destinatario, base, IVA, recargo si aplica, total): presentes, y cada uno ≥ `critical_min` (0,90) **y** la media ≥ `ok_threshold` (0,95). No basta una media.
- **Verificación determinista**: un CIF/NIF/NIE con dígito de control válido, o importes que cuadran entre sí, sustituyen a una confianza algo baja del modelo.
- **Matemáticas**: base + IVA + recargo + otros − retenciones ≈ total (tolerancia de redondeo); base × tipo ≈ cuota (IVA y recargo) por bloque; suma de bloques = totales. Admite varios tipos de IVA por factura.
- **Identidad**: CIF válido, nombre coherente con el proveedor ya registrado para ese CIF, proveedor ≠ farmacia.
- **Destinatario = farmacia**: NIF/CIF igual al configurado (o nombre + código postal si la factura no trae NIF).
- **Duplicados**: hash del fichero (sin gastar llamada a la IA), proveedor + nº de factura, proveedor + fecha + importe.
- También marca: documento ilegible/incompleto, «no parece factura», valores ambiguos, rectificativa sin factura original, fecha futura, moneda ≠ EUR.
- **No** marca por líneas imperfectas ni por detalles secundarios.

Cada motivo es específico (`El total calculado (774,40 €) difiere 4,80 € del total indicado.`), se guarda en `review_reason(s)` y se muestra en la tabla (texto + tooltip). Nunca «confidence bajo» a secas.

## Revisión

En CONVIENE REVISAR: **🔍 Abrir factura** (Drive → URL de Drive en pestaña nueva; si no, visor interno `/api/files/:id/content`), **Reprocesar con IA**, **Editar** (revalida con las reglas; si pasan → `VALIDADA MANUALMENTE`) y **Marcar como revisada**. Cada corrección queda en `invoice_edits` (campo, valor anterior/nuevo). Si cambian los datos del nombre, el archivo se renombra.

## Excel para la gestoría

`⬇ Excel gestoría` (respeta los filtros de fecha/proveedor/categoría): hojas *Facturas* (con enlace al documento y subtotales), *Desglose fiscal* y *Resumen por categoría*. Excluye duplicados sin resolver y errores. Con Drive conectado, también puede subirse a la carpeta de la gestoría.

## Datos (SQLite en `data/facturas.db`)

`invoices`, `invoice_taxes`, `invoice_lines`, `suppliers`, `categories`, `files` (original_filename, processed_filename, source, document_url, google_drive_file_id, hash, location), `processing_results` (modelo, effort, versión de prompt, JSON bruto de la IA, validaciones, tokens, duración, error) e `invoice_edits`.

## Seguridad

- Las llamadas a Anthropic se hacen **solo desde el backend**. La API Key vive en variable de entorno o en `data/secrets.json` (permisos 600); la API solo informa «configurada: sí/no», nunca la devuelve, y el logger redacta cualquier cadena con forma de clave.
- Escucha solo en `127.0.0.1` por defecto. Si la expones, define `APP_PASSWORD` (autenticación básica) y usa HTTPS delante. La app no tiene usuarios ni roles.
- Los documentos se envían a Anthropic para su lectura; tenlo en cuenta respecto a RGPD si contienen datos personales.

## Qué NO está verificado

- La integración con **Anthropic** y con **Google Drive** no se ha probado contra los servicios reales (sin credenciales en el entorno de desarrollo): los tests y la demo usan un extractor simulado. Si el modo de salida estructurada rechazara el esquema, el extractor reintenta pidiendo el JSON en el prompt (`processing_results.structured_output` lo registra).
- El esquema se envía con `output_config.format`; no se activan los `fallbacks` de rechazo del modelo (un rechazo se registra como error de la factura).
- Imágenes > 5 MB y PDF > 32 MB se rechazan (límites de la API) con un error visible.
