// まちを歩く: ギャラリーの作品 (人・犬・猫) を、カメラに写った地面の上で歩かせる。
//   - WebXR (Android の Chrome など): 床として認識できた場所を記録し、その中だけを歩く (壁・机の上は歩かない)
//   - それ以外 (iPhone など): カメラ映像 + 向きセンサー。スマホの高さを CAM_H と仮定し、円の中を歩く
//     (センサーも無い PC では、ドラッグで見回す)
// ?mode=camera で、WebXR が使える端末でもかんたんモードにする
import * as THREE from 'three';

const $ = (id) => document.getElementById(id);
const startPanel = $('start'), startBtn = $('startBtn'), simpleBtn = $('simpleBtn'), infoEl = $('info');
const msgEl = $('msg'), video = $('video'), canvas = $('gl'), sizeBtn = $('sizeBtn');
const params = new URLSearchParams(location.search);

const MAX_CHARS = 6;     // 同時に歩くキャラの数
const CAM_H = 1.4;       // かんたんモード: スマホを持つ高さ [m]
const FOCAL_RATIO = 0.8; // かんたんモード: カメラの焦点距離 ≒ 映像の長辺 × この値 (main.js と同じ)
const CELL = 0.25;       // WebXR: 床を記録するマスの大きさ [m]
const FLOOR_TOL = 0.07;  // WebXR: この高さの差までは同じ床とみなす [m]
const SCAN_RANGE = 5;    // WebXR: これより遠い床は記録しない (遠いほど不正確) [m]
const SIZES = [['小', 1.2], ['ふつう', 2.5], ['大', 4]];   // かんたんモードの歩く範囲 (半径)

const say = (t) => { msgEl.hidden = !t; msgEl.textContent = t || ''; };
const rand = (a, b) => a + Math.random() * (b - a);
const clamp = THREE.MathUtils.clamp;
const angleDiff = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a));

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

// みんなが歩く場所。原点の高さ = 床、Y が上
const world = new THREE.Group();
world.visible = false;
scene.add(world);

const sun = new THREE.DirectionalLight(0xffffff, 1.8);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
Object.assign(sun.shadow.camera, { left: -4, right: 4, top: 4, bottom: -4, near: 0.5, far: 15 });
world.add(sun, sun.target);

