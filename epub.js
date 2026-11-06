// EPUB / TXT parsing for the browser.
// Rules (same as functions/lib/epubParser.js):
//  - EPUB2: NCX navMap. EPUB3: nav document.
//  - Multiple TOC entries pointing to one file with different #anchors
//    are split inside that file at the anchor positions.
//  - Text is taken from <p>, and also from <br>-separated text when a
//    book has no <p> at all (e.g. <div class="chaptercontent"> ... <br><br> ...).
//  - Standalone pure-number segments (page numbers like "001") are dropped.
//  - Images keep their original document order (interleaved, not moved to chapter end).
(function () {
  function isPureNumber(s) { return /^\d+$/.test((s || "").trim()); }
  function cleanText(s) {
    return (s || "").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").trim();
  }
  function normalizePath(baseDir, href) {
    var hrefNoHash = href.split("#")[0];
    var parts = (baseDir ? baseDir + "/" : "") + hrefNoHash;
    var out = [];
    parts.split("/").forEach(function (p) {
      if (!p || p === ".") return;
      if (p === "..") out.pop(); else out.push(p);
    });
    return out.join("/");
  }
  function dirOf(path) { var i = path.lastIndexOf("/"); return i < 0 ? "" : path.slice(0, i); }

  // ---- minimal ZIP reader (stored + deflate) ----
  async function readZip(buf) {
    var view = new DataView(buf);
    var eocd = -1;
    for (var i = buf.byteLength - 22; i >= 0; i--) {
      if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("not a zip file");
    var total = view.getUint16(eocd + 10, true);
    var cdOff = view.getUint32(eocd + 16, true);
    var files = {};
    var p = cdOff;
    for (var n = 0; n < total; n++) {
      if (view.getUint32(p, true) !== 0x02014b50) break;
      var method = view.getUint16(p + 10, true);
      var compSize = view.getUint32(p + 20, true);
      var nameLen = view.getUint16(p + 28, true);
      var extraLen = view.getUint16(p + 30, true);
      var commentLen = view.getUint16(p + 32, true);
      var localOff = view.getUint32(p + 42, true);
      var name = new TextDecoder().decode(new Uint8Array(buf, p + 46, nameLen));
      var lp = localOff;
      var lNameLen = view.getUint16(lp + 26, true);
      var lExtraLen = view.getUint16(lp + 28, true);
      var dataStart = lp + 30 + lNameLen + lExtraLen;
      var raw = new Uint8Array(buf, dataStart, compSize);
      var data;
      if (method === 0) data = raw;
      else if (method === 8) {
        var stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
        data = new Uint8Array(await new Response(stream).arrayBuffer());
      } else throw new Error("unsupported zip method " + method);
      files[name] = data;
      p += 46 + nameLen + extraLen + commentLen;
    }
    return files;
  }
  function textOf(files, name) {
    if (!files[name]) return "";
    return new TextDecoder().decode(files[name]);
  }
  function splitByBr(html) {
    // Split on two or more <br> in a row; single <br> inside a paragraph is kept as space.
    return html.split(/(?:<br\s*\/?>\s*){2,}/i).map(cleanText).filter(function (t) { return t && !isPureNumber(t); });
  }

  // Walk a parsed HTML document in order, emitting blocks without double counting.
  function blocksFromDocument(doc, chapterDir, files) {
    var blocks = [];
    function pushText(t) { t = (t || "").trim(); if (t && !isPureNumber(t)) blocks.push({ kind: "text", text: t }); }
    function pushImage(src) {
      if (!src) return;
      var path = normalizePath(chapterDir, src);
      blocks.push({ kind: "image", imagePath: path });
    }
    function walk(node) {
      if (node.nodeType === 3) { pushText(node.textContent); return; }
      if (node.nodeType !== 1) return;
      var tag = node.tagName.toLowerCase();
      var cls = (node.getAttribute("class") || "");
      if (/^h[1-3]$/.test(tag)) { pushText(node.textContent); return; }
      if (tag === "p") { pushText(node.textContent); return; }
      if (tag === "img") { pushImage(node.getAttribute("src")); return; }
      if (tag === "div" && cls.indexOf("divimage") >= 0) {
        var img = node.querySelector("img"); if (img) pushImage(img.getAttribute("src")); return;
      }
      if (tag === "div" && cls.indexOf("chaptercontent") >= 0) {
        splitByBr(node.innerHTML).forEach(pushText);
        // Images inside chaptercontent (illustration chapter) still count, in order after text.
        node.querySelectorAll("img").forEach(function (im) { pushImage(im.getAttribute("src")); });
        return;
      }
      // Generic container: recurse, but skip nav / head / style / script.
      if (tag === "nav" || tag === "head" || tag === "style" || tag === "script") return;
      Array.prototype.forEach.call(node.childNodes, walk);
    }
    var body = doc.body || doc.documentElement;
    if (body) walk(body);
    return blocks;
  }

  function parseNavToc(navHtml) {
    var doc = new DOMParser().parseFromString(navHtml, "text/html");
    var links = [];
    var nav = doc.querySelector('nav[epub\\:type="toc"], nav');
    var anchors = (nav || doc).querySelectorAll("a[href]");
    anchors.forEach(function (a) {
      var href = a.getAttribute("href");
      var title = (a.textContent || "").trim();
      if (href && title && title !== "目录") links.push({ href: href, title: title });
    });
    return links;
  }
  function parseNcx(ncxXml) {
    var doc = new DOMParser().parseFromString(ncxXml, "text/xml");
    var out = [];
    doc.querySelectorAll("navPoint").forEach(function (np) {
      var label = np.querySelector("navLabel text");
      var content = np.querySelector("content");
      if (label && content) out.push({ href: content.getAttribute("src"), title: (label.textContent || "").trim() });
    });
    return out;
  }

  async function parseEpub(arrayBuffer) {
    var files = await readZip(arrayBuffer);
    var container = textOf(files, "META-INF/container.xml");
    var opfMatch = container.match(/full-path="([^"]+)"/);
    if (!opfMatch) throw new Error("EPUB container has no rootfile");
    var opfPath = opfMatch[1];
    var opfDir = dirOf(opfPath);
    var opf = textOf(files, opfPath);
    function meta(tag) { var m = opf.match(new RegExp("<dc:" + tag + "[^>]*>([^<]+)</dc:" + tag + ">")); return m ? m[1].trim() : ""; }
    var title = meta("title") || "未命名";
    var author = meta("creator") || "";
    var desc = meta("description") || "";
    // Manifest: id -> href / media-type / properties
    var manifest = {};
    var itemRe = /<item[^>]+>/g, im;
    while ((im = itemRe.exec(opf))) {
      var id = (im[0].match(/id="([^"]+)"/) || [])[1];
      var href = (im[0].match(/href="([^"]+)"/) || [])[1];
      var type = (im[0].match(/media-type="([^"]+)"/) || [])[1] || "";
      var props = (im[0].match(/properties="([^"]+)"/) || [])[1] || "";
      if (id && href) manifest[id] = { href: href, type: type, props: props, path: normalizePath(opfDir, href) };
    }
    var coverPath = "";
    var coverMeta = opf.match(/<meta[^>]+name="cover"[^>]+content="([^"]+)"/);
    if (coverMeta && manifest[coverMeta[1]]) coverPath = manifest[coverMeta[1]].path;
    // TOC
    // TOC hrefs are relative to the TOC file itself (nav / NCX), NOT to the OPF.
    // E.g. nav at OEBPS/Text/nav.xhtml linking to "Volume_0.xhtml" means
    // OEBPS/Text/Volume_0.xhtml, not OEBPS/Volume_0.xhtml.
    var toc = [];
    var tocDir = opfDir;
    var navItem = Object.values(manifest).find(function (x) { return x.props.indexOf("nav") >= 0; });
    if (navItem) { toc = parseNavToc(textOf(files, navItem.path)); tocDir = dirOf(navItem.path); }
    if (!toc.length) {
      var ncxItem = Object.values(manifest).find(function (x) { return x.type === "application/x-dtbncx+xml"; });
      if (ncxItem) { toc = parseNcx(textOf(files, ncxItem.path)); tocDir = dirOf(ncxItem.path); }
    }
    if (!toc.length) {
      // Fallback: spine order, one chapter per spine file.
      // Manifest hrefs ARE relative to the OPF, so reset tocDir.
      tocDir = opfDir;
      var spineRe = /idref="([^"]+)"/g, sm;
      while ((sm = spineRe.exec(opf))) {
        var it = manifest[sm[1]];
        if (it && it.type === "application/xhtml+xml") toc.push({ href: it.href, title: title });
      }
    }
    // Group TOC entries by file, split single files at anchors.
    var chapters = [];
    var byFile = {};
    toc.forEach(function (entry) {
      var parts = entry.href.split("#");
      var filePath = normalizePath(tocDir, parts[0]);
      var anchor = parts[1] || "";
      (byFile[filePath] = byFile[filePath] || []).push({ title: entry.title, anchor: anchor });
    });
    Object.keys(byFile).forEach(function (filePath) {
      var entries = byFile[filePath];
      var html = textOf(files, filePath);
      var chapterDir = dirOf(filePath);
      if (entries.length === 1 && !entries[0].anchor) {
        var doc = new DOMParser().parseFromString(html, "text/html");
        chapters.push({ title: entries[0].title, blocks: blocksFromDocument(doc, chapterDir, files) });
        return;
      }
      // Split at anchor positions in document order.
      // Boundaries must be at tag starts, not at the id attribute itself,
      // otherwise "id=\"chapter_1\">" leaks in as a text block.
      entries.forEach(function (entry, idx) {
        var start = 0;
        if (entry.anchor) {
          var pos = html.search(new RegExp('id="' + entry.anchor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + '"'));
          start = pos >= 0 ? html.lastIndexOf("<", pos) : 0;
          if (start < 0) start = 0;
        }
        var end = html.length;
        for (var j = idx + 1; j < entries.length; j++) {
          if (!entries[j].anchor) continue;
          var np = html.indexOf('id="' + entries[j].anchor + '"', start + 1);
          if (np >= 0) { end = html.lastIndexOf("<", np); if (end < 0) end = np; break; }
        }
        var slice = html.slice(start, end);
        var sdoc = new DOMParser().parseFromString(slice, "text/html");
        var blocks = blocksFromDocument(sdoc, chapterDir, files);
        // The heading itself is inside the slice; keep it as the chapter title
        // and drop a duplicate heading block equal to the title.
        if (blocks.length && blocks[0].kind === "text" && blocks[0].text === entry.title) blocks.shift();
        chapters.push({ title: entry.title, blocks: blocks });
      });
    });
    // Cover: first image if no explicit cover, else explicit cover path.
    var images = [];
    chapters.forEach(function (ch) { ch.blocks.forEach(function (b) { if (b.kind === "image") images.push(b.imagePath); }); });
    return { title: title, author: author, intro: desc, coverPath: coverPath || images[0] || "", chapters: chapters, imagePaths: images, files: files };
  }

  function parseTxt(text) {
    var lines = text.replace(/\r\n/g, "\n").split("\n");
    var chapters = [{ title: "正文", blocks: [] }];
    // NOTE: do NOT use \b after 章 — \b is an ASCII word boundary and never
    // matches after a Chinese character, so "第一章 开头" would not be recognised.
    var headingRe = /^\s*(第[一二三四五六七八九十百千0-9]+章|序章|楔子|后记|番外|插图)/;
    lines.forEach(function (line) {
      var t = line.trim();
      if (!t) return;
      if (headingRe.test(t) && t.length < 60) { chapters.push({ title: t, blocks: [] }); return; }
      if (isPureNumber(t)) return;
      chapters[chapters.length - 1].blocks.push({ kind: "text", text: t });
    });
    return { title: "未命名", author: "", intro: "", coverPath: "", chapters: chapters.filter(function (c) { return c.blocks.length || c.title !== "正文"; }), imagePaths: [], files: {} };
  }

  window.EpubParser = { parseEpub: parseEpub, parseTxt: parseTxt, isPureNumber: isPureNumber, splitByBr: splitByBr };
})();
