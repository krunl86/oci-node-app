#!/bin/bash
# Bootstrap for the OCI Compute instance (replaces EC2 user-data).
# Paste into: Create instance > Advanced options > Management > Cloud-init script.
# Tested target image: Oracle Linux 8.
set -euxo pipefail

APP_NAME=oci-node-app
APP_ROOT=/opt/${APP_NAME}

# Small shapes (e.g. VM.Standard.E2.1.Micro, 1 GB) need swap for dnf to finish
if [ "$(awk '/MemTotal/ {print $2}' /proc/meminfo)" -lt 2000000 ] && [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# Node.js 20 runtime + tools used by the deployment spec
dnf module reset -y nodejs
dnf module enable -y nodejs:20
dnf install -y nodejs unzip curl

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
