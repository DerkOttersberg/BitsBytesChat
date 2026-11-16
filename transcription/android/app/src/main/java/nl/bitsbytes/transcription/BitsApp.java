package nl.bitsbytes.transcription;

import android.app.Application;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class BitsApp extends Application {
    Store store;
    Settings settings;
    final ExecutorService worker = Executors.newSingleThreadExecutor();
    volatile String activeId;
    volatile String busyId;
    volatile float level;
    volatile boolean cancel;
    volatile boolean stopRecording;
    volatile String fatal;
    Transcriber.Transport transport = new Transcriber.HttpsTransport();
    @Override public void onCreate() {
        super.onCreate();
        try { store = new Store(this); settings = new Settings(this); }
        catch (Exception error) { fatal = "storage_error"; }
    }
    boolean busy() { return activeId != null || busyId != null; }
    static String errorCode(Exception error) { return error instanceof AppFailure ? ((AppFailure) error).code : error instanceof SecurityException ? "permission_denied" : "storage_error"; }
}
