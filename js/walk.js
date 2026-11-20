// まちを歩く: ギャラリーの作品 (人・犬・猫) を、カメラに写った地面の上で歩かせる。
//   - WebXR (Android の Chrome など): 地面を認識して、タップした場所のまわりを歩く
//   - それ以外 (iPhone など): カメラ映像 + 向きセンサー。スマホの高さを CAM_H と仮定して地面を置く
//     (センサーも無い PC では、ドラッグで見回す)
// ?mode=camera で、WebXR が使える端末でもかんたんモードにする
import * as THREE from 'three';

const $ = (id) => document.getElementById(id);
const startPanel = $('start'), startBtn = $('startBtn'), simpleBtn = $('simpleBtn'), infoEl = $('info');
const msgEl = $('msg'), video = $('video'), canvas = $('gl');
const params = new URLSearchParams(location.search);

const MAX_CHARS = 6;     // 同時に歩くキャラの数
const AREA_R = 2.5;      // 歩き回る範囲の半径 [m]
const CAM_H = 1.4;       // かんたんモード: スマホを持つ高さ [m]
const FOCAL_RATIO = 0.8; // かんたんモード: カメラの焦点距離 ≒ 映像の長辺 × この値 (main.js と同じ)

const say = (t) => { msgEl.hidden = !t; msgEl.textContent = t || ''; };

// ---------------------------------------------------------------- Three.js
const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.05, 100);
scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f99, 1.5));

// みんなが歩く場所。原点 = 地面の上の中心、Y が上
const world = new THREE.Group();
world.visible = false;
scene.add(world);

const sun = new THREE.DirectionalLight(0xffffff, 1.8);
sun.position.set(2, 6, 3);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
Object.assign(sun.shadow.camera, { left: -4, right: 4, top: 4, bottom: -4, near: 0.5, far: 15 });
world.add(sun, sun.target);

// 影だけを地面に落とす透明な板
const ground = new THREE.Mesh(new THREE.PlaneGeometry(12, 12), new THREE.ShadowMaterial({ opacity: 0.3 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
world.add(ground);

// ---------------------------------------------------------------- キャラの読み込み
function loadDesigns() {
  try { return JSON.parse(localStorage.getItem('hakodate_designs') || '[]'); } catch { return []; }
}
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
// 最近の作品から最大 MAX_CHARS 体。作品が無ければ見本 (男性・女性・犬・猫)
function pickDesigns(MODELS) {
  const list = loadDesigns().filter((d) => MODELS[d.baseModel] && d.state);
  if (!list.length) {
    return {
      sample: true,
      designs: Object.keys(MODELS).map((k) => ({ name: '見本の' + MODELS[k].label, baseModel: k, state: MODELS[k].defaultState() })),
    };
  }
  return { sample: false, designs: shuffle(list.slice(0, 12)).slice(0, MAX_CHARS) };
}

// 名前の札 (いつもカメラの方を向く)
function nameLabel(text, h) {
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  const font = 'bold 44px system-ui, sans-serif';
  ctx.font = font;
  c.width = Math.ceil(ctx.measureText(text).width) + 44;
  c.height = 72;
  ctx.font = font;
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(0, 0, c.width, c.height, 36); else ctx.rect(0, 0, c.width, c.height);
  ctx.fill();
  ctx.fillStyle = '#1f2937';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, c.width / 2, c.height / 2 + 2);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false }));
  sp.scale.set((h * c.width) / c.height, h, 1);
  return sp;
}

// ---------------------------------------------------------------- 歩く動きのための「関節」
// モデルは手足が部品ごとに分かれている (名前の最後が L / R) ので、付け根を支点にしたグループに入れ直して振る
const boxOf = (m) => {
  if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
  return m.geometry.boundingBox.clone().translate(m.position);
};

