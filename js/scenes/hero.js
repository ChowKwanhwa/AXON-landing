// hero 场景：boot 开场时间线 + 两侧 K 线挂载 + 指针交互 + 刷新滚动记忆。
// 行为与数值对照原站 Hero.astro 入口 / heroIntro / heroInteraction / hero-reload-scroll 四个模块。
// 注：hero 是 fixed 图层，boot intro 为时间驱动；滚动倒带由 rewind 模块负责，不在本文件。
import { BREAKPOINTS, matches } from '../config.js';
import { isMotionReduced } from '../lib/motion.js';
import { CHART_LIVE_START_EVENT, CHART_SKIP_QUERY, mountHeroCharts } from '../lib/hero-chart.js';

const INTRO_COMPLETE_EVENT = 'hero:intro:complete';
const INTRO_STARTED_EVENT = 'hero:intro:started';

// intro 时间轴段在 phone / 紧凑横屏 / 矮视口下跳过
const TIMELINE_SKIP_QUERY = `${CHART_SKIP_QUERY}, ${BREAKPOINTS.timelineCollision}`;
// 粗指针 / phone / 窄纵横比 → 轻量指针交互（只维护 timeline 高亮）
const LITE_INTERACTION_QUERY = `${BREAKPOINTS.coarsePointer}, ${BREAKPOINTS.phone}, ${BREAKPOINTS.compactAspect}`;

/* ================= 刷新滚动记忆（对照 hero-reload-scroll） ================= */

const MID_SCROLL_KEY = 'cryptowl.heroIntroWasMidScroll';
const HERO_ZONE_KEY = 'cryptowl.heroReloadWasInHeroZone';
const SCROLL_EPSILON = 1;
const RELOAD_RESET_FRAMES = 3;
const RELOAD_LOAD_RESET_WINDOW_MS = 850;

let reloadScrollHandled = false;
let heroZoneTracked = false;
let midScrollTracked = false;

const scrollTop = () => document.scrollingElement?.scrollTop ?? document.documentElement.scrollTop ?? 0;

const readSession = (key) => {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
};

const writeSession = (key, value) => {
  try {
    window.sessionStorage.setItem(key, value);
  } catch {
    // 隐私模式下忽略
  }
};

const navigationType = () => {
  const [entry] = performance.getEntriesByType('navigation');
  if (entry?.type) return entry.type;
  const legacy = performance.navigation;
  return legacy && legacy.type === legacy.TYPE_RELOAD ? 'reload' : 'navigate';
};

const absoluteTop = (element) => element.getBoundingClientRect().top + scrollTop();

const isInHeroZone = () => {
  const y = scrollTop();
  if (y <= SCROLL_EPSILON) return false;
  const hero = document.querySelector('.hero');
  const question = document.querySelector('.gate-question');
  if (!hero || !question) return false;
  return y >= absoluteTop(hero) && y < absoluteTop(question) - SCROLL_EPSILON;
};

const shouldResetReloadScroll = () => {
  if (navigationType() !== 'reload' || window.location.hash.length > 1) return false;
  return readSession(HERO_ZONE_KEY) === 'true' ? true : isInHeroZone();
};

const forceScrollTop = () => {
  document.documentElement.scrollTop = 0;
  document.body.scrollTop = 0;
  window.scrollTo(0, 0);
};

const revealReloadBoot = () => {
  const root = document.documentElement;
  if (root.dataset.heroReloadBoot === 'pending') delete root.dataset.heroReloadBoot;
  if (root.dataset.heroReloadScrollRestoration === 'manual') {
    try {
      window.history.scrollRestoration = 'auto';
    } catch {
      // 不支持 scrollRestoration 时忽略
    }
    delete root.dataset.heroReloadScrollRestoration;
  }
};

const trackWithScroll = (persist) => {
  let frame = 0;
  const schedule = () => {
    if (frame) return;
    frame = window.requestAnimationFrame(() => {
      frame = 0;
      persist();
    });
  };
  persist();
  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('pagehide', persist);
  window.addEventListener('beforeunload', persist);
};

const trackHeroZone = () => {
  if (heroZoneTracked) return;
  heroZoneTracked = true;
  trackWithScroll(() => {
    writeSession(HERO_ZONE_KEY, isInHeroZone() ? 'true' : 'false');
  });
};

const trackMidScroll = () => {
  if (midScrollTracked) return;
  midScrollTracked = true;
  trackWithScroll(() => {
    writeSession(MID_SCROLL_KEY, scrollTop() > SCROLL_EPSILON ? 'true' : 'false');
  });
};

const restoreReloadScroll = () => {
  if (reloadScrollHandled) return true;
  if (!shouldResetReloadScroll()) {
    revealReloadBoot();
    return false;
  }
  reloadScrollHandled = true;
  document.documentElement.dataset.heroReloadScrollReset = 'true';
  writeSession(HERO_ZONE_KEY, 'false');
  writeSession(MID_SCROLL_KEY, 'false');
  forceScrollTop();
  let remaining = RELOAD_RESET_FRAMES;
  const step = () => {
    if (remaining <= 0) {
      revealReloadBoot();
      return;
    }
    remaining -= 1;
    window.requestAnimationFrame(() => {
      forceScrollTop();
      step();
    });
  };
  step();
  const startedAt = performance.now();
  window.addEventListener(
    'load',
    () => {
      if (performance.now() - startedAt > RELOAD_LOAD_RESET_WINDOW_MS) return;
      forceScrollTop();
    },
    { once: true },
  );
  return true;
};

/** 带 hash / 刷新前处于页中 / 当前已滚动时不播 intro（对照入口 M()）。 */
const shouldPlayIntro = () =>
  !(window.location.hash || readSession(MID_SCROLL_KEY) === 'true' || scrollTop() > SCROLL_EPSILON);

/* ================= hero 交互门控（原站 interaction-runtime 的 hero 子集） ================= */
// 精指针 + 页面可见 + 未在滚动 + 处于 hero 区间时启用；rewind 相变事件可覆盖区间判断。

const SCROLL_IDLE_MS = 180;
const SCROLL_MIN_DELTA = 1;

let heroGate;

const createHeroGate = () => {
  const finePointer = window.matchMedia(BREAKPOINTS.finePointer);
  const listeners = new Set();
  let visible = document.visibilityState !== 'hidden';
  let scrolling = false;
  let idleTimer = 0;
  let lastY = scrollTop();
  let rewindPhase = null;

  const heroActive = () => {
    const y = scrollTop();
    if (y <= SCROLL_EPSILON) return true;
    if (rewindPhase) return rewindPhase === 'hero';
    const question = document.querySelector('.gate-question');
    return question ? y < absoluteTop(question) - SCROLL_EPSILON : false;
  };
  const compute = () => finePointer.matches && visible && !scrolling && heroActive();
  let current = compute();
  const emit = () => {
    const next = compute();
    if (next === current) return;
    current = next;
    listeners.forEach((listener) => {
      listener(next);
    });
  };
  const stopScrolling = () => {
    if (idleTimer !== 0) {
      window.clearTimeout(idleTimer);
      idleTimer = 0;
    }
    scrolling = false;
    emit();
  };
  const scheduleIdle = () => {
    if (idleTimer !== 0) window.clearTimeout(idleTimer);
    idleTimer = window.setTimeout(() => {
      idleTimer = 0;
      stopScrolling();
    }, SCROLL_IDLE_MS);
  };
  window.addEventListener(
    'scroll',
    () => {
      const y = scrollTop();
      if (y <= SCROLL_EPSILON) {
        stopScrolling();
        return;
      }
      const delta = Math.abs(y - lastY);
      lastY = y;
      if (delta >= SCROLL_MIN_DELTA) scrolling = true;
      if (scrolling) scheduleIdle();
      emit();
    },
    { passive: true },
  );
  finePointer.addEventListener('change', emit);
  document.addEventListener('visibilitychange', () => {
    visible = document.visibilityState !== 'hidden';
    emit();
  });
  window.addEventListener(
    'rewindtransitionphasechange',
    (event) => {
      const phase = event.detail?.phase;
      rewindPhase = phase === 'hero' || phase === 'tunnel' || phase === 'question' ? phase : null;
      emit();
    },
    { passive: true },
  );
  return {
    isEnabled: () => (current = compute()),
    onChange: (handler) => {
      listeners.add(handler);
      handler(compute());
      return () => {
        listeners.delete(handler);
      };
    },
  };
};

const getHeroGate = () => (heroGate ??= createHeroGate());

/* ================= intro：时序常量（对照 heroIntro，scale = 1） ================= */

const clampValue = (value, min, max) => Math.min(max, Math.max(min, value));

// [className, 不透明度 | .hero 上的 CSS 变量名]，命中即为该元素的 intro 目标透明度
const INTRO_OPACITY_RULES = [
  ['hero-gate__tunnel-depth-glow--phone', 0.7],
  ['hero-gate__tunnel-depth-glow', '--hero-tunnel-depth-glow-opacity'],
  ['hero__gate-foreground-shadow', 0.54],
  ['hero__gate-foreground-core', 0.82],
  ['hero-gate__floor-ray--edge', 1],
  ['hero-gate__floor-ray--center', '--hero-road-ray-center-opacity'],
  ['hero-gate__floor-ray--support', '--hero-road-ray-support-opacity'],
  ['hero-gate__floor-ray--field', '--hero-road-ray-field-opacity'],
  ['hero-gate__floor-cross--foreground', '--hero-road-cross-foreground-opacity'],
  ['hero-gate__floor-cross--field', '--hero-road-cross-field-opacity'],
  ['hero-gate__floor-cross--entry', '--hero-road-cross-entry-opacity'],
  ['hero-gate__floor-cross--inner-entry', '--hero-road-cross-inner-entry-opacity'],
  ['hero-gate__floor-cross--depth', '--hero-road-cross-depth-opacity'],
  ['hero-gate__side-wall-edge--upper', '--hero-wall-edge-upper-opacity'],
  ['hero-gate__side-wall-edge--lower', '--hero-wall-edge-lower-opacity'],
  ['hero-gate__side-wall-upright--center', '--hero-wall-upright-center-opacity'],
  ['hero-gate__side-wall-upright', '--hero-wall-upright-opacity'],
  ['hero-gate__wall-side-turn', '--hero-wall-corner-opacity'],
  ['hero-gate__wall-threshold-line', '--hero-wall-grid-upper-opacity'],
  ['hero-gate__side-wall-row--ceiling', '--hero-wall-grid-ceiling-opacity'],
  ['hero-gate__wall-bridge-line--ceiling', '--hero-wall-grid-ceiling-opacity'],
  ['hero-gate__side-wall-row--lower', '--hero-wall-grid-lower-opacity'],
  ['hero-gate__wall-bridge-line--lower', '--hero-wall-grid-lower-opacity'],
  ['hero-gate__side-wall-row--mid', '--hero-wall-grid-mid-opacity'],
  ['hero-gate__wall-bridge-line--mid', '--hero-wall-grid-mid-opacity'],
  ['hero-gate__side-wall-row--upper', '--hero-wall-grid-upper-opacity'],
  ['hero-gate__wall-bridge-line--upper', '--hero-wall-grid-upper-opacity'],
];

