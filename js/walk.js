// まちを歩く: じぶんの作品 (人・犬・猫) が、カメラに写った地面の上で過ごす。
//   人: 散歩 / ギターを弾く / ダンス、犬・猫: 散歩 / はしゃぐ / おひるね
//   キャラは見ている人のまわり 360° にいて、画面の外から歩いてきたり、外へ出ていったりする
//   - WebXR (Android の Chrome など): 床として認識できた場所を記録し、その中だけを歩く (壁・机の上は歩かない)
//   - それ以外 (iPhone など): カメラ映像 + 向きセンサー。スマホの高さを CAM_H と仮定し、自分を中心とした円の中にいる
//     (センサーも無い PC では、ドラッグで見回す)
// ?mode=camera で、WebXR が使える端末でもかんたんモードにする。?id=… の作品は必ず出す
import * as THREE from 'three';

const $ = (id) => document.getElementById(id);
const startPanel = $('start'), startBtn = $('startBtn'), simpleBtn = $('simpleBtn'), infoEl = $('info');
const msgEl = $('msg'), video = $('video'), canvas = $('gl'), sizeBtn = $('sizeBtn'), soundBtn = $('soundBtn');
const params = new URLSearchParams(location.search);

const MAX_ACTIVE = 6;    // 同時に出ているキャラの数
const MAX_POOL = 12;     // 入れ替わりで出てくるキャラの数
const CAM_H = 1.4;       // かんたんモード: スマホを持つ高さ [m]
const FOCAL_RATIO = 0.8; // かんたんモード: カメラの焦点距離 ≒ 映像の長辺 × この値 (main.js と同じ)
const CELL = 0.25;       // WebXR: 床を記録するマスの大きさ [m]
const FLOOR_TOL = 0.07;  // WebXR: この高さの差までは同じ床とみなす [m]
const SCAN_RANGE = 5;    // WebXR: これより遠い床は記録しない (遠いほど不正確) [m]
const SIZES = [['小', 1.8], ['ふつう', 4], ['大', 8]];   // かんたんモードの範囲 (自分を中心とした半径)
const BPM = 100;         // ギターとダンスのテンポ (みんな同じリズム)

// 「おまかせ」の時に何をするか (確率)
const AUTO_ACTS = { human: [['walk', 0.5], ['guitar', 0.25], ['dance', 0.25]], pet: [['walk', 0.5], ['play', 0.3], ['nap', 0.2]] };
const STAGE_ACTS = new Set(['guitar', 'dance', 'nap']);   // 1か所にとどまってする

const say = (t) => { msgEl.hidden = !t; msgEl.textContent = t || ''; };
const rand = (a, b) => a + Math.random() * (b - a);
const clamp = THREE.MathUtils.clamp;
const angleDiff = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a));
const beatAt = (t) => (t * BPM) / 60;

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
// 今見ているカメラ (WebXR 中は XR のカメラ)
const viewCam = () => (renderer.xr.isPresenting ? renderer.xr.getCamera() : camera);

// みんながいる場所。原点の高さ = 床、Y が上
const world = new THREE.Group();
world.visible = false;
scene.add(world);

const sun = new THREE.DirectionalLight(0xffffff, 1.8);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
world.add(sun, sun.target);

