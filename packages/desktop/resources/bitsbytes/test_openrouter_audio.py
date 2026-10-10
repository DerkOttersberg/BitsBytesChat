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
import sys
import threading
import time
import unittest
from unittest.mock import patch
import wave

spec = importlib.util.spec_from_file_location("audio_worker", Path(__file__).with_name("worker.py"))
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class OpenRouterAudio(unittest.TestCase):
    def test_health_activates_libraries_created_after_worker_start(self):
        with tempfile.TemporaryDirectory() as root, patch.object(worker, "ROOT", Path(root)):
            folder = Path(root) / "runtime" / "worker" / "Lib" / "site-packages"
            folder.mkdir(parents=True, exist_ok=True)
            (folder / "bb_late_component.py").write_text("ready = True\n", encoding="utf-8")
            self.assertNotIn(str(folder), sys.path)
            try:
                self.assertTrue(worker.dispatch("health", {})["audioReady"])
                self.assertTrue(worker.importlib.import_module("bb_late_component").ready)
            finally:
                if str(folder) in sys.path:
                    sys.path.remove(str(folder))
                sys.modules.pop("bb_late_component", None)

    def test_capture_resamples_stereo_hardware_rate_to_durable_mono(self):
        import array
        import math
        pcm = worker.CapturePCM(48000, 2)
        samples = array.array("h", [sample for i in range(48000)
                                   for sample in [int(9000 * math.sin(2 * math.pi * 440 * i / 48000))] * 2]).tobytes()
        converted = b"".join(pcm.convert(samples[i:i+19200]) for i in range(0, len(samples), 19200)) + pcm.convert(None)
        self.assertEqual(len(converted), worker.RATE * 2)
        self.assertGreater(max(array.array("h", converted)), 8000)
        native = worker.CapturePCM(16000, 1)
        source = bytes(3200)
        self.assertEqual(native.convert(source) + native.convert(None), source)

    def test_capture_format_falls_back_when_device_rejects_16khz(self):
        class Device:
            PortAudioError = RuntimeError
            @staticmethod
            def query_devices(_device, _kind):
                return {"default_samplerate": 48000, "max_input_channels": 2}
            @staticmethod
            def check_input_settings(**options):
                if options["samplerate"] != 48000 or options["channels"] != 2:
                    raise RuntimeError("Unsupported fixture rate")
        self.assertEqual(worker.capture_format(Device, None), (48000, 2))

    def test_unavailable_microphone_has_an_actionable_error(self):
        class Device:
            PortAudioError = RuntimeError
            @staticmethod
            def query_devices(_device, _kind):
                raise RuntimeError("Device unavailable")
        with self.assertRaisesRegex(ValueError, "audioMicrophone"):
            worker.capture_format(Device, None)

    def test_capture_start_failure_closes_the_stream_with_an_actionable_error(self):
        from unittest.mock import patch
        import sounddevice
        job = worker.create_job({"engine": "openrouter", "audioDiarization": False})
        with patch.object(worker, "capture_format", return_value=(16000, 1)), \
                patch.object(sounddevice, "RawInputStream", side_effect=sounddevice.PortAudioError("Unavailable")):
            with self.assertRaisesRegex(ValueError, "audioMicrophone"):
                worker.Recorder(job["id"], None)

    def test_string_and_numeric_speaker_ids_are_supported(self):
        for value in [0, "0", "speaker_0"]:
            result = worker.speaker_segments({"text": "Hello.", "words": [{"word": "Hello.", "start": 0, "end": 1, "speaker": value}]}, {"start": 0, "duration": 2})
            self.assertEqual(result[0]["speaker"], "speaker_0")

    def test_empty_finished_audio_is_actionable_without_provider_request(self):
        job = worker.create_job({"engine": "openrouter", "audioDiarization": False})
        with self.assertRaisesRegex(ValueError, "bb.error.audioEmpty"):
            worker.transcribe({"id": job["id"], "key": "fixture-key"})
        self.assertEqual(self.requests, [])
        self.assertEqual(worker.read_job(job["id"])["status"], "error")

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
        job = worker.create_job({"engine": "openrouter", "audioDiarization": False, **preferences})
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

    def diarized_response(self):
        return {"text": "Hallo. Hoi! Nog een vraag.", "words": [
            {"word": "Hallo.", "start": 0, "end": 1, "speaker": 0},
            {"word": "Hoi!", "start": 31, "end": 32, "speaker": 1},
            {"word": "Nog", "start": 61, "end": 62, "speaker": 0},
            {"word": "een", "start": 62, "end": 63, "speaker": 0},
            {"word": "vraag.", "start": 63, "end": 64, "speaker": 0},
        ]}

    def test_speakers_are_requested_once_for_the_entire_recording_and_survive_restart(self):
        import av
        job = self.recording((30, 30, 5), audioModel="elevenlabs/scribe-v2", audioLanguage="nl",
                             audioDiarization=True, speakerLabel="Speaker {{number}}")
        self.responses = [(200, self.diarized_response())]
        result = worker.transcribe({"id": job["id"], "key": "fixture-key", "audioDiarization": False})
        self.assertEqual(len(self.requests), 1)
        payload = self.requests[0]["body"]
        self.assertEqual(payload["model"], "elevenlabs/scribe-v2")
        self.assertEqual(payload["language"], "nl")
        self.assertEqual(payload["provider"]["options"]["elevenlabs"], {"diarize": True})
        self.assertEqual(payload["response_format"], "verbose_json")
        self.assertEqual(payload["timestamp_granularities"], ["word"])
        self.assertEqual(payload["input_audio"]["format"], "mp3")
        with av.open(io.BytesIO(base64.b64decode(payload["input_audio"]["data"]))) as container:
            self.assertAlmostEqual(sum(frame.samples / frame.sample_rate for frame in container.decode(audio=0)), 65, delta=0.2)
        self.assertEqual(result["transcript"], "Speaker 1: Hallo.\nSpeaker 2: Hoi!\nSpeaker 1: Nog een vraag.")
        self.assertEqual([turn["speaker"] for turn in result["segments"]], ["speaker_0", "speaker_1", "speaker_0"])
        self.assertEqual(result["segments"][-1]["start"], 61)
        self.assertTrue(all(chunk["done"] for chunk in result["chunks"]))
        self.assertEqual((worker.job_dir(job["id"]) / "transcript.txt").read_text(), result["transcript"])
        worker.recover()
        restored = worker.transcribe({"id": job["id"], "key": "fixture-key"})
        self.assertEqual(restored["transcript"], result["transcript"])
        self.assertEqual(len(self.requests), 1, "A completed diarization must not be submitted twice")

    def test_diarization_waits_until_finish_and_cancel_does_not_upload(self):
        job = self.recording((1,), audioModel="elevenlabs/scribe-v2", audioDiarization=True)
        worker.update_job(job["id"], recording=True, status="recording")
        with concurrent.futures.ThreadPoolExecutor() as pool:
            future = pool.submit(worker.transcribe, {"id": job["id"], "key": "fixture-key"})
            time.sleep(0.25)
            self.assertFalse(future.done())
            self.assertEqual(self.requests, [])
            worker.dispatch("transcribe.cancel", {"id": job["id"]})
            result = future.result(timeout=2)
        self.assertEqual(result["status"], "cancelled")
        self.assertEqual(self.requests, [])

    def test_cancel_diarization_terminates_the_owned_process_without_committing_labels(self):
        self.delay = True
        self.responses = [(200, {"text": "Hoi", "words": [{"word": "Hoi", "start": 0, "end": 1, "speaker": 0}]})]
        job = self.recording((1,), audioModel="elevenlabs/scribe-v2", audioDiarization=True)
        with concurrent.futures.ThreadPoolExecutor() as pool:
            future = pool.submit(worker.transcribe, {"id": job["id"], "key": "fixture-key"})
            self.assertTrue(self.received.wait(15), "Owned codec/request startup did not reach the fixture")
            worker.dispatch("transcribe.cancel", {"id": job["id"]})
            result = future.result(timeout=2)
            self.release.set()
        self.assertEqual(result["status"], "cancelled")
        self.assertFalse(result.get("diarizationComplete"))
        self.assertEqual(result["transcript"], "")
        self.assertFalse(result["chunks"][0]["done"])

    def test_missing_speaker_labels_is_actionable_without_silent_fallback_or_retry(self):
        job = self.recording((1,), audioModel="elevenlabs/scribe-v2", audioDiarization=True)
        with self.assertRaisesRegex(RuntimeError, "audioDiarizationResponse"):
            worker.transcribe({"id": job["id"], "key": "fixture-key"})
        saved = worker.read_job(job["id"])
        self.assertEqual(saved["status"], "error")
        self.assertFalse(saved["chunks"][0]["done"])
        self.assertEqual(len(self.requests), 1)
        self.assertTrue(Path(saved["chunks"][0]["path"]).exists())

    def test_speaker_names_update_plain_transcript_but_never_send_another_request(self):
        job = self.recording((30, 30, 5), audioModel="elevenlabs/scribe-v2", audioDiarization=True,
                             speakerLabel="Speaker {{number}}")
        self.responses = [(200, self.diarized_response())]
        worker.transcribe({"id": job["id"], "key": "fixture-key"})
        saved = worker.dispatch("job.speakers", {"id": job["id"], "names": {"speaker_0": "Derk", "speaker_1": "Tom"}})
        self.assertEqual(saved["transcript"], "Derk: Hallo.\nTom: Hoi!\nDerk: Nog een vraag.")
        self.assertEqual(len(self.requests), 1)
        for names in ({"speaker_3": "Unknown"}, {"speaker_0": "Injected\nline"}, {"speaker_0": "x" * 81}):
            with self.assertRaisesRegex(ValueError, "audioSpeakerName"):
                worker.dispatch("job.speakers", {"id": job["id"], "names": names})
        self.assertEqual(worker.read_job(job["id"])["transcript"], saved["transcript"])
        worker.recover()
        self.assertEqual(worker.read_job(job["id"])["speakerNames"], {"speaker_0": "Derk", "speaker_1": "Tom"})

    def test_turning_diarization_off_rebuilds_plain_text_from_the_retained_audio(self):
        job = self.recording((1,), audioModel="elevenlabs/scribe-v2", audioDiarization=True)
        self.responses = [(200, {"text": "Hoi", "words": [{"word": "Hoi", "start": 0, "end": 1, "speaker": 0}]})]
        worker.transcribe({"id": job["id"], "key": "fixture-key"})
        changed = worker.dispatch("job.update", {"id": job["id"], "values": {"audioDiarization": False}})
        self.assertFalse(changed.get("diarizationComplete"))
        self.assertEqual(changed["segments"], [])
        plain = worker.transcribe({"id": job["id"], "key": "fixture-key"})
        self.assertEqual(plain["transcript"], "Nederlands: café.")
        self.assertEqual(self.requests[-1]["body"]["response_format"], "json")
        self.assertNotIn("provider", self.requests[-1]["body"])


if __name__ == "__main__":
    unittest.main()
