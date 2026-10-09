# oci-node-app

Demo Express API showing an **AWS → OCI migration** of a Node.js app with an
end-to-end CI/CD pipeline on **OCI DevOps**: commit → build & test → publish
artifacts → deploy to Compute → health check (with automatic rollback).

## AWS → OCI service mapping

| AWS (current)                          | OCI (target)                                   | In this repo |
|----------------------------------------|------------------------------------------------|--------------|
| CodeStar (project wrapper)             | DevOps Project                                 | console setup below |
| CodeCommit / GitHub connection         | DevOps Code Repository / external connection   | — |
| CodeBuild `buildspec.yml`              | Build pipeline, Managed Build stage            | [build_spec.yaml](build_spec.yaml) |
| S3 artifact bucket                     | Artifact Registry (generic artifacts)          | `app_zip`, `deploy_spec` outputs |
| CodeDeploy `appspec.yml` + hooks       | Deploy pipeline, Instance Group deployment spec| [deployment/deploy_spec.yaml](deployment/deploy_spec.yaml) |
| CodePipeline trigger on push           | DevOps Trigger                                 | console setup below |
| EC2 instance                           | Compute instance (Oracle Linux 8)              | [infra/cloud-init.sh](infra/cloud-init.sh) |
| EC2 user-data                          | Cloud-init script                              | [infra/cloud-init.sh](infra/cloud-init.sh) |
| EC2 instance profile (IAM role)        | Dynamic group + policy (Instance Principals)   | [infra/iam-policies.txt](infra/iam-policies.txt) |
| CodeDeploy agent                       | Oracle Cloud Agent "Compute Instance Run Command" plugin | enabled on the instance |
| Secrets Manager                        | OCI Vault secret                               | [src/secrets.js](src/secrets.js) |
| SNS (pipeline notifications)           | Notifications (ONS topic)                      | required by DevOps project |

## Pipeline flow

```
git push ─► Trigger ─► Build pipeline
                        1. Managed Build (build_spec.yaml): npm ci, npm test, zip
                        2. Deliver Artifacts: app.zip + deploy_spec.yaml ─► Artifact Registry (version = BUILDRUN_HASH)
                        3. Trigger Deployment ─► Deploy pipeline (BUILDRUN_HASH passed as parameter)
                                                  Instance Group stage runs deploy_spec.yaml on each instance:
                                                  unpack ─► write config ─► switch symlink + restart ─► /health check
                                                  (health check fails ─► roll back to previous release, stage fails)
```

On the instance:
```
/opt/oci-node-app/releases/<hash>/   one directory per deployed build (last 5 kept)
/opt/oci-node-app/current ─► releases/<hash>
/etc/oci-node-app/app.env            non-secret config (vault id, secret name)
systemd unit: oci-node-app
```

## Secrets (Secrets Manager → OCI Vault)

The app keeps the AWS pattern of **one secret containing a JSON object of
key/value pairs**. At startup, when `SECRETS_PROVIDER=oci-vault`, [src/secrets.js](src/secrets.js)
uses Instance Principals to read the secret and loads each key into
`process.env`. The rest of the code keeps reading `process.env.X`, exactly as it did on AWS.
Secret values are never written to disk or to pipeline logs.

Locally, `SECRETS_PROVIDER=env` (the default) reads from `.env` instead.

## Endpoints
| Method | Path             | Description                                  |
|--------|------------------|----------------------------------------------|
| GET    | `/health`        | Health check, deployed version, secrets source |
| GET    | `/api/books`     | List all books                               |
| GET    | `/api/books/:id` | Get one book by id                           |

## Run locally
```bash
nvm install 20 && nvm use 20
npm install
cp .env.example .env
npm run dev          # or: npm start
npm test
```
Then open http://localhost:3000/api/books

## OCI setup (one-time, console)

Use one compartment for everything, e.g. `oci-node-app-demo`.

1. **IAM**: create the two dynamic groups and two policies in
   [infra/iam-policies.txt](infra/iam-policies.txt).
