import json
import os
import re
import subprocess
import tempfile
import threading
import time
import traceback
import uuid
from datetime import datetime
from pathlib import Path

import netifaces
from flask import Flask, jsonify, make_response, request, send_file
from flask_cors import CORS
from flask_sock import Sock

app = Flask(__name__)

# ---------------------------------------------------------
# CORS
# The frontend may be served locally, from ngrok, or from another host,
# so every origin is allowed. The ngrok-skip-browser-warning header must
# be allowed or ngrok requests fail the preflight check.
# ---------------------------------------------------------
CORS(
    app,
    resources={
        r"/*": {
            "origins": "*",
            "methods": ["GET", "POST", "PUT", "DELETE", "OPTIONS", "HEAD"],
            "allow_headers": [
                "Content-Type",
                "Authorization",
                "X-Requested-With",
                "Accept",
                "Origin",
                "ngrok-skip-browser-warning",
            ],
            "expose_headers": ["Content-Type", "Content-Disposition"],
            "supports_credentials": False,
            "max_age": 86400,
        }
    },
)


@app.after_request
def after_request(response):
    response.headers["Access-Control-Allow-Headers"] = (
        "Content-Type, ngrok-skip-browser-warning"
    )
    response.headers["Access-Control-Allow-Methods"] = (
        "GET, POST, PUT, DELETE, OPTIONS"
    )
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Connection"] = "keep-alive"
    response.headers["Keep-Alive"] = "timeout=180, max=100"
    return response


@app.route("/", defaults={"path": ""}, methods=["OPTIONS"])
@app.route("/<path:path>", methods=["OPTIONS"])
def handle_options(path):
    """Answer CORS preflight requests."""
    response = make_response()
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Methods"] = (
        "GET, POST, PUT, DELETE, OPTIONS"
    )
    response.headers["Access-Control-Allow-Headers"] = (
        "Content-Type, ngrok-skip-browser-warning"
    )
    response.headers["Access-Control-Max-Age"] = "86400"
    return response, 200


sock = Sock(app)


@app.before_request
def log_request():
    origin = request.headers.get("Origin", "local")
    host = request.headers.get("Host", "unknown")
    skip_warning = request.headers.get("ngrok-skip-browser-warning", "not set")
    print(f"[server] {request.method} {request.path} from {request.remote_addr}")
    print(f"         host: {host} | origin: {origin} | ngrok-skip: {skip_warning}")


@app.errorhandler(404)
def not_found(error):
    print(f"[server] 404: {request.path}")
    return jsonify({"error": "Not found", "path": request.path}), 404


@app.errorhandler(500)
def internal_error(error):
    print(f"[server] 500: {error}")
    return jsonify({"error": "Internal server error", "message": str(error)}), 500


# ---------------------------------------------------------
# Configuration
# ---------------------------------------------------------
BASE_DATASET_PATH = "/Users/atifasim/documents/deepfake/packet-dataset"
VIDEO_SOURCE_ROOT = "/Users/atifasim/documents/deepfake/hidf"

AVAILABLE_DEVICES = ["computer", "mobile", "tablet"]
AVAILABLE_DATASETS = ["hidf", "sdfvd", "forensic++", "manual-fake-2022"]
AVAILABLE_TYPES = ["real", "fake"]
AVAILABLE_PORTS = [8080]
AVAILABLE_NETWORKS = ["jazz", "wifi"]

DEFAULT_PORT = 8080
CAPTURE_DURATION = 3
active_captures = {}
active_streams = {}


# ---------------------------------------------------------
# Helpers
# ---------------------------------------------------------
def ensure_dir(directory):
    Path(directory).mkdir(parents=True, exist_ok=True)


def sanitize_filename(filename):
    name = Path(filename).stem
    return re.sub(r'[<>:"/\\|?*]', "_", name)


