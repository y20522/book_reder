// 电子书站前端主逻辑：书架 / 阅读器 / 段评 / 书签 / 自动进度 / 上传。
// 自动进度与书签是分开的：进度不点书签也会实时保存；书签是手动多条标记。
(function () {
  var api = window.EbookAPI;
  var $ = function (id) { return document.getElementById(id); };
  var state = { books: [], book: null, chapterIndex: 0, chapter: null, commentCounts: {}, commentTarget: null, commentSort: "hot", settings: JSON.parse(localStorage.getItem("ebook_settings") || '{"fontSize":17,"lineHeight":1.9,"theme":"paper"}') };
  var saveTimer = null;

  function applySettings() {
    document.body.setAttribute("data-theme", state.settings.theme);
    document.documentElement.style.fontSize = state.settings.fontSize + "px";
    $("fontSizeLabel").textContent = state.settings.fontSize + "px";
    $("lineHeightLabel").textContent = state.settings.lineHeight.toFixed(1);
    var reader = $("chapterContent"); if (reader) reader.style.lineHeight = state.settings.lineHeight;
    localStorage.setItem("ebook_settings", JSON.stringify(state.settings));
  }
  function esc(s) { return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
  function bytesToBase64(bytes) {
    var s = ""; var CHUNK = 8192;
    for (var i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    return btoa(s);
  }
  function extOf(path) { var m = /(\.[A-Za-z0-9]+)$/.exec(path || ""); return m ? m[1].toLowerCase() : ""; }
  function openModal(id) { $(id).classList.add("open"); }
  function closeModal(id) { $(id).classList.remove("open"); }
  document.querySelectorAll(".modal").forEach(function (m) { m.addEventListener("click", function (e) { if (e.target === m) m.classList.remove("open"); }); });

  // ---------- shelf ----------
  async function loadShelf() {
    var q = $("searchInput").value.trim();
    state.books = await api.listBooks(q);
    $("modeHint").textContent = api.mode === "cloud" ? "云端模式" : "本地预览模式（未配置云函数地址）";
    var shelf = $("shelf"); shelf.innerHTML = "";
    $("emptyHint").classList.toggle("hidden", state.books.length > 0);
    state.books.forEach(function (b) {
      var card = document.createElement("div"); card.className = "bookcard";
      var prog = b.progress;
      var pct = prog ? Math.round(prog.percent || 0) : 0;
      card.innerHTML = (b.coverUrl ? '<img src="' + esc(b.coverUrl) + '" alt="">' : "") +
        "<h3>" + esc(b.title) + "</h3><p>" + esc(b.author || "") + "</p>" +
        "<p>共 " + (b.chapterCount || (b.chapters ? b.chapters.length : 0)) + " 章 · " + (b.commentCount || 0) + " 条段评 · " + (b.bookmarkCount || 0) + " 个书签</p>" +
        (prog ? "<p>读到第 " + (prog.chapterIndex + 1) + " 章 · 已读 " + pct + "%</p><div class='progressbar'><i style='width:" + pct + "%'></i></div>" : "");
      card.onclick = function () { openBook(b._id); };
      shelf.appendChild(card);
    });
  }
  $("searchInput").addEventListener("input", loadShelf);

  // ---------- reader ----------
  async function openBook(bookId) {
    var book = await api.getBook(bookId);
    if (!book) return;
    state.book = book;
    // Resume: prefer saved progress paragraph, else chapter 0.
    var prog = book.progress || null;
    state.chapterIndex = prog ? prog.chapterIndex : 0;
    $("shelfView").classList.add("hidden");
    $("readerView").classList.remove("hidden");
    $("bookTitle").textContent = book.title;
    await renderChapter();
    if (prog && prog.paragraphIndex) {
      setTimeout(function () {
        var el = document.querySelector('[data-para="' + prog.paragraphIndex + '"]');
        if (el) el.scrollIntoView({ block: "start" });
      }, 100);
    }
    refreshBookmarks();
  }
  $("backBtn").onclick = function () { $("readerView").classList.add("hidden"); $("shelfView").classList.remove("hidden"); loadShelf(); };

  async function renderChapter() {
    var data = await api.getChapter(state.book._id, state.chapterIndex);
    if (!data) return;
    state.chapter = data.chapter; state.commentCounts = data.commentCounts || {};
    var totalCh = state.book.chapters ? state.book.chapters.length : (state.book.chapterCount || 1);
    var totalParas = 0, doneParas = 0;
    // Percent is computed from chapter + paragraph position inside the book.
    var book = state.book;
    if (book.chapters) {
      book.chapters.forEach(function (ch, ci) {
        var n = ch.blocks ? ch.blocks.length : 0; totalParas += n;
        if (ci < state.chapterIndex) doneParas += n;
      });
    }
    var curParas = state.chapter.blocks ? state.chapter.blocks.length : 0;
    var pct = totalParas ? Math.round(((doneParas + Math.min(1, curParas ? 1 : 0)) / totalParas) * 100) : 0;
    $("progressText").textContent = "第 " + (state.chapterIndex + 1) + " / " + totalCh + " 章";
    $("progressBar").style.width = pct + "%";
    var container = $("chapterContent"); container.innerHTML = "";
    var h = document.createElement("h2"); h.textContent = state.chapter.title; container.appendChild(h);
    (state.chapter.blocks || []).forEach(function (block, idx) {
      if (block.kind === "image") {
        var div = document.createElement("div"); div.className = "imgblock"; div.setAttribute("data-para", idx);
        // Local mode: imagePath is a zip path, not a URL, so show a placeholder note.
        // Cloud mode: the server returns imageUrl for stored images.
        if (block.imageUrl) { var im = document.createElement("img"); im.src = block.imageUrl; div.appendChild(im); }
        else { var note = document.createElement("p"); note.style.color = "var(--dim)"; note.textContent = "［插图：" + (block.imagePath || "图片") + "］"; div.appendChild(note); }
        var cnt = state.commentCounts[idx] || 0;
        if (cnt) { var b = document.createElement("span"); b.className = "bubble"; b.textContent = cnt; div.appendChild(b); }
        div.onclick = function () { if (window.getSelection && window.getSelection().toString().trim().length > 1) return; openComments(idx); };
        container.appendChild(div); return;
      }
      if (block.kind === "heading") { var hh = document.createElement("h3"); hh.textContent = block.text; container.appendChild(hh); return; }
      var p = document.createElement("p"); p.className = "para"; p.setAttribute("data-para", idx);
      var cnt2 = state.commentCounts[idx] || 0;
      if (cnt2) p.classList.add("has-comments");
      p.textContent = block.text;
      if (cnt2) { var bb = document.createElement("span"); bb.className = "bubble"; bb.textContent = cnt2; p.appendChild(bb); }
      p.onclick = function () { if (window.getSelection && window.getSelection().toString().trim().length > 1) return; openComments(idx); };
      container.appendChild(p);
    });
    // Prev / next chapter buttons
    var nav = document.createElement("div"); nav.className = "row"; nav.style.marginTop = "24px";
    if (state.chapterIndex > 0) { var prev = document.createElement("button"); prev.className = "btn"; prev.textContent = "上一章"; prev.onclick = function () { gotoChapter(state.chapterIndex - 1); }; nav.appendChild(prev); }
    if (state.chapterIndex < totalCh - 1) { var next = document.createElement("button"); next.className = "btn primary"; next.textContent = "下一章"; next.onclick = function () { gotoChapter(state.chapterIndex + 1); }; nav.appendChild(next); }
    container.appendChild(nav);
    saveProgressNow();
  }
  function gotoChapter(ci) { state.chapterIndex = ci; window.scrollTo(0, 0); renderChapter(); }

  // Automatic real-time progress: scroll (throttled) + pagehide/visibilitychange.
  function currentParaIndex() {
    var els = document.querySelectorAll("[data-para]");
    var best = 0;
    els.forEach(function (el) {
      var r = el.getBoundingClientRect();
      if (r.top <= 120) best = parseInt(el.getAttribute("data-para"), 10);
    });
    return best;
  }
  function saveProgressNow() {
    if (!state.book || !state.chapter) return;
    var total = state.book.chapters ? state.book.chapters.reduce(function (a, c) { return a + (c.blocks ? c.blocks.length : 0); }, 0) : 0;
    var done = 0;
    if (state.book.chapters) state.book.chapters.forEach(function (ch, ci) { if (ci < state.chapterIndex) done += ch.blocks ? ch.blocks.length : 0; });
    var pct = total ? Math.round(((done + currentParaIndex() + 1) / total) * 100) : 0;
    api.saveProgress({ bookId: state.book._id, chapterIndex: state.chapterIndex, paragraphIndex: currentParaIndex(), percent: pct }).catch(function () {});
  }
  window.addEventListener("scroll", function () {
    if (!state.book) return;
    clearTimeout(saveTimer); saveTimer = setTimeout(saveProgressNow, 500);
  }, { passive: true });
  window.addEventListener("pagehide", saveProgressNow);
  document.addEventListener("visibilitychange", function () { if (document.hidden) saveProgressNow(); });

  // ---------- comments ----------
  async function openComments(paraIndex) {
    state.commentTarget = paraIndex;
    await refreshComments();
    openModal("commentModal");
  }
  async function refreshComments() {
    var list = await api.listComments(state.book._id, state.chapterIndex, state.commentTarget, state.commentSort);
    var box = $("commentList"); box.innerHTML = "";
    if (!list.length) box.innerHTML = "<p style='color:var(--dim)'>还没有段评，来写第一条吧。</p>";
    list.forEach(function (c) {
      var div = document.createElement("div"); div.className = "comment";
      div.innerHTML = "<div class='meta'>" + esc(c.nickname || "读者") + " · " + new Date(c.createdAt).toLocaleString() + "</div><div>" + esc(c.content) + "</div>";
      var like = document.createElement("button"); like.className = "btn"; like.textContent = (c.liked ? "♥ " : "♡ ") + (c.likes || 0);
      like.onclick = async function () { await api.toggleLike(c._id); refreshComments(); loadShelf(); };
      div.appendChild(like); box.appendChild(div);
    });
  }
  document.querySelectorAll("[data-sort]").forEach(function (btn) {
    btn.onclick = function () { state.commentSort = btn.getAttribute("data-sort"); refreshComments(); };
  });
  $("closeCommentBtn").onclick = function () { closeModal("commentModal"); };
  $("postCommentBtn").onclick = async function () {
    var content = $("commentInput").value.trim(); if (!content || state.commentTarget === null) return;
    await api.postComment({ bookId: state.book._id, chapterIndex: state.chapterIndex, paragraphIndex: state.commentTarget, nickname: $("nicknameInput").value.trim() || "读者", content: content });
    $("commentInput").value = "";
    await refreshComments(); await renderChapter();
  };
  $("commentsBtn").onclick = function () {
    // Open comments for the current paragraph (top of viewport).
    openComments(currentParaIndex());
  };

  // ---------- TOC ----------
  $("tocBtn").onclick = async function () {
    var book = state.book; var list = $("tocList"); list.innerHTML = "";
    (book.chapters || []).forEach(function (ch, ci) {
      var item = document.createElement("div"); item.className = "listitem"; item.textContent = ch.title;
      item.onclick = function () { closeModal("tocModal"); gotoChapter(ci); };
      list.appendChild(item);
    });
    openModal("tocModal");
  };
  $("closeTocBtn").onclick = function () { closeModal("tocModal"); };

  // ---------- bookmarks (multiple) ----------
  async function refreshBookmarks() {
    if (!state.book) return;
    var list = await api.listBookmarks(state.book._id);
    $("bookmarkCount").textContent = list.length ? list.length : "";
    var box = $("bookmarkList"); box.innerHTML = "";
    if (!list.length) box.innerHTML = "<p style='color:var(--dim)'>还没有书签，点下方「添加书签」可以存多个。</p>";
    list.forEach(function (b) {
      var item = document.createElement("div"); item.className = "listitem";
      item.innerHTML = "<div>第 " + (b.chapterIndex + 1) + " 章 · 第 " + (b.paragraphIndex + 1) + " 段</div><small>" + esc(b.excerpt || "") + " · " + new Date(b.createdAt).toLocaleString() + "</small>";
      item.onclick = async function () {
        closeModal("bookmarkModal");
        if (b.chapterIndex !== state.chapterIndex) { state.chapterIndex = b.chapterIndex; await renderChapter(); }
        setTimeout(function () { var el = document.querySelector('[data-para="' + b.paragraphIndex + '"]'); if (el) el.scrollIntoView({ block: "start" }); }, 100);
      };
      var del = document.createElement("button"); del.className = "btn"; del.textContent = "删除";
      del.onclick = async function (e) { e.stopPropagation(); await api.deleteBookmark(b._id); refreshBookmarks(); };
      item.appendChild(del); box.appendChild(item);
    });
  }
  $("bookmarkListBtn").onclick = async function () { await refreshBookmarks(); openModal("bookmarkModal"); };
  $("closeBookmarkBtn").onclick = function () { closeModal("bookmarkModal"); };
  $("addBookmarkBtn").onclick = async function () {
    if (!state.book || !state.chapter) return;
    var pi = currentParaIndex();
    var block = state.chapter.blocks[pi];
    var excerpt = block ? (block.text || "插图").slice(0, 40) : "";
    await api.addBookmark({ bookId: state.book._id, chapterIndex: state.chapterIndex, paragraphIndex: pi, excerpt: excerpt });
    await refreshBookmarks();
    alert("书签已添加：第 " + (state.chapterIndex + 1) + " 章 · 第 " + (pi + 1) + " 段");
  };

  // ---------- settings ----------
  $("settingsBtn").onclick = function () { applySettings(); openModal("settingsModal"); };
  $("closeSettingsBtn").onclick = function () { closeModal("settingsModal"); };
  $("fontMinus").onclick = function () { state.settings.fontSize = Math.max(13, state.settings.fontSize - 1); applySettings(); };
  $("fontPlus").onclick = function () { state.settings.fontSize = Math.min(24, state.settings.fontSize + 1); applySettings(); };
  $("lineMinus").onclick = function () { state.settings.lineHeight = Math.max(1.4, +(state.settings.lineHeight - 0.1).toFixed(1)); applySettings(); };
  $("linePlus").onclick = function () { state.settings.lineHeight = Math.min(2.6, +(state.settings.lineHeight + 0.1).toFixed(1)); applySettings(); };
  document.querySelectorAll("[data-theme]").forEach(function (btn) {
    btn.onclick = function () { state.settings.theme = btn.getAttribute("data-theme"); applySettings(); };
  });

  // ---------- upload (free, no password) ----------
  $("fileInput").addEventListener("change", async function (e) {
    var file = e.target.files[0]; if (!file) return;
    try {
      var parsed;
      if (/\.epub$/i.test(file.name)) {
        var buf = await file.arrayBuffer();
        parsed = await window.EpubParser.parseEpub(buf);
      } else {
        var text = await file.text();
        parsed = window.EpubParser.parseTxt(text);
        parsed.title = file.name.replace(/\.(txt|epub)$/i, "");
      }
      var book = {
        title: parsed.title, author: parsed.author || "", intro: parsed.intro || "",
        chapters: parsed.chapters.map(function (ch) { return { title: ch.title, blocks: ch.blocks }; }),
        chapterCount: parsed.chapters.length
      };
      // Cloud mode: upload the EPUB's images to object storage BEFORE
      // createBook, so each image block can carry its storage fileID
      // (imageFileId) and the reader shows the real image instead of the
      // placeholder note. The book id is generated here so images can be
      // stored under books/<bookId>/images/. One failed image never fails
      // the whole book upload — that block keeps its placeholder.
      // Local mode: no storage, so imagePath is kept for reference only.
      if (api.mode === "cloud" && parsed.files) {
        var bookId = "book-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
        book._id = bookId;
        var paths = (parsed.imagePaths || []).slice();
        if (parsed.coverPath && paths.indexOf(parsed.coverPath) < 0) paths.push(parsed.coverPath);
        var uploaded = {};
        for (var ii = 0; ii < paths.length; ii++) {
          var pth = paths[ii];
          var bytes = parsed.files[pth];
          if (!bytes) continue;
          try {
            var up = await api.putBookImage({ bookId: bookId, imageKey: "books/" + bookId + "/images/" + ii + extOf(pth), imageBase64: bytesToBase64(bytes) });
            if (up && up.fileID) uploaded[pth] = up;
          } catch (e) { /* keep placeholder for this image */ }
        }
        book.chapters.forEach(function (ch) {
          ch.blocks.forEach(function (b) {
            if (b.kind === "image" && uploaded[b.imagePath]) {
              b.imageFileId = uploaded[b.imagePath].fileID;
              if (uploaded[b.imagePath].tempFileURL) b.imageUrl = uploaded[b.imagePath].tempFileURL;
            }
          });
        });
        if (parsed.coverPath && uploaded[parsed.coverPath]) {
          book.coverFileId = uploaded[parsed.coverPath].fileID;
          if (uploaded[parsed.coverPath].tempFileURL) book.coverUrl = uploaded[parsed.coverPath].tempFileURL;
        }
      }
      var created = await api.createBook(book);
      alert("上传成功：《" + book.title + "》共 " + book.chapters.length + " 章");
      await loadShelf();
      if (created && created._id) openBook(created._id);
    } catch (err) {
      alert("上传失败：" + (err && err.message ? err.message : err));
    }
    e.target.value = "";
  });

  applySettings();
  loadShelf();
})();
