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
  function renderSummary(data, raw) {
    var box = $("aiSummaryBody");
    if (!box) return;
    if (!data) {
      box.innerHTML = "<p>AI 返回的不是标准格式，下面是原文：</p><pre class='ai-raw'>" + esc(raw) + "</pre>";
      return;
    }
    var html = "";
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

  async function summarizeChapter() {
    var box = $("aiSummaryBody");
    var btn = $("aiSummaryBtn");
    if (!box) return;
    var ch = chapterText();
    if (!ch.text) { box.innerHTML = "<p>这一章还没有正文可以总结。</p>"; return; }
    if (btn) btn.disabled = true;
    box.innerHTML = "<p>正在让 AI 读这一章…（第一次可能要等几秒）</p>";
    openSummary();
    var text = ch.text.length > 12000 ? ch.text.slice(0, 12000) + "\n（本章太长，只取了前 12000 字）" : ch.text;
    try {
      var content = await chat([
        { role: "system", content: "你是一个中文小说阅读助手。请用中文回答，只返回 JSON，不要加任何解释、不要用 Markdown 代码块包裹之外的文字。JSON 字段：summary（故事概要，200-300字）、keyPoints（关键情节，字符串数组，5-8条）、characters（数组，每项 {name, identity, description, relations:[{to, relation}]}，只写本章实际出现的人物，relations 写人物之间的关系，如“师徒”“对手”“同伴”）、mindmap（本章结构思维导图，{title, children:[{title, children:[...]}]}，3-4层，节点标题要短）。" },
        { role: "user", content: "书名：《" + ch.bookTitle + "》\n章节：" + ch.chapterTitle + "\n正文：\n" + text }
      ]);
      renderSummary(parseJson(content), content);
    } catch (e) {
      box.innerHTML = "<p>AI总结失败：" + esc(e.message || e) + "</p><p>请检查设置里的接口地址、模型名和密钥是否正确（密钥只保存在你自己的浏览器里）。</p>";
    }
    if (btn) btn.disabled = false;
  }
  function openSummary() { var m = $("aiSummaryModal"); if (m) m.classList.add("open"); }
  function closeSummary() { var m = $("aiSummaryModal"); if (m) m.classList.remove("open"); }

  // ---------- 划词 AI解读 ----------
  var lastSelection = "";
  function openInterpret(selectedText) {
    if (selectedText) lastSelection = selectedText;
    var sel = $("aiSelectedText");
    if (sel) sel.value = lastSelection;
    if ($("aiQuestionInput")) $("aiQuestionInput").value = "";
    if ($("aiAnswerBox")) $("aiAnswerBox").innerHTML = "";
    var w = $("aiInterpretFloat");
    if (w) { w.classList.remove("hidden"); }
    if (sel) sel.focus();
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
    if (!q) q = "请解读这段文字：讲了什么、有什么含义、和上下文有什么关系？";
    if (box) box.innerHTML = "<p>AI 正在解读…</p>";
    var ch = chapterText();
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

  // ---------- 划词浮动工具条 ----------
  function hideToolbar() { var t = $("aiSelectToolbar"); if (t) t.classList.add("hidden"); }
  function onSelectionEnd() {
    setTimeout(function () {
      var sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) { hideToolbar(); return; }
      var text = sel.toString().trim();
      var container = $("chapterContent");
      if (!text || text.length < 2 || text.length > 2000 || !container || !container.contains(sel.anchorNode)) { hideToolbar(); return; }
      lastSelection = text;
      var rect = sel.getRangeAt(0).getBoundingClientRect();
      var t = $("aiSelectToolbar");
      if (!t) return;
      t.classList.remove("hidden");
      var left = Math.max(8, Math.min(window.innerWidth - 120, rect.left + rect.width / 2 - 50));
      var top = Math.max(8, rect.top - 44);
      t.style.left = left + "px";
      t.style.top = top + "px";
    }, 30);
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
    if (sBtn) sBtn.onclick = summarizeChapter;
    var sClose = $("closeAiSummaryBtn");
    if (sClose) sClose.onclick = closeSummary;
    var sRegen = $("aiSummaryRegenBtn");
    if (sRegen) sRegen.onclick = summarizeChapter;
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
    var toolbarBtn = $("aiInterpretToolbarBtn");
    if (toolbarBtn) toolbarBtn.onclick = function () { hideToolbar(); openInterpret(lastSelection); };
    var askBtn = $("aiAskBtn");
    if (askBtn) askBtn.onclick = askInterpret;
    var closeBtn = $("closeAiInterpretBtn");
    if (closeBtn) closeBtn.onclick = closeInterpret;
    var content = $("chapterContent");
    if (content) {
      content.addEventListener("mouseup", onSelectionEnd);
      content.addEventListener("touchend", onSelectionEnd);
    }
    document.addEventListener("mousedown", function (e) {
      var t = $("aiSelectToolbar");
      if (t && !t.classList.contains("hidden") && !t.contains(e.target)) hideToolbar();
    });
    makeDraggable($("aiInterpretFloat"), $("aiInterpretHeader"));
  });

  window.EbookAI = { getSettings: getSettings, saveSettings: saveSettings, chat: chat, summarizeChapter: summarizeChapter, openInterpret: openInterpret };
})();