def get_pcap_path(device, dataset, video_type, port, network, original_filename):
    """Build a unique path: device/dataset/real-or-fake/8080/network/name.pcapng"""
    base_name = sanitize_filename(original_filename)
    folder = f"{BASE_DATASET_PATH}/{device}/{dataset}/{video_type}/8080/{network}"
    ensure_dir(folder)

    pcap_path = f"{folder}/{base_name}.pcapng"
    counter = 1
    while os.path.exists(pcap_path):
        pcap_path = f"{folder}/{base_name}_{counter}.pcapng"
        counter += 1
    return pcap_path


def get_failure_report_path(capture_id):
    report_dir = f"{BASE_DATASET_PATH}/reports"
    ensure_dir(report_dir)
    return f"{report_dir}/failure_report_{capture_id}.json"


def save_failure_report(capture_id, failed_files):
    report_path = get_failure_report_path(capture_id)
    report = {
        "capture_id": capture_id,
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
    """Start tcpdump through sudo without letting sudo prompt for a password."""
    try:
        open(output_pcap, "wb").close()
        os.chmod(output_pcap, 0o666)
    except Exception:
        pass

    # Loopback captures use "any" so traffic on every interface is seen
    capture_interface = "any" if interface == "lo0" else interface

    tcpdump_cmd = [
        "sudo", "-n", "tcpdump",
        "-i", capture_interface,
        "-U",
        "-n",
        "-l",
        "-B", "4096",
        "-w", output_pcap,
        filter_expr,
    ]

    print(f"   Starting tcpdump on {capture_interface}: {filter_expr}")

    try:
        tcpdump = subprocess.Popen(
            tcpdump_cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )

        time.sleep(1)

        if tcpdump.poll() is not None:
            _, stderr = tcpdump.communicate()
            print(f"   tcpdump exited immediately: {stderr[:300]}")
            return None

        print(f"   tcpdump running (PID {tcpdump.pid}) on {capture_interface}")
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
def capture_video(video_path, output_pcap, port, device_type, client_ip):
    video_name = os.path.basename(video_path)
    print(f"\n   {video_name}  device={device_type}  port={port}")
    os.makedirs(os.path.dirname(output_pcap), exist_ok=True)

    try:
        open(output_pcap, "wb").close()
        os.chmod(output_pcap, 0o666)
        print(f"   PCAP file created: {output_pcap}")
    except Exception as e:
        print(f"   Could not pre-create PCAP: {e}")

    # "any" captures traffic on every interface, including loopback
    tcpdump_cmd = [
        "sudo", "-n", "tcpdump",
        "-i", "any",
        "-U",
        "-w", output_pcap,
        f"port {port}",
    ]

    print(f"   tcpdump command: {' '.join(tcpdump_cmd)}")

    tcpdump = None
    server = None
    client = None

    try:
        print("   Starting tcpdump on 'any' interface...")
        tcpdump = subprocess.Popen(
            tcpdump_cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )

        time.sleep(2)

        if tcpdump.poll() is not None:
            _, stderr = tcpdump.communicate()
            print(f"   tcpdump failed immediately: {stderr[:300]}")
            return False

        print(f"   tcpdump running (PID {tcpdump.pid})")

        print(f"   Starting ffmpeg server on port {port}...")
        server_log = tempfile.NamedTemporaryFile(
            mode="w+", delete=False, suffix="_server.log"
        )
        server_log_path = server_log.name
        server_log.close()

        server = subprocess.Popen(
            [
                "ffmpeg", "-re", "-i", video_path,
                "-c:v", "libx264", "-preset", "ultrafast",
                "-tune", "zerolatency", "-f", "mpegts",
                f"tcp://127.0.0.1:{port}?listen",
            ],
            stdout=open(server_log_path, "w"),
            stderr=subprocess.STDOUT,
        )
        print(f"   ffmpeg server started (PID {server.pid})")
        time.sleep(3)

        if server.poll() is not None:
            with open(server_log_path, "r") as f:
                server_output = f.read()
            print(f"   ffmpeg server crashed:\n{server_output[:500]}")
            return False

        print(f"   Starting ffmpeg client (port {port})...")
        client_log = tempfile.NamedTemporaryFile(
            mode="w+", delete=False, suffix="_client.log"
        )
        client_log_path = client_log.name
        client_log.close()

        client = subprocess.Popen(
            [
                "ffmpeg", "-i", f"tcp://127.0.0.1:{port}",
                "-t", str(CAPTURE_DURATION), "-f", "null", "-",
            ],
            stdout=open(client_log_path, "w"),
            stderr=subprocess.STDOUT,
        )
        print(f"   ffmpeg client started (PID {client.pid})")
        time.sleep(2)

        try:
            client.wait(timeout=CAPTURE_DURATION + 10)
            print("   ffmpeg client finished")
        except subprocess.TimeoutExpired:
            print("   ffmpeg client timed out, killing it")
            kill_process(client)

        with open(client_log_path, "r") as f:
            client_output = f.read()
        if "error" in client_output.lower() and "Connection refused" in client_output:
            print(f"   Connection issue:\n{client_output[:300]}")

        time.sleep(2)

        print("   Stopping processes...")
        kill_process(client)
        kill_process(server)
        kill_process(tcpdump)
        time.sleep(2)

        if not os.path.exists(output_pcap):
            print("   PCAP file was not created")
            return False

        size = os.path.getsize(output_pcap)
        print(f"   PCAP size: {size / 1024:.2f} KB ({size} bytes)")

        try:
            with open(output_pcap, "rb") as f:
                magic_bytes = f.read(4)
            if magic_bytes == b"\xa1\xb2\xc3\xd4":
                print("   Valid PCAP magic bytes")
            elif magic_bytes == b"\xd4\xc3\xb2\xa1":
                print("   Valid PCAP magic bytes (little-endian)")
            else:
                print(f"   Unknown file format: {magic_bytes.hex()}")
        except Exception as e:
            print(f"   Could not read PCAP: {e}")

        try:
            dump_check = subprocess.run(
                ["tcpdump", "-r", output_pcap, "-c", "0"],
                capture_output=True,
                text=True,
                timeout=5,
            )
            print(f"   tcpdump read check: {dump_check.stderr.strip()}")
        except Exception as e:
            print(f"   Could not read PCAP with tcpdump: {e}")

        if size > 100:
            print("   Capture successful")
            for path in (server_log_path, client_log_path):
                try:
                    os.remove(path)
                except Exception:
                    pass
            return True

        print(f"   PCAP too small ({size} bytes). Checking logs...")
        for label, path in (("Server", server_log_path), ("Client", client_log_path)):
            try:
                with open(path, "r") as f:
                    content = f.read()
                if content.strip():
                    print(f"   {label} log:\n{content[:300]}")
            except Exception:
                pass
        return False

    except subprocess.TimeoutExpired:
        print("   Timed out waiting for the ffmpeg client")
        return False
    except Exception as e:
        print(f"   Exception: {e}")
        traceback.print_exc()
        return False
    finally:
        kill_process(client)
        kill_process(server)
        kill_process(tcpdump)


def process_videos(device, dataset, video_type, port, network, client_ip, video_count=None):
    video_source = f"{VIDEO_SOURCE_ROOT}/{dataset}/{video_type}"

    if not os.path.exists(video_source):
        return {"error": f"Video source not found: {video_source}"}

    videos = list(Path(video_source).glob("*.mp4"))
    if video_count and video_count > 0:
        videos = videos[:video_count]

    results = {
        "capture_id": str(uuid.uuid4()),
        "device": device,
        "dataset": dataset,
        "video_type": video_type,
        "port": port,
        "network": network,
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
    print(f"   Network: {network}")
    print(f"   Client IP: {client_ip}")
    print(f"   Videos: {len(videos)}")
    print(f"   Source: {video_source}")
    print(
        f"   Save location: {BASE_DATASET_PATH}/{device}/{dataset}/{video_type}/8080/{network}/"
    )

    for i, video_path in enumerate(videos, 1):
        original_name = video_path.name
        print(f"\n   [{i}/{len(videos)}] {original_name}")

        output_pcap = get_pcap_path(
            device, dataset, video_type, port, network, original_name
        )

        success = capture_video(str(video_path), output_pcap, port, device, client_ip)

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
        report_path = save_failure_report(results["capture_id"], results["failed"])
        results["failure_report"] = report_path
        print(f"\nFailure report saved: {report_path}")

    return results


# ---------------------------------------------------------
# REST endpoints
# ---------------------------------------------------------
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
    video_count = data.get("videos")

    print("\n/capture request received")
    print(f"   device: {device}, dataset: {dataset}, type: {video_type}")
    print(f"   port: {port}, network: {network}, video_count: {video_count}")

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

    client_ip = request.remote_addr
    if request.headers.get("X-Forwarded-For"):
        client_ip = request.headers.get("X-Forwarded-For").split(",")[0].strip()

    capture_id = str(uuid.uuid4())

    def run_capture():
        results = process_videos(
            device, dataset, video_type, port, network, client_ip, video_count
        )
        results["capture_id"] = capture_id
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
                "network": network,
                "videos": video_count,
                "expected_path": f"{BASE_DATASET_PATH}/{device}/{dataset}/{video_type}/8080/{network}/",
            },
        }
    )


