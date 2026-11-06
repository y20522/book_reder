// 图片存在 IndexedDB 里，不存在 localStorage 里。
// 原因：iPhone 的 Safari 给 localStorage 只有约 5MB，34 卷 18 张插图
// 即使缩过图、转成 base64 也要几 MB，存书的时候就会报
// "The quota has been exceeded"，整本都传不上去。IndexedDB 的
// 额度大得多（几十 MB 以上），放插图正合适；书的文字、段评、
// 书签、进度还是走 localStorage（都很小）。
// 如果浏览器打不开 IndexedDB（极少数旧机 / 隐私模式），就退回
// 内存缓存：当次能看，关掉页面就没了，阅读器会显示占位。
(function () {
  var DB_NAME = "ebook_images";
  var STORE = "images";
  var mem = {};
  var dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      if (!window.indexedDB) { reject(new Error("no indexedDB")); return; }
      var req = window.indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "key" });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error("indexedDB open failed")); };
      req.onblocked = function () { reject(new Error("indexedDB blocked")); };
    });
    return dbPromise;
  }
  function tx(mode) {
    return openDb().then(function (db) { return db.transaction(STORE, mode).objectStore(STORE); });
  }
  function put(key, dataUrl) {
    mem[key] = dataUrl;
    return tx("readwrite").then(function (store) {
      return new Promise(function (resolve, reject) {
        var req = store.put({ key: key, dataUrl: dataUrl });
        req.onsuccess = function () { resolve(true); };
        req.onerror = function () { reject(req.error || new Error("indexedDB put failed")); };
      });
    }).catch(function (e) {
      // IndexedDB 写不进去（比如额度也满了）：内存里留一份，当次能看。
      return false;
    });
  }
  function get(key) {
    if (mem[key]) return Promise.resolve(mem[key]);
    return tx("readonly").then(function (store) {
      return new Promise(function (resolve) {
        var req = store.get(key);
        req.onsuccess = function () {
          var v = req.result && req.result.dataUrl;
          if (v) mem[key] = v;
          resolve(v || null);
        };
        req.onerror = function () { resolve(null); };
      });
    }).catch(function () { return mem[key] || null; });
  }
  function del(key) {
    delete mem[key];
    return tx("readwrite").then(function (store) {
      return new Promise(function (resolve) { var req = store.delete(key); req.onsuccess = function () { resolve(true); }; req.onerror = function () { resolve(false); }; });
    }).catch(function () { return false; });
  }
  function getAllForBook(bookId) {
    var prefix = bookId + "|";
    var out = {};
    Object.keys(mem).forEach(function (k) { if (k.indexOf(prefix) === 0) out[k.slice(prefix.length)] = mem[k]; });
    return tx("readonly").then(function (store) {
      return new Promise(function (resolve) {
        var req = store.getAll();
        req.onsuccess = function () {
          (req.result || []).forEach(function (row) {
            if (row.key && row.key.indexOf(prefix) === 0) out[row.key.slice(prefix.length)] = row.dataUrl;
          });
          resolve(out);
        };
        req.onerror = function () { resolve(out); };
      });
    }).catch(function () { return out; });
  }
  function deleteForBook(bookId) {
    var prefix = bookId + "|";
    Object.keys(mem).forEach(function (k) { if (k.indexOf(prefix) === 0) delete mem[k]; });
    return tx("readwrite").then(function (store) {
      return new Promise(function (resolve) {
        var req = store.getAllKeys();
        req.onsuccess = function () {
          var keys = (req.result || []).filter(function (k) { return k.indexOf(prefix) === 0; });
          var left = keys.length;
          if (!left) { resolve(true); return; }
          keys.forEach(function (k) {
            var d = store.delete(k);
            d.onsuccess = d.onerror = function () { if (--left === 0) resolve(true); };
          });
        };
        req.onerror = function () { resolve(false); };
      });
    }).catch(function () { return false; });
  }
  function available() { return !!window.indexedDB; }

  window.EbookImages = { put: put, get: get, del: del, getAllForBook: getAllForBook, deleteForBook: deleteForBook, available: available };
})();
