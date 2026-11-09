(function () {
  'use strict';

  var menu = document.querySelector('[data-profile-menu]');
  if (!menu) {
    return;
  }

  var trigger = menu.querySelector('[data-profile-trigger]');
  var dropdown = menu.querySelector('[data-profile-dropdown]');
  if (!trigger || !dropdown) {
    return;
  }

  function open() {
    dropdown.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
  }

  function close() {
    dropdown.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
  }

  function isOpen() {
    return !dropdown.hidden;
  }

  trigger.addEventListener('click', function (event) {
    event.stopPropagation();
    if (isOpen()) {
      close();
    } else {
      open();
    }
  });

  document.addEventListener('click', function (event) {
    if (isOpen() && !menu.contains(event.target)) {
      close();
    }
  });

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && isOpen()) {
      close();
      trigger.focus();
    }
  });
})();
