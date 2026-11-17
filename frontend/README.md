# Frontend capture controllers

This folder contains two standalone browser interfaces for the PCAP capture
backends. They are separate applications: use the TCP page for TCP-stream
captures and the WebRTC page for WebRTC captures. Neither page captures or
saves PCAP files by itself; the matching backend must be running.

## Run the frontend

No frontend build or package installation is required. From the repository root,
serve this folder with Python:

```bash
cd frontend
python3 -m http.server 8000
```

Open the page you need:

- TCP: <http://localhost:8000/tcp/tcp.html>
- WebRTC: <http://localhost:8000/webrtc/webrtc.html>

Keep the static server running while using the page. For backend setup,
dependencies, packet-capture permissions, and network/security limitations, see
the [backend README](../backend/README.md).

## TCP controller

Page: `tcp/tcp.html` (styles and behavior are in `tcp/tcp.css` and
`tcp/tcp.js`).

1. Start the TCP backend from the repository root:

   ```bash
   cd backend/tcp
   python3 tcp_8080_current.py
   ```

   It listens on port `8080`. In the page's **Server** settings, set the server
   IP and server port to the backend address. The page initially shows port
   `5001`, so change it to `8080` when using this backend.
2. Choose **Local network** or **Internet (ngrok)** and configure the backend
   address. **Detect server** and **Check server health** can help verify the
   connection.
3. Choose device, dataset, network, video type, and capture port. The capture
   port is separate from the server port; it defaults to `8080` and identifies
   the traffic being captured.
4. Choose one video to **Start streaming**, or select several and use
   **Stream all selected files**. The browser sends the video to the backend,
   which records the traffic.

The page also provides server-side capture controls, network/interface
information, progress and logs, and session-metadata export. Connection and
dataset selections are saved in browser storage.

## WebRTC controller

Page: `webrtc/webrtc.html` (styles and behavior are in `webrtc/webrtc.css` and
`webrtc/webrtc.js`).

1. Start the WebRTC backend from the repository root:

   ```bash
   cd backend/webrtc
   python3 app.py
   ```

   The page defaults to `http://localhost:5001`. Enter the backend URL and click
   **Connect**. Use the backend's HTTPS/WSS address when connecting through
   ngrok.
2. Select one or more video files and choose a stream source:
   - **Uploaded videos** plays each selected file and sends its canvas stream.
   - **Camera** or **Screen share** uses that live source instead of the
     uploaded video content.
3. Set device, dataset, video type, network, and capture duration, then click
   **Start batch capture**. The page shows the live preview, per-file progress,
   completion/failure counts, PCAP sizes, and logs.

WebRTC media needs a direct network path between the browser and capture
machine; an ngrok tunnel carries signaling but does not relay the media stream.
See the backend README for details and precautions before exposing either
backend to a network.