// 影だけを地面に落とす透明な板
const ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShadowMaterial({ opacity: 0.3 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
world.add(ground);

// 影の範囲をみんながいる場所に合わせる (world の座標)
function centerLight(x, z, r) {
  sun.position.set(x + 2, 6, z + 3);
  sun.target.position.set(x, 0, z);
  ground.position.set(x, 0, z);
  ground.scale.setScalar(r * 2 + 4);
  Object.assign(sun.shadow.camera, { left: -r - 1, right: r + 1, top: r + 1, bottom: -r - 1, near: 0.5, far: 20 });
  sun.shadow.camera.updateProjectionMatrix();
}
centerLight(0, 0, 4);

// ---------------------------------------------------------------- 歩ける場所
//  circle: 見ている人を中心とする円 (かんたんモード)
//  grid:   床として認識できたマスの集まり (WebXR)。world の x, z = XR の座標の x, z
const area = {
  mode: 'circle',
  R: 4,
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
// 条件 test に合う場所を探す (見つからなければ null)
const _fp = new THREE.Vector2();
function findPoint(test, tries = 40) {
  for (let i = 0; i < tries; i++) {
    if (!randomPoint(_fp)) return null;
    if (test(_fp)) return _fp.clone();
  }
  return null;
}

// world の (x, z) が画面に写っているか。margin > 0 で画面より少し広く、< 0 で内側だけ
const _iv = new THREE.Vector3();
function inView(x, z, margin = 0) {
  const cam = viewCam();
  _iv.set(x, 0.3, z);
  world.localToWorld(_iv);
  _iv.applyMatrix4(cam.matrixWorldInverse);
  if (_iv.z > -0.2) return false;   // カメラの後ろ
  _iv.applyMatrix4(cam.projectionMatrix);
  return Math.abs(_iv.x) < 1 + margin && Math.abs(_iv.y) < 1 + margin;
}

// ---------------------------------------------------------------- キャラの読み込み
function pickAct(kind, want) {
  const list = AUTO_ACTS[kind];
  if (want && list.some(([a]) => a === want)) return want;
  let r = Math.random();
  for (const [a, p] of list) { if ((r -= p) <= 0) return a; }
  return 'walk';
}
// じぶんの作品のうち「ARに出す」もの (新しい順)。?id=… の作品は必ず入れる。1体も無ければ見本
function pickDesigns(MODELS) {
  const DS = window.DesignStore;
  const ok = (d) => d && MODELS[d.baseModel] && d.state;
  const mine = DS.mine().filter(ok);
  const focus = DS.get(params.get('id'));
  const list = mine.filter((d) => d.walk !== false);
  if (ok(focus)) list.unshift(focus);
  const designs = [...new Map(list.map((d) => [d.id, d])).values()].slice(0, MAX_POOL);
  if (!designs.length) {
    const acts = { man: 'guitar', woman: 'dance', dog: 'play', cat: 'walk' };
    return {
      sample: true,
      hasMine: mine.length > 0,
      designs: Object.keys(MODELS).map((k) => ({ name: '見本の' + MODELS[k].label, baseModel: k, act: acts[k], state: MODELS[k].defaultState() })),
    };
  }
  return { sample: false, designs };
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

// アコースティックギター (モデルの座標、ネックが +Y、表が +Z)
function makeGuitar() {
  const g = new THREE.Group();
  const wood = new THREE.MeshStandardMaterial({ color: 0xc8843a, roughness: 0.5 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x4a2f1c, roughness: 0.6 });
  const hole = new THREE.MeshBasicMaterial({ color: 0x1c120a });
  const lower = new THREE.Mesh(new THREE.SphereGeometry(0.1, 20, 12), wood);
  lower.scale.set(1, 1.05, 0.33);
  const upper = new THREE.Mesh(new THREE.SphereGeometry(0.078, 20, 12), wood);
  upper.scale.set(1, 1, 0.33);
  upper.position.y = 0.12;
  const sound = new THREE.Mesh(new THREE.CircleGeometry(0.03, 20), hole);
  sound.position.set(0, 0.07, 0.034);
  const neck = new THREE.Mesh(new THREE.BoxGeometry(0.034, 0.25, 0.02), dark);
  neck.position.set(0, 0.3, 0.012);
  const headstock = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.065, 0.022), dark);
  headstock.position.set(0, 0.455, 0.008);
  g.add(lower, upper, sound, neck, headstock);
  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  return g;
}

// ---------------------------------------------------------------- 動きのための「関節」
// モデルは手足が部品ごとに分かれている (名前の最後が L / R) ので、付け根を支点にしたグループに入れ直して動かす
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

// ---------------------------------------------------------------- 人: 骨 (スケルトン) を入れる
// 体・服は継ぎ目のない1枚の形なので、骨を入れて「どの点がどの骨にどれだけついて動くか」を決める。
//   体: 形から決める (脚は股より下で左右に分かれ、腕は胴から離れている)
//   服・靴: いちばん近い体の点と同じにする (スカートは脚に引っぱられすぎないよう、腰にも半分つける)
// 体型スライダーで形を変えている時は、models.js の deformPoint と同じ変形を元に戻してから判定する
const SHAPE = { ANKLE: 0.08, HIP: 0.6 };
const sm = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const bellyOf = (y) => sm(0.45, 0.68, y) * (1 - sm(0.74, 0.92, y));
const shapeOf = (st) => {
  const b = st?.body || {};
  return { legs: b.legs ?? 1, shoulders: b.shoulders ?? 1, belly: b.belly ?? 1 };
};
// 変形前 → 変形後 (models.js の deformPoint の胴の部分と同じ)
function shapeFwd(x, y, z, P, out) {
  const b = 1 + (P.belly - 1) * bellyOf(y);
  const sx = (1 + (P.shoulders - 1) * sm(0.72, 0.9, y)) * b;
  const yy = y > SHAPE.ANKLE ? SHAPE.ANKLE + (Math.min(y, SHAPE.HIP) - SHAPE.ANKLE) * P.legs + Math.max(0, y - SHAPE.HIP) : y;
  return out.set(x * sx, yy, z * b);
}
// 変形後 → 変形前
function shapeInv(x, y, z, P, out) {
  const top = SHAPE.ANKLE + (SHAPE.HIP - SHAPE.ANKLE) * P.legs;
  const y0 = y <= SHAPE.ANKLE ? y : y <= top ? SHAPE.ANKLE + (y - SHAPE.ANKLE) / P.legs : y - (SHAPE.HIP - SHAPE.ANKLE) * (P.legs - 1);
  const b = 1 + (P.belly - 1) * bellyOf(y0);
  const sx = (1 + (P.shoulders - 1) * sm(0.72, 0.9, y0)) * b;
  return out.set(x / sx, y0, z / b);
}

// 骨: [名前, 親, 変形前の位置]
const BONES = [
  ['hips', null, [0, 0.53, 0]], ['chest', 'hips', [0, 0.76, 0]],
  ['thighL', 'hips', [0.055, 0.53, 0]], ['shinL', 'thighL', [0.06, 0.29, 0.005]],
  ['thighR', 'hips', [-0.055, 0.53, 0]], ['shinR', 'thighR', [-0.06, 0.29, 0.005]],
  ['upperArmL', 'chest', [0.12, 0.86, 0]], ['foreArmL', 'upperArmL', [0.145, 0.72, 0]],
  ['upperArmR', 'chest', [-0.12, 0.86, 0]], ['foreArmR', 'upperArmR', [-0.145, 0.72, 0]],
];
const BI = Object.fromEntries(BONES.map(([n], i) => [n, i]));
// 骨にくっつけるだけのもの (形が変わらない小物)
const RIGID = /^(Neck_|Bag_)/;
const SKIRT = /(Skirt|OnePiece)/;

// 体の 1 点 (変形前) → [骨, 重み] の組
function bodyWeights(x, y, out) {
  out.length = 0;
  const ax = Math.abs(x), s = x >= 0 ? 'L' : 'R';
  const split = 0.125 - Math.max(0, y - 0.55) * 0.13;   // 胴と腕の境目 (腕は胴から離れて下がっている)
  if (y > 0.44 && y < 0.84 && ax > split) {
    // 腕: ひじで上腕と前腕に分け、肩の近くは胸にも少し
    const e = sm(0.69, 0.75, y), top = sm(0.78, 0.88, y) * 0.3;
    out.push([BI['upperArm' + s], (1 - top) * e], [BI['foreArm' + s], (1 - top) * (1 - e)], [BI.chest, top]);
  } else if (y >= 0.84 && ax > 0.05) {
    // 肩: 外側ほど腕と一緒に動く
    const a = sm(0.05, 0.13, ax) * (1 - sm(0.86, 0.94, y)) * 0.7;
    out.push([BI['upperArm' + s], a], [BI.chest, 1 - a]);
  } else if (y < 0.56) {
    // 脚と腰: 股の上は腰、ひざで太ももとすねに分ける
    const h = sm(0.42, 0.56, y), t = sm(0.26, 0.32, y);
    out.push([BI.hips, h], [BI['thigh' + s], (1 - h) * t], [BI['shin' + s], (1 - h) * (1 - t)]);
  } else {
    const c = sm(0.62, 0.74, y);
    out.push([BI.hips, 1 - c], [BI.chest, c]);
  }
  return out;
}

function setSkinAttrs(geo, fill) {
  const n = geo.attributes.position.count;
  const idx = new Uint16Array(n * 4), wt = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) fill(i, idx, wt);
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(idx, 4));
  geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(wt, 4));
}
const _sv = new THREE.Vector3(), _sw = [];

