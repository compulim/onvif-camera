# rpi-onvif-camera

Emulate a fixed, read-only ONVIF camera on Raspberry Pi OS or another systemd-based
Linux host. FFmpeg or mpv ingests a file/URL, MediaMTX serves its H.264/AAC stream
over RTSP, and Node.js provides ONVIF Device/Media1 SOAP and WS-Discovery.

This is an ONVIF-compatible emulator, **not an ONVIF-certified device**. It supports
one fixed profile, discovery, device information, UTC time, services/capabilities,
source/encoder configuration queries, encoder options, and `GetStreamUri`.
PTZ, events, snapshots, recording, and configuration writes are not implemented;
unsupported operations return SOAP faults.

## Install on Raspberry Pi OS / Debian

1. Install **Node.js 22 or newer and npm system-wide**, with `node` on
   `/usr/local/bin` or `/usr/bin`. A per-user nvm installation is not accessible
   to the service. Check `node --version`; older Raspberry Pi OS repositories
   may need a newer Node.js installation. A 64-bit OS is recommended.
2. Install media tools:

   ```sh
   sudo apt-get update
   sudo apt-get install ffmpeg mpv ca-certificates
   ```

3. Download **MediaMTX v1.21.3** from the
   [upstream release](https://github.com/bluenviron/mediamtx/releases/tag/v1.21.3).
   Select the Linux archive matching your **OS** (`dpkg --print-architecture`):
   `arm64` → `linux_arm64`, `armhf` → `linux_armv7`, or `amd64` → `linux_amd64`.
   Check its SHA-256 against the release's checksums, then extract the `mediamtx`
   executable. The installer does not fetch or execute remote installation scripts.
4. From this checkout, install the application and units:

   ```sh
   sudo sh ./install.sh /absolute/path/to/mediamtx
   sudoedit /etc/rpi-onvif-camera/camera.env
   sudoedit /etc/rpi-onvif-camera/mediamtx.yml
   ```

   Set `CAMERA_ADDRESS` to the Pi's LAN IPv4 address (use a DHCP reservation) and
   `CAMERA_SOURCE` to a readable absolute filename or URL. Put media under
   `/var/lib/rpi-onvif-camera`, not a home directory: service hardening hides
   `/home` and `/root`. For example:

   ```sh
   sudo install -o onvif-camera -g onvif-camera -m 0640 ./input.mp4 \
     /var/lib/rpi-onvif-camera/input.mp4
   sudo systemctl enable --now rpi-onvif-mediamtx.service rpi-onvif-camera.service
   ```

The installer creates an unprivileged `onvif-camera` account, installs under
`/opt/rpi-onvif-camera`, and preserves both configuration files on upgrades.
Re-run it to upgrade, then restart both services. Services restart after failures,
including failed media publishers; stopping the camera terminates its players.

## Configuration

See [`deploy/camera.env.example`](deploy/camera.env.example) for all settings.
The file is a systemd EnvironmentFile, **not a shell script**; do not use `export`
or shell substitutions.

| Variable | Default | Meaning |
| --- | --- | --- |
| `CAMERA_ADDRESS` | required | LAN IPv4 address advertised to clients; never localhost |
| `CAMERA_ID` | LAN address | Unique stable identity; set this to survive address changes |
| `CAMERA_NAME` | Raspberry Pi Camera | Display name |
| `CAMERA_PLAYER` | `ffmpeg` | `ffmpeg`, `mpv`, or `external` |
| `CAMERA_SOURCE` | required for managed players | Media file or URL |
| `CAMERA_WIDTH`, `CAMERA_HEIGHT` | `1280`, `720` | Output resolution |
| `CAMERA_FPS`, `CAMERA_BITRATE` | `15`, `2000` | Frame rate and video bitrate (kbit/s) |
| `CAMERA_AUDIO` | `true` | Set `false` for video-only sources |
| `CAMERA_PORT`, `CAMERA_RTSP_PORT` | `8000`, `8554` | SOAP and RTSP TCP ports |
| `CAMERA_BIND` | `0.0.0.0` | SOAP listener address |
| `CAMERA_DISCOVERY` | `true` | Enable IPv4 multicast discovery |
| `CAMERA_USERNAME`, `CAMERA_PASSWORD` | empty | Optional ONVIF UsernameToken digest credentials; set both |

Managed players loop files and normalize video to H.264 Main/yuv420p and audio
to mono AAC, 48 kHz, 64 kbit/s. **Set `CAMERA_AUDIO=false` if the source has no
audio**, so the advertised profile matches the stream. mpv uses encoding mode
to write NUT (preserving H.264/AAC codec headers) to stdout; FFmpeg paces and relays it to RTSP without another
encode. It is not interactive mpv playback or `--stream-record`.

Software H.264 encoding can be expensive on a Pi. Start at 640×360/15 fps on
slower boards and monitor CPU/temperature. Hardware encoder availability varies
by Pi model and OS; use external mode for a hardware-specific pipeline.
Managed input supports the formats/protocols enabled by your FFmpeg/mpv build.
For raw V4L2/ALSA/libcamera capture or custom input flags, use external mode.
Don't put untrusted URLs or files in the configuration.

Changing ports requires matching changes to `rtspAddress` in MediaMTX and your
firewall. Restart after configuration or network-address changes:

```sh
sudo systemctl restart rpi-onvif-mediamtx.service rpi-onvif-camera.service
```

### External publishers / live capture

Set `CAMERA_PLAYER=external` to leave media ingest to a separate process. Publish
to `rtsp://127.0.0.1:8554/camera` from the Pi, for example:

```sh
ffmpeg -re -stream_loop -1 -i input.mp4 \
  -map 0:v:0 -map '0:a:0?' -vf scale=1280:720,fps=15 \
  -c:v libx264 -preset veryfast -tune zerolatency -profile:v main \
  -pix_fmt yuv420p -b:v 2000k -g 30 -bf 0 \
  -c:a aac -b:a 64k -ar 48000 -ac 1 \
  -f rtsp -rtsp_transport tcp rtsp://127.0.0.1:8554/camera
```

Keep external video/audio parameters aligned with `CAMERA_*`; the ONVIF service
does not probe an external stream. External publishers need their own supervision.
MediaMTX permits publishing **only from loopback** by default and rejects a second
publisher. It accepts both TCP and UDP RTSP clients.

## Connect and troubleshoot

Use your NVR's ONVIF discovery on the same multicast-capable LAN, or add:

- Device endpoint: `http://PI_ADDRESS:8000/onvif/device_service`
- Media endpoint: `http://PI_ADDRESS:8000/onvif/media_service`
- Video stream: `rtsp://PI_ADDRESS:8554/camera` (VLC, ffplay, NVR)

Allow **TCP 8000/8554**, **UDP 3702** (discovery), and **UDP 8000/8001**
(RTP/RTCP) from trusted clients only. Multicast often does not cross VLANs;
manually configure the device URL in that case. No privileged ports are needed.

```sh
sudo journalctl -u rpi-onvif-camera -u rpi-onvif-mediamtx -f
curl http://PI_ADDRESS:8000/health
ffprobe -rtsp_transport tcp rtsp://PI_ADDRESS:8554/camera
```

`/health` checks HTTP liveness only; use `ffprobe` to verify media availability.
Keep the Pi's clock synchronized for WS-Security timestamp validation.

### Security

The supplied configuration allows anonymous ONVIF queries and RTSP viewing:
**use an isolated trusted camera LAN; never expose these ports to the Internet**.
Set both ONVIF credentials to require fresh WS-Security UsernameToken
PasswordDigest requests (plaintext PasswordText is rejected). UTC time remains
public for client clock synchronization. This does **not** authenticate RTSP.

For private viewing, replace the anonymous `read` permission in
`/etc/rpi-onvif-camera/mediamtx.yml` with a named user/password or an IP allowlist
using [MediaMTX authentication](https://mediamtx.org/docs/usage/authentication).
Configure RTSP credentials separately in your client; `GetStreamUri` never embeds
passwords. Neither HTTP nor default RTSP traffic is encrypted; use an isolated
network or VPN even with authentication. Configuration files are installed
root-owned, group-readable, mode 0640. Restrict source URLs containing credentials
as these can also appear in player process arguments/logs.

## Development

```sh
npm ci
npm run check
npm test
CAMERA_ADDRESS=192.168.1.20 CAMERA_PLAYER=external npm start
```

Start MediaMTX separately with `mediamtx ./deploy/mediamtx.yml`. Node tests use
local ephemeral HTTP listeners and require no media tools or physical Pi.
An actual Raspberry Pi/NVR test is still needed for performance and
client-specific compatibility.

To uninstall, disable/stop both units, remove their files from
`/etc/systemd/system`, run `sudo systemctl daemon-reload`, and remove
`/opt/rpi-onvif-camera`. Retain `/etc/rpi-onvif-camera` and
`/var/lib/rpi-onvif-camera` until you no longer need configuration/media.