// hero 两侧 K 线：数据生成 → candle DOM（CSS 变量定位）→ live K 线运行时。
// 逻辑与数值对照原站 heroChartMount 模块，逐值一致。
import { BREAKPOINTS, matches } from '../config.js';

/** phone / 紧凑横屏下不挂载 hero 图表（对照原站 Hero 入口的 H 媒体查询）。 */
export const CHART_SKIP_QUERY = `${BREAKPOINTS.phone}, ${BREAKPOINTS.compactLandscape}`;

/** intro 完成（或静态揭示）后由 hero 场景派发到每个 .hero-chart 上。 */
export const CHART_LIVE_START_EVENT = 'hero-chart-live:start';

// ---- 布局常量 ----
const TOP_PAD = 13;
const BOTTOM_PAD = 12;
const CANDLE_COUNT = 104;
const MIN_PRICE = 96;
const MAX_PRICE = 112;
const PRICE_RANGE = MAX_PRICE - MIN_PRICE;
const PLOT_HEIGHT = 100 - TOP_PAD - BOTTOM_PAD;
const FIRST_CANDLE_X = -4;
const LAST_CANDLE_X = 97.1;
const SEGMENT_SPLIT = { leftMaxX: 48, rightMinX: 52 };
const PRICE_LABELS = ['74K', '72K', '70K', '68K', '66K', '64K', '62K', '60K'];
const WICK_THRESHOLD = 0.35;
const LIVE_TICK_INTERVAL_MS = 880;

// 影线种子（按 index % 16 循环取用）
const WICK_SEEDS = [
  { upper: 0.18, lower: 0.42 },
  { upper: 0.52, lower: 0.16 },
  { upper: 0.08, lower: 0.24 },
  { upper: 0.68, lower: 0 },
  { upper: 0.22, lower: 0.74 },
  { upper: 0, lower: 0.2 },
  { upper: 0.34, lower: 0.28 },
  { upper: 0.92, lower: 0.12 },
  { upper: 0.14, lower: 0 },
  { upper: 0.46, lower: 0.58 },
  { upper: 0, lower: 0.36 },
  { upper: 0.28, lower: 0.1 },
  { upper: 1.06, lower: 0.32 },
  { upper: 0.12, lower: 0.88 },
  { upper: 0.38, lower: 0 },
  { upper: 0.06, lower: 0.18 },
];

// 收盘价锚点（smoothstep 插值出 104 根收盘价）
const PRICE_ANCHORS = [
  { index: 0, close: 104.2, volatility: 1.25 },
  { index: 5, close: 100.45, volatility: 1.55 },
  { index: 11, close: 97.65, volatility: 1.78 },
  { index: 17, close: 98.8, volatility: 1.18 },
  { index: 24, close: 103.65, volatility: 1.42 },
  { index: 29, close: 105.35, volatility: 1.62 },
  { index: 35, close: 103.2, volatility: 1.12 },
  { index: 41, close: 104.85, volatility: 1.04 },
  { index: 46, close: 102.85, volatility: 0.92 },
  { index: 54, close: 102.05, volatility: 0.52 },
  { index: 63, close: 102.42, volatility: 0.48 },
  { index: 67, close: 102.58, volatility: 0.56 },
  { index: 68, close: 102.78, volatility: 0.96 },
  { index: 73, close: 104.2, volatility: 1.08 },
  { index: 77, close: 107.45, volatility: 1.48 },
  { index: 81, close: 110.65, volatility: 1.72 },
  { index: 86, close: 107.45, volatility: 1.58 },
  { index: 89, close: 106.12, volatility: 1.92 },
  { index: 93, close: 108.55, volatility: 1.28 },
  { index: 97, close: 109.32, volatility: 1.06 },
  { index: 101, close: 110.65, volatility: 1.22 },
  { index: 103, close: 112.45, volatility: 1.42 },
];