function rigCharacter(root, isPet) {
  const meshes = [];
  root.traverse((o) => { if (o.isMesh && o.userData.part !== 'Face') meshes.push(o); });

  // 人: 脚の付け根の高さ (太ももの上の端)
  let hipY = 0.62;
  if (!isPet) {
    const thighs = new THREE.Box3();
    meshes.forEach((m) => { if (/_Thigh_[LR]$/.test(m.name)) thighs.union(boxOf(m)); });
    if (!thighs.isEmpty()) hipY = thighs.max.y;
  }

  const sets = new Map(); // 'LegL' など → メッシュ
  for (const m of meshes) {
    let key = null;
    if (isPet) {
      const mm = m.name.match(/_(?:Leg|Paw|Fluff_Ankle)(Front|Back)_([LR])$/);
      if (mm) key = mm[1] + mm[2];
    } else {
      const side = m.name.match(/_?([LR])\d*$/)?.[1];
      if (!side) continue;
      const b = boxOf(m);
      if (/(UpperArm|Forearm|Hand|Sleeve|Cuff|Tamoto)/.test(m.name)) key = 'Arm' + side;
      else if (b.max.y <= hipY + 0.12 && b.min.y < hipY * 0.7) key = 'Leg' + side;   // 腰より下で、左右のある部品 = 脚・靴
    }
    if (!key) continue;
    if (!sets.has(key)) sets.set(key, []);
    sets.get(key).push(m);
  }

  const joints = {};
  for (const [key, list] of sets) {
    const parent = list[0].parent;
    const own = list.filter((m) => m.parent === parent);
    const b = new THREE.Box3();
    own.forEach((m) => b.union(boxOf(m)));
    const c = b.getCenter(new THREE.Vector3());
    const pivot = new THREE.Group();
    pivot.position.set(c.x, b.max.y, c.z);       // 上の端 = 付け根
    parent.add(pivot);
    own.forEach((m) => { m.position.sub(pivot.position); pivot.add(m); });
    joints[key] = pivot;
  }

  // 犬・猫のしっぽ (models.js で付け根を支点にしたグループに入っている)
  let tail = null;
  root.traverse((o) => { if (!tail && o.isMesh && /_Tail$/.test(o.name)) tail = o.parent; });
  return { joints, tail, tailRot: tail ? tail.rotation.y : 0 };
}

// ---------------------------------------------------------------- 歩くキャラ
const tmp2 = new THREE.Vector2();
const viewer = new THREE.Vector2(0, 99);   // 見ている人の位置 (tick で更新)
const KEEP_AWAY = 1.2;                    // 見ている人からこれだけは離れる [m]
const angleDiff = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a));

class Walker {
  constructor(design, model) {
    this.isPet = model.kind === 'pet';
    this.root = model.build(design.state);
    this.root.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    this.rig = rigCharacter(this.root, this.isPet);
    this.group = new THREE.Group();
    this.group.add(this.root);
    const box = new THREE.Box3().setFromObject(this.root);
    const label = nameLabel(design.name || model.label, this.isPet ? 0.07 : 0.1);
    label.position.y = box.max.y + (this.isPet ? 0.08 : 0.12);
    this.group.add(label);

    // 速さ [m/s] と歩幅 [m] (歩幅から足を振る速さを決める)
    const size = box.max.y;
    this.speed = (this.isPet ? 0.55 : 0.6) * (0.85 + Math.random() * 0.3);
    this.stride = this.isPet ? size * 0.55 : size * 0.38;
    this.radius = this.isPet ? 0.3 : 0.35;    // ぶつからないための大きさ
    this.pos = new THREE.Vector2();
    this.target = new THREE.Vector2();
    this.heading = Math.random() * Math.PI * 2;
    this.mode = 'idle';
    this.timer = Math.random() * 1.5;
    this.phase = 0;
    this.walk = 0;      // 0 = 止まっている 〜 1 = 歩いている (手足の振りをなめらかに)
  }

  pickTarget() {
    // 見ている人 (カメラ) のすぐ近くは目的地にしない
    for (let i = 0; i < 10; i++) {
      const a = Math.random() * Math.PI * 2, r = AREA_R * Math.sqrt(Math.random());
      this.target.set(Math.cos(a) * r, Math.sin(a) * r);
      if (this.target.distanceTo(viewer) > KEEP_AWAY + 0.5) return;
    }
  }

