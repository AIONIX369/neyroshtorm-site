/*
  Первый экран Нейрошторма: «Рождение знака в шторме» (21.10.2026).
  Шторм частиц → световой штрих ныряет в центр → знак из стекла разворачивается из глаза шторма →
  луч из звезды, частицы ложатся в орбиту. Курсор наклоняет знак и закручивает частицы.
  Прототип и варианты: studio/hero-lab/shtorm-v2.html. Бриф: docs/neyroshtorm-hero-brief-2026-10-21.md

  createHeroScene({ panel, section, mobile, motion, fine }) → { start, tick, compile } или null без WebGL.
  Холст кладётся внутрь панели первого экрана и поворачивается вместе с ней при уходе.
*/
import * as THREE from 'three';

const EDGE = 1;          // рёбра стекла: 0 - чистое стекло, 1 - светлая фаска, 2 - полуматовый металл как у робота
const MARK_HALF = 0.66;  // половина знака внутри плитки (плитка 2,2)

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const seg = (t, a, b) => clamp((t - a) / (b - a), 0, 1);
const eOut = (x) => 1 - Math.pow(1 - x, 3);
function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* Таймлайн сюжета (секунды от появления панели) */
function tl(t) {
  return {
    appear: eOut(seg(t, 1.3, 2.35)),
    alpha: seg(t, 1.3, 1.62),
    glow: 0.6 + 0.4 * eOut(seg(t, 1.8, 2.8)),
    beam: t < 2.2 ? 0 : t < 2.4 ? 1.5 * eOut(seg(t, 2.2, 2.4)) : 0.8 + 0.7 * (1 - eOut(seg(t, 2.4, 3.0))),
    flash: Math.exp(-Math.pow((t - 1.43) / 0.11, 2)),
    live: seg(t, 2.6, 3.8),
    haze: eOut(seg(t, 1.2, 2.6)),
  };
}

