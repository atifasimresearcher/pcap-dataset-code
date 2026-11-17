#!/usr/bin/env python3
"""
Flask backend for the deepfake capture API.

PCAP folder layout:
    <base>/<device>/<dataset>/<video_type>/<port>/<protocol>/<network>/<file>.pcapng
Supports WebSocket streaming, client IP filtering and a heartbeat.
"""

import json
import logging
import os
import re
import select
import subprocess
import threading
import time
import traceback
import uuid
from datetime import datetime
from pathlib import Path

import netifaces
from flask import Flask, jsonify, make_response, request, send_file
from flask_sock import Sock

try:
    from webrtc_signaling import register_webrtc_signaling
except ImportError:
    register_webrtc_signaling = None

logger = logging.getLogger(__name__)

app = Flask(__name__)

CORS_METHODS = "GET, POST, PUT, DELETE, OPTIONS, HEAD"
CORS_HEADERS = (
    "Content-Type, Authorization, ngrok-skip-browser-warning, "
    "X-Requested-With, Accept, Origin"
)


@app.before_request
def handle_preflight():
    if request.method == "OPTIONS":
        response = make_response()
        response.headers["Access-Control-Allow-Origin"] = "*"
        response.headers["Access-Control-Allow-Methods"] = CORS_METHODS
        response.headers["Access-Control-Allow-Headers"] = CORS_HEADERS
        response.headers["Access-Control-Max-Age"] = "86400"
        return response, 200


@app.after_request
def after_request(response):
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Methods"] = CORS_METHODS
    response.headers["Access-Control-Allow-Headers"] = CORS_HEADERS
    return response


sock = Sock(app)


# ---------------------------------------------------------
# WebRTC signaling WebSocket
# ---------------------------------------------------------
@sock.route("/ws/webrtc-batch")
def webrtc_batch_ws(ws):
    from webrtc_signaling import handle_signaling_message, ws_clients

    ws_clients.add(ws)
    logger.info("WebRTC signaling WebSocket client connected")
    print("WebRTC signaling WebSocket client connected")

    try:
        while True:
            try:
                data = ws.receive()
                if data:
                    handle_signaling_message(json.loads(data))
            except json.JSONDecodeError as e:
                logger.error(f"Invalid JSON from client: {e}")
                continue
    except Exception as e:
        logger.error(f"WebSocket error: {e}")
    finally:
        ws_clients.discard(ws)
        logger.info("WebRTC signaling WebSocket client disconnected")
        print("WebRTC signaling WebSocket client disconnected")


if register_webrtc_signaling:
    register_webrtc_signaling(app, sock)
    print("WebRTC signaling server registered (browser to backend)")
else:
    print("WebRTC signaling module not available (aiortc not installed)")


@app.route("/api/debug/post-test", methods=["POST"])
def debug_post_test():
    """Check that POST requests reach the backend."""
    data = request.get_json()
    print(f"Debug POST received: {data}")
    return jsonify({"status": "ok", "received": data})


# ---------------------------------------------------------
# Configuration
# ---------------------------------------------------------
BASE_DATASET_PATHS = {
    3: "/Users/atifasim/documents/deepfake/packet-dataset-3s",
    6: "/Users/atifasim/documents/deepfake/packet-dataset-6s",
}
VIDEO_SOURCE_ROOT = "/Users/atifasim/documents/deepfake/hidf"

AVAILABLE_DEVICES = ["computer", "mobile", "tablet"]
AVAILABLE_DATASETS = ["hidf", "sdfvd"]
AVAILABLE_TYPES = ["real", "fake"]
AVAILABLE_PORTS = [443, 3478]
AVAILABLE_NETWORKS = ["jazz", "wifi"]
AVAILABLE_DURATIONS = [3, 6]

DEFAULT_PORT = 5001
DEFAULT_DURATION = 3
active_captures = {}
active_streams = {}

# Read from the environment so the password is not stored in the source file.
# Set it with: export SUDO_PASSWORD='...'
SUDO_PASSWORD = os.environ.get("SUDO_PASSWORD", "your_computer_password_here")


