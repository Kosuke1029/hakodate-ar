// ES module ではなく普通の <script> として読む (HTML をダブルクリックで開いても動くように)。
// three.js は importmap 経由で CDN から動的 import する。avatar-style.js の後に読むこと。
window.modelsReady = (async () => {
const THREE = await import('three');
const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
const { DecalGeometry } = await import('three/addons/geometries/DecalGeometry.js');
const ST = window.AvatarStyle;

// file:// で開いた時は fetch できないので、埋め込み版 (○○.glb.js) を <script> で読む
const scriptLoads = {};
function loadScript(src) {
  return (scriptLoads[src] ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`読み込めません: ${src}`));
    document.head.appendChild(s);
  }));
}
async function loadGLB(url) {
  const loader = new GLTFLoader();
  if (location.protocol === 'file:') {
    if (!window.EMBEDDED_GLB?.[url]) await loadScript(url + '.js');
    const bin = Uint8Array.from(atob(window.EMBEDDED_GLB[url]), (c) => c.charCodeAt(0));
    return loader.parseAsync(bin.buffer, '');
  }
  return loader.loadAsync(url);
}

// ---------------------------------------------------------------- 寸法 (Blender のベースモデルに合わせた値, 単位 m)
const NECK_PIVOT = new THREE.Vector3(0, 0.98, 0);  // 頭を大きくするときの支点 (首の付け根)
// 顔の絵を貼る範囲 (avatar-style.js の顔 canvas と対応)。正面から -Z 向きに投影する
const FACE_BOX = { center: new THREE.Vector3(0, 1.07, 0.15), size: new THREE.Vector3(0.2, 0.2, 0.2) };
const PATTERN_TILE = 0.08; // 柄 1 枚が服の上で何 m になるか (大きさ 1 のとき)
// 頭にかぶる帽子をかぶっている間は、髪が帽子から飛び出さないように少し縮める
const HAIR_PIVOT = new THREE.Vector3(0, 1.12, 0);
const HAIR_SQUEEZE = { Cap: 0.93, Beanie: 0.91, Bucket: 0.91, Straw: 0.96 };

// ---------------------------------------------------------------- パーツの一覧
// Blender から書き出した models/avatar/<種類>/ の .glb。
//   shared: true … 男女共通 (<種類>_<名前>.glb)。false … 男女別 (BaseMan_<種類>_<名前>.glb)
//   head: true   … 頭と一緒に動く・大きくなる
//   optional     … 「なし」を選べる
//   code         … Blender ではなくコードで作る小物 (makeCodeItem)
//   replaces     … これを着ている間は使わない種類 (ワンピース → トップス・ボトムス)
// 新しいパーツを足すときは: .glb を models/avatar/<種類>/ に置く → python embed_model.py → items に名前を足す
const CATEGORIES = [
  { key: 'Face', label: '輪郭', group: '頭', shared: true, head: true,
    items: ['Standard', 'Oval', 'Round', 'Long', 'Slim', 'Square', 'Heart', 'Diamond', 'Pear', 'Chubby'] },
  { key: 'Hair', label: '髪型', group: '頭', shared: true, head: true, optional: true,
    items: ['Short', 'Bob', 'Long', 'Ponytail', 'TwinTails', 'Bun', 'Buzz', 'Mash', 'Spiky', 'Afro'] },
  { key: 'Ears', label: '耳', group: '頭', shared: true, head: true, items: ['Round', 'Big', 'Pointy'] },
  { key: 'Nose', label: '鼻', group: '頭', shared: true, head: true, optional: true, items: ['Small', 'Round', 'Pointy', 'Wide'] },
  { key: 'Top', label: 'トップス', group: '服', items: ['TShirt', 'LongSleeve', 'Tank', 'Blouse', 'Hoodie', 'Jacket'] },
  { key: 'Bottom', label: 'ボトムス', group: '服', items: ['Pants', 'Shorts', 'Skirt', 'PleatedSkirt', 'LongSkirt'] },
  { key: 'OnePiece', label: 'ワンピース・着物', group: '服', optional: true, items: ['Dress', 'Kimono'], replaces: ['Top', 'Bottom'] },
  { key: 'Shoes', label: '靴', group: '服', items: ['Sneakers', 'Flats', 'Boots', 'Sandals', 'Geta'] },
  { key: 'Hat', label: '帽子', group: '小物', shared: true, head: true, optional: true,
    items: ['Cap', 'Beanie', 'Beret', 'Bucket', 'Straw', 'TopHat'], code: ['Hachimaki'] },
  { key: 'Glasses', label: 'メガネ', group: '小物', shared: true, head: true, optional: true, items: ['Round', 'Square', 'Sunglasses'] },
  { key: 'HeadAccessory', label: '頭のかざり', group: '小物', shared: true, head: true, optional: true,
    items: ['Ribbon', 'Headphones'], code: ['Flower', 'HairPin'] },
  { key: 'Neck', label: '首もと', group: '小物', optional: true, items: ['Muffler', 'Tie'], code: ['BowTie'] },
  { key: 'Bag', label: 'カバン', group: '小物', optional: true, items: ['Backpack', 'Shoulder', 'Tote'] },
];
const CAT = Object.fromEntries(CATEGORIES.map((c) => [c.key, c]));

// 名前 → 表示名
const PART_LABELS = {
  Short: 'ショート', Bob: 'ボブ', Long: 'ロング', Ponytail: 'ポニーテール', TwinTails: 'ツインテール',
  Bun: 'おだんご', Buzz: 'ぼうず', Mash: 'マッシュ', Spiky: 'ツンツン', Afro: 'アフロ',
  TShirt: 'Tシャツ', LongSleeve: '長そで', Tank: 'タンクトップ', Blouse: 'ブラウス', Hoodie: 'パーカー', Jacket: 'ジャケット',
  Pants: 'ズボン', Shorts: '短パン', Skirt: 'スカート', PleatedSkirt: 'プリーツスカート', LongSkirt: 'ロングスカート',
  Dress: 'ワンピース', Kimono: '着物',
  Sneakers: 'スニーカー', Flats: 'フラットシューズ', Boots: 'ブーツ', Sandals: 'サンダル', Geta: '下駄',
  Cap: 'キャップ', Beanie: 'ニット帽', Beret: 'ベレー帽', Bucket: 'バケットハット', Straw: '麦わら帽子', TopHat: 'シルクハット', Hachimaki: 'ハチマキ',
  Square: '四角メガネ', Sunglasses: 'サングラス',
  Ribbon: 'リボン', Headphones: 'ヘッドホン', Flower: '花', HairPin: 'ヘアピン',
  Muffler: 'マフラー', Tie: 'ネクタイ', BowTie: '蝶ネクタイ',
  Backpack: 'リュック', Shoulder: 'ショルダーバッグ', Tote: 'トートバッグ',
};
const CATEGORY_ITEM_LABELS = {
  Face: { Standard: 'ふつう', Oval: 'たまご', Round: 'まる顔', Long: '面長', Slim: 'ほっそり', Square: '四角',
    Heart: 'ハート', Diamond: 'ひし形', Pear: '下ぶくれ', Chubby: 'ふっくら' },
  Ears: { Round: 'ふつう', Big: '大きい', Pointy: 'とがり耳' },
  Nose: { Small: '小さい', Round: 'まるい', Pointy: '高い', Wide: 'ひろい' }, Glasses: { Round: '丸メガネ' } };
const itemLabel = (cat, id) => CATEGORY_ITEM_LABELS[cat]?.[id] ?? PART_LABELS[id] ?? id;

// マテリアル名の最後に付く部分 → 表示名
const SUFFIX_LABELS = {
  Belt: 'ベルト', Collar: '襟', Sole: '底', Strap: 'ひも', Handle: '持ち手', Rib: 'そで口・すそ', Button: 'ボタン',
  Inner: '中に着ているもの', Cuff: '折り返し', Brim: 'つば', Band: 'リボン', Pad: 'クッション', Lens: 'レンズ',
  Knot: '結び目', Tie: '髪ゴム', Obi: '帯', Obijime: '帯締め',
};

