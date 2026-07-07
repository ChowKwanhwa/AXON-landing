// 入口：注册 GSAP 插件 → motion 偏好 → ScrollSmoother → header → 各场景。
// GSAP 及插件由 index.html 以 UMD <script defer> 引入（window.gsap 等）。
import { initMotionPreference } from './lib/motion.js';
import { setupScrollRuntime, getSmoother } from './scroll-runtime.js';
import { initHeader } from './header.js';
import { initHero } from './scenes/hero.js';
import { initRewind } from './scenes/rewind.js';
import { initQuestion } from './scenes/question.js';
import { initStrategy } from './scenes/strategy.js';
import { initTimeReplay } from './scenes/time-replay.js';
import { initControl } from './scenes/control.js';
import { initAnalytics } from './scenes/analytics.js';
import { initProductEntry } from './scenes/product-entry.js';
import { initExit } from './scenes/exit.js';

const start = () => {
  const { gsap, ScrollTrigger, ScrollSmoother, SplitText } = window;
  if (!gsap || !ScrollTrigger || !ScrollSmoother) {
    console.error('[template] GSAP 未加载，检查 CDN script 标签');
    return;
  }
  gsap.registerPlugin(ScrollTrigger, ScrollSmoother, ...(SplitText ? [SplitText] : []));

  initMotionPreference();
  setupScrollRuntime();

  /** 传给每个场景的共享上下文 */
  const ctx = {
    gsap,
    ScrollTrigger,
    SplitText,
    get smoother() {
      return getSmoother();
    },
  };

  initHeader(ctx);

  // 场景初始化按文档顺序；每个场景自行处理降级与断点
  const scenes = [
    ['hero', initHero],
    ['rewind', initRewind],
    ['question', initQuestion],
    ['strategy', initStrategy],
    ['time-replay', initTimeReplay],
    ['control', initControl],
    ['analytics', initAnalytics],
    ['product-entry', initProductEntry],
    ['exit', initExit],
  ];
  for (const [name, init] of scenes) {
    try {
      init(ctx);
    } catch (error) {
      console.error(`[template] 场景 ${name} 初始化失败`, error);
    }
  }

  requestAnimationFrame(() => ScrollTrigger.refresh());
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start, { once: true });
} else {
  start();
}