def get_base_dataset_path(duration=3):
    if duration not in BASE_DATASET_PATHS:
        duration = DEFAULT_DURATION
    return BASE_DATASET_PATHS[duration]


# ---------------------------------------------------------
# Helpers
# ---------------------------------------------------------
def ensure_dir(directory):
    Path(directory).mkdir(parents=True, exist_ok=True)


def sanitize_filename(filename):
    name = Path(filename).stem
    return re.sub(r'[<>:"/\\|?*]', "_", name)


def get_pcap_path(device, dataset, video_type, port, protocol, network,
                  original_filename, duration=3):
    base_name = sanitize_filename(original_filename)
    base_path = get_base_dataset_path(duration)
    folder = f"{base_path}/{device}/{dataset}/{video_type}/{port}/{protocol}/{network}"
    ensure_dir(folder)

    pcap_path = f"{folder}/{base_name}.pcapng"
    counter = 1
    while os.path.exists(pcap_path):
        pcap_path = f"{folder}/{base_name}_{counter}.pcapng"
        counter += 1
    return pcap_path


def get_failure_report_path(capture_id, duration=3):
    report_dir = f"{get_base_dataset_path(duration)}/reports"
    ensure_dir(report_dir)
    return f"{report_dir}/failure_report_{capture_id}.json"


def save_failure_report(capture_id, failed_files, duration=3):
    report_path = get_failure_report_path(capture_id, duration)
    report = {
        "capture_id": capture_id,
        "duration": duration,
        "timestamp": datetime.now().isoformat(),
        "total_failed": len(failed_files),
        "failed_files": failed_files,
    }
    with open(report_path, "w") as f:
        json.dump(report, f, indent=2)
    return report_path


def kill_process(proc):
    if proc and proc.poll() is None:
        proc.terminate()
        time.sleep(1)
        if proc.poll() is None:
            proc.kill()
            time.sleep(1)


def get_network_interfaces():
    interfaces = []
    try:
        for iface in netifaces.interfaces():
            if iface in ("lo0", "lo"):
                continue
            addrs = netifaces.ifaddresses(iface)
            if netifaces.AF_INET in addrs:
                for addr in addrs[netifaces.AF_INET]:
                    ip = addr["addr"]
                    if not ip.startswith("127.") and not ip.startswith("169.254."):
                        interfaces.append(
                            {
                                "name": iface,
                                "ip": ip,
                                "mac": addrs.get(netifaces.AF_LINK, [{}])[0].get(
                                    "addr", "Unknown"
                                ),
                            }
                        )
    except Exception as e:
        print(f"Error getting interfaces: {e}")
        interfaces = [{"name": "en0", "ip": "192.168.1.50", "mac": "Auto-detected"}]
    return interfaces


def get_main_interface():
    interfaces = get_network_interfaces()
    if interfaces:
        return interfaces[0]["name"]
    return "en0"


def start_tcpdump(output_pcap, filter_expr, interface="lo0"):
    tcpdump_cmd = [
        "sudo", "-S", "tcpdump",
        "-i", interface,
        "-U",
        "-n",
        "-l",
        "-B", "4096",
        "-w", output_pcap,
        filter_expr,
    ]

    print(f"   Starting tcpdump on {interface}: {filter_expr}")

    try:
        tcpdump = subprocess.Popen(
            tcpdump_cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
        )

        tcpdump.stdin.write(f"{SUDO_PASSWORD}\n")
        tcpdump.stdin.flush()
        time.sleep(2)

        if tcpdump.poll() is not None:
            stderr = tcpdump.stderr.read()
            print(f"   tcpdump exited immediately: {stderr[:300]}")
            return None

        ready, _, _ = select.select([tcpdump.stderr], [], [], 0.2)
        if ready:
            line = tcpdump.stderr.readline()
            if line and "permission denied" in line.lower():
                print("   Permission denied. Check SUDO_PASSWORD.")
                kill_process(tcpdump)
                return None

        print(f"   tcpdump running (PID {tcpdump.pid}) on {interface}")
        return tcpdump

    except Exception as e:
        print(f"   start_tcpdump failed: {e}")
        return None


