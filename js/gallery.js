function loadDesigns() {
  return JSON.parse(localStorage.getItem('hakodate_designs') || '[]');
}

function saveDesigns(list) {
  localStorage.setItem('hakodate_designs', JSON.stringify(list));
}

function formatDate(iso) {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function renderGallery() {
  const grid = document.getElementById('gallery-grid');
  const designs = loadDesigns();

  if (!designs.length) {
    grid.innerHTML = '<p class="gallery-empty">まだ作品がありません。<br>デザインエディタで最初の作品を作ってみましょう！</p>';
    return;
  }

  grid.innerHTML = '';
  designs.forEach((d) => {
    const card = document.createElement('div');
    card.className = 'gallery-card';

    const thumb = document.createElement('div');
    thumb.className = 'gallery-thumb';
    if (d.thumbnail) thumb.style.backgroundImage = `url(${d.thumbnail})`;

    const info = document.createElement('div');
    info.className = 'gallery-info';

    const name = document.createElement('p');
    name.className = 'gallery-name';
    name.textContent = d.name;

    const meta = document.createElement('p');
    meta.className = 'gallery-meta';
    meta.textContent = `${d.modelIcon || ''} ${d.modelLabel || d.baseModel}  ·  ${formatDate(d.createdAt)}`;

    const likeBtn = document.createElement('button');
    likeBtn.className = 'like-btn' + (d.liked ? ' liked' : '');
    likeBtn.innerHTML = `♥ <span class="like-count">${d.likes}</span>`;
    likeBtn.addEventListener('click', () => toggleLike(d.id, likeBtn));

    info.append(name, meta, likeBtn);
    card.append(thumb, info);
    grid.appendChild(card);
  });
}

function toggleLike(id, btn) {
  const list = loadDesigns();
  const d = list.find((x) => x.id === id);
  if (!d) return;
  d.liked = !d.liked;
  d.likes = Math.max(0, d.likes + (d.liked ? 1 : -1));
  saveDesigns(list);
  btn.className = 'like-btn' + (d.liked ? ' liked' : '');
  btn.querySelector('.like-count').textContent = d.likes;
}

document.addEventListener('DOMContentLoaded', renderGallery);
