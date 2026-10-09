const { test } = require('node:test');
const assert = require('node:assert');
const { loadSecrets } = require('../src/secrets');

test('uses plain env vars when SECRETS_PROVIDER is not oci-vault', async () => {
  delete process.env.SECRETS_PROVIDER;
  assert.strictEqual(await loadSecrets(), 'env');
});

test('requires vault settings when SECRETS_PROVIDER=oci-vault', async () => {
  process.env.SECRETS_PROVIDER = 'oci-vault';
  delete process.env.OCI_VAULT_ID;
  delete process.env.OCI_SECRET_NAME;
  await assert.rejects(loadSecrets(), /OCI_VAULT_ID and OCI_SECRET_NAME are required/);
  delete process.env.SECRETS_PROVIDER;
});
