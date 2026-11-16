package nl.bitsbytes.transcription;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.net.Uri;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import org.json.JSONObject;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.util.Arrays;

public final class AudioService extends Service {
    private BitsApp app;
    private PowerManager.WakeLock wake;
    private final Object recordingGate = new Object();
    @Override public void onCreate() {
        super.onCreate(); app = (BitsApp) getApplication();
        NotificationManager notifications = getSystemService(NotificationManager.class);
        notifications.createNotificationChannel(new NotificationChannel("audio", getString(R.string.recording_channel), NotificationManager.IMPORTANCE_LOW));
    }
    @Override public IBinder onBind(Intent intent) { return null; }
    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null || app.store == null) { stopSelf(); return START_NOT_STICKY; }
        String action = intent.getAction();
        if ("pause".equals(action) || "resumeRecording".equals(action)) { if (app.activeId != null) { app.pauseRequested = "pause".equals(action); synchronized (recordingGate) { recordingGate.notifyAll(); } } return START_NOT_STICKY; }
        if ("finish".equals(action)) { app.stopRecording = true; synchronized (recordingGate) { recordingGate.notifyAll(); } if (!app.busy()) stopSelf(); return START_NOT_STICKY; }
        if ("cancel".equals(action)) { app.cancel = true; app.transport.cancel(); if (!app.busy()) stopSelf(); return START_NOT_STICKY; }
        if (app.busy()) return START_NOT_STICKY;
        boolean record = "record".equals(action);
        try {
            foreground(record);
            app.cancel = false; app.stopRecording = false; app.level = 0; app.paused = false; app.pauseRequested = false;
            JSONObject row;
            if (record) {
                if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) throw new AppFailure("permission_denied");
                JSONObject preferences = app.settings.preferences();
                Store.set(preferences, "speakers", intent.getBooleanExtra("speakers", preferences.optBoolean("speakers")));
                if (preferences.optBoolean("speakers") && !Settings.supportsSpeakers(preferences.optString("model"))) throw new AppFailure("speaker_model");
                String resume = intent.getStringExtra("resumeId");
                if (resume != null) {
                    row = app.store.get(resume);
                    if (!row.optString("status").equals("interrupted") || row.has("source") || row.optInt("completedParts") != 0 || new File(app.store.directory(resume), "prepared.json").exists()) throw new AppFailure("busy_error");
                    app.store.update(resume, "status", "recording", "error", "");
                } else row = app.store.create(preferences, "recording");
                app.activeId = row.getString("id");
            } else if ("import".equals(action)) {
                row = app.store.create(app.settings.preferences(), "importing"); app.busyId = row.getString("id");
            } else {
                row = app.store.get(intent.getStringExtra("id")); app.busyId = row.getString("id");
            }
            String id = row.getString("id");
            wake = getSystemService(PowerManager.class).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, getPackageName() + ":audio");
            wake.setReferenceCounted(false);
            wake.acquire(6 * 60 * 60 * 1000L);
            app.worker.execute(() -> work(intent, id, record));
        } catch (Exception error) { app.fatal = BitsApp.errorCode(error); finishService(); }
        return START_NOT_STICKY;
    }
    private void work(Intent intent, String id, boolean record) {
        try {
            if (record) {
                capture(id); app.activeId = null; app.busyId = id;
                foreground(false); AudioFiles.wav(app.store, id);
            }
            if ("import".equals(intent.getAction())) importAudio(intent.getData(), id);
            if (!app.cancel) Transcriber.run(app, id);
            else throw new AppFailure("network_error");
        } catch (Exception error) {
            try { app.store.update(id, "status", "error", "error", BitsApp.errorCode(error), "progress", JSONObject.NULL); }
            catch (Exception ignored) { app.fatal = "storage_error"; }
        } finally { finishService(); }
    }
    private void capture(String id) throws Exception {
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) throw new AppFailure("permission_denied");
        int minimum = AudioRecord.getMinBufferSize(16000, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
        if (minimum <= 0) throw new AppFailure("microphone_error");
        AudioRecord audio = new AudioRecord(MediaRecorder.AudioSource.MIC, 16000, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, Math.max(minimum * 2, 32000));
        byte[] chunk = new byte[32000]; byte[] input = new byte[3200]; int used = 0; int sequence = app.store.get(id).optInt("chunks");
        try {
            if (audio.getState() != AudioRecord.STATE_INITIALIZED) throw new AppFailure("microphone_error");
            audio.startRecording(); if (audio.getRecordingState() != AudioRecord.RECORDSTATE_RECORDING) throw new AppFailure("microphone_error");
            while (!app.stopRecording && !app.cancel) {
                if (app.pauseRequested) {
                    if (used > 0) { app.store.append(id, sequence++, Arrays.copyOf(chunk, used)); used = 0; }
                    audio.stop(); app.store.update(id, "status", "paused"); app.paused = true; app.level = 0; foreground(true);
                    if (wake != null && wake.isHeld()) wake.release();
                    synchronized (recordingGate) { while (app.pauseRequested && !app.stopRecording && !app.cancel) recordingGate.wait(); }
                    if (app.stopRecording || app.cancel) break;
                    if (wake != null) wake.acquire(6 * 60 * 60 * 1000L);
                    audio.startRecording(); app.store.update(id, "status", "recording"); app.paused = false; foreground(true);
                }
                int count = audio.read(input, 0, input.length, AudioRecord.READ_BLOCKING);
                if (count <= 0 || count % 2 != 0) throw new AppFailure("microphone_error");
                if (Build.VERSION.SDK_INT >= 29) {
                    android.media.AudioRecordingConfiguration configuration = audio.getActiveRecordingConfiguration();
                    if (configuration != null && configuration.isClientSilenced()) throw new AppFailure("microphone_error");
                }
                double energy = 0;
                for (int index = 0; index < count; index += 2) { short value = (short) ((input[index] & 255) | (input[index + 1] << 8)); energy += (double) value * value; }
                app.level = (float) Math.min(1, Math.sqrt(energy / (count / 2.0)) / 10000.0);
                int offset = 0;
                while (offset < count) {
                    int length = Math.min(count - offset, chunk.length - used); System.arraycopy(input, offset, chunk, used, length); used += length; offset += length;
                    if (used == chunk.length) { app.store.append(id, sequence++, chunk); used = 0; }
                }
            }
        } finally {
            try { audio.stop(); } catch (Exception ignored) { } audio.release(); app.level = 0;
            if (used > 0) app.store.append(id, sequence, Arrays.copyOf(chunk, used));
        }
    }
    private void importAudio(Uri uri, String id) throws Exception {
        if (uri == null || !"content".equals(uri.getScheme())) throw new AppFailure("audio_error");
        File temporary = new File(app.store.directory(id), "original.copying");
        try (InputStream input = getContentResolver().openInputStream(uri); FileOutputStream output = new FileOutputStream(temporary)) {
            if (input == null) throw new AppFailure("audio_error");
            byte[] buffer = new byte[65536]; int count;
            while ((count = input.read(buffer)) != -1) { AudioFiles.check(app); output.write(buffer, 0, count); }
            output.getFD().sync();
        }
        String type = getContentResolver().getType(uri);
        String extension = "audio/mp4".equals(type) ? "m4a" : "audio/mpeg".equals(type) ? "mp3" : android.webkit.MimeTypeMap.getSingleton().getExtensionFromMimeType(type == null ? "" : type);
        if (extension == null || !extension.matches("[a-z0-9]{1,8}")) extension = "audio";
        File original = new File(app.store.directory(id), "original." + extension);
        if (!temporary.renameTo(original)) throw new AppFailure("storage_error");
        app.store.update(id, "source", original.getName(), "error", "");
    }
    private void foreground(boolean recording) {
        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent content = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Intent stop = new Intent(this, AudioService.class).setAction(recording ? "finish" : "cancel");
        PendingIntent action = PendingIntent.getService(this, recording ? 1 : 2, stop, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification notification = new Notification.Builder(this, "audio").setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(getString(R.string.app_name)).setContentText(getString(recording ? app.paused ? R.string.paused : R.string.recording_notification : R.string.working_notification))
            .setContentIntent(content).setOngoing(true).setOnlyAlertOnce(true)
            .addAction(new Notification.Action.Builder(null, getString(recording ? R.string.finish : R.string.cancel), action).build()).build();
        if (recording) {
            PendingIntent pause = PendingIntent.getService(this, app.paused ? 4 : 3, new Intent(this, AudioService.class).setAction(app.paused ? "resumeRecording" : "pause"), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            notification = Notification.Builder.recoverBuilder(this, notification).addAction(new Notification.Action.Builder(null, getString(app.paused ? R.string.resume_recording : R.string.pause_recording), pause).build()).build();
        }
        if (Build.VERSION.SDK_INT >= 30) startForeground(1, notification, recording ? ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE : ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        else if (Build.VERSION.SDK_INT == 29) startForeground(1, notification, recording ? 0 : ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        else startForeground(1, notification);
    }
    private void finishService() {
        app.activeId = null; app.busyId = null; app.level = 0; app.paused = false; app.pauseRequested = false;
        if (wake != null && wake.isHeld()) wake.release(); wake = null;
        stopForeground(STOP_FOREGROUND_REMOVE); stopSelf();
    }
    @Override public void onTimeout(int startId, int type) { app.stopRecording = true; app.cancel = true; app.transport.cancel(); stopSelf(); }
    @Override public void onDestroy() {
        app.stopRecording = true;
        synchronized (recordingGate) { recordingGate.notifyAll(); }
        if (app.busyId != null) { app.cancel = true; app.transport.cancel(); }
        if (wake != null && wake.isHeld()) wake.release(); super.onDestroy();
    }
}
