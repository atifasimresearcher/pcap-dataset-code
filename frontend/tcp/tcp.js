// =========================================================
// LOGGING
// =========================================================
console.clear = () => console.warn("[protection] console.clear() blocked");

const LOG_KEY = "deepfake_streaming_logs";
const MAX_LOG_ROWS = 1000;
let currentSessionMetadata = {};

function saveLog(message, type = "info") {
  try {
    const stored = localStorage.getItem(LOG_KEY);
    let logs = stored ? JSON.parse(stored) : [];
    logs.push({
      timestamp: new Date().toISOString(),
      time: new Date().toLocaleTimeString(),
      message,
      type,
    });
    if (logs.length > MAX_LOG_ROWS) logs = logs.slice(-MAX_LOG_ROWS);
    localStorage.setItem(LOG_KEY, JSON.stringify(logs));
  } catch (e) {}
}

function displaySavedLogs() {
  try {
    const stored = localStorage.getItem(LOG_KEY);
    if (!stored) return;
    const logs = JSON.parse(stored);
    if (!logs.length) return;
    addToLog(`Previous session: ${logs.length} log entries`, "info");
    logs.slice(-5).forEach((l) => addToLog(`[${l.time}] ${l.message}`, l.type));
  } catch (e) {}
}

function clearSavedLogs() {
  if (!confirm("Clear all saved logs?")) return;
  localStorage.removeItem(LOG_KEY);
  document.getElementById("statusLog").innerHTML = "<div>Logs cleared.</div>";
  addToLog("Logs cleared", "warning");
}

