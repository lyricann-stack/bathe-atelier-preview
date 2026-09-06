// ===================== lab/app.js =====================
// Photo2Tub-Claude-Lab 第一階段：頁面互動、three.js 場景、JSON 存/載、A→B 一致性自測。
// 只依賴 lab/geometry.js 與 CDN 版 three.js，不引用/修改 reference/ 或原網站任何檔案。

(function () {
  'use strict';
  const G = window.TubGeometryLab;

  // ---------- three.js 場景（材質/燈光/接觸陰影沿用示範作法，避免過曝掩蓋幾何） ----------
  const stage = document.getElementById('stage');
  const statusEl = document.getElementById('status');
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 50);
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputEncoding = THREE.sRGBEncoding;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.92;
  stage.appendChild(renderer.domElement);

  const hemiLight = new THREE.HemisphereLight(0xffffff, 0x787c83, 0.85);
  scene.add(hemiLight);
  function addLight(x, y, z, intensity) {
    const l = new THREE.DirectionalLight(0xffffff, intensity);
    l.position.set(x, y, z);
    scene.add(l);
    return l;
  }
  const keyLight = addLight(-3, 5, 4, 1.5);
  const fillLight = addLight(3, 3, -3, 0.9);
  const rimLight = addLight(1, 1, 4, 0.22);

  const ceramic = new THREE.MeshPhysicalMaterial({
    color: 0xf5f5f2, roughness: 0.24, metalness: 0, clearcoat: 0.32, clearcoatRoughness: 0.22,
    side: THREE.DoubleSide
  });

  // 展示模式：「原示範柔光展示」與 Codex 視覺驗收要求的「診斷中性灰」（見
  // handoff/codex-review-02-visual.md 第1點）。只調材質/燈光/曝光/背景，不動幾何，
  // 兩個模式可互相切回，不用新燈光掩蓋幾何本身的差異。
  const DISPLAY_PRESETS = {
    demo: { color: 0xf5f5f2, roughness: 0.24, clearcoat: 0.32, clearcoatRoughness: 0.22,
      hemi: 0.85, key: 1.5, fill: 0.9, rim: 0.22, exposure: 0.92, background: null },
    diagnostic: { color: 0xd9dbdd, roughness: 0.44, clearcoat: 0.08, clearcoatRoughness: 0.42,
      hemi: 0.55, key: 1.05, fill: 0.5, rim: 0.16, exposure: 0.68, background: 0x4d5054 }
  };
  function setDisplayMode(mode) {
    const p = DISPLAY_PRESETS[mode] || DISPLAY_PRESETS.demo;
    ceramic.color.setHex(p.color);
    ceramic.roughness = p.roughness;
    ceramic.clearcoat = p.clearcoat;
    ceramic.clearcoatRoughness = p.clearcoatRoughness;
    ceramic.needsUpdate = true;
    hemiLight.intensity = p.hemi;
    keyLight.intensity = p.key;
    fillLight.intensity = p.fill;
    rimLight.intensity = p.rim;
    renderer.toneMappingExposure = p.exposure;
    scene.background = p.background != null ? new THREE.Color(p.background) : null;
    draw();
  }
  const metal = new THREE.MeshStandardMaterial({ color: 0xa8acaf, metalness: 0.82, roughness: 0.25 });
  const slotMat = new THREE.MeshStandardMaterial({ color: 0x777c80, roughness: 0.6 });

  const tub = new THREE.Mesh(new THREE.BufferGeometry(), ceramic);
  scene.add(tub);
  const drain = new THREE.Mesh(new THREE.CylinderGeometry(0.027, 0.027, 0.002, 48), metal);
  scene.add(drain);
  const slot = new THREE.Mesh(new THREE.BoxGeometry(0.068, 0.006, 0.0018), slotMat);
  scene.add(slot);

  // 柔光接觸陰影（不使用可見地板）
  const shadowCanvas = document.createElement('canvas');
  shadowCanvas.width = 256; shadowCanvas.height = 256;
  const sctx = shadowCanvas.getContext('2d');
  const grad = sctx.createRadialGradient(128, 128, 4, 128, 128, 128);
  grad.addColorStop(0, 'rgba(0,0,0,.24)');
  grad.addColorStop(.5, 'rgba(0,0,0,.13)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  sctx.fillStyle = grad; sctx.fillRect(0, 0, 256, 256);
  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(2, 0.9),
    new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(shadowCanvas), transparent: true, depthWrite: false })
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.004;
  scene.add(shadow);

  let az = 0.23, el = 0.38, distance = 3.1;
  const target = new THREE.Vector3(0, 0.32, 0);
  function draw() {
    camera.position.set(
      distance * Math.sin(az) * Math.cos(el),
      target.y + distance * Math.sin(el),
      distance * Math.cos(az) * Math.cos(el)
    );
    camera.lookAt(target);
    renderer.render(scene, camera);
  }
  function resize() {
    const w = stage.clientWidth, h = stage.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.fov = w < 480 ? 46 : 35;
    camera.updateProjectionMatrix();
    draw();
  }
  new ResizeObserver(resize).observe(stage);

  // ---------- 目前形狀狀態（唯一真相來源，載入時整包替換，不逐欄合併） ----------
  let currentShape = G.defaultShape();

  function rebuild() {
    const geo = G.buildTubBufferGeometry(currentShape);
    tub.geometry.dispose();
    tub.geometry = geo;

    const d = G.computeDrainPosition(currentShape);
    drain.position.set(d[0], d[1], d[2]);
    const ov = G.computeOverflowTransform(currentShape);
    slot.position.set(ov.position[0], ov.position[1], ov.position[2]);
    slot.rotation.x = ov.rotationX;

    const L = currentShape.dimensions.length, W = currentShape.dimensions.width;
    shadow.scale.set(L / 1800, W / 800, 1);
    autoFrame();
    draw();
  }

  // 依實際 bounding sphere 設定 target 與（未手動調過縮放時的）distance，取代原本寫死的
  // target.y 公式；解決 Codex 視覺驗收第2點「模型上方空白較多」——用真正的模型邊界取景，
  // 讓模型在不裁切的前提下盡量占滿畫面主要寬度，而不是所有形狀都套用同一組固定距離。
  function autoFrame() {
    tub.geometry.computeBoundingSphere();
    const sphere = tub.geometry.boundingSphere;
    if (!sphere || !isFinite(sphere.radius) || sphere.radius <= 0) return;
    target.set(sphere.center.x, sphere.center.y, sphere.center.z);
    if (!userAdjustedZoom) {
      const vFovRad = camera.fov * Math.PI / 180;
      const aspect = camera.aspect || (stage.clientWidth / Math.max(1, stage.clientHeight)) || 1;
      const hFovRad = 2 * Math.atan(Math.tan(vFovRad / 2) * aspect);
      const limitingFovRad = Math.min(vFovRad, hFovRad);
      const fitDistance = sphere.radius / Math.sin(limitingFovRad / 2) * 1.12; // 12% 邊界留白，避免裁切
      distance = Math.max(1.7, Math.min(4.8, fitDistance));
      zoomInput.value = distance;
    }
  }

  // ---------- 視角 / 縮放控制 ----------
  const VIEWS = { perspective: [0.23, 0.38], side: [0, 0], top: [0, Math.PI / 2 - 0.001], end: [Math.PI / 2, 0] };
  const angleSel = document.getElementById('view-angle');
  angleSel.addEventListener('change', (e) => { [az, el] = VIEWS[e.target.value]; draw(); });
  const zoomInput = document.getElementById('view-zoom');
  // userAdjustedZoom：使用者手動調過縮放後，rebuild() 就不再用 bounding sphere 自動改 distance，
  // 避免跟使用者操作互相打架；載入新形狀（applyShape）時會重置這個旗標，讓新形狀重新自動取景。
  let userAdjustedZoom = false;
  zoomInput.addEventListener('input', () => { distance = Number(zoomInput.value); userAdjustedZoom = true; draw(); });
  document.getElementById('display-mode').addEventListener('change', (e) => setDisplayMode(e.target.value));

  const pointers = new Map();
  let pinch = 0;
  stage.addEventListener('pointerdown', (e) => { stage.setPointerCapture(e.pointerId); pointers.set(e.pointerId, [e.clientX, e.clientY]); pinch = 0; });
  stage.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    const old = pointers.get(e.pointerId);
    pointers.set(e.pointerId, [e.clientX, e.clientY]);
    if (pointers.size === 1) {
      az -= (e.clientX - old[0]) * 0.008;
      el = Math.max(-0.35, Math.min(1.56, el + (e.clientY - old[1]) * 0.008));
    } else {
      const p = [...pointers.values()];
      const d = Math.hypot(p[0][0] - p[1][0], p[0][1] - p[1][1]);
      if (pinch) { distance = Math.max(1.7, Math.min(4.8, distance * pinch / d)); userAdjustedZoom = true; }
      pinch = d; zoomInput.value = distance;
    }
    draw();
  });
  ['pointerup', 'pointercancel'].forEach((ev) => stage.addEventListener(ev, (e) => { pointers.delete(e.pointerId); pinch = 0; }));
  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    distance = Math.max(1.7, Math.min(4.8, distance * Math.exp(e.deltaY * 0.001)));
    userAdjustedZoom = true;
    zoomInput.value = distance;
    draw();
  }, { passive: false });

  // ---------- 參數滑桿（讀寫 currentShape，即時 rebuild） ----------
  const SLIDER_MAP = [
    ['param-length', ['dimensions', 'length'], 'mm'],
    ['param-width', ['dimensions', 'width'], 'mm'],
    ['param-center-height', ['dimensions', 'centerHeight'], 'mm'],
    ['param-rise-positive', ['rim', 'endPositiveRise'], 'mm'],
    ['param-rise-negative', ['rim', 'endNegativeRise'], 'mm'],
    ['param-round', ['plan', 'cornerRoundPct'], '% 方形'],
    ['param-rim-thickness', ['shell', 'rimThickness'], 'mm']
  ];
  function getPath(obj, path) { return path.reduce((o, k) => o[k], obj); }
  function setPath(obj, path, val) { let o = obj; for (let i = 0; i < path.length - 1; i++) o = o[path[i]]; o[path[path.length - 1]] = val; }

  let pending = false;
  function syncControlsFromShape() {
    SLIDER_MAP.forEach(([id, path, unit]) => {
      const input = document.getElementById(id);
      const output = document.getElementById(id + '-value');
      const v = getPath(currentShape, path);
      input.value = v;
      output.textContent = v + (unit.startsWith('%') ? unit : ' ' + unit);
    });
    document.getElementById('shape-label').textContent = currentShape.label || '（未命名形狀）';
    document.getElementById('shape-source-note').textContent = currentShape.sourceNote || '';
  }
  SLIDER_MAP.forEach(([id, path, unit]) => {
    const input = document.getElementById(id);
    const output = document.getElementById(id + '-value');
    input.addEventListener('input', () => {
      setPath(currentShape, path, Number(input.value));
      output.textContent = input.value + (unit.startsWith('%') ? unit : ' ' + unit);
      if (!pending) { pending = true; requestAnimationFrame(() => { pending = false; rebuild(); }); }
    });
    input.addEventListener('change', () => { statusEl.textContent = '浴缸形狀已更新（' + new Date().toLocaleTimeString() + '）'; });
  });

  // ---------- JSON 存 / 載 ----------
  const jsonArea = document.getElementById('json-area');
  const loadMsg = document.getElementById('load-message');

  function refreshJsonArea() { jsonArea.value = JSON.stringify(currentShape, null, 2); }

  function applyShape(newShape) {
    currentShape = newShape; // 整包替換，絕不逐欄合併殘留舊值
    userAdjustedZoom = false; // 換一個形狀就重新自動取景，不沿用上一個形狀的手動縮放
    syncControlsFromShape();
    refreshJsonArea();
    rebuild();
  }

  document.getElementById('btn-export').addEventListener('click', () => { refreshJsonArea(); });

  document.getElementById('btn-download').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(currentShape, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (currentShape.label || 'tub-shape').replace(/[^\w\-]+/g, '_') + '.json';
    a.click();
    URL.revokeObjectURL(a.href);
  });

  document.getElementById('btn-load-from-text').addEventListener('click', () => {
    const res = G.loadShapeFromJSON(jsonArea.value);
    if (!res.ok) {
      loadMsg.textContent = '匯入失敗：' + res.errors.join('；');
      loadMsg.className = 'load-message error';
      return;
    }
    applyShape(res.shape);
    loadMsg.textContent = '已從貼上的 JSON 完整重建（乾淨 state，未沿用前一個模型）。';
    loadMsg.className = 'load-message ok';
  });

  document.getElementById('file-input').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      const res = G.loadShapeFromJSON(reader.result);
      if (!res.ok) {
        loadMsg.textContent = '匯入失敗（' + f.name + '）：' + res.errors.join('；');
        loadMsg.className = 'load-message error';
        return;
      }
      applyShape(res.shape);
      loadMsg.textContent = '已載入 ' + f.name + '（完整重建，乾淨 state）。';
      loadMsg.className = 'load-message ok';
    };
    reader.readAsText(f);
    e.target.value = '';
  });

  async function loadFixture(path) {
    const res = await fetch(path, { cache: 'no-store' });
    const text = await res.text();
    return G.loadShapeFromJSON(text);
  }

  document.getElementById('btn-load-reference').addEventListener('click', async () => {
    const res = await loadFixture('fixtures/reference-shape.json');
    if (!res.ok) { loadMsg.textContent = '載入 reference-shape.json 失敗：' + res.errors.join('；'); loadMsg.className = 'load-message error'; return; }
    applyShape(res.shape);
    loadMsg.textContent = '已載入 fixtures/reference-shape.json（示範重現版）。';
    loadMsg.className = 'load-message ok';
  });

  document.getElementById('btn-load-variant').addEventListener('click', async () => {
    const res = await loadFixture('fixtures/test-variant-b.json');
    if (!res.ok) { loadMsg.textContent = '載入 test-variant-b.json 失敗：' + res.errors.join('；'); loadMsg.className = 'load-message error'; return; }
    applyShape(res.shape);
    loadMsg.textContent = '已載入 fixtures/test-variant-b.json（參數化驗證用第二款形狀）。';
    loadMsg.className = 'load-message ok';
  });

  document.getElementById('btn-reset-default').addEventListener('click', () => {
    applyShape(G.defaultShape());
    loadMsg.textContent = '已重設為程式內建預設形狀（等同示範預設值）。';
    loadMsg.className = 'load-message ok';
  });

  // ---------- A→B 一致性自測：先直接載 B 記錄雜湊，再載 A→再載 B，比較兩次雜湊是否相同 ----------
  function hashPositions(geo) {
    const arr = geo.getAttribute('position').array;
    let h1 = 0x811c9dc5, h2 = 0x811c9dc5;
    for (let i = 0; i < arr.length; i++) {
      const bits = Math.round(arr[i] * 1e6);
      h1 = (h1 ^ (bits & 0xffff)) * 16777619 >>> 0;
      h2 = (h2 ^ ((bits >>> 16) & 0xffff)) * 16777619 >>> 0;
    }
    return h1.toString(16) + '-' + h2.toString(16) + '-n' + arr.length;
  }

  document.getElementById('btn-selftest').addEventListener('click', async () => {
    const out = document.getElementById('selftest-result');
    out.textContent = '執行中…';
    // 見 handoff/codex-review-02-visual.md 第3點：自測建立的暫存幾何要 dispose，
    // 且自測不能把使用者目前正在看的設計換掉——結束一律還原成呼叫當下的 currentShape。
    // applyShape() 內部會重置 userAdjustedZoom 並重新 autoFrame()，連同視角/縮放狀態一起
    // 存起來，測試結束還原形狀之後再還原這些狀態，才不會把使用者手動調過的鏡頭蓋掉。
    const savedShape = currentShape;
    const savedView = { az, el, distance, userAdjustedZoom };
    let directGeo = null, afterAthenBGeo = null;
    try {
      const A = await loadFixture('fixtures/reference-shape.json');
      const B = await loadFixture('fixtures/test-variant-b.json');
      if (!A.ok || !B.ok) throw new Error('fixture 載入失敗：' + (A.errors || []).concat(B.errors || []).join('；'));

      // 情境一：直接建構 B 的幾何
      directGeo = G.buildTubBufferGeometry(B.shape);
      const hashDirectB = hashPositions(directGeo);

      // 情境二：先完整載入 A，再完整載入 B（用 applyShape 模擬使用者操作順序），
      // 驗證載入 B 之後的幾何跟「一開始就直接載入 B」完全一致，沒有殘留 A 的欄位。
      applyShape(A.shape);
      applyShape(B.shape);
      afterAthenBGeo = G.buildTubBufferGeometry(currentShape);
      const hashAthenB = hashPositions(afterAthenBGeo);

      const pass = hashDirectB === hashAthenB;
      out.textContent = (pass ? '✅ 通過：' : '❌ 不通過：') +
        'directB=' + hashDirectB + ' | A→B=' + hashAthenB;
      out.className = pass ? 'ok' : 'error';
    } catch (err) {
      out.textContent = '自測發生錯誤：' + err.message;
      out.className = 'error';
    } finally {
      if (directGeo) directGeo.dispose();
      if (afterAthenBGeo) afterAthenBGeo.dispose();
      applyShape(savedShape); // 還原自測前使用者正在看的設計（會連帶重新 autoFrame）
      // autoFrame() 剛剛用還原後的形狀重算了一次 target/distance；再把使用者當時真正的
      // 鏡頭狀態（旋轉角度、是否手動縮放過、手動縮放的距離）蓋回去，而不是留著自動取景值。
      az = savedView.az; el = savedView.el; userAdjustedZoom = savedView.userAdjustedZoom;
      if (savedView.userAdjustedZoom) { distance = savedView.distance; zoomInput.value = distance; }
      draw();
    }
  });

  // ---------- 啟動 ----------
  // resize() 要先跑一次把 camera.aspect 定下來，autoFrame()（在 rebuild() 內）才能用正確的
  // 長寬比計算初始取景距離，不然第一次 rebuild 會用預設 aspect=1 算出偏差的 distance。
  setDisplayMode('demo');
  syncControlsFromShape();
  refreshJsonArea();
  resize();
  rebuild();
})();
