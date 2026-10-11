import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
import React from 'react';
import * as icons from 'lucide-react';
import { renderToStaticMarkup } from 'react-dom/server';
import { isRegistrationForm, registrationFilings, lookupRegistrationFilings } from '../supabase/functions/_shared/registrationFilings.ts';

const columns = (forms) => ({
  form: forms,
  filingDate: forms.map((_, i) => `2026-06-${String(25 - i).padStart(2, '0')}`),
  accessionNumber: forms.map((_, i) => `0000320193-26-${String(i + 1).padStart(6, '0')}`),
  primaryDocument: forms.map((_, i) => `filing${i}.htm`),
});
const json = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
function mockSec(data, archives = {}) {
  const calls = [];
  const fetch = async url => {
    calls.push(url);
    if (url.endsWith('company_tickers.json')) return json({ 0: { ticker: 'AAPL', cik_str: 320193 } });
    if (url.endsWith('CIK0000320193.json')) return json(data);
    const archive = archives[url.split('/').at(-1)];
    assert.ok(archive, `Unexpected request: ${url}`);
    return json(archive);
  };
  return { fetch, calls };
}

test('includes S/F registrations and amendments; excludes other forms and prefix lookalikes', () => {
  for (const form of ['S-1', 'S-3ASR', 'S-4', 'S-4/A', 'F-4', 'F-4/A', 'S-11/A', 'F-1', 'F-3MEF', 'S-8', 'F-6EF']) {
    assert.equal(isRegistrationForm(form), true, form);
  }
  for (const form of ['10-K', '10-Q', '8-K', '20-F', 'DEF14A', '424B3', 'EFFECT', 'SC 13D', 'F-SR', 'S-40', 'S-4XYZ', 'F-40', undefined]) {
    assert.equal(isRegistrationForm(form), false, form);
  }
});

test('preserves date, form and dashed accession; creates direct EDGAR links', () => {
  const result = registrationFilings(columns(['10-K', 'S-4/A', 'F-4']), '0000320193');
  assert.equal(result.length, 2);
  assert.deepEqual(result[0], {
    form: 'S-4/A', date: '2026-06-24', accession: '0000320193-26-000002',
    primaryDocument: 'filing1.htm', period: '',
    url: 'https://www.sec.gov/Archives/edgar/data/320193/000032019326000002/filing1.htm',
  });
});

test('uses filing index if primary document is missing and skips malformed rows', () => {
  const data = columns(['S-4', 'F-4']);
  data.primaryDocument = [];
  data.accessionNumber[1] = '';
  const result = registrationFilings(data, '320193');
  assert.equal(result.length, 1);
  assert.ok(result[0].url.endsWith('/0000320193-26-000001-index.html'));
});

test('ticker lookup retains company identity and limits registrations rather than all filings', async () => {
  const data = { name: 'Apple Inc.', filings: { recent: columns([...Array(21).fill('10-Q'), 'S-4/A', 'F-4']) } };
  const sec = mockSec(data);
  const result = await lookupRegistrationFilings(' aapl ', sec.fetch, 2);
  assert.equal(result.ticker, 'AAPL');
  assert.equal(result.companyName, 'Apple Inc.');
  assert.equal(result.cik, '0000320193');
  assert.deepEqual(result.filings.map(f => f.form), ['S-4/A', 'F-4']);
  assert.equal(sec.calls.length, 2);
});

test('numeric CIK bypasses ticker mapping, including companies without a ticker', async () => {
  for (const input of ['320193', '0000320193']) {
    const sec = mockSec({ name: 'Private registrant', filings: { recent: columns(['F-4/A']) } });
    const result = await lookupRegistrationFilings(input, sec.fetch);
    assert.equal(result.cik, '0000320193');
    assert.equal(result.ticker, '');
    assert.equal(sec.calls.length, 1);
  }
});

