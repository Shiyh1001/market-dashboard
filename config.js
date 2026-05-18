// ---- Finance Cache ----
// Caches financial data (profile + financials + news) per stock code.
// Survives offline: once fetched, data is available without the Python API.

var FinanceCache = (function() {
  var KEY = 'dashboard_finance_cache';

  function _load() {
    try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; }
  }

  function _save(cache) {
    try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch (e) {
      // localStorage full — evict oldest entries
      var keys = Object.keys(cache);
      keys.sort(function(a, b) { return (cache[a].cachedAt || '').localeCompare(cache[b].cachedAt || ''); });
      for (var i = 0; i < Math.ceil(keys.length / 4); i++) { delete cache[keys[i]]; }
      localStorage.setItem(KEY, JSON.stringify(cache));
    }
  }

  function get(code) {
    var cache = _load();
    return cache[code.toUpperCase()] || null;
  }

  function set(code, data) {
    var cache = _load();
    cache[code.toUpperCase()] = {
      profile: data.profile,
      financials: data.financials,
      news: data.news,
      cachedAt: new Date().toISOString(),
      code: code,
    };
    _save(cache);
  }

  function remove(code) {
    var cache = _load();
    delete cache[code.toUpperCase()];
    _save(cache);
  }

  function getAll() {
    return _load();
  }

  function clear() {
    localStorage.removeItem(KEY);
  }

  function hasAll(stockCodes) {
    var cache = _load();
    for (var i = 0; i < stockCodes.length; i++) {
      if (!cache[stockCodes[i].toUpperCase()]) return false;
    }
    return true;
  }

  return { get: get, set: set, remove: remove, getAll: getAll, clear: clear, hasAll: hasAll };
})();


// ---- Stock Config Manager ----
// Persisted to localStorage, consumed by other dashboard pages.

var StockConfig = (function() {
  var KEY = 'dashboard_stocks';

  function getAll() {
    try {
      return JSON.parse(localStorage.getItem(KEY)) || [];
    } catch (e) {
      return [];
    }
  }

  function saveAll(list) {
    localStorage.setItem(KEY, JSON.stringify(list));
  }

  function add(code, label) {
    var list = getAll();
    // Deduplicate by code (case-insensitive)
    var exists = list.some(function(s) {
      return s.code.toUpperCase() === code.toUpperCase();
    });
    if (exists) return false;
    list.push({ code: code, label: label || '', added: new Date().toISOString().slice(0, 10) });
    saveAll(list);
    return true;
  }

  function remove(code) {
    var list = getAll();
    var idx = -1;
    for (var i = 0; i < list.length; i++) {
      if (list[i].code.toUpperCase() === code.toUpperCase()) { idx = i; break; }
    }
    if (idx === -1) return false;
    list.splice(idx, 1);
    saveAll(list);
    return true;
  }

  function clearAll() {
    localStorage.removeItem(KEY);
  }

  function importJSON(jsonStr) {
    try {
      var arr = JSON.parse(jsonStr);
      if (!Array.isArray(arr)) throw new Error('Not an array');
      var list = getAll();
      var added = 0;
      for (var i = 0; i < arr.length; i++) {
        if (!arr[i].code) continue;
        var exists = list.some(function(s) {
          return s.code.toUpperCase() === arr[i].code.toUpperCase();
        });
        if (!exists) {
          list.push({
            code: arr[i].code,
            label: arr[i].label || '',
            added: arr[i].added || new Date().toISOString().slice(0, 10),
          });
          added++;
        }
      }
      saveAll(list);
      return added;
    } catch (e) {
      return -1;
    }
  }

  function exportJSON() {
    return JSON.stringify(getAll(), null, 2);
  }

  function getCodes() {
    return getAll().map(function(s) { return s.code; });
  }

  return {
    getAll: getAll,
    add: add,
    remove: remove,
    clearAll: clearAll,
    importJSON: importJSON,
    exportJSON: exportJSON,
    getCodes: getCodes,
  };
})();


// ---- Config Page UI ----

function cfgResolveName(code, label) {
  // 1. FinanceCache profile
  var cached = FinanceCache.get(code);
  if (cached && cached.profile) {
    var p = cached.profile.data || cached.profile;
    if (p.name) return p.name;
  }
  // 2. StockConfig label
  if (label) return label;
  // 3. Stock list cache (from AI pick)
  try {
    var slEntry = JSON.parse(localStorage.getItem('sp_stock_list_cache'));
    if (slEntry && slEntry.data) {
      for (var i = 0; i < slEntry.data.length; i++) {
        if (slEntry.data[i].code === code) return slEntry.data[i].name || '';
      }
    }
  } catch (e) { /* ignore */ }
  return '';
}

