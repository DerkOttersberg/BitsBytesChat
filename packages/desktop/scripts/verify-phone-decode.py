"""Decode actual browser MediaRecorder output through the production local worker."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import time
import uuid
import wave

parser = argparse.ArgumentParser()
parser.add_argument("audio", type=Path)
parser.add_argument("--transcribe", action="store_true")
options = parser.parse_args()
root = Path(__file__).resolve().parents[3]
folder = root / ".tools/qa" / ("phone-decode-" + uuid.uuid4().hex)
folder.mkdir(parents=True)
spec = importlib.util.spec_from_file_location("worker", root / "packages/desktop/resources/bitsbytes/worker.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
worker.ROOT = folder
worker.emit = lambda value: None
started = time.perf_counter()
job = worker.import_audio({"path": str(options.audio.resolve()), "title": "Browser microphone QA", "engine": "parakeet"})
assert job["importComplete"] and job["status"] == "recorded" and job["duration"] > 0
frames = 0
for chunk in job["chunks"]:
    assert abs(chunk["start"] - frames / worker.RATE) < 0.01
    with wave.open(chunk["path"], "rb") as audio:
        assert audio.getframerate() == worker.RATE and audio.getnchannels() == 1 and audio.getsampwidth() == 2
        frames += audio.getnframes()
assert abs(job["duration"] - frames / worker.RATE) < 0.01
report = {"source": str(options.audio), "job": job["id"], "seconds": job["duration"], "chunks": len(job["chunks"]), "decodeSeconds": time.perf_counter() - started}
if options.transcribe:
    os.environ["HF_HOME"] = str(Path(os.environ["LOCALAPPDATA"]) / "BitsBytesChat/models/huggingface")
    os.environ["HF_HUB_OFFLINE"] = "1"
    started = time.perf_counter()
    result = worker.transcribe({"id": job["id"], "acceleration": "cpu"})
    assert result["status"] == "transcribed" and all(chunk["done"] for chunk in result["chunks"])
    report.update(transcriptionSeconds=time.perf_counter() - started, segments=len(result["segments"]), status=result["status"])
    # Fake microphone audio verifies encoding and inference, not Dutch accuracy.
    report["accuracyBenchmark"] = False
(root / ".tools/qa/results" / (options.audio.stem + "-decode.json")).write_text(json.dumps(report, indent=2), encoding="utf-8")
print(json.dumps(report))
