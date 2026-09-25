(() => {
  'use strict';

  const canvas = document.querySelector('#game');
  const ctx = canvas.getContext('2d');
  const TILE = 16;
  const SAVE_KEY = 'fruit-trail-save-v2';
  const CAMP = { x: 8, y: 8, radius: 20 };
  const fruitKinds = ['apple', 'orange', 'blueberry'];
  const directions = ['up', 'down', 'left', 'right'];

  function validSave(save) {
    return [2, 3].includes(save?.version) && Number.isInteger(save.seed) && save.seed >= 0 && save.seed <= 0xffffffff &&
      Number.isFinite(save.player?.x) && Number.isFinite(save.player?.y) && directions.includes(save.player?.direction) &&
      fruitKinds.every(kind => Number.isInteger(save.fruitCounts?.[kind]) && save.fruitCounts[kind] >= 0) &&
      Array.isArray(save.collected) && save.collected.every(key => /^-?\d+,-?\d+$/.test(key)) &&
      (save.version === 2 || Number.isInteger(save.ordersCompleted) && save.ordersCompleted >= 0);
  }

  function loadProgress() {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return null;
      const save = JSON.parse(raw);
      if (validSave(save)) return save;
      localStorage.removeItem(SAVE_KEY);
    } catch (error) {
      console.warn('Could not load saved progress.', error);
    }
    return null;
  }

  const saved = loadProgress();
  const seed = saved?.seed ?? (Math.random() * 0xffffffff) >>> 0;
  const tiles = new Map();
  const keys = new Set();
  const touchKeys = new Set();
  const collected = new Set(saved?.collected);
  const fruitCounts = saved?.fruitCounts ?? { apple: 0, orange: 0, blueberry: 0 };
  const player = { x: saved?.player.x ?? 8, y: saved?.player.y ?? 8, direction: saved?.player.direction ?? 'down', moving: false };
  let ordersCompleted = saved?.ordersCompleted ?? 0;
  let campVisited = Math.hypot(player.x - CAMP.x, player.y - CAMP.y) <= CAMP.radius;
  let deliveryTimeout;
  let focused = true;
  let lastTime = performance.now();
  let walkTime = 0;
  let saveTime = 0;

  ctx.imageSmoothingEnabled = false;

  function viewSize(width, height) {
    if (!width || !height) return [320, 180];
    return width / height >= 16 / 9 ? [Math.round(180 * width / height), 180] : [320, Math.round(320 * height / width)];
  }

  new ResizeObserver(([entry]) => {
    const [width, height] = viewSize(entry.contentRect.width, entry.contentRect.height);
    if (canvas.width === width && canvas.height === height) return;
    canvas.width = width;
    canvas.height = height;
    ctx.imageSmoothingEnabled = false;
  }).observe(canvas);

  function hash(x, y, salt = 0) {
    let n = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ seed ^ salt;
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
  }

  function smooth(t) { return t * t * (3 - 2 * t); }

  function noise(x, y, scale, salt = 0) {
    x /= scale; y /= scale;
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const tx = smooth(x - x0), ty = smooth(y - y0);
    const a = hash(x0, y0, salt), b = hash(x0 + 1, y0, salt);
    const c = hash(x0, y0 + 1, salt), d = hash(x0 + 1, y0 + 1, salt);
    return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
  }

  function terrainAt(x, y) {
    if (x * x + y * y < 36) return 'grass';
    const land = noise(x, y, 13, 11) * .7 + noise(x, y, 5, 29) * .3;
    const road = Math.abs(noise(x, y, 19, 71) - .5);
    if (road < .035) return 'mud';
    if (land < .31) return 'water';
    if (land > .61) return 'forest';
    return 'grass';
  }

  function makeTile(x, y) {
    const terrain = terrainAt(x, y);
    const safe = x * x + y * y < 36;
    const tree = terrain === 'forest' && !safe && hash(x, y, 101) < .25;
    let fruit = null;
    if (terrain === 'forest' && !tree && hash(x, y, 202) < .075) {
      const kinds = ['apple', 'orange', 'blueberry'];
      fruit = kinds[Math.floor(hash(x, y, 303) * kinds.length)];
    }
    return { terrain, tree, fruit };
  }

  function getTile(x, y) {
    const key = `${x},${y}`;
    if (!tiles.has(key)) {
      const tile = makeTile(x, y);
      if (collected.has(key)) tile.fruit = null;
      tiles.set(key, tile);
    }
    return tiles.get(key);
  }

  function generateCaves() {
    let state = seed ^ 0x9e3779b9;
    const random = () => {
      state |= 0; state = state + 0x6D2B79F5 | 0;
      let n = Math.imul(state ^ state >>> 15, 1 | state);
      n = n + Math.imul(n ^ n >>> 7, 61 | n) ^ n;
      return ((n ^ n >>> 14) >>> 0) / 4294967296;
    };
    const caves = [], used = new Set();
    const valid = ({ x, y }) => {
      const tile = makeTile(x, y);
      return tile.terrain !== 'water' && !tile.tree && !tile.fruit &&
        Math.hypot(x * TILE - CAMP.x, y * TILE - CAMP.y) > CAMP.radius + TILE * 3 && !used.has(`${x},${y}`);
    };
    while (caves.length < 6) {
      const a = { x: Math.floor(random() * 513) - 256, y: Math.floor(random() * 513) - 256 };
      const distance = 80 + Math.floor(random() * 81), angle = random() * Math.PI * 2;
      const b = { x: a.x + Math.round(Math.cos(angle) * distance), y: a.y + Math.round(Math.sin(angle) * distance) };
      const actualDistance = Math.hypot(a.x - b.x, a.y - b.y);
      if (!valid(a) || !valid(b) || actualDistance < 80 || actualDistance > 160) continue;
      used.add(`${a.x},${a.y}`); used.add(`${b.x},${b.y}`);
      caves.push({ number: caves.length + 1, a, b });
    }
    return caves;
  }

  const caves = generateCaves();
  const cavesByLocation = new Map(caves.flatMap(cave => [
    [`${cave.a.x},${cave.a.y}`, { cave, destination: cave.b }],
    [`${cave.b.x},${cave.b.y}`, { cave, destination: cave.a }]
  ]));
  let caveLock = cavesByLocation.has(`${Math.floor(player.x / TILE)},${Math.floor(player.y / TILE)}`) ?
    `${Math.floor(player.x / TILE)},${Math.floor(player.y / TILE)}` : null;

  function nearestCave(x, y) {
    return caves.flatMap(cave => [cave.a, cave.b].map(mouth => ({ cave, distance: Math.hypot(x - (mouth.x + .5) * TILE, y - (mouth.y + .5) * TILE) / TILE })))
      .reduce((nearest, entrance) => entrance.distance < nearest.distance ? entrance : nearest);
  }

  function teleportAt(x, y, save = true) {
    const key = `${Math.floor(x / TILE)},${Math.floor(y / TILE)}`;
    if (caveLock === key) return false;
    caveLock = null;
    const mouth = cavesByLocation.get(key);
    if (!mouth) return false;
    player.x = (mouth.destination.x + .5) * TILE;
    player.y = (mouth.destination.y + .5) * TILE;
    caveLock = `${mouth.destination.x},${mouth.destination.y}`;
    if (save) saveProgress();
    return true;
  }

  function blocked(x, y) {
    const r = 4;
    return [[x-r,y-r], [x+r,y-r], [x-r,y+r], [x+r,y+r]].some(([px, py]) =>
      getTile(Math.floor(px / TILE), Math.floor(py / TILE)).tree
    );
  }

  function collectAt(x, y) {
    const tx = Math.floor(x / TILE), ty = Math.floor(y / TILE);
    const tile = getTile(tx, ty);
    if (!tile.fruit) return false;
    fruitCounts[tile.fruit]++;
    tile.fruit = null;
    collected.add(`${tx},${ty}`);
    updateHud();
    return true;
  }

  function orderFor(completed) {
    const amount = 2 + Math.floor(completed / 3);
    return Object.fromEntries(fruitKinds.map((kind, index) => [kind, amount + (index === completed % fruitKinds.length)]));
  }

  function paceFor(completed) { return 1 + Math.min(3, Math.floor(completed / 3)) * .1; }

  function deliveryMessage(completed) {
    return completed <= 9 && completed % 3 === 0 ? 'Order delivered! Pace upgraded.' : 'Order delivered!';
  }

  function deliver(insideCamp, notify = true) {
    if (!insideCamp) { campVisited = false; return false; }
    if (campVisited) return false;
    campVisited = true;
    const order = orderFor(ordersCompleted);
    if (!fruitKinds.every(kind => fruitCounts[kind] >= order[kind])) return false;
    fruitKinds.forEach(kind => fruitCounts[kind] -= order[kind]);
    ordersCompleted++;
    if (notify) {
      updateHud();
      const feedback = document.querySelector('#delivery');
      feedback.textContent = deliveryMessage(ordersCompleted);
      feedback.classList.add('visible');
      clearTimeout(deliveryTimeout);
      deliveryTimeout = setTimeout(() => feedback.classList.remove('visible'), 1600);
      saveProgress();
    }
    return true;
  }

  function updateHud() {
    for (const kind in fruitCounts) document.querySelector(`#${kind}`).textContent = fruitCounts[kind];
    const order = orderFor(ordersCompleted);
    fruitKinds.forEach(kind => document.querySelector(`#${kind}-needed`).textContent = order[kind]);
    document.querySelector('#orders-completed').textContent = ordersCompleted;
    document.querySelector('#pace').textContent = `${Math.round(paceFor(ordersCompleted) * 100)}%`;
  }

  function saveProgress() {
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify({
        version: 3,
        seed,
        player: { x: player.x, y: player.y, direction: player.direction },
        fruitCounts,
        ordersCompleted,
        collected: [...collected]
      }));
    } catch (error) {
      console.warn('Could not save progress.', error);
    }
  }

  function update(dt) {
    let dx = 0, dy = 0;
    const pressed = key => keys.has(key) || touchKeys.has(key);
    if (pressed('arrowleft') || pressed('a')) dx--;
    if (pressed('arrowright') || pressed('d')) dx++;
    if (pressed('arrowup') || pressed('w')) dy--;
    if (pressed('arrowdown') || pressed('s')) dy++;
    player.moving = focused && !!(dx || dy);
    if (!player.moving) return;
    if (Math.abs(dx) > Math.abs(dy)) player.direction = dx < 0 ? 'left' : 'right';
    else player.direction = dy < 0 ? 'up' : 'down';
    const length = Math.hypot(dx, dy);
    const terrain = getTile(Math.floor(player.x / TILE), Math.floor(player.y / TILE)).terrain;
    const speed = (terrain === 'mud' ? 30 : 48) * paceFor(ordersCompleted) * dt / length;
    const nx = player.x + dx * speed, ny = player.y + dy * speed;
    if (!blocked(nx, player.y)) player.x = nx;
    if (!blocked(player.x, ny)) player.y = ny;
    walkTime += dt;
    teleportAt(player.x, player.y);
    if (collectAt(player.x, player.y)) saveProgress();
    deliver(Math.hypot(player.x - CAMP.x, player.y - CAMP.y) <= CAMP.radius);
    saveTime += dt;
    if (saveTime >= 1) { saveTime = 0; saveProgress(); }
  }

  const colors = { grass: '#77a64b', forest: '#47783e', water: '#397ca3', mud: '#9a6940' };

  function drawTile(tile, x, y, tx, ty) {
    ctx.fillStyle = colors[tile.terrain];
    ctx.fillRect(x, y, TILE, TILE);
    const speck = hash(tx, ty, 404);
    ctx.fillStyle = tile.terrain === 'water' ? '#68aec2' : '#ffffff18';
    ctx.fillRect(x + 2 + Math.floor(speck * 9), y + 3 + Math.floor(speck * 7), tile.terrain === 'water' ? 6 : 2, 1);
    if (tile.tree) {
      ctx.fillStyle = '#5b3825'; ctx.fillRect(x + 7, y + 9, 3, 6);
      ctx.fillStyle = '#183f2c'; ctx.fillRect(x + 3, y + 2, 11, 9);
      ctx.fillStyle = '#2d6540'; ctx.fillRect(x + 5, y + 1, 7, 3);
    }
    if (tile.fruit) drawFruit(tile.fruit, x + 8, y + 9);
  }

  function drawFruit(kind, x, y) {
    ctx.fillStyle = kind === 'apple' ? '#d94b3d' : kind === 'orange' ? '#f49b31' : '#493c9f';
    if (kind === 'blueberry') {
      ctx.fillRect(x - 4, y - 2, 3, 3); ctx.fillRect(x, y - 3, 3, 3); ctx.fillRect(x - 1, y + 1, 3, 3);
    } else ctx.fillRect(x - 3, y - 3, 6, 6);
    ctx.fillStyle = '#214d2e'; ctx.fillRect(x, y - 5, 3, 2);
  }

  function drawPlayer(x, y, boating) {
    const step = player.moving && Math.floor(walkTime * 8) % 2;
    if (boating) {
      ctx.save(); ctx.translate(x, y);
      if (player.direction === 'left') ctx.rotate(Math.PI / 2);
      if (player.direction === 'right') ctx.rotate(-Math.PI / 2);
      if (player.direction === 'down') ctx.rotate(Math.PI);
      if (player.moving) {
        ctx.fillStyle = '#9bd2dc';
        ctx.fillRect(-5, 9 + step, 3, 1); ctx.fillRect(2, 10 - step, 4, 1);
      }
      ctx.fillStyle = '#472d22';
      ctx.fillRect(-2, -12, 4, 2); ctx.fillRect(-4, -10, 8, 2);
      ctx.fillRect(-6, -8, 12, 12); ctx.fillRect(-5, 4, 10, 3); ctx.fillRect(-3, 7, 6, 2);
      ctx.fillStyle = '#b66b32';
      ctx.fillRect(-2, -10, 4, 2); ctx.fillRect(-4, -8, 8, 11); ctx.fillRect(-3, 3, 6, 3);
      ctx.fillStyle = '#e0a24c';
      ctx.fillRect(-4, -7, 2, 9); ctx.fillRect(2, -7, 2, 9); ctx.fillRect(-1, -9, 2, 3);
      ctx.fillStyle = '#3f68a8'; ctx.fillRect(-3, -2, 6, 5);
      ctx.fillStyle = '#f0c89c'; ctx.fillRect(-3, -7, 6, 5);
      ctx.fillStyle = '#593923'; ctx.fillRect(-3, -8, 6, 2);
      const paddleX = step ? -7 : 6;
      ctx.fillStyle = '#e4c083'; ctx.fillRect(paddleX, -4, 1, 10);
      ctx.fillStyle = '#8b512d'; ctx.fillRect(paddleX - 1, 5, 3, 4);
      ctx.restore(); return;
    }
    ctx.fillStyle = '#2b2533';
    ctx.fillRect(x - 4, y + 3, 3, 5 + step); ctx.fillRect(x + 1, y + 3 + step, 3, 5 - step);
    ctx.fillStyle = '#3f68a8'; ctx.fillRect(x - 5, y - 3, 10, 8);
    ctx.fillStyle = '#f0c89c'; ctx.fillRect(x - 4, y - 10, 8, 7);
    ctx.fillStyle = '#593923'; ctx.fillRect(x - 5, y - 11, 10, 3);
    ctx.fillStyle = '#2b2533';
    if (player.direction === 'left') ctx.fillRect(x - 5, y - 7, 2, 2);
    else if (player.direction === 'right') ctx.fillRect(x + 3, y - 7, 2, 2);
    else if (player.direction === 'up') ctx.fillRect(x - 3, y - 11, 6, 2);
    else { ctx.fillRect(x - 3, y - 7, 2, 2); ctx.fillRect(x + 1, y - 7, 2, 2); }
  }

  function drawCamp(x, y) {
    ctx.fillStyle = '#e7c36a';
    ctx.beginPath(); ctx.arc(x, y, CAMP.radius, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#c66a3d';
    ctx.beginPath(); ctx.moveTo(x - 12, y + 8); ctx.lineTo(x, y - 10); ctx.lineTo(x + 12, y + 8); ctx.fill();
    ctx.fillStyle = '#763d2b'; ctx.fillRect(x - 12, y + 8, 24, 3);
  }

  function drawCave(cave, x, y) {
    ctx.fillStyle = '#514b50'; ctx.fillRect(x + 1, y + 5, 14, 10);
    ctx.fillStyle = '#17151a'; ctx.fillRect(x + 4, y + 7, 8, 8);
    ctx.fillStyle = '#f4df8b'; ctx.font = 'bold 7px monospace'; ctx.textAlign = 'center';
    ctx.fillText(cave.number, x + 8, y + 5);
  }

  function render() {
    const cameraX = Math.round(player.x - canvas.width / 2);
    const cameraY = Math.round(player.y - canvas.height / 2);
    const left = Math.floor(cameraX / TILE) - 1, top = Math.floor(cameraY / TILE) - 1;
    const right = Math.floor((cameraX + canvas.width) / TILE) + 1;
    const bottom = Math.floor((cameraY + canvas.height) / TILE) + 1;
    for (let ty = top; ty <= bottom; ty++) for (let tx = left; tx <= right; tx++)
      drawTile(getTile(tx, ty), tx * TILE - cameraX, ty * TILE - cameraY, tx, ty);
    for (const cave of caves) for (const mouth of [cave.a, cave.b])
      if (mouth.x >= left && mouth.x <= right && mouth.y >= top && mouth.y <= bottom)
        drawCave(cave, mouth.x * TILE - cameraX, mouth.y * TILE - cameraY);
    drawCamp(Math.round(CAMP.x - cameraX), Math.round(CAMP.y - cameraY));
    const water = getTile(Math.floor(player.x / TILE), Math.floor(player.y / TILE)).terrain === 'water';
    drawPlayer(Math.round(player.x - cameraX), Math.round(player.y - cameraY), water);
    const angle = Math.atan2(CAMP.y - player.y, CAMP.x - player.x);
    const arrows = ['→', '↘', '↓', '↙', '←', '↖', '↑', '↗'];
    const distance = Math.round(Math.hypot(player.x - CAMP.x, player.y - CAMP.y) / TILE);
    document.querySelector('#camp-direction').textContent = `${distance ? arrows[Math.round(angle / (Math.PI / 4) + 8) % 8] : '●'} ${distance}m`;
    const nearest = nearestCave(player.x, player.y);
    document.querySelector('#cave-distance').textContent = `Cave ${nearest.cave.number}: ${Math.round(nearest.distance)}m`;
  }

  function frame(now) {
    const dt = Math.min((now - lastTime) / 1000, .05);
    lastTime = now;
    update(dt); render(); requestAnimationFrame(frame);
  }

  const movementKeys = new Set(['arrowleft', 'arrowright', 'arrowup', 'arrowdown', 'w', 'a', 's', 'd']);
  addEventListener('keydown', event => {
    const key = event.key.toLowerCase();
    if (movementKeys.has(key)) { event.preventDefault(); keys.add(key); }
  });
  addEventListener('keyup', event => keys.delete(event.key.toLowerCase()));
  function clearInputs() { keys.clear(); touchKeys.clear(); }
  addEventListener('blur', () => { focused = false; clearInputs(); });
  addEventListener('focus', () => focused = true);
  document.addEventListener('visibilitychange', () => {
    focused = !document.hidden;
    if (document.hidden) clearInputs();
    else lastTime = performance.now();
  });
  document.querySelectorAll('.controls button').forEach(button => {
    button.addEventListener('pointerdown', event => {
      event.preventDefault();
      button.setPointerCapture(event.pointerId);
      touchKeys.add(button.dataset.key);
    });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'])
      button.addEventListener(type, () => touchKeys.delete(button.dataset.key));
  });
  addEventListener('pagehide', saveProgress);
  document.querySelector('#clear-progress').addEventListener('click', () => {
    if (!confirm('Clear all progress and start a new game?')) return;
    try { localStorage.removeItem(SAVE_KEY); } catch (error) { console.warn('Could not clear saved progress.', error); }
    location.reload();
  });

  function selfCheck() {
    const controls = [...document.querySelectorAll('.controls button')];
    console.assert(controls.length === 4 && controls.every(button => movementKeys.has(button.dataset.key)), 'Touch controls must map to movement keys');
    console.assert(viewSize(180, 320).join() === '320,569' && viewSize(640, 180).join() === '640,180', 'Responsive view must preserve scale and its minimum size');
    console.assert(getTile(0, 0) === getTile(0, 0), 'Tile lookup must be stable');
    console.assert(terrainAt(0, 0) === 'grass' && !getTile(0, 0).tree, 'Spawn must be safe');
    console.assert(['grass', 'forest', 'water', 'mud'].includes(terrainAt(100, 100)), 'Terrain must be valid');
    console.assert(JSON.stringify(caves) === JSON.stringify(generateCaves()), 'Cave generation must be deterministic');
    console.assert(caves.length === 6 && new Set(caves.map(cave => cave.number)).size === 6 && cavesByLocation.size === 12,
      'Caves must have six unique numbered pairs and twelve unique mouths');
    console.assert(nearestCave((caves[0].a.x + .5) * TILE, (caves[0].a.y + .5) * TILE).cave === caves[0],
      'Nearest cave must identify the cave at its entrance');
    console.assert(caves.every(cave => [cave.a, cave.b].every(mouth => {
      const tile = makeTile(mouth.x, mouth.y);
      return tile.terrain !== 'water' && !tile.tree && !tile.fruit;
    }) && Math.hypot(cave.a.x - cave.b.x, cave.a.y - cave.b.y) >= 80 &&
      Math.hypot(cave.a.x - cave.b.x, cave.a.y - cave.b.y) <= 160), 'Cave mouths must be passable and 80-160 tiles apart');
    console.assert(JSON.stringify(orderFor(0)) === '{"apple":3,"orange":2,"blueberry":2}' &&
      JSON.stringify(orderFor(1)) === '{"apple":2,"orange":3,"blueberry":2}' &&
      JSON.stringify(orderFor(3)) === '{"apple":4,"orange":3,"blueberry":3}', 'Orders must rotate and scale deterministically');
    console.assert([0, 2, 3, 5, 6, 8, 9, 99].map(paceFor).join() === '1,1,1.1,1.1,1.2,1.2,1.3,1.3' &&
      30 * paceFor(99) < 48 * paceFor(99), 'Pace must upgrade at 3/6/9, cap at 130%, and keep mud slower');
    console.assert(deliveryMessage(2) === 'Order delivered!' && deliveryMessage(3) === 'Order delivered! Pace upgraded.' &&
      deliveryMessage(12) === 'Order delivered!', 'Only upgrade deliveries must show pace feedback');
    console.assert(validSave({ version: 2, seed: 1, player: { x: 8, y: 8, direction: 'down' },
      fruitCounts: { apple: 1, orange: 2, blueberry: 3 }, collected: ['1,-2'] }), 'Version 2 saves must remain valid');
    const existingSave = { version: 3, seed: 1, player: { x: 8, y: 8, direction: 'down' },
      fruitCounts: { apple: 1, orange: 2, blueberry: 3 }, ordersCompleted: 6, collected: ['1,-2'] };
    console.assert(validSave(existingSave) && paceFor(existingSave.ordersCompleted) === 1.2,
      'Existing saves must reconstruct pace from completed deliveries');
    const tile = getTile(1, 1), oldFruit = tile.fruit, wasCollected = collected.has('1,1');
    const before = Object.values(fruitCounts).reduce((a, b) => a + b, 0);
    tile.fruit = 'apple'; collectAt(TILE + 8, TILE + 8); collectAt(TILE + 8, TILE + 8);
    console.assert(Object.values(fruitCounts).reduce((a, b) => a + b, 0) === before + 1, 'Collection must be idempotent');
    fruitCounts.apple--; tile.fruit = oldFruit;
    if (!wasCollected) collected.delete('1,1');
    const oldCounts = { ...fruitCounts }, oldCompleted = ordersCompleted, oldVisited = campVisited;
    Object.assign(fruitCounts, { apple: 5, orange: 4, blueberry: 3 }); ordersCompleted = 0; campVisited = false;
    console.assert(deliver(true, false) && fruitCounts.apple === 2 && fruitCounts.orange === 2 && fruitCounts.blueberry === 1 && ordersCompleted === 1,
      'Delivery must consume only the order and preserve surplus');
    console.assert(!deliver(true, false) && ordersCompleted === 1, 'Camp may deliver only once per visit');
    deliver(false, false); Object.assign(fruitCounts, orderFor(1));
    console.assert(deliver(true, false) && ordersCompleted === 2, 'Leaving camp must allow another delivery');
    deliver(false, false); Object.assign(fruitCounts, orderFor(2)); deliver(true, false); updateHud();
    console.assert(ordersCompleted === 3 && document.querySelector('#pace').textContent === '110%',
      'Third delivery must immediately upgrade pace and its HUD value');
    Object.assign(fruitCounts, oldCounts); ordersCompleted = oldCompleted; campVisited = oldVisited;
    const oldPlayer = { ...player }, oldCaveLock = caveLock, cave = caves[0];
    player.x = (cave.a.x + .5) * TILE; player.y = (cave.a.y + .5) * TILE; caveLock = null;
    console.assert(teleportAt(player.x, player.y, false) && player.x === (cave.b.x + .5) * TILE &&
      player.y === (cave.b.y + .5) * TILE && player.direction === oldPlayer.direction,
      'Either cave mouth must teleport to its partner without changing direction');
    console.assert(!teleportAt(player.x, player.y, false), 'Arrival must not immediately teleport back');
    teleportAt(player.x + TILE, player.y, false);
    console.assert(teleportAt(player.x, player.y, false) && player.x === (cave.a.x + .5) * TILE && player.y === (cave.a.y + .5) * TILE,
      'Leaving and re-entering a cave must reactivate it');
    Object.assign(player, oldPlayer); caveLock = oldCaveLock;
    updateHud();
  }

  updateHud();
  selfCheck();
  requestAnimationFrame(frame);
})();