// 特定 K 线的影线覆写
const WICK_OVERRIDES = new Map([
  [8, { upper: 0.18, lower: 1.45 }],
  [12, { upper: 0.08, lower: 1.82 }],
  [29, { upper: 1.24, lower: 0.18 }],
  [78, { upper: 1.06, lower: 0.16 }],
  [81, { upper: 1.42, lower: 0.24 }],
  [89, { upper: 0.14, lower: 1.68 }],
  [103, { upper: 1.14, lower: 0.12 }],
]);

/* ================= 数据模型 ================= */

const smoothstep = (t) => t * t * (3 - 2 * t);

const anchorPairAt = (index) => {
  let next = PRICE_ANCHORS.findIndex((anchor) => anchor.index >= index);
  if (next === -1) next = PRICE_ANCHORS.length - 1;
  if (next === 0) next = 1;
  return [PRICE_ANCHORS[next - 1], PRICE_ANCHORS[next]];
};

const priceToY = (price) => TOP_PAD + ((MAX_PRICE - price) / PRICE_RANGE) * PLOT_HEIGHT;

const candleXAt = (index) =>
  FIRST_CANDLE_X + (index * (LAST_CANDLE_X - FIRST_CANDLE_X)) / (CANDLE_COUNT - 1);

const buildCloses = () =>
  Array.from({ length: CANDLE_COUNT }, (_, index) => {
    const [prev, next] = anchorPairAt(index);
    const t = (index - prev.index) / (next.index - prev.index);
    const eased = smoothstep(Math.min(Math.max(t, 0), 1));
    const base = prev.close + (next.close - prev.close) * eased;
    const volatility = prev.volatility + (next.volatility - prev.volatility) * eased;
    const damp = index > 46 && index < 68 ? 0.34 : 1;
    const wave = (Math.sin(index * 0.72 + 0.35) * 0.54 + Math.sin(index * 1.37 + 1.1) * 0.34) * volatility;
    const ripple = (Math.sin(index * 0.23 + 2.2) * 0.28 + Math.sin(index * 1.88) * 0.18) * volatility;
    const kick =
      index === 7 || index === 12 ? -0.72 : index === 27 || index === 78 ? 0.82 : index === 87 ? -0.95 : index === 102 ? 0.68 : 0;
    return Number((base + (wave + ripple + kick) * damp).toFixed(2));
  });

const buildChartModel = () => {
  const closes = buildCloses();
  const candles = closes
    .map((close, index) => {
      const open = index === 0 ? close - 0.22 : closes[index - 1];
      const span = Math.abs(close - open);
      const seed = WICK_SEEDS[index % WICK_SEEDS.length];
      const progress = index / (closes.length - 1);
      const reach = progress > 0.43 && progress < 0.62 ? 1.02 : 1.36;
      const override = WICK_OVERRIDES.get(index);
      const upper = seed.upper * reach + (span > 1.05 ? 0.24 : 0) + (span < 0.25 ? 0.1 : 0) + (override?.upper ?? 0);
      const lower = seed.lower * reach + (span < 0.22 ? 0.12 : 0) + (override?.lower ?? 0);
      return {
        open,
        close,
        high: Math.max(open, close) + upper,
        low: Math.min(open, close) - lower,
        live: index === closes.length - 1,
      };
    })
    .map((candle, index) => {
      const x = candleXAt(index);
      const openY = priceToY(candle.open);
      const closeY = priceToY(candle.close);
      const highY = priceToY(candle.high);
      const lowY = priceToY(candle.low);
      const topY = candle.live ? openY : highY;
      const bottomY = candle.live ? openY : lowY;
      const bodyTopY = Math.min(openY, closeY);
      const bodyBottomY = Math.max(openY, closeY);
      const up = candle.close >= candle.open;
      const bodySpan = Math.abs(closeY - openY);
      const liveBodyHeight = candle.live ? 0 : bodySpan;
      const liveOpacity = Math.min(1, liveBodyHeight / 0.18);
      return {
        ...candle,
        index,
        x,
        tone: up ? 'up' : 'down',
        bodyWidth: candle.live ? 1.18 : up ? 1 : 0.92,
        upperWickTop: topY,
        upperWickHeight: candle.live ? 0 : Math.max(bodyTopY - highY, 0),
        lowerWickTop: candle.live ? openY : bodyBottomY,
        lowerWickHeight: candle.live ? 0 : Math.max(lowY - bodyBottomY, 0),
        bodyTop: candle.live ? openY : bodyTopY,
        bodyHeight: candle.live ? 0 : Math.max(bodyBottomY - bodyTopY, 0.35),
        liveOpenY: openY,
        liveBodyHeight,
        liveUpOpacity: up ? liveOpacity : 0,
        liveDownOpacity: up ? 0 : liveOpacity,
        rangeTop: topY,
        rangeHeight: candle.live ? 0 : Math.max(bottomY - topY, 0.35),
      };
    });
  const segments = [
    { key: 'left', candles: candles.filter((candle) => !candle.live && candle.x <= SEGMENT_SPLIT.leftMaxX) },
    { key: 'right', candles: candles.filter((candle) => candle.live || candle.x >= SEGMENT_SPLIT.rightMinX) },
  ];
  const ticks = PRICE_LABELS.map((label, index) => ({
    label,
    top: TOP_PAD + (index / (PRICE_LABELS.length - 1)) * PLOT_HEIGHT,
  }));
  return { candles, segments, ticks, liveCandle: candles[candles.length - 1] };
};

