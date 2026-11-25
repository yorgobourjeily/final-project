"""
Live student face recognition using a PRE-TRAINED model (InsightFace / ArcFace "buffalo_l").
No training from scratch needed - the model downloads automatically (~300 MB) on first run.

Install:
    pip install insightface onnxruntime opencv-python numpy
    (GPU users: pip install onnxruntime-gpu instead of onnxruntime)

Folder layout for your students:
    dataset/
        Ahmad/   1.jpg 2.jpg 3.jpg ...
        Maya/    1.jpg 2.jpg ...
    (10-30 clear photos per student, different angles and lighting)
    student_ids.json maps those folder names to numeric ZeroProxy student IDs.

Usage:
    python face_live.py capture Ahmad   # take photos of a student with the webcam (press SPACE to save, Q to quit)
    python face_live.py encoder         # run the local camera-image encoder for the admin form
    python face_live.py enroll          # encode photos and save each student's face template in ZeroProxy
    python face_live.py live            # classroom: runs forever, recognises faces and saves arrival times
    python face_live.py live --headless # same, without a video window (Ctrl+C to stop)
    python face_live.py live --cameras 0,1,rtsp://user:pass@192.168.1.20/stream   # several cameras at once

Set ZEROPROXY_DEVICE_KEY to the backend DEVICE_KEY before enrollment or live recognition
(if unset, DEVICE_KEY is read from ../zeroproxy-backend/.env).
--cameras (or ZEROPROXY_CAMERA) lists the cameras, separated by commas: webcam numbers or stream URLs (default 0).
All cameras share one face model, so recognition speed is divided between them.
ZEROPROXY_DET_SIZE sets the live face-finder size: 320 = fastest, 480 = default, 640 = finds faces further away.
Each camera is reopened automatically if it disconnects; the others keep running.
Faces are scanned only while a teacher has a class running (Start class / End class on the teacher page).
While live mode runs, the admin page's "View camera" button shows the cameras (this computer only, nothing is stored).
Face embeddings are stored in the backend database; camera images are not uploaded.
"""
import os
import sys
import json
import queue
import re
import threading
import time
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

import cv2
import numpy as np
import onnxruntime
from insightface.app import FaceAnalysis

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATASET_DIR = os.path.join(BASE_DIR, "dataset")
STUDENT_IDS_FILE = os.path.join(BASE_DIR, "student_ids.json")
SCAN_URL = os.environ.get("ZEROPROXY_SCAN_URL", "http://localhost:3000/api/scans")
ENROLL_URL = os.environ.get("ZEROPROXY_ENROLL_URL", "http://localhost:3000/api/face-enrollments")
SESSION_URL = SCAN_URL.rsplit("/", 1)[0] + "/scan-status"
SESSION_CHECK_SECONDS = 3
WAITING_STATUS = "Waiting for a teacher to start a class"
SCAN_RETRY_SECONDS = 15
SCAN_SUCCESS_COOLDOWN_SECONDS = 60
TRACK_SIMILARITY = 0.80
TRACK_TIMEOUT_SECONDS = 20
ENCODER_HOST = "127.0.0.1"
ENCODER_PORT = 8765
ENCODER_ORIGINS = {"http://localhost:4200", "http://127.0.0.1:4200"}
MAX_IMAGE_BYTES = 8 * 1024 * 1024
VIEW_PORT = 8766
VIEW_FRAME_SECONDS = 0.1  # the admin page's camera view runs at up to 10 frames/s, to leave the CPU for recognition
CAMERA_RETRY_SECONDS = 5
CAMERA_LOST_SECONDS = 2
# Enrollment photos from the admin popup: full profiles or tilted heads give unreliable face codes.
MIN_DETECTION_SCORE = 0.6
MAX_PITCH_DEGREES = 35
MAX_YAW_DEGREES = 50


# Face finder input size for live mode: smaller = faster, larger = finds faces further away (320 / 480 / 640).
LIVE_DET_SIZE = int(os.environ.get("ZEROPROXY_DET_SIZE", "480"))