// 拱门 / 路面绘制
const CONSTRUCTION = {
  mainArchDuration: 1,
  roadRayDuration: 1,
  secondaryArchStart: 0.042,
  tertiaryArchStart: 0.063,
  ribAfterMarkerDelay: clampValue(0.008, 0.006, 0.016),
  ribDuration: clampValue(0.054, 0.052, 0.082),
  roadCrossAfterRayDelay: clampValue(0.017, 0.014, 0.032),
  roadCrossDuration: clampValue(0.25, 0.24, 0.36),
};

// 侧墙网格
const BACK_GRID = {
  afterGateDelay: clampValue(0.003, 0.003, 0.008),
  centerGateProgress: 0.5,
  rowsDelay: clampValue(0.06, 0.052, 0.092),
  structureDuration: clampValue(0.46, 0.4, 0.64),
  rowsDuration: clampValue(0.36, 0.32, 0.52),
  leftWallStartDelay: clampValue(0.34, 0.28, 0.46),
  centerWallStartDelay: clampValue(0.34, 0.28, 0.46),
  rightWallStartDelay: clampValue(0.03, 0.02, 0.06),
  centerAfterLeftDelay: clampValue(0.08, 0.06, 0.16),
  rightAfterCenterDelay: clampValue(0.15, 0.12, 0.24),
  afterRibsDelay: clampValue(0.18, 0.16, 0.28),
};

const ROAD_RAY_EASE = 'linear';
const ROAD_CROSS_EASE = 'power1.out';

// 拱肋起始偏移（× mainArchDuration）
const RIB_START_OFFSETS = {
  leftBase: 0.016,
  leftShoulder: 0.1,
  rightShoulder: -0.1,
  rightBase: -0.06,
};

const CANDLE_SETTLE_DURATION = clampValue(0.093, 0.078, 0.118);
const PRICE_SCALE_BASE_DURATION = clampValue(0.103, 0.086, 0.13);
const PRICE_SCALE_EXTRA_DURATION = clampValue(0.0087, 0.006, 0.012);

// 图表揭示
const CHART_TIMING = {
  leftRevealMinDuration: clampValue(0.21, 0.2, 0.32),
  leftRevealGateOverlap: clampValue(0.03, 0.024, 0.052),
  rightRevealMinDuration: clampValue(0.32, 0.3, 0.46),
  rightRevealPadding: clampValue(0.027, 0.024, 0.048),
  rightRevealWallOverlap: clampValue(0.29, 0.24, 0.36),
  priceToLiveDelay: clampValue(0.057, 0.052, 0.088),
  liveAfterRightRevealDelay: clampValue(0.007, 0.006, 0.014),
  liveStartCallbackDelay: clampValue(0.02, 0.018, 0.034),
};

// 氛围光
const ATMOSPHERE_TIMING = {
  tunnelLightDuration: clampValue(0.31, 0.3, 0.46),
  gateAtmosphereDuration: clampValue(0.225, 0.22, 0.34),
  gateForegroundDuration: clampValue(0.127, 0.12, 0.19),
  gateForegroundProgress: 0.82,
};

// 标题 / 副标题 / CTA
const CONTENT_TIMING = {
  strategyGateProgress: 0.74,
  strategyCharsDuration: clampValue(0.2, 0.2, 0.29),
  strategyCharsStaggerAmount: clampValue(0.167, 0.16, 0.24),
  timeAfterStrategyDelay: clampValue(0.21, 0.19, 0.31),
  timeDuration: clampValue(0.223, 0.22, 0.32),
  subheadAfterTimeDelay: clampValue(0.11, 0.1, 0.17),
  subheadMoveDuration: clampValue(0.193, 0.19, 0.28),
  subheadPartsDuration: clampValue(0.16, 0.16, 0.24),
  subheadPartsStagger: clampValue(0.015, 0.014, 0.024),
  contentCtaDelay: clampValue(0.06, 0.052, 0.092),
  contentCtaDuration: clampValue(0.113, 0.11, 0.17),
  timelineAfterSubheadDelay: clampValue(0.107, 0.1, 0.17),
};

const HEADER_TIMING = {
  duration: clampValue(0.25, 0.25, 0.25),
  ctaDelay: clampValue(0.01, 0.008, 0.016),
};

// 底部时间轴
const TIMELINE_TIMING = {
  containerDuration: clampValue(0.103, 0.086, 0.132),
  rewindDuration: clampValue(0.08, 0.068, 0.104),
  innerTracksDelay: clampValue(0.03, 0.024, 0.044),
  innerTracksDuration: clampValue(0.117, 0.096, 0.15),
  chevronsDelay: clampValue(0.08, 0.068, 0.104),
  chevronsDuration: clampValue(0.07, 0.058, 0.09),
  chevronsStagger: clampValue(0.007, 0.005, 0.01),
  outerTracksDelay: clampValue(0.103, 0.086, 0.132),
  outerTracksDuration: clampValue(0.127, 0.106, 0.16),
  outerLabelsDelay: clampValue(0.17, 0.14, 0.22),
  outerLabelsDuration: clampValue(0.09, 0.074, 0.116),
  outerLabelsStagger: clampValue(0.01, 0.008, 0.014),
};

const CLEAR_PROPS =
  'opacity,transform,transformOrigin,translate,y,scale,clipPath,webkitClipPath,strokeDasharray,strokeDashoffset,strokeMiterlimit';
const PATH_SAMPLE_SEGMENTS = 96;
const NUMBER_PATTERN = /-?\d+(?:\.\d+)?/g;

/* ================= intro：SVG path 几何工具 ================= */

const round3 = (value) => `${Math.round(value * 1e3) / 1e3}`;

const originalPathCache = new WeakMap();
const originalPath = (path) => {
  if (originalPathCache.has(path)) return originalPathCache.get(path) ?? null;
  const d = path.getAttribute('d');
  originalPathCache.set(path, d);
  return d;
};

// 在原始 d 上测量（临时还原再恢复当前值）
const withOriginalPath = (path, measure) => {
  const original = originalPath(path);
  if (!original) return measure();
  const currentD = path.getAttribute('d');
  if (currentD === original) return measure();
  path.setAttribute('d', original);
  try {
    return measure();
  } finally {
    if (currentD === null) path.removeAttribute('d');
    else path.setAttribute('d', currentD);
  }
};

const pointAt = (path, length) => withOriginalPath(path, () => path.getPointAtLength(length));

// 解析拱门 path："M sx sy L lx ly A rx ry 0 0 1 rx2 ry2 L ex ey"
const parseArchGeometry = (path) => {
  const numbers = originalPath(path)?.match(NUMBER_PATTERN)?.map(Number) ?? [];
  if (numbers.length < 13) return null;
  const [startX, startY, leftX, sideY, radiusX, radiusY, , , , rightX, rightSideY, endX, endY] = numbers;
  return {
    startX,
    startY,
    leftX,
    sideY,
    radiusX,
    radiusY,
    rightX,
    rightSideY,
    endX,
    endY,
    leftLegLength: Math.hypot(leftX - startX, sideY - startY),
    rightLegLength: Math.hypot(endX - rightX, endY - rightSideY),
  };
};

const pathLengthCache = new WeakMap();
const totalLength = (path) => {
  const cached = pathLengthCache.get(path);
  if (cached !== undefined) return cached;
  try {
    const length = path.getTotalLength();
    pathLengthCache.set(path, length);
    return length;
  } catch {
    return 0;
  }
};

const maxTotalLength = (paths) => Math.max(0, ...paths.map(totalLength));

// 参照 gatePrimary 长度等速缩放次级拱的时长
const scaledDurationByLength = (targets, reference, duration) => {
  const referenceLength = maxTotalLength(reference);
  const targetLength = maxTotalLength(targets);
  return referenceLength <= 0 || targetLength <= 0 ? duration : duration * (targetLength / referenceLength);
};

// 非拱门形状 path 的兜底：按弧长采样折线
const sampledPartialPath = (path, length) => {
  const startPoint = pointAt(path, 0);
  if (length <= 0) return `M ${round3(startPoint.x)} ${round3(startPoint.y)}`;
  const segments = Math.max(1, Math.ceil(PATH_SAMPLE_SEGMENTS * Math.min(1, length / 640)));
  return Array.from({ length: segments + 1 }, (_, i) => pointAt(path, (length * i) / segments))
    .map((point, i) => `${i === 0 ? 'M' : 'L'} ${round3(point.x)} ${round3(point.y)}`)
    .join(' ');
};

// 给定绘制进度（0-1）生成部分 d
const partialPathData = (path, progress) => {
  const original = originalPath(path);
  const length = totalLength(path);
  const clamped = Math.min(1, Math.max(0, progress));
  const drawn = length * clamped;
  if (!original || length <= 0) return null;
  if (clamped >= 1) return original;
  const geometry = parseArchGeometry(path);
  if (!geometry) return sampledPartialPath(path, drawn);
  const { startX, startY, leftX, sideY, radiusX, radiusY, rightX, rightSideY, endX, endY, leftLegLength, rightLegLength } =
    geometry;
  const arcLength = Math.max(0, length - leftLegLength - rightLegLength);
  if (drawn <= leftLegLength) {
    const t = leftLegLength > 0 ? drawn / leftLegLength : 0;
    const y = startY + (sideY - startY) * t;
    return [`M ${round3(startX)} ${round3(startY)}`, `L ${round3(leftX)} ${round3(y)}`].join(' ');
  }
  if (drawn <= leftLegLength + arcLength) {
    const point = pointAt(path, drawn);
    return [
      `M ${round3(startX)} ${round3(startY)}`,
      `L ${round3(leftX)} ${round3(sideY)}`,
      [`A ${round3(radiusX)} ${round3(radiusY)}`, '0 0 1', `${round3(point.x)} ${round3(point.y)}`].join(' '),
    ].join(' ');
  }
  const t = rightLegLength > 0 ? (drawn - leftLegLength - arcLength) / rightLegLength : 1;
  const y = rightSideY + (endY - rightSideY) * Math.min(1, Math.max(0, t));
  return [
    `M ${round3(startX)} ${round3(startY)}`,
    `L ${round3(leftX)} ${round3(sideY)}`,
    [`A ${round3(radiusX)} ${round3(radiusY)}`, '0 0 1', `${round3(rightX)} ${round3(rightSideY)}`].join(' '),
    `L ${round3(endX)} ${round3(y)}`,
  ].join(' ');
};

const setPathProgress = (path, progress) => {
  const data = partialPathData(path, progress);
  if (data) path.setAttribute('d', data);
};

const restorePaths = (paths) => {
  paths.forEach((path) => {
    const original = originalPath(path);
    if (original) path.setAttribute('d', original);
    path.removeAttribute('pathLength');
    path.removeAttribute('stroke-dasharray');
    path.removeAttribute('stroke-dashoffset');
  });
};

const LINE_LIKE_CLASSES = [
  'hero-gate__floor-cross',
  'hero-gate__floor-ray',
  'hero-gate__arch-connector',
  'hero-gate__side-wall-edge',
  'hero-gate__side-wall-upright',
  'hero-gate__wall-side-turn',
  'hero-gate__side-wall-row',
  'hero-gate__wall-bridge-line',
  'hero-gate__wall-threshold-line',
];

const collapseGatePath = (path) => {
  if (LINE_LIKE_CLASSES.some((className) => path.classList.contains(className))) return;
  totalLength(path);
  setPathProgress(path, 0);
};

