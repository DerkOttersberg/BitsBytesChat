package nl.bitsbytes.transcription;

import android.media.AudioFormat;
import android.media.MediaCodec;
import android.media.MediaCodecInfo;
import android.media.MediaExtractor;
import android.media.MediaFormat;
import android.media.MediaMuxer;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.Arrays;
import java.util.Locale;

final class AudioFiles {
    static synchronized File wav(Store store, String id) throws Exception {
        JSONObject row = store.get(id); long size = 0;
        for (int index = 0; index < row.optInt("chunks"); index++) size += chunk(store, id, index).length();
        if (size == 0) throw new AppFailure("empty_error");
        if (size > 0xffffffffL - 36) throw new AppFailure("audio_error");
        File file = new File(store.directory(id), "recording.wav"); if (file.isFile() && file.length() == size + 44) return file;
        File temporary = new File(store.directory(id), "recording.wav.tmp");
        ByteBuffer header = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN);
        header.put("RIFF".getBytes(java.nio.charset.StandardCharsets.US_ASCII)).putInt((int) (size + 36));
        header.put("WAVEfmt ".getBytes(java.nio.charset.StandardCharsets.US_ASCII)).putInt(16).putShort((short) 1).putShort((short) 1);
        header.putInt(16000).putInt(32000).putShort((short) 2).putShort((short) 16).put("data".getBytes(java.nio.charset.StandardCharsets.US_ASCII)).putInt((int) size);
        try (FileOutputStream output = new FileOutputStream(temporary); InputStream input = pcm(store, id)) {
            output.write(header.array()); copy(input, output); output.getFD().sync();
        }
        if (!temporary.renameTo(file)) throw new java.io.IOException();
        return file;
    }
    static File chunk(Store store, String id, int index) { return new File(store.directory(id), String.format(Locale.ROOT, "%08d.pcm", index)); }
    static void copy(InputStream input, java.io.OutputStream output) throws Exception { byte[] buffer = new byte[65536]; int count; while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count); }
    private static InputStream pcm(Store store, String id) {
        int count = store.get(id).optInt("chunks");
        return new InputStream() {
            int index; FileInputStream current;
            @Override public int read() throws java.io.IOException { byte[] one = new byte[1]; return read(one, 0, 1) == -1 ? -1 : one[0] & 255; }
            @Override public int read(byte[] buffer, int offset, int length) throws java.io.IOException {
                while (index < count) {
                    if (current == null) current = new FileInputStream(chunk(store, id, index));
                    int read = current.read(buffer, offset, length); if (read != -1) return read;
                    current.close(); current = null; index++;
                }
                return -1;
            }
            @Override public void close() throws java.io.IOException { if (current != null) current.close(); }
        };
    }
    static JSONObject prepare(BitsApp app, String id) throws Exception {
        Store store = app.store; JSONObject row = store.get(id); boolean speakers = row.getJSONObject("preferences").optBoolean("speakers");
        JSONObject prepared = Store.read(new File(store.directory(id), "prepared.json"));
        if (prepared != null && prepared.optBoolean("speakers") == speakers) {
            JSONArray files = prepared.optJSONArray("parts"); boolean valid = files != null && files.length() > 0;
            if (valid) for (int index = 0; index < files.length(); index++) {
                String name = files.getString(index);
                if (!(name.equals("audio.m4a") || name.matches("upload-[0-9]{6}\\.m4a")) || !new File(store.directory(id), name).isFile()) valid = false;
            }
            if (valid) return prepared;
        }
        if (row.has("source") && !row.optBoolean("decoded")) decode(app, id);
        row = store.get(id);
        if (row.optDouble("duration") <= 0) throw new AppFailure("empty_error");
        encode(app, id, speakers ? 32000 : 48000);
        JSONArray parts = speakers ? new JSONArray().put("audio.m4a") : split(app, id);
        prepared = Store.object("parts", parts, "duration", store.get(id).optDouble("duration"), "speakers", speakers);
        Store.write(new File(store.directory(id), "prepared.json"), prepared);
        return prepared;
    }
    private static void encode(BitsApp app, String id, int bitrate) throws Exception {
        File output = new File(app.store.directory(id), "audio.m4a");
        File temporary = new File(app.store.directory(id), "audio.encoding");
        MediaCodec codec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC);
        MediaMuxer muxer = new MediaMuxer(temporary.getAbsolutePath(), MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4);
        boolean started = false; int track = -1;
        try (InputStream input = pcm(app.store, id)) {
            MediaFormat format = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, 16000, 1);
            format.setInteger(MediaFormat.KEY_BIT_RATE, bitrate); format.setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC);
            codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE); codec.start();
            boolean inputEnded = false; boolean outputEnded = false; long bytes = 0; long deadline = System.currentTimeMillis() + 1800000;
            MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
            while (!outputEnded) {
                check(app); if (System.currentTimeMillis() > deadline) throw new AppFailure("audio_error");
                if (!inputEnded) {
                    int index = codec.dequeueInputBuffer(10000);
                    if (index >= 0) {
                        ByteBuffer buffer = codec.getInputBuffer(index); if (buffer == null) throw new AppFailure("audio_error");
                        buffer.clear(); byte[] data = new byte[Math.min(buffer.capacity(), 16384) & ~1]; int count = input.read(data);
                        if (count < 0) { codec.queueInputBuffer(index, 0, 0, bytes * 1000000L / 32000, MediaCodec.BUFFER_FLAG_END_OF_STREAM); inputEnded = true; }
                        else { buffer.put(data, 0, count); codec.queueInputBuffer(index, 0, count, bytes * 1000000L / 32000, 0); bytes += count; }
                    }
                }
                int index = codec.dequeueOutputBuffer(info, 10000);
                if (index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) { track = muxer.addTrack(codec.getOutputFormat()); muxer.start(); started = true; }
                if (index >= 0) {
                    ByteBuffer buffer = codec.getOutputBuffer(index);
                    if ((info.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0) info.size = 0;
                    if (info.size > 0 && buffer != null && started) { buffer.position(info.offset); buffer.limit(info.offset + info.size); muxer.writeSampleData(track, buffer, info); }
                    outputEnded = (info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0;
                    codec.releaseOutputBuffer(index, false);
                }
            }
        } finally {
            try { codec.stop(); } catch (Exception ignored) { } codec.release();
            try { if (started) muxer.stop(); } finally { muxer.release(); }
        }
        sync(temporary); if (!temporary.renameTo(output)) throw new java.io.IOException();
    }
    private static JSONArray split(BitsApp app, String id) throws Exception {
        MediaExtractor extractor = new MediaExtractor(); MediaMuxer muxer = null; JSONArray parts = new JSONArray();
        File temporary = null; File destination = null;
        try {
            extractor.setDataSource(new File(app.store.directory(id), "audio.m4a").getAbsolutePath()); extractor.selectTrack(0);
            MediaFormat format = extractor.getTrackFormat(0); ByteBuffer data = ByteBuffer.allocate(1024 * 1024);
            MediaCodec.BufferInfo info = new MediaCodec.BufferInfo(); long offset = 0; int track = 0; int part = 0;
            while (true) {
                check(app); data.clear(); int count = extractor.readSampleData(data, 0); if (count < 0) break;
                long time = extractor.getSampleTime();
                if (muxer == null || time - offset >= 300000000L) {
                    if (muxer != null) { muxer.stop(); muxer.release(); muxer = null; sync(temporary); if (!temporary.renameTo(destination)) throw new java.io.IOException(); }
                    String name = String.format(Locale.ROOT, "upload-%06d.m4a", part++);
                    destination = new File(app.store.directory(id), name); temporary = new File(app.store.directory(id), name + ".tmp");
                    muxer = new MediaMuxer(temporary.getAbsolutePath(), MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4);
                    track = muxer.addTrack(format); muxer.start(); offset = time; parts.put(name);
                }
                info.set(0, count, time - offset, 0); data.position(0); data.limit(count); muxer.writeSampleData(track, data, info); extractor.advance();
            }
            if (muxer != null) { muxer.stop(); muxer.release(); muxer = null; sync(temporary); if (!temporary.renameTo(destination)) throw new java.io.IOException(); }
        } finally { extractor.release(); if (muxer != null) { try { muxer.stop(); } catch (Exception ignored) { } muxer.release(); } }
        if (parts.length() == 0) throw new AppFailure("audio_error"); return parts;
    }
    static void decode(BitsApp app, String id) throws Exception {
        app.store.resetDecode(id); JSONObject row = app.store.get(id);
        MediaExtractor extractor = new MediaExtractor(); MediaCodec codec = null;
        try {
            String source = row.getString("source"); if (!source.matches("original\\.[a-z0-9]+")) throw new AppFailure("audio_error");
            extractor.setDataSource(new File(app.store.directory(id), source).getAbsolutePath());
            int selected = -1;
            for (int index = 0; index < extractor.getTrackCount(); index++) if (extractor.getTrackFormat(index).getString(MediaFormat.KEY_MIME).startsWith("audio/")) { selected = index; break; }
            if (selected < 0) throw new AppFailure("audio_error");
            extractor.selectTrack(selected); MediaFormat format = extractor.getTrackFormat(selected);
            Resampler resampler = new Resampler(app, id, format.getInteger(MediaFormat.KEY_SAMPLE_RATE), format.getInteger(MediaFormat.KEY_CHANNEL_COUNT));
            String mime = format.getString(MediaFormat.KEY_MIME);
            if (MediaFormat.MIMETYPE_AUDIO_RAW.equals(mime)) {
                ByteBuffer input = ByteBuffer.allocate(1024 * 1024); int count;
                while (true) { check(app); input.clear(); count = extractor.readSampleData(input, 0); if (count < 0) break; input.position(0); input.limit(count); resampler.consume(input, AudioFormat.ENCODING_PCM_16BIT); extractor.advance(); }
            } else {
                codec = MediaCodec.createDecoderByType(mime); format.setInteger(MediaFormat.KEY_PCM_ENCODING, AudioFormat.ENCODING_PCM_16BIT);
                codec.configure(format, null, null, 0); codec.start(); boolean inEnded = false; boolean outEnded = false;
                MediaCodec.BufferInfo info = new MediaCodec.BufferInfo(); int encoding = AudioFormat.ENCODING_PCM_16BIT; long deadline = System.currentTimeMillis() + 1800000;
                while (!outEnded) {
                    check(app); if (System.currentTimeMillis() > deadline) throw new AppFailure("audio_error");
                    if (!inEnded) {
                        int index = codec.dequeueInputBuffer(10000);
                        if (index >= 0) {
                            ByteBuffer input = codec.getInputBuffer(index); if (input == null) throw new AppFailure("audio_error"); input.clear();
                            int count = extractor.readSampleData(input, 0);
                            if (count < 0) { codec.queueInputBuffer(index, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM); inEnded = true; }
                            else { codec.queueInputBuffer(index, 0, count, extractor.getSampleTime(), 0); extractor.advance(); }
                        }
                    }
                    int index = codec.dequeueOutputBuffer(info, 10000);
                    if (index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                        MediaFormat decoded = codec.getOutputFormat(); resampler.rate = decoded.getInteger(MediaFormat.KEY_SAMPLE_RATE); resampler.channels = decoded.getInteger(MediaFormat.KEY_CHANNEL_COUNT);
                        if (decoded.containsKey(MediaFormat.KEY_PCM_ENCODING)) encoding = decoded.getInteger(MediaFormat.KEY_PCM_ENCODING);
                    }
                    if (index >= 0) {
                        ByteBuffer output = codec.getOutputBuffer(index);
                        if (info.size > 0 && output != null) { output.position(info.offset); output.limit(info.offset + info.size); resampler.consume(output, encoding); }
                        outEnded = (info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0; codec.releaseOutputBuffer(index, false);
                    }
                }
            }
            resampler.flush(); app.store.update(id, "decoded", true, "status", "transcribing");
        } finally { extractor.release(); if (codec != null) { try { codec.stop(); } catch (Exception ignored) { } codec.release(); } }
    }
    private static final class Resampler {
        final BitsApp app; final String id; int rate; int channels; int sequence; int used; double clock; double sum; int samples;
        final byte[] chunk = new byte[32000];
        Resampler(BitsApp app, String id, int rate, int channels) { this.app = app; this.id = id; this.rate = rate; this.channels = channels; }
        void consume(ByteBuffer input, int encoding) throws Exception {
            if (rate < 8000 || rate > 192000 || channels < 1 || channels > 16 || (encoding != AudioFormat.ENCODING_PCM_16BIT && encoding != AudioFormat.ENCODING_PCM_FLOAT)) throw new AppFailure("audio_error");
            input.order(ByteOrder.LITTLE_ENDIAN); int size = (encoding == AudioFormat.ENCODING_PCM_FLOAT ? 4 : 2) * channels;
            while (input.remaining() >= size) {
                double mono = 0;
                for (int channel = 0; channel < channels; channel++) mono += encoding == AudioFormat.ENCODING_PCM_FLOAT ? input.getFloat() : input.getShort() / 32768.0;
                mono /= channels; if (!Double.isFinite(mono)) mono = 0; sum += mono; samples++; clock += 16000;
                while (clock >= rate) { clock -= rate; short sample = (short) Math.round(Math.max(-1, Math.min(1, sum / samples)) * 32767); chunk[used++] = (byte) sample; chunk[used++] = (byte) (sample >>> 8); if (used == chunk.length) flush(); }
                if (clock < 16000) { sum = 0; samples = 0; }
            }
        }
        void flush() throws Exception { if (used > 0) { app.store.append(id, sequence++, Arrays.copyOf(chunk, used)); used = 0; } }
    }
    static void sync(File file) throws Exception { try (FileOutputStream output = new FileOutputStream(file, true)) { output.getFD().sync(); } }
    static void check(BitsApp app) throws AppFailure { if (app.cancel || Thread.currentThread().isInterrupted()) throw new AppFailure("network_error"); }
}
