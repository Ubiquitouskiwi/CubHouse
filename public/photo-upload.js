'use strict';

/*
 * Bulk photo upload for the "Add a photo" form on Home.
 *
 * Without JavaScript the form posts one photo and the server answers with a
 * flash message. With it, this script lets people pick or drag in many photos
 * and sends them one request per photo to the SAME route (so every auth, CSRF,
 * rate-limit and file check still runs per photo), three at a time, asking for
 * a JSON answer: { ok, photo } or { ok: false, error: { code, message } }.
 *
 * Every photo gets a row with a plain-language state: Waiting, Uploading n%,
 * Saving (the server is re-encoding it and stripping location details),
 * Added / Sent, or Failed with the reason and a Retry button. One failure never
 * stops the rest. Files the server would refuse (too big, a video, an iPhone
 * HEIC) fail at once, before any bytes are sent.
 *
 * The logic below is plain functions so test/photoUploadClient.test.js can run
 * it in Node; mount() is the only part that touches the page. Previews use
 * object URLs, which never leave the browser.
 */
(function (factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (typeof document !== 'undefined') {
    api.mount(document);
  }
})(function () {
  var CONCURRENCY = 3;
  var ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/avif'];
  var ALLOWED_EXT = ['jpg', 'jpeg', 'png', 'webp', 'avif'];
  var HEIC_EXT = ['heic', 'heif'];
  var VIDEO_EXT = ['mov', 'mp4', 'm4v', 'avi', '3gp', 'webm', 'mkv'];
  // Codes after which sending more photos cannot work until the person acts.
  var STOP_CODES = ['rate_limited', 'signed_out', 'expired'];
  // Codes whose server message is already written for people; shown as is.
  var SERVER_WORDED = ['unreadable', 'unsupported_type', 'animated', 'too_many_pixels', 'processing_failed', 'bad_caption'];

  function extOf(name) {
    var m = /\.([a-z0-9]+)$/i.exec(String(name || ''));
    return m ? m[1].toLowerCase() : '';
  }

  function formatBytes(n) {
    if (n >= 1024 * 1024) {
      return (n / (1024 * 1024)).toFixed(1) + ' MB';
    }
    return Math.max(1, Math.round(n / 1024)) + ' KB';
  }

  function plural(n, one, many) {
    return n + ' ' + (n === 1 ? one : many);
  }

  /** Checks a file the way the server will, so a bad one fails instantly. */
  function checkFile(file, maxBytes) {
    var type = String(file.type || '').toLowerCase();
    var ext = extOf(file.name);
    if (type.indexOf('video/') === 0 || VIDEO_EXT.indexOf(ext) !== -1) {
      return 'video';
    }
    if (type === 'image/heic' || type === 'image/heif' || HEIC_EXT.indexOf(ext) !== -1) {
      return 'heic';
    }
    if (!file.size) {
      return 'empty';
    }
    if (file.size > maxBytes) {
      return 'too_large';
    }
    // Some phones and computers send no type; fall back to the extension and
    // let the server's byte check decide.
    if (ALLOWED_TYPES.indexOf(type) !== -1 || (!type && ALLOWED_EXT.indexOf(ext) !== -1)) {
      return null;
    }
    return 'unsupported_type';
  }

  /** Plain-language reason for a failure code. */
  function messageFor(code, opts) {
    var o = opts || {};
    var mb = Math.round((o.maxBytes || 15 * 1024 * 1024) / (1024 * 1024));
    if (o.serverMessage && SERVER_WORDED.indexOf(code) !== -1) {
      return o.serverMessage;
    }
    switch (code) {
      case 'too_large':
        return 'Too big: over ' + mb + ' MB. Pick a smaller copy, or send it from your phone\'s share menu, which usually shrinks it.';
      case 'video':
        return 'This is a video. Only photos can be uploaded for now.';
      case 'heic':
        return 'This is an iPhone HEIC photo, which Cubhouse cannot read yet. On the iPhone, choose Settings, Camera, ' +
          'Formats, Most Compatible, or share the photo as a JPEG.';
      case 'empty':
        return 'This file is empty.';
      case 'unsupported_type':
        return 'Not a photo type Cubhouse accepts. Use JPEG, PNG, WebP, or AVIF.';
      case 'duplicate':
        return 'Already in this list, so it was skipped.';
      case 'network':
        return 'The connection dropped. Check your Wi-Fi or signal, then select Retry.';
      case 'rate_limited':
        return 'Upload limit reached for now (about ' + (o.perHour || 120) + ' photos an hour). ' +
          'Wait a while, then select Retry failed.';
      case 'signed_out':
        return 'You were signed out. Refresh the page, sign in, and add the photos that did not go through.';
      case 'expired':
        return 'This page expired. Refresh the page and add the photos that did not go through.';
      case 'cancelled':
        return 'Cancelled.';
      case 'server_error':
        return 'Something went wrong on our end. Select Retry. If it keeps failing, tell a guardian.';
      default:
        return o.serverMessage || 'This photo could not be uploaded. Select Retry, or try a different file.';
    }
  }

  /** Map an HTTP answer (status + parsed JSON or null) to { ok, ... }. */
  function interpretResponse(status, json, redirectedToLogin) {
    if (json && json.ok === true) {
      return { ok: true, photo: json.photo || null, sharing: json.sharing || null, message: json.message || '' };
    }
    if (json && json.error && json.error.code) {
      return { ok: false, code: json.error.code, serverMessage: json.error.message || '' };
    }
    if (redirectedToLogin || status === 401) {
      return { ok: false, code: 'signed_out' };
    }
    if (status === 403) {
      return { ok: false, code: 'expired' };
    }
    if (status === 413) {
      return { ok: false, code: 'too_large' };
    }
    if (status === 429) {
      return { ok: false, code: 'rate_limited' };
    }
    if (status === 0) {
      return { ok: false, code: 'network' };
    }
    return { ok: false, code: 'server_error' };
  }

  function formatEta(seconds) {
    if (!isFinite(seconds) || seconds <= 0) {
      return '';
    }
    if (seconds < 60) {
      return 'less than a minute left';
    }
    return 'about ' + plural(Math.round(seconds / 60), 'minute', 'minutes') + ' left';
  }

  /**
   * The upload queue. `send(item, onProgress)` starts one upload and returns
   * { promise, abort }; promise resolves to interpretResponse()'s shape and
   * onProgress(loaded, total) reports bytes, with loaded === total meaning the
   * bytes are all there and the server is now processing.
   */
  function createQueue(options) {
    var send = options.send;
    var concurrency = options.concurrency || CONCURRENCY;
    var maxBytes = options.maxBytes;
    var onChange = options.onChange || function () {};
    var onFinish = options.onFinish || function () {};
    var now = options.now || function () { return Date.now(); };
    var items = [];
    var nextId = 1;
    var running = false;
    var startedAt = 0;
    var bytesAtStart = 0;

    function find(id) {
      for (var i = 0; i < items.length; i += 1) {
        if (items[i].id === id) {
          return items[i];
        }
      }
      return null;
    }

    function keyOf(file) {
      return [file.name, file.size, file.lastModified].join('|');
    }

    function set(item, patch) {
      for (var k in patch) {
        if (Object.prototype.hasOwnProperty.call(patch, k)) {
          item[k] = patch[k];
        }
      }
      onChange(item);
    }

    function active() {
      return items.filter(function (it) { return it.state === 'uploading' || it.state === 'processing'; });
    }

    function add(files, fields) {
      var added = [];
      var seen = {};
      items.forEach(function (it) {
        if (it.state !== 'cancelled' && it.state !== 'skipped') {
          seen[keyOf(it.file)] = true;
        }
      });
      Array.prototype.forEach.call(files, function (file) {
        var key = keyOf(file);
        var problem = seen[key] ? 'duplicate' : checkFile(file, maxBytes);
        seen[key] = true;
        var item = {
          id: nextId,
          file: file,
          name: file.name || 'photo',
          size: file.size || 0,
          loaded: 0,
          state: problem === 'duplicate' ? 'skipped' : problem ? 'failed' : 'queued',
          code: problem,
          serverMessage: '',
          result: null,
          fields: running ? fields || null : null,
          abort: null,
          // Instant (client-side) failures cannot succeed on retry.
          retryable: !problem,
        };
        nextId += 1;
        items.push(item);
        added.push(item);
        onChange(item);
      });
      if (running) {
        pump();
      }
      return added;
    }

    function finish() {
      running = false;
      onFinish(counts());
    }

    function pump() {
      if (!running) {
        return;
      }
      var slots = concurrency - active().length;
      var queued = items.filter(function (it) { return it.state === 'queued'; });
      for (var i = 0; i < queued.length && slots > 0; i += 1, slots -= 1) {
        startOne(queued[i]);
      }
      if (active().length === 0 && queued.length === 0) {
        finish();
      }
    }

    function startOne(item) {
      set(item, { state: 'uploading', loaded: 0, code: null, serverMessage: '' });
      var handle = send(item, function (loaded, total) {
        if (item.state !== 'uploading') {
          return;
        }
        set(item, { loaded: Math.min(loaded, item.size), state: total && loaded >= total ? 'processing' : 'uploading' });
      });
      item.abort = handle.abort;
      handle.promise.then(function (res) {
        item.abort = null;
        if (item.state === 'cancelled') {
          return;
        }
        if (res.ok) {
          set(item, { state: 'done', loaded: item.size, result: res });
        } else {
          set(item, { state: 'failed', loaded: 0, code: res.code, serverMessage: res.serverMessage || '' });
          if (STOP_CODES.indexOf(res.code) !== -1) {
            // Sending more would fail the same way: hold the rest with the
            // same reason, still retryable, instead of hammering the server.
            items.forEach(function (it) {
              if (it.state === 'queued') {
                set(it, { state: 'failed', code: res.code, serverMessage: '' });
              }
            });
          }
        }
        pump();
      });
    }

    function start(fields) {
      items.forEach(function (it) {
        if (it.state === 'queued' && !it.fields) {
          it.fields = fields || null;
        }
      });
      if (!items.some(function (it) { return it.state === 'queued'; })) {
        return false;
      }
      if (!running) {
        running = true;
        startedAt = now();
        bytesAtStart = progress().loaded;
      }
      pump();
      return true;
    }

    function retry(id, fields) {
      var item = find(id);
      if (!item || !item.retryable || (item.state !== 'failed' && item.state !== 'cancelled')) {
        return false;
      }
      set(item, { state: 'queued', code: null, serverMessage: '', loaded: 0, fields: item.fields || fields || null });
      return start(fields);
    }

    function retryFailed(fields) {
      var any = false;
      items.forEach(function (it) {
        if (it.retryable && it.state === 'failed') {
          set(it, { state: 'queued', code: null, serverMessage: '', loaded: 0 });
          any = true;
        }
      });
      return any ? start(fields) : false;
    }

    function cancel(id) {
      var item = find(id);
      // Once the bytes are in, the server is already saving the photo, so a
      // cancel then would only hide a photo that still gets added.
      if (!item || (item.state !== 'queued' && item.state !== 'uploading')) {
        return false;
      }
      var abort = item.state === 'uploading' ? item.abort : null;
      set(item, { state: 'cancelled', code: 'cancelled', loaded: 0 });
      if (abort) {
        abort();
      }
      if (running) {
        pump();
      }
      return true;
    }

    function cancelAll() {
      items.slice().forEach(function (it) {
        if (it.state === 'queued' || it.state === 'uploading') {
          cancel(it.id);
        }
      });
    }

    function remove(id) {
      var item = find(id);
      if (!item || item.state === 'uploading' || item.state === 'processing' || item.state === 'queued') {
        return false;
      }
      items.splice(items.indexOf(item), 1);
      return true;
    }

    function clearFinished() {
      var removed = items.filter(function (it) { return it.state !== 'queued' && it.state !== 'uploading' && it.state !== 'processing'; });
      items = items.filter(function (it) { return removed.indexOf(it) === -1; });
      return removed;
    }

    function counts() {
      var c = { total: items.length, queued: 0, uploading: 0, processing: 0, done: 0, failed: 0, cancelled: 0, skipped: 0,
        awaitingGuardian: 0, rejected: 0 };
      items.forEach(function (it) {
        c[it.state] += 1;
        if (it.state === 'failed' && !it.retryable) {
          c.rejected += 1;
        }
        if (it.state === 'done' && it.result && it.result.sharing === 'awaiting_guardian') {
          c.awaitingGuardian += 1;
        }
      });
      return c;
    }

    /** Overall progress over the photos actually being sent. */
    function progress() {
      var loaded = 0;
      var total = 0;
      items.forEach(function (it) {
        if (it.state === 'done' || it.state === 'processing') {
          total += it.size;
          loaded += it.size;
        } else if (it.state === 'uploading' || it.state === 'queued') {
          total += it.size;
          loaded += it.loaded;
        }
      });
      var percent = total ? Math.floor((loaded / total) * 100) : 0;
      var eta = NaN;
      var elapsed = (now() - startedAt) / 1000;
      if (running && elapsed >= 3 && loaded > bytesAtStart) {
        eta = (total - loaded) / ((loaded - bytesAtStart) / elapsed);
      }
      return { loaded: loaded, total: total, percent: percent, eta: eta };
    }

    function isBusy() {
      return items.some(function (it) {
        return it.state === 'uploading' || it.state === 'processing' || (running && it.state === 'queued');
      });
    }

    return {
      add: add,
      start: start,
      retry: retry,
      retryFailed: retryFailed,
      cancel: cancel,
      cancelAll: cancelAll,
      remove: remove,
      clearFinished: clearFinished,
      counts: counts,
      progress: progress,
      isBusy: isBusy,
      isRunning: function () { return running; },
      items: function () { return items.slice(); },
    };
  }

  /** One-line overall status while uploads run. */
  function overallText(c, p) {
    // Files refused before sending are not part of "n of N".
    var finished = c.done + c.failed - (c.rejected || 0);
    var sending = finished + c.uploading + c.processing + c.queued;
    var parts = ['Uploading: ' + finished + ' of ' + sending + ' finished', p.percent + '%'];
    var eta = formatEta(p.eta);
    if (eta) {
      parts.push(eta);
    }
    return parts.join(', ');
  }

  /** The end-of-batch summary: what happened and what to do next. */
  function summarize(c, role) {
    var member = role === 'member';
    var lines = [];
    if (c.done) {
      lines.push(member
        ? 'They show up for the family once a parent approves them.'
        : 'New photos are private to parents until you share them.');
    }
    if (c.awaitingGuardian) {
      lines.push(plural(c.awaitingGuardian, 'photo is', 'photos are') +
        ' waiting for the other guardian to approve the sharing you picked.');
    }
    if (c.failed) {
      lines.push(plural(c.failed, 'photo', 'photos') + ' did not upload. They are at the top of the list, ' +
        'each with the reason.' + (c.failed > (c.rejected || 0) ? ' Select Retry to try again.' : ''));
    }
    if (c.cancelled) {
      lines.push(plural(c.cancelled, 'photo was', 'photos were') + ' cancelled.');
    }
    if (c.skipped) {
      lines.push(plural(c.skipped, 'duplicate was', 'duplicates were') + ' skipped.');
    }
    var headline = member
      ? plural(c.done, 'photo', 'photos') + ' sent' + (c.failed ? ', ' + c.failed + ' failed' : '')
      : plural(c.done, 'photo', 'photos') + ' added' + (c.failed ? ', ' + c.failed + ' failed' : '');
    return {
      headline: headline,
      lines: lines,
      tone: c.failed ? (c.done ? 'mixed' : 'error') : 'success',
      link: c.done
        ? member
          ? { href: '/home?uploaded=1#my-uploads', text: 'See the photos you sent in' }
          : { href: '/photos', text: 'View the new photos' }
        : null,
    };
  }

  var STATE_LABEL = {
    queued: 'Waiting',
    uploading: 'Uploading',
    processing: 'Saving',
    done: 'Added',
    failed: 'Failed',
    cancelled: 'Cancelled',
    skipped: 'Skipped',
  };

  function stateText(item, role) {
    if (item.state === 'uploading') {
      return 'Uploading ' + (item.size ? Math.floor((item.loaded / item.size) * 100) : 0) + '%';
    }
    if (item.state === 'processing') {
      return 'Saving (removing location details)';
    }
    if (item.state === 'done') {
      if (role === 'member') {
        return 'Sent for approval';
      }
      return item.result && item.result.sharing === 'awaiting_guardian' ? 'Added, sharing awaits a guardian' : 'Added';
    }
    return STATE_LABEL[item.state] || item.state;
  }

  // --- Browser wiring ---

  function xhrSend(url, csrf) {
    return function (item, onProgress) {
      var xhr = new XMLHttpRequest();
      var promise = new Promise(function (resolve) {
        var data = new FormData();
        data.append('_csrf', csrf);
        if (item.fields && item.fields.caption) {
          data.append('caption', item.fields.caption);
        }
        if (item.fields && item.fields.profileId) {
          data.append('profileId', item.fields.profileId);
        }
        data.append('image', item.file, item.name);
        xhr.open('POST', url);
        xhr.setRequestHeader('Accept', 'application/json');
        xhr.timeout = 10 * 60 * 1000;
        xhr.upload.onprogress = function (e) {
          if (e.lengthComputable) {
            onProgress(e.loaded, e.total);
          }
        };
        xhr.upload.onload = function () {
          onProgress(item.size, item.size);
        };
        xhr.onload = function () {
          var json = null;
          if (/json/.test(xhr.getResponseHeader('Content-Type') || '')) {
            try {
              json = JSON.parse(xhr.responseText);
            } catch {
              json = null;
            }
          }
          // A redirect to the sign-in page is followed silently by XHR.
          var toLogin = /\/login(\?|$)/.test(String(xhr.responseURL || '').replace(/#.*$/, ''));
          resolve(interpretResponse(xhr.status, json, toLogin));
        };
        xhr.onerror = function () { resolve({ ok: false, code: 'network' }); };
        xhr.ontimeout = function () { resolve({ ok: false, code: 'network' }); };
        xhr.onabort = function () { resolve({ ok: false, code: 'cancelled' }); };
        xhr.send(data);
      });
      return { promise: promise, abort: function () { xhr.abort(); } };
    };
  }

  function mount(doc) {
    var form = doc.querySelector('[data-upload-form]');
    if (!form || typeof FormData === 'undefined' || typeof XMLHttpRequest === 'undefined') {
      return;
    }
    var q = function (sel) { return form.querySelector(sel); };
    var input = q('[data-upload-input]');
    var submitBtn = q('[data-upload-submit]');
    var drop = q('[data-upload-drop]');
    var queueBox = q('[data-upload-queue]');
    var list = q('[data-upload-list]');
    var overall = q('[data-upload-overall]');
    var bar = q('[data-upload-progress]');
    var keepOpen = q('[data-upload-keep-open]');
    var summaryBox = q('[data-upload-summary]');
    var live = q('[data-upload-live]');
    var status = q('[data-upload-status]');
    var retryAllBtn = q('[data-upload-retry-all]');
    var cancelAllBtn = q('[data-upload-cancel-all]');
    var clearBtn = q('[data-upload-clear]');
    var captionInput = q('[data-upload-caption]');
    var csrfInput = form.querySelector('input[name="_csrf"]');
    if (!input || !submitBtn || !list) {
      return;
    }
    var role = form.getAttribute('data-uploader-role') || 'member';
    var maxBytes = Number(form.getAttribute('data-max-bytes')) || 15 * 1024 * 1024;
    var perHour = Number(form.getAttribute('data-per-hour')) || 120;
    var labelOne = submitBtn.getAttribute('data-label-one') || 'Upload';
    var rows = {};
    var previews = 0;
    var MAX_PREVIEWS = 24; // shortcut: decoding hundreds of phone photos at once can exhaust a phone's memory.

    // Enhance: many files, no native "required" (the queue decides), the
    // single-photo preview is replaced by the list.
    input.multiple = true;
    input.removeAttribute('required');
    form.classList.add('upload-enhanced');
    var pickLabel = q('[data-upload-pick-label]');
    if (pickLabel) {
      pickLabel.textContent = 'Choose photos';
    }
    var dropText = q('[data-upload-drop-text]');
    if (dropText) {
      dropText.hidden = false;
    }
    var multiHint = q('[data-upload-multi-hint]');
    if (multiHint) {
      multiHint.hidden = false;
    }

    function fields() {
      var profile = form.elements.profileId;
      return {
        caption: captionInput ? captionInput.value.trim() : '',
        profileId: profile ? profile.value : '',
      };
    }

    function announce(text) {
      if (live) {
        // Clear first so the same words are announced again.
        live.textContent = '';
        setTimeout(function () { live.textContent = text; }, 50);
      }
    }

    var queue = createQueue({
      send: xhrSend(form.getAttribute('action'), csrfInput ? csrfInput.value : ''),
      maxBytes: maxBytes,
      onChange: function (item) {
        renderRow(item);
        scheduleOverall();
        // Instant (client-side) failures are announced together by addFiles().
        if (item.state === 'failed' && item.retryable) {
          announce(item.name + ' failed. ' + reason(item));
        }
      },
      onFinish: function (c) {
        // Bring failures to the top so they are not lost below the fold.
        queue.items().filter(function (it) { return it.state === 'failed'; }).reverse().forEach(function (it) {
          if (rows[it.id]) {
            list.insertBefore(rows[it.id].li, list.firstChild);
          }
        });
        list.scrollTop = 0;
        renderOverall();
        renderSummary(c);
      },
    });

    function reason(item) {
      return messageFor(item.code, { maxBytes: maxBytes, perHour: perHour, serverMessage: item.serverMessage });
    }

    function el(tag, cls, text) {
      var node = doc.createElement(tag);
      if (cls) {
        node.className = cls;
      }
      if (text !== undefined) {
        node.textContent = text;
      }
      return node;
    }

    function button(text, label, onClick) {
      var b = el('button', 'btn-sm', text);
      b.type = 'button';
      b.setAttribute('aria-label', label);
      b.addEventListener('click', onClick);
      return b;
    }

    function renderRow(item) {
      var row = rows[item.id];
      if (!row) {
        var li = el('li', 'upload-item');
        li.tabIndex = -1;
        var thumb;
        if (previews < MAX_PREVIEWS && /^image\/(jpeg|png|webp|avif)$/.test(item.file.type) && item.state !== 'failed') {
          previews += 1;
          thumb = el('img', 'upload-item-thumb');
          thumb.alt = '';
          var url = URL.createObjectURL(item.file);
          thumb.onload = function () { URL.revokeObjectURL(url); };
          thumb.onerror = function () {
            // Not a real image: show the plain placeholder, not a broken icon.
            URL.revokeObjectURL(url);
            var blank = el('span', 'upload-item-thumb upload-item-thumb-blank');
            blank.setAttribute('aria-hidden', 'true');
            if (thumb.parentNode) {
              thumb.parentNode.replaceChild(blank, thumb);
            }
          };
          thumb.src = url;
        } else {
          thumb = el('span', 'upload-item-thumb upload-item-thumb-blank');
          thumb.setAttribute('aria-hidden', 'true');
        }
        var main = el('div', 'upload-item-main');
        var name = el('span', 'upload-item-name', item.name);
        var size = el('span', 'upload-item-size muted', formatBytes(item.size));
        var state = el('span', 'upload-item-state');
        var icon = el('span', 'upload-item-icon');
        icon.setAttribute('aria-hidden', 'true');
        var stateLabel = el('span');
        state.appendChild(icon);
        state.appendChild(stateLabel);
        var bar1 = el('progress', 'upload-item-bar');
        bar1.max = 100;
        bar1.setAttribute('aria-label', 'Upload progress for ' + item.name);
        var why = el('p', 'upload-item-reason');
        var actions = el('div', 'upload-item-actions');
        main.appendChild(name);
        main.appendChild(size);
        main.appendChild(state);
        main.appendChild(bar1);
        main.appendChild(why);
        li.appendChild(thumb);
        li.appendChild(main);
        li.appendChild(actions);
        list.appendChild(li);
        row = { li: li, stateLabel: stateLabel, bar: bar1, why: why, actions: actions, lastState: null };
        rows[item.id] = row;
      }
      row.li.className = 'upload-item is-' + item.state;
      row.stateLabel.textContent = stateText(item, role);
      row.bar.hidden = item.state !== 'uploading' && item.state !== 'processing';
      if (item.state === 'processing') {
        row.bar.removeAttribute('value'); // indeterminate while the server works
      } else {
        row.bar.value = item.size ? Math.floor((item.loaded / item.size) * 100) : 0;
      }
      var showWhy = item.state === 'failed' || item.state === 'skipped';
      row.why.hidden = !showWhy;
      row.why.textContent = showWhy ? reason(item) : '';
      if (row.lastState !== item.state) {
        row.lastState = item.state;
        renderActions(item, row);
      }
    }

    function renderActions(item, row) {
      var hadFocus = row.li.contains(doc.activeElement);
      row.actions.textContent = '';
      if (item.state === 'queued' || item.state === 'uploading') {
        row.actions.appendChild(button('Cancel', 'Cancel ' + item.name, function () { queue.cancel(item.id); }));
      }
      if ((item.state === 'failed' || item.state === 'cancelled') && item.retryable) {
        row.actions.appendChild(button('Retry', 'Retry ' + item.name, function () {
          queue.retry(item.id, fields());
          refreshControls();
        }));
      }
      if (item.state === 'failed' || item.state === 'cancelled' || item.state === 'skipped') {
        row.actions.appendChild(button('Remove', 'Remove ' + item.name + ' from the list', function () {
          if (queue.remove(item.id)) {
            row.li.remove();
            delete rows[item.id];
            renderOverall();
          }
        }));
      }
      if (item.state === 'done' && item.result && item.result.photo && item.result.photo.url) {
        var a = el('a', 'btn-sm', 'View');
        a.href = item.result.photo.url;
        a.setAttribute('aria-label', 'View ' + item.name);
        row.actions.appendChild(a);
      }
      // A clicked button may have just disappeared: keep focus in the row.
      if (hadFocus && !row.li.contains(doc.activeElement)) {
        var next = row.actions.querySelector('button, a');
        (next || row.li).focus();
      }
    }

    var overallPending = false;
    function scheduleOverall() {
      if (overallPending) {
        return;
      }
      overallPending = true;
      (window.requestAnimationFrame || setTimeout)(function () {
        overallPending = false;
        renderOverall();
      });
    }

    function renderOverall() {
      var c = queue.counts();
      var p = queue.progress();
      var busy = queue.isBusy();
      queueBox.hidden = c.total === 0;
      if (busy) {
        overall.textContent = overallText(c, p);
        bar.value = p.percent;
        bar.hidden = false;
      } else if (c.queued) {
        overall.textContent = plural(c.queued, 'photo', 'photos') + ' ready to upload.';
        bar.hidden = true;
      } else {
        bar.hidden = !c.done;
        bar.value = 100;
        overall.textContent = c.total ? 'Finished.' : '';
      }
      keepOpen.hidden = !busy;
      if (busy) {
        summaryBox.hidden = true;
      }
      refreshControls();
    }

    function refreshControls() {
      var c = queue.counts();
      var busy = queue.isBusy();
      var retryable = queue.items().filter(function (it) { return it.state === 'failed' && it.retryable; }).length;
      retryAllBtn.hidden = busy || retryable === 0;
      retryAllBtn.textContent = 'Retry ' + plural(retryable, 'failed photo', 'failed photos');
      cancelAllBtn.hidden = !busy;
      clearBtn.hidden = busy || c.total === 0;
      submitBtn.disabled = busy || c.queued === 0;
      if (busy) {
        submitBtn.textContent = 'Uploading...';
      } else if (c.queued > 1) {
        submitBtn.textContent = (role === 'member' ? 'Send ' : 'Upload ') + c.queued + ' photos' +
          (role === 'member' ? ' to parents' : '');
      } else {
        submitBtn.textContent = labelOne;
      }
    }

    function renderSummary(c) {
      if (!c.done && !c.failed && !c.cancelled) {
        summaryBox.hidden = true;
        return;
      }
      var s = summarize(c, role);
      summaryBox.textContent = '';
      summaryBox.className = 'upload-summary upload-summary-' + s.tone;
      summaryBox.appendChild(el('p', 'upload-summary-headline', s.headline + '.'));
      s.lines.forEach(function (line) { summaryBox.appendChild(el('p', '', line)); });
      if (s.link) {
        var a = el('a', 'primary-button', s.link.text);
        a.href = s.link.href;
        summaryBox.appendChild(a);
      }
      summaryBox.hidden = false;
      announce(s.headline + '. ' + s.lines.join(' '));
      summaryBox.focus();
    }

    function addFiles(files) {
      if (!files || !files.length) {
        return;
      }
      summaryBox.hidden = true;
      var added = queue.add(files, fields());
      var bad = added.filter(function (it) { return it.state === 'failed'; }).length;
      var ok = added.length - bad - added.filter(function (it) { return it.state === 'skipped'; }).length;
      renderOverall();
      var msg = plural(ok, 'photo', 'photos') + ' added to the list.';
      if (bad) {
        msg += ' ' + plural(bad, 'file', 'files') + ' cannot be uploaded; the list says why.';
      }
      if (status) {
        status.textContent = msg;
      }
      announce(msg + (queue.isRunning() ? '' : ' Select ' + submitBtn.textContent + ' to start.'));
    }

    input.addEventListener('change', function () {
      addFiles(input.files);
      // Reset so picking the same photos again still fires "change".
      input.value = '';
    });

    if (drop) {
      ['dragenter', 'dragover'].forEach(function (type) {
        drop.addEventListener(type, function (e) {
          e.preventDefault();
          drop.classList.add('is-dragover');
        });
      });
      ['dragleave', 'drop'].forEach(function (type) {
        drop.addEventListener(type, function (e) {
          e.preventDefault();
          drop.classList.remove('is-dragover');
        });
      });
      drop.addEventListener('drop', function (e) {
        addFiles(e.dataTransfer && e.dataTransfer.files);
      });
      // A photo dropped just outside the box must not navigate away and lose the list.
      ['dragover', 'drop'].forEach(function (type) {
        doc.addEventListener(type, function (e) {
          if (e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') !== -1) {
            e.preventDefault();
          }
        });
      });
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (!queue.start(fields())) {
        input.focus();
        return;
      }
      if (status) {
        status.textContent = '';
      }
      var c = queue.counts();
      announce('Uploading ' + plural(c.queued + c.uploading, 'photo', 'photos') + '.');
      renderOverall();
    });

    retryAllBtn.addEventListener('click', function () {
      queue.retryFailed(fields());
      renderOverall();
    });
    cancelAllBtn.addEventListener('click', function () {
      queue.cancelAll();
      renderOverall();
    });
    clearBtn.addEventListener('click', function () {
      queue.clearFinished().forEach(function (it) {
        if (rows[it.id]) {
          rows[it.id].li.remove();
          delete rows[it.id];
        }
      });
      summaryBox.hidden = true;
      if (status) {
        status.textContent = '';
      }
      renderOverall();
      input.focus();
    });

    window.addEventListener('beforeunload', function (e) {
      if (queue.isBusy()) {
        e.preventDefault();
        e.returnValue = '';
      }
    });
  }

  return {
    checkFile: checkFile,
    messageFor: messageFor,
    interpretResponse: interpretResponse,
    createQueue: createQueue,
    summarize: summarize,
    overallText: overallText,
    formatBytes: formatBytes,
    formatEta: formatEta,
    stateText: stateText,
    mount: mount,
    CONCURRENCY: CONCURRENCY,
  };
});