  update(dt, t, others) {
    if (this.mode === 'idle') {
      this.timer -= dt;
      if (this.timer <= 0) { this.pickTarget(); this.mode = 'walk'; }
    } else {
      tmp2.subVectors(this.target, this.pos);
      if (tmp2.length() < 0.15) {
        this.mode = 'idle';
        this.timer = 0.8 + Math.random() * 2.5;
      } else {
        // 目的地の方へ向きを変えながら前へ
        const want = Math.atan2(tmp2.x, tmp2.y);
        const d = angleDiff(this.heading, want);
        this.heading += Math.sign(d) * Math.min(Math.abs(d), 2.5 * dt);
        const go = this.speed * dt * Math.max(0, Math.cos(d));   // 大きく向きを変える間はゆっくり
        this.pos.x += Math.sin(this.heading) * go;
        this.pos.y += Math.cos(this.heading) * go;
        this.phase += (go / (2 * this.stride)) * Math.PI * 2;
      }
    }
    // ほかのキャラと重ならないように少し押し合う
    for (const o of others) {
      if (o === this) continue;
      tmp2.subVectors(this.pos, o.pos);
      const min = this.radius + o.radius, d = tmp2.length();
      if (d > 1e-4 && d < min) this.pos.addScaledVector(tmp2, ((min - d) / d) * 0.5);
    }
    // 見ている人にぶつからない
    tmp2.subVectors(this.pos, viewer);
    const dv = tmp2.length();
    if (dv > 1e-4 && dv < KEEP_AWAY) {
      this.pos.addScaledVector(tmp2, (KEEP_AWAY - dv) / dv);
      if (this.mode === 'walk' && this.target.distanceTo(viewer) < KEEP_AWAY + 0.5) this.pickTarget();
    }

    this.walk += ((this.mode === 'walk' ? 1 : 0) - this.walk) * Math.min(1, dt * 6);
    this.animate(t);
    this.group.position.set(this.pos.x, 0, this.pos.y);
    this.group.rotation.y = this.heading;
  }

  animate(t) {
    const s = Math.sin(this.phase) * this.walk;
    const J = this.rig.joints;
    const rot = (k, v) => { if (J[k]) J[k].rotation.x = v; };
    if (this.isPet) {
      // 対角の脚がいっしょに動く (右前と左後ろ)
      rot('FrontL', s * 0.5); rot('BackR', s * 0.5);
      rot('FrontR', -s * 0.5); rot('BackL', -s * 0.5);
      if (this.rig.tail) this.rig.tail.rotation.y = this.rig.tailRot + Math.sin(t * (this.walk > 0.5 ? 9 : 5)) * 0.35;
      this.root.position.y = Math.abs(Math.sin(this.phase)) * 0.008 * this.walk;
    } else {
      rot('LegL', s * 0.5); rot('LegR', -s * 0.5);
      rot('ArmL', -s * 0.4); rot('ArmR', s * 0.4);
      this.root.position.y = Math.abs(Math.sin(this.phase)) * 0.025 * this.walk;
      this.root.rotation.z = Math.sin(this.phase) * 0.02 * this.walk;   // 少し左右にゆれる
    }
  }
}

let walkers = [];
function spawnAll() {
  walkers.forEach((w, i) => {
    const a = (i / walkers.length) * Math.PI * 2;
    w.pos.set(Math.cos(a) * 0.9, Math.sin(a) * 0.9);
    w.heading = a + Math.PI / 2;
    world.add(w.group);
  });
}

let lastT = 0;
function tick(now) {
  const dt = Math.min((now - (lastT || now)) / 1000, 0.1);
  lastT = now;
  if (!world.visible) return;
  const t = now / 1000;
  // 見ている人 (カメラ) の、地面の上での位置 (world の座標)
  const c = world.worldToLocal(tmpV.setFromMatrixPosition(camera.matrixWorld));
  viewer.set(c.x, c.z);
  for (const w of walkers) w.update(dt, t, walkers);
}

