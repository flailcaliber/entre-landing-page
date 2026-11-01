// Top edge fade (phones, tablets): the page dissolves into the cream as it
// scrolls under the top of the screen. The fade grows over the first 32px
// of scroll. Styles: .edge-fade in legal.css (and in join.html).
(function () {
  var el = document.getElementById('edgeFade');
  if (!el) return;
  var queued = false;
  function update() {
    queued = false;
    el.style.setProperty('--edge-fade', Math.min(Math.max(window.scrollY, 0), 32) / 32);
  }
  window.addEventListener('scroll', function () {
    if (queued) return;
    queued = true;
    requestAnimationFrame(update);
  }, { passive: true });
  update();
})();