// 影だけを地面に落とす透明な板
const ground = new THREE.Mesh(new THREE.PlaneGeometry(12, 12), new THREE.ShadowMaterial({ opacity: 0.3 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
world.add(ground);

// 影の範囲をみんながいる場所に合わせる (world の座標)
function centerLight(x, z) {
  sun.position.set(x + 2, 6, z + 3);
  sun.target.position.set(x, 0, z);
  ground.position.set(x, 0, z);
}
centerLight(0, 0);

// ---------------------------------------------------------------- 歩ける場所
//  circle: 原点を中心とする円 (かんたんモード)
//  grid:   床として認識できたマスの集まり (WebXR)。world の x, z = XR の座標の x, z
const area = {
  mode: 'circle',
  R: 2.5,
  cells: new Map(),   // マス → { x, z (中心), ys: [見つかった水平面の高さ] }
  walk: new Set(),    // 歩けるマス
  list: [],           // 歩けるマスの中心 (ランダムに選ぶ用)
  floorY: null,
};
const cellKey = (x, z) => Math.floor(x / CELL) + ',' + Math.floor(z / CELL);

function okAt(x, z) {
  if (area.mode === 'circle') return x * x + z * z < area.R * area.R;
  return area.walk.has(cellKey(x, z));
}
// 端から少し内側 (目的地はここから選ぶ。壁ぎわぎりぎりには行かない)
function okInner(x, z) {
  if (area.mode === 'circle') { const r = Math.max(0.3, area.R - 0.3); return x * x + z * z < r * r; }
  const d = CELL * 0.9;
  return okAt(x, z) && okAt(x + d, z) && okAt(x - d, z) && okAt(x, z + d) && okAt(x, z - d);
}
// a から b までまっすぐ歩けるか
function pathOK(a, b) {
  const n = Math.ceil(a.distanceTo(b) / 0.1);
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    if (!okAt(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t)) return false;
  }
  return true;
}
function randomPoint(out) {
  if (area.mode === 'circle') {
    const a = Math.random() * Math.PI * 2, r = area.R * Math.sqrt(Math.random());
    return out.set(Math.cos(a) * r, Math.sin(a) * r);
  }
  if (!area.list.length) return null;
  const c = area.list[Math.floor(Math.random() * area.list.length)];
  return out.set(c.x + rand(-0.4, 0.4) * CELL, c.z + rand(-0.4, 0.4) * CELL);
}

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
const meshesOf = (root) => {
  const list = [];
  root.traverse((o) => { if (o.isMesh && o.userData.part !== 'Face') list.push(o); });
  return list;
};
// list のメッシュを、箱の上の端を支点にしたグループへ入れ直す
function pivotGroup(list) {
  const parent = list[0].parent;
  const own = list.filter((m) => m.parent === parent);
  const b = new THREE.Box3();
  own.forEach((m) => b.union(boxOf(m)));
  const c = b.getCenter(new THREE.Vector3());
  const pivot = new THREE.Group();
  pivot.position.set(c.x, b.max.y, c.z);
  parent.add(pivot);
  own.forEach((m) => { m.position.sub(pivot.position); pivot.add(m); });
  return pivot;
}

// 人: 股関節・ひざ・肩
function rigHuman(root) {
  const meshes = meshesOf(root);
  const thighs = new THREE.Box3(), shins = new THREE.Box3();
  meshes.forEach((m) => {
    if (/_Thigh_[LR]$/.test(m.name)) thighs.union(boxOf(m));
    if (/_Shin_[LR]$/.test(m.name)) shins.union(boxOf(m));
  });
  const hipY = thighs.isEmpty() ? 0.62 : thighs.max.y;
  // ひざ: 太ももの下の端とすねの上の端の間
  const kneeY = !thighs.isEmpty() && !shins.isEmpty() ? (thighs.min.y + shins.max.y) / 2 : hipY * 0.53;

  const sets = new Map();
  for (const m of meshes) {
    const side = m.name.match(/_?([LR])\d*$/)?.[1];
    if (!side) continue;
    const b = boxOf(m);
    let key = null;
    if (/(UpperArm|Forearm|Hand|Sleeve|Cuff|Tamoto)/.test(m.name)) key = 'Arm' + side;
    else if (b.max.y <= hipY + 0.12 && b.min.y < hipY * 0.7) key = 'Leg' + side;   // 腰より下で、左右のある部品 = 脚・靴
    if (!key) continue;
    if (!sets.has(key)) sets.set(key, []);
    sets.get(key).push(m);
  }

  const joints = {};
  for (const [key, list] of sets) {
    const pivot = pivotGroup(list);
    joints[key] = pivot;
    if (!key.startsWith('Leg')) continue;
    // ひざより下 (すね・足・靴) は、ひざを支点にしたグループへ
    const lower = pivot.children.filter((m) => boxOf(m).getCenter(new THREE.Vector3()).y < kneeY - pivot.position.y);
    if (!lower.length) continue;
    const b = new THREE.Box3();
    lower.forEach((m) => b.union(boxOf(m)));
    const c = b.getCenter(new THREE.Vector3());
    const knee = new THREE.Group();
    knee.position.set(c.x, kneeY - pivot.position.y, c.z);
    pivot.add(knee);
    lower.forEach((m) => { m.position.sub(knee.position); knee.add(m); });
    joints['Knee' + key.slice(3)] = knee;
  }
  return { joints, legY: hipY };
}

// 犬・猫: 4本の脚 (付け根で振る + 前へ出す時に持ち上げる) としっぽ
function rigPet(root) {
  const sets = new Map();
  for (const m of meshesOf(root)) {
    const mm = m.name.match(/_(?:Leg|Paw|Fluff_Ankle)(Front|Back)_([LR])$/);
    if (!mm) continue;
    const key = mm[1] + mm[2];
    if (!sets.has(key)) sets.set(key, []);
    sets.get(key).push(m);
  }
  const joints = {}, baseY = {};
  let sum = 0;
  for (const [key, list] of sets) {
    joints[key] = pivotGroup(list);
    baseY[key] = joints[key].position.y;
    sum += baseY[key];
  }
  let tail = null;
  root.traverse((o) => { if (!tail && o.isMesh && /_Tail$/.test(o.name)) tail = o.parent; });
  return { joints, baseY, legY: sets.size ? sum / sets.size : 0.25, tail, tailRot: tail ? tail.rotation.y : 0 };
}

// ---------------------------------------------------------------- 歩くキャラ
const tmp2 = new THREE.Vector2(), tmpA = new THREE.Vector2();
const viewer = new THREE.Vector2(0, 99);   // 見ている人の位置 (tick で更新)
const keepAway = () => (area.mode === 'grid' ? 0.8 : 1.2);   // 見ている人からこれだけは離れる [m]

// 犬・猫の脚を出す順番 (1周期の中の位置)。なみあし: 左後→左前→右後→右前、はやあし: 対角の脚がいっしょ
const PET_WALK = { BackL: 0, FrontL: 0.25, BackR: 0.5, FrontR: 0.75 };
const PET_TROT = { BackL: 0, FrontR: 0, BackR: 0.5, FrontL: 0.5 };

class Walker {
  constructor(design, model) {
    this.isPet = model.kind === 'pet';
    this.root = model.build(design.state);
    this.root.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    this.head = this.root.children[1] || null;
    this.headRot = this.head ? this.head.rotation.clone() : null;
    this.rig = this.isPet ? rigPet(this.root) : rigHuman(this.root);
    this.group = new THREE.Group();
    this.group.add(this.root);
    const box = new THREE.Box3().setFromObject(this.root);
    const label = nameLabel(design.name || model.label, this.isPet ? 0.07 : 0.1);
    label.position.y = box.max.y + (this.isPet ? 0.08 : 0.12);
    this.group.add(label);

    // 脚の長さ [m] から、ふつうの速さを決める (脚が長いほど速い)
    this.legLen = Math.max(0.08, this.rig.legY * this.root.scale.y);
    this.cruise = this.isPet
      ? 0.42 * Math.sqrt(this.legLen / 0.22) * rand(0.9, 1.1)
      : 0.62 * Math.sqrt(this.legLen / 0.63) * rand(0.9, 1.1);
    this.radius = this.isPet ? 0.28 : 0.3;    // ぶつからないための大きさ
    this.pos = new THREE.Vector2();
    this.target = new THREE.Vector2();
    this.heading = Math.random() * Math.PI * 2;
    this.v = 0;          // 今の速さ [m/s]
    this.mode = 'idle';
    this.gait = 'walk';
    this.timer = rand(0.3, 1.8);
    this.phase = Math.random() * Math.PI * 2;
    this.blend = 0;      // 手足の振りの大きさ 0〜1
    this.look = { yaw: 0, pitch: 0, y: 0, p: 0, timer: 0, viewer: false };
    this.seed = Math.random() * 10;
    this.spawned = false;
    this.appear = 1;
  }

  // 次に行く場所を決める。まっすぐ歩いて行ける、近すぎず遠すぎない場所
  pickTarget() {
    const keep = keepAway() + 0.3;
    for (let i = 0; i < 40; i++) {
      if (!randomPoint(this.target)) return false;
      const d = this.target.distanceTo(this.pos);
      if (d < 0.5 || d > 3.5 || !okInner(this.target.x, this.target.y)) continue;
      if (this.target.distanceTo(viewer) < keep) continue;
      if (area.mode === 'grid' && !pathOK(this.pos, this.target)) continue;
      return true;
    }
    // 見つからなければ条件をゆるめる
    for (let i = 0; i < 20; i++) {
      if (!randomPoint(this.target)) return false;
      if (this.target.distanceTo(this.pos) > 0.3 && okAt(this.target.x, this.target.y)) return true;
    }
    return false;
  }

  go(gaitHint) {
    const far = this.target.distanceTo(this.pos);
    this.gait = this.isPet && (gaitHint === 'trot' || (far > 1.4 && Math.random() < 0.55)) ? 'trot' : 'walk';
    this.mode = 'walk';
  }

  // (x, z) のまわりへ集まる
  goNear(x, z) {
    for (let i = 0; i < 30; i++) {
      const a = Math.random() * Math.PI * 2, r = rand(0.25, 0.9);
      this.target.set(x + Math.cos(a) * r, z + Math.sin(a) * r);
      if (okAt(this.target.x, this.target.y)) { this.go(this.target.distanceTo(this.pos) > 1 ? 'trot' : null); return; }
    }
  }

  rest(time) {
    this.mode = 'idle';
    this.timer = time ?? rand(1, 4);
    this.look.timer = rand(0.2, 0.8);
  }

  update(dt, t, others) {
    let omega = 0;   // 向きを変える速さ [rad/s]
    const L = this.look;

    if (this.mode === 'idle') {
      this.v = Math.max(0, this.v - 2.5 * dt);
      this.timer -= dt;
      if (this.timer <= 0) {
        if (this.pickTarget()) this.go(); else this.timer = 0.8;
      }
      // きょろきょろ見回す。ときどきこちら (カメラ) を見る
      L.timer -= dt;
      if (L.timer <= 0) {
        L.timer = rand(0.9, 2.6);
        L.viewer = Math.random() < 0.35 && viewer.distanceTo(this.pos) < 6;
        L.yaw = rand(-0.8, 0.8);
        L.pitch = rand(-0.12, 0.15);
      }
      if (L.viewer) {
        tmp2.subVectors(viewer, this.pos);
        const a = angleDiff(this.heading, Math.atan2(tmp2.x, tmp2.y));
        // 首だけで向けないほど後ろなら、体ごと少し向き直る
        if (Math.abs(a) > 0.9) {
          const turn = clamp(a - Math.sign(a) * 0.6, -1.5 * dt, 1.5 * dt);
          this.heading += turn;
          omega = turn / dt;
        }
        L.yaw = clamp(a, -0.9, 0.9);
        L.pitch = this.isPet ? -0.3 : -0.15;   // 見上げる
      }
    } else {
      tmp2.subVectors(this.target, this.pos);
      const dist = tmp2.length();
      if (dist < 0.1) this.rest();
      else {
        const d = angleDiff(this.heading, Math.atan2(tmp2.x, tmp2.y));
        const maxTurn = (this.isPet ? 3 : 2.4) * dt;
        const turn = clamp(d, -maxTurn, maxTurn);
        this.heading += turn;
        omega = turn / dt;
        L.yaw = clamp(d * 0.7, -0.6, 0.6);    // 曲がる方を先に見る
        L.pitch = 0;
        // 大きく向きを変える間はその場で向き直り、まっすぐになったら加速。目的地の手前で減速
        const cruise = this.cruise * (this.gait === 'trot' ? 2 : 1);
        const align = Math.max(0, Math.cos(d));
        let want = Math.abs(d) > 1.2 ? 0 : cruise * align * align;
        want = Math.min(want, Math.sqrt(2 * 0.8 * Math.max(0, dist - 0.06)));
        this.v += clamp(want - this.v, -2.5 * dt, (this.isPet ? 1.6 : 1) * dt);
      }
    }

    // 前へ進む。歩ける場所の外へ出そうなら止まる
    if (this.v > 0) {
      const fx = Math.sin(this.heading), fz = Math.cos(this.heading), step = this.v * dt;
      const nx = this.pos.x + fx * step, nz = this.pos.y + fz * step;
      const ahead = this.radius * 0.6;
      if (okAt(this.pos.x, this.pos.y) && (!okAt(nx, nz) || !okAt(nx + fx * ahead, nz + fz * ahead))) {
        this.v = 0;
        this.rest(rand(0.3, 1.2));
      } else this.pos.set(nx, nz);
    }

    // ほかのキャラ・見ている人と重ならないように押し合う (歩ける場所の外へは押し出さない)
    tmpA.copy(this.pos);
    for (const o of others) {
      if (o === this || !o.spawned) continue;
      tmp2.subVectors(this.pos, o.pos);
      const min = this.radius + o.radius, d = tmp2.length();
      if (d > 1e-4 && d < min) this.pos.addScaledVector(tmp2, ((min - d) / d) * 0.5);
    }
    tmp2.subVectors(this.pos, viewer);
    const dv = tmp2.length(), keep = keepAway();
    if (dv > 1e-4 && dv < keep) {
      this.pos.addScaledVector(tmp2, (keep - dv) / dv);
      if (this.mode === 'walk' && this.target.distanceTo(viewer) < keep + 0.3) this.rest(0.2);
    }
    if (okAt(tmpA.x, tmpA.y) && !okAt(this.pos.x, this.pos.y)) this.pos.copy(tmpA);

    // 足が地面をすべらない速さで手足を振る
    //   片足が地面についている間に体が進む距離 ≒ 2 × 脚の長さ × 振る角度 なので、
    //   1周期 (2歩) の間に進む距離から、振る速さが決まる
    const stepV = this.v + Math.abs(omega) * 0.07;
    const amp0 = this.isPet ? (this.gait === 'trot' ? 0.42 : 0.3) : 0.36;
    this.blend += (Math.min(1, stepV / (0.45 * this.cruise)) - this.blend) * Math.min(1, dt * 5);
    const A = amp0 * this.blend;
    this.phase += ((stepV * Math.PI) / (2 * this.legLen * Math.max(A, amp0 * 0.45))) * dt;

    // 首はなめらかに
    const k = Math.min(1, dt * 3.5);
    L.y += (L.yaw - L.y) * k;
    L.p += (L.pitch - L.p) * k;

    if (this.isPet) this.animatePet(t, A); else this.animateHuman(t, A);

    if (this.appear < 1) {
      this.appear = Math.min(1, this.appear + dt * 3);
      const e = 1 - (1 - this.appear) ** 3;
      this.group.scale.setScalar(Math.max(0.001, e));
    }
    this.group.position.set(this.pos.x, 0, this.pos.y);
    this.group.rotation.y = this.heading;
  }

  animateHuman(t, A) {
    const J = this.rig.joints, b = this.blend, ph = this.phase;
    const s = Math.sin(ph), c = Math.cos(ph);
    const rot = (key, v) => { if (J[key]) J[key].rotation.x = v; };
    // 脚: 前へ振る脚 (振り出し中) だけひざを曲げる。地面についている脚はほぼまっすぐ
    rot('LegL', -A * s);
    rot('LegR', A * s);
    rot('KneeL', b * (1.05 * Math.max(0, c) ** 1.5 + 0.05));
    rot('KneeR', b * (1.05 * Math.max(0, -c) ** 1.5 + 0.05));
    // 腕: 反対側の脚といっしょに前へ。少しだけ前寄り
    rot('ArmL', 0.85 * A * s - 0.04 * b);
    rot('ArmR', -0.85 * A * s - 0.04 * b);
    // 体: 地面についた脚の上を通るので、足を開いた時に低く、そろった時に高くなる。左右にも少しゆれる
    const r = this.root;
    r.position.y = this.legLen * (Math.cos(A * s) - 1);
    r.position.x = -0.014 * b * c;
    r.rotation.y = -0.13 * A * s;
    // 止まっている時は、ゆっくり重心を移す
    r.rotation.z = 0.012 * Math.sin(t * 1.1 + this.seed) * (1 - b);
    if (this.head) {
      this.head.rotation.y = this.headRot.y + this.look.y - r.rotation.y;
      this.head.rotation.x = this.headRot.x + this.look.p;
    }
  }

  animatePet(t, A) {
    const R = this.rig, b = this.blend, ph = this.phase;
    const order = this.gait === 'trot' ? PET_TROT : PET_WALK;
    for (const key in R.joints) {
      const psi = ph - (order[key] ?? 0) * Math.PI * 2;
      const j = R.joints[key];
      j.rotation.x = -A * Math.sin(psi);
      // 前へ振り出す間は足を持ち上げる (脚を少し体の中へ引き込む)
      const lift = Math.max(0, (Math.cos(psi) - 0.25) / 0.75) ** 1.5;
      j.position.y = R.baseY[key] + R.baseY[key] * 0.14 * b * lift;
    }
    // 脚を斜めにした分だけ体を下げる。はやあしは少し弾む
    const r = this.root;
    const bounce = this.gait === 'trot' ? 0.05 * this.legLen * b * Math.abs(Math.sin(ph)) : 0;
    r.position.y = -0.5 * this.legLen * (1 - Math.cos(A)) + bounce;
    if (this.head) {
      this.head.rotation.y = this.headRot.y + this.look.y;
      this.head.rotation.x = this.headRot.x + this.look.p + 0.06 * b * Math.sin(2 * ph);
    }
    if (R.tail) {
      const fast = this.gait === 'trot' && b > 0.5;
      const f = fast ? 11 : b > 0.3 ? 7 : 4;
      const amp = fast ? 0.4 : b > 0.3 ? 0.32 : 0.22 * (0.5 + 0.5 * Math.sin(t * 0.3 + this.seed));
      R.tail.rotation.y = R.tailRot + Math.sin(t * f + this.seed) * amp;
    }
  }

  spawnAt(x, z, heading) {
    this.pos.set(x, z);
    this.heading = heading;
    this.v = 0;
    this.rest(rand(0.3, 1.5));
    this.spawned = true;
    this.appear = 0;
    this.group.scale.setScalar(0.001);
    world.add(this.group);
  }

  despawn() {
    this.spawned = false;
    world.remove(this.group);
  }
}

let walkers = [];

// かんたんモード: みんなを輪になって出す
function spawnCircle() {
  walkers.forEach((w, i) => {
    const a = (i / walkers.length) * Math.PI * 2, r = Math.min(0.9, area.R * 0.6);
    w.spawnAt(Math.cos(a) * r, Math.sin(a) * r, a + Math.PI / 2);
  });
}

// WebXR: 床が見つかったところから、ひとりずつ出てくる
let spawnWait = 0;
function spawnFromScan(dt) {
  spawnWait -= dt;
  if (spawnWait > 0) return;
  const w = walkers.find((x) => !x.spawned);
  if (!w) return;
  const p = new THREE.Vector2();
  for (let i = 0; i < 30; i++) {
    if (!randomPoint(p) || !okInner(p.x, p.y) && i < 20) continue;
    if (!okAt(p.x, p.y) || p.distanceTo(viewer) < 0.7) continue;
    if (walkers.some((o) => o.spawned && o.pos.distanceTo(p) < 0.6)) continue;
    w.spawnAt(p.x, p.y, Math.random() * Math.PI * 2);
    spawnWait = 0.35;
    return;
  }
  spawnWait = 0.2;
}

let lastT = 0;
const tmpV = new THREE.Vector3();
function tick(now) {
  const dt = Math.min((now - (lastT || now)) / 1000, 0.1);
  lastT = now;
  updateRing(dt);
  if (!world.visible) return;
  const t = now / 1000;
  // 見ている人 (カメラ) の、地面の上での位置 (world の座標)
  const c = world.worldToLocal(tmpV.setFromMatrixPosition(camera.matrixWorld));
  viewer.set(c.x, c.z);
  if (area.mode === 'grid') spawnFromScan(dt);
  for (const w of walkers) if (w.spawned) w.update(dt, t, walkers);
}

// ---------------------------------------------------------------- 歩く範囲の輪 (かんたんモードで広さを変えた時に見せる)
const ring = new THREE.Mesh(
  new THREE.RingGeometry(0.97, 1, 72).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false }),
);
ring.position.y = 0.004;
world.add(ring);
let ringTime = 0;
function showRing() {
  ring.scale.setScalar(area.R);
  ringTime = 2.2;
}
function updateRing(dt) {
  ringTime = Math.max(0, ringTime - dt);
  ring.material.opacity = 0.7 * Math.min(1, ringTime / 0.6);
  ring.visible = ringTime > 0;
}