function downloadLogs() {
  const stored = localStorage.getItem(LOG_KEY);
  if (!stored) {
    addToLog("No logs to download", "error");
    return;
  }
  const logs = JSON.parse(stored);
  const text = logs
    .map((l) => `[${l.time}] ${l.type.toUpperCase()}: ${l.message}`)
    .join("\n");
  triggerDownload(
    new Blob([text], { type: "text/plain" }),
    `client_logs_${ts()}.txt`,
  );
  addToLog("Logs downloaded", "success");
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function ts() {
  return new Date().toISOString().slice(0, 19).replace(/:/g, "-");
}

// =========================================================
// CONFIGURATION
// =========================================================
let LOCAL_IP = localStorage.getItem("SERVER_IP") || "127.0.0.1";
let LOCAL_PORT = localStorage.getItem("SERVER_PORT") || "5001";
let NGROK_URL =
  localStorage.getItem("NGROK_URL") ||
  "https://65d8-154-80-52-225.ngrok-free.app";
let currentMode = localStorage.getItem("CONNECTION_MODE") || "local";
const CHUNK_SIZE = 1400;

function saveServerConfig() {
  localStorage.setItem("SERVER_IP", LOCAL_IP);
  localStorage.setItem("SERVER_PORT", LOCAL_PORT);
  localStorage.setItem("NGROK_URL", NGROK_URL);
  localStorage.setItem("CONNECTION_MODE", currentMode);
}

function getBaseUrl() {
  if (currentMode === "local") {
    return `http://${LOCAL_IP}:${LOCAL_PORT}`;
  }
  return NGROK_URL;
}

function getHeaders() {
  const h = { "Content-Type": "application/json" };
  if (currentMode === "ngrok") {
    h["ngrok-skip-browser-warning"] = "any-value";
  }
  return h;
}

function getWebSocketUrl() {
  if (currentMode === "local") {
    return `ws://${LOCAL_IP}:${LOCAL_PORT}/stream`;
  }
  const base = NGROK_URL.replace(/^https?:\/\//, "");
  return `wss://${base}/stream`;
}

function getWebRTCSignalingWsUrl() {
  if (currentMode === "local") {
    return `ws://${LOCAL_IP}:${LOCAL_PORT}/ws/webrtc-batch`;
  }
  const base = NGROK_URL.replace(/^https?:\/\//, "");
  return `wss://${base}/ws/webrtc-batch`;
}

// =========================================================
// STATE
// =========================================================
let selectedDevice = "computer";
let selectedDataset = localStorage.getItem("SELECTED_DATASET") || "hidf";
let selectedNetwork = localStorage.getItem("SELECTED_NETWORK") || "jazz";
let currentCaptureId = null;
let statusCheckInterval = null;
let streamingSocket = null;
let streamingActive = false;
let chunkCount = 0;
let totalBytesSent = 0;
let streamStartTime = null;
let detectedDuration = 0;

// Batch streaming state
let batchQueue = [];
let batchCurrentIndex = 0;
let batchActive = false;
let batchResults = [];

// Port and protocol state
let currentProtocol = "tcp";
let currentStreamPort = 443;

// WebRTC state
let webRTCWs = null;
let webRTCPC = null;
let webRTCActive = false;

// =========================================================
// WEBRTC SIGNALING
// =========================================================

async function startWebRTCStreaming(port, protocol) {
  const fileInput = document.getElementById("videoFile");
  if (!fileInput.files || !fileInput.files.length) {
    showToast("Select a video file first", "error");
    addToLog("No file selected for WebRTC", "error");
    return;
  }

  const file = fileInput.files[0];
  const device = selectedDevice;
  const videoType = document.getElementById("videoTypeSelect").value;
  const duration = detectedDuration > 0 ? detectedDuration : 3;
  const captureId = `webrtc_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  addToLog(`Starting WebRTC stream on port ${port}`, "stream");
  addToLog(
    `File: ${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB)`,
    "info",
  );
  addToLog(`Duration: ${duration}s`, "info");

  const webrtcBtn = document.getElementById("streamBtn3478");
  if (webrtcBtn) {
    webrtcBtn.disabled = true;
    webrtcBtn.innerHTML = '<span class="spinner"></span> WebRTC negotiating…';
  }

  updateStatusBadge("WebRTC Connecting");
  webRTCActive = true;

  try {
    const signalingWsUrl = getWebRTCSignalingWsUrl();
    addToLog(`WebRTC signaling WebSocket: ${signalingWsUrl}`, "info");

    webRTCWs = new WebSocket(signalingWsUrl);

    webRTCWs.onopen = () => {
      addToLog("WebRTC signaling WebSocket connected", "success");
    };

    webRTCWs.onerror = () => {
      addToLog("WebRTC signaling WebSocket error", "error");
    };

    webRTCPC = new RTCPeerConnection({
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
        { urls: "stun:stun2.l.google.com:19302" },
      ],
    });

    // Play the file in a hidden video element and capture its stream
    const videoElement = document.createElement("video");
    videoElement.src = URL.createObjectURL(file);
    videoElement.muted = true;

    await new Promise((resolve) => {
      videoElement.onloadedmetadata = () => {
        videoElement.play();
        resolve();
      };
    });

    const stream = videoElement.captureStream();
    const videoTrack = stream.getVideoTracks()[0];

    if (videoTrack) {
      webRTCPC.addTrack(videoTrack, stream);
      addToLog(`Added video track: ${videoTrack.label}`, "success");
    } else {
      throw new Error("No video track found");
    }

    webRTCPC.onicecandidate = (event) => {
      if (
        event.candidate &&
        webRTCWs &&
        webRTCWs.readyState === WebSocket.OPEN
      ) {
        const message = {
          type: "ice_candidate",
          capture_id: captureId,
          ice_candidate: event.candidate,
        };
        webRTCWs.send(JSON.stringify(message));
        addToLog("Sent ICE candidate", "info");
      }
    };

    webRTCPC.oniceconnectionstatechange = () => {
      addToLog(`ICE connection state: ${webRTCPC.iceConnectionState}`, "info");
      if (webRTCPC.iceConnectionState === "connected") {
        addToLog("WebRTC connected", "success");
        updateStatusBadge("WebRTC Streaming");
      }
    };

    webRTCPC.ontrack = (event) => {
      addToLog(`Receiving track: ${event.track.kind}`, "success");
    };

    addToLog("Creating WebRTC offer…", "info");
    const offer = await webRTCPC.createOffer();
    await webRTCPC.setLocalDescription(offer);

    // Wait for ICE gathering to finish
    await new Promise((resolve) => {
      if (webRTCPC.iceGatheringState === "complete") {
        resolve();
      } else {
        webRTCPC.onicegatheringstatechange = () => {
          if (webRTCPC.iceGatheringState === "complete") {
            resolve();
          }
        };
      }
    });

    addToLog("Sending SDP offer to backend…", "info");
    const requestBody = {
      capture_id: captureId,
      filename: file.name,
      sdp_offer: webRTCPC.localDescription.sdp,
      config: {
        device_type: device,
        dataset_type: selectedDataset,
        video_type: videoType,
        network_type: selectedNetwork,
        duration: duration,
        port: port,
      },
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000);

    const response = await fetch(`${getBaseUrl()}/api/webrtc/offer`, {
      method: "POST",
      headers: getHeaders(),
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    addToLog("Received SDP answer from backend", "success");

    const answer = new RTCSessionDescription({
      type: "answer",
      sdp: data.sdp_answer,
    });
    await webRTCPC.setRemoteDescription(answer);

    addToLog(
      `WebRTC negotiation complete. Streaming for ${duration}s`,
      "success",
    );
    showToast("WebRTC streaming started", "success");

    await new Promise((resolve) => setTimeout(resolve, duration * 1000));

    await cleanupWebRTC();
    addToLog("WebRTC stream completed", "success");
    showToast("WebRTC stream complete", "success");
    updateStatusBadge("Completed");
  } catch (error) {
    if (error.name === "AbortError") {
      addToLog("Request timed out. The backend is not responding.", "error");
    } else {
      addToLog(`WebRTC setup error: ${error.message}`, "error");
    }
    await cleanupWebRTC();
  } finally {
    if (webrtcBtn) {
      webrtcBtn.disabled = false;
      webrtcBtn.innerHTML = "Start WebRTC stream (port 3478)";
    }
    webRTCActive = false;
  }
}

async function cleanupWebRTC() {
  if (webRTCWs) {
    webRTCWs.close();
    webRTCWs = null;
  }
  if (webRTCPC) {
    webRTCPC.close();
    webRTCPC = null;
  }
}

// =========================================================
// TCP / UDP STREAMING OVER WEBSOCKET
// =========================================================

async function startStreamingWithPort(port, protocol) {
  // Port 3478 uses WebRTC signaling
  if (port === 3478 && protocol === "udp") {
    await startWebRTCStreaming(port, protocol);
    return;
  }

  currentStreamPort = port;
  currentProtocol = protocol;

  const fileInput = document.getElementById("videoFile");
  if (!fileInput.files || !fileInput.files.length) {
    showToast("Select a video file first", "error");
    addToLog("No file selected", "error");
    return;
  }

  const file = fileInput.files[0];
  const device = selectedDevice;
  const videoType = document.getElementById("videoTypeSelect").value;
  const duration = detectedDuration > 0 ? detectedDuration : 3;

  const protocolName = protocol.toUpperCase();
  const protocolDesc =
    protocol === "tcp" ? "reliable, with ACKs" : "fast, no retransmissions";

  addToLog(`Starting ${protocolName} stream on port ${port}`, "stream");
  addToLog(`Protocol: ${protocolName} (${protocolDesc})`, "info");
  addToLog(
    `File: ${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB, ${duration}s)`,
    "info",
  );
  addToLog(`Device: ${device}, type: ${videoType}`, "info");

  const tcpBtn = document.getElementById("streamBtnTCP");
  const udpBtn = document.getElementById("streamBtnUDP");
  const webrtcBtn = document.getElementById("streamBtn3478");
  if (tcpBtn) tcpBtn.disabled = true;
  if (udpBtn) udpBtn.disabled = true;
  if (webrtcBtn) webrtcBtn.disabled = true;
  document.getElementById("streamBtn").disabled = true;

  if (protocol === "tcp" && tcpBtn) {
    tcpBtn.innerHTML = '<span class="spinner"></span> TCP streaming…';
    updateStatusBadge("Streaming (TCP)");
  } else if (protocol === "udp" && udpBtn) {
    udpBtn.innerHTML = '<span class="spinner"></span> UDP streaming…';
    updateStatusBadge("Streaming (UDP)");
  }

  streamingActive = true;
  streamStartTime = Date.now();
  chunkCount = 0;
  totalBytesSent = 0;
  document.getElementById("statsGrid").style.display = "grid";

  const wsUrl = getWebSocketUrl();
  addToLog(`Connecting to ${wsUrl}…`, "info");

  let captureStarted = false;
  let completed = false;

  const timeout = setTimeout(
    () => {
      if (!completed) {
        addToLog("Timed out waiting for capture to finish", "error");
        cleanupStreaming();
      }
    },
    duration * 1000 + 30000,
  );

  try {
    streamingSocket = new WebSocket(wsUrl);

    streamingSocket.onopen = () => {
      addToLog("WebSocket connected", "success");

      streamingSocket.send(
        JSON.stringify({
          type: "start_stream",
          device: device,
          dataset: selectedDataset,
          port: port,
          protocol: protocol,
          video_type: videoType,
          network: selectedNetwork,
          duration: duration,
          filename: file.name,
          client_ip: "auto-detect",
        }),
      );
      addToLog(`Start command sent (${protocolName} on port ${port})`, "stream");
    };

    streamingSocket.onmessage = async (event) => {
      let resp;
      try {
        resp = JSON.parse(event.data);
      } catch {
        return;
      }

      if (resp.type === "capture_started") {
        captureStarted = true;
        addToLog(`Capture started. PCAP: ${resp.pcap_file}`, "success");
        document.getElementById("captureIdDisplay").textContent =
          `PCAP: ${resp.pcap_file} (${protocolName} port ${port})`;
        await streamFileToSocketSingle(file, duration);
      } else if (resp.type === "capture_complete") {
        clearTimeout(timeout);
        completed = true;
        addToLog(
          `${protocolName} stream complete. PCAP: ${resp.pcap_file} (${(resp.size_bytes / 1024).toFixed(1)} KB)`,
          "success",
        );
        addToLog(`Protocol: ${protocolName}, port: ${port}`, "info");
        addToLog(
          `Chunks received: ${resp.chunks_received}, rate: ${resp.avg_rate_kbps || "N/A"} KB/s`,
          "info",
        );
        showToast(`${protocolName} stream complete`, "success");
        updateStatusBadge("Completed");
        updateProgress(100);
        cleanupStreaming();
      } else if (resp.type === "error") {
        addToLog(`Server error: ${resp.message}`, "error");
        cleanupStreaming();
      }
    };

    streamingSocket.onerror = () => {
      addToLog("WebSocket error", "error");
      cleanupStreaming();
    };

    streamingSocket.onclose = () => {
      if (!completed && captureStarted) {
        addToLog("WebSocket closed unexpectedly", "warning");
        cleanupStreaming();
      }
    };
  } catch (err) {
    addToLog(`Connection failed: ${err.message}`, "error");
    cleanupStreaming();
  }
}

// =========================================================
// NETWORK DETECTION
// =========================================================
async function detectNetworkInfo() {
  const connection =
    navigator.connection ||
    navigator.mozConnection ||
    navigator.webkitConnection;
  if (connection) {
    document.getElementById("connType").textContent =
      connection.effectiveType || "Unknown";
    document.getElementById("downlink").textContent = connection.downlink
      ? `${connection.downlink} Mbps`
      : "Unknown";
    document.getElementById("rtt").textContent = connection.rtt
      ? `${connection.rtt} ms`
      : "Unknown";
    currentSessionMetadata.network_type = connection.effectiveType;
  }
  addToLog(`Network: ${connection?.effectiveType || "Unknown"}`, "info");
}

function getCurrentLocation() {
  if (!navigator.geolocation) {
    addToLog("Geolocation not supported", "error");
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (position) => {
      const lat = position.coords.latitude.toFixed(6);
      const lng = position.coords.longitude.toFixed(6);
      document.getElementById("gpsLocation").value = `${lat}, ${lng}`;
      addToLog(`Location: ${lat}, ${lng}`, "success");
    },
    (error) => addToLog(`Location error: ${error.message}`, "error"),
  );
}

function saveDatasetSelection() {
  const dataset = document.getElementById("datasetSelect").value;
  if (dataset) {
    selectedDataset = dataset;
    localStorage.setItem("SELECTED_DATASET", dataset);
    currentSessionMetadata.dataset = dataset;
    addToLog(`Dataset: ${dataset.toUpperCase()}`, "success");
  }
}

function saveNetworkLocation() {
  const location = document.getElementById("networkLocation").value;
  if (location) {
    selectedNetwork = location;
    localStorage.setItem("SELECTED_NETWORK", location);
    currentSessionMetadata.network_type = location;

    const networkValue = document.getElementById("networkValue");
    if (networkValue) networkValue.textContent = location.toUpperCase();

    addToLog(`Network selected: ${location.toUpperCase()}`, "success");
    console.log(`[Network Selection] Updated: ${location}`);
  }
}

function exportMetadata() {
  const metadata = {
    timestamp: new Date().toISOString(),
    device: selectedDevice,
    dataset: selectedDataset,
    network: selectedNetwork,
    port: currentStreamPort,
    protocol: currentProtocol,
    video_type: document.getElementById("videoTypeSelect").value,
    video_quality: document.getElementById("videoQuality").value,
    network_mode: currentMode,
    gps: document.getElementById("gpsLocation").value,
    ...currentSessionMetadata,
  };
  triggerDownload(
    new Blob([JSON.stringify(metadata, null, 2)], { type: "application/json" }),
    `metadata_${ts()}.json`,
  );
  addToLog("Metadata exported", "success");
}

// =========================================================
// UI HELPERS
// =========================================================
function setMode(mode) {
  currentMode = mode;
  saveServerConfig();
  document
    .getElementById("modeLocal")
    .classList.toggle("active", mode === "local");
  document
    .getElementById("modeNgrok")
    .classList.toggle("active", mode === "ngrok");
  const display = document.getElementById("serverDisplay");
  if (mode === "local") {
    display.textContent = `${LOCAL_IP}:${LOCAL_PORT} (local)`;
  } else {
    display.textContent = "ngrok (internet)";
  }
  addToLog(`Mode: ${mode}`, "info");
}

function updateServerConfig() {
  const ipInput = document.getElementById("serverIpInput");
  const portInput = document.getElementById("serverPortInput");
  const ngrokInput = document.getElementById("ngrokUrlInput");

  if (ipInput) LOCAL_IP = ipInput.value;
  if (portInput) LOCAL_PORT = portInput.value;
  if (ngrokInput) NGROK_URL = ngrokInput.value;

  saveServerConfig();
  addToLog("Server settings saved", "success");
  showToast("Settings saved", "success");
  setMode(currentMode);
}

function autoDetectServer() {
  addToLog("Looking for the server…", "info");

  const commonAddresses = [
    "127.0.0.1:5001",
    "localhost:5001",
    "192.168.1.1:5001",
    "10.0.0.1:5001",
  ];

  let found = false;
  const checkAddress = async (index) => {
    if (index >= commonAddresses.length) {
      if (!found) {
        addToLog("Server not found. Enter the address manually.", "error");
        showToast("Server not found. Enter the address manually.", "error");
      }
      return;
    }

    const addr = commonAddresses[index];
    const [ip, port] = addr.split(":");

    try {
      const response = await fetch(`http://${addr}/health`, {
        method: "GET",
        headers: { "Content-Type": "application/json" },
      });

      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), 2000),
      );

      await Promise.race([response, timeoutPromise]);

      if (response.ok) {
        LOCAL_IP = ip;
        LOCAL_PORT = port;
        saveServerConfig();
        document.getElementById("serverIpInput").value = LOCAL_IP;
        document.getElementById("serverPortInput").value = LOCAL_PORT;
        addToLog(`Server found at ${addr}`, "success");
        showToast(`Server found: ${addr}`, "success");
        setMode("local");
        found = true;
        return;
      }
    } catch (e) {
      // Try the next address
    }

    checkAddress(index + 1);
  };

  checkAddress(0);
}

