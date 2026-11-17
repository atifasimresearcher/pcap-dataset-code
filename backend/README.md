# DeepTraffic PCAP Capture Scripts

Scripts used to stream real and deepfake videos from a client device and record the
resulting network traffic with `tcpdump`. The video datasets and the browser client
are **not** included.

```
tcp/      Flask backend on port 8080  (tcp_8080_current.py)
webrtc/   Flask backend on port 5001  (app.py + webrtc_signaling.py, aiortc)
```

The client device reaches both backends through **ngrok**: port **8080** for the TCP
backend and port **5001** for the WebRTC backend (see "Using ngrok" below).

**Read "Before you run anything" and "Known limitations" first.** The scripts contain
paths from the original developer's machine and differ from each other in several
settings.

## How each backend works

**TCP backend (port 8080)** has two modes:

- `WebSocket /stream`: a client device (phone, tablet, computer) connects and sends
  the video chunks. `tcpdump` records the port 8080 traffic. This is the mode that
  produces device- and network-labelled captures.
- `POST /capture`: batch test mode. `ffmpeg` runs a server and a client on the same
  machine over `127.0.0.1`. The `device` and `network` values are only folder names
  here, not real conditions. Use it for smoke tests, not for dataset collection.

**WebRTC backend (port 5001)**: the browser sends an SDP offer to
`/api/webrtc/offer`, aiortc answers, and `tcpdump` records the session. `app.py`
also contains a `/stream` WebSocket route and a `/capture` route that mirror the TCP
backend, with protocol and port options.

## Requirements

- Python 3.10 or newer
- `tcpdump` (included with macOS)
- `ffmpeg` and `ffprobe` (TCP backend `/capture` and `/test-capture`)
- `ngrok` (see "Using ngrok")
- Permission to capture packets (see below)
- Python packages: `Flask`, `flask-cors`, `flask-sock`, `simple-websocket`,
  `netifaces`, `aiortc`

The dataset paper reports Flask 2.3.3, aiortc 1.14.0 and tcpdump 4.99.1. Pin these
in `requirements.txt` and save `pip freeze` output with your captures.

```bash
brew install ffmpeg
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
```

## Before you run anything

Work through this checklist in order.

- [ ] **Set the paths.** Edit all of these places:
  - `tcp/tcp_8080_current.py`: `BASE_DATASET_PATH` (output) and `video_source`
    inside `process_videos()` (input; currently
    `.../deepfake/hidf/{dataset}/{video_type}`, whatever the dataset).
  - `webrtc/app.py`: `BASE_DATASET_PATHS` (one output folder per duration) and the
    same `video_source` line in `process_videos()`.
  - `webrtc/webrtc_signaling.py`: `BASE_DATASET_PATH`.
  - Remove any personal absolute paths (`/Users/<name>/...`) before sharing or
    publishing the code.
- [ ] **Lay out the source videos** as `<video root>/<dataset>/<real|fake>/*.mp4`.
  Dataset names are `hidf`, `sdfvd`, `forensic++` and `manual-fake-2022` in the TCP
  script. `app.py` accepts only `hidf` and `sdfvd`.
- [ ] **Choose the capture interface.** `webrtc_signaling.py` and `app.py` hard-code
  `en0`. List yours with `networksetup -listallhardwareports` and edit the scripts.
  The TCP script uses `any` for local clients (see Known limitations).
- [ ] **Set up capture permission** (next section) and test it with
  `sudo -n true && echo OK`.
- [ ] **Remove `SUDO_PASSWORD`.** Delete the variable and every use of
  `sudo -S` plus `stdin.write(...)` in `app.py` and `webrtc_signaling.py`.
- [ ] **Close the capture machine to other traffic.** Quit other apps, sync tools and
  VPNs. Add a `host <client_ip>` filter wherever one is missing (see Known
  limitations).
- [ ] **Install ngrok and add your authtoken** (see "Using ngrok").
- [ ] **Restrict network access.** The servers listen on `0.0.0.0`, allow any CORS
  origin and have no authentication. They can start `tcpdump` with sudo and read a
  file path given to `/test-capture`. Because ngrok makes them reachable from the
  internet, anyone with the tunnel URL can use them, so stop the tunnels when you are
  not collecting.
