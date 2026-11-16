package nl.bitsbytes.transcription;

import android.app.job.JobInfo;
import android.app.job.JobScheduler;
import android.content.ComponentName;
import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.OutputStream;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

final class LinkClient {
    static final int JOB_ID = 47831;
    final LinkStore store;
    private final Context context;
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final ScheduledExecutorService timeout = Executors.newSingleThreadScheduledExecutor();
    private CompletableFuture<Boolean> running;
    LinkClient(Context context, Settings settings) throws Exception {
        this.context = context; store = new LinkStore(context, settings);
        ConnectivityManager manager = context.getSystemService(ConnectivityManager.class);
        manager.registerDefaultNetworkCallback(new ConnectivityManager.NetworkCallback() {
            @Override public void onAvailable(Network network) { if (store.hasPending()) flushAsync().whenComplete((pending, error) -> schedule()); }
        });
    }
    synchronized CompletableFuture<Boolean> flushAsync() {
        if (running != null) return running;
        CompletableFuture<Boolean> result = new CompletableFuture<>(); running = result;
        executor.execute(() -> {
            boolean pending = true; Exception failure = null;
            try { flush(); pending = store.hasPending(); } catch (Exception error) { failure = error; }
            synchronized (LinkClient.this) { running = null; }
            if (failure == null) result.complete(pending); else result.completeExceptionally(failure);
        }); return result;
    }
    void schedule() {
        JobScheduler scheduler = context.getSystemService(JobScheduler.class);
        if (!store.hasPending()) { scheduler.cancel(JOB_ID); return; }
        if (scheduler.getPendingJob(JOB_ID) != null) return;
        scheduler.schedule(new JobInfo.Builder(JOB_ID, new ComponentName(context, LinkJobService.class)).setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY).setPersisted(true).setBackoffCriteria(10000, JobInfo.BACKOFF_POLICY_EXPONENTIAL).build());
    }
    private void flush() throws Exception {
        for (JSONObject computer : store.computers()) {
            if (!computer.optBoolean("pending") || computer.optBoolean("blocked")) continue;
            try {
                JSONObject response = call(computer, "pair", Store.object("phoneId", store.phoneId(), "name", android.os.Build.MODEL));
                if (!response.optString("desktopId").equals(computer.optString("id")) || !response.optString("status").equals("linked") || !response.optString("peerId").equals(computer.optString("peerId"))) throw new java.io.IOException();
                store.updateComputer(computer.optString("id"), "pending", false, "blocked", false, "error", "", "name", response.optString("name", computer.optString("name")));
            } catch (AppFailure failure) { store.updateComputer(computer.optString("id"), "blocked", true, "error", failure.code); }
            catch (Exception offline) { store.updateComputer(computer.optString("id"), "error", "pc_offline"); }
        }
        for (JSONObject meta : store.pending()) {
            JSONObject computer = store.computer(meta.optString("computerId")); if (computer == null || computer.optBoolean("pending")) continue;
            if (computer.optBoolean("blocked")) { store.state(meta.optString("id"), "blocked", computer.optString("error", "pc_unlinked")); continue; }
            JSONObject job = store.job(meta.optString("id")); if (job == null) continue;
            try {
                JSONObject response = call(computer, "deliver", job);
                if (!response.optString("desktopId").equals(computer.optString("id")) || !response.optString("id").equals(job.optString("id")) || !response.optString("sha256").equals(job.optString("sha256")) || !response.optString("status").equals("copied")) throw new java.io.IOException();
                store.state(job.optString("id"), "sent", ""); store.updateComputer(computer.optString("id"), "error", "", "lastSeen", System.currentTimeMillis());
            } catch (AppFailure failure) { store.state(job.optString("id"), "blocked", failure.code); if (failure.code.equals("pc_unlinked")) store.updateComputer(computer.optString("id"), "blocked", true, "error", failure.code); }
            catch (Exception offline) { store.state(job.optString("id"), "queued", "pc_offline"); }
        }
    }
    JSONObject call(JSONObject computer, String operation, JSONObject body) throws Exception {
        List<Endpoint> endpoints = new ArrayList<>(); JSONArray addresses = computer.optJSONArray("addresses");
        if (addresses != null) for (int i = 0; i < Math.min(addresses.length(), 12); i++) if (LinkStore.address(addresses.optString(i))) endpoints.add(new Endpoint(addresses.optString(i), computer.optInt("port")));
        for (Endpoint endpoint : endpoints) {
            try { JSONObject response = request(computer, endpoint, operation, body); remember(computer, endpoint); return response; }
            catch (AppFailure failure) { throw failure; } catch (Exception offline) { /* discover its new address before leaving the job queued */ }
        }
        for (Endpoint endpoint : discover(computer)) {
            try { JSONObject response = request(computer, endpoint, operation, body); remember(computer, endpoint); return response; }
            catch (AppFailure failure) { throw failure; } catch (Exception offline) { }
        }
        throw new java.io.IOException("PC unavailable");
    }
    private void remember(JSONObject computer, Endpoint endpoint) throws Exception {
        JSONArray addresses = new JSONArray().put(endpoint.host); JSONArray previous = computer.optJSONArray("addresses");
        if (previous != null) for (int i = 0; i < previous.length() && addresses.length() < 12; i++) if (!endpoint.host.equals(previous.optString(i))) addresses.put(previous.optString(i));
        if (endpoint.port != computer.optInt("port") || !addresses.toString().equals(String.valueOf(previous))) store.updateComputer(computer.optString("id"), "addresses", addresses, "port", endpoint.port);
    }
    private JSONObject request(JSONObject computer, Endpoint endpoint, String operation, JSONObject body) throws Exception {
        final String pin = computer.getString("pin");
        X509TrustManager trust = new X509TrustManager() {
            @Override public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
            @Override public void checkClientTrusted(X509Certificate[] chain, String authType) throws CertificateException { throw new CertificateException(); }
            @Override public void checkServerTrusted(X509Certificate[] chain, String authType) throws CertificateException {
                try { if (chain == null || chain.length == 0 || !MessageDigest.isEqual(pin.getBytes(StandardCharsets.US_ASCII), LinkStore.sha(chain[0].getPublicKey().getEncoded()).getBytes(StandardCharsets.US_ASCII))) throw new CertificateException("PC identity mismatch"); }
                catch (CertificateException failure) { throw failure; } catch (Exception failure) { throw new CertificateException(failure); }
            }
        };
        SSLContext tls = SSLContext.getInstance("TLS"); tls.init(null, new TrustManager[]{trust}, null);
        String host = endpoint.host.contains(":") ? "[" + endpoint.host + "]" : endpoint.host;
        HttpsURLConnection connection = (HttpsURLConnection) new URL("https://" + host + ":" + endpoint.port + "/v1/peers/" + computer.getString("peerId") + "/" + operation).openConnection();
        connection.setSSLSocketFactory(tls.getSocketFactory());
        // Dynamic LAN addresses have no public DNS identity. The QR-pinned SPKI above is the required server identity.
        connection.setHostnameVerifier((hostname, session) -> true);
        java.util.concurrent.ScheduledFuture<?> deadline = timeout.schedule(connection::disconnect, 30, TimeUnit.SECONDS);
        try {
            connection.setInstanceFollowRedirects(false); connection.setConnectTimeout(1800); connection.setReadTimeout(12000); connection.setRequestMethod("POST"); connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8"); connection.setRequestProperty("Authorization", "Bearer " + store.token(computer.getString("id")));
            byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8); connection.setFixedLengthStreamingMode(bytes.length);
            try (OutputStream output = connection.getOutputStream()) { output.write(bytes); }
            int status = connection.getResponseCode();
            if (status == 401 || status == 403 || status == 410) throw new AppFailure("pc_unlinked");
            if (status == 413) throw new AppFailure("pc_text_limit"); if (status == 400) throw new AppFailure("pc_delivery_error");
            if (status != 200) throw new java.io.IOException();
            try (java.io.InputStream input = connection.getInputStream()) { return new JSONObject(new String(Store.bytes(input, 65536), StandardCharsets.UTF_8)); }
        } finally { deadline.cancel(false); connection.disconnect(); }
    }
    private List<Endpoint> discover(JSONObject computer) {
        Map<String, Endpoint> found = new ConcurrentHashMap<>(); NsdManager manager = context.getSystemService(NsdManager.class); CountDownLatch ready = new CountDownLatch(1);
        NsdManager.DiscoveryListener listener = new NsdManager.DiscoveryListener() {
            @Override public void onDiscoveryStarted(String type) { }
            @Override public void onDiscoveryStopped(String type) { }
            @Override public void onStartDiscoveryFailed(String type, int code) { ready.countDown(); }
            @Override public void onStopDiscoveryFailed(String type, int code) { }
            @Override public void onServiceLost(NsdServiceInfo service) { }
            @Override public void onServiceFound(NsdServiceInfo service) {
                if (!service.getServiceName().startsWith("BBT-" + computer.optString("id"))) return;
                manager.resolveService(service, new NsdManager.ResolveListener() {
                    @Override public void onResolveFailed(NsdServiceInfo info, int code) { }
                    @Override public void onServiceResolved(NsdServiceInfo info) {
                        try {
                            String id = new String(info.getAttributes().get("id"), StandardCharsets.UTF_8); String pin = new String(info.getAttributes().get("pin"), StandardCharsets.UTF_8);
                            String host = info.getHost().getHostAddress();
                            if (id.equals(computer.optString("id")) && pin.equals(computer.optString("pin")) && LinkStore.address(host)) { found.put(host, new Endpoint(host, info.getPort())); ready.countDown(); }
                        } catch (Exception invalid) { }
                    }
                });
            }
        };
        try {
            manager.discoverServices("_bbtranscript._tcp.", NsdManager.PROTOCOL_DNS_SD, listener);
            try (DatagramSocket socket = new DatagramSocket()) {
                socket.setBroadcast(true); socket.setSoTimeout(400); byte[] query = "BitsBytes-Transcription discovery 1".getBytes(StandardCharsets.US_ASCII);
                socket.send(new DatagramPacket(query, query.length, InetAddress.getByName("255.255.255.255"), 47832));
                java.util.Enumeration<java.net.NetworkInterface> interfaces = java.net.NetworkInterface.getNetworkInterfaces();
                while (interfaces.hasMoreElements()) for (java.net.InterfaceAddress address : interfaces.nextElement().getInterfaceAddresses()) if (address.getBroadcast() != null) socket.send(new DatagramPacket(query, query.length, address.getBroadcast(), 47832));
                long until = System.currentTimeMillis() + 1800;
                while (System.currentTimeMillis() < until && found.isEmpty()) {
                    try {
                        DatagramPacket packet = new DatagramPacket(new byte[2048], 2048); socket.receive(packet); JSONObject value = new JSONObject(new String(packet.getData(), 0, packet.getLength(), StandardCharsets.UTF_8));
                        if (computer.optString("id").equals(value.optString("id")) && computer.optString("pin").equals(value.optString("pin")) && value.optInt("port") > 0 && value.optInt("port") <= 65535) found.put(packet.getAddress().getHostAddress(), new Endpoint(packet.getAddress().getHostAddress(), value.getInt("port")));
                    } catch (java.net.SocketTimeoutException wait) { }
                }
            }
            if (found.isEmpty()) ready.await(700, TimeUnit.MILLISECONDS);
        } catch (Exception unavailable) { }
        finally { try { manager.stopServiceDiscovery(listener); } catch (Exception ignored) { } }
        return new ArrayList<>(found.values());
    }
    private static final class Endpoint { final String host; final int port; Endpoint(String host, int port) { this.host = host; this.port = port; } }
}