/** intro 目标透明度：命中规则取数值，或读 .hero 上的 CSS 变量；也可直接作为 GSAP 函数值使用。 */
const introOpacityFor = (index, element) => {
  for (const [className, opacity] of INTRO_OPACITY_RULES) {
    if (!element.classList.contains(className)) continue;
    if (typeof opacity === 'number') return opacity;
    const view = element.ownerDocument.defaultView;
    const hero = element.closest('.hero');
    const raw = hero && view ? view.getComputedStyle(hero).getPropertyValue(opacity).trim() : '';
    const value = Number.parseFloat(raw);
    return Number.isFinite(value) ? value : 1;
  }
  return 1;
};

const attrNumber = (element, name) => Number.parseFloat(element.getAttribute(name) ?? '0') || 0;

/* ================= intro：line 绘制工具 ================= */

// line 元素初始端点缓存（首次读取发生在 restore 阶段，此时属性仍为原值）
const lineBaseCache = new WeakMap();
const readLineBase = (line) => {
  const cached = lineBaseCache.get(line);
  if (cached) return cached;
  const base = {
    x1: attrNumber(line, 'x1'),
    y1: attrNumber(line, 'y1'),
    x2: attrNumber(line, 'x2'),
    y2: attrNumber(line, 'y2'),
  };
  lineBaseCache.set(line, base);
  return base;
};

const restoreLines = (lines) => {
  lines.forEach((line) => {
    const base = readLineBase(line);
    line.setAttribute('x1', base.x1.toString());
    line.setAttribute('y1', base.y1.toString());
    line.setAttribute('x2', base.x2.toString());
    line.setAttribute('y2', base.y2.toString());
  });
};

// 折叠到 (x1, y1) 起点
const collapseLinesToStart = (lines) => {
  lines.forEach((line) => {
    const base = readLineBase(line);
    line.setAttribute('x1', base.x1.toString());
    line.setAttribute('y1', base.y1.toString());
    line.setAttribute('x2', base.x1.toString());
    line.setAttribute('y2', base.y1.toString());
  });
};

const lineEndpoints = (base, direction = 'forward') =>
  direction === 'left-to-right' && base.x1 > base.x2
    ? { startX: base.x2, startY: base.y2, endX: base.x1, endY: base.y1, animatedEndpoint: 'start' }
    : { startX: base.x1, startY: base.y1, endX: base.x2, endY: base.y2, animatedEndpoint: 'end' };

const collapseWalls = (lines, direction = 'forward') => {
  lines.forEach((line) => {
    const base = readLineBase(line);
    const points = lineEndpoints(base, direction);
    line.setAttribute('x1', points.startX.toString());
    line.setAttribute('y1', points.startY.toString());
    line.setAttribute('x2', points.startX.toString());
    line.setAttribute('y2', points.startY.toString());
  });
};

const resolveLineOpacity = (index, line, config) =>
  typeof config.opacity === 'number'
    ? config.opacity
    : typeof config.opacity === 'function'
      ? config.opacity(index, line)
      : introOpacityFor(index, line);

const staggerOffset = (index, count, stagger) => {
  if (!stagger) return 0;
  if (stagger.from === 'center') return Math.abs(index - (count - 1) / 2) * stagger.each;
  if (stagger.from === 'end') return (count - 1 - index) * stagger.each;
  return index * stagger.each;
};

const offsetPosition = (position, offset) =>
  offset === 0 ? position : typeof position === 'number' ? position + offset : `${position}+=${offset}`;

// 侧墙线条：从方向起点扫出
const drawWallLines = (tl, lines, config, position) => {
  lines.forEach((line, index) => {
    const base = readLineBase(line);
    const points = lineEndpoints(base, config.direction);
    const at = offsetPosition(position, staggerOffset(index, lines.length, config.stagger));
    tl.set(
      line,
      {
        opacity: resolveLineOpacity(index, line, config),
        attr: { x1: points.startX, y1: points.startY, x2: points.startX, y2: points.startY },
      },
      at,
    );
    tl.to(
      line,
      {
        attr:
          points.animatedEndpoint === 'start' ? { x1: points.endX, y1: points.endY } : { x2: points.endX, y2: points.endY },
        duration: config.duration,
        ease: config.ease ?? 'none',
      },
      at,
    );
  });
};

// 拱肋：从 (x1, y1) 扫向 (x2, y2)
const drawLinesFromStart = (tl, lines, opacity, duration, position) => {
  lines.forEach((line) => {
    const base = readLineBase(line);
    tl.set(line, { opacity, attr: { x1: base.x1, y1: base.y1, x2: base.x1, y2: base.y1 } }, position);
    tl.to(line, { attr: { x2: base.x2, y2: base.y2 }, duration, ease: 'none' }, position);
  });
};

const drawRibPair = (tl, front, rear, frontStart, rearStart, duration = CONSTRUCTION.ribDuration) => {
  drawLinesFromStart(tl, front, 0.74, duration, frontStart);
  drawLinesFromStart(tl, rear, 0.62, duration, rearStart);
};

/* ================= intro：路面（floor rays / cross） ================= */

const rayBaseCache = new WeakMap();
const readRayBase = (ray) => {
  const cached = rayBaseCache.get(ray);
  if (cached) return cached;
  const base = {
    startX: attrNumber(ray, 'x1'),
    startY: attrNumber(ray, 'y1'),
    endX: attrNumber(ray, 'x2'),
    endY: attrNumber(ray, 'y2'),
  };
  rayBaseCache.set(ray, base);
  return base;
};

const crossBaseCache = new WeakMap();
const readCrossBase = (line) => {
  const cached = crossBaseCache.get(line);
  if (cached) return cached;
  const startX = attrNumber(line, 'x1');
  const endX = attrNumber(line, 'x2');
  const base = { startX, centerX: (startX + endX) / 2, endX };
  crossBaseCache.set(line, base);
  return base;
};

const restoreRoadCross = (lines) => {
  lines.forEach((line) => {
    const base = readCrossBase(line);
    line.setAttribute('x1', base.startX.toString());
    line.setAttribute('x2', base.endX.toString());
  });
};

const collapseRoadCross = (lines) => {
  lines.forEach((line) => {
    const base = readCrossBase(line);
    line.setAttribute('x1', base.centerX.toString());
    line.setAttribute('x2', base.centerX.toString());
  });
};

const restoreRoadRays = (rays) => {
  rays.forEach((ray) => {
    const base = readRayBase(ray);
    ray.setAttribute('x1', base.startX.toString());
    ray.setAttribute('y1', base.startY.toString());
    ray.setAttribute('x2', base.endX.toString());
    ray.setAttribute('y2', base.endY.toString());
  });
};

const collapseRoadRays = (rays) => {
  rays.forEach((ray) => {
    const base = readRayBase(ray);
    ray.setAttribute('x1', base.endX.toString());
    ray.setAttribute('y1', base.endY.toString());
    ray.setAttribute('x2', base.endX.toString());
    ray.setAttribute('y2', base.endY.toString());
  });
};

// 横线开始时刻：按其 y1 在路面外/内段行进比例推算
const crossStartTime = (line, timing) => {
  const y = attrNumber(line, 'y1');
  if (timing.foregroundY === timing.innerY) return timing.start + timing.crossAfterRayDelay;
  const outerSpan = timing.foregroundY - timing.baseY;
  const innerSpan = timing.baseY - timing.innerY;
  const totalSpan = outerSpan + innerSpan;
  if (totalSpan <= 0) return timing.start + timing.crossAfterRayDelay;
  const travelled = y >= timing.baseY ? timing.foregroundY - y : outerSpan + (timing.baseY - y);
  const progress = Math.min(1, Math.max(0, travelled / totalSpan));
  return timing.start + timing.duration * progress + timing.crossAfterRayDelay;
};

// 路面时序：外段/内段时长按 data-road-* 标注的 y 值分摊
const buildRoadTiming = (targets, start, duration, construction) => {
  const metric = targets.roadMetrics[0] ?? targets.frame.roadRays[0];
  const outerSpan = metric ? attrNumber(metric, 'data-road-foreground-y') - attrNumber(metric, 'data-road-base-y') : 0;
  const innerSpan = metric ? attrNumber(metric, 'data-road-base-y') - attrNumber(metric, 'data-road-inner-y') : 0;
  const totalSpan = outerSpan + innerSpan;
  const outerDuration = totalSpan > 0 ? duration * (outerSpan / totalSpan) : duration;
  return {
    start,
    duration,
    outerDuration,
    innerDuration: Math.max(0, duration - outerDuration),
    innerY: metric ? attrNumber(metric, 'data-road-inner-y') : 0,
    baseY: metric ? attrNumber(metric, 'data-road-base-y') : 0.5,
    foregroundY: metric ? attrNumber(metric, 'data-road-foreground-y') : 1,
    crossAfterRayDelay: construction.roadCrossAfterRayDelay,
    crossDuration: construction.roadCrossDuration,
  };
};

// 射线：从远端 (x2, y2) 拉回近端 (x1, y1)
const drawRoadRays = (tl, rays, start, duration) => {
  rays.forEach((ray, index) => {
    const base = readRayBase(ray);
    tl.set(
      ray,
      { opacity: introOpacityFor(index, ray), attr: { x1: base.endX, y1: base.endY, x2: base.endX, y2: base.endY } },
      start,
    );
    tl.to(ray, { attr: { x1: base.startX, y1: base.startY }, duration, ease: ROAD_RAY_EASE }, start);
  });
};

const animateRoadRays = (tl, rays, timing) => {
  const full = rays.filter((ray) => ray.classList.contains('hero-gate__floor-ray--full'));
  const outer = rays.filter((ray) => ray.classList.contains('hero-gate__floor-ray--outer'));
  const inner = rays.filter((ray) => ray.classList.contains('hero-gate__floor-ray--inner'));
  if (full.length > 0) {
    drawRoadRays(tl, full, timing.start, timing.duration);
    return;
  }
  drawRoadRays(tl, outer, timing.start, timing.outerDuration);
  drawRoadRays(tl, inner, timing.start + timing.outerDuration, timing.innerDuration);
};

// 横线：由中心向两侧展开
const animateRoadCross = (tl, lines, timing) => {
  lines.forEach((line) => {
    const start = crossStartTime(line, timing);
    const base = readCrossBase(line);
    tl.set(line, { opacity: introOpacityFor(0, line), attr: { x1: base.centerX, x2: base.centerX } }, start);
    tl.to(line, { attr: { x1: base.startX, x2: base.endX }, duration: timing.crossDuration, ease: ROAD_CROSS_EASE }, start);
  });
};

/* ================= intro：拱门 path 绘制与拱肋时刻 ================= */

// 主/次/远拱：set 目标透明度后按弧长进度重写 d
const drawGateArch = (tl, paths, config, position) => {
  if (paths.length === 0) return tl;
  tl.set(paths, { opacity: config.opacity ?? 1 }, position);
  paths.forEach((path) => {
    const proxy = { value: 0 };
    const initial = partialPathData(path, 0);
    if (initial) tl.set(path, { attr: { d: initial } }, position);
    tl.to(
      proxy,
      {
        value: 1,
        duration: config.duration,
        ease: config.ease ?? 'power2.inOut',
        onUpdate: () => setPathProgress(path, proxy.value),
        onComplete: () => restorePaths([path]),
      },
      position,
    );
  });
  return tl;
};

