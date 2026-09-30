import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// ---- 設定 ----
const COVER_W = 0.90;        // 黒いカバーの長辺 [m]
const COVER_H = 0.20;        // 短辺 [m]
const TRAIN_LEN = 0.30;      // 画面上の電車の長さ [m]
const SPEED = 0.15;          // 走行速度 [m/s]
const GAP = 0.25;            // 1周ごとの間隔 [m]
const PROC_W = 320;          // 画像処理の横幅 [px]
const FOCAL_RATIO = 0.75;    // 焦点距離 ≒ 長辺px × この値 (iPhone広角カメラ相当)
const LOST_MS = 600;         // 見失ってから消すまで

const OPENCV_URL = 'vendor/opencv.js';
const params = new URLSearchParams(location.search);
const TEST = params.has('test');

// ---- DOM ----
const $ = (id) => document.getElementById(id);
const stage = $('stage'), video = $('video'), glCanvas = $('gl'), overlay = $('overlay');
const startBtn = $('startBtn'), loadMsg = $('loadMsg'), statusEl = $('status');
const debugBtn = $('debugBtn'), debugPanel = $('debugPanel'), maskView = $('maskView');
const threshInput = $('thresh'), threshVal = $('threshVal');
const octx = overlay.getContext('2d');

let debug = params.has('debug');
let vThresh = 80;
threshInput.oninput = () => { vThresh = +threshInput.value; threshVal.textContent = vThresh; };
debugBtn.onclick = () => { debug = !debug; debugPanel.hidden = !debug; if (!debug) octx.clearRect(0, 0, overlay.width, overlay.height); };

// ---- OpenCV 読み込み ----
function loadOpenCV() {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = OPENCV_URL; s.async = true;
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

// カバー座標系: 原点=カバー中心, X=長辺方向, Y=短辺方向, Z=上
const anchor = new THREE.Group();
anchor.matrixAutoUpdate = false;
anchor.visible = false;
scene.add(anchor);

const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.position.set(0.15, -0.25, 1.0);
sun.target.position.set(0, 0, 0);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
Object.assign(sun.shadow.camera, { left: -0.6, right: 0.6, top: 0.6, bottom: -0.6, near: 0.1, far: 3 });
anchor.add(sun, sun.target);

const shadowPlane = new THREE.Mesh(
  new THREE.PlaneGeometry(COVER_W, COVER_H),
  new THREE.ShadowMaterial({ opacity: 0.35 })
);
shadowPlane.position.z = 0.001;
shadowPlane.receiveShadow = true;
anchor.add(shadowPlane);

// 両端でトンネルに出入りするように切り取る
const localClips = [
  new THREE.Plane(new THREE.Vector3(1, 0, 0), COVER_W / 2),
  new THREE.Plane(new THREE.Vector3(-1, 0, 0), COVER_W / 2),
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
  upright.rotation.x = Math.PI / 2;           // モデルのY上 → カバーのZ上
  upright.add(model);
  trainPivot.add(upright);
  trainReady = true;
}, undefined, (e) => console.error(e));

// ---- レイアウト (映像を画面いっぱいに cover 表示) ----
let srcW = 0, srcH = 0;
function layout() {
  if (!srcW) return;
  const W = innerWidth, H = innerHeight;
  const sc = Math.max(W / srcW, H / srcH);
  const w = srcW * sc, h = srcH * sc;
  Object.assign(stage.style, { width: w + 'px', height: h + 'px', left: (W - w) / 2 + 'px', top: (H - h) / 2 + 'px' });
  renderer.setSize(w, h, false);
  overlay.width = w; overlay.height = h;
  const f = FOCAL_RATIO * Math.max(srcW, srcH);
  camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(srcH / 2 / f));
  camera.aspect = srcW / srcH;
  camera.updateProjectionMatrix();
}
addEventListener('resize', layout);

// ---- 検出 ----
const proc = document.createElement('canvas');
const pctx = proc.getContext('2d', { willReadFrequently: true });
let pw = 0, ph = 0, kernel = null;