test('reads older submissions when recent filings lack registrations, deduplicates and sorts', async () => {
  const older = columns(['F-4/A', 'S-4']);
  const sec = mockSec({ name: 'Apple', filings: { recent: columns(['10-K']), files: [{ name: 'older.json', filingTo: '2026-06-25' }, { name: 'oldest.json', filingTo: '2020-01-01' }] } }, { 'older.json': older });
  const result = await lookupRegistrationFilings('AAPL', sec.fetch, 2);
  assert.deepEqual(result.filings.map(f => f.form), ['F-4/A', 'S-4']);
  assert.equal(sec.calls.length, 3);
});

test('empty results are a successful list; SEC failures and unknown tickers remain errors', async () => {
  const sec = mockSec({ name: 'Apple', filings: { recent: columns(['10-K']) } });
  assert.deepEqual((await lookupRegistrationFilings('AAPL', sec.fetch)).filings, []);
  await assert.rejects(lookupRegistrationFilings('UNKNOWN', sec.fetch), /not found/);
  await assert.rejects(lookupRegistrationFilings('320193', async () => new Response('', { status: 503 })), /Failed to fetch filings/);
});

test('filing rows render required fields as direct links without analysis callbacks', () => {
  const source = readFileSync(new URL('../src/pages/SECScanner.jsx', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true } }).outputText;
  const require = createRequire(import.meta.url);
  const exports = {};
  const guardedRequire = name => {
    if (name === 'lucide-react') return icons;
    if (name === '@/api/apiClient') return new Proxy({}, { get() { throw new Error('Scanner rendering must not call analysis APIs'); } });
    if (name.endsWith('registrationFilings.ts')) return { isRegistrationForm };
    return require(name);
  };
  new Function('require', 'exports', compiled)(guardedRequire, exports);
  const filings = registrationFilings(columns(['S-4/A', 'F-4']), '320193');
  const tree = exports.FilingSelectStep({ ticker: 'AAPL', companyName: 'Apple', cik: '320193', filings, onBack() {} });
  const links = tree.props.children.find(child => child?.props?.className === 'space-y-2').props.children;
  for (const [i, link] of links.entries()) {
    assert.equal(link.type, 'a');
    assert.equal(link.props.href, filings[i].url);
    assert.equal(link.props.target, '_blank');
    assert.equal(link.props.onClick, undefined);
  }
  const html = renderToStaticMarkup(tree);
  for (const filing of filings) for (const field of ['form', 'date', 'accession', 'url']) assert.ok(html.includes(filing[field]), field);
  assert.ok(!html.includes('analyze'));
  const emptyHtml = renderToStaticMarkup(React.createElement(exports.FilingSelectStep, { ticker: '', cik: '320193', filings: [], onBack() {} }));
  assert.ok(emptyHtml.includes('No S/F registration statements found'));
  assert.ok(emptyHtml.includes('CIK 320193'));
});

test('edge lookup returns metadata without downloading documents or XBRL', async () => {
  let handler;
  const originalDeno = globalThis.Deno;
  const originalFetch = globalThis.fetch;
  globalThis.Deno = { serve(callback) { handler = callback; } };
  const sec = mockSec({ name: 'Apple', filings: { recent: columns(['10-K', 'S-4/A', 'F-4']) } });
  globalThis.fetch = sec.fetch;
  try {
    await import('../supabase/functions/fetch-and-analyze-filing/index.ts');
    for (const body of [{ ticker: 'AAPL' }, { cik: '320193' }]) {
      const response = await handler(new Request('http://localhost', { method: 'POST', body: JSON.stringify(body) }));
      assert.equal(response.status, 200);
      const data = await response.json();
      assert.deepEqual(data.filings.map(f => f.form), ['S-4/A', 'F-4']);
      assert.equal(data.content, undefined);
    }
    assert.ok(sec.calls.every(url => url.includes('submissions/') || url.endsWith('company_tickers.json')));
  } finally {
    globalThis.Deno = originalDeno;
    globalThis.fetch = originalFetch;
  }
});