// 标记点（左脚/左肩/右肩/右脚）在拱门弧长上的比例
const archMarkerFraction = (path, marker) => {
  if (marker === 'leftBase') return 0;
  if (marker === 'rightBase') return 1;
  const numbers = (originalPath(path) ?? path.getAttribute('d') ?? '').match(NUMBER_PATTERN)?.map(Number) ?? [];
  const length = totalLength(path);
  if (numbers.length < 13 || length <= 0) return marker === 'leftShoulder' ? 0.24 : 0.76;
  const leftLeg = Math.hypot(numbers[2] - numbers[0], numbers[3] - numbers[1]);
  const rightLeg = Math.hypot(numbers[11] - numbers[9], numbers[12] - numbers[10]);
  return marker === 'leftShoulder'
    ? Math.min(1, Math.max(0, leftLeg / length))
    : Math.min(1, Math.max(0, 1 - rightLeg / length));
};

const markerTime = (elements, start, duration, marker) => {
  const first = elements[0];
  return first ? start + duration * archMarkerFraction(first, marker) : start;
};

const ribStartTime = (marker, markers, construction) =>
  Math.max(...markers.map((entry) => markerTime(entry.elements, entry.start, entry.duration, marker))) +
  construction.ribAfterMarkerDelay +
  construction.mainArchDuration * (RIB_START_OFFSETS[marker] ?? 0);

const ribTimes = (marker, frontMarkers, rearMarkers, construction) => ({
  front: ribStartTime(marker, frontMarkers, construction),
  rear: ribStartTime(marker, rearMarkers, construction),
});

/* ================= intro：目标收集与总排程 ================= */

// chartTargetMode: 'full' | 'containers' | 'none'（intro 实际只用后两种）
const collectTargets = (hero, { chartTargetMode = 'full' } = {}) => {
  const withChart = chartTargetMode !== 'none';
  const fullChart = chartTargetMode === 'full';
  const all = (selector) => Array.from(hero.querySelectorAll(selector));
  const one = (selector) => {
    const el = hero.querySelector(selector);
    return el ? [el] : [];
  };
  const doc = (selector) => {
    const el = hero.ownerDocument.querySelector(selector);
    return el ? [el] : [];
  };
  const measurable = (els) => els.filter((el) => typeof el.getTotalLength === 'function');
  const within = (els, selector) => els.flatMap((el) => Array.from(el.querySelectorAll(selector)));
  const bodiesByTone = (els, tone) => within(els.filter((el) => el.classList.contains(`candle--${tone}`)), '.candle__body');
  const leftCandles = fullChart ? all('.hero-chart__segment--left .candle:not(.candle--live)') : [];
  const rightCandles = fullChart ? all('.hero-chart__segment--right .candle:not(.candle--live)') : [];
  return {
    frame: {
      roadRays: measurable(all('.hero-gate__floor-ray')),
      roadCross: measurable(all('.hero-gate__floor-cross')),
      wallLeftStructure: measurable(all('.hero-gate__side-wall-edge--left, .hero-gate__side-wall-upright--intro-left')),
      wallRightStructure: measurable(all('.hero-gate__side-wall-edge--right, .hero-gate__side-wall-upright--intro-right')),
      wallCenterStructure: measurable(all('.hero-gate__side-wall-upright--intro-center, .hero-gate__wall-side-turn')),
      wallLeftRows: measurable(all('.hero-gate__side-wall-row--left')),
      wallRightRows: measurable(all('.hero-gate__side-wall-row--right')),
      wallBridgeRows: measurable(all('.hero-gate__wall-bridge-line')),
      wallThresholdRows: measurable(all('.hero-gate__wall-threshold-line')),
      gatePrimary: measurable(all('.hero-gate__core')),
      gatePrimaryDetails: measurable(all('.hero-gate__core-inner')),
      gatePrimaryGlow: measurable(all('.hero-gate__core-aura')),
      gateSecondary: measurable(all('.hero-gate__rear-arch-path--near')),
      gateTertiary: measurable(all('.hero-gate__rear-arch-path--far')),
      ribLeftBaseFront: measurable(
        all('.hero-gate__arch-connector--base.hero-gate__arch-connector--left.hero-gate__arch-connector--front'),
      ),
      ribLeftBaseRear: measurable(
        all('.hero-gate__arch-connector--base.hero-gate__arch-connector--left.hero-gate__arch-connector--rear'),
      ),
      ribLeftShoulderFront: measurable(
        all('.hero-gate__arch-connector--shoulder.hero-gate__arch-connector--left.hero-gate__arch-connector--front'),
      ),
      ribLeftShoulderRear: measurable(
        all('.hero-gate__arch-connector--shoulder.hero-gate__arch-connector--left.hero-gate__arch-connector--rear'),
      ),
      ribRightShoulderFront: measurable(
        all('.hero-gate__arch-connector--shoulder.hero-gate__arch-connector--right.hero-gate__arch-connector--front'),
      ),
      ribRightShoulderRear: measurable(
        all('.hero-gate__arch-connector--shoulder.hero-gate__arch-connector--right.hero-gate__arch-connector--rear'),
      ),
      ribRightBaseFront: measurable(
        all('.hero-gate__arch-connector--base.hero-gate__arch-connector--right.hero-gate__arch-connector--front'),
      ),
      ribRightBaseRear: measurable(
        all('.hero-gate__arch-connector--base.hero-gate__arch-connector--right.hero-gate__arch-connector--rear'),
      ),
    },
    roadMetrics: one('.hero-gate__floor--bridge'),
    gateAtmosphere: [],
    tunnelLight: all('.hero-gate__tunnel-depth-glow, .hero-gate__thickness'),
    gateForeground: all('.hero__gate-foreground-shadow, .hero__gate-foreground-core'),
    quietLight: all('.hero-gate__grid-light--floor, .hero-gate__grid-light--wall, .hero-gate__grid-light--threshold'),
    chart: withChart ? one('.hero__chart-stage') : [],
    chartCandles: withChart ? one('.hero-chart__candles') : [],
    chartLeftCandles: leftCandles,
    chartRightCandles: rightCandles,
    chartLeftBodies: within(leftCandles, '.candle__body'),
    chartRightBodies: within(rightCandles, '.candle__body'),
    chartLeftUpBodies: bodiesByTone(leftCandles, 'up'),
    chartLeftDownBodies: bodiesByTone(leftCandles, 'down'),
    chartRightUpBodies: bodiesByTone(rightCandles, 'up'),
    chartRightDownBodies: bodiesByTone(rightCandles, 'down'),
    chartLeftWicks: within(leftCandles, '.candle__wick'),
    chartRightWicks: within(rightCandles, '.candle__wick'),
    chartLiveCandles: fullChart ? all('.hero-chart .candle--live') : [],
    chartPriceScale: withChart ? one('.hero-chart__price-scale') : [],
    chartPriceTicks: fullChart ? all('.hero-chart__price-tick') : [],
    time: one('.hero__headline-word'),
    strategy: one('.hero__headline-line'),
    subhead: one('.hero__subhead'),
    subheadParts: all('.hero__subhead-word, .hero__subhead-dot'),
    contentCta: one('.hero__content-cta-frame'),
    timeline: one('.hero__timeline'),
    timelineRewind: one('.hero__timeline-label--rewind'),
    timelineOuterLabels: all('.hero__timeline-label--past, .hero__timeline-label--now'),
    timelineLeftInnerTrack: one('.hero__timeline-track--left-inner'),
    timelineRightInnerTrack: one('.hero__timeline-track--right-inner'),
    timelineLeftOuterTrack: one('.hero__timeline-track--left'),
    timelineRightOuterTrack: one('.hero__timeline-track--right'),
    timelineInnerTracks: all('.hero__timeline-track--left-inner, .hero__timeline-track--right-inner'),
    timelineOuterTracks: all('.hero__timeline-track--left, .hero__timeline-track--right'),
    timelineChevrons: all('.hero__timeline-chevrons'),
    timelineParts: all('.hero__timeline-label, .hero__timeline-track, .hero__timeline-chevrons'),
    header: doc('.header'),
    headerBrand: doc('.header__brand'),
    headerCta: doc('.header__menu-trigger'),
  };
};

const allTargets = (targets) =>
  [
    ...Object.values(targets.frame).flat(),
    ...targets.gateAtmosphere,
    ...targets.tunnelLight,
    ...targets.gateForeground,
    ...targets.quietLight,
    ...targets.chart,
    ...targets.chartCandles,
    ...targets.chartLeftCandles,
    ...targets.chartRightCandles,
    ...targets.chartLeftBodies,
    ...targets.chartRightBodies,
    ...targets.chartLeftWicks,
    ...targets.chartRightWicks,
    ...targets.chartLiveCandles,
    ...targets.chartPriceScale,
    ...targets.chartPriceTicks,
    ...targets.time,
    ...targets.strategy,
    ...targets.subhead,
    ...targets.subheadParts,
    ...targets.contentCta,
    ...targets.timeline,
    ...targets.timelineParts,
    ...targets.header,
    ...targets.headerBrand,
    ...targets.headerCta,
  ].filter(Boolean);

const ribTargets = (targets) => [
  ...targets.frame.ribLeftBaseFront,
  ...targets.frame.ribLeftBaseRear,
  ...targets.frame.ribLeftShoulderFront,
  ...targets.frame.ribLeftShoulderRear,
  ...targets.frame.ribRightShoulderFront,
  ...targets.frame.ribRightShoulderRear,
  ...targets.frame.ribRightBaseFront,
  ...targets.frame.ribRightBaseRear,
];

const wallTargets = (targets) => [
  ...targets.frame.wallLeftStructure,
  ...targets.frame.wallRightStructure,
  ...targets.frame.wallCenterStructure,
  ...targets.frame.wallLeftRows,
  ...targets.frame.wallRightRows,
  ...targets.frame.wallBridgeRows,
  ...targets.frame.wallThresholdRows,
];

