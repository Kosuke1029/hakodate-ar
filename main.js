import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// ---- 設定 ----
const TRACK_L = 0.60;        // 段ボールの線路の長さ [m]（縦横比はカメラ映像から自動で測る）
const TRAIN_LEN = 0.32;      // 電車の長さ [m]
const SPEED = 0.18;          // 走行速度 [m/s]
const GAP = 0.20;            // 1周ごとの間隔 [m]
const PROC_W = 480;          // 画像処理の横幅 [px]
const FOCAL_RATIO = 0.75;    // 焦点距離の初期値 ≒ 長辺px × この値（実行中に自動補正）
const DETECT_INTERVAL = 4;   // 追跡中は何フレームごとに線路検出で補正するか
const LOST_TRACK_MS = 1500;  // 追跡も検出もできない状態がこれだけ続いたらやり直し

const params = new URLSearchParams(location.search);
const TEST = params.get('test');           // ?test=1〜8 で test/trackN.jpg を使う
const SIM = TEST && params.has('sim');     // ?test=N&sim でカメラが動いているように画像を動かす
const FIXED_F = params.get('f');           // ?f=0.8 で焦点距離を固定

// ---- DOM ----
const $ = (id) => document.getElementById(id);
const stage = $('stage'), video = $('video'), frameCanvas = $('frame'), glCanvas = $('gl'), overlay = $('overlay');
const startBtn = $('startBtn'), loadMsg = $('loadMsg'), statusEl = $('status');
const debugBtn = $('debugBtn'), debugPanel = $('debugPanel'), maskView = $('maskView');
const threshInput = $('thresh'), threshVal = $('threshVal'), debugInfo = $('debugInfo');
const focalInput = $('focal'), focalVal = $('focalVal'), focalAuto = $('focalAuto');
const octx = overlay.getContext('2d');
const fctx = frameCanvas.getContext('2d');

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
focalInput.oninput = () => {
  autoFocal = false; focalAuto.checked = false;
  store.set('focalAuto', '0'); store.set('focal', focalInput.value / 100);
  if (srcW) { focal = focalInput.value / 100 * Math.max(srcW, srcH); updateCamera(); }
};
focalAuto.onchange = () => {
  autoFocal = focalAuto.checked; store.set('focalAuto', autoFocal ? '1' : '0');
  fSamples.length = 0;
};
debugBtn.onclick = () => { debug = !debug; debugPanel.hidden = !debug; if (!debug) octx.clearRect(0, 0, overlay.width, overlay.height); };

// ---- OpenCV 読み込み (メイン側は追跡だけに使う。検出は worker.js) ----
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

// 電柱: 位置と高さを測って、見えない円柱 (奥行きだけ書く) を置く → 電車が後ろを通ると隠れる
const occluder = new THREE.Mesh(
  new THREE.CylinderGeometry(1, 1, 1, 24),
  new THREE.MeshBasicMaterial({ colorWrite: false }),
);
occluder.rotation.x = Math.PI / 2;   // 円柱の軸 (Y) → 線路のZ (上)
occluder.renderOrder = -1;           // 電車より先に奥行きを書く
occluder.visible = false;
anchor.add(occluder);

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

// ---- 姿勢推定: 四角形のホモグラフィーから直接求める (焦点距離も自動補正) ----
const fSamples = [];
function median(a) { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; }

function invert3(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d].map((v) => v / det);
}
function applyH(H, [x, y]) {
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

// 角を「長い辺が p0→p1」になるよう並べる
function orderQuad(q) {
  const cx = q.reduce((s, p) => s + p[0], 0) / 4, cy = q.reduce((s, p) => s + p[1], 0) / 4;
  const p = [...q].sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  return d(p[0], p[1]) + d(p[2], p[3]) >= d(p[1], p[2]) + d(p[3], p[0]) ? p : [p[1], p[2], p[3], p[0]];
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
    X, Y, N, center, aspect,
    // 画面上の点 (元映像の px) → 線路の平面上の3D点 (OpenCVカメラ座標)
    toPlane(x, y) {
      const [u, v] = applyH(Hinv, [x - cx, y - cy]);
      return a1.clone().multiplyScalar(u).addScaledVector(a2, v).add(a3).divideScalar(lambda);
    },
    project(P) { return [f * P.x / P.z + cx, f * P.y / P.z + cy]; },
  };
}

// OpenCVカメラ座標 (x右, y下, z前) → Three.js (x右, y上, z後)。補間はしない (映像と同じフレームに合わせる)
const tmpM = new THREE.Matrix4(), tgtPos = new THREE.Vector3(), tgtQuat = new THREE.Quaternion(), tmpScale = new THREE.Vector3();
const curQuat = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1);
const flipZ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI);
const ax = new THREE.Vector3(), bx = new THREE.Vector3();
let hasPose = false;

