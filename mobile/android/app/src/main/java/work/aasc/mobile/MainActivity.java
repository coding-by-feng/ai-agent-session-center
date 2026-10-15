package work.aasc.mobile;

import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.view.WindowManager;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    /** When the app last went to the background (biometric lock, AASC-21). */
    private long pausedAt = 0;

    /** A notification tap just sent the WebView back to the shell, which checks the lock itself. */
    private boolean returningForTap = false;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // The app's own plugins (AASC-17): both serve the bundled shell page only.
        registerPlugin(DeviceVaultPlugin.class);
        registerPlugin(ShellBridgePlugin.class);
        // A cold start from the share sheet: the shell takes the item when it starts (AASC-21).
        ShareInbox.INSTANCE.accept(getIntent(), getPackageName());
        super.onCreate(savedInstanceState);
        // The app switcher never shows a terminal (AASC-22, RELEASE row 7). Android 13+ has a switch
        // for exactly that (screenshots still work); older versions are covered in onPause.
        if (Build.VERSION.SDK_INT >= 33) setRecentsScreenshotEnabled(false);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        // Shared while running: the Mac's page may be showing, so go back to the shell to pick a session.
        if (ShareInbox.INSTANCE.accept(intent, getPackageName()) && getBridge() != null) {
            getBridge().getWebView().loadUrl(getBridge().getLocalUrl() + "/?share=1");
            return;
        }
        // A notification tap (AASC-19): the push plugin (in super) held it for a listener, and only
        // the shell listens, so a Mac's page sends the WebView back to the shell to open it.
        Bundle extras = intent.getExtras();
        if (extras != null && PushRules.INSTANCE.isTap(extras.keySet()) && getBridge() != null && getBridge().getWebView() != null) {
            String target = PushRules.INSTANCE.tapUrl(getBridge().getLocalUrl(), getBridge().getWebView().getUrl());
            if (target != null) {
                returningForTap = true;
                getBridge().getWebView().loadUrl(target);
            }
        }
    }

    @Override
    public void onPause() {
        // Before Android 13: secure while in the background, so the switcher's snapshot is blank.
        if (Build.VERSION.SDK_INT < 33) getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        super.onPause();
        pausedAt = System.currentTimeMillis();
    }

    @Override
    public void onResume() {
        super.onResume();
        if (Build.VERSION.SDK_INT < 33) getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SECURE);
        // With the lock on and a Mac's page showing, the shell decides whether to ask (LockRules).
        if (getBridge() == null || getBridge().getWebView() == null) return;
        if (returningForTap) {
            // The tap's shell start runs the lock check; a resume reload here would race the tap.
            returningForTap = false;
            return;
        }
        String settings = getSharedPreferences(LockRules.PREFS, Context.MODE_PRIVATE).getString(LockRules.SETTINGS_KEY, null);
        String target = LockRules.INSTANCE.resumeUrl(
            settings, getBridge().getLocalUrl(), getBridge().getWebView().getUrl(), pausedAt, System.currentTimeMillis());
        if (target != null) getBridge().getWebView().loadUrl(target);
    }
}
