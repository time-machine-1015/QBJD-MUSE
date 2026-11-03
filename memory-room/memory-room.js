(function () {
  "use strict";

  /* ============================================================
     回忆收存室 v2 · three.js 3D 点云 + 按住说话 + IndexedDB 存档
     照片按亮度映射 Z 深度（亮远暗近）+ 边缘隧道弯曲
     星尘发光点精灵（加色混合）· 时间驱动动画 · 帧率无关
     ============================================================ */

  var MAX_RECORD_MS = 60 * 1000;
  var HINT_TEXT = "按住 · 录下你对这张照片想说的话";
  /* 调试用：?photo=xxx.png 直接指定素材；?static=1 跳过凝聚动画，便于截图比对 */
  var QS = new URLSearchParams(location.search);
  var STATIC = QS.get("static") === "1";
  var ZMODE = QS.get("zmode") || "rand";   /* layer | rand（对照实验） */
  var STAY = QS.get("stay") === "1";       /* 调试：关掉自动回正，方便截图 */
  var DOTK = parseFloat(QS.get("dot") || "0") || 0;   /* 调试：覆盖点径系数 */

  var root = document.getElementById("memory-room");
  if (!root || root.dataset.mrInit) return;
  root.dataset.mrInit = "1";

  var $ = function (id) { return document.getElementById(id); };
  var cvA = root.querySelector(".mr-canvas--ambience");
  var cvP = root.querySelector(".mr-canvas--particles");
  var ctxA = cvA.getContext("2d");

  var elSave     = $("mr-btn-save");
  var elDiscard  = $("mr-btn-discard");
  var elTimer    = $("mr-timer");
  var elClose    = $("mr-btn-close");
  var elSpeak    = $("mr-speak");
  var elTran     = $("mr-transcript");
  var elTranRole = $("mr-transcript-role");
  var elTranText = $("mr-transcript-text");
  var elStatus   = $("mr-status");
  var elCoord    = $("mr-coord");
  var elLoading  = $("mr-loading");
  var elLoadPct  = $("mr-loading-pct");
  var elToast    = $("mr-toast");
  var drawer     = $("mr-drawer");
  var veil       = $("mr-veil");
  var drawerList = $("mr-drawer-list");
  var drawerSub  = $("mr-drawer-sub");
  var archTrig   = root.querySelector(".mr-archive-trigger");
  var archCount  = archTrig.querySelector(".mr-count");

  /* ---------------- 小工具 ---------------- */
  function toast(msg, ms) {
    elToast.textContent = msg;
    elToast.classList.add("is-visible");
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { elToast.classList.remove("is-visible"); }, ms || 2600);
  }
  function fmtDate(ts) {
    var d = new Date(ts);
    var p = function (n) { return (n < 10 ? "0" : "") + n; };
    return d.getFullYear() + "." + p(d.getMonth() + 1) + "." + p(d.getDate()) +
           "  " + p(d.getHours()) + ":" + p(d.getMinutes());
  }
  function fmtMS(ms) {
    var s = Math.max(0, Math.round(ms / 1000));
    var m = Math.floor(s / 60);
    return (m < 10 ? "0" : "") + m + ":" + ((s % 60) < 10 ? "0" : "") + (s % 60);
  }

  /* ---------------- 大家的回忆（音频列表，由宿主注入） ---------------- */
  var voices = [];   /* [{ id, author, audioUrl, createdAt, duration }] */
  var currentUser = "";   /* 当前登录名（宿主注入），用于判断能否删除 */
  var bridge = null;      /* 宿主注入的桥接对象 { onRecord(blob, durationMs), onDelete(voiceId) } */
  var audioEl = null, playingVoiceId = null;

  /* ---------------- 尺寸 / DPR ---------------- */
  var W = 0, H = 0, DPR = 1;
  function resize() {
    var r = root.getBoundingClientRect();
    W = Math.max(1, Math.round(r.width));
    H = Math.max(1, Math.round(r.height));
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    cvA.width = Math.round(W * DPR);
    cvA.height = Math.round(H * DPR);
    ctxA.setTransform(DPR, 0, 0, DPR, 0, 0);
    drawAmbience();
    if (renderer) {
      renderer.setPixelRatio(DPR);
      renderer.setSize(W, H, false);
      camera.aspect = W / H;
      camera.updateProjectionMatrix();
      /* 世界单位→设备像素：不含相机距离，距离由 shader 的 /-mv.z 承担（不可重复换算） */
      if (points) points.material.uniforms.uScale.value = (H * DPR) / (2 * Math.tan(FOV * Math.PI / 360));
      /* 关键：EffectComposer 构造时抓的是当时的 pixelRatio(=1)，不显式设置的话
         整个后处理链会按 CSS 分辨率跑，再被放大回设备像素 —— 全屏模糊 2 倍 */
      if (composer) { composer.setPixelRatio(DPR); composer.setSize(W, H); }
    }
    if (photo.blob) buildParticles(true);
  }

  /* ---------------- 氛围层：用照片主色染色的暗场 ----------------
     参考站点之所以"活"，一半功劳在这里：底色不是死黑 #000，
     而是 #0b0806 + 两层跟着照片主色走的径向渐变。 */
  function drawAmbience() {
    ctxA.clearRect(0, 0, W, H);
    ctxA.fillStyle = "#0b0806";
    ctxA.fillRect(0, 0, W, H);

    var d = photo.domColor || [0.52, 0.40, 0.28];
    var cr = Math.round(d[0] * 255), cg = Math.round(d[1] * 255), cb = Math.round(d[2] * 255);
    var mid = function (k) {
      return "rgba(" + Math.round(cr * k) + "," + Math.round(cg * k) + "," + Math.round(cb * k) + ",";
    };
    var gx0 = W / 2, gy0 = H * 0.44;

    var g1 = ctxA.createRadialGradient(gx0, gy0, 0, gx0, gy0, Math.max(W, H) * 0.80);
    g1.addColorStop(0, mid(0.20) + "0.20)");
    g1.addColorStop(0.5, mid(0.42) + "0.10)");
    g1.addColorStop(1, "rgba(11,8,6,0)");
    ctxA.fillStyle = g1;
    ctxA.fillRect(0, 0, W, H);

    var g2 = ctxA.createRadialGradient(gx0, gy0, 0, gx0, gy0, Math.min(W, H) * 0.58);
    g2.addColorStop(0, mid(1.0) + "0.14)");
    g2.addColorStop(1, "rgba(0,0,0,0)");
    ctxA.fillStyle = g2;
    ctxA.fillRect(0, 0, W, H);

    /* 极细噪点：防止大面积渐变色带 */
    var n = Math.min(9000, Math.round(W * H / 90));
    for (var i = 0; i < n; i++) {
      var x = Math.random() * W, y = Math.random() * H;
      ctxA.fillStyle = Math.random() < 0.6
        ? "rgba(226,216,202," + (Math.random() * 0.040) + ")"
        : "rgba(255,255,255," + (Math.random() * 0.022) + ")";
      ctxA.fillRect(x, y, 1, 1);
    }
  }

  /* ============================================================
     three.js 场景：星尘点云
     ============================================================ */
  var renderer = null, scene = null, camera = null, points = null;
  var bokehPoints = null;      /* 外围散景光斑层（大颗虚化 bokeh） */
  var composer = null, bloomPass = null;
  var geoPos = null;
  var CAM_Z = 10, FOV = 55;
  var planeW = 10, planeH = 8;

  function initGL() {
    if (!window.THREE) {
      elLoading.classList.add("is-done");
      elLoadPct.textContent = "";
      elLoading.firstElementChild.textContent = "three.js 未加载";
      toast("three.min.js 缺失，粒子无法渲染");
      return false;
    }
    renderer = new THREE.WebGLRenderer({
      canvas: cvP, alpha: true, antialias: false,
      preserveDrawingBuffer: true, powerPreference: "high-performance"
    });
    renderer.setClearColor(0x000000, 0);
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(FOV, W / H, 0.1, 60);
    camera.position.set(0, 0, CAM_Z);

    var geo = new THREE.BufferGeometry();
    /* 空 geometry：buildParticles 时用真实数组重建 attribute（count 必须正确） */
    var mat = new THREE.ShaderMaterial({
      uniforms: {
        uScale: { value: 1 },   /* 设备像素/世界单位换算系数（resize 时更新） */
        uAlpha: { value: 1 }
      },
      vertexShader: [
        "attribute float aSize;",
        "attribute float aAlpha;",
        "attribute float aGlow;",
        "attribute vec3 color;",
        "varying vec3 vColor;",
        "varying float vA;",
        "varying float vGlow;",
        "uniform float uScale;",
        "void main() {",
        "  vColor = color;",
        "  vA = aAlpha;",
        "  vGlow = aGlow;",
        "  vec4 mv = modelViewMatrix * vec4(position, 1.0);",
        "  gl_PointSize = aSize * uScale / -mv.z;",
        "  gl_Position = projectionMatrix * mv;",
        "}"
      ].join("\n"),
      fragmentShader: [
        "precision mediump float;",
        "varying vec3 vColor;",
        "varying float vA;",
        "varying float vGlow;",
        "uniform float uAlpha;",
        "void main() {",
        "  vec2 d = gl_PointCoord - vec2(0.5);",
        "  float r2 = dot(d, d);",
        "  if (r2 > 0.25) discard;",
        /* 实核 80% 半径 + 极窄柔边：核心区密接成面，而不是靠堆叠点径去补
           （旧版 0.04~0.22 的宽柔边让 α≈1 的实核只剩 11%，永远漏黑缝） */
        "  float soft = 1.0 - smoothstep(0.04, 0.25, r2);",
        /* 显影/调色已整段在 CPU 端烘焙（toneColor），这里只补一点高光辉光给 bloom 拾取 */
        "  vec3 col = min(vColor + vGlow * 0.08 * vec3(1.0, 0.97, 0.92), vec3(1.0));",
        "  gl_FragColor = vec4(col, uAlpha * vA * soft);",
        "}"
      ].join("\n"),
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending /* 普通混合：照片暗部颜色不被吃掉 */
    });

    root3d = new THREE.Group();
    scene.add(root3d);
    points = new THREE.Points(geo, mat);
    root3d.add(points);

    /* 散景层：大颗虚化光斑（同 geometry），只在外围/亮部出现，营造参考图的 bokeh 光尘 */
    var bokehMat = new THREE.ShaderMaterial({
      uniforms: {
        uScale: mat.uniforms.uScale,  /* 与主层共享换算系数 */
        uAlpha: { value: 1 }
      },
      vertexShader: [
        "attribute float aSize;",
        "attribute float aAlpha;",
        "attribute vec3 color;",
        "varying vec3 vColor;",
        "varying float vA;",
        "uniform float uScale;",
        "void main() {",
        "  vColor = color;",
        "  vA = aAlpha;",
        "  vec4 mv = modelViewMatrix * vec4(position, 1.0);",
        "  gl_PointSize = aSize * uScale / -mv.z;",
        "  gl_Position = projectionMatrix * mv;",
        "}"
      ].join("\n"),
      fragmentShader: [
        "precision mediump float;",
        "varying vec3 vColor;",
        "varying float vA;",
        "uniform float uAlpha;",
        "void main() {",
        "  vec2 d = gl_PointCoord - vec2(0.5);",
        "  float r2 = dot(d, d);",
        "  if (r2 > 0.25) discard;",
        /* 柔和弥散：焦外光斑的观感，平方衰减让边缘更虚 */
        "  float soft = 1.0 - r2 * 4.0;",
        "  soft = soft * soft;",
        "  gl_FragColor = vec4(vColor, uAlpha * vA * soft);",
        "}"
      ].join("\n"),
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending /* 散景加色：只叠光，不遮主体 */
    });
    geoB = new THREE.BufferGeometry();
    bokehPoints = new THREE.Points(geoB, bokehMat);
    bokehPoints.frustumCulled = false;
    root3d.add(bokehPoints);

    /* 真 Bloom 后处理（对齐参考图的光雾质感）：阈上高光做高斯弥散再合成 */
    if (THREE.EffectComposer && THREE.UnrealBloomPass) {
      composer = new THREE.EffectComposer(renderer);
      composer.addPass(new THREE.RenderPass(scene, camera));
      bloomPass = new THREE.UnrealBloomPass(
        new THREE.Vector2(W, H),
        0.34,  /* strength：光雾强度 */
        0.62,  /* radius：弥散半径 */
        0.62   /* threshold：阈值下调，让网点自带的光晕也参与弥散 */
      );
      composer.addPass(bloomPass);
      var copyPass = new THREE.ShaderPass(THREE.CopyShader);
      copyPass.renderToScreen = true;
      composer.addPass(copyPass);
    }
    return true;
  }
  /* ---------------- 粒子（SoA 数组） ---------------- */
  var P = { n: 0,
    x: null, y: null, z: null, vx: null, vy: null, vz: null,
    hx: null, hy: null, hz: null,
    sx0: null, sy0: null, sz0: null, ax: null, ay: null, az: null,
    ph: null, amp: null, drift: null, delay: null
  };
  var mode = "assembling"; /* assembling | photo */
  /* 散景光尘层 */
  var B = { n: 0, hx: null, hy: null, hz: null, ph: null };
  var geoB = null, geoBPos = null;
  /* 成像层：屏幕自适应点阵平面（照片本体） */
  var planeMesh = null, planeMat = null, photoTex = null, PITCH = 1.6, yShiftCur = 0;
  var CELLS = { x: 96, y: 132 };   /* 图片长边的网点数（参考视频实测 ~135） */
  /* ===== 对齐参考站「氛围调节」面板的参数（滑杆 0~100，默认都是 50） ===== */
  /* 参考站的滑杆值域（从他们 XOR 混淆的参数表里解出来的）：
     [最小值, 中值(=滑杆50), 最大值, 低段指数, 高段指数] */
  var SPEC = {
    pointSize:    [0,     0.40, 1,    1.1, 1.3],
    depthStrength:[0,     0.80, 5,    1.2, 1.8],
    jitterStart:  [0,     15,   100,  1.25, 1.7],
    jitterStrength:[0,    0.65, 1,    1.2, 1.2],
    vignetteStart:[0,     0.50, 1.5,  1.2, 1.5],
    colorBoost:   [0,     0.18, 0.4,  1.1, 1.2],
    waveSpeed:    [0,     0.60, 1,    1.2, 1.3],
    waveAmp:      [0.2,   1.20, 4,    1.3, 1.7]
  };
  /* 滑杆 0~100 → 实际值（他们 d() 的反函数） */
  function sv(name, slider) {
    var sp = SPEC[name], a = sp[0], m = sp[1], b = sp[2], eLo = sp[3], eHi = sp[4];
    var t = Math.max(0, Math.min(100, slider));
    return t <= 50
      ? a + (m - a) * Math.pow(t / 50, eLo)
      : m + (b - m) * Math.pow((t - 50) / 50, eHi);
  }
  var TUNE = {
    quality: 100,   /* 画质：对应采样长边 300/400/500/600 */
    depth: 50,      /* 立体感 */
    size: 50,       /* 星星大小 */
    waveAmp: 50,    /* 起伏幅度 */
    waveSpeed: 50,  /* 起伏速度 */
    looseness: 50,  /* 松散程度 */
    loosenessRange: 50, /* 松散范围 */
    vignette: 50,   /* 暗角范围 */
    brightness: 50  /* 明亮度 */
  };
  /* 画质档 → 采样长边（他们的预设值） */
  function sampleLongSide() {
    var q = [300, 400, 500, 600];
    var k = Math.max(0, Math.min(3, Math.round(TUNE.quality / 100 * 3)));
    var v = q[k];
    return W < 640 ? Math.min(v, 400) : v;   /* 移动端封顶 400，防过载 */
  }
  /* 3D 旋转（对齐参考站点：Y 自由转，X 限 ±0.5rad，松手 1s 自动回正） */
  var root3d = null;
  var rot = { x: 0, y: 0 }, rotT = { x: 0, y: 0 };
  var dragging = false, lastXDrag = 0, lastYDrag = 0, lastActionAt = 0;
  /* 相机：dolly（滚轮/捏合）+ 环绕（指针） */
  var camZ = CAM_Z, camZTarget = CAM_Z, orbitYaw = 0, orbitPitch = 0;
  var ZMIN = CAM_Z * 0.30, ZMAX = CAM_Z * 2.05;
  var assembleStart = 0, assembleDur = 2200, assembleLabel = "凝聚中";
  var voiceEnergy = 0;
  var lastT = 0;
  var step0 = 0.05; /* 网格步长缓存（enterAssembling 用） */
  var WPP = 0.0123; /* 世界单位 / CSS 像素（buildParticles 时更新） */
  var pointer = { nx: 0, ny: 0, x: -9999, y: -9999, active: false };

  function easeOutCubic(k) { return 1 - Math.pow(1 - k, 3); }
  function smoothstep(a, b, x) {
    var t = Math.max(0, Math.min(1, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  }

  /* 显影曲线：CPU 端逐粒子烘焙。
     饱和度保留 → 暗部 gamma 抬升 → 极轻冷影 → S 形对比 → 高光滚降 → 边缘压暗。
     与离线仿真（sim.py / tune.py）完全同源，改这里必须同步改仿真。 */
  var TONE = { gamma: 0.82, contrast: 0.35, knee: 0.12, sat: 0.92, cool: 0.010 };
  function toneColor(r, g, b, vig) {
    var l = 0.299 * r + 0.587 * g + 0.114 * b;
    var k = TONE.sat;
    r = l * (1 - k) + r * k; g = l * (1 - k) + g * k; b = l * (1 - k) + b * k;

    r = Math.pow(Math.max(0, r), TONE.gamma);
    g = Math.pow(Math.max(0, g), TONE.gamma);
    b = Math.pow(Math.max(0, b), TONE.gamma);

    var cw = TONE.cool * (1 - l);
    r = Math.max(0, r - cw * 0.40);
    g = Math.max(0, g + cw * 0.15);
    b = Math.max(0, b + cw * 1.00);

    var kc = TONE.contrast;
    r = r * (1 - kc) + smoothstep(0.02, 0.98, r) * kc;
    g = g * (1 - kc) + smoothstep(0.02, 0.98, g) * kc;
    b = b * (1 - kc) + smoothstep(0.02, 0.98, b) * kc;

    r = r / (0.86 + r * TONE.knee);
    g = g / (0.86 + g * TONE.knee);
    b = b / (0.86 + b * TONE.knee);

    return [Math.min(1, r * vig), Math.min(1, g * vig), Math.min(1, b * vig)];
  }

  function enterAssembling(label, withVeil) {
    mode = "assembling";
    assembleStart = performance.now();
    assembleLabel = label || "凝聚中";
    elStatus.textContent = assembleLabel + " 0%";
    if (withVeil) {
      elLoading.classList.remove("is-done");
      elLoadPct.textContent = "0%";
    }
    /* 向心收拢（对齐参考「凝聚」叙事）：粒子从屏幕外圈出发，向照片位收拢
       出发点 = 家位沿径向反推到屏幕外 + 少量随机偏角；错峰 = 随个体延时
       半径按视口算（照片变小后不能用 plane 尺寸，否则出发点全落在画面内） */
    var RX = W * WPP * 0.62, RY = H * WPP * 0.62;
    for (var i = 0; i < P.n; i++) {
      P.sx0[i] = P.x[i]; P.sy0[i] = P.y[i]; P.sz0[i] = P.z[i];
      if (withVeil) {
        var hx = P.hx[i], hy = P.hy[i];
        var rr = Math.sqrt(hx * hx + hy * hy) || 1;
        /* 反推到屏幕外圈（保证至少在视野边界之外） */
        var push = 1.55 + Math.random() * 0.85;
        var bx = hx * push, by = hy * push;
        /* 保证出发一定在视野外 */
        bx = hx + (hx / rr) * RX * (0.8 + Math.random() * 0.6);
        by = hy + (hy / rr) * RY * (0.8 + Math.random() * 0.6);
        var ang = Math.random() * Math.PI * 2;
        var jR = step0 * (0.5 + Math.random() * 1.5);
        P.sx0[i] = bx + Math.cos(ang) * jR;
        P.sy0[i] = by + Math.sin(ang) * jR;
        P.sz0[i] = P.hz[i] + (Math.random() - 0.5) * planeH * 0.22;
        P.x[i] = P.sx0[i]; P.y[i] = P.sy0[i]; P.z[i] = P.sz0[i];
      }
      /* 飞行弧线（轻）+ 个体错峰（0~35% 时段） */
      var a = Math.random() * Math.PI * 2;
      var elv = Math.random() * Math.PI - Math.PI / 2;
      var arcR = 0.15 + Math.random() * 0.5;
      P.ax[i] = Math.cos(elv) * Math.cos(a) * arcR;
      P.ay[i] = Math.cos(elv) * Math.sin(a) * arcR;
      P.az[i] = Math.sin(elv) * arcR * 0.6;
      P.delay[i] = withVeil ? Math.random() * 0.35 : 0;
    }
  }

  var photo = { blob: null, img: null, url: null, name: "默认照片", domColor: null };

  function loadImage(blob) {
    return new Promise(function (res, rej) {
      var url = URL.createObjectURL(blob);
      var img = new Image();
      img.onload = function () { res({ img: img, url: url }); };
      img.onerror = function () { URL.revokeObjectURL(url); rej(new Error("图片解码失败")); };
      img.src = url;
    });
  }

  /* 构建点云：照片缩成悬浮的一小块，点距 1.15~1.9 CSS px 的细颗粒，核心区实心铺面
     —— 参考视频实测：成片只占屏宽约 38%~52%，颗粒点距约 1.2 CSS px，圆内覆盖率≈100% */
  function buildParticles(instant) {
    if (!photo.img || !renderer) { P.n = 0; return; }

    var img = photo.img;
    var VH = 2 * CAM_Z * Math.tan(FOV * Math.PI / 360);
    WPP = VH / H;                                  /* 世界单位 / CSS 像素（z=0 平面） */

    /* 显示盒：移动端约 52% 屏宽，桌面约 55% 宽 / 38% 高；contain 不裁切 */
    var bw = W < 640 ? W * 0.90 : W * 0.78;
    var bh = W < 640 ? H * 0.54 : H * 0.56;
    var fit = Math.min(bw / img.naturalWidth, bh / img.naturalHeight);
    var rwCss = img.naturalWidth * fit, rhCss = img.naturalHeight * fit;
    /* 整体上移，给底部「按住说话」控件和顶部章节标题让位 */
    var yShift = (W < 640 ? 0.050 : 0.060) * H * WPP;
    yShiftCur = yShift;

    planeW = rwCss * WPP;
    planeH = rhCss * WPP;

    /* 点距：按照片面积自适应，保持 1.15~1.9 CSS px 的细颗粒；粒子数落在 1.8~3.5 万 */
    var area = rwCss * rhCss;
    /* 密度：一个像素一个粒子（对齐参考站：长边 300/400/500/600） */
    var LONG = sampleLongSide();
    var longCss = Math.max(rwCss, rhCss);
    var pitch = Math.max(0.5, longCss / LONG);
    var cols = Math.max(8, Math.round(rwCss / pitch));
    var rows = Math.max(8, Math.round(rhCss / pitch));
    var sxw = planeW / cols, syw = planeH / rows;
    var pitchWorld = (sxw + syw) * 0.5;
    step0 = pitchWorld;
    PITCH = pitch;

    /* contain 采样：整张照片映射进 cols×rows 网格 */
    var off = document.createElement("canvas");
    off.width = cols; off.height = rows;
    var octx = off.getContext("2d", { willReadFrequently: true });
    if (octx) octx.drawImage(img, 0, 0, cols, rows);
    var data = null;
    try { data = octx.getImageData(0, 0, cols, rows).data; } catch (e) { P.n = 0; return; }

    var COVER = 2.30;      /* 点径 = 2.30 × 间距：实核占满 → 圆内无黑缝，靠 bloom 出光感 */
    var gx = [], gy = [], gz = [], gc = [], gs = [], ga = [], gg = [], gd = [];
    var bx = [], by = [], bz = [], bc = [], bs = [], ba = [], bph = [];

    for (var cy = 0; cy < rows; cy++) {
      for (var cx = 0; cx < cols; cx++) {
        var idx = (cy * cols + cx) * 4;
        var r = data[idx] / 255, g = data[idx + 1] / 255, b = data[idx + 2] / 255;
        var L = 0.299 * r + 0.587 * g + 0.114 * b;

        var nx = (cx + 0.5) / cols * 2 - 1;
        var ny = (cy + 0.5) / rows * 2 - 1;
        var rho = Math.sqrt(nx * nx + ny * ny);

        /* 椭圆抖动遮罩：中心实心，向外被噪声侵蚀成絮状边界（参考视频的圆团轮廓） */
        /* 松散范围 / 松散程度：边缘被噪声侵蚀的起点与烈度 */
        var js = sv("jitterStart", TUNE.loosenessRange);      /* 0~100，50 → 15 */
        var jstr = sv("jitterStrength", TUNE.looseness);       /* 0~1，50 → 0.65 */
        var d0 = 1.0 - 0.30 * (js / 100);                      /* 15 → 0.955，100 → 0.70 */
        var lp = 0.5 + 1.6 * jstr;
        var edge = 1 - smoothstep(d0, 1.05, rho);
        if (rho > d0 * 0.90 && Math.random() > Math.pow(edge, lp)) continue;

        var vig = 0.45 + 0.55 * Math.pow(edge, 0.75);   /* 边缘压暗，融进黑底 */
        var col = toneColor(r, g, b, vig);

        var jx = (Math.random() - 0.5) * sxw * 0.9;
        var jy = (Math.random() - 0.5) * syw * 0.9;
        var px0 = (cx + 0.5) * sxw - planeW / 2 + jx;
        var py0 = planeH / 2 - (cy + 0.5) * syw + jy + yShift;
        /* 真 3D：亮度 → 深度（暗近亮远）+ 一层随机壳厚，形成有体积的云 */
        /* 深度分层：把画面按亮度切成 N 层，每层放在不同的深度上
           —— 转起来是一叠错开的"剪纸"，不是一个被打散的随机云。 */
        /* 每一颗粒子的 z 都来自这张照片自己的内容：
           亮的地方（白墙、字、高光）往前顶，暗的地方往后沉。
           不是随机抖动，也不是按亮度切块，而是逐像素的真实深度。 */
        var ds = sv("depthStrength", TUNE.depth);            /* 0~5，默认 0.8 */
        var REL = parseFloat(QS.get("rel") || "0.45") || 0.45;
        var pz0 = (L - 0.5) * planeH * REL * (ds / 0.8)
                + (Math.random() - 0.5) * planeW * 0.008;

        gx.push(px0); gy.push(py0); gz.push(pz0);
        gc.push(col[0], col[1], col[2]);
        var ps = sv("pointSize", TUNE.size);               /* 0~1，50 → 0.4 */
        gs.push(pitchWorld * (DOTK > 0 ? DOTK : (1.05 + 0.85 * (ps / 0.4))));
        ga.push(Math.min(1, edge * 1.5) * (0.80 + 0.20 * Math.random()));
        gg.push(Math.max(0, Math.min(1, (L - 0.55) / 0.45)));
        gd.push((1 - edge) * 0.5);                      /* 只有外围会飘 */

        /* 散景：亮部里抽 2.5%，大颗、加色、z 抖开 → 参考视频里那种焦外光斑 */
        if (L > 0.40 && rho < 1.0 && Math.random() < 0.025) {
          bx.push(px0 + (Math.random() - 0.5) * sxw * 2.2);
          by.push(py0 + (Math.random() - 0.5) * syw * 2.2);
          bz.push(pz0 + (Math.random() - 0.5) * planeW * 0.30);
          bc.push(Math.min(1, col[0] * 1.20 + 0.04),
                  Math.min(1, col[1] * 1.18 + 0.04),
                  Math.min(1, col[2] * 1.12 + 0.04));
          bs.push(pitchWorld * (4.5 + Math.random() * 9));
          ba.push(0.10 + Math.random() * 0.16);
          bph.push(Math.random() * Math.PI * 2);
        }
      }
    }

    var n = gx.length;
    P.n = n;
    P.x = new Float32Array(n); P.y = new Float32Array(n); P.z = new Float32Array(n);
    P.vx = new Float32Array(n); P.vy = new Float32Array(n); P.vz = new Float32Array(n);
    P.hx = new Float32Array(n); P.hy = new Float32Array(n); P.hz = new Float32Array(n);
    P.sx0 = new Float32Array(n); P.sy0 = new Float32Array(n); P.sz0 = new Float32Array(n);
    P.ax = new Float32Array(n); P.ay = new Float32Array(n); P.az = new Float32Array(n);
    P.ph = new Float32Array(n); P.amp = new Float32Array(n); P.drift = new Float32Array(n);
    P.delay = new Float32Array(n);

    var posArr = new Float32Array(n * 3);
    for (var k = 0; k < n; k++) {
      P.hx[k] = gx[k]; P.hy[k] = gy[k]; P.hz[k] = gz[k];
      P.ph[k] = Math.random() * Math.PI * 2;
      P.amp[k] = 0.7 + Math.random() * 1.1;
      P.drift[k] = gd[k] || 0.12;
      P.delay[k] = 0;
      P.x[k] = gx[k]; P.y[k] = gy[k]; P.z[k] = gz[k];
      P.sx0[k] = gx[k]; P.sy0[k] = gy[k]; P.sz0[k] = gz[k];
      posArr[k * 3] = P.x[k]; posArr[k * 3 + 1] = P.y[k]; posArr[k * 3 + 2] = P.z[k];
    }

    /* 重建 attribute（BufferAttribute.count 由数组长度决定，不能复用空壳） */
    var geo = points.geometry;
    geo.setAttribute("position", new THREE.BufferAttribute(posArr, 3));
    geo.attributes.position.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(gc), 3));
    geo.setAttribute("aSize", new THREE.BufferAttribute(new Float32Array(gs), 1));
    geo.setAttribute("aAlpha", new THREE.BufferAttribute(new Float32Array(ga), 1));
    geo.setAttribute("aGlow", new THREE.BufferAttribute(new Float32Array(gg), 1));
    geo.setDrawRange(0, n);
    geo.computeBoundingSphere();   /* 换图后平面尺寸会变，不复算会按旧包围球被视锥剔除 */
    geoPos = geo.attributes.position;

    buildBokehLayer(bx, by, bz, bc, bs, ba, bph);
    buildStipplePlane(img);
    photo.domColor = dominantColor(img);
    drawAmbience();
    applyVisualTune();
  }

  /* ============================================================
     成像层：屏幕自适应的「点阵平面」
     照片本身贴在一张 quad 上，由 fragment shader 按 **屏幕像素** 打点。
     好处：① 覆盖率 100%，任何缩放下都不漏底；② 放大时格子变多、采样更细，
     真的"看进去"；③ 成本只有一个 quad。
     ============================================================ */
  var STIPPLE_FRAG = [
    "#ifdef GL_FRAGMENT_PRECISION_HIGH",
    "precision highp float;",
    "#else",
    "precision mediump float;",
    "#endif",
    "varying vec2 vUv;",
    "uniform sampler2D uMap;",
    "uniform vec2 uCells;",
    "uniform float uAlpha;",
    "uniform float uDot;",
    "uniform float uFace;",
    "uniform float uVig;",
    "uniform float uBright;",
    "",
    "float hash(vec2 p) {",
    "  p = fract(p * vec2(443.897, 441.423));",
    "  p += dot(p, p + 19.19);",
    "  return fract((p.x + p.y) * p.x);",
    "}",
    "",
    "void main() {",
    "  vec2 q = vUv * 2.0 - 1.0;",
    "  float rho = length(q);",
    "  float edge = 1.0 - smoothstep(mix(0.96, 0.52, uVig), 1.04, rho);",
    "",
    "  vec2 g = vUv * uCells;",
    "  vec2 cell = floor(g);",
    "  vec2 f = fract(g) - 0.5;",
    "",
    "  /* 每格抖动取样，避免规则网格 */",
    "  vec2 jit = (vec2(hash(cell), hash(cell + 37.0)) - 0.5) * 0.90;",
    "  vec3 c = texture2D(uMap, (cell + 0.5 + jit) / uCells).rgb;",
    "",
    "  /* 显影 / 调色（与 CPU 端 toneColor 同源） */",
    "  float l = dot(c, vec3(0.299, 0.587, 0.114));",
    "  c = mix(vec3(l), c, 0.95);",
    "  c = pow(max(c, vec3(0.0)), vec3(0.78));",
    "  c += vec3(-0.005, 0.002, 0.012) * (1.0 - l);",
    "  c = mix(c, smoothstep(vec3(0.03), vec3(0.97), c), vec3(0.30));",
    "  c = c / (0.70 + c * 0.075);",
    "  c = min(c * 0.98 + 0.045, vec3(1.0));",
    "",
    "  /* 随机网点：每格一个噪声值，点亮与否由亮度决定 —— 参考里那种不规则砂点 */",
    "  float n = hash(cell + 91.0);",
    "  float lit = smoothstep(n - 0.16, n + 0.16, l * 1.88 + 0.18);",
    "  float d = length(f);",
    "  float shape = 1.0 - smoothstep(0.26, 0.50, d);",
    "  float halo = exp(-d * d * 6.0) * 0.60 * (0.55 + l);",
    "  float m = clamp(lit * shape + halo, 0.0, 1.0);",
    "",
    "  /* 边缘：椭圆 + 噪声侵蚀 */",
    "  if (hash(cell * 1.7 + 5.0) > edge) discard;",
    "",
    "  c *= (0.50 + 0.50 * pow(edge, 0.70)) * uBright;",
    "  float baseA = 0.22 * l;",
    "  float a = max(m, baseA) * uAlpha * (0.45 + 0.55 * edge);",
    "  gl_FragColor = vec4(c, a * uFace);",
    "}"
  ].join("\n");

  function buildStipplePlane(img) {
    if (!scene) return;
    if (!planeMat) {
      planeMat = new THREE.ShaderMaterial({
        uniforms: {
          uMap: { value: null },
          uCells: { value: new THREE.Vector2(60, 80) },
          uAlpha: { value: 0 },
          uDot: { value: 1.0 },
          uFace: { value: 1.0 },
          uVig: { value: 0.5 },
          uBright: { value: 1.0 }
        },
        vertexShader: [
          "varying vec2 vUv;",
          "void main() {",
          "  vUv = uv;",
          "  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);",
          "}"
        ].join("\n"),
        fragmentShader: STIPPLE_FRAG,
        transparent: true,
        depthWrite: false,
        depthTest: false,
        blending: THREE.NormalBlending
      });
      planeMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), planeMat);
      planeMesh.frustumCulled = false;
      planeMesh.renderOrder = -1;
      if (root3d) root3d.add(planeMesh); else scene.add(planeMesh);
    }
    if (photoTex) photoTex.dispose();
    photoTex = new THREE.Texture(img);
    photoTex.needsUpdate = true;
    photoTex.minFilter = THREE.LinearMipMapLinearFilter;
    photoTex.magFilter = THREE.LinearFilter;
    photoTex.wrapS = photoTex.wrapT = THREE.ClampToEdgeWrapping;
    planeMat.uniforms.uMap.value = photoTex;
    var SPECK_CSS = 2.4 - 1.5 * (TUNE.size / 100);   /* 星星大小：50 → 1.65px */
    CELLS.x = Math.max(8, Math.round(planeW / WPP / SPECK_CSS));
    CELLS.y = Math.max(8, Math.round(planeH / WPP / SPECK_CSS));
    if (planeMat.uniforms) planeMat.uniforms.uCells.value.set(CELLS.x, CELLS.y);
    planeMesh.scale.set(planeW, planeH, 1);
    planeMesh.position.set(0, yShiftCur, 0);
  }

  /* ---------------- 散景光尘层 ---------------- */
  function buildBokehLayer(bx, by, bz, bc, bs, ba, bph) {
    if (!geoB) return;
    var nB = bx.length;
    B.n = nB;
    if (!nB) {
      B.hx = B.hy = B.hz = B.ph = new Float32Array(0);
      geoB.setAttribute("position", new THREE.BufferAttribute(new Float32Array(0), 3));
      geoB.setAttribute("color", new THREE.BufferAttribute(new Float32Array(0), 3));
      geoB.setAttribute("aSize", new THREE.BufferAttribute(new Float32Array(0), 1));
      geoB.setAttribute("aAlpha", new THREE.BufferAttribute(new Float32Array(0), 1));
      geoB.setDrawRange(0, 0);
      geoBPos = geoB.attributes.position;
      return;
    }
    B.hx = new Float32Array(bx); B.hy = new Float32Array(by);
    B.hz = new Float32Array(bz); B.ph = new Float32Array(bph);
    var posB = new Float32Array(nB * 3);
    for (var i = 0; i < nB; i++) {
      posB[i * 3] = B.hx[i]; posB[i * 3 + 1] = B.hy[i]; posB[i * 3 + 2] = B.hz[i];
    }
    geoB.setAttribute("position", new THREE.BufferAttribute(posB, 3));
    geoB.attributes.position.setUsage(THREE.DynamicDrawUsage);
    geoB.setAttribute("color", new THREE.BufferAttribute(new Float32Array(bc), 3));
    geoB.setAttribute("aSize", new THREE.BufferAttribute(new Float32Array(bs), 1));
    geoB.setAttribute("aAlpha", new THREE.BufferAttribute(new Float32Array(ba), 1));
    geoB.setDrawRange(0, nB);
    geoB.computeBoundingSphere();
    geoBPos = geoB.attributes.position;
  }

  /* 主色：24×24 下采样，按饱和度 × 中亮度加权（借参考站点的取色思路） */
  function dominantColor(img) {
    try {
      var c = document.createElement("canvas");
      c.width = 24; c.height = 24;
      var x = c.getContext("2d", { willReadFrequently: true });
      x.drawImage(img, 0, 0, 24, 24);
      var d = x.getImageData(0, 0, 24, 24).data;
      var r = 0, g = 0, b = 0, wsum = 0;
      for (var i = 0; i < d.length; i += 4) {
        var R = d[i] / 255, G = d[i + 1] / 255, Bc = d[i + 2] / 255;
        var mx = Math.max(R, G, Bc), mn = Math.min(R, G, Bc);
        var sat = mx === 0 ? 0 : (mx - mn) / mx;
        var mid = 1 - 2 * Math.abs((R + G + Bc) / 3 - 0.5);
        var w = (0.15 + sat) * (0.3 + 0.7 * mid) + 0.02;
        r += R * w; g += G * w; b += Bc * w; wsum += w;
      }
      if (wsum <= 0) return [0.45, 0.36, 0.26];
      return [r / wsum, g / wsum, b / wsum];
    } catch (e) { return [0.45, 0.36, 0.26]; }
  }

  /* ---------------- 指针 → 世界坐标（z=0 平面） ---------------- */
  var _ndc = null, _dir = null, _wp = null;
  function pointerWorld() {
    if (!camera) return null;
    if (!_ndc) { _ndc = new THREE.Vector3(); _dir = new THREE.Vector3(); }
    _ndc.set(pointer.nx, pointer.ny, 0.5).unproject(camera);
    _dir.copy(_ndc).sub(camera.position).normalize();
    if (Math.abs(_dir.z) < 1e-4) return null;
    var t = -camera.position.z / _dir.z;
    if (!_wp) _wp = new THREE.Vector3();
    _wp.copy(camera.position).add(_dir.multiplyScalar(t));
    return _wp;
  }

  /* ---------------- 渲染循环（时间驱动） ---------------- */
  var rafId = 0, running = false;
  function frame(t) {
    rafId = requestAnimationFrame(frame);
    var dt = Math.min(0.05, (t - (lastT || t)) / 1000);
    lastT = t;
    var k60 = Math.max(0.2, dt * 60);
    var damp = Math.pow(0.86, k60);
    var n = P.n;

    if (mode === "assembling") {
      var kAll = Math.min(1, (t - assembleStart) / assembleDur);
      var eAll = easeOutCubic(kAll);
      var bowAll = Math.sin(Math.PI * kAll);
      var span = 1 - 0.35; /* 个体错峰窗口 0~35% */
      for (var i = 0; i < n; i++) {
        var d = P.delay[i];
        var kk = Math.min(1, Math.max(0, (kAll - d) / span));
        var e = easeOutCubic(kk);
        var bow = Math.sin(Math.PI * kk);
        P.x[i] = P.sx0[i] + (P.hx[i] - P.sx0[i]) * e + P.ax[i] * bow;
        P.y[i] = P.sy0[i] + (P.hy[i] - P.sy0[i]) * e + P.ay[i] * bow;
        P.z[i] = P.sz0[i] + (P.hz[i] - P.sz0[i]) * e + P.az[i] * bow;
      }
      var pct = Math.round(eAll * 100);
      elLoadPct.textContent = pct + "%";
      elStatus.textContent = assembleLabel + " " + pct + "%";
      if (kAll >= 1) {
        mode = "photo";
        elLoading.classList.add("is-done");
        elStatus.textContent = "";
        toast(assembleLabel === "归来" ? "影像已归来" : "影像已凝聚");
      }
    } else {
      /* 照片态：中心稳、雾区飘（drift 加权），录音时被声音唤醒 */
      var t2 = t / 1000;
      var shake = 0.008 + voiceEnergy * 0.16;
      var spd = 0.5 + voiceEnergy * 2;
      for (var m = 0; m < n; m++) {
        var dm = 1 + P.drift[m] * 10;
        P.x[m] = P.hx[m] + Math.sin(t2 * spd + P.ph[m]) * shake * dm;
        P.y[m] = P.hy[m] + Math.cos(t2 * spd * 0.9 + P.ph[m]) * shake * dm;
        /* 径向波纹：从中心向外传的 z 起伏（参考站的「起伏速度 / 起伏幅度」） */
        var rr2 = Math.sqrt(P.hx[m] * P.hx[m] + P.hy[m] * P.hy[m]);
        var wAmp = planeW * 0.012 * sv("waveAmp", TUNE.waveAmp);   /* 0.2~4，50 → 1.2 */
        var wSpd = 0.20 + 1.3 * sv("waveSpeed", TUNE.waveSpeed);   /* 0~1，50 → 0.6 */
        var wv = Math.sin(rr2 * 2.4 - t2 * wSpd) * wAmp;
        P.z[m] = P.hz[m] + wv + Math.sin(t2 * spd * 0.7 + P.ph[m] * 1.7) * shake * dm * 1.4;
      }
    }

    /* 点阵平面：格数固定在"图片长边 ≈132 格"（对齐参考视频的颗粒密度），
       推近时只轻微加密 → 像一幅点彩画被拉近，而不是点被放大糊掉 */
    if (planeMat) {
      /* 正对时以点阵平面为主（清晰），转开时交给粒子云（体积） */
      var faceK = 0;   /* 试验：完全关闭点阵平面，只靠粒子成像 */
      points.material.uniforms.uAlpha.value = mode === "assembling" ? 1 : (0.18 + 0.82 * (1 - faceK));
      planeMat.uniforms.uAlpha.value =
        mode === "assembling" ? Math.max(0, Math.min(1, (t - assembleStart) / assembleDur - 0.55) / 0.45) : 1;
    }

    /* 散景光尘：极慢漂浮，让景深"活"起来 */
    if (B.n > 0 && geoBPos) {
      var arrB = geoBPos.array, tb = t / 1000;
      for (var bi = 0; bi < B.n; bi++) {
        arrB[bi * 3] = B.hx[bi] + Math.sin(tb * 0.33 + B.ph[bi]) * 0.06;
        arrB[bi * 3 + 1] = B.hy[bi] + Math.cos(tb * 0.27 + B.ph[bi] * 1.3) * 0.06;
        arrB[bi * 3 + 2] = B.hz[bi] + Math.sin(tb * 0.21 + B.ph[bi] * 0.7) * 0.10;
      }
      geoBPos.needsUpdate = true;
    }
    if (bokehPoints) {
      bokehPoints.material.uniforms.uAlpha.value =
        mode === "assembling" ? Math.max(0, Math.min(1, (t - assembleStart) / assembleDur)) : 1;
    }

    /* 3D 旋转：松手 1 秒后缓慢回正（照抄参考站点的行为） */
    if (!STAY && !dragging && performance.now() - lastActionAt > 1000) {
      rotT.x += (0 - rotT.x) * 0.04 * k60;
      rotT.y += (0 - rotT.y) * 0.04 * k60;
    }
    rot.x += (rotT.x - rot.x) * 0.08 * k60;
    rot.y += (rotT.y - rot.y) * 0.08 * k60;
    if (root3d) { root3d.rotation.x = rot.x; root3d.rotation.y = rot.y; }

    /* 正对时用点阵平面保证清晰；一转开就淡出，露出真正的粒子体积 */
    if (planeMat) {
      var face = Math.min(1, Math.max(0, 1 - (Math.abs(rot.y) + Math.abs(rot.x) * 0.7) / 0.32));
      planeMat.uniforms.uFace.value = face;
    }

    /* 相机：绕原点环绕 + 推拉（滚轮/捏合），阻尼 + 极慢呼吸
       —— 近处粒子被透视放大，远处保持，这就是「放大缩小」的 3D 视差来源 */
    if (camera) {
      camZ += (camZTarget - camZ) * Math.min(1, 0.10 * k60);
      var yawT = pointer.active ? pointer.nx * 0.13 : Math.sin(t / 9000) * 0.05;
      var pitchT = pointer.active ? pointer.ny * 0.08 : Math.cos(t / 12000) * 0.03;
      orbitYaw += (yawT - orbitYaw) * Math.min(1, 0.06 * k60);
      orbitPitch += (pitchT - orbitPitch) * Math.min(1, 0.06 * k60);
      var cd = camZ * (1 + Math.sin(t / 5200) * 0.010);
      var cpc = Math.cos(orbitPitch);
      camera.position.set(Math.sin(orbitYaw) * cd * cpc, Math.sin(orbitPitch) * cd, Math.cos(orbitYaw) * cd * cpc);
      camera.lookAt(0, 0, 0);
    }

    /* 上传位置并渲染（主层 + 散景层；有 composer 走 bloom，否则直渲） */
    if (renderer && n > 0) {
      var arr = geoPos.array;
      for (var q = 0; q < n; q++) {
        arr[q * 3] = P.x[q]; arr[q * 3 + 1] = P.y[q]; arr[q * 3 + 2] = P.z[q];
      }
      geoPos.needsUpdate = true;
      if (bokehPoints) bokehPoints.material.uniforms.uAlpha.value = 1;
      if (composer) {
        composer.render();
      } else {
        renderer.render(scene, camera);
      }
    } else if (renderer) {
      renderer.clear();
      if (composer) composer.render();
    }
  }

  /* ---------------- 指针 ---------------- */
  function ptFromEvent(e) {
    var r = root.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  root.addEventListener("pointermove", function (e) {
    var p = ptFromEvent(e);
    pointer.x = p.x; pointer.y = p.y;
    pointer.nx = (p.x / W) * 2 - 1;
    pointer.ny = -((p.y / H) * 2 - 1);
    pointer.active = true;
  });
  root.addEventListener("pointerleave", function () { pointer.active = false; });

  /* ---------------- 拖拽旋转（Y 自由，X 限 ±0.5rad） ---------------- */
  function isUI(t) {
    return !!(t && t.closest && t.closest("button,a,input,.mr-tune,.mr-drawer,.mr-controls,.mr-stack"));
  }
  root.addEventListener("pointerdown", function (e) {
    if (isUI(e.target)) return;
    dragging = true;
    lastXDrag = e.clientX; lastYDrag = e.clientY;
    lastActionAt = performance.now();
    try { root.setPointerCapture(e.pointerId); } catch (err) { }
  });
  root.addEventListener("pointermove", function (e) {
    if (!dragging) return;
    var dx = e.clientX - lastXDrag, dy = e.clientY - lastYDrag;
    lastXDrag = e.clientX; lastYDrag = e.clientY;
    rotT.y += 0.005 * dx;
    rotT.x = Math.max(-0.5, Math.min(0.5, rotT.x + 0.005 * dy));
    lastActionAt = performance.now();
  });
  function endDrag() { dragging = false; lastActionAt = performance.now(); }
  root.addEventListener("pointerup", endDrag);
  root.addEventListener("pointercancel", endDrag);

  /* ---------------- 相机：滚轮 / 双指捏合推拉，双击归位 ---------------- */
  root.addEventListener("wheel", function (e) {
    e.preventDefault();
    camZTarget = Math.max(ZMIN, Math.min(ZMAX, camZTarget * (1 + e.deltaY * 0.0011)));
  }, { passive: false });
  root.addEventListener("dblclick", function () { camZTarget = CAM_Z; });

  var pinch = { d0: 0, z0: 0 };
  function touchDist(e) {
    var a = e.touches[0], b = e.touches[1];
    return Math.sqrt((a.clientX - b.clientX) * (a.clientX - b.clientX) +
                     (a.clientY - b.clientY) * (a.clientY - b.clientY));
  }
  root.addEventListener("touchstart", function (e) {
    if (e.touches.length === 2) { pinch.d0 = touchDist(e); pinch.z0 = camZTarget; }
  }, { passive: true });
  root.addEventListener("touchmove", function (e) {
    if (e.touches.length === 2 && pinch.d0 > 0) {
      e.preventDefault();
      var k = pinch.d0 / Math.max(1, touchDist(e));
      camZTarget = Math.max(ZMIN, Math.min(ZMAX, pinch.z0 * k));
    }
  }, { passive: false });
  root.addEventListener("touchend", function (e) {
    if (e.touches.length < 2) pinch.d0 = 0;
  }, { passive: true });
  root.addEventListener("pointerdown", function (e) {
    var p = ptFromEvent(e);
    pointer.x = p.x; pointer.y = p.y;
    pointer.nx = (p.x / W) * 2 - 1;
    pointer.ny = -((p.y / H) * 2 - 1);
    pointer.active = true;
  });

  /* ---------------- 氛围调节面板 ---------------- */
  var elTune = $("mr-tune");
  var elTuneBtn = $("mr-tune-btn");
  var elTuneClose = $("mr-tune-close");
  var tuneTimer = 0;

  function applyVisualTune() {
    if (planeMat && planeMat.uniforms) {
      var vs = sv("vignetteStart", TUNE.vignette);   /* 0~1.5，50 → 0.5 */
      var cb = sv("colorBoost", TUNE.brightness);    /* 0~0.4，50 → 0.18 */
      planeMat.uniforms.uVig.value = Math.min(1, vs / 1.5);
      planeMat.uniforms.uBright.value = 0.85 + cb;
    }
  }
  function rebuildNow() {
    if (!photo.img || mode === "assembling") return;
    buildParticles(false);
    mode = "photo";
    for (var i = 0; i < P.n; i++) { P.x[i] = P.hx[i]; P.y[i] = P.hy[i]; P.z[i] = P.hz[i]; }
    elLoading.classList.add("is-done");
    elStatus.textContent = "";
  }
  function scheduleRebuild() {
    clearTimeout(tuneTimer);
    tuneTimer = setTimeout(rebuildNow, 140);
  }
  if (elTune && elTuneBtn) {
    elTuneBtn.addEventListener("click", function () {
      var willOpen = elTune.hasAttribute("hidden");
      if (willOpen) { elTune.removeAttribute("hidden"); } else { elTune.setAttribute("hidden", ""); }
      elTuneBtn.setAttribute("aria-expanded", willOpen ? "true" : "false");
    });
    if (elTuneClose) elTuneClose.addEventListener("click", function () {
      elTune.setAttribute("hidden", "");
      elTuneBtn.setAttribute("aria-expanded", "false");
    });
    Array.prototype.forEach.call(elTune.querySelectorAll("input[data-tune]"), function (el) {
      el.addEventListener("input", function () {
        var k = el.getAttribute("data-tune");
        TUNE[k] = +el.value;
        var b = el.parentNode.querySelector("b");
        if (b) b.textContent = el.value;
        if (k === "vignette" || k === "brightness") applyVisualTune();
        else if (k === "waveAmp" || k === "waveSpeed") { /* 每帧直接读 TUNE */ }
        else scheduleRebuild();
      });
    });
  }

  /* ---------------- 设置照片（由宿主调用） ---------------- */
  function setPhoto(blob, name) {
    photo.blob = blob;
    photo.name = name || "照片";
    return loadImage(blob).then(function (r) {
      if (photo.url) URL.revokeObjectURL(photo.url);
      photo.img = r.img;
      photo.url = r.url;
      buildParticles(false);
      enterAssembling("凝聚中", true);
      if (STATIC) {
        /* 静态模式：跳过飞入动画，直接把粒子摆回家位（用于截图比对/验收） */
        mode = "photo";
        for (var i = 0; i < P.n; i++) {
          P.x[i] = P.hx[i]; P.y[i] = P.hy[i]; P.z[i] = P.hz[i];
        }
        elLoading.classList.add("is-done");
        elLoading.style.display = "none";   /* 静态截图模式：跳过淡出过渡 */
        elLoadPct.textContent = "100%";
        elStatus.textContent = "";
      }
      updateCoord();
      return true;
    });
  }

  function updateCoord() {
    if (photo.img) {
      elCoord.textContent = photo.img.naturalWidth + " × " + photo.img.naturalHeight +
        " px · " + (photo.blob && photo.blob.size ? (photo.blob.size / 1024).toFixed(0) + " KB" : "");
    }
  }

  /* ============================================================
     按住说话：idle → recording → review →（上传 / 放弃）
     ============================================================ */
  var flow = "idle";
  var pending = null; /* { audioBlob, heldMs } */
  var rec = {
    mediaRecorder: null, chunks: [], stream: null,
    audioCtx: null, analyser: null, rafId: 0,
    active: false, startedAt: 0, stopTimer: 0, permTimer: 0, ticker: 0
  };

  function recSupported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
  }

  function setFlow(f) {
    flow = f;
    root.classList.toggle("is-recording", f === "recording");
    elTran.classList.toggle("is-idle", f === "idle");
    elTimer.hidden = (f !== "recording");
    elSave.hidden = (f !== "review");
    elDiscard.hidden = (f !== "review");
    elSpeak.disabled = (f !== "idle");
    if (f === "idle") {
      elTranRole.textContent = "";
      elTranText.textContent = HINT_TEXT;
    } else if (f === "recording") {
      elTranRole.textContent = "正在录音";
      elTranText.textContent = "";
    } else if (f === "review") {
      elTranRole.textContent = "已录好";
      elTranText.textContent = pending
        ? ("时长 " + Math.round(pending.heldMs / 1000) + " 秒 · 上传后大家都能听到")
        : "";
    }
  }

  function beginSpeak() {
    if (flow !== "idle") return;
    if (!recSupported()) {
      toast("当前环境无法录音（需 https 或 localhost）");
      return;
    }
    rec.active = true;
    rec.chunks = [];
    rec.startedAt = Date.now();
    rec.permTimer = setTimeout(function () {
      if (rec.active && !rec.stream) {
        rec.active = false;
        toast("未获得麦克风权限");
      }
    }, 10000);

    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      if (!rec.active) { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
      clearTimeout(rec.permTimer);
      rec.stream = stream;
      setFlow("recording");
      elTimer.textContent = "00:00";
      rec.ticker = setInterval(function () {
        elTimer.textContent = fmtMS(Date.now() - rec.startedAt);
      }, 250);

      var mime = "";
      ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"].forEach(function (m) {
        if (!mime && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) mime = m;
      });
      try {
        rec.mediaRecorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      } catch (e) {
        rec.mediaRecorder = new MediaRecorder(stream);
      }
      rec.mediaRecorder.ondataavailable = function (e) { if (e.data && e.data.size) rec.chunks.push(e.data); };
      rec.mediaRecorder.onstop = onRecorderStop;
      rec.mediaRecorder.start(250);

      /* 音量分析 → 粒子波动（声音唤醒照片） */
      var AC = window.AudioContext || window.webkitAudioContext;
      rec.audioCtx = new AC();
      var src = rec.audioCtx.createMediaStreamSource(stream);
      rec.analyser = rec.audioCtx.createAnalyser();
      rec.analyser.fftSize = 512;
      src.connect(rec.analyser);
      var buf = new Uint8Array(rec.analyser.fftSize);
      (function pump() {
        if (!rec.active) return;
        rec.analyser.getByteTimeDomainData(buf);
        var sum = 0;
        for (var i = 0; i < buf.length; i++) { var v = (buf[i] - 128) / 128; sum += v * v; }
        var rms = Math.sqrt(sum / buf.length);
        voiceEnergy = Math.min(1, rms * 3.4);
        rec.rafId = requestAnimationFrame(pump);
      })();

      rec.stopTimer = setTimeout(endSpeak, MAX_RECORD_MS);
    }).catch(function () {
      clearTimeout(rec.permTimer);
      rec.active = false;
      toast("麦克风未授权");
    });
  }

  function endSpeak() {
    if (!rec.active) return;
    rec.active = false;
    clearTimeout(rec.stopTimer);
    clearTimeout(rec.permTimer);
    clearInterval(rec.ticker);
    voiceEnergy = 0;
    cancelAnimationFrame(rec.rafId);
    if (rec.mediaRecorder && rec.mediaRecorder.state !== "inactive") {
      rec.mediaRecorder.stop();
    } else {
      cleanupStream();
      backToIdle();
    }
  }

  function onRecorderStop() {
    var heldMs = Date.now() - rec.startedAt;
    var audioBlob = rec.chunks.length ? new Blob(rec.chunks, { type: rec.mediaRecorder.mimeType || "audio/webm" }) : null;
    cleanupStream();
    if (!audioBlob || heldMs < 400) {
      toast(heldMs < 400 ? "按住时间太短，未录到" : "未录到声音，请重试");
      backToIdle();
      return;
    }
    pending = { audioBlob: audioBlob, heldMs: heldMs };
    setFlow("review");
  }

  function backToIdle() {
    pending = null;
    setFlow("idle");
  }

  function cleanupStream() {
    if (rec.stream) { rec.stream.getTracks().forEach(function (t) { t.stop(); }); rec.stream = null; }
    if (rec.audioCtx) { try { rec.audioCtx.close(); } catch (e) {} rec.audioCtx = null; }
    rec.mediaRecorder = null;
  }

  /* 按住 / 松开 */
  var speakPid = null;
  elSpeak.addEventListener("pointerdown", function (e) {
    e.preventDefault();
    speakPid = e.pointerId;
    try { elSpeak.setPointerCapture && elSpeak.setPointerCapture(e.pointerId); } catch (err) {}
    beginSpeak();
  });
  function speakUp(e) {
    if (speakPid === null) return;
    if (e && e.pointerId !== undefined && e.pointerId !== speakPid) return;
    speakPid = null;
    endSpeak();
  }
  elSpeak.addEventListener("pointerup", speakUp);
  elSpeak.addEventListener("pointercancel", speakUp);
  window.addEventListener("pointerup", speakUp);
  elSpeak.addEventListener("contextmenu", function (e) { e.preventDefault(); });
  root.addEventListener("contextmenu", function (e) {
    if (e.target.closest && e.target.closest(".mr-speak")) e.preventDefault();
  });

  /* 上传 / 放弃 */
  elSave.addEventListener("click", function () {
    if (flow !== "review" || !pending) return;
    var p = pending;
    elSave.disabled = true;
    elSave.textContent = "上传中…";
    var done = function () {
      elSave.disabled = false;
      elSave.textContent = "上传给大家听 →";
      backToIdle();
    };
    if (bridge && bridge.onRecord) {
      Promise.resolve(bridge.onRecord(p.audioBlob, p.heldMs)).then(function () {
        toast("已上传 · 大家都能听到了");
        done();
      }).catch(function (err) {
        elSave.disabled = false;
        elSave.textContent = "上传给大家听 →";
        toast("上传失败：" + ((err && err.message) || "请重试"));
      });
    } else {
      toast("未连接上传通道，无法共享");
      done();
    }
  });
  elDiscard.addEventListener("click", function () {
    if (flow !== "review") return;
    toast("已放弃这段录音");
    backToIdle();
  });

  /* ---------------- 大家的回忆（音频列表） ---------------- */
  var audioEl = null, playingVoiceId = null;
  function fmtDur(ms) {
    if (!ms) return "";
    var s = Math.round(ms / 1000);
    return s + "″";
  }
  function refreshArchive() {
    var all = (voices || []).slice().sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
    archCount.textContent = String(all.length);
    drawerSub.textContent = "共 " + all.length + " 段声音";
    drawerList.innerHTML = "";
    if (!all.length) {
      drawerList.innerHTML = '<div class="mr-empty">还没有人留下声音。<br>按住下方的话筒，<br>录下你对这张照片想说的话。</div>';
      return;
    }
    all.forEach(function (v) {
      var card = document.createElement("div");
      card.className = "mr-card";
      var author = v.author || "匿名";
      var dur = fmtDur(v.duration);
      var mine = currentUser && v.author === currentUser;
      card.innerHTML =
        '<div class="mr-card-date">' + author + (dur ? " · " + dur : "") + "</div>" +
        '<div class="mr-card-audio">' +
        '  <button type="button" class="mr-play">▶ 播放</button>' +
        '  <span class="mr-bar"><span></span></span>' +
        "</div>" +
        '<div class="mr-card-meta">' +
        (mine ? '<button type="button" class="mr-del">删除</button>' : '') +
        "</div>";
      var playBtn = card.querySelector(".mr-play");
      var barFill = card.querySelector(".mr-bar span");
      var delBtn  = card.querySelector(".mr-del");

      playBtn.addEventListener("click", function () {
        if (playingVoiceId === v.id && audioEl && !audioEl.paused) {
          audioEl.pause(); playBtn.textContent = "▶ 播放"; return;
        }
        if (audioEl) { audioEl.pause(); }
        audioEl = new Audio(v.audioUrl);
        playingVoiceId = v.id;
        playBtn.textContent = "■ 暂停";
        audioEl.addEventListener("timeupdate", function () {
          if (audioEl && audioEl.duration) barFill.style.width = (audioEl.currentTime / audioEl.duration * 100) + "%";
        });
        audioEl.addEventListener("ended", function () {
          playBtn.textContent = "▶ 播放";
          barFill.style.width = "0";
          playingVoiceId = null;
        });
        audioEl.play().catch(function () {
          playBtn.textContent = "▶ 播放";
          toast("播放失败");
        });
      });

      if (delBtn) {
        delBtn.addEventListener("click", function () {
          if (!delBtn.classList.contains("is-confirm")) {
            delBtn.classList.add("is-confirm");
            delBtn.textContent = "确认删除？";
            setTimeout(function () {
              delBtn.classList.remove("is-confirm");
              delBtn.textContent = "删除";
            }, 2600);
            return;
          }
          if (audioEl && playingVoiceId === v.id) { audioEl.pause(); playingVoiceId = null; }
          if (bridge && bridge.onDelete) {
            Promise.resolve(bridge.onDelete(v.id)).then(function () {
              toast("已删除");
            }).catch(function (err) {
              toast("删除失败：" + ((err && err.message) || "请重试"));
            });
          }
        });
      }

      drawerList.appendChild(card);
    });
  }

  function setDrawer(open) {
    drawer.classList.toggle("is-open", open);
    veil.classList.toggle("is-visible", open);
    archTrig.classList.toggle("is-open", open);
    archTrig.setAttribute("aria-expanded", open ? "true" : "false");
  }
  archTrig.addEventListener("click", function () { setDrawer(!drawer.classList.contains("is-open")); });
  veil.addEventListener("click", function () { setDrawer(false); });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") {
      if (drawer.classList.contains("is-open")) setDrawer(false);
      else if (bridge && bridge.onClose) bridge.onClose();
    }
  });

  /* 关闭按钮：返回回忆墙 */
  if (elClose) elClose.addEventListener("click", function () {
    if (bridge && bridge.onClose) bridge.onClose();
  });

  /* ---------------- 启动 ---------------- */
  function start() {
    setFlow("idle");
    var glOK = initGL();
    resize();
    running = true;
    rafId = requestAnimationFrame(frame);
    if (!glOK) {
      elLoading.classList.add("is-done");
      elStatus.textContent = "three.js 未加载";
    }
    refreshArchive();
  }

  window.addEventListener("resize", function () {
    clearTimeout(window._mrResizeT);
    window._mrResizeT = setTimeout(resize, 180);
  });
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) { cancelAnimationFrame(rafId); running = false; }
    else if (!running) { running = true; rafId = requestAnimationFrame(frame); }
  });

  start();

  /* 对外接口 */
  window.MemoryRoom = {
    version: "3.2.0-voices",
    setRotation: function (x, y) { rotT.x = Math.max(-0.5, Math.min(0.5, x || 0)); rotT.y = y || 0; rot.x = rotT.x; rot.y = rotT.y; lastActionAt = performance.now(); },
    open: function (blob, name) {
      root.classList.add("is-open");
      resize();
      if (blob) return setPhoto(blob, name);
      /* 无照片：仅打开界面，等待宿主稍后 setPhoto；显示加载幕布 */
      elLoading.classList.remove("is-done");
      elLoadPct.textContent = "0%";
      elStatus.textContent = "加载照片中…";
      return Promise.resolve(true);
    },
    close: function () {
      if (audioEl) { audioEl.pause(); }
      root.classList.remove("is-open");
      setDrawer(false);
      backToIdle();
    },
    setPhoto: function (blob, name) { return setPhoto(blob, name); },
    setVoices: function (list) { voices = list || []; refreshArchive(); },
    setUser: function (name) { currentUser = name || ""; refreshArchive(); },
    setBridge: function (b) { bridge = b || null; },
    refresh: refreshArchive
  };
})();