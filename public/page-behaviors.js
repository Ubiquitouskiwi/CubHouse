'use strict';

/*
 * Small page behaviors that used to be inline <script> blocks and inline
 * onsubmit="..." handlers. Moving them here lets the Content Security Policy
 * forbid inline script entirely. Everything is driven by data- attributes.
 */
(function () {
  // Confirm before submitting a destructive form: <form data-confirm="...">
  document.addEventListener('submit', function (event) {
    var form = event.target;
    if (form && form.getAttribute && form.hasAttribute('data-confirm')) {
      if (!window.confirm(form.getAttribute('data-confirm'))) {
        event.preventDefault();
      }
    }
  });

  // Show only the id list relevant to the chosen audience. A container marked
  // data-audience-scope holds radios [data-aud-radio] and panels
  // [data-aud-panel="<audience>"].
  function bindAudience(root) {
    var radios = root.querySelectorAll('[data-aud-radio]');
    var panels = root.querySelectorAll('[data-aud-panel]');
    function sync() {
      var chosen = root.querySelector('[data-aud-radio]:checked');
      var val = chosen ? chosen.value : 'parents';
      panels.forEach(function (p) {
        p.hidden = p.getAttribute('data-aud-panel') !== val;
      });
    }
    radios.forEach(function (r) {
      r.addEventListener('change', sync);
    });
    sync();
  }
  document.querySelectorAll('[data-audience-scope]').forEach(bindAudience);

  // Point an "add to album" form at the chosen album.
  document.querySelectorAll('[data-album-add]').forEach(function (form) {
    var select = form.querySelector('[data-album-select]');
    if (!select) {
      return;
    }
    var setAction = function () {
      form.setAttribute('action', '/albums/' + encodeURIComponent(select.value) + '/add');
    };
    setAction();
    select.addEventListener('change', setAction);
  });

  // Show the watermark override only when download is enabled.
  document.querySelectorAll('[data-download-toggle]').forEach(function (box) {
    var target = document.querySelector(box.getAttribute('data-download-toggle'));
    if (!target) {
      return;
    }
    var sync = function () {
      target.hidden = !box.checked;
    };
    box.addEventListener('change', sync);
    sync();
  });
})();