// 由拱门/侧墙的绘制关系推导所有段落的开始时刻
const buildSchedule = (targets) => {
  const construction = CONSTRUCTION;
  const backGrid = BACK_GRID;
  const chartTiming = CHART_TIMING;
  const atmosphereTiming = ATMOSPHERE_TIMING;
  const contentTiming = CONTENT_TIMING;
  const roadStart = 0;
  const roadDuration = construction.roadRayDuration;
  const roadTiming = buildRoadTiming(targets, roadStart, roadDuration, construction);
  const gateStart = 0;
  const gateDuration = construction.mainArchDuration;
  const gateEnd = gateStart + gateDuration;
  const secondaryDuration = scaledDurationByLength(targets.frame.gateSecondary, targets.frame.gatePrimary, gateDuration);
  const tertiaryDuration = scaledDurationByLength(targets.frame.gateTertiary, targets.frame.gatePrimary, gateDuration);
  const primary = { elements: targets.frame.gatePrimary, start: gateStart, duration: gateDuration };
  const secondary = {
    elements: targets.frame.gateSecondary,
    start: construction.secondaryArchStart,
    duration: secondaryDuration,
  };
  const tertiary = { elements: targets.frame.gateTertiary, start: construction.tertiaryArchStart, duration: tertiaryDuration };
  const frontMarkers = [primary, secondary];
  const rearMarkers = [secondary, tertiary];
  const leftBase = ribTimes('leftBase', frontMarkers, rearMarkers, construction);
  const leftShoulder = ribTimes('leftShoulder', frontMarkers, rearMarkers, construction);
  const rightShoulder = ribTimes('rightShoulder', frontMarkers, rearMarkers, construction);
  const rightBase = ribTimes('rightBase', frontMarkers, rearMarkers, construction);
  const ribsEnd =
    Math.max(
      leftBase.front,
      leftBase.rear,
      leftShoulder.front,
      leftShoulder.rear,
      rightShoulder.front,
      rightShoulder.rear,
      rightBase.front,
      rightBase.rear,
    ) + construction.ribDuration;
  const archesEnd = Math.max(gateEnd, secondary.start + secondary.duration, tertiary.start + tertiary.duration);
  const wallLeftBaseStart = Math.max(0, leftBase.rear + construction.ribDuration + backGrid.afterGateDelay);
  const wallLeftStart = wallLeftBaseStart + backGrid.leftWallStartDelay;
  const centerCandidate = gateStart + gateDuration * backGrid.centerGateProgress + backGrid.centerWallStartDelay;
  const wallCenterStart = Math.max(centerCandidate, wallLeftStart + backGrid.centerAfterLeftDelay);
  const rightCandidate = rightBase.rear + construction.ribDuration + backGrid.afterGateDelay + backGrid.rightWallStartDelay;
  const wallRightStart = Math.max(wallLeftBaseStart, rightCandidate, wallCenterStart + backGrid.rightAfterCenterDelay);
  const wallLeftRowsStart = wallLeftStart + backGrid.rowsDelay;
  const wallCenterRowsStart = wallCenterStart + backGrid.rowsDelay * 0.5;
  const wallRightRowsStart = wallRightStart + backGrid.rowsDelay;
  const wallLeftEnd = Math.max(wallLeftStart + backGrid.structureDuration, wallLeftRowsStart + backGrid.rowsDuration);
  const wallRightEnd = Math.max(wallRightStart + backGrid.structureDuration, wallRightRowsStart + backGrid.rowsDuration);
  const leftChartStart = wallLeftEnd;
  const leftChartRevealDuration =
    Math.max(leftChartStart + chartTiming.leftRevealMinDuration, archesEnd - chartTiming.leftRevealGateOverlap) -
    leftChartStart;
  const rightChartStart = Math.max(wallRightStart, wallRightEnd - chartTiming.rightRevealWallOverlap);
  const rightChartRevealDuration = Math.max(
    chartTiming.rightRevealMinDuration,
    wallRightEnd - rightChartStart + chartTiming.rightRevealPadding,
  );
  const rightChartEnd = rightChartStart + rightChartRevealDuration;
  const priceScaleStart = rightChartStart + rightChartRevealDuration * 0.72;
  const liveCandleStart = Math.max(
    priceScaleStart + chartTiming.priceToLiveDelay,
    rightChartEnd + chartTiming.liveAfterRightRevealDelay,
  );
  const backGridEnd = Math.max(
    wallLeftEnd,
    wallRightEnd,
    wallCenterStart + backGrid.structureDuration,
    wallCenterRowsStart + backGrid.rowsDuration,
  );
  const gateAtmosphereStart = Math.max(backGridEnd, ribsEnd) + backGrid.afterRibsDelay;
  const strategyStart = Math.max(gateStart, gateStart + gateDuration * contentTiming.strategyGateProgress);
  const timeStart = strategyStart + contentTiming.timeAfterStrategyDelay;
  const tunnelLightStart = Math.max(timeStart, gateEnd);
  const gateForegroundStart = Math.max(gateStart + gateDuration * atmosphereTiming.gateForegroundProgress, gateEnd);
  const subheadStart = timeStart + contentTiming.subheadAfterTimeDelay;
  const timelineStart = subheadStart + contentTiming.timelineAfterSubheadDelay;
  return {
    construction,
    backGrid,
    chartTiming,
    atmosphereTiming,
    contentTiming,
    road: { start: roadStart, duration: roadDuration, timing: roadTiming },
    gate: {
      primary,
      secondary,
      tertiary,
      primaryEnd: gateEnd,
      archesEnd,
      primaryLayerRevealDuration: Math.min(0.18, gateDuration * 0.16),
    },
    ribs: {
      duration: construction.ribDuration,
      leftBase,
      leftShoulder,
      rightShoulder,
      rightBase,
      end: ribsEnd,
    },
    wall: {
      leftBaseStart: wallLeftBaseStart,
      leftStart: wallLeftStart,
      leftRowsStart: wallLeftRowsStart,
      leftEnd: wallLeftEnd,
      rightStart: wallRightStart,
      rightRowsStart: wallRightRowsStart,
      rightEnd: wallRightEnd,
      centerStart: wallCenterStart,
      centerRowsStart: wallCenterRowsStart,
      structureDuration: backGrid.structureDuration,
      rowsDuration: backGrid.rowsDuration,
      backGridEnd,
    },
    chart: {
      leftChartStart,
      rightChartStart,
      leftChartRevealDuration,
      rightChartRevealDuration,
      priceScaleStart,
      liveCandleStart,
    },
    atmosphere: { tunnelLightStart, gateAtmosphereStart, gateForegroundStart },
    content: {
      strategyStart,
      timeStart,
      subheadStart,
      timelineStart,
      headerStart: Math.max(timeStart, subheadStart - 0.12),
    },
  };
};

/* ================= intro：内容 / 时间轴 / 图表 / header 段 ================= */

const headlineSplits = new WeakMap();

const revertHeadlineSplit = (hero) => {
  const split = headlineSplits.get(hero);
  if (!split) return;
  split.revert();
  headlineSplits.delete(hero);
};

// 标题 SplitText 逐字 → “Time” → 副标题 → CTA
const buildContent = (tl, hero, targets, positions) => {
  const { gsap, SplitText } = window;
  const { strategyStart, timeStart, subheadStart } = positions;
  const strategyLine = targets.strategy[0];
  const split = strategyLine
    ? SplitText.create(strategyLine, {
        type: 'chars',
        charsClass: 'hero__headline-char',
        tag: 'span',
        reduceWhiteSpace: false,
        aria: 'none',
      })
    : null;
  const chars = split?.chars ?? [];
  if (split) headlineSplits.set(hero, split);
  const center = (chars.length - 1) / 2;
  tl.set(targets.strategy, { opacity: 1 }, strategyStart)
    .fromTo(
      chars,
      {
        opacity: 0,
        display: 'inline-block',
        x: (index) => `${(center - index) * 0.12}em`,
        scaleX: 0.78,
        clipPath: 'inset(-18% 46% -34% 46%)',
        webkitClipPath: 'inset(-18% 46% -34% 46%)',
        transformOrigin: '50% 62%',
      },
      {
        opacity: 1,
        x: 0,
        scaleX: 1,
        clipPath: 'inset(-18% 0% -34% 0%)',
        webkitClipPath: 'inset(-18% 0% -34% 0%)',
        duration: CONTENT_TIMING.strategyCharsDuration,
        ease: 'power4.out',
        stagger: { amount: CONTENT_TIMING.strategyCharsStaggerAmount, from: 'center' },
        onComplete: () => {
          gsap.set(chars, { clearProps: 'opacity,transform,clipPath,webkitClipPath' });
        },
      },
      strategyStart,
    )
    .fromTo(
      targets.time,
      { opacity: 0, y: 26, z: -72, scale: 0.88, rotationX: -7, transformPerspective: 760, transformOrigin: '50% 68%' },
      {
        opacity: 1,
        y: 0,
        z: 0,
        scale: 1,
        rotationX: 0,
        transformPerspective: 760,
        duration: CONTENT_TIMING.timeDuration,
        ease: 'expo.out',
      },
      timeStart,
    )
    .set(targets.subhead, { opacity: 1 }, subheadStart)
    .fromTo(targets.subhead, { y: 8 }, { y: 0, duration: CONTENT_TIMING.subheadMoveDuration, ease: 'power3.out' }, subheadStart)
    .fromTo(
      targets.subheadParts,
      { opacity: 0, y: 9 },
      {
        opacity: 1,
        y: 0,
        duration: CONTENT_TIMING.subheadPartsDuration,
        ease: 'power3.out',
        stagger: CONTENT_TIMING.subheadPartsStagger,
      },
      subheadStart,
    )
    .fromTo(
      targets.contentCta,
      { opacity: 0, y: 10, scale: 0.96 },
      { opacity: introOpacityFor, y: 0, scale: 1, duration: CONTENT_TIMING.contentCtaDuration, ease: 'power3.out' },
      subheadStart + CONTENT_TIMING.contentCtaDelay,
    );
};

// 底部时间轴：容器 → Rewind → 内轨 → 箭头 → 外轨 → Past/Now
const buildTimelineIntro = (tl, targets, position) => {
  tl.set(targets.timeline, { opacity: 1 }, position)
    .set(targets.timelineInnerTracks, { opacity: 0, scaleX: 0 }, position)
    .set(targets.timelineOuterTracks, { opacity: 0, scaleX: 0 }, position)
    .set([...targets.timelineLeftInnerTrack, ...targets.timelineLeftOuterTrack], { transformOrigin: '100% 50%' }, position)
    .set([...targets.timelineRightInnerTrack, ...targets.timelineRightOuterTrack], { transformOrigin: '0% 50%' }, position)
    .fromTo(targets.timeline, { y: 7 }, { y: 0, duration: TIMELINE_TIMING.containerDuration, ease: 'power3.out' }, position)
    .fromTo(
      targets.timelineRewind,
      { opacity: 0, y: 5 },
      { opacity: 1, y: 0, duration: TIMELINE_TIMING.rewindDuration, ease: 'power3.out' },
      position,
    )
    .to(
      targets.timelineInnerTracks,
      { opacity: 1, scaleX: 1, duration: TIMELINE_TIMING.innerTracksDuration, ease: 'power2.out' },
      position + TIMELINE_TIMING.innerTracksDelay,
    )
    .fromTo(
      targets.timelineChevrons,
      { opacity: 0, y: 3 },
      {
        opacity: 1,
        y: 0,
        duration: TIMELINE_TIMING.chevronsDuration,
        ease: 'power3.out',
        stagger: TIMELINE_TIMING.chevronsStagger,
      },
      position + TIMELINE_TIMING.chevronsDelay,
    )
    .to(
      targets.timelineOuterTracks,
      { opacity: 1, scaleX: 1, duration: TIMELINE_TIMING.outerTracksDuration, ease: 'power2.out' },
      position + TIMELINE_TIMING.outerTracksDelay,
    )
    .fromTo(
      targets.timelineOuterLabels,
      { opacity: 0, y: 5 },
      {
        opacity: 1,
        y: 0,
        duration: TIMELINE_TIMING.outerLabelsDuration,
        ease: 'power3.out',
        stagger: TIMELINE_TIMING.outerLabelsStagger,
      },
      position + TIMELINE_TIMING.outerLabelsDelay,
    );
};