function detectQuad(source) {
  pctx.drawImage(source, 0, 0, pw, ph);
  const src = cv.matFromImageData(pctx.getImageData(0, 0, pw, ph));
  const hsv = new cv.Mat(), mask = new cv.Mat(), chans = new cv.MatVector();
  const contours = new cv.MatVector(), hier = new cv.Mat();
  let best = null;
  try {
    cv.cvtColor(src, hsv, cv.COLOR_RGBA2RGB);
    cv.cvtColor(hsv, hsv, cv.COLOR_RGB2HSV);
    cv.split(hsv, chans);
    cv.threshold(chans.get(2), mask, vThresh, 255, cv.THRESH_BINARY_INV); // 暗い所 = 黒カバー候補
    cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, kernel, new cv.Point(-1, -1), 2); // テカリの穴埋め
    cv.morphologyEx(mask, mask, cv.MORPH_OPEN, kernel);
    if (debug) cv.imshow(maskView, mask);

    cv.findContours(mask, contours, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    const minArea = pw * ph * 0.01;
    let bestArea = 0;
    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i);
      const area = cv.contourArea(c);
      if (area < minArea) { c.delete(); continue; }
      const r = cv.boundingRect(c);
      const touches = r.x <= 1 || r.y <= 1 || r.x + r.width >= pw - 1 || r.y + r.height >= ph - 1;
      const hull = new cv.Mat();
      cv.convexHull(c, hull, false, true);
      const hullArea = cv.contourArea(hull);
      if (!touches && area / hullArea > 0.8 && hullArea > bestArea) {
        const q = approxQuad(hull, hullArea);
        if (q) { best = q; bestArea = hullArea; }
      }
      hull.delete(); c.delete();
    }
  } finally {
    src.delete(); hsv.delete(); mask.delete(); chans.delete(); contours.delete(); hier.delete();
  }
  return best;
}

function approxQuad(hull, hullArea) {
  const peri = cv.arcLength(hull, true);
  const ap = new cv.Mat();
  try {
    for (let eps = 0.02; eps <= 0.12; eps += 0.01) {
      cv.approxPolyDP(hull, ap, eps * peri, true);
      if (ap.rows === 4) {
        const d = ap.data32S;
        const pts = [0, 1, 2, 3].map((i) => [d[i * 2], d[i * 2 + 1]]);
        if (polyArea(pts) / hullArea < 0.85) return null;
        return pts;
      }
      if (ap.rows < 4) return null;
    }
    return null;
  } finally { ap.delete(); }
}

function polyArea(p) {
  let a = 0;
  for (let i = 0; i < p.length; i++) { const j = (i + 1) % p.length; a += p[i][0] * p[j][1] - p[j][0] * p[i][1]; }
  return Math.abs(a) / 2;
}

// ---- 姿勢推定 ----
function solvePose(img) {
  const f = FOCAL_RATIO * Math.max(srcW, srcH);
  const K = cv.matFromArray(3, 3, cv.CV_64F, [f, 0, srcW / 2, 0, f, srcH / 2, 0, 0, 1]);
  const dist = cv.Mat.zeros(4, 1, cv.CV_64F);
  const obj = cv.matFromArray(4, 3, cv.CV_64F, [
    -COVER_W / 2, -COVER_H / 2, 0,  COVER_W / 2, -COVER_H / 2, 0,
     COVER_W / 2,  COVER_H / 2, 0, -COVER_W / 2,  COVER_H / 2, 0,
  ]);
  const objPts = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, y]) => [x * COVER_W / 2, y * COVER_H / 2]);
  let best = null;
  // どの辺が長辺か・点の並び順の向き、の4通りを試し、カバーが手前を向き再投影誤差が最小のものを採用
  for (const rev of [false, true]) {
    const base = rev ? [...img].reverse() : img;
    for (const shift of [0, 1]) {
      const pts = [0, 1, 2, 3].map((i) => base[(i + shift) % 4]);
      const ip = cv.matFromArray(4, 2, cv.CV_64F, pts.flat());
      const rvec = new cv.Mat(), tvec = new cv.Mat(), Rm = new cv.Mat();
      try {
        if (!cv.solvePnP(obj, ip, K, dist, rvec, tvec, false, cv.SOLVEPNP_ITERATIVE)) continue;
        cv.Rodrigues(rvec, Rm);
        const R = Array.from(Rm.data64F), t = Array.from(tvec.data64F);
        if (t[2] <= 0) continue;
        const n = [R[2], R[5], R[8]];
        if (n[0] * t[0] + n[1] * t[1] + n[2] * t[2] >= 0) continue; // 裏向き
        let err = 0;
        objPts.forEach(([X, Y], i) => {
          const x = R[0] * X + R[1] * Y + t[0], y = R[3] * X + R[4] * Y + t[1], z = R[6] * X + R[7] * Y + t[2];
          err += Math.hypot(f * x / z + srcW / 2 - pts[i][0], f * y / z + srcH / 2 - pts[i][1]);
        });
        if (!best || err < best.err) best = { R, t, err };
      } finally { ip.delete(); rvec.delete(); tvec.delete(); Rm.delete(); }
    }
  }
  K.delete(); dist.delete(); obj.delete();
  return best;
}

