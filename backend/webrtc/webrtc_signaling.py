import asyncio
import json
import logging
import os
import re
import subprocess
import threading
import time
import traceback
from pathlib import Path
from typing import Dict, Optional

from aiortc import RTCPeerConnection, RTCSessionDescription
from aiortc.contrib.media import MediaBlackhole
from flask import Blueprint, jsonify, make_response, request

# ---------------------------------------------------------
# Configuration
# ---------------------------------------------------------
BASE_DATASET_PATH = "/Users/atifasim/documents/deepfake/packet-dataset"

# Read from the environment so the password is not stored in the source file.
# Set it with: export SUDO_PASSWORD='...'
SUDO_PASSWORD = os.environ.get("SUDO_PASSWORD", "your_computer_password_here")

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

active_captures: Dict[str, dict] = {}
ws_clients = set()
pending_ice_candidates: Dict[str, list] = {}

# ---------------------------------------------------------
# Blueprint and CORS
# ---------------------------------------------------------
signaling_bp = Blueprint("signaling", __name__, url_prefix="/api/webrtc")


@signaling_bp.after_request
def bp_cors(response):
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    response.headers["Access-Control-Allow-Headers"] = (
        "Content-Type, Authorization, ngrok-skip-browser-warning"
    )
    return response


def _preflight():
    r = make_response()
    r.headers["Access-Control-Allow-Origin"] = "*"
    r.headers["Access-Control-Allow-Methods"] = "POST, OPTIONS"
    r.headers["Access-Control-Allow-Headers"] = (
        "Content-Type, ngrok-skip-browser-warning"
    )
    return r, 200


@signaling_bp.route("/offer", methods=["OPTIONS"])
def offer_preflight():
    return _preflight()


@signaling_bp.route("/ice-candidate", methods=["OPTIONS"])
def ice_preflight():
    return _preflight()


# ---------------------------------------------------------
# Folder structure: <base>/<device>/<dataset>/<video_type>/webrtc/<network>/
# ---------------------------------------------------------
def get_pcap_path(device: str, dataset: str, video_type: str,
                  network: str, filename: str) -> str:
    folder = f"{BASE_DATASET_PATH}/{device}/{dataset}/{video_type}/webrtc/{network}"
    os.makedirs(folder, exist_ok=True)

    base_name = re.sub(r'[<>:"/\\|?*]', "_", Path(filename).stem)
    pcap_path = f"{folder}/{base_name}.pcapng"

    counter = 1
    while os.path.exists(pcap_path):
        pcap_path = f"{folder}/{base_name}_{counter}.pcapng"
        counter += 1

    return pcap_path


# ---------------------------------------------------------
# tcpdump
# ---------------------------------------------------------
def start_tcpdump(pcap_path: str) -> Optional[subprocess.Popen]:
    logger.info(f"Starting tcpdump: {pcap_path}")
    cmd = [
        "sudo", "-S", "tcpdump",
        "-i", "en0",    # macOS: en0, Linux: eth0, Docker: docker0
        "-w", pcap_path,
        "-U",           # unbuffered writes, needed for live capture
        "-B", "4096",
        "-n",           # no DNS lookups
        "-l",
        "udp or tcp",   # WebRTC uses both
    ]
    try:
        proc = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
        )
        proc.stdin.write(f"{SUDO_PASSWORD}\n")
        proc.stdin.flush()
        time.sleep(2)
        if proc.poll() is not None:
            stderr = proc.stderr.read()
            logger.error(f"tcpdump exited: {stderr[:200]}")
            return None
        logger.info(f"tcpdump running (PID {proc.pid}) on en0")
        return proc
    except Exception as e:
        logger.error(f"tcpdump failed to start: {e}")
        return None


def stop_tcpdump(proc: subprocess.Popen) -> None:
    if not proc:
        return
    logger.info("Stopping tcpdump...")
    try:
        proc.terminate()
        proc.wait(timeout=3)
    except subprocess.TimeoutExpired:
        proc.kill()
    time.sleep(1)


