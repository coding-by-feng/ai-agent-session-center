package work.aasc.mobile;

import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    /** When the app last went to the background (biometric lock, AASC-21). */
    private long pausedAt = 0;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // The app's own plugins (AASC-17): both serve the bundled shell page only.
        registerPlugin(DeviceVaultPlugin.class);
        registerPlugin(ShellBridgePlugin.class);
        // A cold start from the share sheet: the shell takes the item when it starts (AASC-21).
        ShareInbox.INSTANCE.accept(getIntent(), getPackageName());
        super.onCreate(savedInstanceState);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        // Shared while running: the Mac's page may be showing, so go back to the shell to pick a session.
        if (ShareInbox.INSTANCE.accept(intent, getPackageName()) && getBridge() != null) {
            getBridge().getWebView().loadUrl(getBridge().getLocalUrl() + "/?share=1");
        }
    }

    @Override
    public void onPause() {
        super.onPause();
        pausedAt = System.currentTimeMillis();
    }

    @Override
    public void onResume() {
        super.onResume();
        // With the lock on and a Mac's page showing, the shell decides whether to ask (LockRules).
        if (getBridge() == null || getBridge().getWebView() == null) return;
        String settings = getSharedPreferences(LockRules.PREFS, Context.MODE_PRIVATE).getString(LockRules.SETTINGS_KEY, null);
        String target = LockRules.INSTANCE.resumeUrl(
            settings, getBridge().getLocalUrl(), getBridge().getWebView().getUrl(), pausedAt, System.currentTimeMillis());
        if (target != null) getBridge().getWebView().loadUrl(target);
    }
}
