const assert = require('node:assert/strict');
const fs = require('node:fs');
const file = 'tests/mcp/run-code.spec.ts';
fs.mkdirSync('evidence', { recursive: true });
const phase = process.argv[2];
if (phase === 'baseline') {
  const source = fs.readFileSync(file, 'utf8');
  fs.writeFileSync('evidence/original-source.ts', source);
  assert.ok(source.includes('const listenerErrors = await consoleEntries(listenerResponse);'));
  fs.writeFileSync(file, source.replace(
      'const listenerErrors = await consoleEntries(listenerResponse);',
      `console.log('LISTENER_RESPONSE', JSON.stringify(listenerResponse));\n  const listenerErrors = await consoleEntries(listenerResponse);`));
} else if (phase === 'consume') {
  const source = fs.readFileSync('evidence/original-source.ts', 'utf8');
  const before = "page.evaluate(() => fetch('/empty.html')),";
  assert.ok(source.includes(before));
  fs.writeFileSync(file, source.replace(before,
      "page.evaluate(async () => { await (await fetch('/empty.html')).text(); }),"));
} else if (phase === 'delayed') {
  fs.appendFileSync(file, `

test('browser_run_code_unsafe reports delayed listener errors without losing the session', async ({ client, server }) => {
  let release;
  const arrived = new Promise<void>(resolve => {
    server.setRoute('/held-listener-trigger', async (_request, response) => {
      await new Promise<void>(fulfill => { release = fulfill; resolve(); });
      response.end('done');
    });
  });
  try {
    await client.callTool({ name: 'browser_navigate', arguments: { url: server.HELLO_WORLD } });
    const registration = await client.callTool({ name: 'browser_run_code_unsafe', arguments: {
      code: \`async page => {
        page.__listenerFired = false;
        page.on('requestfinished', request => {
          if (!request.url().endsWith('/held-listener-trigger')) return;
          page.__listenerFired = true;
          throw new Error('DELAYED_LISTENER_1803');
        });
        await page.evaluate(() => { void fetch('/held-listener-trigger').then(response => response.text()); });
        return 'registered before release';
      }\`,
    } });
    expect(registration.isError).toBeFalsy();
    expect(JSON.stringify(registration)).toContain('registered before release');
    await arrived;
    release();
    await expect.poll(async () => {
      const result = await client.callTool({ name: 'browser_run_code_unsafe', arguments: { code: 'page => page.__listenerFired' } });
      expect(result.isError).toBeFalsy();
      return parseResponse(result).result;
    }).toBe('true');
    const errors = await client.callTool({ name: 'browser_console_messages', arguments: { level: 'error' } });
    expect(errors.isError).toBeFalsy();
    expect(JSON.stringify(errors)).toContain('DELAYED_LISTENER_1803');
    const followUp = await client.callTool({ name: 'browser_tabs', arguments: { action: 'list' } });
    expect(followUp.isError).toBeFalsy();
    expect(JSON.stringify(followUp)).toContain(server.HELLO_WORLD);
  } finally {
    release?.();
  }
});
`);
} else {
  throw new Error('Unknown phase ' + phase);
}
