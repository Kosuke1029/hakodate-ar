// 普通の <script> として読む (HTML をダブルクリックで開いても動くように)。avatar-style.js → models.js の後に読み込むこと
(async () => {
const showError = (msg) => {
  const box = document.querySelector('.preview-container');
  if (box) box.insertAdjacentHTML('beforeend', `<p class="load-error">${msg}</p>`);
};

let THREE, OrbitControls, MODELS;
try {
  THREE = await import('three');
  ({ OrbitControls } = await import('three/addons/controls/OrbitControls.js'));
  MODELS = await window.modelsReady;
} catch (e) {
  console.error(e);
  showError('3D表示の読み込みに失敗しました。インターネット接続を確認してください。');
  return;
}
const ST = window.AvatarStyle;
const canvas = document.getElementById('preview');

let scene, camera, renderer, controls, currentGroup;
let baseModel = 'man';
let states = {}; // { man: state, woman: state }  (state の形は models.js の defaultState())
const stateOf = (mk = baseModel) => (states[mk] ??= MODELS[mk].defaultState());
const DS = window.DesignStore;
const nameInput = document.getElementById('work-name');
let editingId = null;   // 保存ずみの作品を直している時はその id (保存すると上書き)

// ---------------------------------------------------------------- 作りかけの自動保存
// 画面を閉じても、次に開いた時に続きから作れるように。変わった時だけ書き込む
let lastDraft = '';
function draftJSON() {
  return JSON.stringify({ baseModel, states, name: nameInput.value, editingId });
}
function saveDraft() {
  const s = draftJSON();
  if (s === lastDraft) return;
  if (DS.setDraft(JSON.parse(s))) lastDraft = s;
}
function restore() {
  const id = new URLSearchParams(location.search).get('id');
  const draft = DS.getDraft();
  // ?id=… の作品を直す。ただし同じ作品の作りかけがあれば、そちらから続ける
  if (id && !(draft && draft.editingId === id)) {
    const rec = DS.get(id);
    if (rec && DS.isMine(rec) && MODELS[rec.baseModel]) {
      baseModel = rec.baseModel;
      states = { [rec.baseModel]: JSON.parse(JSON.stringify(rec.state)) };
      nameInput.value = rec.name || '';
      editingId = rec.id;
    }
  } else if (draft && MODELS[draft.baseModel]) {
    baseModel = draft.baseModel;
    states = Object.fromEntries(Object.entries(draft.states || {}).filter(([k]) => MODELS[k]));
    nameInput.value = draft.name || '';
    editingId = draft.editingId && DS.get(draft.editingId) ? draft.editingId : null;
  }
  if (editingId) history.replaceState(null, '', `editor.html?id=${editingId}`);
  updateSaveLabel();
  lastDraft = draftJSON();
}
function updateSaveLabel() {
  document.getElementById('save-btn').textContent = editingId ? '上書き保存' : '保存・公開';
}
const draftTimer = setInterval(saveDraft, 1500);
addEventListener('pagehide', saveDraft);
document.addEventListener('visibilitychange', () => { if (document.hidden) saveDraft(); });
nameInput.addEventListener('input', saveDraft);

// ---------------------------------------------------------------- Three.js

function initThree() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0xf0f4f8);

  const rect = canvas.parentElement.getBoundingClientRect();
  const w = rect.width || window.innerWidth;
  const h = rect.height || Math.round(w * 0.75);

  camera = new THREE.PerspectiveCamera(40, w / h, 0.01, 50);
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(w, h);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  scene.add(new THREE.HemisphereLight(0xffffff, 0xd9dee6, 1.1));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(1.5, 3, 2.5);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  Object.assign(sun.shadow.camera, { left: -1, right: 1, top: 1, bottom: -1 });
  scene.add(sun);

  scene.add(new THREE.GridHelper(3, 12, 0xd1d5db, 0xe5e7eb));
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(3, 3), new THREE.ShadowMaterial({ opacity: 0.18 }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxPolarAngle = Math.PI / 1.8;
  controls.minDistance = 0.4;
  controls.maxDistance = 6;

  window.addEventListener('resize', onResize);
  new ResizeObserver(onResize).observe(canvas.parentElement); // 画面の配置が変わった時も描き直す
  (function animate() {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
  })();
}

function onResize() {
  const rect = canvas.parentElement.getBoundingClientRect();
  const w = rect.width || window.innerWidth;
  const h = rect.height || Math.round(w * 0.75);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}

// 全身が入るように、少し斜め前から
function frameModel(obj) {
  const box = new THREE.Box3().setFromObject(obj);
  if (box.isEmpty()) return;
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const vFov = THREE.MathUtils.degToRad(camera.fov) / 2;
  const hFov = Math.atan(Math.tan(vFov) * camera.aspect);
  const dist = (sphere.radius / Math.sin(Math.min(vFov, hFov))) * 1.0;
  const dir = new THREE.Vector3(0.45, 0.25, 1).normalize();
  controls.target.copy(sphere.center);
  camera.position.copy(sphere.center).addScaledVector(dir, dist);
  camera.lookAt(sphere.center);
  controls.update();
}

function disposeGroup(g) {
  g?.traverse((o) => {
    if (!o.isMesh || !o.material.userData.disposable) return;
    if (o.userData.part === 'Face') o.material.map?.dispose();
    o.material.dispose();
  });
}

// 変更のたびに組み立て直す (同じ処理の中での変更はまとめて 1 回)。
// 新しく選んだパーツはその場で読み込むので、組み立ては非同期
let pending = null;
let lastBuild = Promise.resolve();
let buildToken = 0;
const preview = document.querySelector('.preview-container');

function rebuild({ reframe = false } = {}) {
  const first = !pending;
  pending = { reframe: reframe || pending?.reframe };
  if (first) queueMicrotask(flushRebuild);
}
function flushRebuild() {
  if (!pending) return lastBuild;
  const { reframe } = pending;
  pending = null;
  const token = ++buildToken;
  const mk = baseModel;
  const model = MODELS[mk];
  const st = stateOf(mk);
  const loadingTimer = setTimeout(() => preview.classList.add('is-loading'), 150);
  lastBuild = model.ensure(st).then(() => {
    if (token !== buildToken) return; // 読み込み中に、さらに変更された
    if (currentGroup) { scene.remove(currentGroup); disposeGroup(currentGroup); }
    currentGroup = model.build(st);
    scene.add(currentGroup);
    if (reframe) frameModel(currentGroup);
  }).catch((e) => {
    console.error(e);
    showError('パーツを読み込めませんでした。');
  }).finally(() => {
    clearTimeout(loadingTimer);
    if (token === buildToken) preview.classList.remove('is-loading');
  });
  return lastBuild;
}

// ---------------------------------------------------------------- UI 部品

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

function section(title) {
  const sec = el('div', 'parts-section');
  sec.appendChild(el('p', 'parts-label', title));
  return sec;
}

// 選択肢ボタンの列。icon(opt) が canvas などを返せば絵付きボタン
function optionRow(options, current, onPick, icon) {
  const row = el('div', 'parts-options');
  options.forEach((opt) => {
    const b = el('button', 'parts-option' + (icon ? ' icon-option' : '') + (current === opt.id ? ' active' : ''));
    b.type = 'button';
    if (icon) { const i = icon(opt); if (i) b.appendChild(i); }
    b.appendChild(el('span', null, opt.label));
    b.addEventListener('click', () => {
      row.querySelectorAll('.parts-option').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      onPick(opt.id);
    });
    row.appendChild(b);
  });
  return row;
}

// 色のチップ + 自由に選ぶボタン
function colorPicker(paletteKey, current, onPick, ariaLabel) {
  const wrap = el('div', 'color-picker');
  const presets = el('div', 'color-presets');
  const input = el('input', 'color-input');
  input.type = 'color';
  input.value = current || '#ffffff';
  input.title = '自由に色を選ぶ';
  const mark = (hex) => presets.querySelectorAll('.color-chip').forEach((c) =>
    c.classList.toggle('active', c.dataset.hex === hex.toLowerCase()));
  const apply = (hex, final) => { input.value = hex; mark(hex); onPick(hex, final); };
  input.addEventListener('input', (e) => apply(e.target.value, false));
  input.addEventListener('change', (e) => apply(e.target.value, true));
  ST.PALETTES[paletteKey].forEach(([name, hex]) => {
    const chip = el('button', 'color-chip' + ((current || '').toLowerCase() === hex ? ' active' : ''));
    chip.type = 'button';
    chip.dataset.hex = hex;
    chip.title = name;
    chip.setAttribute('aria-label', `${ariaLabel}を${name}にする`);
    chip.style.background = hex;
    chip.addEventListener('click', () => apply(hex, true));
    presets.appendChild(chip);
  });
  presets.appendChild(input);
  wrap.appendChild(presets);
  return wrap;
}

// ---------------------------------------------------------------- タブ: パーツ

function renderPartsTab() {
  const box = document.getElementById('tab-parts');
  box.innerHTML = '';
  const model = MODELS[baseModel];
  const st = stateOf();

  // ワンピースなどを着ている間は使わない種類
  const replacedBy = {};
  for (const [key, def] of Object.entries(model.parts)) {
    if (def.replaces && st.parts[key] && st.parts[key] !== 'none') def.replaces.forEach((k) => (replacedBy[k] = { key, label: def.label }));
  }

  let group = null;
  Object.entries(model.parts).forEach(([key, def]) => {
    if (def.group !== group) {
      group = def.group;
      box.appendChild(el('p', 'tab-hint sub-heading' + (box.children.length ? '' : ' sub-heading--first'), group));
    }
    const sec = section(def.label);
    if (replacedBy[key]) {
      sec.classList.add('is-disabled');
      sec.appendChild(el('p', 'tab-hint', `「${replacedBy[key].label}」を着ている間は使いません`));
    }
    sec.appendChild(optionRow(def.options, st.parts[key] ?? def.default, (id) => {
      st.parts[key] = id;
      if (def.colors?.[id]) Object.assign(st.colors, def.colors[id]); // 犬種・猫種を選んだら、その種類らしい色に
      if (replacedBy[key]) st.parts[replacedBy[key].key] = 'none';
      rebuild();
      if (def.replaces || replacedBy[key]) renderPartsTab();
    }));
    box.appendChild(sec);
  });
}

// ---------------------------------------------------------------- タブ: 顔

// 選択肢ごとの小さな絵 (その部分だけを肌色の上に描く)
const faceScratch = document.createElement('canvas');
faceScratch.width = faceScratch.height = ST.FACE_SIZE;
// s: 顔のパーツの種類 (avatar-style.js の FACE_SECTIONS / PET_FACE_SECTIONS の 1 つ)
function faceIcon(s, face, skin) {
  const ctx = faceScratch.getContext('2d');
  if (s.draw) s.draw(ctx, face);
  else ST.drawFace(ctx, face, s.key);
  const [x, y, w, h] = s.region ?? ST.FACE_ICON_REGION[s.key];
  const c = el('canvas', 'option-icon');
  c.width = 112; c.height = 64;
  const ic = c.getContext('2d');
  ic.fillStyle = skin;
  ic.fillRect(0, 0, c.width, c.height);
  const k = Math.min(c.width / w, c.height / h);
  ic.drawImage(faceScratch, x, y, w, h, (c.width - w * k) / 2, (c.height - h * k) / 2, w * k, h * k);
  return c;
}

function renderFaceTab() {
  const box = document.getElementById('tab-face');
  box.innerHTML = '';
  const model = MODELS[baseModel];
  const st = stateOf();
  const sections = model.faceSections ?? ST.FACE_SECTIONS;

  sections.forEach((s) => {
    const sec = section(s.label);
    const skin = st.colors[s.skinKey ?? model.skinKey ?? 'Skin'] ?? '#f9d6bb';
    sec.appendChild(optionRow(s.list, st.face[s.key], (id) => {
      st.face[s.key] = id;
      rebuild();
    }, (opt) => {
      if (opt.id === 'original') return null;
      return faceIcon(s, { ...st.face, [s.key]: opt.id }, skin);
    }));
    if (s.color) {
      sec.appendChild(colorPicker(s.palette, st.face[s.color], (hex, final) => {
        st.face[s.color] = hex;
        rebuild();
        if (final) renderFaceTab();
      }, s.label));
    }
    box.appendChild(sec);
  });
}

// ---------------------------------------------------------------- タブ: 色

// その部分を一瞬光らせて、どこの色なのかを分かるようにする
function flashPart(key) {
  const mats = new Set();
  currentGroup?.traverse((m) => { if (m.isMesh && m.userData.part === key && m.material.emissive) mats.add(m.material); });
  mats.forEach((mat) => {
    if (mat.userData.flashing) return;
    mat.userData.flashing = true;
    const orig = mat.emissive.clone();
    let n = 0;
    const tick = () => {
      mat.emissive.set(n % 2 === 0 ? 0x666666 : orig);
      if (++n < 6) setTimeout(tick, 160);
      else { mat.emissive.copy(orig); mat.userData.flashing = false; }
    };
    tick();
  });
}

function renderColorTab() {
  const box = document.getElementById('tab-color');
  box.innerHTML = '';
  const model = MODELS[baseModel];
  const st = stateOf();

  // 犬・猫: 毛色のセット (色・柄・顔の模様をまとめて)
  if (model.furPresets) {
    const sec = section('毛色のセット');
    const row = el('div', 'parts-options');
    model.furPresets.forEach((p) => {
      const b = el('button', 'parts-option icon-option');
      b.type = 'button';
      const sw = el('div', 'option-icon option-icon--swatch');
      const main = p.colors.Pet_Body, light = p.colors.Pet_Muzzle;
      const c2 = p.patterns.Pet_Body?.color2;
      sw.style.background = c2
        ? `radial-gradient(circle at 70% 30%, ${c2} 0 28%, transparent 30%), linear-gradient(135deg, ${main} 55%, ${light} 55%)`
        : `linear-gradient(135deg, ${main} 55%, ${light} 55%)`;
      b.append(sw, el('span', null, p.label));
      b.addEventListener('click', () => {
        Object.assign(st.colors, p.colors);
        for (const k of Object.keys(st.patterns)) if (k.startsWith('Pet_')) delete st.patterns[k];
        Object.assign(st.patterns, JSON.parse(JSON.stringify(p.patterns)));
        Object.assign(st.face, p.face);
        rebuild();
        renderActiveTab();
      });
      row.appendChild(b);
    });
    sec.appendChild(row);
    box.appendChild(sec);
  }
  box.appendChild(el('p', 'tab-hint', '名前をタップすると、その場所が光ります'));

  model.colorGroups.forEach((g) => {
    const row = el('div', 'color-row');
    const lbl = el('button', 'color-label', g.label);
    lbl.type = 'button';
    lbl.addEventListener('click', () => flashPart(g.key));
    row.appendChild(lbl);
    row.appendChild(colorPicker(g.palette, st.colors[g.key] ?? g.default, (hex) => {
      st.colors[g.key] = hex;
      rebuild();
    }, g.label));
    box.appendChild(row);
  });
}

// ---------------------------------------------------------------- タブ: 柄

const patternScratch = document.createElement('canvas');
patternScratch.width = patternScratch.height = ST.PATTERN_SIZE;
function patternIcon(id, c1, c2) {
  ST.drawPattern(patternScratch.getContext('2d'), id, c1, c2);
  const c = el('canvas', 'option-icon option-icon--swatch');
  c.width = c.height = 48;
  c.getContext('2d').drawImage(patternScratch, 0, 0, 128, 128, 0, 0, 48, 48);
  return c;
}

// 選んだ画像を小さくして保存する (保存データを軽く)
function shrinkImage(file, max = 256) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const s = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * s);
      c.height = Math.round(img.height * s);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      resolve(c.toDataURL('image/png'));
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