let placed = false;
function placeWorld(p) {
  world.position.copy(p);
  world.visible = true;
  world.updateMatrixWorld(true);
  if (!placed) { placed = true; spawnAll(); }
  say('画面をタップすると、その場所にみんなが移動します');
}

// ---------------------------------------------------------------- WebXR (地面を認識する)
let hitSource = null;
const reticle = new THREE.Mesh(
  new THREE.RingGeometry(0.12, 0.16, 40).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 }),
);
reticle.matrixAutoUpdate = false;
reticle.visible = false;
scene.add(reticle);
const tmpV = new THREE.Vector3();

async function startXR() {
  const session = await navigator.xr.requestSession('immersive-ar', {
    requiredFeatures: ['hit-test'],
    optionalFeatures: ['dom-overlay'],
    domOverlay: { root: $('ui') },
  });
  renderer.xr.enabled = true;
  renderer.xr.setReferenceSpaceType('local');
  await renderer.xr.setSession(session);
  const viewer = await session.requestReferenceSpace('viewer');
  hitSource = await session.requestHitTestSource({ space: viewer });
  session.addEventListener('select', () => {
    if (reticle.visible) placeWorld(tmpV.setFromMatrixPosition(reticle.matrix));
  });
  session.addEventListener('end', () => location.reload());
  startPanel.hidden = true;
  say('スマホを地面に向けてゆっくり動かし、輪が出たら画面をタップ');
  renderer.setAnimationLoop((now, frame) => {
    if (frame && hitSource) {
      const hits = frame.getHitTestResults(hitSource);
      reticle.visible = hits.length > 0;
      if (hits.length) reticle.matrix.fromArray(hits[0].getPose(renderer.xr.getReferenceSpace()).transform.matrix);
    }
    tick(now);
    renderer.render(scene, camera);
  });
}

// ---------------------------------------------------------------- かんたんモード (カメラ映像 + 向きセンサー)
let devOri = null, hasVideo = false;
const zee = new THREE.Vector3(0, 0, 1);
const q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5)); // 端末の座標 → カメラの座標 (x 軸で -90°)
const qTmp = new THREE.Quaternion(), qTarget = new THREE.Quaternion(), euler = new THREE.Euler();

function onOrientation(e) {
  if (e.alpha == null || e.beta == null || e.gamma == null) return;
  devOri = { alpha: e.alpha, beta: e.beta, gamma: e.gamma };
}
// 端末の向き → カメラの向き (Y が上の座標)
function orientationQuat(out) {
  const d = THREE.MathUtils.degToRad;
  const orient = d(screen.orientation?.angle ?? window.orientation ?? 0);
  euler.set(d(devOri.beta), d(devOri.alpha), -d(devOri.gamma), 'YXZ');
  out.setFromEuler(euler);
  out.multiply(q1);
  out.multiply(qTmp.setFromAxisAngle(zee, -orient));
  return out;
}

// センサーが無い時はドラッグで見回す
let yaw = 0, pitch = -0.45;
function updateCameraFov() {
  camera.aspect = innerWidth / innerHeight;
  if (hasVideo && video.videoWidth) {
    // 画面いっぱいに cover 表示している映像の、見えている範囲の縦の画角
    const W = video.videoWidth, H = video.videoHeight;
    const f = FOCAL_RATIO * Math.max(W, H);
    const sc = Math.max(innerWidth / W, innerHeight / H);
    camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(innerHeight / sc / 2 / f));
  } else camera.fov = 60;
  camera.updateProjectionMatrix();
}
addEventListener('resize', () => {
  if (renderer.xr.isPresenting) return;
  renderer.setSize(innerWidth, innerHeight, false);
  updateCameraFov();
});

const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const raycaster = new THREE.Raycaster();
// 画面の点 (-1〜1) から地面までのばした点。遠すぎる・空を向いているなら null
function groundAt(ndcX, ndcY) {
  raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera);
  const p = raycaster.ray.intersectPlane(groundPlane, new THREE.Vector3());
  return p && p.distanceTo(camera.position) < 15 ? p : null;
}

