// ===================== lab/geometry.js =====================
// Photo2Tub-Claude-Lab 第一階段：獨立曲面引擎（不修改 reference/ 內任何檔案）。
//
// 幾何數學移植自業主認可的示範 reference/codex-bathtub-3d.html（22 組剖面插值、
// 兩端獨立抬升、抬升依剖面高度加權），但拆成純函式並改由「受控 JSON 形狀物件」
// 驅動，而不是頁面內寫死的數值，方便存檔/重載與參數調整。
//
// 座標慣例（依 reference/modification-plan.md §13.1）：
//   X = 長度方向（正端 end_positive＝抬升較高那端，對應示範的 shape.right）
//   Y = 高度方向
//   Z = 寬度方向
// 內部運算單位＝公尺（沿用示範作法），JSON 對外欄位單位＝毫米（mm），
// 由 buildRuntimeShape() 統一換算，避免頁面各處各自 /1000。
//
// 【2026-09-07 Codex 第一輪審查後修正，見 handoff/codex-review-01.md】
// 1. sectionProfile 是核心欄位，缺少必須拒絕，不再靜默補預設值。
// 2. 驗證改用 typeof v==='number' && Number.isFinite(v)，避免 global isFinite()
//    把 null / 數字字串誤判為合法數值（isFinite(null)===true 是已知陷阱）。
// 3. 補齊所有實際參與幾何運算的欄位驗證：calibration 各分母、rimTaperRowSpan、
//    rise power、cornerRoundPct 範圍、accessories.overflow.rowIndex 邊界等。
// 4. 原示範 point() 內「缸邊厚度調整」的收縮分母是兩個獨立字面常數 .879 / .379，
//    不是任何 profile 列的別名。第一版誤寫成 rows[8]（實際是 [.899,.399,...]），
//    数值上與示範不同（雖然預設 24mm 時 extra=0 看不出差異，改厚度就會偏）。
//    現在改回明確的獨立校正常數 calibration.rimTaperRefLength/RefWidth=.879/.379，
//    不依賴任何列索引，才是對示範的忠實逐字移植。
// 5. sectionProfile.rows 第一階段明確只支援固定 22 列（EXPECTED_PROFILE_ROW_COUNT），
//    不宣稱支援任意列數曲面表示法；列數不符直接拒絕匯入。
// 6. accessories.drain.xFrac 更名為 xAnchorM 並在說明中註明：這是「公尺尺度的錨點
//    數值，乘上 length/baseLengthDrain 的近似 1.0 縮放比例」，不是 0~1 的正規化比例，
//    避免第二階段接 AI 時被誤填成百分比。
// 7. 根 JSON 為 null（或非物件）時回傳 {ok:false, errors:[...]}，不再拋出 TypeError；
//    呼叫端（app.js）在 ok:false 時本就不會呼叫 applyShape()，因此會保留目前模型。
// 8. loadShapeFromJSON 驗證通過欄位後，會實際建構一次幾何並檢查所有頂點座標皆為
//    有限數，避免「JSON 格式合法」被誤當成「幾何有效」；任一頂點非有限數就拒絕匯入。
//
// 尚未做（如實記錄，不宣稱已完成）：自我相交（self-intersection）檢查、內外殼穿透
// 檢查、法線品質檢查。目前只保證位置座標全部是有限數，幾何拓樸本身仍完全沿用示範
// 的三角化方式，未額外驗證。