@app.route("/status/<capture_id>", methods=["GET"])
def get_status(capture_id):
    if capture_id in active_captures:
        return jsonify(active_captures[capture_id])
    return jsonify({"error": "Capture ID not found"}), 404


@app.route("/download-report/<capture_id>", methods=["GET"])
def download_report(capture_id):
    report_path = get_failure_report_path(capture_id)
    if os.path.exists(report_path):
        return send_file(
            report_path,
            as_attachment=True,
            download_name=f"failure_report_{capture_id}.json",
        )

    if capture_id in active_captures:
        capture = active_captures[capture_id]
        if capture.get("failed_count", 0) > 0:
            report = {
                "capture_id": capture_id,
                "timestamp": capture.get("timestamp", datetime.now().isoformat()),
                "total_failed": capture.get("failed_count", 0),
                "failed_files": capture.get("failed", []),
            }
            return jsonify(report)

    return jsonify({"error": "No report found for this capture ID"}), 404


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


@app.route("/test-capture", methods=["POST"])
def test_capture():
    """Run one capture against a single video to debug the pipeline."""
    data = request.get_json() or {}
    port = data.get("port", 8080)
    video_path = data.get("video_path")

    print("\nTest capture starting")
    print(f"   Port: {port}")
    print(f"   Video: {video_path}")

    if not video_path or not os.path.exists(video_path):
        return jsonify(
            {"error": "Video file not found", "provided_path": video_path}
        ), 400

    try:
        probe = subprocess.run(
            [
                "ffprobe", "-v", "error", "-show_entries",
                "format=duration", "-of",
                "default=noprint_wrappers=1:nokey=1:noescapetext=1",
                video_path,
            ],
            capture_output=True,
            text=True,
            timeout=10,
        )
        duration = float(probe.stdout.strip())
        file_size_mb = os.path.getsize(video_path) / 1024 / 1024
        print(f"   Video info: {duration:.1f}s, {file_size_mb:.1f} MB")
    except Exception as e:
        return jsonify({"error": f"Could not probe video: {e}"}), 400

    test_pcap = f"{tempfile.gettempdir()}/test_capture_{port}.pcapng"
    print(f"   Output: {test_pcap}")

    try:
        success = capture_video(video_path, test_pcap, port, "test", "127.0.0.1")

        if os.path.exists(test_pcap):
            pcap_size = os.path.getsize(test_pcap)
            return jsonify(
                {
                    "success": success,
                    "pcap_path": test_pcap,
                    "pcap_size_bytes": pcap_size,
                    "pcap_size_kb": pcap_size / 1024,
                    "video_size_mb": file_size_mb,
                    "video_duration_s": duration,
                    "message": "Test capture complete. Check the server log for details.",
                }
            ), 200
        return jsonify(
            {
                "success": False,
                "error": "PCAP file was not created",
                "test_pcap": test_pcap,
            }
        ), 500
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