function selectDevice(device) {
  selectedDevice = device;
  document
    .querySelectorAll(".device-card")
    .forEach((c) =>
      c.classList.toggle("selected", c.dataset.device === device),
    );
  addToLog(`Device: ${device}`);
}

function addToLog(message, type = "info") {
  const log = document.getElementById("statusLog");
  const entry = document.createElement("div");
  entry.className = `log-${type}`;
  entry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
  log.appendChild(entry);
  log.scrollTop = log.scrollHeight;
  saveLog(message, type);
}

function showToast(message, type = "info") {
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = message;
  document.getElementById("toastContainer").appendChild(toast);
  setTimeout(() => toast.remove(), 5000);
}

function updateStatusBadge(status) {
  const badge = document.getElementById("statusBadge");
  badge.textContent = status;
  badge.className = "status-badge";
  if (status === "Running") badge.classList.add("running");
  if (status === "Completed") badge.classList.add("completed");
  if (status === "Failed") badge.classList.add("failed");
  if (status === "Streaming") badge.classList.add("streaming");
  if (status === "Batch") badge.classList.add("batch");
  if (status === "WebRTC Connecting") badge.classList.add("streaming");
  if (status === "WebRTC Streaming") badge.classList.add("streaming");
}

function updateProgress(pct) {
  document.getElementById("progressFill").style.width = `${pct}%`;
}