- [ ] **Smoke test:**
  ```bash
  curl http://localhost:8080/health
  ```
  Then run one short video through `/capture` or `/test-capture`, and check the file:
  ```bash
  file path/to/capture.pcapng
  tcpdump -nr path/to/capture.pcapng | head
  ```

## Packet-capture permissions and passwords

Never put your account password in this README, a Python file or a commit. Do not run
the Flask server with `sudo`: it listens on all interfaces, so its web routes would run
as root.

The TCP script runs `sudo -n tcpdump`. `-n` means sudo never prompts, so if sudo needs
a password, `tcpdump` exits at once and the capture is reported as failed.

`sudo -v` caches your authorization only for a limited time (5 minutes by default), so
it is **not enough for a long batch run**. Pick one of these:

1. **Preferred: give your user capture access to the BPF devices** (for example with
   the ChmodBPF helper installed by Wireshark), then remove `sudo -n` / `sudo -S`
   from the `tcpdump` command lists in the scripts. No password or sudo is needed.
2. **Restricted sudo rule** on a dedicated capture machine only. Edit with `visudo`:
   ```bash
   sudo visudo -f /etc/sudoers.d/tcpdump-capture
   # add (replace youruser):
   youruser ALL=(root) NOPASSWD: /usr/sbin/tcpdump
   ```
   This lets that user run `tcpdump` as root without a password, including writing
   files with `-w`, so keep it off shared machines.

**The WebRTC scripts do not work without code changes.** `app.py` and
`webrtc_signaling.py` pipe `SUDO_PASSWORD` into `sudo -S`. Do not fill it in. Switch to
option 1 or 2 and remove the password code before using or publishing them.

## Run

TCP backend (port 8080):

```bash
cd tcp
python tcp_8080_current.py
```

WebRTC backend (port 5001):

```bash
cd webrtc
python app.py
```

Run each in its own terminal with the virtual environment active, and run **one
capture session at a time**. Sessions that overlap each start their own `tcpdump`, so
their traffic is mixed into each other's files. The browser client must be provided
separately and pointed at the backend URL.

After a run, check for orphaned processes: `pgrep tcpdump` and `pgrep ffmpeg`.

## Using ngrok

The client device connects to the backends through ngrok tunnels: **port 8080 for the
TCP backend and port 5001 for the WebRTC backend.**

1. Install ngrok and add your authtoken once:
   ```bash
   brew install ngrok
   ngrok config add-authtoken <your-token>
   ```
2. Start the backend, then open its tunnel in a separate terminal:
   ```bash
   ngrok http 8080    # TCP backend
   ngrok http 5001    # WebRTC backend
   ```
3. Configure the client with the `https://...ngrok...` forwarding URL shown by ngrok.
   Use the matching `wss://...` address for the WebSocket routes (`/stream` and
   `/ws/webrtc-batch`). Free-plan URLs change on every restart, so update the client
   each time.
4. Have the client send the `ngrok-skip-browser-warning` header. The backends already
   allow it in their CORS settings.
5. Stop the tunnels when you are not collecting data.

What the capture sees when ngrok is used:

- The ngrok agent runs on the capture machine and forwards requests to Flask, so Flask
  sees the connections as coming from `127.0.0.1`. The `tcpdump` filter on port 8080
  therefore records the local ngrok-to-Flask leg, not the client's own Wi-Fi or 4G
  path. Check this when you interpret the captures.
- `app.py` takes the client IP from the `X-Forwarded-For` header. Filtering on that
  address (`host <client_ip>`) matches nothing on the loopback leg, so confirm that
  captures are not empty.
- For WebRTC, ngrok carries only the signaling requests on port 5001. The media
  (RTP over UDP) does not go through the tunnel, so the client and the capture
  machine need a direct UDP path (for example the same network, or working
  ICE/STUN candidates).

## Output layout

```
TCP:             <BASE>/<device>/<dataset>/<real|fake>/8080/<jazz|wifi>/<name>.pcapng
WebRTC (offer):  <BASE>/<device>/<dataset>/<video_type>/webrtc/<network>/<name>.pcapng
app.py /stream:  <BASE per duration>/<device>/<dataset>/<type>/<port>/<protocol>/<network>/<name>.pcapng
```

If a file name exists, `_1`, `_2`, ... is appended. Failed batch captures are listed
in `reports/failure_report_<capture_id>.json`.