# ---------------------------------------------------------
# WebSocket streaming
# ---------------------------------------------------------
@sock.route("/stream")
def stream_handler(ws):
    client_ip = request.remote_addr
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

    try:
        print("[server] Waiting for start command...")
        message = ws.receive()
        print(f"[server] Start message: {message}")

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
        network = config.get("network", "wifi")
        duration = config.get("duration", 3)
        filename = config.get("filename", "unknown.mp4")

        print(
            f"[server] Config: device={device}, dataset={dataset}, type={video_type}, "
            f"port={port}, network={network}, duration={duration}s, file={filename}"
        )

        output_pcap = get_pcap_path(device, dataset, video_type, port, network, filename)
        print(f"[server] PCAP output: {output_pcap}")

        filter_expr = f"port {port}"
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

        stream_start = time.time()
        chunk_count = 0
        byte_count = 0
        timeout = duration + 30

        while time.time() - stream_start < timeout:
            try:
                chunk = ws.receive()
                if chunk is None:
                    break

                if isinstance(chunk, str):
                    try:
                        ctrl = json.loads(chunk)
                        if ctrl.get("type") == "eof":
                            print(f"[server] EOF received after {chunk_count} chunks")
                            break
                    except Exception:
                        byte_count += len(chunk)
                else:
                    chunk_count += 1
                    byte_count += len(chunk)

                    if chunk_count <= 5 or chunk_count % 50 == 0:
                        elapsed = time.time() - stream_start
                        print(
                            f"[server] Chunk {chunk_count}: {len(chunk)} B, "
                            f"total {byte_count / 1024:.1f} KB, elapsed {elapsed:.1f}s"
                        )

            except Exception:
                continue

        elapsed_total = time.time() - stream_start
        print(
            f"[server] Stream loop ended after {elapsed_total:.1f}s, "
            f"chunks={chunk_count}, bytes={byte_count}"
        )

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
                }
            )
        )
        print("[server] Sent capture_complete")

        capture_result = stop_tcpdump(tcpdump, output_pcap)
        if capture_result:
            print(f"[server] PCAP saved: {capture_result['size_kb']:.1f} KB")

    except Exception as e:
        print(f"[server] Exception: {e}")
        traceback.print_exc()
        try:
            ws.send(json.dumps({"type": "error", "message": str(e)}))
        except Exception:
            pass

    finally:
        if tcpdump:
            kill_process(tcpdump)
        if stream_id in active_streams:
            del active_streams[stream_id]
        print("[server] Session closed")


