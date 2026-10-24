const test = require('node:test');
const assert = require('node:assert');
const { isPrivateAddress, checkTarget, htmlToText } = require('../src/webFetch');

test('private, loopback and metadata addresses are refused', async () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.1', '172.20.0.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:127.0.0.1', '0.0.0.0']) {
    assert.strictEqual(isPrivateAddress(ip), true, ip);
  }
  assert.strictEqual(isPrivateAddress('93.184.216.34'), false);
  await assert.rejects(checkTarget('http://127.0.0.1:11434/api/tags'), /private network/);
  await assert.rejects(checkTarget('http://[::1]/'), /private network/);
  await assert.rejects(checkTarget('file:///etc/passwd'), /Only http/);
  await assert.rejects(checkTarget('http://user:pw@example.com/'), /user name/);
});

test('HTML becomes readable text without scripts and styles', () => {
  const text = htmlToText('<html><head><title>x</title></head><body><script>evil()</script><h1>Title</h1><p>A &amp; B</p><style>.a{}</style></body></html>');
  assert.strictEqual(text, 'Title\n A & B');
});
