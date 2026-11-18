/* 拾光 · iPhone PWA 安装与离线入口 */
(() => {
  'use strict';

  const INSTALL_HINT_KEY = 'lq-install-hint-dismissed-v1';
  const standalone =
    (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
    window.navigator.standalone === true;

  document.documentElement.classList.toggle('is-standalone', standalone);

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker
        .register('sw.js')
        .then((registration) => {
          registration.update().catch(() => {});
        })
        .catch(() => {
          /* 离线缓存不可用时，备忘录本身仍然可以正常使用 */
        });
    });
  }

  const isIOS =
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  const banner = document.getElementById('installBanner');
  let dismissed = false;
  try {
    dismissed = localStorage.getItem(INSTALL_HINT_KEY) === '1';
  } catch (_) {
    /* ignore */
  }

  if (banner && isIOS && !standalone && !dismissed) {
    window.setTimeout(() => {
      banner.hidden = false;
    }, 1000);
  }

  document.addEventListener('click', (event) => {
    const dismiss = event.target.closest?.('[data-action="dismiss-install"]');
    if (!dismiss) return;
    if (banner) banner.hidden = true;
    try {
      localStorage.setItem(INSTALL_HINT_KEY, '1');
    } catch (_) {
      /* ignore */
    }
  });
})();
