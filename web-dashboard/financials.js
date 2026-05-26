(function() {
// ---- Financial Analysis ----
var faChart = null, faCurrentCode = null;

function fmtCNY(n) {
  if (n == null || isNaN(n)) return '--';
  n = Number(n);
  if (Math.abs(n) >= 1e8) return (n / 1e8).toFixed(2) + ' 亿';
  if (Math.abs(n) >= 1e4) return (n / 1e4).toFixed(2) + ' 万';
  return n.toFixed(2);
}
function fmtPct(n) { if (n == null || isNaN(n)) return '--'; n = Number(n); return (n >= 0 ? '+' : '') + n.toFixed(2) + '%'; }
function fmtRatio(n) { if (n == null || isNaN(n)) return '--'; return Number(n).toFixed(2); }
function fmtPeriod(pe) {
  if (!pe || pe.length < 8) return pe || '';
  var y = pe.slice(0, 4), m = pe.slice(4, 6), d = pe.slice(6, 8);
  if (m === '12' && d === '31') return y + '年全年';
  if (m === '03' && d === '31') return y + '年Q1';
  if (m === '06' && d === '30') return y + '年H1';
  if (m === '09' && d === '30') return y + '年Q3';
  return y + '年' + m + '月';
}
function el(id) { return document.getElementById(id); }

function showLoading() { el('faLoading').style.display='block'; el('faError').style.display='none'; el('faResults').style.display='none'; }
function showError(msg) { el('faLoading').style.display='none'; el('faError').style.display='block'; el('faError').textContent=msg; el('faResults').style.display='none'; }
function showResults() { el('faLoading').style.display='none'; el('faError').style.display='none'; el('faResults').style.display='block'; }

async function fetchSA(path) {
  var resp = await fetch('/api/sa' + path);
  if (!resp.ok) {
    var ct = resp.headers.get('content-type') || '';
    if (ct.indexOf('json') !== -1) { var err = await resp.json(); throw new Error(err.error || err.detail || 'HTTP ' + resp.status); }
    throw new Error('HTTP ' + resp.status);
  }
  return resp.json();
}

function buildProfile(profile) {
  var p = profile.data || profile;
  el('faName').textContent = p.name || '--';
  el('faTicker').textContent = p.ticker || '--';
  el('faIndustry').textContent = (p.industry && p.industry !== 'None') ? p.industry : (p.sector || '--');
  el('faMcap').textContent = p.market_cap ? fmtCNY(p.market_cap) : '--';
  el('faPE').textContent = p.pe_ratio ? fmtRatio(p.pe_ratio) : '--';
  el('faPB').textContent = p.pb_ratio ? fmtRatio(p.pb_ratio) : '--';
}

function buildMetricCards(financials) {
  var grid = el('faMetricGrid');
  if (!financials) { grid.innerHTML = '<p style="color:var(--text-secondary);text-align:center;padding:20px;">暂无财务数据</p>'; return; }
  var fin = financials.data || financials;
  var rows = fin.data || (Array.isArray(fin) ? fin : []);
  var seen = {}, items = [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var yr = r.year || r.period_end || '';
    if (!seen[yr] && (r.revenue || r.net_income)) { seen[yr] = true; items.push(r); }
  }
  items.sort(function(a, b) { return (b.year || '') - (a.year || ''); });
  if (items.length === 0) { grid.innerHTML = '<p style="color:var(--text-secondary);text-align:center;padding:20px;">暂无财务数据</p>'; return; }
  var latest = items[0], prev = items[1];
  var revGrowth = (prev && prev.revenue) ? ((latest.revenue - prev.revenue) / Math.abs(prev.revenue) * 100) : null;
  var niGrowth = (prev && prev.net_income) ? ((latest.net_income - prev.net_income) / Math.abs(prev.net_income) * 100) : null;
  var ocfGrowth = (prev && prev.operating_cash_flow) ? ((latest.operating_cash_flow - prev.operating_cash_flow) / Math.abs(prev.operating_cash_flow) * 100) : null;
  var grossMargin = (latest.gross_profit && latest.revenue) ? (latest.gross_profit / latest.revenue * 100) : null;
  var netMargin = (latest.net_income && latest.revenue) ? (latest.net_income / latest.revenue * 100) : null;
  var ocfNiRatio = (latest.operating_cash_flow && latest.net_income) ? (latest.operating_cash_flow / latest.net_income) : null;
  var debtRatio = (latest.total_liabilities && latest.total_assets) ? (latest.total_liabilities / latest.total_assets * 100) : null;

  function growthTag(g) {
    if (g == null) return '';
    var cls = g >= 0 ? 'up' : 'down';
    return '<span class="metric-sub ' + cls + '">' + (g >= 0 ? '+' : '') + g.toFixed(1) + '% YoY</span>';
  }

  var cards = [
    { label: '营业收入', value: fmtCNY(latest.revenue), sub: growthTag(revGrowth) },
    { label: '归母净利润', value: fmtCNY(latest.net_income), sub: growthTag(niGrowth) },
    { label: '经营现金流', value: fmtCNY(latest.operating_cash_flow), sub: growthTag(ocfGrowth) },
    { label: '毛利率', value: grossMargin != null ? grossMargin.toFixed(2) + '%' : '--', sub: '' },
    { label: '净利率', value: netMargin != null ? netMargin.toFixed(2) + '%' : '--', sub: '' },
    { label: 'OCF/净利润', value: ocfNiRatio != null ? ocfNiRatio.toFixed(2) + 'x' : '--', sub: ocfNiRatio != null && ocfNiRatio < 0.5 ? '<span class="metric-sub down">低于0.5</span>' : '' },
    { label: '资产负债率', value: debtRatio != null ? debtRatio.toFixed(1) + '%' : '--', sub: '' },
    { label: '最新报告', value: fmtPeriod(items[0].period_end) || (items[0].year || '--'), sub: '' },
  ];

  grid.innerHTML = cards.map(function(c) {
    return '<div class="fa-metric-card"><div class="metric-label">' + c.label + '</div><div class="metric-value">' + c.value + '</div>' + c.sub + '</div>';
  }).join('');
}

function buildChart(financials) {
  if (!financials) return;
  var fin = financials.data || financials;
  var rows = fin.data || (Array.isArray(fin) ? fin : []);
  var seen = {}, items = [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var yr = r.year || r.period_end || '';
    if (!seen[yr] && r.revenue) { seen[yr] = true; items.push(r); }
  }
  items.sort(function(a, b) { return (a.year || '') - (b.year || ''); });
  if (items.length === 0) return;

  var years = items.map(function(r) { return fmtPeriod(r.period_end) || (r.year || ''); });
  var revenues = items.map(function(r) { return (r.revenue || 0) / 1e8; });
  var netIncomes = items.map(function(r) { return (r.net_income || 0) / 1e8; });

  var dom = el('faChart');
  if (!dom) return;
  if (faChart) faChart.dispose();
  faChart = echarts.init(dom);
  faChart.setOption({
    tooltip: { trigger: 'axis', backgroundColor: '#fff', borderColor: '#d3d3d3', textStyle: { color: '#36454f', fontSize: 12 } },
    legend: { data: ['营业收入(亿)', '净利润(亿)'], bottom: 0, textStyle: { color: '#708090', fontSize: 12 } },
    grid: { left: 70, right: 30, top: 20, bottom: 40 },
    xAxis: { type: 'category', data: years, axisLabel: { color: '#708090', fontSize: 12 }, axisLine: { lineStyle: { color: '#d3d3d3' } }, axisTick: { show: false } },
    yAxis: { type: 'value', splitLine: { lineStyle: { color: '#f0f0f0' } }, axisLabel: { color: '#708090', fontSize: 11, formatter: function(v) { return v + '亿'; } } },
    series: [
      { name: '营业收入(亿)', type: 'bar', data: revenues, itemStyle: { color: '#36454f', borderRadius: [4,4,0,0] }, barMaxWidth: 40 },
      { name: '净利润(亿)', type: 'line', data: netIncomes, smooth: true, symbol: 'circle', symbolSize: 8, lineStyle: { width: 2, color: '#708090' }, itemStyle: { color: '#708090' } },
    ],
  });
}

function buildRatioTable(financials) {
  if (!financials) { el('faRatioTable').innerHTML = '<tr><td>暂无数据</td></tr>'; return; }
  var fin = financials.data || financials;
  var rows = fin.data || (Array.isArray(fin) ? fin : []);
  var seen = {}, items = [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var yr = r.year || r.period_end || '';
    if (!seen[yr] && r.revenue) { seen[yr] = true; items.push(r); }
  }
  items.sort(function(a, b) { return (b.year || '') - (a.year || ''); });
  if (items.length === 0) { el('faRatioTable').innerHTML = '<tr><td>暂无数据</td></tr>'; return; }

  var headers = ['报告期', '毛利率', '净利率', 'OCF/净利润', '资产负债率', '营收增速', '净利增速'];
  var body = '';
  for (var i = 0; i < items.length; i++) {
    var r = items[i], prev = items[i+1];
    var gm = (r.gross_profit && r.revenue) ? (r.gross_profit / r.revenue * 100).toFixed(2) + '%' : '--';
    var nm = (r.net_income && r.revenue) ? (r.net_income / r.revenue * 100).toFixed(2) + '%' : '--';
    var on = (r.operating_cash_flow && r.net_income) ? (r.operating_cash_flow / r.net_income).toFixed(2) + 'x' : '--';
    var dr = (r.total_liabilities && r.total_assets) ? (r.total_liabilities / r.total_assets * 100).toFixed(1) + '%' : '--';
    var rg = '--', ng = '--';
    if (prev && prev.revenue && r.revenue) rg = ((r.revenue - prev.revenue) / Math.abs(prev.revenue) * 100).toFixed(1) + '%';
    if (prev && prev.net_income && r.net_income) ng = ((r.net_income - prev.net_income) / Math.abs(prev.net_income) * 100).toFixed(1) + '%';
    body += '<tr><td>' + (fmtPeriod(r.period_end) || r.year || '--') + '</td><td>' + gm + '</td><td>' + nm + '</td><td>' + on + '</td><td>' + dr + '</td><td>' + rg + '</td><td>' + ng + '</td></tr>';
  }
  el('faRatioTable').innerHTML = '<thead><tr>' + headers.map(function(h) { return '<th>' + h + '</th>'; }).join('') + '</tr></thead><tbody>' + body + '</tbody>';
}

function buildNews(newsData) {
  var list = el('faNewsList');
  var nd = newsData.data || newsData;
  var articles = nd.articles || nd.data || [];
  if (!articles.length) { list.innerHTML = '<p style="color:var(--text-secondary);padding:12px;">暂无最新动态</p>'; return; }
  list.innerHTML = articles.slice(0, 3).map(function(a) {
    var d = (a.date || a.published || a.pubDate || '').slice(0, 10);
    return '<div class="fa-news-item"><div class="news-date">' + d + '</div><div class="news-title">' + (a.title || '') + '</div>' + (a.snippet ? '<div class="news-snippet">' + a.snippet + '</div>' : '') + '</div>';
  }).join('');
}

var faCacheIndicator = null; // {code, cachedAt, online}

async function runAnalysis(code, forceRefresh) {
  if (!code) return;
  faCurrentCode = code;
  showLoading();
  el('faReportOutput').classList.remove('show');
  el('faReportOutput').innerHTML = '';
  removeCacheIndicator();

  // Check cache first (unless force refresh) — require at least profile + financials
  if (!forceRefresh) {
    var cached = FinanceCache.get(code);
    if (cached && cached.profile && cached.financials) {
      buildProfile(cached.profile);
      buildMetricCards(cached.financials);
      buildRatioTable(cached.financials);
      buildNews(cached.news);
      showResults();
      setTimeout(function() { buildChart(cached.financials); }, 200);
      showCacheIndicator(code, cached.cachedAt, true);
      return;
    }
  }

  // Fetch from API
  try {
    var results = await Promise.all([
      fetchSA('/profile?identifier=' + encodeURIComponent(code)),
      fetchSA('/financials?identifier=' + encodeURIComponent(code) + '&period=annual&years=3'),
      fetchSA('/stock_news?identifier=' + encodeURIComponent(code) + '&days=30&limit=3'),
    ]);
    // Cache the fetched data
    FinanceCache.set(code, {
      profile: results[0],
      financials: results[1],
      news: results[2],
    });
    buildProfile(results[0]);
    buildMetricCards(results[1]);
    buildRatioTable(results[1]);
    buildNews(results[2]);
    showResults();
    setTimeout(function() { buildChart(results[1]); }, 200);
    showCacheIndicator(code, new Date().toISOString(), false);
  } catch (e) {
    showError('数据获取失败：' + e.message + '。请确认股票代码正确，并确保 Python API 服务已启动。');
  }
}

function showCacheIndicator(code, cachedAt, fromCache) {
  removeCacheIndicator();
  var elm = document.createElement('div');
  elm.id = 'faCacheNote';
  elm.style.cssText = 'max-width:900px;margin:0 auto 16px;text-align:center;font-size:12px;';
  var time = cachedAt.slice(0, 16).replace('T', ' ');
  if (fromCache) {
    elm.innerHTML = '<span style="background:#22c55e18;color:#22c55e;padding:3px 12px;border-radius:10px;">缓存数据 · ' + time + '</span> ' +
      '<button id="faRefreshBtn" style="border:1px solid var(--border);background:transparent;color:var(--text-secondary);padding:3px 12px;border-radius:10px;cursor:pointer;font-size:12px;margin-left:8px;">刷新</button>';
  } else {
    elm.innerHTML = '<span style="background:#f0f0f0;color:var(--text-secondary);padding:3px 12px;border-radius:10px;">实时数据 · ' + time + '</span>';
  }
  var results = el('faResults');
  results.parentNode.insertBefore(elm, results);

  var refreshBtn = elm.querySelector('#faRefreshBtn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', function() {
      runAnalysis(faCurrentCode, true);
    });
  }
}

function removeCacheIndicator() {
  var elm = document.getElementById('faCacheNote');
  if (elm) elm.remove();
}

// ---- DOM-dependent initialization ----
document.addEventListener('DOMContentLoaded', function() {

// Search
el('faBtn').addEventListener('click', function() {
  var code = el('faInput').value.trim();
  if (!code) return;
  runAnalysis(code);
});
el('faInput').addEventListener('keydown', function(e) {
  if (e.key === 'Enter') el('faBtn').click();
});

// Quick tags
document.querySelectorAll('.fa-tag').forEach(function(tag) {
  tag.addEventListener('click', function() {
    el('faInput').value = this.dataset.code;
    runAnalysis(this.dataset.code);
  });
});

// Report generation
el('faReportBtn').addEventListener('click', function() {
  var code = faCurrentCode || el('faInput').value.trim();
  if (!code) { alert('请先输入股票代码并获取数据'); return; }
  var btn = el('faReportBtn');
  btn.disabled = true;
  btn.textContent = '正在调用 Senior Analyst 分析引擎...';

  function buildReportFromData(data) {
    var report = generateReport(code, data);
    var out = el('faReportOutput');
    out.innerHTML = report;
    out.classList.add('show');
    out.scrollIntoView({ behavior: 'smooth' });
  }

  fetch('/api/sa/financials?identifier=' + encodeURIComponent(code) + '&period=annual&years=3')
    .then(function(r) { return r.json(); })
    .then(function(fin) {
      if (!fin.success) throw new Error(fin.error || '数据获取失败');
      return Promise.all([
        fetch('/api/sa/profile?identifier=' + encodeURIComponent(code)).then(function(r) { return r.json(); }),
        fetch('/api/sa/stock_news?identifier=' + encodeURIComponent(code) + '&days=30&limit=3').then(function(r) { return r.json(); }),
      ]).then(function(results) { return { financials: fin, profile: results[0], news: results[1] }; });
    })
    .then(function(data) {
      buildReportFromData(data);
    })
    .catch(function(e) {
      // Fallback to cache
      var cached = FinanceCache.get(code);
      if (cached) {
        buildReportFromData({ financials: cached.financials, profile: cached.profile, news: cached.news });
        cfgToast('已使用离线缓存生成报告');
      } else {
        var out = el('faReportOutput');
        out.innerHTML = '<h2>报告生成受限</h2><p>' + e.message + '</p><p>深度分析报告需要 AI 模型参与。请在 Claude Code 中输入以下命令获取完整报告：</p><blockquote><code>/senior_analyst ' + code + '</code></blockquote>';
        out.classList.add('show');
        out.scrollIntoView({ behavior: 'smooth' });
      }
    })
    .finally(function() {
      btn.disabled = false;
      btn.textContent = '生成深度分析报告';
    });
});

function generateReport(code, data) {
  var fin = data.financials.data || data.financials;
  var prof = data.profile.data || data.profile;
  var rows = fin.data || (Array.isArray(fin) ? fin : []);
  var seen = {}, items = [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var yr = r.year || r.period_end || '';
    if (!seen[yr] && r.revenue) { seen[yr] = true; items.push(r); }
  }
  items.sort(function(a, b) { return (b.year || '') - (a.year || ''); });

  var latest = items[0] || {}, prev = items[1] || {};
  var revGrowth = (prev.revenue && latest.revenue) ? ((latest.revenue - prev.revenue) / Math.abs(prev.revenue) * 100) : null;
  var niGrowth = (prev.net_income && latest.net_income) ? ((latest.net_income - prev.net_income) / Math.abs(prev.net_income) * 100) : null;
  var ocfNi = (latest.operating_cash_flow && latest.net_income) ? (latest.operating_cash_flow / latest.net_income) : null;
  var debtRatio = (latest.total_liabilities && latest.total_assets) ? (latest.total_liabilities / latest.total_assets * 100) : null;
  var grossMargin = (latest.gross_profit && latest.revenue) ? (latest.gross_profit / latest.revenue * 100) : null;
  var netMargin = (latest.net_income && latest.revenue) ? (latest.net_income / latest.revenue * 100) : null;

  function grade(val, thresholds) {
    if (val == null) return 'N/A';
    for (var i = 0; i < thresholds.length; i++) { if (val >= thresholds[i][0]) return thresholds[i][1]; }
    return thresholds[thresholds.length - 1][1];
  }
  var ocfGrade = ocfNi != null ? grade(ocfNi, [[1.5, 'A'], [0.8, 'B'], [-Infinity, 'C']]) : 'N/A';
  var debtGrade = debtRatio != null ? grade(debtRatio, [[100, 'D'], [70, 'C'], [40, 'B'], [-Infinity, 'A']]) : 'N/A';
  var profitGrade = netMargin != null ? grade(netMargin, [[20, 'A'], [10, 'B'], [0, 'C'], [-Infinity, 'D']]) : 'N/A';

  var redFlags = [], greenFlags = [];
  if (ocfNi != null && ocfNi < 0.5) redFlags.push('OCF/净利润=' + ocfNi.toFixed(2) + 'x，低于0.5警戒线');
  if (ocfNi != null && ocfNi >= 1.0) greenFlags.push('OCF/净利润=' + ocfNi.toFixed(2) + 'x，盈利含金量高');
  if (debtRatio != null && debtRatio > 70) redFlags.push('资产负债率=' + debtRatio.toFixed(1) + '%，偏高');
  if (revGrowth != null && revGrowth < 0) redFlags.push('营收同比下滑 ' + revGrowth.toFixed(1) + '%');
  if (niGrowth != null && niGrowth >= 20) greenFlags.push('净利润同比增长 ' + niGrowth.toFixed(1) + '%');
  if (grossMargin != null && grossMargin >= 30) greenFlags.push('毛利率=' + grossMargin.toFixed(1) + '%，产品竞争力强');
  var riskLevel = redFlags.length >= 3 ? '高风险' : redFlags.length >= 1 ? '需关注' : '低风险';

  var html = '<h1>' + (prof.name || code) + '（' + (prof.ticker || code) + '）财报速查报告</h1>';
  html += '<p><em>自动生成于 ' + new Date().toLocaleString('zh-CN') + ' | 数据源：' + (fin.data_source || 'eastmoney') + '</em></p><hr>';
  html += '<h2>一、核心结论</h2>';
  html += '<table><tr><th>维度</th><th>评级</th><th>关键指标</th></tr>';
  html += '<tr><td>日子（现金流）</td><td>' + ocfGrade + '</td><td>OCF/净利润 = ' + (ocfNi != null ? ocfNi.toFixed(2) + 'x' : '--') + '</td></tr>';
  html += '<tr><td>底子（资产负债）</td><td>' + debtGrade + '</td><td>资产负债率 = ' + (debtRatio != null ? debtRatio.toFixed(1) + '%' : '--') + '</td></tr>';
  html += '<tr><td>面子（利润）</td><td>' + profitGrade + '</td><td>净利率 = ' + (netMargin != null ? netMargin.toFixed(1) + '%' : '--') + '</td></tr>';
  html += '</table>';
  html += '<p><strong>综合风险评级：</strong>' + riskLevel + ' | <strong>红旗信号：</strong>' + redFlags.length + ' 个</p>';

  html += '<h2>二、关键财务数据</h2>';
  html += '<table><tr><th>指标</th><th>' + (fmtPeriod(latest.period_end) || latest.year || '最新') + '</th>' + (prev.period_end ? '<th>' + fmtPeriod(prev.period_end) + '</th>' : (prev.year ? '<th>' + prev.year + '</th>' : '')) + '<th>同比</th></tr>';
  html += '<tr><td>营业收入</td><td>' + fmtCNY(latest.revenue) + '</td>' + (prev.year ? '<td>' + fmtCNY(prev.revenue) + '</td>' : '') + '<td>' + (revGrowth != null ? fmtPct(revGrowth) : '--') + '</td></tr>';
  html += '<tr><td>归母净利润</td><td>' + fmtCNY(latest.net_income) + '</td>' + (prev.year ? '<td>' + fmtCNY(prev.net_income) + '</td>' : '') + '<td>' + (niGrowth != null ? fmtPct(niGrowth) : '--') + '</td></tr>';
  html += '<tr><td>经营现金流</td><td>' + fmtCNY(latest.operating_cash_flow) + '</td>' + (prev.year && prev.operating_cash_flow ? '<td>' + fmtCNY(prev.operating_cash_flow) + '</td>' : '<td>--</td>') + '<td>--</td></tr>';
  html += '</table>';

  if (greenFlags.length > 0) {
    html += '<h2>三、亮点</h2><ul>' + greenFlags.map(function(f) { return '<li>' + f + '</li>'; }).join('') + '</ul>';
  }
  if (redFlags.length > 0) {
    html += '<h2>四、风险提示</h2><ul>' + redFlags.map(function(f) { return '<li>' + f + '</li>'; }).join('') + '</ul>';
  }
  html += '<hr><p><strong>提示：</strong>本报告为自动生成的财务速查。如需包含行业对标、勾稽验证、情景分析等深度内容，请在 Claude Code 中运行 <code>/senior_analyst ' + code + '</code> 获取完整分析。</p>';
  return html;
}

// Load default stock on first visit
var faInitialized = false;
document.querySelector('[data-page="financials"]').addEventListener('click', function() {
  if (!faInitialized) { faInitialized = true; }
  renderConfigTags();
});

}); // DOMContentLoaded

// ---- Render config stock tags into financials page ----
function renderConfigTags() {
  var container = document.getElementById('faConfigTags');
  if (!container) return;
  var stocks = StockConfig.getAll();
  if (stocks.length === 0) {
    container.style.display = 'none';
    return;
  }
  container.style.display = 'flex';
  var hint = container.querySelector('.cfg-hint');
  if (!hint) {
    hint = document.createElement('span');
    hint.className = 'cfg-hint';
    hint.style.marginRight = '6px';
    hint.textContent = '我的自选：';
    container.appendChild(hint);
  }
  // Remove old dynamic tags (keep the hint)
  container.querySelectorAll('.fa-tag').forEach(function(t) { t.remove(); });
  stocks.forEach(function(s) {
    var tag = document.createElement('span');
    tag.className = 'fa-tag';
    tag.dataset.code = s.code;
    tag.textContent = s.label || s.code;
    tag.addEventListener('click', function() {
      document.getElementById('faInput').value = this.dataset.code;
      runAnalysis(this.dataset.code);
    });
    container.appendChild(tag);
  });
}
})();
