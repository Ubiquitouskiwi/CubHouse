'use strict';

/*
 * Photo lightbox. Clicking a grid photo opens a full-size overlay. Clicking the
 * image toggles a zoomed-in state. Escape, the close button, or a click on the
 * backdrop closes it. Progressive enhancement: with JS off, each photo tile
 * still links to its detail page via the "Open" link.
 */
(function () {
  var lightbox = document.querySelector('[data-lightbox]');
  if (!lightbox) {
    return;
  }

  var image = lightbox.querySelector('[data-lightbox-image]');
  var caption = lightbox.querySelector('[data-lightbox-caption]');
  var pageLink = lightbox.querySelector('[data-lightbox-page]');
  var closeBtn = lightbox.querySelector('[data-lightbox-close]');

  function open(src, cap, href) {
    image.setAttribute('src', src);
    image.setAttribute('alt', cap || 'Photo');
    caption.textContent = cap || '';
    if (pageLink && href) {
      pageLink.setAttribute('href', href);
    }
    image.classList.remove('is-zoomed');
    lightbox.hidden = false;
    document.body.classList.add('lightbox-open');
  }

  function close() {
    lightbox.hidden = true;
    image.setAttribute('src', '');
    image.classList.remove('is-zoomed');
    document.body.classList.remove('lightbox-open');
  }

  // Wire up every photo trigger in the grid.
  document.querySelectorAll('[data-photo-open]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      open(
        btn.getAttribute('data-src'),
        btn.getAttribute('data-caption'),
        btn.getAttribute('data-href')
      );
    });
  });

  // Click the image to toggle zoom.
  image.addEventListener('click', function (e) {
    e.stopPropagation();
    image.classList.toggle('is-zoomed');
  });

  if (closeBtn) {
    closeBtn.addEventListener('click', close);
  }

  // Click on the backdrop (not the figure) closes.
  lightbox.addEventListener('click', function (e) {
    if (e.target === lightbox) {
      close();
    }
  });

  // Escape closes.
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !lightbox.hidden) {
      close();
    }
  });
})();
