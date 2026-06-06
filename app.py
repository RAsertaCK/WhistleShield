import os
import json
import uuid
import time
import threading
from pathlib import Path
from flask import Flask, request, jsonify, send_file, send_from_directory, render_template

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 20 * 1024 * 1024  # 20 MB

@app.after_request
def add_cors(response):
    response.headers["Access-Control-Allow-Origin"]  = "*"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, DELETE, OPTIONS"

    if request.path.startswith("/static/"):
        response.headers["Cache-Control"] = "public, max-age=31536000, immutable"

    # Menangani preflight request OPTIONS dari browser perangkat lain
    if request.method == "OPTIONS":
        response.status_code = 200
        return response
        
    # Mencegah caching pada API responses
    if request.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate"
        response.headers["Pragma"]        = "no-cache"

    if request.is_secure:
        response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains; preload"
    return response

DB_FILE = Path("rooms_db.json")
DB_LOCK = threading.Lock()
STATIC_VERSION = int(time.time())

ROOMS     = {}
UPLOAD_DIR = Path("uploads")
UPLOAD_DIR.mkdir(exist_ok=True)
ROOM_TTL  = 24 * 3600   # 24 jam
IDLE_TTL  = 3 * 3600    # Hapus session kosong setelah 3 jam

def _save_db():
    try:
        with DB_LOCK:
            DB_FILE.write_text(json.dumps(ROOMS, indent=2), encoding="utf-8")
    except Exception as e:
        app.logger.error(f"Error saving DB file: {e}")


def _load_db():
    global ROOMS
    if not DB_FILE.exists():
        ROOMS = {}
        return
    try:
        with DB_LOCK:
            data = json.loads(DB_FILE.read_text(encoding="utf-8"))
        ROOMS = data if isinstance(data, dict) else {}
    except Exception as e:
        app.logger.error(f"Error loading DB file: {e}")
        ROOMS = {}

    now = time.time()
    for rid, room in list(ROOMS.items()):
        room.setdefault("public_key", "")
        room.setdefault("stego_path", None)
        room.setdefault("has_message", False)
        room["created_at"] = float(room.get("created_at", now))
        room["last_seen"]  = float(room.get("last_seen", room["created_at"]))
        if room["stego_path"] and not os.path.exists(room["stego_path"]):
            room["stego_path"] = None
            room["has_message"] = False
        if now - room["created_at"] > ROOM_TTL:
            del ROOMS[rid]
    _save_db()


def _touch_room(room):
    room["last_seen"] = time.time()
    _save_db()


def _cleanup_expired():
    now = time.time()
    expired = []
    for rid, room in ROOMS.items():
        if now - room["created_at"] > ROOM_TTL:
            expired.append(rid)
        elif not room.get("has_message") and now - room.get("last_seen", room["created_at"]) > IDLE_TTL:
            expired.append(rid)
    for rid in expired:
        path = ROOMS[rid].get("stego_path")
        if path:
            try:
                if os.path.exists(path):
                    os.remove(path)
            except Exception as e:
                app.logger.error(f"Error deleting {path}: {e}")
        del ROOMS[rid]
    if expired:
        _save_db()


def _cleanup_loop():
    while True:
        time.sleep(600)
        with DB_LOCK:
            _cleanup_expired()

_load_db()
threading.Thread(target=_cleanup_loop, daemon=True).start()


def _is_valid_png(file_bytes: bytes) -> bool:
    """Validasi magic bytes PNG: 8 byte pertama harus 89 50 4E 47 0D 0A 1A 0A"""
    return file_bytes[:8] == b'\x89PNG\r\n\x1a\n'

# ══════════════════════════════════════════════════
# HALAMAN
# ══════════════════════════════════════════════════

@app.route("/")
def index():
    return render_template("index.html", static_version=STATIC_VERSION)

@app.route("/room/<room_id>")
def room_page(room_id):
    return render_template("index.html", static_version=STATIC_VERSION)

@app.route("/Icon/<path:filename>")
def serve_icon(filename):
    """Serve gambar dari folder Icon/ di root project."""
    icon_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "Icon")
    return send_from_directory(icon_dir, filename)

# ══════════════════════════════════════════════════
# API
# ══════════════════════════════════════════════════