let placed = false;
// かんたんモード: p を中心にする
function placeWorld(p) {
  world.position.copy(p);
  world.visible = true;
  world.updateMatrixWorld(true);
  if (!placed) { placed = true; spawnCircle(); }
  showRing();
  say('画面をタップすると、その場所にみんなが移動します');
}

// ---------------------------------------------------------------- WebXR (床を記録しながら歩く)
const reticle = new THREE.Mesh(
  new THREE.RingGeometry(0.12, 0.16, 40).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 }),
);
reticle.matrixAutoUpdate = false;
reticle.visible = false;
scene.add(reticle);

// 記録した床の点 (XR の座標でそのまま置く)
const MAX_DOTS = 6000;
const dots = new THREE.InstancedMesh(
  new THREE.CircleGeometry(0.025, 8).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.45, depthWrite: false }),
  MAX_DOTS,
);
dots.count = 0;
dots.frustumCulled = false;
dots.visible = false;
scene.add(dots);
const dotM = new THREE.Matrix4();
function addDot(x, y, z) {
  if (dots.count >= MAX_DOTS) return;
  dots.setMatrixAt(dots.count++, dotM.makeTranslation(x, y + 0.003, z));
  dots.instanceMatrix.needsUpdate = true;
}

function addWalk(key, c) {
  if (area.walk.has(key)) return;
  area.walk.add(key);
  area.list.push(c);
  addDot(c.x, area.floorY, c.z);
}