(function (global) {
  'use strict';

  const SCHEMA_VERSION = 'photo2tub-lab-shape-v1';
  const EXPECTED_PROFILE_ROW_COUNT = 22; // 第一階段明確只支援固定 22 列校正剖面

  // ---------- 預設剖面（逐字取自 reference/codex-bathtub-3d.html 的 profile 陣列） ----------
  // 欄位：[outerLengthRadiusM, outerWidthRadiusM, baseHeightM, endRiseWeight]（單位見 rowUnit='m'）
  //   outerLengthRadiusM / outerWidthRadiusM：該剖面列在長向/寬向的半徑（公尺，見上方單位說明）
  //   baseHeightM：該列基準高度（公尺，抬升前）
  //   endRiseWeight：0~1，該列吃多少比例的端部抬升（0=完全不受抬升影響，避免整個底部被拉起；
  //                  1=完全跟隨缸緣抬升）
  const DEFAULT_PROFILE_ROWS = [
    [0, 0, .022, 0], [.40, .14, .022, 0], [.62, .235, .022, 0], [.686, .272, .041, 0],
    [.732, .298, .094, .025], [.791, .331, .216, .13], [.843, .365, .365, .43],
    [.880, .387, .480, .80], [.899, .399, .536, 1], [.8995, .3995, .542, 1],
    [.895, .395, .546, 1], [.885, .385, .545, 1], [.879, .379, .540, 1],
    [.876, .376, .528, .99], [.861, .364, .465, .80], [.827, .337, .343, .47],
    [.777, .301, .231, .16], [.716, .257, .156, .025], [.658, .222, .132, 0],
    [.550, .182, .127, 0], [.33, .11, .126, 0], [0, 0, .126, 0]
  ];

  function defaultShape() {
    return {
      schemaVersion: SCHEMA_VERSION,
      unit: 'mm',
      label: '參考示範重現（人工參數）',
      sourceNote:
        '沿用 2026-09-06 業主認可示範（reference/codex-bathtub-3d.html）的人工估算數值，' +
        '非量測尺寸；來源見 reference/modification-plan.md §3。',
      dimensions: { length: 1800, width: 800, centerHeight: 550 },
      rim: {
        endPositiveRise: 205,
        endNegativeRise: 15,
        endPositiveRisePower: 2.1,
        endNegativeRisePower: 2.0
      },
      plan: { cornerRoundPct: 20 },
      shell: { rimThickness: 24 },
      sectionProfile: {
        rowUnit: 'm', // 明確標出：rows 內數值單位是公尺，不是 mm，也不是 0~1 比例（見檔頭說明）
        calibration: {
          baseLengthSurface: 1799, // 曲面點縮放用的長度校正常數（示範原始寫死值，非 1800，忠實保留）
          baseLengthDrain: 1800,   // 排水孔位置縮放用的長度校正常數（示範原始就用不同的分母，忠實保留）
          baseWidth: 799,
          baseHeight: 546,
          baseRimThickness: 24,
          rimTaperRefLength: 0.879, // 缸邊厚度調整收縮項的獨立字面常數（示範原始碼 a/.879，非任何列的別名）
          rimTaperRefWidth: 0.379   // 缸邊厚度調整收縮項的獨立字面常數（示範原始碼 b/.379，非任何列的別名）
        },
        rimTaperRowStart: 9, // 缸邊厚度調整只影響第 9~13 列附近（示範以 smoothstep 限制範圍）
        rimTaperRowSpan: 4,
        rows: DEFAULT_PROFILE_ROWS.map((r) => r.slice())
      },
      accessories: {
        drain: {
          xAnchorM: -0.23,
          note: '這是公尺尺度的錨點數值（非 0~1 正規化比例），實際套用時會再乘上 ' +
            'length/baseLengthDrain 的近似 1.0 縮放比例；示範估算位置，非量測。'
        },
        overflow: {
          rowIndex: 14,
          t: 0.45,
          tNormal: 0.46,
          theta: 1.5 * Math.PI,
          note: '示範估算的內壁溢水孔位置與角度，非量測。'
        }
      },
      evidence: {
        status: 'estimated',
        basis: '依 reference/reference-photo.png 目視比對示範作者手動調校，非型錄或量測資料。',
        unknowns: ['實際量產長寬高', '實際壁厚', '排水孔/溢水孔精確位置', '底部與裙擺實際構造']
      }
    };
  }

  // ---------- Catmull-Rom 取樣（逐字對應示範的 sample()） ----------
  function sampleColumn(rows, i, t, col) {
    const a = rows[Math.max(0, i - 1)][col];
    const b = rows[i][col];
    const c = rows[Math.min(rows.length - 1, i + 1)][col];
    const d = rows[Math.min(rows.length - 1, i + 2)][col];
    return 0.5 * (
      (2 * b) + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t * t +
      (-a + 3 * b - 3 * c + d) * t * t * t
    );
  }

  // ---------- 由 JSON 形狀物件建立「運算用」形狀（單位換算與防呆一次做完） ----------
  function buildRuntimeShape(shape) {
    const dim = shape.dimensions, rim = shape.rim, plan = shape.plan, shell = shape.shell;
    const cal = shape.sectionProfile.calibration;
    return {
      rows: shape.sectionProfile.rows,
      rimTaperRowStart: shape.sectionProfile.rimTaperRowStart,
      rimTaperRowSpan: shape.sectionProfile.rimTaperRowSpan,
      lengthMm: dim.length,
      widthMm: dim.width,
      centerHeightMm: dim.centerHeight,
      endPositiveRiseMm: rim.endPositiveRise,
      endNegativeRiseMm: rim.endNegativeRise,
      endPositiveRisePower: rim.endPositiveRisePower,
      endNegativeRisePower: rim.endNegativeRisePower,
      roundPct: plan.cornerRoundPct,
      rimThicknessMm: shell.rimThickness,
      cal
    };
  }

  // ---------- 單點曲面座標（逐字對應示範的 point()，改讀 runtime shape） ----------
  function surfacePoint(rt, i, t, theta) {
    const rows = rt.rows;
    const a = sampleColumn(rows, i, t, 0);
    const b = sampleColumn(rows, i, t, 1);
    const h = sampleColumn(rows, i, t, 2);
    const w = sampleColumn(rows, i, t, 3);
    const u = Math.max(0, Math.min(1, (i + t - rt.rimTaperRowStart) / rt.rimTaperRowSpan));
    const inner = u * u * (3 - 2 * u);
    const extra = (rt.rimThicknessMm - rt.cal.baseRimThickness) / 1000 * inner;
    // 忠實對應示範的 a/.879、b/.379：獨立字面校正常數，不是任何 profile 列的索引別名。
    const aa = a * (rt.lengthMm / rt.cal.baseLengthSurface) - extra * (a / rt.cal.rimTaperRefLength);
    const bb = b * (rt.widthMm / rt.cal.baseWidth) - extra * (b / rt.cal.rimTaperRefWidth);
    const c = Math.cos(theta), sn = Math.sin(theta);
    const power = 1 - rt.roundPct * 0.007;
    const x = Math.sign(c) * Math.pow(Math.abs(c), power);
    const z = Math.sign(sn) * Math.pow(Math.abs(sn), power);
    const rise =
      (rt.endPositiveRiseMm / 1000) * Math.pow(Math.max(0, x), rt.endPositiveRisePower) +
      (rt.endNegativeRiseMm / 1000) * Math.pow(Math.max(0, -x), rt.endNegativeRisePower);
    const y = h * rt.centerHeightMm / rt.cal.baseHeight + w * rise;
    return [aa * x, y, bb * z];
  }

  const THETA_SEGMENTS = 192; // 周向取樣數
  const ROW_SUBSTEPS = 8;     // 每兩剖面列之間的插值細分數

  // ---------- 建立 BufferGeometry（需要全域 THREE，由 index.html 以 CDN 載入） ----------
  function buildTubBufferGeometry(shape) {
    const rt = buildRuntimeShape(shape);
    const rows = rt.rows;
    const pos = [], idx = [];
    for (let i = 0; i < rows.length - 1; i++) {
      for (let s = 0; s < ROW_SUBSTEPS; s++) {
        for (let j = 0; j <= THETA_SEGMENTS; j++) {
          pos.push(...surfacePoint(rt, i, s / ROW_SUBSTEPS, (j / THETA_SEGMENTS) * Math.PI * 2));
        }
      }
    }
    // 缸底中心封蓋點：讀最後一列的 baseHeight，而非寫死示範的 .126
    const lastH = rows[rows.length - 1][2];
    const capY = lastH * rt.centerHeightMm / rt.cal.baseHeight;
    for (let j = 0; j <= THETA_SEGMENTS; j++) pos.push(0, capY, 0);

    const rowsCount = pos.length / 3 / (THETA_SEGMENTS + 1);
    for (let i = 0; i < rowsCount - 1; i++) {
      for (let j = 0; j < THETA_SEGMENTS; j++) {
        const a = i * (THETA_SEGMENTS + 1) + j, b = a + THETA_SEGMENTS + 1;
        idx.push(a, a + 1, b, b, a + 1, b + 1);
      }
    }

    const geo = new global.THREE.BufferGeometry();
    geo.setAttribute('position', new global.THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    return geo;
  }

  // 建構後的幾何有效性檢查（第一階段範圍：只保證座標/法線皆為有限數）。
  // 尚未做：自交、內外殼穿透、殼厚檢查（如實記錄，見 handoff/phase-1-result.md）。
  function checkBuiltGeometryFinite(geo) {
    const errors = [];
    const posAttr = geo.getAttribute('position');
    const nrmAttr = geo.getAttribute('normal');
    if (!posAttr) { errors.push('geometry 缺少 position attribute'); return { ok: false, errors }; }
    const pos = posAttr.array;
    for (let i = 0; i < pos.length; i++) {
      if (!Number.isFinite(pos[i])) { errors.push('position 陣列第 ' + i + ' 個分量非有限數：' + pos[i]); break; }
    }
    if (nrmAttr) {
      const nrm = nrmAttr.array;
      for (let i = 0; i < nrm.length; i++) {
        if (!Number.isFinite(nrm[i])) { errors.push('normal 陣列第 ' + i + ' 個分量非有限數：' + nrm[i]); break; }
      }
    }
    return { ok: errors.length === 0, errors };
  }

  // ---------- 排水孔 / 溢水孔位置（逐字對應示範 rebuild() 內的計算） ----------
  function computeDrainPosition(shape) {
    const rt = buildRuntimeShape(shape);
    const rows = rt.rows;
    const lastH = rows[rows.length - 1][2];
    const capY = lastH * rt.centerHeightMm / rt.cal.baseHeight;
    const x = shape.accessories.drain.xAnchorM * (rt.lengthMm / rt.cal.baseLengthDrain);
    return [x, capY + 0.002, 0];
  }

  function computeOverflowTransform(shape) {
    const rt = buildRuntimeShape(shape);
    const ov = shape.accessories.overflow;
    const q = surfacePoint(rt, ov.rowIndex, ov.t, ov.theta);
    const r = surfacePoint(rt, ov.rowIndex, ov.tNormal, ov.theta);
    return {
      position: [0, q[1], q[2] + 0.0015],
      rotationX: -Math.atan2(r[2] - q[2], q[1] - r[1])
    };
  }

  // ---------- 驗證 ----------
  // 用 typeof + Number.isFinite，避免 global isFinite() 把 null / 數字字串誤判為合法數值
  // （isFinite(null) === true 是已知陷阱，Number.isFinite(null) === false 才正確）。
  function isFiniteNumber(v) { return typeof v === 'number' && Number.isFinite(v); }
  function isPositiveFiniteNumber(v) { return isFiniteNumber(v) && v > 0; }
  function isNonNegativeFiniteNumber(v) { return isFiniteNumber(v) && v >= 0; }

  function validateShape(shape) {
    const errors = [];
    const req = (cond, msg) => { if (!cond) errors.push(msg); };

    req(shape !== null && typeof shape === 'object' && !Array.isArray(shape), '根物件必須是非 null 的物件');
    if (!shape || typeof shape !== 'object' || Array.isArray(shape)) return { ok: false, errors };

    req(shape.schemaVersion === SCHEMA_VERSION, `schemaVersion 必須為 ${SCHEMA_VERSION}（收到 ${JSON.stringify(shape.schemaVersion)}）`);
    req(shape.unit === 'mm', `unit 必須為 'mm'（收到 ${JSON.stringify(shape.unit)}）`);

    const dim = shape.dimensions;
    req(dim && typeof dim === 'object', 'dimensions 缺失');
    if (dim) {
      req(isPositiveFiniteNumber(dim.length), 'dimensions.length 必須是正的有限數值');
      req(isPositiveFiniteNumber(dim.width), 'dimensions.width 必須是正的有限數值');
      req(isPositiveFiniteNumber(dim.centerHeight), 'dimensions.centerHeight 必須是正的有限數值');
    }

    const rim = shape.rim;
    req(rim && typeof rim === 'object', 'rim 缺失');
    if (rim) {
      req(isNonNegativeFiniteNumber(rim.endPositiveRise), 'rim.endPositiveRise 必須是非負的有限數值（null 不等於已確認的 0，缺少必須明確填 0）');
      req(isNonNegativeFiniteNumber(rim.endNegativeRise), 'rim.endNegativeRise 必須是非負的有限數值（null 不等於已確認的 0，缺少必須明確填 0）');
      req(isFiniteNumber(rim.endPositiveRisePower) && rim.endPositiveRisePower > 0 && rim.endPositiveRisePower <= 10,
        'rim.endPositiveRisePower 必須是 (0,10] 範圍內的有限數值（缺少會讓 Math.pow 產生 NaN）');
      req(isFiniteNumber(rim.endNegativeRisePower) && rim.endNegativeRisePower > 0 && rim.endNegativeRisePower <= 10,
        'rim.endNegativeRisePower 必須是 (0,10] 範圍內的有限數值（缺少會讓 Math.pow 產生 NaN）');
    }

    const plan = shape.plan;
    req(plan && typeof plan === 'object', 'plan 缺失');
    if (plan) {
      req(isFiniteNumber(plan.cornerRoundPct) && plan.cornerRoundPct >= 0 && plan.cornerRoundPct <= 100,
        'plan.cornerRoundPct 必須是 [0,100] 範圍內的有限數值');
    }

    const shell = shape.shell;
    req(shell && typeof shell === 'object', 'shell 缺失');
    if (shell) {
      req(isPositiveFiniteNumber(shell.rimThickness), 'shell.rimThickness 必須是正的有限數值');
    }

    const sp = shape.sectionProfile;
    req(sp && typeof sp === 'object', 'sectionProfile 缺失（核心欄位，不會靜默補預設值）');
    if (sp) {
      req(sp.rowUnit === 'm', `sectionProfile.rowUnit 必須為 'm'（收到 ${JSON.stringify(sp.rowUnit)}），標明 rows 的內部單位`);
      req(isFiniteNumber(sp.rimTaperRowStart) && sp.rimTaperRowStart >= 0, 'sectionProfile.rimTaperRowStart 必須是非負有限數值');
      req(isPositiveFiniteNumber(sp.rimTaperRowSpan), 'sectionProfile.rimTaperRowSpan 必須是正的有限數值（會被當除數）');

      const cal = sp.calibration;
      req(cal && typeof cal === 'object', 'sectionProfile.calibration 缺失');
      if (cal) {
        ['baseLengthSurface', 'baseLengthDrain', 'baseWidth', 'baseHeight', 'baseRimThickness',
          'rimTaperRefLength', 'rimTaperRefWidth'].forEach((k) => {
          req(isPositiveFiniteNumber(cal[k]), `sectionProfile.calibration.${k} 必須是正的有限數值（會被當除數，0 會導致曲面除以 0）`);
        });
      }

      req(Array.isArray(sp.rows), 'sectionProfile.rows 必須是陣列');
      if (Array.isArray(sp.rows)) {
        req(sp.rows.length === EXPECTED_PROFILE_ROW_COUNT,
          `sectionProfile.rows 第一階段只支援固定 ${EXPECTED_PROFILE_ROW_COUNT} 列（收到 ${sp.rows.length} 列）；` +
          '不宣稱支援任意列數的曲面表示法');
        sp.rows.forEach((row, i) => {
          req(Array.isArray(row) && row.length === 4 && row.every(isFiniteNumber),
            `sectionProfile.rows[${i}] 必須是 4 個有限數值`);
        });
      }
    }

    const acc = shape.accessories;
    req(acc && typeof acc === 'object', 'accessories 缺失');
    if (acc) {
      const drain = acc.drain;
      req(drain && isFiniteNumber(drain.xAnchorM), 'accessories.drain.xAnchorM 必須是有限數值');
      const ov = acc.overflow;
      req(ov && typeof ov === 'object', 'accessories.overflow 缺失');
      if (ov && sp && Array.isArray(sp.rows)) {
        req(Number.isInteger(ov.rowIndex) && ov.rowIndex >= 0 && ov.rowIndex < sp.rows.length,
          `accessories.overflow.rowIndex 必須是 [0, ${sp.rows.length - 1}] 範圍內的整數`);
        req(isFiniteNumber(ov.t), 'accessories.overflow.t 必須是有限數值');
        req(isFiniteNumber(ov.tNormal), 'accessories.overflow.tNormal 必須是有限數值');
        req(isFiniteNumber(ov.theta), 'accessories.overflow.theta 必須是有限數值');
      }
    }

    return { ok: errors.length === 0, errors };
  }

  // ---------- 完整匯入：一律從全新物件建立，不沿用/合併舊 state ----------
  // 核心形狀欄位（dimensions/rim/plan/shell/sectionProfile/accessories）缺一律視為
  // 錯誤，不靜默補值，避免把「未知」誤當成「示範預設」。只有 label/sourceNote/evidence
  // 這類非幾何用途的說明欄位缺少時才補上通用預設文字。
  function loadShapeFromJSON(text) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      return { ok: false, errors: ['JSON 解析失敗：' + e.message] };
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, errors: ['根 JSON 必須是物件（收到 ' + JSON.stringify(parsed) + '）'] };
    }
    const def = defaultShape();
    const candidate = {
      schemaVersion: parsed.schemaVersion,
      unit: parsed.unit,
      label: (typeof parsed.label === 'string' && parsed.label) || '（未命名形狀）',
      sourceNote: (typeof parsed.sourceNote === 'string' && parsed.sourceNote) || '',
      dimensions: parsed.dimensions,
      rim: parsed.rim,
      plan: parsed.plan,
      shell: parsed.shell,
      sectionProfile: parsed.sectionProfile,
      accessories: parsed.accessories,
      evidence: parsed.evidence || def.evidence
    };

    const check = validateShape(candidate);
    if (!check.ok) return { ok: false, errors: check.errors };

    // schema 驗證通過後，實際建構一次幾何，確認所有頂點/法線皆為有限數，
    // 避免「JSON 格式合法」被誤當成「幾何有效」。
    let geo;
    try {
      geo = buildTubBufferGeometry(candidate);
    } catch (e) {
      return { ok: false, errors: ['幾何建構過程拋出例外：' + e.message] };
    }
    const geoCheck = checkBuiltGeometryFinite(geo);
    geo.dispose();
    if (!geoCheck.ok) return { ok: false, errors: geoCheck.errors };

    return { ok: true, shape: candidate };
  }

  global.TubGeometryLab = {
    SCHEMA_VERSION,
    EXPECTED_PROFILE_ROW_COUNT,
    defaultShape,
    buildTubBufferGeometry,
    checkBuiltGeometryFinite,
    computeDrainPosition,
    computeOverflowTransform,
    validateShape,
    loadShapeFromJSON
  };
})(window);
