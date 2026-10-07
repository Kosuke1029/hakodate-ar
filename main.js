import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// ---- 設定 ----
const TRACK_L = 0.60;        // 段ボールの線路の長さ [m]（縦横比はカメラ映像から自動で測る）
const TRAIN_LEN = 0.32;      // 電車の長さ [m]
const SPEED = 0.18;          // 走行速度 [m/s]
const GAP = 0.20;            // 1周ごとの間隔 [m]
const PROC_W = 480;          // 画像処理の横幅 [px]
const FOCAL_RATIO = 0.75;    // 焦点距離の初期値 ≒ 長辺px × この値（実行中に自動補正）

const params = new URLSearchParams(location.search);
const TEST = params.get('test');           // ?test=1〜8 で test/trackN.jpg を使う
const FIXED_F = params.get('f');           // ?f=0.8 で焦点距離を固定
const SHOW_MASK = params.get('mask') || 'thin'; // デバッグ表示するマスク

// ---- DOM ----
const $ = (id) => document.getElementById(id);
const stage = $('stage'), video = $('video'), glCanvas = $('gl'), overlay = $('overlay');
const startBtn = $('startBtn'), loadMsg = $('loadMsg'), statusEl = $('status');
const debugBtn = $('debugBtn'), debugPanel = $('debugPanel'), maskView = $('maskView');
const threshInput = $('thresh'), threshVal = $('threshVal'), debugInfo = $('debugInfo');
const focalInput = $('focal'), focalVal = $('focalVal'), focalAuto = $('focalAuto');
const octx = overlay.getContext('2d');

let debug = params.has('debug');
let lineT = 25;   // 周りよりこの値以上暗い細い所 = 描いた線 (小さいほど敏感)
threshInput.oninput = () => { lineT = +threshInput.value; threshVal.textContent = lineT; };
// 焦点 (画角) の手動調整。値は端末に保存して次回も使う
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* 保存できない環境では無視 */ } },
};
let autoFocal = !FIXED_F && store.get('focalAuto') !== '0';
const savedFocal = FIXED_F || store.get('focal');
focalAuto.checked = autoFocal;
if (savedFocal) focalInput.value = Math.round(savedFocal * 100);
function setFocalRatio(r) {
  if (!srcW) return;
  focal = r * Math.max(srcW, srcH);
  updateCamera();
}
focalInput.oninput = () => {
  autoFocal = false; focalAuto.checked = false;
  store.set('focalAuto', '0'); store.set('focal', focalInput.value / 100);
  setFocalRatio(focalInput.value / 100);
};
focalAuto.onchange = () => {
  autoFocal = focalAuto.checked; store.set('focalAuto', autoFocal ? '1' : '0');
  fSamples.length = 0;
};

debugBtn.onclick = () => { debug = !debug; debugPanel.hidden = !debug; if (!debug) octx.clearRect(0, 0, overlay.width, overlay.height); };

// ---- OpenCV 読み込み ----
function loadOpenCV() {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'vendor/opencv.js'; s.async = true;
    s.onerror = () => reject(new Error('OpenCV.js の読み込みに失敗しました'));
    s.onload = async () => {
      if (window.cv instanceof Promise) window.cv = await window.cv;
      const wait = () => (window.cv && window.cv.Mat) ? resolve() : setTimeout(wait, 50);
      wait();
    };
    document.head.appendChild(s);
  });
}

// ---- Three.js ----
const renderer = new THREE.WebGLRenderer({ canvas: glCanvas, alpha: true, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.localClippingEnabled = true;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, 1, 0.01, 50);
scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.6));

// 線路座標系: 原点=線路の中心, X=線路方向, Y=横方向, Z=上
const anchor = new THREE.Group();
anchor.matrixAutoUpdate = false;
anchor.visible = false;
scene.add(anchor);

const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.position.set(0.15, -0.25, 1.0);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
Object.assign(sun.shadow.camera, { left: -0.5, right: 0.5, top: 0.5, bottom: -0.5, near: 0.1, far: 3 });
anchor.add(sun, sun.target);

const shadowPlane = new THREE.Mesh(new THREE.PlaneGeometry(TRACK_L, 0.2), new THREE.ShadowMaterial({ opacity: 0.35 }));
shadowPlane.position.z = 0.001;
shadowPlane.receiveShadow = true;
anchor.add(shadowPlane);

// 線路の両端で出入りするように切り取る
const localClips = [
  new THREE.Plane(new THREE.Vector3(1, 0, 0), TRACK_L / 2),
  new THREE.Plane(new THREE.Vector3(-1, 0, 0), TRACK_L / 2),
];
const worldClips = localClips.map((p) => p.clone());

const trainPivot = new THREE.Group();
anchor.add(trainPivot);
let trainReady = false;

