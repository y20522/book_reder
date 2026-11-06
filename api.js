// API layer: cloud mode (CloudBase HTTP function) or local mode (localStorage).
// Local mode exists so the UI can be previewed without a cloud environment,
// and so device-based progress/bookmarks work even before deployment.
// Cloud mode is used when frontend/config.js has a non-empty API_BASE_URL.
(function () {
  var cfg = window.EBOOK_CONFIG || {};
  var API = (cfg.API_BASE_URL || "").replace(/\/$/, "");
  var deviceId = localStorage.getItem("ebook_device_id");
  if (!deviceId) { deviceId = "dev-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8); localStorage.setItem("ebook_device_id", deviceId); }

  function ls(key, fallback) { try { return JSON.parse(localStorage.getItem(key) || "null") || fallback; } catch (e) { return fallback; } }
  function lsSet(key, val) { localStorage.setItem(key, JSON.stringify(val)); }
  function uid() { return "id-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8); }

  async function cloud(action, data) {
    var res = await fetch(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(Object.assign({ action: action, deviceId: deviceId }, data || {})) });
    var json = await res.json().catch(function () { return {}; });
    if (!res.ok || json.error) throw new Error(json.error || ("cloud error " + res.status));
    return json.data;
  }

  // Local mode: same shapes as the cloud API returns.
  var local = {
    listBooks: function (q) {
      var books = ls("ebook_local_books", []);
      if (q) { var s = q.toLowerCase(); books = books.filter(function (b) { return (b.title + b.author).toLowerCase().indexOf(s) >= 0; }); }
      var comments = ls("ebook_local_comments", []);
      return books.map(function (b) {
        return Object.assign({}, b, {
          commentCount: comments.filter(function (c) { return c.bookId === b._id; }).length,
          bookmarkCount: ls("ebook_local_bookmarks", []).filter(function (x) { return x.bookId === b._id; }).length,
          progress: (ls("ebook_local_progress", []).find(function (p) { return p.bookId === b._id; }) || null)
        });
      });
    },
    getBook: function (bookId) { return ls("ebook_local_books", []).find(function (b) { return b._id === bookId; }) || null; },
    getChapter: function (bookId, chapterIndex) {
      var book = local.getBook(bookId); if (!book) return null;
      var ch = book.chapters[chapterIndex];
      var comments = ls("ebook_local_comments", []).filter(function (c) { return c.bookId === bookId && c.chapterIndex === chapterIndex; });
      var counts = {};
      comments.forEach(function (c) { counts[c.paragraphIndex] = (counts[c.paragraphIndex] || 0) + 1; });
      return { chapter: ch, commentCounts: counts };
    },
    listComments: function (bookId, chapterIndex, paragraphIndex, sort) {
      var list = ls("ebook_local_comments", []).filter(function (c) { return c.bookId === bookId && c.chapterIndex === chapterIndex && c.paragraphIndex === paragraphIndex; });
      var likes = ls("ebook_local_likes", []);
      list = list.map(function (c) { return Object.assign({}, c, { liked: likes.indexOf(c._id) >= 0 }); });
      if (sort === "hot") list.sort(function (a, b) { return b.likes - a.likes; });
      else list.sort(function (a, b) { return b.createdAt - a.createdAt; });
      return list;
    },
    postComment: function (data) {
      var comments = ls("ebook_local_comments", []);
      var c = Object.assign({ _id: uid(), likes: 0, createdAt: Date.now() }, data);
      comments.push(c); lsSet("ebook_local_comments", comments); return c;
    },
    toggleLike: function (commentId) {
      var likes = ls("ebook_local_likes", []);
      var comments = ls("ebook_local_comments", []);
      var c = comments.find(function (x) { return x._id === commentId; }); if (!c) return null;
      var idx = likes.indexOf(commentId);
      if (idx >= 0) { likes.splice(idx, 1); c.likes = Math.max(0, c.likes - 1); }
      else { likes.push(commentId); c.likes += 1; }
      lsSet("ebook_local_likes", likes); lsSet("ebook_local_comments", comments);
      return { liked: idx < 0, likes: c.likes };
    },
    listBookmarks: function (bookId) { return ls("ebook_local_bookmarks", []).filter(function (b) { return b.bookId === bookId; }).sort(function (a, b) { return b.createdAt - a.createdAt; }); },
    addBookmark: function (data) {
      var list = ls("ebook_local_bookmarks", []);
      var exists = list.find(function (b) { return b.bookId === data.bookId && b.chapterIndex === data.chapterIndex && b.paragraphIndex === data.paragraphIndex; });
      if (exists) return exists;
      var b = Object.assign({ _id: uid(), createdAt: Date.now() }, data);
      list.push(b); lsSet("ebook_local_bookmarks", list); return b;
    },
    deleteBookmark: function (id) { lsSet("ebook_local_bookmarks", ls("ebook_local_bookmarks", []).filter(function (b) { return b._id !== id; })); return true; },
    saveProgress: function (data) {
      var list = ls("ebook_local_progress", []);
      var cur = list.find(function (p) { return p.bookId === data.bookId; });
      var val = Object.assign({ deviceId: deviceId, updatedAt: Date.now() }, data);
      if (cur) Object.assign(cur, val); else list.push(val);
      lsSet("ebook_local_progress", list); return val;
    },
    createBook: function (book) {
      var books = ls("ebook_local_books", []);
      var b = Object.assign({ _id: uid(), createdAt: Date.now() }, book);
      books.unshift(b); lsSet("ebook_local_books", books); return b;
    }
  };

  window.EbookAPI = {
    mode: API ? "cloud" : "local",
    deviceId: deviceId,
    listBooks: function (q) { return API ? cloud("listBooks", { q: q }) : Promise.resolve(local.listBooks(q)); },
    getBook: function (id) { return API ? cloud("getBook", { bookId: id }) : Promise.resolve(local.getBook(id)); },
    getChapter: function (id, ci) { return API ? cloud("getChapter", { bookId: id, chapterIndex: ci }) : Promise.resolve(local.getChapter(id, ci)); },
    listComments: function (id, ci, pi, sort) { return API ? cloud("listComments", { bookId: id, chapterIndex: ci, paragraphIndex: pi, sort: sort }) : Promise.resolve(local.listComments(id, ci, pi, sort)); },
    postComment: function (d) { return API ? cloud("postComment", d) : Promise.resolve(local.postComment(d)); },
    toggleLike: function (id) { return API ? cloud("toggleLike", { commentId: id }) : Promise.resolve(local.toggleLike(id)); },
    listBookmarks: function (id) { return API ? cloud("listBookmarks", { bookId: id }) : Promise.resolve(local.listBookmarks(id)); },
    addBookmark: function (d) { return API ? cloud("addBookmark", d) : Promise.resolve(local.addBookmark(d)); },
    deleteBookmark: function (id) { return API ? cloud("deleteBookmark", { bookmarkId: id }) : Promise.resolve(local.deleteBookmark(id)); },
    saveProgress: function (d) { return API ? cloud("saveProgress", d) : Promise.resolve(local.saveProgress(d)); },
    createBook: function (b) { return API ? cloud("createBook", { book: b }) : Promise.resolve(local.createBook(b)); },
    // Upload one EPUB image to object storage; returns { fileID, tempFileURL }.
    // Local mode has no storage, so this is a no-op there and the reader
    // keeps showing the image placeholder note (see app.js renderChapter).
    putBookImage: function (d) { return API ? cloud("putBookImage", d) : Promise.resolve({ fileID: d.imageKey || "", tempFileURL: "" }); }
  };
})();
