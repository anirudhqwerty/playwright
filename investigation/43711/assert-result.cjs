const assert = require('node:assert/strict');
const fs = require('node:fs');
const report = JSON.parse(fs.readFileSync('evidence/webkit.json', 'utf8'));
assert.deepEqual(report.errors, []);
if (process.env.PHASE === 'baseline') {
  assert.equal(Number(process.argv[2]), 1);
  assert.equal(report.stats.unexpected, 2);
  assert.equal(report.stats.expected, 1);
  const failures = [];
  function visit(suite) {
    for (const spec of suite.specs || []) {
      for (const test of spec.tests) {
        if (test.status === 'unexpected')
          failures.push({ title: spec.title, message: test.results[0].error.message.replace(/\u001b\[[0-9;]*m/g, '') });
      }
    }
    for (const child of suite.suites || []) visit(child);
  }
  report.suites.forEach(visit);
  assert.equal(failures.length, 2);
  for (const failure of failures) {
    assert.match(failure.title, /CA-029|CA-030/);
    assert.match(failure.message, /Expected: "function"/);
    assert.match(failure.message, /Received: "object"/);
  }
  console.log('Verified expected baseline failures:', failures);
} else {
  assert.equal(Number(process.argv[2]), 0);
  assert.equal(report.stats.unexpected, 0);
  assert.equal(report.stats.expected, 3);
}