# ---------------------------------------------------------
# Offer endpoint: real aiortc negotiation
# ---------------------------------------------------------
@signaling_bp.route("/offer", methods=["POST"])
def handle_webrtc_offer():
    print("[offer] POST /api/webrtc/offer received")

    try:
        data = request.get_json()
        if not data:
            return jsonify({"error": "No JSON body"}), 400

        capture_id = data.get("capture_id")
        filename = data.get("filename")
        sdp_offer = data.get("sdp_offer")
        config = data.get("config", {})

        if not all([capture_id, filename, sdp_offer]):
            return jsonify({"error": "Missing: capture_id, filename, sdp_offer"}), 400

        print(f"   capture_id={capture_id}, filename={filename}")

        device = config.get("device_type", "computer")
        dataset = config.get("dataset_type", "hidf")
        video_type = config.get("video_type", "fake")
        network = config.get("network_type", "wifi")
        duration = int(config.get("duration", 3))

        pcap_path = get_pcap_path(device, dataset, video_type, network, filename)
        print(f"   PCAP path: {pcap_path}")

        sdp_result = {"answer": None, "error": None}
        ready_event = threading.Event()

        def run_webrtc_thread():
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)

            async def negotiate_and_capture():
                pc = RTCPeerConnection()
                blackhole = MediaBlackhole()

                @pc.on("track")
                async def on_track(track):
                    print(f"   Receiving {track.kind} track")
                    blackhole.addTrack(track)
                    await blackhole.start()

                @pc.on("connectionstatechange")
                async def on_state():
                    state = pc.connectionState
                    print(f"   WebRTC state: {state}")
                    if state == "connected":
                        print("   Connected, RTP flowing")

                @pc.on("iceconnectionstatechange")
                async def on_ice():
                    print(f"   ICE: {pc.iceConnectionState}")

                await pc.setRemoteDescription(
                    RTCSessionDescription(sdp=sdp_offer, type="offer")
                )
                print("   Remote description set")

                answer = await pc.createAnswer()
                await pc.setLocalDescription(answer)
                print(f"   SDP answer ready ({len(pc.localDescription.sdp)} chars)")

                # Release the Flask request so the browser gets the answer now
                sdp_result["answer"] = pc.localDescription.sdp
                ready_event.set()

                # Start tcpdump before media flows
                tcpdump = start_tcpdump(pcap_path)

                await asyncio.sleep(0.5)
                print("   tcpdump initialised, waiting for the stream...")

                # Wait up to 15s for ICE to connect
                ice_connected = False
                for _ in range(30):
                    await asyncio.sleep(0.5)
                    if pc.iceConnectionState in ("connected", "completed"):
                        ice_connected = True
                        print("   ICE connected, RTP traffic flowing")
                        break
                    if pc.iceConnectionState == "failed":
                        print("   ICE failed")
                        break

                if not ice_connected:
                    print("   ICE did not connect within 15s. Capturing anyway.")

                print(f"   Capturing RTP stream for {duration}s...")
                await asyncio.sleep(duration)

                # Short delay so the last packets reach the file
                print("   Stopping capture...")
                await asyncio.sleep(0.3)

                if tcpdump:
                    stop_tcpdump(tcpdump)

                await asyncio.sleep(0.5)

                size = os.path.getsize(pcap_path) if os.path.exists(pcap_path) else 0
                print(f"   Capture done: {size / 1024:.1f} KB, {pcap_path}")

                active_captures[capture_id]["status"] = "complete"
                active_captures[capture_id]["size"] = size

                broadcast_ws(
                    {
                        "type": "capture_complete",
                        "capture_id": capture_id,
                        "filename": filename,
                        "pcap_path": pcap_path,
                        "pcap_size": size,
                        "size_kb": round(size / 1024, 2),
                    }
                )

                await pc.close()

            try:
                loop.run_until_complete(negotiate_and_capture())
            except Exception as e:
                print(f"   WebRTC thread error: {e}")
                traceback.print_exc()
                sdp_result["error"] = str(e)
                ready_event.set()
                broadcast_ws(
                    {
                        "type": "capture_error",
                        "capture_id": capture_id,
                        "filename": filename,
                        "error": str(e),
                    }
                )
            finally:
                loop.close()

        threading.Thread(target=run_webrtc_thread, daemon=True).start()

        if not ready_event.wait(timeout=10):
            return jsonify({"error": "SDP negotiation timed out after 10s"}), 500

        if sdp_result["error"]:
            return jsonify({"error": sdp_result["error"]}), 500

        active_captures[capture_id] = {
            "filename": filename,
            "pcap_path": pcap_path,
            "config": config,
            "created_at": time.time(),
            "status": "capturing",
        }

        print("   Returning SDP answer to browser")
        return jsonify(
            {
                "status": "success",
                "capture_id": capture_id,
                "sdp_answer": sdp_result["answer"],
                "pcap_path": pcap_path,
            }
        )

    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e), "status": "error"}), 500


# ---------------------------------------------------------
# ICE candidate endpoint
# ---------------------------------------------------------
@signaling_bp.route("/ice-candidate", methods=["POST"])
def handle_ice_candidate():
    try:
        data = request.get_json()
        capture_id = data.get("capture_id")
        candidate = data.get("candidate")
        if capture_id in active_captures:
            return jsonify({"status": "ok"})
        pending_ice_candidates.setdefault(capture_id, []).append(candidate)
        return jsonify({"status": "queued"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ---------------------------------------------------------
# WebSocket helpers
# ---------------------------------------------------------
def handle_signaling_message(message: dict):
    msg_type = message.get("type")
    if msg_type == "ping":
        broadcast_ws({"type": "pong", "timestamp": time.time()})
    elif msg_type == "ice_candidate":
        capture_id = message.get("capture_id")
        candidate = message.get("ice_candidate")
        pending_ice_candidates.setdefault(capture_id, []).append(candidate)


def broadcast_ws(message: dict):
    dead = set()
    for ws in ws_clients:
        try:
            ws.send(json.dumps(message))
        except Exception:
            dead.add(ws)
    ws_clients.difference_update(dead)


# ---------------------------------------------------------
# Registration
# ---------------------------------------------------------
def register_webrtc_signaling(app, sock):
    print("   Registering WebRTC signaling server (aiortc mode)...")
    print(
        f"   Folder structure: {BASE_DATASET_PATH}/{{device}}/{{dataset}}/{{video_type}}/webrtc/{{network}}/"
    )
    app.register_blueprint(signaling_bp)
    print("   Routes: /api/webrtc/offer, /api/webrtc/ice-candidate")
    logger.info("WebRTC signaling server ready")