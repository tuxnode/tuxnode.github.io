(() => {
  const supportsVT =
    typeof document.startViewTransition === 'function' &&
    !window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function isInternalLink(a) {
    if (a.target && a.target !== '_self') return false;
    if (a.hasAttribute('download')) return false;
    const href = a.getAttribute('href');
    if (!href || href.startsWith('#')) return false;
    const url = new URL(a.href, location.href);
    if (url.origin !== location.origin) return false;
    if (url.href === location.href) return false;
    if (url.hash && url.pathname === location.pathname) return false;
    return true;
  }

  async function fetchPage(url) {
    const res = await fetch(url, { headers: { Accept: 'text/html' } });
    if (!res.ok) throw new Error('fetch failed: ' + res.status);
    return new DOMParser().parseFromString(await res.text(), 'text/html');
  }

  function swapContent(doc) {
    const main = document.querySelector('main');
    const newMain = doc.querySelector('main');
    if (!main || !newMain) return false;
    main.replaceWith(document.importNode(newMain, true));
    document.title = doc.title;
    return true;
  }

  function runScripts() {
    document.querySelectorAll('main script').forEach((old) => {
      const s = document.createElement('script');
      Array.from(old.attributes).forEach((a) => s.setAttribute(a.name, a.value));
      s.text = old.textContent;
      old.replaceWith(s);
    });
  }

  document.addEventListener('click', (e) => {
    if (!supportsVT) return;
    const a = e.target.closest('a');
    if (!a || !isInternalLink(a)) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    const url = new URL(a.href, location.href);

    const transition = document.startViewTransition(async () => {
      const doc = await fetchPage(url.href);
      if (!swapContent(doc)) throw new Error('swap failed');
      runScripts();
      if (!url.hash) window.scrollTo(0, 0);
    });

    transition.finished
      .then(() => {
        history.pushState({}, '', url.pathname + url.search + url.hash);
        if (url.hash) {
          const el = document.querySelector(url.hash);
          if (el) el.scrollIntoView();
        } else {
          window.scrollTo(0, 0);
        }
      })
      .catch(() => {
        location.href = url.href;
      });
  });

  window.addEventListener('popstate', () => {
    if (!supportsVT) return;
    const transition = document.startViewTransition(async () => {
      const doc = await fetchPage(location.href);
      if (!swapContent(doc)) throw new Error('swap failed');
      runScripts();
      window.scrollTo(0, 0);
    });

    transition.finished.catch(() => location.reload());
  });
})();