new GLTFLoader().load('models/Hakodate_500.glb', (gltf) => {
  const model = gltf.scene;
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const s = TRAIN_LEN / size.x;              // モデルはX方向が車体長
  model.scale.setScalar(s);
  model.position.set(-(box.min.x + size.x / 2) * s, -box.min.y * s, -(box.min.z + size.z / 2) * s);
  model.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true;
    o.material = o.material.clone();
    o.material.clippingPlanes = worldClips;
    o.material.clipShadows = true;
  });
  const upright = new THREE.Group();
  upright.rotation.x = Math.PI / 2;           // モデルのY上 → 線路のZ上
  upright.add(model);
  trainPivot.add(upright);
  trainReady = true;
}, undefined, (e) => console.error(e));

// ---- レイアウト (映像を画面いっぱいに cover 表示) ----
let srcW = 0, srcH = 0, focal = 0;
function updateCamera() {
  camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(srcH / 2 / focal));
  camera.aspect = srcW / srcH;
  camera.updateProjectionMatrix();
}
function layout() {
  if (!srcW) return;
  const W = innerWidth, H = innerHeight;
  const sc = (params.has('contain') ? Math.min : Math.max)(W / srcW, H / srcH); // ?contain で全体表示
  const w = srcW * sc, h = srcH * sc;
  Object.assign(stage.style, { width: w + 'px', height: h + 'px', left: (W - w) / 2 + 'px', top: (H - h) / 2 + 'px' });
  renderer.setSize(w, h, false);
  overlay.width = w; overlay.height = h;
  updateCamera();
}
addEventListener('resize', layout);

// ---- 検出: 段ボール(ベージュ)の中にある、描かれた線路(細い黒線)を探す ----
const proc = document.createElement('canvas');
const pctx = proc.getContext('2d', { willReadFrequently: true });
let pw = 0, ph = 0, mats = null;

function initMats() {
  const k = (n) => cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(n, n));
  mats = { k3: k(3), k7: k(7), k11: k(11), k15: k(15) };
  mats.beigeLo = new cv.Mat(ph, pw, cv.CV_8UC3, new cv.Scalar(5, 12, 120));
  mats.beigeHi = new cv.Mat(ph, pw, cv.CV_8UC3, new cv.Scalar(40, 170, 255));
}