// =========================================================
// FILE INFO
// =========================================================
function updateFileInfo() {
  const fi = document.getElementById("videoFile");
  if (!fi.files || !fi.files.length) {
    document.getElementById("fileName").textContent = "None";
    document.getElementById("fileSize").textContent = "-";
    document.getElementById("streamInfo").textContent = "Select a video file";
    detectedDuration = 0;
    return;
  }
  const file = fi.files[0];
  document.getElementById("fileName").textContent = file.name;
  document.getElementById("fileSize").textContent =
    (file.size / 1024 / 1024).toFixed(2) + " MB";
  detectDuration(file, (dur) => {
    detectedDuration = dur;
    document.getElementById("streamInfo").textContent = `${dur}s`;
  });
}

function detectDuration(file, callback) {
  const vid = document.createElement("video");
  const url = URL.createObjectURL(file);
  vid.src = url;
  vid.onloadedmetadata = () => {
    const dur = Math.ceil(vid.duration);
    if (callback) callback(dur);
    URL.revokeObjectURL(url);
  };
  vid.onerror = () => {
    if (callback) callback(10);
    URL.revokeObjectURL(url);
  };
}

// =========================================================
// BATCH STREAMING
// =========================================================
function updateBatchFileList() {
  const input = document.getElementById("batchFiles");
  const listDiv = document.getElementById("batchFileList");
  const countSpan = document.getElementById("batchCount");
  const totalSizeSpan = document.getElementById("batchTotalSize");

  if (!input.files || !input.files.length) {
    countSpan.textContent = "0 files";
    totalSizeSpan.textContent = "-";
    listDiv.style.display = "none";
    return;
  }

  const files = Array.from(input.files);
  countSpan.textContent = `${files.length} files`;

  let totalSize = 0;
  files.forEach((f) => (totalSize += f.size));
  totalSizeSpan.textContent = (totalSize / 1024 / 1024).toFixed(2) + " MB";

  const estSeconds = files.length * 3;
  document.getElementById("batchEstTime").textContent = `${estSeconds} seconds`;

  listDiv.innerHTML = "";
  files.forEach((f, idx) => {
    const div = document.createElement("div");
    div.className = "batch-file-item";
    const name = document.createElement("span");
    name.className = "batch-file-name";
    name.textContent = `${idx + 1}. ${f.name}`;
    const size = document.createElement("span");
    size.className = "batch-file-size";
    size.textContent = `${(f.size / 1024 / 1024).toFixed(2)} MB`;
    div.append(name, size);
    listDiv.appendChild(div);
  });
  listDiv.style.display = "block";
}

