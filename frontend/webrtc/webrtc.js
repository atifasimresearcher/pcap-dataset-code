const FETCH_TIMEOUT_MS = 60000;
const ICE_TIMEOUT_MS = 10000;
const LOG_STORAGE_KEY = "webrtc_batch_logs";
const BACKEND_URL_KEY = "webrtc_backend_url";
const STUN_SERVERS = [
  "stun:stun.l.google.com:19302",
  "stun:stun1.l.google.com:19302",
  "stun:stun2.l.google.com:19302",
];

const state = {
  selectedFiles: [],
  captures: {},
  ws: null,
  peerConnections: {},
  localStream: null,
  totalSize: 0,
  backendUrl: "http://localhost:5001",
  stats: { total: 0, completed: 0, failed: 0 },
};

const previewVideo = document.getElementById("previewVideo");
const previewCanvas = document.getElementById("previewCanvas");
const previewCtx = previewCanvas.getContext("2d");
let rafHandle = null;

// ---------------------------------------------------------
// Headers
// ---------------------------------------------------------
function getHeaders() {
  const h = { "Content-Type": "application/json" };
  if (state.backendUrl.includes("ngrok")) {
    h["ngrok-skip-browser-warning"] = "true";
  }
  return h;
}

// ---------------------------------------------------------
// Path preview and mode badge
// ---------------------------------------------------------
function updatePathPreview() {
  const device = document.getElementById("deviceType").value;
  const dataset = document.getElementById("datasetType").value;
  const vtype = document.getElementById("videoType").value;
  const network = document.getElementById("networkType").value;
  document.getElementById("pathPreview").textContent =
    `packet-dataset / ${device} / ${dataset} / ${vtype} / webrtc / ${network} /`;
}

function updateModeBadge(url) {
  const badge = document.getElementById("modeBadge");
  if (url.includes("ngrok")) {
    badge.textContent = "NGROK";
    badge.className = "badge-pill mode-ngrok";
  } else {
    badge.textContent = "LOCAL";
    badge.className = "badge-pill mode-local";
  }
}

// ---------------------------------------------------------
// File management
// ---------------------------------------------------------
document.getElementById("videoFiles").addEventListener("change", (e) => {
  state.selectedFiles = Array.from(e.target.files);
  displayFileList();
  updateStats();
});

function displayFileList() {
  const fl = document.getElementById("fileList");
  fl.innerHTML = "";
  state.selectedFiles.forEach((file, i) => {
    const item = document.createElement("div");
    item.className = "file-item";

    const info = document.createElement("div");
    info.className = "file-info";
    const name = document.createElement("div");
    name.className = "file-name";
    name.textContent = file.name;
    const size = document.createElement("div");
    size.className = "file-size";
    size.textContent = `${(file.size / 1024 / 1024).toFixed(2)} MB`;
    info.append(name, size);

    const remove = document.createElement("button");
    remove.className = "remove-btn";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => removeFile(i));

    item.append(info, remove);
    fl.appendChild(item);
  });
  document.getElementById("startBtn").disabled =
    state.selectedFiles.length === 0;
  document.getElementById("connText").textContent = state.selectedFiles.length
    ? `${state.selectedFiles.length} file(s) selected`
    : "Waiting for files…";
}

function removeFile(i) {
  state.selectedFiles.splice(i, 1);
  document.getElementById("videoFiles").value = "";
  displayFileList();
  updateStats();
}

function clearFileList() {
  state.selectedFiles = [];
  document.getElementById("videoFiles").value = "";
  displayFileList();
  updateStats();
  stopCanvasDrawing();
  setPreviewIdle();
}

// ---------------------------------------------------------
// Preview toggle (saves CPU on tablets)
// ---------------------------------------------------------
let previewVisible = true;
function togglePreview() {
  previewVisible = !previewVisible;
  const btn = document.getElementById("previewToggle");
  const grid = document.getElementById("previewGrid");
  if (previewVisible) {
    grid.style.display = "grid";
    btn.textContent = "Hide preview";
    addLog("Preview shown", "info");
  } else {
    grid.style.display = "none";
    btn.textContent = "Show preview";
    addLog("Preview hidden. CPU use is lower.", "info");
  }
}

// ---------------------------------------------------------
// Canvas drawing, throttled to 15 fps
// ---------------------------------------------------------
let lastFrameTime = 0;
const FRAME_INTERVAL = 1000 / 15;