function renderPatternTab() {
  const box = document.getElementById('tab-pattern');
  const model = MODELS[baseModel];
  box.innerHTML = `<p class="tab-hint">${model.kind === 'pet' ? '毛' : '服'}に柄をつけられます。1色目は「色」タブの色です</p>`;
  const st = stateOf();
  const cloth = model.colorGroups.filter((g) => g.cloth);
  if (!cloth.length) {
    box.appendChild(el('p', 'empty-hint', '柄をつけられる服がありません'));
    return;
  }

  cloth.forEach((g) => {
    const p = { ...ST.PATTERN_DEFAULT, ...(st.patterns[g.key] || {}) };
    const base = st.colors[g.key] ?? g.default;
    const sec = section(g.label);
    const set = (patch, rerender = true) => {
      st.patterns[g.key] = { ...p, ...patch };
      rebuild();
      if (rerender) renderPatternTab();
    };

    const options = [...ST.PATTERNS.map(({ id, label }) => ({ id, label })), { id: 'image', label: '画像' }];
    const file = el('input');
    file.type = 'file';
    file.accept = 'image/*';
    file.hidden = true;
    file.addEventListener('change', async () => {
      const f = file.files[0];
      if (!f) return;
      try { set({ type: 'image', image: await shrinkImage(f) }); }
      catch (e) { console.error(e); }
    });
    sec.appendChild(file);

    sec.appendChild(optionRow(options, p.type, (id) => {
      if (id === 'image') file.click();
      else set({ type: id });
    }, (opt) => {
      if (opt.id !== 'image') return patternIcon(opt.id, base, p.color2);
      const c = el('div', 'option-icon option-icon--swatch option-icon--image');
      if (p.image) c.style.backgroundImage = `url(${p.image})`;
      else c.textContent = '+';
      return c;
    }));

    if (p.type !== 'plain') {
      if (p.type !== 'image') {
        sec.appendChild(el('p', 'tab-hint', '柄の色'));
        sec.appendChild(colorPicker('cloth', p.color2, (hex, final) => set({ color2: hex }, final), `${g.label}の柄`));
      }
      sec.appendChild(slider('柄の大きさ', 0.4, 2.5, 0.05, p.scale, (v, final) => set({ scale: v }, final)));
    }
    box.appendChild(sec);
  });
}