async function startBatchStreaming() {
  const input = document.getElementById("batchFiles");
  if (!input.files || !input.files.length) {
    showToast("Select video files first", "error");
    addToLog("No files selected for batch", "error");
    return;
  }

  batchQueue = Array.from(input.files);
  batchCurrentIndex = 0;
  batchResults = [];
  batchActive = true;

  document.getElementById("batchStreamBtn").disabled = true;
  document.getElementById("batchStreamBtn").innerHTML =
    '<span class="spinner"></span> Batch running…';
  document.getElementById("stopBatchBtn").style.display = "block";
  updateStatusBadge("Batch");

  addToLog(`Batch started: ${batchQueue.length} files`, "stream");

  for (let i = 0; i < batchQueue.length && batchActive; i++) {
    batchCurrentIndex = i;
    const file = batchQueue[i];

    document.getElementById("batchCurrentFile").textContent =
      `Processing: ${file.name}`;
    const percent = (i / batchQueue.length) * 100;
    document.getElementById("batchProgressPercent").textContent =
      `${Math.round(percent)}%`;
    document.getElementById("batchProgressBar").style.width = `${percent}%`;
    document.getElementById("batchProgress").style.display = "block";

    addToLog(`[${i + 1}/${batchQueue.length}] Processing: ${file.name}`, "stream");

    const success = await processSingleFile(file);
    batchResults.push({
      file: file.name,
      success,
      timestamp: new Date().toISOString(),
    });

    if (success) {
      addToLog(`[${i + 1}/${batchQueue.length}] Done: ${file.name}`, "success");
    } else {
      addToLog(`[${i + 1}/${batchQueue.length}] Failed: ${file.name}`, "error");
    }

    await new Promise((r) => setTimeout(r, 2000));
  }

  const successCount = batchResults.filter((r) => r.success).length;
  const failCount = batchResults.filter((r) => !r.success).length;
  addToLog(`Batch complete: ${successCount} succeeded, ${failCount} failed`, "success");
  showToast(
    `Batch complete: ${successCount}/${batchQueue.length} files`,
    "success",
  );

  const batchReport = {
    timestamp: new Date().toISOString(),
    device: selectedDevice,
    port: currentStreamPort,
    protocol: currentProtocol,
    total_files: batchQueue.length,
    success: successCount,
    failed: failCount,
    results: batchResults,
  };
  triggerDownload(
    new Blob([JSON.stringify(batchReport, null, 2)], {
      type: "application/json",
    }),
    `batch_report_${ts()}.json`,
  );

  cleanupBatch();
}

