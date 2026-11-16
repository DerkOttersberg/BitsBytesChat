package nl.bitsbytes.transcription;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

public final class LinkDeliveryService extends Service {
    private PowerManager.WakeLock wake;
    @Override public IBinder onBind(Intent intent) { return null; }
    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        BitsApp app = (BitsApp) getApplication();
        getSystemService(NotificationManager.class).createNotificationChannel(new NotificationChannel("pc-link", getString(R.string.link_pc), NotificationManager.IMPORTANCE_LOW));
        PendingIntent open = PendingIntent.getActivity(this, 8, new Intent(this, MainActivity.class), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification notification = new Notification.Builder(this, "pc-link").setSmallIcon(R.drawable.ic_notification).setContentTitle(getString(R.string.sending_pc)).setContentText(getString(R.string.pc_queue_note)).setContentIntent(open).setOngoing(true).build();
        if (Build.VERSION.SDK_INT >= 29) startForeground(2, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC); else startForeground(2, notification);
        if (app.links == null) { stopSelf(); return START_NOT_STICKY; }
        if (wake == null) { wake = getSystemService(PowerManager.class).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, getPackageName() + ":pc-link"); wake.acquire(120000); }
        app.links.flushAsync().whenComplete((pending, error) -> { app.links.schedule(); stopForeground(STOP_FOREGROUND_REMOVE); stopSelf(); });
        return START_NOT_STICKY;
    }
    @Override public void onDestroy() { if (wake != null && wake.isHeld()) wake.release(); super.onDestroy(); }
    @Override public void onTimeout(int startId, int type) { stopSelf(); }
}
