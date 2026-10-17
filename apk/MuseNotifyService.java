package com.qbjd.muse;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;

import javax.net.ssl.SSLParameters;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;

/**
 * 常驻前台服务：自己连 MQTT，收到事件就发系统通知。
 * 这样即使 App 界面被关掉，只要服务活着就能收到（国产 ROM 需要用户加省电白名单）。
 * 没有第三方依赖：MQTT 3.1.1 只用 CONNECT / SUBSCRIBE / PUBLISH / PINGREQ 四个包。
 */
public class MuseNotifyService extends Service {
    public static final String PREFS = "muse_notify";
    public static final String CH_SERVICE = "qbjd_service";
    public static final String CH_EVENTS = "qbjd_events";
    public static final int ID_SERVICE = 7101;
    private static final String TAG = "MuseNotify";

    private volatile boolean running = false;
    private Thread worker;

    @Override
    public void onCreate() {
        super.onCreate();
        createChannels();
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(ID_SERVICE, serviceNotification(), android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        } else {
            startForeground(ID_SERVICE, serviceNotification());
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && "stop".equals(intent.getAction())) {
            stopSelf();
            return START_NOT_STICKY;
        }
        if (!running) {
            running = true;
            worker = new Thread(this::loop, "muse-mqtt");
            worker.setDaemon(true);
            worker.start();
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        running = false;
        if (worker != null) worker.interrupt();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    /* ---------------- 通知渠道 ---------------- */
    private void createChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm == null) return;
        NotificationChannel svc = new NotificationChannel(CH_SERVICE, "守护中", NotificationManager.IMPORTANCE_MIN);
        svc.setDescription("保持连接，及时收到朋友们的动态");
        svc.setShowBadge(false);
        nm.createNotificationChannel(svc);
        NotificationChannel ev = new NotificationChannel(CH_EVENTS, "回忆动态", NotificationManager.IMPORTANCE_HIGH);
        ev.setDescription("有人上传照片、点赞或评论你时提醒");
        ev.enableVibration(true);
        nm.createNotificationChannel(ev);
    }