function largestContour(mask) {
  const contours = new cv.MatVector(), hier = new cv.Mat();
  cv.findContours(mask, contours, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
  let best = null, bestArea = 0;
  for (let i = 0; i < contours.size(); i++) {
    const c = contours.get(i);
    const a = cv.contourArea(c);
    if (a > bestArea) { if (best) best.delete(); best = c; bestArea = a; } else c.delete();
  }
  contours.delete(); hier.delete();
  return { contour: best, area: bestArea };
}

// 1フレームを解析する。戻り値の gray / avoid は呼び出し側で delete すること
function analyze(source) {
  pctx.imageSmoothingQuality = 'high';
  pctx.drawImage(source, 0, 0, pw, ph);
  const keep = [];
  const M = () => { const m = new cv.Mat(); keep.push(m); return m; };
  const out = { quad: null, gray: new cv.Mat(), avoid: cv.Mat.zeros(ph, pw, cv.CV_8U), poles: [] };
  try {
    const rgba = cv.matFromImageData(pctx.getImageData(0, 0, pw, ph)); keep.push(rgba);
    cv.cvtColor(rgba, out.gray, cv.COLOR_RGBA2GRAY);
    const hsv = M();
    cv.cvtColor(rgba, hsv, cv.COLOR_RGBA2RGB);
    cv.cvtColor(hsv, hsv, cv.COLOR_RGB2HSV);
    const chans = new cv.MatVector(); cv.split(hsv, chans);
    const V = chans.get(2); keep.push(V); chans.delete();

    // 1) 段ボール領域: ベージュ(描いた線で分断されないよう閉じてから)の一番大きい塊の凸包
    const beige = M();
    cv.inRange(hsv, mats.beigeLo, mats.beigeHi, beige);
    cv.morphologyEx(beige, beige, cv.MORPH_OPEN, mats.k3);
    cv.morphologyEx(beige, beige, cv.MORPH_CLOSE, mats.k11);
    if (debug && SHOW_MASK === 'beige') cv.imshow(maskView, beige);
    const { contour: card, area: cardArea } = largestContour(beige);
    if (!card || cardArea < pw * ph * 0.02) { card && card.delete(); return out; }
    const hull = M(); cv.convexHull(card, hull, false, true); card.delete();
    const cardMask = cv.Mat.zeros(ph, pw, cv.CV_8U); keep.push(cardMask);
    const hv = new cv.MatVector(); hv.push_back(hull);
    cv.drawContours(cardMask, hv, 0, new cv.Scalar(255), -1); hv.delete();
    cv.erode(cardMask, cardMask, mats.k7);
    const meanV = cv.mean(V, beige)[0];

    // 2) 太い黒 (電柱・ケーブルカバーなど)。電柱の候補探しと、追跡点から外すのに使う
    const thickAll = M();
    cv.threshold(V, thickAll, meanV * 0.57, 255, cv.THRESH_BINARY_INV);
    cv.morphologyEx(thickAll, thickAll, cv.MORPH_OPEN, mats.k7);
    cv.dilate(thickAll, out.avoid, mats.k7);
    out.poles = findPoles(thickAll, cardMask);

    // 3) 細い黒線: ブラックハット(周りより暗い細い所)で、明るさの変化に強く検出
    const thin = M();
    cv.morphologyEx(V, thin, cv.MORPH_BLACKHAT, mats.k11);
    cv.threshold(thin, thin, lineT, 255, cv.THRESH_BINARY);
    cv.bitwise_and(thin, cardMask, thin);
    // 太い黒の周りは除外
    const thick = M();
    cv.bitwise_and(thickAll, cardMask, thick);
    cv.dilate(thick, thick, mats.k15);
    cv.subtract(thin, thick, thin);
    if (debug && SHOW_MASK === 'thin') cv.imshow(maskView, thin);

    // 4) 線のかたまりのうち、一番大きいものと同じ直線上にあるものをまとめる (電柱で途切れても繋がる)
    const joined = M();
    cv.dilate(thin, joined, mats.k7);
    out.quad = collectTrack(joined, thin.data);
    return out;
  } finally {
    keep.forEach((m) => m.delete());
  }
}

// 電柱の候補: 縦長の太い黒で、根元が段ボールの上にあるもの
function findPoles(thick, cardMask) {
  const labels = new cv.Mat(), stats = new cv.Mat(), cents = new cv.Mat();
  const res = [];
  try {
    const n = cv.connectedComponentsWithStats(thick, labels, stats, cents, 8, cv.CV_32S);
    const L = labels.data32S, C = cardMask.data;
    for (let i = 1; i < n; i++) {
      const x = stats.intAt(i, cv.CC_STAT_LEFT), y = stats.intAt(i, cv.CC_STAT_TOP);
      const w = stats.intAt(i, cv.CC_STAT_WIDTH), h = stats.intAt(i, cv.CC_STAT_HEIGHT);
      if (h < w * 1.5 || w > pw * 0.15 || stats.intAt(i, cv.CC_STAT_AREA) < pw * ph * 0.0005) continue;
      // 一番下の行と一番上の行の中心
      const rowMid = (yy) => { let sx = 0, c = 0; for (let xx = x; xx < x + w; xx++) if (L[yy * pw + xx] === i) { sx += xx; c++; } return c ? sx / c : null; };
      const by = y + h - 1, bx = rowMid(by), ty = y, tx = rowMid(ty);
      if (bx === null || tx === null || !C[by * pw + Math.round(bx)]) continue;
      let wsum = 0, wc = 0;   // 下の方の太さ
      for (let yy = Math.max(y, by - 6); yy <= by; yy++) { let c = 0; for (let xx = x; xx < x + w; xx++) if (L[yy * pw + xx] === i) c++; wsum += c; wc++; }
      res.push({ base: [bx, by], top: [tx, ty], width: wsum / wc });
    }
  } finally { labels.delete(); stats.delete(); cents.delete(); }
  return res;
}

function percentile(arr, q) {
  const s = Float64Array.from(arr).sort();
  return s[Math.min(s.length - 1, Math.max(0, Math.round(q / 100 * (s.length - 1))))];
}

function collectTrack(mask, thinData) {
  const labels = new cv.Mat(), stats = new cv.Mat(), cents = new cv.Mat();
  try {
    const n = cv.connectedComponentsWithStats(mask, labels, stats, cents, 8, cv.CV_32S);
    if (n < 2) return null;
    const area = (i) => stats.intAt(i, cv.CC_STAT_AREA);
    let big = 1;
    for (let i = 2; i < n; i++) if (area(i) > area(big)) big = i;
    if (area(big) < pw * ph * 0.004) return null;
    const L = labels.data32S;

    // 一番大きい塊の主軸 (= 線路のおおよその向き)
    let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, c = 0;
    for (let y = 0, idx = 0; y < ph; y++) for (let x = 0; x < pw; x++, idx++) {
      if (L[idx] !== big) continue;
      sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; c++;
    }
    const mx = sx / c, my = sy / c;
    const th = 0.5 * Math.atan2(2 * (sxy / c - mx * my), (sxx / c - mx * mx) - (syy / c - my * my));
    const vx = Math.cos(th), vy = Math.sin(th);
    const perp = (x, y) => Math.abs((x - mx) * vy - (y - my) * vx);

    // 線路の幅 (主軸からの距離の98%点) → この帯の中を線路とみなす
    const hist = new Uint32Array(Math.ceil(Math.hypot(pw, ph)) + 1);
    for (let y = 0, idx = 0; y < ph; y++) for (let x = 0; x < pw; x++, idx++) if (L[idx] === big) hist[perp(x, y) | 0]++;
    let acc = 0, wmax = 0;
    while (acc < c * 0.98 && wmax < hist.length) acc += hist[wmax++];
    const limit = wmax * 1.3 + 3;

    // 半分以上が帯の中にある塊を採用 (電柱で途切れた部分も拾う)
    const inside = new Uint32Array(n), total = new Uint32Array(n);
    for (let y = 0, idx = 0; y < ph; y++) for (let x = 0; x < pw; x++, idx++) {
      const l = L[idx]; if (!l) continue;
      total[l]++; if (perp(x, y) < limit) inside[l]++;
    }
    const ok = new Uint8Array(n);
    for (let i = 1; i < n; i++) ok[i] = i === big || (total[i] >= 20 && inside[i] >= total[i] * 0.5) ? 1 : 0;

    // 帯の中の、膨張前の線の画素を集める。画面の端に触れていたら (線路がはみ出している) 不採用
    const P = [];
    for (let y = 0, idx = 0; y < ph; y++) for (let x = 0; x < pw; x++, idx++) {
      if (!thinData[idx] || !ok[L[idx]] || perp(x, y) >= limit) continue;
      if (x < 3 || y < 3 || x >= pw - 3 || y >= ph - 3) return null;
      P.push(x, y);
    }
    return fitBand(P);
  } finally {
    labels.delete(); stats.delete(); cents.delete();
  }
}

// 線の点群に「2本のレール = 2本の直線」を当てはめて四隅を求める
function fitBand(P) {
  const n = P.length / 2;
  if (n < 50) return null;
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += P[2 * i]; my += P[2 * i + 1]; }
  mx /= n; my /= n;
  let cxx = 0, cyy = 0, cxy = 0;
  for (let i = 0; i < n; i++) { const dx = P[2 * i] - mx, dy = P[2 * i + 1] - my; cxx += dx * dx; cyy += dy * dy; cxy += dx * dy; }
  const th = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
  const d = [Math.cos(th), Math.sin(th)], nr = [-d[1], d[0]];
  const t = new Float64Array(n), s = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const dx = P[2 * i] - mx, dy = P[2 * i + 1] - my;
    t[i] = dx * d[0] + dy * d[1]; s[i] = dx * nr[0] + dy * nr[1];
  }
  const t0 = percentile(t, 1), t1 = percentile(t, 99), NB = 16;

  // 線路方向に区切り、各区間の外側 (上位/下位5%) を直線で近似。外れ値は2回まで除く
  const fitEdge = (q) => {
    const xs = [], ys = [];
    for (let b = 0; b < NB; b++) {
      const lo = t0 + (t1 - t0) * b / NB, hi = t0 + (t1 - t0) * (b + 1) / NB;
      const sel = [];
      for (let i = 0; i < n; i++) if (t[i] >= lo && t[i] < hi) sel.push(s[i]);
      if (sel.length >= 5) { xs.push((lo + hi) / 2); ys.push(percentile(sel, q)); }
    }
    if (xs.length < 3) return null;
    let use = xs.map(() => true), a = 0, c = 0;
    for (let it = 0; it < 3; it++) {
      let k = 0, Sx = 0, Sy = 0, Sxx = 0, Sxy = 0;
      xs.forEach((x, i) => { if (use[i]) { k++; Sx += x; Sy += ys[i]; Sxx += x * x; Sxy += x * ys[i]; } });
      const den = k * Sxx - Sx * Sx;
      if (k < 2 || !den) return null;
      a = (k * Sxy - Sx * Sy) / den; c = (Sy - a * Sx) / k;
      const r = xs.map((x, i) => Math.abs(ys[i] - (a * x + c)));
      const thr = Math.max(2 * percentile(r, 50), 1.5);
      use = r.map((v) => v <= thr);
    }
    return (x) => a * x + c;
  };
  const up = fitEdge(95), lo = fitEdge(5);
  if (!up || !lo) return null;

  // 各レールの端 = そのレールに沿った点の範囲 (遠近による端の傾きも表せる)
  const tol = Math.max(2, 0.2 * Math.abs(up(0) - lo(0)));
  const ends = (f) => {
    const ts = [];
    for (let i = 0; i < n; i++) if (Math.abs(s[i] - f(t[i])) < tol) ts.push(t[i]);
    return ts.length < 10 ? null : [percentile(ts, 0.5), percentile(ts, 99.5)];
  };
  const eu = ends(up), el = ends(lo);
  if (!eu || !el) return null;
  const pt = (tt, ss) => [mx + d[0] * tt + nr[0] * ss, my + d[1] * tt + nr[1] * ss];
  return [pt(el[0], lo(el[0])), pt(el[1], lo(el[1])), pt(eu[1], up(eu[1])), pt(eu[0], up(eu[0]))];
}

