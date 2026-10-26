// Test infrastructure, started by Playwright (see playwright.config.ts):
//
//  - Fake Resend API (FAKE_RESEND_PORT): POST /emails, GET /emails/receiving/:id,
//    plus /_test/* controls. /_test/inbound stores a received email and
//    delivers a Svix-signed `email.received` webhook to the backend, exactly
//    like Resend does, so the real webhook code path is exercised.
//  - Network proxy (PROXY_PORT -> BACKEND_PORT): the extension under test
//    talks to the backend through it; /_test/network {down:true} cuts it to
//    simulate going offline (HTTP and WebSocket).
//  - Fixture pages (FIXTURES_PORT): serves tests/fixtures/pages, with
//    per-path version switching (/_test/version) and a strict-CSP route.
//
// It also builds the test extension (API = proxy) before listening.
import { execFileSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import net from 'node:net';
import { dirname, join, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const env = (k, d) => process.env[k] ?? d;
const FAKE_RESEND_PORT = Number(env('FAKE_RESEND_PORT', '18901'));
const FIXTURES_PORT = Number(env('FIXTURES_PORT', '18902'));
const PROXY_PORT = Number(env('PROXY_PORT', '18788'));
const BACKEND_PORT = Number(env('BACKEND_PORT', '18787'));
const WEBHOOK_SECRET = env('WEBHOOK_SECRET', 'whsec_dGVzdC13ZWJob29rLXNlY3JldC0xMjM0NTY3ODkw');
const WEBHOOK_URL = env('WEBHOOK_URL', `http://127.0.0.1:${BACKEND_PORT}/webhooks/resend`);

execFileSync(process.execPath, [join(root, 'scripts/build-extension.mjs'), '--out', 'build/ext-test', '--api', `http://localhost:${PROXY_PORT}`, '--no-zip', '--test-open-shadow'], {
  cwd: root,
  stdio: 'inherit',
});
// The same build with the production (closed) shadow root, for the isolation test.
execFileSync(process.execPath, [join(root, 'scripts/build-extension.mjs'), '--out', 'build/ext-test-closed', '--api', `http://localhost:${PROXY_PORT}`, '--no-zip'], {
  cwd: root,
  stdio: 'inherit',
});

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

// ---------------------------------------------------------------------------
// Fake Resend
// ---------------------------------------------------------------------------

const sent = []; // newest last
const byIdempotencyKey = new Map();
const received = new Map();
let failNext = { count: 0, status: 500, name: 'application_error' };

function sign(id, timestamp, body) {
  const key = Buffer.from(WEBHOOK_SECRET.replace(/^whsec_/, ''), 'base64');
  return createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');
}

async function deliverWebhook(event, { badSignature = false } = {}) {
  const body = JSON.stringify(event);
  const id = `msg_${randomUUID()}`;
  const ts = Math.floor(Date.now() / 1000);
  const signature = badSignature ? 'v1,AAAA' : `v1,${sign(id, ts, body)}`;
  const res = await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'svix-id': id, 'svix-timestamp': String(ts), 'svix-signature': signature },
    body,
  });
  return { status: res.status, body: await res.text() };
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${FAKE_RESEND_PORT}`);
    if (req.method === 'POST' && url.pathname === '/emails') {
      if (!/^Bearer re_/.test(req.headers.authorization ?? '')) return json(res, 401, { statusCode: 401, name: 'validation_error', message: 'API key is invalid' });
      if (!req.headers['user-agent']) return json(res, 403, { name: 'error_1010' });
      if (failNext.count > 0) {
        failNext.count--;
        return json(res, failNext.status, { statusCode: failNext.status, name: failNext.name, message: 'injected failure' }, failNext.status === 429 ? { 'retry-after': '1' } : {});
      }
      const body = JSON.parse(await readBody(req));
      for (const f of ['from', 'to', 'subject']) {
        if (!body[f]) return json(res, 422, { statusCode: 422, name: 'missing_required_field', message: `Missing \`${f}\` field.` });
      }
      const key = req.headers['idempotency-key'];
      if (key && byIdempotencyKey.has(key)) return json(res, 200, { id: byIdempotencyKey.get(key) });
      const id = randomUUID();
      if (key) byIdempotencyKey.set(key, id);
      sent.push({ id, ...body, idempotencyKey: key ?? null, created_at: new Date().toISOString() });
      return json(res, 200, { id });
    }
    const m = /^\/emails\/receiving\/([^/]+)$/.exec(url.pathname);
    if (req.method === 'GET' && m) {
      const email = received.get(decodeURIComponent(m[1]));
      if (!email) return json(res, 404, { statusCode: 404, name: 'not_found', message: 'Email not found' });
      return json(res, 200, email);
    }
    if (url.pathname === '/_test/sent') {
      const to = url.searchParams.get('to');
      const list = sent.filter(e => !to || [].concat(e.to).includes(to)).slice().reverse();
      return json(res, 200, list);
    }
    if (url.pathname === '/_test/reset') {
      sent.length = 0;
      received.clear();
      byIdempotencyKey.clear();
      failNext = { count: 0, status: 500, name: 'application_error' };
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/_test/fail' && req.method === 'POST') {
      const b = JSON.parse(await readBody(req));
      failNext = { count: b.count ?? 1, status: b.status ?? 500, name: b.name ?? 'application_error' };
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/_test/inbound' && req.method === 'POST') {
      // Body: { from, fromName?, to: [..], cc?, subject, text?, html?, headers?, authentication?, badSignature? }
      const b = JSON.parse(await readBody(req));
      const id = randomUUID();
      const created = new Date().toISOString();
      const fromHeader = b.fromName ? `${b.fromName} <${b.from}>` : b.from;
      received.set(id, {
        object: 'email',
        id,
        to: b.to,
        from: b.from,
        created_at: created,
        subject: b.subject ?? '',
        html: b.html ?? null,
        html_format: 'data_uri',
        text: b.text ?? null,
        headers: { from: fromHeader, 'mime-version': '1.0', ...(b.headers ?? {}) },
        bcc: [],
        cc: b.cc ?? [],
        reply_to: [],
        received_for: b.receivedFor ?? b.to,
        authentication: b.authentication === undefined ? { spf: 'pass', dkim: 'pass', dmarc: 'pass' } : b.authentication,
        message_id: `<${id}@mail.example>`,
        raw: null,
        attachments: [],
      });
      const event = {
        type: 'email.received',
        created_at: created,
        data: {
          email_id: id,
          created_at: created,
          from: b.from,
          to: b.to,
          bcc: [],
          cc: b.cc ?? [],
          received_for: b.receivedFor ?? b.to,
          message_id: `<${id}@mail.example>`,
          subject: b.subject ?? '',
          attachments: [],
        },
      };
      const delivery = await deliverWebhook(event, { badSignature: !!b.badSignature });
      // Resend redelivers until it gets a 2xx; mimic that for 5xx answers.
      let attempts = 1;
      let last = delivery;
      while (last.status >= 500 && attempts < 4) {
        await new Promise(r => setTimeout(r, 300));
        last = await deliverWebhook(event);
        attempts++;
      }
      if (b.redeliver) last = await deliverWebhook(event); // duplicate delivery
      return json(res, 200, { email_id: id, webhookStatus: last.status, webhookBody: last.body, attempts });
    }
    json(res, 404, { statusCode: 404, name: 'not_found' });
  } catch (err) {
    json(res, 500, { error: String(err) });
  }
}).listen(FAKE_RESEND_PORT, () => console.log(`fake resend on ${FAKE_RESEND_PORT}`));

