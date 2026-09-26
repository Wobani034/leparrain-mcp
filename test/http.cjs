const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const programs = [
  {
    slug: 'qonto', name: 'Qonto', category: 'Banque', description: 'Compte professionnel.',
    has_referral_link: true, referral_link: 'https://example.com/qonto-ref', is_boosted: true,
  },
  {
    slug: 'boursobank', name: 'BoursoBank', category: 'Banque', description: 'Compte bancaire.',
    has_referral_link: true, referral_link: 'https://example.com/boursobank-ref', is_boosted: true,
  },
];

let usagePosts = 0;
const backend = http.createServer((req, res) => {
  let status = 200;
  let body;
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/mcp/me') {
    const token = req.headers.authorization;
    if (token === 'Bearer good') body = { user_id: 'user-1', email: 'test@example.com', email_confirmed: true };
    else if (token === 'Bearer down') { status = 503; body = { error: 'unavailable' }; }
    else { status = 401; body = { error: 'invalid token' }; }
  } else if (url.pathname === '/api/public/programs') {
    const slug = url.searchParams.get('slug');
    body = { programs: slug ? programs.filter((p) => p.slug === slug) : programs };
  } else if (url.pathname === '/api/public/articles') {
    body = { articles: [{ title: 'Comparer les banques', url: 'https://leparrain.com/blog/banques' }] };
  } else if (url.pathname === '/api/mcp/me/links') {
    body = { links: {} };
  } else if (url.pathname === '/api/mcp/usage' && req.method === 'POST') {
    usagePosts++;
    body = { ok: true };
  } else {
    status = 404;
    body = { error: 'not found' };
  }
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
});

async function request(base, method, params, authorization) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  if (authorization) headers.authorization = authorization;
  const response = await fetch(base, {
    method: 'POST', headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) }),
  });
  return { status: response.status, headers: response.headers, body: await response.json() };
}

async function main() {
  backend.listen(0, '127.0.0.1');
  await once(backend, 'listening');
  const apiBase = `http://127.0.0.1:${backend.address().port}`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'leparrain-mcp-http-'));
  const ledgerPath = path.join(tempDir, 'ledger.jsonl');
  const child = spawn(process.execPath, [path.join(__dirname, '../src/http.js')], {
    env: { ...process.env, LP_DATA_MODE: 'api', LP_API_BASE_URL: apiBase, LP_LEDGER_PATH: ledgerPath, PORT: '0' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  let base;
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
    const match = stderr.match(/HTTP prêt sur (http:\/\/127\.0\.0\.1:\d+\/mcp)/);
    if (match) base = match[1];
  });

  try {
    for (let i = 0; !base && i < 100; i++) {
      if (child.exitCode !== null) throw new Error(`MCP exited early: ${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(base, `MCP failed to start: ${stderr}`);

    const init = await request(base, 'initialize', {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'http-test', version: '1' },
    });
    assert.equal(init.status, 200);
    assert.ok(init.body.result?.protocolVersion);

    const anonymous = await request(base, 'tools/list');
    assert.equal(anonymous.status, 200);
    const anonTools = anonymous.body.result.tools.map((tool) => tool.name);
    for (const tool of anonymous.body.result.tools) {
      assert.equal(typeof tool.annotations?.readOnlyHint, 'boolean', `${tool.name} readOnlyHint`);
      assert.equal(typeof tool.annotations?.openWorldHint, 'boolean', `${tool.name} openWorldHint`);
      assert.equal(typeof tool.annotations?.destructiveHint, 'boolean', `${tool.name} destructiveHint`);
      assert.equal(tool.annotations.readOnlyHint, tool.name !== 'search_programs', `${tool.name} logging annotation`);
    }
    for (const tool of ['search_programs', 'get_program', 'get_best_referral', 'compare_programs', 'search_blog']) {
      assert.ok(anonTools.includes(tool), `${tool} must be public`);
    }
    for (const tool of ['suggest_program', 'create_announcement', 'get_my_earnings', 'recommend_contact']) {
      assert.ok(!anonTools.includes(tool), `${tool} must require a user`);
    }

    const calls = [
      ['search_programs', { query: 'banque' }, 'Qonto'],
      ['get_program', { slug: 'qonto' }, 'qonto-ref'],
      ['get_best_referral', { slug: 'qonto' }, 'qonto-ref'],
      ['compare_programs', { slug_a: 'qonto', slug_b: 'boursobank' }, 'BoursoBank'],
      ['search_blog', { query: 'banques' }, 'Comparer les banques'],
    ];
    for (const [name, args, expected] of calls) {
      const result = await request(base, 'tools/call', { name, arguments: args });
      assert.equal(result.status, 200, `${name}: ${JSON.stringify(result.body)}`);
      assert.match(JSON.stringify(result.body), new RegExp(expected), name);
    }
    assert.ok(fs.readFileSync(ledgerPath, 'utf8').trim(), 'search_programs writes placement ledger');
    assert.equal(usagePosts, 0, 'anonymous reads do not POST usage records');
    const protectedCall = await request(base, 'tools/call', { name: 'create_announcement', arguments: {} });
    assert.equal(protectedCall.status, 200);
    assert.ok(protectedCall.body.error || protectedCall.body.result?.isError);

    const connected = await request(base, 'tools/list', undefined, 'Bearer good');
    assert.equal(connected.status, 200);
    const connectedTools = connected.body.result.tools.map((tool) => tool.name);
    for (const tool of connected.body.result.tools) {
      assert.equal(typeof tool.annotations?.readOnlyHint, 'boolean', `${tool.name} readOnlyHint`);
      assert.equal(typeof tool.annotations?.openWorldHint, 'boolean', `${tool.name} openWorldHint`);
      assert.equal(typeof tool.annotations?.destructiveHint, 'boolean', `${tool.name} destructiveHint`);
      assert.equal(tool.annotations.readOnlyHint, false, `${tool.name} may write usage logs`);
    }
    for (const name of ['delete_announcement', 'update_announcement', 'recommend_contact']) {
      const tool = connected.body.result.tools.find((entry) => entry.name === name);
      assert.equal(tool.annotations.destructiveHint, true, `${name} can irreversibly change data`);
    }
    for (const tool of ['create_announcement', 'get_my_earnings']) {
      assert.ok(connectedTools.includes(tool), `${tool} must be available to connected users`);
    }
    assert.ok(!connectedTools.includes('suggest_program'), 'in-memory suggestions must not be exposed');
    const connectedRead = await request(base, 'tools/call', { name: 'get_program', arguments: { slug: 'qonto' } }, 'Bearer good');
    assert.equal(connectedRead.status, 200);
    for (let i = 0; usagePosts === 0 && i < 20; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(usagePosts > 0, 'connected reads POST usage records');

    for (const invalid of ['Bearer bad', 'Basic bad']) {
      const result = await request(base, 'tools/list', undefined, invalid);
      assert.equal(result.status, 401);
      assert.match(result.headers.get('www-authenticate'), /oauth-protected-resource/);
    }
    const unavailable = await request(base, 'tools/list', undefined, 'Bearer down');
    assert.equal(unavailable.status, 503);
    assert.equal(unavailable.headers.get('www-authenticate'), null);
    console.log('  ✓ HTTP MCP: anonymous discovery, protected tools, OAuth challenge, backend outage');
  } finally {
    child.kill('SIGTERM');
    if (child.exitCode === null) await once(child, 'exit');
    backend.close();
    await once(backend, 'close');
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
