package nl.bitsbytes.transcription;

import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.ParcelFileDescriptor;
import android.os.SystemClock;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.uiautomator.By;
import androidx.test.uiautomator.UiDevice;
import androidx.test.uiautomator.Until;
import com.google.zxing.BinaryBitmap;
import com.google.zxing.RGBLuminanceSource;
import com.google.zxing.common.HybridBinarizer;
import com.google.zxing.qrcode.QRCodeReader;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Assume;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeUnit;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

/** Invoked by test/phone-desktop.ts with a private, disposable PC profile. No paid provider is involved. */
@RunWith(AndroidJUnit4.class)
public class LinkIntegrationTest {
    private byte[] shell(String command) throws Exception {
        try (InputStream input = new ParcelFileDescriptor.AutoCloseInputStream(InstrumentationRegistry.getInstrumentation().getUiAutomation().executeShellCommand(command))) { return Store.bytes(input, 4 * 1024 * 1024); }
    }
    @Test public void realPcQrAndLongClipboardTransferSurviveAnAcknowledgementRetry() throws Exception {
        String configuration = InstrumentationRegistry.getArguments().getString("pairingFile"); Assume.assumeTrue(configuration != null);
        JSONObject config = new JSONObject(new String(shell("cat /data/local/tmp/bbt-pair.json"), StandardCharsets.UTF_8));
        byte[] image = shell("cat /data/local/tmp/bbt-qr.png"); Bitmap qr = BitmapFactory.decodeByteArray(image, 0, image.length); assertNotNull(qr);
        int[] pixels = new int[qr.getWidth() * qr.getHeight()]; qr.getPixels(pixels, 0, qr.getWidth(), 0, 0, qr.getWidth(), qr.getHeight());
        String code = new QRCodeReader().decode(new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(qr.getWidth(), qr.getHeight(), pixels)))).getText();
        assertEquals(config.getString("pairing"), code);
        BitsApp app = (BitsApp) androidx.test.core.app.ApplicationProvider.getApplicationContext(); assertNotNull(app.links);
        String pc = app.links.store.add(code); app.links.store.updateComputer(pc, "addresses", new JSONArray().put("10.0.2.2"));
        JSONObject computer = app.links.store.computer(pc); JSONObject wrong = Store.copy(computer); StringBuilder wrongPin = new StringBuilder(); for (int i = 0; i < 64; i++) wrongPin.append('0'); wrong.put("pin", wrongPin.toString());
        boolean rejected = false;
        try { app.links.call(wrong, "pair", Store.object("phoneId", app.links.store.phoneId(), "name", "Android integration test")); } catch (Exception expected) { rejected = true; }
        assertTrue("A different PC key must not receive the pairing credential", rejected);
        app.links.flushAsync().get(45, TimeUnit.SECONDS); assertFalse(app.links.store.computer(pc).getBoolean("pending"));
        StringBuilder text = new StringBuilder(); for (int i = 0; i < 22000; i++) text.append("Spreker 1: lange conversatie — café 中文 🤖\n");
        String id = app.store.create(Settings.defaults(), "complete").getString("id"); app.store.update(id, "duration", 3600); app.store.savePart(id, 0, Store.object("text", text.toString()));
        UiDevice device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation()); androidx.test.uiautomator.Configurator.getInstance().setWaitForIdleTimeout(100);
        app.startActivity(new Intent(app, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK));
        androidx.test.uiautomator.UiObject2 recording = device.wait(Until.findObject(By.pkg(app.getPackageName()).textContains("Transcribed")), 10000); assertNotNull(recording); recording.click();
        androidx.test.uiautomator.UiObject2 send = device.wait(Until.findObject(By.pkg(app.getPackageName()).text("Send to PC")), 10000); assertNotNull(send); send.click();
        long deadline = SystemClock.elapsedRealtime() + 45000; JSONObject delivery = null;
        while (SystemClock.elapsedRealtime() < deadline) { delivery = app.links.store.latest(id); if (delivery != null && delivery.optString("state").equals("sent")) break; SystemClock.sleep(100); }
        assertNotNull(delivery); assertEquals("sent", delivery.getString("state"));
        LinkStore reopened = new LinkStore(app, app.settings); assertEquals("sent", reopened.latest(id).getString("state")); assertFalse(reopened.job(delivery.getString("id")).has("text"));
        JSONObject retry = Store.object("id", delivery.getString("id"), "phoneId", app.links.store.phoneId(), "recordingId", id, "title", "Retry", "duration", 3600, "text", text.toString(), "sha256", LinkStore.sha(text.toString().getBytes(StandardCharsets.UTF_8)));
        shell("touch /data/local/tmp/bbt-link-received"); deadline = SystemClock.elapsedRealtime() + 30000;
        while (shell("ls /data/local/tmp/bbt-link-retry 2>/dev/null").length == 0 && SystemClock.elapsedRealtime() < deadline) SystemClock.sleep(100);
        assertTrue(SystemClock.elapsedRealtime() < deadline);
        JSONObject response = app.links.call(app.links.store.computer(pc), "deliver", retry); assertEquals("copied", response.getString("status"));
    }
}