function applyPose({ X, Y, N, center }) {
  tmpM.set(
    X.x, Y.x, N.x, center.x,
    -X.y, -Y.y, -N.y, -center.y,
    -X.z, -Y.z, -N.z, -center.z,
    0, 0, 0, 1,
  );
  tmpM.decompose(tgtPos, tgtQuat, tmpScale);
  // 線路は前後どちら向きでも同じ形なので、前フレームと向きを揃える
  if (hasPose) {
    ax.set(1, 0, 0).applyQuaternion(tgtQuat);
    bx.set(1, 0, 0).applyQuaternion(curQuat);
    if (ax.dot(bx) < 0) tgtQuat.multiply(flipZ);
  }
  curQuat.copy(tgtQuat); hasPose = true;
  anchor.matrix.compose(tgtPos, tgtQuat, one);
  anchor.matrixWorldNeedsUpdate = true;
  anchor.updateMatrixWorld(true);
}

// ---- 追跡: 一度見つけた線路の四隅を、段ボールや机の模様の動き (オプティカルフロー) で毎フレーム動かす ----
const proc = document.createElement('canvas');
const pctx = proc.getContext('2d', { willReadFrequently: true });
let pw = 0, ph = 0;
let corners = null;          // 線路の四隅 (処理画像の px)。画面外に出ても保持する
let prevGray = null, prevPts = null, frameId = 0, lastGood = 0, lkWin = null;
const history = new Map();   // frameId → { H: 前フレームからの動き, pose }  (検出結果を今のフレームまで運ぶため)

// 追跡に使う点: 線路の周り (段ボールと机の平面) から
function pickFeatures(gray) {
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
  // 電柱は平面から飛び出しているので、追跡に使うとずれの原因になる → 除外
  if (occluder.visible) {
    const P = (x, y, z) => new THREE.Vector3(x, y, z).applyMatrix4(anchor.matrixWorld).project(camera);
    const toPx = (v) => new cv.Point((v.x + 1) / 2 * pw, (1 - v.y) / 2 * ph);
    const { x, y } = occluder.position;
    const base = P(x, y, 0), top = P(x, y, occluder.scale.y), side = P(x + occluder.scale.x, y, 0);
    const thick = Math.max(8, Math.hypot((side.x - base.x) / 2 * pw, (side.y - base.y) / 2 * ph) * 4);
    cv.line(m, toPx(base), toPx(top), new cv.Scalar(0), Math.round(thick));
  }
  const pts = new cv.Mat();
  cv.goodFeaturesToTrack(gray, pts, 200, 0.01, 6, m, 3);
  m.delete();
  return pts;
}

// 前フレームからの点の動きで平面の動き (ホモグラフィー) を求める。失敗したら null
function track(gray) {
  if (!prevGray || !prevPts || prevPts.rows < 8) return null;
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
    if (a.length < 16) return null;
    const am = cv.matFromArray(a.length / 2, 1, cv.CV_32FC2, a), bm = cv.matFromArray(b.length / 2, 1, cv.CV_32FC2, b);
    const inl = new cv.Mat();
    const Hm = cv.findHomography(am, bm, cv.RANSAC, 2.5, inl);
    let H = null;
    if (!Hm.empty()) {
      const keep = [];
      for (let i = 0; i < inl.rows; i++) if (inl.data[i]) keep.push(b[2 * i], b[2 * i + 1]);
      if (keep.length >= 16) {
        H = Array.from(Hm.data64F);
        prevPts.delete();
        prevPts = cv.matFromArray(keep.length / 2, 1, cv.CV_32FC2, keep);
      }
    }
    am.delete(); bm.delete(); inl.delete(); Hm.delete();
    return H;
  } finally { next.delete(); status.delete(); err.delete(); }
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

function resetTracking() {
  corners = null; hasPose = false;
  if (prevPts) { prevPts.delete(); prevPts = null; }
  poleSamples.length = 0; occluder.visible = false;
}

