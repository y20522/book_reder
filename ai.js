// AI 功能：AI总结（思维导图 / 故事概要 / 人物关系）+ 划词 AI解读。
// 用的是用户自己的大模型密钥，走兼容 OpenAI 格式的接口（默认 DeepSeek）。
// 密钥只存在读者自己的浏览器 localStorage 里（ebook_ai_settings），
// 不写进代码、不上传到 GitHub、不发给任何其他地方，只在点 AI 按钮时
// 直接发给用户自己在设置里填的接口地址。
(function () {
  var LS_KEY = "ebook_ai_settings";
  var DEFAULTS = {
    endpoint: "https://api.deepseek.com/v1/chat/completions",
    model: "deepseek-chat",
    apiKey: ""
  };

  function $(id) { return document.getElementById(id); }
  function esc(s) { return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

  function getSettings() {
    try {
      var s = JSON.parse(localStorage.getItem(LS_KEY) || "{}");
      return {
        endpoint: (s.endpoint || DEFAULTS.endpoint).trim(),
        model: (s.model || DEFAULTS.model).trim(),
        apiKey: (s.apiKey || "").trim()
      };
    } catch (e) { return { endpoint: DEFAULTS.endpoint, model: DEFAULTS.model, apiKey: "" }; }
  }
  function saveSettings(s) {
    localStorage.setItem(LS_KEY, JSON.stringify({
      endpoint: (s.endpoint || DEFAULTS.endpoint).trim(),
      model: (s.model || DEFAULTS.model).trim(),
      apiKey: (s.apiKey || "").trim()
    }));
  }
  function exportSettings() {
    var s = getSettings();
    var blob = new Blob([JSON.stringify(s, null, 2)], { type: "application/json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "ebook-ai-settings.json";
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
    if ($("aiSettingsStatus")) $("aiSettingsStatus").textContent = "已导出文件，请自己保管好（文件里有你的密钥，别发给别人、别传到 GitHub）";
  }
  async function importSettingsFile(file) {
    if (!file) return;
    try {
      var s = JSON.parse(await file.text());
      if (!s || typeof s !== "object") throw new Error("文件格式不对");
      saveSettings({ endpoint: s.endpoint || DEFAULTS.endpoint, model: s.model || DEFAULTS.model, apiKey: s.apiKey || "" });
      fillSettingsForm();
      if ($("aiSettingsStatus")) $("aiSettingsStatus").textContent = "已导入 AI 设置" + (getSettings().apiKey ? "（密钥已填好）" : "（文件里没有密钥，请再填一次密钥）");
    } catch (e) {
      if ($("aiSettingsStatus")) $("aiSettingsStatus").textContent = "导入失败：" + (e.message || e);
    }
  }
  function fillSettingsForm() {
    var s = getSettings();
    if ($("aiEndpointInput")) $("aiEndpointInput").value = s.endpoint;
    if ($("aiModelInput")) $("aiModelInput").value = s.model;
    if ($("aiKeyInput")) $("aiKeyInput").value = s.apiKey;
    if ($("aiSettingsStatus")) $("aiSettingsStatus").textContent = s.apiKey ? "已填写密钥（只保存在你自己的浏览器里）" : "还没有填写密钥，填好保存后才能用 AI 功能";
  }

  async function chat(messages) {
    var s = getSettings();
    if (!s.apiKey) throw new Error("请先在设置里填写大模型密钥（只保存在你自己的浏览器里）");
    if (!s.endpoint) throw new Error("请先在设置里填写接口地址");
    var res = await fetch(s.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + s.apiKey },
      body: JSON.stringify({ model: s.model, messages: messages, temperature: 0.6, max_tokens: 2500 })
    });
    var json = await res.json().catch(function () { return {}; });
    if (!res.ok) {
      var msg = (json && json.error && (json.error.message || json.error)) || ("请求失败 " + res.status);
      throw new Error(String(msg));
    }
    var content = json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
    if (!content) throw new Error("接口没有返回内容，请检查接口地址和模型名");
    return content;
  }

  function parseJson(content) {
    if (!content) return null;
    var t = String(content).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
    var start = t.indexOf("{"), end = t.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try { return JSON.parse(t.slice(start, end + 1)); } catch (e) { return null; }
  }
  function chapterText() {
    var title = "";
    var h = document.querySelector("#chapterContent h2");
    if (h) title = h.textContent.trim();
    var parts = [];
    document.querySelectorAll("#chapterContent .para, #chapterContent h3").forEach(function (el) {
      var t = el.textContent.trim();
      if (t) parts.push(t);
    });
    var bookTitle = $("bookTitle") ? $("bookTitle").textContent.trim() : "";
    return { bookTitle: bookTitle, chapterTitle: title, text: parts.join("\n") };
  }

  // ---------- AI总结 ----------
  function mindmapHtml(node) {
    if (!node) return "";
    var title = esc(node.title || node.name || "");
    var kids = node.children || node.nodes || [];
    var html = "<li><span class='mm-node'>" + title + "</span>";
    if (kids.length) {
      html += "<ul>";
      kids.forEach(function (k) { html += mindmapHtml(k); });
      html += "</ul>";
    }
    return html + "</li>";
  }
  // ---------- AI总结缓存：生成过一次，下次直接看，不再重新生成 ----------
  var SUMMARY_LS = "ebook_ai_summaries_v1";
  function summaryKey() {
    var ch = chapterText();
    return ch.bookTitle + " | " + ch.chapterTitle;
  }
  function loadSummaries() {
    try { return JSON.parse(localStorage.getItem(SUMMARY_LS) || "{}"); } catch (e) { return {}; }
  }
  function saveSummary(key, data, raw) {
    var all = loadSummaries();
    all[key] = { data: data, raw: raw || "", savedAt: Date.now() };
    try { localStorage.setItem(SUMMARY_LS, JSON.stringify(all)); } catch (e) { /* 存储满了就不缓存 */ }
  }
  function fmtTime(ts) {
    var d = new Date(ts);
    return (d.getMonth() + 1) + "月" + d.getDate() + "日 " + d.getHours() + ":" + String(d.getMinutes()).padStart(2, "0");
  }

  function renderSummary(data, raw, savedAt) {
    var box = $("aiSummaryBody");
    if (!box) return;
    var cachedNote = savedAt ? "<p class='ai-cached-note'>上次生成于 " + esc(fmtTime(savedAt)) + "，直接呈现之前的结果；想重新生成点右上角「重新生成」。</p>" : "";
    if (!data) {
      box.innerHTML = cachedNote + "<p>AI 返回的不是标准格式，下面是原文：</p><pre class='ai-raw'>" + esc(raw) + "</pre>";
      return;
    }
    var html = cachedNote;
    if (data.summary) html += "<h4>故事概要</h4><p>" + esc(data.summary) + "</p>";
    if (data.keyPoints && data.keyPoints.length) {
      html += "<h4>关键情节</h4><ol>";
      data.keyPoints.forEach(function (p) { html += "<li>" + esc(p) + "</li>"; });
      html += "</ol>";
    }
    if (data.mindmap) {
      html += "<h4>思维导图</h4><div class='mindmap'><ul class='mm-tree'>" + mindmapHtml(data.mindmap) + "</ul></div>";
    }
    if (data.characters && data.characters.length) {
      html += "<h4>人物关系</h4>";
      data.characters.forEach(function (c) {
        html += "<div class='char-card'><strong>" + esc(c.name || "") + "</strong>" +
          (c.identity ? " · " + esc(c.identity) : "") +
          (c.description ? "<div>" + esc(c.description) + "</div>" : "");
        if (c.relations && c.relations.length) {
          html += "<div class='relations'>";
          c.relations.forEach(function (r) {
            html += "<span class='rel-chip'>" + esc(c.name || "") + " — " + esc(r.relation || r.type || "相关") + " → " + esc(r.to || r.target || "") + "</span>";
          });
          html += "</div>";
        }
        html += "</div>";
      });
    }
    if (!html) box.innerHTML = "<pre class='ai-raw'>" + esc(raw) + "</pre>";
    else box.innerHTML = html;
  }

  // force=true 时重新生成（「重新生成」按钮）；否则有缓存就直接呈现，不再调用 AI。
  async function summarizeChapter(force) {
    var box = $("aiSummaryBody");
    var btn = $("aiSummaryBtn");
    if (!box) return;
    var ch = chapterText();
    if (!ch.text) { box.innerHTML = "<p>这一章还没有正文可以总结。</p>"; openSummary(); return; }
    var key = summaryKey();
    if (!force) {
      var cached = loadSummaries()[key];
      if (cached) { openSummary(); renderSummary(cached.data, cached.raw, cached.savedAt); return; }
    }
    if (btn) btn.disabled = true;
    box.innerHTML = "<p>正在让 AI 读这一章…（第一次可能要等几秒）</p>";
    openSummary();
    var text = ch.text.length > 12000 ? ch.text.slice(0, 12000) + "\n（本章太长，只取了前 12000 字）" : ch.text;
    try {
      var content = await chat([
        { role: "system", content: "你是一个中文小说阅读助手。请用中文回答，只返回 JSON，不要加任何解释、不要用 Markdown 代码块包裹之外的文字。JSON 字段：summary（故事概要，200-300字）、keyPoints（关键情节，字符串数组，5-8条）、characters（数组，每项 {name, identity, description, relations:[{to, relation}]}，只写本章实际出现的人物，relations 写人物之间的关系，如“师徒”“对手”“同伴”）、mindmap（本章结构思维导图，{title, children:[{title, children:[...]}]}，3-4层，节点标题要短）。" },
        { role: "user", content: "书名：《" + ch.bookTitle + "》\n章节：" + ch.chapterTitle + "\n正文：\n" + text }
      ]);
      var data = parseJson(content);
      saveSummary(key, data, content);
      renderSummary(data, content, Date.now());
    } catch (e) {
      box.innerHTML = "<p>AI总结失败：" + esc(e.message || e) + "</p><p>请检查设置里的接口地址、模型名和密钥是否正确（密钥只保存在你自己的浏览器里）。</p>";
    }
    if (btn) btn.disabled = false;
  }
  function openSummary() { var m = $("aiSummaryModal"); if (m) m.classList.add("open"); }
  function closeSummary() { var m = $("aiSummaryModal"); if (m) m.classList.remove("open"); }

  // ---------- 划词 AI解读 / 翻译 ----------
  var lastSelection = "";
  var lastSelectionPara = -1;
  var interpretMode = "interpret"; // interpret | translate
  function selectionParaIndex() {
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount) return -1;
    var node = sel.anchorNode;
    while (node && node.nodeType !== 1) node = node.parentNode;
    while (node) {
      if (node.classList && node.classList.contains("para")) {
        var v = parseInt(node.getAttribute("data-para"), 10);
        return isNaN(v) ? -1 : v;
      }
      node = node.parentNode;
    }
    return -1;
  }
  function openInterpret(selectedText, opts) {
    if (selectedText) lastSelection = selectedText;
    opts = opts || {};
    interpretMode = opts.mode || "interpret";
    var sel = $("aiSelectedText");
    if (sel) sel.value = lastSelection;
    if ($("aiQuestionInput")) $("aiQuestionInput").value = "";
    if ($("aiAnswerBox")) $("aiAnswerBox").innerHTML = "";
    var title = $("aiFloatTitle");
    if (title) title.textContent = interpretMode === "translate" ? "AI翻译" : "AI助手";
    var q = $("aiQuestionInput");
    if (q) q.placeholder = interpretMode === "translate" ? "想让它怎么翻？（不填就默认中英互译）" : "你的问题（不填就默认：请解读这段文字）";
    var w = $("aiInterpretFloat");
    if (w) { w.classList.remove("hidden"); }
    if (opts.auto) askInterpret();
    else if (sel) sel.focus();
  }
  function closeInterpret() {
    var w = $("aiInterpretFloat");
    if (w) w.classList.add("hidden");
    try { window.getSelection().removeAllRanges(); } catch (e) {}
  }
  async function askInterpret() {
    var selText = $("aiSelectedText") ? $("aiSelectedText").value.trim() : "";
    var q = $("aiQuestionInput") ? $("aiQuestionInput").value.trim() : "";
    var box = $("aiAnswerBox");
    if (!selText) { if (box) box.innerHTML = "<p>请先在输入框里粘贴或写一段要解读的文本。</p>"; return; }
    var ch = chapterText();
    if (interpretMode === "translate") {
      if (!q) q = "请翻译这段文字";
      if (box) box.innerHTML = "<p>正在翻译…</p>";
      try {
        var tr = await chat([
          { role: "system", content: "你是一个翻译助手。原文是中文就翻译成英文，原文是英文就翻译成中文。只返回译文本身，不要加解释、不要加引号、不要编造原文没有的内容。" },
          { role: "user", content: q + "：\n" + selText }
        ]);
        if (box) box.innerHTML = "<p class='ai-translation'>" + esc(tr).replace(/\n/g, "<br>") + "</p>";
      } catch (e) {
        if (box) box.innerHTML = "<p>翻译失败：" + esc(e.message || e) + "</p><p>请检查设置里的接口地址、模型名和密钥是否正确。</p>";
      }
      return;
    }
    if (!q) q = "请解读这段文字：讲了什么、有什么含义、和上下文有什么关系？";
    if (box) box.innerHTML = "<p>AI 正在解读…</p>";
    try {
      var content = await chat([
        { role: "system", content: "你是一个中文小说阅读助手。请用中文、通俗易懂地回答，先直接回答问题，再补充必要的背景和细节。不要编造原文里没有的情节。" },
        { role: "user", content: "书名：《" + ch.bookTitle + "》\n章节：" + ch.chapterTitle + "\n读者选中的文本：\n" + selText + "\n\n读者的问题：" + q }
      ]);
      if (box) box.innerHTML = "<p>" + esc(content).replace(/\n/g, "<br>") + "</p>";
    } catch (e) {
      if (box) box.innerHTML = "<p>AI解读失败：" + esc(e.message || e) + "</p><p>请检查设置里的接口地址、模型名和密钥是否正确。</p>";
    }
  }

  // ---------- 划线（高亮 / 下划线 / 波浪线 / 灰底），存在本机 ----------
  var HL_LS = "ebook_highlights_v1";
  function loadHighlights() {
    try { return JSON.parse(localStorage.getItem(HL_LS) || "[]"); } catch (e) { return []; }
  }
  function saveHighlights(list) {
    try { localStorage.setItem(HL_LS, JSON.stringify(list)); } catch (e) {}
  }
  function highlightKey() {
    var ch = chapterText();
    return { book: ch.bookTitle, chapter: ch.chapterTitle };
  }
  function addHighlight(style) {
    if (!lastSelection) return;
    var key = highlightKey();
    var list = loadHighlights();
    if (style === "remove") {
      list = list.filter(function (h) { return !(h.book === key.book && h.chapter === key.chapter && h.para === lastSelectionPara && h.text === lastSelection); });
    } else {
      var exists = list.some(function (h) { return h.book === key.book && h.chapter === key.chapter && h.para === lastSelectionPara && h.text === lastSelection; });
      if (!exists) list.push({ book: key.book, chapter: key.chapter, para: lastSelectionPara, text: lastSelection, style: style, createdAt: Date.now() });
    }
    saveHighlights(list);
    hideToolbar(); hideHighlightPalette();
    try { window.getSelection().removeAllRanges(); } catch (e) {}
    // 让阅读器重新渲染这一章，把划线画上去（保持原来的滚动位置）。
    window.dispatchEvent(new CustomEvent("ebook:highlights-changed"));
  }
  function hideHighlightPalette() { var p = $("aiHighlightPalette"); if (p) p.classList.add("hidden"); }

  // ---------- 划词浮动工具条（文石 BOOX 式：AI解读 / 翻译 / 划线 / 复制） ----------
  function hideToolbar() { var t = $("aiSelectToolbar"); if (t) t.classList.add("hidden"); hideHighlightPalette(); }
  function showToolbarAt(rect) {
    var t = $("aiSelectToolbar");
    if (!t) return;
    t.classList.remove("hidden");
    var w = t.offsetWidth || 320;
    var left = Math.max(8, Math.min(window.innerWidth - w - 8, rect.left + rect.width / 2 - w / 2));
    var top = rect.top - 52;
    if (top < 8) top = Math.min(window.innerHeight - 60, rect.bottom + 8);
    t.style.left = left + "px";
    t.style.top = top + "px";
  }
  function onSelectionEnd() {
    setTimeout(function () {
      var sel = window.getSelection();
      // 只有真的框选了文字才出工具条：没选、只点了光标、选了不到 2 个字，都不出现。
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) { hideToolbar(); return; }
      var text = sel.toString().trim();
      var container = $("chapterContent");
      if (!text || text.length < 2 || text.length > 2000 || !container || !container.contains(sel.anchorNode)) { hideToolbar(); return; }
      lastSelection = text;
      lastSelectionPara = selectionParaIndex();
      showToolbarAt(sel.getRangeAt(0).getBoundingClientRect());
    }, 30);
  }
  // 长按（手机 / 墨水屏）：只在系统已经选出词的情况下才出工具条，
  // 绝不自己替用户选中整段——以前长按 600ms 会自动选中整段，
  // 就是没框选也弹出工具条的原因。滑动会取消，不影响正常翻页。
  function bindLongPress(content) {
    if (!content) return;
    var timer = null, sx = 0, sy = 0;
    content.addEventListener("touchstart", function (e) {
      if (e.touches.length !== 1) return;
      sx = e.touches[0].clientX; sy = e.touches[0].clientY;
      timer = setTimeout(function () {
        var sel = window.getSelection();
        if (!sel || sel.isCollapsed || sel.toString().trim().length < 2) return;
        lastSelection = sel.toString().trim();
        lastSelectionPara = selectionParaIndex();
        showToolbarAt(sel.getRangeAt(0).getBoundingClientRect());
      }, 600);
    }, { passive: true });
    content.addEventListener("touchmove", function (e) {
      if (!timer) return;
      var t = e.touches[0];
      if (Math.abs(t.clientX - sx) > 12 || Math.abs(t.clientY - sy) > 12) { clearTimeout(timer); timer = null; }
    }, { passive: true });
    content.addEventListener("touchend", function () { if (timer) { clearTimeout(timer); timer = null; } }, { passive: true });
  }
  // 工具条出现后，点别处 / 滚动 / 选区清空就收起来，别一直赖在屏幕上。
  function bindHideToolbar() {
    function outside(e) {
      var t = $("aiSelectToolbar"), p = $("aiHighlightPalette");
      if (t && !t.classList.contains("hidden") && !t.contains(e.target) && !(p && p.contains(e.target))) hideToolbar();
      else if (p && !p.classList.contains("hidden") && !p.contains(e.target) && !(t && t.contains(e.target))) hideHighlightPalette();
    }
    document.addEventListener("mousedown", outside);
    document.addEventListener("touchstart", outside, { passive: true });
    window.addEventListener("scroll", function () { hideToolbar(); }, { passive: true });
    document.addEventListener("selectionchange", function () {
      var sel = window.getSelection();
      var t = $("aiSelectToolbar");
      if (t && !t.classList.contains("hidden") && (!sel || sel.isCollapsed || !sel.toString().trim())) hideToolbar();
    });
  }

  // ---------- 悬浮窗拖动 ----------
  function makeDraggable(win, handle) {
    if (!win || !handle) return;
    var sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
    handle.addEventListener("mousedown", function (e) {
      dragging = true; sx = e.clientX; sy = e.clientY;
      var r = win.getBoundingClientRect(); ox = r.left; oy = r.top;
      win.style.transform = "none"; win.style.left = ox + "px"; win.style.top = oy + "px";
      e.preventDefault();
    });
    document.addEventListener("mousemove", function (e) {
      if (!dragging) return;
      win.style.left = Math.max(0, ox + e.clientX - sx) + "px";
      win.style.top = Math.max(0, oy + e.clientY - sy) + "px";
    });
    document.addEventListener("mouseup", function () { dragging = false; });
  }

  // ---------- 绑定 ----------
  document.addEventListener("DOMContentLoaded", function () {
    fillSettingsForm();
    var sBtn = $("aiSummaryBtn");
    if (sBtn) sBtn.onclick = function () { summarizeChapter(false); };
    var sClose = $("closeAiSummaryBtn");
    if (sClose) sClose.onclick = closeSummary;
    var sRegen = $("aiSummaryRegenBtn");
    if (sRegen) sRegen.onclick = function () { summarizeChapter(true); };
    var saveBtn = $("aiSaveSettingsBtn");
    if (saveBtn) saveBtn.onclick = function () {
      saveSettings({
        endpoint: $("aiEndpointInput") ? $("aiEndpointInput").value : "",
        model: $("aiModelInput") ? $("aiModelInput").value : "",
        apiKey: $("aiKeyInput") ? $("aiKeyInput").value : ""
      });
      fillSettingsForm();
      if ($("aiSettingsStatus")) $("aiSettingsStatus").textContent = "已保存到你自己的浏览器里";
    };
    var clearBtn = $("aiClearKeyBtn");
    if (clearBtn) clearBtn.onclick = function () {
      saveSettings({ endpoint: DEFAULTS.endpoint, model: DEFAULTS.model, apiKey: "" });
      fillSettingsForm();
    };
    var exportBtn = $("aiExportBtn");
    if (exportBtn) exportBtn.onclick = exportSettings;
    var importInput = $("aiImportInput");
    if (importInput) importInput.addEventListener("change", function (e) {
      importSettingsFile(e.target.files && e.target.files[0]);
      e.target.value = "";
    });
    var toolbarBtn = $("aiInterpretToolbarBtn");
    if (toolbarBtn) toolbarBtn.onclick = function () { hideToolbar(); openInterpret(lastSelection, { mode: "interpret" }); };
    var translateBtn = $("aiTranslateToolbarBtn");
    if (translateBtn) translateBtn.onclick = function () { hideToolbar(); openInterpret(lastSelection, { mode: "translate", auto: true }); };
    var hlBtn = $("aiHighlightToolbarBtn");
    if (hlBtn) hlBtn.onclick = function () {
      var p = $("aiHighlightPalette");
      if (!p) return;
      var t = $("aiSelectToolbar");
      var r = t ? t.getBoundingClientRect() : { left: 8, bottom: 100 };
      p.classList.remove("hidden");
      p.style.left = Math.max(8, r.left) + "px";
      p.style.top = (r.bottom + 8) + "px";
    };
    document.querySelectorAll("#aiHighlightPalette [data-hl]").forEach(function (b) {
      b.onclick = function () { addHighlight(b.getAttribute("data-hl")); };
    });
    var copyBtn = $("aiCopyToolbarBtn");
    if (copyBtn) copyBtn.onclick = function () {
      if (!lastSelection) return;
      var done = function () { hideToolbar(); try { window.getSelection().removeAllRanges(); } catch (e) {} };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(lastSelection).then(done, done);
      else { var ta = document.createElement("textarea"); ta.value = lastSelection; document.body.appendChild(ta); ta.select(); try { document.execCommand("copy"); } catch (e) {} ta.remove(); done(); }
    };
    var askBtn = $("aiAskBtn");
    if (askBtn) askBtn.onclick = askInterpret;
    var qInput = $("aiQuestionInput");
    if (qInput) qInput.addEventListener("keydown", function (e) { if (e.key === "Enter") askInterpret(); });
    var closeBtn = $("closeAiInterpretBtn");
    if (closeBtn) closeBtn.onclick = closeInterpret;
    var expandBtn = $("aiExpandBtn");
    if (expandBtn) expandBtn.onclick = function () { var w = $("aiInterpretFloat"); if (w) w.classList.toggle("ai-full"); };
    var content = $("chapterContent");
    if (content) {
      content.addEventListener("mouseup", onSelectionEnd);
      content.addEventListener("touchend", onSelectionEnd);
      bindLongPress(content);
    }
    bindHideToolbar();
    makeDraggable($("aiInterpretFloat"), $("aiInterpretHeader"));
  });

  window.EbookAI = { getSettings: getSettings, saveSettings: saveSettings, chat: chat, summarizeChapter: summarizeChapter, openInterpret: openInterpret };
})();
