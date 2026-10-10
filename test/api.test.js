const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const app = require('../src/server');

function get(server, path) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    http
      .get({ port, path }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
      })
      .on('error', reject);
  });
}

test('API endpoints', async (t) => {
  const server = app.listen(0);
  t.after(() => server.close());

  const health = await get(server, '/health');
  assert.strictEqual(health.status, 200);
  assert.strictEqual(health.body.status, 'ok');
  assert.strictEqual(health.body.cloud, 'oci');

  const list = await get(server, '/api/books');
  assert.strictEqual(list.status, 200);
  assert.strictEqual(list.body.count, 3);

  const one = await get(server, '/api/books/1');
  assert.strictEqual(one.body.title, 'Ramayana');

  const missing = await get(server, '/api/books/99');
  assert.strictEqual(missing.status, 404);
});