async function startCamera(permission) {
  startPanel.hidden = true;
  say('準備しています…');
  addEventListener('deviceorientation', onOrientation);
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
    });
    video.srcObject = stream;
    await video.play();
    hasVideo = true;
  } catch (e) {
    // カメラが使えない (PC・許可されない) 時は、空と地面を 3D で描く (見回しても地平線が合うように)
    console.warn(e);
    scene.background = new THREE.Color(0xbcd7ee);
    const floor = new THREE.Mesh(new THREE.CircleGeometry(60, 48), new THREE.MeshLambertMaterial({ color: 0xa7aea3 }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.002;
    floor.receiveShadow = true;
    scene.add(floor);
    say('カメラが使えないため、背景なしで表示しています');
  }
  await permission;
  camera.position.set(0, CAM_H, 0);
  updateCameraFov();
  video.addEventListener('loadedmetadata', updateCameraFov);

  // 見回し (センサーが無い時) とタップ
  let down = null;
  canvas.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, yaw, pitch, moved: false }; });
  canvas.addEventListener('pointermove', (e) => {
    if (!down) return;
    const dx = e.clientX - down.x, dy = e.clientY - down.y;
    if (Math.hypot(dx, dy) > 8) down.moved = true;
    if (!devOri && down.moved) {
      yaw = down.yaw - dx * 0.005;
      pitch = THREE.MathUtils.clamp(down.pitch - dy * 0.005, -1.4, 0.4);
    }
  });
  canvas.addEventListener('pointerup', (e) => {
    if (down && !down.moved) {
      const p = groundAt((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
      if (p) placeWorld(p);
    }
    down = null;
  });

  const startAt = performance.now();
  renderer.setAnimationLoop((now) => {
    if (devOri) camera.quaternion.slerp(orientationQuat(qTarget), 0.35);
    else camera.quaternion.setFromEuler(euler.set(pitch, yaw, 0, 'YXZ'));
    camera.updateMatrixWorld();
    // 最初は、見ている方向の 4m 先の地面にみんなを出す
    if (!placed && (devOri || now - startAt > 800)) {
      const f = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion).setY(0);
      if (f.lengthSq() < 1e-6) f.set(0, 0, -1);
      placeWorld(camera.position.clone().setY(0).addScaledVector(f.normalize(), 4));
      if (!devOri) say('ドラッグで見回し、タップでみんなを移動できます');
    }
    tick(now);
    renderer.render(scene, camera);
  });
}

// iPhone は「動作と方向」の許可が必要 (ボタンを押した直後に呼ぶこと)
function askOrientationPermission() {
  const DOE = window.DeviceOrientationEvent;
  if (DOE && typeof DOE.requestPermission === 'function') return DOE.requestPermission().catch(() => 'denied');
  return Promise.resolve('granted');
}

// ---------------------------------------------------------------- 起動
(async () => {
  let MODELS;
  try {
    MODELS = await window.modelsReady;
  } catch (e) {
    console.error(e);
    infoEl.textContent = '3D表示の読み込みに失敗しました。インターネット接続を確認してください。';
    return;
  }
  const { sample, designs } = pickDesigns(MODELS);
  const built = [];
  for (const d of designs) {
    const model = MODELS[d.baseModel];
    try {
      await model.ensure(d.state);
      built.push(new Walker(d, model));
    } catch (e) { console.error(e); }
  }
  walkers = built;
  infoEl.textContent = sample
    ? 'ギャラリーにまだ作品がないので、見本のキャラクターが歩きます'
    : `ギャラリーの作品から ${walkers.length} 体が歩きます`;

  const xrOK = !params.has('mode') && await navigator.xr?.isSessionSupported?.('immersive-ar').catch(() => false);
  startBtn.disabled = false;
  startBtn.textContent = 'カメラを起動';
  startBtn.onclick = () => {
    if (xrOK) startXR().catch((e) => { console.error(e); startCamera(askOrientationPermission()); });
    else startCamera(askOrientationPermission());
  };
  if (xrOK) {
    simpleBtn.hidden = false;
    simpleBtn.onclick = () => startCamera(askOrientationPermission());
  }
})();