# CPU threads for the face model. ONNX Runtime's default (every core, busy-waiting) is SLOWER and starves
# the webcam driver and the display; measured on 24 cores: default 3.5 frames/s on 23 cores, 8 threads 16 frames/s.
MODEL_THREADS = int(os.environ.get("ZEROPROXY_THREADS", str(min(8, max(2, (os.cpu_count() or 4) // 3)))))


def load_model(modules=("detection", "recognition"), det_size=640):
    """Loads only the parts of buffalo_l that are used: unused ones (age/gender, 2D landmarks) cost ~3x the time.
    'landmark_3d_68' gives the head angle (pose), needed only to check enrollment photos."""
    options = onnxruntime.SessionOptions()
    options.intra_op_num_threads = MODEL_THREADS
    options.inter_op_num_threads = 1
    options.add_session_config_entry("session.intra_op.allow_spinning", "0")
    # ctx_id=-1 -> CPU, ctx_id=0 -> first GPU
    app = FaceAnalysis(
        name="buffalo_l", providers=["CPUExecutionProvider"], allowed_modules=list(modules), sess_options=options
    )
    app.prepare(ctx_id=-1, det_size=(det_size, det_size))
    return app


def largest_face(faces):
    return max(faces, key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]))


def load_student_ids():
    if not os.path.exists(STUDENT_IDS_FILE):
        return {}
    with open(STUDENT_IDS_FILE, "r", encoding="utf-8") as f:
        mapping = json.load(f)
    if not isinstance(mapping, dict):
        raise ValueError(f"{STUDENT_IDS_FILE} must contain a JSON object mapping folder names to student IDs.")
    return mapping


def post_json(url, payload, device_key):
    return send_json(Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "X-Device-Key": device_key},
        method="POST",
    ))


def send_json(request):
    try:
        with urlopen(request, timeout=5) as response:
            data = response.read().decode("utf-8")
            return response.status, json.loads(data) if data else {}
    except HTTPError as exc:
        try:
            data = json.loads(exc.read().decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            data = {"error": f"Request rejected ({exc.code})"}
        return exc.code, data
    except (URLError, TimeoutError, OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        return None, {"error": f"Could not reach ZeroProxy: {exc}"}


def capture(name):
    """Save webcam photos of one student into dataset/<name>/."""
    folder = os.path.join(DATASET_DIR, name)
    os.makedirs(folder, exist_ok=True)
    cam = cv2.VideoCapture(0)
    count = len(os.listdir(folder))
    print("SPACE = save photo, Q = quit")
    while True:
        ok, frame = cam.read()
        if not ok:
            break
        view = frame.copy()
        cv2.putText(view, f"{name}: {count} photos", (10, 30),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 255, 0), 2)
        cv2.imshow("Capture", view)
        key = cv2.waitKey(1) & 0xFF
        if key == ord(" "):
            count += 1
            cv2.imwrite(os.path.join(folder, f"{count}.jpg"), frame)
        elif key == ord("q"):
            break
    cam.release()
    cv2.destroyAllWindows()


def enroll():
    """Encode each student's photos and save the template in the backend database."""
    device_key = device_key_from_env()
    if not device_key:
        print("Set ZEROPROXY_DEVICE_KEY to the backend DEVICE_KEY before enrollment.")
        return
    try:
        student_ids = load_student_ids()
    except (OSError, json.JSONDecodeError, ValueError) as exc:
        print(f"Could not read student ID mapping: {exc}")
        return

    folders = []
    missing_ids = []
    for person in sorted(os.listdir(DATASET_DIR)) if os.path.isdir(DATASET_DIR) else []:
        person_dir = os.path.join(DATASET_DIR, person)
        if not os.path.isdir(person_dir):
            continue
        image_names = [name for name in os.listdir(person_dir) if os.path.isfile(os.path.join(person_dir, name))]
        if not image_names:
            continue
        student_id = str(student_ids.get(person, person if person.isdigit() else "")).strip()
        if not student_id.isdigit():
            missing_ids.append(person)
            continue
        folders.append((person, student_id, image_names))

    if missing_ids:
        print("Missing numeric ZeroProxy student IDs for these dataset folders: " + ", ".join(missing_ids))
        print(f'Add mappings to {STUDENT_IDS_FILE}, for example: {json.dumps({missing_ids[0]: "2"}, indent=2)}')
        return
    if not folders:
        print("No student photos found in dataset/.")
        return
    id_folders = {}
    for person, student_id, _ in folders:
        id_folders.setdefault(student_id, []).append(person)
    duplicates = [student_id for student_id, people in id_folders.items() if len(people) > 1]
    if duplicates:
        print("Each dataset folder must map to a different student ID. Duplicate IDs: " + ", ".join(duplicates))
        return

    app = load_model()
    enrolled = 0
    for person, student_id, image_names in folders:
        person_dir = os.path.join(DATASET_DIR, person)
        vecs = []
        for img_name in image_names:
            img = cv2.imread(os.path.join(person_dir, img_name))
            if img is None:
                continue
            faces = app.get(img)
            if not faces:
                print(f"  no face found in {person}/{img_name}, skipped")
                continue
            vecs.append(largest_face(faces).normed_embedding)
        if not vecs:
            print(f"{person}: no usable photos")
            continue
        mean = np.mean(vecs, axis=0)
        embedding = (mean / np.linalg.norm(mean)).tolist()
        status, response = post_json(ENROLL_URL, {"id": student_id, "embedding": embedding}, device_key)
        if status in (200, 201):
            enrolled += 1
            print(f"{person}: {len(vecs)} photos encoded; {response.get('message', 'template saved')}")
        else:
            print(f"{person}: enrollment failed: {response.get('error', 'unknown API error')}")
    print(f"Enrolled {enrolled} of {len(folders)} student face templates in ZeroProxy.")


def scan_sender(scan_queue, result_queue, device_key):
    """Send face encodings for database matching without blocking camera processing."""
    while True:
        item = scan_queue.get()
        if item is None:
            return
        face_key, embedding, arrival_time = item
        status, response = post_json(
            SCAN_URL,
            {"embedding": embedding, "time": arrival_time},
            device_key,
        )
        result_queue.put((face_key, status in (200, 201), response))


def session_watcher(device_key, scanning, stop):
    """Asks ZeroProxy every few seconds whether a class is running; faces are scanned only then."""
    last_message = None
    while not stop.is_set():
        status, response = send_json(Request(SESSION_URL, headers={"X-Device-Key": device_key}))
        running = status == 200 and bool(response.get("scanning"))
        if running:
            scanning.set()
            message = f"Class running ({', '.join(response.get('classes', []))}): scanning faces."
        else:
            scanning.clear()
            message = f"{WAITING_STATUS}." if status == 200 else f"Cannot check for running classes: {response.get('error')}"
        if message != last_message:
            log(message)
            last_message = message
        stop.wait(SESSION_CHECK_SECONDS)


def find_face_tracker(trackers, embedding):
    best = None
    best_similarity = TRACK_SIMILARITY
    for tracker in trackers:
        similarity = float(np.dot(tracker["embedding"], embedding))
        if similarity >= best_similarity:
            best = tracker
            best_similarity = similarity
    return best


def serve_encoder():
    """Serve browser captures as face embeddings on the local machine only."""
    app = load_model(("detection", "recognition", "landmark_3d_68"))
    inference_lock = threading.Lock()

    class EncoderHandler(BaseHTTPRequestHandler):
        def send_json(self, status, payload):
            data = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            origin = self.headers.get("Origin")
            if origin in ENCODER_ORIGINS:
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Vary", "Origin")
                self.send_header("Access-Control-Allow-Private-Network", "true")
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_OPTIONS(self):
            origin = self.headers.get("Origin")
            if origin not in ENCODER_ORIGINS:
                self.send_json(403, {"error": "Origin not allowed."})
                return
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Access-Control-Allow-Private-Network", "true")
            self.end_headers()

        def do_POST(self):
            if self.path != "/encode":
                self.send_json(404, {"error": "Endpoint not found."})
                return
            if self.headers.get("Origin") not in ENCODER_ORIGINS:
                self.send_json(403, {"error": "Origin not allowed."})
                return
            if not self.headers.get("Content-Type", "").startswith("image/jpeg"):
                self.send_json(415, {"error": "Send a JPEG image."})
                return
            try:
                content_length = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                self.send_json(400, {"error": "Invalid image size."})
                return
            if content_length <= 0 or content_length > MAX_IMAGE_BYTES:
                self.send_json(413, {"error": "Image must be smaller than 8 MB."})
                return

            image_data = self.rfile.read(content_length)
            image = cv2.imdecode(np.frombuffer(image_data, dtype=np.uint8), cv2.IMREAD_COLOR)
            if image is None:
                self.send_json(400, {"error": "Could not read the captured image."})
                return
            with inference_lock:
                faces = app.get(image)
            if len(faces) != 1:
                self.send_json(400, {"error": "Keep exactly one face in the camera frame."})
                return

            face = faces[0]
            if float(face.det_score) < MIN_DETECTION_SCORE:
                self.send_json(400, {"error": "The face is not clear enough. Improve the light and look at the camera."})
                return
            pitch, yaw = (float(face.pose[0]), float(face.pose[1])) if getattr(face, "pose", None) is not None else (0.0, 0.0)
            # Yaw first: on a full profile the pitch estimate is unreliable too.
            if abs(yaw) > MAX_YAW_DEGREES:
                self.send_json(400, {"error": "The head is turned too far. Turn only slightly so both eyes stay visible."})
                return
            if abs(pitch) > MAX_PITCH_DEGREES:
                self.send_json(400, {"error": "Keep the head level: do not look up or down."})
                return

            embedding = np.asarray(face.normed_embedding, dtype=np.float32)
            magnitude = np.linalg.norm(embedding)
            if embedding.size != 512 or magnitude < 1e-12:
                self.send_json(400, {"error": "The face model returned an invalid embedding."})
                return
            self.send_json(200, {"embedding": (embedding / magnitude).tolist(), "yaw": round(yaw, 1), "pitch": round(pitch, 1)})

        def log_message(self, format, *args):
            print(f"Face encoder: {format % args}")

    server = ThreadingHTTPServer((ENCODER_HOST, ENCODER_PORT), EncoderHandler)
    print(f"Local face encoder listening at http://localhost:{ENCODER_PORT}/encode (Ctrl+C to stop)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping face encoder.")
    finally:
        server.server_close()


def log(message):
    print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] {message}", flush=True)


def device_key_from_env():
    """ZEROPROXY_DEVICE_KEY, or DEVICE_KEY from ../zeroproxy-backend/.env when both run on one machine."""
    key = os.environ.get("ZEROPROXY_DEVICE_KEY", "").strip()
    if key:
        return key
    env_file = os.path.join(BASE_DIR, "..", "zeroproxy-backend", ".env")
    try:
        with open(env_file, "r", encoding="utf-8") as f:
            for line in f:
                name, _, value = line.strip().partition("=")
                if name == "DEVICE_KEY" and value.strip():
                    return value.strip()
    except OSError:
        pass
    return ""


def parse_cameras(text):
    """'0,1,rtsp://...' -> [0, 1, 'rtsp://...']. Numbers are webcams, anything else is a stream URL. Repeats are dropped."""
    items = [item.strip() for item in text.split(",") if item.strip()]
    return list(dict.fromkeys(int(item) if item.isdigit() else item for item in items))


def camera_name(source):
    """The camera's name for logs and window titles, without the password of a stream URL."""
    return re.sub(r"//.*@", "//", str(source))


def open_camera(source, closed):
    """Opens one camera, retrying until it is available (the classroom machine runs unattended).
    Returns None if `closed` is set first."""
    name = camera_name(source)
    # On Windows, DirectShow opens webcams faster and drops out less than the default Media Foundation driver.
    backends = [cv2.CAP_DSHOW, cv2.CAP_ANY] if sys.platform == "win32" and isinstance(source, int) else [cv2.CAP_ANY]
    while not closed.is_set():
        for backend in backends:
            cam = cv2.VideoCapture(source, backend)
            if cam.isOpened():
                cam.set(cv2.CAP_PROP_BUFFERSIZE, 1)  # no queue of old frames = no delay
                ok, _ = cam.read()
                if ok:
                    log(f"Camera {name} opened ({cam.getBackendName()}).")
                    return cam
            cam.release()
        log(f"Camera {name} unavailable; retrying in {CAMERA_RETRY_SECONDS} s...")
        closed.wait(CAMERA_RETRY_SECONDS)
    return None


def draw_overlay(frame, boxes, status, fps):
    """Draws the recognition boxes and status text on a frame."""
    for (x1, y1, x2, y2), label, color in boxes:
        cv2.rectangle(frame, (x1, y1), (x2, y2), color, 2)
        cv2.putText(frame, label, (x1, y1 - 8), cv2.FONT_HERSHEY_SIMPLEX, 0.7, color, 2)
    cv2.putText(frame, status[:100], (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (255, 255, 255), 2)
    cv2.putText(frame, f"recognition {fps:.1f}/s", (10, frame.shape[0] - 12), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (200, 200, 200), 1)


def serve_camera_views(cameras, state, state_lock, stop):
    """Streams the cameras to the admin page, on this computer only. Frames are encoded only while someone watches."""

    class ViewHandler(BaseHTTPRequestHandler):
        def send_camera_list(self):
            data = json.dumps({"cameras": [{"name": camera.name} for camera in cameras]}).encode("utf-8")
            self.send_response(200)
            origin = self.headers.get("Origin")
            if origin in ENCODER_ORIGINS:
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Vary", "Origin")
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def send_stream(self, index):
            self.send_response(200)
            self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=frame")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            last_seq = -1
            while not stop.is_set():
                frame, seq = cameras[index].latest()
                if frame is None or seq == last_seq:
                    time.sleep(0.02)
                    continue
                last_seq = seq
                frame = frame.copy()
                with state_lock:
                    boxes, status, fps = list(state["boxes"][index]), state["status"], state["fps"]
                draw_overlay(frame, boxes, status, fps)
                ok, image = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 75])
                if ok:
                    self.wfile.write(b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: %d\r\n\r\n" % image.size)
                    self.wfile.write(image.tobytes())
                    self.wfile.write(b"\r\n")
                time.sleep(VIEW_FRAME_SECONDS)

        def do_GET(self):
            # Only names of this computer: stops other websites reaching the cameras through a look-alike address.
            if self.headers.get("Host") not in (f"localhost:{VIEW_PORT}", f"{ENCODER_HOST}:{VIEW_PORT}"):
                self.send_error(403)
                return
            stream = re.fullmatch(r"/stream/(\d{1,3})", self.path)
            try:
                if self.path == "/cameras":
                    self.send_camera_list()
                elif stream and int(stream[1]) < len(cameras):
                    self.send_stream(int(stream[1]))
                else:
                    self.send_error(404)
            except OSError:
                pass  # the viewer closed the page

        def log_message(self, format, *args):
            pass

    try:
        server = ThreadingHTTPServer((ENCODER_HOST, VIEW_PORT), ViewHandler)
    except OSError as exc:
        log(f"Camera view unavailable, recognition continues: {exc}")
        return None
    threading.Thread(target=server.serve_forever, daemon=True).start()
    log(f"Camera view ready for the admin page at http://localhost:{VIEW_PORT}")
    return server


def live(headless=False, sources=(0,)):
    """Runs forever: recognises faces on every camera, sends their encodings to ZeroProxy, which matches them and saves the arrival time."""
    device_key = device_key_from_env()
    if not device_key:
        print("Set ZEROPROXY_DEVICE_KEY to the backend DEVICE_KEY before starting live recognition.")
        return

    app = load_model(det_size=LIVE_DET_SIZE)
    cameras = [LatestFrameCamera(source) for source in sources]
    scan_queue = queue.Queue()
    result_queue = queue.Queue()
    sender = threading.Thread(target=scan_sender, args=(scan_queue, result_queue, device_key), daemon=True)
    sender.start()
    state = {"boxes": [[] for _ in cameras], "status": WAITING_STATUS, "fps": 0.0}
    state_lock = threading.Lock()
    stop = threading.Event()
    scanning = threading.Event()
    threading.Thread(target=session_watcher, args=(device_key, scanning, stop), daemon=True).start()
    worker = threading.Thread(
        target=recognition_worker, args=(app, cameras, scan_queue, result_queue, state, state_lock, stop, scanning), daemon=True
    )
    worker.start()
    view_server = serve_camera_views(cameras, state, state_lock, stop)
    log(
        f"Live recognition running on {len(cameras)} camera(s)"
        + (" (headless, Ctrl+C to stop)." if headless else " (press Q in a window to stop).")
    )
    try:
        if headless:
            while worker.is_alive():
                worker.join(timeout=1)
            return
        # One window per camera shows every frame at full speed with the latest recognition boxes drawn on top.
        last_seqs = [-1] * len(cameras)
        while True:
            shown = False
            for index, camera in enumerate(cameras):
                frame, seq = camera.latest()
                if frame is None or seq == last_seqs[index]:
                    continue
                last_seqs[index] = seq
                shown = True
                frame = frame.copy()
                with state_lock:
                    boxes, status, fps = list(state["boxes"][index]), state["status"], state["fps"]
                draw_overlay(frame, boxes, status, fps)
                cv2.imshow(f"Live Face Recognition - camera {camera.name} (Q to quit)", frame)
            if cv2.waitKey(1 if shown else 5) & 0xFF == ord("q"):
                break
    except KeyboardInterrupt:
        log("Stopping live recognition.")
    finally:
        stop.set()
        worker.join(timeout=5)
        if view_server:
            view_server.shutdown()
            view_server.server_close()
        for camera in cameras:
            camera.close()
        scan_queue.put(None)
        sender.join(timeout=1)
        cv2.destroyAllWindows()


class LatestFrameCamera:
    """Reads one camera in its own thread and keeps only the newest frame, so nothing waits on stale frames.
    Opens and reconnects by itself, so a missing camera never holds up the others."""

    def __init__(self, source):
        self.name = camera_name(source)
        self._source = source
        self._lock = threading.Lock()
        self._frame = None
        self._seq = 0
        self._closed = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def _run(self):
        cam = open_camera(self._source, self._closed)
        failed_since = None
        while cam is not None and not self._closed.is_set():
            ok, frame = cam.read()
            if not ok:
                # A single failed read is normal; only reopen (camera light off/on) if the feed is gone for a while.
                failed_since = failed_since or time.monotonic()
                if time.monotonic() - failed_since < CAMERA_LOST_SECONDS:
                    time.sleep(0.05)
                    continue
                log(f"Lost the feed of camera {self.name}; reconnecting...")
                cam.release()
                cam = open_camera(self._source, self._closed)
                failed_since = None
                continue
            failed_since = None
            with self._lock:
                self._frame = frame
                self._seq += 1
        if cam is not None:
            cam.release()

    def latest(self):
        with self._lock:
            return self._frame, self._seq

    def close(self):
        self._closed.set()
        self._thread.join(timeout=2)


def recognition_worker(app, cameras, scan_queue, result_queue, state, state_lock, stop, scanning):
    """While a class is running, runs the face model on the cameras' newest frames, in turn, as fast as the CPU allows;
    publishes boxes for the display. The trackers are shared, so a student seen by two cameras is still one face."""
    trackers = []
    next_face_key = 1
    scan_status = state["status"]
    last_seqs = [-1] * len(cameras)
    next_camera = 0
    while not stop.is_set():
        if not scanning.is_set():
            scan_status = WAITING_STATUS
            with state_lock:
                state["boxes"] = [[] for _ in cameras]
                state["status"] = scan_status
                state["fps"] = 0.0
            stop.wait(0.2)
            continue
        if scan_status == WAITING_STATUS:
            scan_status = "Class running: scanning faces"

        # The next camera in turn with a new frame, so each one gets an equal share of the model.
        for offset in range(len(cameras)):
            index = (next_camera + offset) % len(cameras)
            frame, seq = cameras[index].latest()
            if frame is not None and seq != last_seqs[index]:
                break
        else:
            time.sleep(0.01)
            continue
        next_camera = index + 1
        last_seqs[index] = seq
        started = time.monotonic()

        # Server replies for faces sent earlier.
        while not result_queue.empty():
            face_key, succeeded, response = result_queue.get_nowait()
            tracker = next((item for item in trackers if item["key"] == face_key), None)
            if tracker is None:
                continue
            tracker["pending"] = False
            if succeeded:
                student = response.get("student", {})
                tracker["label"] = f"{student.get('name', 'Student')} {student.get('id', '')}".strip()
                tracker["ok"] = True
                tracker["retry_at"] = time.monotonic() + SCAN_SUCCESS_COOLDOWN_SECONDS
                scan_status = response.get("message", f"Matched {tracker['label']}")
            else:
                error = response.get("error", "ZeroProxy scan failed")
                tracker["label"] = "Unknown face" if "matched" in error or "enrolled" in error else error[:40]
                tracker["ok"] = False
                tracker["retry_at"] = time.monotonic() + SCAN_RETRY_SECONDS
                scan_status = error
            log(scan_status)

        try:
            faces = app.get(frame)
        except Exception as exc:  # keep the classroom machine running whatever happens to one frame
            log(f"Face model error on a frame: {exc}")
            continue

        now = time.monotonic()
        trackers = [item for item in trackers if item["pending"] or now - item["last_seen"] < TRACK_TIMEOUT_SECONDS]
        boxes = []
        for face in faces:
            embedding = np.asarray(face.normed_embedding, dtype=np.float32)
            magnitude = np.linalg.norm(embedding)
            if magnitude < 1e-12:
                continue
            embedding /= magnitude
            tracker = find_face_tracker(trackers, embedding)
            if tracker is None:
                tracker = {
                    "key": next_face_key,
                    "embedding": embedding.copy(),
                    "last_seen": now,
                    "retry_at": 0,
                    "pending": False,
                    "ok": None,
                    "label": "Matching...",
                }
                next_face_key += 1
                trackers.append(tracker)
            tracker["last_seen"] = now
            if not tracker["pending"] and now >= tracker["retry_at"]:
                scan_queue.put((tracker["key"], embedding.tolist(), datetime.now().strftime("%H:%M:%S")))
                tracker["pending"] = True
                if not tracker["ok"]:
                    tracker["label"] = "Matching..."
                scan_status = "Matching face against enrolled database templates..."
            # Green = recognised, red = unknown / refused, orange = still matching.
            color = {True: (0, 200, 0), False: (0, 0, 230)}.get(tracker["ok"], (0, 165, 255))
            boxes.append((tuple(int(v) for v in face.bbox), tracker["label"], color))

        elapsed = max(time.monotonic() - started, 1e-3)
        with state_lock:
            state["boxes"][index] = boxes
            state["status"] = scan_status
            state["fps"] = 0.8 * state["fps"] + 0.2 * (1 / elapsed) if state["fps"] else 1 / elapsed


if __name__ == "__main__":
    if len(sys.argv) < 2 or sys.argv[1] not in ("capture", "encoder", "enroll", "live"):
        print(__doc__)
    elif sys.argv[1] == "capture":
        if len(sys.argv) < 3:
            print("Usage: python face_live.py capture <StudentName>")
        else:
            capture(sys.argv[2])
    elif sys.argv[1] == "encoder":
        serve_encoder()
    elif sys.argv[1] == "enroll":
        enroll()
    else:
        args = sys.argv[2:]
        cameras_text = os.environ.get("ZEROPROXY_CAMERA") or "0"
        if "--cameras" in args:
            cameras_text = "".join(args[args.index("--cameras") + 1:][:1])
        sources = parse_cameras(cameras_text)
        if sources:
            live(headless="--headless" in args, sources=sources)
        else:
            print("Usage: python face_live.py live --cameras 0,1")