function skinHuman(root, state) {
  const body = root.children[0];
  const P = shapeOf(state);
  const key = `${P.legs}|${P.shoulders}|${P.belly}`;

  // 骨を作る (体型に合わせて位置を変形)
  const abs = {}, B = {}, bones = [];
  for (const [name, parent, p] of BONES) {
    abs[name] = shapeFwd(p[0], p[1], p[2], P, new THREE.Vector3());
    const bone = new THREE.Bone();
    bone.name = name;
    bone.position.copy(abs[name]);
    if (parent) { bone.position.sub(abs[parent]); B[parent].add(bone); } else body.add(bone);
    B[name] = bone;
    bones.push(bone);
  }
  root.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(bones);

  // 体の重み
  const bodyMesh = body.children.find((o) => o.isMesh && /^Base(Man|Woman)_Body$/.test(o.name));
  const bodyGeo = bodyMesh?.geometry;
  if (bodyGeo && bodyGeo.userData.skinKey !== key) {
    const pos = bodyGeo.attributes.position;
    setSkinAttrs(bodyGeo, (i, idx, wt) => {
      shapeInv(pos.getX(i), pos.getY(i), pos.getZ(i), P, _sv);
      bodyWeights(_sv.x, _sv.y, _sw).forEach(([b, w], k) => { idx[i * 4 + k] = b; wt[i * 4 + k] = w; });
    });
    bodyGeo.userData.skinKey = key;
  }

  // 服・靴: いちばん近い体の点の重みをもらう (体の点を 2cm のマスに分けて探す)
  let grid = null;
  const C = 0.02, cell = (v) => Math.floor(v / C);
  const buildGrid = () => {
    grid = new Map();
    const pos = bodyGeo.attributes.position, o = bodyMesh.position;
    for (let i = 0; i < pos.count; i++) {
      const k = cell(pos.getX(i) + o.x) + ',' + cell(pos.getY(i) + o.y) + ',' + cell(pos.getZ(i) + o.z);
      (grid.get(k) || grid.set(k, []).get(k)).push(i);
    }
  };
  // 腕についている体の点 (手は腰の横に下がっているので、スカートやパンツが手に引っぱられないように除く)
  let armMask = null;
  const ARM_BONES = new Set([BI.upperArmL, BI.foreArmL, BI.upperArmR, BI.foreArmR]);
  const nearestBody = (x, y, z, allowArm) => {
    const pos = bodyGeo.attributes.position, o = bodyMesh.position;
    if (!armMask) {
      const bi = bodyGeo.attributes.skinIndex, bw = bodyGeo.attributes.skinWeight;
      armMask = new Uint8Array(pos.count);
      for (let n = 0; n < pos.count; n++) {
        let a = 0;
        for (let k = 0; k < 4; k++) if (ARM_BONES.has(bi.getComponent(n, k))) a += bw.getComponent(n, k);
        armMask[n] = a > 0.2 ? 1 : 0;
      }
    }
    const cx = cell(x), cy = cell(y), cz = cell(z);
    // 腕の点と、それ以外の点のいちばん近いものを別々に探す
    let bA = -1, dA = Infinity, bT = -1, dT = Infinity;
    // 腕以外の点が見つかるまで広げる (腕の点だけ先に見つかっても止めない)
    for (let r = 1; r <= 6 && bT < 0; r++) {
      for (let i = -r; i <= r; i++) for (let j = -r; j <= r; j++) for (let k = -r; k <= r; k++) {
        const list = grid.get(cx + i + ',' + (cy + j) + ',' + (cz + k));
        if (!list) continue;
        for (const n of list) {
          const d = (pos.getX(n) + o.x - x) ** 2 + (pos.getY(n) + o.y - y) ** 2 + (pos.getZ(n) + o.z - z) ** 2;
          if (armMask[n]) { if (d < dA) { dA = d; bA = n; } } else if (d < dT) { dT = d; bT = n; }
        }
      }
    }
    // 袖は腕の方がはっきり近い。胴と腕の間 (すそのわき) は胴につける
    if (allowArm && bA >= 0 && (bT < 0 || Math.sqrt(dA) + 0.006 < Math.sqrt(dT))) return bA;
    return bT >= 0 ? bT : allowArm ? bA : -1;
  };

  for (const m of [...body.children]) {
    if (m.isBone || m === bodyMesh && !bodyGeo) continue;
    if (!m.isMesh || RIGID.test(m.name)) {
      // 小物: 胸の骨 (トートバッグは持っている方の手) にくっつける
      let bone = B.chest;
      if (/Tote/.test(m.name)) bone = new THREE.Box3().setFromObject(m).getCenter(_sv).x >= 0 ? B.foreArmL : B.foreArmR;
      bone.attach(m);
      continue;
    }
    const geo = m.geometry;
    if (m !== bodyMesh && geo.userData.skinKey !== key + bodyGeo?.uuid) {
      if (!bodyGeo) continue;
      if (!grid) buildGrid();
      const pos = geo.attributes.position, skirt = SKIRT.test(m.name);
      const bottom = /^Bottom_/.test(m.name), onePiece = /^OnePiece_/.test(m.name);
      const bi = bodyGeo.attributes.skinIndex, bw = bodyGeo.attributes.skinWeight;
      setSkinAttrs(geo, (i, idx, wt) => {
        const x = pos.getX(i) + m.position.x, y = pos.getY(i) + m.position.y, z = pos.getZ(i) + m.position.z;
        // 腕につけてよいのは、上の服の袖 (ズボン・スカート、ワンピースの腰から下は腕につけない)
        const allowArm = !bottom && !(onePiece && shapeInv(x, y, z, P, _sv).y < 0.62);
        let n = nearestBody(x, y, z, allowArm);
        if (n < 0 && !allowArm) n = nearestBody(x, y, z, true);
        const w = new Map();
        if (n >= 0) for (let k = 0; k < 4; k++) { const wk = bw.getComponent(n, k); if (wk > 0) w.set(bi.getComponent(n, k), wk); }
        else w.set(BI.hips, 1);
        // スカート・ワンピースの下の方は、半分くらい腰についていく (脚の間で裂けて見えないように)
        if (skirt && shapeInv(x, y, z, P, _sv).y < 0.56) {
          for (const [b, v] of w) w.set(b, v * 0.45);
          w.set(BI.hips, (w.get(BI.hips) || 0) + 0.55);
        }
        [...w].sort((a, b) => b[1] - a[1]).slice(0, 4).forEach(([b, v], k) => { idx[i * 4 + k] = b; wt[i * 4 + k] = v; });
      });
      geo.userData.skinKey = key + bodyGeo.uuid;
    }
    const sk = new THREE.SkinnedMesh(geo, m.material);
    sk.name = m.name;
    sk.userData = m.userData;
    sk.castShadow = m.castShadow;
    sk.position.copy(m.position);
    sk.quaternion.copy(m.quaternion);
    sk.scale.copy(m.scale);
    sk.frustumCulled = false;
    sk.normalizeSkinWeights();
    body.add(sk);
    body.remove(m);
    sk.updateMatrixWorld(true);
    sk.bind(skeleton);
  }

  const restDir = (a, b) => abs[b].clone().sub(abs[a]).normalize();
  return {
    joints: {
      LegL: B.thighL, KneeL: B.shinL, LegR: B.thighR, KneeR: B.shinR,
      ArmL: B.upperArmL, ElbowL: B.foreArmL, ArmR: B.upperArmR, ElbowR: B.foreArmR, Chest: B.chest,
    },
    rest: { L: restDir('upperArmL', 'foreArmL'), R: restDir('upperArmR', 'foreArmR') },
    legY: abs.thighL.y,
  };
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
  const z = { Front: [], Back: [] };
  for (const [key, list] of sets) {
    joints[key] = pivotGroup(list);
    baseY[key] = joints[key].position.y;
    sum += baseY[key];
    z[key.startsWith('Front') ? 'Front' : 'Back'].push(joints[key].position.z);
  }
  const avg = (a, d) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : d);
  let tail = null;
  root.traverse((o) => { if (!tail && o.isMesh && /_Tail$/.test(o.name)) tail = o.parent; });
  return {
    joints, baseY, legY: sets.size ? sum / sets.size : 0.25,
    zFront: avg(z.Front, 0.12), zBack: avg(z.Back, -0.12),
    tail, tailRot: tail ? tail.rotation.y : 0,
  };
}

// 体ごと、地面の上の点 (0, 0, z) を支点に前後へ傾ける (お座り・おじぎ)。angle < 0 で頭が上
function pitchAbout(r, z, angle) {
  const pz = z * r.scale.y;
  r.rotation.x += angle;
  r.position.y += pz * Math.sin(angle);
  r.position.z += pz - pz * Math.cos(angle);
}

// ---------------------------------------------------------------- キャラ
const tmp2 = new THREE.Vector2(), tmpA = new THREE.Vector2();
const viewer = new THREE.Vector2(0, 99);   // 見ている人の位置 (tick で更新)
const keepAway = () => (area.mode === 'grid' ? 0.8 : 1.0);   // 見ている人からこれだけは離れる [m]
const qA = new THREE.Quaternion(), vA = new THREE.Vector3(), vB = new THREE.Vector3();
const lerp = THREE.MathUtils.lerp;

// 犬・猫の脚を出す順番 (1周期の中の位置)。なみあし: 左後→左前→右後→右前、はやあし: 対角の脚がいっしょ
const PET_WALK = { BackL: 0, FrontL: 0.25, BackR: 0.5, FrontR: 0.75 };
const PET_TROT = { BackL: 0, FrontR: 0, BackR: 0.5, FrontL: 0.5 };

let walkers = [];
let spawnCount = 0;