# ---------------------------------------------------------
# Startup
# ---------------------------------------------------------
def create_dataset_folders():
    """Create device/dataset/real-or-fake/8080/network folders up front."""
    print("\nCreating dataset folders...")
    for device in AVAILABLE_DEVICES:
        for dataset in AVAILABLE_DATASETS:
            for vtype in AVAILABLE_TYPES:
                for network in AVAILABLE_NETWORKS:
                    ensure_dir(
                        f"{BASE_DATASET_PATH}/{device}/{dataset}/{vtype}/8080/{network}"
                    )

    ensure_dir(f"{BASE_DATASET_PATH}/reports")
    print("   Done")


if __name__ == "__main__":
    create_dataset_folders()

    interfaces = get_network_interfaces()
    host_ip = interfaces[0]["ip"] if interfaces else "localhost"

    print("\nFlask backend starting")
    print("\nNetwork interfaces:")
    for iface in interfaces:
        print(f"   - {iface['name']}  {iface['ip']}")

    print(f"\nWebSocket: ws://{host_ip}:8080/stream")
    print(f"REST API:  http://{host_ip}:8080")
    print("\nFolder structure:")
    print(f"   {BASE_DATASET_PATH}/{{device}}/{{dataset}}/{{real-or-fake}}/8080/{{network}}/")
    print("\nServer ready. Press Ctrl+C to stop.\n")

    app.run(host="0.0.0.0", port=8080, debug=False, threaded=True)
