// ---- Alerts Engine ----
// Monitors configured stocks for anomalies: volume, amount, price,
// trading halt, exchange monitoring, and news sentiment.

var AlertEngine = (function() {
  var ALERT_KEY = 'dashboard_alerts';
  var CHECK_INTERVAL = 60000; // 1 minute
  var VOL_THRESHOLD = 2.0;    // volume > 2x average
  var AMT_THRESHOLD = 2.0;    // amount > 2x average
  var PRICE_THRESHOLD = 9.0;  // |change%| > 9%
  var timer = null;
  var _checking = false; // prevent concurrent runCheck

  function getHistory() {
    try { return JSON.parse(localStorage.getItem(ALERT_KEY)) || []; }
    catch (e) { return []; }
  }

  function saveHistory(alerts) {
    var arr = alerts.slice(0, 200); // cap at 200
    localStorage.setItem(ALERT_KEY, JSON.stringify(arr));
  }

  function addAlert(alert) {
    var alerts = getHistory();
    // Deduplicate: same stock + same type + same title
    var dup = alerts.some(function(a) {
      return a.code === alert.code && a.type === alert.type && a.title === alert.title;
    });
    if (dup) return null;
    alert.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    alert.time = new Date().toISOString();
    alert.read = false;
    alerts.unshift(alert);
    saveHistory(alerts);
    return alert;
  }

  function markRead(id) {
    var alerts = getHistory();
    for (var i = 0; i < alerts.length; i++) {
      if (alerts[i].id === id) { alerts[i].read = true; saveHistory(alerts); return true; }
    }
    return false;
  }

  function getUnreadCount() {
    var alerts = getHistory();
    var n = 0;
    for (var i = 0; i < alerts.length; i++) { if (!alerts[i].read) n++; }
    return n;
  }

  function dismissAlert(id) {
    var alerts = getHistory();
    var idx = -1;
    for (var i = 0; i < alerts.length; i++) {
      if (alerts[i].id === id) { idx = i; break; }
    }
    if (idx === -1) return false;
    alerts.splice(idx, 1);
    saveHistory(alerts);
    return true;
  }

  function clearHistory() {
    localStorage.removeItem(ALERT_KEY);
  }

  // Fetch 5-day K-line for a stock to compute volume/amount averages
  async function fetchAvgVolume(code) {
    try {
      var resp = await fetch('/api/kline?code=' + code + '&scale=240');
      if (!resp.ok) return null;
      var data = await resp.json();
      if (!data.length) return null;
      // Use last 5 days (excluding today if possible)
      var recent = data.slice(-6, -1); // yesterday and prior 4 days
      if (recent.length < 3) recent = data.slice(0, -1);
      if (recent.length === 0) recent = data.slice(0, 5);
      var totalVol = 0, totalAmt = 0;
      for (var i = 0; i < recent.length; i++) {
        totalVol += recent[i].volume || 0;
        totalAmt += (recent[i].volume || 0) * ((recent[i].close || 0));
      }
      return {
        avgVolume: totalVol / recent.length,
        avgAmount: totalAmt / recent.length,
      };
    } catch (e) { return null; }
  }

  // Check a single stock for anomalies
  async function checkStock(quote, avg) {
    var alerts = [];

    // Trading halt
    if (quote.halted) {
      alerts.push({
        code: quote.code, name: quote.name, type: 'halt',
        level: 'high',
        title: '停牌预警 — ' + quote.name,
        detail: quote.name + '（' + quote.code + '）当前处于停牌状态。',
      });
      return alerts; // Skip other checks if halted
    }

    // Price spike (limit up/down)
    if (Math.abs(quote.changePct) >= PRICE_THRESHOLD) {
      alerts.push({
        code: quote.code, name: quote.name, type: 'price',
        level: Math.abs(quote.changePct) >= 15 ? 'high' : 'medium',
        title: (quote.changePct > 0 ? '暴涨' : '暴跌') + '预警 — ' + quote.name,
        detail: quote.name + '（' + quote.code + '）当前' + (quote.changePct > 0 ? '涨' : '跌') + '幅 ' +
          quote.changePct.toFixed(2) + '%，价格 ' + quote.price.toFixed(2) +
          '，触发异常波动预警。',
        changePct: quote.changePct,
      });
    }

    // Volume anomaly
    if (avg && avg.avgVolume > 0 && quote.volume > avg.avgVolume * VOL_THRESHOLD) {
      var ratio = (quote.volume / avg.avgVolume).toFixed(1);
      alerts.push({
        code: quote.code, name: quote.name, type: 'volume',
        level: ratio > 4 ? 'high' : 'medium',
        title: '成交量异常放大 — ' + quote.name,
        detail: quote.name + '（' + quote.code + '）当前成交量 ' + quote.volume + ' 手，' +
          '为近5日均量 ' + Math.round(avg.avgVolume) + ' 手的 ' + ratio + ' 倍。' +
          '成交额 ' + (quote.amount / 10000).toFixed(2) + ' 万元。',
        ratio: parseFloat(ratio),
      });
    }

    // Amount anomaly — estimate today's amount consistently with fetchAvgVolume
    if (avg && avg.avgAmount > 0) {
      var todayEstAmt = quote.volume * quote.price;
      if (todayEstAmt > avg.avgAmount * AMT_THRESHOLD) {
        var amtRatio = (todayEstAmt / avg.avgAmount).toFixed(1);
        alerts.push({
          code: quote.code, name: quote.name, type: 'amount',
          level: amtRatio > 4 ? 'high' : 'medium',
          title: '成交额异常放大 — ' + quote.name,
          detail: quote.name + '（' + quote.code + '）当前成交额 ' + (quote.amount / 10000).toFixed(2) + ' 万元，' +
            '为近5日均额的 ' + amtRatio + ' 倍。',
          ratio: parseFloat(amtRatio),
        });
      }
    }

    return alerts;
  }

  // Check if a code is an A-share (only A-shares are supported by Sina)
  function isAshare(code) {
    return /^\d{6}$/.test(code.trim());
  }

  // Run a full check on all configured stocks
  async function runCheck(onProgress, onSkipped) {
    if (_checking) return [];
    _checking = true;
    try {
    var stocks = StockConfig.getAll();
    if (stocks.length === 0) return [];

    var allAlerts = [];
    var skipped = [];
    for (var i = 0; i < stocks.length; i++) {
      var code = stocks[i].code;
      if (onProgress) onProgress(i + 1, stocks.length, code);

      if (!isAshare(code)) {
        skipped.push(stocks[i].label || code);
        continue;
      }

      try {
        // Fetch real-time quote
        var resp = await fetch('/api/stock_quotes?codes=' + encodeURIComponent(code));
        if (!resp.ok) continue;
        var quotes = await resp.json();
        if (!quotes.length) continue;

        var quote = quotes[0];
        var avg = await fetchAvgVolume(code);
        var stockAlerts = await checkStock(quote, avg);

        for (var j = 0; j < stockAlerts.length; j++) {
          var saved = addAlert(stockAlerts[j]);
          if (saved) allAlerts.push(saved);
        }
      } catch (e) {
        // Skip failed stocks silently
      }
    }

    if (onSkipped && skipped.length > 0) onSkipped(skipped);
    return allAlerts;
    } finally { _checking = false; }
  }

  function startAutoCheck(onNewAlert) {
    if (timer) clearInterval(timer);
    function check() {
      runCheck().then(function(alerts) {
        if (alerts.length > 0 && onNewAlert) onNewAlert(alerts);
      });
    }
    timer = setInterval(check, CHECK_INTERVAL);
    check(); // immediate first check
  }

  function stopAutoCheck() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  function isAutoRunning() {
    return timer !== null;
  }

  // Request browser notification permission
  function requestNotificationPermission() {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }

  function notify(alerts) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    if (alerts.length === 0) return;
    if (alerts.length === 1) {
      var a = alerts[0];
      new Notification(a.title, { body: a.detail.slice(0, 120), icon: '/favicon.ico', tag: a.code + '-' + a.type });
    } else {
      new Notification('提醒中心 — ' + alerts.length + ' 条新提醒', {
        body: alerts.map(function(a) { return a.title; }).join('\n').slice(0, 200),
        icon: '/favicon.ico',
      });
    }
  }

  return {
    getHistory: getHistory,
    addAlert: addAlert,
    dismissAlert: dismissAlert,
    markRead: markRead,
    getUnreadCount: getUnreadCount,
    clearHistory: clearHistory,
    runCheck: runCheck,
    startAutoCheck: startAutoCheck,
    stopAutoCheck: stopAutoCheck,
    isAutoRunning: isAutoRunning,
    requestNotificationPermission: requestNotificationPermission,
    notify: notify,
    isAshare: isAshare,
  };
})();


