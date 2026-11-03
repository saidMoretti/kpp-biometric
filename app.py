import base64
import json
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

import cv2
import face_recognition
import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field


ROOT = Path(__file__).resolve().parent
DB_PATH = Path(os.environ.get("KPP_DB_PATH", ROOT / "kpp.sqlite3"))
MATCH_THRESHOLD = float(os.environ.get("KPP_MATCH_THRESHOLD", "0.52"))
ENROLL_DUPLICATE_THRESHOLD = float(os.environ.get("KPP_DUPLICATE_THRESHOLD", "0.45"))
app = FastAPI(title="Система биометрической аутентификации КПП")
app.mount("/static", StaticFiles(directory=ROOT / "static"), name="static")


def connect():
    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row
    return db


def initialize():
    with connect() as db:
        db.executescript("""
            CREATE TABLE IF NOT EXISTS employees (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                personnel_id TEXT NOT NULL UNIQUE,
                clearance INTEGER NOT NULL CHECK(clearance BETWEEN 1 AND 3),
                embedding TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS events (
                id INTEGER PRIMARY KEY,
                employee_id INTEGER,
                employee_name TEXT,
                personnel_id TEXT,
                result TEXT NOT NULL,
                reason TEXT NOT NULL,
                zone_level INTEGER NOT NULL,
                distance REAL,
                occurred_at TEXT NOT NULL
            );
        """)


initialize()


class EnrollRequest(BaseModel):
    name: str = Field(min_length=2, max_length=100)
    personnel_id: str = Field(min_length=1, max_length=40)
    clearance: int = Field(ge=1, le=3)
    frames: list[str] = Field(min_length=1, max_length=8)


class ClearanceUpdate(BaseModel):
    clearance: int = Field(ge=1, le=3)


class VerifyRequest(BaseModel):
    frames: list[str] = Field(min_length=2, max_length=12)
    zone_level: int = Field(ge=1, le=3)


def decode_frame(data_url):
    try:
        encoded = data_url.split(",", 1)[-1]
        raw = base64.b64decode(encoded, validate=True)
        image = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR)
        if image is None:
            raise ValueError("invalid image")
        return cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
    except Exception as exc:
        raise HTTPException(400, "Не удалось прочитать кадр камеры") from exc


def analyze_frames(data_urls, need_motion=False):
    encodings, centers = [], []
    for item in data_urls:
        rgb = decode_frame(item)
        height, width = rgb.shape[:2]
        scale = min(1.0, 640 / max(width, height))
        if scale < 1:
            rgb = cv2.resize(rgb, (int(width * scale), int(height * scale)))
        faces = face_recognition.face_locations(rgb, model="hog", number_of_times_to_upsample=1)
        if len(faces) != 1:
            continue
        top, right, bottom, left = faces[0]
        vectors = face_recognition.face_encodings(rgb, [faces[0]], num_jitters=1)
        if vectors:
            encodings.append(vectors[0])
            centers.append(((left + right) / 2 / rgb.shape[1], (top + bottom) / 2 / rgb.shape[0]))
    if not encodings:
        raise HTTPException(422, "Лицо не распознано. Посмотрите в камеру и улучшите освещение.")
    if need_motion and len(encodings) < 2:
        raise HTTPException(422, "Не удалось проверить движение. Повторите сканирование.")
    if need_motion:
        drift = max(float(np.linalg.norm(np.subtract(a, b))) for a in centers for b in centers)
        if drift < 0.012:
            raise HTTPException(422, "Движение не подтверждено. Плавно поверните голову и повторите.")
    return np.mean(encodings, axis=0)


