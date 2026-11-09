'use strict';

/*
 * Recent-photos carousel for the welcome page.
 *
 * Progressive enhancement: the markup is a plain horizontally scrollable track
 * of slides, so with JS off it is still usable (native scroll / swipe). This
 * script wires the prev/next buttons to scroll by roughly one viewport, keeps
 * the buttons' disabled state in sync with the scroll position, and respects
 * the user's reduced-motion preference for the scroll animation.
 */
(function () {
  var reduceMotion =
    window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function setup(carousel) {
    var track = carousel.querySelector('[data-carousel-track]');
    var prev = carousel.querySelector('[data-carousel-prev]');
    var next = carousel.querySelector('[data-carousel-next]');
    if (!track || !prev || !next) {
      return;
    }

    function scrollByPage(direction) {
      // Scroll by ~85% of the visible width so a sliver of the next slide
      // stays on screen as an affordance that there is more.
      var amount = track.clientWidth * 0.85 * direction;
      track.scrollBy({
        left: amount,
        behavior: reduceMotion ? 'auto' : 'smooth'
      });
    }

    function updateButtons() {
      var maxScroll = track.scrollWidth - track.clientWidth - 1;
      var atStart = track.scrollLeft <= 0;
      var atEnd = track.scrollLeft >= maxScroll;
      // If everything fits, hide the controls entirely.
      var overflows = track.scrollWidth > track.clientWidth + 1;
      prev.hidden = !overflows;
      next.hidden = !overflows;
      prev.disabled = atStart;
      next.disabled = atEnd;
    }

    prev.addEventListener('click', function () {
      scrollByPage(-1);
    });
    next.addEventListener('click', function () {
      scrollByPage(1);
    });
    track.addEventListener('scroll', updateButtons, { passive: true });
    window.addEventListener('resize', updateButtons);

    updateButtons();
  }

  var carousels = document.querySelectorAll('[data-carousel]');
  for (var i = 0; i < carousels.length; i += 1) {
    setup(carousels[i]);
  }
})();