function drawCanvasMessage(text, size, fill) {
  previewCtx.fillStyle = fill;
  previewCtx.fillRect(0, 0, previewCanvas.width, previewCanvas.height);
  previewCtx.fillStyle = "#888";
  previewCtx.font = `${size}px Segoe UI, sans-serif`;
  previewCtx.textAlign = "center";
  previewCtx.fillText(text, previewCanvas.width / 2, previewCanvas.height / 2);
}

function setPreviewIdle() {
  const vs = document.getElementById("videoStatus");
  const cs = document.getElementById("canvasStatus");
  vs.textContent = "Idle: no file loaded";
  vs.className = "preview-status idle";
  cs.textContent = "Idle: waiting for stream";
  cs.className = "preview-status idle";
  drawCanvasMessage("No stream active", 28, "#111");
}

function setPreviewActive(filename) {
  const vs = document.getElementById("videoStatus");
  const cs = document.getElementById("canvasStatus");
  vs.textContent = `Playing: ${filename}`;
  vs.className = "preview-status active";
  cs.textContent = "Live: streaming over WebRTC";
  cs.className = "preview-status active";
}

function stopCanvasDrawing() {
  if (rafHandle) {
    cancelAnimationFrame(rafHandle);
    rafHandle = null;
  }
}

function startCanvasDrawing() {
  stopCanvasDrawing();
  const draw = (timestamp) => {
    if (timestamp - lastFrameTime >= FRAME_INTERVAL) {
      lastFrameTime = timestamp;
      if (previewVisible) {
        if (previewVideo && !previewVideo.paused && !previewVideo.ended) {
          previewCtx.drawImage(
            previewVideo,
            0,
            0,
            previewCanvas.width,
            previewCanvas.height,
          );
        } else {
          drawCanvasMessage("Video paused or ended", 22, "#111");
        }
      } else {
        // Preview hidden, but the canvas stream still needs frames
        previewCtx.fillStyle = "#000";
        previewCtx.fillRect(0, 0, previewCanvas.width, previewCanvas.height);
      }
    }
    rafHandle = requestAnimationFrame(draw);
  };
  rafHandle = requestAnimationFrame(draw);
}

// ---------------------------------------------------------
// WebSocket
// ---------------------------------------------------------
function connectWebSocket() {
  const btn = document.getElementById("connectBtn");
  btn.disabled = true;
  btn.textContent = "Connecting…";
  const url =
    document.getElementById("backendUrl").value.trim() || state.backendUrl;
  state.backendUrl = url;
  localStorage.setItem(BACKEND_URL_KEY, url);
  updateModeBadge(url);
  const proto = url.startsWith("https") ? "wss:" : "ws:";
  const wsUrl = `${proto}//${url.replace(/^https?:\/\//, "")}/ws/webrtc-batch`;
  addLog(`Connecting: ${wsUrl}`, "info");
  state.ws = new WebSocket(wsUrl);
  state.ws.onopen = () => {
    addLog("WebSocket connected", "success");
    updateConnectionStatus(true);
    btn.disabled = false;
    btn.textContent = "Reconnect";
  };
  state.ws.onerror = () => {
    addLog("WebSocket error", "error");
    updateConnectionStatus(false);
    btn.disabled = false;
    btn.textContent = "Connect";
  };
  state.ws.onclose = () => {
    addLog("WebSocket disconnected", "warning");
    updateConnectionStatus(false);
    btn.disabled = false;
    btn.textContent = "Connect";
  };
  state.ws.onmessage = (e) => {
    try {
      handleWsMessage(JSON.parse(e.data));
    } catch (_) {}
  };
}

function handleWsMessage(msg) {
  const { type, capture_id, sdp_answer, ice_candidate, error, pcap_size } = msg;
  switch (type) {
    case "signaling_answer":
      handleSignalingAnswer(capture_id, sdp_answer);
      break;
    case "ice_candidate":
      handleRemoteIce(capture_id, ice_candidate);
      break;
    case "capture_started":
      addLog(`Started: ${msg.filename}`, "info");
      updateProgressItem(capture_id, "capturing", 10);
      break;
    case "capture_progress":
      updateProgressItem(
        capture_id,
        "capturing",
        msg.progress || 0,
        msg.details,
      );
      break;
    case "capture_complete":
      state.stats.completed++;
      state.totalSize += pcap_size || 0;
      updateProgressItem(
        capture_id,
        "complete",
        100,
        `PCAP: ${((pcap_size || 0) / 1024).toFixed(2)} KB`,
      );
      addLog(
        `Complete: ${msg.filename} (${((pcap_size || 0) / 1024).toFixed(2)} KB)`,
        "success",
      );
      cleanupPC(capture_id);
      updateStats();
      break;
    case "capture_error":
      state.stats.failed++;
      updateProgressItem(capture_id, "error", 0, `Error: ${error}`);
      addLog(`Failed: ${msg.filename}. ${error}`, "error");
      cleanupPC(capture_id);
      updateStats();
      break;
  }
}