export function createHeroScene({ panel, section, mobile = false, motion = true, fine = true }) {
  const canvas = document.createElement('canvas');
  canvas.className = 'hero-gl';
  canvas.setAttribute('aria-hidden', 'true');
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance' });
  } catch (e) { return null; }
  panel.prepend(canvas);
  renderer.setClearColor(0x0C0A12, 1);
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.autoClear = false;

  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
  const rt = new THREE.WebGLRenderTarget(4, 4, { depthBuffer: false });
  const sceneB = new THREE.Scene(); // фон и всё, что за знаком (видно сквозь стекло)
  const sceneF = new THREE.Scene(); // копия заднего слоя, знак, всё, что перед знаком, луч
  const m3 = (x, y, z) => new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(x, y, z)));

  const U = {
    uT: { value: 0 }, uRes: { value: new THREE.Vector2(1, 1) }, uDist: { value: 10 },
    uStormRot: { value: m3(0.62, -0.2, 0.3) }, uRingRot: { value: m3(1.2, 0.05, 0.2) },
    uCenterZ: { value: -10 }, uMouseW: { value: new THREE.Vector3(99, 99, 0) }, uMouseStr: { value: 0 },
    uLeft: { value: new THREE.Vector2(-0.55, 0.08) }, uSize: { value: 2.2 }, uAlpha: { value: 0.8 },
    uObjMat: { value: new THREE.Matrix4() }, uObjInv: { value: new THREE.Matrix4() }, uObjPos: { value: new THREE.Vector3() },
    uBeam: { value: 0 }, uFlash: { value: 0 }, uGlow: { value: 0.6 }, uHaze: { value: 0 }, uAppear: { value: 0 }, uEdge: { value: EDGE },
    uPix: { value: 0.001 }, uSteps: { value: mobile ? 64 : 96 }, uStepsIn: { value: mobile ? 20 : 32 },
    uBehind: { value: rt.texture }, uMarkTex: { value: makeMarkTexture(1024) }, uMarkHalf: { value: MARK_HALF },
    uStarPx: { value: new THREE.Vector2() }, uBeamDir: { value: new THREE.Vector2(-0.82, 0.57) },
  };

  const COMMON = /* glsl */`
    float spin(float t) {
      float vS = 1.55, vI = 0.16, tau = 0.95, t0 = 1.15;
      return vI * t + (vS - vI) * (min(t, t0) + tau * (1.0 - exp(-max(t - t0, 0.0) / tau)));
    }`;
  const QUAD_VS = /* glsl */`void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`;
  const DASH_FS = /* glsl */`
    varying vec4 vCol; varying float vAng, vAsp;
    void main() {
      vec2 q = gl_PointCoord * 2.0 - 1.0; q.y = -q.y;
      float c = cos(vAng), s = sin(vAng);
      vec2 r = vec2(c * q.x + s * q.y, -s * q.x + c * q.y);
      float d = length(vec2(r.x, r.y * vAsp));
      float a = 1.0 - smoothstep(0.25, 1.0, d);
      if (a < 0.01) discard;
      gl_FragColor = vec4(vCol.rgb, vCol.a * a);
    }`;
  const add = { transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending };
  const quad = new THREE.PlaneGeometry(2, 2);

  /* Фон: градиент панели сайта, как в CSS --panel, и мягкая дымка за знаком */
  const bg = new THREE.Mesh(quad, new THREE.ShaderMaterial({
    uniforms: U, vertexShader: QUAD_VS, depthTest: false, depthWrite: false,
    fragmentShader: /* glsl */`
      uniform vec2 uRes, uStarPx; uniform float uHaze, uT;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
      void main() {
        vec2 fc = gl_FragCoord.xy;
        float r = length((fc - uStarPx) / uRes.y);
        vec2 uv = fc / uRes;
        // radial-gradient(120% 90% at 70% 110%, #F3A6D8 0%, #6E55FF 38%, #2A1C7A 70%, #0C0A12 100%)
        float d = length((vec2(uv.x, 1.0 - uv.y) - vec2(0.70, 1.10)) / vec2(1.20, 0.90));
        vec3 c0 = vec3(0.953, 0.651, 0.847), c1 = vec3(0.431, 0.333, 1.0), c2 = vec3(0.165, 0.110, 0.478), c3 = vec3(0.047, 0.039, 0.071);
        vec3 col = d < 0.38 ? mix(c0, c1, d / 0.38) : (d < 0.70 ? mix(c1, c2, (d - 0.38) / 0.32) : mix(c2, c3, clamp((d - 0.70) / 0.30, 0.0, 1.0)));
        col += vec3(0.20, 0.13, 0.55) * 0.22 * uHaze * exp(-r * r * 6.0);
        col += (hash(fc + fract(uT * 7.0) * 100.0) - 0.5) / 255.0;
        gl_FragColor = vec4(col, 1.0);
      }`,
  }));
  bg.frustumCulled = false; bg.renderOrder = 0; sceneB.add(bg);

  /* Частицы шторма: 58 % втягиваются в знак, остальные ложатся в орбиту */
  const NP = mobile ? 3600 : 9000;
  const r1 = rng(7);
  const pPos = new Float32Array(NP * 3), pB = new Float32Array(NP * 3);
  for (let i = 0; i < NP; i++) {
    pPos[i * 3] = r1(); pPos[i * 3 + 1] = r1(); pPos[i * 3 + 2] = r1();
    pB[i * 3] = r1(); pB[i * 3 + 1] = r1() < 0.58 ? 0 : 1; pB[i * 3 + 2] = r1();
  }
  const pGeo = new THREE.BufferGeometry();
  pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
  pGeo.setAttribute('aB', new THREE.BufferAttribute(pB, 3));
  const P_VS = /* glsl */`
    uniform float uT, uSide, uCenterZ, uMouseStr, uSize, uDist, uAlpha;
    uniform vec2 uRes, uLeft;
    uniform vec3 uMouseW;
    uniform mat3 uStormRot, uRingRot;
    attribute vec3 aB;
    varying vec4 vCol; varying float vAng, vAsp;
    ${COMMON}
    vec3 ppos(float t, out float alpha, out float bright) {
      float sx = position.x, sy = position.y, sz = position.z, sw = aB.x;
      float r0 = mix(0.75, 2.8, pow(sx, 0.75));
      float w = 2.1 / (0.55 + r0);
      float arm = floor(sy * 3.0);
      float ang0 = fract(sy * 13.7) < 0.62 ? arm * 2.0944 + 2.3 * log(r0) + (fract(sy * 3.0) - 0.5) * 1.1 : sy * 6.2831853;
      float ang = ang0 + spin(t) * w;
      float z = (sz - 0.5) * 0.35 - 0.6 * (2.8 - r0) / 2.05;
      alpha = smoothstep(0.0, 0.45, t - sw * 0.35);
      bright = 1.0;
      if (aB.y < 0.5) {
        float c = clamp((t - (0.9 + sw * 0.75)) / (0.45 + sz * 0.3), 0.0, 1.0);
        float r = r0 * (1.0 - c * c * c);
        ang += 3.5 * c * c;
        alpha *= 1.0 - smoothstep(0.72, 1.0, c);
        bright = 1.0 + 1.8 * c;
        return uStormRot * vec3(cos(ang) * r, sin(ang) * r, z * (1.0 - c));
      }
      float g = smoothstep(1.85 + sw * 0.5, 2.9 + sw * 0.45, t);
      float rr = 1.98 + (sx - 0.5) * 0.5 + (sz - 0.5) * 0.14;
      vec3 a = vec3(cos(ang) * r0, sin(ang) * r0, z);
      vec3 b = vec3(cos(ang) * rr, sin(ang) * rr, (sz - 0.5) * 0.09);
      alpha *= mix(1.0, 1.25, g);
      bright = mix(1.0, 1.45, g);
      return mix(uStormRot * a, uRingRot * b, g);
    }
    void main() {
      float a, br, a0, br0;
      vec3 p = ppos(uT, a, br);
      vec3 p0 = ppos(uT - 0.035, a0, br0);
      vec2 dv = p.xy - uMouseW.xy;
      float f = exp(-dot(dv, dv) / 0.5) * uMouseStr;
      vec2 dn = dv / max(length(dv), 1e-3);
      p.xy += (dn * 0.20 + vec2(-dn.y, dn.x) * 0.32) * f;
      vec4 mv = viewMatrix * vec4(p, 1.0);
      float side = (mv.z - uCenterZ) >= 0.0 ? 1.0 : -1.0;
      if (side != uSide || a < 0.004) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
      vec4 cp = projectionMatrix * mv;
      vec4 cp0 = projectionMatrix * viewMatrix * vec4(p0, 1.0);
      vec2 vel = (cp.xy / cp.w - cp0.xy / cp0.w) * uRes * 0.5;
      float ringK = aB.y > 0.5 ? smoothstep(1.85 + aB.x * 0.5, 2.9 + aB.x * 0.45, uT) : 0.0;
      float base = uSize * mix(0.7, 1.5, aB.z) * (1.0 + 0.45 * ringK);
      float len = clamp(length(vel) * 0.9, base, base * 6.0);
      gl_PointSize = len;
      vAsp = len / base;
      vAng = atan(vel.y, vel.x);
      float df = clamp(1.0 - (-mv.z - uDist) * 0.16, 0.4, 1.15);
      float lf = smoothstep(uLeft.x, uLeft.y, cp.x / cp.w);
      float h = fract(position.x * 7.13 + aB.z * 3.17);
      vec3 col = h < 0.42 ? vec3(0.43, 0.33, 1.0) : (h < 0.68 ? vec3(1.0, 0.31, 0.68) : (h < 0.9 ? vec3(0.66, 0.61, 1.0) : vec3(0.95, 0.92, 1.0)));
      col = mix(col, vec3(0.92, 0.88, 1.0), 0.35);   // на ярком градиенте светлее
      float tw = aB.y > 0.5 ? (0.75 + 0.25 * sin(uT * 2.6 + aB.z * 40.0)) : 1.0;
      vCol = vec4(col * br, a * df * lf * tw * uAlpha);
      gl_Position = cp;
    }`;
  const mkPoints = (side, order, scene) => {
    const m = new THREE.Points(pGeo, new THREE.ShaderMaterial({ uniforms: { ...U, uSide: { value: side } }, vertexShader: P_VS, fragmentShader: DASH_FS, ...add }));
    m.frustumCulled = false; m.renderOrder = order; scene.add(m); return m;
  };
  mkPoints(-1, 2, sceneB);
  mkPoints(1, 3, sceneF);

  /* Тонкие стеклянные ленты шторма */
  const r2 = rng(11), NR = mobile ? 14 : 22, RS = 64, rCount = NR * (RS + 1) * 2;
  const rArc = new Float32Array(rCount * 4), rS = new Float32Array(rCount), rSide = new Float32Array(rCount), rIdx = [];
  let vi = 0;
  for (let a = 0; a < NR; a++) {
    const arc = [0.9 + r2() * 2.1, r2() * Math.PI * 2, 0.7 + r2() * 1.7, r2()];
    for (let s = 0; s <= RS; s++) for (const sd of [-1, 1]) { rArc.set(arc, vi * 4); rS[vi] = s / RS; rSide[vi] = sd; vi++; }
    const base = a * (RS + 1) * 2;
    for (let s = 0; s < RS; s++) { const i = base + s * 2; rIdx.push(i, i + 1, i + 2, i + 1, i + 3, i + 2); }
  }
  const rGeo = new THREE.BufferGeometry();
  rGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(rCount * 3), 3));
  rGeo.setAttribute('aArc', new THREE.BufferAttribute(rArc, 4));
  rGeo.setAttribute('aS', new THREE.BufferAttribute(rS, 1));
  rGeo.setAttribute('aSide', new THREE.BufferAttribute(rSide, 1));
  rGeo.setIndex(rIdx);
  const ribbons = new THREE.Mesh(rGeo, new THREE.ShaderMaterial({
    uniforms: U, ...add,
    vertexShader: /* glsl */`
      uniform float uT; uniform mat3 uStormRot; uniform vec2 uLeft;
      attribute vec4 aArc; attribute float aS, aSide;
      varying float vA, vE;
      ${COMMON}
      void main() {
        float r0 = aArc.x, w = 2.1 / (0.55 + r0);
        float ang = aArc.y + aS * aArc.z + spin(uT) * w;
        float c = clamp((uT - 0.85 - aArc.w * 0.45) / 0.8, 0.0, 1.0);
        float r = r0 * (1.0 + 0.10 * aS) * (1.0 - c * c * c);
        ang += 3.0 * c * c;
        float z = -0.6 * (3.1 - r0) / 2.3 * (1.0 - c) + (aArc.w - 0.5) * 0.2;
        vec3 rad = vec3(cos(ang), sin(ang), 0.0);
        vec3 p = uStormRot * (vec3(rad.xy * r, z) + rad * aSide * (0.006 + 0.012 * aArc.w));
        vA = pow(sin(3.14159 * aS), 1.5) * (1.0 - smoothstep(0.6, 1.0, c)) * smoothstep(0.0, 0.6, uT) * 0.5;
        vE = aSide;
        vec4 cp = projectionMatrix * viewMatrix * vec4(p, 1.0);
        vA *= smoothstep(uLeft.x, uLeft.y, cp.x / cp.w);
        gl_Position = cp;
      }`,
    fragmentShader: /* glsl */`
      varying float vA, vE;
      void main() { gl_FragColor = vec4(vec3(0.78, 0.74, 1.0), vA * (1.0 - abs(vE) * 0.6)); }`,
  }));
  ribbons.frustumCulled = false; ribbons.renderOrder = 1; sceneB.add(ribbons);

  /* Световой штрих: в шторме бежит по кругу и ныряет в центр, потом изредка пробегает по орбите */
  const CS = 140, cS = new Float32Array((CS + 1) * 2), cSide = new Float32Array((CS + 1) * 2), cIdx = [];
  for (let s = 0; s <= CS; s++) for (let k = 0; k < 2; k++) { cS[s * 2 + k] = s / CS; cSide[s * 2 + k] = k ? 1 : -1; }
  for (let s = 0; s < CS; s++) { const i = s * 2; cIdx.push(i, i + 1, i + 2, i + 1, i + 3, i + 2); }
  const cGeo = new THREE.BufferGeometry();
  cGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(cS.length * 3), 3));
  cGeo.setAttribute('aS', new THREE.BufferAttribute(cS, 1));
  cGeo.setAttribute('aSide', new THREE.BufferAttribute(cSide, 1));
  cGeo.setIndex(cIdx);
  const C_VS = /* glsl */`
    uniform float uT, uW, uA; uniform mat3 uStormRot, uRingRot;
    attribute float aS, aSide;
    varying float vA, vE, vVZ, vS;
    vec3 stormC(float t) {
      float k = clamp((t - 0.70) / 0.74, 0.0, 1.0);
      float r = 2.35 * (1.0 - k * k * k) * (1.0 + 0.04 * sin(t * 3.0));
      float a = 0.5 + 5.0 * t + 7.0 * k * k;
      return uStormRot * vec3(cos(a) * r, sin(a) * r, -0.2 * k);
    }
    vec3 ringC(float u) { float a = -0.6 + u * 4.0; return uRingRot * vec3(cos(a) * 2.0, sin(a) * 2.0, 0.0); }
    void main() {
      vec3 p, p2; float env;
      if (uT < 2.0) {
        float tau = max(uT - aS * 0.45, 0.0);
        p = stormC(tau); p2 = stormC(tau + 0.006);
        env = smoothstep(0.02, 0.3, uT) * (1.0 - smoothstep(1.32, 1.46, uT));
      } else {
        float u = mod(uT - 3.6, 7.5);
        float tu = max(u - aS * 0.34, 0.0);
        p = ringC(tu); p2 = ringC(tu + 0.006);
        env = step(3.6, uT) * sin(3.14159 * clamp(u / 1.9, 0.0, 1.0)) * 0.7;
      }
      vec3 T = normalize(p2 - p + 1e-6);
      vec3 S = normalize(cross(T, normalize(cameraPosition - p)));
      float w = uW * pow(1.0 - aS, 1.2) + 0.002;
      vec4 mv = viewMatrix * vec4(p + S * aSide * w, 1.0);
      vVZ = mv.z; vE = aSide; vS = aS;
      vA = env * pow(1.0 - aS, 1.6) * uA;
      gl_Position = projectionMatrix * mv;
    }`;
  const C_FS = /* glsl */`
    uniform float uSide, uCenterZ, uHalo;
    varying float vA, vE, vVZ, vS;
    void main() {
      if ((vVZ - uCenterZ) * uSide < 0.0) discard;
      float e = 1.0 - abs(vE);
      vec3 col = uHalo > 0.5 ? vec3(0.55, 0.45, 1.0) : mix(vec3(1.0, 0.98, 1.0), vec3(0.66, 0.56, 1.0), smoothstep(0.0, 0.8, vS));
      float a = vA * (uHalo > 0.5 ? e * e : smoothstep(0.0, 0.6, e));
      gl_FragColor = vec4(col, a);
    }`;
  const comets = [];
  const mkComet = (side, halo, order, scene) => {
    const m = new THREE.Mesh(cGeo, new THREE.ShaderMaterial({
      uniforms: { ...U, uSide: { value: side }, uHalo: { value: halo }, uW: { value: halo ? 0.13 : 0.022 }, uA: { value: halo ? 0.22 : 1.0 } },
      vertexShader: C_VS, fragmentShader: C_FS, ...add, side: THREE.DoubleSide,
    }));
    m.frustumCulled = false; m.renderOrder = order; scene.add(m); comets.push(m);
  };
  mkComet(-1, 1, 3, sceneB); mkComet(-1, 0, 4, sceneB);
  mkComet(1, 1, 4, sceneF); mkComet(1, 0, 5, sceneF);

  /* Копия заднего слоя на экран */
  const blit = new THREE.Mesh(quad, new THREE.ShaderMaterial({
    uniforms: U, vertexShader: QUAD_VS, depthTest: false, depthWrite: false,
    fragmentShader: /* glsl */`
      uniform sampler2D uBehind; uniform vec2 uRes;
      void main() { gl_FragColor = texture2D(uBehind, gl_FragCoord.xy / uRes); }`,
  }));
  blit.frustumCulled = false; blit.renderOrder = 0; sceneF.add(blit);

  /* Знак из стекла: трассировка поля расстояний, преломление заднего слоя, знак светится внутри */
  const glass = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShaderMaterial({
    uniforms: U, transparent: true, depthTest: false, depthWrite: false,
    vertexShader: /* glsl */`
      uniform vec3 uObjPos;
      uniform mat4 uObjMat;
      varying vec3 vW;
      void main() {
        vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
        vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
        float sc = length(uObjMat[0].xyz);
        vec3 wp = uObjPos + (right * position.x + up * position.y) * 4.4 * sc;
        vW = wp;
        gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
      }`,
    fragmentShader: /* glsl */`
      precision highp float;
      uniform sampler2D uBehind, uMarkTex;
      uniform vec2 uRes;
      uniform mat4 uObjMat, uObjInv;
      uniform float uBeam, uT, uPix, uSteps, uStepsIn, uMarkHalf, uGlow, uAppear, uEdge;
      varying vec3 vW;

      float sdRR(vec2 p, vec2 b, float r) { vec2 q = abs(p) - b + r; return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r; }
      // плитка знака: 2,2 x 2,2 x 0,68, скругление углов 0,36, рёбер 0,15
      float map(vec3 p) {
        const float re = 0.15;
        float d2 = sdRR(p.xy, vec2(1.1 - re), 0.36 - re);
        vec2 w = vec2(d2, abs(p.z) - (0.34 - re));
        return min(max(w.x, w.y), 0.0) + length(max(w, 0.0)) - re;
      }
      vec3 nrm(vec3 p) {
        const vec2 e = vec2(1.0, -1.0) * 0.0015;
        return normalize(e.xyy * map(p + e.xyy) + e.yyx * map(p + e.yyx) + e.yxy * map(p + e.yxy) + e.xxx * map(p + e.xxx));
      }
      // студийное окружение: софтбоксы дают чистые блики на рёбрах
      float box(vec3 d, vec3 L, vec3 U, vec2 sz, float soft) {
        float f = dot(d, L); if (f <= 0.0) return 0.0;
        vec3 R = normalize(cross(L, U)); vec3 V = cross(R, L);
        vec2 q = vec2(dot(d, R), dot(d, V)) / f;
        vec2 e = abs(q) - sz;
        return 1.0 - smoothstep(-soft, soft, max(e.x, e.y));
      }
      vec3 env(vec3 d) {
        vec3 c = vec3(0.022, 0.018, 0.045) + vec3(0.09, 0.06, 0.22) * smoothstep(-0.2, 1.0, d.y) * 0.6;
        c += vec3(1.0, 0.97, 1.0) * 2.0 * box(d, normalize(vec3(-0.55, 0.6, 0.6)), vec3(0.0, 1.0, 0.0), vec2(0.45, 0.2), 0.08);
        c += vec3(0.8, 0.76, 1.0) * 1.2 * box(d, normalize(vec3(0.1, 0.97, 0.2)), vec3(0.0, 0.0, -1.0), vec2(1.1, 0.07), 0.04);
        c += vec3(0.43, 0.33, 1.0) * 1.6 * box(d, normalize(vec3(0.95, 0.1, 0.3)), vec3(0.0, 1.0, 0.0), vec2(0.16, 0.7), 0.1);
        c += vec3(1.0, 0.31, 0.68) * 1.5 * box(d, normalize(vec3(0.4, -0.8, 0.45)), vec3(1.0, 0.0, 0.0), vec2(0.6, 0.25), 0.15);
        c += vec3(0.85, 0.8, 1.0) * 1.1 * box(d, normalize(vec3(0.55, 0.5, 0.7)), vec3(0.0, 1.0, 0.0), vec2(0.5, 0.28), 0.12);
        c += vec3(0.62, 0.42, 1.0) * 1.0 * box(d, normalize(vec3(-0.95, 0.05, 0.3)), vec3(0.0, 1.0, 0.0), vec2(0.12, 0.8), 0.08);
        c += vec3(0.30, 0.26, 0.55) * 0.35 * smoothstep(0.2, 1.0, d.z);
        c += vec3(1.0, 0.98, 1.0) * 1.5 * box(d, normalize(vec3(-0.35, 0.35, 0.87)), vec3(0.0, 1.0, 0.0), vec2(0.22, 0.10), 0.06);
        return c;
      }
      vec3 envC(vec3 d) {   // «хромовое» окружение для подсветки рёбер: небо, резкий горизонт, земля
        vec3 sky = mix(vec3(0.92, 0.90, 0.98), vec3(0.34, 0.32, 0.46), smoothstep(0.06, 0.7, d.y));
        vec3 gnd = mix(vec3(0.045, 0.04, 0.075), vec3(0.24, 0.19, 0.36), smoothstep(-0.1, -0.75, d.y));
        return mix(gnd, sky, smoothstep(0.03, 0.08, d.y)) + env(d) * 0.8;
      }
      vec3 envM(vec3 d) {   // полуматовый металл, как у робота: размытое окружение, мягкие блики
        vec3 c = mix(vec3(0.24, 0.23, 0.30), vec3(0.86, 0.85, 0.92), smoothstep(-0.6, 0.7, d.y));
        c += vec3(0.95, 0.93, 1.0) * 0.55 * box(d, normalize(vec3(-0.55, 0.6, 0.6)), vec3(0.0, 1.0, 0.0), vec2(0.6, 0.35), 0.45);
        c += vec3(0.55, 0.45, 1.0) * 0.35 * box(d, normalize(vec3(0.95, 0.1, 0.3)), vec3(0.0, 1.0, 0.0), vec2(0.3, 0.9), 0.45);
        c += vec3(1.0, 0.45, 0.75) * 0.25 * box(d, normalize(vec3(0.4, -0.8, 0.45)), vec3(1.0, 0.0, 0.0), vec2(0.7, 0.4), 0.45);
        return c;
      }
      vec3 irid(float x) { return 0.5 + 0.5 * cos(6.2831 * (vec3(0.0, 0.33, 0.67) + x)); }
      // знак внутри стекла: R - знак, G - звезда, B - ореол
      vec4 markTex(vec2 xy, float lod) {
        float H = uMarkHalf / 0.7;
        return textureLod(uMarkTex, vec2(0.5 + xy.x / (2.0 * H), 0.5 - xy.y / (2.0 * H)), lod);
      }

      void main() {
        vec3 ro = cameraPosition;
        vec3 rd = normalize(vW - ro);
        vec3 o = (uObjInv * vec4(ro, 1.0)).xyz;
        vec3 d = normalize((uObjInv * vec4(rd, 0.0)).xyz);
        float b = dot(o, d), c = dot(o, o) - 1.75 * 1.75, h = b * b - c;
        if (h < 0.0) discard;
        h = sqrt(h);
        float t = max(-b - h, 0.0), tEnd = -b + h;
        float minR = 1e9, tMin = t; bool hit = false;
        for (int i = 0; i < 110; i++) {
          if (float(i) >= uSteps) break;
          float dist = map(o + d * t);
          float pr = t * uPix;
          float r = dist / pr;
          if (r < minR) { minR = r; tMin = t; }
          if (dist < 0.3 * pr) { hit = true; break; }
          t += dist * 0.85;
          if (t > tEnd) break;
        }
        float cov = 1.0;
        if (!hit) { cov = 1.0 - smoothstep(0.3, 1.4, minR); if (cov < 0.01) discard; t = tMin; }
        vec3 p = o + d * t;
        vec3 n = nrm(p);
        mat3 M = mat3(uObjMat);
        float cosv = clamp(dot(-d, n), 0.0, 1.0);
        vec3 nW = normalize(M * n);
        float F = 0.045 + 0.955 * pow(1.0 - cosv, 5.0);
        vec3 refl = env(reflect(rd, nW));
        // путь внутри стекла
        vec3 di = refract(d, n, 1.0 / 1.45);
        if (dot(di, di) < 0.01) di = d;
        float tt = 0.03;
        for (int j = 0; j < 40; j++) {
          if (float(j) >= uStepsIn) break;
          float dist = -map(p + di * tt);
          if (dist < 0.002) break;
          tt += max(dist * 0.9, 0.012);
        }
        vec3 q = p + di * tt;
        vec3 n2 = nrm(q);
        vec3 dout = refract(di, -n2, 1.45);
        if (dot(dout, dout) < 0.01) dout = reflect(di, -n2);
        vec3 doutW = normalize(M * dout);
        float lod = clamp(log2(max(t * uPix, 1e-5) / (2.0 * uMarkHalf / 0.7 / 1024.0)), 0.0, 6.0);
        vec3 mark = vec3(0.0);
        if (abs(di.z) > 1e-4) {
          float s = -p.z / di.z;
          if (s > 0.0 && s < tt) {
            vec2 mxy = (p + di * s).xy;
            vec4 m = markTex(mxy, lod);
            vec3 body = mix(vec3(0.66, 0.60, 1.0), vec3(0.97, 0.95, 1.0), smoothstep(-0.7, 0.8, mxy.y / uMarkHalf));
            mark = body * m.r * 0.9 + vec3(0.48, 0.38, 1.0) * m.b * (1.0 - m.r) * 0.45 + vec3(0.78, 0.72, 1.0) * m.g * uBeam * 0.28;
          }
        }
        float scat = markTex(p.xy, 4.0).b;
        vec2 suv = gl_FragCoord.xy / uRes;
        vec2 off = (doutW.xy - rd.xy) * 0.10;
        vec3 beh = vec3(texture2D(uBehind, suv + off).r, texture2D(uBehind, suv + off * 1.07).g, texture2D(uBehind, suv + off * 1.14).b);
        vec3 absorb = exp(-tt * vec3(0.38, 0.62, 0.16));
        vec3 bodyC = vec3(0.13, 0.085, 0.34) * (1.0 - exp(-tt * 0.7)) * (0.55 + 0.45 * uGlow);
        vec3 inner = mix(vec3(0.42, 0.30, 1.0), vec3(1.0, 0.30, 0.66), smoothstep(0.2, -1.1, q.y)) * 0.20 * tt * uGlow;
        vec3 trans = beh * absorb + env(doutW) * 0.25 * absorb + bodyC + inner + vec3(0.55, 0.45, 1.0) * scat * 0.35 + mark;
        vec3 col = mix(trans, refl, F);
        col += irid(0.15 + (1.0 - cosv) * 1.3) * vec3(0.8, 0.7, 1.0) * pow(1.0 - cosv, 3.0) * 0.30;
        col += vec3(0.78, 0.72, 1.0) * pow(1.0 - cosv, 4.0) * 0.35;
        // подсветка рёбер: скругления и бока отражают «хромовое» окружение, светлая фаска по контуру
        float ez = 1.0 - abs(n.z);
        if (uEdge > 1.5) {
          // режим 2: периметр - полуматовый металл, как у робота; тонкий шов отделяет его от стекла
          vec3 mC = envM(reflect(rd, nW)) * vec3(0.92, 0.91, 0.96);
          col = mix(col, mC, smoothstep(0.10, 0.22, ez));
          col *= 1.0 - 0.35 * smoothstep(0.05, 0.09, ez) * (1.0 - smoothstep(0.09, 0.13, ez));
        } else if (uEdge > 0.5) {
          // режим 1: рёбра отражают «хромовое» окружение, светлая фаска по контуру
          float edgeK = smoothstep(0.12, 0.85, ez);
          vec3 eC = max(envC(reflect(rd, nW)), vec3(0.34, 0.29, 0.52));
          col = mix(col, eC * vec3(0.96, 0.94, 1.0), edgeK * 0.85);
          float bevel = smoothstep(0.04, 0.22, ez) * (1.0 - smoothstep(0.45, 0.85, ez));
          col += vec3(0.92, 0.88, 1.0) * bevel * 0.38;
        }
        gl_FragColor = vec4(col, cov * uAppear);
      }`,
  }));
  glass.frustumCulled = false; glass.renderOrder = 1; sceneF.add(glass);

  /* Искры: вспышка рождения знака, разлетаются в плоскости вихря */
  const NS = mobile ? 160 : 320, r3 = rng(23);
  const sP = new Float32Array(NS * 3), sV = new Float32Array(NS * 3), sB = new Float32Array(NS * 3);
  for (let i = 0; i < NS; i++) {
    const a = r3() * Math.PI * 2, rr = r3() * 0.25, sp = 1.6 + r3() * 2.4;
    sP.set([Math.cos(a) * rr, Math.sin(a) * rr, (r3() - 0.5) * 0.1], i * 3);
    sV.set([Math.cos(a) * sp, Math.sin(a) * sp, (r3() - 0.5) * 0.8], i * 3);
    sB.set([1.38 + r3() * 0.2, 0.45 + r3() * 0.45, r3()], i * 3);
  }
  const sGeo = new THREE.BufferGeometry();
  sGeo.setAttribute('position', new THREE.BufferAttribute(sP, 3));
  sGeo.setAttribute('aV', new THREE.BufferAttribute(sV, 3));
  sGeo.setAttribute('aB', new THREE.BufferAttribute(sB, 3));
  const sparks = new THREE.Points(sGeo, new THREE.ShaderMaterial({
    uniforms: U, ...add, fragmentShader: DASH_FS,
    vertexShader: /* glsl */`
      uniform float uT, uSize; uniform vec2 uRes; uniform mat3 uStormRot;
      attribute vec3 aV, aB;
      varying vec4 vCol; varying float vAng, vAsp;
      vec3 sp(float age) { float k = 1.0 - exp(-age * 3.2); return position + aV * k / 3.2; }
      void main() {
        float age = uT - aB.x;
        if (age < 0.0 || age > aB.y) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
        vec4 cp = projectionMatrix * viewMatrix * vec4(uStormRot * sp(age), 1.0);
        vec4 cp0 = projectionMatrix * viewMatrix * vec4(uStormRot * sp(max(age - 0.03, 0.0)), 1.0);
        vec2 vel = (cp.xy / cp.w - cp0.xy / cp0.w) * uRes * 0.5;
        float base = uSize * 1.1;
        float len = clamp(length(vel), base, base * 8.0);
        gl_PointSize = len; vAsp = len / base; vAng = atan(vel.y, vel.x);
        vec3 col = mix(vec3(1.0, 0.92, 1.0), vec3(1.0, 0.35, 0.72), aB.z);
        vCol = vec4(col * 1.8, pow(1.0 - age / aB.y, 1.3));
        gl_Position = cp;
      }`,
  }));
  sparks.frustumCulled = false; sparks.renderOrder = 6; sceneF.add(sparks);

  /* Луч из звезды и вспышка в момент, когда штрих ныряет в центр */
  const beam = new THREE.Mesh(quad, new THREE.ShaderMaterial({
    uniforms: U, vertexShader: QUAD_VS, ...add,
    fragmentShader: /* glsl */`
      uniform vec2 uRes, uStarPx, uBeamDir; uniform float uBeam, uFlash, uT;
      float n1(float x) { return 0.5 + 0.25 * sin(x) + 0.15 * sin(x * 2.31 + 1.3) + 0.10 * sin(x * 5.17 + 0.7); }
      void main() {
        vec2 p = (gl_FragCoord.xy - uStarPx) / uRes.y;
        float r = length(p);
        float a = atan(p.y, p.x), ba = atan(uBeamDir.y, uBeamDir.x);
        float da = abs(mod(a - ba + 3.14159, 6.28318) - 3.14159);
        float cone = 1.0 - smoothstep(0.0, 0.42, da); cone *= cone;
        float rays = n1(a * 34.0 + uT * 0.4) * n1(a * 13.0 - uT * 0.25 + 2.0);
        float bm = cone * (0.35 + 0.9 * rays) * exp(-r * 1.5) * smoothstep(0.0, 0.05, r);
        float core = exp(-r * r * 1400.0) + 0.35 * exp(-r * r * 90.0);
        vec3 col = vec3(0.86, 0.83, 1.0) * bm * uBeam * 0.48 + vec3(0.96, 0.93, 1.0) * core * (uBeam * 0.55 + uFlash * 1.8);
        gl_FragColor = vec4(col, 1.0);
      }`,
  }));
  beam.frustumCulled = false; beam.renderOrder = 9; sceneF.add(beam);

  /* ---------- Размеры: центр сцены справа на десктопе, по центру между текстом на телефоне ---------- */
  let W = 0, H = 0, BW = 1, BH = 1, CX = 0.665, CY = 0.5, DIST = 10;
  let DPR = Math.min(window.devicePixelRatio || 1, mobile ? 1.25 : 1.5);
  let dirty = true;
  const bsz = new THREE.Vector2();
  function layout(force) {
    const w = panel.offsetWidth, h = panel.offsetHeight;   // без transform: панель крутится при уходе
    if (!w || !h) return false;
    if (!force && W && w === W && (mobile || h === H)) return true;
    W = w; H = h;
    const asp = W / H, wide = asp > 0.95;
    CX = wide ? (asp > 1.5 ? 0.665 : 0.64) : 0.5;
    CY = wide ? 0.5 : 0.44;
    DIST = wide ? (asp > 1.5 ? 10 : 11.2) : clamp(4.8 / (0.536 * asp), 12, 22);
    renderer.setPixelRatio(DPR);
    renderer.setSize(W, H, false);
    renderer.getDrawingBufferSize(bsz); BW = bsz.x; BH = bsz.y;
    rt.setSize(BW, BH);
    U.uRes.value.set(BW, BH);
    camera.aspect = asp;
    camera.setViewOffset(W, H, W * (0.5 - CX), H * (0.5 - CY), W, H);
    camera.position.set(0, 0, DIST);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    U.uPix.value = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / BH;
    U.uLeft.value.set(wide ? -0.55 : -3, wide ? 0.08 : -2.9);
    U.uDist.value = DIST;
    U.uSize.value = 2.1 * DPR;
    dirty = true;
    return true;
  }
  new ResizeObserver(() => layout(false)).observe(panel);

  /* ---------- Курсор ---------- */
  const mouse = { tx: 0, ty: 0, px: -1, py: -1, last: -99 };
  const st = { tiltX: 0, tiltY: 0, mStr: 0 };
  const nowS = () => performance.now() / 1000;
  if (fine && motion) addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch') return;
    const r = panel.getBoundingClientRect();
    mouse.px = e.clientX - r.left; mouse.py = e.clientY - r.top;
    mouse.tx = clamp((mouse.px - W * CX) / (W * 0.5), -1, 1);
    mouse.ty = clamp((mouse.py - H * CY) / (H * 0.5), -1, 1);
    mouse.last = nowS();
  }, { passive: true });
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0), hitP = new THREE.Vector3();
  function step(dt) {
    const k = 1 - Math.exp(-4.5 * dt);
    const active = nowS() - mouse.last < 1.6;
    st.tiltX += ((active ? mouse.tx * 0.38 : 0) - st.tiltX) * k;
    st.tiltY += ((active ? mouse.ty * 0.26 : 0) - st.tiltY) * k;
    st.mStr += ((active ? 1 : 0) - st.mStr) * (1 - Math.exp(-3 * dt));
  }

  /* ---------- Кадр ---------- */
  const objMat = new THREE.Matrix4(), objInv = new THREE.Matrix4(), quat = new THREE.Quaternion(), eu = new THREE.Euler();
  const objPos = new THREE.Vector3(), objScale = new THREE.Vector3(1, 1, 1), v3 = new THREE.Vector3();
  function draw(t) {
    const s = tl(t);
    // знак разворачивается из ребра к зрителю и растёт; потом живёт и следит за курсором
    const turn = 1 - s.appear;
    const tf = 0.35 + 0.65 * s.live;
    const rx = -0.10 + 0.25 * turn + st.tiltY * tf + 0.03 * Math.sin(t * 0.7) * s.live;
    const ry = 0.34 - 1.75 * turn + st.tiltX * tf + 0.07 * Math.sin(t * 0.45) * s.live;
    objPos.set(0, 0.045 * Math.sin(t * 1.1) * s.live, 0);
    objScale.setScalar(Math.max(0.3 + 0.7 * s.appear, 0.001));
    objMat.compose(objPos, quat.setFromEuler(eu.set(rx, ry, 0)), objScale);
    objInv.copy(objMat).invert();
    U.uObjMat.value.copy(objMat); U.uObjInv.value.copy(objInv); U.uObjPos.value.copy(objPos);

    v3.copy(objPos).project(camera);
    U.uStarPx.value.set((v3.x * 0.5 + 0.5) * BW, (v3.y * 0.5 + 0.5) * BH);
    v3.copy(objPos).applyMatrix4(camera.matrixWorldInverse);
    U.uCenterZ.value = v3.z;

    if (mouse.px >= 0) {
      ndc.set((mouse.px / W) * 2 - 1, -(mouse.py / H) * 2 + 1);
      ray.setFromCamera(ndc, camera);
      if (ray.ray.intersectPlane(plane, hitP)) U.uMouseW.value.copy(hitP);
    }
    U.uMouseStr.value = st.mStr;
    U.uBeamDir.value.set(-0.82 + st.tiltX * 0.35, 0.57 - st.tiltY * 0.35).normalize();

    U.uT.value = t;
    U.uAppear.value = s.alpha;
    U.uBeam.value = s.beam; U.uFlash.value = s.flash; U.uHaze.value = s.haze; U.uGlow.value = s.glow;

    glass.visible = s.alpha > 0.002;
    sparks.visible = t > 1.3 && t < 2.6;
    beam.visible = s.beam > 0.001 || s.flash > 0.001;
    ribbons.visible = t < 2.4;
    const cv = t < 1.6 || t > 3.5; comets.forEach((m) => { m.visible = cv; });

    renderer.setRenderTarget(rt); renderer.clear(); renderer.render(sceneB, camera);
    renderer.setRenderTarget(null); renderer.clear(); renderer.render(sceneF, camera);
  }

  /* ---------- Видимость, потеря контекста, качество ---------- */
  let visible = true, T = motion ? 0 : 6, running = false, acc = 0, perfN = 0, perfSum = 0;
  new IntersectionObserver((en) => { visible = en[0].isIntersecting; if (visible) dirty = true; }).observe(section);
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); running = false; canvas.style.display = 'none'; });

  return {
    /* Прогрев шейдеров во время лоадера */
    compile() { layout(true); renderer.compile(sceneB, camera); renderer.compile(sceneF, camera); },
    /* Старт сюжета: в момент появления панели */
    start() { layout(true); T = motion ? 0 : 6; running = true; dirty = true; if (!motion) draw(T); },
    /* Шаг из общего цикла gsap.ticker: dt в секундах */
    tick(dt) {
      if (!running || !visible || canvas.style.display === 'none') return;
      if (!W && !layout(true)) return;
      if (!motion) { if (dirty) { dirty = false; draw(T); } return; }
      acc += dt;
      if (!mobile && acc < 1 / 62) return;
      const step_ = Math.min(acc, 0.05); acc = 0;
      T += step_;
      step(step_);
      draw(T);
      if (T > 4) {   // если кадр дольше 22 мс - снижаем разрешение
        perfSum += step_; perfN++;
        if (perfN === 120) { if (perfSum / perfN > 0.022 && DPR > 0.8) { DPR = Math.max(0.8, DPR * 0.8); layout(true); } perfN = 0; perfSum = 0; }
      }
    },
    /* Отладка: кадр в момент t */
    seek(t) { layout(true); T = t; draw(t); },
  };
}

