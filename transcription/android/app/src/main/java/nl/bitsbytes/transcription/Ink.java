package nl.bitsbytes.transcription;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.BitmapShader;
import android.graphics.Canvas;
import android.graphics.ColorFilter;
import android.graphics.Paint;
import android.graphics.PixelFormat;
import android.graphics.Shader;
import android.graphics.Typeface;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.StateListDrawable;
import android.view.View;

final class Ink {
    static final int PAPER = 0xfffff9eb, INK = 0xff171512, MINT = 0xff2bffac, MUTED = 0xff686257, RED = 0xffa33b2d;
    final Context context; final Typeface regular; final Typeface bold;
    Ink(Context context) {
        this.context = context;
        regular = Typeface.createFromAsset(context.getAssets(), "fonts/RobotoCondensed-Regular.ttf");
        bold = Typeface.createFromAsset(context.getAssets(), "fonts/RobotoCondensed-Bold.ttf");
    }
    int dp(float value) { return Math.round(value * context.getResources().getDisplayMetrics().density); }
    GradientDrawable box(int fill, int border) { GradientDrawable result = new GradientDrawable(); result.setColor(fill); if (border != 0) result.setStroke(dp(1), border); return result; }
    Drawable button(boolean primary) {
        StateListDrawable result = new StateListDrawable();
        result.addState(new int[]{-android.R.attr.state_enabled}, surface(0xffe1dccc, MUTED, 10));
        result.addState(new int[]{android.R.attr.state_pressed}, surface(primary ? 0xff1fce8b : 0xffeee9de, INK, 30));
        result.addState(new int[]{}, surface(primary ? MINT : PAPER, primary ? PAPER : 0xff837f78, 32)); return result;
    }
    Drawable paper() { return surface(PAPER, 0, 18); }
    Drawable header() { return surface(INK, 0, 35); }
    Drawable surface(int fill, int border, int alpha) {
        try {
            Bitmap image = BitmapFactory.decodeStream(context.getAssets().open("textures/dots.png"));
            Paint paint = new Paint(); BitmapShader shader = new BitmapShader(image, Shader.TileMode.REPEAT, Shader.TileMode.REPEAT);
            android.graphics.Matrix scale = new android.graphics.Matrix(); scale.setScale(context.getResources().getDisplayMetrics().density, context.getResources().getDisplayMetrics().density); shader.setLocalMatrix(scale); paint.setShader(shader);
            paint.setColorFilter(new android.graphics.PorterDuffColorFilter(fill == INK ? 0xff947860 : INK, android.graphics.PorterDuff.Mode.SRC_IN)); paint.setAlpha(alpha);
            return new Drawable() {
                @Override public void draw(Canvas canvas) {
                    Paint base = new Paint(); base.setColor(fill); canvas.drawRect(getBounds(), base); canvas.drawRect(getBounds(), paint);
                    if (border != 0) { base.setColor(border); base.setStyle(Paint.Style.STROKE); base.setStrokeWidth(dp(1.5f)); base.setPathEffect(new android.graphics.DashPathEffect(new float[]{dp(5), dp(3)}, 0)); canvas.drawRect(getBounds().left + dp(2), getBounds().top + dp(2), getBounds().right - dp(2), getBounds().bottom - dp(2), base); }
                }
                @Override public void setAlpha(int alpha) { paint.setAlpha(alpha); }
                @Override public void setColorFilter(ColorFilter filter) { paint.setColorFilter(filter); }
                @Override public int getOpacity() { return PixelFormat.OPAQUE; }
            };
        } catch (Exception ignored) { return box(fill, border); }
    }
    Drawable icon(String symbol) {
        return new Drawable() {
            final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
            @Override public void draw(Canvas canvas) {
                canvas.save(); canvas.translate(getBounds().left, getBounds().top); canvas.scale(getBounds().width() / 24f, getBounds().height() / 24f);
                paint.setColor(INK); paint.setStrokeWidth(1.7f); paint.setStyle(Paint.Style.STROKE); paint.setStrokeJoin(Paint.Join.ROUND); paint.setStrokeCap(Paint.Cap.ROUND);
                android.graphics.Path path = new android.graphics.Path();
                switch (symbol) {
                    case "record" -> { canvas.drawRoundRect(9, 3, 15, 15, 3, 3, paint); canvas.drawArc(5, 6, 19, 19, 0, 180, false, paint); canvas.drawLine(12, 19, 12, 22, paint); canvas.drawLine(8, 22, 16, 22, paint); }
                    case "settings" -> { canvas.drawLine(4, 7, 20, 7, paint); canvas.drawLine(4, 17, 20, 17, paint); canvas.drawCircle(9, 7, 3, paint); canvas.drawCircle(16, 17, 3, paint); }
                    case "copy" -> { canvas.drawRoundRect(8, 8, 20, 21, 2, 2, paint); path.moveTo(16, 8); path.lineTo(16, 3); path.lineTo(3, 3); path.lineTo(3, 16); path.lineTo(8, 16); canvas.drawPath(path, paint); }
                    case "pause" -> { paint.setStyle(Paint.Style.FILL); canvas.drawRect(6, 5, 10, 19, paint); canvas.drawRect(14, 5, 18, 19, paint); }
                    case "finish" -> { paint.setStyle(Paint.Style.FILL); canvas.drawRect(6, 6, 18, 18, paint); }
                    case "play" -> { path.moveTo(8, 4); path.lineTo(20, 12); path.lineTo(8, 20); path.close(); canvas.drawPath(path, paint); }
                    case "send" -> { path.moveTo(3, 3); path.lineTo(22, 12); path.lineTo(3, 21); path.lineTo(6, 12); path.close(); canvas.drawPath(path, paint); canvas.drawLine(6, 12, 22, 12, paint); }
                    case "pc" -> { canvas.drawRect(3, 4, 21, 17, paint); canvas.drawLine(12, 17, 12, 21, paint); canvas.drawLine(7, 21, 17, 21, paint); }
                    case "import" -> { canvas.drawLine(12, 3, 12, 15, paint); path.moveTo(8, 11); path.lineTo(12, 15); path.lineTo(16, 11); path.moveTo(5, 16); path.lineTo(5, 21); path.lineTo(19, 21); path.lineTo(19, 16); canvas.drawPath(path, paint); }
                    default -> { for (int i = 0; i < 5; i++) canvas.drawLine(4 + i * 4, i == 2 ? 3 : i % 2 == 0 ? 10 : 6, 4 + i * 4, i == 2 ? 21 : i % 2 == 0 ? 14 : 18, paint); }
                }
                canvas.restore();
            }
            @Override public void setAlpha(int alpha) { paint.setAlpha(alpha); }
            @Override public void setColorFilter(ColorFilter filter) { paint.setColorFilter(filter); }
            @Override public int getOpacity() { return PixelFormat.TRANSLUCENT; }
        };
    }
    Drawable people() {
        return new Drawable() {
            final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
            @Override public void draw(Canvas canvas) {
                canvas.save(); canvas.translate(getBounds().left, getBounds().top); canvas.scale(getBounds().width() / 24f, getBounds().height() / 24f);
                paint.setColor(INK); paint.setStrokeWidth(1.6f); paint.setStyle(Paint.Style.STROKE);
                canvas.drawCircle(9, 7, 3, paint); canvas.drawCircle(17, 8, 2.5f, paint);
                canvas.drawArc(2, 12, 16, 24, 180, 180, false, paint); canvas.drawArc(13, 13, 23, 23, 220, 140, false, paint); canvas.restore();
            }
            @Override public void setAlpha(int alpha) { paint.setAlpha(alpha); }
            @Override public void setColorFilter(ColorFilter filter) { paint.setColorFilter(filter); }
            @Override public int getOpacity() { return PixelFormat.TRANSLUCENT; }
        };
    }
    static final class Wave extends View {
        final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG); final float[] history = new float[35]; int cursor;
        Wave(Context context) { super(context); setContentDescription("Microphone level"); }
        void sample(float level) { history[cursor++ % history.length] = level; invalidate(); }
        @Override protected void onDraw(Canvas canvas) {
            super.onDraw(canvas); paint.setColor(INK); paint.setStrokeCap(Paint.Cap.ROUND);
            float step = getWidth() / (float) (history.length + 1); paint.setStrokeWidth(Math.max(2, step * .37f));
            for (int index = 0; index < history.length; index++) {
                float height = Math.max(2, history[(cursor + index) % history.length] * getHeight() * .8f);
                canvas.drawLine((index + 1) * step, (getHeight() - height) / 2, (index + 1) * step, (getHeight() + height) / 2, paint);
            }
        }
    }
}
