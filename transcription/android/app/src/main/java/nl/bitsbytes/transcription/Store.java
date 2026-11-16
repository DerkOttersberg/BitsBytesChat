package nl.bitsbytes.transcription;

import android.content.Context;
import android.util.AtomicFile;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

final class Store {
    final File root;
    private final Map<String, JSONObject> rows = new LinkedHashMap<>();
    volatile long revision;

    Store(Context context) throws Exception { this(new File(context.getFilesDir(), "recordings")); }
    Store(File root) throws Exception { this.root = root; if (!root.exists() && !root.mkdirs()) throw new java.io.IOException(); recover(); }

    static JSONObject object(Object... pairs) {
        JSONObject result = new JSONObject();
        try { for (int index = 0; index < pairs.length; index += 2) result.put((String) pairs[index], pairs[index + 1]); }
        catch (Exception error) { throw new IllegalArgumentException(error); }
        return result;
    }
    static JSONObject copy(JSONObject value) { try { return new JSONObject(value.toString()); } catch (Exception error) { throw new IllegalArgumentException(error); } }
    static void set(JSONObject row, String key, Object value) { try { row.put(key, value); } catch (Exception error) { throw new IllegalArgumentException(error); } }
    static JSONObject read(File file) { return read(file, 20_000_000); }
    static JSONObject read(File file, int maximum) {
        try (FileInputStream input = new AtomicFile(file).openRead()) {
            if (input.getChannel().size() > maximum) return null;
            return new JSONObject(new String(bytes(input, maximum), StandardCharsets.UTF_8));
        } catch (Exception error) { return null; }
    }
    static byte[] bytes(InputStream input, int maximum) throws Exception {
        ByteArrayOutputStream result = new ByteArrayOutputStream(); byte[] buffer = new byte[16384]; int count;
        while ((count = input.read(buffer)) != -1) { if (result.size() + count > maximum) throw new java.io.IOException(); result.write(buffer, 0, count); }
        return result.toByteArray();
    }
    static void write(File file, byte[] data) throws Exception {
        AtomicFile atomic = new AtomicFile(file);
        FileOutputStream output = atomic.startWrite();
        try { output.write(data); output.getFD().sync(); atomic.finishWrite(output); }
        catch (Exception error) { atomic.failWrite(output); throw error; }
    }
    static void write(File file, JSONObject data) throws Exception { write(file, data.toString().getBytes(StandardCharsets.UTF_8)); }