class Walker {
  constructor(design, model) {
    this.isPet = model.kind === 'pet';
    this.act = pickAct(this.isPet ? 'pet' : 'human', design.act);
    this.stageAct = STAGE_ACTS.has(this.act);
    this.root = model.build(design.state);
    this.root.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    this.head = this.root.children[1] || null;
    this.headRot = this.head ? this.head.rotation.clone() : null;
    this.rig = this.isPet ? rigPet(this.root) : skinHuman(this.root, design.state);
    this.group = new THREE.Group();
    this.group.add(this.root);
    const box = new THREE.Box3().setFromObject(this.root);
    const label = nameLabel(design.name || model.label, this.isPet ? 0.07 : 0.1);
    label.position.y = box.max.y + (this.isPet ? 0.08 : 0.12);
    this.group.add(label);
    this.height = box.max.y;

    // ギター: 歩く時は背中、弾く時は体の前
    if (this.act === 'guitar') {
      this.guitar = makeGuitar();
      const w = this.root.children[0]?.scale.x || 1;
      const hy = this.rig.legY;
      this.guitarFront = { p: new THREE.Vector3(-0.03, hy + 0.1, 0.08 * w + 0.05), q: new THREE.Quaternion().setFromEuler(new THREE.Euler(0.15, 0, -1.2)) };
      this.guitarBack = { p: new THREE.Vector3(0, hy + 0.2, -0.087 * w - 0.05), q: new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI, 0.5)) };
      this.root.add(this.guitar);
    }

    // 脚の長さ [m] から、ふつうの速さを決める (脚が長いほど速い)
    this.legLen = Math.max(0.08, this.rig.legY * this.root.scale.y);
    this.cruise = this.isPet
      ? 0.42 * Math.sqrt(this.legLen / 0.22) * rand(0.9, 1.1)
      : 0.62 * Math.sqrt(this.legLen / 0.63) * rand(0.9, 1.1);
    this.radius = this.isPet ? 0.28 : 0.3;    // ぶつからないための大きさ
    this.pos = new THREE.Vector2();
    this.target = new THREE.Vector2();
    this.stage = null;   // ギター・ダンス・おひるねをする場所
    this.heading = Math.random() * Math.PI * 2;
    this.v = 0;          // 今の速さ [m/s]
    this.mode = 'idle';  // idle / walk / perform
    this.purpose = null; // walk の目的: wander / stage / leave / play
    this.gait = 'walk';
    this.timer = 0;
    this.phase = Math.random() * Math.PI * 2;
    this.blend = 0;      // 歩く手足の振りの大きさ 0〜1
    this.pw = 0;         // ギター・ダンスなどの動きの大きさ 0〜1
    this.sitW = 0;       // 犬・猫のお座り 0〜1
    this.waveW = 0;      // 人が手をふる 0〜1
    this.sitting = false;
    this.waving = false;
    this.play = { t: 0, end: 0, move: 'hop', start: 0, dur: 1, spin: 0 };
    this.stuck = { t: 0, d: Infinity };   // 目的地に近づけているか
    this.look = { yaw: 0, pitch: 0, y: 0, p: 0, timer: 0, viewer: false };
    this.seed = Math.random() * 10;
    this.spawned = false;
    this.awayUntil = 0;
    this.appear = 1;
    this.lastBeat = -1;
    this.lastEighth = -1;
  }

  // ---------------------------------------------------------------- 行き先
  // 次に行く場所。まっすぐ歩いて行ける、近すぎず遠すぎない場所 (wantView なら画面の中)
  pickTarget(wantView, maxDist = 3.5) {
    const keep = keepAway() + 0.3;
    const good = (q) => {
      const d = q.distanceTo(this.pos);
      if (d < 0.5 || d > maxDist || !okInner(q.x, q.y) || q.distanceTo(viewer) < keep) return false;
      if (wantView && !inView(q.x, q.y, -0.15)) return false;
      // ほかのキャラ (特に演奏中の人) のすぐそばは目的地にしない (押し返されて着かなくなる)
      if (walkers.some((o) => o !== this && o.spawned && o.pos.distanceTo(q) < this.radius + o.radius + 0.15)) return false;
      return area.mode !== 'grid' || pathOK(this.pos, q);
    };
    let p = findPoint(good);
    if (!p && wantView) { wantView = false; p = findPoint(good); }   // 画面の中に良い場所が無ければどこでも
    p ||= findPoint((q) => q.distanceTo(this.pos) > 0.3 && okAt(q.x, q.y), 20);
    if (!p) return false;
    this.target.copy(p);
    return true;
  }

  // ギター・ダンス・おひるねの場所: 画面の中で、見ている人から少し離れた所。ほかの人の場所とは重ならない
  pickStage() {
    const others = walkers.filter((o) => o !== this && o.spawned && o.stage);
    const free = (q) => {
      const d = q.distanceTo(viewer);
      return okInner(q.x, q.y) && d > keepAway() + 0.4 && d < 4.5 && !others.some((o) => o.stage.distanceTo(q) < 1.2);
    };
    const p = findPoint((q) => free(q) && inView(q.x, q.y, -0.25), 60) || findPoint(free) || findPoint((q) => okAt(q.x, q.y));
    if (!p) return false;
    this.stage = p;
    this.target.copy(p);
    return true;
  }

  // 画面の外の、見ている人から遠めの場所 (ここへ着いたら一度いなくなる)
  pickLeave() {
    let best = null;
    for (let i = 0; i < 12; i++) {
      const p = findPoint((q) => okAt(q.x, q.y) && !inView(q.x, q.y, 0.2) && q.distanceTo(viewer) > 1.5
        && (area.mode !== 'grid' || pathOK(this.pos, q)), 10);
      if (p && (!best || p.distanceTo(viewer) > best.distanceTo(viewer))) best = p;
    }
    if (!best) return false;
    this.target.copy(best);
    return true;
  }

  go(purpose, gaitHint) {
    this.purpose = purpose;
    this.stuck.t = 0;
    this.stuck.d = Infinity;
    const far = this.target.distanceTo(this.pos);
    this.gait = this.isPet && (gaitHint === 'trot' || (far > 1.4 && Math.random() < 0.55)) ? 'trot' : 'walk';
    this.mode = 'walk';
    this.sitting = this.waving = false;
  }

  // (x, z) のまわりへ集まる (画面をタップした時)
  goNear(x, z) {
    if (this.stageAct) return;
    for (let i = 0; i < 30; i++) {
      const a = Math.random() * Math.PI * 2, r = rand(0.25, 0.9);
      this.target.set(x + Math.cos(a) * r, z + Math.sin(a) * r);
      if (okAt(this.target.x, this.target.y)) {
        this.go(this.act === 'play' ? 'play' : 'wander', this.target.distanceTo(this.pos) > 1 ? 'trot' : null);
        return;
      }
    }
  }

  // 画面の外から出てきた時: 画面の中へ歩いてくる
  enter() {
    if (this.pickTarget(true, 6)) this.go(this.act === 'play' ? 'play' : 'wander', this.act === 'play' ? 'trot' : null);
    else this.rest(0.5);
  }

  rest(time) {
    this.mode = 'idle';
    this.purpose = null;
    this.timer = time ?? rand(1.5, 4.5);
    this.look.timer = rand(0.2, 0.8);
    this.sitting = this.isPet && this.timer > 2.5 && Math.random() < 0.5;   // 犬・猫はときどきお座り
    this.waving = false;
  }

  startPerform(time) {
    this.mode = 'perform';
    this.purpose = null;
    this.timer = time;
    this.play.t = 0;
    this.play.end = 0;
    this.look.timer = 0;
    this.sitting = this.waving = false;
  }

  // 休み終わったら、次に何をするか
  next(t) {
    if (this.stageAct) {
      if (this.pickStage()) this.go('stage'); else this.rest(1);
      return;
    }
    if (this.act === 'play') { this.startPerform(rand(5, 9)); return; }
    // 散歩: ときどき画面の外へ出ていく (待っているキャラがいる時は多め)
    const waiting = walkers.some((w) => !w.spawned && w.awayUntil <= t + 1);
    if (Math.random() < (waiting ? 0.5 : 0.15) && this.pickLeave()) { this.go('leave'); return; }
    if (this.pickTarget(Math.random() < 0.6)) this.go('wander'); else this.timer = 0.8;
  }

  arrive(t) {
    const p = this.purpose;
    if (p === 'stage') this.startPerform(this.act === 'nap' ? rand(50, 100) : rand(35, 70));
    else if (p === 'play') this.startPerform(rand(5, 9));
    else if (p === 'leave' && !inView(this.pos.x, this.pos.y, 0.1)) {
      this.despawn();
      this.awayUntil = t + rand(3, 8);
    } else this.rest();
  }

  endPerform(t) {
    if (this.act === 'play') {
      // ひとしきり遊んだら、近くへ走っていく
      if (this.pickTarget(Math.random() < 0.6, 2.5)) this.go('play', 'trot'); else this.startPerform(rand(4, 7));
      return;
    }
    this.stage = null;   // 場所を変える
    this.next(t);
  }

  // ---------------------------------------------------------------- 毎フレーム
  update(dt, t, others) {
    let omega = 0;   // 向きを変える速さ [rad/s]
    const L = this.look;
    const lookAtViewer = (pitch) => {
      tmp2.subVectors(viewer, this.pos);
      const a = angleDiff(this.heading, Math.atan2(tmp2.x, tmp2.y));
      L.yaw = clamp(a, -0.9, 0.9);
      L.pitch = pitch;
      return a;
    };

    if (this.mode === 'perform') {
      this.v = Math.max(0, this.v - 2.5 * dt);
      this.timer -= dt;
      if (this.act === 'guitar' || this.act === 'dance') {
        // 見ている人の方を向いて演奏する
        tmp2.subVectors(viewer, this.pos);
        const d = angleDiff(this.heading, Math.atan2(tmp2.x, tmp2.y));
        if (Math.abs(d) > 0.3) {
          const turn = clamp(d, -1.2 * dt, 1.2 * dt);
          this.heading += turn;
          omega = turn / dt;
        }
        L.yaw = this.act === 'guitar' ? clamp(d * 0.5, -0.4, 0.4) : 0;
        L.pitch = 0;
      } else if (this.act === 'nap') {
        // ときどき顔を上げてこちらを見る
        L.timer -= dt;
        if (L.timer <= 0) { L.timer = rand(3, 8); L.viewer = Math.random() < 0.35; }
        if (L.viewer) lookAtViewer(-0.1); else { L.yaw = 0.2; L.pitch = 0.3; }
      } else if (this.act === 'play') {
        omega = this.updatePlay(dt);
        L.yaw = 0;
        L.pitch = this.play.move === 'bow' ? -0.3 : 0;
      }
      if (this.timer <= 0) this.endPerform(t);
    } else if (this.mode === 'idle') {
      this.v = Math.max(0, this.v - 2.5 * dt);
      this.timer -= dt;
      if (this.timer <= 0) this.next(t);
      // きょろきょろ見回す。ときどきこちら (カメラ) を見る。人は手をふることも
      L.timer -= dt;
      if (L.timer <= 0) {
        L.timer = rand(0.9, 2.6);
        L.viewer = Math.random() < 0.35 && viewer.distanceTo(this.pos) < 6;
        this.waving = !this.isPet && L.viewer && Math.random() < 0.5 && inView(this.pos.x, this.pos.y);
        L.yaw = rand(-0.8, 0.8);
        L.pitch = rand(-0.12, 0.15);
      }
      if (L.viewer) {
        const a = lookAtViewer(this.isPet ? -0.3 : -0.15);
        // 首だけで向けないほど後ろなら、体ごと少し向き直る
        if (Math.abs(a) > 0.9 && !this.sitting) {
          const turn = clamp(a - Math.sign(a) * 0.6, -1.5 * dt, 1.5 * dt);
          this.heading += turn;
          omega = turn / dt;
        }
      }
    } else {
      tmp2.subVectors(this.target, this.pos);
      const dist = tmp2.length();
      // 1.5 秒たってもほとんど近づけない (ほかのキャラにふさがれている) なら、あきらめて別の所へ
      const S = this.stuck;
      if ((S.t += dt) > 1.5) {
        const blocked = S.d - dist < 0.08;
        S.t = 0;
        S.d = dist;
        if (blocked) {
          if (this.purpose === 'stage' || dist < 0.5) this.arrive(t); else this.rest(rand(0.3, 1));
          S.d = Infinity;
        }
      }
      if (this.mode !== 'walk') { /* 上であきらめた */ } else if (dist < 0.1) this.arrive(t);
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
        if (this.mode === 'walk') {
          if (this.purpose === 'stage' && this.stage && this.stage.distanceTo(this.pos) < 1) this.arrive(t);
          else this.rest(rand(0.3, 1.2));
        }
      } else this.pos.set(nx, nz);
    }

    // ほかのキャラ・見ている人と重ならないように押し合う (演奏中の人は動かない。歩ける場所の外へは押し出さない)
    tmpA.copy(this.pos);
    if (this.mode !== 'perform') {
      for (const o of others) {
        if (o === this || !o.spawned) continue;
        tmp2.subVectors(this.pos, o.pos);
        const min = this.radius + o.radius, d = tmp2.length();
        if (d > 1e-4 && d < min) this.pos.addScaledVector(tmp2, ((min - d) / d) * (o.mode === 'perform' ? 1 : 0.5));
      }
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
    const amp0 = this.isPet ? (this.gait === 'trot' || this.act === 'play' ? 0.42 : 0.3) : 0.36;
    this.blend += (Math.min(1, stepV / (0.45 * this.cruise)) - this.blend) * Math.min(1, dt * 5);
    const A = amp0 * this.blend;
    this.phase += ((stepV * Math.PI) / (2 * this.legLen * Math.max(A, amp0 * 0.45))) * dt;

    // 動きの切り替えはなめらかに
    const ease = (cur, on, speed) => cur + ((on ? 1 : 0) - cur) * Math.min(1, dt * speed);
    this.pw = ease(this.pw, this.mode === 'perform', 3);
    this.sitW = ease(this.sitW, this.mode === 'idle' && this.sitting, 3);
    this.waveW = ease(this.waveW, this.mode === 'idle' && this.waving, 4);
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

  // はしゃぐ: ぴょんぴょん跳ねる・くるっと回る・おじぎ (遊ぼうのポーズ) を順に
  updatePlay(dt) {
    const P = this.play;
    P.t += dt;
    if (P.t >= P.end) {
      P.move = ['hop', 'spin', 'bow', 'hop'][Math.floor(Math.random() * 4)];
      P.dur = { hop: 1.2, spin: 1.1, bow: 1.4 }[P.move];
      P.start = P.t;
      P.end = P.t + P.dur + rand(0.1, 0.5);
      P.spin = (Math.random() < 0.5 ? -1 : 1) * (Math.PI * 2) / P.dur;
    }
    if (P.move === 'spin' && P.t - P.start < P.dur) {
      this.heading += P.spin * dt;
      return P.spin;
    }
    return 0;
  }

  // ---------------------------------------------------------------- 人の動き
  animateHuman(t, A) {
    const J = this.rig.joints, b = this.blend, ph = this.phase;
    const s = Math.sin(ph), c = Math.cos(ph);
    const set = (key, x, z = 0) => { if (J[key]) J[key].rotation.set(x, 0, z); };
    // 歩く: 前へ振る脚 (振り出し中) だけひざを曲げる。地面についている脚はほぼまっすぐ。腕は反対側の脚といっしょに前へ
    set('LegL', -A * s);
    set('LegR', A * s);
    set('KneeL', b * (1.05 * Math.max(0, c) ** 1.5 + 0.05));
    set('KneeR', b * (1.05 * Math.max(0, -c) ** 1.5 + 0.05));
    const armL = 0.85 * A * s - 0.04 * b, armR = -0.85 * A * s - 0.04 * b;
    set('ArmL', armL);
    set('ArmR', armR);
    // ひじは軽く曲げ、腕が前へ来た時ほど曲がる。胸は腰と反対にひねる
    set('ElbowL', -0.12 - b * (0.15 + 0.9 * Math.max(0, -armL)));
    set('ElbowR', -0.12 - b * (0.15 + 0.9 * Math.max(0, -armR)));
    if (J.Chest) J.Chest.rotation.set(0, 0.22 * A * s, 0);
    // 体: 地面についた脚の上を通るので、足を開いた時に低く、そろった時に高くなる。左右にも少しゆれる
    const r = this.root;
    r.position.set(-0.014 * b * c, this.legLen * (Math.cos(A * s) - 1), 0);
    r.rotation.set(0, -0.13 * A * s, 0.012 * Math.sin(t * 1.1 + this.seed) * (1 - b));   // 止まっている時は、ゆっくり重心を移す
    if (this.head) {
      this.head.rotation.set(this.headRot.x + this.look.p, this.headRot.y + this.look.y - r.rotation.y, this.headRot.z);
    }

    if (this.pw > 0.001) this.humanPerform(t);
    if (this.guitar) {
      const F = this.guitarFront, B = this.guitarBack, w = this.pw;
      this.guitar.position.lerpVectors(B.p, F.p, w);
      this.guitar.quaternion.slerpQuaternions(B.q, F.q, w);
    }
    // 手をふる (右手を上げ、ひじから先を左右に)
    if (this.waveW > 0.001 && J.ArmR) {
      vA.set(-0.6, 0.7, 0.25).normalize();
      J.ArmR.quaternion.slerp(qA.setFromUnitVectors(this.rig.rest.R, vA), this.waveW);
      if (J.ElbowR) J.ElbowR.rotation.x += (-0.5 + 0.4 * Math.sin(t * 9) - J.ElbowR.rotation.x) * this.waveW;
    }
  }

  // ギター・ダンス: 拍に合わせたポーズへ、this.pw の割合で近づける
  humanPerform(t) {
    const J = this.rig.joints, r = this.root, w = this.pw, Lg = this.legLen;
    const b = beatAt(t);
    const side = Math.sin(Math.PI * b);              // 1拍ごとに左右 (+1 = 左)
    const bounce = Math.abs(Math.cos(Math.PI * b));  // 拍の頭で 1
    let legLx = 0, legLz = 0, legRx = 0, legRz = 0, kneeL = 0, kneeR = 0;
    let rootX = 0, rootY = 0, rootRy = 0, rootRz = 0, headX = 0, headZ = 0, chestRy = 0;
    let elbowL = -0.15, elbowR = -0.15;   // ひじ (マイナスで前へ曲げる)
    const armL = vA.copy(this.rig.rest.L), armR = vB.copy(this.rig.rest.R);   // 上腕の向き
    // ひざを曲げてしゃがむ (足の裏は地面のまま): 太ももを前へ k/2、すねを後ろへ k
    const squat = (k) => {
      kneeL = kneeR = k;
      legLx = legRx = -k / 2;
      rootY = -Lg * (1 - Math.cos(k / 2));
    };

    if (this.act === 'guitar') {
      // 右手で弦をかき鳴らし (1拍に下・上)、左手はネック。体でリズムを取り、右足でつま先を鳴らす
      const strum = Math.sin(2 * Math.PI * b);
      armR.set(0.12, -0.97, 0.18);
      elbowR = -1.05 + 0.25 * strum;
      armL.set(0.45, -0.75, 0.45);
      elbowL = -1.15;
      rootRz = 0.03 * Math.sin((Math.PI * b) / 2);
      headX = 0.12 + 0.06 * Math.max(0, strum);
      const tap = Math.max(0, strum);
      legRx = -0.08 * tap;
      kneeR = 0.18 * tap;
      kneeL = 0.04;
    } else {
      // ダンス: 16拍ごとに振り付けが変わる (みんな同じテンポなので、何人いてもそろう)
      const routine = Math.floor(b / 16) % 4;
      if (routine === 0) {
        // ステップタッチ: 左右に体重を移しながら、腕を交互に振る
        squat(0.32 * bounce);
        rootX = 0.06 * side;
        legLz = 0.16 * Math.max(0, side);
        legRz = -0.16 * Math.max(0, -side);
        armL.set(0.5, -0.45 + 0.45 * side, 0.45);
        armR.set(-0.5, -0.45 - 0.45 * side, 0.45);
        elbowL = -0.7 - 0.5 * Math.max(0, side);
        elbowR = -0.7 - 0.5 * Math.max(0, -side);
        chestRy = 0.15 * side;
        headZ = 0.1 * side;
      } else if (routine === 1) {
        // 両手を上げて左右にゆれる
        squat(0.28 * bounce);
        armL.set(0.42 + 0.18 * side, 0.9, 0.1);
        armR.set(-0.42 + 0.18 * side, 0.9, 0.1);
        elbowL = elbowR = -0.25;
        rootRz = 0.08 * side;
        headZ = -0.06 * side;
      } else if (routine === 2) {
        // くるっと回って、ジャンプして、着地
        const q = b % 4;
        if (q < 2) {
          const u = q / 2;
          rootRy = Math.PI * 2 * (u * u * (3 - 2 * u));
          armL.set(1, 0.05, 0);
          armR.set(-1, 0.05, 0);
          elbowL = elbowR = -0.05;
          squat(0.15);
        } else if (q < 3) {
          const u = q - 2, up = Math.sin(Math.PI * u);
          rootY = 0.12 * up;
          kneeL = kneeR = 0.8 * up;
          legLx = legRx = -0.4 * up;
          armL.set(0.35, 0.93, 0.1);
          armR.set(-0.35, 0.93, 0.1);
        } else {
          squat(0.55 * (4 - q));
          armL.set(0.8, -0.3, 0.3);
          armR.set(-0.8, -0.3, 0.3);
        }
      } else {
        // パンチ: 左右の手を交互に前へ突き出す
        const e = Math.floor(b) % 2;
        squat(0.3 * bounce);
        armL.set(0.15, e ? 0.05 : -0.9, e ? 1 : 0.3);
        armR.set(-0.15, e ? -0.9 : 0.05, e ? 0.3 : 1);
        elbowL = e ? -0.05 : -1.9;   // 突き出す手はまっすぐ、もう片方はこぶしを胸の前に
        elbowR = e ? -1.9 : -0.05;
        chestRy = (e ? -1 : 1) * 0.25;
        rootRy = -0.1 * side;
      }
    }

    const mixX = (key, v) => { const j = J[key]; if (j) j.rotation.x += (v - j.rotation.x) * w; };
    const setZ = (key, v) => { const j = J[key]; if (j) j.rotation.z = v * w; };
    mixX('LegL', legLx); setZ('LegL', legLz);
    mixX('LegR', legRx); setZ('LegR', legRz);
    mixX('KneeL', kneeL); mixX('KneeR', kneeR);
    mixX('ElbowL', elbowL); mixX('ElbowR', elbowR);
    if (J.Chest) J.Chest.rotation.y += (chestRy - J.Chest.rotation.y) * w;
    if (J.ArmL) J.ArmL.quaternion.slerp(qA.setFromUnitVectors(this.rig.rest.L, armL.normalize()), w);
    if (J.ArmR) J.ArmR.quaternion.slerp(qA.setFromUnitVectors(this.rig.rest.R, armR.normalize()), w);
    r.position.x += (rootX - r.position.x) * w;
    r.position.y += (rootY - r.position.y) * w;
    r.rotation.y += (rootRy - r.rotation.y) * w;
    r.rotation.z += (rootRz - r.rotation.z) * w;
    if (this.head) {
      this.head.rotation.x += headX * w;
      this.head.rotation.z += headZ * w;
    }
  }

  // ---------------------------------------------------------------- 犬・猫の動き
  animatePet(t, A) {
    const R = this.rig, J = R.joints, b = this.blend, ph = this.phase, r = this.root;
    const order = this.gait === 'trot' || this.act === 'play' ? PET_TROT : PET_WALK;
    for (const key in J) {
      const psi = ph - (order[key] ?? 0) * Math.PI * 2;
      const j = J[key];
      j.rotation.set(-A * Math.sin(psi), 0, 0);
      // 前へ振り出す間は足を持ち上げる (脚を少し体の中へ引き込む)
      const lift = Math.max(0, (Math.cos(psi) - 0.25) / 0.75) ** 1.5;
      j.position.y = R.baseY[key] * (1 + 0.14 * b * lift);
    }
    // 脚を斜めにした分だけ体を下げる。はやあしは少し弾む
    const bounce = this.gait === 'trot' ? 0.05 * this.legLen * b * Math.abs(Math.sin(ph)) : 0;
    r.position.set(0, -0.5 * this.legLen * (1 - Math.cos(A)) + bounce, 0);
    r.rotation.set(0, 0, 0);
    let headNod = 0.06 * b * Math.sin(2 * ph);

    const legTo = (front, rot, w) => {
      for (const key in J) {
        if (key.startsWith('Front') !== front) continue;
        J[key].rotation.x += (rot - J[key].rotation.x) * w;
        J[key].position.y += (R.baseY[key] - J[key].position.y) * w;
      }
    };

    // お座り: 前足を支点に頭を上げ、後ろ足を前へたたむ
    if (this.sitW > 0.001) {
      const w = this.sitW, th = 0.5 * w;
      pitchAbout(r, R.zFront, -th);
      legTo(true, th, w);
      legTo(false, -1.0, w);
      headNod += 0.3 * w;
    }
    // おひるね: 前足は前へ、後ろ足は後ろへのばして、おなかを地面につける。ゆっくり息をする
    if (this.act === 'nap' && this.pw > 0.001) {
      const w = this.pw;
      r.position.y += (-this.legLen * 0.9 - r.position.y) * w + 0.004 * Math.sin(t * 1.7) * w;
      legTo(true, -1.45, w);
      legTo(false, 1.45, w);
    }
    // はしゃぐ
    if (this.act === 'play' && this.pw > 0.001) {
      const P = this.play, w = this.pw, u = clamp((P.t - P.start) / P.dur, 0, 1);
      if (P.move === 'hop' && u < 1) {
        // 2回ぴょんぴょん
        const h = Math.abs(Math.sin(Math.PI * 2 * u));
        r.position.y += 0.35 * this.legLen * h * w;
        legTo(true, -0.35 * h, w);
        legTo(false, 0.35 * h, w);
      } else if (P.move === 'bow' && u < 1) {
        // 前足をのばして頭を下げ、おしりを上げる (遊ぼうのポーズ)
        const th = 0.38 * Math.sin(Math.PI * u) * w;
        pitchAbout(r, R.zBack, th);
        legTo(true, -0.9 - th, Math.sin(Math.PI * u) * w);
        legTo(false, -th, Math.sin(Math.PI * u) * w);
      }
    }

    if (this.head) {
      this.head.rotation.set(this.headRot.x + this.look.p + headNod, this.headRot.y + this.look.y, this.headRot.z);
    }
    if (R.tail) {
      const excited = this.act === 'play' || (this.gait === 'trot' && b > 0.5);
      const sleepy = this.act === 'nap' && this.pw > 0.5;
      const f = excited ? 11 : sleepy ? 1.2 : b > 0.3 ? 7 : 4;
      const amp = excited ? 0.4 : sleepy ? 0.08 : b > 0.3 ? 0.32 : 0.22 * (0.5 + 0.5 * Math.sin(t * 0.3 + this.seed));
      R.tail.rotation.y = R.tailRot + (sleepy ? 0.6 : 0) + Math.sin(t * f + this.seed) * amp;
    }
  }

  // ---------------------------------------------------------------- 出る・消える
  spawnAt(x, z, heading, pop) {
    this.pos.set(x, z);
    this.heading = heading;
    this.v = 0;
    this.spawned = true;
    this.appear = pop ? 0 : 1;
    this.group.scale.setScalar(pop ? 0.001 : 1);
    world.add(this.group);
  }

  despawn() {
    this.spawned = false;
    this.stage = null;
    this.mode = 'idle';
    world.remove(this.group);
  }
}