2. **Vault**: *Identity & Security > Vault* → create a vault and a master
   encryption key → create a secret named `oci-node-app-secrets` with JSON
   content, e.g. `{"API_KEY":"demo-123"}`. Note the **vault OCID**.
3. **Compute**: create an Oracle Linux 8 instance:
   - *Advanced options > Management*: paste [infra/cloud-init.sh](infra/cloud-init.sh).
   - *Oracle Cloud Agent* tab: enable **Compute Instance Run Command**.
   - Allow TCP 3000 ingress in the subnet's security list/NSG (or put a Load Balancer in front).
4. **Notifications**: create an ONS topic (the DevOps project requires one).
5. **Artifact Registry**: create a repository, e.g. `oci-node-app-artifacts`.
6. **DevOps project**: *Developer Services > DevOps > Create project* (select the topic).
   Enable logging for the project.
7. **Code**: push this repo to a DevOps Code Repository (or add a GitHub/GitLab
   connection and mirror it).
8. **DevOps artifacts** (*Project > Artifacts > Add artifact*), all with
   **Allow parameterization = Yes**:
   | Name           | Type                                       | Source                   | Path / version |
   |----------------|--------------------------------------------|--------------------------|----------------|
   | `app-zip`      | General artifact                           | Artifact Registry repo   | `app.zip` / `${BUILDRUN_HASH}` |
   | `deploy-spec`  | Instance group deployment configuration    | Artifact Registry repo   | `deploy_spec.yaml` / `${BUILDRUN_HASH}` |
9. **Environment** (*Project > Environments*): type **Instance group**, select
   the instance(s) from step 3.
10. **Deploy pipeline**:
    - Parameters: `BUILDRUN_HASH` (default `latest`), `OCI_VAULT_ID` (= vault OCID),
      `OCI_SECRET_NAME` (= `oci-node-app-secrets`).
    - Stage: **Deploy incrementally through Compute instance group** → environment
      from step 9, deployment configuration `deploy-spec`, artifact `app-zip`,
      rollout by count = 1.
11. **Build pipeline** with three stages:
    1. **Managed Build**: build spec `build_spec.yaml`, primary repo = your repo/branch.
    2. **Deliver artifacts**: `app_zip` → `app-zip`, `deploy_spec` → `deploy-spec`.
    3. **Trigger deployment**: deploy pipeline from step 10, *Send build pipeline parameters* = Yes.
12. **Trigger** (*Project > Triggers*): on push to `main` → run the build pipeline.
13. Push a commit (or *Start manual run*), then:
    ```bash
    curl http://<instance-public-ip>:3000/health
    # {"status":"ok","version":"<BUILDRUN_HASH>","secretsSource":"oci-vault",...}
    ```

## Migrating the real app: checklist
- Replace `@aws-sdk/client-secrets-manager` calls with [src/secrets.js](src/secrets.js) (same JSON secret shape).
- Search the code for other `@aws-sdk/*` / `aws-sdk` usage, e.g. S3 → Object Storage
  (S3-compatible API with Customer Secret Keys, or `oci-objectstorage`) and SQS → OCI Queue.
- Move CodeBuild env vars to `build_spec.yaml` (`env.variables` / `env.vaultVariables`).
- Port CodeDeploy hooks (`BeforeInstall`, `ApplicationStart`, `ValidateService`)
  into steps of [deployment/deploy_spec.yaml](deployment/deploy_spec.yaml).
- Replace the EC2 instance role with the dynamic group + policies.
- Production hardening: narrow the `ocarun` sudoers rule, put a Load Balancer in front of
  2+ instances, and use private subnets with a bastion.

## Container option
The [Dockerfile](Dockerfile) is kept for a later move to OKE or Container Instances.
That path would add a `docker build` step in the build spec and deliver the image
to OCIR as `<region-key>.ocir.io/<namespace>/oci-node-app:${BUILDRUN_HASH}`.