// ---------------------------------------------------------
// Media stream
// ---------------------------------------------------------
async function setupMediaStream(videoFile = null) {
  try {
    const source = document.getElementById("streamSource").value;
    if (source === "camera") {
      addLog("Requesting camera…", "info");
      state.localStream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true,
      });
      previewVideo.srcObject = state.localStream;
      previewVideo.play();
      setPreviewActive("Camera");
    } else if (source === "screen") {
      addLog("Requesting screen share…", "info");
      state.localStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      });
      previewVideo.srcObject = state.localStream;
      previewVideo.play();
      setPreviewActive("Screen share");
    } else {
      if (videoFile) {
        previewVideo.srcObject = null;
        previewVideo.src = URL.createObjectURL(videoFile);
        previewVideo.muted = true;
        previewVideo.loop = false;
        await new Promise((res) => {
          previewVideo.onloadedmetadata = res;
          previewVideo.onerror = res;
          setTimeout(res, 3000);
        });
        previewVideo.play();
        setPreviewActive(videoFile.name);
        addLog(
          `Playing: ${videoFile.name} (${previewVideo.duration.toFixed(1)}s)`,
          "info",
        );
      }
      startCanvasDrawing();
      state.localStream = previewCanvas.captureStream(10); // 10 fps saves memory on tablets
      addLog("Canvas stream ready (10 fps)", "success");
    }
    return state.localStream;
  } catch (err) {
    addLog(`Media stream error: ${err.message}`, "error");
    return null;
  }
}

// ---------------------------------------------------------
// WebRTC capture
// ---------------------------------------------------------
async function startWebRTCCapture(captureId, filename, config) {
  try {
    const pc = new RTCPeerConnection({
      iceServers: STUN_SERVERS.map((u) => ({ urls: u })),
    });
    state.peerConnections[captureId] = pc;

    if (state.localStream)
      state.localStream.getTracks().forEach((t) => {
        pc.addTrack(t, state.localStream);
        addLog(`Added ${t.kind} track`, "info");
      });

    pc.onconnectionstatechange = () =>
      addLog(`${filename}: connection ${pc.connectionState}`, "info");
    pc.oniceconnectionstatechange = () =>
      addLog(`${filename}: ICE ${pc.iceConnectionState}`, "info");

    addLog(`Creating offer for ${filename}…`, "info");
    const offer = await pc.createOffer({
      offerToReceiveAudio: false,
      offerToReceiveVideo: false,
    });
    await pc.setLocalDescription(offer);

    // ICE gathering with a hard timeout
    addLog(`Gathering ICE candidates (max ${ICE_TIMEOUT_MS / 1000}s)…`, "info");
    await new Promise((resolve) => {
      if (pc.iceGatheringState === "complete") {
        resolve();
        return;
      }
      const t = setTimeout(() => {
        addLog("ICE gathering timed out. Continuing.", "warning");
        resolve();
      }, ICE_TIMEOUT_MS);
      pc.onicegatheringstatechange = () => {
        addLog(`ICE gathering: ${pc.iceGatheringState}`, "info");
        if (pc.iceGatheringState === "complete") {
          clearTimeout(t);
          resolve();
        }
      };
    });

    const sdp = pc.localDescription.sdp;
    addLog(`Sending offer (${sdp.length} chars)…`, "info");

    const ctrl = new AbortController();
    const ft = setTimeout(() => {
      addLog(`Fetch timed out (${FETCH_TIMEOUT_MS / 1000}s)`, "error");
      ctrl.abort();
    }, FETCH_TIMEOUT_MS);

    let offerData;
    try {
      const resp = await fetch(`${state.backendUrl}/api/webrtc/offer`, {
        method: "POST",
        headers: getHeaders(),
        body: JSON.stringify({
          capture_id: captureId,
          filename,
          sdp_offer: sdp,
          config,
        }),
        signal: ctrl.signal,
      });
      clearTimeout(ft);
      addLog(
        `Response: ${resp.status} ${resp.statusText}`,
        resp.ok ? "success" : "error",
      );
      if (!resp.ok) {
        const t = await resp.text();
        throw new Error(`HTTP ${resp.status}: ${t.substring(0, 200)}`);
      }
      offerData = await resp.json();
      if (offerData.error) throw new Error(offerData.error);
    } catch (fe) {
      clearTimeout(ft);
      addLog(`Fetch failed: ${fe.message}`, "error");
      throw fe;
    }

    if (offerData.sdp_answer) {
      addLog("Setting remote description…", "info");
      await pc.setRemoteDescription(
        new RTCSessionDescription({ type: "answer", sdp: offerData.sdp_answer }),
      );
      addLog(
        `WebRTC negotiation complete. Capturing ${config.duration}s…`,
        "success",
      );
      addLog(
        `Saving to: .../${config.device_type}/${config.dataset_type}/${config.video_type}/webrtc/${config.network_type}/`,
        "info",
      );
      updateProgressItem(
        captureId,
        "capturing",
        50,
        `Capturing ${config.duration}s…`,
      );
    } else {
      addLog("No sdp_answer in response", "warning");
    }
  } catch (err) {
    addLog(`WebRTC error for ${filename}: ${err.message}`, "error");
    state.stats.failed++;
    updateProgressItem(captureId, "error", 0, err.message);
    updateStats();
  }
}

