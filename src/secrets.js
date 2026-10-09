// Loads app secrets from OCI Vault (replacement for AWS Secrets Manager).
//
// AWS equivalent being replaced:
//   const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
//   const res = await client.send(new GetSecretValueCommand({ SecretId: 'my-app/prod' }));
//   const values = JSON.parse(res.SecretString);
//
// The secret is stored the same way as on AWS: one secret holding a JSON
// object of key/value pairs, e.g. {"DB_PASSWORD":"...","API_KEY":"..."}.
// Auth uses Instance Principals (the OCI equivalent of an EC2 instance role),
// so no credentials live on the server.

async function loadSecrets() {
  if (process.env.SECRETS_PROVIDER !== 'oci-vault') {
    return 'env';
  }

  const { OCI_VAULT_ID, OCI_SECRET_NAME } = process.env;
  if (!OCI_VAULT_ID || !OCI_SECRET_NAME) {
    throw new Error('OCI_VAULT_ID and OCI_SECRET_NAME are required when SECRETS_PROVIDER=oci-vault');
  }

  const common = require('oci-common');
  const { SecretsClient } = require('oci-secrets');

  const provider = await new common.InstancePrincipalsAuthenticationDetailsProviderBuilder().build();
  const client = new SecretsClient({ authenticationDetailsProvider: provider });

  const { secretBundle } = await client.getSecretBundleByName({
    secretName: OCI_SECRET_NAME,
    vaultId: OCI_VAULT_ID,
  });
  const raw = Buffer.from(secretBundle.secretBundleContent.content, 'base64').toString('utf8');
  const values = JSON.parse(raw);

  // Explicit env vars win, so a single value can still be overridden locally
  for (const [key, value] of Object.entries(values)) {
    if (process.env[key] === undefined) {
      process.env[key] = String(value);
    }
  }
  return 'oci-vault';
}

module.exports = { loadSecrets };
