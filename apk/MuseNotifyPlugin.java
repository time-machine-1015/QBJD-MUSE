package com.qbjd.muse;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 网页 ↔ 原生 的桥：网页登录后把 MQTT 主题交给这里，服务就能在后台收通知。
 * 另外提供：通知权限申请、电池白名单入口、点通知后的跳转目标。
 */
@CapacitorPlugin(name = "MuseNotify")
public class MuseNotifyPlugin extends Plugin {
    private static JSObject pendingTarget = null;

    public static void setPendingTarget(String photoId, String commentId) {
        if (photoId == null || photoId.isEmpty()) return;
        JSObject o = new JSObject();
        o.put("photoId", photoId);
        o.put("commentId", commentId == null ? "" : commentId);
        pendingTarget = o;
    }

    @PluginMethod
    public void start(PluginCall call) {
        String topic = call.getString("topic", "");
        String url = call.getString("url", "");
        String user = call.getString("user", "");
        if (topic == null || topic.isEmpty() || url == null || url.isEmpty()) {
            call.reject("缺少 topic / url");
            return;
        }
        String host = hostOf(url);
        SharedPreferences sp = getContext().getSharedPreferences(MuseNotifyService.PREFS, Context.MODE_PRIVATE);
        sp.edit().putString("topic", topic).putString("host", host).putString("user", user).putBoolean("enabled", true).apply();

        ensurePermission();

        Context ctx = getContext();
        Intent svc = new Intent(ctx, MuseNotifyService.class);
        if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(svc);
        else ctx.startService(svc);
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        SharedPreferences sp = getContext().getSharedPreferences(MuseNotifyService.PREFS, Context.MODE_PRIVATE);
        sp.edit().putBoolean("enabled", false).remove("topic").apply();
        Intent svc = new Intent(getContext(), MuseNotifyService.class).setAction("stop");
        getContext().stopService(svc);
        call.resolve();
    }

    @PluginMethod
    public void status(PluginCall call) {
        SharedPreferences sp = getContext().getSharedPreferences(MuseNotifyService.PREFS, Context.MODE_PRIVATE);
        JSObject o = new JSObject();
        o.put("enabled", sp.getBoolean("enabled", false));
        o.put("topic", sp.getString("topic", ""));
        o.put("host", sp.getString("host", ""));
        PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
        o.put("ignoringBatteryOptimizations", pm != null && pm.isIgnoringBatteryOptimizations(getContext().getPackageName()));
        call.resolve(o);
    }

    @PluginMethod
    public void takePendingTarget(PluginCall call) {
        JSObject o = pendingTarget;
        pendingTarget = null;
        if (o == null) call.resolve(new JSObject());
        else call.resolve(o);
    }

    /** 申请通知权限（Android 13+），失败也不影响其它功能 */
    @PluginMethod
    public void ensurePermission(PluginCall call) {
        ensurePermission();
        if (call != null) call.resolve();
    }

    private void ensurePermission() {
        if (Build.VERSION.SDK_INT >= 33) {
            try {
                if (getActivity().checkSelfPermission("android.permission.POST_NOTIFICATIONS")
                        != android.content.pm.PackageManager.PERMISSION_GRANTED) {
                    getActivity().requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"}, 9001);
                }
            } catch (Exception ignored) {}
        }
    }

    /** 拉起"允许后台运行"设置，减少被国产 ROM 杀掉后台的概率 */
    @PluginMethod
    public void openBatterySettings(PluginCall call) {
        Context ctx = getContext();
        try {
            if (Build.VERSION.SDK_INT >= 23) {
                PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
                if (pm != null && !pm.isIgnoringBatteryOptimizations(ctx.getPackageName())) {
                    Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
                    i.setData(Uri.parse("package:" + ctx.getPackageName()));
                    i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    ctx.startActivity(i);
                    call.resolve();
                    return;
                }
            }
            Intent i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
            i.setData(Uri.parse("package:" + ctx.getPackageName()));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(i);
            call.resolve();
        } catch (Exception e) {
            call.reject("打不开设置：" + e.getMessage());
        }
    }

    private static String hostOf(String url) {
        try {
            String s = url.replaceFirst("^wss?://", "").replaceFirst("^https?://", "");
            int slash = s.indexOf('/');
            if (slash > 0) s = s.substring(0, slash);
            int colon = s.indexOf(':');
            if (colon > 0) s = s.substring(0, colon);
            return s;
        } catch (Exception e) {
            return "broker.emqx.io";
        }
    }
}
