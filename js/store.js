// 作品の保存場所 (この端末のブラウザの localStorage)。普通の script として読む → window.DesignStore
//   作品:     hakodate_designs  [{ id, name, baseModel, state, thumbnail, owner, walk, createdAt, updatedAt, ... }]
//   作りかけ: hakodate_draft    { baseModel, states, name, editingId, savedAt }
//   この端末: hakodate_uid      (自分の作品の目印。owner が無い古い作品は、この端末で作ったもの)
(() => {
  const KEY = 'hakodate_designs', DRAFT = 'hakodate_draft', UID = 'hakodate_uid';

  const read = (k, def) => {
    try { return JSON.parse(localStorage.getItem(k)) ?? def; } catch { return def; }
  };

  function uid() {
    let u = localStorage.getItem(UID);
    if (!u) {
      u = crypto.randomUUID?.() || Date.now().toString(36) + Math.random().toString(36).slice(2);
      try { localStorage.setItem(UID, u); } catch {}
    }
    return u;
  }

  const all = () => read(KEY, []);
  // 容量がいっぱいの時は例外 (QuotaExceededError) を投げる
  const saveAll = (list) => localStorage.setItem(KEY, JSON.stringify(list));
  const isMine = (d) => !d.owner || d.owner === uid();
  const time = (d) => Date.parse(d.updatedAt || d.createdAt) || 0;
  // 自分の作品 (新しく作った・直した順)
  const mine = () => all().filter(isMine).sort((a, b) => time(b) - time(a));
  const get = (id) => all().find((d) => d.id === id) || null;

  // 新しい作品なら先頭に追加、同じ id があれば上書き
  function put(rec) {
    const list = all();
    const i = list.findIndex((d) => d.id === rec.id);
    if (i >= 0) list[i] = { ...list[i], ...rec };
    else list.unshift({ owner: uid(), walk: true, likes: 0, ...rec });
    saveAll(list);
    persist();
    return rec.id;
  }
  function update(id, patch) {
    const list = all();
    const d = list.find((x) => x.id === id);
    if (!d) return;
    Object.assign(d, patch);
    saveAll(list);
  }
  const remove = (id) => saveAll(all().filter((d) => d.id !== id));

  const getDraft = () => read(DRAFT, null);
  function setDraft(d) {
    try { localStorage.setItem(DRAFT, JSON.stringify({ ...d, savedAt: new Date().toISOString() })); return true; } catch { return false; }
  }
  const clearDraft = () => localStorage.removeItem(DRAFT);

  // ブラウザが容量不足の時に勝手に消さないようにお願いする (対応していないブラウザでは何もしない)
  function persist() {
    try { navigator.storage?.persist?.().catch(() => {}); } catch {}
  }

  // 一覧用の小さい画像 (保存できる数を増やすため)
  function thumbnail(src, max = 360) {
    const s = Math.min(1, max / Math.max(src.width, src.height));
    const c = document.createElement('canvas');
    c.width = Math.round(src.width * s);
    c.height = Math.round(src.height * s);
    c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.8);
  }

  const isQuota = (e) => e && (e.name === 'QuotaExceededError' || e.code === 22 || e.code === 1014);

  window.DesignStore = { uid, all, mine, get, put, update, remove, isMine, getDraft, setDraft, clearDraft, persist, thumbnail, isQuota };
})();