// 角を「長い辺が p0→p1」になるよう並べる
function orderQuad(q) {
  const cx = q.reduce((s, p) => s + p[0], 0) / 4, cy = q.reduce((s, p) => s + p[1], 0) / 4;
  const p = [...q].sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  return d(p[0], p[1]) + d(p[2], p[3]) >= d(p[1], p[2]) + d(p[3], p[0]) ? p : [p[1], p[2], p[3], p[0]];
}

// ---- 姿勢推定: 四角形のホモグラフィーから直接求める (焦点距離も自動補正) ----
const fSamples = [];
function median(a) { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; }

function invert3(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d].map((v) => v / det);
}

// img: 線路の四隅 (元映像の px)。p0→p1 が長辺
function solvePose(img) {
  const cx = srcW / 2, cy = srcH / 2;
  const src = cv.matFromArray(4, 2, cv.CV_32F, [0, 0, 1, 0, 1, 1, 0, 1]);
  const dst = cv.matFromArray(4, 2, cv.CV_32F, img.flatMap(([x, y]) => [x - cx, y - cy]));
  const Hm = cv.getPerspectiveTransform(src, dst);
  const H = Array.from(Hm.data64F);
  src.delete(); dst.delete(); Hm.delete();
  const h1 = [H[0], H[3], H[6]], h2 = [H[1], H[4], H[7]], h3 = [H[2], H[5], H[8]];

  // 線路の2辺が直交する条件から焦点距離を推定
  if (autoFocal) {
    const f2 = -(h1[0] * h2[0] + h1[1] * h2[1]) / (h1[2] * h2[2]);
    const f0 = FOCAL_RATIO * Math.max(srcW, srcH);
    if (f2 > 0 && Math.sqrt(f2) > f0 * 0.5 && Math.sqrt(f2) < f0 * 1.8) {
      fSamples.push(Math.sqrt(f2));
      if (fSamples.length > 90) fSamples.shift();
      if (fSamples.length >= 10) {
        const fm = median(fSamples);
        if (Math.abs(fm - focal) / focal > 0.01) { focal = fm; updateCamera(); }
      }
    }
  }

  const f = focal;
  const a = (h) => new THREE.Vector3(h[0] / f, h[1] / f, h[2]);
  const a1 = a(h1), a2 = a(h2), a3 = a(h3);
  if (a3.z < 0) { a1.negate(); a2.negate(); a3.negate(); }
  const lambda = a1.length() / TRACK_L;
  const center = a1.clone().multiplyScalar(0.5).addScaledVector(a2, 0.5).add(a3).divideScalar(lambda);
  const X = a1.clone().normalize();
  const N = new THREE.Vector3().crossVectors(a1, a2).normalize();
  if (N.dot(center) > 0) N.negate();               // 上向き = カメラ側
  const Y = new THREE.Vector3().crossVectors(N, X);
  const aspect = a1.length() / a2.length();
  if (center.z <= 0 || aspect < 2) return null;    // 明らかにおかしい形は捨てる
  const Hinv = invert3(H);
  return {
    R: [X.x, Y.x, N.x, X.y, Y.y, N.y, X.z, Y.z, N.z],
    t: [center.x, center.y, center.z],
    N, aspect,
    // 画面上の点 (元映像の px) → 線路の平面上の3D点 (OpenCVカメラ座標)
    toPlane(x, y) {
      const X0 = x - cx, Y0 = y - cy;
      const w = Hinv[6] * X0 + Hinv[7] * Y0 + Hinv[8];
      const u = (Hinv[0] * X0 + Hinv[1] * Y0 + Hinv[2]) / w, v = (Hinv[3] * X0 + Hinv[4] * Y0 + Hinv[5]) / w;
      return a1.clone().multiplyScalar(u).addScaledVector(a2, v).add(a3).divideScalar(lambda);
    },
    project(P) { return [f * P.x / P.z + cx, f * P.y / P.z + cy]; },
  };
}