// マテリアル名から「色を変える単位」を決める。髪は形を変えても同じ色、耳・鼻は肌と同じ色
function colorKeyOf(matName) {
  const n = matName.replace(/^Base(Man|Woman)_/, '');
  if (/^(Ears|Nose|Face)_/.test(n)) return 'Skin';
  if (/^Hair_[^_]+$/.test(n)) return 'Hair';
  if (/^Hair_[^_]+_Tie$/.test(n)) return 'HairTie';
  return n;
}
function colorLabelOf(key) {
  if (key === 'Skin') return '肌';
  if (key === 'Hair') return '髪';
  if (key === 'HairTie') return '髪ゴム';
  if (key.startsWith('Pet_')) return PET_COLOR_LABELS[key.slice(4)] ?? key.slice(4);
  const [cat, name, ...rest] = key.split('_');
  const base = itemLabel(cat, name);
  return rest.length ? `${base}の${SUFFIX_LABELS[rest.join('_')] ?? rest.join('_')}` : base;
}
function paletteOf(key) {
  if (key === 'Skin') return 'skin';
  if (key === 'Hair') return 'hair';
  if (key === 'Pet_Nose') return 'nose';
  if (/^Pet_(Collar|Ribbon)$/.test(key)) return 'cloth';
  if (key.startsWith('Pet_')) return 'fur';
  return 'cloth';
}
// 柄を付けられるか (服と、犬・猫の毛)
const isCloth = (key) => /^(Top|Bottom|OnePiece|Shoes|Hat|Neck|Bag|Pet)_/.test(key) && !/_Lens$|^Pet_Nose$/.test(key);

// 最初の色 (Blender のモデルは白っぽいので、それらしい色を付けておく)
const START_COLORS = {
  Skin: '#f9d6bb', HairTie: '#d42a2a',
  Top_TShirt: '#1e3a5f', Top_LongSleeve: '#2f8f4e', Top_Tank: '#f97316', Top_Blouse: '#f8fafc', Top_Blouse_Collar: '#f8fafc',
  Top_Hoodie: '#9ca3af', Top_Hoodie_Rib: '#6b7280', Top_Jacket: '#3b5b8c', Top_Jacket_Button: '#1f2937', Top_Jacket_Inner: '#f8fafc',
  Bottom_Pants: '#d8c3a5', Bottom_Pants_Belt: '#3c2a1f', Bottom_Shorts: '#3b5b8c', Bottom_Skirt: '#1e3a5f',
  Bottom_PleatedSkirt: '#8b1e2d', Bottom_LongSkirt: '#d8c3a5',
  OnePiece_Dress: '#f6c1cf', OnePiece_Dress_Belt: '#ffffff', OnePiece_Kimono: '#1e3a5f', OnePiece_Kimono_Collar: '#f8fafc',
  OnePiece_Kimono_Obi: '#d4a017', OnePiece_Kimono_Obijime: '#d42a2a',
  Shoes_Sneakers: '#f8fafc', Shoes_Sneakers_Sole: '#9ca3af', Shoes_Flats: '#8b5a2b', Shoes_Flats_Sole: '#3c2a1f',
  Shoes_Boots: '#6b4426', Shoes_Boots_Sole: '#1f2937', Shoes_Sandals: '#d8c3a5', Shoes_Sandals_Sole: '#8b5a2b',
  Shoes_Geta: '#c89b6a', Shoes_Geta_Strap: '#d42a2a',
  Hat_Cap: '#1d4ed8', Hat_Cap_Brim: '#1d4ed8', Hat_Beanie: '#d42a2a', Hat_Beanie_Cuff: '#d42a2a', Hat_Beret: '#8b1e2d',
  Hat_Bucket: '#d8c3a5', Hat_Bucket_Brim: '#d8c3a5', Hat_Straw: '#e8c872', Hat_Straw_Brim: '#e8c872', Hat_Straw_Band: '#b8322a',
  Hat_TopHat: '#1f2937', Hat_TopHat_Brim: '#1f2937', Hat_TopHat_Band: '#8b1e2d', Hat_Hachimaki: '#f8fafc',
  Glasses_Round: '#3c2a1f', Glasses_Square: '#1f2937', Glasses_Sunglasses: '#1f2937', Glasses_Sunglasses_Lens: '#1b1b1f',
  HeadAccessory_Ribbon: '#ec4899', HeadAccessory_Headphones: '#1f2937', HeadAccessory_Headphones_Pad: '#9ca3af',
  HeadAccessory_Flower: '#f6c1cf', HeadAccessory_HairPin: '#facc15',
  Neck_Muffler: '#d42a2a', Neck_Tie: '#1e3a5f', Neck_Tie_Knot: '#1e3a5f', Neck_BowTie: '#1f2937',
  Bag_Backpack: '#d97706', Bag_Backpack_Strap: '#3c2a1f', Bag_Shoulder: '#8b5a2b', Bag_Shoulder_Strap: '#3c2a1f',
  Bag_Tote: '#f1e7d0', Bag_Tote_Handle: '#8b5a2b',
};

// 柄用に、模型の向きから UV を作る (Blender の UV に頼らず、どの服でも同じ大きさで柄が出るように)
function addWorldUV(geo) {
  if (!geo.attributes.normal) geo.computeVertexNormals();
  const pos = geo.attributes.position, nor = geo.attributes.normal;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const ax = Math.abs(nor.getX(i)), ay = Math.abs(nor.getY(i)), az = Math.abs(nor.getZ(i));
    let u, v;
    if (ay > ax && ay > az) { u = x; v = z; }
    else if (ax > az) { u = nor.getX(i) > 0 ? -z : z; v = y; }
    else { u = nor.getZ(i) > 0 ? x : -x; v = y; }
    uv[i * 2] = u / PATTERN_TILE;
    uv[i * 2 + 1] = v / PATTERN_TILE;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

// ---------------------------------------------------------------- 体型の変形
// 体・服・カバンに「同じ変形」をかけるので、どの服を着ていても体からずれない。
// 高さ (y) で区切って伸ばす: 足首より下はそのまま / 足首〜股は脚の長さ倍 / それより上は持ち上げるだけ
const ANKLE_Y = 0.08, HIP_Y = 0.6, NECK_Y0 = 0.94, NECK_Y1 = 0.98;
const SHOULDER_Y = 0.92, WRIST_DROP = 0.33; // 肩の高さと、肩から手首までの長さ
// 腕と一緒に動くもの (胴体と横の位置が重なるので名前で見分ける)。トートバッグは手に持っている
const isArmMesh = (name) => /(UpperArm|Forearm|Hand|Sleeve|Cuff|Tamoto)_?[LR]\d*$/.test(name) || /Bag_Tote/.test(name);

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
// おなか周りだけ膨らませる山形 (0.45〜0.9 で、0.7 あたりが一番)
const belly = (y) => smooth(0.45, 0.68, y) * (1 - smooth(0.74, 0.92, y));

function bodyParams(b) {
  return {
    legs: b.legs ?? 1, arms: b.arms ?? 1, shoulders: b.shoulders ?? 1, belly: b.belly ?? 1, neck: b.neck ?? 1,
  };
}
const isDefaultShape = (P) => P.legs === 1 && P.arms === 1 && P.shoulders === 1 && P.belly === 1 && P.neck === 1;

// 1 点を変形する (out に書く)
function deformPoint(x, y, z, arm, P, out) {
  const y0 = y; // 変形前の高さ
  if (arm) {
    // 腕: 肩から下を腕の長さ倍 (手首より先は伸ばさずに下げるだけ)、肩幅・おなかの分だけ外へ
    const d = SHOULDER_Y - y;
    const d2 = d <= 0 ? d : d <= WRIST_DROP ? d * P.arms : WRIST_DROP * P.arms + (d - WRIST_DROP);
    y = SHOULDER_Y - d2;
    x += Math.sign(x) * (0.16 * (P.shoulders - 1) + 0.1 * Math.max(0, P.belly - 1));
    // 脚の付け根より上にあるので、脚を伸ばした分だけ持ち上げる
    y += (HIP_Y - ANKLE_Y) * (P.legs - 1);
  } else {
    // 胴: 上の方ほど肩幅、まん中はおなか
    const b = 1 + (P.belly - 1) * belly(y0);
    x *= (1 + (P.shoulders - 1) * smooth(0.72, 0.9, y0)) * b;
    z *= b;
    // 脚の長さ: 足首より下はそのまま、足首〜脚の付け根を伸ばし、それより上は持ち上げる
    if (y0 > ANKLE_Y) y = ANKLE_Y + (Math.min(y0, HIP_Y) - ANKLE_Y) * P.legs + Math.max(0, y0 - HIP_Y);
    // 首の長さ: 首の部分を伸ばし、それより上は持ち上げる
    y += Math.min(Math.max(y0 - NECK_Y0, 0), NECK_Y1 - NECK_Y0) * (P.neck - 1);
  }
  out.set(x, y, z);
  return out;
}

// 形を変えた geometry (位置だけ作り直し、法線・UV・面は元のものを使う)。同じ体型なら使い回す
const _p = new THREE.Vector3();
function deformedGeometry(geo, arm, P) {
  const key = `${arm}|${P.legs}|${P.arms}|${P.shoulders}|${P.belly}|${P.neck}`;
  const cache = geo.userData.deformed;
  if (cache?.key === key) return cache.geo;
  const pos = geo.attributes.position;
  const arr = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    deformPoint(pos.getX(i), pos.getY(i), pos.getZ(i), arm, P, _p);
    arr[i * 3] = _p.x; arr[i * 3 + 1] = _p.y; arr[i * 3 + 2] = _p.z;
  }
  const g = new THREE.BufferGeometry();
  g.setIndex(geo.index);
  for (const [name, attr] of Object.entries(geo.attributes)) if (name !== 'position') g.setAttribute(name, attr);
  g.setAttribute('position', new THREE.BufferAttribute(arr, 3));
  g.computeBoundingSphere();
  cache?.geo.dispose();
  geo.userData.deformed = { key, geo: g };
  return g;
}