async function processSingleFile(file) {
  return new Promise(async (resolve) => {
    let duration = 3;
    detectDuration(file, (dur) => {
      duration = dur;
    });
    await new Promise((r) => setTimeout(r, 500));

    const device = selectedDevice;
    const port = currentStreamPort;
    const videoType = document.getElementById("videoTypeSelect").value;

    addToLog(
      `Duration: ${duration}s, size: ${(file.size / 1024 / 1024).toFixed(2)} MB`,
      "stream",
    );

    const wsUrl = getWebSocketUrl();
    let socket = null;
    let captureStarted = false;
    let completed = false;
    let chunk_count = 0;

    addToLog(`Connecting to WebSocket: ${wsUrl}`, "info");

    const timeout = setTimeout(
      () => {
        if (!completed) {
          addToLog(
            `Timeout: ${file.name} (${duration * 1000 + 90000} ms elapsed)`,
            "error",
          );
          if (socket) {
            addToLog(`Socket state: ${socket.readyState}`, "error");
            socket.close();
          }
          resolve(false);
        }
      },
      duration * 1000 + 90000,
    );

    try {
      socket = new WebSocket(wsUrl);

      socket.onopen = () => {
        addToLog(`WebSocket open (state: ${socket.readyState})`, "success");
        const startMsg = JSON.stringify({
          type: "start_stream",
          device,
          dataset: selectedDataset,
          port: parseInt(port),
          video_type: videoType,
          network: selectedNetwork,
          duration,
          filename: file.name,
          client_ip: "auto-detect",
        });
        addToLog(`Sending: ${startMsg.substring(0, 100)}…`, "stream");
        socket.send(startMsg);
      };

      socket.onmessage = async (event) => {
        addToLog(`Received: ${event.data.substring(0, 150)}…`, "info");
        let resp;
        try {
          resp = JSON.parse(event.data);
          addToLog(`Parsed type: ${resp.type}`, "info");
        } catch (e) {
          addToLog(`Failed to parse JSON: ${e.message}`, "error");
          return;
        }

        if (resp.type === "capture_started") {
          captureStarted = true;
          addToLog(`Capture started for ${file.name}`, "success");
          addToLog(`PCAP: ${resp.pcap_file}`, "info");
          await streamFileToSocket(socket, file, duration, (count) => {
            chunk_count = count;
          });
        } else if (resp.type === "capture_complete") {
          clearTimeout(timeout);
          completed = true;
          addToLog(
            `Server received ${resp.chunks_received} chunks (${(resp.bytes_received / 1024).toFixed(1)} KB)`,
            "success",
          );
          if (resp.pcap_file) {
            addToLog(`PCAP file: ${resp.pcap_file}`, "success");
          }
          if (resp.size_bytes) {
            addToLog(
              `Final size: ${(resp.size_bytes / 1024).toFixed(1)} KB`,
              "success",
            );
          }
          socket.close();
          resolve(true);
        } else if (resp.type === "error") {
          clearTimeout(timeout);
          completed = true;
          addToLog(`Server error: ${resp.message}`, "error");
          socket.close();
          resolve(false);
        } else {
          addToLog(`Unknown message type: ${resp.type}`, "warning");
        }
      };

      socket.onerror = () => {
        addToLog("WebSocket error", "error");
        addToLog(`Socket state: ${socket.readyState}`, "error");
        addToLog(`URL: ${wsUrl}`, "error");
        if (!completed) {
          clearTimeout(timeout);
          completed = true;
          resolve(false);
        }
      };

      socket.onclose = (event) => {
        addToLog(
          `WebSocket closed: code=${event.code}, reason=${event.reason || "none"}, wasClean=${event.wasClean}`,
          "warning",
        );

        if (event.code === 1000 || completed) {
          return;
        }

        if (event.code === 1006 && captureStarted && chunk_count > 0) {
          addToLog(
            `Abnormal close (1006) but ${chunk_count} chunks were sent. Likely successful.`,
            "warning",
          );
          setTimeout(() => {
            if (!completed) {
              completed = true;
              addToLog(
                "Treating as success (packets captured despite socket error)",
                "success",
              );
              resolve(true);
            }
          }, 3000);
          return;
        }

        if (!completed && captureStarted) {
          addToLog("Waiting for capture_complete after close…", "info");
          setTimeout(() => {
            if (!completed) {
              completed = true;
              addToLog(
                `No capture_complete received after close (code ${event.code})`,
                "error",
              );
              resolve(false);
            }
          }, 5000);
        } else if (!completed && !captureStarted) {
          completed = true;
          addToLog("Closed before capture started", "error");
          resolve(false);
        }
      };
    } catch (err) {
      clearTimeout(timeout);
      addToLog(`Connection exception: ${err.message}`, "error");
      addToLog(`Stack: ${err.stack}`, "error");
      resolve(false);
    }
  });
}

async function streamFileToSocket(socket, file, durationSeconds, onProgress) {
  const totalSize = file.size;
  const bytesPerSecond = totalSize / durationSeconds;
  let offset = 0;
  let chunkNumber = 0;
  const startTime = Date.now();

  addToLog(
    `Starting stream: ${totalSize} bytes at ${bytesPerSecond.toFixed(0)} bytes/sec`,
    "info",
  );

  function sendNext() {
    if (socket.readyState !== WebSocket.OPEN) {
      addToLog(`Socket not open (state: ${socket.readyState})`, "error");
      return;
    }

    const elapsedMs = Date.now() - startTime;
    const shouldHaveSent = (elapsedMs / 1000) * bytesPerSecond;

    if (offset > shouldHaveSent && offset < totalSize) {
      const waitMs = ((offset - shouldHaveSent) / bytesPerSecond) * 1000;
      setTimeout(sendNext, Math.max(waitMs, 10));
      return;
    }

    if (offset >= totalSize) {
      addToLog(`Sending EOF. ${chunkNumber} chunks sent`, "stream");
      if (onProgress) onProgress(chunkNumber);
      socket.send(
        JSON.stringify({
          type: "eof",
          total_chunks: chunkNumber,
          total_bytes: totalSize,
        }),
      );
      return;
    }

    const size = Math.min(CHUNK_SIZE, totalSize - offset);
    const blob = file.slice(offset, offset + size);
    const reader = new FileReader();

    reader.onload = (e) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(e.target.result);
        chunkNumber++;
        offset += size;

        if (chunkNumber % 10 === 0) {
          const progress = ((offset / totalSize) * 100).toFixed(1);
          addToLog(
            `Chunk ${chunkNumber}: sent ${size} B, progress ${progress}%`,
            "stream",
          );
        }

        setTimeout(sendNext, 0);
      } else {
        addToLog(`Socket closed while sending chunk ${chunkNumber}`, "error");
      }
    };

    reader.onerror = (err) => {
      addToLog(`FileReader error: ${err}`, "error");
    };

    reader.readAsArrayBuffer(blob);
  }

  sendNext();
}

function stopBatchStreaming() {
  batchActive = false;
  addToLog("Batch stopped by user", "warning");
  cleanupBatch();
}

function cleanupBatch() {
  batchActive = false;
  document.getElementById("batchStreamBtn").disabled = false;
  document.getElementById("batchStreamBtn").innerHTML =
    "Stream all selected files";
  document.getElementById("stopBatchBtn").style.display = "none";
  document.getElementById("batchProgress").style.display = "none";
  updateStatusBadge("Ready");
  if (streamingSocket) streamingSocket.close();
}