async function handleSignalingAnswer(captureId, sdpAnswer) {
  try {
    const pc = state.peerConnections[captureId];
    if (!pc) return;
    await pc.setRemoteDescription(
      new RTCSessionDescription({ type: "answer", sdp: sdpAnswer }),
    );
  } catch (err) {
    addLog(`SDP answer error: ${err.message}`, "error");
  }
}

async function handleRemoteIce(captureId, candidate) {
  try {
    const pc = state.peerConnections[captureId];
    if (pc && candidate) await pc.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (_) {}
}

function cleanupPC(captureId) {
  const pc = state.peerConnections[captureId];
  if (pc) {
    pc.close();
    delete state.peerConnections[captureId];
  }
}

// ---------------------------------------------------------
// Batch capture
// ---------------------------------------------------------
async function startBatchCapture() {
  if (!state.selectedFiles.length) {
    alert("Select at least one video file.");
    return;
  }

  state.captures = {};
  state.stats = { total: 0, completed: 0, failed: 0 };
  state.totalSize = 0;
  document.getElementById("progressList").innerHTML = "";

  const config = {
    device_type: document.getElementById("deviceType").value,
    dataset_type: document.getElementById("datasetType").value,
    video_type: document.getElementById("videoType").value,
    network_type: document.getElementById("networkType").value,
    duration: parseInt(document.getElementById("captureDuration").value),
    stream_source: document.getElementById("streamSource").value,
  };

  addLog(
    `Save path: packet-dataset/${config.device_type}/${config.dataset_type}/${config.video_type}/webrtc/${config.network_type}/`,
    "info",
  );

  state.stats.total = state.selectedFiles.length;
  updateStats();
  const source = document.getElementById("streamSource").value;

  try {
    if (source === "camera" || source === "screen") {
      addLog(`Batch of ${state.selectedFiles.length} files, shared stream`, "info");
      const stream = await setupMediaStream();
      if (!stream) throw new Error("Failed to acquire media stream");
      for (const file of state.selectedFiles) {
        const id = Math.random().toString(36).substr(2, 9);
        state.captures[id] = { status: "waiting", filename: file.name };
        createProgressItem(id, file.name, "waiting");
        await new Promise((r) => setTimeout(r, 300));
        await startWebRTCCapture(id, file.name, config);
      }
    } else {
      addLog(`Batch of ${state.selectedFiles.length} files, canvas mode`, "info");
      for (let i = 0; i < state.selectedFiles.length; i++) {
        const file = state.selectedFiles[i];
        const id = Math.random().toString(36).substr(2, 9);
        state.captures[id] = { status: "waiting", filename: file.name };
        createProgressItem(id, file.name, "waiting");
        addLog(`[${i + 1}/${state.selectedFiles.length}] ${file.name}`, "info");

        const stream = await setupMediaStream(file);
        if (!stream) {
          addLog(`No stream for ${file.name}`, "error");
          state.stats.failed++;
          updateStats();
          continue;
        }

        await new Promise((r) => setTimeout(r, 500));
        await startWebRTCCapture(id, file.name, config);

        const wait = (config.duration + 2) * 1000;
        addLog(`Waiting ${config.duration + 2}s before the next file…`, "info");
        await new Promise((r) => setTimeout(r, wait));
      }
    }

    addLog(`All ${state.selectedFiles.length} files processed`, "success");
    stopCanvasDrawing();
    setPreviewIdle();
  } catch (err) {
    addLog(`Batch error: ${err.message}`, "error");
  }
}

// ---------------------------------------------------------
// Progress UI
// ---------------------------------------------------------
function createProgressItem(id, filename, status) {
  const el = document.createElement("div");
  el.id = `progress-${id}`;
  el.className = "progress-item";
  el.innerHTML = `
    <div class="progress-header">
      <div class="progress-name"></div>
      <div class="progress-status status-waiting" id="status-${id}"></div>
    </div>
    <div class="progress-bar"><div class="progress-fill" id="fill-${id}"></div></div>
    <div class="progress-details">
      <span id="details-${id}">Initialising…</span>
      <span id="time-${id}">-</span>
    </div>`;
  el.querySelector(".progress-name").textContent = filename;
  el.querySelector(".progress-status").textContent = status;
  document.getElementById("progressList").appendChild(el);
}

function updateProgressItem(id, status, progress, details = "") {
  const s = document.getElementById(`status-${id}`);
  const f = document.getElementById(`fill-${id}`);
  const d = document.getElementById(`details-${id}`);
  if (s) {
    s.className = `progress-status status-${status}`;
    s.textContent = status;
  }
  if (f) f.style.width = progress + "%";
  if (d && details) d.textContent = details;
}

// ---------------------------------------------------------
// Logging and stats
// ---------------------------------------------------------
function addLog(message, type = "info") {
  const c = document.getElementById("logContainer");
  const l = document.createElement("div");
  l.className = `log-line log-${type}`;
  const stamp = document.createElement("span");
  stamp.className = "log-timestamp";
  stamp.textContent = `[${new Date().toLocaleTimeString()}]`;
  l.append(stamp, ` ${message}`);
  c.appendChild(l);
  c.scrollTop = c.scrollHeight;
  try {
    let logs = JSON.parse(localStorage.getItem(LOG_STORAGE_KEY)) || [];
    logs.push({ timestamp: new Date().toISOString(), message, type });
    if (logs.length > 500) logs = logs.slice(-500);
    localStorage.setItem(LOG_STORAGE_KEY, JSON.stringify(logs));
  } catch (_) {}
}

function updateStats() {
  document.getElementById("totalFiles").textContent = state.stats.total;
  document.getElementById("completedFiles").textContent = state.stats.completed;
  document.getElementById("failedFiles").textContent = state.stats.failed;
  document.getElementById("totalSize").textContent =
    (state.totalSize / 1024 / 1024).toFixed(2) + " MB";
}

function updateConnectionStatus(connected) {
  const el = document.getElementById("connectionStatus");
  el.className = `connection-pill ${connected ? "connected" : "disconnected"}`;
  el.textContent = connected ? "Connected" : "Disconnected";
  const dot = document.getElementById("connStatus");
  dot.className = `status-indicator ${connected ? "status-connected" : "status-disconnected"}`;
}

// ---------------------------------------------------------
// Init
// ---------------------------------------------------------
document.addEventListener("DOMContentLoaded", () => {
  const saved = localStorage.getItem(BACKEND_URL_KEY);
  if (saved) state.backendUrl = saved;
  document.getElementById("backendUrl").value = state.backendUrl;
  updateModeBadge(state.backendUrl);

  document
    .getElementById("backendUrl")
    .addEventListener("input", (e) => updateModeBadge(e.target.value));
  document
    .getElementById("connectBtn")
    .addEventListener("click", connectWebSocket);

  updatePathPreview();
  setPreviewIdle();
  displayFileList();
  addLog("WebRTC batch capture ready", "info");
  addLog("Folder structure: device/dataset/fake-or-real/webrtc/network", "info");
  addLog(
    `Fetch timeout: ${FETCH_TIMEOUT_MS / 1000}s, ICE timeout: ${ICE_TIMEOUT_MS / 1000}s`,
    "info",
  );
});