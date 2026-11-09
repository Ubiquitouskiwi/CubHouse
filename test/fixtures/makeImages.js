'use strict';

const sharp = require('sharp');

/**
 * Test image factories. Everything is generated in memory so the repo holds no
 * photos. `jpegWithGps` mimics a phone photo: GPS coordinates, device make,
 * model and serial number, and the owner's name in EXIF.
 */

async function plainJpeg({ width = 640, height = 480, color = '#3a6b5f' } = {}) {
  return sharp({ create: { width, height, channels: 3, background: color } }).jpeg().toBuffer();
}

async function plainPng({ width = 320, height = 240, color = '#8a5a44' } = {}) {
  return sharp({ create: { width, height, channels: 4, background: color } }).png().toBuffer();
}

async function jpegWithGps() {
  return sharp({ create: { width: 800, height: 600, channels: 3, background: '#4a5a8a' } })
    .withExif({
      IFD0: {
        Make: 'PhoneCo',
        Model: 'Pocket 15 Pro',
        Artist: 'Parent Fullname',
        ImageDescription: 'At home on Elm Street',
      },
      IFD2: { BodySerialNumber: 'SN-1234567890' },
      IFD3: {
        GPSLatitudeRef: 'N',
        GPSLatitude: '40/1 26/1 46/1',
        GPSLongitudeRef: 'W',
        GPSLongitude: '79/1 58/1 56/1',
      },
    })
    .jpeg()
    .toBuffer();
}

module.exports = { plainJpeg, plainPng, jpegWithGps };