// ひとり出す。散歩・はしゃぐキャラは、なるべく画面の外に出してから画面の中へ歩いてこさせる
function spawnOne(w, preferOff) {
  const keep = keepAway();
  const free = (q) => okAt(q.x, q.y) && q.distanceTo(viewer) > keep + 0.2
    && !walkers.some((o) => o.spawned && o.pos.distanceTo(q) < 0.6);
  const faceViewer = (p) => Math.atan2(viewer.x - p.x, viewer.y - p.y);
  if (w.stageAct) {
    if (!w.pickStage()) return false;
    const p = w.stage;
    w.spawnAt(p.x, p.y, faceViewer(p) + rand(-0.3, 0.3), true);
    w.startPerform(w.act === 'nap' ? rand(50, 100) : rand(35, 70));
    return true;
  }
  let p = preferOff ? findPoint((q) => free(q) && okInner(q.x, q.y) && !inView(q.x, q.y, 0.2)) : null;
  const off = !!p;
  p ||= findPoint((q) => free(q) && okInner(q.x, q.y)) || findPoint(free);
  if (!p) return false;
  w.spawnAt(p.x, p.y, off ? faceViewer(p) : Math.random() * Math.PI * 2, !off);
  if (off) w.enter(); else w.rest(rand(0.3, 1.5));
  return true;
}