def log_event(employee, result, reason, zone_level, distance=None):
    with connect() as db:
        db.execute("""INSERT INTO events(employee_id, employee_name, personnel_id, result,
            reason, zone_level, distance, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (employee["id"] if employee else None,
             employee["name"] if employee else None,
             employee["personnel_id"] if employee else None,
             result, reason, zone_level, distance, datetime.now(timezone.utc).isoformat()))


@app.get("/")
def index():
    return FileResponse(ROOT / "static" / "index.html")


@app.get("/api/staff")
def staff():
    with connect() as db:
        rows = db.execute("SELECT id, name, personnel_id, clearance, created_at FROM employees ORDER BY name").fetchall()
    return [dict(row) for row in rows]


@app.post("/api/staff")
def enroll(payload: EnrollRequest):
    embedding = analyze_frames(payload.frames)
    try:
        with connect() as db:
            db.execute("BEGIN IMMEDIATE")
            existing = db.execute("SELECT id, name, personnel_id, embedding FROM employees").fetchall()
            duplicate = None
            duplicate_distance = None
            for employee_row in existing:
                known = np.asarray(json.loads(employee_row["embedding"]), dtype=np.float64)
                distance = float(np.linalg.norm(known - embedding))
                if duplicate_distance is None or distance < duplicate_distance:
                    duplicate, duplicate_distance = employee_row, distance
            if duplicate and duplicate_distance <= ENROLL_DUPLICATE_THRESHOLD:
                raise HTTPException(
                    409,
                    f"Похоже, этот человек уже зарегистрирован: {duplicate['name']} · № {duplicate['personnel_id']}",
                )
            created_at = datetime.now(timezone.utc).isoformat()
            cur = db.execute("INSERT INTO employees(name, personnel_id, clearance, embedding, created_at) VALUES (?, ?, ?, ?, ?)",
                (payload.name.strip(), payload.personnel_id.strip(), payload.clearance,
                 json.dumps(embedding.tolist()), created_at))
            db.execute("""INSERT INTO events(employee_id, employee_name, personnel_id, result,
                reason, zone_level, distance, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (cur.lastrowid, payload.name.strip(), payload.personnel_id.strip(), "registered",
                 f"Сотрудник зарегистрирован · уровень допуска: {payload.clearance}",
                 payload.clearance, None, created_at))
    except sqlite3.IntegrityError as exc:
        raise HTTPException(409, "Табельный номер уже зарегистрирован") from exc
    return {"id": cur.lastrowid, "status": "created"}


@app.patch("/api/staff/{employee_id}")
def update_employee(employee_id: int, payload: ClearanceUpdate):
    with connect() as db:
        employee = db.execute(
            "SELECT id, name, personnel_id, clearance FROM employees WHERE id = ?", (employee_id,)
        ).fetchone()
        if employee and employee["clearance"] != payload.clearance:
            db.execute("UPDATE employees SET clearance = ? WHERE id = ?", (payload.clearance, employee_id))
    if not employee:
        raise HTTPException(404, "Сотрудник не найден")
    if employee["clearance"] != payload.clearance:
        reason = f"Уровень допуска изменен: {employee['clearance']} → {payload.clearance}"
        log_event(employee, "clearance_changed", reason, payload.clearance)
    return {"id": employee_id, "clearance": payload.clearance, "status": "updated"}


@app.delete("/api/staff/{employee_id}")
def remove_employee(employee_id: int):
    with connect() as db:
        employee = db.execute(
            "SELECT id, name, personnel_id, clearance FROM employees WHERE id = ?", (employee_id,)
        ).fetchone()
        if employee:
            db.execute("DELETE FROM employees WHERE id = ?", (employee_id,))
            db.execute("""INSERT INTO events(employee_id, employee_name, personnel_id, result,
                reason, zone_level, distance, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (employee["id"], employee["name"], employee["personnel_id"], "deleted",
                 "Сотрудник удален", employee["clearance"], None, datetime.now(timezone.utc).isoformat()))
    if not employee:
        raise HTTPException(404, "Сотрудник не найден")
    return {"status": "deleted"}


@app.get("/api/events")
def events(limit: int = 100):
    limit = max(1, min(limit, 500))
    with connect() as db:
        rows = db.execute("SELECT * FROM events ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
    return [dict(row) for row in rows]


@app.post("/api/verify")
def verify(payload: VerifyRequest):
    try:
        probe = analyze_frames(payload.frames, need_motion=True)
    except HTTPException as exc:
        log_event(None, "denied", str(exc.detail), payload.zone_level)
        raise
    with connect() as db:
        rows = db.execute("SELECT * FROM employees").fetchall()
    best, best_distance = None, None
    for row in rows:
        known = np.asarray(json.loads(row["embedding"]), dtype=np.float64)
        distance = float(np.linalg.norm(known - probe))
        if best_distance is None or distance < best_distance:
            best, best_distance = row, distance
    if best is None or best_distance > MATCH_THRESHOLD:
        reason = "Сотрудник не найден" if best is None else "Лицо не совпало с записью"
        log_event(None, "denied", reason, payload.zone_level, best_distance)
        return {"granted": False, "reason": reason, "distance": best_distance}
    if best["clearance"] < payload.zone_level:
        reason = "Недостаточный уровень допуска"
        log_event(best, "denied", reason, payload.zone_level, best_distance)
        return {"granted": False, "reason": reason, "employee": best["name"], "distance": best_distance}
    reason = "Доступ разрешен"
    log_event(best, "granted", reason, payload.zone_level, best_distance)
    return {"granted": True, "reason": reason, "employee": best["name"],
            "personnel_id": best["personnel_id"], "clearance": best["clearance"], "distance": best_distance}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host="127.0.0.1", port=int(os.environ.get("PORT", "8000")), reload=False)
