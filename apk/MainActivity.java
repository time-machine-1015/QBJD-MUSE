package com.qbjd.muse;

import android.content.Intent;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(MuseNotifyPlugin.class);
        super.onCreate(savedInstanceState);
        captureTarget(getIntent());
    }

    @Override
    public void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        captureTarget(intent);
    }

    private void captureTarget(Intent intent) {
        if (intent == null) return;
        String photoId = intent.getStringExtra("photoId");
        String commentId = intent.getStringExtra("commentId");
        if (photoId != null && !photoId.isEmpty()) {
            MuseNotifyPlugin.setPendingTarget(photoId, commentId);
            intent.removeExtra("photoId");
            intent.removeExtra("commentId");
        }
    }
}
