import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(path.join(process.cwd(), 'package.json'));
const self = fileURLToPath(import.meta.url);
const marker = 'MCP_LISTENER_SYNC_1803';
const deadline = (promise, ms = 20000) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Evidence deadline exceeded')), ms);
  })]).finally(() => clearTimeout(timer));
};

if (process.argv[2] === '--mcp-child') {
  const child = spawn(process.execPath, [path.resolve('packages/playwright-core/lib/entry/mcp.js'), '--headless', '--browser=chromium', '--isolated'], { stdio: 'inherit' });
  child.on('exit', (code, signal) => {
    console.error('CHILD_EXIT ' + JSON.stringify({ code, signal }));
    process.exit(code ?? 1);
  });
} else if (process.argv[2] === '--standalone-child') {
  const { chromium } = require('./packages/playwright-core');
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(process.argv[3]);
  page.on('requestfinished', () => {
    console.error('STANDALONE_EVENT_FIRED');
    throw new TypeError(marker);
  });
  await page.goto(process.argv[3] + '/standalone-trigger');
} else {
  fs.mkdirSync('evidence', { recursive: true });
  const { Client } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/index.js')));
  const { StdioClientTransport } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/stdio.js')));
  let release;
  let arrived;
  const held = new Promise(resolve => arrived = resolve);
  const server = http.createServer(async (request, response) => {
    if (request.url === '/listener-trigger') {
      await new Promise(resolve => { release = resolve; arrived(); });
    }
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<title>Local evidence</title><h1>probe</h1>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const result = {
    node: process.version,
    playwright: require('./packages/playwright-core/package.json').version,
    mcp: require('./packages/playwright-core/package.json').version + ' (monorepo MCP entry)',
    sdk: JSON.parse(fs.readFileSync(path.resolve('node_modules/@modelcontextprotocol/sdk/package.json'), 'utf8')).version,
    upstream: process.env.UPSTREAM_SHA,
    source: process.env.SOURCE_SHA,
  };
  const child = spawn(process.execPath, [self, '--standalone-child', url], { stdio: ['ignore', 'pipe', 'pipe'] });
  let standaloneStderr = '';
  child.stderr.on('data', data => standaloneStderr += data);
  result.standalone = await deadline(new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal }))));
  result.standalone.eventFired = standaloneStderr.includes('STANDALONE_EVENT_FIRED');
  fs.writeFileSync('evidence/standalone-stderr.log', standaloneStderr);
  assert.equal(result.standalone.code, 1);
  assert.equal(result.standalone.eventFired, true);
  assert.match(standaloneStderr, /MCP_LISTENER_SYNC_1803/);

  const transport = new StdioClientTransport({ command: process.execPath, args: [self, '--mcp-child'], stderr: 'pipe' });
  let stderr = '';
  let exited;
  const exit = new Promise(resolve => exited = resolve);
  transport.stderr.on('data', data => {
    stderr += data;
    if (stderr.includes('CHILD_EXIT ')) exited();
  });
  const client = new Client({ name: 'issue-1803-evidence', version: '1.0.0' });
  try {
    await deadline(client.connect(transport));
    await deadline(client.callTool({ name: 'browser_navigate', arguments: { url } }));
    const registration = await deadline(client.callTool({ name: 'browser_run_code_unsafe', arguments: { code: `async page => {
      page.__listenerEvents = [];
      page.on('requestfinished', request => {
        page.__listenerEvents.push(request.url());
        if (!request.url().endsWith('/listener-trigger')) return;
        throw new TypeError('${marker}');
      });
      await page.evaluate(() => { void fetch('/listener-trigger').then(response => response.text()); });
      return 'registered';
    }` } }));
    assert.equal(!!registration.isError, false);
    assert.match(JSON.stringify(registration), /registered/);
    result.registrationCompleted = true;
    await deadline(held);
    result.triggerReleasedAfterRegistration = true;
    release();
    const outcome = await Promise.race([exit.then(() => 'exit'), new Promise(resolve => setTimeout(() => resolve('diagnose'), 3000))]);
    if (outcome === 'diagnose') {
      try {
        result.diagnostics = await deadline(client.callTool({ name: 'browser_run_code_unsafe', arguments: { code: `async page => ({ events: page.__listenerEvents, count: page.listenerCount('requestfinished'), url: page.url() })` } }));
      } catch (error) {
        result.diagnosticError = String(error);
      }
    }
    await deadline(exit, 5000);
    result.eventFired = stderr.includes(marker);
    result.childExit = JSON.parse(stderr.match(/CHILD_EXIT (\{[^\n]+\})/)[1]);
    try {
      await deadline(client.callTool({ name: 'browser_tabs', arguments: { action: 'list' } }));
      result.followUpSucceeded = true;
    } catch (error) {
      result.followUpSucceeded = false;
      result.followUpError = String(error);
    }
    assert.equal(result.childExit.code, 1);
    assert.equal(result.eventFired, true);
    assert.equal(result.followUpSucceeded, false);
    assert.match(stderr, /_callHandler|Connection.dispatch/);
  } finally {
    fs.writeFileSync('evidence/mcp-stderr.log', stderr);
    fs.writeFileSync('evidence/baseline.json', JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
    release?.();
    await client.close();
    server.closeAllConnections();
    server.close();
  }
}
