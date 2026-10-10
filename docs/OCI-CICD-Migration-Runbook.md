# AWS → OCI Migration: Node.js CI/CD Pipeline on OCI DevOps

**Technical runbook: Step 0 to Step 34**

| Item | Value |
|---|---|
| Application | `oci-node-app` (Node.js 20 / Express REST API) |
| Source platform | AWS: EC2, CodeStar (CodeCommit/CodeBuild/CodeDeploy/CodePipeline), Secrets Manager |
| Target platform | OCI: Compute, DevOps (Build + Deploy pipelines, Triggers), Artifact Registry, Vault |
| Source repository | `https://github.com/krunl86/oci-node-app` (private, branch `main`) |
| OCI region | India West (Mumbai), `ap-mumbai-1` (single availability domain) |
| OCI account type | Free Trial |
| Executed | 2026-10-09 → 2026-10-10 |
| Final state | Push to `main` → build → test → package → deliver → deploy → health check, fully automatic (≈9 min) |

---

## Table of contents

- [1. Architecture](#1-architecture)
- [2. AWS → OCI service mapping](#2-aws--oci-service-mapping)
- [3. Resource inventory (as built)](#3-resource-inventory-as-built)
- [4. Repository layout](#4-repository-layout)
- [Step 0: Code review, application changes, local setup](#step-0--code-review-application-changes-local-setup)
- [Phase 1: Foundation (Steps 1–7)](#phase-1--foundation-steps-17)
- [Phase 2: CI: build pipeline (Steps 8–20)](#phase-2--ci-build-pipeline-steps-820)
- [Phase 3: Deploy target: network and Compute (Steps 21–24)](#phase-3--deploy-target-network-and-compute-steps-2124)
- [Phase 4: CD: deploy pipeline and automation (Steps 25–34)](#phase-4--cd-deploy-pipeline-and-automation-steps-2534)
- [Appendix A: Final source files (complete)](#appendix-a--final-source-files-complete)
- [Appendix B: Git commit history](#appendix-b--git-commit-history)
- [Appendix C: Issues encountered and fixes](#appendix-c--issues-encountered-and-fixes)
- [Appendix D: Operations cheat sheet](#appendix-d--operations-cheat-sheet)
- [Appendix E: Production hardening checklist](#appendix-e--production-hardening-checklist)
- [Appendix F: Cost notes](#appendix-f--cost-notes)
- [Appendix G: Teardown](#appendix-g--teardown)

---

## 1. Architecture

```
 Developer
    │  git push origin main
    ▼
 GitHub (krunl86/oci-node-app, private)
    │  webhook (push event, application/json, shared secret)
    ▼
 OCI DevOps Trigger: github-push-main
    │
    ▼
 Build pipeline: oci-node-app-build
   ├─ Stage 1  build           Managed Build, build_spec.yaml
   │                           nvm/Node 20 → npm ci → npm test → npm prune → zip
   │                           exports BUILDRUN_HASH (7-char build id)
   ├─ Stage 2  deliver         Deliver artifacts → Artifact Registry (version = BUILDRUN_HASH)
   │                             app_zip     → DevOps artifact app-zip     (app.zip)
   │                             deploy_spec → DevOps artifact deploy-spec (deploy_spec.yaml)
   └─ Stage 3  trigger-deploy  Trigger deployment (sends BUILDRUN_HASH)
                                   │
                                   ▼
 Deploy pipeline: oci-node-app-deploy   params: BUILDRUN_HASH, VAULT_ID, SECRET_NAME
   └─ Stage    deploy-vm       Instance group rolling deployment → environment oci-node-app-vm-env
                                   │  Oracle Cloud Agent, "Compute Instance Run Command" plugin
                                   ▼
 Compute instance oci-node-app-vm-1 (Oracle Linux 8, VM.Standard.E2.1.Micro, public subnet)
   deploy_spec.yaml steps:
     1 Unpack release           /opt/oci-node-app/releases/<hash>
     2 Write runtime config     /etc/oci-node-app/app.env (non-secret)
     3 Switch release, restart  current → releases/<hash>; systemctl restart oci-node-app
     4 Health check             GET /health must return version=<hash>, else roll back
   Runtime:
     systemd unit oci-node-app → node src/server.js (user nodeapp, port 3000)
     On startup: Instance Principal → OCI Vault → secret oci-node-app-secrets (JSON) → process.env
```

## 2. AWS → OCI service mapping

| AWS (current) | OCI (target) | Implemented by |
|---|---|---|
| CodeStar project | DevOps Project `oci-node-app` | Console (Step 8) |
| CodeCommit / GitHub source | GitHub via DevOps **External connection** `github-connection` | Steps 10–13 |
| CodePipeline source trigger | DevOps **Trigger** `github-push-main` + GitHub webhook | Steps 33–34 |
| CodeBuild + `buildspec.yml` | Build pipeline, **Managed Build** stage + `build_spec.yaml` | Steps 17–18 |
| S3 artifact bucket | **Artifact Registry** repo `oci-node-app-artifacts` | Steps 14–16, 19 |
| CodeDeploy + `appspec.yml` | Deploy pipeline, **Instance Group** stage + `deployment/deploy_spec.yaml` | Steps 25–27 |
| CodeDeploy agent | Oracle Cloud Agent, **Compute Instance Run Command** plugin | Step 24 |
| CodePipeline build→deploy glue | **Trigger deployment** stage | Step 28 |
| EC2 instance | **Compute** instance `oci-node-app-vm-1` | Step 23 |
| EC2 user-data | **cloud-init** script `infra/cloud-init.sh` | Step 23 |
| EC2 instance profile / IAM role | **Dynamic group** + **policy** (Instance Principals) | Steps 1–3 |
| CodeStar/CodePipeline service roles | Dynamic group `devops-dg` + policy | Steps 1, 3, 30 |
| Secrets Manager | **OCI Vault** + secret `oci-node-app-secrets` | Steps 4–6 + `src/secrets.js` |
| SNS (pipeline notifications) | **Notifications** topic `oci-node-app-topic` | Step 7 |
| CloudWatch Logs (build/deploy logs) | **Logging**: log group `oci-node-app-logs`, log `Project_all` | Step 9 |
| VPC / subnet / IGW / SG | **VCN** `oci-node-app-vcn`, public subnet, IGW, security list | Steps 21–22 |

## 3. Resource inventory (as built)

| Resource | Name | Identifier / value |
|---|---|---|
| Tenancy | `krunalgadgetguru` | Object Storage namespace `bmvuadcsr74u` |
| Compartment | `oci-node-app-demo` | `ocid1.compartment.oc1..aaaaaaaaznj4z6zgc4b5eduycp75tjxui6xuemokef7h6hl2ael37qguedkq` |
| Dynamic group | `devops-dg` | Default identity domain |
| Dynamic group | `app-instances-dg` | Default identity domain |
| Policy (root compartment) | `oci-node-app-policy` | 14 statements (Step 3 + Step 30) |
| Vault | `oci-node-app-vault` | `ocid1.vault.oc1.ap-mumbai-1.fbvmsmczaagaq.abrg6ljrzlnodjnuqdxhmcnk7rniqo4g5dypo67a3t3zsulqsoskmtq4s4oq` |
| Master encryption key | `oci-node-app-key` | Software-protected, AES-256 |
| Secret | `oci-node-app-secrets` | Plain-text JSON `{"API_KEY":"demo-123"}` |
| Secret | `github-pat` | GitHub classic PAT (scopes `repo`, `read:user`) |
| Notification topic | `oci-node-app-topic` | `ocid1.onstopic.oc1.ap-mumbai-1.amaaaaaa5djkejiawqvv5pfj6j5l6lhsbll5wvmdnx7utrtbwdmkscjkv3ua` |
| DevOps project | `oci-node-app` | `ocid1.devopsproject.oc1.ap-mumbai-1.amaaaaaa5djkejiavrdwihpqgv7njyoxvpwotsrkod2z6rsriryj4a7ho7ba` |
| Log group / log | `oci-node-app-logs` / `Project_all` | Retention 1 month |
| External connection | `github-connection` | Type GitHub, secret `github-pat` |
| Artifact Registry repo | `oci-node-app-artifacts` | Mutable |
| DevOps artifact | `app-zip` | General artifact, path `app.zip`, version `${BUILDRUN_HASH}` |
| DevOps artifact | `deploy-spec` | Instance group deployment configuration, path `deploy_spec.yaml`, version `${BUILDRUN_HASH}` |
| Build pipeline | `oci-node-app-build` | Stages `build` → `deliver` → `trigger-deploy` |
| VCN | `oci-node-app-vcn` | `10.0.0.0/16`, DNS label `ocinodeappvcn` |
| Public subnet | `public subnet-oci-node-app-vcn` | `10.0.0.0/24` |
| Private subnet | `private subnet-oci-node-app-vcn` | `10.0.1.0/24` (unused) |
| Gateways | Internet / NAT / Service gateway | Created by the VCN wizard |
| Security list rule | default security list | Ingress TCP 3000 from `0.0.0.0/0` |
| Compute instance | `oci-node-app-vm-1` | OL8, `VM.Standard.E2.1.Micro`, AD-1, FD-1, public IP `80.225.250.143`, user `opc` |
| Instance OCID | | `ocid1.instance.oc1.ap-mumbai-1.anrg6ljr5djkejiciaduixzgxl4omwh3rxjsu55blesc6w6bmagvew67dpea` |
| SSH key pair | `oci-node-app.key` | `~/.ssh/oci-node-app.key` (+ `.pub`) on the admin Mac |
| Environment | `oci-node-app-vm-env` | Instance group (static list: `oci-node-app-vm-1`) |
| Deploy pipeline | `oci-node-app-deploy` | Stage `deploy-vm` |
| Trigger | `github-push-main` | GitHub, Push, branch `main` → `oci-node-app-build` |
| App URL | | `http://80.225.250.143:3000/health` |

## 4. Repository layout

```
oci-node-app/
├── .dockerignore
├── .env.example                  # local dev config template (SECRETS_PROVIDER=env)
├── .gitignore
├── Dockerfile                    # kept for a future OKE / Container Instances move
├── README.md
├── build_spec.yaml               # OCI DevOps build spec (replaces buildspec.yml)
├── deployment/
│   └── deploy_spec.yaml          # OCI instance-group deployment spec (replaces appspec.yml)
├── docs/
│   └── OCI-CICD-Migration-Runbook.md   # this document
├── infra/
│   ├── cloud-init.sh             # Compute bootstrap (replaces EC2 user-data)
│   └── iam-policies.txt          # dynamic groups + policy statements
├── package.json
├── package-lock.json
├── src/
│   ├── secrets.js                # OCI Vault loader (replaces Secrets Manager client)
│   └── server.js                 # Express API
└── test/
    ├── api.test.js
    └── secrets.test.js
```

---

## Step 0: Code review, application changes, local setup

### 0.1 Starting point (as received)

The project contained `Dockerfile`, `README.md`, `.dockerignore`, `.gitignore`, `package.json`, `package-lock.json`, `build_spec.yaml`, `.env.example`, `src/server.js`, `test/api.test.js`. It was **not** a git repository.

Commands used to inspect it:

```bash
cd /Users/krunalprajapati/Downloads/oci-node-app
find . -type f -not -path './node_modules/*' -not -path './.git/*' | head -100
for f in package.json Dockerfile .dockerignore .gitignore build_spec.yaml .env.example src/server.js test/api.test.js README.md; do echo "===== $f"; cat "$f"; done
```

**Review findings**

| # | Finding | Impact |
|---|---|---|
| 1 | Pipeline was **build-only**: no deploy stage | Nothing reached a server |
| 2 | No secrets handling | No replacement for AWS Secrets Manager |
| 3 | README told users to set the OCIR artifact path to `oci-node-app:${BUILDRUN_HASH}` | Wrong: OCIR needs `<region-key>.ocir.io/<namespace>/<repo>:<tag>` |
| 4 | IAM policy example incomplete (only `repos` + `generic-artifacts`) | Build/deploy runs would fail authorization |
| 5 | Docker image built in the pipeline but never used | Wasted build time for an EC2→Compute migration |

**Original `build_spec.yaml` (before changes)**

```yaml
version: 0.1
component: build
timeoutInSeconds: 900
runAs: root
shell: bash

env:
  variables:
    NODE_VERSION: "20"
  exportedVariables:
    - BUILDRUN_HASH

steps:
  - type: Command
    name: "Set up Node.js"
    timeoutInSeconds: 300
    command: |
      # Build runners ship with nvm; fall back to installing it if missing
      export NVM_DIR="$HOME/.nvm"
      if [ ! -s "$NVM_DIR/nvm.sh" ]; then
        curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
      fi
      source "$NVM_DIR/nvm.sh"
      nvm install ${NODE_VERSION}
      nvm use ${NODE_VERSION}
      node -v && npm -v

  - type: Command
    name: "Install dependencies"
    timeoutInSeconds: 300
    command: |
      source "$HOME/.nvm/nvm.sh"
      nvm use ${NODE_VERSION}
      npm ci

  - type: Command
    name: "Run tests"
    timeoutInSeconds: 300
    command: |
      source "$HOME/.nvm/nvm.sh"
      nvm use ${NODE_VERSION}
      npm test

  - type: Command
    name: "Package application"
    timeoutInSeconds: 300
    onFailure:
      - type: Command
        command: echo "Packaging failed"
        timeoutInSeconds: 60
    command: |
      export BUILDRUN_HASH=$(echo ${OCI_BUILD_RUN_ID} | rev | cut -c 1-7)
      echo "Build hash: ${BUILDRUN_HASH}"
      source "$HOME/.nvm/nvm.sh"
      nvm use ${NODE_VERSION}
      npm prune --omit=dev
      zip -r app.zip src package.json package-lock.json node_modules

  - type: Command
    name: "Build Docker image"
    timeoutInSeconds: 600
    command: |
      docker build -t oci-node-app:${BUILDRUN_HASH} .

outputArtifacts:
  - name: app_zip
    type: BINARY
    location: ${OCI_PRIMARY_SOURCE_DIR}/app.zip

  - name: app_image
    type: DOCKER_IMAGE
    location: oci-node-app:${BUILDRUN_HASH}
```

### 0.2 Design decisions

| Decision | Rationale |
|---|---|
| Target **Compute instance group** deployment (not OKE / containers) | Closest lift-and-shift for EC2 + CodeDeploy |
| Deploy a **zip + systemd**, drop the Docker build step | Image was unused; Dockerfile kept for a later container move |
| Secrets read by the **app at startup** via **Instance Principals** | No secrets on disk or in pipeline logs; same JSON-secret shape as AWS |
| **Release directories + `current` symlink** | Atomic switch and instant rollback |
| Deploy spec published **as a build artifact** (not inline in the console) | Spec stays versioned with the code |

### 0.3 Tooling check and new dependencies

```bash
node -v        # v24.11.1 (local dev machine)
npm -v         # 11.6.2
npm view oci-secrets version
npm view oci-common version     # 2.142.2

npm install oci-secrets@^2 oci-common@^2
npm test
```

`package.json` dependencies after the change:

```json
"dependencies": {
  "cors": "^2.8.5",
  "dotenv": "^16.4.5",
  "express": "^4.19.2",
  "helmet": "^7.1.0",
  "morgan": "^1.10.0",
  "oci-common": "^2.142.2",
  "oci-secrets": "^2.142.2"
}
```

### 0.4 New file: `src/secrets.js` (Secrets Manager → OCI Vault)

```js
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
```

**Migration pattern for the real application:** replace every `GetSecretValueCommand` call with `loadSecrets()` at startup; the rest of the code keeps reading `process.env.X`.

### 0.5 Changes to `src/server.js`

**a) Imports, version and secrets source** (the version is read from a `VERSION` file the build bakes into each zip, so `/health` reports the *running* release, even after a rollback):

```diff
 require('dotenv').config();

+const fs = require('node:fs');
+const path = require('node:path');
 const express = require('express');
 const cors = require('cors');
 const helmet = require('helmet');
 const morgan = require('morgan');
+const { loadSecrets } = require('./secrets');

 const app = express();
 const PORT = process.env.PORT || 3000;
+// VERSION is written into each release zip by the build pipeline
+const versionFile = path.join(__dirname, '..', 'VERSION');
+const APP_VERSION = fs.existsSync(versionFile) ? fs.readFileSync(versionFile, 'utf8').trim() : 'local';
+let secretsSource = 'env';
```

**b) Health payload** (`cloud` was added in Step 34 as the end-to-end trigger test):

```diff
 app.get('/health', (req, res) => {
   res.json({
     status: 'ok',
+    cloud: 'oci',
+    version: APP_VERSION,
+    secretsSource,
     uptimeSeconds: Math.round(process.uptime()),
     timestamp: new Date().toISOString(),
   });
 });
```

**c) Async startup with secrets + graceful shutdown for systemd restarts:**

```diff
-if (require.main === module) {
-  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
-}
+async function start() {
+  secretsSource = await loadSecrets();
+  const server = app.listen(PORT, () =>
+    console.log(`Server ${APP_VERSION} running on port ${PORT} (secrets: ${secretsSource})`)
+  );
+  // systemd sends SIGTERM on stop/restart during a deployment
+  process.on('SIGTERM', () => server.close(() => process.exit(0)));
+}
+
+if (require.main === module) {
+  start().catch((err) => {
+    console.error('Failed to start:', err);
+    process.exit(1);
+  });
+}
```

### 0.6 `.env.example`

```diff
 PORT=3000
+
+# Local dev reads secrets from this file. On OCI Compute set
+# SECRETS_PROVIDER=oci-vault and the app pulls them from OCI Vault instead.
+SECRETS_PROVIDER=env
+# OCI_VAULT_ID=ocid1.vault.oc1..xxxx
+# OCI_SECRET_NAME=oci-node-app-secrets
```

### 0.7 New test: `test/secrets.test.js`

```js
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
```

### 0.8 `build_spec.yaml` changes

| Change | Why |
|---|---|
| New first step **"Set build version"** computes `BUILDRUN_HASH` | Every later step and the exported variable see it |
| `echo "${BUILDRUN_HASH}" > VERSION` and `VERSION` added to the zip | App reports its release on `/health` |
| `zip -qr` + `ls -lh app.zip` | Quieter logs, size visible |
| Removed **"Build Docker image"** step and `app_image` output | Unused for the Compute target |
| New output **`deploy_spec`** → `deployment/deploy_spec.yaml` | Deploy spec is versioned with each build |

The final file is in [Appendix A.5](#a5-build_specyaml).

### 0.9 New file: `deployment/deploy_spec.yaml` (initial version)

The initial version used `${APP_ROOT}`-style references and a plain multi-line script per step. It was corrected three times during the exercise (Steps 26, 29, 31). The **final working version** is in [Appendix A.6](#a6-deploymentdeploy_specyaml); the evolution is documented at those steps.

### 0.10 New file: `infra/cloud-init.sh` (initial version)

The initial version installed Node.js with `dnf`:

```bash
# Node.js 20 runtime + tools used by the deployment spec
dnf module reset -y nodejs
dnf module enable -y nodejs:20
dnf install -y nodejs unzip curl
```

This failed on the 1 GB shape (Step 23/24) and was replaced. The final version is in [Appendix A.7](#a7-infracloud-initsh).

### 0.11 New file: `infra/iam-policies.txt`

Holds the dynamic-group rules and policy statements. Final version in [Appendix A.8](#a8-infraiam-policiestxt).

### 0.12 README rewrite

README rewritten with the AWS→OCI mapping table, pipeline flow, secrets explanation, endpoints, local run instructions, console setup steps, migration checklist and the container option (with the correct OCIR path format `<region-key>.ocir.io/<namespace>/oci-node-app:${BUILDRUN_HASH}`).

### 0.13 Local verification

```bash
# Unit tests
npm test                                  # ℹ tests 3  ℹ pass 3  ℹ fail 0

# Smoke test without VERSION file
PORT=3456 node src/server.js &
curl -s localhost:3456/health
# {"status":"ok","version":"local","secretsSource":"env",...}

# Smoke test with VERSION file (simulates a pipeline build)
echo abc1234 > VERSION
PORT=3456 node src/server.js &
curl -s localhost:3456/health
# {"status":"ok","version":"abc1234","secretsSource":"env",...}
rm VERSION

# Script / YAML syntax
bash -n infra/cloud-init.sh && echo cloud-init-syntax-ok
cd /tmp && npx --yes js-yaml /Users/krunalprajapati/Downloads/oci-node-app/build_spec.yaml >/dev/null && echo ok
cd /tmp && npx --yes js-yaml /Users/krunalprajapati/Downloads/oci-node-app/deployment/deploy_spec.yaml >/dev/null && echo ok
```

### 0.14 Initialize git

```bash
cd /Users/krunalprajapati/Downloads/oci-node-app
git init -q -b main
git add -A
git status --short
git -c user.email=krunalgadgetguru@gmail.com -c user.name="Krunal Prajapati" \
  commit -q -m "OCI DevOps CI/CD demo: build, deploy to Compute, Vault secrets"
git log --oneline          # 9f7d039
```

`node_modules/` and `.env` are excluded by `.gitignore`.

### 0.15 Create the compartment (Console)

*Identity & Security → Compartments → Create compartment*

| Field | Value |
|---|---|
| Name | `oci-node-app-demo` |
| Parent | root |

Result: `ocid1.compartment.oc1..aaaaaaaaznj4z6zgc4b5eduycp75tjxui6xuemokef7h6hl2ael37qguedkq`

---

## Phase 1: Foundation (Steps 1–7)

### Step 1: Dynamic group `devops-dg`

*Identity & Security → Domains → **Default** → Dynamic groups → Create dynamic group*

| Field | Value |
|---|---|
| Name | `devops-dg` |
| Description | `OCI DevOps pipelines for oci-node-app` |
| Matching rules | **Match any rules defined below** |
| Rule 1 (single box) | see below |

```
ALL {resource.compartment.id = 'ocid1.compartment.oc1..aaaaaaaaznj4z6zgc4b5eduycp75tjxui6xuemokef7h6hl2ael37qguedkq', ANY {resource.type = 'devopsbuildpipeline', resource.type = 'devopsdeploypipeline', resource.type = 'devopsrepository', resource.type = 'devopsconnection', resource.type = 'devopstrigger'}}
```

> **Issue 1.** The first attempt pasted five separate `ANY {...}` lines into one rule box. Console error:
> `Unable to parse matching rule 'Any {ANY {resource.type = 'devopsbuildpipeline', ...} ANY {...} ...}'`
> In addition, `ANY {resource.type = X, resource.compartment.id = Y}` is semantically wrong: it matches *any* resource in the compartment **or** that resource type tenancy-wide.
> **Fix:** a single rule `ALL {compartment, ANY {types...}}`. The repo file was updated (commit `dfaff30`):
>
> ```diff
> -ANY {resource.type = 'devopsbuildpipeline', resource.compartment.id = '<compartment-ocid>'}
> -ANY {resource.type = 'devopsdeploypipeline', resource.compartment.id = '<compartment-ocid>'}
> -ANY {resource.type = 'devopsrepository', resource.compartment.id = '<compartment-ocid>'}
> -ANY {resource.type = 'devopsconnection', resource.compartment.id = '<compartment-ocid>'}
> -ANY {resource.type = 'devopstrigger', resource.compartment.id = '<compartment-ocid>'}
> +# Single rule (paste into one rule box):
> +ALL {resource.compartment.id = '<compartment-ocid>', ANY {resource.type = 'devopsbuildpipeline', resource.type = 'devopsdeploypipeline', resource.type = 'devopsrepository', resource.type = 'devopsconnection', resource.type = 'devopstrigger'}}
> ```

### Step 2: Dynamic group `app-instances-dg`

Same location → *Create dynamic group*

| Field | Value |
|---|---|
| Name | `app-instances-dg` |
| Description | `Compute instances running oci-node-app` |
| Matching rules | **Match any rules defined below** |
| Rule 1 | `ALL {instance.compartment.id = 'ocid1.compartment.oc1..aaaaaaaaznj4z6zgc4b5eduycp75tjxui6xuemokef7h6hl2ael37qguedkq'}` |

This is the OCI equivalent of the EC2 instance profile: the app uses it (Instance Principals) to read the Vault secret.

### Step 3: Policy `oci-node-app-policy`

*Identity & Security → Policies* → select the **root** compartment in the left filter → *Create policy*

| Field | Value |
|---|---|
| Name | `oci-node-app-policy` |
| Description | `DevOps pipelines and instances access for oci-node-app` |
| Compartment | root |
| Policy Builder | **Show manual editor** |

Statements as entered in Step 3:

```
Allow dynamic-group devops-dg to manage devops-family in compartment oci-node-app-demo
Allow dynamic-group devops-dg to manage generic-artifacts in compartment oci-node-app-demo
Allow dynamic-group devops-dg to read all-artifacts in compartment oci-node-app-demo
Allow dynamic-group devops-dg to manage repos in compartment oci-node-app-demo
Allow dynamic-group devops-dg to use ons-topics in compartment oci-node-app-demo
Allow dynamic-group devops-dg to read secret-family in compartment oci-node-app-demo
Allow dynamic-group devops-dg to read instance-family in compartment oci-node-app-demo
Allow dynamic-group devops-dg to use instance-agent-command-execution-family in compartment oci-node-app-demo
Allow dynamic-group devops-dg to use virtual-network-family in compartment oci-node-app-demo
Allow dynamic-group app-instances-dg to use instance-agent-command-execution-family in compartment oci-node-app-demo where request.instance.id = target.instance.id
Allow dynamic-group app-instances-dg to read generic-artifacts in compartment oci-node-app-demo
Allow dynamic-group app-instances-dg to read all-artifacts in compartment oci-node-app-demo
Allow dynamic-group app-instances-dg to read secret-bundles in compartment oci-node-app-demo where target.secret.name = 'oci-node-app-secrets'
```

A 14th statement was added in **Step 30** (`manage instance-agent-command-family`).

| Statement purpose | Who |
|---|---|
| Run pipelines, read/write artifacts, notify | `devops-dg` |
| Read the `github-pat` secret for the GitHub connection | `devops-dg` (`read secret-family`) |
| Create Run Command jobs on instances | `devops-dg` (`manage instance-agent-command-family`, Step 30) |
| Receive Run Command jobs, download artifacts | `app-instances-dg` |
| Read **only** the app secret | `app-instances-dg` (`where target.secret.name = 'oci-node-app-secrets'`) |

### Step 4: Vault `oci-node-app-vault`

*Identity & Security → Vault* → compartment `oci-node-app-demo` → *Create Vault*

| Field | Value |
|---|---|
| Compartment | `oci-node-app-demo` |
| Name | `oci-node-app-vault` |
| Make it a virtual private vault | **unchecked** (private vaults are billed hourly) |

Wait for **Active** (about 1 min).

### Step 5: Master encryption key `oci-node-app-key`

Vault → *Master encryption keys* → *Create Key*

| Field | Value |
|---|---|
| Compartment | `oci-node-app-demo` |
| Protection mode | **Software** (free) |
| Name | `oci-node-app-key` |
| Algorithm / length | AES / 256 bits (default) |

Wait for **Enabled**.

### Step 6: Secret `oci-node-app-secrets`

> **Console note.** In the current Console, secrets are **not** created inside the Vault page. Use *Identity & Security → **Secret Management** → Create Secret* (back arrow next to *Key Management* in the sidebar, or search "Secrets").

| Field | Value |
|---|---|
| Compartment | `oci-node-app-demo` |
| Name | `oci-node-app-secrets` (must match policy and pipeline) |
| Description | `Runtime secrets for oci-node-app` |
| Vault | `oci-node-app-vault` |
| Encryption key | `oci-node-app-key` |
| Generation | Manual |
| Secret type template | Plain-Text |
| Secret contents | `{"API_KEY":"demo-123"}` |

Then *Vault → oci-node-app-vault → Vault information → OCID → Copy*:
`ocid1.vault.oc1.ap-mumbai-1.fbvmsmczaagaq.abrg6ljrzlnodjnuqdxhmcnk7rniqo4g5dypo67a3t3zsulqsoskmtq4s4oq`

### Step 7: Notification topic `oci-node-app-topic`

*Developer Services → Application Integration → Notifications → Topics → Create Topic*

| Field | Value |
|---|---|
| Compartment | `oci-node-app-demo` |
| Name | `oci-node-app-topic` |
| Description | `OCI DevOps notifications for oci-node-app` |

No subscription required (an email subscription can be added for alerts).

---

## Phase 2: CI: build pipeline (Steps 8–20)

### Step 8: DevOps project `oci-node-app`

*Developer Services → DevOps → Projects → Create DevOps project*

| Field | Value |
|---|---|
| Compartment | `oci-node-app-demo` |
| Project name | `oci-node-app` |
| Description | `CI/CD for oci-node-app (AWS CodeStar replacement)` |
| Notification topic | `oci-node-app-topic` |

### Step 9: Enable project logging

Project → **Logs** tab → row **DevOps Logs** → **⋯ → Enable log**

1. In the *Enable resource log* panel, the **Log group** dropdown showed *"None available in selected compartment"*. Click **Create new group** at the top of the panel:

   | Field | Value |
   |---|---|
   | Compartment | `oci-node-app-demo` |
   | Name | `oci-node-app-logs` |
   | Description | `Logs for oci-node-app DevOps project` |

2. Back in the panel:

   | Field | Value |
   |---|---|
   | Log group | `oci-node-app-logs` |
   | Log name | `Project_all` (default) |
   | Log retention | 1 month (default) |

3. **Enable log** → refresh until **Status: Active**.

> If the row still shows "-" after refresh, repeat via **⋯ → Enable log** and select the existing group. Without this, build/deploy logs are not visible in the Console.

### Step 10: Source repository on GitHub

The original plan used an OCI Code Repository. **Requirement change:** source must come from an external GitHub repo.

1. *github.com → + → New repository*

   | Field | Value |
   |---|---|
   | Name | `oci-node-app` |
   | Visibility | **Private** (works; OCI authenticates with a token) |
   | README / .gitignore / license | **unchecked** (repo must be empty) |

2. Push the local repo (commands run on the admin Mac):

```bash
which gh                      # not installed → GitHub CLI not used
cd /Users/krunalprajapati/Downloads/oci-node-app
git remote -v                 # none
git status --short            # M infra/iam-policies.txt  (Step 1 fix)

git add infra/iam-policies.txt
git -c user.email=krunalgadgetguru@gmail.com -c user.name="Krunal Prajapati" \
  commit -q -m "Fix devops-dg matching rule: single ALL rule scoped to compartment"

git remote add origin https://github.com/krunl86/oci-node-app.git
git config --get credential.helper        # osxkeychain
GIT_TERMINAL_PROMPT=0 git push -u origin main
#  * [new branch]      main -> main
```

### Step 11: GitHub personal access token

*GitHub → profile → Settings → Developer settings → Personal access tokens → Tokens (classic) → Generate new token (classic)*

| Field | Value |
|---|---|
| Note | `oci-devops-oci-node-app` |
| Expiration | 90 days |
| Scopes | `repo` (all), `read:user` |

Copy the `ghp_…` token immediately. **Never paste it into chat, tickets or docs.**

### Step 12: Store the token in Vault (`github-pat`)

*Identity & Security → Secret Management → Create Secret*

| Field | Value |
|---|---|
| Compartment | `oci-node-app-demo` |
| Name | `github-pat` |
| Description | `GitHub token for OCI DevOps external connection` |
| Vault / key | `oci-node-app-vault` / `oci-node-app-key` |
| Generation | Manual |
| Template | Plain-Text |
| Contents | the `ghp_…` token only (no quotes, spaces or newline) |

### Step 13: External connection `github-connection`

*DevOps → oci-node-app → Latest external connections → Create external connection*

| Field | Value |
|---|---|
| Name | `github-connection` |
| Description | `Connection to github.com/krunl86/oci-node-app` |
| Type | GitHub |
| Vault compartment / Vault | `oci-node-app-demo` / `oci-node-app-vault` |
| Secret compartment / Secret | `oci-node-app-demo` / `github-pat` |

Optional: *Actions → Validate connection*.

### Step 14: Artifact Registry repository

*Developer Services → Containers & Artifacts → Artifact Registry → Create repository*

| Field | Value |
|---|---|
| Name | `oci-node-app-artifacts` |
| Compartment | `oci-node-app-demo` |
| Immutable artifacts | unchecked |

### Step 15: DevOps artifact `app-zip`

*DevOps → oci-node-app → Latest artifacts → Add artifact*

| Field | Value |
|---|---|
| Name | `app-zip` |
| Type | **General artifact** |
| Artifact source | Artifact Registry repository → region India West (Mumbai), compartment `oci-node-app-demo`, repo `oci-node-app-artifacts` → **Select** |
| Artifact location | **Set Custom Location** |
| Artifact path | `app.zip` |
| Version | `${BUILDRUN_HASH}` |
| Allow parameterization | **checked** |

### Step 16: DevOps artifact `deploy-spec`

| Field | Value |
|---|---|
| Name | `deploy-spec` |
| Type | **Instance group deployment configuration** |
| Artifact source | Artifact Registry repository → `oci-node-app-artifacts` |
| Artifact location | Set Custom Location |
| Artifact path | `deploy_spec.yaml` (underscore) |
| Version | `${BUILDRUN_HASH}` |
| Allow parameterization | **checked** (substitutes Vault OCID, secret name, release) |

### Step 17: Build pipeline `oci-node-app-build`

*DevOps → oci-node-app → Build pipelines → Create build pipeline* (scroll the project tab row left with `<` to reach *Build pipelines*)

| Field | Value |
|---|---|
| Name | `oci-node-app-build` |
| Description | `Build, test and package oci-node-app from GitHub` |

### Step 18: Stage 1: Managed Build `build`

Pipeline tab → **+** → Add stage → **Managed Build**

| Field | Value |
|---|---|
| Stage name | `build` |
| Description | `npm ci, npm test, package app.zip` |
| Build agent | default (Oracle Linux 8 standard image, e.g. `OL8_X86_64_STANDARD_10`) |
| Build spec file path | `build_spec.yaml` |
| Primary code repository | Source connection type **GitHub** → connection `github-connection` → repository `krunl86/oci-node-app` → branch `main` → build source name `oci_node_app` |
| Timeout | default |

### Step 19: Stage 2: Deliver artifacts `deliver`

**+ below `build`** → Add stage → **Deliver artifacts**

| Field | Value |
|---|---|
| Stage name | `deliver` |
| Description | `Upload app.zip and deploy_spec.yaml to Artifact Registry` |
| Artifacts | Select `app-zip` and `deploy-spec` |

**Associate artifacts with build result**: the right-hand box is the `outputArtifacts.name` from `build_spec.yaml`:

| Destination DevOps artifact | Build config/result artifact name |
|---|---|
| `deploy-spec` | `deploy_spec` |
| `app-zip` | `app_zip` |

```yaml
outputArtifacts:
  - name: app_zip        ← app-zip
  - name: deploy_spec    ← deploy-spec
```

### Step 20: First build run

*oci-node-app-build → Start manual run* → name `first-build` → Start.

Expected: **build** (Set build version → Set up Node.js → Install dependencies → Run tests [`ℹ pass 3`, `ℹ fail 0`] → Package application) → **deliver**.
Result: **Succeeded**. `app.zip` and `deploy_spec.yaml` appeared in `oci-node-app-artifacts` with a 7-character version.

---

## Phase 3: Deploy target: network and Compute (Steps 21–24)

### Step 21: VCN via wizard

*Networking → Virtual cloud networks* → compartment `oci-node-app-demo` → **Actions → Start VCN Wizard** (do **not** use the bare *Create VCN* button) → **Create VCN with Internet Connectivity**

| Field | Value |
|---|---|
| VCN name | `oci-node-app-vcn` |
| Compartment | `oci-node-app-demo` |
| VCN CIDR | `10.0.0.0/16` |
| Public subnet | `public subnet-oci-node-app-vcn`, `10.0.0.0/24` |
| Private subnet | `private subnet-oci-node-app-vcn`, `10.0.1.0/24` |

Review → **Create** → wait for all green ticks. Created: Internet gateway (public subnet), NAT gateway + Service gateway (private subnet), default and private security lists, route tables.

### Step 22: Ingress rule for port 3000

VCN → **Security** → *default security list for oci-node-app-vcn* → **Security rules** → **Add Ingress Rules**

| Field | Value |
|---|---|
| Stateless | off |
| Source type | CIDR |
| Source CIDR | `0.0.0.0/0` |
| IP protocol | TCP |
| Source port range | (empty) |
| Destination port range | `3000` |
| Description | `oci-node-app HTTP` |

The panel header should read *"Allows TCP traffic for ports: 3000"*. (Demo only: restrict the source or use a Load Balancer in production.)

### Step 23: Compute instance `oci-node-app-vm-1`

*Compute → Instances → Create instance*

#### 23a: Basic information

| Field | Value |
|---|---|
| Name | `oci-node-app-vm-1` |
| Compartment | `oci-node-app-demo` |
| Placement | AD 1 (`sMMo:AP-MUMBAI-1-AD-1`); fault domain left empty |
| Image | **Oracle Linux 8** (build `2026.09.18-0`) |
| Shape | see 23e (final: `VM.Standard.E2.1.Micro`) |
| Instance metadata service | **Require an authorization header** = on (IMDSv2; supported by OCI SDK and agent) |
| Initialization script | **Paste cloud-init script** (first line must be `#!/bin/bash`) |
| Oracle Cloud Agent | **Compute Instance Run Command**: not shown in this wizard version, enabled after creation (Step 24) |

> **Issue 2: default shape.** The wizard defaulted to `VM.Standard.E2.1.Micro` (1 GB). It was first changed to `VM.Standard.A1.Flex` (1 OCPU / 6 GB, Ampere).

#### 23b: Security page

Shielded instance / Confidential computing: off → Next.

#### 23c: Networking page

| Field | Value |
|---|---|
| Primary network | Select existing VCN → `oci-node-app-demo` / `oci-node-app-vcn` |
| Subnet | Select existing → `public subnet-oci-node-app-vcn (regional)` |
| Private IPv4 | Automatically assign |
| Automatically assign public IPv4 address | **on** |
| IPv6 | off (warning "VCN and subnet combination does not support IPv6" is expected) |
| SSH keys | Generate a key pair for me → **Download private key** + **Download public key** |

Moving the downloaded keys (the browser named them after the instance, so the `ssh-key-*.key` glob failed):

```bash
# First attempt (failed: wrong file name)
mkdir -p ~/.ssh && mv ~/Downloads/ssh-key-*.key ~/.ssh/oci-node-app.key && chmod 600 ~/.ssh/oci-node-app.key
# zsh: no matches found: /Users/krunalprajapati/Downloads/ssh-key-*.key

# Locate the files
ls -lt ~/Downloads | head -15
# oci-node-app.key, oci-node-app.key.pub

# Working command
mv -n ~/Downloads/oci-node-app.key ~/Downloads/oci-node-app.key.pub ~/.ssh/
chmod 600 ~/.ssh/oci-node-app.key
ls -l ~/.ssh/oci-node-app.key*
head -1 ~/.ssh/oci-node-app.key        # -----BEGIN RSA PRIVATE KEY-----
```

For later wizard attempts: **Upload public key file (.pub)** → `~/.ssh/oci-node-app.key.pub` (Cmd+Shift+. shows hidden folders in the macOS file picker).

#### 23d: Storage → Review → Create

Storage defaults (boot volume ≈47 GB) → Review → **Create**.

#### 23e: Capacity errors and resolution

| Attempt | Shape | Result |
|---|---|---|
| 1 | `VM.Standard.A1.Flex` 1 OCPU / 6 GB | `Out of capacity for shape VM.Standard.A1.Flex in availability domain AD-1` |
| 2 | `VM.Standard.E4.Flex` 1 OCPU / 4 GB | `Out of capacity for shape VM.Standard.E4.Flex in availability domain AD-1` |
| 3+ | E5.Flex / Standard3.Flex / fault domains 1–3 | `Too many requests for the user` (API rate limit from rapid retries) |
| Next day | **`VM.Standard.E2.1.Micro`** (Always Free) | **Succeeded**: AD-1, FD-1 |

Notes:
- Mumbai has **one** availability domain, so "try another AD" is not possible.
- Free Trial accounts are limited to the home region.
- In this Console version the fault domain dropdown lists only FD-1/2/3; leaving it empty lets Oracle choose.
- After "Too many requests", wait ~15 min and retry one attempt at a time.

In anticipation of the 1 GB shape, cloud-init was given a swap section (commit `989cd5d`). It was later superseded (see Step 24):

```bash
# Small shapes (e.g. VM.Standard.E2.1.Micro, 1 GB) need swap for dnf to finish
if [ "$(awk '/MemTotal/ {print $2}' /proc/meminfo)" -lt 2000000 ] && [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
```

```bash
git add infra/cloud-init.sh
git -c user.email=krunalgadgetguru@gmail.com -c user.name="Krunal Prajapati" \
  commit -q -m "cloud-init: add swap on <2 GB shapes so E2.1.Micro can install Node.js"
GIT_TERMINAL_PROMPT=0 git push -q origin main
```

**Instance created:** `oci-node-app-vm-1`, Running, `VM.Standard.E2.1.Micro`, public IP **80.225.250.143**, user `opc`.

### Step 24: Enable Run Command plugin + fix the bootstrap

#### 24a: Enable the plugin (Console)

Instance → **Management** tab → **Oracle Cloud Agent** → *Compute Instance Run Command* → **Enable** → wait 2–5 min for **Running**.

#### 24b: Verify cloud-init over SSH

```bash
ssh -i ~/.ssh/oci-node-app.key -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 -o BatchMode=yes opc@80.225.250.143 \
  'cloud-init status --long; node -v; free -m'
# "System is booting up. Unprivileged users are not permitted to log in yet."  (retry after boot)

ssh -i ~/.ssh/oci-node-app.key -o ConnectTimeout=10 -o BatchMode=yes opc@80.225.250.143 \
  'cloud-init status; uptime; free -m | head -3; sudo tail -5 /var/log/cloud-init-output.log'
```

Output (abridged):

```
status: error
Mem:   945 total ...   Swap: 1890
/var/lib/cloud/instance/scripts/part-001: line 8:  4202 Killed   dnf module reset -y nodejs
cc_scripts_user.py[WARNING]: Failed to run module scripts-user
```

> **Issue 3: `dnf` OOM-killed on 1 GB.** The OL8 image already has a 1.9 GB `/.swapfile`; `dnf` was still killed. (Line 8 also showed the *original* script had been pasted, without the swap block.)

Instance state check:

```bash
ssh -i ~/.ssh/oci-node-app.key -o ConnectTimeout=10 -o BatchMode=yes opc@80.225.250.143 \
  'uname -m; rpm -q unzip xz tar curl; swapon --show; id nodeapp; ls /etc/systemd/system/oci-node-app.service; sudo firewall-cmd --list-ports; systemctl is-active oracle-cloud-agent'
# x86_64 / unzip, xz, tar, curl installed / /.swapfile 1.9G / no nodeapp / no unit / no ports / agent active
```

#### 24c: Fix: install Node.js from the official tarball (no `dnf`)

`infra/cloud-init.sh` change (commit `684b4df`):

```diff
-# Small shapes (e.g. VM.Standard.E2.1.Micro, 1 GB) need swap for dnf to finish
-if [ "$(awk '/MemTotal/ {print $2}' /proc/meminfo)" -lt 2000000 ] && [ ! -f /swapfile ]; then
-  ...
-fi
-
-# Node.js 20 runtime + tools used by the deployment spec
-dnf module reset -y nodejs
-dnf module enable -y nodejs:20
-dnf install -y nodejs unzip curl
+# Node.js 20 from the official tarball. dnf gets OOM-killed on 1 GB shapes
+# (VM.Standard.E2.1.Micro); unzip/curl/xz already ship with the OL8 image.
+NODE_DIST=https://nodejs.org/dist/latest-v20.x
+NODE_ARCH=$(uname -m | sed 's/x86_64/x64/;s/aarch64/arm64/')
+if ! command -v node >/dev/null; then
+  cd /tmp
+  curl -fsSLO ${NODE_DIST}/SHASUMS256.txt
+  NODE_TARBALL=$(awk "/linux-${NODE_ARCH}.tar.xz\$/ {print \$2}" SHASUMS256.txt)
+  curl -fsSLO ${NODE_DIST}/${NODE_TARBALL}
+  grep " ${NODE_TARBALL}\$" SHASUMS256.txt | sha256sum -c -
+  tar -xJf ${NODE_TARBALL} -C /usr/local --strip-components=1 --no-same-owner
+  ln -sf /usr/local/bin/node /usr/bin/node
+  rm -f ${NODE_TARBALL} SHASUMS256.txt
+fi
+node -v
```

Run the fixed bootstrap on the existing instance (instead of recreating it):

```bash
cd /Users/krunalprajapati/Downloads/oci-node-app
bash -n infra/cloud-init.sh && echo syntax-ok
scp -i ~/.ssh/oci-node-app.key -o BatchMode=yes -q infra/cloud-init.sh opc@80.225.250.143:/tmp/bootstrap.sh
ssh -i ~/.ssh/oci-node-app.key -o BatchMode=yes opc@80.225.250.143 \
  'sudo bash /tmp/bootstrap.sh 2>&1 | tail -15; echo "exit=${PIPESTATUS[0]}"'
# ... systemctl enable oci-node-app → Created symlink ...
# firewall-cmd --permanent --add-port=3000/tcp → success
# exit=0
```

Verify:

```bash
ssh -i ~/.ssh/oci-node-app.key -o BatchMode=yes opc@80.225.250.143 \
  'node -v; npm -v; id nodeapp; id ocarun; systemctl is-enabled oci-node-app; sudo firewall-cmd --list-ports; sudo cat /etc/sudoers.d/101-oracle-cloud-agent-run-command; free -m | sed -n 2p'
# v20.20.2 / 10.8.2 / uid=985(nodeapp) / uid=986(ocarun) groups=oracle-cloud-agent,adm
# enabled / 3000/tcp / ocarun ALL=(ALL) NOPASSWD:ALL
```

The `ocarun` user exists only after the Run Command plugin is enabled, which confirms Step 24a.

```bash
git add infra/cloud-init.sh
git -c user.email=krunalgadgetguru@gmail.com -c user.name="Krunal Prajapati" \
  commit -q -m "cloud-init: install Node.js from official tarball instead of dnf"
GIT_TERMINAL_PROMPT=0 git push -q origin main      # 684b4df
```

---

## Phase 4: CD: deploy pipeline and automation (Steps 25–34)

### Step 25: Environment `oci-node-app-vm-env`

*DevOps → oci-node-app → Latest environments → Create environment*

| Field | Value |
|---|---|
| Environment type | **Instance group** |
| Name | `oci-node-app-vm-env` |
| Description | `Compute instances running oci-node-app` |
| Instances | Add instance → region India West (Mumbai) → compartment `oci-node-app-demo` → `oci-node-app-vm-1` |

### Step 26: Deploy pipeline `oci-node-app-deploy` + parameters

*DevOps → oci-node-app → Deployment pipelines → Create pipeline*

| Field | Value |
|---|---|
| Pipeline name | `oci-node-app-deploy` |
| Description | `Deploy oci-node-app to Compute instance group` |

**Parameters** tab:

| Name | Default value | Description |
|---|---|---|
| `BUILDRUN_HASH` | `latest` | Build version to deploy (set by the build pipeline) |
| `VAULT_ID` | `ocid1.vault.oc1.ap-mumbai-1.fbvmsmczaagaq.abrg6ljrzlnodjnuqdxhmcnk7rniqo4g5dypo67a3t3zsulqsoskmtq4s4oq` | Vault holding app secrets |
| `SECRET_NAME` | `oci-node-app-secrets` | Secret name in the Vault |

> **Issue 4: reserved prefix.** `OCI_VAULT_ID` was rejected:
> *"Parameter name can only consist of ASCII letter, digit or '_' (underscore) characters and not start with an oci (case-insensitive) prefix."*
> **Fix:** rename to `VAULT_ID` / `SECRET_NAME`; the spec maps them to the app's `OCI_*` env names (commit `bd1a4c6`):
>
> ```diff
>  env:
>    variables:
>      APP_NAME: "oci-node-app"
>      APP_ROOT: "/opt/oci-node-app"
>      RELEASE: "${BUILDRUN_HASH}"
> -    OCI_VAULT_ID: "${OCI_VAULT_ID}"
> -    OCI_SECRET_NAME: "${OCI_SECRET_NAME}"
> +    VAULT_ID: "${VAULT_ID}"
> +    SECRET_NAME: "${SECRET_NAME}"
> ...
> -      OCI_VAULT_ID=${OCI_VAULT_ID}
> -      OCI_SECRET_NAME=${OCI_SECRET_NAME}
> +      OCI_VAULT_ID=${VAULT_ID}
> +      OCI_SECRET_NAME=${SECRET_NAME}
> ```
>
> ```bash
> sed -i '' -e '99s/`OCI_VAULT_ID`/`VAULT_ID`/' -e '100s/`OCI_SECRET_NAME`/`SECRET_NAME`/' README.md
> (cd /tmp && npx --yes js-yaml /Users/krunalprajapati/Downloads/oci-node-app/deployment/deploy_spec.yaml >/dev/null && echo yaml-ok)
> git add -A
> git -c user.email=krunalgadgetguru@gmail.com -c user.name="Krunal Prajapati" \
>   commit -q -m "Rename deploy params to VAULT_ID/SECRET_NAME (OCI prefix is reserved)"
> GIT_TERMINAL_PROMPT=0 git push -q origin main      # bd1a4c6
> ```

### Step 27: Deploy stage `deploy-vm`

Deploy pipeline → Pipeline tab → **+** → Add stage → **Deploy incrementally through Compute instance group** (rolling)

| Field | Value |
|---|---|
| Stage name | `deploy-vm` |
| Description | `Rolling deploy to oci-node-app-vm-env` |
| Environment | `oci-node-app-vm-env` |
| Deployment configuration | `deploy-spec` |
| Additional artifact | `app-zip` |
| Rollout policy | Instance count, batch count `1`, batch delay default (60 s) |
| Load balancer | None |
| Rollback policy | default (No stage rollback; the spec rolls back itself) |

### Step 28: Stage 3 of the build: `trigger-deploy`

Build pipeline → **+ below `deliver`** → Add stage → **Trigger deployment**

| Field | Value |
|---|---|
| Stage name | `trigger-deploy` |
| Description | `Start oci-node-app-deploy with this build's version` |
| Deployment pipeline | `oci-node-app-deploy` |
| Send build pipeline parameters | **checked** (passes exported `BUILDRUN_HASH`) |

Canvas: **build → deliver → trigger-deploy**.

### Step 29: First end-to-end run (failed)

*oci-node-app-build → Start manual run* → `first-e2e`. Build stages succeeded; the deployment `devopsdeployment20261010042449` **failed** after 1 min 3 s.

> **Where to find deployments (current Console):** *Project → **Latest deployment pipelines** → oci-node-app-deploy → **Deployments** tab → deployment → click stage `deploy-vm`* (log panel). Triggered deployments are auto-named `devopsdeploymentYYYYMMDDhhmmss`.

Stage log:

```
Deployment execution starting stage: deploy-vm.
Value is missing for the placeholders: [..., APP_ROOT, RELEASE, APP_NAME, APP_NAME, ...]
Fetching the instance ids and updating their progress.
Starting deployment on instance ocid1.instance.oc1.ap-mumbai-1.anrg6ljr...dpea
Unable to create run command for instance: ocid1.instance.oc1.ap-mumbai-1.anrg6ljr...dpea Verify con...
  For configuring required policies see: https://docs.oracle.com/en-us/iaas/Content/devops/using/devops_iampolicies.htm#create-policy
Handling deployment failure.
Cleaning up failed deployment.
```

**Two problems:**

| # | Symptom | Cause | Fix |
|---|---|---|---|
| A | `Unable to create run command` | `devops-dg` had `use instance-agent-command-execution-family` (what the **instance** needs) but not permission to **create** commands | Add `manage instance-agent-command-family` (Step 30) |
| B | `Value is missing for the placeholders` | DevOps treats **every** `${...}` in the spec as a pipeline parameter | Use plain `$VAR` inside step commands |

Fix B: unbrace variables in the step commands (only lines 23+, so `env.variables` keeps `${BUILDRUN_HASH}`, `${VAULT_ID}`, `${SECRET_NAME}`):

```bash
cd /Users/krunalprajapati/Downloads/oci-node-app
sed -i '' -E '23,$ s/\$\{(APP_ROOT|APP_NAME|RELEASE|VAULT_ID|SECRET_NAME)\}/$\1/g' deployment/deploy_spec.yaml
echo "braced refs left in steps: $(sed -n '23,$p' deployment/deploy_spec.yaml | grep -c '\${')"   # 0
```

Also lengthened the health check for the 1/8-OCPU micro shape:

```diff
-    timeoutInSeconds: 180
+    timeoutInSeconds: 240
     command: |
       set -uo pipefail
       cd "$APP_ROOT"
-      for i in $(seq 1 20); do
+      # Up to ~150s: startup plus the Vault call is slow on 1/8-OCPU micro shapes
+      for i in $(seq 1 50); do
```

`infra/iam-policies.txt`:

```diff
 Allow dynamic-group devops-dg to use instance-agent-command-execution-family in compartment <compartment-name>
+Allow dynamic-group devops-dg to manage instance-agent-command-family in compartment <compartment-name>
```

```bash
git add -A
git -c user.email=krunalgadgetguru@gmail.com -c user.name="Krunal Prajapati" \
  commit -q -m "Fix first deploy: run-command IAM, unbraced spec vars, longer health check"
GIT_TERMINAL_PROMPT=0 git push -q origin main      # 7706e13
```

#### 29a: Instance unresponsive (separate issue found during this step)

`curl http://80.225.250.143:3000/health` and SSH both timed out (`Connection timed out during banner exchange`), even though the deployment never ran on the VM.

```bash
ssh -i ~/.ssh/oci-node-app.key -o BatchMode=yes -o ConnectTimeout=60 opc@80.225.250.143 \
  'uptime; ps -eo pid,pcpu,pmem,etime,comm,args --sort=-pcpu | head -15'
#  load average: 31.19, 42.02, 29.89   (1/8 OCPU!)   kswapd0 busy, defunct python3

ssh -i ~/.ssh/oci-node-app.key -o BatchMode=yes -o ConnectTimeout=60 opc@80.225.250.143 \
  'systemctl list-timers --all --no-pager | grep -Ei "dnf|yum|makecache|osms|ksplice"; sudo journalctl --since "-90min" --no-pager | grep -Ei "makecache|Out of memory|oom-kill|Killed process" | tail -8'
```

```
dnf-makecache.timer  ... last 04:13 ... next 05:58
04:13:00 systemd[1]: Starting dnf makecache...
04:35:22 kernel: systemd invoked oom-killer ...
04:35:24 kernel: Out of memory: Killed process 18951 (dnf) total-vm:2929772kB, anon-rss:722788kB
04:35:24 systemd[1]: dnf-makecache.service: Failed with result 'signal'.
```

> **Issue 5: hourly `dnf makecache`** needs ≈700 MB RSS; on 1 GB it thrashed swap for 22 minutes (load ≈44) until OOM-killed, starving sshd and the Run Command agent.

Fix on the VM, then in cloud-init (commit `cc69957`):

```bash
ssh -i ~/.ssh/oci-node-app.key -o BatchMode=yes -o ConnectTimeout=60 opc@80.225.250.143 \
  'sudo systemctl disable --now dnf-makecache.timer && systemctl is-enabled dnf-makecache.timer; uptime'
# Removed /etc/systemd/system/timers.target.wants/dnf-makecache.timer.
# disabled
# load average: 22.33, 39.30, 29.25   (later 0.00)
```

```diff
 node -v
+
+# The hourly dnf metadata refresh swaps a 1 GB shape to a standstill (and gets
+# OOM-killed); patch via OS Management or a manual `dnf update` instead.
+systemctl disable --now dnf-makecache.timer
```

```bash
bash -n infra/cloud-init.sh
git add infra/cloud-init.sh
git -c user.email=krunalgadgetguru@gmail.com -c user.name="Krunal Prajapati" \
  commit -q -m "cloud-init: disable dnf-makecache timer (OOM-thrashes 1 GB shapes)"
GIT_TERMINAL_PROMPT=0 git push -q origin main      # cc69957
```

### Step 30: Policy fix

*Identity & Security → Policies* (root) → `oci-node-app-policy` → **Edit policy statements** → add at the bottom:

```
Allow dynamic-group devops-dg to manage instance-agent-command-family in compartment oci-node-app-demo
```

Save; allow ~1 minute to propagate.

### Step 31: Second end-to-end run (failed: sudo wraps only line 1)

*Start manual run* → `second-e2e`. Build history: **Succeeded**. Deployment `devopsdeployment20261010044232`: **Failed** (5 min 53 s).

The Console log showed progress past the IAM issue (artifact `app.zip` version `am5p336` downloaded, FileCopy succeeded, step 1 started). Full step output was read on the VM:

```bash
ssh -i ~/.ssh/oci-node-app.key -o BatchMode=yes -o ConnectTimeout=30 opc@80.225.250.143 '
D=/var/lib/ocarun/commands/wd/latestDeployment
sudo find -L $D -maxdepth 3 -type f | head -20
echo ===STDOUT; sudo find -L $D -name stdout -exec tail -40 {} \;
echo ===STDERR; sudo find -L $D -name stderr -exec tail -40 {} \;
echo ===FS; ls -la /tmp/oci-node-app-incoming /opt/oci-node-app/releases'
```

```
"The command to be run is /usr/bin/sudo -n -u root -E set -euo pipefail\nZIP=$(find ...
sudo: set: command not found
mkdir: cannot create directory '/opt/oci-node-app/releases/am5p336': Permission denied
checkdir:  cannot create extraction directory: /opt/oci-node-app/releases/am5p336
chown: cannot access '/opt/oci-node-app/releases/am5p336': No such file or directory
"Step Unpack release succeeded"
...
sudo: set: command not found
.../phases/step-1/script.sh: line 4: /etc/oci-node-app/app.env: Permission denied
chmod: changing permissions of '/etc/oci-node-app/app.env': Operation not permitted
"Step Write runtime config failed"
```

> **Issue 6: `runAs: root` sudo-wraps only the FIRST line of a command.** The agent generates `script.sh` as `/usr/bin/sudo -n -u root -E <line 1>` followed by the remaining lines, which run as the unprivileged `ocarun` user. `set -e` never took effect (it was the sudo'd "command"), so step 1 even reported success.
>
> Useful facts learned:
> - Step stdout lives at `/var/lib/ocarun/commands/wd/<deploymentId>/<stageId>/stdout`; `latestDeployment` symlinks to the newest.
> - Artifacts are downloaded into that working directory (`app.zip`, plus its extracted contents), then copied per the spec's `files:` section.

**Fix: start a root bash on line 1 and feed the step through a quoted heredoc.** Pattern used for every step:

```yaml
    command: |
      bash -euo pipefail <<'SCRIPT'
      ...step body...
      SCRIPT
```

Line 1 becomes `/usr/bin/sudo -n -u root -E bash -euo pipefail <<'SCRIPT'`; the body is stdin of the root shell. `-E` preserves `APP_ROOT`, `RELEASE`, etc. (`SETENV` is implied for `NOPASSWD: ALL`). The quoted delimiter stops the outer (ocarun) shell from expanding variables. The unpack step also now uses the exact path `/tmp/oci-node-app-incoming/app.zip` instead of `find … | head -1`.

**Verification on the VM, mimicking the agent exactly** (generate per-step scripts with `sudo` on line 1, run as `ocarun`):

```bash
mkdir -p /tmp/spec-test && cd /tmp/spec-test && npm i --silent js-yaml@4
node -e '
const y=require("js-yaml"),fs=require("fs");
const s=y.load(fs.readFileSync(process.argv[1],"utf8"));
s.steps.forEach((st,i)=>{const L=st.command.split("\n");L[0]="/usr/bin/sudo -n -u root -E "+L[0];fs.writeFileSync(`step${i+1}.sh`,L.join("\n"));console.log(i+1,st.name,"| line1:",L[0]);});
' /Users/krunalprajapati/Downloads/oci-node-app/deployment/deploy_spec.yaml
scp -i ~/.ssh/oci-node-app.key -o BatchMode=yes -q step*.sh opc@80.225.250.143:/tmp/

ssh -i ~/.ssh/oci-node-app.key -o BatchMode=yes -o ConnectTimeout=30 opc@80.225.250.143 '
sudo mkdir -p /tmp/oci-node-app-incoming && sudo cp /var/lib/ocarun/commands/wd/latestDeployment/app.zip /tmp/oci-node-app-incoming/ && sudo chown -R ocarun /tmp/oci-node-app-incoming
chmod 644 /tmp/step*.sh
for n in 1 2 3 4; do
  echo "=== step $n"
  sudo -u ocarun env APP_NAME=oci-node-app APP_ROOT=/opt/oci-node-app RELEASE=am5p336 \
    VAULT_ID=ocid1.vault.oc1.ap-mumbai-1.fbvmsmczaagaq.abrg6ljrzlnodjnuqdxhmcnk7rniqo4g5dypo67a3t3zsulqsoskmtq4s4oq \
    SECRET_NAME=oci-node-app-secrets bash /tmp/step$n.sh; rc=$?
  echo "exit=$rc"; [ $rc -eq 0 ] || break
done'
```

```
=== step 1  Unpacked am5p336 to /opt/oci-node-app/releases/am5p336      exit=0
=== step 2  Wrote /etc/oci-node-app/app.env                             exit=0
=== step 3  current -> releases/am5p336, service restarted              exit=0
=== step 4  curl: (7) Failed to connect ... (x2)  Release am5p336 is healthy   exit=0
```

```bash
curl -s http://80.225.250.143:3000/health
# {"status":"ok","version":"am5p336","secretsSource":"oci-vault","uptimeSeconds":11,...}
curl -s http://80.225.250.143:3000/api/books/1
# {"id":1,"title":"Ramayana","author":"Valmiki","year":-500}
```

`secretsSource: oci-vault` confirms the **Instance Principal → Vault** path works (IMDSv2 enabled).

```bash
(cd /tmp && npx --yes js-yaml /Users/krunalprajapati/Downloads/oci-node-app/deployment/deploy_spec.yaml >/dev/null && echo yaml-ok)
npm test                                    # pass 3, fail 0
git add -A
git -c user.email=krunalgadgetguru@gmail.com -c user.name="Krunal Prajapati" \
  commit -q -m "deploy_spec: run each step as root via bash heredoc"
GIT_TERMINAL_PROMPT=0 git push -q origin main      # 0aed49b
```

### Step 32: Third end-to-end run (succeeded, pipeline-only)

*Start manual run* → `third-e2e`. Build + deployment **Succeeded**, no manual action on the VM.

```bash
curl -s http://80.225.250.143:3000/health
# {"status":"ok","version":"afpwzkg","secretsSource":"oci-vault",...}
ssh -i ~/.ssh/oci-node-app.key -o BatchMode=yes opc@80.225.250.143 \
  'ls -l /opt/oci-node-app/current; ls -1t /opt/oci-node-app/releases; cat /opt/oci-node-app/previous_release'
# current -> releases/afpwzkg
# afpwzkg  am5p336
# releases/am5p336        (rollback target)
```

### Step 33: GitHub trigger in OCI

*DevOps → oci-node-app → Latest triggers → Create trigger*

| Field | Value |
|---|---|
| Name | `github-push-main` |
| Description | `Run build pipeline on push to main` |
| Source connection | GitHub |
| Action | Build pipeline `oci-node-app-build`, Event **Push**, Source branch `main` |

On **Create**, OCI shows the **Trigger URL** and **Secret** once. Copy both to a safe place; never paste the secret into chat or docs.

### Step 34: GitHub webhook + automated end-to-end test

*github.com/krunl86/oci-node-app → Settings → Webhooks → Add webhook*

| Field | Value |
|---|---|
| Payload URL | Trigger URL from Step 33 |
| Content type | **`application/json`** (not the default form-urlencoded) |
| Secret | Secret from Step 33 |
| SSL verification | Enabled |
| Events | **Just the push event** |
| Active | checked |

Check *Recent Deliveries*: the initial **ping** should have a green tick.

**Automated test: visible code change pushed with no manual pipeline start.**

`src/server.js`:

```diff
   res.json({
     status: 'ok',
+    cloud: 'oci',
     version: APP_VERSION,
```

`test/api.test.js`:

```diff
   assert.strictEqual(health.body.status, 'ok');
+  assert.strictEqual(health.body.cloud, 'oci');
```

```bash
npm test                                     # pass 3, fail 0
git add -A
git -c user.email=krunalgadgetguru@gmail.com -c user.name="Krunal Prajapati" \
  commit -q -m "health: report cloud=oci (end-to-end trigger test)"
GIT_TERMINAL_PROMPT=0 git push -q origin main      # 1e6a23e at 06:46:59 UTC

# Watch for the change to go live
for i in $(seq 1 100); do
  out=$(curl -s -m 8 http://80.225.250.143:3000/health)
  if echo "$out" | grep -q '"cloud":"oci"'; then echo "$(date -u +%H:%M:%S) LIVE: $out"; exit 0; fi
  sleep 15
done
```

| Time (UTC) | Event |
|---|---|
| 06:46:59 | `git push` (commit `1e6a23e`) |
| 06:47 | Build run `github-push-main:20261010064701` started by the trigger |
| ≈06:52 | Build run **Succeeded** (build → deliver → trigger-deploy) |
| 06:56:08 | **LIVE**: `{"status":"ok","cloud":"oci","version":"a5dathv","secretsSource":"oci-vault",...}` |

```bash
ssh -i ~/.ssh/oci-node-app.key -o BatchMode=yes opc@80.225.250.143 \
  'ls -l /opt/oci-node-app/current; cat /opt/oci-node-app/previous_release; ls -1t /opt/oci-node-app/releases'
# current -> releases/a5dathv
# releases/afpwzkg
# a5dathv  afpwzkg  am5p336
```

**Result: push-to-production in ≈9 minutes, zero manual steps.**

---

## Appendix A: Final source files (complete)

### A.1 `package.json`

```json
{
  "name": "oci-node-app",
  "version": "1.0.0",
  "description": "Simple Node.js API with a build pipeline for OCI DevOps",
  "main": "src/server.js",
  "scripts": {
    "start": "node src/server.js",
    "dev": "node --watch src/server.js",
    "test": "node --test"
  },
  "engines": {
    "node": ">=18"
  },
  "license": "MIT",
  "dependencies": {
    "cors": "^2.8.5",
    "dotenv": "^16.4.5",
    "express": "^4.19.2",
    "helmet": "^7.1.0",
    "morgan": "^1.10.0",
    "oci-common": "^2.142.2",
    "oci-secrets": "^2.142.2"
  }
}
```

### A.2 `src/server.js`

```js
require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const { loadSecrets } = require('./secrets');

const app = express();
const PORT = process.env.PORT || 3000;
// VERSION is written into each release zip by the build pipeline
const versionFile = path.join(__dirname, '..', 'VERSION');
const APP_VERSION = fs.existsSync(versionFile) ? fs.readFileSync(versionFile, 'utf8').trim() : 'local';
let secretsSource = 'env';

app.use(helmet());
app.use(cors());
app.use(morgan('dev'));
app.use(express.json());

// Sample in-memory data
const books = [
  { id: 1, title: 'Ramayana', author: 'Valmiki', year: -500 },
  { id: 2, title: 'Mahabharata', author: 'Vyasa', year: -400 },
  { id: 3, title: 'Bhagavad Gita', author: 'Vyasa', year: -200 },
];

// 1. Health check (also useful for OCI load balancer / container probes)
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    cloud: 'oci',
    version: APP_VERSION,
    secretsSource,
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

// 2. List all books
app.get('/api/books', (req, res) => {
  res.json({ count: books.length, data: books });
});

// 3. Get a single book by id
app.get('/api/books/:id', (req, res) => {
  const book = books.find((b) => b.id === Number(req.params.id));
  if (!book) {
    return res.status(404).json({ error: 'Book not found' });
  }
  res.json(book);
});

app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

async function start() {
  secretsSource = await loadSecrets();
  const server = app.listen(PORT, () =>
    console.log(`Server ${APP_VERSION} running on port ${PORT} (secrets: ${secretsSource})`)
  );
  // systemd sends SIGTERM on stop/restart during a deployment
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
}

if (require.main === module) {
  start().catch((err) => {
    console.error('Failed to start:', err);
    process.exit(1);
  });
}

module.exports = app;
```

### A.3 `src/secrets.js`

See [Step 0.4](#04-new-file-srcsecretsjs-secrets-manager--oci-vault) (unchanged since).

### A.4 Tests

`test/api.test.js`:

```js
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
```

`test/secrets.test.js`: see [Step 0.7](#07-new-test-testsecretstestjs).

### A.5 `build_spec.yaml`

```yaml
# OCI DevOps build spec (replaces AWS CodeBuild buildspec.yml)
version: 0.1
component: build
timeoutInSeconds: 900
runAs: root
shell: bash

env:
  variables:
    NODE_VERSION: "20"
  # Exported variables flow to the Deliver Artifacts stage and, via the
  # Trigger Deployment stage, into the deploy pipeline as parameters.
  exportedVariables:
    - BUILDRUN_HASH

steps:
  - type: Command
    name: "Set build version"
    timeoutInSeconds: 60
    command: |
      export BUILDRUN_HASH=$(echo ${OCI_BUILD_RUN_ID} | rev | cut -c 1-7)
      echo "Build hash: ${BUILDRUN_HASH}"

  - type: Command
    name: "Set up Node.js"
    timeoutInSeconds: 300
    command: |
      # Build runners ship with nvm; fall back to installing it if missing
      export NVM_DIR="$HOME/.nvm"
      if [ ! -s "$NVM_DIR/nvm.sh" ]; then
        curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
      fi
      source "$NVM_DIR/nvm.sh"
      nvm install ${NODE_VERSION}
      nvm use ${NODE_VERSION}
      node -v && npm -v

  - type: Command
    name: "Install dependencies"
    timeoutInSeconds: 300
    command: |
      source "$HOME/.nvm/nvm.sh"
      nvm use ${NODE_VERSION}
      npm ci

  - type: Command
    name: "Run tests"
    timeoutInSeconds: 300
    command: |
      source "$HOME/.nvm/nvm.sh"
      nvm use ${NODE_VERSION}
      npm test

  - type: Command
    name: "Package application"
    timeoutInSeconds: 300
    onFailure:
      - type: Command
        command: echo "Packaging failed"
        timeoutInSeconds: 60
    command: |
      source "$HOME/.nvm/nvm.sh"
      nvm use ${NODE_VERSION}
      npm prune --omit=dev
      echo "${BUILDRUN_HASH}" > VERSION
      zip -qr app.zip src package.json package-lock.json node_modules VERSION
      ls -lh app.zip

outputArtifacts:
  # Delivered to Artifact Registry as generic artifacts, version ${BUILDRUN_HASH}
  - name: app_zip
    type: BINARY
    location: ${OCI_PRIMARY_SOURCE_DIR}/app.zip

  - name: deploy_spec
    type: BINARY
    location: ${OCI_PRIMARY_SOURCE_DIR}/deployment/deploy_spec.yaml
```

### A.6 `deployment/deploy_spec.yaml`

```yaml
# OCI DevOps instance group deployment spec (replaces AWS CodeDeploy appspec.yml)
#
# Runs on each Compute instance via the Oracle Cloud Agent "Compute Instance
# Run Command" plugin. ${...} values are deploy pipeline parameters, so the
# DevOps artifact holding this file must have "Allow parameterization" = Yes.
# Parameter names may not start with "OCI" (reserved), hence VAULT_ID / SECRET_NAME.
# DevOps treats every ${...} as a pipeline parameter, so step commands use
# plain $VAR for the env variables below to avoid "Value is missing" warnings.
#
# With runAs: root the agent wraps only the FIRST line of a command in
# `sudo -E`; later lines run as the unprivileged ocarun user. Each step
# therefore starts a root bash on line 1 and feeds the script via a heredoc.
version: 1.0
component: deployment
runAs: root
env:
  variables:
    APP_NAME: "oci-node-app"
    APP_ROOT: "/opt/oci-node-app"
    RELEASE: "${BUILDRUN_HASH}"
    VAULT_ID: "${VAULT_ID}"
    SECRET_NAME: "${SECRET_NAME}"

files:
  # All artifacts selected in the deploy stage are copied here (app.zip)
  - source: /
    destination: /tmp/oci-node-app-incoming

steps:
  - stepType: Command
    name: "Unpack release"
    timeoutInSeconds: 120
    command: |
      bash -euo pipefail <<'SCRIPT'
      ZIP=/tmp/oci-node-app-incoming/app.zip
      [ -f "$ZIP" ] || { echo "No app.zip in /tmp/oci-node-app-incoming"; ls -la /tmp/oci-node-app-incoming; exit 1; }
      DEST="$APP_ROOT/releases/$RELEASE"
      rm -rf "$DEST" && mkdir -p "$DEST"
      unzip -q "$ZIP" -d "$DEST"
      chown -R nodeapp:nodeapp "$DEST"
      rm -rf /tmp/oci-node-app-incoming
      echo "Unpacked $RELEASE to $DEST"
      SCRIPT

  - stepType: Command
    name: "Write runtime config"
    timeoutInSeconds: 60
    command: |
      bash -euo pipefail <<'SCRIPT'
      # Only non-secret config goes on disk; secrets are read from Vault at startup
      mkdir -p /etc/$APP_NAME
      cat > /etc/$APP_NAME/app.env <<EOF
      NODE_ENV=production
      PORT=3000
      SECRETS_PROVIDER=oci-vault
      OCI_VAULT_ID=$VAULT_ID
      OCI_SECRET_NAME=$SECRET_NAME
      EOF
      chmod 640 /etc/$APP_NAME/app.env
      chown root:nodeapp /etc/$APP_NAME/app.env
      echo "Wrote /etc/$APP_NAME/app.env"
      SCRIPT

  - stepType: Command
    name: "Switch release and restart"
    timeoutInSeconds: 120
    command: |
      bash -euo pipefail <<'SCRIPT'
      cd "$APP_ROOT"
      # Remember the previous release so the health check can roll back
      if [ -L current ]; then readlink current > previous_release; fi
      ln -sfn "releases/$RELEASE" current
      systemctl restart $APP_NAME
      echo "current -> releases/$RELEASE, service restarted"
      SCRIPT

  - stepType: Command
    name: "Health check (roll back on failure)"
    timeoutInSeconds: 240
    command: |
      bash -uo pipefail <<'SCRIPT'
      cd "$APP_ROOT"
      # Up to ~150s: startup plus the Vault call is slow on 1/8-OCPU micro shapes
      for i in $(seq 1 50); do
        if curl -fsS http://127.0.0.1:3000/health | grep -q "\"version\":\"$RELEASE\""; then
          echo "Release $RELEASE is healthy"
          # Keep the 5 most recent releases
          ls -1dt releases/* | tail -n +6 | xargs -r rm -rf
          exit 0
        fi
        sleep 3
      done
      echo "Health check failed for $RELEASE"
      journalctl -u $APP_NAME -n 50 --no-pager || true
      if [ -s previous_release ]; then
        echo "Rolling back to $(cat previous_release)"
        ln -sfn "$(cat previous_release)" current
        systemctl restart $APP_NAME
      fi
      exit 1
      SCRIPT
```

### A.7 `infra/cloud-init.sh`

```bash
#!/bin/bash
# Bootstrap for the OCI Compute instance (replaces EC2 user-data).
# Paste into: Create instance > Advanced options > Management > Cloud-init script.
# Tested target image: Oracle Linux 8.
set -euxo pipefail

APP_NAME=oci-node-app
APP_ROOT=/opt/${APP_NAME}

# Node.js 20 from the official tarball. dnf gets OOM-killed on 1 GB shapes
# (VM.Standard.E2.1.Micro); unzip/curl/xz already ship with the OL8 image.
NODE_DIST=https://nodejs.org/dist/latest-v20.x
NODE_ARCH=$(uname -m | sed 's/x86_64/x64/;s/aarch64/arm64/')
if ! command -v node >/dev/null; then
  cd /tmp
  curl -fsSLO ${NODE_DIST}/SHASUMS256.txt
  NODE_TARBALL=$(awk "/linux-${NODE_ARCH}.tar.xz\$/ {print \$2}" SHASUMS256.txt)
  curl -fsSLO ${NODE_DIST}/${NODE_TARBALL}
  grep " ${NODE_TARBALL}\$" SHASUMS256.txt | sha256sum -c -
  tar -xJf ${NODE_TARBALL} -C /usr/local --strip-components=1 --no-same-owner
  ln -sf /usr/local/bin/node /usr/bin/node
  rm -f ${NODE_TARBALL} SHASUMS256.txt
fi
node -v

# The hourly dnf metadata refresh swaps a 1 GB shape to a standstill (and gets
# OOM-killed); patch via OS Management or a manual `dnf update` instead.
systemctl disable --now dnf-makecache.timer

# Unprivileged service user
id nodeapp &>/dev/null || useradd --system --home-dir ${APP_ROOT} --shell /sbin/nologin nodeapp
mkdir -p ${APP_ROOT}/releases /etc/${APP_NAME}
chown -R nodeapp:nodeapp ${APP_ROOT}
touch /etc/${APP_NAME}/app.env

# systemd unit (replaces pm2 / CodeDeploy start scripts on EC2)
cat > /etc/systemd/system/${APP_NAME}.service <<EOF
[Unit]
Description=${APP_NAME}
After=network-online.target
Wants=network-online.target

[Service]
User=nodeapp
WorkingDirectory=${APP_ROOT}/current
EnvironmentFile=/etc/${APP_NAME}/app.env
ExecStart=/usr/bin/node src/server.js
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable ${APP_NAME}

# The deployment spec uses runAs: root, which the Run Command agent user
# (ocarun) performs through sudo. Narrow this down for production.
echo "ocarun ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/101-oracle-cloud-agent-run-command
chmod 440 /etc/sudoers.d/101-oracle-cloud-agent-run-command

# Open the app port (the VCN security list / NSG must allow it too)
firewall-cmd --permanent --add-port=3000/tcp
firewall-cmd --reload
```

### A.8 `infra/iam-policies.txt`

```
# Replace <compartment-ocid> / <compartment-name> before use.
# Identity > Domains > Default > Dynamic groups

## Dynamic group: devops-dg  (DevOps service resources — replaces CodeStar/CodePipeline service roles)
# Single rule (paste into one rule box):
ALL {resource.compartment.id = '<compartment-ocid>', ANY {resource.type = 'devopsbuildpipeline', resource.type = 'devopsdeploypipeline', resource.type = 'devopsrepository', resource.type = 'devopsconnection', resource.type = 'devopstrigger'}}

## Dynamic group: app-instances-dg  (Compute instances — replaces the EC2 instance profile/role)
ALL {instance.compartment.id = '<compartment-ocid>'}


# Identity > Policies  (create in the same compartment)

## devops-policy
Allow dynamic-group devops-dg to manage devops-family in compartment <compartment-name>
Allow dynamic-group devops-dg to manage generic-artifacts in compartment <compartment-name>
Allow dynamic-group devops-dg to read all-artifacts in compartment <compartment-name>
Allow dynamic-group devops-dg to manage repos in compartment <compartment-name>
Allow dynamic-group devops-dg to use ons-topics in compartment <compartment-name>
Allow dynamic-group devops-dg to read secret-family in compartment <compartment-name>
Allow dynamic-group devops-dg to read instance-family in compartment <compartment-name>
Allow dynamic-group devops-dg to use instance-agent-command-execution-family in compartment <compartment-name>
Allow dynamic-group devops-dg to manage instance-agent-command-family in compartment <compartment-name>
Allow dynamic-group devops-dg to use load-balancers in compartment <compartment-name>
Allow dynamic-group devops-dg to use virtual-network-family in compartment <compartment-name>

## app-instances-policy
Allow dynamic-group app-instances-dg to use instance-agent-command-execution-family in compartment <compartment-name> where request.instance.id = target.instance.id
Allow dynamic-group app-instances-dg to read generic-artifacts in compartment <compartment-name>
Allow dynamic-group app-instances-dg to read all-artifacts in compartment <compartment-name>
Allow dynamic-group app-instances-dg to read secret-bundles in compartment <compartment-name> where target.secret.name = 'oci-node-app-secrets'
```

> The console policy (Step 3 + Step 30) omits `use load-balancers` because no LB is used yet; add it when a Load Balancer is introduced.

### A.9 Other files

`.env.example`

```
PORT=3000

# Local dev reads secrets from this file. On OCI Compute set
# SECRETS_PROVIDER=oci-vault and the app pulls them from OCI Vault instead.
SECRETS_PROVIDER=env
# OCI_VAULT_ID=ocid1.vault.oc1..xxxx
# OCI_SECRET_NAME=oci-node-app-secrets
```

`.gitignore`

```
node_modules/
.env
*.log
```

`.dockerignore`

```
node_modules
npm-debug.log
.env
.git
test
```

`Dockerfile` (unchanged; kept for a future container target)

```dockerfile
FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src

ENV PORT=3000
EXPOSE 3000

USER node
CMD ["node", "src/server.js"]
```

### A.10 Files generated on the instance

`/etc/systemd/system/oci-node-app.service` (by cloud-init):

```ini
[Unit]
Description=oci-node-app
After=network-online.target
Wants=network-online.target

[Service]
User=nodeapp
WorkingDirectory=/opt/oci-node-app/current
EnvironmentFile=/etc/oci-node-app/app.env
ExecStart=/usr/bin/node src/server.js
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
```

`/etc/oci-node-app/app.env` (by deploy step 2; mode 640, root:nodeapp):

```
NODE_ENV=production
PORT=3000
SECRETS_PROVIDER=oci-vault
OCI_VAULT_ID=ocid1.vault.oc1.ap-mumbai-1.fbvmsmczaagaq.abrg6ljrzlnodjnuqdxhmcnk7rniqo4g5dypo67a3t3zsulqsoskmtq4s4oq
OCI_SECRET_NAME=oci-node-app-secrets
```

`/etc/sudoers.d/101-oracle-cloud-agent-run-command`:

```
ocarun ALL=(ALL) NOPASSWD:ALL
```

Directory layout:

```
/opt/oci-node-app/
├── current -> releases/a5dathv
├── previous_release          # "releases/afpwzkg"
└── releases/
    ├── a5dathv/  (src/, node_modules/, package*.json, VERSION)
    ├── afpwzkg/
    └── am5p336/
```

---

## Appendix B: Git commit history

| Commit | Time (IST) | Message | Step |
|---|---|---|---|
| `9f7d039` | 2026-10-09 23:31 | OCI DevOps CI/CD demo: build, deploy to Compute, Vault secrets | 0 |
| `dfaff30` | 2026-10-10 00:14 | Fix devops-dg matching rule: single ALL rule scoped to compartment | 1 |
| `989cd5d` | 2026-10-10 01:23 | cloud-init: add swap on <2 GB shapes so E2.1.Micro can install Node.js | 23e |
| `684b4df` | 2026-10-10 09:35 | cloud-init: install Node.js from official tarball instead of dnf | 24 |
| `bd1a4c6` | 2026-10-10 09:41 | Rename deploy params to VAULT_ID/SECRET_NAME (OCI prefix is reserved) | 26 |
| `7706e13` | 2026-10-10 10:04 | Fix first deploy: run-command IAM, unbraced spec vars, longer health check | 29 |
| `cc69957` | 2026-10-10 10:06 | cloud-init: disable dnf-makecache timer (OOM-thrashes 1 GB shapes) | 29a |
| `0aed49b` | 2026-10-10 12:02 | deploy_spec: run each step as root via bash heredoc | 31 |
| `1e6a23e` | 2026-10-10 12:16 | health: report cloud=oci (end-to-end trigger test) | 34 |

All commits authored as `Krunal Prajapati <krunalgadgetguru@gmail.com>` with trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

## Appendix C: Issues encountered and fixes

| # | Step | Symptom | Root cause | Fix |
|---|---|---|---|---|
| 1 | 1 | `Unable to parse matching rule 'Any {ANY {...} ANY {...}}'` | Five rules pasted in one box; `ANY {type, compartment}` also over-broad | Single rule `ALL {compartment, ANY {types}}` |
| 2 | 6 | No *Create secret* button in Vault page | New Console moved secrets to **Secret Management** | *Identity & Security → Secret Management* |
| 3 | 9 | Log group dropdown empty | No log group existed | **Create new group** in the panel |
| 4 | 19 | "Build config/result artifact name can not be empty" | Needs `outputArtifacts.name` | `app_zip`, `deploy_spec` |
| 5 | 23 | `Out of capacity` A1.Flex, E4.Flex in AD-1 | Mumbai single AD, trial capacity | Retry later; E2.1.Micro succeeded |
| 6 | 23 | `Too many requests for the user` | Rapid create retries | Wait ~15 min; one attempt at a time |
| 7 | 23c | `zsh: no matches found: ~/Downloads/ssh-key-*.key` | Browser named key `oci-node-app.key` | `mv -n ~/Downloads/oci-node-app.key* ~/.ssh/` |
| 8 | 24 | cloud-init `status: error`, `dnf ... Killed` | `dnf` OOM on 1 GB | Node.js tarball install, no `dnf` |
| 9 | 26 | Parameter `OCI_VAULT_ID` rejected | `OCI` prefix reserved | `VAULT_ID`, `SECRET_NAME` |
| 10 | 29 | `Unable to create run command for instance` | Missing create permission | `manage instance-agent-command-family` |
| 11 | 29 | `Value is missing for the placeholders` | `${VAR}` in spec treated as pipeline params | `$VAR` in step commands |
| 12 | 29a | SSH/HTTP timeouts, load ≈44 | Hourly `dnf-makecache` OOM thrash | `systemctl disable --now dnf-makecache.timer` |
| 13 | 31 | `sudo: set: command not found`, `Permission denied` | `runAs: root` sudo-wraps only line 1 | `bash -euo pipefail <<'SCRIPT'` per step |
| 14 | 29 | "Deployments" tab not on project page | New Console layout | *Latest deployment pipelines → pipeline → Deployments* |

---

## Appendix D: Operations cheat sheet

```bash
# SSH to the instance
ssh -i ~/.ssh/oci-node-app.key opc@80.225.250.143

# App health / API
curl -s http://80.225.250.143:3000/health
curl -s http://80.225.250.143:3000/api/books
curl -s http://80.225.250.143:3000/api/books/1

# Service status and logs (on the VM)
systemctl status oci-node-app --no-pager
sudo journalctl -u oci-node-app -n 50 --no-pager
sudo journalctl -u oci-node-app -f

# Current / previous / available releases (on the VM)
ls -l /opt/oci-node-app/current
cat /opt/oci-node-app/previous_release
ls -1t /opt/oci-node-app/releases

# Manual rollback (on the VM)
sudo ln -sfn releases/<previous-hash> /opt/oci-node-app/current
sudo systemctl restart oci-node-app
curl -s http://127.0.0.1:3000/health

# Deployment step output written by the Run Command agent (on the VM)
sudo ls /var/lib/ocarun/commands/wd/latestDeployment/
sudo find -L /var/lib/ocarun/commands/wd/latestDeployment -name stdout -exec tail -60 {} \;

# Runtime config (on the VM)
sudo cat /etc/oci-node-app/app.env

# Resource checks (on the VM)
uptime; free -m
systemctl list-timers --all --no-pager | grep -Ei "dnf|makecache"
sudo journalctl --since "-60min" --no-pager | grep -Ei "oom-kill|Killed process"

# Redeploy a specific build version without rebuilding:
#   Console → oci-node-app-deploy → Run pipeline → set BUILDRUN_HASH=<hash>
```

Release flow from a developer's machine:

```bash
git add -A
git commit -m "<change>"
git push origin main          # trigger → build → deploy (≈9 min)
```

---

## Appendix E: Production hardening checklist

| Area | Demo state | Production recommendation |
|---|---|---|
| Ingress | TCP 3000 open to `0.0.0.0/0` | OCI Load Balancer (HTTPS 443) in front; restrict instance NSG to LB subnet |
| Availability | 1 × E2.1.Micro, single FD | ≥2 instances across fault domains (or regions with multiple ADs); flexible shapes |
| Subnet | Public subnet, public IP | Private subnet + NAT; Bastion service for SSH |
| sudo | `ocarun ALL=(ALL) NOPASSWD:ALL` | Restrict to required commands (`systemctl restart oci-node-app`, `unzip`, `ln`, `chown`, ...) |
| Dynamic group `app-instances-dg` | All instances in compartment | Match by instance tag or specific OCIDs |
| Patching | `dnf-makecache` disabled | OS Management Hub / scheduled patch windows (larger shapes can keep the timer) |
| Rollback | In-spec symlink rollback | Also enable stage **automatic rollback** and LB-based blue/green |
| Approvals | None | Add an **Approval** stage before production deploy |
| Secrets | JSON secret, read at startup | Rotation policy; scope `read secret-bundles` per secret (already scoped) |
| GitHub token | Classic PAT, 90 days | Fine-grained PAT or GitHub App; rotation reminder |
| Monitoring | Health endpoint only | OCI Monitoring alarms (CPU, memory, HTTP checks), Logging Analytics, budget alerts |
| Infrastructure | Console click-ops | Terraform / OCI Resource Manager for all resources in this runbook |

---

## Appendix F: Cost notes

| Resource | Cost |
|---|---|
| `VM.Standard.E2.1.Micro` | Always Free |
| VCN, subnets, IGW, NAT GW, Service GW, security lists | Free |
| Vault (default, non-private) + software key | Free |
| Secrets | Free tier covers this usage |
| DevOps build minutes | Small; covered by trial credits |
| Artifact Registry storage | A few MB per build (pennies) |
| Logging | Within free tier at this volume |

Check credits: *Profile → Tenancy → Billing & Cost Management → Subscriptions* (or *Upgrade and Manage Payment*). Spend breakdown: *Billing & Cost Management → Cost Analysis* (group by Service). Alerts: *Budgets → Create Budget* (root compartment, e.g. USD 5/month, alert at 50%).

---

## Appendix G: Teardown

Delete in this order to avoid dependency errors:

1. GitHub: *Settings → Webhooks* → delete the OCI webhook; revoke the PAT `oci-devops-oci-node-app`.
2. DevOps project `oci-node-app`: delete trigger → build pipeline (stages first) → deploy pipeline (stage first) → environment → artifacts → external connection → project.
3. Compute: terminate `oci-node-app-vm-1` (tick *Permanently delete the attached boot volume*).
4. Networking: delete `oci-node-app-vcn` (the *Delete* action removes subnets, gateways, route tables and security lists).
5. Artifact Registry: delete `oci-node-app-artifacts`.
6. Logging: delete log `Project_all` and log group `oci-node-app-logs`.
7. Notifications: delete `oci-node-app-topic`.
8. Vault: schedule deletion of secrets `oci-node-app-secrets` and `github-pat`, key `oci-node-app-key`, then vault `oci-node-app-vault` (minimum 7-day pending period).
9. IAM: delete policy `oci-node-app-policy`, dynamic groups `devops-dg` and `app-instances-dg`.
10. Compartment `oci-node-app-demo` (must be empty).
11. Local: `rm ~/.ssh/oci-node-app.key ~/.ssh/oci-node-app.key.pub` and remove `80.225.250.143` from `~/.ssh/known_hosts` (`ssh-keygen -R 80.225.250.143`).
