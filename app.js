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
  // 把 EPUB 里的图片转成 data URL，嵌进书里存到本机。
  // 原因：本地模式没有对象存储，imagePath 只是 zip 里的内部路径
  // （如 OEBPS/Images/xxx.jpg），浏览器拿它当网址是打不开的，
  // 所以以前只能显示「［插图：…］」占位。转成 data URL 后就能真显示。
  // 图片先缩到最长边 800px、JPEG 0.78 质量再存：34 卷 18 张原图共 3.7MB，
  // 直接存 base64 会把 localStorage（约 5MB）撑爆，缩完约 1MB 左右才放得下。
  function blobToDataUrl(blob) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader(); r.onload = function () { resolve(r.result); }; r.onerror = reject; r.readAsDataURL(blob);
    });
  }
  async function imageBytesToDataUrl(bytes, path) {
    var ext = extOf(path);
    var mime = ext === ".png" ? "image/png" : ext === ".gif" ? "image/gif" : ext === ".webp" ? "image/webp" : "image/jpeg";
    try {
      var blob = new Blob([bytes], { type: mime });
      var bmp = await createImageBitmap(blob);
      var scale = Math.min(1, 800 / Math.max(bmp.width, bmp.height));
      var w = Math.max(1, Math.round(bmp.width * scale)), h = Math.max(1, Math.round(bmp.height * scale));
      var canvas = document.createElement("canvas"); canvas.width = w; canvas.height = h;
      canvas.getContext("2d").drawImage(bmp, 0, 0, w, h);
      if (typeof bmp.close === "function") bmp.close();
      var outType = mime === "image/png" ? "image/png" : "image/jpeg";
      var out = await new Promise(function (resolve) { canvas.toBlob(resolve, outType, 0.78); });
      if (out) return await blobToDataUrl(out);
    } catch (e) { /* 缩图失败就原样存 */ }
    return "data:" + mime + ";base64," + bytesToBase64(bytes);
  }
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
      var del = document.createElement("button");
      del.className = "book-del"; del.textContent = "✕"; del.setAttribute("aria-label", "删除《" + b.title + "》");
      del.onclick = async function (ev) {
        ev.stopPropagation();
        if (!window.confirm("确定删除《" + b.title + "》吗？它的段评、书签、进度、划线和 AI总结也会一起删掉。")) return;
        await api.deleteBook(b._id);
        await loadShelf();
      };
      card.appendChild(del);
      card.onclick = function () { openBook(b._id); };
      shelf.appendChild(card);
    });
  }
  $("searchInput").addEventListener("input", loadShelf);

  // ---------- 书架导出 / 导入（换设备不用重新传 EPUB） ----------
  // 只支持本地模式：书、段评、书签、进度、点赞都存在本机 localStorage 里，
  // 导出成一个 JSON 文件，自己发到手机上再导入就行。云端模式请走云端同步。
  function lsRead(key, fallback) { try { return JSON.parse(localStorage.getItem(key) || "null") || fallback; } catch (e) { return fallback; } }
  function lsWrite(key, val) { localStorage.setItem(key, JSON.stringify(val)); }
  function exportShelf() {
    if (api.mode !== "local") { alert("云端模式下请用云端同步，导出导入只支持本地模式"); return; }
    var data = {
      version: 1, exportedAt: Date.now(),
      books: lsRead("ebook_local_books", []),
      comments: lsRead("ebook_local_comments", []),
      bookmarks: lsRead("ebook_local_bookmarks", []),
      progress: lsRead("ebook_local_progress", []),
      likes: lsRead("ebook_local_likes", [])
    };
    if (!data.books.length) { alert("书架还是空的，先上传一本书再导出"); return; }
    var blob = new Blob([JSON.stringify(data)], { type: "application/json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = "ebook-shelf-export.json";
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
    alert("已导出 " + data.books.length + " 本书，文件里有书、段评、书签和进度，插图也一起在里面（所以文件会比较大）；发到手机上再点「导入书架」就行。");
  }
  async function importShelfFile(file) {
    if (!file) return;
    if (api.mode !== "local") { alert("云端模式下请用云端同步，导出导入只支持本地模式"); return; }
    try {
      var data = JSON.parse(await file.text());
      if (data && data.title && data.chapters) data = { books: [data] };
      if (!data || !Array.isArray(data.books)) throw new Error("文件里没有书，选一下从本站导出的 ebook-shelf-export.json");
      var books = lsRead("ebook_local_books", []);
      var added = 0, updated = 0;
      data.books.forEach(function (b) {
        if (!b || !b._id || !b.chapters) return;
        var i = books.findIndex(function (x) { return x._id === b._id; });
        if (i >= 0) { books[i] = b; updated++; } else { books.push(b); added++; }
      });
      lsWrite("ebook_local_books", books);
      ["comments", "bookmarks"].forEach(function (kind) {
        var key = "ebook_local_" + kind;
        var cur = lsRead(key, []);
        var ids = {}; cur.forEach(function (x) { if (x && x._id) ids[x._id] = true; });
        (data[kind] || []).forEach(function (x) { if (x && x._id && !ids[x._id]) { cur.push(x); ids[x._id] = true; } });
        lsWrite(key, cur);
      });
      // likes 存的是段评 ID 字符串数组，不是对象，要单独按字符串去重合并。
      var likes = lsRead("ebook_local_likes", []);
      (data.likes || []).forEach(function (id) { if (typeof id === "string" && likes.indexOf(id) < 0) likes.push(id); });
      lsWrite("ebook_local_likes", likes);
      var prog = lsRead("ebook_local_progress", []);
      (data.progress || []).forEach(function (p) {
        if (!p || !p.bookId) return;
        var i = prog.findIndex(function (x) { return x.bookId === p.bookId; });
        if (i >= 0) { if (!prog[i].updatedAt || (p.updatedAt || 0) >= prog[i].updatedAt) prog[i] = p; }
        else prog.push(p);
      });
      lsWrite("ebook_local_progress", prog);
      await loadShelf();
      alert("导入完成：新增 " + added + " 本，更新 " + updated + " 本。现在书架上有 " + books.length + " 本书。");
    } catch (err) {
      alert("导入失败：" + (err && err.message ? err.message : err));
    }
  }
  var exportBtn = $("exportShelfBtn");
  if (exportBtn) exportBtn.onclick = exportShelf;
  var importInput = $("importShelfInput");
  if (importInput) importInput.addEventListener("change", function (e) {
    importShelfFile(e.target.files && e.target.files[0]);
    e.target.value = "";
  });

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
    setChromeHidden(false);
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

  // 手机沉浸阅读（番茄式）：点章节标题、或向下滚时收起上下栏，向上滚 / 点右下角 ☰ 再显示。
  // 段落点开段评的逻辑不变，标题点按只负责显隐菜单。
  var lastScrollY = 0;
  function setChromeHidden(hidden) {
    var rv = $("readerView"); if (!rv) return;
    rv.classList.toggle("chrome-hidden", hidden);
    var t = $("chromeToggleBtn"); if (t) t.classList.toggle("hidden", !hidden);
  }
  var chromeBtn = $("chromeToggleBtn");
  if (chromeBtn) chromeBtn.onclick = function () { setChromeHidden(false); };
  window.addEventListener("scroll", function () {
    if ($("readerView").classList.contains("hidden")) return;
    if (window.innerWidth > 768) return;
    var y = window.scrollY || 0;
    if (y > lastScrollY + 30 && y > 140) setChromeHidden(true);
    else if (y < lastScrollY - 30) setChromeHidden(false);
    lastScrollY = y;
  }, { passive: true });

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
    $("progressText").textContent = "第 " + (state.chapterIndex + 1) + " / " + totalCh + " 章 · 已读 " + pct + "%";
    $("progressBar").style.width = pct + "%";
    var container = $("chapterContent"); container.innerHTML = "";
    var h = document.createElement("h2"); h.textContent = state.chapter.title;
    h.onclick = function () { var rv = $("readerView"); if (rv) setChromeHidden(!rv.classList.contains("chrome-hidden")); };
    container.appendChild(h);
    (state.chapter.blocks || []).forEach(function (block, idx) {
      if (block.kind === "image") {
        var div = document.createElement("div"); div.className = "imgblock"; div.setAttribute("data-para", idx);
        // imageUrl 有值就显示真图（云端是存储地址，本地是上传时嵌进去的 data URL）；
        // 没有才显示占位（比如旧版本传的书、或存储满了被去掉图片的书）。
        if (block.imageUrl) { var im = document.createElement("img"); im.src = block.imageUrl; im.loading = "lazy"; div.appendChild(im); }
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
      // 划线：把本章存过的划线按原文原样包一层 span 画出来。
      var hlList = [];
      try { hlList = JSON.parse(localStorage.getItem("ebook_highlights_v1") || "[]"); } catch (e) { hlList = []; }
      var myHls = hlList.filter(function (h) { return h.book === state.book.title && h.chapter === state.chapter.title && h.para === idx && block.text.indexOf(h.text) >= 0; });
      if (myHls.length) {
        var rest = block.text;
        myHls.forEach(function (h) {
          var at = rest.indexOf(h.text);
          if (at < 0) return;
          if (at > 0) p.appendChild(document.createTextNode(rest.slice(0, at)));
          var sp = document.createElement("span"); sp.className = "hl-" + h.style; sp.textContent = h.text; p.appendChild(sp);
          rest = rest.slice(at + h.text.length);
        });
        if (rest) p.appendChild(document.createTextNode(rest));
      } else {
        p.textContent = block.text;
      }
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
  // 划线改了之后重新渲染本章，把线画上去，滚动位置不动。
  window.addEventListener("ebook:highlights-changed", function () {
    var y = window.scrollY || 0;
    renderChapter().then(function () { window.scrollTo(0, y); });
  });

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
      // Local mode: no object storage, so embed the images as downscaled
      // data URLs (see imageBytesToDataUrl). One failed image never fails
      // the whole upload — that block keeps its placeholder.
      if (api.mode !== "cloud" && parsed.files) {
        var localPaths = (parsed.imagePaths || []).slice();
        if (parsed.coverPath && localPaths.indexOf(parsed.coverPath) < 0) localPaths.push(parsed.coverPath);
        var localImgs = {};
        for (var li = 0; li < localPaths.length; li++) {
          var lp = localPaths[li]; var lb = parsed.files[lp];
          if (!lb) continue;
          try { localImgs[lp] = await imageBytesToDataUrl(lb, lp); } catch (e) { /* keep placeholder */ }
        }
        book.chapters.forEach(function (ch) {
          ch.blocks.forEach(function (b) {
            if (b.kind === "image" && localImgs[b.imagePath]) b.imageUrl = localImgs[b.imagePath];
          });
        });
        if (parsed.coverPath && localImgs[parsed.coverPath]) book.coverUrl = localImgs[parsed.coverPath];
      }
      var created;
      try {
        created = await api.createBook(book);
      } catch (err2) {
        // 本机存储满了（localStorage 约 5MB）：去掉图片再存一次，
        // 至少文字和章节能留下来，图片恢复成占位。
        if (err2 && (err2.name === "QuotaExceededError" || err2.code === 22)) {
          book.chapters.forEach(function (ch) { ch.blocks.forEach(function (b) { if (b.kind === "image") delete b.imageUrl; }); });
          delete book.coverUrl;
          created = await api.createBook(book);
          alert("书已上传，但本机存储不够，图片没能存下来，只显示占位。可以先删一本旧书再重新上传。");
          await loadShelf();
          if (created && created._id) openBook(created._id);
          e.target.value = "";
          return;
        }
        throw err2;
      }
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
