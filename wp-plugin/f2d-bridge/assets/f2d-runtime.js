/* figma2divi runtime: behaviour for the components the compiler marks with hook classes.
 * Without this script every component shows the design's resting state (html lacks .f2d-js).
 *   .f2d-menu-toggle / .f2d-menu-panel   hamburger menu below the header's breakpoint; html.f2d-menu-open
 *                                        while it is open (.f2d-menu-extra parts join the drawer)
 *   .f2d-acc > .f2d-acc-item             accordion (items with a .f2d-acc-panel toggle)
 *   .f2d-slider > .f2d-slide             slider; .f2d-slider-prev / -next move one card when paged
 *   .f2d-marquee                         continuous ticker (stops for prefers-reduced-motion)
 */
(function () {
  'use strict';
  var d = document;
  var root = d.documentElement;
  root.classList.add('f2d-js');
  var TABLET = '(max-width: 980px)';
  var uid = 0;
  var idOf = function (el, p) { if (!el.id) el.id = 'f2d-' + p + '-' + ++uid; return el.id; };
  var all = function (sel, ctx) { return Array.prototype.slice.call((ctx || d).querySelectorAll(sel)); };
  var asButton = function (el, label) {
    if (el.tagName !== 'BUTTON') { el.setAttribute('role', 'button'); el.tabIndex = 0; }
    if (label) el.setAttribute('aria-label', label);
  };
  var onActivate = function (el, fn) {
    el.addEventListener('click', fn);
    el.addEventListener('keydown', function (e) {
      if (el.tagName !== 'BUTTON' && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); fn(e); }
    });
  };

  function menus() {
    all('.f2d-menu-toggle').forEach(function (t) {
      var panel = d.querySelector('.f2d-menu-panel');
      if (!panel) return;
      t.setAttribute('aria-controls', idOf(panel, 'menu'));
      t.setAttribute('aria-expanded', 'false');
      var set = function (open) {
        panel.classList.toggle('is-open', open);
        root.classList.toggle('f2d-menu-open', open); // the header shows its drawer-only parts
        t.setAttribute('aria-expanded', open ? 'true' : 'false');
      };
      onActivate(t, function () { set(!panel.classList.contains('is-open')); });
      d.addEventListener('keydown', function (e) { if (e.key === 'Escape' && panel.classList.contains('is-open')) { set(false); t.focus(); } });
      panel.addEventListener('click', function (e) { if (e.target.closest('a')) set(false); });
      // The compact header's breakpoint comes from the design (the button is shown only there).
      window.addEventListener('resize', function () { if (getComputedStyle(t).display === 'none') set(false); });
    });
  }

  function accordions() {
    all('.f2d-acc-item').forEach(function (item) {
      var head = item.querySelector('.f2d-acc-head');
      var panels = all('.f2d-acc-panel', item);
      if (!head || !panels.length) return; // nothing to reveal: stays as designed
      asButton(head);
      head.setAttribute('aria-controls', panels.map(function (p) { return idOf(p, 'acc'); }).join(' '));
      var set = function (open) { item.classList.toggle('is-open', open); head.setAttribute('aria-expanded', open ? 'true' : 'false'); };
      set(item.classList.contains('is-open')); // the compiler wrote the design's state
      onActivate(head, function () { set(!item.classList.contains('is-open')); });
    });
  }

  function sliders() {
    all('.f2d-slider').forEach(function (s) {
      var slides = all('.f2d-slide', s);
      var prev = s.querySelector('.f2d-slider-prev');
      var next = s.querySelector('.f2d-slider-next');
      if (slides.length < 2) return;
      var i = 0;
      var mq = window.matchMedia(TABLET);
      s.setAttribute('aria-roledescription', 'carousel');
      slides.forEach(function (el, k) { el.setAttribute('aria-roledescription', 'slide'); el.setAttribute('aria-label', (k + 1) + ' of ' + slides.length); });
      var render = function () {
        var paged = mq.matches;
        s.classList.toggle('is-paged', paged);
        slides.forEach(function (el, k) { el.classList.toggle('is-active', k === i); });
        if (prev) prev.setAttribute('aria-disabled', !paged || i === 0 ? 'true' : 'false');
        if (next) next.setAttribute('aria-disabled', !paged || i === slides.length - 1 ? 'true' : 'false');
      };
      var go = function (step) { if (!mq.matches) return; i = Math.max(0, Math.min(slides.length - 1, i + step)); render(); };
      if (prev) { asButton(prev, 'Previous'); onActivate(prev, function () { go(-1); }); }
      if (next) { asButton(next, 'Next'); onActivate(next, function () { go(1); }); }
      (mq.addEventListener ? mq.addEventListener.bind(mq, 'change') : mq.addListener.bind(mq))(render);
      render();
    });
  }

  function marquees() {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return; // static, as designed
    all('.f2d-marquee').forEach(function (m) {
      if (m.querySelector('.f2d-marquee-track')) return;
      var gap = getComputedStyle(m).columnGap;
      var track = d.createElement('div');
      track.className = 'f2d-marquee-track';
      track.style.gap = gap;
      track.style.paddingRight = gap === 'normal' ? '0' : gap; // one gap after each copy: -50% lands exactly on the second copy
      var items = Array.prototype.slice.call(m.children);
      items.forEach(function (el) { track.appendChild(el); });
      items.forEach(function (el) {
        var c = el.cloneNode(true);
        c.setAttribute('aria-hidden', 'true');
        all('[id]', c).concat([c]).forEach(function (x) { x.removeAttribute('id'); });
        track.appendChild(c);
      });
      m.appendChild(track);
      var half = track.scrollWidth / 2;
      track.style.setProperty('--f2d-marquee-dur', Math.max(20, half / 60) + 's'); // ~60px per second
    });
  }

  var start = function () { menus(); accordions(); sliders(); marquees(); };
  if (d.readyState === 'loading') d.addEventListener('DOMContentLoaded', start);
  else start();
})();