// ---------------------------------------------------------------------------
// Network proxy with an off switch
// ---------------------------------------------------------------------------

let networkDown = false;
const live = new Set();
net
  .createServer(client => {
    if (networkDown) {
      client.destroy();
      return;
    }
    const upstream = net.connect(BACKEND_PORT, '127.0.0.1');
    live.add(client);
    live.add(upstream);
    client.pipe(upstream);
    upstream.pipe(client);
    const done = () => {
      client.destroy();
      upstream.destroy();
      live.delete(client);
      live.delete(upstream);
    };
    client.on('error', done);
    upstream.on('error', done);
    client.on('close', done);
    upstream.on('close', done);
  })
  .listen(PROXY_PORT, () => console.log(`proxy ${PROXY_PORT} -> ${BACKEND_PORT}`));

// ---------------------------------------------------------------------------
// Fixture pages
// ---------------------------------------------------------------------------

const pagesDir = join(root, 'tests/fixtures/pages');
const versions = new Map(); // path -> file
const STRICT_CSP = "default-src 'none'; style-src 'self'; script-src 'none'; img-src 'none'; font-src 'none'; connect-src 'none'; frame-src 'none'";
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript' };

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${FIXTURES_PORT}`);
  if (url.pathname === '/_test/version' && req.method === 'POST') {
    const b = JSON.parse(await readBody(req));
    if (b.file) versions.set(b.path, b.file);
    else versions.delete(b.path);
    return json(res, 200, { ok: true });
  }
  if (url.pathname === '/_test/network' && req.method === 'POST') {
    const b = JSON.parse(await readBody(req));
    networkDown = !!b.down;
    if (networkDown) for (const s of live) s.destroy();
    return json(res, 200, { ok: true, down: networkDown });
  }
  if (url.pathname === '/favicon.ico') {
    res.writeHead(204);
    return res.end();
  }
  // /u/<id>/<file>: the same fixture under a unique URL (and canonical), so
  // every test gets its own page and its own threads.
  const unique = /^\/(?:csp\/|sandbox\/)?u\/[\w-]+\/(.+)$/.exec(url.pathname);
  let file = versions.get(url.pathname) ?? (unique ? unique[1] : url.pathname.replace(/^\/(csp\/|sandbox\/)?/, ''));
  if (!file || file.endsWith('/')) file += 'index.html';
  if (!extname(file)) file += '.html';
  const full = resolve(pagesDir, file);
  if (!full.startsWith(pagesDir) || !existsSync(full)) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    return res.end('not found');
  }
  const headers = { 'content-type': TYPES[extname(full)] ?? 'application/octet-stream', 'cache-control': 'no-store' };
  if (url.pathname.startsWith('/csp/')) headers['content-security-policy'] = STRICT_CSP;
  // A sandboxed document (opaque origin) that still runs its own scripts, the
  // harder case (raw.githubusercontent.com uses `sandbox` without scripts).
  if (url.pathname.startsWith('/sandbox/')) headers['content-security-policy'] = "style-src 'unsafe-inline'; sandbox allow-scripts";
  res.writeHead(200, headers);
  let content = readFileSync(full);
  if (unique && extname(full) === '.html') {
    content = Buffer.from(
      content.toString('utf8').replace(/<link rel="canonical" href="[^"]*">/, `<link rel="canonical" href="http://localhost:${FIXTURES_PORT}${url.pathname}">`),
    );
  }
  res.end(content);
}).listen(FIXTURES_PORT, () => console.log(`fixtures on ${FIXTURES_PORT}`));