// ---------------------------------------------------------------- 柄のテクスチャ (同じものは使い回す)
const patternCache = new Map();
function patternTexture(p, baseHex) {
  const scale = p.scale || 1;
  const key = p.type === 'image' ? `img|${p.image}|${scale}` : `${p.type}|${baseHex}|${p.color2}|${scale}`;
  let tex = patternCache.get(key);
  if (tex) return tex;
  if (p.type === 'image') {
    tex = new THREE.TextureLoader().load(p.image);
  } else {
    const c = document.createElement('canvas');
    c.width = c.height = ST.PATTERN_SIZE;
    ST.drawPattern(c.getContext('2d'), p.type, baseHex, p.color2);
    tex = new THREE.CanvasTexture(c);
  }
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1 / scale, 1 / scale);
  tex.anisotropy = 4;
  if (patternCache.size > 80) { patternCache.forEach((t) => t.dispose()); patternCache.clear(); }
  patternCache.set(key, tex);
  return tex;
}

// ---------------------------------------------------------------- コードで作る小物 (Blender にまだ無いもの)
const geoCache = {};
const G = (key, make) => (geoCache[key] ??= make());
const V = (x, y, z) => new THREE.Vector3(x, y, z);

// key: 'Hat_Hachimaki' など。座標は体の座標 (足元が原点)
function makeCodeItem(key, mat) {
  const g = new THREE.Group();
  const add = (geo, x, y, z, setup) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    setup?.(m);
    g.add(m);
    return m;
  };
  // 頭の表面に、外向きに付ける
  const onHead = (obj, p) => { obj.position.copy(p); obj.lookAt(p.clone().multiplyScalar(2).sub(V(0, 1.13, 0))); g.add(obj); };

  if (key === 'Hat_Hachimaki') {
    add(G('hachi', () => new THREE.TorusGeometry(0.15, 0.013, 8, 40)), 0, 1.16, -0.005, (m) => { m.rotation.x = Math.PI / 2; m.scale.set(1, 1.06, 1); });
    add(G('hachiKnot', () => new THREE.BoxGeometry(0.03, 0.03, 0.02)), 0, 1.16, -0.168);
    add(G('hachiTail', () => new THREE.BoxGeometry(0.018, 0.08, 0.006)), 0.02, 1.12, -0.172, (m) => { m.rotation.z = 0.4; });
    add(G('hachiTail', () => new THREE.BoxGeometry(0.018, 0.08, 0.006)), -0.02, 1.12, -0.172, (m) => { m.rotation.z = -0.3; });
  } else if (key === 'HeadAccessory_Flower') {
    const fl = new THREE.Group();
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * Math.PI * 2;
      const m = new THREE.Mesh(G('petal', () => new THREE.SphereGeometry(0.016, 10, 8)), mat);
      m.position.set(Math.cos(a) * 0.018, Math.sin(a) * 0.018, 0);
      m.scale.z = 0.45;
      fl.add(m);
    }
    fl.add(new THREE.Mesh(G('flowerCore', () => new THREE.SphereGeometry(0.01, 10, 8)), new THREE.MeshStandardMaterial({ color: 0xf5d05a })));
    onHead(fl, V(-0.1, 1.2, 0.085));
  } else if (key === 'HeadAccessory_HairPin') {
    for (const r of [0.5, -0.5]) {
      add(G('pinBar', () => new THREE.BoxGeometry(0.05, 0.007, 0.005)), 0.065, 1.17, 0.146, (m) => { m.rotation.z = r; });
    }
  } else if (key === 'Neck_BowTie') {
    const cone = G('btCone', () => new THREE.ConeGeometry(0.024, 0.04, 4));
    for (const s of [-1, 1]) add(cone, s * 0.021, 0.928, 0.1, (m) => { m.rotation.z = s * Math.PI / 2; m.scale.z = 0.5; });
    add(G('btKnot', () => new THREE.SphereGeometry(0.009, 10, 8)), 0, 0.928, 0.102);
  }
  return g;
}

// ---------------------------------------------------------------- アバター

