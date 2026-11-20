# onvif-camera

Emulate a fixed, read-only ONVIF camera on Raspberry Pi OS or another
Linux host. Another device publishes an H.264 (optionally AAC) stream to MediaMTX
over SRT, MediaMTX serves it over RTSP, and Node.js provides ONVIF Device/Media1 SOAP and
WS-Discovery. No FFmpeg or mpv is needed on this host.

This is an ONVIF-compatible emulator, **not an ONVIF-certified device**. It supports
one fixed profile, discovery, device information, UTC time, services/capabilities,
source/encoder configuration queries, encoder options, and `GetStreamUri`.
PTZ, events, snapshots, recording, and configuration writes are not implemented;
unsupported operations return SOAP faults.

## Usage

Requires **Node.js 22 or newer**. Run [MediaMTX](https://github.com/bluenviron/mediamtx)
separately with a `camera` path that accepts the published stream. The sample
[`mediamtx.yml`](mediamtx.yml) enables only what this project needs (RTSP for
viewers, SRT for the publisher) and disables RTMP, HLS, WebRTC and MoQ. Download it
next to the MediaMTX binary and run:

```sh
curl -o mediamtx.yml https://raw.githubusercontent.com/compulim/rpi-onvif-camera/main/mediamtx.yml
./mediamtx mediamtx.yml
```

Then start the ONVIF service:

```sh
npx onvif-camera
```

Every setting has a default, so no configuration file is required. To override
settings, set environment variables or put them in a `.env` file in the current
working directory (loaded via [dotenv](https://github.com/motdotla/dotenv);
variables already set in the environment take precedence). Start from
[`.env.example`](.env.example):

```sh
curl -o .env https://raw.githubusercontent.com/compulim/rpi-onvif-camera/main/.env.example
```

`CAMERA_ADDRESS` defaults to the host's first non-loopback IPv4 address; set it
explicitly on hosts with multiple interfaces (use a DHCP reservation). Set the
`CAMERA_WIDTH`/`HEIGHT`/`FPS`/`BITRATE`/`AUDIO` values to match the published stream.

## Configuration

See [`.env.example`](.env.example) for all settings.

| Variable | Default | Meaning |
| --- | --- | --- |
| `CAMERA_ADDRESS` | first non-loopback IPv4 address | LAN IPv4 address advertised to clients; never localhost |
| `CAMERA_ID` | `CAMERA_ADDRESS` | Unique stable identity, also reported by `GetHostname`; set this to survive address changes |
| `CAMERA_NAME` | Raspberry Pi Camera | Display name |
| `CAMERA_MANUFACTURER` | Raspberry Pi | Manufacturer reported by `GetDeviceInformation` |
| `CAMERA_MODEL` | Camera Module | Model reported by `GetDeviceInformation` and the `hardware` scope |
| `CAMERA_FIRMWARE_VERSION` | `version` in `package.json` | Firmware version reported by `GetDeviceInformation` |
| `CAMERA_SERIAL_NUMBER` | derived from `CAMERA_ID` | Serial number reported by `GetDeviceInformation` |
| `CAMERA_HARDWARE_ID` | onvif-camera | Hardware ID reported by `GetDeviceInformation` |
| `CAMERA_WIDTH`, `CAMERA_HEIGHT` | `1920`, `1080` | Advertised resolution |
| `CAMERA_FPS`, `CAMERA_BITRATE` | `30`, `20000` | Advertised frame rate and video bitrate (kbit/s) |
| `CAMERA_AUDIO` | `true` | Set `false` for video-only streams |
| `CAMERA_AUDIO_BITRATE`, `CAMERA_AUDIO_SAMPLE_RATE` | `128`, `44100` | Advertised AAC audio bitrate (kbit/s) and sample rate (Hz, for example `48000` or `44100`) |
| `CAMERA_AUDIO_CHANNELS` | `2` | Advertised audio channels: `1` (mono) or `2` (stereo) |
| `CAMERA_PORT` | `8000` | SOAP TCP port |
| `CAMERA_MEDIAMTX_ADDRESS` | `CAMERA_ADDRESS` | LAN IPv4 address of the MediaMTX server; may be another machine |
| `CAMERA_RTSP_PORT` | `8554` | MediaMTX RTSP TCP port (`rtspAddress`), reported by `GetNetworkProtocols` |
| `CAMERA_RTSP_PATH` | `camera` | MediaMTX path name of the stream |
| `CAMERA_RTP_PORT`, `CAMERA_RTCP_PORT` | `8000`, `8001` | MediaMTX RTP/RTCP UDP ports (`rtpAddress`/`rtcpAddress`); RTP must be even and RTCP must be RTP + 1 |
| `CAMERA_BIND` | `0.0.0.0` | SOAP listener address |
| `CAMERA_DISCOVERY` | `true` | Enable IPv4 multicast discovery |
| `CAMERA_USERNAME`, `CAMERA_PASSWORD` | empty | Optional ONVIF UsernameToken digest credentials; set both |

The ONVIF service does not probe the stream; it advertises the `CAMERA_*` values.
Keep them aligned with what is published (H.264 Main video; optional stereo AAC,
16-bit 44.1 kHz source encoded as 128 kbit/s AAC by default).

`GetStreamUri` returns `rtsp://CAMERA_MEDIAMTX_ADDRESS:CAMERA_RTSP_PORT/CAMERA_RTSP_PATH`.
Changing MediaMTX ports requires matching changes to `rtspAddress`, `rtpAddress`
and `rtcpAddress` in MediaMTX and the `CAMERA_RTSP_PORT`/`CAMERA_RTP_PORT`/`CAMERA_RTCP_PORT`
settings (or `srtAddress` for the SRT publishing port, default UDP 8890), plus your
firewall. If `CAMERA_MEDIAMTX_ADDRESS` points to another machine, a local MediaMTX
is not needed. Restart after configuration or network-address changes.

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

Windows 10/11 network camera support (for example, the Camera app) is video-only:
it [does not support ONVIF audio streaming](https://learn.microsoft.com/windows-hardware/drivers/stream/network-cameras#unsupported-features),
so recordings made through it have no sound even when the stream has AAC audio.
Use an NVR or open the RTSP URL directly (for example, VLC or `ffmpeg`) to record audio.
Many NVRs disable audio per channel by default; if there is no sound, enable
audio in the NVR's channel or recording settings.

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
local ephemeral HTTP listeners and require no media tools or physical Pi.
An actual Raspberry Pi/NVR test is still needed for performance and
client-specific compatibility.