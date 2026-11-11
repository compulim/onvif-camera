#!/bin/sh
# Installs MediaMTX for the ONVIF server. Skip this if MediaMTX is already
# installed and serves the "camera" path over RTSP.
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "Run with sudo: sudo sh install-mediamtx.sh /absolute/path/to/mediamtx" >&2
  exit 1
fi
if [ "$#" -ne 1 ] || [ ! -x "$1" ]; then
  echo "Supply an executable MediaMTX v1.21.3 binary for this Linux architecture." >&2
  exit 1
fi

# Use system-wide tools, including administrative commands such as useradd.
PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
export PATH
for command in systemctl useradd install; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Missing prerequisite: $command (see README.md)" >&2
    exit 1
  fi
done

source_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
app=/opt/rpi-onvif-camera
config=/etc/rpi-onvif-camera
if ! id onvif-camera >/dev/null 2>&1; then
  useradd --system --user-group --create-home --home-dir /var/lib/rpi-onvif-camera --shell /usr/sbin/nologin onvif-camera
fi
install -d -m 0755 "$app" "$app/bin"
install -d -m 0750 -o root -g onvif-camera "$config"
install -m 0755 "$1" "$app/bin/mediamtx"

# Preserve local configuration on upgrades.
if [ ! -e "$config/mediamtx.yml" ]; then
  install -m 0640 -o root -g onvif-camera "$source_dir/deploy/mediamtx.yml" "$config/mediamtx.yml"
fi
install -m 0644 "$source_dir/deploy/rpi-onvif-mediamtx.service" /etc/systemd/system/
systemctl daemon-reload
echo "Installed MediaMTX. Edit $config/mediamtx.yml, then run:"
echo "sudo systemctl enable --now rpi-onvif-mediamtx.service"
