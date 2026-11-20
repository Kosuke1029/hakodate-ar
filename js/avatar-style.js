// アバターの「アプリ側で作る」見た目: 色のパレット・顔のパーツ・服の柄・小物の種類。
// three.js を使わない (canvas に描くだけ) ので、普通の <script> として読み込む。models.js より先に読むこと。
window.AvatarStyle = (() => {

// ---------------------------------------------------------------- 色
const PALETTES = {
  skin: [
    ['色白', '#ffe9da'], ['うすだいだい', '#f9d6bb'], ['小麦', '#efc08f'], ['はだ', '#e0aa74'],
    ['日焼け', '#c68650'], ['褐色', '#8d5730'], ['こげ茶', '#5e3a22'],
  ],
  hair: [
    ['黒', '#1d1d22'], ['こげ茶', '#3c2a1f'], ['茶', '#6b4426'], ['明るい茶', '#a3713c'],
    ['金', '#e3bf63'], ['銀', '#c7ccd3'], ['白', '#f3f3f3'], ['赤', '#a8322a'],
    ['ピンク', '#f29bbd'], ['青', '#3b6fd6'], ['緑', '#3f8f5a'], ['紫', '#7e57c2'],
  ],
  eye: [
    ['黒', '#26211f'], ['茶', '#6b4426'], ['はしばみ', '#9a7a3a'], ['青', '#3b82d6'],
    ['緑', '#3f9a5f'], ['灰', '#7b8794'], ['紫', '#8b5cf6'], ['赤', '#d13b3b'],
  ],
  cloth: [
    ['白', '#f8fafc'], ['生成り', '#f1e7d0'], ['ベージュ', '#d8c3a5'], ['グレー', '#9ca3af'],
    ['黒', '#1f2937'], ['紺', '#1e3a5f'], ['青', '#1d4ed8'], ['水色', '#38bdf8'],
    ['ミント', '#5fd3b4'], ['緑', '#2f8f4e'], ['からし', '#d4a017'], ['黄', '#facc15'],
    ['オレンジ', '#f97316'], ['赤', '#d42a2a'], ['えんじ', '#8b1e2d'], ['ピンク', '#ec4899'],
    ['さくら', '#f6c1cf'], ['紫', '#7c3aed'], ['茶', '#8b5a2b'], ['デニム', '#3b5b8c'],
  ],
  lip: [['こげ茶', '#5b3226'], ['赤茶', '#8a3b2e'], ['赤', '#c9343c'], ['ピンク', '#e4728a'], ['黒', '#26211f']],
  cheek: [['ピンク', '#f49ab0'], ['もも', '#f7a8a0'], ['オレンジ', '#f8b27a'], ['赤', '#ef6b6b'], ['むらさき', '#d7a2e8']],
  // 犬・猫の毛
  fur: [
    ['白', '#f8f6f2'], ['クリーム', '#f1e2c6'], ['ベージュ', '#e3caa0'], ['金', '#e2b46a'],
    ['きつね色', '#d98a45'], ['アプリコット', '#c4906a'], ['茶', '#8f5532'], ['こげ茶', '#4a3021'],
    ['黒', '#232020'], ['グレー', '#a9abae'], ['ブルーグレー', '#7c8894'], ['茶トラ', '#dc9f5f'],
  ],
  nose: [['黒', '#1f1a17'], ['こげ茶', '#4a3021'], ['茶', '#8f5532'], ['ピンク', '#e59aa5'], ['うすピンク', '#f2c4cb']],
};

// ---------------------------------------------------------------- 顔
// 顔の絵は 512px 四方の canvas に描き、頭の正面に「シール」として貼る (models.js の FACE_BOX と対応)。
// canvas 上の位置: 目 (141 / 371, 179)、眉 y≈112、鼻 (256, 290)、口 (256, 346)、ほっぺ (89 / 423, 282)
const S = 512;
const EYE = { y: 179, x: [141, 371] };
const BROW_Y = 108;
const FEATURE_SCALE = 1.2; // 目・まゆ・口を少し大きめに (AR で遠くからでも表情が分かるように)
const NOSE = { x: 256, y: 292 };
const MOUTH = { x: 256, y: 350 };
const CHEEK = { y: 284, x: [92, 420] };
const INK = '#2b2220';

function lighten(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const f = (v) => Math.round(v + (255 - v) * amt);
  return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`;
}

function ellipse(ctx, x, y, rx, ry, fill, stroke, lw) {
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.stroke(); }
}
function line(ctx, pts, color, lw) {
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.stroke();
}
function curve(ctx, a, c, b, color, lw) {
  ctx.beginPath();
  ctx.moveTo(a[0], a[1]);
  ctx.quadraticCurveTo(c[0], c[1], b[0], b[1]);
  ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.lineCap = 'round';
  ctx.stroke();
}
function star(ctx, x, y, r1, r2, fill) {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 ? r2 : r1;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    ctx.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
  }
  ctx.closePath();
  ctx.fillStyle = fill; ctx.fill();
}

// 黒目 (iris)。ローカル座標 (目の中心が原点)
function iris(ctx, rx, ry, color, dy = 4, shine = 1) {
  const g = ctx.createLinearGradient(0, -ry, 0, ry);
  g.addColorStop(0, color);
  g.addColorStop(1, lighten(color, 0.45));
  ellipse(ctx, 0, dy, rx, ry, g);
  ellipse(ctx, 0, dy + 2, rx * 0.48, ry * 0.5, '#151112');
  if (shine) {
    ellipse(ctx, -rx * 0.38, dy - ry * 0.4, rx * 0.32, ry * 0.26, '#fff');
    if (shine > 1) ellipse(ctx, rx * 0.35, dy + ry * 0.45, rx * 0.16, ry * 0.12, '#fff');
  }
}

// 目: (ctx, side, color)。side = 外側の向き (+1: 右へ)。ローカル座標で +x が外側
const EYES = [
  { id: 'round', label: 'ぱっちり', draw(ctx, s, c) {
    ellipse(ctx, 0, 0, 27, 36, '#fff');
    iris(ctx, 21, 29, c);
    curve(ctx, [-29, -10], [0, -46], [31, -14], INK, 6);
  } },
  { id: 'sparkle', label: 'キラキラ', draw(ctx, s, c) {
    ellipse(ctx, 0, 2, 28, 38, '#fff');
    iris(ctx, 25, 34, c, 4, 2);
    star(ctx, -9, -10, 10, 4, '#fff');
    curve(ctx, [-31, -8], [0, -50], [34, -16], INK, 8);
    line(ctx, [[30, -15], [40, -24]], INK, 5);
  } },
  { id: 'dot', label: 'つぶら', draw(ctx, s, c) { ellipse(ctx, 0, 6, 11, 15, c === '#26211f' ? INK : c); ellipse(ctx, -3, 1, 3.5, 4, '#fff'); } },
  { id: 'smile', label: 'にっこり', draw(ctx) { curve(ctx, [-24, 10], [0, -22], [24, 10], INK, 8); } },
  { id: 'line', label: 'ほそ目', draw(ctx) { curve(ctx, [-24, 6], [0, 0], [24, 6], INK, 7); } },
  { id: 'sleepy', label: 'ねむそう', draw(ctx, s, c) {
    ctx.save(); ctx.beginPath(); ctx.rect(-40, 0, 80, 60); ctx.clip();
    ellipse(ctx, 0, 0, 26, 32, '#fff'); iris(ctx, 20, 26, c, 2, 0);
    ctx.restore();
    line(ctx, [[-28, 0], [28, 0]], INK, 7);
  } },
  { id: 'tare', label: 'たれ目', draw(ctx, s, c) {
    ellipse(ctx, 0, 2, 26, 33, '#fff'); iris(ctx, 20, 27, c);
    curve(ctx, [-28, -18], [6, -36], [30, 4], INK, 7);
  } },
  { id: 'tsuri', label: 'つり目', draw(ctx, s, c) {
    ellipse(ctx, 0, 2, 26, 31, '#fff'); iris(ctx, 20, 26, c);
    curve(ctx, [-28, -4], [0, -24], [32, -30], INK, 7);
    curve(ctx, [-22, 26], [6, 32], [28, 14], INK, 3);
  } },
  { id: 'lashes', label: 'まつげ', draw(ctx, s, c) {
    ellipse(ctx, 0, 0, 26, 34, '#fff'); iris(ctx, 20, 28, c);
    curve(ctx, [-29, -10], [0, -46], [31, -14], INK, 6);
    line(ctx, [[22, -24], [34, -36]], INK, 4);
    line(ctx, [[30, -14], [42, -22]], INK, 4);
    line(ctx, [[12, -30], [18, -44]], INK, 4);
  } },
  { id: 'wink', label: 'ウインク', draw(ctx, s, c) {
    if (s < 0) { ellipse(ctx, 0, 0, 27, 36, '#fff'); iris(ctx, 21, 29, c); curve(ctx, [-29, -10], [0, -46], [31, -14], INK, 6); }
    else line(ctx, [[-22, -14], [18, 2], [-22, 16]], INK, 7);
  } },
  { id: 'kira', label: 'ほし目', draw(ctx, s, c) { star(ctx, 0, 2, 30, 13, c === '#26211f' ? '#f5b400' : c); } },
  { id: 'heart', label: 'ハート', draw(ctx, s, c) {
    ctx.beginPath();
    ctx.moveTo(0, 26);
    ctx.bezierCurveTo(-38, 0, -22, -32, 0, -12);
    ctx.bezierCurveTo(22, -32, 38, 0, 0, 26);
    ctx.fillStyle = c === '#26211f' ? '#e8457a' : c; ctx.fill();
  } },
  { id: 'glasses_eye', label: 'ぐるぐる', draw(ctx) {
    ctx.beginPath();
    for (let a = 0; a < Math.PI * 7; a += 0.2) ctx.lineTo(Math.cos(a) * a * 1.4, Math.sin(a) * a * 1.4);
    ctx.strokeStyle = INK; ctx.lineWidth = 4; ctx.stroke();
  } },
];

// 眉: ローカル座標で +x が外側
const BROWS = [
  { id: 'none', label: 'なし', draw: null },
  { id: 'natural', label: 'ふつう', draw(ctx, c) { curve(ctx, [-26, 6], [0, -8], [28, 4], c, 8); } },
  { id: 'thick', label: '太まゆ', draw(ctx, c) { curve(ctx, [-26, 6], [0, -8], [28, 4], c, 15); } },
  { id: 'thin', label: '細まゆ', draw(ctx, c) { curve(ctx, [-26, 6], [2, -10], [30, 6], c, 4); } },
  { id: 'straight', label: 'まっすぐ', draw(ctx, c) { line(ctx, [[-26, 0], [28, 0]], c, 9); } },
  { id: 'angry', label: 'キリッ', draw(ctx, c) { line(ctx, [[-26, 12], [28, -10]], c, 10); } },
  { id: 'worried', label: 'こまり', draw(ctx, c) { curve(ctx, [-26, -10], [4, -4], [28, 12], c, 8); } },
  { id: 'maro', label: 'まろ', draw(ctx, c) { ellipse(ctx, -2, -6, 14, 9, c); } },
];

const NOSES = [
  { id: 'none', label: 'なし', draw: null },
  { id: 'dot', label: 'てん', draw(ctx) { ellipse(ctx, 0, 0, 4, 3, 'rgba(120,70,50,.55)'); } },
  { id: 'hook', label: 'くの字', draw(ctx) { line(ctx, [[2, -16], [-7, 6], [4, 8]], 'rgba(110,60,45,.6)', 4); } },
  { id: 'round', label: 'まる', draw(ctx) { ellipse(ctx, 0, 0, 11, 9, 'rgba(240,140,120,.45)'); ellipse(ctx, -3, -3, 3, 2.5, 'rgba(255,255,255,.7)'); } },
  { id: 'nostril', label: 'はな穴', draw(ctx) { ellipse(ctx, -6, 2, 3, 2.2, 'rgba(110,60,45,.6)'); ellipse(ctx, 6, 2, 3, 2.2, 'rgba(110,60,45,.6)'); } },
];

// 口: 中心が原点
const MOUTHS = [
  { id: 'smile', label: 'にこっ', draw(ctx, c) { curve(ctx, [-22, -4], [0, 18], [22, -4], c, 6); } },
  { id: 'small', label: 'ちょこん', draw(ctx, c) { curve(ctx, [-10, -2], [0, 8], [10, -2], c, 5); } },
  { id: 'grin', label: 'わはは', draw(ctx, c) {
    ctx.beginPath(); ctx.moveTo(-28, -8); ctx.quadraticCurveTo(0, -4, 28, -8);
    ctx.quadraticCurveTo(24, 36, 0, 36); ctx.quadraticCurveTo(-24, 36, -28, -8);
    ctx.fillStyle = '#7a2230'; ctx.fill();
    ctx.save(); ctx.clip(); ellipse(ctx, 0, 34, 18, 12, '#ef7f8f'); ctx.restore();
    ctx.strokeStyle = c; ctx.lineWidth = 4; ctx.stroke();
  } },
  { id: 'teeth', label: 'にかっ', draw(ctx, c) {
    ctx.beginPath(); ctx.roundRect(-26, -10, 52, 24, 11);
    ctx.fillStyle = '#fff'; ctx.fill(); ctx.strokeStyle = c; ctx.lineWidth = 4; ctx.stroke();
    line(ctx, [[-24, 2], [24, 2]], c, 2.5);
  } },
  { id: 'tongue', label: 'てへ', draw(ctx, c) {
    ctx.beginPath(); ctx.ellipse(8, 4, 10, 12, 0, 0, Math.PI); ctx.fillStyle = '#ef7f8f'; ctx.fill();
    curve(ctx, [-20, -4], [0, 12], [22, -4], c, 5);
  } },
  { id: 'cat', label: 'ねこ口', draw(ctx, c) {
    curve(ctx, [-20, -2], [-10, 14], [0, -2], c, 5);
    curve(ctx, [0, -2], [10, 14], [20, -2], c, 5);
  } },
  { id: 'o', label: 'おちょぼ', draw(ctx, c) { ellipse(ctx, 0, 0, 7, 8, '#b4505e', c, 3); } },
  { id: 'surprised', label: 'びっくり', draw(ctx, c) { ellipse(ctx, 0, 4, 13, 18, '#7a2230', c, 4); } },
  { id: 'flat', label: 'むっ', draw(ctx, c) { line(ctx, [[-16, 0], [16, 0]], c, 5); } },
  { id: 'pout', label: 'へ', draw(ctx, c) { curve(ctx, [-18, 6], [0, -12], [18, 6], c, 5); } },
  { id: 'wavy', label: 'もにょ', draw(ctx, c) {
    ctx.beginPath(); ctx.moveTo(-22, 0);
    ctx.bezierCurveTo(-14, -10, -6, 10, 0, 0); ctx.bezierCurveTo(6, -10, 14, 10, 22, 0);
    ctx.strokeStyle = c; ctx.lineWidth = 5; ctx.lineCap = 'round'; ctx.stroke();
  } },
  { id: 'lips', label: 'くちびる', draw(ctx, c) {
    ctx.beginPath(); ctx.moveTo(-20, 0);
    ctx.quadraticCurveTo(-10, -12, 0, -5); ctx.quadraticCurveTo(10, -12, 20, 0);
    ctx.quadraticCurveTo(0, 18, -20, 0);
    ctx.fillStyle = c; ctx.fill();
    line(ctx, [[-18, 0], [18, 0]], 'rgba(0,0,0,.35)', 2);
  } },
];

// ほっぺ: 中心が原点、+x が外側
const CHEEKS = [
  { id: 'none', label: 'なし', draw: null },
  { id: 'round', label: 'まる', draw(ctx, c) {
    const g = ctx.createRadialGradient(0, 0, 2, 0, 0, 30);
    g.addColorStop(0, c); g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.globalAlpha = 0.85; ellipse(ctx, 0, 0, 30, 22, g); ctx.globalAlpha = 1;
  } },
  { id: 'solid', label: 'ぽっ', draw(ctx, c) { ctx.globalAlpha = 0.7; ellipse(ctx, 0, 0, 22, 14, c); ctx.globalAlpha = 1; } },
  { id: 'lines', label: 'てれ', draw(ctx, c) {
    for (const dx of [-14, 0, 14]) line(ctx, [[dx - 5, 10], [dx + 5, -10]], c, 4);
  } },
  { id: 'swirl', label: 'うずまき', draw(ctx, c) {
    ctx.beginPath();
    for (let a = 0; a < Math.PI * 5; a += 0.2) ctx.lineTo(Math.cos(a) * a * 1.3, Math.sin(a) * a * 1.0);
    ctx.strokeStyle = c; ctx.lineWidth = 3.5; ctx.stroke();
  } },
];

// その他 (顔全体の座標で描く)
const EXTRAS = [
  { id: 'none', label: 'なし', draw: null },
  { id: 'mole', label: 'ほくろ', draw(ctx) { ellipse(ctx, MOUTH.x + 40, MOUTH.y - 18, 4, 4, '#3a2a22'); } },
  { id: 'freckles', label: 'そばかす', draw(ctx) {
    const pts = [[-14, -8], [0, -12], [12, -4], [-6, 4], [8, 8], [-16, 10]];
    for (const x of CHEEK.x) for (const [dx, dy] of pts) ellipse(ctx, x + (x < 256 ? dx : -dx) + (x < 256 ? 22 : -22), CHEEK.y - 16 + dy, 2.6, 2.6, 'rgba(140,80,50,.6)');
  } },
  { id: 'mustache', label: '口ひげ', draw(ctx, c) {
    for (const s of [-1, 1]) {
      ctx.beginPath(); ctx.moveTo(MOUTH.x, MOUTH.y - 20);
      ctx.quadraticCurveTo(MOUTH.x + s * 26, MOUTH.y - 34, MOUTH.x + s * 40, MOUTH.y - 12);
      ctx.quadraticCurveTo(MOUTH.x + s * 24, MOUTH.y - 18, MOUTH.x, MOUTH.y - 12);
      ctx.fillStyle = c; ctx.fill();
    }
  } },
  { id: 'beard', label: 'あごひげ', under: true, draw(ctx, c) {
    ctx.beginPath(); ctx.moveTo(MOUTH.x - 60, MOUTH.y + 4);
    ctx.quadraticCurveTo(MOUTH.x, MOUTH.y + 40, MOUTH.x + 60, MOUTH.y + 4);
    ctx.quadraticCurveTo(MOUTH.x + 50, MOUTH.y + 120, MOUTH.x, MOUTH.y + 130);
    ctx.quadraticCurveTo(MOUTH.x - 50, MOUTH.y + 120, MOUTH.x - 60, MOUTH.y + 4);
    ctx.fillStyle = c; ctx.globalAlpha = 0.9; ctx.fill(); ctx.globalAlpha = 1;
  } },
  { id: 'stubble', label: 'ぶしょうひげ', under: true, draw(ctx) {
    ctx.fillStyle = 'rgba(70,60,60,.35)';
    for (let i = 0; i < 140; i++) {
      const a = Math.PI * (0.15 + 0.7 * ((i * 37) % 100) / 100);
      const r = 70 + ((i * 53) % 40);
      ctx.fillRect(MOUTH.x + Math.cos(a) * r * 0.9, MOUTH.y - 50 + Math.sin(a) * r, 2.5, 2.5);
    }
  } },
  { id: 'bandage', label: 'ばんそうこう', draw(ctx) {
    ctx.save(); ctx.translate(CHEEK.x[1] - 8, CHEEK.y - 10); ctx.rotate(-0.5);
    ctx.beginPath(); ctx.roundRect(-30, -10, 60, 20, 9); ctx.fillStyle = '#f3c9a0'; ctx.fill();
    ctx.fillStyle = '#e6b088'; ctx.fillRect(-10, -10, 20, 20);
    ctx.restore();
  } },
  { id: 'sweat', label: 'あせ', draw(ctx) {
    ctx.save(); ctx.translate(CHEEK.x[1] + 20, BROW_Y + 10);
    ctx.beginPath(); ctx.moveTo(0, -16); ctx.quadraticCurveTo(14, 8, 0, 12); ctx.quadraticCurveTo(-14, 8, 0, -16);
    ctx.fillStyle = '#9ed8ff'; ctx.fill(); ctx.strokeStyle = '#4ba3dd'; ctx.lineWidth = 2; ctx.stroke();
    ctx.restore();
  } },
  { id: 'scar', label: 'きず', draw(ctx) {
    line(ctx, [[EYE.x[0] - 10, BROW_Y - 10], [EYE.x[0] + 12, EYE.y + 36]], 'rgba(170,80,70,.8)', 4);
    for (let t = 0.2; t < 0.9; t += 0.25) {
      const x = EYE.x[0] - 10 + 22 * t, y = BROW_Y - 10 + (EYE.y + 46 - BROW_Y) * t;
      line(ctx, [[x - 8, y], [x + 8, y - 3]], 'rgba(170,80,70,.8)', 3);
    }
  } },
];

const FACE_DEFAULT = {
  eyes: 'round', brows: 'natural', nose: 'none', mouth: 'smile', cheeks: 'none', extra: 'none',
  eyeColor: '#26211f', browColor: '#3c2a1f', mouthColor: '#8a3b2e', cheekColor: '#f49ab0',
};

const find = (list, id) => list.find((o) => o.id === id) || list[0];

// 顔をひとつの canvas に描く。only を渡すとその部分だけ (アイコン用)。keys を渡すとその部分だけ描く (犬・猫は目・まゆ・ほっぺだけ)
function drawFace(ctx, face, only, keys) {
  const f = { ...FACE_DEFAULT, ...face };
  const want = (k) => (!only || only === k) && (!keys || keys.includes(k));
  ctx.clearRect(0, 0, S, S);

  // ひげなど、口や目より下に描くもの
  const ex = find(EXTRAS, f.extra);
  if (want('extra') && ex.draw && ex.under) ex.draw(ctx, f.browColor);

  if (want('cheeks')) {
    const ch = find(CHEEKS, f.cheeks);
    if (ch.draw) CHEEK.x.forEach((x, i) => { ctx.save(); ctx.translate(x, CHEEK.y); ctx.scale(i ? 1 : -1, 1); ch.draw(ctx, f.cheekColor); ctx.restore(); });
  }
  if (want('eyes')) {
    const e = find(EYES, f.eyes);
    if (e.draw) EYE.x.forEach((x, i) => { const s = i ? 1 : -1; ctx.save(); ctx.translate(x, EYE.y); ctx.scale(s * FEATURE_SCALE, FEATURE_SCALE); e.draw(ctx, s, f.eyeColor); ctx.restore(); });
  }
  if (want('brows')) {
    const b = find(BROWS, f.brows);
    if (b.draw) EYE.x.forEach((x, i) => { ctx.save(); ctx.translate(x, BROW_Y); ctx.scale((i ? 1 : -1) * FEATURE_SCALE, FEATURE_SCALE); b.draw(ctx, f.browColor); ctx.restore(); });
  }
  if (want('nose')) {
    const n = find(NOSES, f.nose);
    if (n.draw) { ctx.save(); ctx.translate(NOSE.x, NOSE.y); n.draw(ctx); ctx.restore(); }
  }
  if (want('mouth')) {
    const m = find(MOUTHS, f.mouth);
    ctx.save(); ctx.translate(MOUTH.x, MOUTH.y); ctx.scale(FEATURE_SCALE, FEATURE_SCALE); m.draw(ctx, f.mouthColor); ctx.restore();
  }
  if (want('extra') && ex.draw && !ex.under) ex.draw(ctx, f.browColor);
}

// アイコン用に、その部分が入っている範囲 (canvas 座標)
const FACE_ICON_REGION = {
  eyes: [56, 100, 400, 160], brows: [56, 68, 400, 80], nose: [196, 252, 120, 80],
  mouth: [176, 300, 160, 100], cheeks: [40, 234, 432, 100], extra: [40, 80, 432, 432],
};

const FACE_SECTIONS = [
  { key: 'eyes',   label: '目',     list: EYES,   color: 'eyeColor',   palette: 'eye' },
  { key: 'brows',  label: 'まゆ',   list: BROWS,  color: 'browColor',  palette: 'hair' },
  { key: 'nose',   label: '鼻',     list: NOSES },
  { key: 'mouth',  label: '口',     list: MOUTHS, color: 'mouthColor', palette: 'lip' },
  { key: 'cheeks', label: 'ほっぺ', list: CHEEKS, color: 'cheekColor', palette: 'cheek' },
  { key: 'extra',  label: 'その他', list: EXTRAS },
];

// ---------------------------------------------------------------- 犬・猫の顔
// 顔の模様は頭のシール (目と同じ canvas) に、目より先に描く。
// 口・ひげは「口のまわり (マズル)」に貼る別のシール (512px 四方) に描く。nose = { y: 鼻の下端, w: 鼻の幅の半分 } (canvas px)
const PET_FACE_DEFAULT = {
  mark: 'none', markColor: '#f8f6f2', petMouth: 'omega', lineColor: '#3a2a25', whiskers: 'none', whiskerColor: '#3a2a25',
};

const MARKS = [
  { id: 'none', label: 'なし', draw: null },
  { id: 'hachi', label: 'ハチワレ', draw(ctx, c) {
    ctx.beginPath(); ctx.moveTo(256, 92);
    ctx.quadraticCurveTo(170, 250, 40, S); ctx.lineTo(S - 40, S);
    ctx.quadraticCurveTo(342, 250, 256, 92);
    ctx.fillStyle = c; ctx.fill();
  } },
  { id: 'blaze', label: '鼻すじ', draw(ctx, c) {
    ctx.beginPath(); ctx.moveTo(232, 0); ctx.lineTo(280, 0);
    ctx.quadraticCurveTo(284, 260, 340, S); ctx.lineTo(172, S);
    ctx.quadraticCurveTo(228, 260, 232, 0);
    ctx.fillStyle = c; ctx.fill();
  } },
  { id: 'patch', label: '片目ぶち', draw(ctx, c) { ellipse(ctx, 375, 172, 96, 84, c); } },
  { id: 'spot', label: 'おでこ', draw(ctx, c) { ellipse(ctx, 256, 56, 74, 52, c); } },
  { id: 'mask', label: 'マスク', draw(ctx, c) {
    ellipse(ctx, 141, 182, 86, 68, c); ellipse(ctx, 371, 182, 86, 68, c);
    ctx.fillStyle = c; ctx.fillRect(141, 130, 230, 90);
  } },
];

const PET_MOUTHS = [
  { id: 'none', label: 'なし', draw: null },
  { id: 'omega', label: 'ω', draw(ctx, x, y, r, c, lw) {
    line(ctx, [[x, y], [x, y + r * 0.5]], c, lw);
    ctx.beginPath(); ctx.arc(x - r, y + r * 0.5, r, 0, Math.PI); ctx.moveTo(x + 2 * r, y + r * 0.5); ctx.arc(x + r, y + r * 0.5, r, 0, Math.PI);
    ctx.strokeStyle = c; ctx.lineWidth = lw; ctx.lineCap = 'round'; ctx.stroke();
  } },
  { id: 'smile', label: 'にっこり', draw(ctx, x, y, r, c, lw) {
    line(ctx, [[x, y], [x, y + r * 1.1]], c, lw);
    curve(ctx, [x - r * 1.7, y + r * 0.5], [x, y + r * 1.9], [x + r * 1.7, y + r * 0.5], c, lw);
  } },
  { id: 'tongue', label: 'ペロッ', draw(ctx, x, y, r, c, lw) {
    ellipse(ctx, x + r * 0.2, y + r * 1.55, r * 0.6, r * 0.8, '#ef7f93', c, lw * 0.6);
    PET_MOUTHS[1].draw(ctx, x, y, r, c, lw);
  } },
  { id: 'open', label: 'あーん', draw(ctx, x, y, r, c, lw) {
    line(ctx, [[x, y], [x, y + r * 0.4]], c, lw);
    ctx.save();
    ctx.beginPath(); ctx.ellipse(x, y + r * 1.3, r * 1.1, r * 0.9, 0, 0, Math.PI * 2);
    ctx.fillStyle = '#6b2a2e'; ctx.fill(); ctx.clip();
    ellipse(ctx, x, y + r * 2.0, r * 0.9, r * 0.6, '#ef7f93');
    ctx.restore();
    ellipse(ctx, x, y + r * 1.3, r * 1.1, r * 0.9, null, c, lw * 0.7);
  } },
  { id: 'flat', label: 'むっ', draw(ctx, x, y, r, c, lw) {
    line(ctx, [[x, y], [x, y + r * 0.6]], c, lw);
    curve(ctx, [x - r * 1.3, y + r * 1.0], [x, y + r * 0.35], [x + r * 1.3, y + r * 1.0], c, lw);
  } },
];

const WHISKERS = [
  { id: 'none', label: 'なし', len: 0 },
  { id: 'short', label: 'みじかい', len: 1.6 },
  { id: 'long', label: 'ながい', len: 3.2 },
];

// 顔の模様 (頭のシールに、目より先に)
function drawPetMarks(ctx, face) {
  const f = { ...PET_FACE_DEFAULT, ...face };
  const m = find(MARKS, f.mark);
  if (m.draw) { ctx.save(); m.draw(ctx, f.markColor); ctx.restore(); }
}

// 口とひげ (マズルのシールに)。only: 'petMouth' か 'whiskers' だけ描く (アイコン用)
function drawPetMuzzle(ctx, face, nose, only) {
  const f = { ...PET_FACE_DEFAULT, ...face };
  const r = nose.w * 0.85, lw = Math.max(8, nose.w * 0.22), x = S / 2, y = nose.y;
  if (!only || only === 'whiskers') {
    const wk = find(WHISKERS, f.whiskers);
    if (wk.len) for (const s of [-1, 1]) for (let i = 0; i < 3; i++) {
      const x0 = x + s * nose.w * 1.4, y0 = y + nose.w * (0.1 + i * 0.45);
      line(ctx, [[x0, y0], [x0 + s * nose.w * wk.len, y0 + nose.w * (i - 1) * 0.5 * wk.len / 2]], f.whiskerColor, Math.max(4, lw * 0.5));
    }
  }
  if (!only || only === 'petMouth') {
    const m = find(PET_MOUTHS, f.petMouth);
    if (m.draw) { ctx.save(); m.draw(ctx, x, y, r, f.lineColor, lw); ctx.restore(); }
  }
}

// エディタのアイコン用: 鼻を描いてから口・ひげ
function petMuzzleIcon(only) {
  return (ctx, face) => {
    ctx.clearRect(0, 0, S, S);
    ellipse(ctx, S / 2, 170, 60, 42, '#2b2220');
    drawPetMuzzle(ctx, face, { y: 205, w: 60 }, only);
  };
}

const byKey = (k) => FACE_SECTIONS.find((s) => s.key === k);
const PET_FACE_SECTIONS = [
  byKey('eyes'),
  byKey('brows'),
  { key: 'mark', label: '顔の模様', list: MARKS, color: 'markColor', palette: 'fur', region: [0, 0, S, S],
    draw: (ctx, face) => { ctx.clearRect(0, 0, S, S); drawPetMarks(ctx, face); } },
  { key: 'petMouth', label: '口', list: PET_MOUTHS, color: 'lineColor', palette: 'nose', region: [96, 120, 320, 220],
    skinKey: 'Pet_Muzzle', draw: petMuzzleIcon('petMouth') },
  { key: 'whiskers', label: 'ひげ', list: WHISKERS, color: 'whiskerColor', palette: 'fur', region: [0, 110, S, 220],
    skinKey: 'Pet_Muzzle', draw: petMuzzleIcon('whiskers') },
  byKey('cheeks'),
];

// ---------------------------------------------------------------- 柄
// どれも 256px 四方で、上下左右につなげても継ぎ目が出ないように描く
const P = 256;
// 端をまたぐ図形は、となりのタイルの位置にも描いて継ぎ目を消す
function wrap(fn) { for (const dx of [-P, 0, P]) for (const dy of [-P, 0, P]) fn(dx, dy); }

const PATTERNS = [
  { id: 'plain', label: '無地', draw: null },
  { id: 'stripe', label: 'ストライプ', draw(ctx, c1, c2) {
    ctx.fillStyle = c2; for (let x = 0; x < P; x += 64) ctx.fillRect(x, 0, 22, P);
  } },
  { id: 'border', label: 'ボーダー', draw(ctx, c1, c2) {
    ctx.fillStyle = c2; for (let y = 0; y < P; y += 64) ctx.fillRect(0, y, P, 26);
  } },
  { id: 'pinstripe', label: 'ピンストライプ', draw(ctx, c1, c2) {
    ctx.fillStyle = c2; for (let x = 0; x < P; x += 32) ctx.fillRect(x, 0, 4, P);
  } },
  { id: 'dots', label: '水玉', draw(ctx, c1, c2) {
    for (let y = 0; y < P; y += 64) for (let x = 0; x < P; x += 64) {
      wrap((dx, dy) => { ellipse(ctx, x + dx + 16, y + dy + 16, 13, 13, c2); ellipse(ctx, x + dx + 48, y + dy + 48, 13, 13, c2); });
    }
  } },
  { id: 'gingham', label: 'チェック', draw(ctx, c1, c2) {
    ctx.fillStyle = c2; ctx.globalAlpha = 0.55;
    for (let x = 0; x < P; x += 64) ctx.fillRect(x, 0, 32, P);
    for (let y = 0; y < P; y += 64) ctx.fillRect(0, y, P, 32);
    ctx.globalAlpha = 1;
  } },
  { id: 'tartan', label: 'タータン', draw(ctx, c1, c2) {
    ctx.globalAlpha = 0.45; ctx.fillStyle = c2;
    for (const o of [0, 128]) { ctx.fillRect(o + 20, 0, 48, P); ctx.fillRect(0, o + 20, P, 48); }
    ctx.globalAlpha = 0.9; ctx.fillStyle = '#ffffff';
    for (const o of [0, 128]) { ctx.fillRect(o + 98, 0, 4, P); ctx.fillRect(0, o + 98, P, 4); }
    ctx.fillStyle = '#111'; ctx.globalAlpha = 0.5;
    for (const o of [0, 128]) { ctx.fillRect(o + 42, 0, 4, P); ctx.fillRect(0, o + 42, P, 4); }
    ctx.globalAlpha = 1;
  } },
  { id: 'ichimatsu', label: '市松', draw(ctx, c1, c2) {
    ctx.fillStyle = c2;
    for (let y = 0; y < P; y += 64) for (let x = 0; x < P; x += 64) if (((x + y) / 64) % 2 === 0) ctx.fillRect(x, y, 64, 64);
  } },
  { id: 'seigaiha', label: '青海波', draw(ctx, c1, c2) {
    const R = 64;
    for (let row = -2; row * (R / 2) < P + R; row++) {
      const y = row * (R / 2);
      const off = (row & 1) ? R : 0;
      for (let x = -2 * R + off; x < P + 2 * R; x += 2 * R) {
        for (let k = 0; k < 4; k++) {
          ctx.beginPath(); ctx.arc(x, y, R * (1 - k * 0.22), Math.PI, 0);
          ctx.fillStyle = k % 2 ? c1 : c2; ctx.fill();
        }
      }
    }
  } },
  { id: 'uroko', label: 'うろこ', draw(ctx, c1, c2) {
    ctx.fillStyle = c2;
    for (let y = 0; y < P; y += 64) for (let x = 0; x < P; x += 64) {
      const ox = ((y / 64) % 2) * 32;
      wrap((dx, dy) => {
        ctx.beginPath(); ctx.moveTo(x + ox + dx, y + 64 + dy); ctx.lineTo(x + ox + 32 + dx, y + dy); ctx.lineTo(x + ox + 64 + dx, y + 64 + dy); ctx.fill();
      });
    }
  } },
  { id: 'yagasuri', label: '矢がすり', draw(ctx, c1, c2) {
    ctx.fillStyle = c2;
    for (let x = 0; x < P; x += 64) {
      if ((x / 64) % 2) continue;
      for (let y = -64; y < P + 64; y += 64) {
        ctx.beginPath();
        ctx.moveTo(x, y); ctx.lineTo(x + 32, y + 24); ctx.lineTo(x + 64, y);
        ctx.lineTo(x + 64, y + 40); ctx.lineTo(x + 32, y + 64); ctx.lineTo(x, y + 40);
        ctx.fill();
      }
    }
  } },
  { id: 'asanoha', label: '麻の葉', draw(ctx, c1, c2) {
    // 正三角形の格子に線を引いて麻の葉に (横 64 / 縦 64 の近似で継ぎ目なし)
    ctx.strokeStyle = c2; ctx.lineWidth = 3; ctx.lineCap = 'round';
    const w = 64, h = 64;
    for (let j = -1; j <= P / h; j++) for (let i = -1; i <= P / w; i++) {
      const x = i * w + ((j & 1) ? w / 2 : 0), y = j * h;
      const pts = [[x, y], [x + w, y], [x + w / 2, y + h]];
      const cx = x + w / 2, cy = y + h / 3;
      ctx.beginPath();
      for (const [px, py] of pts) { ctx.moveTo(cx, cy); ctx.lineTo(px, py); }
      ctx.moveTo(pts[0][0], pts[0][1]); ctx.lineTo(pts[1][0], pts[1][1]); ctx.lineTo(pts[2][0], pts[2][1]); ctx.closePath();
      ctx.stroke();
      const qx = x + w, qy = y, rx = x + w / 2, ry = y + h, sx = x + 1.5 * w, sy = y + h;
      const ux = (qx + rx + sx) / 3, uy = (qy + ry + sy) / 3;
      ctx.beginPath();
      for (const [px, py] of [[qx, qy], [rx, ry], [sx, sy]]) { ctx.moveTo(ux, uy); ctx.lineTo(px, py); }
      ctx.stroke();
    }
  } },
  { id: 'sakura', label: '桜', draw(ctx, c1, c2) {
    const flower = (x, y, r) => {
      for (let k = 0; k < 5; k++) {
        ctx.save(); ctx.translate(x, y); ctx.rotate((k * Math.PI * 2) / 5);
        ctx.beginPath(); ctx.moveTo(0, 0);
        ctx.bezierCurveTo(-r * 0.7, -r * 0.5, -r * 0.5, -r * 1.1, -r * 0.12, -r);
        ctx.lineTo(0, -r * 0.82); ctx.lineTo(r * 0.12, -r);
        ctx.bezierCurveTo(r * 0.5, -r * 1.1, r * 0.7, -r * 0.5, 0, 0);
        ctx.fillStyle = c2; ctx.fill(); ctx.restore();
      }
      ellipse(ctx, x, y, r * 0.15, r * 0.15, '#f5d05a');
    };
    wrap((dx, dy) => { flower(70 + dx, 70 + dy, 52); flower(190 + dx, 185 + dy, 44); flower(205 + dx, 50 + dy, 24); flower(60 + dx, 205 + dy, 26); });
  } },
  { id: 'star', label: '星 (五稜郭)', draw(ctx, c1, c2) {
    wrap((dx, dy) => { star(ctx, 64 + dx, 64 + dy, 34, 16, c2); star(ctx, 192 + dx, 192 + dy, 34, 16, c2); star(ctx, 190 + dx, 60 + dy, 12, 5, c2); star(ctx, 60 + dx, 196 + dy, 12, 5, c2); });
  } },
  { id: 'ika', label: 'イカ', draw(ctx, c1, c2) {
    const squid = (x, y, rot) => {
      ctx.save(); ctx.translate(x, y); ctx.rotate(rot); ctx.fillStyle = c2; ctx.strokeStyle = c2;
      ctx.beginPath(); ctx.moveTo(0, -42); ctx.lineTo(-20, -18); ctx.lineTo(20, -18); ctx.fill();
      ctx.beginPath(); ctx.ellipse(0, 0, 13, 28, 0, 0, Math.PI * 2); ctx.fill();
      ctx.lineWidth = 3.5; ctx.lineCap = 'round';
      for (let k = -2; k <= 2; k++) { ctx.beginPath(); ctx.moveTo(k * 4, 24); ctx.quadraticCurveTo(k * 9, 40, k * 6, 50); ctx.stroke(); }
      ellipse(ctx, -5, 10, 3, 3, c1); ellipse(ctx, 5, 10, 3, 3, c1);
      ctx.restore();
    };
    wrap((dx, dy) => { squid(64 + dx, 64 + dy, -0.3); squid(192 + dx, 190 + dy, 0.35); });
  } },
  { id: 'wave', label: 'なみ', draw(ctx, c1, c2) {
    ctx.strokeStyle = c2; ctx.lineWidth = 9; ctx.lineCap = 'round';
    for (let y = 16; y < P + 32; y += 32) {
      ctx.beginPath();
      for (let x = 0; x <= P; x += 4) ctx.lineTo(x, y + Math.sin((x / P) * Math.PI * 8) * 8);
      ctx.stroke();
    }
  } },
  { id: 'heart', label: 'ハート', draw(ctx, c1, c2) {
    const heart = (x, y, r) => {
      ctx.beginPath(); ctx.moveTo(x, y + r);
      ctx.bezierCurveTo(x - r * 1.5, y, x - r * 0.8, y - r * 1.2, x, y - r * 0.45);
      ctx.bezierCurveTo(x + r * 0.8, y - r * 1.2, x + r * 1.5, y, x, y + r);
      ctx.fillStyle = c2; ctx.fill();
    };
    wrap((dx, dy) => { heart(64 + dx, 64 + dy, 22); heart(192 + dx, 192 + dy, 22); });
  } },
  { id: 'camo', label: '迷彩', draw(ctx, c1, c2) {
    const blobs = [[40, 50, 46, 26, 0.4], [170, 30, 40, 22, -0.3], [120, 140, 56, 30, 0.2], [220, 200, 44, 28, 0.8], [40, 210, 40, 24, -0.6], [200, 110, 26, 16, 0.1]];
    wrap((dx, dy) => blobs.forEach(([x, y, rx, ry, r], i) => {
      ctx.beginPath(); ctx.ellipse(x + dx, y + dy, rx, ry, r, 0, Math.PI * 2);
      ctx.fillStyle = i % 2 ? c2 : lighten(c2, 0.35); ctx.fill();
    }));
  } },
  // 犬・猫の毛向け (服にも使える)
  { id: 'tabby', label: 'トラ縞', draw(ctx, c1, c2) {
    ctx.fillStyle = c2;
    [[0, 26], [64, 18], [128, 24], [192, 16]].forEach(([x0, w]) => wrap((dx) => {
      ctx.beginPath();
      for (let y = 0; y <= P; y += 8) ctx.lineTo(x0 + dx + Math.sin((y / P) * Math.PI * 4) * 9, y);
      for (let y = P; y >= 0; y -= 8) ctx.lineTo(x0 + dx + w + Math.sin((y / P) * Math.PI * 4 + 0.8) * 9, y);
      ctx.closePath(); ctx.fill();
    }));
  } },
  { id: 'patches', label: 'ぶち', draw(ctx, c1, c2) {
    // 丸をいくつか重ねた、形のそろわない大きなぶち
    const blobs = [[60, 70, [[0, 0, 42], [30, 18, 30], [-26, 22, 26]]], [190, 170, [[0, 0, 46], [-34, -16, 30], [20, 34, 28]]], [200, 40, [[0, 0, 20], [16, 10, 16]]]];
    blobs.forEach(([bx, by, parts]) => wrap((dx, dy) => parts.forEach(([ox, oy, r]) => ellipse(ctx, bx + ox + dx, by + oy + dy, r, r * 0.85, c2))));
  } },
];

const PATTERN_DEFAULT = { type: 'plain', color2: '#1f2937', scale: 1 };

function drawPattern(ctx, id, c1, c2) {
  ctx.fillStyle = c1;
  ctx.fillRect(0, 0, P, P);
  const p = PATTERNS.find((x) => x.id === id);
  if (p?.draw) { ctx.save(); p.draw(ctx, c1, c2); ctx.restore(); }
}

// ---------------------------------------------------------------- 体型
const BODY_SLIDERS = [
  { key: 'height',    label: '身長',       min: 0.8,  max: 1.2,  step: 0.01 },
  { key: 'head',      label: '頭の大きさ', min: 0.8,  max: 1.3,  step: 0.01 },
  { key: 'width',     label: '体格',       min: 0.8,  max: 1.3,  step: 0.01 },
  { key: 'legs',      label: '脚の長さ',   min: 0.75, max: 1.35, step: 0.01 },
  { key: 'arms',      label: '腕の長さ',   min: 0.8,  max: 1.25, step: 0.01 },
  { key: 'shoulders', label: '肩幅',       min: 0.85, max: 1.3,  step: 0.01 },
  { key: 'belly',     label: 'おなか',     min: 0.85, max: 1.45, step: 0.01 },
  { key: 'neck',      label: '首の長さ',   min: 0.5,  max: 2.5,  step: 0.05 },
];
const BODY_DEFAULT = Object.fromEntries(BODY_SLIDERS.map((s) => [s.key, 1]));

return {
  PALETTES, FACE_SECTIONS, FACE_DEFAULT, FACE_ICON_REGION, FACE_SIZE: S, drawFace,
  PET_FACE_SECTIONS, PET_FACE_DEFAULT, drawPetMarks, drawPetMuzzle,
  PATTERNS, PATTERN_DEFAULT, PATTERN_SIZE: P, drawPattern,
  BODY_SLIDERS, BODY_DEFAULT,
};
})();