// 图表揭示：clipPath 三段展开 + 价格轴 + live 启动回调
const buildChartReveal = (tl, targets, positions, onLiveStart) => {
  const leftStart = positions.leftChartStart;
  const leftDuration = positions.leftChartRevealDuration;
  const rightDuration = positions.rightChartRevealDuration;
  const lead = Math.min(0.36, Math.max(0.26, leftDuration + 0.08));
  const revealStart = Math.max(0, leftStart - lead);
  const totalDuration = Math.min(2, Math.max(1.6, leftDuration + rightDuration + 0.5));
  const tabletColumns =
    targets.chart[0]?.ownerDocument.defaultView?.matchMedia('(min-width: 48rem) and (max-width: 63.999rem)').matches ??
    false;
  const firstStop = tabletColumns ? 56 : 58;
  const secondStop = tabletColumns ? 29 : 39;
  const snapDuration = 0.01;
  const firstDuration = totalDuration * 0.35;
  const settleDuration = Math.max(0.22, totalDuration - firstDuration - snapDuration);
  const settleStart = revealStart + firstDuration + snapDuration;
  const priceScaleDuration = PRICE_SCALE_BASE_DURATION * 1.26 + PRICE_SCALE_EXTRA_DURATION * 2.4;
  const priceScaleStart = settleStart + settleDuration * 0.55;
  const priceScaleEnd = priceScaleStart + priceScaleDuration;
  const liveStart = Math.max(positions.liveCandleStart, priceScaleEnd + 0.014);
  tl.set(targets.chartCandles, { clipPath: 'inset(0% 100% 0% 0%)', webkitClipPath: 'inset(0% 100% 0% 0%)' }, revealStart)
    .set(targets.chart, { opacity: 1 }, revealStart)
    .set(targets.chartCandles, { opacity: 0.18, y: 4, scale: 0.996 }, revealStart)
    .to(
      targets.chartCandles,
      {
        clipPath: `inset(0% ${firstStop}% 0% 0%)`,
        webkitClipPath: `inset(0% ${firstStop}% 0% 0%)`,
        duration: firstDuration,
        ease: 'power2.inOut',
      },
      revealStart,
    )
    .to(
      targets.chartCandles,
      {
        clipPath: `inset(0% ${secondStop}% 0% 0%)`,
        webkitClipPath: `inset(0% ${secondStop}% 0% 0%)`,
        duration: snapDuration,
        ease: 'none',
      },
      revealStart + firstDuration,
    )
    .to(
      targets.chartCandles,
      { clipPath: 'inset(0% 0% 0% 0%)', webkitClipPath: 'inset(0% 0% 0% 0%)', duration: settleDuration, ease: 'power2.out' },
      settleStart,
    )
    .to(
      targets.chartCandles,
      { opacity: introOpacityFor, y: 0, scale: 1, duration: CANDLE_SETTLE_DURATION * 1.25, ease: 'power2.out' },
      revealStart + 0.035,
    )
    .fromTo(
      targets.chartPriceScale,
      { opacity: 0, clipPath: 'inset(0% 0% 0% 68%)', webkitClipPath: 'inset(0% 0% 0% 68%)' },
      {
        opacity: introOpacityFor,
        clipPath: 'inset(0% 0% 0% 0%)',
        webkitClipPath: 'inset(0% 0% 0% 0%)',
        duration: priceScaleDuration,
        ease: 'power3.out',
      },
      priceScaleStart,
    )
    .call(onLiveStart, [], liveStart + CHART_TIMING.liveStartCallbackDelay);
};

const buildHeader = (tl, targets, position) => {
  tl.set(targets.header, { opacity: 1 }, position)
    .fromTo(
      targets.headerBrand,
      { opacity: 0, y: -4 },
      { opacity: 1, y: 0, duration: HEADER_TIMING.duration, ease: 'power2.out' },
      position,
    )
    .fromTo(
      targets.headerCta,
      { opacity: 0, y: -4 },
      { opacity: 1, y: 0, duration: HEADER_TIMING.duration, ease: 'power2.out' },
      position + HEADER_TIMING.ctaDelay,
    );
};

/* ================= intro：运行时（reset / 静态完成 / 构建 / 入口） ================= */

const activeIntroTimelines = new WeakMap();

const introChartsEnabled = () => !matches(CHART_SKIP_QUERY);
const introChartTargetMode = (chartsEnabled = introChartsEnabled()) => (chartsEnabled ? 'containers' : 'none');

const dispatchChartLive = (hero) => {
  if (matches(CHART_SKIP_QUERY)) return;
  hero.querySelectorAll('.hero-chart').forEach((chart) => {
    chart.dispatchEvent(new CustomEvent(CHART_LIVE_START_EVENT));
  });
};

const dispatchIntroComplete = (hero) => {
  window.dispatchEvent(new CustomEvent(INTRO_COMPLETE_EVENT, { detail: { hero } }));
};

const markIntroStarted = (hero) => {
  hero.dataset.introStartedAt = `${Math.round(performance.now())}`;
  window.dispatchEvent(new CustomEvent(INTRO_STARTED_EVENT, { detail: { hero } }));
};

// 清掉进行中的时间线与全部内联痕迹，恢复 SVG 初始几何
const resetIntro = (hero, chartTargetMode = introChartTargetMode()) => {
  const { gsap } = window;
  const active = activeIntroTimelines.get(hero);
  if (active) {
    active.kill();
    activeIntroTimelines.delete(hero);
  }
  revertHeadlineSplit(hero);
  const targets = collectTargets(hero, { chartTargetMode });
  gsap.set(allTargets(targets), { clearProps: CLEAR_PROPS });
  restorePaths([
    ...targets.frame.gatePrimary,
    ...targets.frame.gatePrimaryGlow,
    ...targets.frame.gatePrimaryDetails,
    ...targets.frame.gateSecondary,
    ...targets.frame.gateTertiary,
  ]);
  restoreRoadCross(targets.frame.roadCross);
  restoreRoadRays(targets.frame.roadRays);
  restoreLines(ribTargets(targets));
  restoreLines(wallTargets(targets));
  return targets;
};

// comfort / 非首屏路径：不播动画，直接进入完成态
const completeIntroStatically = (hero) => {
  resetIntro(hero);
  hero.dataset.introState = 'done';
  hero.classList.add('is-intro-complete');
  dispatchChartLive(hero);
  dispatchIntroComplete(hero);
};

// boot 时间线主构建
const buildIntroTimeline = (hero) => {
  const { gsap } = window;
  const chartsEnabled = introChartsEnabled();
  const targets = resetIntro(hero, introChartTargetMode(chartsEnabled));
  const frameElements = Object.values(targets.frame).flat();
  const decorElements = [
    ...targets.gateAtmosphere,
    ...targets.tunnelLight,
    ...targets.gateForeground,
    ...targets.chart,
    ...targets.chartLeftCandles,
    ...targets.chartRightCandles,
    ...targets.chartLeftBodies,
    ...targets.chartRightBodies,
    ...targets.chartLeftWicks,
    ...targets.chartRightWicks,
    ...targets.chartLiveCandles,
    ...targets.chartPriceScale,
    ...targets.chartPriceTicks,
    ...targets.time,
    ...targets.strategy,
    ...targets.subhead,
    ...targets.subheadParts,
    ...targets.contentCta,
    ...targets.timeline,
    ...targets.timelineParts,
    ...targets.header,
    ...targets.headerBrand,
    ...targets.headerCta,
  ];
  hero.classList.add('is-intro-preparing', 'is-intro-complete');
  hero.dataset.introState = 'running';
  hero.classList.remove('is-intro-complete');
  [...targets.frame.gatePrimary, ...targets.frame.gateSecondary, ...targets.frame.gateTertiary].forEach(collapseGatePath);
  collapseRoadRays(targets.frame.roadRays);
  collapseRoadCross(targets.frame.roadCross);
  collapseLinesToStart(ribTargets(targets));
  collapseWalls([
    ...targets.frame.wallLeftStructure,
    ...targets.frame.wallRightStructure,
    ...targets.frame.wallCenterStructure,
    ...targets.frame.wallLeftRows,
  ]);
  collapseWalls(
    [...targets.frame.wallRightRows, ...targets.frame.wallBridgeRows, ...targets.frame.wallThresholdRows],
    'left-to-right',
  );
  gsap.set(frameElements, { opacity: 0 });
  gsap.set(decorElements, { opacity: 0 });
  gsap.set([...targets.headerBrand, ...targets.headerCta], { y: -5 });
  hero.classList.remove('is-intro-preparing');
  const tl = gsap.timeline({
    defaults: { ease: 'power3.out' },
    onComplete: () => {
      gsap.set(allTargets(targets), { clearProps: CLEAR_PROPS });
      hero.dataset.introState = 'done';
      hero.classList.add('is-intro-complete');
      dispatchChartLive(hero);
      dispatchIntroComplete(hero);
      activeIntroTimelines.delete(hero);
    },
  });
  const schedule = buildSchedule(targets);
  const skipTimeline = matches(TIMELINE_SKIP_QUERY);

  animateRoadRays(tl, targets.frame.roadRays, schedule.road.timing);
  animateRoadCross(tl, targets.frame.roadCross, schedule.road.timing);
  drawWallLines(
    tl,
    targets.frame.wallLeftStructure,
    { duration: schedule.wall.structureDuration, ease: 'none', stagger: { each: 0.035, from: 'start' } },
    schedule.wall.leftStart,
  );
  drawWallLines(
    tl,
    targets.frame.wallLeftRows,
    { duration: schedule.wall.rowsDuration, ease: 'none', stagger: { each: 0.032, from: 'start' } },
    schedule.wall.leftRowsStart,
  );
  drawWallLines(
    tl,
    targets.frame.wallCenterStructure,
    { duration: schedule.wall.structureDuration, ease: 'none' },
    schedule.wall.centerStart,
  );
  drawWallLines(
    tl,
    targets.frame.wallBridgeRows,
    {
      duration: schedule.wall.rowsDuration,
      direction: 'left-to-right',
      ease: 'none',
      stagger: { each: 0.032, from: 'start' },
    },
    schedule.wall.centerRowsStart,
  );
  drawWallLines(
    tl,
    targets.frame.wallThresholdRows,
    {
      duration: schedule.wall.rowsDuration,
      direction: 'left-to-right',
      ease: 'none',
      stagger: { each: 0.032, from: 'start' },
    },
    schedule.wall.centerRowsStart,
  );
  drawWallLines(
    tl,
    targets.frame.wallRightStructure,
    { duration: schedule.wall.structureDuration, ease: 'none', stagger: { each: 0.035, from: 'start' } },
    schedule.wall.rightStart,
  );
  drawWallLines(
    tl,
    targets.frame.wallRightRows,
    {
      duration: schedule.wall.rowsDuration,
      direction: 'left-to-right',
      ease: 'none',
      stagger: { each: 0.032, from: 'start' },
    },
    schedule.wall.rightRowsStart,
  );
  drawGateArch(
    tl,
    targets.frame.gatePrimary,
    { opacity: 1, duration: schedule.gate.primary.duration, ease: 'power1.inOut' },
    schedule.gate.primary.start,
  );
  drawGateArch(
    tl,
    targets.frame.gateSecondary,
    { opacity: 0.78, duration: schedule.gate.secondary.duration, ease: 'power1.inOut' },
    schedule.gate.secondary.start,
  );
  drawGateArch(
    tl,
    targets.frame.gateTertiary,
    { opacity: 0.62, duration: schedule.gate.tertiary.duration, ease: 'power1.inOut' },
    schedule.gate.tertiary.start,
  );
  drawRibPair(
    tl,
    targets.frame.ribLeftBaseFront,
    targets.frame.ribLeftBaseRear,
    schedule.ribs.leftBase.front,
    schedule.ribs.leftBase.rear,
    schedule.construction.ribDuration,
  );
  drawRibPair(
    tl,
    targets.frame.ribLeftShoulderFront,
    targets.frame.ribLeftShoulderRear,
    schedule.ribs.leftShoulder.front,
    schedule.ribs.leftShoulder.rear,
    schedule.construction.ribDuration,
  );
  drawRibPair(
    tl,
    targets.frame.ribRightShoulderFront,
    targets.frame.ribRightShoulderRear,
    schedule.ribs.rightShoulder.front,
    schedule.ribs.rightShoulder.rear,
    schedule.construction.ribDuration,
  );
  drawRibPair(
    tl,
    targets.frame.ribRightBaseFront,
    targets.frame.ribRightBaseRear,
    schedule.ribs.rightBase.front,
    schedule.ribs.rightBase.rear,
    schedule.construction.ribDuration,
  );
  const layerRevealDuration = schedule.gate.primaryLayerRevealDuration;
  tl.to(
    targets.frame.gatePrimaryGlow,
    { opacity: 0.36, duration: layerRevealDuration, ease: 'power2.out' },
    schedule.gate.primaryEnd,
  )
    .to(
      targets.frame.gatePrimaryDetails,
      { opacity: 0.78, duration: layerRevealDuration, ease: 'power2.out' },
      schedule.gate.primaryEnd,
    )
    .to(
      targets.tunnelLight,
      { opacity: introOpacityFor, duration: schedule.atmosphereTiming.tunnelLightDuration, ease: 'power2.out' },
      schedule.atmosphere.tunnelLightStart,
    )
    .to(
      targets.gateForeground,
      { opacity: introOpacityFor, duration: schedule.atmosphereTiming.gateForegroundDuration, ease: 'power2.out' },
      schedule.atmosphere.gateForegroundStart,
    );
  if (targets.gateAtmosphere.length > 0) {
    tl.to(
      targets.gateAtmosphere,
      { opacity: introOpacityFor, duration: schedule.atmosphereTiming.gateAtmosphereDuration, ease: 'power2.out' },
      schedule.atmosphere.gateAtmosphereStart,
    );
  }
  buildHeader(tl, targets, schedule.content.headerStart);
  if (chartsEnabled) {
    buildChartReveal(
      tl,
      targets,
      {
        leftChartStart: schedule.chart.leftChartStart,
        leftChartRevealDuration: schedule.chart.leftChartRevealDuration,
        rightChartRevealDuration: schedule.chart.rightChartRevealDuration,
        liveCandleStart: schedule.chart.liveCandleStart,
      },
      () => dispatchChartLive(hero),
    );
  }
  buildContent(tl, hero, targets, {
    strategyStart: schedule.content.strategyStart,
    timeStart: schedule.content.timeStart,
    subheadStart: schedule.content.subheadStart,
  });
  if (!skipTimeline) buildTimelineIntro(tl, targets, schedule.content.timelineStart);
  activeIntroTimelines.set(hero, tl);
  markIntroStarted(hero);
};

