/* ============================================================
 * mqtt-lite.js · 极简 MQTT 3.1.1 客户端（WebSocket 版，无依赖）
 * ============================================================
 * 为什么自己写：只用到"连上 → 订阅一个主题 → 收消息 / 发一条消息"，
 * 手写比引入整个 MQTT 库更小、更可控，也方便在 Node 里跑测试。
 *
 * 浏览器：<script src="./mqtt-lite.js"></script> → window.MuseMQTT
 * Node  ：require("./mqtt-lite.js")（测试用）
 * ============================================================ */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.MuseMQTT = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  /* ---------- 编码 ---------- */
  function varint(n) {
    const out = [];
    do { let b = n % 128; n = Math.floor(n / 128); if (n > 0) b |= 0x80; out.push(b); } while (n > 0);
    return out;
  }
  const utf8 = (s) => { const b = enc.encode(String(s)); return [b.length >> 8, b.length & 255, ...b]; };
  const u16 = (n) => [(n >> 8) & 255, n & 255];
  function frame(header, body) { return new Uint8Array([header, ...varint(body.length), ...body]); }

  function connectPacket(clientId, keepalive) {
    const body = [...utf8("MQTT"), 4, 0x02, ...u16(keepalive), ...utf8(clientId)];
    return frame(0x10, body);
  }
  function subscribePacket(packetId, topics) {
    const body = [...u16(packetId)];
    for (const t of topics) body.push(...utf8(t), 0);
    return frame(0x82, body);
  }
  function publishPacket(topic, payload) {
    const body = [...utf8(topic), ...enc.encode(String(payload))];
    return frame(0x30, body);
  }
  const pingPacket = () => new Uint8Array([0xc0, 0x00]);
  const disconnectPacket = () => new Uint8Array([0xe0, 0x00]);

  /* ---------- 解码 ---------- */
  function decodeVarint(bytes, i) {
    let mult = 1, value = 0, b;
    do { b = bytes[i++]; value += (b & 127) * mult; mult *= 128; } while (b & 128);
    return { value, next: i };
  }

  /* 从一段字节里切出所有完整包（WebSocket 可能把多个包放在一帧里） */
  function parse(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const out = [];
    let i = 0;
    while (i < bytes.length) {
      if (i + 1 >= bytes.length) break;
      const header = bytes[i];
      const lenInfo = decodeVarint(bytes, i + 1);
      const start = lenInfo.next;
      const end = start + lenInfo.value;
      if (end > bytes.length) break;
      out.push(decodePacket(header, bytes.subarray(start, end)));
      i = end;
    }
    return out;
  }

  function decodePacket(header, body) {
    const type = header >> 4;
    if (type === 2) return { type: "connack", ok: body[1] === 0, code: body[1] };
    if (type === 9) return { type: "suback" };
    if (type === 13) return { type: "pingresp" };
    if (type === 3) {
      const qos = (header >> 1) & 3;
      const tlen = (body[0] << 8) | body[1];
      const topic = dec.decode(body.subarray(2, 2 + tlen));
      let p = 2 + tlen;
      let packetId = null;
      if (qos > 0) { packetId = (body[p] << 8) | body[p + 1]; p += 2; }
      return { type: "publish", topic, qos, packetId, payload: dec.decode(body.subarray(p)) };
    }
    return { type: "other", raw: type };
  }

  /* ---------- 客户端 ---------- */
  function createClient(opts) {
    const o = opts || {};
    const url = o.url || "wss://broker.emqx.io:8084/mqtt";
    const topics = Array.isArray(o.topics) ? o.topics.filter(Boolean) : [];
    const clientId = o.clientId || "qbjd-" + Math.random().toString(36).slice(2, 10);
    const wsProtocol = o.protocol === null ? null : (o.protocol || "mqtt");   /* 公共 MQTT 服务器要求子协议 mqtt */
    const keepalive = 45;
    let ws = null, stopped = false, reconnectTimer = null, pingTimer = null, watchdog = null;
    let backoff = 2000, packetId = 1, lastPong = 0, state = "idle";

    const setState = (s) => {
      if (state === s) return;
      state = s;
      try { o.onState && o.onState(s); } catch (_) {}
    };
    const scheduleReconnect = () => {
      if (stopped) return;
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 30000);
    };
    const cleanup = () => {
      clearInterval(pingTimer); clearInterval(watchdog);
      pingTimer = null; watchdog = null;
      if (ws) { try { ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null; ws.close(); } catch (_) {} }
      ws = null;
    };

    function connect() {
      if (stopped || !topics.length) return;
      setState("connecting");
      try {
        ws = wsProtocol ? new WebSocket(url, [wsProtocol]) : new WebSocket(url);
        ws.binaryType = "arraybuffer";
      } catch (e) { setState("error"); scheduleReconnect(); return; }

      ws.onopen = () => {
        try {
          ws.send(connectPacket(clientId, keepalive));
        } catch (_) { scheduleReconnect(); }
      };
      ws.onmessage = (ev) => {
        let packets;
        try { packets = parse(ev.data); } catch (_) { return; }
        for (const p of packets) {
          if (p.type === "connack") {
            if (!p.ok) { setState("error"); try { ws.close(); } catch (_) {} return; }
            backoff = 2000;
            setState("online");
            try { ws.send(subscribePacket(packetId++, topics)); } catch (_) {}
            lastPong = Date.now();
            clearInterval(pingTimer);
            pingTimer = setInterval(() => { try { ws.send(pingPacket()); } catch (_) {} }, keepalive * 1000 * 0.7);
            clearInterval(watchdog);
            watchdog = setInterval(() => {
              if (Date.now() - lastPong > keepalive * 2000) { try { ws.close(); } catch (_) {} }
            }, 15000);
          } else if (p.type === "pingresp") {
            lastPong = Date.now();
          } else if (p.type === "publish") {
            if (p.qos === 1 && p.packetId != null) {
              try { ws.send(new Uint8Array([0x40, 0x02, (p.packetId >> 8) & 255, p.packetId & 255])); } catch (_) {}
            }
            let data = p.payload;
            try { data = JSON.parse(p.payload); } catch (_) {}
            try { o.onMessage && o.onMessage(p.topic, data); } catch (_) {}
          }
        }
      };
      ws.onclose = () => { cleanup(); setState("offline"); scheduleReconnect(); };
      ws.onerror = () => { setState("error"); };
    }

    return {
      start: connect,
      stop() {
        stopped = true;
        clearTimeout(reconnectTimer);
        try { if (ws && state === "online") ws.send(disconnectPacket()); } catch (_) {}
        cleanup();
        setState("closed");
      },
      publish(topic, obj) {
        if (!ws || state !== "online" || !topic) return false;
        try {
          ws.send(publishPacket(topic, typeof obj === "string" ? obj : JSON.stringify(obj)));
          return true;
        } catch (_) { return false; }
      },
      get state() { return state; },
    };
  }

  return {
    version: "1.0.0",
    encode: { connectPacket, subscribePacket, publishPacket, pingPacket, disconnectPacket, varint },
    decode: { parse, decodeVarint },
    createClient,
  };
});