// OpenCVカメラ座標 (x右, y下, z前) → Three.js (x右, y上, z後)
const tmpM = new THREE.Matrix4(), tgtPos = new THREE.Vector3(), tgtQuat = new THREE.Quaternion(), tmpScale = new THREE.Vector3();
const curPos = new THREE.Vector3(), curQuat = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1);
const flipZ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI);
const ax = new THREE.Vector3(), bx = new THREE.Vector3();
let hasPose = false;

function applyPose({ R, t }) {
  tmpM.set(
    R[0], R[1], R[2], t[0],
    -R[3], -R[4], -R[5], -t[1],
    -R[6], -R[7], -R[8], -t[2],
    0, 0, 0, 1,
  );
  tmpM.decompose(tgtPos, tgtQuat, tmpScale);
  if (!hasPose) {
    curPos.copy(tgtPos); curQuat.copy(tgtQuat); hasPose = true;
  } else {
    // 線路は前後どちら向きでも同じ形なので、前フレームと向きを揃える
    ax.set(1, 0, 0).applyQuaternion(tgtQuat);
    bx.set(1, 0, 0).applyQuaternion(curQuat);
    if (ax.dot(bx) < 0) tgtQuat.multiply(flipZ);
    curPos.lerp(tgtPos, 0.7);
    curQuat.slerp(tgtQuat, 0.7);
  }
  anchor.matrix.compose(curPos, curQuat, one);
  anchor.matrixWorldNeedsUpdate = true;
  anchor.updateMatrixWorld(true);
}