// ---- Alerts Page UI ----
(function() {

var ALERT_TYPE_LABELS = {
  volume:  { label: '成交量异常', icon: '&#128200;', cls: 'al-type-volume' },
  amount:  { label: '成交额异常', icon: '&#128176;', cls: 'al-type-amount' },
  price:   { label: '价格异动',   icon: '&#9889;',   cls: 'al-type-price' },
  halt:    { label: '停牌预警',   icon: '&#128308;', cls: 'al-type-halt' },
  news:    { label: '舆情预警',   icon: '&#128240;', cls: 'al-type-news' },
  monitor: { label: '重点监控',   icon: '&#128065;', cls: 'al-type-monitor' },
};

function alRender(filterType) {
  var alerts = AlertEngine.getHistory();
  var list = document.getElementById('alList');
  var badge = document.getElementById('alBadge');
  var count = document.getElementById('alCount');

  if (filterType) {
    alerts = alerts.filter(function(a) { return a.type === filterType; });
  }

  if (badge) {
    var unread = AlertEngine.getUnreadCount();
    badge.textContent = unread;
    badge.style.display = unread > 0 ? 'inline' : 'none';
  }
  if (count) count.textContent = alerts.length + ' 条提醒 (' + AlertEngine.getUnreadCount() + ' 未读)';

  if (alerts.length === 0) {
    var stocks = StockConfig.getAll();
    var emptyMsg = stocks.length === 0
      ? '暂无自选股，请先在「配置」页面添加自选股，再点击「手动检测」进行异常检测。'
      : '暂无提醒。点击「手动检测」对自选股进行实时异常检测，或开启「自动监控」持续跟踪。';
    list.innerHTML = '<div class="al-empty">' + emptyMsg + '</div>';
    return;
  }

  list.innerHTML = alerts.map(function(a) {
    var t = ALERT_TYPE_LABELS[a.type] || { label: a.type, icon: '&#128276;', cls: '' };
    var readCls = a.read ? ' al-read' : '';
    return '<div class="al-item ' + a.level + readCls + '">' +
      '<button class="al-dismiss-btn" data-id="' + a.id + '" title="关闭">&times;</button>' +
      '<div class="al-item-head">' +
        '<span class="al-type-tag ' + t.cls + '">' + t.icon + ' ' + t.label + '</span>' +
        '<span class="al-level-tag ' + a.level + '">' + (a.level === 'high' ? '高' : '中') + '</span>' +
        (a.read ? '<span class="al-read-tag">已读</span>' : '<button class="al-markread-btn" data-id="' + a.id + '">标记已读</button>') +
        '<span class="al-time">' + fmtAlertTime(a.time) + '</span>' +
      '</div>' +
      '<div class="al-item-title">' + escHTML(a.title || '') + '</div>' +
      '<div class="al-item-detail">' + escHTML(a.detail || '') + '</div>' +
    '</div>';
  }).join('');

  // Bind mark-read buttons
  list.querySelectorAll('.al-markread-btn').forEach(function(btn) {
    btn.addEventListener('click', function(e) {
      e.stopPropagation();
      AlertEngine.markRead(btn.dataset.id);
      alRender(alCurrentFilter);
      updateAutoBtnState();
    });
  });

  // Bind dismiss buttons
  list.querySelectorAll('.al-dismiss-btn').forEach(function(btn) {
    btn.addEventListener('click', function(e) {
      e.stopPropagation();
      var id = this.dataset.id;
      AlertEngine.dismissAlert(id);
      alRender(alCurrentFilter);
      updateAutoBtnState();
    });
  });
}

var alCurrentFilter = null;

// Manual check trigger
var alRunning = false;
function alRunManualCheck() {
  if (alRunning) return;
  alRunning = true;
  var btn = document.getElementById('alCheckBtn');
  btn.disabled = true;
  btn.textContent = '检测中...';

  AlertEngine.runCheck(function(current, total, code) {
    btn.textContent = '检测中 ' + current + '/' + total + '...';
  }, function(skipped) {
    cfgToast('以下非A股代码不支持实时检测：' + skipped.join(', '));
  }).then(function(newAlerts) {
    alRender(alCurrentFilter);
    updateAutoBtnState();
    if (newAlerts.length > 0) {
      alFlashBadge();
      AlertEngine.notify(newAlerts);
    }
  }).finally(function() {
    alRunning = false;
    btn.disabled = false;
    btn.textContent = '手动检测';
  });
}

function alFlashBadge() {
  var badge = document.getElementById('alBadge');
  if (!badge) return;
  badge.classList.add('flash');
  setTimeout(function() { badge.classList.remove('flash'); }, 1000);
}

// Auto-check toggle
function updateAutoBtnState() {
  var btn = document.getElementById('alAutoBtn');
  if (!btn) return;
  if (AlertEngine.isAutoRunning()) {
    btn.textContent = '自动监控：开';
    btn.style.background = '#22c55e18';
    btn.style.color = '#22c55e';
    btn.style.borderColor = '#22c55e';
  } else {
    btn.textContent = '自动监控：关';
    btn.style.background = '';
    btn.style.color = '';
    btn.style.borderColor = '';
  }
}

function alToggleAutoCheck() {
  if (AlertEngine.isAutoRunning()) {
    AlertEngine.stopAutoCheck();
    updateAutoBtnState();
    cfgToast('自动监控已关闭');
  } else {
    var stocks = StockConfig.getAll();
    if (stocks.length === 0) {
      cfgToast('请先在「配置」页面添加自选股');
      return;
    }
    AlertEngine.requestNotificationPermission();
    AlertEngine.startAutoCheck(function(newAlerts) {
      alRender(alCurrentFilter);
      updateAutoBtnState();
      alFlashBadge();
      AlertEngine.notify(newAlerts);
    });
    updateAutoBtnState();
    cfgToast('自动监控已开启（每60秒检测一次）');
  }
}

// News scan: fetch recent news and check for negative keywords
var NEGATIVE_KEYWORDS = ['立案', '调查', '警示函', '监管函', '问询函', '处罚', '亏损', '暴雷', '违约', '退市', 'ST', '*ST', '特别处理', '停牌', '重组失败', '业绩变脸', '商誉减值', '造假', '内幕', '操纵'];
async function alScanNews() {
  var stocks = StockConfig.getAll();
  if (stocks.length === 0) { cfgToast('自选股列表为空'); return; }
  var found = 0;
  for (var i = 0; i < stocks.length; i++) {
    var code = stocks[i].code;
    try {
      var resp = await fetch('/api/sa/stock_news?identifier=' + encodeURIComponent(code) + '&days=3&limit=5');
      var data = await resp.json();
      var articles = (data.data && data.data.articles) || [];
      for (var j = 0; j < articles.length; j++) {
        var title = articles[j].title || '';
        var snippet = articles[j].snippet || '';
        var combined = title + snippet;
        for (var k = 0; k < NEGATIVE_KEYWORDS.length; k++) {
          if (combined.indexOf(NEGATIVE_KEYWORDS[k]) !== -1) {
            AlertEngine.addAlert({
              code: code, name: stocks[i].label || code, type: 'news',
              level: 'high',
              title: '舆情预警 — ' + NEGATIVE_KEYWORDS[k] + '相关',
              detail: '检测到 ' + (stocks[i].label || code) + '（' + code + '）相关新闻含关键词"' + NEGATIVE_KEYWORDS[k] + '"：' + title,
            });
            found++;
            break; // one alert per stock per scan
          }
        }
      }
    } catch (e) { /* skip */ }
  }
  if (found > 0) {
    alRender(alCurrentFilter);
    alFlashBadge();
    updateAutoBtnState();
  }
  cfgToast('舆情扫描完成，发现 ' + found + ' 条预警');
}


// ---- Event Wiring ----
document.addEventListener('DOMContentLoaded', function() {
  var alInitialized = false;
  var alNav = document.querySelector('[data-page="alerts"]');
  if (alNav) {
    alNav.addEventListener('click', function() {
      if (!alInitialized) {
        alInitialized = true;
        alRender();
      }
    });
  }

  // Manual check button
  var checkBtn = document.getElementById('alCheckBtn');
  if (checkBtn) checkBtn.addEventListener('click', alRunManualCheck);

  // Auto monitor toggle button
  var autoBtn = document.getElementById('alAutoBtn');
  if (autoBtn) {
    autoBtn.addEventListener('click', alToggleAutoCheck);
    updateAutoBtnState();
  }

  // News scan button
  var newsBtn = document.getElementById('alNewsScanBtn');
  if (newsBtn) {
    newsBtn.addEventListener('click', function() {
      if (alRunning) return;
      newsBtn.disabled = true;
      newsBtn.textContent = '扫描中...';
      alScanNews().finally(function() {
        newsBtn.disabled = false;
        newsBtn.textContent = '舆情扫描';
      });
    });
  }

  // Clear button
  var clearBtn = document.getElementById('alClearBtn');
  if (clearBtn) {
    clearBtn.addEventListener('click', function() {
      if (!confirm('确定清空全部提醒记录吗？')) return;
      AlertEngine.clearHistory();
      alCurrentFilter = null;
      document.querySelectorAll('.al-filter').forEach(function(x) { x.classList.remove('active'); });
      var allFilter = document.querySelector('.al-filter.all');
      if (allFilter) allFilter.classList.add('active');
      alRender(null);
      updateAutoBtnState();
    });
  }

  // Filter tabs
  document.querySelectorAll('.al-filter').forEach(function(f) {
    f.addEventListener('click', function() {
      document.querySelectorAll('.al-filter').forEach(function(x) { x.classList.remove('active'); });
      this.classList.add('active');
      alCurrentFilter = this.dataset.filter || null;
      alRender(alCurrentFilter);
    });
  });

  // Initial render of badge
  var unread = AlertEngine.getUnreadCount();
  var badge = document.getElementById('alBadge');
  if (badge && unread > 0) {
    badge.textContent = unread;
    badge.style.display = 'inline';
  }

  // Auto-check on page load
  setTimeout(function() { alRender(); }, 500);

  // Request notification permission on first interaction
  document.addEventListener('click', function() {
    AlertEngine.requestNotificationPermission();
  }, { once: true });
});
})();