// ---- 検出 (Web Worker) ----
const worker = new Worker('worker.js?v=8');
let workerReady = false, workerBusy = false, lastSentFrame = -99, lastMask = null, lastDetectQuad = null;
worker.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'ready') { workerReady = true; return; }
  if (m.type !== 'result') return;
  workerBusy = false;
  lastMask = m.mask;
  lastDetectQuad = m.quad;
  if (!m.quad) return;

  // 検出したのは少し前のフレーム。追跡で求めた動きを順に掛けて、今のフレームの位置に運ぶ
  let q = m.quad, carried = true;
  for (let j = m.id + 1; j <= frameId; j++) {
    const h = history.get(j);
    if (!h || !h.H) { carried = false; break; }
    q = q.map((p) => applyH(h.H, p));
  }
  lastGood = performance.now();
  if (!corners) {
    corners = q;   // 最初の1回は数フレーム前の位置のまま使い、以降の検出で補正する
  } else if (carried) {
    // 追跡のずれを少しずつ補正。大きく食い違うときは検出の方が誤り (線路の一部しか写っていない等) とみなす
    const { q: qq, meanDist } = matchOrder(q, corners);
    const diag = Math.hypot(pw, ph);
    const w = meanDist < diag * 0.03 ? 0.25 : meanDist < diag * 0.08 ? 0.08 : 0;
    corners = corners.map((p, i) => [p[0] + (qq[i][0] - p[0]) * w, p[1] + (qq[i][1] - p[1]) * w]);
  }
  // 電柱はそのフレームの姿勢で測る
  const h = history.get(m.id);
  if (h && h.pose && m.poles.length) measurePoles(m.poles, h.pose);
};

// ---- 電柱の位置・高さ・太さ ----
const poleSamples = [];
function measurePoles(poles, pose) {
  if (poleSamples.length >= 30) return;
  const k = srcW / pw;
  // そのフレームの線路の向きが、今の線路座標と前後逆なら符号を反転
  bx.set(1, 0, 0).applyQuaternion(curQuat);              // 今のX軸 (Three.js カメラ座標)
  const sameDir = pose.X.x * bx.x - pose.X.y * bx.y - pose.X.z * bx.z >= 0;
  for (const p of poles) {
    const B = pose.toPlane(p.base[0] * k, p.base[1] * k);
    if (B.z <= 0) continue;
    // 高さ: 根元から上向きに伸ばして、画面上のてっぺんに一番近くなる長さ
    const top = [p.top[0] * k, p.top[1] * k];
    let bestH = 0, bestD = Infinity;
    for (let hh = 0.02; hh <= 0.5; hh += 0.002) {
      const [x, y] = pose.project(B.clone().addScaledVector(pose.N, hh));
      const d = Math.hypot(x - top[0], y - top[1]);
      if (d < bestD) { bestD = d; bestH = hh; }
    }
    const r = p.width * k * B.z / focal / 2;
    const d = B.clone().sub(pose.center);
    let lx = d.dot(pose.X), ly = d.dot(pose.Y);
    if (!sameDir) { lx = -lx; ly = -ly; }
    if (Math.abs(lx) > TRACK_L / 2 + 0.1 || Math.abs(ly) > 0.15) continue;
    poleSamples.push([lx, ly, bestH, r]);
  }
  if (poleSamples.length >= 5) {
    const m = [0, 1, 2, 3].map((i) => median(poleSamples.map((s) => s[i])));
    // 見た目より少し太く・高くして、隠れ残りが出ないようにする
    occluder.position.set(m[0], m[1], m[2] * 1.1 / 2);
    occluder.scale.set(m[3] * 1.3, m[2] * 1.1, m[3] * 1.3);
    occluder.visible = true;
  }
}

// ---- デバッグ表示 ----
const aspectSamples = [];
let lastTracked = false, procMs = 0, fpsCount = 0, fpsT = 0, fps = 0;
function drawDebug(pose) {
  octx.clearRect(0, 0, overlay.width, overlay.height);
  const s = overlay.width / pw;
  const poly = (q, color) => {
    octx.strokeStyle = color; octx.lineWidth = 3; octx.beginPath();
    q.forEach(([x, y], i) => (i ? octx.lineTo(x * s, y * s) : octx.moveTo(x * s, y * s)));
    octx.closePath(); octx.stroke();
  };
  if (corners) poly(orderQuad(corners), lastTracked ? '#0af' : '#888');   // 追跡中の四隅 (水色)
  if (prevPts) {
    octx.fillStyle = '#ff0';                                              // 追跡点 (黄)
    for (let i = 0; i < prevPts.rows; i++) octx.fillRect(prevPts.data32F[2 * i] * s - 1, prevPts.data32F[2 * i + 1] * s - 1, 3, 3);
  }
  if (lastMask && lastMask.length === pw * ph) {
    maskView.width = pw; maskView.height = ph;
    const img = new ImageData(pw, ph);
    for (let i = 0; i < lastMask.length; i++) { const v = lastMask[i]; img.data[4 * i] = img.data[4 * i + 1] = img.data[4 * i + 2] = v; img.data[4 * i + 3] = 255; }
    maskView.getContext('2d').putImageData(img, 0, 0);
    lastMask = null;
  }
  if (pose) { aspectSamples.push(pose.aspect); if (aspectSamples.length > 60) aspectSamples.shift(); }
  const asp = aspectSamples.length ? median(aspectSamples) : 0;
  const fr = focal / Math.max(srcW, srcH);
  focalVal.textContent = fr.toFixed(2);
  if (autoFocal) focalInput.value = Math.round(fr * 100);
  const pole = occluder.visible ? ` / 電柱${(occluder.scale.y / 1.1 * 100).toFixed(0)}cm` : '';
  debugInfo.textContent = `${fps}fps 処理${procMs.toFixed(0)}ms / 焦点${fr.toFixed(2)} / 幅≈${asp ? (TRACK_L / asp * 100).toFixed(1) : '-'}cm / 追跡点${prevPts ? prevPts.rows : 0}${pole}${lastDetectQuad ? '' : ' / 検出なし'}`;
}