// ---------------------------------------------------------------- タブ: 体型

function slider(label, min, max, step, value, onChange) {
  const row = el('label', 'slider-row');
  const name = el('span', 'slider-label', label);
  const input = el('input', 'slider');
  Object.assign(input, { type: 'range', min, max, step, value });
  const val = el('span', 'slider-value', `${Math.round(value * 100)}%`);
  input.addEventListener('input', () => { val.textContent = `${Math.round(input.value * 100)}%`; onChange(+input.value, false); });
  input.addEventListener('change', () => onChange(+input.value, true));
  row.append(name, input, val);
  return row;
}

function renderBodyTab() {
  const box = document.getElementById('tab-body');
  box.innerHTML = '';
  const model = MODELS[baseModel];
  const st = stateOf();
  (model.bodySliders ?? ST.BODY_SLIDERS).forEach((s) => {
    box.appendChild(slider(s.label, s.min, s.max, s.step, st.body[s.key], (v) => {
      st.body[s.key] = v;
      rebuild();
    }));
  });
  const reset = el('button', 'parts-option reset-btn', '元にもどす');
  reset.type = 'button';
  reset.addEventListener('click', () => {
    st.body = model.defaultState().body;
    rebuild();
    renderBodyTab();
  });
  box.appendChild(reset);
}