let spawnWait = 0;
function spawner(dt, t) {
  spawnWait -= dt;
  if (spawnWait > 0) return;
  spawnWait = 0.4;
  if (walkers.filter((w) => w.spawned).length >= MAX_ACTIVE) return;
  const c = walkers.filter((w) => !w.spawned && w.awayUntil <= t).sort((a, b) => a.awayUntil - b.awayUntil)[0];
  if (c && spawnOne(c, spawnCount >= 2)) spawnCount++;   // 最初の2人はすぐ見えるところに
  else spawnWait = 0.25;
}

// ---------------------------------------------------------------- 音 (ギター)
// ギターの音は、弦をはじいた音を計算で作る (Karplus-Strong)。遠いほど小さく、左右の位置で聞こえる向きが変わる
const audio = { ctx: null, master: null, on: true, bufs: new Map() };
const CHORDS = [
  [130.81, 164.81, 196.0, 261.63, 329.63],          // C
  [98.0, 123.47, 146.83, 196.0, 246.94, 392.0],     // G
  [110.0, 164.81, 220.0, 261.63, 329.63],           // Am
  [87.31, 130.81, 174.61, 220.0, 261.63, 349.23],   // F
];
const STRUM = [1, 0, 1, 1, 0, 1, 1, 1];   // 8分音符ごとに弾くか (偶数 = 下へ、奇数 = 上へ)

