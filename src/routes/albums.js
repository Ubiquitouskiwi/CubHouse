'use strict';

const { createRouter } = require('../security/asyncRouter');
const { requireAuth } = require('../auth');
const { canViewPhoto, photoCapabilities } = require('../permissions');
const { safeReturnPath } = require('../security/sessionGuard');
const { str } = require('../validation');

/**
 * Albums: each user's PERSONAL collections. Albums never change who can see
 * or download a photo. A user can only add a photo they can already view and
 * only touch their own albums; photos that leave their audience drop out of
 * the album at read time.
 */
module.exports = function albumRoutes(ctx) {
  const { store } = ctx;
  const router = createRouter();

  function viewerFrom(user) {
    return { role: user.role, id: user.id, groupIds: user.groupIds || [] };
  }

  async function ownAlbum(req) {
    const album = await store.findAlbumById(req.params.id);
    return album && album.ownerId === req.user.id ? album : null;
  }

  router.get('/albums', requireAuth, async (req, res) => {
    const albums = await store.listAlbumsByOwner(req.user.id);
    res.render('albums', {
      title: 'Albums',
      user: req.user,
      albums: albums.map((a) => ({ id: a.id, name: a.name, photoCount: a.photoIds.length })),
    });
  });

  router.post('/albums', requireAuth, async (req, res) => {
    const name = str(req.body.name, { field: 'name', max: 200 });
    if (!name) {
      req.flash('error', 'Give your album a name.');
      return res.redirect('/albums');
    }
    if (name.length > 80) {
      req.flash('error', 'Album name must be 80 characters or fewer.');
      return res.redirect('/albums');
    }
    await store.createAlbum({ ownerId: req.user.id, name });
    req.flash('success', `Album "${name}" created.`);
    return res.redirect('/albums');
  });

  router.get('/albums/:id', requireAuth, async (req, res) => {
    const viewer = viewerFrom(req.user);
    const album = await ownAlbum(req);
    if (!album) {
      return res.status(404).render('error', { title: 'Not Found', message: 'That album could not be found.' });
    }
    const resolved = await Promise.all(album.photoIds.map((pid) => store.findPhotoById(pid)));
    res.render('album', {
      title: album.name,
      user: req.user,
      viewer,
      album,
      photos: resolved.filter((p) => p && canViewPhoto(viewer, p)),
      capFor: (photo) => photoCapabilities(viewer, photo),
    });
  });

  router.post('/albums/:id/add', requireAuth, async (req, res) => {
    const viewer = viewerFrom(req.user);
    const album = await ownAlbum(req);
    if (!album) {
      req.flash('error', 'That album could not be found.');
      return res.redirect('/albums');
    }
    const photoId = str(req.body.photoId, { field: 'photoId' });
    const photo = await store.findPhotoById(photoId);
    if (!photo || !canViewPhoto(viewer, photo)) {
      req.flash('error', 'You cannot add that photo.');
      return res.redirect(`/albums/${album.id}`);
    }
    await store.addPhotoToAlbum(album.id, photoId);
    req.flash('success', 'Added to album.');
    return res.redirect(safeReturnPath(req, `/albums/${album.id}`));
  });

  router.post('/albums/:id/remove', requireAuth, async (req, res) => {
    const album = await ownAlbum(req);
    if (!album) {
      req.flash('error', 'That album could not be found.');
      return res.redirect('/albums');
    }
    await store.removePhotoFromAlbum(album.id, str(req.body.photoId, { field: 'photoId' }));
    req.flash('success', 'Removed from album.');
    return res.redirect(`/albums/${album.id}`);
  });

  router.post('/albums/:id/delete', requireAuth, async (req, res) => {
    const album = await ownAlbum(req);
    if (!album) {
      req.flash('error', 'That album could not be found.');
      return res.redirect('/albums');
    }
    await store.deleteAlbum(album.id);
    req.flash('success', 'Album deleted.');
    return res.redirect('/albums');
  });

  return router;
};