function avatarModel({ label, icon, base, defaults }) {
  const fileOf = (cat, id) => (cat === 'Body'
    ? `models/avatar/Body/${base}_Body.glb`
    : CAT[cat].shared ? `models/avatar/${cat}/${cat}_${id}.glb` : `models/avatar/${cat}/${base}_${cat}_${id}.glb`);

  const partsDef = {};
  for (const c of CATEGORIES) {
    const options = [...c.items, ...(c.code || [])].map((id) => ({ id, label: itemLabel(c.key, id) }));
    if (c.optional) options.push({ id: 'none', label: 'なし' });
    partsDef[c.key] = { label: c.label, group: c.group, options, replaces: c.replaces, default: defaults.parts[c.key] ?? 'none' };
  }

  const loaded = {};   // 'Hair/Bob' → Promise<scene>
  const scenes = {};   // 'Hair/Bob' → scene

  // 選ばれているパーツ ([種類, 名前]) を、ワンピースなどの「代わりに着る」も考えて並べる
  function selected(parts) {
    const hidden = new Set();
    for (const c of CATEGORIES) if (c.replaces && parts[c.key] && parts[c.key] !== 'none') c.replaces.forEach((k) => hidden.add(k));
    return CATEGORIES
      .filter((c) => !hidden.has(c.key) && parts[c.key] && parts[c.key] !== 'none')
      .map((c) => [c.key, parts[c.key]]);
  }
  const isCode = (cat, id) => CAT[cat]?.code?.includes(id);

  const model = {
    label,
    icon,
    parts: partsDef,
    colorGroups: [],   // build() のたびに、表示中のパーツから作り直す
    _faceGeo: {},      // 輪郭ごとの、顔の絵を貼る形 (頭の正面に沿わせたもの)

    defaultState() {
      return {
        parts: Object.fromEntries(Object.entries(partsDef).map(([k, d]) => [k, d.default])),
        colors: { ...START_COLORS, ...(defaults.colors || {}) },
        face: { ...ST.FACE_DEFAULT, ...(defaults.face || {}) },
        patterns: {},
        body: { ...ST.BODY_DEFAULT },
      };
    },

    // そのパーツの .glb を読む (一度読んだものは使い回す)
    _loadPart(cat, id) {
      const k = `${cat}/${id}`;
      return (loaded[k] ??= loadGLB(fileOf(cat, id)).then((gltf) => {
        const src = gltf.scene;
        src.updateMatrixWorld(true);
        src.traverse((o) => {
          if (!o.isMesh) return;
          if (isCloth(colorKeyOf(o.material.name))) addWorldUV(o.geometry);
          if (/_Head$/.test(o.name)) {
            this._faceGeo[cat === 'Face' ? id : 'Body'] = new DecalGeometry(o, FACE_BOX.center, new THREE.Euler(), FACE_BOX.size);
          }
        });
        scenes[k] = src;
        return src;
      }));
    },

    // state を組み立てるのに必要なファイルを読んでおく
    ensure(state) {
      const parts = { ...this.defaultState().parts, ...(state?.parts || {}) };
      return Promise.all([['Body', 'Body'], ...selected(parts)]
        .filter(([cat, id]) => !isCode(cat, id))
        .map(([cat, id]) => this._loadPart(cat, id)));
    },
    load() { return this.ensure(); },

    // state (defaultState() と同じ形) から 3D モデルを組み立てる。先に ensure(state) しておくこと
    build(state = {}) {
      const def = this.defaultState();
      const st = {
        parts: { ...def.parts, ...(state.parts || {}) },
        colors: { ...def.colors, ...(state.colors || {}) },
        face: { ...def.face, ...(state.face || {}) },
        patterns: state.patterns || {},
        body: { ...def.body, ...(state.body || {}) },
      };

      // root (身長) ─┬─ body (体格: 横と奥行き)
      //              └─ head (頭の大きさ: 首の付け根が支点)
      const root = new THREE.Group();
      const body = new THREE.Group();
      const head = new THREE.Group();
      const P = bodyParams(st.body);
      const plain = isDefaultShape(P);
      deformPoint(NECK_PIVOT.x, NECK_PIVOT.y, NECK_PIVOT.z, false, P, head.position); // 脚や首を伸ばした分だけ頭も上へ
      root.add(body, head);
      root.scale.setScalar(st.body.height);
      body.scale.set(st.body.width, 1, st.body.width);
      head.scale.setScalar(st.body.head);
      head.scale.x *= Math.sqrt(st.body.width); // 体格を変えても頭が細く見えすぎないように少しだけ追従

      const toHead = (obj) => { obj.position.copy(NECK_PIVOT).negate(); head.add(obj); };
      const hair = new THREE.Group();
      hair.position.subVectors(HAIR_PIVOT, NECK_PIVOT);
      hair.scale.setScalar(HAIR_SQUEEZE[st.parts.Hat] ?? 1);
      head.add(hair);

      const mats = {};
      const groups = [];
      const matFor = (key, src) => {
        if (!mats[key]) {
          const m = src ? src.clone() : new THREE.MeshStandardMaterial({ roughness: 0.6 });
          m.userData.disposable = true;
          if (/_Lens$/.test(key)) { m.transparent = true; m.depthWrite = false; }
          mats[key] = m;
          groups.push({ key, label: colorLabelOf(key), palette: paletteOf(key), cloth: isCloth(key) && !!src, default: '#' + m.color.getHexString() });
        }
        return mats[key];
      };

      for (const [cat, id] of [['Body', 'Body'], ...selected(st.parts)]) {
        const onHead = cat !== 'Body' && CAT[cat].head;
        if (isCode(cat, id)) {
          const key = `${cat}_${id}`;
          const obj = makeCodeItem(key, matFor(key));
          obj.traverse((o) => { if (o.isMesh) { o.castShadow = true; if (o.material === mats[key]) o.userData.part = key; } });
          if (onHead) toHead(obj);
          else {
            // コードで作った小物は、付いている場所が動いた分だけずらす
            const c = new THREE.Box3().setFromObject(obj).getCenter(new THREE.Vector3());
            obj.position.add(deformPoint(c.x, c.y, c.z, false, P, new THREE.Vector3()).sub(c));
            body.add(obj);
          }
          continue;
        }
        const src = scenes[`${cat}/${id}`];
        if (!src) continue;
        src.traverse((o) => {
          if (!o.isMesh) return;
          const key = colorKeyOf(o.material.name);
          const onBody = cat !== 'Hair' && !onHead && !(cat === 'Body' && /_Head$/.test(o.name));
          const geo = onBody && !plain ? deformedGeometry(o.geometry, isArmMesh(o.name), P) : o.geometry;
          const m = new THREE.Mesh(geo, matFor(key, o.material));
          m.name = o.name;
          m.userData.part = key;
          m.castShadow = !/_Lens$/.test(key);
          if (cat === 'Hair') { m.position.copy(HAIR_PIVOT).negate(); hair.add(m); }
          else if (onHead || (cat === 'Body' && /_Head$/.test(o.name))) toHead(m);
          else body.add(m);
        });
      }

      // 色・柄
      paintMaterials(mats, st);

      // 顔の絵
      const faceGeo = this._faceGeo[st.parts.Face] ?? this._faceGeo.Body;
      if (faceGeo) toHead(faceMesh(faceGeo, st.face));

      this.colorGroups = groups;
      return root;
    },
  };
  return model;
}

// 顔の絵を貼ったメッシュ (keys: 描く部分。省略ですべて。under: 顔より下に描くもの (犬・猫の顔の模様))
function faceMesh(geo, face, keys, under) {
  return decalMesh(geo, (ctx) => {
    if (!under) { ST.drawFace(ctx, face, null, keys); return; }
    under(ctx);
    const top = document.createElement('canvas');
    top.width = top.height = ST.FACE_SIZE;
    ST.drawFace(top.getContext('2d'), face, null, keys);
    ctx.drawImage(top, 0, 0);
  });
}

// canvas に描いた絵をシールとして貼ったメッシュ
function decalMesh(geo, draw) {
  const c = document.createElement('canvas');
  c.width = c.height = ST.FACE_SIZE;
  draw(c.getContext('2d'));
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const fm = new THREE.MeshStandardMaterial({
    map: tex, transparent: true, depthWrite: false, roughness: 0.75,
    polygonOffset: true, polygonOffsetFactor: -4,
  });
  fm.userData.disposable = true;
  const m = new THREE.Mesh(geo, fm);
  m.renderOrder = 1;
  m.userData.part = 'Face';
  return m;
}

// 色・柄をマテリアルに反映する (人も犬・猫も共通)
function paintMaterials(mats, st) {
  for (const [key, mat] of Object.entries(mats)) {
    const hex = st.colors[key];
    const p = st.patterns[key];
    if (p && p.type !== 'plain' && isCloth(key)) {
      mat.map = patternTexture(p, hex ?? '#' + mat.color.getHexString());
      mat.color.set(0xffffff);
    } else {
      mat.map = null;
      if (hex) mat.color.setStyle(hex);
    }
    // レンズは明るい色なら透明に、暗い色ならサングラスらしく
    if (/_Lens$/.test(key)) {
      const hsl = mat.color.getHSL({});
      mat.opacity = hsl.l > 0.5 ? 0.25 : 0.88;
    }
  }
}

