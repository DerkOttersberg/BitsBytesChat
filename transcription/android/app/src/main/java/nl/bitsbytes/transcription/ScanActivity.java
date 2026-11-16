package nl.bitsbytes.transcription;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipboardManager;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.hardware.Camera;
import android.os.Bundle;
import android.view.SurfaceHolder;
import android.view.SurfaceView;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import com.google.zxing.BinaryBitmap;
import com.google.zxing.PlanarYUVLuminanceSource;
import com.google.zxing.common.HybridBinarizer;
import com.google.zxing.qrcode.QRCodeReader;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

public final class ScanActivity extends Activity implements SurfaceHolder.Callback {
    private Camera camera; private SurfaceView preview; private boolean surface;
    private final ExecutorService decoder = Executors.newSingleThreadExecutor();
    private final AtomicBoolean decoding = new AtomicBoolean(); private boolean done;
    private long lastScan;
    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved); Ink ink = new Ink(this); LinearLayout root = new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL); root.setPadding(ink.dp(20), ink.dp(40), ink.dp(20), ink.dp(28)); root.setBackgroundColor(Ink.PAPER);
        TextView title = new TextView(this); title.setText(R.string.scan_pc); title.setTypeface(ink.bold); title.setTextColor(Ink.INK); title.setTextSize(24); root.addView(title);
        preview = new SurfaceView(this); preview.getHolder().addCallback(this); root.addView(preview, new LinearLayout.LayoutParams(-1, 0, 1));
        Button paste = new Button(this); paste.setText(R.string.paste_pairing); paste.setTypeface(ink.bold); paste.setBackground(ink.button(false)); paste.setOnClickListener(view -> {
            ClipboardManager clipboard = getSystemService(ClipboardManager.class); if (clipboard.hasPrimaryClip() && clipboard.getPrimaryClip() != null) accept(clipboard.getPrimaryClip().getItemAt(0).coerceToText(this).toString());
        }); root.addView(paste, new LinearLayout.LayoutParams(-1, ink.dp(52))); setContentView(root);
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) requestPermissions(new String[]{Manifest.permission.CAMERA}, 1);
    }
    @Override protected void onResume() { super.onResume(); open(); }
    @Override protected void onPause() { close(); super.onPause(); }
    @Override protected void onDestroy() { decoder.shutdownNow(); super.onDestroy(); }
    @Override public void onRequestPermissionsResult(int code, String[] permissions, int[] results) { super.onRequestPermissionsResult(code, permissions, results); if (code == 1 && results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) open(); }
    @Override public void surfaceCreated(SurfaceHolder holder) { surface = true; open(); }
    @Override public void surfaceChanged(SurfaceHolder holder, int format, int width, int height) { }
    @Override public void surfaceDestroyed(SurfaceHolder holder) { surface = false; close(); }
    private void open() {
        if (done || camera != null || !surface || checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) return;
        try {
            camera = Camera.open(); Camera.Parameters parameters = camera.getParameters();
            Camera.Size selected = parameters.getSupportedPreviewSizes().get(0);
            for (Camera.Size size : parameters.getSupportedPreviewSizes()) if (Math.abs(size.width * size.height - 640 * 480) < Math.abs(selected.width * selected.height - 640 * 480)) selected = size;
            parameters.setPreviewSize(selected.width, selected.height); parameters.setPreviewFormat(android.graphics.ImageFormat.NV21);
            if (parameters.getSupportedFocusModes().contains(Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE)) parameters.setFocusMode(Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE);
            camera.setParameters(parameters); Camera.CameraInfo info = new Camera.CameraInfo(); Camera.getCameraInfo(0, info);
            int rotation = getWindowManager().getDefaultDisplay().getRotation() * 90;
            camera.setDisplayOrientation((info.orientation - rotation + 360) % 360); camera.setPreviewDisplay(preview.getHolder());
            int width = selected.width; int height = selected.height;
            camera.setPreviewCallbackWithBuffer((bytes, source) -> {
                long now = android.os.SystemClock.elapsedRealtime();
                if (done || decoder.isShutdown() || now - lastScan < 150 || !decoding.compareAndSet(false, true)) { try { source.addCallbackBuffer(bytes); } catch (Exception ignored) { } return; } lastScan = now;
                decoder.execute(() -> {
                    try { String text = new QRCodeReader().decode(new BinaryBitmap(new HybridBinarizer(new PlanarYUVLuminanceSource(bytes, width, height, 0, 0, width, height, false)))).getText(); if (text.startsWith("bitsbytes://link/")) runOnUiThread(() -> accept(text)); }
                    catch (Exception noCode) { }
                    finally { decoding.set(false); try { source.addCallbackBuffer(bytes); } catch (Exception ignored) { } }
                });
            });
            camera.addCallbackBuffer(new byte[width * height * 3 / 2]); camera.addCallbackBuffer(new byte[width * height * 3 / 2]); camera.startPreview();
        } catch (Exception unavailable) { close(); }
    }
    private void close() { Camera active = camera; camera = null; if (active != null) { try { active.setPreviewCallbackWithBuffer(null); active.stopPreview(); } catch (Exception ignored) { } finally { try { active.release(); } catch (Exception ignored) { } } } }
    private void accept(String text) {
        if (done) return;
        try { LinkStore.parse(text); done = true; close(); setResult(RESULT_OK, new Intent().putExtra("pairing", text)); finish(); }
        catch (Exception invalid) { new AlertDialog.Builder(this).setMessage(R.string.pc_code_error).setPositiveButton(android.R.string.ok, null).show(); }
    }
}
