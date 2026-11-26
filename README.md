# onvif-camera

Emulate a fixed, read-only ONVIF camera on Raspberry Pi OS or another
Linux host. Another device publishes an H.264 (optionally AAC) stream to MediaMTX
over SRT, MediaMTX serves it over RTSP, and Node.js provides ONVIF Device/Media1 SOAP and
WS-Discovery. FFmpeg is optional on this host: if installed, `ffprobe` detects the
stream settings and `ffmpeg` serves snapshots.

This is an ONVIF-compatible emulator, **not an ONVIF-certified device**. It supports
one fixed profile, discovery, device information, UTC time, services/capabilities,
source/encoder configuration queries, encoder options, `GetStreamUri`, and
`GetSnapshotUri` (only when FFmpeg is installed).
PTZ, events, recording, and configuration writes are not implemented;
unsupported operations return SOAP faults.

## Quick start

Requires **Node.js 22 or newer**.

1. Create `.env` and `mediamtx.yml` in the current directory (existing files are
   never overwritten):

   ```sh
   npx onvif-camera --init
   ```

2. If you do not already have an RTSP server, download
   [MediaMTX](https://github.com/bluenviron/mediamtx/releases) and run it with the
   generated configuration:

   ```sh
   ./mediamtx mediamtx.yml
   ```

3. Start the ONVIF service:

   ```sh
   npx onvif-camera
   ```

Then [publish a stream](#publishing-the-stream) to the `camera` path and add the
camera to your NVR.

## Configuration

Every setting has a default. Override them in `.env` (created by `--init` from
[`.env.example`](.env.example)) or with environment variables, which take precedence.
`CAMERA_ADDRESS` defaults to the host's first non-loopback IPv4 address; set it
explicitly on hosts with multiple interfaces.

| Variable | Default | Meaning |
| --- | --- | --- |
| `CAMERA_ADDRESS` | first non-loopback IPv4 address | LAN IPv4 address advertised to clients; never localhost |
| `CAMERA_ID` | `CAMERA_ADDRESS` | Unique stable identity, also reported by `GetHostname`; set this to survive address changes |
| `CAMERA_NAME` | onvif-camera | Display name |
| `CAMERA_MANUFACTURER` | Raspberry Pi | Manufacturer reported by `GetDeviceInformation` |
| `CAMERA_MODEL` | Camera Module | Model reported by `GetDeviceInformation` and the `hardware` scope |
| `CAMERA_FIRMWARE_VERSION` | `version` in `package.json` | Firmware version reported by `GetDeviceInformation` |
| `CAMERA_SERIAL_NUMBER` | derived from `CAMERA_ID` | Serial number reported by `GetDeviceInformation` |
| `CAMERA_HARDWARE_ID` | onvif-camera | Hardware ID reported by `GetDeviceInformation` |
| `CAMERA_WIDTH`, `CAMERA_HEIGHT` | probed, else `1920`, `1080` | Advertised resolution |
| `CAMERA_FPS`, `CAMERA_BITRATE` | probed, else `30`, `20000` | Advertised frame rate and video bitrate (kbit/s) |
| `CAMERA_AUDIO` | probed, else `true` | Set `false` for video-only streams |
| `CAMERA_AUDIO_BITRATE`, `CAMERA_AUDIO_SAMPLE_RATE` | probed, else `128`, `44100` | Advertised AAC audio bitrate (kbit/s) and sample rate (Hz, for example `48000` or `44100`) |
| `CAMERA_AUDIO_CHANNELS` | probed, else `2` | Advertised audio channels: `1` (mono) or `2` (stereo) |
| `CAMERA_PORT` | `8000` | SOAP TCP port |
| `CAMERA_RTSP_URL` | `rtsp://CAMERA_ADDRESS:8554/camera` | `rtsp://` or `rtsps://` stream URL returned by `GetStreamUri`; may point to another machine. Do not embed credentials |
| `CAMERA_BIND` | `0.0.0.0` | SOAP listener address |
| `CAMERA_DISCOVERY` | `true` | Enable IPv4 multicast discovery |
| `CAMERA_VERBOSE` | `false` | Log SOAP request and response bodies with each request's HTTP status code; passwords are redacted |
| `CAMERA_USERNAME`, `CAMERA_PASSWORD` | empty | Optional ONVIF UsernameToken digest credentials; set both |

If `ffprobe` is installed and any of `CAMERA_WIDTH`, `CAMERA_HEIGHT`, `CAMERA_FPS`,
`CAMERA_BITRATE` or `CAMERA_AUDIO*` is unset, the stream at `CAMERA_RTSP_URL` is
probed once at startup and the detected values are advertised. A stream without an
audio track is advertised as video-only. Values set explicitly always win; values
the stream does not report (RTSP rarely reports bitrates) or that are out of range
fall back to the defaults. The stream must already be published when the service
starts; otherwise, or without `ffprobe`, the configured or default values are
advertised. Keep them aligned with what is published (H.264 Main video; optional
stereo AAC, 16-bit 44.1 kHz source encoded as 128 kbit/s AAC by default).

If `ffmpeg` is installed, `GetSnapshotUri` returns
`http://CAMERA_ADDRESS:CAMERA_PORT/onvif/snapshot.jpg`, which serves a JPEG frame
grabbed from `CAMERA_RTSP_URL` (shared between requests for up to one second).
When ONVIF credentials are set, the snapshot URL also contains a secret derived
from them, so it is only obtainable through an authenticated `GetSnapshotUri`.
Without `ffmpeg`, snapshots are disabled. On Raspberry Pi OS, install both tools
with `sudo apt install ffmpeg`.

`GetStreamUri` returns `CAMERA_RTSP_URL`. Changing the MediaMTX RTSP port requires
matching `rtspAddress` in MediaMTX and the port in `CAMERA_RTSP_URL`; other MediaMTX
ports (`rtpAddress`/`rtcpAddress`, `srtAddress`) only need matching firewall rules.
If `CAMERA_RTSP_URL` points to another machine, a local MediaMTX is not needed.
Restart after configuration, stream or network-address changes.

### Publishing the stream

Publish from another device on the LAN to the `camera` path over SRT (MPEG-TS
over UDP port 8890), which has lower overhead than RTSP publishing:

```sh
ffmpeg -re -i input.mp4 -c copy -f mpegts "srt://PI_ADDRESS:8890?streamid=publish:camera&pkt_size=1316"
```

To loop an MP4 and re-encode it to match the default advertised profile
(1920x1080 at 30 FPS, 20 Mbit/s):

```sh
ffmpeg -re -stream_loop -1 -i "input.mp4" -map 0:v:0 -map 0:a:0 -vf scale=1920:1080,fps=30 -c:v libx264 -preset veryfast -profile:v main -pix_fmt yuv420p -b:v 20000k -g 30 -bf 0 -c:a aac -b:a 128k -ar 44100 -ac 2 -f mpegts "srt://PI_ADDRESS:8890?streamid=publish:camera&pkt_size=1316"
```

In your MediaMTX configuration, **restrict publishing** on the `camera` path to the
publisher's address (for example, set `ips: ["192.168.1.50/32"]` on the `publish`
entry in the sample [`mediamtx.yml`](mediamtx.yml)) so other LAN hosts cannot take
over the stream, and allow both TCP and UDP RTSP clients. If audio is published with
different settings, update `CAMERA_AUDIO_BITRATE`/`CAMERA_AUDIO_SAMPLE_RATE`/`CAMERA_AUDIO_CHANNELS`.

## Connect and troubleshoot

Use your NVR's ONVIF discovery on the same multicast-capable LAN, or add:

- Device endpoint: `http://PI_ADDRESS:8000/onvif/device_service`
- Media endpoint: `http://PI_ADDRESS:8000/onvif/media_service`
- Video stream: `rtsp://PI_ADDRESS:8554/camera` (VLC, ffplay, NVR)

Allow **TCP 8000** (ONVIF) and **UDP 3702** (discovery) on this host, and **TCP 8554**
(RTSP) and **UDP 8000/8001** (RTP/RTCP) on the MediaMTX host, from trusted clients
only, plus **UDP 8890** (SRT) from the publisher. Multicast often does not cross VLANs;
manually configure the device URL in that case. No privileged ports are needed.

```sh
curl http://PI_ADDRESS:8000/health
```

Many NVRs disable audio per channel by default; if there is no sound, enable
audio in the NVR's channel or recording settings.

### Compatibility notes

- Not every NVR supports an RTSP stream served from a different IP address than the
  ONVIF service. If yours does not, run MediaMTX on the same host and leave
  `CAMERA_RTSP_URL` unset.
- Windows 10/11 cannot discover ONVIF cameras outside the local subnet: its
  WS-Discovery probe is sent with TTL=1, so it never crosses a router. Keep the
  camera on the same subnet as the Windows PC.
- Some NVRs require a username/password and an explicit port number when adding
  the camera. Set `CAMERA_USERNAME`/`CAMERA_PASSWORD` and enter port `8000`
  (`CAMERA_PORT`).
- Windows 10/11 network camera support (for example, the Camera app) is video-only:
  it [does not support audio](https://learn.microsoft.com/windows-hardware/drivers/stream/network-cameras#unsupported-features).
  Use an NVR or open the RTSP URL directly (for example, VLC or `ffmpeg`) for audio.

`/health` checks HTTP liveness only; open the RTSP URL in a client (for example,
VLC) or check the MediaMTX log to verify the stream is being published.
Keep the Pi's clock synchronized for WS-Security timestamp validation.

### Stuttering or corrupted frames

If the source file plays fine locally but the RTSP stream stutters and FFmpeg logs
`RTP: missed N packets`, `max delay reached. need to consume packet`, or
`concealing ... errors in I frame`, RTP packets are being lost on the way to the
viewer. FFmpeg (and many players) read RTSP over **UDP** by default; at 20 Mbit/s
each keyframe is a burst of hundreds of UDP packets that easily overflows the
client's socket buffer (especially on Windows) or a Wi-Fi link. Read over TCP
instead:

```sh
ffplay -rtsp_transport tcp rtsp://PI_ADDRESS:8554/camera
ffmpeg -rtsp_transport tcp -i rtsp://PI_ADDRESS:8554/camera -c copy out.mkv
```

In VLC, enable *Preferences → Input/Codecs → Live555 stream transport → RTP over
RTSP (TCP)*; in an NVR, choose TCP as the RTSP transport. If it still stutters:

- Check the MediaMTX log for `reader is too slow` (raise `writeQueueSize` in
  the MediaMTX configuration) or SRT packet-loss
  messages from the publisher. For lossy publisher links, add a larger SRT
  latency to the publish URL, for example `&latency=500000` (microseconds, in
  FFmpeg).
- Lower `CAMERA_BITRATE` and the publisher's `-b:v` (for example, 8000k) if the
  network, especially Wi-Fi, cannot sustain 20 Mbit/s bursts.

### Security

The default configuration allows anonymous ONVIF queries and RTSP viewing:
**use an isolated trusted camera LAN; never expose these ports to the Internet**.
Set both ONVIF credentials to require fresh WS-Security UsernameToken
PasswordDigest requests (plaintext PasswordText is rejected). UTC time remains
public for client clock synchronization. This does **not** authenticate RTSP.

For private viewing, restrict the `read` permission in the MediaMTX configuration
with a named user/password or an IP allowlist
using [MediaMTX authentication](https://mediamtx.org/docs/usage/authentication).
Configure RTSP credentials separately in your client; `GetStreamUri` never embeds
passwords. Neither HTTP nor default RTSP traffic is encrypted; use an isolated
network or VPN even with authentication. Keep `.env` readable only by the user
running the service.

## Development

```sh
npm ci
npm run check
npm test
npm start
```

Start MediaMTX separately. Node tests use
local ephemeral HTTP listeners and require no media tools (FFmpeg) or physical Pi.
An actual Raspberry Pi/NVR test is still needed for performance and
client-specific compatibility.