// ---------------------------------------------------------------- 犬・猫
// models/avatar/<Dog|Cat>/<Dog|Cat>_<種類>.glb。メッシュ・マテリアル名は <Dog|Cat>_<種類>_<部位>。
// 色は部位ごと (Pet_Body など) に持つので、種類を変えても同じ部位の色の設定がそのまま使える。
// 目や口はモデルに無いので、人と同じく顔の絵 (目・まゆ・ほっぺ) を頭の正面に貼る
const PET_HEAD = /_(Head|Ear_[LR]|EarTuft_[LR]|Muzzle|Nose|Fluff_Top)$/; // 頭と一緒に動く・大きくなる
const PET_COLOR_ORDER = ['Body', 'Head', 'Ear', 'Muzzle', 'Nose', 'Paw', 'Tail', 'Fluff', 'Collar', 'Ribbon'];
const PET_COLOR_LABELS = {
  Body: '体', Head: '頭', Ear: '耳', Muzzle: '口のまわり', Nose: '鼻', Paw: '足先', Tail: 'しっぽ',
  Fluff: 'ふわふわの毛', Collar: '首輪', Ribbon: 'リボン',
};
const PET_FACE_KEYS = ['eyes', 'brows', 'cheeks'];   // 頭のシールに drawFace で描く部分 (模様・口・ひげは別)
const PET_BODY_SLIDERS = [
  { key: 'height',  label: '大きさ',       min: 0.7, max: 1.4, step: 0.01 },
  { key: 'head',    label: '頭の大きさ',   min: 0.8, max: 1.4, step: 0.01 },
  { key: 'width',   label: '体格',         min: 0.8, max: 1.3, step: 0.01 },
  { key: 'legs',    label: '脚の長さ',     min: 0.5, max: 1.4, step: 0.01 },
  { key: 'bodyLen', label: '胴の長さ',     min: 0.7, max: 1.6, step: 0.01 },
  { key: 'tail',    label: 'しっぽの長さ', min: 0.3, max: 1.6, step: 0.01 },
  { key: 'ears',    label: '耳の大きさ',   min: 0.6, max: 1.6, step: 0.01 },
  { key: 'muzzle',  label: '鼻先の長さ',   min: 0.6, max: 1.6, step: 0.01 },
];
const petColorKey = (matName) => 'Pet_' + matName.split('_').slice(2).join('_');

// 脚の長さ: 足先より下はそのまま、足先〜胴の下の方を伸び縮み、それより上は持ち上げる (下げる) だけ
function petLegY(y, I, k) {
  if (y <= I.pawTop) return y;
  if (y <= I.legTop) return I.pawTop + (y - I.pawTop) * k;
  return y + (I.legTop - I.pawTop) * (k - 1);
}
// 脚の長さ k と、前後方向の伸び zs (胴だけ。胴の長さ) をかけた geometry
function petDeformGeometry(geo, I, k, zs) {
  const key = `${k}|${zs}`;
  const cache = geo.userData.petDeformed;
  if (cache?.key === key) return cache.geo;
  const pos = geo.attributes.position;
  const arr = new Float32Array(pos.array.length);
  for (let i = 0; i < pos.count; i++) {
    arr[i * 3] = pos.getX(i);
    arr[i * 3 + 1] = petLegY(pos.getY(i), I, k);
    arr[i * 3 + 2] = pos.getZ(i) * zs;
  }
  const g = new THREE.BufferGeometry();
  g.setIndex(geo.index);
  for (const [name, attr] of Object.entries(geo.attributes)) if (name !== 'position') g.setAttribute(name, attr);
  g.setAttribute('position', new THREE.BufferAttribute(arr, 3));
  g.computeBoundingSphere();
  cache?.geo.dispose();
  geo.userData.petDeformed = { key, geo: g };
  return g;
}
const centerZ = (geo) => {
  if (!geo.boundingBox) geo.computeBoundingBox();
  return (geo.boundingBox.min.z + geo.boundingBox.max.z) / 2;
};

// 首もとの小物 (首の向き・太さに合わせてコードで作る)
const tagMaterial = new THREE.MeshStandardMaterial({ color: 0xe3bf63, metalness: 0.6, roughness: 0.3 });
function petNeckItem(type, I, mat) {
  const g = new THREE.Group();
  const R = I.neckR;
  const ring = new THREE.Group();   // 首輪の輪 (Z 軸を首の向きに合わせる)
  ring.position.copy(I.neckCenter);
  ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), I.neckDir);
  g.add(ring);
  // 首の前側 (のど) の向き
  const front = new THREE.Vector3(0, -I.neckDir.z, I.neckDir.y).normalize();
  const frontPos = (out) => I.neckCenter.clone().addScaledVector(front, R * out);
  const add = (parent, geo, setup) => { const m = new THREE.Mesh(geo, mat); setup?.(m); parent.add(m); return m; };

  if (type === 'Collar') {
    add(ring, new THREE.TorusGeometry(R, R * 0.16, 10, 40));
    const tag = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.28, R * 0.28, R * 0.06, 20), tagMaterial);
    tag.position.copy(frontPos(1.15)).add(new THREE.Vector3(0, -R * 0.3, 0));
    tag.lookAt(tag.position.clone().add(front));
    tag.rotateX(Math.PI / 2);
    g.add(tag);
  } else if (type === 'Ribbon') {
    add(ring, new THREE.TorusGeometry(R, R * 0.09, 8, 40));
    const bow = new THREE.Group();
    bow.position.copy(frontPos(1.1));
    bow.lookAt(bow.position.clone().add(front));
    const cone = new THREE.ConeGeometry(R * 0.45, R * 0.8, 4);
    for (const s of [-1, 1]) add(bow, cone, (m) => { m.position.x = s * R * 0.42; m.rotation.z = s * Math.PI / 2; m.scale.z = 0.5; });
    add(bow, new THREE.SphereGeometry(R * 0.2, 10, 8));
    g.add(bow);
  }
  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  return g;
}

// ---------------------------------------------------------------- 犬・猫の小物
// 人の小物 (.glb / コードで作るもの) を、犬・猫の頭・目・首・背中の大きさと向きに合わせて変形して付ける。
// 人の体の寸法 (Face_Standard / BaseMan_Body の値, m)
const HUMAN = {
  headCenter: new THREE.Vector3(0, 1.111, 0), headSize: new THREE.Vector3(0.24, 0.278, 0.254),
  headTop: 1.25, browY: 1.105,                         // 頭のてっぺん、帽子のふちの高さ (いちばん深くかぶるニット帽・バケットハット)
  eyeY: 1.10, eyeX: 0.045, lensZ: 0.133,              // 目の高さ・左右の位置、メガネのレンズの前後位置
  neckCenter: new THREE.Vector3(0, 0.955, 0), mufflerInner: 0.063,   // マフラーの巻いている所
  chest: new THREE.Vector3(0, 0.93, 0.08),            // ネクタイ・蝶ネクタイの結び目
  back: new THREE.Vector3(0, 0.77, -0.087), width: 0.268,           // リュックが背中に当たる所、胴の幅
};
// mode: head (頭に合わせる) / eyes (目に合わせる) / neck (首に巻く) / chest (のどから下げる) / back (背中にのせる)
// pet: 犬・猫だけの小物 (petNeckItem)、code: makeCodeItem で作るもの
const PET_ACC = [
  { key: 'Hat', mode: 'head', items: ['Cap', 'Beanie', 'Beret', 'Bucket', 'Straw', 'TopHat'], code: ['Hachimaki'],
    file: (id) => `models/avatar/Hat/Hat_${id}.glb` },
  { key: 'Glasses', mode: 'eyes', items: ['Round', 'Square', 'Sunglasses'], file: (id) => `models/avatar/Glasses/Glasses_${id}.glb` },
  { key: 'HeadAccessory', mode: 'head', items: ['Ribbon', 'Headphones'], code: ['Flower', 'HairPin'],
    file: (id) => `models/avatar/HeadAccessory/HeadAccessory_${id}.glb` },
  { key: 'Neck', mode: (id) => (id === 'Muffler' ? 'neck' : 'chest'), pet: ['Collar', 'Ribbon'], items: ['Muffler', 'Tie'], code: ['BowTie'],
    file: (id) => `models/avatar/Neck/BaseMan_Neck_${id}.glb` },
  { key: 'Bag', mode: 'back', items: ['Backpack', 'Shoulder'], file: (id) => `models/avatar/Bag/BaseMan_Bag_${id}.glb` },
];
const PET_ACC_LABELS = { Collar: '首輪', Ribbon: 'リボン' };

const accLoads = {}, accScenes = {};
function loadAccessory(file) {
  return (accLoads[file] ??= loadGLB(file).then((gltf) => {
    const src = gltf.scene;
    src.updateMatrixWorld(true);
    src.traverse((o) => { if (o.isMesh && isCloth(colorKeyOf(o.material.name))) addWorldUV(o.geometry); });
    accScenes[file] = src;
    return src;
  }));
}
const accFiles = (parts) => PET_ACC
  .filter((a) => parts?.[a.key] && parts[a.key] !== 'none' && a.items.includes(parts[a.key]))
  .map((a) => a.file(parts[a.key]));

