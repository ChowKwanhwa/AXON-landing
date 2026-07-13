// 中英文切换：点击按钮 → 写 localStorage → 刷新页面；
// 刷新后在所有场景动画初始化之前整页替换文案，SplitText 在替换后的文本上切分，
// 因此动画代码零改动、两种语言动效一致。
const STORAGE_KEY = 'axon.lang';

export const getLang = () => {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === 'zh' ? 'zh' : 'en';
  } catch {
    return 'en';
  }
};

const setLang = (lang) => {
  try {
    window.localStorage.setItem(STORAGE_KEY, lang);
  } catch {}
};

// 顺序映射：selector → 依次替换匹配元素的 textContent
const ZH_TEXTS = [
  ['.skip-link', ['跳转到正文']],
  ['.header-menu__eyebrow', ['导航', '站点页面', '入口', '动效', '法律']],
  ['.header-menu__section-link', ['首页', '协议', '引擎', '代理', '市场', '实证']],
  ['.header-menu__page-link', ['文档', '联系']],
  ['.header-menu__action span', ['阅读文档', '加入 Telegram']],
  ['[data-motion-choice="full"]', ['完整']],
  ['[data-motion-choice="comfort"]', ['舒适']],
  ['.header-menu__legal-link', ['隐私政策', '使用条款', '风险披露']],
  ['.hero__content-cta .button__label', ['阅读文档']],
  ['.hero__timeline-label--rewind', ['结算']],
  ['.gate-question__lead', ['稳定币的链上结算规模，已超过主要银行卡网络的总和。']],
  ['.gate-question__headline-line', ['那么，为什么', '资金的流转', '仍停留在 T+2？']],
  ['.scene-eyebrow:not(.gate-question__lead)', [
    '原生内置，而非事后拼接', 'AI 代理支付', 'PayFi 货币市场', '同一条底层链', '即刻开始构建',
  ]],
  ['#strategy-title', ['原生，即设计。']],
  ['.scene-body__line', ['支付所需的能力，原生内置于链的底层，', '而不是事后加装的补丁。']],
  ['.strategy-fragment__label', ['最终性', '稳定币', '费用代付', '合规']],
  ['.strategy-fragment__value', [
    '亚秒级，不可逆转', '一等公民结算资产', 'Paymaster 无 Gas 体验', '可插拔 KYC/AML 网关',
  ]],
  ['.strategy-rule__label', ['账户抽象', '会话密钥', '价格喂价', '回购销毁']],
  ['.strategy-rule__value', [
    '默认智能账户', '权限可限定、可撤销', '多源喂价，脱锚熔断', '手续费驱动通缩飞轮',
  ]],
  ['[data-time-replay-title="history"]', ['用历史行情回测带单引擎。']],
  ['[data-time-replay-title="live"]', ['或者，看它实时盈利。']],
  ['#control-title', ['自主，且受控。']],
  ['.control-scene .scene-body', ['AI 代理在你设定的限额、时间窗与白名单内完成机器对机器支付——永不越界。']],
  ['.control-field__state-title', [
    '所有代理已授权', '触达消费限额', '白名单外已拦截', '手动撤销授权', '会话已续期',
  ]],
  ['.control-field__state-copy', [
    '会话均在策略范围内运行。', '支付在你设定的上限处暂停。', '未知交易对手一律拒绝。',
    '授权即时收回。', '新密钥，同样的护栏。',
  ]],
  ['#analytics-title', ['让流动中的资金生息。']],
  ['.analytics-scene .scene-body', ['浮存、信用与结算流动性在链上透明生息——并从每一笔资金流汇总而来。']],
  ['.analytics-zone-label span', ['资金流', '市场', '金库']],
  ['.analytics-zone-label small', ['支付流水', '货币市场', '金库视图']],
  ['.analytics-metric dt', [
    '已部署浮存', '已赚取收益', '年化收益率', '利用率', '已结算量', '周转时间', '节省费用', '累计销毁',
  ]],
  ['#product-entry-title', ['一条链，承载所有资金流。']],
  ['.product-entry-scene .scene-body', ['结算、带单引擎、代理支付与货币市场，运行在同一条为支付金融而生的 Layer-1 上。']],
  ['.product-entry-proof__marker span:last-child', [
    '结算稳定币', '代理支付', '浮存生息', '跨境流转', '手续费销毁',
  ]],
  ['.product-entry-scene__action .button__label', ['阅读文档']],
  ['.product-entry-scene__action.text-link', ['联系团队']],
  ['#exit-title', ['在一条可以验证的链上结算。']],
  ['.exit-scene__body', ['开放的底层能力、透明的资金流，以及把每一笔资金去向都写清楚的文档。']],
  ['.exit-scene__action .button__label', ['阅读文档']],
  ['.exit-scene__action.text-link', ['加入 Telegram']],
  ['.site-footer__link', ['首页', '文档', '联系']],
];

// hero 折面标题需保留三段 span 结构，手工分段（拼接 = "资金结算于"）
const applyHeroZh = () => {
  const hidden = document.querySelector('.hero__headline .visually-hidden');
  if (hidden) hidden.textContent = '资金的下一站 ';
  const bendLeft = document.querySelector('.hero__headline-line-bend--left');
  const plane = document.querySelector('.hero__headline-line-plane');
  const bendRight = document.querySelector('.hero__headline-line-bend--right');
  if (bendLeft) bendLeft.textContent = '资';
  if (plane) plane.textContent = '金的下一';
  if (bendRight) bendRight.textContent = '站';
  const subhead = document.querySelector('.hero__subhead');
  if (subhead) {
    subhead.innerHTML = [
      '<span class="hero__subhead-word">高性能</span>',
      '<span class="hero__subhead-dot">·</span>',
      '<span class="hero__subhead-word">AI 原生 Layer-1 公链</span>',
      '<span class="hero__subhead-dot">·</span>',
      '<span class="hero__subhead-word">为 PayFi 而生</span>',
    ].join(' ');
  }
};

/** 在场景初始化之前调用：中文模式下整页替换文案 */
export const applyLanguage = () => {
  if (getLang() !== 'zh') return;
  document.documentElement.lang = 'zh-CN';
  document.title = 'AXON Finance — AI 原生的 PayFi 公链';
  const meta = document.querySelector('meta[name="description"]');
  if (meta) {
    meta.setAttribute('content', '为支付金融而生的高性能 Layer-1：稳定币即时结算、AI 代理支付与链上货币市场。');
  }
  for (const [selector, texts] of ZH_TEXTS) {
    const nodes = document.querySelectorAll(selector);
    texts.forEach((text, index) => {
      if (nodes[index]) nodes[index].textContent = text;
    });
  }
  applyHeroZh();
};

/** 绑定 header 切换按钮：按钮显示目标语言，点击后刷新生效 */
export const initLangToggle = () => {
  const button = document.querySelector('[data-lang-toggle]');
  if (!button) return;
  const lang = getLang();
  button.textContent = lang === 'zh' ? 'EN' : '中文';
  button.setAttribute('aria-label', lang === 'zh' ? 'Switch to English' : '切换为中文');
  button.addEventListener('click', () => {
    setLang(lang === 'zh' ? 'en' : 'zh');
    window.location.reload();
  });
};
