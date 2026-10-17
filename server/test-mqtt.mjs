/* ============================================================
 * MQTT 通道测试
 *  1) 编解码（不联网）
 *  2) 真实连一次公共 MQTT 服务器：订阅自己的主题 → 发一条 → 收到（验证国内可达 + 秒级送达）
 * 跑法：node server/test-mqtt.mjs
 * ============================================================ */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const MQTT = require("../mqtt-lite.js");

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra !== undefined ? "  → " + JSON.stringify(extra) : "")); }
};

console.log("\n[1] 编解码");
{
  check("剩余长度 varint 0", JSON.stringify(MQTT.encode.varint(0)) === "[0]");
  check("剩余长度 varint 127", JSON.stringify(MQTT.encode.varint(127)) === "[127]");
  check("剩余长度 varint 128", JSON.stringify(MQTT.encode.varint(128)) === "[128,1]");
  check("剩余长度 varint 321", JSON.stringify(MQTT.encode.varint(321)) === "[193,2]");

  const pub = MQTT.encode.publishPacket("qbjd/x/u/a", JSON.stringify({ type: "like_photo", actor: "b" }));
  const packets = MQTT.decode.parse(pub);
  check("PUBLISH 能原样解析回来",
    packets.length === 1 && packets[0].type === "publish" && packets[0].topic === "qbjd/x/u/a" &&
    JSON.parse(packets[0].payload).type === "like_photo", packets);

  const two = new Uint8Array([...MQTT.encode.publishPacket("a", "1"), ...MQTT.encode.publishPacket("b", "2")]);
  const both = MQTT.decode.parse(two);
  check("一帧里粘了两个包也能拆开", both.length === 2 && both[0].payload === "1" && both[1].payload === "2");

  const conn = MQTT.encode.connectPacket("client-1", 45);
  const text = Buffer.from(conn).toString("latin1");
  check("CONNECT 包结构正确（协议名/级别/keepalive/clientId）",
    conn[0] === 0x10 && text.includes("MQTT") && text.includes("client-1") && conn.includes(4));
  const sub = MQTT.encode.subscribePacket(7, ["t/1"]);
  check("SUBSCRIBE 包头与主题正确", sub[0] === 0x82 && Buffer.from(sub).toString("latin1").includes("t/1"));
  check("PINGREQ / DISCONNECT 正确", MQTT.encode.pingPacket()[0] === 0xc0 && MQTT.encode.disconnectPacket()[0] === 0xe0);
}

console.log("\n[2] 真实通道（公共 MQTT 服务器）");
const topic = "qbjd/selftest/" + Math.random().toString(36).slice(2, 10) + "/u/tester";
const received = await new Promise((resolve) => {
  let timer = null;
  const client = MQTT.createClient({
    url: "wss://broker.emqx.io:8084/mqtt",
    clientId: "qbjd-test-" + Math.random().toString(36).slice(2, 8),
    topics: [topic],
    onState(s) {
      console.log("    连接状态: " + s);
      if (s === "online") {
        setTimeout(() => client.publish(topic, { type: "hello", at: Date.now() }), 400);
      }
      if (s === "error" || s === "offline") { /* 等重连，超时兜底 */ }
    },
    onMessage(t, data) {
      clearTimeout(timer);
      client.stop();
      resolve({ topic: t, data });
    },
  });
  timer = setTimeout(() => { client.stop(); resolve(null); }, 20000);
  client.start();
});
check("连上公共 MQTT 并收到自己发的消息（端到端）",
  received && received.topic === topic && received.data && received.data.type === "hello", received);

console.log(`\n结果：${pass} 项通过，${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