const setupHeroIntro = () => {
  trackMidScroll();
  document.querySelectorAll('.hero').forEach((hero) => {
    if (hero.dataset.introReady === 'true') return;
    hero.dataset.introReady = 'true';
    if (shouldPlayIntro()) buildIntroTimeline(hero);
    else completeIntroStatically(hero);
  });
};

// 入口静态揭示路径（intro 完全不跑时）：置完成态 + 派发两类事件
const staticReveal = () => {
  document.querySelectorAll('.hero').forEach((hero) => {
    hero.dataset.introReady = 'true';
    hero.dataset.introState = 'done';
    hero.classList.remove('is-intro-preparing');
    hero.classList.add('is-intro-complete');
    hero.querySelectorAll('.hero-chart').forEach((chart) => {
      chart.dispatchEvent(new CustomEvent(CHART_LIVE_START_EVENT));
    });
    dispatchIntroComplete(hero);
  });
};

/* ================= 指针交互（对照 heroInteraction） ================= */

const isLowQualityDevice = () => {
  if (typeof navigator === 'undefined') return false;
  const memory = navigator.deviceMemory;
  const cores = navigator.hardwareConcurrency ?? 8;
  return navigator.connection?.saveData === true || (typeof memory === 'number' && memory <= 4) || cores <= 4;
};

const onRewindPhaseAway = (handler) => {
  const listener = (event) => {
    const phase = event.detail?.phase;
    if (phase && phase !== 'hero') handler();
  };
  window.addEventListener('rewindtransitionphasechange', listener);
  return () => {
    window.removeEventListener('rewindtransitionphasechange', listener);
  };
};

const buildInteractionContext = (hero, gate) => {
  const timelineDisabledMedia = window.matchMedia(TIMELINE_SKIP_QUERY);
  const clearPointerState = () => {
    hero.classList.remove('is-pointer-active');
    delete hero.dataset.timelineState;
  };
  const chartStage = hero.querySelector('.hero__chart-stage');
  const timeline = hero.querySelector('.hero__timeline');
  const headline = hero.querySelector('.hero__headline-line');
  const gateRoot = hero.querySelector('.hero-gate');
  const gateSvg = gateRoot?.querySelector('.hero-gate__svg');
  const gateLightFills = Array.from(gateRoot?.querySelectorAll('.hero-gate__grid-light-fill') ?? []);
  const timelineAvailable = Boolean(timeline);
  const gateLightAvailable = Boolean(gateSvg && gateLightFills.length > 0);
  const strategyParallaxAvailable = !isLowQualityDevice() && Boolean(headline) && gateLightAvailable;
  const hasMoveInteraction = timelineAvailable || gateLightAvailable || strategyParallaxAvailable;
  const baseGridLightOpacity =
    Number.parseFloat(window.getComputedStyle(hero).getPropertyValue('--hero-grid-light-opacity')) || 0;
  const baseGateGridLightOpacity =
    Number.parseFloat(window.getComputedStyle(hero).getPropertyValue('--hero-gate-grid-light-opacity')) || 0;
  const setGateLight = (x = 200, y = 302, radius = 170) => {
    if (!gateLightAvailable) return;
    gateLightFills.forEach((fill) => {
      fill.setAttribute('cx', x.toFixed(2));
      fill.setAttribute('cy', y.toFixed(2));
      fill.setAttribute('r', radius.toFixed(2));
    });
  };
  // 指针横向三等分 → past / rewind / now 高亮
  const updateTimelineStateFromPoint = (pointerX, pointerY, heroRect) => {
    if (!timelineAvailable) return;
    if (!gate.isEnabled()) {
      clearPointerState();
      return;
    }
    if (timelineDisabledMedia.matches) {
      delete hero.dataset.timelineState;
      return;
    }
    const stageTop = chartStage?.getBoundingClientRect()?.top ?? heroRect.top;
    if (pointerY < stageTop || pointerY > heroRect.bottom || heroRect.width <= 0) {
      delete hero.dataset.timelineState;
      return;
    }
    const ratio = (pointerX - heroRect.left) / heroRect.width;
    const state = ratio < 1 / 3 ? 'past' : ratio > 2 / 3 ? 'now' : 'rewind';
    if (hero.dataset.timelineState !== state) hero.dataset.timelineState = state;
  };
  return {
    activeGateGridLightOpacity: 0.9,
    activeGridLightOpacity: 0.72,
    baseGateGridLightOpacity,
    baseGridLightOpacity,
    chartStage,
    clearPointerState,
    gateLightAvailable,
    gateSvg,
    hasMoveInteraction,
    hero,
    setGateLight,
    strategyParallaxAvailable,
    timelineAvailable,
    updateTimelineState: (event) => {
      if (event.pointerType === 'touch') return;
      updateTimelineStateFromPoint(event.clientX, event.clientY, hero.getBoundingClientRect());
    },
    updateTimelineStateFromPoint,
  };
};

// 粗指针 / phone：仅维护 gate 光心默认值与 timeline 高亮
const setupLiteInteraction = (ctx, gate) => {
  const { hero, clearPointerState, setGateLight, timelineAvailable, updateTimelineState } = ctx;
  setGateLight();
  if (!timelineAvailable) return;
  const unsubscribeGate = gate.onChange((enabled) => {
    if (!enabled) clearPointerState();
  });
  const unsubscribePhase = onRewindPhaseAway(clearPointerState);
  hero.addEventListener('pointerenter', updateTimelineState, { passive: true });
  hero.addEventListener('pointermove', updateTimelineState, { passive: true });
  hero.addEventListener(
    'pointerleave',
    () => {
      clearPointerState();
    },
    { passive: true },
  );
  window.addEventListener(
    'pagehide',
    () => {
      unsubscribeGate();
      unsubscribePhase();
    },
    { once: true },
  );
};

// 无移动交互目标时的悬停亮度切换
const setupHoverInteraction = (ctx, gate) => {
  const { gsap } = window;
  const { hero, clearPointerState } = ctx;
  const reset = (immediate = false) => {
    clearPointerState();
    const base = {
      '--hero-grid-light-opacity': ctx.baseGridLightOpacity,
      '--hero-gate-grid-light-opacity': ctx.baseGateGridLightOpacity,
    };
    if (immediate) {
      gsap.set(hero, base);
      return;
    }
    gsap.to(hero, { ...base, duration: 0.18, ease: 'power2.out' });
  };
  hero.addEventListener(
    'pointerenter',
    (event) => {
      if (event.pointerType === 'touch') return;
      if (!gate.isEnabled()) {
        reset(true);
        return;
      }
      hero.classList.add('is-pointer-active');
      gsap.to(hero, {
        '--hero-grid-light-opacity': ctx.activeGridLightOpacity,
        '--hero-gate-grid-light-opacity': ctx.activeGateGridLightOpacity,
        duration: 0.18,
        ease: 'power2.out',
      });
    },
    { passive: true },
  );
  hero.addEventListener(
    'pointerleave',
    () => {
      reset();
    },
    { passive: true },
  );
  const unsubscribeGate = gate.onChange((enabled) => {
    if (!enabled) reset(true);
  });
  const unsubscribePhase = onRewindPhaseAway(() => {
    reset(true);
  });
  window.addEventListener(
    'pagehide',
    () => {
      unsubscribeGate();
      unsubscribePhase();
    },
    { once: true },
  );
};