// 人の座標 → 犬・猫の座標 の変換 (I: 犬・猫の寸法)
function accMatrix(mode, I) {
  const H = HUMAN, M = () => new THREE.Matrix4();
  const at = (v) => M().makeTranslation(v.x, v.y, v.z);
  if (mode === 'head') {
    // 犬・猫は頭の中で目の位置が高いので、頭のてっぺんをそろえ、帽子のふち (人の眉の高さ) が目より上に来るよう縦を縮める
    const s = I.headSize, sx = s.x / H.headSize.x, sz = s.z / H.headSize.z;
    const top = I.headCenter.y + s.y / 2;
    const sy = Math.min(sx, (top - (I.eye.y + 0.02)) / (H.headTop - H.browY));
    return M().makeTranslation(I.headCenter.x, top, I.headCenter.z)
      .multiply(M().makeScale(sx, sy, sz))
      .multiply(M().makeTranslation(-H.headCenter.x, -H.headTop, -H.headCenter.z));
  }
  if (mode === 'eyes') {
    const k = I.eye.x / H.eyeX;
    return at(new THREE.Vector3(0, I.eye.y, I.headCenter.z))
      .multiply(M().makeScale(k, k, (I.eye.z - I.headCenter.z) / H.lensZ))
      .multiply(M().makeTranslation(0, -H.eyeY, 0));
  }
  if (mode === 'neck') {
    const k = (I.neckR * 1.15) / H.mufflerInner;
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), I.neckDir);
    // 首は人より短いので、首の向きには半分に (マフラーの垂れが地面まで届かないように)
    return M().compose(I.neckCenter, q, new THREE.Vector3(k, k * 0.5, k)).multiply(at(H.neckCenter.clone().negate()));
  }
  if (mode === 'chest') {
    const k = (I.headSize.x / H.headSize.x) * 0.55;
    return at(I.throat).multiply(M().makeScale(k, k, k)).multiply(at(H.chest.clone().negate()));
  }
  // back: 人の背中 (-Z) が上、人の上 (+Y) が頭の方 (+Z) になるよう X 軸で 90° 回す
  const t = I.torso, k = (t.max.x - t.min.x) / H.width;
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
  return M().compose(new THREE.Vector3(0, t.max.y - 0.004, (t.min.z + t.max.z) / 2), q, new THREE.Vector3(k, k, k))
    .multiply(at(H.back.clone().negate()));
}

