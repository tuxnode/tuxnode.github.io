(() => {
  const supportsVT =
    typeof document.startViewTransition === 'function' &&
    !window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let currentHref = location.href;

  function scrollToHash(hash) {
    const id = decodeURIComponent(hash.slice(1));
    const el = document.getElementById(id);
    if (el) el.scrollIntoView();
    return el;
  }

  function samePageHashClick(url) {
    return (
      url.pathname + url.search ===
      new URL(location.href).pathname + new URL(location.href).search
    );
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
    const a = e.target.closest('a');
    if (!a) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;

    const href = a.getAttribute('href');
    if (!href) return;

    // TOC-style fragment links: scroll manually (reliable on SPA pages too)
    if (href.startsWith('#')) {
      const el = scrollToHash(href);
      if (el) {
        e.preventDefault();
        history.pushState({}, '', href);
      }
      return;
    }

    if (a.target && a.target !== '_self') return;
    if (a.hasAttribute('download')) return;
    const url = new URL(a.href, location.href);
    if (url.origin !== location.origin) return;
    if (url.href === location.href) return;

    // internal link to current page with a hash: manual scroll
    if (url.hash && samePageHashClick(url)) {
      const el = scrollToHash(url.hash);
      if (el) {
        e.preventDefault();
        history.pushState({}, '', url.pathname + url.search + url.hash);
      }
      return;
    }

    if (!supportsVT) return;
    e.preventDefault();

    const transition = document.startViewTransition(async () => {
      const doc = await fetchPage(url.href);
      if (!swapContent(doc)) throw new Error('swap failed');
      runScripts();
      if (!url.hash) window.scrollTo(0, 0);
    });

    transition.finished
      .then(() => {
        history.pushState({}, '', url.pathname + url.search + url.hash);
        currentHref = url.href;
        if (url.hash) {
          if (!scrollToHash(url.hash)) window.scrollTo(0, 0);
        } else {
          window.scrollTo(0, 0);
        }
      })
      .catch(() => {
        location.href = url.href;
      });
  });

  window.addEventListener('popstate', () => {
    // same document, only the hash changed (TOC back/forward): scroll only
    if (
      new URL(currentHref).pathname + new URL(currentHref).search ===
      new URL(location.href).pathname + new URL(location.href).search
    ) {
      currentHref = location.href;
      if (location.hash) scrollToHash(location.hash);
      else window.scrollTo(0, 0);
      return;
    }

    if (!supportsVT) return;
    const transition = document.startViewTransition(async () => {
      const doc = await fetchPage(location.href);
      if (!swapContent(doc)) throw new Error('swap failed');
      runScripts();
      if (location.hash) {
        if (!scrollToHash(location.hash)) window.scrollTo(0, 0);
      } else {
        window.scrollTo(0, 0);
      }
    });

    transition.finished
      .then(() => {
        currentHref = location.href;
      })
      .catch(() => location.reload());
  });
})();