function cfgMarketBadge(code) {
  if (/^\d{6}$/.test(code)) {
    if (code.startsWith('6')) return '<span class="cfg-mkt-badge mkt-sh">沪</span>';
    if (code.startsWith('0') || code.startsWith('3')) return '<span class="cfg-mkt-badge mkt-sz">深</span>';
    return '';
  }
  if (/\.HK$/i.test(code)) return '<span class="cfg-mkt-badge mkt-hk">港</span>';
  if (/^[A-Z]+$/i.test(code)) return '<span class="cfg-mkt-badge mkt-us">美</span>';
  return '';
}

function cfgRender() {
  var stocks = StockConfig.getAll();
  var tbody = document.getElementById('cfgStockList');
  document.getElementById('cfgCount').textContent = stocks.length + ' 只';

  if (stocks.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="cfg-empty">暂无自选股，请在上方添加，或在 AI选股 页面筛选后点击"添加自选"</td></tr>';
    document.getElementById('cfgCacheAllBtn').disabled = true;
    return;
  }
  document.getElementById('cfgCacheAllBtn').disabled = false;

  tbody.innerHTML = stocks.map(function(s, i) {
    var cached = FinanceCache.get(s.code);
    var nameRaw = cfgResolveName(s.code, s.label);
    var nameHtml = nameRaw ? esc(nameRaw) : '<span style="color:var(--text-secondary);">--</span>';

    var cacheHtml = cached
      ? '<span class="cfg-cache-badge cached" title="缓存于 ' + cached.cachedAt.slice(0, 16).replace('T', ' ') + '">● 已缓存</span>'
      : '<span class="cfg-cache-badge uncached">○ 未缓存</span>';

    var mktBadge = cfgMarketBadge(s.code);

    var actionHtml = cached
      ? '<button class="cfg-cache-now" data-code="' + esc(s.code) + '">更新</button><button class="cfg-del" data-code="' + esc(s.code) + '">删除</button>'
      : '<button class="cfg-cache-now" data-code="' + esc(s.code) + '">缓存</button><button class="cfg-del" data-code="' + esc(s.code) + '">删除</button>';

    return '<tr>' +
      '<td style="width:36px;color:var(--text-secondary);">' + (i + 1) + '</td>' +
      '<td>' + mktBadge + '<span class="cfg-code">' + esc(s.code) + '</span></td>' +
      '<td title="' + esc(nameRaw || '') + '">' + nameHtml + '</td>' +
      '<td>' + cacheHtml + '</td>' +
      '<td>' + actionHtml + '</td>' +
      '</tr>';
  }).join('');

  // Bind delete handlers
  tbody.querySelectorAll('.cfg-del').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var code = this.dataset.code;
      StockConfig.remove(code);
      FinanceCache.remove(code);
      cfgRender();
      cfgToast('已删除 ' + code);
    });
  });

  // Bind single cache buttons
  tbody.querySelectorAll('.cfg-cache-now').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var code = this.dataset.code;
      this.textContent = '...';
      this.disabled = true;
      fetchAndCacheOne(code).then(function(ok) {
        cfgRender();
        cfgToast(ok ? code + ' 缓存成功' : code + ' 缓存失败');
      });
    });
  });
}

// Cache a single stock by fetching all three endpoints
function fetchAndCacheOne(code) {
  return Promise.all([
    cfgFetchSA( '/profile?identifier=' + encodeURIComponent(code)),
    cfgFetchSA( '/financials?identifier=' + encodeURIComponent(code) + '&period=annual&years=3'),
    cfgFetchSA( '/stock_news?identifier=' + encodeURIComponent(code) + '&days=30&limit=3'),
  ]).then(function(results) {
    FinanceCache.set(code, {
      profile: results[0],
      financials: results[1],
      news: results[2],
    });
    return true;
  }).catch(function() {
    return false;
  });
}

// Cache all configured stocks in sequence (to avoid overwhelming the API)
async function cacheAllStocks(updateFn) {
  var stocks = StockConfig.getAll();
  if (stocks.length === 0) { cfgToast('自选股列表为空'); return; }
  var done = 0, failed = 0;
  for (var i = 0; i < stocks.length; i++) {
    var code = stocks[i].code;
    if (updateFn) updateFn(code, 'fetching', i + 1, stocks.length);
    var ok = await fetchAndCacheOne(code);
    if (ok) done++; else failed++;
    if (updateFn) updateFn(code, ok ? 'done' : 'failed', i + 1, stocks.length);
  }
  cfgRender();
  cfgToast('缓存完成：' + done + ' 成功' + (failed > 0 ? '，' + failed + ' 失败' : ''));
}