function petModel({ label, icon, kind, breedLabel, breeds, defaultBreed, faceDefaults, furPresets }) {
  const fileOf = (id) => `models/avatar/${kind}/${kind}_${id}.glb`;
  const ids = Object.keys(breeds);
  const loaded = {};   // 種類 → Promise
  const info = {};     // 種類 → { src, faceGeo, muzzleGeo, 首・脚・耳・しっぽの寸法 }
  const prefixed = (colors) => Object.fromEntries(Object.entries(colors).map(([k, v]) => ['Pet_' + k, v]));
  const breedColors = Object.fromEntries(ids.map((id) => [id, prefixed({ Collar: '#d42a2a', Ribbon: '#ec4899', ...breeds[id].colors })]));

  const partsDef = {
    Breed: {
      label: breedLabel, group: '種類', default: defaultBreed,
      options: ids.map((id) => ({ id, label: breeds[id].label })),
      colors: breedColors,   // 種類を選んだら、その種類らしい色にする (editor.js)
    },
  };
  for (const a of PET_ACC) {
    const options = [
      ...(a.pet || []).map((id) => ({ id, label: PET_ACC_LABELS[id] })),
      ...[...a.items, ...(a.code || [])].map((id) => ({ id, label: itemLabel(a.key, id) })),
      { id: 'none', label: 'なし' },
    ];
    partsDef[a.key] = { label: CAT[a.key].label, group: '小物', default: 'none', options };
  }

  return {
    label,
    icon,
    kind: 'pet',
    parts: partsDef,
    colorGroups: [],
    faceSections: ST.PET_FACE_SECTIONS,
    bodySliders: PET_BODY_SLIDERS,
    skinKey: 'Pet_Head',   // 顔のアイコンの下地の色
    // 毛色のセット (色タブで選ぶ): 色・柄・顔の模様をまとめて変える
    furPresets: furPresets.map((p) => ({
      label: p.label,
      colors: prefixed(p.colors),
      patterns: prefixed(p.patterns || {}),
      face: { mark: 'none', ...(p.face || {}) },
    })),

    defaultState(breed = defaultBreed) {
      return {
        parts: { Breed: breed, ...Object.fromEntries(PET_ACC.map((a) => [a.key, 'none'])) },
        colors: { ...START_COLORS, ...breedColors[breed] },
        face: { ...ST.FACE_DEFAULT, ...ST.PET_FACE_DEFAULT, eyes: 'dot', brows: 'none', cheeks: 'none', browColor: '#3c2a1f', ...faceDefaults },
        patterns: {},
        body: Object.fromEntries(PET_BODY_SLIDERS.map((s) => [s.key, 1])),
      };
    },

    _load(id) {
      return (loaded[id] ??= loadGLB(fileOf(id)).then((gltf) => {
        const src = gltf.scene;
        src.updateMatrixWorld(true);
        const boxOf = (re) => {
          const b = new THREE.Box3();
          src.traverse((o) => { if (o.isMesh && re.test(o.name)) b.expandByObject(o); });
          return b;
        };
        let headMesh = null, muzzleMesh = null;
        src.traverse((o) => {
          if (!o.isMesh) return;
          if (isCloth(petColorKey(o.material.name))) addWorldUV(o.geometry);
          if (/_Head$/.test(o.name)) headMesh = o;
          if (/_Muzzle$/.test(o.name)) muzzleMesh = o;
        });
        const V3 = () => new THREE.Vector3();
        const head = boxOf(/_Head$/), muzzle = boxOf(/_Muzzle$/), neck = boxOf(/_Neck$/), nose = boxOf(/_Nose$/);
        const torso = boxOf(/_Torso$/), paw = boxOf(/_Paw/), tail = boxOf(/_Tail$/);
        const hs = head.getSize(V3()), hc = head.getCenter(V3());
        const nc = neck.getCenter(V3());
        // 顔の絵: 目が口のまわり (マズル) のすぐ上に来るように (avatar-style.js の目は中心から 0.15 上)
        const s = hs.x * 0.85;
        const eyeY = muzzle.max.y + 0.02;
        const faceGeo = headMesh && new DecalGeometry(headMesh, new THREE.Vector3(0, eyeY - 0.15 * s, head.max.z),
          new THREE.Euler(), new THREE.Vector3(s, s, hs.z));
        // 口・ひげ: マズルの正面に貼る。鼻の位置を canvas の座標で覚えておく
        const ms = muzzle.getSize(V3()), mc = muzzle.getCenter(V3());
        const sm = Math.max(ms.x, ms.y) * 1.5;
        const muzzleGeo = muzzleMesh && new DecalGeometry(muzzleMesh, new THREE.Vector3(0, mc.y, muzzle.max.z),
          new THREE.Euler(), new THREE.Vector3(sm, sm, ms.z));
        const px = ST.FACE_SIZE / sm;
        const noseCanvas = { y: ST.FACE_SIZE / 2 - (nose.min.y - mc.y) * px, w: (nose.max.x - nose.min.x) / 2 * px };
        // 耳の付け根: 立ち耳は下の端、たれ耳は上の端
        const earBase = {};
        for (const side of ['L', 'R']) {
          const b = boxOf(new RegExp(`_Ear_${side}$`)), c = b.getCenter(V3());
          earBase[side] = new THREE.Vector3(c.x, c.y > hc.y ? b.min.y : b.max.y, c.z);
        }
        // 小物用: 目の位置 (メガネのレンズを置く前後位置は、頭を楕円体とみなした表面)
        const ex = 0.225 * s, dy = eyeY - hc.y;
        const zf = hc.z + (hs.z / 2) * Math.sqrt(Math.max(0.05, 1 - (ex / (hs.x / 2)) ** 2 - (dy / (hs.y / 2)) ** 2)) + 0.006;
        const neckDir = hc.clone().sub(nc).normalize(), neckR = neck.getSize(V3()).x / 2;
        const front = new THREE.Vector3(0, -neckDir.z, neckDir.y).normalize();   // のどの向き
        info[id] = {
          src, faceGeo, muzzleGeo, noseCanvas,
          pivot: nc.clone().lerp(hc, 0.5),                    // 頭を大きくするときの支点
          neckCenter: nc, neckDir, neckR,
          headCenter: hc, headSize: hs, eye: { x: ex, y: eyeY, z: zf }, torso,
          throat: nc.clone().addScaledVector(front, neckR * 1.05).add(new THREE.Vector3(0, 0, 0.015)),
          pawTop: paw.max.y, legTop: torso.min.y + 0.25 * (torso.max.y - torso.min.y),
          earBase,
          tailBase: new THREE.Vector3(0, tail.min.y, tail.max.z),   // しっぽの付け根 (胴に近い側の下)
          muzzleBackZ: muzzle.min.z, noseZ: nose.getCenter(V3()).z,
        };
        return src;
      }));
    },
    ensure(state) {
      return Promise.all([this._load(state?.parts?.Breed ?? defaultBreed), ...accFiles(state?.parts).map(loadAccessory)]);
    },
    load() { return this.ensure(); },

    build(state = {}) {
      const breed = state.parts?.Breed ?? defaultBreed;
      const def = this.defaultState(breed);
      const st = {
        parts: { ...def.parts, ...(state.parts || {}) },
        colors: { ...def.colors, ...(state.colors || {}) },
        face: { ...def.face, ...(state.face || {}) },
        patterns: state.patterns || {},
        body: { ...def.body, ...(state.body || {}) },
      };
      const root = new THREE.Group();
      const I = info[breed];
      if (!I) return root;

      const body = new THREE.Group();
      const head = new THREE.Group();
      root.add(body, head);
      const { legs: k, bodyLen: L, tail: T, ears: E, muzzle: M } = st.body;
      root.scale.setScalar(st.body.height);
      body.scale.x = st.body.width;
      // 胴を前後に伸ばした分、前のもの (頭・前脚) は前へ、後ろのもの (後ろ脚・しっぽ) は後ろへ
      head.position.set(I.pivot.x, petLegY(I.pivot.y, I, k), I.pivot.z * L);
      head.scale.setScalar(st.body.head);
      head.scale.x *= Math.sqrt(st.body.width);
      const toHead = (m) => { m.position.copy(I.pivot).negate(); head.add(m); };

      // しっぽ: 付け根を支点に大きさを変える
      const tail = new THREE.Group();
      tail.position.set(I.tailBase.x, petLegY(I.tailBase.y, I, k), I.tailBase.z * L);
      tail.scale.setScalar(T);
      body.add(tail);
      // 耳: それぞれの付け根を支点に
      const ears = {};
      for (const side of ['L', 'R']) {
        const g = new THREE.Group();
        g.position.copy(I.earBase[side]).sub(I.pivot);
        g.scale.setScalar(E);
        head.add(g);
        ears[side] = g;
      }
      // 鼻先: マズルの付け根から前へ伸ばす (鼻は伸ばさずに前へずらす)
      const muzzle = new THREE.Group();
      muzzle.position.set(-I.pivot.x, -I.pivot.y, I.muzzleBackZ - I.pivot.z);
      muzzle.scale.z = M;
      head.add(muzzle);
      const toMuzzle = (m) => { m.position.set(0, 0, -I.muzzleBackZ); muzzle.add(m); };

      const mats = {};
      const matFor = (key, src) => {
        if (!mats[key]) {
          const m = src ? src.clone() : new THREE.MeshStandardMaterial({ roughness: 0.6 });
          m.userData.disposable = true;
          if (/_Lens$/.test(key)) { m.transparent = true; m.depthWrite = false; }
          mats[key] = m;
        }
        return mats[key];
      };

      I.src.traverse((o) => {
        if (!o.isMesh) return;
        const key = petColorKey(o.material.name);
        const m = new THREE.Mesh(o.geometry, matFor(key, o.material));
        m.name = o.name;
        m.userData.part = key;
        m.castShadow = true;
        const ear = o.name.match(/_(?:Ear|EarTuft)_([LR])$/);
        if (/_(Tail|Fluff_TailTip)$/.test(o.name)) { m.position.copy(I.tailBase).negate(); tail.add(m); }
        else if (ear) { m.position.copy(I.earBase[ear[1]]).negate(); ears[ear[1]].add(m); }
        else if (/_Muzzle$/.test(o.name)) toMuzzle(m);
        else if (/_Nose$/.test(o.name)) { toHead(m); m.position.z += (I.noseZ - I.muzzleBackZ) * (M - 1); }
        else if (PET_HEAD.test(o.name)) toHead(m);
        else {
          const torso = /_Torso$/.test(o.name);
          if (k !== 1 || (torso && L !== 1)) m.geometry = petDeformGeometry(o.geometry, I, k, torso ? L : 1);
          if (!torso) m.position.z = centerZ(o.geometry) * (L - 1);
          body.add(m);
        }
      });

      // 人の小物
      for (const a of PET_ACC) {
        const id = st.parts[a.key];
        if (!id || id === 'none' || a.pet?.includes(id)) continue;
        const mode = typeof a.mode === 'function' ? a.mode(id) : a.mode;
        const g = new THREE.Group();
        g.matrixAutoUpdate = false;
        if (a.code?.includes(id)) {
          const key = `${a.key}_${id}`;
          const obj = makeCodeItem(key, matFor(key));
          obj.traverse((o) => { if (o.isMesh) { o.castShadow = true; if (o.material === mats[key]) o.userData.part = key; } });
          g.add(obj);
        } else {
          const src = accScenes[a.file(id)];
          if (!src) continue;
          src.traverse((o) => {
            if (!o.isMesh) return;
            const key = colorKeyOf(o.material.name);
            const m = new THREE.Mesh(o.geometry, matFor(key, o.material));
            m.applyMatrix4(o.matrixWorld);
            m.name = o.name;
            m.userData.part = key;
            m.castShadow = !/_Lens$/.test(key);
            g.add(m);
          });
        }
        const A = accMatrix(mode, I);
        if (mode === 'head' || mode === 'eyes') {
          g.matrix.makeTranslation(-I.pivot.x, -I.pivot.y, -I.pivot.z).multiply(A);
          head.add(g);
        } else {
          // 体の小物: 脚の長さ・胴の長さで動いた分だけずらす
          const p = new THREE.Vector3().setFromMatrixPosition(A);
          g.matrix.makeTranslation(0, petLegY(p.y, I, k) - p.y, p.z * (L - 1)).multiply(A);
          body.add(g);
        }
      }

      if (PET_ACC_LABELS[st.parts.Neck]) {
        const key = 'Pet_' + st.parts.Neck;
        const item = petNeckItem(st.parts.Neck, I, matFor(key));
        item.traverse((o) => { if (o.isMesh && o.material === mats[key]) o.userData.part = key; });
        item.position.set(0, petLegY(I.neckCenter.y, I, k) - I.neckCenter.y, I.neckCenter.z * (L - 1));
        body.add(item);
      }

      paintMaterials(mats, st);
      // 顔: 模様 → 目・まゆ・ほっぺ (頭)、口・ひげ (マズル)
      if (I.faceGeo) toHead(faceMesh(I.faceGeo, st.face, PET_FACE_KEYS, (ctx) => ST.drawPetMarks(ctx, st.face)));
      if (I.muzzleGeo) toMuzzle(decalMesh(I.muzzleGeo, (ctx) => ST.drawPetMuzzle(ctx, st.face, I.noseCanvas)));

      // 毛の色 → 小物の色 の順
      const order = (key) => { const i = key.startsWith('Pet_') ? PET_COLOR_ORDER.indexOf(key.slice(4)) : -1; return i < 0 ? 100 : i; };
      this.colorGroups = Object.keys(mats).sort((a, b) => order(a) - order(b)).map((key) => ({
        key, label: colorLabelOf(key), palette: paletteOf(key), cloth: isCloth(key), default: '#' + mats[key].color.getHexString(),
      }));
      return root;
    },
  };
}

