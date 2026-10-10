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