/* ================= DOM 生成 ================= */

const createEl = (tag, className) => {
  const el = document.createElement(tag);
  if (className) el.className = className;
  return el;
};

const formatNumber = (value) => {
  const rounded = Number(value.toFixed(2));
  return Object.is(rounded, -0) ? '0' : rounded.toString();
};

const percentText = (value) => `${formatNumber(value)}%`;

const appendSpan = (parent, className) => {
  parent.append(createEl('span', className));
};

const candleStyle = (candle) => {
  const vars = [`--x:${percentText(candle.x)}`, `--bt:${percentText(candle.bodyTop)}`, `--bh:${percentText(candle.bodyHeight)}`];
  if (candle.bodyWidth !== 1) vars.push(`--bw:${formatNumber(candle.bodyWidth)}`);
  if (candle.live) {
    vars.push(
      `--lo:${percentText(candle.liveOpenY ?? candle.bodyTop)}`,
      `--lb:${percentText(candle.liveBodyHeight ?? candle.bodyHeight)}`,
      `--lu:${formatNumber(candle.liveUpOpacity ?? 0)}`,
      `--ld:${formatNumber(candle.liveDownOpacity ?? 0)}`,
      `--rt:${percentText(candle.rangeTop ?? candle.bodyTop)}`,
      `--rh:${percentText(candle.rangeHeight ?? candle.bodyHeight)}`,
    );
  } else {
    if (candle.upperWickHeight > WICK_THRESHOLD) {
      vars.push(`--ut:${percentText(candle.upperWickTop)}`, `--uh:${percentText(candle.upperWickHeight)}`);
    }
    if (candle.lowerWickHeight > WICK_THRESHOLD) {
      vars.push(`--lt:${percentText(candle.lowerWickTop)}`, `--lh:${percentText(candle.lowerWickHeight)}`);
    }
  }
  return vars.join(';');
};

const buildCandle = (candle) => {
  const root = createEl('div', ['candle', `candle--${candle.tone}`, candle.live ? 'candle--live' : ''].filter(Boolean).join(' '));
  root.setAttribute('style', candleStyle(candle));
  if (candle.live) {
    root.dataset.liveCandle = 'true';
    appendSpan(root, 'candle__range');
    appendSpan(root, 'candle__body candle__body--live candle__body--live-up');
    appendSpan(root, 'candle__body candle__body--live candle__body--live-down');
    return root;
  }
  if (candle.upperWickHeight > WICK_THRESHOLD) appendSpan(root, 'candle__wick candle__wick--upper');
  appendSpan(root, 'candle__body');
  if (candle.lowerWickHeight > WICK_THRESHOLD) appendSpan(root, 'candle__wick candle__wick--lower');
  return root;
};