// 毛色のセット用: 体の色・口のまわりと足先の色・鼻の色
const fur = (main, light, nose) => ({ Body: main, Head: main, Ear: main, Tail: main, Fluff: light, Muzzle: light, Paw: light, Nose: nose });
const furPattern = (type, c2, scale) => Object.fromEntries(['Body', 'Head', 'Tail'].map((k) => [k, { type, color2: c2, scale }]));
const stripes = (c2) => furPattern('tabby', c2, 1.3);
const spots = (c2) => ({ Body: { type: 'patches', color2: c2, scale: 1.1 } });
// 黒い毛だと黒目が見えないので、白目のある目にする
const DARK_EYES = { eyes: 'round', eyeColor: '#d9a72e' };

const MODELS = {
  man: avatarModel({
    label: '男性',
    icon: '👨',
    base: 'BaseMan',
    defaults: {
      parts: { Face: 'Standard', Hair: 'Short', Ears: 'Round', Top: 'TShirt', Bottom: 'Pants', Shoes: 'Sneakers' },
      colors: { Hair: '#3c2a1f' },
    },
  }),
  woman: avatarModel({
    label: '女性',
    icon: '👩',
    base: 'BaseWoman',
    defaults: {
      parts: { Face: 'Oval', Hair: 'Bob', Ears: 'Round', Top: 'Blouse', Bottom: 'Skirt', Shoes: 'Flats' },
      colors: { Hair: '#6b4426', Bottom_Skirt: '#1e3a5f' },
      face: { eyes: 'lashes', brows: 'thin', cheeks: 'round' },
    },
  }),
  dog: petModel({
    label: '犬',
    icon: '🐶',
    kind: 'Dog',
    breedLabel: '犬種',
    defaultBreed: 'Shiba',
    faceDefaults: { petMouth: 'smile' },
    furPresets: [
      { label: '赤', colors: fur('#d98a45', '#f7ecdc', '#1f1a17') },
      { label: '黒', colors: fur('#2a2422', '#d39a5c', '#1f1a17'), face: { ...DARK_EYES, eyeColor: '#6b4426' } },
      { label: '白', colors: fur('#f6f2ea', '#f6f2ea', '#1f1a17') },
      { label: 'クリーム', colors: fur('#f1dcb4', '#f8eedb', '#2a211d') },
      { label: 'チョコ', colors: fur('#6b3f26', '#7e4c30', '#2a1a12') },
      { label: '白黒ぶち', colors: fur('#f6f2ea', '#f6f2ea', '#1f1a17'), patterns: spots('#2a2422'), face: { mark: 'patch', markColor: '#2a2422' } },
      { label: '白茶ぶち', colors: fur('#f6f2ea', '#f6f2ea', '#1f1a17'), patterns: spots('#a8642f'), face: { mark: 'patch', markColor: '#a8642f' } },
      { label: '鼻すじ', colors: fur('#8f5532', '#f6f2ea', '#1f1a17'), face: { mark: 'blaze', markColor: '#f6f2ea' } },
    ],
    breeds: {
      Shiba: { label: '柴犬', colors: { Body: '#d98a45', Head: '#d98a45', Ear: '#d98a45', Tail: '#d98a45', Muzzle: '#f7ecdc', Paw: '#f7ecdc', Nose: '#1f1a17' } },
      Retriever: { label: 'レトリバー', colors: { Body: '#e2b46a', Head: '#e2b46a', Ear: '#d7a456', Tail: '#e2b46a', Muzzle: '#ebc583', Paw: '#e2b46a', Nose: '#2a211d' } },
      Dachshund: { label: 'ダックスフンド', colors: { Body: '#7b4526', Head: '#7b4526', Ear: '#5c3219', Tail: '#7b4526', Muzzle: '#8f5532', Paw: '#8f5532', Nose: '#1f1a17' } },
      Corgi: { label: 'コーギー', colors: { Body: '#e19a52', Head: '#e19a52', Ear: '#e19a52', Tail: '#e19a52', Muzzle: '#fbf6ee', Paw: '#fbf6ee', Nose: '#1f1a17' } },
      Poodle: { label: 'トイプードル', colors: { Body: '#b8835a', Head: '#b8835a', Ear: '#a8744c', Tail: '#b8835a', Muzzle: '#b8835a', Paw: '#b8835a', Fluff: '#c4906a', Nose: '#2a211d' } },
      Pug: { label: 'パグ', colors: { Body: '#e3caa0', Head: '#e3caa0', Ear: '#2d2623', Tail: '#e3caa0', Muzzle: '#2d2623', Paw: '#e3caa0', Nose: '#1f1a17' } },
    },
  }),
  cat: petModel({
    label: '猫',
    icon: '🐱',
    kind: 'Cat',
    breedLabel: '猫種',
    defaultBreed: 'Shorthair',
    faceDefaults: { petMouth: 'omega', whiskers: 'short' },
    furPresets: [
      { label: '茶トラ', colors: fur('#e3a05c', '#fbf2e4', '#e59aa5'), patterns: stripes('#c06a32') },
      { label: 'キジトラ', colors: fur('#8a7056', '#d9cbb8', '#8a5a52'), patterns: stripes('#3d2e22') },
      { label: 'サバトラ', colors: fur('#a3a6aa', '#eeeeec', '#c98a92'), patterns: stripes('#4b4f55') },
      { label: '黒', colors: fur('#262222', '#262222', '#3a2a2a'), face: { ...DARK_EYES, whiskerColor: '#f8f6f2' } },
      { label: '白', colors: fur('#f8f6f2', '#f8f6f2', '#f2a7b3') },
      { label: 'ハチワレ', colors: fur('#262222', '#f8f6f2', '#f2a7b3'), face: { ...DARK_EYES, mark: 'hachi', markColor: '#f8f6f2' } },
      { label: '三毛風', colors: fur('#f8f6f2', '#f8f6f2', '#f2a7b3'), patterns: spots('#e09a52'), face: { mark: 'patch', markColor: '#262222' } },
      { label: 'グレー', colors: fur('#7c8894', '#7c8894', '#6b5a62') },
    ],
    breeds: {
      Shorthair: { label: 'ショートヘア', colors: { Body: '#a9abae', Head: '#a9abae', Ear: '#a9abae', Tail: '#a9abae', Muzzle: '#eeeeec', Paw: '#eeeeec', Nose: '#e59aa5' } },
      ScottishFold: { label: 'スコティッシュフォールド', colors: { Body: '#c7c1b8', Head: '#c7c1b8', Ear: '#c7c1b8', Tail: '#c7c1b8', Muzzle: '#f3efe8', Paw: '#f3efe8', Nose: '#d98d97' } },
      Persian: { label: 'ペルシャ', colors: { Body: '#f6f2ec', Head: '#f6f2ec', Ear: '#f6f2ec', Tail: '#f6f2ec', Muzzle: '#fbf8f3', Paw: '#f6f2ec', Fluff: '#fbf8f3', Nose: '#e8a3ad' } },
      Munchkin: { label: 'マンチカン', colors: { Body: '#dc9f5f', Head: '#dc9f5f', Ear: '#dc9f5f', Tail: '#dc9f5f', Muzzle: '#fbf2e4', Paw: '#fbf2e4', Nose: '#e59aa5' } },
      MaineCoon: { label: 'メインクーン', colors: { Body: '#7d6250', Head: '#7d6250', Ear: '#7d6250', Tail: '#7d6250', Muzzle: '#e9dccb', Paw: '#e9dccb', Fluff: '#cdb79c', Nose: '#b9787a' } },
    },
  }),
};

return MODELS;
})();