// 上を向いた面 (床・机の上など) に当たった点を、マスごとに高さを覚えておく
function recordHit(x, y, z, vx, vz) {
  if (Math.hypot(x - vx, z - vz) > SCAN_RANGE) return;
  const key = cellKey(x, z);
  let c = area.cells.get(key);
  if (!c) {
    c = { x: (Math.floor(x / CELL) + 0.5) * CELL, z: (Math.floor(z / CELL) + 0.5) * CELL, ys: [] };
    area.cells.set(key, c);
  }
  if (c.ys.some((h) => Math.abs(h - y) < 0.04)) return;
  if (c.ys.length >= 4) return;
  c.ys.push(y);
  if (area.floorY == null) addDot(c.x, y, c.z);                       // まだ床を決めていない: 見つけた面をすべて表示
  else if (Math.abs(y - area.floorY) < FLOOR_TOL) addWalk(key, c);    // 床と同じ高さなら歩ける
}

// 床の高さを決めて、歩けるマスを作り直す
function setFloor(y) {
  area.floorY = y;
  area.walk.clear();
  area.list = [];
  dots.count = 0;
  for (const [key, c] of area.cells) if (c.ys.some((h) => Math.abs(h - y) < FLOOR_TOL)) addWalk(key, c);
  dots.instanceMatrix.needsUpdate = true;
}