const buildHeroChart = () => {
  const model = buildChartModel();
  const root = createEl('div', 'chart hero-chart');
  root.setAttribute('aria-hidden', 'true');
  const candlesWrap = createEl('div', 'chart__candles hero-chart__candles');
  model.segments.forEach((segment) => {
    const segmentEl = createEl('div', `chart__segment hero-chart__segment hero-chart__segment--${segment.key}`);
    segment.candles.forEach((candle) => {
      segmentEl.append(buildCandle(candle));
    });
    candlesWrap.append(segmentEl);
  });
  root.append(candlesWrap);
  const priceScale = createEl('div', 'chart__price-scale hero-chart__price-scale');
  model.ticks.forEach((tick) => {
    const tickEl = createEl('span', 'chart__price-tick hero-chart__price-tick');
    tickEl.setAttribute('style', `top:${tick.top}%;`);
    tickEl.textContent = tick.label;
    priceScale.append(tickEl);
  });
  root.append(priceScale);
  const live = model.liveCandle;
  root.dataset.liveOpen = live.open.toString();
  root.dataset.liveCurrent = live.close.toString();
  root.dataset.liveHigh = live.high.toString();
  root.dataset.liveLow = live.low.toString();
  root.dataset.priceMin = MIN_PRICE.toString();
  root.dataset.priceMax = MAX_PRICE.toString();
  root.dataset.plotTop = TOP_PAD.toString();
  root.dataset.plotBottom = BOTTOM_PAD.toString();
  return root;
};

/* ================= live K 线运行时 ================= */

