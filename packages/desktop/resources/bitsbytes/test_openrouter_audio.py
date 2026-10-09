"""Real local HTTP and owned-process checks; no provider account or real API key."""
import base64
import concurrent.futures
import contextlib
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import wave

spec = importlib.util.spec_from_file_location("audio_worker", Path(__file__).with_name("worker.py"))
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class OpenRouterAudio(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="bb-openrouter-audio-")
        worker.ROOT = Path(self.temp.name)
        self.addCleanup(self.temp.cleanup)
        self.output = io.StringIO()
        redirect = contextlib.redirect_stdout(self.output)
        redirect.__enter__()
        self.addCleanup(redirect.__exit__, None, None, None)
        self.requests = []
        self.responses = []
        self.received = threading.Event()
        self.release = threading.Event()
        self.delay = False
        fixture = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_POST(self):
                payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                fixture.requests.append({"body": payload, "authorization": self.headers.get("Authorization")})
                fixture.received.set()
                if fixture.delay:
                    fixture.release.wait(8)
                status, body = fixture.responses.pop(0) if fixture.responses else (200, {"text": " Nederlands: café. "})
                if status == 0:
                    self.close_connection = True
                    return
                encoded = (json.dumps(body) if not isinstance(body, bytes) else body.decode()).encode()
                try:
                    self.send_response(status)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(encoded)))
                    self.end_headers()
                    self.wfile.write(encoded)
                except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                    pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=lambda: self.server.serve_forever(poll_interval=0.05), daemon=True)
        self.thread.start()
        self.addCleanup(self.stop_server)
        endpoint = f"http://127.0.0.1:{self.server.server_port}/audio/transcriptions"
        replacement = patch.object(worker, "OPENROUTER_STT_URL", endpoint)
        replacement.start()
        self.addCleanup(replacement.stop)

    def stop_server(self):
        self.release.set()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(2)

    def recording(self, durations=(30,), **preferences):
        job = worker.create_job({"engine": "openrouter", **preferences})
        for duration in durations:
            worker.add_chunk(job["id"], bytes(worker.RATE * 2 * duration))
        return worker.read_job(job["id"])

    def test_json_wav_payload_and_durable_model_language_snapshot(self):
        job = self.recording((30, 30, 5), audioModel="openai/gpt-4o-mini-transcribe", audioLanguage="nl")
        result = worker.transcribe({"id": job["id"], "key": "fixture-key", "audioModel": "ignored/chat-model", "audioLanguage": "en"})
        self.assertEqual(result["status"], "transcribed")
        self.assertEqual(len(self.requests), 3)
        self.assertEqual([(row["start"], row["end"]) for row in result["segments"]], [(0, 30), (30, 60), (60, 65)])
        for request, chunk in zip(self.requests, result["chunks"]):
            body = request["body"]
            self.assertEqual(request["authorization"], "Bearer fixture-key")
            self.assertEqual(set(body), {"model", "language", "input_audio", "response_format"})
            self.assertEqual(body["model"], "openai/gpt-4o-mini-transcribe")
            self.assertEqual(body["language"], "nl")
            self.assertEqual(body["response_format"], "json")
            self.assertEqual(body["input_audio"]["format"], "wav")
            audio = base64.b64decode(body["input_audio"]["data"], validate=True)
            self.assertEqual(audio, Path(chunk["path"]).read_bytes())
            with wave.open(io.BytesIO(audio), "rb") as wav:
                self.assertEqual((wav.getnchannels(), wav.getframerate(), wav.getsampwidth()), (1, 16000, 2))
        self.assertEqual(result["transcript"], "\n".join(["Nederlands: café."] * 3))
        self.assertNotIn("fixture-key", json.dumps(result))
        self.assertNotIn("fixture-key", self.output.getvalue())

    def test_auto_language_omitted_and_empty_speech_is_a_valid_completed_chunk(self):
        job = self.recording((1,))
        self.responses = [(200, {"text": ""})]
        result = worker.transcribe({"id": job["id"], "key": "fixture-key"})
        self.assertNotIn("language", self.requests[0]["body"])
        self.assertEqual(self.requests[0]["body"]["model"], worker.AUDIO_DEFAULT_MODEL)
        self.assertEqual(result["status"], "transcribed")
        self.assertTrue(result["chunks"][0]["done"])
        self.assertEqual(result["transcript"], "")

    def test_rate_limit_then_explicit_retry_retains_completed_chunks(self):
        job = self.recording((30, 2))
        self.responses = [(200, {"text": "First saved chunk."}), (429, {"error": "fixture-key upstream detail"})]
        with self.assertRaisesRegex(RuntimeError, "bb.error.audioQuota"):
            worker.transcribe({"id": job["id"], "key": "fixture-key"})
        interrupted = worker.read_job(job["id"])
        self.assertEqual([row["done"] for row in interrupted["chunks"]], [True, False])
        self.assertEqual(interrupted["transcript"], "First saved chunk.")
        self.assertNotIn("fixture-key", json.dumps(interrupted))
        time.sleep(0.15)
        self.assertEqual(len(self.requests), 2, "Provider failure must not automatically repeat a billed POST")
        worker.recover()
        result = worker.transcribe({"id": job["id"], "key": "replacement-fixture"})
        self.assertEqual(len(self.requests), 3)
        self.assertEqual(result["status"], "transcribed")
        self.assertEqual(result["transcript"], "First saved chunk.\nNederlands: café.")

    def test_errors_are_actionable_and_never_include_upstream_bodies(self):
        job = self.recording((1,))
        cases = [(401, "audioKeyRejected"), (403, "audioKeyRejected"), (402, "audioCredits"),
                 (429, "audioQuota"), (400, "audioModelRejected"), (404, "audioModelRejected"),
                 (422, "audioModelRejected"), (503, "audioProviderError"), (504, "audioUncertain")]
        for status, error in cases:
            with self.subTest(status=status):
                self.responses = [(status, {"error": {"message": "secret-fixture-key PRIVATE_AUDIO"}})]
                with self.assertRaisesRegex(RuntimeError, "^bb.error." + error + "$"):
                    worker.openrouter_request(job["chunks"][0], {"key": "secret-fixture-key", "audioModel": worker.AUDIO_DEFAULT_MODEL}, worker.OPENROUTER_STT_URL)

    def test_missing_key_and_retired_cloud_do_not_submit_requests(self):
        job = self.recording((1,))
        with self.assertRaisesRegex(ValueError, "audioKey"):
            worker.transcribe({"id": job["id"], "key": " "})
        with self.assertRaisesRegex(ValueError, "audioRetired"):
            worker.transcribe_chunk(job["chunks"][0], "groq", {})
        self.assertEqual(self.requests, [])
        self.assertFalse(worker.read_job(job["id"])["chunks"][0]["done"])

    def test_malformed_output_and_uncertain_delivery_leave_chunk_uncommitted(self):
        for status, body, error in [(200, {"text": ["invalid"]}, "audioResponse"), (200, b"invalid-json", "audioResponse"), (0, {}, "audioUncertain")]:
            with self.subTest(error=error):
                job = self.recording((1,))
                self.responses = [(status, body)]
                before = len(self.requests)
                with self.assertRaisesRegex(RuntimeError, error):
                    worker.transcribe({"id": job["id"], "key": "fixture-key"})
                self.assertEqual(len(self.requests), before + 1)
                self.assertFalse(worker.read_job(job["id"])["chunks"][0]["done"])

    def test_cancel_terminates_owned_request_promptly_without_committing_result(self):
        job = self.recording((1,))
        self.delay = True
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(worker.transcribe, {"id": job["id"], "key": "fixture-key"})
            self.assertTrue(self.received.wait(5), "Owned request did not reach the local fixture")
            started = time.monotonic()
            worker.dispatch("transcribe.cancel", {"id": job["id"]})
            result = future.result(timeout=2)
            self.assertLess(time.monotonic() - started, 2)
            self.assertEqual(result["status"], "cancelled")
            self.assertFalse(result["chunks"][0]["done"])
            self.assertEqual(result["transcript"], "")
            self.assertEqual(len(self.requests), 1)
            self.release.set()

    def test_model_change_rebuilds_transcript_but_keeps_audio_and_same_model_resumes(self):
        job = self.recording((1,))
        source = Path(job["chunks"][0]["path"])
        digest = hashlib.sha256(source.read_bytes()).hexdigest()
        worker.transcribe({"id": job["id"], "key": "fixture-key"})
        same = worker.dispatch("job.update", {"id": job["id"], "values": {"engine": "openrouter", "audioModel": worker.AUDIO_DEFAULT_MODEL, "audioLanguage": ""}})
        self.assertTrue(same["chunks"][0]["done"])
        changed = worker.dispatch("job.update", {"id": job["id"], "values": {"audioModel": "openai/gpt-4o-mini-transcribe"}})
        self.assertFalse(changed["chunks"][0]["done"])
        self.assertEqual(changed["transcript"], "")
        self.assertEqual((worker.job_dir(job["id"]) / "transcript.txt").read_text(), "")
        self.assertEqual(hashlib.sha256(source.read_bytes()).hexdigest(), digest)
        worker.update_job(job["id"], status="transcribing")
        with self.assertRaisesRegex(ValueError, "activeJob"):
            worker.dispatch("job.update", {"id": job["id"], "values": {"audioLanguage": "nl"}})

    def test_restart_keeps_snapshot_and_requires_explicit_resume(self):
        job = self.recording((1,), audioModel="openai/gpt-4o-mini-transcribe", audioLanguage="nl")
        worker.update_job(job["id"], status="transcribing")
        worker.recover()
        recovered = worker.read_job(job["id"])
        self.assertEqual(recovered["status"], "interrupted")
        self.assertEqual(recovered["audioModel"], "openai/gpt-4o-mini-transcribe")
        self.assertEqual(recovered["audioLanguage"], "nl")
        self.assertEqual(self.requests, [])
        result = worker.transcribe({"id": job["id"], "key": "fixture-key"})
        self.assertEqual(result["status"], "transcribed")
        self.assertEqual(len(self.requests), 1)


if __name__ == "__main__":
    unittest.main()
