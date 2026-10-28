const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const ts = require('typescript');
const vm = require('node:vm');
const { webkit, chromium } = require('../../packages/playwright-core');

// Script-level checks use the exact production method bodies. They do not
// launch the iOS WebView implementation, which requires an Apple simulator.
function productionScript(path) {
  const text = fs.readFileSync(path, 'utf8');
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  let body;
  function visit(node) {
    if (ts.isMethodDeclaration(node) && node.name.getText(source) === '_publicKeyCredentialScript')
      body = node.body.getText(source);
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(body, path);
  return vm.runInNewContext(ts.transpile(`(function getScript() ${body})()`, { target: ts.ScriptTarget.ES2022 }));
}

async function snapshot(page) {
  return await page.evaluate(async () => {
    const constructor = window.PublicKeyCredential;
    let construction;
    try { new constructor(); construction = 'succeeded'; } catch (error) { construction = { name: error.name, message: error.message }; }
    let instance;
    try { instance = ({}) instanceof constructor; } catch (error) { instance = { name: error.name, message: error.message }; }
    return {
      kind: typeof constructor,
      supportsWebAuthn: constructor !== undefined && typeof constructor === 'function',
      capabilities: await constructor.getClientCapabilities(),
      conditional: await constructor.isConditionalMediationAvailable(),
      platform: await constructor.isUserVerifyingPlatformAuthenticatorAvailable(),
      construction, instance,
    };
  });
}

(async () => {
  const server = http.createServer((request, response) => response.end('<!doctype html><title>local reproduction</title>'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const records = [];
  try {
    for (const browserType of [webkit, chromium]) {
      const browser = await browserType.launch();
      try {
        console.log(JSON.stringify({ browser: browserType.name(), version: browser.version(), node: process.version, playwright: require('../../packages/playwright-core/package.json').version }));
        for (const mobile of browserType === webkit ? [false, true] : [false]) {
          for (const install of browserType === webkit ? [false, true] : [false]) {
            const context = await browser.newContext({ isMobile: mobile });
            try {
              if (install) await context.credentials.install();
              const page = await context.newPage();
              await page.goto(url);
              const result = await snapshot(page);
              const record = { browser: browserType.name(), mobile, credentialsInstalled: install, result };
              records.push(record);
              console.log(JSON.stringify(record));
              if (browserType === webkit) {
                assert.equal(result.kind, process.env.PHASE === 'baseline' ? 'object' : 'function');
                assert.deepEqual([result.capabilities, result.conditional, result.platform], [{}, install, install]);
              } else {
                assert.equal(result.kind, 'function');
                for (const path of ['packages/playwright-core/src/server/webkit/wkPage.ts', 'packages/playwright-core/src/server/webkit/webview/wvPage.ts']) {
                  const script = productionScript(path);
                  const preserved = await page.evaluate(script => {
                    const native = PublicKeyCredential;
                    const capabilities = native.getClientCapabilities;
                    eval(script);
                    return native === PublicKeyCredential && capabilities === PublicKeyCredential.getClientCapabilities;
                  }, script);
                  assert.equal(preserved, true);
                  const fallback = await page.evaluate(async script => {
                    const native = PublicKeyCredential;
                    try {
                      delete window.PublicKeyCredential;
                      eval(script);
                      return { kind: typeof PublicKeyCredential, capabilities: await PublicKeyCredential.getClientCapabilities(), conditional: await PublicKeyCredential.isConditionalMediationAvailable(), platform: await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable() };
                    } finally { window.PublicKeyCredential = native; }
                  }, script);
                  console.log(JSON.stringify({ scriptOnly: path, preservedNative: preserved, fallback }));
                  assert.equal(fallback.kind, process.env.PHASE === 'baseline' ? 'object' : 'function');
                  assert.deepEqual([fallback.capabilities, fallback.conditional, fallback.platform], [{}, false, false]);
                }
              }
            } finally { await context.close(); }
          }
        }
      } finally { await browser.close(); }
    }
    fs.mkdirSync('evidence', { recursive: true });
    fs.writeFileSync('evidence/browser-behavior.json', JSON.stringify(records, null, 2));
  } finally { await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