// =========================================================
// SINGLE FILE STREAMING
// =========================================================
async function startTrueStreaming() {
  const fileInput = document.getElementById("videoFile");
  if (!fileInput.files || !fileInput.files.length) {
    showToast("Select a video file first", "error");
    addToLog("No file selected", "error");
    return;
  }

  const file = fileInput.files[0];
  const device = selectedDevice;
  const port = currentStreamPort;
  const videoType = document.getElementById("videoTypeSelect").value;
  const duration = detectedDuration > 0 ? detectedDuration : 3;

  addToLog(`Starting stream: ${file.name}`, "stream");
  addToLog(
    `Size: ${(file.size / 1024 / 1024).toFixed(2)} MB, duration: ${duration}s`,
    "info",
  );
  addToLog(`Device: ${device}, port: ${port}, type: ${videoType}`, "info");

  document.getElementById("streamBtn").disabled = true;
  document.getElementById("streamBtn").innerHTML =
    '<span class="spinner"></span> Streaming…';
  updateStatusBadge("Streaming");

  streamingActive = true;
  streamStartTime = Date.now();
  chunkCount = 0;
  totalBytesSent = 0;
  document.getElementById("statsGrid").style.display = "grid";

  const wsUrl = getWebSocketUrl();
  addToLog(`Connecting to ${wsUrl}…`, "info");

  let captureStarted = false;
  let completed = false;

  const timeout = setTimeout(
    () => {
      if (!completed) {
        addToLog("Timed out waiting for capture to finish", "error");
        cleanupStreaming();
      }
    },
    duration * 1000 + 30000,
  );

  try {
    streamingSocket = new WebSocket(wsUrl);

    streamingSocket.onopen = () => {
      addToLog("WebSocket connected", "success");
      streamingSocket.send(
        JSON.stringify({
          type: "start_stream",
          device: device,
          port: parseInt(port),
          video_type: videoType,
          duration: duration,
          filename: file.name,
          client_ip: "auto-detect",
        }),
      );
      addToLog("Start command sent", "stream");
    };

    streamingSocket.onmessage = async (event) => {
      let resp;
      try {
        resp = JSON.parse(event.data);
      } catch {
        return;
      }

      if (resp.type === "capture_started") {
        captureStarted = true;
        addToLog(`Capture started for ${file.name}`, "success");
        addToLog(`PCAP: ${resp.pcap_file}`, "info");
        addToLog(`File size: ${file.size} bytes`, "info");
        addToLog(`Chunk size: ${CHUNK_SIZE} bytes`, "info");
        await streamFileToSocketSingle(file, duration);
      } else if (resp.type === "capture_complete") {
        clearTimeout(timeout);
        completed = true;
        addToLog(
          `Stream complete. PCAP: ${resp.pcap_file} (${(resp.size_bytes / 1024).toFixed(1)} KB)`,
          "success",
        );
        showToast("Stream complete", "success");
        updateStatusBadge("Completed");
        updateProgress(100);
        cleanupStreaming();
      } else if (resp.type === "error") {
        addToLog(`Server error: ${resp.message}`, "error");
        cleanupStreaming();
      }
    };

    streamingSocket.onerror = () => {
      addToLog("WebSocket error", "error");
      cleanupStreaming();
    };

    streamingSocket.onclose = () => {
      if (!completed && captureStarted) {
        addToLog("WebSocket closed unexpectedly", "warning");
        cleanupStreaming();
      }
    };
  } catch (err) {
    addToLog(`Connection failed: ${err.message}`, "error");
    cleanupStreaming();
  }
}

async function streamFileToSocketSingle(file, durationSeconds) {
  const totalSize = file.size;
  const bytesPerSecond = totalSize / durationSeconds;
  let offset = 0;
  const startTime = Date.now();

  function sendNext() {
    if (!streamingActive || streamingSocket.readyState !== WebSocket.OPEN)
      return;

    const elapsedMs = Date.now() - startTime;
    const shouldHaveSent = (elapsedMs / 1000) * bytesPerSecond;

    if (offset > shouldHaveSent && offset < totalSize) {
      const waitMs = ((offset - shouldHaveSent) / bytesPerSecond) * 1000;
      setTimeout(sendNext, Math.max(waitMs, 10));
      return;
    }

    if (offset >= totalSize) {
      streamingSocket.send(
        JSON.stringify({
          type: "eof",
          total_chunks: chunkCount,
          total_bytes: totalBytesSent,
        }),
      );
      addToLog(
        `EOF sent: ${chunkCount} chunks, ${(totalBytesSent / 1024).toFixed(1)} KB`,
        "success",
      );
      return;
    }

    const size = Math.min(CHUNK_SIZE, totalSize - offset);
    const blob = file.slice(offset, offset + size);
    const reader = new FileReader();

    reader.onload = (e) => {
      if (streamingSocket.readyState === WebSocket.OPEN) {
        streamingSocket.send(e.target.result);
        chunkCount++;
        totalBytesSent += size;
        offset += size;

        if (chunkCount % 50 === 0) {
          const elapsed = (Date.now() - startTime) / 1000;
          document.getElementById("chunkCount").textContent = chunkCount;
          document.getElementById("bytesSent").textContent =
            (totalBytesSent / 1024).toFixed(1) + " KB";
          document.getElementById("streamTime").textContent =
            elapsed.toFixed(1) + "s";
          document.getElementById("packetRate").textContent = Math.round(
            chunkCount / elapsed,
          );
          updateProgress((offset / totalSize) * 100);
          addToLog(
            `Progress: ${Math.round((offset / totalSize) * 100)}%, ${chunkCount} chunks`,
            "stream",
          );
        }
        setTimeout(sendNext, 0);
      }
    };
    reader.readAsArrayBuffer(blob);
  }

  sendNext();
}

function stopStreaming() {
  streamingActive = false;
  if (streamingSocket) streamingSocket.close();
  addToLog("Streaming stopped", "warning");
  cleanupStreaming();
}

