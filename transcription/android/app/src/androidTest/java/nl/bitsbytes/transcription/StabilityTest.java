package nl.bitsbytes.transcription;

import android.content.Context;
import android.content.Intent;
import android.media.MediaExtractor;
import android.media.MediaFormat;
import android.os.SystemClock;
import androidx.test.core.app.ApplicationProvider;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.uiautomator.By;
import androidx.test.uiautomator.UiDevice;
import androidx.test.uiautomator.Until;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.io.File;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

@RunWith(AndroidJUnit4.class)
public class StabilityTest {
    @org.junit.Rule public androidx.test.rule.GrantPermissionRule microphone = androidx.test.rule.GrantPermissionRule.grant("android.permission.RECORD_AUDIO");
    private Context context() { return ApplicationProvider.getApplicationContext(); }
    private void tap(UiDevice device, String label) {
        for (int attempt = 0; attempt < 3; attempt++) {
            androidx.test.uiautomator.UiObject2 control = device.wait(Until.findObject(By.pkg(context().getPackageName()).text(label)), 5000);
            assertNotNull(label, control);
            try { control.click(); return; }
            catch (androidx.test.uiautomator.StaleObjectException transition) { SystemClock.sleep(100); }
        }
        org.junit.Assert.fail("Control kept changing: " + label);
    }
    private Store isolated() throws Exception { return new Store(new File(context().getCacheDir(), "test-" + UUID.randomUUID())); }
    private String recording(Store store, int seconds) throws Exception {
        String id = store.create(Settings.defaults(), "recording").getString("id");
        byte[] pcm = new byte[32000];
        for (int sample = 0; sample < 16000; sample++) { short value = (short) (Math.sin(sample * Math.PI * 2 * 440 / 16000) * 10000); pcm[sample * 2] = (byte) value; pcm[sample * 2 + 1] = (byte) (value >>> 8); }
        for (int second = 0; second < seconds; second++) store.append(id, second, pcm);
        return id;
    }
    @Test public void audioSurvivesWithoutManifestUpdates() throws Exception {
        Store store = isolated(); String id = recording(store, 3);
        Store reopened = new Store(store.root); JSONObject recovered = reopened.get(id);
        assertEquals(3, recovered.getInt("chunks")); assertEquals(3, recovered.getDouble("duration"), .001);
        assertEquals("interrupted", recovered.getString("status"));
        assertEquals(96044, AudioFiles.wav(reopened, id).length());
    }
    @Test public void corruptManifestsRecoverCommittedPartsAndCost() throws Exception {
        Store store = isolated(); String id = recording(store, 1);
        store.savePart(id, 0, Store.object("text", "Saved words", "costUSD", .01));
        store.savePart(id, 1, Store.object("text", "More words", "costUSD", .02));
        Store.write(new File(store.directory(id), "recording.json"), new byte[]{1});
        Store.write(new File(store.directory(id), "recording.backup.json"), new byte[]{2});
        Store reopened = new Store(store.root); JSONObject row = reopened.get(id);
        assertEquals("Saved words\n\nMore words", row.getString("transcript")); assertEquals(2, row.getInt("completedParts"));
        assertEquals(.03, row.getDouble("costUSD"), .00001);
        Store again = new Store(store.root); assertEquals(.03, again.get(id).getDouble("costUSD"), .00001);
    }
    @Test public void missingCostIsNotReportedAsFree() throws Exception {
        Store store = isolated(); String id = recording(store, 1);
        store.savePart(id, 0, Store.object("text", "First", "costUSD", .02));
        store.savePart(id, 1, Store.object("text", "Second"));
        assertFalse(new Store(store.root).get(id).getBoolean("costComplete"));
    }
    @Test public void speakerLabelsAreStableAndStructured() throws Exception {
        JSONObject response = Store.object("text", "hello there again", "words", new JSONArray()
            .put(Store.object("word", "Hello", "speaker", 7, "start", 0))
            .put(Store.object("word", ",", "speaker", 7, "start", .1))
            .put(Store.object("word", "there", "speaker", 2, "start", 1))
            .put(Store.object("word", "again", "speaker", 7, "start", 2)), "usage", Store.object("cost", "0.04"));
        JSONObject part = Transcriber.parse(response, true); JSONArray turns = part.getJSONArray("turns");
        assertEquals(3, turns.length()); assertEquals("Hello,", turns.getJSONObject(0).getString("text"));
        assertEquals(1, turns.getJSONObject(2).getInt("speaker")); assertEquals(.04, part.getDouble("costUSD"), .00001);
        JSONObject preferences = Settings.defaults(); preferences.put("speakers", true);
        assertTrue(Transcriber.options(preferences).getJSONObject("provider").getJSONObject("options").getJSONObject("elevenlabs").getBoolean("diarize"));
    }
    @Test public void encryptedSettingsRoundTrip() throws Exception {
        Settings settings = new Settings(context()); settings.save("elevenlabs/scribe-v2", "nl", false, "test-secret-local-only");
        assertEquals("test-secret-local-only", new Settings(context()).apiKey());
        String json = Store.read(new File(context().getFilesDir(), "settings.json")).toString();
        assertFalse(json.contains("test-secret-local-only"));
    }
    @Test public void uploadJsonStreamsExactBase64AndSpeakerOptions() throws Exception {
        File file = new File(context().getCacheDir(), "payload-test.m4a"); byte[] bytes = new byte[]{0, 1, 2, -1, 42}; Store.write(file, bytes);
        JSONObject preferences = Settings.defaults(); preferences.put("speakers", true); preferences.put("language", "nl");
        java.io.ByteArrayOutputStream output = new java.io.ByteArrayOutputStream(); Transcriber.writeRequest(preferences, file, output);
        JSONObject request = new JSONObject(new String(output.toByteArray(), java.nio.charset.StandardCharsets.UTF_8));
        assertEquals("m4a", request.getJSONObject("input_audio").getString("format"));
        org.junit.Assert.assertArrayEquals(bytes, android.util.Base64.decode(request.getJSONObject("input_audio").getString("data"), android.util.Base64.DEFAULT));
        assertEquals("verbose_json", request.getString("response_format")); assertEquals("nl", request.getString("language"));
        assertTrue(request.getJSONObject("provider").getJSONObject("options").getJSONObject("elevenlabs").getBoolean("diarize"));
    }
    @Test public void failureRetainsPartsAndCancellationDoesNotUpload() throws Exception {
        BitsApp app = (BitsApp) context(); Store previous = app.store; Transcriber.Transport transport = app.transport;
        try {
            app.store = isolated(); String id = recording(app.store, 1); app.cancel = true; AtomicInteger calls = new AtomicInteger();
            app.transport = (preferences, audio, key) -> { calls.incrementAndGet(); throw new AppFailure("network_error"); };
            try { Transcriber.run(app, id); org.junit.Assert.fail("Cancellation must stop work"); } catch (AppFailure expected) { assertEquals("network_error", expected.code); }
            assertEquals(0, calls.get()); assertEquals(1, new Store(app.store.root).get(id).getInt("chunks"));
        } finally { app.cancel = false; app.store = previous; app.transport = transport; }
    }
    @Test public void receivedResponseSurvivesCrashBeforeTranscriptProjection() throws Exception {
        BitsApp app = (BitsApp) context(); Store previous = app.store; Transcriber.Transport transport = app.transport;
        try {
            app.cancel = false; app.store = isolated(); String id = recording(app.store, 1); AudioFiles.prepare(app, id);
            Store.write(new File(app.store.directory(id), "response-000000.json"), Store.object("text", "Paid response", "usage", Store.object("cost", .07)));
            app.store = new Store(app.store.root); AtomicInteger calls = new AtomicInteger();
            app.transport = (preferences, audio, key) -> { calls.incrementAndGet(); throw new AppFailure("network_error"); };
            Transcriber.run(app, id); assertEquals(0, calls.get()); assertEquals("Paid response", app.store.get(id).getString("transcript"));
            assertEquals(.07, new Store(app.store.root).get(id).getDouble("costUSD"), .00001);
        } finally { app.store = previous; app.transport = transport; }
    }
    @Test public void nativeCodecChunksLongAudioAndResumeSkipsSavedRequests() throws Exception {
        BitsApp app = (BitsApp) context(); Store previous = app.store; Transcriber.Transport transport = app.transport;
        try {
            app.settings.save("elevenlabs/scribe-v2", "", false, "test-secret-local-only");
            app.cancel = false; app.store = isolated(); String id = recording(app.store, 301);
            JSONObject prepared = AudioFiles.prepare(app, id); assertEquals(2, prepared.getJSONArray("parts").length());
            File compressed = new File(app.store.directory(id), "audio.m4a"); assertTrue(compressed.length() > 1000);
            MediaExtractor extractor = new MediaExtractor(); extractor.setDataSource(compressed.getAbsolutePath());
            assertEquals(MediaFormat.MIMETYPE_AUDIO_AAC, extractor.getTrackFormat(0).getString(MediaFormat.KEY_MIME)); extractor.release();
            app.store.savePart(id, 0, Store.object("text", "Already paid", "costUSD", .01));
            AtomicInteger calls = new AtomicInteger();
            app.transport = (preferences, file, key) -> { calls.incrementAndGet(); return Store.object("text", "New part", "usage", Store.object("cost", .02)); };
            Transcriber.run(app, id); assertEquals(1, calls.get()); assertEquals("complete", app.store.get(id).getString("status"));
            Transcriber.run(app, id); assertEquals(1, calls.get());
            assertEquals("Already paid\n\nNew part", app.store.get(id).getString("transcript"));
            assertEquals(.03, new Store(app.store.root).get(id).getDouble("costUSD"), .00001);
            String imported = app.store.create(Settings.defaults(), "importing").getString("id");
            File original = new File(app.store.directory(imported), "original.m4a");
            java.nio.file.Files.copy(compressed.toPath(), original.toPath()); app.store.update(imported, "source", "original.m4a");
            AudioFiles.decode(app, imported); assertEquals(301, app.store.get(imported).getDouble("duration"), .3);
        } finally { app.store = previous; app.transport = transport; }
    }
    @Test public void phoneRequiresStartAndRecordsAcrossLockThenAutoTranscribes() throws Exception {
        BitsApp app = (BitsApp) context();
        if (android.os.Build.VERSION.SDK_INT >= 33) InstrumentationRegistry.getInstrumentation().getUiAutomation().grantRuntimePermission(context().getPackageName(), "android.permission.POST_NOTIFICATIONS");
        app.settings.save("elevenlabs/scribe-v2", "", false, "test-secret-local-only");
        Transcriber.Transport previous = app.transport; AtomicInteger calls = new AtomicInteger();
        app.transport = (preferences, file, key) -> { calls.incrementAndGet(); return Store.object("text", "Automatic transcript", "usage", Store.object("cost", .001)); };
        UiDevice device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation());
        androidx.test.uiautomator.Configurator.getInstance().setWaitForIdleTimeout(100);
        try {
            context().startActivity(new Intent(context(), MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK));
            tap(device, "Record");
            assertTrue(device.wait(Until.hasObject(By.text("Start recording")), 5000));
            SystemClock.sleep(700); assertFalse(app.busy()); assertNotNull(device.findObject(By.text("00:00")));
            tap(device, "Start recording");
            long deadline = SystemClock.elapsedRealtime() + 10000; while (app.activeId == null && SystemClock.elapsedRealtime() < deadline) SystemClock.sleep(50);
            assertNotNull(app.activeId); String id = app.activeId;
            device.pressHome(); device.sleep(); SystemClock.sleep(2300); device.wakeUp(); device.pressMenu();
            context().startActivity(new Intent(context(), MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            tap(device, "Finish recording");
            deadline = SystemClock.elapsedRealtime() + 15000; while (app.busy() && SystemClock.elapsedRealtime() < deadline) SystemClock.sleep(50);
            assertFalse(app.busy()); assertTrue(app.store.get(id).getDouble("duration") >= 2); assertEquals(1, calls.get());
            assertEquals("Automatic transcript", app.store.get(id).getString("transcript")); assertEquals("complete", app.store.get(id).getString("status"));
            assertTrue(new File(app.store.directory(id), "recording.wav").isFile());
            tap(device, "Copy transcript");
            java.util.concurrent.atomic.AtomicReference<String> copied = new java.util.concurrent.atomic.AtomicReference<>();
            InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> copied.set(context().getSystemService(android.content.ClipboardManager.class).getPrimaryClip().getItemAt(0).getText().toString()));
            assertEquals("Automatic transcript", copied.get());
            tap(device, "Listen"); assertTrue(device.wait(Until.hasObject(By.text("Pause")), 3000));
            tap(device, "Pause");
        } finally { app.transport = previous; device.wakeUp(); }
    }
}