def stop_tcpdump(tcpdump, output_pcap):
    if not tcpdump:
        return None

    print("   Stopping tcpdump...")
    kill_process(tcpdump)
    time.sleep(1)

    if os.path.exists(output_pcap):
        size = os.path.getsize(output_pcap)
        size_kb = size / 1024
        print(f"   PCAP size: {size_kb:.2f} KB ({size} bytes)")
        return {"size": size, "size_kb": size_kb, "path": output_pcap}

    print("   PCAP file not found")
    return None


# ---------------------------------------------------------
# Server-side batch capture
# ---------------------------------------------------------
def capture_video(video_path, output_pcap, port, device_type, client_ip, duration=3):
    video_name = os.path.basename(video_path)
    print(f"\n   {video_name}  device={device_type}  port={port}")
    os.makedirs(os.path.dirname(output_pcap), exist_ok=True)

    # en0 is the real network interface; lo0 would only see localhost traffic
    tcpdump_cmd = [
        "sudo", "-S", "tcpdump", "-i", "en0",
        "-U", "-w", output_pcap,
        "-B", "4096",
        f"port {port}",
    ]

    try:
        tcpdump = subprocess.Popen(
            tcpdump_cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
        )
        tcpdump.stdin.write(f"{SUDO_PASSWORD}\n")
        tcpdump.stdin.flush()
        time.sleep(2)

        if tcpdump.poll() is not None:
            print(f"   tcpdump failed: {tcpdump.stderr.read()[:200]}")
            return False

        server = subprocess.Popen(
            [
                "ffmpeg", "-re", "-i", video_path,
                "-c:v", "libx264", "-preset", "ultrafast",
                "-tune", "zerolatency", "-f", "mpegts",
                f"tcp://127.0.0.1:{port}?listen",
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        time.sleep(2)

        subprocess.run(
            [
                "ffmpeg", "-i", f"tcp://127.0.0.1:{port}",
                "-t", str(duration), "-f", "null", "-",
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        time.sleep(2)

        kill_process(tcpdump)
        kill_process(server)
        time.sleep(1)

        if os.path.exists(output_pcap):
            size = os.path.getsize(output_pcap)
            print(f"   {size / 1024:.1f} KB: {'ok' if size > 100 else 'too small'}")
            return size > 100
        return False

    except Exception as e:
        print(f"   {e}")
        return False


def process_videos(device, dataset, video_type, port, protocol, network,
                   client_ip, video_count=None, duration=3):
    video_source = f"{VIDEO_SOURCE_ROOT}/{dataset}/{video_type}"

    if not os.path.exists(video_source):
        return {"error": f"Video source not found: {video_source}"}

    videos = list(Path(video_source).glob("*.mp4"))
    if video_count and video_count > 0:
        videos = videos[:video_count]

    base_path = get_base_dataset_path(duration)
    results = {
        "capture_id": str(uuid.uuid4()),
        "device": device,
        "dataset": dataset,
        "video_type": video_type,
        "port": port,
        "network": network,
        "duration": duration,
        "client_ip": client_ip,
        "timestamp": datetime.now().isoformat(),
        "total_videos": len(videos),
        "success": [],
        "failed": [],
        "status": "running",
    }

    print(f"\nProcessing {video_type} videos")
    print(f"   Device: {device}")
    print(f"   Dataset: {dataset}")
    print(f"   Port: {port}")
    print(f"   Protocol: {protocol}")
    print(f"   Network: {network}")
    print(f"   Duration: {duration}s")
    print(f"   Client IP: {client_ip}")
    print(f"   Videos: {len(videos)}")
    print(f"   Source: {video_source}")
    print(
        f"   Save location: {base_path}/{device}/{dataset}/{video_type}/{port}/{protocol}/{network}/"
    )

    for i, video_path in enumerate(videos, 1):
        original_name = video_path.name
        print(f"\n   [{i}/{len(videos)}] {original_name}")

        output_pcap = get_pcap_path(
            device, dataset, video_type, port, protocol, network,
            original_name, duration,
        )

        success = capture_video(
            str(video_path), output_pcap, port, device, client_ip, duration
        )

        if success:
            results["success"].append(
                {
                    "video": original_name,
                    "pcap": os.path.basename(output_pcap),
                    "path": output_pcap,
                }
            )
            print(f"   Saved: {os.path.basename(output_pcap)}")
        else:
            results["failed"].append(
                {
                    "video": original_name,
                    "pcap": os.path.basename(output_pcap),
                    "error": "Capture failed",
                }
            )
            print(f"   Failed: {original_name}")

        time.sleep(1)

    results["status"] = "completed"
    results["success_count"] = len(results["success"])
    results["failed_count"] = len(results["failed"])

    if results["failed_count"] > 0:
        report_path = save_failure_report(
            results["capture_id"], results["failed"], duration
        )
        results["failure_report"] = report_path
        print(f"\nFailure report saved: {report_path}")

    return results


# ---------------------------------------------------------
# REST endpoints
# ---------------------------------------------------------
@app.route("/webrtc-batch", methods=["GET"])
def webrtc_batch_page():
    """The frontend is hosted separately, so this route only explains that."""
    return jsonify(
        {
            "error": "Frontend is hosted separately",
            "message": "Open webrtc.html directly in your browser and set the backend URL there",
            "frontend_path": "webrtc.html",
            "backend_url": f"http://{request.remote_addr}:5001",
        }
    ), 404


@app.route("/health", methods=["GET"])
def health():
    print("[server] /health called")
    return jsonify(
        {
            "status": "healthy",
            "timestamp": datetime.now().isoformat(),
            "available_options": {
                "devices": AVAILABLE_DEVICES,
                "datasets": AVAILABLE_DATASETS,
                "types": AVAILABLE_TYPES,
                "ports": AVAILABLE_PORTS,
                "networks": AVAILABLE_NETWORKS,
                "durations": AVAILABLE_DURATIONS,
            },
        }
    ), 200


@app.route("/capture", methods=["POST"])
def start_capture():
    data = request.get_json()

    device = data.get("device", "computer")
    dataset = data.get("dataset", "hidf")
    video_type = data.get("type", "real")
    port = data.get("port", DEFAULT_PORT)
    network = data.get("network", "wifi")
    duration = data.get("duration", DEFAULT_DURATION)
    video_count = data.get("videos")

    print("\n/capture request received")
    print(f"   device: {device}, dataset: {dataset}, type: {video_type}")
    print(
        f"   port: {port}, network: {network}, duration: {duration}s, video_count: {video_count}"
    )

    if device not in AVAILABLE_DEVICES:
        return jsonify({"error": f"Invalid device. Choose from: {AVAILABLE_DEVICES}"}), 400
    if dataset not in AVAILABLE_DATASETS:
        return jsonify({"error": f"Invalid dataset. Choose from: {AVAILABLE_DATASETS}"}), 400
    if video_type not in AVAILABLE_TYPES:
        return jsonify({"error": f"Invalid type. Choose from: {AVAILABLE_TYPES}"}), 400
    if port not in AVAILABLE_PORTS:
        return jsonify({"error": f"Invalid port. Choose from: {AVAILABLE_PORTS}"}), 400
    if network not in AVAILABLE_NETWORKS:
        return jsonify({"error": f"Invalid network. Choose from: {AVAILABLE_NETWORKS}"}), 400
    if duration not in AVAILABLE_DURATIONS:
        return jsonify({"error": f"Invalid duration. Choose from: {AVAILABLE_DURATIONS}"}), 400

    client_ip = request.remote_addr
    if request.headers.get("X-Forwarded-For"):
        client_ip = request.headers.get("X-Forwarded-For").split(",")[0].strip()

    capture_id = str(uuid.uuid4())
    protocol = data.get("protocol", "tcp")
    base_path = get_base_dataset_path(duration)

    print(f"   Base path: {base_path}")
    print(f"   Duration: {duration}s")

    def run_capture():
        results = process_videos(
            device, dataset, video_type, port, protocol, network,
            client_ip, video_count, duration,
        )
        results["capture_id"] = capture_id
        results["duration"] = duration
        active_captures[capture_id] = results

    thread = threading.Thread(target=run_capture)
    thread.start()
    active_captures[capture_id] = {"status": "running", "id": capture_id}

    return jsonify(
        {
            "message": "Capture started",
            "capture_id": capture_id,
            "config": {
                "device": device,
                "dataset": dataset,
                "type": video_type,
                "port": port,
                "protocol": protocol,
                "network": network,
                "duration": duration,
                "videos": video_count,
                "expected_path": f"{base_path}/{device}/{dataset}/{video_type}/{port}/{protocol}/{network}/",
            },
        }
    )


@app.route("/status/<capture_id>", methods=["GET"])
def get_status(capture_id):
    if capture_id in active_captures:
        status = active_captures[capture_id].copy()
        duration = status.get("duration", DEFAULT_DURATION)
        status["base_path"] = get_base_dataset_path(duration)
        return jsonify(status)
    return jsonify({"error": "Capture ID not found"}), 404


@app.route("/download-report/<capture_id>", methods=["GET"])
def download_report(capture_id):
    download_name = f"failure_report_{capture_id}.json"

    # If the capture is still in memory, use its own duration folder
    if capture_id in active_captures:
        capture = active_captures[capture_id]
        duration = capture.get("duration", DEFAULT_DURATION)

        report_path = get_failure_report_path(capture_id, duration)
        if os.path.exists(report_path):
            return send_file(report_path, as_attachment=True, download_name=download_name)

        if capture.get("failed_count", 0) > 0:
            return jsonify(
                {
                    "capture_id": capture_id,
                    "duration": duration,
                    "timestamp": capture.get("timestamp", datetime.now().isoformat()),
                    "total_failed": capture.get("failed_count", 0),
                    "failed_files": capture.get("failed", []),
                }
            )

    # Otherwise look in every duration folder
    for dur in AVAILABLE_DURATIONS:
        report_path = get_failure_report_path(capture_id, dur)
        if os.path.exists(report_path):
            return send_file(report_path, as_attachment=True, download_name=download_name)

    return jsonify({"error": "No report found for this capture ID"}), 404


@app.route("/debug/paths", methods=["GET"])
def debug_paths():
    return jsonify(
        {
            "base_paths": BASE_DATASET_PATHS,
            "available_durations": AVAILABLE_DURATIONS,
            "current_paths": {
                duration: get_base_dataset_path(duration)
                for duration in AVAILABLE_DURATIONS
            },
        }
    ), 200


@app.route("/interfaces", methods=["GET"])
def get_interfaces():
    print("[server] /interfaces called")
    interfaces = get_network_interfaces()
    return jsonify(
        {
            "interfaces": interfaces,
            "count": len(interfaces),
            "main_interface": interfaces[0] if interfaces else None,
        }
    ), 200


# ---------------------------------------------------------
# WebSocket streaming
# ---------------------------------------------------------
@sock.route("/stream")
def stream_handler(ws):
    # Use the real client IP when the request comes through the ngrok proxy
    client_ip = request.remote_addr
    if request.headers.get("X-Forwarded-For"):
        client_ip = request.headers.get("X-Forwarded-For").split(",")[0].strip()

    print(f"\nWebSocket connected from {client_ip}")

    stream_id = str(uuid.uuid4())
    active_streams[stream_id] = {
        "ws": ws,
        "client_ip": client_ip,
        "start_time": datetime.now(),
        "chunks_received": 0,
        "bytes_received": 0,
    }

    tcpdump = None
    keepalive_active = True

    def send_heartbeat():
        while keepalive_active:
            time.sleep(15)
            try:
                ws.send(json.dumps({"type": "ping", "timestamp": time.time()}))
            except Exception:
                break

    heartbeat_thread = threading.Thread(target=send_heartbeat, daemon=True)
    heartbeat_thread.start()

    try:
        # Wait for the start command
        print("[server] Waiting for start command (timeout: 30s)...")
        ws.settimeout(30)
        message = ws.receive()

        if not message:
            print("[server] No start message received")
            return

        try:
            config = json.loads(message)
        except json.JSONDecodeError as e:
            print(f"[server] Invalid JSON: {e}")
            ws.send(json.dumps({"type": "error", "message": f"Invalid JSON: {e}"}))
            return

        device = config.get("device", "computer")
        dataset = config.get("dataset", "hidf")
        video_type = config.get("video_type", "real")
        port = config.get("port", DEFAULT_PORT)
        protocol = config.get("protocol", "tcp")
        network = config.get("network", "wifi")
        duration = config.get("duration", DEFAULT_DURATION)
        filename = config.get("filename", "unknown.mp4")

        if duration not in AVAILABLE_DURATIONS:
            duration = DEFAULT_DURATION

        print(
            f"[server] Config: device={device}, dataset={dataset}, type={video_type}, "
            f"port={port}, protocol={protocol}, network={network}, "
            f"duration={duration}s, file={filename}"
        )

        output_pcap = get_pcap_path(
            device, dataset, video_type, port, protocol, network, filename, duration
        )
        print(f"[server] PCAP output: {output_pcap}")

        # Filter on client IP, protocol and port so other traffic is not captured
        filter_expr = f"(host {client_ip}) and {protocol.lower()} and port {port}"
        server_ips = [iface["ip"] for iface in get_network_interfaces()]
        is_local = client_ip in server_ips or client_ip.startswith("127.")

        if is_local:
            print("[server] Client is local, using lo0")
            tcpdump = start_tcpdump(output_pcap, filter_expr, "lo0")
        else:
            print("[server] Client is remote, using en0")
            tcpdump = start_tcpdump(output_pcap, filter_expr, "en0")

        if tcpdump is None:
            ws.send(
                json.dumps(
                    {"type": "error", "message": "Failed to start packet capture"}
                )
            )
            return

        ws.send(
            json.dumps(
                {
                    "type": "capture_started",
                    "stream_id": stream_id,
                    "pcap_file": os.path.basename(output_pcap),
                }
            )
        )
        print("[server] Sent capture_started")

        # Receive chunks until EOF, timeout or lost connection
        stream_start = time.time()
        chunk_count = 0
        byte_count = 0
        timeout = duration + 60
        last_activity = time.time()
        eof_received = False

        print(f"[server] Listening for chunks (timeout: {timeout}s)")

        while time.time() - stream_start < timeout and not eof_received:
            try:
                ws.settimeout(2)
                chunk = ws.receive()

                if chunk is None:
                    print("[server] Received None, connection may be closing")
                    break

                last_activity = time.time()

                if isinstance(chunk, str):
                    try:
                        ctrl = json.loads(chunk)
                        msg_type = ctrl.get("type")
                        if msg_type == "eof":
                            print(f"[server] EOF received after {chunk_count} chunks")
                            eof_received = True
                            break
                        elif msg_type == "ping":
                            ws.send(json.dumps({"type": "pong", "timestamp": time.time()}))
                            continue
                        else:
                            print(f"[server] Unknown control message: {msg_type}")
                    except json.JSONDecodeError:
                        byte_count += len(chunk)
                else:
                    chunk_count += 1
                    byte_count += len(chunk)

                    if chunk_count <= 5 or chunk_count % 100 == 0:
                        elapsed = time.time() - stream_start
                        rate = (byte_count / 1024) / elapsed if elapsed > 0 else 0
                        print(
                            f"[server] Chunk {chunk_count}: {len(chunk)} B, "
                            f"total {byte_count / 1024:.1f} KB, rate {rate:.1f} KB/s, "
                            f"elapsed {elapsed:.1f}s"
                        )

            except Exception:
                if time.time() - last_activity > 30:
                    print("[server] No activity for 30s, assuming connection lost")
                    break
                time.sleep(0.1)
                continue

        elapsed_total = time.time() - stream_start
        print(
            f"[server] Stream loop ended after {elapsed_total:.1f}s, "
            f"chunks={chunk_count}, bytes={byte_count / 1024:.1f} KB"
        )

        try:
            ws.send(
                json.dumps(
                    {
                        "type": "capture_complete",
                        "stream_id": stream_id,
                        "pcap_file": os.path.basename(output_pcap),
                        "size_bytes": byte_count,
                        "size_kb": byte_count / 1024,
                        "chunks_received": chunk_count,
                        "bytes_received": byte_count,
                        "duration": elapsed_total,
                        "avg_rate_kbps": (byte_count / 1024) / elapsed_total
                        if elapsed_total > 0
                        else 0,
                    }
                )
            )
            print("[server] Sent capture_complete")
        except Exception as e:
            print(f"[server] Could not send capture_complete: {e}")

        capture_result = stop_tcpdump(tcpdump, output_pcap)
        if capture_result:
            print(f"[server] PCAP saved: {capture_result['size_kb']:.1f} KB")

            active_captures[stream_id] = {
                "status": "completed",
                "type": "stream",
                "device": device,
                "dataset": dataset,
                "video_type": video_type,
                "port": port,
                "network": network,
                "duration_config": duration,
                "client_ip": client_ip,
                "pcap": os.path.basename(output_pcap),
                "size": capture_result["size"],
                "chunks": chunk_count,
                "bytes": byte_count,
                "elapsed_time": elapsed_total,
                "timestamp": datetime.now().isoformat(),
            }
        else:
            print("[server] PCAP file not found or empty")

    except Exception as e:
        print(f"[server] Exception: {e}")
        traceback.print_exc()
        try:
            ws.send(json.dumps({"type": "error", "message": str(e)}))
        except Exception:
            pass

    finally:
        keepalive_active = False
        if tcpdump:
            kill_process(tcpdump)
        if stream_id in active_streams:
            del active_streams[stream_id]
        print("[server] Session closed")


# ---------------------------------------------------------
# Startup
# ---------------------------------------------------------
def create_dataset_folders():
    print("\nCreating dataset folders...")
    ports = [53, 443, 1935, 8080]
    protocols = ["tcp", "udp"]

    for duration in AVAILABLE_DURATIONS:
        base_path = get_base_dataset_path(duration)
        print(f"   {duration}s recordings: {base_path}")

        for device in AVAILABLE_DEVICES:
            for dataset in AVAILABLE_DATASETS:
                for vtype in AVAILABLE_TYPES:
                    for port in ports:
                        for protocol in protocols:
                            for network in AVAILABLE_NETWORKS:
                                ensure_dir(
                                    f"{base_path}/{device}/{dataset}/{vtype}/{port}/{protocol}/{network}"
                                )

        ensure_dir(f"{base_path}/reports")

    print("   Done")


if __name__ == "__main__":
    create_dataset_folders()

    interfaces = get_network_interfaces()
    host_ip = interfaces[0]["ip"] if interfaces else "localhost"

    print("\nFlask backend starting")
    print("\nNetwork interfaces:")
    for iface in interfaces:
        print(f"   - {iface['name']}  {iface['ip']}")

    print(f"\nWebSocket: ws://{host_ip}:5001/stream")
    print(f"REST API:  http://{host_ip}:5001")

    print("\nFolder structure by duration:")
    for duration, path in BASE_DATASET_PATHS.items():
        print(
            f"   {duration}s: {path}/{{device}}/{{dataset}}/{{type}}/{{port}}/{{protocol}}/{{network}}/"
        )

    print("\nTimeouts:")
    print("   - Start message: 30s")
    print("   - Chunk receive: 2s per chunk")
    print("   - Heartbeat: every 15s")
    print("   - Client IP filtering: on")

    print("\nServer ready. Press Ctrl+C to stop.\n")

    app.run(host="0.0.0.0", port=5001, debug=False, threaded=True)