// ---- 追跡: 一度見つけた線路の四隅を、段ボールや机の模様の動き (オプティカルフロー) で追い続ける ----
let corners = null;          // 線路の四隅 (処理画像の px)。画面外に出ても保持する
let prevGray = null, prevPts = null, frameNo = 0, lastGood = 0, lkWin = null;

function transformQuad(q, Hm) {
  const src = cv.matFromArray(4, 1, cv.CV_32FC2, q.flat()), dst = new cv.Mat();
  cv.perspectiveTransform(src, dst, Hm);
  const d = dst.data32F, r = [0, 1, 2, 3].map((i) => [d[2 * i], d[2 * i + 1]]);
  src.delete(); dst.delete();
  return r;
}

// 検出した四角形の角の順番を、追跡中の四隅に一番近くなるよう並べ替える
function matchOrder(q, ref) {
  let best = q, bestD = Infinity;
  for (const rev of [false, true]) {
    const b = rev ? [...q].reverse() : q;
    for (let s = 0; s < 4; s++) {
      const c = [0, 1, 2, 3].map((i) => b[(i + s) % 4]);
      const dsum = c.reduce((acc, p, i) => acc + Math.hypot(p[0] - ref[i][0], p[1] - ref[i][1]), 0);
      if (dsum < bestD) { bestD = dsum; best = c; }
    }
  }
  return { q: best, meanDist: bestD / 4 };
}

// 追跡に使う点: 線路の周り (段ボールと机の平面) から。電柱など太い黒の周りは除く
function pickFeatures(gray, avoid) {
  const m = cv.Mat.zeros(ph, pw, cv.CV_8U);
  const c = orderQuad(corners);
  const mid = (p, q) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
  const ctr = [(c[0][0] + c[1][0] + c[2][0] + c[3][0]) / 4, (c[0][1] + c[1][1] + c[2][1] + c[3][1]) / 4];
  const e0 = mid(c[0], c[3]), e1 = mid(c[1], c[2]), s0 = mid(c[0], c[1]), s1 = mid(c[2], c[3]);
  const u = [(e1[0] - e0[0]) / 2, (e1[1] - e0[1]) / 2], v = [(s1[0] - s0[0]) / 2, (s1[1] - s0[1]) / 2];
  // 線路の長さ方向に1.2倍、幅方向に3倍 (≒段ボール全体) の範囲
  const poly = [[1.2, 3], [1.2, -3], [-1.2, -3], [-1.2, 3]]
    .map(([i, j]) => [Math.round(ctr[0] + u[0] * i + v[0] * j), Math.round(ctr[1] + u[1] * i + v[1] * j)]);
  const pm = cv.matFromArray(4, 1, cv.CV_32SC2, poly.flat());
  const mv = new cv.MatVector(); mv.push_back(pm);
  cv.drawContours(m, mv, 0, new cv.Scalar(255), -1);
  mv.delete(); pm.delete();
  cv.subtract(m, avoid, m);
  const pts = new cv.Mat();
  cv.goodFeaturesToTrack(gray, pts, 200, 0.01, 6, m, 3);
  m.delete();
  return pts;
}

// 前フレームからの点の動きで平面の動き (ホモグラフィー) を求め、四隅を動かす
function track(gray) {
  if (!prevGray || !prevPts || prevPts.rows < 8 || !corners) return false;
  lkWin ??= new cv.Size(21, 21);
  const next = new cv.Mat(), status = new cv.Mat(), err = new cv.Mat();
  try {
    cv.calcOpticalFlowPyrLK(prevGray, gray, prevPts, next, status, err, lkWin, 3);
    const a = [], b = [];
    for (let i = 0; i < status.rows; i++) {
      if (!status.data[i]) continue;
      const x = next.data32F[2 * i], y = next.data32F[2 * i + 1];
      if (x < 0 || y < 0 || x >= pw || y >= ph) continue;
      a.push(prevPts.data32F[2 * i], prevPts.data32F[2 * i + 1]); b.push(x, y);
    }
    if (a.length < 16) return false;
    const am = cv.matFromArray(a.length / 2, 1, cv.CV_32FC2, a), bm = cv.matFromArray(b.length / 2, 1, cv.CV_32FC2, b);
    const inl = new cv.Mat();
    const Hm = cv.findHomography(am, bm, cv.RANSAC, 2.5, inl);
    let ok = false;
    if (!Hm.empty()) {
      const keep = [];
      for (let i = 0; i < inl.rows; i++) if (inl.data[i]) keep.push(b[2 * i], b[2 * i + 1]);
      if (keep.length >= 16) {
        corners = transformQuad(corners, Hm);
        prevPts.delete();
        prevPts = cv.matFromArray(keep.length / 2, 1, cv.CV_32FC2, keep);
        ok = true;
      }
    }
    am.delete(); bm.delete(); inl.delete(); Hm.delete();
    return ok;
  } finally { next.delete(); status.delete(); err.delete(); }
}

