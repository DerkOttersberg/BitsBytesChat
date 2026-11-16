package nl.bitsbytes.transcription;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import org.json.JSONObject;
import java.io.File;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

final class Settings {
    private final File file;
    private JSONObject data;
    Settings(Context context) { file = new File(context.getFilesDir(), "settings.json"); data = Store.read(file); if (data == null) data = defaults(); }
    static JSONObject defaults() { return Store.object("model", "elevenlabs/scribe-v2", "language", "", "speakers", false); }
    static boolean supportsSpeakers(String model) { return model.equals("elevenlabs/scribe-v2") || model.equals("elevenlabs/scribe-v2-medical"); }
    synchronized JSONObject preferences() { return Store.object("model", data.optString("model", "elevenlabs/scribe-v2"), "language", data.optString("language"), "speakers", data.optBoolean("speakers")); }
    synchronized boolean hasKey() { return data.has("ciphertext"); }
    synchronized void save(String model, String language, boolean speakers, String key) throws Exception {
        model = model.trim(); language = language.trim(); key = key.trim();
        if (!model.matches("[a-zA-Z0-9][a-zA-Z0-9._-]*/[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,180}") || !language.matches("([a-z]{2})?") || key.length() > 4096) throw new AppFailure("settings_error");
        if (speakers && !supportsSpeakers(model)) throw new AppFailure("speaker_model");
        JSONObject next = Store.copy(data);
        Store.set(next, "model", model); Store.set(next, "language", language); Store.set(next, "speakers", speakers);
        if (!key.isEmpty()) {
            try {
                Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, secret());
                Store.set(next, "ciphertext", Base64.encodeToString(cipher.doFinal(key.getBytes(java.nio.charset.StandardCharsets.UTF_8)), Base64.NO_WRAP));
                Store.set(next, "iv", Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP));
            } catch (Exception error) { throw new AppFailure("encryption_error"); }
        }
        Store.write(file, next); data = next;
    }
    synchronized String apiKey() throws Exception {
        if (!hasKey()) throw new AppFailure("missing_key");
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, secret(), new GCMParameterSpec(128, Base64.decode(data.getString("iv"), Base64.NO_WRAP)));
            return new String(cipher.doFinal(Base64.decode(data.getString("ciphertext"), Base64.NO_WRAP)), java.nio.charset.StandardCharsets.UTF_8);
        } catch (Exception error) { throw new AppFailure("encryption_error"); }
    }
    private SecretKey secret() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
        String alias = "bitsbytes-transcription-api";
        if (!store.containsAlias(alias)) {
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
            generator.generateKey();
        }
        return (SecretKey) store.getKey(alias, null);
    }
    synchronized JSONObject seal(String text) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, secret());
        return Store.object("iv", Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP), "ciphertext", Base64.encodeToString(cipher.doFinal(text.getBytes(java.nio.charset.StandardCharsets.UTF_8)), Base64.NO_WRAP));
    }
    synchronized String unseal(JSONObject encrypted) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, secret(), new GCMParameterSpec(128, Base64.decode(encrypted.getString("iv"), Base64.NO_WRAP)));
        return new String(cipher.doFinal(Base64.decode(encrypted.getString("ciphertext"), Base64.NO_WRAP)), java.nio.charset.StandardCharsets.UTF_8);
    }
}
