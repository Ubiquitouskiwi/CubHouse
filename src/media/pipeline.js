'use strict';

const sharp = require('sharp');

/**
 * Upload sanitization: the single most important privacy control here.
 *
 * A phone photo carries GPS coordinates (the child's home, nursery, school),
 * capture time, device make/model/serial, and sometimes the owner's name.
 * Rather than trying to delete known-bad tags, every upload is DECODED and
 * RE-ENCODED from pixels. Output carries no EXIF, GPS, XMP, IPTC, MakerNotes,
 * or comments, because nothing but pixels is copied across.
 *
 * Steps:
 *   1. Detect the real format from the bytes (magic bytes via libvips). The
 *      browser-declared MIME type and filename are ignored entirely.
 *   2. Enforce a pixel limit before decoding (decompression bombs) and
 *      reject animations / multi-page files.
 *   3. Bake in EXIF orientation (.rotate()), convert to sRGB, strip metadata.
 *   4. Produce three derivatives: thumb (gallery), display (viewer), full
 *      (download only, behind the download permission).
 */

class UploadRejected extends Error {
  constructor(message) {
    super(message);
    this.name = 'UploadRejected';
    this.userMessage = message;
  }
}

const VARIANTS = Object.freeze({
  thumb: { size: 480, quality: 74 },
  display: { size: 1600, quality: 82 },
  full: { size: 4096, quality: 90 },
});

const FORMAT_LABEL = 'JPEG, PNG, WebP, or AVIF';

async function sanitizeImage(input, { maxPixels, allowedFormats }) {
  if (!Buffer.isBuffer(input) || input.length === 0) {
    throw new UploadRejected('Choose an image to upload.');
  }
  const opts = { limitInputPixels: maxPixels, failOn: 'error', sequentialRead: true };
  let meta;
  try {
    meta = await sharp(input, opts).metadata();
  } catch {
    throw new UploadRejected(
      `That file could not be read as a photo. Please use ${FORMAT_LABEL}. ` +
        'On iPhone, choose "Most Compatible" in Settings, Camera, Formats, or share the photo as a JPEG.'
    );
  }
  if (!allowedFormats.includes(meta.format)) {
    throw new UploadRejected(`Photos must be ${FORMAT_LABEL}.`);
  }
  if ((meta.pages || 1) > 1) {
    throw new UploadRejected('Animated or multi-page images are not supported. Please upload a still photo.');
  }
  if (!meta.width || !meta.height || meta.width * meta.height > maxPixels) {
    throw new UploadRejected('That image is too large in dimensions. Please upload a smaller photo.');
  }

  const variants = {};
  let width = null;
  let height = null;
  try {
    for (const [name, spec] of Object.entries(VARIANTS)) {
      // No .withMetadata()/.keepMetadata(): output contains pixels only.
      const { data, info } = await sharp(input, opts)
        .rotate()
        .resize({ width: spec.size, height: spec.size, fit: 'inside', withoutEnlargement: true })
        .toColorspace('srgb')
        .flatten({ background: '#ffffff' })
        .jpeg({ quality: spec.quality, mozjpeg: true })
        .toBuffer({ resolveWithObject: true });
      variants[name] = data;
      if (name === 'full') {
        width = info.width;
        height = info.height;
      }
    }
  } catch {
    throw new UploadRejected('That photo could not be processed. Please try a different file.');
  }
  return { variants, width, height, sourceFormat: meta.format };
}

/** Read back any EXIF/XMP/GPS presence from a buffer (used by tests/tools). */
async function metadataReport(buffer) {
  const meta = await sharp(buffer).metadata();
  return {
    format: meta.format,
    hasExif: Boolean(meta.exif),
    hasXmp: Boolean(meta.xmp),
    hasIptc: Boolean(meta.iptc),
    hasIcc: Boolean(meta.icc),
    width: meta.width,
    height: meta.height,
  };
}

module.exports = { sanitizeImage, metadataReport, UploadRejected, VARIANTS };