// ---------------------------------------------------------------- タブの切り替え

const TABS = { parts: renderPartsTab, face: renderFaceTab, color: renderColorTab, pattern: renderPatternTab, body: renderBodyTab };
let activeTab = 'parts';

async function renderActiveTab() {
  // 色・柄タブは「いま表示しているパーツ」に合わせるので、先に組み立てを済ませる
  const tab = activeTab;
  await flushRebuild();
  if (tab === activeTab) TABS[activeTab]();
}

function setupTabs() {
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      activeTab = btn.dataset.tab;
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b === btn));
      document.querySelectorAll('.tab-pane').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + activeTab));
      renderActiveTab();
    });
  });
}

// ---------------------------------------------------------------- おまかせ

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const chance = (p) => Math.random() < p;
const rand = (a, b) => +(a + Math.random() * (b - a)).toFixed(2);

// 「なし」になりやすさ (書いていない種類は必ず何か選ぶ)
const NONE_CHANCE = { Hair: 0.05, Nose: 0.3, OnePiece: 0.8, Hat: 0.7, Glasses: 0.8, HeadAccessory: 0.85, Neck: 0.8, Bag: 0.75 };

// 犬・猫のおまかせ: 種類を選んで、その種類らしい色のまま or 毛色を変える
function randomizePet(model) {
  const breed = pick(model.parts.Breed.options).id;
  const st = model.defaultState(breed);
  // 小物 (首もとは半分くらい、ほかはときどき)
  for (const key of ['Hat', 'Glasses', 'HeadAccessory', 'Neck', 'Bag']) {
    const opts = model.parts[key].options.filter((o) => o.id !== 'none');
    st.parts[key] = chance(key === 'Neck' ? 0.5 : 0.2) ? pick(opts).id : 'none';
  }
  const r = Math.random();
  if (r < 0.4) {
    // 毛色のセットから
    const p = pick(model.furPresets);
    Object.assign(st.colors, p.colors);
    Object.assign(st.patterns, JSON.parse(JSON.stringify(p.patterns)));
    Object.assign(st.face, p.face);
  } else if (r < 0.7) {
    const P = ST.PALETTES;
    const fur = pick(P.fur)[1];
    const light = chance(0.5) ? pick(P.fur.slice(0, 2))[1] : fur; // 口のまわり・足先は白っぽく
    Object.assign(st.colors, { Pet_Body: fur, Pet_Head: fur, Pet_Ear: fur, Pet_Tail: fur, Pet_Fluff: chance(0.5) ? light : fur, Pet_Muzzle: light, Pet_Paw: light });
  }
  st.colors.Pet_Collar = pick(ST.PALETTES.cloth)[1];
  st.colors.Pet_Ribbon = pick(ST.PALETTES.cloth)[1];
  st.face.eyes = pick(['dot', 'dot', 'round', 'sparkle', 'smile', 'line', 'sleepy', 'wink']);
  st.face.petMouth = pick(['omega', 'smile', 'tongue', 'open', 'flat', 'none']);
  if (chance(0.5)) st.face.whiskers = pick(['none', 'short', 'long']);
  st.face.brows = chance(0.15) ? pick(['natural', 'maro']) : 'none';
  st.face.cheeks = chance(0.3) ? pick(['round', 'solid']) : 'none';
  st.face.cheekColor = pick(ST.PALETTES.cheek)[1];
  st.body = Object.fromEntries(model.bodySliders.map((s) => [s.key, rand(1 - (1 - s.min) * 0.5, 1 + (s.max - 1) * 0.5)]));
  return st;
}