// ---- 電柱: 位置と高さを測って、見えない円柱 (奥行きだけ書く) を置く → 電車が後ろを通ると隠れる ----
const poleSamples = [];
const occluder = new THREE.Mesh(
  new THREE.CylinderGeometry(1, 1, 1, 24),
  new THREE.MeshBasicMaterial({ colorWrite: false }),
);
occluder.rotation.x = Math.PI / 2;   // 円柱の軸 (Y) → 線路のZ (上)
occluder.renderOrder = -1;           // 電車より先に奥行きを書く
occluder.visible = false;
anchor.add(occluder);
const poleTmp = new THREE.Vector3(), anchorInv = new THREE.Matrix4();

function measurePoles(poles, pose) {
  if (!poles.length || poleSamples.length >= 30) return;
  const k = srcW / pw;
  anchorInv.copy(anchor.matrix).invert();
  for (const p of poles) {
    const B = pose.toPlane(p.base[0] * k, p.base[1] * k);
    if (B.z <= 0) continue;
    // 高さ: 根元から上向きに伸ばして、画面上のてっぺんに一番近くなる長さ
    const top = [p.top[0] * k, p.top[1] * k];
    let bestH = 0, bestD = Infinity;
    for (let h = 0.02; h <= 0.5; h += 0.002) {
      const [x, y] = pose.project(B.clone().addScaledVector(pose.N, h));
      const d = Math.hypot(x - top[0], y - top[1]);
      if (d < bestD) { bestD = d; bestH = h; }
    }
    const r = p.width * k * B.z / focal / 2;
    poleTmp.set(B.x, -B.y, -B.z).applyMatrix4(anchorInv);   // 線路座標へ
    if (Math.abs(poleTmp.x) > TRACK_L / 2 + 0.1 || Math.abs(poleTmp.y) > 0.15) continue;
    poleSamples.push([poleTmp.x, poleTmp.y, bestH, r]);
  }
  if (poleSamples.length >= 5) {
    const m = [0, 1, 2, 3].map((i) => median(poleSamples.map((s) => s[i])));
    // 見た目より少し太く・高くして、隠れ残りが出ないようにする
    occluder.position.set(m[0], m[1], m[2] * 1.1 / 2);
    occluder.scale.set(m[3] * 1.3, m[2] * 1.1, m[3] * 1.3);
    occluder.visible = true;
  }
}

function resetTracking() {
  corners = null; hasPose = false;
  if (prevPts) { prevPts.delete(); prevPts = null; }
  poleSamples.length = 0; occluder.visible = false;
}

const aspectSamples = [];
function drawDebug(quad, pose, tracked) {
  octx.clearRect(0, 0, overlay.width, overlay.height);
  const s = overlay.width / pw;
  const poly = (q, color) => {
    octx.strokeStyle = color; octx.lineWidth = 3; octx.beginPath();
    q.forEach(([x, y], i) => (i ? octx.lineTo(x * s, y * s) : octx.moveTo(x * s, y * s)));
    octx.closePath(); octx.stroke();
  };
  if (corners) poly(orderQuad(corners), tracked ? '#0af' : '#888');   // 追跡中の四隅 (水色)
  if (quad) poly(orderQuad(quad), '#0f0');                            // このフレームで検出した線路 (緑)
  if (prevPts) {
    octx.fillStyle = '#ff0';                                          // 追跡点 (黄)
    for (let i = 0; i < prevPts.rows; i++) octx.fillRect(prevPts.data32F[2 * i] * s - 1, prevPts.data32F[2 * i + 1] * s - 1, 3, 3);
  }
  if (pose) { aspectSamples.push(pose.aspect); if (aspectSamples.length > 60) aspectSamples.shift(); }
  const asp = aspectSamples.length ? median(aspectSamples) : 0;
  const fr = focal / Math.max(srcW, srcH);
  focalVal.textContent = fr.toFixed(2);
  if (autoFocal) focalInput.value = Math.round(fr * 100);
  const pole = occluder.visible ? ` / 電柱 高さ${(occluder.scale.y * 100).toFixed(0)}cm` : '';
  debugInfo.textContent = `焦点 ${fr.toFixed(2)} / 幅≈${asp ? (TRACK_L / asp * 100).toFixed(1) : '-'}cm / 追跡点 ${prevPts ? prevPts.rows : 0}${pole}`;
}

// ---- メインループ ----
let source = null, travel = 0, lastT = performance.now();
const LOST_TRACK_MS = 1500;   // 追跡も検出もできない状態がこれだけ続いたらやり直し

function setStatus(msg) { statusEl.hidden = !msg; statusEl.textContent = msg; }

