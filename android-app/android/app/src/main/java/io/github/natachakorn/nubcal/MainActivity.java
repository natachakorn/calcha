package io.github.natachakorn.nubcal;

import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Bundle;
import androidx.core.content.pm.PackageInfoCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        clearWebCacheAfterUpdate();
    }

    // The app shows the live site; after installing a new APK, drop the WebView's HTTP cache so the
    // newest web version loads at once. Saved meals and the profile live in storage, which is kept.
    private void clearWebCacheAfterUpdate() {
        SharedPreferences prefs = getSharedPreferences("nubcal", MODE_PRIVATE);
        long current;
        try {
            current = PackageInfoCompat.getLongVersionCode(getPackageManager().getPackageInfo(getPackageName(), 0));
        } catch (PackageManager.NameNotFoundException e) {
            return;
        }
        if (prefs.getLong("lastVersionCode", 0) != current) {
            getBridge().getWebView().clearCache(true);
            prefs.edit().putLong("lastVersionCode", current).apply();
        }
    }
}
