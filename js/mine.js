// じぶんの作品: この端末で作った作品の一覧。直す・ARに出すかどうか・削除
const DS = window.DesignStore;
const MAX_AR = 6;   // walk.js の MAX_CHARS と同じ
const savedId = new URLSearchParams(location.search).get('saved');
// ARでの動き (walk.js の AUTO_ACTS と同じ名前)
const ACTS = {
  human: [['auto', 'おまかせ'], ['walk', '散歩'], ['guitar', 'ギター'], ['dance', 'ダンス']],
  pet: [['auto', 'おまかせ'], ['walk', '散歩'], ['play', 'はしゃぐ'], ['nap', 'おひるね']],
};
const isPet = (d) => d.baseModel === 'dog' || d.baseModel === 'cat';

function formatDate(iso) {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

// 作りかけがあれば、続きから作れるように
function renderDraft() {
  const slot = document.getElementById('draft-slot');
  slot.innerHTML = '';
  const d = DS.getDraft();
  if (!d) return;
  const box = el('a', 'mine-draft');
  box.href = d.editingId ? `editor.html?id=${d.editingId}` : 'editor.html';
  box.append(el('span', 'mine-draft-title', '✏️ 作りかけの作品があります'),
    el('span', 'mine-draft-sub', `${d.name ? `「${d.name}」 · ` : ''}${d.savedAt ? formatDate(d.savedAt) : ''} — タップして続きを作る`));
  slot.appendChild(box);
}

function render() {
  const grid = document.getElementById('mine-grid');
  const hint = document.getElementById('mine-hint');
  const list = DS.mine();
  renderDraft();

  if (!list.length) {
    hint.textContent = '';
    grid.innerHTML = '<p class="gallery-empty">まだ作品がありません。<br>「＋ 作る」から作ってみましょう！</p>';
    return;
  }
  const on = list.filter((d) => d.walk !== false).length;
  hint.textContent = on
    ? `「ARに出す」の作品がカメラの中を歩きます (${on} 体${on > MAX_AR ? `・新しい ${MAX_AR} 体まで` : ''})`
    : '「ARに出す」をオンにした作品がカメラの中を歩きます';

  grid.innerHTML = '';
  for (const d of list) {
    const card = el('div', 'gallery-card' + (d.id === savedId ? ' just-saved' : ''));
    const thumb = el('a', 'gallery-thumb');
    thumb.href = `editor.html?id=${d.id}`;
    thumb.setAttribute('aria-label', `${d.name} を直す`);
    if (d.thumbnail) thumb.style.backgroundImage = `url(${d.thumbnail})`;

    const info = el('div', 'gallery-info');
    info.append(
      el('p', 'gallery-name', d.name),
      el('p', 'gallery-meta', `${d.modelIcon || ''} ${d.modelLabel || d.baseModel}  ·  ${formatDate(d.updatedAt || d.createdAt)}`),
    );

    // ARに出す (オン・オフ)
    const walk = el('button', 'mine-walk' + (d.walk !== false ? ' on' : ''));
    walk.type = 'button';
    walk.setAttribute('aria-pressed', String(d.walk !== false));
    walk.textContent = d.walk !== false ? '✓ ARに出す' : 'ARに出さない';
    walk.addEventListener('click', () => { DS.update(d.id, { walk: d.walk === false }); render(); });

    // ARでの動き
    const actRow = el('label', 'mine-act');
    actRow.append(el('span', null, 'ARで'));
    const sel = el('select');
    for (const [id, label] of ACTS[isPet(d) ? 'pet' : 'human']) {
      const o = el('option', null, label);
      o.value = id;
      o.selected = (d.act || 'auto') === id;
      sel.appendChild(o);
    }
    sel.addEventListener('change', () => DS.update(d.id, { act: sel.value }));
    actRow.appendChild(sel);

    const actions = el('div', 'mine-actions');
    const edit = el('a', 'mine-btn', '直す');
    edit.href = `editor.html?id=${d.id}`;
    const ar = el('a', 'mine-btn', 'ARで見る');
    ar.href = `walk.html?id=${d.id}`;
    const del = el('button', 'mine-btn mine-del', '削除');
    del.type = 'button';
    del.addEventListener('click', () => {
      if (!confirm(`「${d.name}」を削除しますか？ (元に戻せません)`)) return;
      DS.remove(d.id);
      render();
    });
    actions.append(edit, ar, del);

    info.append(walk, actRow, actions);
    card.append(thumb, info);
    grid.appendChild(card);
  }
  if (savedId) document.querySelector('.just-saved')?.scrollIntoView({ block: 'center' });
}

document.addEventListener('DOMContentLoaded', render);
