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
    static final int PAPER = 0xfffff9eb, INK = 0xff171512, MINT = 0xffc9e4cf, MUTED = 0xff686257, RED = 0xffa33b2d;
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
        result.addState(new int[]{-android.R.attr.state_enabled}, box(0xffe1dccc, MUTED));
        result.addState(new int[]{android.R.attr.state_pressed}, box(0xffa7c2ae, INK));
        result.addState(new int[]{}, box(primary ? MINT : PAPER, INK)); return result;
    }
    Drawable paper() {
        try {
            Bitmap image = BitmapFactory.decodeStream(context.getAssets().open("textures/dots.png"));
            Paint paint = new Paint(); paint.setShader(new BitmapShader(image, Shader.TileMode.REPEAT, Shader.TileMode.REPEAT)); paint.setAlpha(35);
            return new Drawable() {
                @Override public void draw(Canvas canvas) { canvas.drawColor(PAPER); canvas.drawRect(getBounds(), paint); }
                @Override public void setAlpha(int alpha) { paint.setAlpha(alpha); }
                @Override public void setColorFilter(ColorFilter filter) { paint.setColorFilter(filter); }
                @Override public int getOpacity() { return PixelFormat.OPAQUE; }
            };
        } catch (Exception ignored) { return box(PAPER, 0); }
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