async function randomize() {
  const mk = baseModel;
  const model = MODELS[mk];
  if (model.kind === 'pet') {
    states[mk] = randomizePet(model);
    rebuild();
    renderActiveTab();
    return;
  }
  const st = model.defaultState();
  for (const [key, def] of Object.entries(model.parts)) {
    const opts = def.options.filter((o) => o.id !== 'none');
    st.parts[key] = def.options.some((o) => o.id === 'none') && chance(NONE_CHANCE[key] ?? 0.2) ? 'none' : pick(opts).id;
  }

  // どの色グループがあるかは組み立ててみないと分からないので、読み込んで一度作って捨てる
  try { await model.ensure(st); } catch (e) { console.error(e); showError('パーツを読み込めませんでした。'); return; }
  if (mk !== baseModel) return;
  disposeGroup(model.build(st));
  const P = ST.PALETTES;
  const hair = chance(0.75) ? pick(P.hair.slice(0, 5))[1] : pick(P.hair)[1];
  st.colors.Skin = pick(P.skin)[1];
  st.colors.Hair = hair;
  for (const g of model.colorGroups) {
    if (g.key === 'Skin' || g.key === 'Hair' || /_Lens$/.test(g.key)) continue;
    st.colors[g.key] = pick(P.cloth)[1];
    if (g.cloth && chance(0.3)) {
      st.patterns[g.key] = { type: pick(ST.PATTERNS.slice(1)).id, color2: pick(P.cloth)[1], scale: rand(0.7, 1.4) };
    }
  }

  for (const s of ST.FACE_SECTIONS) {
    if (s.key === 'extra') st.face.extra = chance(0.3) ? pick(s.list).id : 'none';
    else if (s.key === 'nose') st.face.nose = st.parts.Nose === 'none' ? pick(['none', 'dot', 'hook']) : 'none';
    else st.face[s.key] = pick(s.list).id;
  }
  st.face.eyeColor = chance(0.7) ? pick(P.eye.slice(0, 2))[1] : pick(P.eye)[1];
  st.face.browColor = hair === '#f3f3f3' || hair === '#c7ccd3' ? '#6b7280' : hair;
  st.face.mouthColor = pick(P.lip)[1];
  st.face.cheekColor = pick(P.cheek)[1];
  // 体型は極端になりすぎないよう、スライダーの範囲の半分くらいで
  st.body = Object.fromEntries(ST.BODY_SLIDERS.map((s) => [s.key, rand(1 - (1 - s.min) * 0.5, 1 + (s.max - 1) * 0.5)]));

  states[mk] = st;
  rebuild();
  renderActiveTab();
}

