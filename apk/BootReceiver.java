package com.qbjd.muse;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;

/** 手机重启后把守护服务拉起来（配合省电白名单，通知才不容易断） */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null) return;
        if (!Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) return;
        SharedPreferences sp = context.getSharedPreferences(MuseNotifyService.PREFS, Context.MODE_PRIVATE);
        if (!sp.getBoolean("enabled", false)) return;
        Intent svc = new Intent(context, MuseNotifyService.class);
        try {
            if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(svc);
            else context.startService(svc);
        } catch (Exception ignored) {
            /* Android 12+ 后台启动前台服务可能被系统拒绝：下次打开 App 会自动恢复 */
        }
    }
}
