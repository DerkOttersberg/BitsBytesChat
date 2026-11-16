package nl.bitsbytes.transcription;

import android.content.Context;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.File;
import java.io.InputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;
import javax.net.ssl.HttpsURLConnection;

final class Catalog {
    final JSONArray languages;
    private volatile JSONArray models;
    private long fetched;
    private final File file;
    private final AtomicBoolean loading = new AtomicBoolean();
    Catalog(Context context) throws Exception {
        file = new File(context.getFilesDir(), "models.json"); JSONObject bundled;
        try (InputStream input = context.getAssets().open("catalog.json")) { bundled = new JSONObject(new String(Store.bytes(input, 1024 * 1024), StandardCharsets.UTF_8)); }
        languages = bundled.getJSONArray("languages"); models = bundled.getJSONArray("models"); JSONObject saved = Store.read(file);
        if (saved != null && saved.optJSONArray("models") != null && saved.getJSONArray("models").length() > 0) { models = saved.getJSONArray("models"); fetched = saved.optLong("fetched"); }
    }
    JSONArray models() { return models; }
    void refresh() {
        if (System.currentTimeMillis() - fetched < 86400000 || !loading.compareAndSet(false, true)) return;
        new Thread(() -> {
            HttpsURLConnection connection = null;
            try {
                connection = (HttpsURLConnection) new URL("https://openrouter.ai/api/v1/models?output_modalities=transcription").openConnection();
                connection.setConnectTimeout(8000); connection.setReadTimeout(10000); if (connection.getResponseCode() != 200) return;
                JSONObject response; try (InputStream input = connection.getInputStream()) { response = new JSONObject(new String(Store.bytes(input, 4 * 1024 * 1024), StandardCharsets.UTF_8)); }
                JSONArray data = response.optJSONArray("data"); if (data == null) return; List<JSONObject> rows = new ArrayList<>();
                for (int i = 0; i < data.length() && rows.size() < 1000; i++) {
                    JSONObject row = data.optJSONObject(i); if (row == null || !row.optString("id").matches("[a-zA-Z0-9][a-zA-Z0-9._-]*/[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,180}")) continue;
                    rows.add(Store.object("id", row.getString("id"), "name", row.optString("name", row.getString("id"))));
                }
                rows.sort((a, b) -> a.optString("name").compareToIgnoreCase(b.optString("name"))); JSONArray choices = new JSONArray(); for (JSONObject row : rows) choices.put(row);
                if (choices.length() == 0) return; long now = System.currentTimeMillis(); Store.write(file, Store.object("models", choices, "fetched", now)); models = choices; fetched = now;
            } catch (Exception offline) { /* The bundled/cached choices remain usable offline. */ }
            finally { if (connection != null) connection.disconnect(); loading.set(false); }
        }, "model-catalog").start();
    }
    static String label(JSONArray choices, String id) {
        for (int i = 0; i < choices.length(); i++) { JSONObject row = choices.optJSONObject(i); if (row != null && id.equals(row.optString("id"))) return row.optString("name", id); }
        return id.isEmpty() ? "Automatic" : id;
    }
}
