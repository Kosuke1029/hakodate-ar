// 線路検出用の Web Worker。重い画像処理をメインスレッドから外して、表示をなめらかにする
importScripts('vendor/opencv.js');

const ready = (async () => {
  if (self.cv instanceof Promise) self.cv = await self.cv;
  await new Promise((r) => { const w = () => (self.cv && self.cv.Mat ? r() : setTimeout(w, 20)); w(); });
})();

// ---- 検出: 段ボール(ベージュ)の中にある、描かれた線路(細い黒線)を探す ----
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

// 1フレームを解析して、線路の四隅と電柱の候補を返す
function analyze(imageData, opt) {
  const keep = [];
  const M = () => { const m = new cv.Mat(); keep.push(m); return m; };
  const out = { quad: null, poles: [], mask: null };
  try {
    const rgba = cv.matFromImageData(imageData); keep.push(rgba);
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
    const { contour: card, area: cardArea } = largestContour(beige);
    if (!card || cardArea < pw * ph * 0.02) { card && card.delete(); return out; }
    const hull = M(); cv.convexHull(card, hull, false, true); card.delete();
    const cardMask = cv.Mat.zeros(ph, pw, cv.CV_8U); keep.push(cardMask);
    const hv = new cv.MatVector(); hv.push_back(hull);
    cv.drawContours(cardMask, hv, 0, new cv.Scalar(255), -1); hv.delete();
    cv.erode(cardMask, cardMask, mats.k7);
    const meanV = cv.mean(V, beige)[0];

    // 2) 太い黒 (電柱・ケーブルカバーなど)。電柱の候補探しと、細い線の検出から外すのに使う
    const thickAll = M();
    cv.threshold(V, thickAll, meanV * 0.57, 255, cv.THRESH_BINARY_INV);
    cv.morphologyEx(thickAll, thickAll, cv.MORPH_OPEN, mats.k7);
    if (opt.poles) out.poles = findPoles(thickAll, cardMask);

    // 3) 細い黒線: ブラックハット(周りより暗い細い所)で、明るさの変化に強く検出
    const thin = M();
    cv.morphologyEx(V, thin, cv.MORPH_BLACKHAT, mats.k11);
    cv.threshold(thin, thin, opt.lineT, 255, cv.THRESH_BINARY);
    cv.bitwise_and(thin, cardMask, thin);
    // 太い黒の周りは除外
    const thick = M();
    cv.bitwise_and(thickAll, cardMask, thick);
    cv.dilate(thick, thick, mats.k15);
    cv.subtract(thin, thick, thin);
    if (opt.debug) out.mask = new Uint8Array(thin.data);

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


onmessage = async (e) => {
  await ready;
  const { type } = e.data;
  if (type === 'init') {
    pw = e.data.width; ph = e.data.height;
    initMats();
    postMessage({ type: 'ready' });
    return;
  }
  if (type === 'frame') {
    const { id, buffer, opt } = e.data;
    let res = { quad: null, poles: [], mask: null };
    try {
      res = analyze(new ImageData(new Uint8ClampedArray(buffer), pw, ph), opt);
    } catch (err) {
      console.error(err);
    }
    const transfer = res.mask ? [res.mask.buffer] : [];
    postMessage({ type: 'result', id, quad: res.quad, poles: res.poles, mask: res.mask }, transfer);
  }
};