function loop(now) {
  requestAnimationFrame(loop);
  const dt = Math.min((now - lastT) / 1000, 0.1); lastT = now;
  if (SIM) simDraw(now);
  const ready = TEST ? (source.complete ?? true) : video.readyState >= 2;
  if (!ready) return;
  frameNo++;

  let A = null, tracked = false, pose = null;
  try {
    A = analyze(source);
    tracked = track(A.gray);
    if (A.quad) {
      if (!corners) corners = A.quad;
      else {
        // 検出結果で追跡のずれを少しずつ補正。追跡できているのに検出が大きく食い違うときは、
        // 検出の方が誤り (線路の一部しか写っていない等) とみなして使わない
        const { q, meanDist } = matchOrder(A.quad, corners);
        const diag = Math.hypot(pw, ph);
        const w = !tracked ? 1 : meanDist < diag * 0.03 ? 0.15 : meanDist < diag * 0.08 ? 0.05 : 0;
        corners = corners.map((p, i) => [p[0] + (q[i][0] - p[0]) * w, p[1] + (q[i][1] - p[1]) * w]);
      }
    }
    if (A.quad || tracked) lastGood = now;
    if (corners && now - lastGood > LOST_TRACK_MS) resetTracking();

    if (corners) {
      const k = srcW / pw;
      pose = solvePose(orderQuad(corners).map(([x, y]) => [x * k, y * k]));
      if (pose) { applyPose(pose); measurePoles(A.poles, pose); }
      // 追跡点の補充
      if (!prevPts || prevPts.rows < 60 || frameNo % 20 === 0) {
        if (prevPts) prevPts.delete();
        prevPts = pickFeatures(A.gray, A.avoid);
      }
    }
    if (debug) drawDebug(A.quad, pose, tracked);
  } catch (e) {
    console.error(e);
  } finally {
    if (A) {
      if (prevGray) prevGray.delete();
      prevGray = A.gray;
      A.avoid.delete();
    }
  }

  const visible = !!corners && hasPose;
  anchor.visible = visible && trainReady;
  setStatus(visible ? '' : '段ボールの線路全体を画面に入れてください');

  // 電車は (見えていなくても) 走り続ける
  travel = (travel + SPEED * dt) % (TRACK_L + TRAIN_LEN + GAP);
  trainPivot.position.x = -TRACK_L / 2 - TRAIN_LEN / 2 + travel;
  if (anchor.visible) {
    anchor.updateMatrixWorld(true);
    localClips.forEach((p, i) => worldClips[i].copy(p).applyMatrix4(anchor.matrixWorld));
  }
  renderer.render(scene, camera);
}

// ?test=N&sim : テスト画像をカメラが動いているように動かして追跡を確かめる
const SIM = TEST && params.has('sim');
let simImg = null, simCtx = null;
function simDraw(now) {
  const t = now / 1000, c = simCtx.canvas;
  simCtx.setTransform(1, 0, 0, 1, 0, 0);
  simCtx.fillStyle = '#000'; simCtx.fillRect(0, 0, c.width, c.height);
  const sc = 1.15 + 0.35 * Math.sin(t * 0.5);
  simCtx.translate(c.width / 2 + Math.sin(t * 0.7) * c.width * 0.3, c.height / 2 + Math.cos(t * 0.45) * c.height * 0.12);
  simCtx.rotate(Math.sin(t * 0.3) * 0.25);
  simCtx.scale(sc, sc);
  simCtx.drawImage(simImg, -c.width / 2, -c.height / 2, c.width, c.height);
}

async function startCamera() {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
  });
  video.srcObject = stream;
  await video.play();
  await new Promise((r) => (video.videoWidth ? r() : video.addEventListener('loadedmetadata', r, { once: true })));
  return video;
}

function useTestImage() {
  const img = new Image();
  img.src = `test/track${TEST || 1}.jpg`;
  return new Promise((r) => (img.onload = () => {
    if (!SIM) { video.replaceWith(img); r(img); return; }
    const c = document.createElement('canvas');
    c.width = img.naturalWidth / 2; c.height = img.naturalHeight / 2;
    simImg = img; simCtx = c.getContext('2d');
    video.replaceWith(c);
    r(c);
  }));
}

async function start() {
  startBtn.disabled = true; startBtn.textContent = '起動中…';
  try {
    source = TEST ? await useTestImage() : await startCamera();
  } catch (e) {
    console.error(e);
    loadMsg.textContent = 'カメラを起動できませんでした: ' + e.message;
    startBtn.disabled = false; startBtn.textContent = 'もう一度試す';
    return;
  }
  srcW = source.videoWidth || source.naturalWidth || source.width;
  srcH = source.videoHeight || source.naturalHeight || source.height;
  focal = (savedFocal && !autoFocal ? +savedFocal : FOCAL_RATIO) * Math.max(srcW, srcH);
  pw = PROC_W; ph = Math.round(PROC_W * srcH / srcW);
  proc.width = pw; proc.height = ph;
  initMats();
  layout();
  $('start').hidden = true;
  debugBtn.hidden = false; debugPanel.hidden = !debug;
  requestAnimationFrame(loop);
}

loadMsg.textContent = '画像認識エンジンを読み込んでいます（初回は少し時間がかかります）';
loadOpenCV().then(() => {
  loadMsg.textContent = '';
  startBtn.disabled = false;
  startBtn.textContent = TEST ? 'テスト画像で開始' : 'カメラを起動';
  startBtn.onclick = start;
}).catch((e) => { loadMsg.textContent = e.message; });