// 精指针完整交互：gate 光斑跟随 + 标题视差 + timeline 高亮
const setupPointerInteraction = (ctx, gate) => {
  const { gsap } = window;
  const {
    hero,
    gateSvg,
    gateLightAvailable,
    strategyParallaxAvailable,
    clearPointerState,
    setGateLight,
    updateTimelineStateFromPoint,
  } = ctx;
  let moveFrame = 0;
  let settleFrame = 0;
  let settleTimer = 0;
  let svgRect;
  let lightRadius = 170;
  let pointerX = 0;
  let pointerY = 0;
  let pointerTracked = false;
  let pointerActive = false;
  let resizeObserver;
  const light = { x: 200, y: 302, radius: 170 };
  const parallax = { x: 0, y: 0 };
  const opacityTweenVars = { duration: 0.18, ease: 'power2.out' };

  const cancelMoveFrame = () => {
    if (moveFrame !== 0) {
      window.cancelAnimationFrame(moveFrame);
      moveFrame = 0;
    }
  };
  const cancelSettle = () => {
    if (settleFrame !== 0) {
      window.cancelAnimationFrame(settleFrame);
      settleFrame = 0;
    }
    if (settleTimer !== 0) {
      window.clearTimeout(settleTimer);
      settleTimer = 0;
    }
  };
  const invalidateSvgRect = () => {
    svgRect = undefined;
  };
  const applyGateLight = () => {
    setGateLight(light.x, light.y, light.radius);
  };
  const applyParallax = () => {
    if (!strategyParallaxAvailable) return;
    hero.style.setProperty('--hero-strategy-parallax-x', `${parallax.x.toFixed(2)}px`);
    hero.style.setProperty('--hero-strategy-parallax-y', `${parallax.y.toFixed(2)}px`);
  };
  const resetGateLight = () => {
    light.x = 200;
    light.y = 302;
    light.radius = 170;
    applyGateLight();
  };
  const lightTweenVars = { duration: 0.08, ease: 'power3.out', onUpdate: applyGateLight };
  const lightX = gsap.quickTo(light, 'x', lightTweenVars);
  const lightY = gsap.quickTo(light, 'y', lightTweenVars);
  const lightRadiusTo = gsap.quickTo(light, 'radius', { duration: 0.12, ease: 'power3.out', onUpdate: applyGateLight });
  const parallaxX = gsap.quickTo(parallax, 'x', { duration: 0.42, ease: 'power3.out', onUpdate: applyParallax });
  const parallaxY = gsap.quickTo(parallax, 'y', { duration: 0.46, ease: 'power3.out', onUpdate: applyParallax });
  const zeroParallax = () => {
    parallaxX(0);
    parallaxY(0);
    parallax.x = 0;
    parallax.y = 0;
    applyParallax();
  };
  const settleParallax = () => {
    if (Math.abs(parallax.x) < 0.01 && Math.abs(parallax.y) < 0.01) {
      zeroParallax();
      return;
    }
    parallaxX(0);
    parallaxY(0);
  };
  const gridOpacityTo = gsap.quickTo(hero, '--hero-grid-light-opacity', opacityTweenVars);
  const gateOpacityTo = gsap.quickTo(hero, '--hero-gate-grid-light-opacity', opacityTweenVars);
  const applyLightOpacity = (active, immediate = false) => {
    const grid = active ? ctx.activeGridLightOpacity : ctx.baseGridLightOpacity;
    const gateGrid = active ? ctx.activeGateGridLightOpacity : ctx.baseGateGridLightOpacity;
    if (immediate) {
      gsap.set(hero, { '--hero-grid-light-opacity': grid, '--hero-gate-grid-light-opacity': gateGrid });
      return;
    }
    gridOpacityTo(grid);
    gateOpacityTo(gateGrid);
  };
  gsap.set(hero, {
    '--hero-grid-light-opacity': ctx.baseGridLightOpacity,
    '--hero-gate-grid-light-opacity': ctx.baseGateGridLightOpacity,
  });
  const deactivate = (immediate = false, settle = false) => {
    pointerActive = false;
    clearPointerState();
    cancelMoveFrame();
    applyLightOpacity(false, immediate);
    if (gateLightAvailable) {
      if (immediate) resetGateLight();
      else {
        lightX(200);
        lightY(302);
        lightRadiusTo(170);
      }
    }
    if (strategyParallaxAvailable) {
      if (immediate) {
        if (settle) settleParallax();
        else zeroParallax();
      } else {
        parallaxX(0);
        parallaxY(0);
      }
    }
  };
  const hardReset = () => {
    pointerTracked = false;
    invalidateSvgRect();
    deactivate(true, true);
  };
  const activate = (immediate = false) => {
    if (pointerActive) return;
    pointerActive = true;
    hero.classList.add('is-pointer-active');
    applyLightOpacity(true, immediate);
  };
  const pointerInsideHero = () => {
    if (!pointerTracked) return false;
    const rect = hero.getBoundingClientRect();
    return pointerX >= rect.left && pointerX <= rect.right && pointerY >= rect.top && pointerY <= rect.bottom;
  };
  const measureSvg = () => {
    if (!gateLightAvailable || !gateSvg) return;
    svgRect = gateSvg.getBoundingClientRect();
    if (svgRect.width <= 0) {
      lightRadius = 170;
      return;
    }
    lightRadius = Math.max(120, Math.min(240, (320 / svgRect.width) * 400));
  };
  const applyPointer = () => {
    moveFrame = 0;
    if (!gate.isEnabled()) {
      deactivate(true);
      return;
    }
    measureSvg();
    const heroRect = hero.getBoundingClientRect();
    updateTimelineStateFromPoint(pointerX, pointerY, heroRect);
    if (gateLightAvailable && svgRect && svgRect.width > 0 && svgRect.height > 0) {
      const svgX = ((pointerX - svgRect.left) / svgRect.width) * 400;
      const svgY = ((pointerY - svgRect.top) / svgRect.height) * 520;
      lightX(Math.max(-1200, Math.min(1600, svgX)));
      lightY(Math.max(-180, Math.min(1080, svgY)));
      lightRadiusTo(lightRadius);
    }
    if (strategyParallaxAvailable && hero.dataset.introState === 'done' && heroRect.width > 0 && heroRect.height > 0) {
      const relX = (pointerX - heroRect.left) / heroRect.width - 0.5;
      const relY = (pointerY - heroRect.top) / heroRect.height - 0.5;
      const svgWidth = svgRect?.width ?? 0;
      const maxX = Math.max(5, Math.min(10, svgWidth * 0.018));
      const maxY = Math.max(3, Math.min(6, svgWidth * 0.01));
      parallaxX(Math.max(-maxX, Math.min(maxX, relX * maxX * 2)));
      parallaxY(Math.max(-maxY, Math.min(maxY, relY * maxY * 2)));
    } else if (strategyParallaxAvailable) {
      parallaxX(0);
      parallaxY(0);
    }
  };
  const requestApply = () => {
    if (moveFrame === 0) moveFrame = window.requestAnimationFrame(applyPointer);
  };
  const onPointerMove = (event) => {
    if (event.pointerType === 'touch') return;
    pointerX = event.clientX;
    pointerY = event.clientY;
    pointerTracked = true;
    if (!gate.isEnabled()) {
      deactivate(true, true);
      return;
    }
    activate();
    requestApply();
  };
  const onGateEnabled = () => {
    if (!gate.isEnabled()) {
      deactivate(true, true);
      return;
    }
    if (!pointerInsideHero()) {
      deactivate(true);
      return;
    }
    measureSvg();
    activate();
    requestApply();
  };
  hero.addEventListener(
    'pointerenter',
    (event) => {
      if (event.pointerType === 'touch') return;
      if (!gate.isEnabled()) {
        deactivate(true, true);
        return;
      }
      measureSvg();
      activate();
      onPointerMove(event);
    },
    { passive: true },
  );
  hero.addEventListener('pointermove', onPointerMove, { passive: true });
  hero.addEventListener(
    'pointerleave',
    () => {
      pointerTracked = false;
      deactivate();
    },
    { passive: true },
  );
  const unsubscribeGate = gate.onChange((enabled) => {
    if (enabled) {
      onGateEnabled();
      return;
    }
    hardReset();
  });
  const unsubscribePhase = onRewindPhaseAway(() => {
    hardReset();
  });
  const onRewindPhaseChange = () => {
    invalidateSvgRect();
  };
  if (typeof ResizeObserver !== 'undefined' && gateSvg) {
    resizeObserver = new ResizeObserver(() => {
      invalidateSvgRect();
      if (!gate.isEnabled()) {
        deactivate(true, true);
        return;
      }
      if (pointerTracked) requestApply();
    });
    resizeObserver.observe(hero);
    resizeObserver.observe(gateSvg);
  }
  const onViewportChange = () => {
    invalidateSvgRect();
    cancelSettle();
    pointerTracked = false;
    deactivate(true, true);
    settleFrame = window.requestAnimationFrame(() => {
      settleFrame = window.requestAnimationFrame(() => {
        settleFrame = 0;
        invalidateSvgRect();
        measureSvg();
      });
    });
    settleTimer = window.setTimeout(() => {
      settleTimer = 0;
      invalidateSvgRect();
      measureSvg();
    }, 180);
  };
  window.addEventListener(
    'pagehide',
    () => {
      unsubscribeGate();
      unsubscribePhase();
      resizeObserver?.disconnect();
      cancelSettle();
      cancelMoveFrame();
      window.removeEventListener('rewindtransitionphasechange', onRewindPhaseChange);
      window.removeEventListener('resize', onViewportChange);
      window.removeEventListener('orientationchange', onViewportChange);
    },
    { once: true },
  );
  window.addEventListener('rewindtransitionphasechange', onRewindPhaseChange, { passive: true });
  window.addEventListener('resize', onViewportChange, { passive: true });
  window.addEventListener('orientationchange', onViewportChange, { passive: true });
};

const setupHeroInteraction = () => {
  document.querySelectorAll('.hero').forEach((hero) => {
    if (hero.dataset.gridLightReady === 'true') return;
    hero.dataset.gridLightReady = 'true';
    const gate = getHeroGate();
    const ctx = buildInteractionContext(hero, gate);
    if (matches(LITE_INTERACTION_QUERY)) {
      setupLiteInteraction(ctx, gate);
      return;
    }
    if (!ctx.hasMoveInteraction) {
      setupHoverInteraction(ctx, gate);
      return;
    }
    setupPointerInteraction(ctx, gate);
  });
};

/* ================= 场景入口（对照 Hero.astro 入口编排） ================= */

const allIntrosComplete = () => {
  const heroes = Array.from(document.querySelectorAll('.hero'));
  if (heroes.length === 0) return true;
  return heroes.every((hero) => hero.dataset.introState === 'done' || hero.classList.contains('is-intro-complete'));
};

// intro 完成后再装指针交互；comfort / reduced 下与原站一致不安装
const scheduleInteractionSetup = (reduced) => {
  if (reduced) return;
  const run = () => {
    try {
      setupHeroInteraction();
    } catch (error) {
      console.warn('Hero interaction setup failed', error);
    }
  };
  if (allIntrosComplete()) {
    run();
    return;
  }
  window.addEventListener(INTRO_COMPLETE_EVENT, run, { once: true });
};

export function initHero(ctx) {
  if (document.querySelectorAll('.hero').length === 0) return;

  const reduced = isMotionReduced();
  restoreReloadScroll();
  trackHeroZone();
  trackMidScroll();
  const runIntro = !reduced && shouldPlayIntro();

  scheduleInteractionSetup(reduced);

  const mountCharts = () => {
    mountHeroCharts({ gsap: ctx.gsap, gate: getHeroGate() });
  };
  try {
    mountCharts();
  } catch (error) {
    console.warn('Hero chart mount failed', error);
  }

  if (runIntro) {
    try {
      setupHeroIntro();
    } catch (error) {
      console.error('[template] Hero intro 初始化失败', error);
      staticReveal();
    }
  } else {
    staticReveal();
  }

  // 离开 phone / 紧凑横屏断点后补挂图表
  const skipMedia = window.matchMedia(CHART_SKIP_QUERY);
  skipMedia.addEventListener('change', () => {
    if (skipMedia.matches) return;
    try {
      mountCharts();
    } catch (error) {
      console.warn('Hero chart mount failed', error);
    }
  });
}
