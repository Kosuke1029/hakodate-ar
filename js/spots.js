// 大門のスポット。ここを書きかえるとスポットを足したり直したりできます。
//   lat/lng  : 位置 (OpenStreetMap で確認。approx: true は地図から見た目安なので、現地で直してください)
//   radius   : この距離 (m) 以内に入ると「ARで見る」が押せる
//   acts     : このスポットで「おまかせ」の作品がする動きと、その割合
//   samples  : 作品が少ないときに足す見本のキャラ (baseModel と動き)
window.SPOTS = [
  {
    id: 'ekimae',
    name: '函館駅前',
    icon: '🚉',
    theme: '旅のはじまり',
    desc: '駅から出てきた人たちが、町へ歩きだす。',
    lat: 41.77335, lng: 140.72670, radius: 60,
    acts: { human: [['walk', 0.75], ['dance', 0.25]], pet: [['walk', 0.8], ['play', 0.2]] },
    samples: [['man', 'walk'], ['woman', 'walk'], ['dog', 'walk'], ['man', 'dance']],
  },
  {
    id: 'asaichi',
    name: '函館朝市',
    icon: '🐟',
    theme: '朝市のねこと犬',
    desc: '市場のまわりで、ねこがおひるね・犬がはしゃぐ。',
    lat: 41.77224, lng: 140.72482, radius: 60,
    acts: { human: [['walk', 1]], pet: [['nap', 0.4], ['play', 0.35], ['walk', 0.25]] },
    samples: [['cat', 'nap'], ['dog', 'play'], ['cat', 'walk'], ['woman', 'walk']],
  },
  {
    id: 'greenplaza',
    name: 'グリーンプラザ',
    icon: '🌳',
    theme: '広場のダンス',
    desc: '広い歩行者の広場で、ダンスが始まる。',
    lat: 41.77300, lng: 140.72840, radius: 55, approx: true,
    acts: { human: [['dance', 0.6], ['walk', 0.4]], pet: [['play', 0.5], ['walk', 0.5]] },
    samples: [['woman', 'dance'], ['man', 'dance'], ['dog', 'play'], ['woman', 'walk']],
  },
  {
    id: 'yokocho',
    name: '大門横丁',
    icon: '🏮',
    theme: '路上ライブ',
    desc: '屋台の横丁で、ギターの弾き語り。',
    lat: 41.77239, lng: 140.73000, radius: 55,
    acts: { human: [['guitar', 0.5], ['walk', 0.3], ['dance', 0.2]], pet: [['nap', 0.5], ['walk', 0.5]] },
    samples: [['man', 'guitar'], ['woman', 'walk'], ['cat', 'nap'], ['woman', 'dance']],
  },
  {
    id: 'matsukaze',
    name: '松風町',
    icon: '🚋',
    theme: '電車通りの散歩',
    desc: '市電の通りを、人も犬もゆっくり散歩。',
    lat: 41.77285, lng: 140.73330, radius: 60, approx: true,
    acts: { human: [['walk', 0.7], ['guitar', 0.3]], pet: [['walk', 0.7], ['nap', 0.3]] },
    samples: [['woman', 'walk'], ['dog', 'walk'], ['man', 'guitar'], ['cat', 'walk']],
  },
];

window.SPOT_MIN = 4;   // スポットでは最低この数のキャラを出す (足りない分は見本)

// 2点間の距離 (m)
window.spotDistance = (lat1, lng1, lat2, lng2) => {
  const R = 6371000, rad = Math.PI / 180;
  const a = Math.sin((lat2 - lat1) * rad / 2) ** 2
    + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin((lng2 - lng1) * rad / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
};
