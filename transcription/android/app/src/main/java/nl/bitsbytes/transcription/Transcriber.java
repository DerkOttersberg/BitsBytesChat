package nl.bitsbytes.transcription;

import android.util.Base64;
import android.util.Base64OutputStream;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;
import javax.net.ssl.HttpsURLConnection;

final class Transcriber {
    interface Transport {
        JSONObject send(JSONObject preferences, File audio, String key) throws Exception;
        default void cancel() { }
    }
    static JSONObject options(JSONObject preferences) throws Exception {
        JSONObject request = Store.object("model", preferences.getString("model"), "response_format", preferences.optBoolean("speakers") ? "verbose_json" : "json");
        if (!preferences.optString("language").isEmpty()) request.put("language", preferences.getString("language"));
        if (preferences.optBoolean("speakers")) {
            if (!Settings.supportsSpeakers(preferences.optString("model"))) throw new AppFailure("speaker_model");
            request.put("timestamp_granularities", new JSONArray().put("word"));
            request.put("provider", Store.object("options", Store.object("elevenlabs", Store.object("diarize", true))));
        }
        return request;
    }
    static final class HttpsTransport implements Transport {
        private volatile HttpsURLConnection connection;
        @Override public void cancel() { HttpsURLConnection current = connection; if (current != null) current.disconnect(); }
        @Override public JSONObject send(JSONObject preferences, File audio, String key) throws Exception {
            if (audio.length() > 24_000_000) throw new AppFailure("size_error");
            HttpsURLConnection request = (HttpsURLConnection) new URL("https://openrouter.ai/api/v1/audio/transcriptions").openConnection();
            connection = request;
            try {
                request.setConnectTimeout(30000); request.setReadTimeout(180000); request.setRequestMethod("POST");
                request.setInstanceFollowRedirects(false); request.setDoOutput(true);
                request.setRequestProperty("Authorization", "Bearer " + key); request.setRequestProperty("Content-Type", "application/json");
                request.setRequestProperty("X-Title", "BitsBytes Transcription Android");
                byte[] prefix = prefix(); byte[] suffix = suffix(preferences);
                request.setFixedLengthStreamingMode(prefix.length + ((audio.length() + 2) / 3) * 4 + suffix.length);
                try (OutputStream output = request.getOutputStream()) { writeRequest(preferences, audio, output); }
                int status = request.getResponseCode();
                if (status != 200) throw new AppFailure(status == 401 || status == 403 ? "key_error" : status == 402 ? "credits_error" : status == 429 ? "quota_error" : "provider_error");
                try (InputStream input = request.getInputStream()) {
                    try { return new JSONObject(new String(Store.bytes(input, 16_000_000), StandardCharsets.UTF_8)); }
                    catch (Exception invalid) { throw new AppFailure("response_error"); }
                }
            } catch (AppFailure error) { throw error; }
            catch (Exception error) { throw new AppFailure("network_error"); }
            finally { request.disconnect(); connection = null; }
        }
    }
    private static byte[] prefix() { return "{\"input_audio\":{\"format\":\"m4a\",\"data\":\"".getBytes(StandardCharsets.UTF_8); }
    private static byte[] suffix(JSONObject preferences) throws Exception { return ("\"}," + options(preferences).toString().substring(1)).getBytes(StandardCharsets.UTF_8); }
    static void writeRequest(JSONObject preferences, File audio, OutputStream output) throws Exception {
        output.write(prefix());
        try (FileInputStream input = new FileInputStream(audio)) {
            Base64OutputStream encoder = new Base64OutputStream(output, Base64.NO_WRAP | Base64.NO_CLOSE);
            AudioFiles.copy(input, encoder); encoder.close();
        }
        output.write(suffix(preferences));
    }
    static void run(BitsApp app, String id) throws Exception {
        Store store = app.store;
        store.update(id, "status", "preparing", "error", ""); store.progress(id, "preparing", 0, 0);
        JSONObject prepared = AudioFiles.prepare(app, id); JSONArray files = prepared.getJSONArray("parts");
        JSONObject row = store.get(id); JSONObject preferences = row.getJSONObject("preferences");
        for (int index = row.optInt("completedParts"); index < files.length(); index++) {
            AudioFiles.check(app);
            store.update(id, "status", "transcribing"); store.progress(id, "transcribing", index + 1, files.length());
            File responseFile = new File(store.directory(id), String.format(java.util.Locale.ROOT, "response-%06d.json", index));
            JSONObject cached = Store.read(responseFile); JSONObject part = null;
            if (cached != null) {
                try { part = parse(cached, preferences.optBoolean("speakers")); }
                catch (AppFailure invalid) { /* An explicit Resume may retry an unusable provider response. */ }
            }
            if (part == null) {
                JSONObject response = app.transport.send(preferences, new File(store.directory(id), files.getString(index)), app.settings.apiKey());
                // Save received provider work before parsing/projecting it, so a crash between these steps does not require another paid request.
                Store.write(responseFile, response); part = parse(response, preferences.optBoolean("speakers"));
            }
            // Commit a received result even if cancellation arrived during the response: avoid discarding paid work.
            store.progress(id, "saving", index + 1, files.length()); store.savePart(id, index, part);
        }
        store.update(id, "status", "complete", "error", "", "progress", JSONObject.NULL);
    }
    static JSONObject parse(JSONObject response, boolean speakers) throws Exception {
        String text = response.optString("text", "").trim(); JSONObject part = Store.object("text", text);
        if (speakers) {
            JSONArray words = response.optJSONArray("words"); if (words == null || words.length() == 0) words = response.optJSONArray("segments");
            if (words == null) throw new AppFailure("speaker_response_error");
            Map<String, Integer> labels = new LinkedHashMap<>(); JSONArray turns = new JSONArray(); JSONObject current = null;
            for (int index = 0; index < words.length(); index++) {
                JSONObject word = words.optJSONObject(index); if (word == null) continue;
                if (word.optString("type").equals("audio_event")) continue;
                String content = word.optString("word", word.optString("text", "")).trim(); if (content.isEmpty()) continue;
                Object raw = word.has("speaker") ? word.opt("speaker") : word.opt("speaker_id");
                String identity = raw == null || raw == JSONObject.NULL ? "" : String.valueOf(raw);
                if (identity.isEmpty() && !word.optString("speaker_label").isEmpty()) identity = word.optString("speaker_label");
                int speaker = 0;
                if (!identity.isEmpty()) { if (!labels.containsKey(identity)) labels.put(identity, labels.size() + 1); speaker = labels.get(identity); }
                if (current == null || current.optInt("speaker") != speaker) {
                    current = Store.object("speaker", speaker, "text", content, "start", Math.max(0, word.optDouble("start", 0))); turns.put(current);
                } else current.put("text", join(current.getString("text"), content));
            }
            if (labels.isEmpty() || turns.length() == 0) throw new AppFailure("speaker_response_error");
            StringBuilder transcript = new StringBuilder();
            for (int index = 0; index < turns.length(); index++) {
                JSONObject turn = turns.getJSONObject(index); if (index > 0) transcript.append("\n\n");
                transcript.append(turn.optInt("speaker") == 0 ? "Unknown speaker" : "Speaker " + turn.optInt("speaker")).append(": ").append(turn.getString("text"));
            }
            part.put("text", transcript.toString()); part.put("turns", turns);
        }
        if (part.optString("text").trim().isEmpty()) throw new AppFailure("response_error");
        JSONObject usage = response.optJSONObject("usage"); double cost = usage == null ? Double.NaN : usage.optDouble("cost", Double.NaN);
        if (Double.isFinite(cost) && cost >= 0) part.put("costUSD", cost);
        return part;
    }
    private static String join(String previous, String next) { return previous + (next.matches("^[,.;:!?%)}\\]].*") ? "" : " ") + next; }
}
