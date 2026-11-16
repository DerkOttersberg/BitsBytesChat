package nl.bitsbytes.transcription;

import android.app.Application;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class BitsApp extends Application {
    Store store;
    Settings settings;
    LinkClient links;
    Catalog catalog;
    final ExecutorService worker = Executors.newSingleThreadExecutor();
    volatile String activeId;
    volatile String busyId;
    volatile float level;
    volatile boolean cancel;
    volatile boolean stopRecording;
    volatile boolean paused;
    volatile boolean pauseRequested;
    volatile String fatal;
    Transcriber.Transport transport = new Transcriber.HttpsTransport();
    @Override public void onCreate() {
        super.onCreate();
        try { store = new Store(this); settings = new Settings(this); }
        catch (Exception error) { fatal = "storage_error"; }
        if (settings != null) try { links = new LinkClient(this, settings); } catch (Exception error) { /* Audio remains usable if the link store needs attention. */ }
        try { catalog = new Catalog(this); catalog.refresh(); } catch (Exception error) { fatal = "storage_error"; }
    }
    boolean busy() { return activeId != null || busyId != null; }
    static String errorCode(Exception error) { return error instanceof AppFailure ? ((AppFailure) error).code : error instanceof SecurityException ? "permission_denied" : "storage_error"; }
}
