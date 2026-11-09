'use strict';

/*
 * Photo upload helper. The form posts the file as multipart/form-data; the
 * server re-encodes it and strips all metadata (location, device, names), so
 * this script only gives quick feedback and a local preview. The preview uses
 * an object URL, which never leaves the browser.
 */
(function () {
  var MAX_BYTES = 15 * 1024 * 1024;

  var form = document.querySelector('[data-upload-form]');
  if (!form) {
    return;
  }
  var fileInput = form.querySelector('[data-upload-input]');
  var submitBtn = form.querySelector('[data-upload-submit]');
  var preview = form.querySelector('[data-upload-preview]');
  var previewImg = form.querySelector('[data-upload-preview-img]');
  var hint = form.querySelector('.upload-hint');
  if (!fileInput || !submitBtn) {
    return;
  }
  var defaultHint = hint ? hint.textContent : '';
  var currentUrl = null;

  function setHint(message, isError) {
    if (hint) {
      hint.textContent = message;
      hint.classList.toggle('upload-hint-error', Boolean(isError));
    }
  }

  fileInput.addEventListener('change', function () {
    submitBtn.disabled = true;
    if (currentUrl) {
      URL.revokeObjectURL(currentUrl);
      currentUrl = null;
    }
    if (preview) {
      preview.hidden = true;
    }
    var file = fileInput.files && fileInput.files[0];
    if (!file) {
      setHint(defaultHint, false);
      return;
    }
    if (file.size > MAX_BYTES) {
      setHint('That photo is larger than 15 MB. Please choose a smaller one.', true);
      fileInput.value = '';
      return;
    }
    if (previewImg && /^image\/(jpeg|png|webp)$/.test(file.type)) {
      currentUrl = URL.createObjectURL(file);
      previewImg.src = currentUrl;
      preview.hidden = false;
    }
    submitBtn.disabled = false;
    setHint('Ready. Location and camera details are removed when you upload.', false);
  });
})();