    synchronized File directory(String id) {
        if (id == null || !id.matches("[a-f0-9-]{36}")) throw new IllegalArgumentException();
        return new File(root, id);
    }
    synchronized JSONObject get(String id) {
        JSONObject row = rows.get(id);
        if (row == null) throw new IllegalArgumentException();
        return copy(row);
    }
    synchronized List<JSONObject> list() {
        List<JSONObject> result = new ArrayList<>();
        for (JSONObject row : rows.values()) result.add(copy(row));
        result.sort((a, b) -> Long.compare(b.optLong("created"), a.optLong("created")));
        return result;
    }
    synchronized JSONObject create(JSONObject preferences, String status) throws Exception {
        String id = UUID.randomUUID().toString();
        if (!directory(id).mkdirs()) throw new java.io.IOException();
        JSONObject row = object("id", id, "created", System.currentTimeMillis(), "duration", 0, "rate", 16000,
            "status", status, "error", "", "transcript", "", "completedParts", 0, "chunks", 0, "preferences", copy(preferences));
        save(row); return get(id);
    }
    synchronized void save(JSONObject row) throws Exception {
        String id = row.getString("id");
        JSONObject previous = read(new File(directory(id), "recording.json"));
        if (previous != null) write(new File(directory(id), "recording.backup.json"), previous);
        write(new File(directory(id), "recording.json"), row);
        rows.put(id, copy(row)); revision++;
    }
    synchronized void update(String id, Object... fields) throws Exception {
        JSONObject row = get(id);
        for (int index = 0; index < fields.length; index += 2) set(row, (String) fields[index], fields[index + 1]);
        save(row);
    }
    synchronized void progress(String id, String stage, int completed, int total) throws Exception {
        JSONObject row = get(id); set(row, "progress", object("stage", stage, "completed", completed, "total", total));
        rows.put(id, row); revision++;
    }
    synchronized double append(String id, int sequence, byte[] pcm) throws Exception {
        JSONObject row = get(id);
        if (!Arrays.asList("recording", "importing").contains(row.optString("status")) || pcm.length == 0 || pcm.length > 32000 || pcm.length % 2 != 0) throw new IllegalArgumentException();
        int next = row.optInt("chunks");
        File file = new File(directory(id), String.format(java.util.Locale.ROOT, "%08d.pcm", sequence));
        if (sequence < next) {
            try (FileInputStream input = new FileInputStream(file)) { if (!Arrays.equals(bytes(input, 32000), pcm)) throw new IllegalArgumentException(); }
            return row.optDouble("duration");
        }
        if (sequence != next) throw new IllegalArgumentException();
        write(file, pcm);
        set(row, "chunks", next + 1); set(row, "duration", row.optDouble("duration") + pcm.length / 32000.0);
        rows.put(id, row); revision++;
        return row.optDouble("duration");
    }
    synchronized void resetDecode(String id) throws Exception {
        File[] chunks = directory(id).listFiles((directory, name) -> name.matches("[0-9]{8}\\.pcm"));
        if (chunks != null) for (File file : chunks) if (!file.delete()) throw new java.io.IOException();
        update(id, "duration", 0, "chunks", 0, "status", "importing", "decoded", false);
    }
    synchronized void savePart(String id, int index, JSONObject part) throws Exception {
        JSONObject row = get(id);
        if (index != row.optInt("completedParts")) throw new IllegalArgumentException();
        set(part, "preferences", row.getJSONObject("preferences"));
        write(new File(directory(id), String.format(java.util.Locale.ROOT, "part-%06d.json", index)), part);
        projectPart(row, part);
        write(new File(directory(id), "transcript.txt"), row.optString("transcript").getBytes(StandardCharsets.UTF_8));
        save(row);
    }
    private void projectPart(JSONObject row, JSONObject part) throws Exception {
        String previous = row.optString("transcript");
        set(row, "transcript", previous + (row.optInt("completedParts") > 0 ? "\n\n" : "") + part.getString("text"));
        boolean cost = part.has("costUSD") && Double.isFinite(part.optDouble("costUSD")) && part.optDouble("costUSD") >= 0;
        set(row, "costComplete", (row.optInt("completedParts") == 0 || row.optBoolean("costComplete")) && cost);
        if (cost) set(row, "costUSD", row.optDouble("costUSD", 0) + part.getDouble("costUSD"));
        set(row, "completedParts", row.optInt("completedParts") + 1);
        if (part.optJSONObject("preferences") != null) set(row, "preferences", part.getJSONObject("preferences"));
        if (part.optJSONArray("turns") != null) {
            set(row, "turns", part.getJSONArray("turns"));
        }
    }
    synchronized void delete(String id) throws Exception {
        File target = directory(id);
        File trash = new File(root.getParentFile(), "trash"); if (!trash.exists() && !trash.mkdirs()) throw new java.io.IOException();
        File moved = new File(trash, id + "-" + System.currentTimeMillis());
        if (!target.renameTo(moved)) throw new java.io.IOException();
        rows.remove(id); revision++;
        deleteTree(moved);
    }
    private static void deleteTree(File file) { File[] children = file.listFiles(); if (children != null) for (File child : children) deleteTree(child); file.delete(); }
    private synchronized void recover() throws Exception {
        File[] folders = root.listFiles(); if (folders == null) return;
        for (File folder : folders) {
            if (!folder.isDirectory() || !folder.getName().matches("[a-f0-9-]{36}")) continue;
            JSONObject row = read(new File(folder, "recording.json"));
            if (row == null) row = read(new File(folder, "recording.backup.json"));
            if (row == null || !row.optString("id").equals(folder.getName()) || row.optJSONObject("preferences") == null)
                row = object("id", folder.getName(), "created", folder.lastModified(), "duration", 0, "status", "interrupted", "error", "recovered_error", "preferences", Settings.defaults());
            set(row, "transcript", ""); set(row, "completedParts", 0); set(row, "costComplete", false);
            row.remove("costUSD"); row.remove("turns"); row.remove("progress");
            for (int index = 0; ; index++) {
                JSONObject part = read(new File(folder, String.format(java.util.Locale.ROOT, "part-%06d.json", index)));
                if (part == null || !(part.opt("text") instanceof String)) break;
                projectPart(row, part);
            }
            long bytes = 0; int count = 0;
            while (true) {
                File chunk = new File(folder, String.format(java.util.Locale.ROOT, "%08d.pcm", count));
                if (!chunk.isFile() || chunk.length() <= 0 || chunk.length() > 32000 || chunk.length() % 2 != 0) break;
                bytes += chunk.length(); count++;
            }
            set(row, "chunks", count); if (count > 0) set(row, "duration", bytes / 32000.0);
            File[] originals = folder.listFiles((directory, name) -> name.matches("original\\.[a-z0-9]+"));
            if (originals != null && originals.length > 0) set(row, "source", originals[0].getName());
            if (Arrays.asList("recording", "paused", "transcribing", "importing", "preparing").contains(row.optString("status"))) {
                set(row, "status", "interrupted"); set(row, "error", "recovered_error");
            }
            save(row);
        }
    }
}
