import test from 'node:test';
import assert from 'node:assert/strict';
import { checkTaxId, extractDriveFolderId, nameSimilarity, normalizeTaxId } from '../server/util.js';
import { toNumber, toIsoDate } from '../server/normalize.js';

test('NIF/CIF/NIE: dígito de control', () => {
  assert.equal(checkTaxId('12345678Z').valid, true);
  assert.equal(checkTaxId('12345678A').valid, false);
  assert.equal(checkTaxId('X1234567L').valid, true);
  assert.equal(checkTaxId('A58818501').valid, true);   // CIF con dígito
  assert.equal(checkTaxId('A58818502').valid, false);
  assert.equal(checkTaxId('Q2826000H').valid, true);   // CIF con letra
  assert.equal(checkTaxId('PT501234567').kind, 'eu-vat');
  assert.equal(normalizeTaxId('ES A-58.818.501'), 'A58818501');
});

test('URL de carpeta de Drive → Folder ID', () => {
  const id = '1AbCdEfGhIjKlMnOpQrStUvWxYz012345';
  assert.equal(extractDriveFolderId(`https://drive.google.com/drive/folders/${id}?usp=sharing`), id);
  assert.equal(extractDriveFolderId(`https://drive.google.com/drive/u/0/folders/${id}`), id);
  assert.equal(extractDriveFolderId(`https://drive.google.com/open?id=${id}`), id);
  assert.equal(extractDriveFolderId(id), id);
  assert.equal(extractDriveFolderId('hola'), null);
});

test('similitud de nombres ignora sufijos legales y "farmacia"', () => {
  assert.ok(nameSimilarity('FARMACIA GARCÍA LÓPEZ, S.L.', 'García López SL') >= 0.99);
  assert.ok(nameSimilarity('Cofares S.A.', 'Farmacia García López') < 0.2);
});

test('normalización de números y fechas', () => {
  assert.equal(toNumber('1.234,56 €'), 1234.56);
  assert.equal(toNumber('1,234.56'), 1234.56);
  assert.equal(toNumber('12,5'), 12.5);
  assert.equal(toIsoDate('05/03/2026'), '2026-03-05');
  assert.equal(toIsoDate('2026-02-30'), null);
});

test('Client ID de Google: formato', async () => {
  const { isGoogleClientId } = await import('../server/util.js');
  assert.equal(isGoogleClientId('123456789012-abc_def.apps.googleusercontent.com'), true);
  assert.equal(isGoogleClientId('GOCSPX-secreto'), false);
  assert.equal(isGoogleClientId(''), false);
});