/* Текстура знака из тех же путей, что и логотип: R - знак без звезды, G - звезда, B - мягкий ореол */
function makeMarkTexture(N) {
  const TOP = new Path2D('M0,56 V40 A40,40 0 0 1 40,0 H120 V56 Z');
  const BOT = new Path2D('M120,64 V80 A40,40 0 0 1 80,120 H0 V64 Z');
  const STAR = new Path2D('M60,20 C64,45.28 74.72,56 100,60 C74.72,64 64,74.72 60,100 C56,74.72 45.28,64 20,60 C45.28,56 56,45.28 60,20 Z');
  const FILL = 0.7, sc = (N * FILL) / 120, off = (N * (1 - FILL)) / 2;
  const cv = (n) => { const c = document.createElement('canvas'); c.width = c.height = n; return c; };
  const draw = (fn) => {
    const c = cv(N), g = c.getContext('2d');
    g.translate(off, off); g.scale(sc, sc); g.fillStyle = '#fff'; fn(g);
    return c;
  };
  const markC = draw((g) => { g.fill(TOP); g.fill(BOT); g.globalCompositeOperation = 'destination-out'; g.fill(STAR); });
  const starC = draw((g) => { g.fill(STAR); });
  const glowC = cv(N), gg = glowC.getContext('2d');
  gg.imageSmoothingEnabled = true; gg.imageSmoothingQuality = 'high';
  for (const [n, a] of [[128, 0.55], [48, 0.6], [20, 0.5]]) {
    const s = cv(n), sg = s.getContext('2d');
    sg.imageSmoothingQuality = 'high'; sg.drawImage(markC, 0, 0, n, n);
    gg.globalAlpha = a; gg.globalCompositeOperation = 'lighter'; gg.drawImage(s, 0, 0, N, N);
  }
  const A = markC.getContext('2d').getImageData(0, 0, N, N).data;
  const B = starC.getContext('2d').getImageData(0, 0, N, N).data;
  const G = gg.getImageData(0, 0, N, N).data;
  const data = new Uint8Array(N * N * 4);
  for (let i = 0; i < N * N; i++) {
    data[i * 4] = A[i * 4 + 3];
    data[i * 4 + 1] = B[i * 4 + 3];
    data[i * 4 + 2] = Math.min(255, G[i * 4 + 3]);
    data[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  tex.colorSpace = THREE.NoColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}