function placeXR(p) {
  const newFloor = area.floorY == null || Math.abs(p.y - area.floorY) > FLOOR_TOL;
  if (newFloor) {
    // はじめて、または別の高さ (机の上など) をタップした: そこを床にしてやり直す
    setFloor(p.y);
    recordHit(p.x, p.y, p.z, p.x, p.z);
    walkers.forEach((w) => w.spawned && w.despawn());
    world.position.set(0, p.y, 0);
    world.visible = true;
    world.updateMatrixWorld(true);
    say('床を映しながらゆっくり見回すと、歩ける場所が広がります');
  } else {
    // 同じ床: タップした場所へみんなが集まる
    walkers.forEach((w) => w.spawned && w.goNear(p.x, p.z));
    say('床を映して見回すと歩ける場所が広がります。タップした所にみんなが集まります');
  }
  centerLight(p.x, p.z);
}

async function startXR() {
  const session = await navigator.xr.requestSession('immersive-ar', {
    requiredFeatures: ['hit-test'],
    optionalFeatures: ['dom-overlay'],
    domOverlay: { root: $('ui') },
  });
  renderer.xr.enabled = true;
  renderer.xr.setReferenceSpaceType('local');
  await renderer.xr.setSession(session);
  area.mode = 'grid';
  const viewerSpace = await session.requestReferenceSpace('viewer');

  // 画面の中心 + まわりの何か所かに光線を出して、床を広く記録する (最初の 1 本は輪の表示用)
  const sources = [await session.requestHitTestSource({ space: viewerSpace })];
  if (typeof XRRay === 'function') {
    const offs = [[-0.3, 0], [0.3, 0], [0, -0.3], [0, 0.3], [-0.3, -0.3], [0.3, -0.3], [-0.3, 0.3], [0.3, 0.3],
      [0, -0.6], [-0.45, -0.55], [0.45, -0.55]];
    for (const [dx, dy] of offs) {
      try {
        sources.push(await session.requestHitTestSource({
          space: viewerSpace,
          offsetRay: new XRRay({ x: 0, y: 0, z: 0, w: 1 }, { x: dx, y: dy, z: -1, w: 0 }),
        }));
      } catch (e) { console.warn(e); break; }
    }
  }

  session.addEventListener('select', () => {
    if (reticle.visible) placeXR(new THREE.Vector3().setFromMatrixPosition(reticle.matrix));
  });
  session.addEventListener('end', () => location.reload());
  startPanel.hidden = true;
  dots.visible = true;
  say('床を映しながらゆっくり見回してください。輪が出たら床をタップ');
  renderer.setAnimationLoop((now, frame) => {
    if (frame) {
      const ref = renderer.xr.getReferenceSpace();
      const vp = frame.getViewerPose(ref)?.transform.position;
      sources.forEach((src, i) => {
        const hit = frame.getHitTestResults(src)[0];
        const m = hit?.getPose(ref)?.transform.matrix;
        // 姿勢の Y 軸 = 面の向き。上を向いた面 (床・机の上) だけを使い、壁は無視する
        const up = !!m && m[5] > 0.9;
        if (i === 0) {
          reticle.visible = up;
          if (up) reticle.matrix.fromArray(m);
        }
        if (up && vp) recordHit(m[12], m[13], m[14], vp.x, vp.z);
      });
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

// 歩く範囲の広さ (小・ふつう・大)
let sizeIdx = 1;
function setSize(i) {
  sizeIdx = i;
  area.R = SIZES[i][1];
  sizeBtn.textContent = `ひろさ: ${SIZES[i][0]}`;
  if (!placed) return;
  showRing();
  // 範囲の外にいるキャラは中へ戻る
  for (const w of walkers) if (!okInner(w.pos.x, w.pos.y) && w.mode === 'idle') w.timer = 0;
}

async function startCamera(permission) {
  startPanel.hidden = true;
  area.mode = 'circle';
  setSize(sizeIdx);
  sizeBtn.hidden = false;
  sizeBtn.onclick = () => setSize((sizeIdx + 1) % SIZES.length);
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
      pitch = clamp(down.pitch - dy * 0.005, -1.4, 0.4);
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