const attachLiveRuntime = (chart, { gsap, gate }) => {
  if (chart.dataset.chartReady === 'true') return;
  chart.dataset.chartReady = 'true';
  const liveCandles = Array.from(chart.querySelectorAll('[data-live-candle]'));
  if (liveCandles.length === 0) return;

  const open = Number(chart.dataset.liveOpen || 0);
  const priceMin = Number(chart.dataset.priceMin || 0);
  const priceMax = Number(chart.dataset.priceMax || 1);
  const plotTop = Number(chart.dataset.plotTop || 8);
  const plotBottom = Number(chart.dataset.plotBottom || 12);
  const plotHeight = 100 - plotTop - plotBottom;
  const ceiling = open + 2.15;
  const floor = open - 1.45;

  let current = open;
  let sessionHigh = open;
  let sessionLow = open;
  const proxy = { current };
  let tickCount = 0;
  let intervalId = 0;
  let tween;
  let started = false;
  let gateReady = false;
  let interactionEnabled = true;
  let stopped = false;
  let unsubscribeGate;

  const toY = (price) => plotTop + ((priceMax - price) / (priceMax - priceMin)) * plotHeight;
  const percent = (value) => `${Number(value.toFixed(3))}%`;
  const canRun = () => started && gateReady && interactionEnabled && !stopped;

  const clearTicking = () => {
    if (intervalId !== 0) {
      window.clearInterval(intervalId);
      intervalId = 0;
    }
  };
  const startTicking = () => {
    if (!canRun() || intervalId !== 0) return;
    chart.dataset.liveRuntime = 'running';
    intervalId = window.setInterval(() => {
      tick();
    }, LIVE_TICK_INTERVAL_MS);
  };
  const pause = () => {
    chart.dataset.liveRuntime = 'paused';
    clearTicking();
    tween?.kill();
    tween = undefined;
  };
  const setVar = (name, value) => {
    const text = typeof value === 'number' ? percent(value) : value;
    liveCandles.forEach((candle) => {
      candle.style.setProperty(name, text);
    });
  };
  const apply = () => {
    current = proxy.current;
    sessionHigh = Math.max(sessionHigh, open, current);
    sessionLow = Math.min(sessionLow, open, current);
    const openY = toY(open);
    const currentY = toY(current);
    const up = current >= open;
    const bodyHeight = Math.abs(currentY - openY);
    const bodyTop = up ? currentY : openY;
    const bodyBottom = up ? openY : currentY;
    const bodyOpacity = Math.min(1, bodyHeight / 0.18);
    const highY = toY(sessionHigh);
    const lowY = toY(sessionLow);
    setVar('--bt', bodyTop);
    setVar('--bh', bodyHeight);
    setVar('--lo', openY);
    setVar('--lb', bodyHeight);
    setVar('--lu', up ? bodyOpacity.toFixed(3) : '0');
    setVar('--ld', up ? '0' : bodyOpacity.toFixed(3));
    setVar('--rt', highY);
    setVar('--rh', Math.max(lowY - highY, 0));
    setVar('--ut', highY);
    setVar('--uh', Math.max(bodyTop - highY, 0));
    setVar('--lt', bodyBottom);
    setVar('--lh', Math.max(lowY - bodyBottom, 0));
    liveCandles.forEach((candle) => {
      candle.classList.toggle('candle--up', current >= open);
      candle.classList.toggle('candle--down', current < open);
    });
  };
  const tick = () => {
    if (!canRun()) return;
    tickCount += 1;
    const wave = Math.sin(tickCount * 0.92) * 0.82 + Math.sin(tickCount * 0.39 + 1.4) * 0.5;
    const spike = tickCount % 9 === 3 ? 0.72 : tickCount % 11 === 6 ? -0.88 : 0;
    const noise = (Math.random() - 0.5) * 0.38;
    const target = open + 0.22 + wave + spike + noise;
    const next = Math.max(floor, Math.min(ceiling, target));
    tween = gsap.to(proxy, {
      current: next,
      duration: 0.78,
      ease: 'power2.out',
      overwrite: true,
      onUpdate: apply,
      onComplete: () => {
        tween = undefined;
        apply();
      },
    });
  };
  apply();
  const subscribeGate = () => {
    if (unsubscribeGate || stopped) return;
    gateReady = true;
    interactionEnabled = gate.isEnabled();
    unsubscribeGate = gate.onChange((enabled) => {
      interactionEnabled = enabled;
      if (enabled) {
        if (canRun()) startTicking();
        return;
      }
      pause();
    });
  };
  const start = () => {
    if (started) return;
    started = true;
    current = open;
    proxy.current = open;
    sessionHigh = open;
    sessionLow = open;
    apply();
    subscribeGate();
    tick();
    startTicking();
  };
  chart.addEventListener(CHART_LIVE_START_EVENT, start);
  if (chart.closest('.hero')?.getAttribute('data-intro-state') === 'done') start();
  window.addEventListener(
    'pagehide',
    () => {
      stopped = true;
      pause();
      unsubscribeGate?.();
      chart.removeEventListener(CHART_LIVE_START_EVENT, start);
    },
    { once: true },
  );
};

/* ================= 挂载入口 ================= */

/**
 * 在每个 .hero__chart-stage 内生成（或复用）hero K 线并接入 live 运行时。
 * @param {{ gsap: object, gate: { isEnabled(): boolean, onChange(cb: (enabled: boolean) => void): () => void } }} options
 */
export const mountHeroCharts = ({ gsap, gate }) => {
  if (matches(CHART_SKIP_QUERY)) return;
  document.querySelectorAll('.hero__chart-stage').forEach((stage) => {
    let chart = stage.querySelector('.hero-chart');
    if (!chart) {
      chart = buildHeroChart();
      stage.replaceChildren(chart);
      stage.dataset.chartMounted = 'true';
    }
    attachLiveRuntime(chart, { gsap, gate });
  });
};
