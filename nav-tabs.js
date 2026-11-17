// Support, Privacy and Terms share one menu bar, and it never reloads.
// Tapping a tab (or any link to one of these pages, like the footer's) swaps
// in that page's content under the bar and glides the white pill to its tab:
// the same 0.45s slide as the homepage's bar. The bar itself is never redrawn,
// so the logo, the tabs and their fonts can't jump.
//
// The address bar shows the real page, Back and Forward work (back to where
// you were scrolled), and a refresh loads that page the normal way. The other
// two pages are fetched quietly once this one has loaded, so a tap swaps at
// once. If a fetch fails, the link just opens the page normally.
//
// Styles: .nav-indicator in legal.css. Without this script, the tabs are
// plain links and the current one keeps its own highlight.
(function () {
  var PAGES = ['/support', '/privacy', '/terms'];
  var root = document.documentElement;
  var bar = document.querySelector('.nav-links');
  if (!bar) return;
  var links = Array.prototype.slice.call(bar.querySelectorAll('.nav-link'));

  function clean(p) { return p.replace(/\.html$/, '').replace(/(.)\/$/, '$1'); }
  function tabFor(p) { return links.filter(function (l) { return l.getAttribute('href') === p; })[0] || null; }

  var here = clean(location.pathname);
  var current = tabFor(here) || bar.querySelector('.nav-link[aria-current]');
  if (!current) return;

  // ── The pill ──────────────────────────────────────────────
  var pill = document.createElement('span');
  pill.className = 'nav-indicator';
  pill.setAttribute('aria-hidden', 'true');
  bar.insertBefore(pill, bar.firstChild);

  function place(link) {
    pill.style.width = link.offsetWidth + 'px';
    pill.style.transform = 'translateX(' + link.offsetLeft + 'px)';
  }
  function snap(link) { // no animation
    bar.classList.add('settling');
    place(link);
    void pill.offsetWidth;
    bar.classList.remove('settling');
  }

  // Takes over from the plain highlight in the same spot, so nothing shows
  bar.classList.add('sliding', 'settling');
  snap(current);

  var glideEnd = 0;
  function glideTo(link) {
    if (!link || link === current) return;
    current.removeAttribute('aria-current');
    link.setAttribute('aria-current', 'page');
    current = link;
    place(link);
    glideEnd = Date.now() + 450;
  }

  // Tabs change size when the fonts arrive or the screen crosses a
  // breakpoint. The pill follows at once (mid-glide, it just aims at the
  // new spot), so it never sits half off its tab.
  function fit() { if (Date.now() < glideEnd) place(current); else snap(current); }
  if (window.ResizeObserver) {
    var watch = new ResizeObserver(fit);
    links.forEach(function (l) { watch.observe(l); });
  } else {
    window.addEventListener('resize', fit);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(fit);
  }

  // ── Swapping pages under the bar ──────────────────────────
  var main = document.getElementById('content');
  var footer = document.querySelector('footer');
  if (!main || !footer || PAGES.indexOf(here) < 0 || !window.fetch || !window.DOMParser || !history.pushState) return;

  var desc = document.querySelector('meta[name="description"]');
  var canon = document.querySelector('link[rel="canonical"]');
  main.setAttribute('tabindex', '-1');

  function attr(doc, sel, name) { var el = doc.querySelector(sel); return el ? el.getAttribute(name) : null; }
  function read(doc) {
    var m = doc.getElementById('content'), f = doc.querySelector('footer');
    if (!m || !f) return null;
    return {
      title: doc.title,
      desc: attr(doc, 'meta[name="description"]', 'content'),
      canon: attr(doc, 'link[rel="canonical"]', 'href'),
      main: m.innerHTML,
      footer: f.innerHTML,
    };
  }

  var cache = {};    // path → page
  var loading = {};  // path → promise of page
  cache[here] = read(document);

  function load(path) {
    if (cache[path]) return Promise.resolve(cache[path]);
    if (!loading[path]) {
      loading[path] = fetch(path, { credentials: 'same-origin' })
        .then(function (r) { if (!r.ok || r.redirected) throw new Error('HTTP ' + r.status); return r.text(); })
        .then(function (html) {
          var page = read(new DOMParser().parseFromString(html, 'text/html'));
          if (!page) throw new Error('not one of these pages');
          cache[path] = page;
          return page;
        });
      loading[path].then(null, function () {}).then(function () { delete loading[path]; });
    }
    return loading[path];
  }

  function show(path, page, opts) {
    if (opts.push) history.pushState({ entre: 1, y: 0 }, '', path + (opts.hash || ''));
    main.innerHTML = page.main;
    footer.innerHTML = page.footer;
    document.title = page.title;
    if (desc && page.desc) desc.setAttribute('content', page.desc);
    if (canon && page.canon) canon.setAttribute('href', page.canon);
    here = path;

    var target = opts.hash && document.getElementById(decodeURIComponent(opts.hash.slice(1)));
    root.style.scrollBehavior = 'auto'; // jump, don't scroll smoothly through the page
    if (typeof opts.y === 'number') window.scrollTo(0, opts.y);
    else if (target) target.scrollIntoView();
    else window.scrollTo(0, 0);
    root.style.scrollBehavior = '';
    try { main.focus({ preventScroll: true }); } catch (e) {}
  }

  var turn = 0; // only the latest tap wins
  function go(path, hash) {
    glideTo(tabFor(path)); // the pill leaves at once, like the homepage
    var mine = ++turn;
    function swap(page) {
      if (mine !== turn) return;
      try { history.replaceState({ entre: 1, y: window.scrollY }, ''); } catch (e) {} // for Back
      show(path, page, { push: true, hash: hash });
    }
    if (cache[path]) swap(cache[path]);
    else load(path).then(swap, function () { if (mine === turn) location.href = path + hash; });
  }

  document.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var a = e.target.closest ? e.target.closest('a[href]') : null;
    if (!a || (a.target && a.target !== '_self') || a.hasAttribute('download')) return;
    var url = new URL(a.href, location.href);
    if (url.origin !== location.origin) return;
    var path = clean(url.pathname);
    if (PAGES.indexOf(path) < 0) return;
    if (path === here) {
      if (url.hash) return; // "On this page" links: the browser jumps to the section
      e.preventDefault();   // this page's own tab: back to the top, no reload
      turn++;
      glideTo(tabFor(here));
      window.scrollTo(0, 0);
      return;
    }
    e.preventDefault();
    go(path, url.hash);
  });

  window.addEventListener('popstate', function (e) {
    var path = clean(location.pathname);
    if (path === here) return; // a jump within this page
    if (PAGES.indexOf(path) < 0) { location.reload(); return; }
    glideTo(tabFor(path));
    var mine = ++turn;
    var opts = { hash: location.hash, y: e.state && typeof e.state.y === 'number' ? e.state.y : undefined };
    if (cache[path]) show(path, cache[path], opts);
    else load(path).then(function (page) { if (mine === turn) show(path, page, opts); }, function () { location.reload(); });
  });

  // Fetch the other two pages once this one has loaded
  function warm() { PAGES.forEach(function (p) { if (p !== here) load(p).then(null, function () {}); }); }
  if (document.readyState === 'complete') setTimeout(warm, 200);
  else window.addEventListener('load', function () { setTimeout(warm, 200); });
})();
