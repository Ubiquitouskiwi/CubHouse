'use strict';

/*
 * Parent photo management: multi-select with quick bulk actions.
 *
 * Selection model (familiar file-manager behavior):
 *   - Click a photo's select box, or Ctrl/Cmd-click anywhere on the card,
 *     to toggle that one photo. This sets the range anchor.
 *   - Shift-click a card to select the contiguous range from the anchor to
 *     that card (replacing the current selection).
 *   - Plain click on the photo image still opens the lightbox and does NOT
 *     change the selection, so viewing and managing stay separate.
 *   - The select-all checkbox toggles every photo at once.
 *
 * The toolbar's bulk buttons are disabled until at least one photo is selected.
 * On submit, the selected ids are written into the form as hidden inputs so the
 * server receives exactly the chosen set. Progressive enhancement: with JS off,
 * each card still has its own single-photo action forms and the Open link.
 */
(function () {
  var form = document.querySelector('[data-bulk-form]');
  var grid = document.querySelector('[data-photo-grid]');
  if (!form || !grid) {
    return;
  }

  var cards = Array.prototype.slice.call(
    grid.querySelectorAll('[data-photo-card]')
  );
  var selectAll = form.querySelector('[data-select-all]');
  var countLabel = form.querySelector('[data-select-count]');
  var idContainer = form.querySelector('[data-bulk-ids]');
  var actionButtons = Array.prototype.slice.call(
    form.querySelectorAll('[data-bulk-action]')
  );

  // Index each card so Shift-range selection knows the order.
  var order = {};
  cards.forEach(function (card, i) {
    order[card.getAttribute('data-photo-id')] = i;
  });

  var anchorIndex = null; // last single-toggled card, for range selection

  function checkboxOf(card) {
    return card.querySelector('[data-photo-checkbox]');
  }

  function isSelected(card) {
    var cb = checkboxOf(card);
    return cb ? cb.checked : false;
  }

  function setSelected(card, value) {
    var cb = checkboxOf(card);
    if (cb) {
      cb.checked = value;
    }
    card.classList.toggle('is-selected', value);
  }

  function selectedCards() {
    return cards.filter(isSelected);
  }

  function refresh() {
    var selected = selectedCards();
    var n = selected.length;

    if (countLabel) {
      countLabel.textContent =
        n === 1 ? '1 selected' : n + ' selected';
    }
    actionButtons.forEach(function (btn) {
      btn.disabled = n === 0;
    });
    if (selectAll) {
      selectAll.checked = n > 0 && n === cards.length;
      selectAll.indeterminate = n > 0 && n < cards.length;
    }
  }

  // Replace selection with the contiguous range [a, b] inclusive.
  function selectRange(a, b) {
    var lo = Math.min(a, b);
    var hi = Math.max(a, b);
    cards.forEach(function (card, i) {
      setSelected(card, i >= lo && i <= hi);
    });
  }

  function toggleOne(card) {
    setSelected(card, !isSelected(card));
  }

  // Wire each card. We listen on the card but ignore clicks that originate on
  // the image open button (those belong to the lightbox) unless a modifier is
  // held, in which case the click means "select", not "open".
  cards.forEach(function (card, index) {
    var cb = checkboxOf(card);

    // Direct checkbox interaction: toggle, set anchor.
    if (cb) {
      cb.addEventListener('click', function (e) {
        // Let the native checkbox update, then sync state.
        e.stopPropagation();
        card.classList.toggle('is-selected', cb.checked);
        anchorIndex = index;
        refresh();
      });
    }

    card.addEventListener('click', function (e) {
      var onOpen = e.target.closest('[data-photo-open]');
      var onCheckbox = e.target.closest('[data-photo-checkbox]');
      var onActionForm = e.target.closest('.photo-actions');
      if (onCheckbox) {
        return; // handled above
      }

      // Shift-click: range select from the anchor to here.
      if (e.shiftKey) {
        e.preventDefault();
        if (anchorIndex === null) {
          anchorIndex = index;
        }
        selectRange(anchorIndex, index);
        refresh();
        return;
      }

      // Ctrl/Cmd-click anywhere on the card: toggle this one.
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        toggleOne(card);
        anchorIndex = index;
        refresh();
        return;
      }

      // Plain click on the image opens the lightbox (handled by lightbox.js);
      // plain click on the per-photo action forms does its own thing. A plain
      // click on empty card chrome toggles selection for convenience.
      if (onOpen || onActionForm) {
        return;
      }
      toggleOne(card);
      anchorIndex = index;
      refresh();
    });
  });

  if (selectAll) {
    selectAll.addEventListener('change', function () {
      var value = selectAll.checked;
      cards.forEach(function (card) {
        setSelected(card, value);
      });
      anchorIndex = null;
      refresh();
    });
  }

  // On submit, serialize the selection into hidden inputs and confirm deletes.
  form.addEventListener('submit', function (e) {
    var submitter = e.submitter || document.activeElement;
    var isDelete =
      submitter && submitter.getAttribute('data-bulk-delete') !== null;
    var selected = selectedCards();

    if (selected.length === 0) {
      e.preventDefault();
      return;
    }
    if (isDelete) {
      var ok = window.confirm(
        'Delete ' +
          selected.length +
          (selected.length === 1 ? ' photo' : ' photos') +
          '? This cannot be undone.'
      );
      if (!ok) {
        e.preventDefault();
        return;
      }
    }

    idContainer.innerHTML = '';
    selected.forEach(function (card) {
      var input = document.createElement('input');
      input.type = 'hidden';
      input.name = 'photoIds';
      input.value = card.getAttribute('data-photo-id');
      idContainer.appendChild(input);
    });
  });

  refresh();
})();
