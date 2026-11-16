package nl.bitsbytes.transcription;

import android.content.Context;
import android.util.Base64;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

final class LinkStore {
    static final int MAX_TEXT_BYTES = 4 * 1024 * 1024;
    static final String ID = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
    final File outbox;
    private final File file;
    private final Settings settings;
    private final JSONObject data;
    private final Map<String, JSONObject> index = new LinkedHashMap<>();
    volatile long revision;
    LinkStore(Context context, Settings settings) throws Exception {
        this.settings = settings; file = new File(context.getFilesDir(), "pc-links.json"); outbox = new File(context.getFilesDir(), "outbox");
        if (!outbox.isDirectory() && !outbox.mkdirs()) throw new java.io.IOException();
        JSONObject saved = Store.read(file); if (saved == null) saved = Store.read(new File(context.getFilesDir(), "pc-links.backup.json"));
        data = saved != null && saved.optString("phoneId").matches(ID) && saved.optJSONObject("computers") != null ? saved : Store.object("phoneId", UUID.randomUUID().toString(), "computers", new JSONObject());
        save();
        File[] jobs = outbox.listFiles((directory, name) -> name.matches("[a-f0-9-]{36}\\.json"));
        if (jobs != null) for (File job : jobs) { JSONObject value = Store.read(job, 28 * 1024 * 1024); if (value != null && value.optString("id").matches(ID)) index.put(value.getString("id"), summary(value)); }
    }
    private void save() throws Exception {
        JSONObject previous = Store.read(file); if (previous != null) Store.write(new File(file.getParentFile(), "pc-links.backup.json"), previous);
        Store.write(file, data); revision++;
    }
    synchronized String phoneId() { return data.optString("phoneId"); }
    synchronized List<JSONObject> computers() {
        List<JSONObject> result = new ArrayList<>(); JSONObject computers = data.optJSONObject("computers");
        java.util.Iterator<String> keys = computers.keys(); while (keys.hasNext()) result.add(Store.copy(computers.optJSONObject(keys.next()))); return result;
    }
    synchronized JSONObject computer(String id) { JSONObject value = data.optJSONObject("computers").optJSONObject(id); return value == null ? null : Store.copy(value); }
    synchronized String token(String id) throws Exception { JSONObject row = computer(id); if (row == null) throw new AppFailure("pc_unlinked"); try { return settings.unseal(row.getJSONObject("secret")); } catch (Exception error) { throw new AppFailure("pc_unlinked"); } }
    static JSONObject parse(String code) throws Exception {
        if (code == null || code.length() > 8192 || !code.trim().startsWith("bitsbytes://link/")) throw new AppFailure("pc_code_error");
        JSONObject value;
        try { value = new JSONObject(new String(Base64.decode(code.trim().substring("bitsbytes://link/".length()), Base64.URL_SAFE | Base64.NO_WRAP), StandardCharsets.UTF_8)); }
        catch (Exception invalid) { throw new AppFailure("pc_code_error"); }
        if (value.optInt("v") != 1 || !value.optString("id").matches(ID) || !value.optString("peerId").matches(ID) || !value.optString("token").matches("[a-zA-Z0-9_-]{43}") || !value.optString("pin").matches("[a-f0-9]{64}") || value.optInt("port") < 1 || value.optInt("port") > 65535 || value.optJSONArray("addresses") == null || value.getJSONArray("addresses").length() > 12) throw new AppFailure("pc_code_error");
        for (int i = 0; i < value.getJSONArray("addresses").length(); i++) if (!address(value.getJSONArray("addresses").optString(i))) throw new AppFailure("pc_code_error");
        return value;
    }
    static boolean address(String host) { return host != null && host.length() <= 100 && (host.matches("[0-9]{1,3}(\\.[0-9]{1,3}){3}") || host.matches("[a-fA-F0-9:]+(%[a-zA-Z0-9_.-]+)?")); }
    synchronized String add(String code) throws Exception {
        JSONObject value = parse(code); String id = value.getString("id");
        value.put("secret", settings.seal(value.getString("token"))); value.remove("token"); value.put("pending", true); value.put("blocked", false); value.put("error", "");
        data.getJSONObject("computers").put(id, value); save();
        for (JSONObject job : new ArrayList<>(index.values())) if (id.equals(job.optString("computerId")) && job.optString("state").equals("blocked")) state(job.optString("id"), "queued", "");
        return id;
    }
    synchronized void updateComputer(String id, Object... fields) throws Exception {
        JSONObject row = computer(id); if (row == null) return;
        for (int i = 0; i < fields.length; i += 2) row.put((String) fields[i], fields[i + 1]);
        data.getJSONObject("computers").put(id, row); save();
    }
    synchronized void removeComputer(String id) throws Exception {
        data.getJSONObject("computers").remove(id); save();
        for (JSONObject meta : new ArrayList<>(index.values())) if (id.equals(meta.optString("computerId"))) {
            File job = new File(outbox, meta.optString("id") + ".json"); if (!job.delete() && job.exists()) throw new java.io.IOException(); index.remove(meta.optString("id"));
        }
        revision++;
    }
    synchronized String enqueue(JSONObject recording, String computerId) throws Exception {
        if (computer(computerId) == null) throw new AppFailure("pc_unlinked");
        String text = recording.optString("transcript"); byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
        if (text.trim().isEmpty()) throw new AppFailure("no_transcript"); if (bytes.length > MAX_TEXT_BYTES) throw new AppFailure("pc_text_limit");
        String digest = sha(bytes);
        for (JSONObject job : index.values()) if (computerId.equals(job.optString("computerId")) && recording.optString("id").equals(job.optString("recordingId")) && digest.equals(job.optString("sha256")) && job.optString("state").equals("queued")) return job.optString("id");
        String id = UUID.randomUUID().toString();
        JSONObject job = Store.object("id", id, "computerId", computerId, "phoneId", phoneId(), "recordingId", recording.getString("id"), "title", java.text.DateFormat.getDateTimeInstance().format(new java.util.Date(recording.optLong("created"))),
            "text", text, "sha256", digest, "duration", recording.optDouble("duration", 0), "state", "queued", "error", "", "created", System.currentTimeMillis());
        Store.write(new File(outbox, id + ".json"), job); index.put(id, summary(job)); revision++; return id;
    }
    synchronized JSONObject job(String id) { if (!id.matches(ID)) return null; return Store.read(new File(outbox, id + ".json"), 28 * 1024 * 1024); }
    synchronized List<JSONObject> pending() { List<JSONObject> result = new ArrayList<>(); for (JSONObject job : index.values()) if (job.optString("state").equals("queued")) result.add(Store.copy(job)); result.sort((a, b) -> Long.compare(a.optLong("created"), b.optLong("created"))); return result; }
    synchronized boolean hasPending() { if (!pending().isEmpty()) return true; for (JSONObject row : computers()) if (row.optBoolean("pending") && !row.optBoolean("blocked")) return true; return false; }
    synchronized JSONObject latest(String recordingId) { JSONObject latest = null; for (JSONObject job : index.values()) if (recordingId.equals(job.optString("recordingId")) && (latest == null || job.optLong("created") > latest.optLong("created"))) latest = job; return latest == null ? null : Store.copy(latest); }
    synchronized void state(String id, String state, String error) throws Exception {
        JSONObject known = index.get(id); if (known != null && state.equals(known.optString("state")) && error.equals(known.optString("error"))) return;
        JSONObject job = job(id); if (job == null) return;
        job.put("state", state); job.put("error", error); if (state.equals("sent")) { job.remove("text"); job.put("sent", System.currentTimeMillis()); }
        Store.write(new File(outbox, id + ".json"), job); index.put(id, summary(job)); revision++;
    }
    private JSONObject summary(JSONObject job) { return Store.object("id", job.optString("id"), "computerId", job.optString("computerId"), "recordingId", job.optString("recordingId"), "state", job.optString("state"), "error", job.optString("error"), "created", job.optLong("created"), "sha256", job.optString("sha256")); }
    static String sha(byte[] bytes) throws Exception { byte[] digest = MessageDigest.getInstance("SHA-256").digest(bytes); StringBuilder result = new StringBuilder(); for (byte value : digest) result.append(String.format(java.util.Locale.ROOT, "%02x", value & 255)); return result.toString(); }
}
