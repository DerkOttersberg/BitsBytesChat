package nl.bitsbytes.transcription;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.drawable.Drawable;
import android.media.MediaPlayer;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.Switch;
import android.widget.TextView;
import android.widget.Toast;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.File;
import java.io.FileInputStream;
import java.io.OutputStream;
import java.text.DateFormat;
import java.util.Date;
import java.util.Locale;

public final class MainActivity extends Activity {
    private BitsApp app; private Ink ink; private LinearLayout root; private LinearLayout body;
    private String page = "library"; private String selected; private String exportId; private String exportFormat; private String state = "";
    private String resumeCaptureId;
    private int textPage;
    private String pendingSendId;
    private long lastLinkRetry;
    private boolean speakers; private boolean starting; private TextView clock; private Ink.Wave wave; private TextView recordStatus;
    private MediaPlayer player; private String playingId; private Button playButton;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable refresh = new Runnable() {
        @Override public void run() {
            if (app.links != null && android.os.SystemClock.elapsedRealtime() - lastLinkRetry > 15000 && app.links.store.hasPending()) { lastLinkRetry = android.os.SystemClock.elapsedRealtime(); app.links.flushAsync().whenComplete((pending, error) -> app.links.schedule()); }
            if (app.store != null) {
                if (page.equals("record") && app.activeId != null) selected = app.activeId;
                if (page.equals("record") && selected != null && app.activeId == null && !starting) { page = "detail"; state = ""; }
                String next = renderState();
                if (page.equals("record") && app.activeId != null && wave != null && next.equals(state)) {
                    clock.setText(duration(app.store.get(app.activeId).optDouble("duration"))); wave.sample(app.level);
                } else if (!page.equals("settings") && !next.equals(state)) { state = next; render(); }
                if (starting && app.busy()) { starting = false; state = ""; render(); }
            }
            if (app.fatal != null) { String error = app.fatal; app.fatal = null; message(error); starting = false; state = ""; }
            handler.postDelayed(this, 150);
        }
    };
    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved); app = (BitsApp) getApplication(); ink = new Ink(this);
        if (Build.VERSION.SDK_INT >= 33) getOnBackInvokedDispatcher().registerOnBackInvokedCallback(android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::back);
        speakers = app.settings != null && app.settings.preferences().optBoolean("speakers");
        if (saved != null) { page = saved.getString("page", "library"); selected = saved.getString("selected"); exportId = saved.getString("export"); exportFormat = saved.getString("exportFormat"); speakers = saved.getBoolean("speakers", speakers); pendingSendId = saved.getString("pendingSend"); resumeCaptureId = saved.getString("resumeCapture"); textPage = saved.getInt("textPage"); }
        if (app.activeId != null) { page = "record"; selected = app.activeId; }
        render();
    }
    @Override protected void onNewIntent(Intent intent) { super.onNewIntent(intent); if (app.activeId != null) { page = "record"; selected = app.activeId; state = ""; render(); } }
    @Override protected void onResume() { super.onResume(); lastLinkRetry = 0; handler.removeCallbacks(refresh); handler.post(refresh); }
    @Override protected void onPause() { handler.removeCallbacks(refresh); super.onPause(); }
    @Override protected void onDestroy() { releasePlayer(); super.onDestroy(); }
    @Override protected void onSaveInstanceState(Bundle saved) { saved.putString("page", page); saved.putString("selected", selected); saved.putString("export", exportId); saved.putString("exportFormat", exportFormat); saved.putBoolean("speakers", speakers); saved.putString("pendingSend", pendingSendId); saved.putString("resumeCapture", resumeCaptureId); saved.putInt("textPage", textPage); super.onSaveInstanceState(saved); }
    // API 33+ uses the registered predictive-back callback; older phones use this entry point.
    @android.annotation.SuppressLint("GestureBackNavigation")
    @Override public void onBackPressed() { back(); }
    private void back() { if (!page.equals("library")) navigate("library", null); else finish(); }
    private void navigate(String destination, String id) { if (!destination.equals("link")) pendingSendId = null; page = destination; selected = id; textPage = 0; starting = false; state = ""; releasePlayer(); render(); }
    private String renderState() { boolean capturing = page.equals("record") && app.activeId != null; return page + ":" + selected + ":" + (capturing ? app.paused ? "paused" : "recording" : Long.toString(app.store == null ? 0 : app.store.revision)) + ":" + app.activeId + ":" + app.busyId + ":" + (capturing || app.links == null ? 0 : app.links.store.revision); }
    private void render() {
        state = renderState();
        clock = null; wave = null; recordStatus = null; playButton = null;
        root = column(); root.setBackgroundColor(Ink.INK); setContentView(root);
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets safe = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
                view.setPadding(safe.left, safe.top, safe.right, safe.bottom);
            } else view.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(), insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            return insets;
        }); root.requestApplyInsets();
        LinearLayout header = row(); header.setPadding(ink.dp(8), 0, ink.dp(16), 0); header.setGravity(Gravity.CENTER_VERTICAL); header.setBackground(ink.header());
        if (!page.equals("library")) { Button back = button("‹", false, () -> navigate("library", null)); back.setContentDescription(getString(R.string.back)); back.setTextSize(30); back.setBackgroundColor(android.graphics.Color.TRANSPARENT); back.setTextColor(Ink.PAPER); header.addView(back, new LinearLayout.LayoutParams(ink.dp(48), ink.dp(54))); }
        TextView title = text(getString(page.equals("library") ? R.string.recordings : page.equals("settings") ? R.string.settings : page.equals("link") ? R.string.link_pc : page.equals("record") ? R.string.new_recording : R.string.recording), 22, true); title.setTextColor(Ink.PAPER);
        if (page.equals("library")) title.setPadding(ink.dp(12), 0, 0, 0);
        header.addView(title, new LinearLayout.LayoutParams(0, ink.dp(56), 1)); root.addView(header);
        ScrollView scroll = new ScrollView(this); scroll.setFillViewport(true); scroll.setBackground(ink.paper());
        body = column(); body.setPadding(ink.dp(20), ink.dp(20), ink.dp(20), ink.dp(24)); scroll.addView(body);
        root.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1));
        if (app.store == null || app.settings == null) { body.addView(text(getString(R.string.storage_error), 18, false)); return; }
        if (page.equals("settings")) settings(); else if (page.equals("record")) recording(); else if (page.equals("detail")) detail(); else if (page.equals("link")) linkPage(); else library();
        LinearLayout navigation = row(); navigation.setPadding(ink.dp(8), ink.dp(8), ink.dp(8), ink.dp(8)); navigation.setBackgroundColor(Ink.PAPER);
        nav(navigation, R.string.recordings, () -> navigate("library", null));
        nav(navigation, R.string.record_tab, () -> { if (app.busy() && app.activeId == null) { message("busy_error"); return; } navigate("record", app.activeId); });
        nav(navigation, R.string.settings, () -> navigate("settings", null)); root.addView(navigation);
    }
    private void library() {
        LinearLayout actions = row();
        addButton(actions, R.string.import_audio, false, () -> { if (app.busy()) { message("busy_error"); return; } startActivityForResult(new Intent(Intent.ACTION_OPEN_DOCUMENT).setType("audio/*").addCategory(Intent.CATEGORY_OPENABLE).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION), 10); });
        body.addView(actions); gap(20);
        if (app.store.list().isEmpty()) body.addView(text(getString(R.string.empty), 24, true));
        for (JSONObject item : app.store.list()) {
            String id = item.optString("id"); LinearLayout card = column(); card.setPadding(ink.dp(14), ink.dp(12), ink.dp(14), ink.dp(12)); card.setBackground(ink.box(Ink.PAPER, Ink.INK));
            card.addView(text(date(item.optLong("created")), 20, true)); gap(card, 5);
            card.addView(text(duration(item.optDouble("duration")) + "  ·  " + status(item), 16, false));
            String preview = item.optString("transcript"); if (!preview.isEmpty()) { TextView snippet = text(preview.substring(0, Math.min(preview.length(), 300)), 17, false); snippet.setMaxLines(2); gap(card, 8); card.addView(snippet); }
            card.setContentDescription(date(item.optLong("created")) + ", " + status(item)); card.setFocusable(true); card.setClickable(true);
            card.setOnClickListener(view -> navigate(id.equals(app.activeId) ? "record" : "detail", id)); body.addView(card); gap(12);
        }
    }
    private void recording() {
        boolean active = app.activeId != null; if (active) { selected = app.activeId; speakers = app.store.get(app.activeId).optJSONObject("preferences").optBoolean("speakers"); }
        clock = text(active ? duration(app.store.get(app.activeId).optDouble("duration")) : "00:00", 56, true); clock.setGravity(Gravity.CENTER); clock.setContentDescription("Recording duration"); body.addView(clock); gap(6);
        wave = new Ink.Wave(this); body.addView(wave, new LinearLayout.LayoutParams(-1, ink.dp(52))); gap(8);
        recordStatus = text(getString(active ? app.paused ? R.string.paused : R.string.recording : R.string.ready), 18, false); recordStatus.setGravity(Gravity.CENTER); body.addView(recordStatus); gap(12);
        Switch toggle = speakerSwitch(speakers); toggle.setEnabled(!active && !starting); toggle.setOnCheckedChangeListener((view, enabled) -> speakers = enabled); body.addView(toggle); gap(12);
        Button control = button(getString(active ? R.string.finish : R.string.start), true, () -> {
            if (active) { service("finish", null); return; }
            resumeCaptureId = null;
            if (app.busy()) { message("busy_error"); return; }
            if (speakers && !Settings.supportsSpeakers(app.settings.preferences().optString("model"))) { message("speaker_model"); return; }
            if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) { requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, 21); return; }
            startRecording();
        }); control.setEnabled(!starting);
        if (active) {
            LinearLayout controls = row(); Button pause = button("", false, () -> service(app.paused ? "resumeRecording" : "pause", null)); pause.setContentDescription(getString(app.paused ? R.string.resume_recording : R.string.pause_recording));
            Drawable symbol = ink.icon(app.paused ? "play" : "pause"); symbol.setBounds(0, 0, ink.dp(24), ink.dp(24)); pause.setCompoundDrawables(symbol, null, null, null); pause.setPadding(ink.dp(16), 0, ink.dp(16), 0);
            controls.addView(pause, new LinearLayout.LayoutParams(ink.dp(56), ink.dp(56))); LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(0, ink.dp(56), 1); params.setMarginStart(ink.dp(10)); controls.addView(control, params); body.addView(controls);
        } else body.addView(control, new LinearLayout.LayoutParams(-1, ink.dp(56)));
        gap(14);
    }
    private void startRecording() {
        if (app.busy() || starting) return; starting = true;
        Intent intent = new Intent(this, AudioService.class).setAction("record").putExtra("speakers", speakers);
        if (resumeCaptureId != null) { intent.putExtra("resumeId", resumeCaptureId); selected = resumeCaptureId; page = "record"; resumeCaptureId = null; }
        try { startForegroundService(intent); } catch (Exception error) { starting = false; message("microphone_error"); }
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 22);
        state = ""; render();
    }
    @Override public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(code, permissions, results);
        if (code == 21 && results.length > 0) { if (results[0] == PackageManager.PERMISSION_GRANTED) startRecording(); else message("permission_denied"); }
    }
    private void detail() {
        if (selected == null) { page = "library"; library(); return; }
        JSONObject item;
        try { item = app.store.get(selected); } catch (Exception gone) { page = "library"; selected = null; library(); return; }
        String id = selected; boolean busy = id.equals(app.busyId);
        body.addView(text(date(item.optLong("created")), 23, true)); gap(6);
        body.addView(text(duration(item.optDouble("duration")) + "  ·  " + status(item), 16, false)); gap(16);
        LinearLayout actions = row(); playButton = addButton(actions, player != null && id.equals(playingId) && player.isPlaying() ? R.string.pause : R.string.listen, true, () -> play(id));
        playButton.setEnabled(!id.equals(app.activeId));
        Button copy = addButton(actions, R.string.copy, false, () -> { try { getSystemService(ClipboardManager.class).setPrimaryClip(ClipData.newPlainText("Transcript", app.store.get(id).optString("transcript"))); message("copied"); } catch (RuntimeException tooLarge) { message("clipboard_error"); } }); copy.setEnabled(!item.optString("transcript").isEmpty()); body.addView(actions); gap(12);
        if (busy) {
            ProgressBar progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal); JSONObject job = item.optJSONObject("progress");
            progress.setIndeterminate(job == null || job.optInt("total") == 0);
            if (job != null && job.optInt("total") > 0) { progress.setMax(job.optInt("total")); progress.setProgress(item.optInt("completedParts")); }
            body.addView(progress, new LinearLayout.LayoutParams(-1, ink.dp(8))); gap(6);
            if (job != null) body.addView(text(stage(job), 16, false)); gap(8);
        }
        String cost = item.has("costUSD") ? getString(R.string.reported_cost, money(item.optDouble("costUSD"))) + (item.optBoolean("costComplete") ? "" : " + unreported usage") : getString(item.optInt("completedParts") > 0 ? R.string.cost_unknown : R.string.cost_after);
        body.addView(text(cost, 15, false)); gap(16);
        if (!item.optString("transcript").isEmpty()) {
            body.addView(button(getString(R.string.send_pc), true, () -> sendToPc(item))); gap(6);
            JSONObject delivery = app.links == null ? null : app.links.store.latest(id);
            if (delivery != null) { body.addView(text(getString(delivery.optString("state").equals("sent") ? R.string.pc_sent : delivery.optString("state").equals("blocked") ? R.string.pc_unlinked : R.string.pc_queued), 15, false)); gap(12); }
        }
        if (!item.optString("error").isEmpty()) { TextView error = text(errorText(item.optString("error")), 17, false); error.setTextColor(Ink.RED); body.addView(error); gap(12); }
        if (!app.busy() && item.optString("status").equals("interrupted") && !item.has("source") && item.optInt("completedParts") == 0 && !new File(app.store.directory(id), "prepared.json").exists()) {
            body.addView(button(getString(R.string.resume_recording), true, () -> { resumeCaptureId = id; if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, 21); else startRecording(); })); gap(8);
        }
        if (busy) body.addView(button(getString(R.string.cancel), false, () -> service("cancel", id)));
        else if (!item.optString("status").equals("complete")) body.addView(button(getString(R.string.resume), true, () -> { if (app.busy()) { message("busy_error"); return; } service("resume", id); }));
        gap(20);
        JSONArray turns = item.optJSONArray("turns");
        if (turns != null && turns.length() > 0) {
            // One selectable text widget keeps long conversations from allocating thousands of Views.
            android.text.SpannableStringBuilder transcript = new android.text.SpannableStringBuilder();
            for (int index = 0; index < turns.length(); index++) {
                JSONObject turn = turns.optJSONObject(index); if (turn == null) continue;
                int start = transcript.length();
                transcript.append((turn.optInt("speaker") == 0 ? getString(R.string.unknown_speaker) : getString(R.string.speaker, turn.optInt("speaker"))) + "  ·  " + duration(turn.optDouble("start")) + "\n");
                transcript.setSpan(new android.text.style.StyleSpan(android.graphics.Typeface.BOLD), start, transcript.length(), android.text.Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
                transcript.setSpan(new android.text.style.RelativeSizeSpan(.8f), start, transcript.length(), android.text.Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
                transcript.append(turn.optString("text")).append("\n\n");
            }
            transcript(transcript);
        } else transcript(item.optString("transcript").isEmpty() ? getString(R.string.no_transcript) : item.optString("transcript"));
        gap(30); LinearLayout footer = row();
        Button export = addButton(footer, R.string.save_audio, false, () -> exportAudio(id)); export.setBackgroundColor(android.graphics.Color.TRANSPARENT); export.setEnabled(!id.equals(app.activeId));
        Button delete = addButton(footer, R.string.delete, false, () -> new AlertDialog.Builder(this).setMessage(R.string.confirm_delete).setNegativeButton(R.string.keep, null).setPositiveButton(R.string.delete, (dialog, which) -> {
            try { releasePlayer(); app.store.delete(id); navigate("library", null); } catch (Exception error) { message("storage_error"); }
        }).show()); delete.setTextColor(Ink.RED); delete.setBackgroundColor(android.graphics.Color.TRANSPARENT); delete.setEnabled(!busy && !id.equals(app.activeId)); body.addView(footer);
    }
    private void transcript(CharSequence transcript) {
        int pages = Math.max(1, (transcript.length() + 11999) / 12000); textPage = Math.max(0, Math.min(textPage, pages - 1)); int start = textPage * 12000; int end = Math.min(transcript.length(), start + 12000);
        if (start > 0 && start < transcript.length() && Character.isLowSurrogate(transcript.charAt(start))) start--;
        if (end < transcript.length() && end > 0 && Character.isHighSurrogate(transcript.charAt(end - 1))) end--;
        TextView content = text("", 21, false); content.setText(transcript.subSequence(start, end)); content.setTextColor(Ink.INK); content.setTextIsSelectable(true); body.addView(content);
        if (pages > 1) {
            gap(16); LinearLayout pagination = row(); Button previous = button("‹", false, () -> { textPage--; render(); }); previous.setContentDescription(getString(R.string.previous_section)); previous.setEnabled(textPage > 0); pagination.addView(previous, new LinearLayout.LayoutParams(ink.dp(50), ink.dp(50)));
            TextView number = text((textPage + 1) + " / " + pages, 16, true); number.setGravity(Gravity.CENTER); pagination.addView(number, new LinearLayout.LayoutParams(0, ink.dp(50), 1));
            Button next = button("›", false, () -> { textPage++; render(); }); next.setContentDescription(getString(R.string.next_section)); next.setEnabled(textPage < pages - 1); pagination.addView(next, new LinearLayout.LayoutParams(ink.dp(50), ink.dp(50))); body.addView(pagination);
        }
    }
    private void settings() {
        JSONObject preferences = app.settings.preferences();
        EditText key = field(R.string.key, "", true); key.setHint(getString(app.settings.hasKey() ? R.string.key_saved : R.string.key));
        String[] model = {preferences.optString("model")}; String[] language = {preferences.optString("language")};
        Switch toggle = speakerSwitch(preferences.optBoolean("speakers")); toggle.setEnabled(Settings.supportsSpeakers(model[0]));
        body.addView(text(getString(R.string.model), 17, true)); gap(6);
        Button modelChoice = button(Catalog.label(app.catalog.models(), model[0]), false, () -> {}); modelChoice.setOnClickListener(view -> picker(R.string.model, app.catalog.models(), value -> { model[0] = value; modelChoice.setText(Catalog.label(app.catalog.models(), value)); toggle.setEnabled(Settings.supportsSpeakers(value)); if (!toggle.isEnabled()) toggle.setChecked(false); })); body.addView(modelChoice, new LinearLayout.LayoutParams(-1, -2)); gap(20);
        body.addView(text(getString(R.string.language), 17, true)); gap(6);
        Button languageChoice = button(Catalog.label(app.catalog.languages, language[0]), false, () -> {}); languageChoice.setOnClickListener(view -> picker(R.string.language, app.catalog.languages, value -> { language[0] = value; languageChoice.setText(Catalog.label(app.catalog.languages, value)); })); body.addView(languageChoice, new LinearLayout.LayoutParams(-1, -2)); gap(20);
        body.addView(toggle); gap(20);
        body.addView(button(getString(R.string.save), true, () -> {
            try { app.settings.save(model[0], language[0], toggle.isChecked(), key.getText().toString()); speakers = toggle.isChecked(); key.setText(""); message("saved"); navigate("library", null); }
            catch (Exception error) { message(BitsApp.errorCode(error)); }
        })); gap(20); body.addView(button(getString(R.string.link_pc), false, () -> navigate("link", null))); gap(20); body.addView(text(getString(R.string.storage_note), 16, false)); app.catalog.refresh();
    }
    private void picker(int title, JSONArray choices, java.util.function.Consumer<String> selected) {
        LinearLayout panel = column(); panel.setPadding(ink.dp(16), ink.dp(8), ink.dp(16), 0); panel.setBackground(ink.paper());
        EditText search = new EditText(this); search.setSingleLine(); search.setTextSize(18); search.setTypeface(ink.regular); search.setHint(R.string.search); search.setContentDescription(getString(R.string.search)); panel.addView(search);
        android.widget.ListView list = new android.widget.ListView(this); panel.addView(list, new LinearLayout.LayoutParams(-1, ink.dp(320)));
        java.util.List<JSONObject> rows = new java.util.ArrayList<>(); android.widget.ArrayAdapter<String> adapter = new android.widget.ArrayAdapter<String>(this, android.R.layout.simple_list_item_1, new java.util.ArrayList<>()) {
            @Override public View getView(int position, View recycled, android.view.ViewGroup parent) { TextView item = (TextView) super.getView(position, recycled, parent); item.setTypeface(ink.regular); item.setTextColor(Ink.INK); item.setTextSize(18); item.setMinHeight(ink.dp(50)); return item; }
        };
        list.setAdapter(adapter); Runnable filter = () -> {
            String query = search.getText().toString().toLowerCase(Locale.ROOT); rows.clear(); adapter.clear();
            for (int i = 0; i < choices.length(); i++) { JSONObject row = choices.optJSONObject(i); if (row != null && (row.optString("name") + " " + row.optString("id")).toLowerCase(Locale.ROOT).contains(query)) { rows.add(row); adapter.add(row.optString("name") + (row.optString("id").isEmpty() ? "" : "  ·  " + row.optString("id"))); } } adapter.notifyDataSetChanged();
        }; filter.run();
        search.addTextChangedListener(new android.text.TextWatcher() { @Override public void beforeTextChanged(CharSequence s, int start, int count, int after) {} @Override public void onTextChanged(CharSequence s, int start, int before, int count) { filter.run(); } @Override public void afterTextChanged(android.text.Editable value) {} });
        AlertDialog dialog = new AlertDialog.Builder(this).setTitle(title).setView(panel).setNegativeButton(android.R.string.cancel, null).create(); list.setOnItemClickListener((parent, view, position, id) -> { selected.accept(rows.get(position).optString("id")); getSystemService(android.view.inputmethod.InputMethodManager.class).hideSoftInputFromWindow(search.getWindowToken(), 0); dialog.dismiss(); }); dialog.getWindow().setSoftInputMode(android.view.WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_HIDDEN | android.view.WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE); dialog.show();
    }
    private void sendToPc(JSONObject recording) {
        if (app.links == null) { message("pc_delivery_error"); return; }
        java.util.List<JSONObject> computers = app.links.store.computers(); if (computers.isEmpty()) { pendingSendId = recording.optString("id"); navigate("link", null); return; }
        java.util.function.Consumer<JSONObject> send = computer -> {
            try { app.links.store.enqueue(recording, computer.optString("id")); startDelivery(); state = ""; render(); }
            catch (Exception error) { message(BitsApp.errorCode(error)); }
        };
        if (computers.size() == 1) { send.accept(computers.get(0)); return; }
        String[] names = new String[computers.size()]; for (int i = 0; i < names.length; i++) names[i] = computers.get(i).optString("name");
        new AlertDialog.Builder(this).setTitle(R.string.send_pc).setItems(names, (dialog, index) -> send.accept(computers.get(index))).show();
    }
    private void startDelivery() { if (app.links == null) return; app.links.schedule(); startForegroundService(new Intent(this, LinkDeliveryService.class)); }
    private void linkPage() {
        if (app.links == null) { body.addView(text(getString(R.string.pc_delivery_error), 18, false)); return; }
        body.addView(button(getString(R.string.scan_pc), true, () -> startActivityForResult(new Intent(this, ScanActivity.class), 30))); gap(16); body.addView(text(getString(R.string.pc_link_hint), 16, false)); gap(20);
        for (JSONObject computer : app.links.store.computers()) {
            body.addView(text(computer.optString("name", "PC"), 21, true));
            body.addView(text(computer.optBoolean("pending") ? getString(R.string.pc_pairing) : computer.optBoolean("blocked") ? getString(R.string.pc_unlinked) : getString(R.string.pc_paired), 16, false)); gap(8);
            LinearLayout actions = row(); addButton(actions, R.string.pc_retry, true, this::startDelivery); addButton(actions, R.string.pc_unlink, false, () -> new AlertDialog.Builder(this).setMessage(R.string.pc_unlink_confirm).setNegativeButton(android.R.string.cancel, null).setPositiveButton(R.string.pc_unlink, (dialog, which) -> { try { app.links.store.removeComputer(computer.optString("id")); app.links.schedule(); render(); } catch (Exception error) { message("storage_error"); } }).show()); body.addView(actions); gap(24);
        }
    }
    private EditText field(int label, String value, boolean secret) {
        body.addView(text(getString(label), 17, true)); gap(6); EditText result = new EditText(this); result.setTypeface(ink.regular); result.setTextSize(18); result.setTextColor(Ink.INK); result.setHintTextColor(Ink.MUTED); result.setText(value); result.setSingleLine(); result.setPadding(ink.dp(12), ink.dp(12), ink.dp(12), ink.dp(12)); result.setBackground(ink.box(Ink.PAPER, Ink.INK));
        result.setInputType(InputType.TYPE_CLASS_TEXT | (secret ? InputType.TYPE_TEXT_VARIATION_PASSWORD : InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS)); result.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO); body.addView(result, new LinearLayout.LayoutParams(-1, ink.dp(54))); gap(20); return result;
    }
    private Switch speakerSwitch(boolean checked) {
        Switch result = new Switch(this); result.setText(R.string.speaker_short); result.setContentDescription(getString(R.string.speakers)); result.setTypeface(ink.regular); result.setTextSize(19); result.setTextColor(Ink.INK); result.setMinHeight(ink.dp(52)); result.setChecked(checked);
        Drawable icon = ink.people(); icon.setBounds(0, 0, ink.dp(26), ink.dp(26)); result.setCompoundDrawables(icon, null, null, null); result.setCompoundDrawablePadding(ink.dp(10)); return result;
    }
    private void service(String action, String id) {
        Intent intent = new Intent(this, AudioService.class).setAction(action); if (id != null) intent.putExtra("id", id);
        try { if (action.equals("finish") || action.equals("cancel") || action.equals("pause") || action.equals("resumeRecording")) startService(intent); else startForegroundService(intent); }
        catch (Exception error) { message("provider_error"); }
    }
    private void play(String id) {
        if (player != null && id.equals(playingId)) { if (player.isPlaying()) player.pause(); else player.start(); state = ""; render(); return; }
        releasePlayer();
        new Thread(() -> {
            try {
                File file = audioFile(id); handler.post(() -> {
                    if (isFinishing() || !id.equals(selected)) return;
                    try { player = new MediaPlayer(); playingId = id; player.setDataSource(file.getAbsolutePath()); player.setOnPreparedListener(media -> { media.start(); state = ""; render(); }); player.setOnCompletionListener(media -> { releasePlayer(); state = ""; render(); }); player.setOnErrorListener((media, what, extra) -> { releasePlayer(); message("playback_error"); return true; }); player.prepareAsync(); }
                    catch (Exception error) { releasePlayer(); message("playback_error"); }
                });
            } catch (Exception error) { handler.post(() -> message("playback_error")); }
        }, "audio-playback").start();
    }
    private File audioFile(String id) throws Exception {
        File encoded = new File(app.store.directory(id), "audio.m4a"); if (encoded.isFile()) return encoded;
        JSONObject item = app.store.get(id); if (item.has("source")) return new File(app.store.directory(id), item.getString("source"));
        return AudioFiles.wav(app.store, id);
    }
    private void exportAudio(String id) {
        exportId = id; JSONObject item = app.store.get(id);
        boolean encoded = new File(app.store.directory(id), "audio.m4a").isFile();
        exportFormat = encoded ? "audio.m4a" : item.has("source") ? item.optString("source") : "recording.wav";
        String extension = encoded ? "m4a" : item.has("source") ? item.optString("source").substring("original.".length()) : "wav";
        String type = android.webkit.MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension);
        startActivityForResult(new Intent(Intent.ACTION_CREATE_DOCUMENT).setType(type == null ? "application/octet-stream" : type).addCategory(Intent.CATEGORY_OPENABLE).putExtra(Intent.EXTRA_TITLE, "BitsBytes-" + id.substring(0, 8) + "." + extension), 11);
    }
    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request == 30 && result == RESULT_OK && data != null && app.links != null) {
            String code = data.getStringExtra("pairing");
            try { JSONObject computer = LinkStore.parse(code); new AlertDialog.Builder(this).setTitle(getString(R.string.link_pc)).setMessage(computer.optString("name", "PC")).setNegativeButton(android.R.string.cancel, null).setPositiveButton(R.string.link_pc, (dialog, which) -> { try { String pc = app.links.store.add(code); String send = pendingSendId; if (send != null) app.links.store.enqueue(app.store.get(send), pc); startDelivery(); navigate(send == null ? "link" : "detail", send); } catch (Exception error) { message(BitsApp.errorCode(error)); } }).show(); }
            catch (Exception invalid) { message("pc_code_error"); } return;
        }
        if (result != RESULT_OK || data == null || data.getData() == null) return;
        Uri uri = data.getData();
        if (request == 10) {
            if (app.busy()) { message("busy_error"); return; }
            try { getContentResolver().takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION); } catch (Exception ignored) { }
            startForegroundService(new Intent(this, AudioService.class).setAction("import").setData(uri)); navigate("library", null);
        }
        if (request == 11 && exportId != null) {
            String id = exportId; String format = exportFormat; exportId = null; exportFormat = null;
            new Thread(() -> {
                try (FileInputStream input = new FileInputStream("recording.wav".equals(format) ? AudioFiles.wav(app.store, id) : new File(app.store.directory(id), format)); OutputStream output = getContentResolver().openOutputStream(uri, "wt")) {
                    if (output == null) throw new java.io.IOException(); AudioFiles.copy(input, output); output.flush(); handler.post(() -> message("saved"));
                } catch (Exception error) { handler.post(() -> message("storage_error")); }
            }, "audio-export").start();
        }
    }
    private void releasePlayer() { if (player != null) { player.release(); player = null; } playingId = null; }
    private String status(JSONObject item) { JSONObject progress = item.optJSONObject("progress"); if (progress != null) return stage(progress); return errorText(item.optString("status", "saved")); }
    private String stage(JSONObject progress) { return progress.optString("stage").equals("transcribing") ? getString(R.string.transcribing, progress.optInt("completed"), progress.optInt("total")) : errorText(progress.optString("stage", "preparing")); }
    private String errorText(String code) {
        int id = switch (code) {
            case "copied" -> R.string.copied; case "saved" -> R.string.saved; case "complete" -> R.string.complete;
            case "recording" -> R.string.recording; case "paused" -> R.string.paused; case "interrupted" -> R.string.interrupted; case "error" -> R.string.error;
            case "pc_unlinked" -> R.string.pc_unlinked; case "pc_code_error" -> R.string.pc_code_error; case "pc_text_limit" -> R.string.pc_text_limit; case "pc_delivery_error" -> R.string.pc_delivery_error;
            case "clipboard_error" -> R.string.clipboard_error;
            case "preparing" -> R.string.preparing; case "importing" -> R.string.importing; case "saving" -> R.string.saving;
            case "speaker_model" -> R.string.speaker_model; case "microphone_error" -> R.string.microphone_error;
            case "permission_denied" -> R.string.permission_denied; case "busy_error" -> R.string.busy_error;
            case "missing_key" -> R.string.missing_key; case "encryption_error" -> R.string.encryption_error;
            case "storage_error" -> R.string.storage_error; case "settings_error" -> R.string.settings_error;
            case "recovered_error" -> R.string.recovered_error; case "network_error" -> R.string.network_error;
            case "key_error" -> R.string.key_error; case "credits_error" -> R.string.credits_error; case "quota_error" -> R.string.quota_error;
            case "response_error" -> R.string.response_error; case "speaker_response_error" -> R.string.speaker_response_error;
            case "size_error" -> R.string.size_error; case "audio_error" -> R.string.audio_error;
            case "empty_error" -> R.string.empty_error; case "playback_error" -> R.string.playback_error;
            default -> R.string.provider_error;
        }; return getString(id);
    }
    private void message(String code) { Toast.makeText(this, errorText(code), Toast.LENGTH_LONG).show(); }
    static String duration(double seconds) { long total = Math.max(0, (long) seconds); return total >= 3600 ? String.format(Locale.ROOT, "%d:%02d:%02d", total / 3600, total / 60 % 60, total % 60) : String.format(Locale.ROOT, "%02d:%02d", total / 60, total % 60); }
    private static String date(long time) { return DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT).format(new Date(time)); }
    private static String money(double amount) { return String.format(Locale.ROOT, "$%.4f", amount); }
    private LinearLayout column() { LinearLayout result = new LinearLayout(this); result.setOrientation(LinearLayout.VERTICAL); return result; }
    private LinearLayout row() { LinearLayout result = new LinearLayout(this); result.setOrientation(LinearLayout.HORIZONTAL); result.setGravity(Gravity.CENTER_VERTICAL); return result; }
    private TextView text(String value, float size, boolean bold) { TextView result = new TextView(this); result.setText(value); result.setTextSize(size); result.setTypeface(bold ? ink.bold : ink.regular); result.setTextColor(bold ? Ink.INK : Ink.MUTED); result.setGravity(Gravity.CENTER_VERTICAL); result.setLineSpacing(ink.dp(3), 1); return result; }
    private Button button(String value, boolean primary, Runnable action) {
        Button result = new Button(this); result.setText(value); result.setAllCaps(false); result.setTypeface(ink.bold); result.setTextSize(17); result.setTextColor(Ink.INK); result.setMinHeight(ink.dp(50)); result.setMinimumWidth(0); result.setMinWidth(0); result.setPadding(ink.dp(12), ink.dp(8), ink.dp(12), ink.dp(8)); result.setBackground(ink.button(primary)); result.setStateListAnimator(null); result.setElevation(0); result.setOnClickListener(view -> action.run());
        String symbol = value.equals(getString(R.string.start)) ? "record" : value.equals(getString(R.string.finish)) ? "finish" : value.equals(getString(R.string.copy)) ? "copy" : value.equals(getString(R.string.listen)) ? "play" : value.equals(getString(R.string.send_pc)) ? "send" : value.equals(getString(R.string.link_pc)) || value.equals(getString(R.string.scan_pc)) ? "pc" : value.equals(getString(R.string.import_audio)) ? "import" : null;
        if (symbol != null) { Drawable icon = ink.icon(symbol); icon.setBounds(0, 0, ink.dp(22), ink.dp(22)); result.setCompoundDrawables(icon, null, null, null); result.setCompoundDrawablePadding(ink.dp(8)); } return result;
    }
    private Button addButton(LinearLayout parent, int label, boolean primary, Runnable action) { Button result = button(getString(label), primary, action); LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(0, -2, 1); if (parent.getChildCount() > 0) params.setMarginStart(ink.dp(8)); parent.addView(result, params); return result; }
    private void nav(LinearLayout parent, int label, Runnable action) { Button result = addButton(parent, label, false, action); result.setTextSize(14); result.setSingleLine(); result.setBackgroundColor(android.graphics.Color.TRANSPARENT); Drawable icon = ink.icon(label == R.string.settings ? "settings" : label == R.string.record_tab ? "record" : "audio"); icon.setBounds(0, 0, ink.dp(22), ink.dp(22)); result.setCompoundDrawables(null, icon, null, null); result.setCompoundDrawablePadding(ink.dp(4)); }
    private void gap(int height) { gap(body, height); }
    private void gap(LinearLayout parent, int height) { View spacer = new View(this); parent.addView(spacer, new LinearLayout.LayoutParams(1, ink.dp(height))); }
}
