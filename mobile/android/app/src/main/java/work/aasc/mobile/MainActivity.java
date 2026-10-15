package work.aasc.mobile;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // The app's own plugins (AASC-17): both serve the bundled shell page only.
        registerPlugin(DeviceVaultPlugin.class);
        registerPlugin(ShellBridgePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