// cfgFetchSA helper (thin wrapper, mirrors financials.js fetchSA)
function cfgFetchSA(path) {
  return fetch('/api/sa' + path).then(function(resp) {
    if (!resp.ok) {
      return resp.json().then(function(err) {
        throw new Error(err.error || err.detail || 'HTTP ' + resp.status);
      });
    }
    return resp.json();
  });
}

function esc(str) {
  var el = document.createElement('span');
  el.textContent = str;
  return el.innerHTML;
}

var cfgToastTimer;
function cfgToast(msg) {
  var el = document.getElementById('cfgToast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'cfgToast';
    el.className = 'cfg-toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(cfgToastTimer);
  cfgToastTimer = setTimeout(function() { el.classList.remove('show'); }, 2000);
}


// ---- Event Wiring ----

document.addEventListener('DOMContentLoaded', function() {
  // Add stock
  document.getElementById('cfgAddBtn').addEventListener('click', function() {
    var code = document.getElementById('cfgStockInput').value.trim();
    if (!code) { cfgToast('请输入股票代码'); return; }
    var ok = StockConfig.add(code, '');
    if (!ok) { cfgToast('该股票代码已存在：' + code); return; }
    document.getElementById('cfgStockInput').value = '';
    cfgRender();
    cfgToast('已添加 ' + code);
  });

  document.getElementById('cfgStockInput').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') document.getElementById('cfgAddBtn').click();
  });

  // Export
  document.getElementById('cfgExportBtn').addEventListener('click', function() {
    var json = StockConfig.exportJSON();
    var blob = new Blob([json], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'dashboard_stocks_' + new Date().toISOString().slice(0, 10) + '.json';
    a.click();
    URL.revokeObjectURL(a.href);
    cfgToast('配置已导出');
  });

  // Import
  var fileInput;
  document.getElementById('cfgImportBtn').addEventListener('click', function() {
    if (!fileInput) {
      fileInput = document.createElement('input');
      fileInput.type = 'file';
      fileInput.accept = '.json';
      fileInput.addEventListener('change', function() {
        var file = this.files[0];
        if (!file) return;
        var reader = new FileReader();
        reader.onload = function() {
          var added = StockConfig.importJSON(reader.result);
          if (added === -1) cfgToast('文件格式错误，请导入正确的 JSON 文件');
          else cfgToast('成功导入 ' + added + ' 只股票');
          cfgRender();
        };
        reader.readAsText(file);
        fileInput.value = '';
      });
    }
    fileInput.click();
  });

  // Clear all
  document.getElementById('cfgClearBtn').addEventListener('click', function() {
    var stocks = StockConfig.getAll();
    if (stocks.length === 0) { cfgToast('列表已为空'); return; }
    if (!confirm('确定要清空全部 ' + stocks.length + ' 只自选股吗？此操作不可恢复。')) return;
    StockConfig.clearAll();
    cfgRender();
    cfgToast('已清空全部自选股');
  });

  // Quick tags (add-on-click for config page quick bar)
  document.querySelectorAll('#page-config .fa-tag').forEach(function(tag) {
    tag.addEventListener('click', function() {
      var code = this.dataset.code;
      var label = this.textContent;
      var ok = StockConfig.add(code, label);
      if (ok) {
        cfgRender();
        cfgToast('已添加 ' + code + ' ' + label);
      } else {
        cfgToast(code + ' 已在列表中');
      }
    });
  });

  // Cache all
  var cacheAllRunning = false;
  document.getElementById('cfgCacheAllBtn').addEventListener('click', function() {
    if (cacheAllRunning) return;
    cacheAllRunning = true;
    var btn = document.getElementById('cfgCacheAllBtn');
    btn.disabled = true;
    btn.textContent = '缓存中...';
    cacheAllStocks(function(code, status, current, total) {
      btn.textContent = '缓存中 ' + current + '/' + total;
    }).finally(function() {
      cacheAllRunning = false;
      btn.disabled = false;
      btn.textContent = '缓存全部';
    });
  });

  // Render on tab switch
  var cfgNav = document.querySelector('[data-page="config"]');
  if (cfgNav) {
    cfgNav.addEventListener('click', function() { cfgRender(); });
  }

  // Initial render if config page is active
  if (window.location.hash === '#config') {
    cfgRender();
  }
});
