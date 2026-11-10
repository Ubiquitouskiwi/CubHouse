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

  // Copy a value to the clipboard (local only, nothing is sent anywhere):
  // <button data-copy="#id" hidden>. Spaces are dropped, so a key shown in
  // groups of four pastes as one string. Shown only where the API exists.
  if (navigator.clipboard && window.isSecureContext) {
    document.querySelectorAll('[data-copy]').forEach(function (button) {
      var source = document.querySelector(button.getAttribute('data-copy'));
      if (!source) {
        return;
      }
      var label = button.textContent;
      button.hidden = false;
      button.addEventListener('click', function () {
        navigator.clipboard.writeText(source.textContent.replace(/\s+/g, '')).then(function () {
          button.textContent = 'Copied';
          setTimeout(function () {
            button.textContent = label;
          }, 2000);
        });
      });
    });
  }

  // Invite email link: /register#code=INVITE-XXXX-XXXX-XXXX. The fragment is
  // never sent to the server (no access logs, no Referer). Prefill only: the
  // server still validates the code. The fragment is then removed from the
  // address bar and history.
  var codeField = document.querySelector('form[action="/register"] input[name="accessCode"]');
  var codeMatch = /^#code=(INVITE-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4})$/.exec(window.location.hash || '');
  if (codeField && codeMatch) {
    if (!codeField.value) {
      codeField.value = codeMatch[1];
    }
    if (window.history && window.history.replaceState) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    }
  }

  // Admin, Family settings: suggest the browser's own time zone and keep the
  // "Invite codes will say" example in step with the field. Same format as
  // the server's emails (src/timeZone.js formatInZone). Nothing is sent
  // until the guardian presses Save; the server validates the zone again.
  document.querySelectorAll('[data-tz-setting]').forEach(function (form) {
    var input = form.querySelector('[data-tz-input]');
    var example = form.querySelector('[data-tz-example]');
    var at = Number(form.getAttribute('data-example-at'));
    var fallback = form.getAttribute('data-server-default') || 'UTC';
    if (!input || !example || !window.Intl) {
      return;
    }
    function format(zone) {
      try {
        return new Intl.DateTimeFormat('en-US', {
          timeZone: zone,
          weekday: 'short',
          month: 'short',
          day: 'numeric',
          year: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
          timeZoneName: 'short',
        }).format(new Date(at));
      } catch (e) {
        return null;
      }
    }
    function sync() {
      var zone = input.value.trim().replace(/ /g, '_');
      var text = format(zone || fallback);
      example.textContent = text
        ? text + (zone ? '' : ' (server default)')
        : 'not a time zone yet. Pick one from the list.';
    }
    var mine = null;
    try {
      mine = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch (e) {
      mine = null;
    }
    var suggest = form.querySelector('[data-tz-suggest]');
    var useMine = form.querySelector('[data-tz-use-mine]');
    if (mine && suggest && useMine) {
      form.querySelector('[data-tz-browser]').textContent = mine;
      suggest.hidden = false;
      useMine.addEventListener('click', function () {
        input.value = mine;
        sync();
        input.focus();
      });
    }
    input.addEventListener('input', sync);
    sync();
  });
})();