// OpenCVカメラ座標 (x右, y下, z前) → Three.js (x右, y上, z後)
const tmpM = new THREE.Matrix4(), tgtPos = new THREE.Vector3(), tgtQuat = new THREE.Quaternion(), tmpScale = new THREE.Vector3();
const curPos = new THREE.Vector3(), curQuat = new THREE.Quaternion();
const flipZ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI);
const ax = new THREE.Vector3(), bx = new THREE.Vector3();
let hasPose = false, lastSeen = 0;

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
    // 長方形は180°回転しても同じ形なので、前フレームと向きを揃える
    ax.set(1, 0, 0).applyQuaternion(tgtQuat);
    bx.set(1, 0, 0).applyQuaternion(curQuat);
    if (ax.dot(bx) < 0) tgtQuat.multiply(flipZ);
    curPos.lerp(tgtPos, 0.5);
    curQuat.slerp(tgtQuat, 0.5);
  }
  anchor.matrix.compose(curPos, curQuat, new THREE.Vector3(1, 1, 1));
  anchor.matrixWorldNeedsUpdate = true;
}

function drawDebug(quad) {
  octx.clearRect(0, 0, overlay.width, overlay.height);
  if (!quad) return;
  const s = overlay.width / srcW;
  octx.strokeStyle = '#0f0'; octx.lineWidth = 3;
  octx.beginPath();
  quad.forEach(([x, y], i) => (i ? octx.lineTo(x * s, y * s) : octx.moveTo(x * s, y * s)));
  octx.closePath(); octx.stroke();
}

// ---- メインループ ----
let source = null, travel = 0, lastT = performance.now();

function setStatus(msg) { statusEl.hidden = !msg; statusEl.textContent = msg; }

function loop(now) {
  requestAnimationFrame(loop);
  const dt = Math.min((now - lastT) / 1000, 0.1); lastT = now;
  const ready = TEST ? source.complete : video.readyState >= 2;
  if (!ready) return;

  let quad = null;
  try { quad = detectQuad(source); } catch (e) { console.error(e); }
  let pose = null;
  if (quad) {
    const k = srcW / pw;
    pose = solvePose(quad.map(([x, y]) => [x * k, y * k]));
  }
  if (debug) drawDebug(quad && quad.map(([x, y]) => [x * srcW / pw, y * srcW / pw]));

  if (debug) document.body.dataset.dbg = JSON.stringify({ quad, pose, fov: camera.fov, trainReady, m: anchor.matrix.elements.map((v) => +v.toFixed(3)) });
  if (pose) { applyPose(pose); lastSeen = now; }
  const visible = hasPose && now - lastSeen < LOST_MS;
  anchor.visible = visible && trainReady;
  if (!visible) hasPose = false;
  setStatus(visible ? '' : '黒いカバー全体を画面に入れてください');

  if (anchor.visible) {
    travel = (travel + SPEED * dt) % (COVER_W + TRAIN_LEN + GAP);
    trainPivot.position.x = -COVER_W / 2 - TRAIN_LEN / 2 + travel;
    anchor.updateMatrixWorld(true);
    localClips.forEach((p, i) => worldClips[i].copy(p).applyMatrix4(anchor.matrixWorld));
  }
  renderer.render(scene, camera);
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
  img.src = 'test/table.jpg';
  video.replaceWith(img);
  return new Promise((r) => (img.onload = () => r(img)));
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
  srcW = source.videoWidth || source.naturalWidth;
  srcH = source.videoHeight || source.naturalHeight;
  pw = PROC_W; ph = Math.round(PROC_W * srcH / srcW);
  proc.width = pw; proc.height = ph;
  kernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(5, 5));
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