function cleanupStreaming() {
  streamingActive = false;
  if (streamingSocket) {
    try {
      streamingSocket.close();
    } catch (e) {}
    streamingSocket = null;
  }

  const tcpBtn = document.getElementById("streamBtnTCP");
  const udpBtn = document.getElementById("streamBtnUDP");
  const webrtcBtn = document.getElementById("streamBtn3478");

  if (tcpBtn) {
    tcpBtn.disabled = false;
    tcpBtn.innerHTML = "Start TCP stream (port 443)";
  }
  if (udpBtn) {
    udpBtn.disabled = false;
    udpBtn.innerHTML = "Start UDP stream (port 443)";
  }
  if (webrtcBtn) {
    webrtcBtn.disabled = false;
    webrtcBtn.innerHTML = "Start WebRTC stream (port 3478)";
  }

  document.getElementById("streamBtn").disabled = false;
  document.getElementById("streamBtn").innerHTML = "Start streaming";
  document.getElementById("statsGrid").style.display = "none";
  if (!batchActive) updateStatusBadge("Ready");

  cleanupWebRTC();
}

// =========================================================
// REST API CALLS
// =========================================================
async function checkHealth() {
  addToLog("Checking server health…");
  try {
    const r = await fetch(`${getBaseUrl()}/health`, { headers: getHeaders() });
    await r.json();
    addToLog("Server is healthy", "success");
    showToast("Server is healthy", "success");
  } catch (e) {
    addToLog(`Health check failed: ${e.message}`, "error");
    showToast("Server unreachable", "error");
  }
}

async function fetchInterfaces() {
  addToLog("Fetching interfaces…");
  try {
    const r = await fetch(`${getBaseUrl()}/interfaces`, {
      headers: getHeaders(),
    });
    const d = await r.json();
    const panel = document.getElementById("interfacesPanel");
    const log = document.getElementById("interfacesLog");
    panel.style.display = "block";
    log.innerHTML = "";
    if (d.interfaces && d.interfaces.length) {
      d.interfaces.forEach((i) => {
        const row = document.createElement("div");
        row.textContent = `${i.name}  IP: ${i.ip}  MAC: ${i.mac}`;
        log.appendChild(row);
      });
      addToLog(`${d.interfaces.length} interface(s) found`, "success");
    }
  } catch (e) {
    addToLog(`Interfaces fetch failed: ${e.message}`, "error");
  }
}

async function startCapture() {
  const port = currentStreamPort;
  const videoType = document.getElementById("videoTypeSelect").value;

  const networkDropdown = document.getElementById("networkLocation");
  const networkFromDropdown = networkDropdown
    ? networkDropdown.value
    : selectedNetwork;

  if (networkFromDropdown !== selectedNetwork) {
    addToLog(
      `Network mismatch. Dropdown: ${networkFromDropdown}, variable: ${selectedNetwork}. Using the dropdown value.`,
      "warning",
    );
    selectedNetwork = networkFromDropdown;
    localStorage.setItem("SELECTED_NETWORK", networkFromDropdown);
  }

  addToLog(
    `Server capture. Device: ${selectedDevice}, dataset: ${selectedDataset}, type: ${videoType}, port: ${port}, network: ${selectedNetwork}`,
    "info",
  );

  const payload = {
    device: selectedDevice,
    dataset: selectedDataset,
    type: videoType,
    port: parseInt(port),
    network: selectedNetwork,
  };

  addToLog(`Sending request with network "${selectedNetwork}"`, "debug");
  addToLog(`Full payload: ${JSON.stringify(payload)}`, "debug");

  try {
    const response = await fetch(`${getBaseUrl()}/capture`, {
      method: "POST",
      headers: getHeaders(),
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (response.ok) {
      currentCaptureId = data.capture_id;
      addToLog(`Capture started. ID: ${data.capture_id}`, "success");
      addToLog(
        `Files will be saved to: .../${selectedDevice}/${selectedDataset}/${videoType}/${port}/${selectedNetwork}/`,
        "success",
      );
      showToast("Capture started", "success");
    } else {
      addToLog(`Failed: ${data.error}`, "error");
    }
  } catch (err) {
    addToLog(`Error: ${err.message}`, "error");
  }
}

// =========================================================
// INIT
// =========================================================
document.addEventListener("DOMContentLoaded", () => {
  const savedIp = localStorage.getItem("SERVER_IP");
  const savedPort = localStorage.getItem("SERVER_PORT");
  const savedNgrok = localStorage.getItem("NGROK_URL");
  const savedMode = localStorage.getItem("CONNECTION_MODE");

  if (savedIp) LOCAL_IP = savedIp;
  if (savedPort) LOCAL_PORT = savedPort;
  if (savedNgrok) NGROK_URL = savedNgrok;
  if (savedMode) currentMode = savedMode;

  const ipInput = document.getElementById("serverIpInput");
  const portInput = document.getElementById("serverPortInput");
  const ngrokInput = document.getElementById("ngrokUrlInput");

  if (ipInput) ipInput.value = LOCAL_IP;
  if (portInput) portInput.value = LOCAL_PORT;
  if (ngrokInput) ngrokInput.value = NGROK_URL;

  setMode(currentMode);
  selectDevice("computer");

  const datasetSelect = document.getElementById("datasetSelect");
  if (datasetSelect) {
    datasetSelect.value = selectedDataset;
  }

  const networkSelect = document.getElementById("networkLocation");
  if (networkSelect) {
    networkSelect.value = selectedNetwork;
    console.log(`[Init] Network dropdown set to: ${selectedNetwork}`);

    const networkValue = document.getElementById("networkValue");
    if (networkValue) networkValue.textContent = selectedNetwork.toUpperCase();
  }

  fetchInterfaces();
  displaySavedLogs();
  detectNetworkInfo();

  addToLog(
    `Initialized. Network: ${selectedNetwork}, dataset: ${selectedDataset}`,
    "info",
  );
});