// ---- 1フレームの処理: 表示する映像と、電車の位置を必ず同じフレームから作る ----
function processFrame(now) {
  const t0 = performance.now();
  frameId++;
  fctx.drawImage(source, 0, 0, srcW, srcH);            // 画面に出す映像 (このフレームで固定)
  pctx.drawImage(frameCanvas, 0, 0, pw, ph);
  const imageData = pctx.getImageData(0, 0, pw, ph);

  // 線路検出は Worker へ (重いので、まだ見つけていない時は毎回・追跡中は数フレームおき)
  if (workerReady && !workerBusy && (!corners || frameId - lastSentFrame >= DETECT_INTERVAL)) {
    workerBusy = true; lastSentFrame = frameId;
    const buf = imageData.data.buffer.slice(0);
    worker.postMessage({ type: 'frame', id: frameId, buffer: buf, opt: { lineT, debug, poles: poleSamples.length < 30 } }, [buf]);
  }

  const rgba = cv.matFromImageData(imageData);
  const gray = new cv.Mat();
  cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
  rgba.delete();

  let pose = null;
  try {
    const H = corners ? track(gray) : null;
    lastTracked = !!H;
    if (H) { corners = corners.map((p) => applyH(H, p)); lastGood = now; }
    if (corners && now - lastGood > LOST_TRACK_MS) resetTracking();

    if (corners) {
      const k = srcW / pw;
      pose = solvePose(orderQuad(corners).map(([x, y]) => [x * k, y * k]));
      if (pose) applyPose(pose);
      if (!prevPts || prevPts.rows < 60 || frameId % 15 === 0) {
        if (prevPts) prevPts.delete();
        prevPts = pickFeatures(gray);
      }
    }
    history.set(frameId, { H, pose });
    history.delete(frameId - 60);
  } catch (e) {
    console.error(e);
  } finally {
    if (prevGray) prevGray.delete();
    prevGray = gray;
  }
  procMs = procMs * 0.9 + (performance.now() - t0) * 0.1;
  if (debug) drawDebug(pose);
}

// ---- メインループ: 描画は毎回 (電車はなめらかに)、画像処理は新しいカメラフレームが来た時だけ ----
let source = null, travel = 0, lastT = performance.now(), newFrame = true;

function setStatus(msg) { statusEl.hidden = !msg; statusEl.textContent = msg; }

function loop(now) {
  requestAnimationFrame(loop);
  const dt = Math.min((now - lastT) / 1000, 0.1); lastT = now;
  if (++fpsCount && now - fpsT > 1000) { fps = fpsCount; fpsCount = 0; fpsT = now; }

  if (SIM) { simDraw(now); newFrame = true; }
  const ready = TEST ? true : video.readyState >= 2;
  if (ready && newFrame) {
    if (!TEST && video.requestVideoFrameCallback) newFrame = false;
    try { processFrame(now); } catch (e) { console.error(e); }
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

// テスト用: 画像をカメラが動いているように動かす
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
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
  });
  video.srcObject = stream;
  await video.play();
  await new Promise((r) => (video.videoWidth ? r() : video.addEventListener('loadedmetadata', r, { once: true })));
  if (video.requestVideoFrameCallback) {
    const onFrame = () => { newFrame = true; video.requestVideoFrameCallback(onFrame); };
    video.requestVideoFrameCallback(onFrame);
  }
  return video;
}

function useTestImage() {
  const img = new Image();
  img.src = `test/track${TEST || 1}.jpg`;
  return new Promise((r) => (img.onload = () => {
    if (!SIM) { r(img); return; }
    const c = document.createElement('canvas');
    c.width = img.naturalWidth / 2; c.height = img.naturalHeight / 2;
    simImg = img; simCtx = c.getContext('2d');
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
  frameCanvas.width = srcW; frameCanvas.height = srcH;
  focal = (savedFocal && !autoFocal ? +savedFocal : FOCAL_RATIO) * Math.max(srcW, srcH);
  pw = PROC_W; ph = Math.round(PROC_W * srcH / srcW);
  proc.width = pw; proc.height = ph;
  pctx.imageSmoothingQuality = 'high';
  worker.postMessage({ type: 'init', width: pw, height: ph });
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