function initAudio() {
  if (audio.ctx) return;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    audio.ctx = new AC();
    const comp = audio.ctx.createDynamicsCompressor();
    audio.master = audio.ctx.createGain();
    audio.master.gain.value = 0.6;
    audio.master.connect(comp).connect(audio.ctx.destination);
  } catch (e) { console.warn(e); audio.ctx = null; }
}
function pluckBuffer(f) {
  if (audio.bufs.has(f)) return audio.bufs.get(f);
  const ctx = audio.ctx, sr = ctx.sampleRate, len = Math.floor(sr * 2.4);
  const buf = ctx.createBuffer(1, len, sr), d = buf.getChannelData(0);
  const N = Math.max(2, Math.round(sr / f));
  let prev = 0;
  for (let i = 0; i < N; i++) { prev = prev * 0.5 + (Math.random() * 2 - 1) * 0.5; d[i] = prev; }   // 少しこもらせたノイズ
  for (let i = N; i < len; i++) d[i] = 0.996 * 0.5 * (d[i - N] + d[i - N + 1]);
  audio.bufs.set(f, buf);
  return buf;
}
function strum(chord, down, gain, pan) {
  const ctx = audio.ctx;
  const notes = down ? chord : chord.slice(-4).reverse();
  const out = ctx.createGain();
  out.gain.value = gain * (down ? 1 : 0.6);
  let node = out;
  if (ctx.createStereoPanner) { const p = ctx.createStereoPanner(); p.pan.value = pan; out.connect(p); node = p; }
  node.connect(audio.master);
  const now = ctx.currentTime + 0.02;
  notes.forEach((f, i) => {
    const src = ctx.createBufferSource();
    src.buffer = pluckBuffer(f);
    src.connect(out);
    src.start(now + i * 0.014);
    src.stop(now + 2.4);
  });
}
function setSound(on) {
  audio.on = on;
  soundBtn.textContent = on ? '🔊 音' : '🔇 音';
  if (!audio.ctx) return;
  if (on) audio.ctx.resume(); else audio.ctx.suspend();
}
document.addEventListener('visibilitychange', () => {
  if (!audio.ctx) return;
  if (document.hidden) audio.ctx.suspend(); else if (audio.on) audio.ctx.resume();
});

