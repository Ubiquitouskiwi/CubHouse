(function () {
  'use strict';

  // Account menu: a disclosure button (aria-expanded) that shows a panel of
  // links. Click, tap, Enter or Space toggles it. Opening from the keyboard
  // moves focus to the first link; Escape closes it and returns focus to the
  // button; tabbing or clicking outside closes it.

  var menu = document.querySelector('[data-profile-menu]');
  if (!menu) {
    return;
  }

  var trigger = menu.querySelector('[data-profile-trigger]');
  var dropdown = menu.querySelector('[data-profile-dropdown]');
  if (!trigger || !dropdown) {
    return;
  }

  function open(focusFirst) {
    dropdown.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    if (focusFirst) {
      var first = dropdown.querySelector('a, button');
      if (first) {
        first.focus();
      }
    }
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
      // detail is 0 when the click came from Enter or Space, not a pointer.
      open(event.detail === 0);
    }
  });

  document.addEventListener('click', function (event) {
    if (isOpen() && !menu.contains(event.target)) {
      close();
    }
  });

  // Focus leaving the menu (Tab past the last link, or Shift+Tab out) closes it.
  menu.addEventListener('focusout', function (event) {
    if (isOpen() && event.relatedTarget && !menu.contains(event.relatedTarget)) {
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