@app.route("/api/room/create", methods=["POST"])
def create_room():
    _cleanup_expired()
    data = request.get_json()
    if not data or "public_key" not in data:
        return jsonify({"error": "public_key wajib disertakan"}), 400

    pub_key = data["public_key"].strip()
    if len(pub_key) < 200:
        return jsonify({"error": "public_key terlalu pendek, bukan RSA-2048 yang valid"}), 400

    room_id = uuid.uuid4().hex[:8].upper()
    while room_id in ROOMS:
        room_id = uuid.uuid4().hex[:8].upper()

    ROOMS[room_id] = {
        "public_key" : pub_key,
        "stego_path" : None,
        "created_at" : time.time(),
        "last_seen"  : time.time(),
        "has_message": False,
    }
    _save_db()
    app.logger.info(f"Room created: {room_id}")
    return jsonify({"room_id": room_id}), 201


@app.route("/api/room/<room_id>/pubkey")
def get_pubkey(room_id):
    room = ROOMS.get(room_id.upper())
    if not room:
        return jsonify({"error": "Room tidak ditemukan atau sudah kadaluarsa"}), 404
    _touch_room(room)
    return jsonify({"room_id": room_id.upper(), "public_key": room["public_key"]})


@app.route("/api/room/<room_id>/status")
def room_status(room_id):
    room = ROOMS.get(room_id.upper())
    if not room:
        return jsonify({"error": "Room tidak ditemukan"}), 404
    _touch_room(room)
    return jsonify({"room_id": room_id.upper(), "has_message": room["has_message"]})


@app.route("/api/room/<room_id>/upload", methods=["POST"])
def upload_stego(room_id):
    _cleanup_expired() # FIX: Bersihkan file lama setiap kali ada upload baru biar nggak memory leak
    
    room = ROOMS.get(room_id.upper())
    if not room:
        return jsonify({"error": "Room tidak ditemukan"}), 404
    if "file" not in request.files:
        return jsonify({"error": "File tidak disertakan"}), 400

    f = request.files["file"]
    if not f.filename:
        return jsonify({"error": "Nama file kosong"}), 400

    file_bytes = f.read()
    if not _is_valid_png(file_bytes):
        return jsonify({"error": "File bukan PNG yang valid. Jangan kirim JPEG — data DCT akan rusak."}), 400

    old = room.get("stego_path")
    if old and os.path.exists(old):
        os.remove(old)

    filename  = f"stego_{room_id.upper()}_{int(time.time())}.png"
    save_path = UPLOAD_DIR / filename
    save_path.write_bytes(file_bytes)

    room["stego_path"]  = str(save_path.resolve())
    room["has_message"] = True
    _save_db()
    app.logger.info(f"Stego uploaded: room={room_id} file={filename} size={len(file_bytes)}B")
    return jsonify({"success": True}), 200


@app.route("/api/room/<room_id>/download")
def download_stego(room_id):
    room = ROOMS.get(room_id.upper())
    if not room:
        return jsonify({"error": "Room tidak ditemukan"}), 404
    if not room["has_message"] or not room["stego_path"]:
        return jsonify({"error": "Belum ada pesan di room ini"}), 404
    if not os.path.exists(room["stego_path"]):
        app.logger.warning(f"File tidak ditemukan: {room['stego_path']}")
        room["has_message"] = False
        room["stego_path"]  = None
        return jsonify({"error": "File stego tidak ditemukan di server"}), 404

    try:
        return send_file(room["stego_path"], mimetype="image/png",
                         as_attachment=False, download_name="stego.png")
    except FileNotFoundError:
        app.logger.error(f"FileNotFoundError saat send_file: {room['stego_path']}")
        room["has_message"] = False
        room["stego_path"]  = None
        return jsonify({"error": "File stego dihapus atau tidak valid"}), 410


@app.route("/api/room/<room_id>/clear", methods=["DELETE"])
def clear_stego(room_id):
    room = ROOMS.get(room_id.upper())
    if not room:
        return jsonify({"error": "Room tidak ditemukan"}), 404
    path = room.get("stego_path")
    if path and os.path.exists(path):
        os.remove(path)
    room["has_message"] = False
    room["stego_path"]  = None
    _save_db()
    return jsonify({"success": True})


@app.route("/api/room/<room_id>/close", methods=["POST", "DELETE"])
def close_room(room_id):
    room = ROOMS.pop(room_id.upper(), None)
    if room:
        path = room.get("stego_path")
        if path and os.path.exists(path):
            try:
                os.remove(path)
            except Exception as e:
                app.logger.error(f"Error deleting {path}: {e}")
        _save_db()
    return jsonify({"success": True})


if __name__ == "__main__":
    print("=" * 50)
    print("  WhistleShield Server")
    print("  https://0.0.0.0:5000")
    print("=" * 50)
    app.run(host="0.0.0.0", port=5000, ssl_context="adhoc", use_reloader=False)