// ギタリストの音と、ふわっと浮かぶ音符
const _cp = new THREE.Vector3();
function guitarSounds(t) {
  const b = beatAt(t);
  const eighth = Math.floor(b * 2);
  for (const w of walkers) {
    if (!w.spawned || w.act !== 'guitar' || w.mode !== 'perform' || w.pw < 0.7) continue;
    if (Math.floor(b) !== w.lastBeat) {
      w.lastBeat = Math.floor(b);
      _cp.set(w.pos.x + rand(-0.1, 0.1), w.height * w.root.scale.y * 0.8, w.pos.y + rand(-0.1, 0.1));
      emitNote(_cp);
    }
    if (eighth === w.lastEighth) continue;
    w.lastEighth = eighth;
    if (!audio.ctx || !audio.on || audio.ctx.state !== 'running' || !STRUM[eighth % 8]) continue;
    // 遠いほど小さく。カメラから見て左右どちらにいるか
    const dist = Math.max(0.4, w.pos.distanceTo(viewer));
    _cp.set(w.pos.x, 0.8, w.pos.y);
    world.localToWorld(_cp).applyMatrix4(viewCam().matrixWorldInverse);
    const pan = clamp(_cp.x / (Math.abs(_cp.z) + 0.6), -0.9, 0.9);
    strum(CHORDS[Math.floor(b / 4) % 4], eighth % 2 === 0, 0.32 * Math.min(1, 1.3 / dist), pan);
  }
}

const noteTex = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  ctx.font = 'bold 52px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 6;
  ctx.strokeStyle = 'rgba(31,41,55,0.8)';
  ctx.strokeText('♪', 32, 34);
  ctx.fillStyle = '#fff';
  ctx.fillText('♪', 32, 34);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
})();
const notes = Array.from({ length: 16 }, () => {
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: noteTex, transparent: true, depthWrite: false }));
  sp.scale.setScalar(0.1);
  sp.visible = false;
  sp.userData = { life: 0, dx: 0 };
  world.add(sp);
  return sp;
});
function emitNote(p) {
  const sp = notes.find((n) => !n.visible);
  if (!sp) return;
  sp.position.copy(p);
  sp.userData.life = 0;
  sp.userData.dx = rand(-0.15, 0.15);
  sp.visible = true;
}
function updateNotes(dt) {
  for (const sp of notes) {
    if (!sp.visible) continue;
    const u = (sp.userData.life += dt) / 2;
    if (u >= 1) { sp.visible = false; continue; }
    sp.position.y += 0.22 * dt;
    sp.position.x += sp.userData.dx * dt;
    sp.material.opacity = Math.min(1, (1 - u) * 2);
  }
}

// ---------------------------------------------------------------- 毎フレーム
let lastT = 0;
const tmpV = new THREE.Vector3();
function tick(now) {
  const dt = Math.min((now - (lastT || now)) / 1000, 0.1);
  lastT = now;
  updateRing(dt);
  if (!world.visible) return;
  const t = now / 1000;
  // 見ている人 (カメラ) の、地面の上での位置 (world の座標)
  const c = world.worldToLocal(tmpV.setFromMatrixPosition(viewCam().matrixWorld));
  viewer.set(c.x, c.z);
  spawner(dt, t);
  for (const w of walkers) if (w.spawned) w.update(dt, t, walkers);
  guitarSounds(t);
  updateNotes(dt);
}

// ---------------------------------------------------------------- 範囲の輪 (かんたんモードで広さを変えた時に見せる)
const ring = new THREE.Mesh(
  new THREE.RingGeometry(0.985, 1, 96).rotateX(-Math.PI / 2),
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
    walkers.forEach((w) => { if (w.spawned) w.despawn(); w.awayUntil = 0; });
    spawnCount = 0;
    world.position.set(0, p.y, 0);
    world.visible = true;
    world.updateMatrixWorld(true);
    say('床を映しながらゆっくり見回すと、歩ける場所が広がり、みんなが集まってきます');
  } else {
    // 同じ床: タップした場所へみんなが集まる
    walkers.forEach((w) => w.spawned && w.goNear(p.x, p.z));
    say('床を見回すと歩ける場所が広がります。タップした所にみんなが集まります');
  }
  centerLight(p.x, p.z, 5);
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
  soundBtn.hidden = false;
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

// 範囲の広さ (小・ふつう・大)
let sizeIdx = 1;
function setSize(i) {
  sizeIdx = i;
  area.R = SIZES[i][1];
  sizeBtn.textContent = `ひろさ: ${SIZES[i][0]}`;
  centerLight(0, 0, area.R);
  if (!world.visible) return;
  showRing();
  // 範囲の外にいるキャラは中へ戻る
  for (const w of walkers) {
    if (!w.spawned || okInner(w.pos.x, w.pos.y)) continue;
    if (w.stageAct) { w.stage = null; w.next(performance.now() / 1000); } else if (w.mode === 'idle') w.timer = 0;
  }
}

async function startCamera(permission) {
  startPanel.hidden = true;
  area.mode = 'circle';
  setSize(sizeIdx);
  sizeBtn.hidden = false;
  soundBtn.hidden = false;
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

  // 見回し (センサーが無い時) とタップ (タップした所へみんなが集まる)
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
    if (down && !down.moved && world.visible) {
      const p = groundAt((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
      if (p) walkers.forEach((w) => w.spawned && w.goNear(p.x, p.z));
    }
    down = null;
  });

  // みんなは自分 (カメラの真下) を中心とした円の中にいる。向きが分かってから出す
  const startAt = performance.now();
  renderer.setAnimationLoop((now) => {
    if (devOri) camera.quaternion.slerp(orientationQuat(qTarget), 0.35);
    else camera.quaternion.setFromEuler(euler.set(pitch, yaw, 0, 'YXZ'));
    camera.updateMatrixWorld();
    if (!world.visible && (devOri || now - startAt > 800)) {
      world.position.set(0, 0, 0);
      world.visible = true;
      world.updateMatrixWorld(true);
      showRing();
      say(devOri ? 'まわりを見回してみよう。タップした所にみんなが集まります'
        : 'ドラッグで見回し、タップした所にみんなが集まります');
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
  const { sample, hasMine, designs } = pickDesigns(MODELS);
  const built = [];
  for (const d of designs) {
    const model = MODELS[d.baseModel];
    try {
      await model.ensure(d.state);
      built.push(new Walker(d, model));
    } catch (e) { console.error(e); }
  }
  // 1か所でする人 (ギター・ダンス・おひるね) から先に出す
  walkers = [...built.filter((w) => w.stageAct), ...built.filter((w) => !w.stageAct)];  infoEl.textContent = sample
    ? (hasMine ? '「ARに出す」作品が無いので、見本のキャラクターが出てきます' : 'まだ作品が無いので、見本のキャラクターが出てきます')
    : `あなたの作品 ${walkers.length} 体が出てきます`;

  soundBtn.onclick = () => { initAudio(); setSound(!audio.on); };
  const begin = (fn) => () => { initAudio(); setSound(true); fn(); };
  const xrOK = !params.has('mode') && await navigator.xr?.isSessionSupported?.('immersive-ar').catch(() => false);
  startBtn.disabled = false;
  startBtn.textContent = 'カメラを起動';
  startBtn.onclick = begin(() => {
    if (xrOK) startXR().catch((e) => { console.error(e); startCamera(askOrientationPermission()); });
    else startCamera(askOrientationPermission());
  });
  if (xrOK) {
    simpleBtn.hidden = false;
    simpleBtn.onclick = begin(() => startCamera(askOrientationPermission()));
  }
})();
