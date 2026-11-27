// 大門をめぐる: スポットの地図と現在地。スポットに近づくと「ARで見る」が押せる
const SPOTS = window.SPOTS;
const dist = window.spotDistance;
const statusEl = document.getElementById('status');
const listEl = document.getElementById('spots');
let me = null;   // { lat, lng, acc }

// ---------------------------------------------------------------- 地図
const map = L.map('map', { zoomControl: false, attributionControl: true });
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);
const bounds = L.latLngBounds(SPOTS.map((s) => [s.lat, s.lng]));
map.fitBounds(bounds, { padding: [30, 30] });

const markers = {};
for (const s of SPOTS) {
  L.circle([s.lat, s.lng], { radius: s.radius, color: '#f59e0b', weight: 1, fillOpacity: 0.12 }).addTo(map);
  markers[s.id] = L.marker([s.lat, s.lng], {
    icon: L.divIcon({ className: '', html: `<div class="spot-pin">${s.icon}</div>`, iconSize: [34, 34], iconAnchor: [17, 17] }),
    title: s.name,
  }).addTo(map).on('click', () => document.getElementById('spot-' + s.id)?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
}
let meMarker = null, meCircle = null;

// ---------------------------------------------------------------- リスト
const fmt = (m) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`);

function render() {
  const rows = SPOTS.map((s) => ({ s, d: me ? dist(me.lat, me.lng, s.lat, s.lng) : null }));
  if (me) rows.sort((a, b) => a.d - b.d);
  listEl.innerHTML = '';
  for (const { s, d } of rows) {
    // GPS の誤差 (最大 40 m) ぶんは甘めに見る
    const near = d != null && d <= s.radius + Math.min(me.acc, 40);
    const li = document.createElement('li');
    li.id = 'spot-' + s.id;
    li.className = 'spot' + (near ? ' near' : '');
    li.innerHTML = `
      <div class="spot-icon">${s.icon}</div>
      <div class="spot-body">
        <p class="spot-name"></p>
        <p class="spot-theme"></p>
        <p class="spot-desc"></p>
        <p class="spot-dist"></p>
      </div>
      <div class="spot-go">
        <a class="spot-ar${near ? '' : ' off'}" href="walk.html?spot=${s.id}">ARで見る</a>
        ${near ? '' : `<a class="spot-try" href="walk.html?spot=${s.id}&try=1">ここで試す</a>`}
      </div>`;
    li.querySelector('.spot-name').textContent = s.name;
    li.querySelector('.spot-theme').textContent = s.theme;
    li.querySelector('.spot-desc').textContent = s.desc;
    li.querySelector('.spot-dist').textContent = d == null ? '' : near ? '📍 いまここにいます！' : `ここから ${fmt(d)}`;
    li.querySelector('.spot-icon').addEventListener('click', () => map.setView([s.lat, s.lng], 18));
    listEl.appendChild(li);
  }
}

// ---------------------------------------------------------------- 現在地
function setStatus(text, warn) {
  statusEl.textContent = text;
  statusEl.classList.toggle('warn', !!warn);
}

let firstFix = true;
function onPos(p) {
  me = { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy };
  const ll = [me.lat, me.lng];
  if (!meMarker) {
    meMarker = L.marker(ll, { icon: L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [16, 16], iconAnchor: [8, 8] }), zIndexOffset: 1000 }).addTo(map);
    meCircle = L.circle(ll, { radius: me.acc, color: '#2563eb', weight: 1, fillOpacity: 0.08 }).addTo(map);
  } else {
    meMarker.setLatLng(ll);
    meCircle.setLatLng(ll).setRadius(me.acc);
  }
  const nearest = Math.min(...SPOTS.map((s) => dist(me.lat, me.lng, s.lat, s.lng)));
  if (firstFix) {
    firstFix = false;
    // 大門の近くなら自分とスポットが入るように、遠ければスポットだけ
    if (nearest < 1500) map.fitBounds(bounds.extend(ll), { padding: [30, 30] });
  }
  setStatus(nearest < 1500
    ? `現在地がわかりました (誤差 約 ${Math.round(me.acc)} m)。スポットに近づくと「ARで見る」が押せます`
    : `大門から ${fmt(nearest)} はなれています。「ここで試す」で、その場でスポットのARを試せます`);
  render();
}
function onErr(e) {
  setStatus(e.code === 1
    ? '位置情報がオフです。設定で許可すると、近くのスポットがわかります。「ここで試す」はそのまま使えます'
    : '現在地がわかりませんでした。「ここで試す」はそのまま使えます', true);
}

render();
if ('geolocation' in navigator) {
  navigator.geolocation.watchPosition(onPos, onErr, { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
} else {
  onErr({ code: 0 });
}
