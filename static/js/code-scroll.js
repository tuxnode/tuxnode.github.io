(() => {
  const DRAG_THRESHOLD = 4;
  let drag = null;
  let suppressClick = false;

  function isScrollable(el) {
    return el.scrollWidth - el.clientWidth > 1;
  }

  function blockFrom(target) {
    return target instanceof Element ? target.closest('.highlight') : null;
  }

  function markScrollable(el) {
    if (el) el.classList.toggle('is-scrollable', isScrollable(el));
  }

  document.addEventListener('pointerover', (e) => {
    markScrollable(blockFrom(e.target));
  });

  document.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse' || e.button !== 0) return;
    const block = blockFrom(e.target);
    if (!block || !isScrollable(block)) return;

    drag = {
      block,
      pointerId: e.pointerId,
      startX: e.clientX,
      startLeft: block.scrollLeft,
      moved: false,
    };

    if (block.setPointerCapture) {
      try {
        block.setPointerCapture(e.pointerId);
      } catch (_) {}
    }
  });

  document.addEventListener(
    'pointermove',
    (e) => {
      if (!drag || e.pointerId !== drag.pointerId) return;

      const dx = e.clientX - drag.startX;
      if (!drag.moved) {
        if (Math.abs(dx) < DRAG_THRESHOLD) return;
        drag.moved = true;
        drag.block.classList.add('is-dragging');
      }

      e.preventDefault();
      drag.block.scrollLeft = drag.startLeft - dx;
    },
    { passive: false }
  );

  function endDrag(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;

    try {
      drag.block.releasePointerCapture(drag.pointerId);
    } catch (_) {}

    drag.block.classList.remove('is-dragging');
    suppressClick = drag.moved;
    drag = null;
  }

  document.addEventListener('pointerup', endDrag);
  document.addEventListener('pointercancel', endDrag);

  document.addEventListener(
    'click',
    (e) => {
      if (!suppressClick) return;
      suppressClick = false;
      e.preventDefault();
      e.stopPropagation();
    },
    true
  );

  function refresh() {
    document.querySelectorAll('.highlight').forEach(markScrollable);
  }

  window.addEventListener('resize', refresh);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', refresh);
  } else {
    refresh();
  }
})();