    private Notification serviceNotification() {
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pi = PendingIntent.getActivity(this, 0, open,
                PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0));
        return new NotificationCompat.Builder(this, CH_SERVICE)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle("QBJD MUSE")
                .setContentText("回忆收集站正在守护，新动态会第一时间提醒你")
                .setOngoing(true)
                .setPriority(NotificationCompat.PRIORITY_MIN)
                .setContentIntent(pi)
                .build();
    }

    /* ---------------- 连接循环 ---------------- */
    private void loop() {
        int backoff = 2000;
        while (running) {
            SharedPreferences sp = getSharedPreferences(PREFS, MODE_PRIVATE);
            String host = sp.getString("host", "");
            String topic = sp.getString("topic", "");
            String user = sp.getString("user", "");
            if (host.isEmpty() || topic.isEmpty()) {
                sleep(5000);
                continue;
            }
            try {
                runConnection(host, 8883, topic, user);
                backoff = 2000;
            } catch (Exception e) {
                Log.w(TAG, "连接断开: " + e);
            }
            if (!running) break;
            sleep(backoff);
            backoff = Math.min(backoff * 2, 60000);
        }
    }

    private void runConnection(String host, int port, String topic, String user) throws Exception {
        SSLSocketFactory f = (SSLSocketFactory) SSLSocketFactory.getDefault();
        SSLSocket socket = (SSLSocket) f.createSocket();
        socket.connect(new InetSocketAddress(host, port), 15000);
        SSLParameters params = socket.getSSLParameters();
        params.setEndpointIdentificationAlgorithm("HTTPS");   /* 同时启用 SNI 和证书校验 */
        socket.setSSLParameters(params);
        socket.startHandshake();
        socket.setSoTimeout(60000);
        Log.i(TAG, "已连接 " + host + ":" + port);

        OutputStream out = socket.getOutputStream();
        DataInputStream in = new DataInputStream(socket.getInputStream());
        String clientId = "qbjd-android-" + Long.toHexString(System.currentTimeMillis());

        write(out, connectPacket(clientId));
        byte[] ack = readPacket(in);
        if (ack == null || (ack[0] >> 4) != 2 || ack.length < 3 || ack[2] != 0) throw new Exception("CONNACK 失败");
        write(out, subscribePacket(1, topic));
        Log.i(TAG, "已订阅 " + topic + " (user=" + user + ")");

        long lastRx = System.currentTimeMillis();
        long lastPing = 0;
        while (running) {
            try {
                byte[] pkt = readPacket(in);
                if (pkt == null) throw new Exception("连接被关闭");
                lastRx = System.currentTimeMillis();
                int type = (pkt[0] >> 4) & 0x0f;
                if (type == 3) {
                    handlePublish(pkt);
                } else if (type == 13) {
                    /* PINGRESP */
                } else if (type == 9) {
                    Log.i(TAG, "订阅成功");
                }
            } catch (java.net.SocketTimeoutException te) {
                /* 读超时：发心跳；太久没有任何数据就重连 */
                long now = System.currentTimeMillis();
                if (now - lastRx > 120000) throw new Exception("心跳超时");
                if (now - lastPing > 30000) { write(out, new byte[]{(byte) 0xc0, 0x00}); lastPing = now; }
            }
        }
        try { socket.close(); } catch (Exception ignored) {}
    }

    /* ---------------- MQTT 包 ---------------- */
    private static byte[] varint(int n) {
        ByteArrayOutputStream o = new ByteArrayOutputStream();
        do {
            int b = n % 128;
            n /= 128;
            if (n > 0) b |= 0x80;
            o.write(b);
        } while (n > 0);
        return o.toByteArray();
    }

    private static byte[] utf8(String s) {
        byte[] b = s.getBytes(StandardCharsets.UTF_8);
        byte[] out = new byte[b.length + 2];
        out[0] = (byte) ((b.length >> 8) & 0xff);
        out[1] = (byte) (b.length & 0xff);
        System.arraycopy(b, 0, out, 2, b.length);
        return out;
    }

    private static byte[] packet(int header, byte[] body) {
        byte[] len = varint(body.length);
        byte[] out = new byte[1 + len.length + body.length];
        out[0] = (byte) header;
        System.arraycopy(len, 0, out, 1, len.length);
        System.arraycopy(body, 0, out, 1 + len.length, body.length);
        return out;
    }

    private static byte[] connectPacket(String clientId) {
        ByteArrayOutputStream body = new ByteArrayOutputStream();
        try {
            body.write(utf8("MQTT"));
            body.write(4);          /* 协议级别 3.1.1 */
            body.write(0x02);       /* clean session */
            body.write(0);
            body.write(60);         /* keepalive 60s */
            body.write(utf8(clientId));
        } catch (Exception ignored) {}
        return packet(0x10, body.toByteArray());
    }

    private static byte[] subscribePacket(int id, String topic) {
        ByteArrayOutputStream body = new ByteArrayOutputStream();
        try {
            body.write((id >> 8) & 0xff);
            body.write(id & 0xff);
            body.write(utf8(topic));
            body.write(0);          /* QoS 0 */
        } catch (Exception ignored) {}
        return packet(0x82, body.toByteArray());
    }

    private static void write(OutputStream out, byte[] data) throws Exception {
        synchronized (MuseNotifyService.class) {
            out.write(data);
            out.flush();
        }
    }

    /** 读一个完整包：返回 [固定头字节, ...包体]（剩余长度可能是多字节，不留在结果里） */
    private static byte[] readPacket(DataInputStream in) throws Exception {
        int header;
        try { header = in.readUnsignedByte(); } catch (java.io.EOFException e) { return null; }
        int mult = 1, len = 0, b;
        do {
            b = in.readUnsignedByte();
            len += (b & 127) * mult;
            mult *= 128;
        } while ((b & 128) != 0);
        byte[] body = new byte[len];
        in.readFully(body);
        byte[] out = new byte[len + 1];
        out[0] = (byte) header;
        System.arraycopy(body, 0, out, 1, len);
        return out;
    }

    /* ---------------- 收到消息 → 系统通知 ---------------- */
    private void handlePublish(byte[] pkt) {
        try {
            int i = 1;                       /* 跳过固定头 */
            int tlen = ((pkt[i] & 0xff) << 8) | (pkt[i + 1] & 0xff);
            i += 2;
            String topic = new String(Arrays.copyOfRange(pkt, i, i + tlen), StandardCharsets.UTF_8);
            i += tlen;
            String payload = new String(Arrays.copyOfRange(pkt, i, pkt.length), StandardCharsets.UTF_8);
            Log.i(TAG, "收到 " + topic + " → " + payload);
            JSONObject ev = new JSONObject(payload);
            String type = ev.optString("type");
            String actor = ev.optString("actor", "有人");
            String text = ev.optString("text", "");
            String title;
            String body;
            if ("new_photo".equals(type)) { title = "新的回忆"; body = actor + " 上传了一张照片"; }
            else if ("like_photo".equals(type)) { title = "新的赞"; body = actor + " 赞了你的照片"; }
            else if ("comment_photo".equals(type)) { title = "新评论"; body = actor + " 评论了你的照片" + (text.isEmpty() ? "" : "：" + text); }
            else if ("like_comment".equals(type)) { title = "新的赞"; body = actor + " 赞了你的评论"; }
            else if ("reply_comment".equals(type)) { title = "新回复"; body = actor + " 回复了你的评论" + (text.isEmpty() ? "" : "：" + text); }
            else { title = "新动态"; body = actor + " 有新动态"; }
            post(title, body, ev.optString("photoId", ""), ev.optString("commentId", ""));
        } catch (Exception e) {
            Log.w(TAG, "解析消息失败: " + e);
        }
    }

    private void post(String title, String body, String photoId, String commentId) {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission("android.permission.POST_NOTIFICATIONS") != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            Log.w(TAG, "没有通知权限，忽略本次提醒");
            return;
        }
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        open.putExtra("photoId", photoId);
        open.putExtra("commentId", commentId);
        int req = (int) (System.currentTimeMillis() & 0x7fffffff);
        PendingIntent pi = PendingIntent.getActivity(this, req, open,
                PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0));
        Notification n = new NotificationCompat.Builder(this, CH_EVENTS)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                .setAutoCancel(true)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setDefaults(NotificationCompat.DEFAULT_ALL)
                .setContentIntent(pi)
                .build();
        try {
            NotificationManagerCompat.from(this).notify(req, n);
        } catch (SecurityException e) {
            Log.w(TAG, "发通知失败: " + e);
        }
    }

    private static void sleep(long ms) {
        try { Thread.sleep(ms); } catch (InterruptedException ignored) {}
    }
}