// ---------------------------------------------------------------- モデル選択

function renderModelSelector() {
  const wrap = document.getElementById('model-selector');
  wrap.innerHTML = '';
  Object.entries(MODELS).forEach(([id, model]) => {
    const btn = el('button', 'model-chip' + (baseModel === id ? ' active' : ''), `${model.icon} ${model.label}`);
    btn.addEventListener('click', () => {
      baseModel = id;
      wrap.querySelectorAll('.model-chip').forEach((b) => b.classList.toggle('active', b === btn));
      rebuild({ reframe: true });
      renderActiveTab();
    });
    wrap.appendChild(btn);
  });
  const dice = el('button', 'model-chip random-chip', '🎲 おまかせ');
  dice.addEventListener('click', randomize);
  wrap.appendChild(dice);
}

// ---------------------------------------------------------------- 保存

async function saveDesign() {
  const name = nameInput.value.trim();
  if (!name) {
    nameInput.focus();
    nameInput.style.borderColor = '#ef4444';
    setTimeout(() => (nameInput.style.borderColor = ''), 1500);
    return;
  }

  const btn = document.getElementById('save-btn');
  btn.disabled = true;
  btn.textContent = '保存中…';

  try {
    await lastBuild;   // 見た目の組み立てが終わってから写真を撮る
    const now = new Date().toISOString();
    const record = {
      id: editingId || Date.now().toString(),
      name,
      baseModel,
      modelLabel: MODELS[baseModel].label,
      modelIcon: MODELS[baseModel].icon,
      state: JSON.parse(JSON.stringify(stateOf())),
      thumbnail: DS.thumbnail(canvas),
      updatedAt: now,
    };
    if (!editingId) record.createdAt = now;

    // ----- Firebase (未設定の場合は localStorage にフォールバック) -----
    // import { db } from './firebase-config.js';
    // await db.collection('designs').add(record);
    // ---------------------------------------------------------------

    DS.put(record);
    DS.clearDraft();
    clearInterval(draftTimer);
    lastDraft = draftJSON();   // ページを離れる時に作りかけとして書き戻さない

    btn.textContent = '保存しました！';
    setTimeout(() => { window.location.href = `mine.html?saved=${record.id}`; }, 700);
  } catch (err) {
    console.error(err);
    btn.disabled = false;
    updateSaveLabel();
    alert(DS.isQuota(err)
      ? '保存できる量がいっぱいです。「じぶんの作品」から使わない作品を削除してください。'
      : '保存に失敗しました');
  }
}

// 作りかけを消して、はじめから作る
function startNew() {
  if (!confirm('いまの作りかけを消して、新しく作りますか？')) return;
  DS.clearDraft();
  states = {};
  editingId = null;
  nameInput.value = '';
  history.replaceState(null, '', 'editor.html');
  updateSaveLabel();
  rebuild({ reframe: true });
  renderActiveTab();
  lastDraft = '';
}

// ---------------------------------------------------------------- 起動

restore();
setupTabs();
document.getElementById('save-btn').addEventListener('click', saveDesign);
document.getElementById('new-btn').addEventListener('click', startNew);
initThree();
renderModelSelector();
rebuild({ reframe: true });
renderActiveTab();
})();
