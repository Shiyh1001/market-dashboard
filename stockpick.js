// ---- AI Stock Picking Engine ----
// Multi-factor quantitative scoring across the full A-share market.
// Fetches stock list from Sina, filters by market/market-cap,
// scores via K-line data, marks watchlist stocks with badge.
// Filters: market, market-cap, sector, detailed industry.

var spState = { results: [], filters: { market: '', sector: '', industry: '', mcap: '100' }, running: false };

// ---- Screen Result Cache ----
// K-line data only changes daily after market close, so cache by date+market+mcap.

var SP_CACHE_KEY = 'sp_screen_cache';

function getScreenCache(market, mcap) {
  try {
    var entry = JSON.parse(localStorage.getItem(SP_CACHE_KEY));
    if (!entry) return null;
    var today = new Date().toISOString().slice(0, 10);
    if (entry.date !== today) return null;
    if (entry.market !== market || entry.mcap !== mcap) return null;
    return entry;
  } catch (e) { return null; }
}

function setScreenCache(market, mcap, results) {
  try {
    localStorage.setItem(SP_CACHE_KEY, JSON.stringify({
      date: new Date().toISOString().slice(0, 10),
      market: market, mcap: mcap,
      results: results,
      cachedAt: new Date().toISOString(),
    }));
  } catch (e) { /* ignore */ }
}

// ========================
// Helpers
// ========================

function calcSMA_sp(arr, period) {
  var result = [];
  for (var i = 0; i < arr.length; i++) {
    if (i < period - 1) { result.push(null); continue; }
    var sum = 0;
    for (var j = 0; j < period; j++) sum += arr[i - j];
    result.push(sum / period);
  }
  return result;
}

function stddev(arr, start, end, mean) {
  var sumSq = 0, count = 0;
  for (var i = start; i <= end; i++) {
    if (arr[i] == null) continue;
    sumSq += Math.pow(arr[i] - mean, 2);
    count++;
  }
  return count > 0 ? Math.sqrt(sumSq / count) : 0;
}

// ========================
// Scoring Factors (10)
// ========================

function scoreLimitUpDown(bars, i) {
  if (i < 1) return 0;
  var prevClose = bars[i - 1].close;
  var todayClose = bars[i].close;
  if (prevClose <= 0) return 0;
  var changePct = ((todayClose - prevClose) / prevClose) * 100;
  if (changePct >= 9.5) return 35;
  if (changePct >= 7.0) return 20;
  if (changePct <= -9.5) return -40;
  if (changePct <= -7.0) return -25;
  return 0;
}

function scoreGap(bars, i) {
  if (i < 1) return 0;
  var prevClose = bars[i - 1].close;
  var todayOpen = bars[i].open;
  if (prevClose <= 0) return 0;
  var gapPct = ((todayOpen - prevClose) / prevClose) * 100;
  if (gapPct > 1.0) return 15;
  if (gapPct < -1.0) return -20;
  if (gapPct >= 0.5) return 10;
  if (gapPct <= -0.5) return -10;
  return 0;
}

function scoreOversoldBounce(bars, i) {
  if (i < 4) return 0;
  var declining3 = true;
  if (bars[i - 2].close >= bars[i - 3].close) declining3 = false;
  if (bars[i - 1].close >= bars[i - 2].close) declining3 = false;
  var todayUp = bars[i].close > bars[i - 1].close;
  if (declining3 && todayUp) return 15;
  if (declining3 && !todayUp) return -20;
  return 0;
}

function scoreVolumePrice(bars, i) {
  if (i < 5) return 0;
  var todayVol = bars[i].volume;
  var sum5 = 0, count = 0;
  for (var j = i - 5; j < i; j++) {
    if (bars[j].volume > 0) { sum5 += bars[j].volume; count++; }
  }
  if (count === 0) return 0;
  var avgVol5 = sum5 / count;
  var volRatio = todayVol / avgVol5;
  var priceUp = bars[i].close > bars[i - 1].close;
  if (volRatio > 1.5 && priceUp) return 20;
  if (volRatio < 0.7 && priceUp) return 10;
  if (volRatio > 1.5 && !priceUp) return -25;
  if (volRatio < 0.7 && !priceUp) return -10;
  return 0;
}

function scoreMAPosition(bars, i) {
  var closes = bars.map(function(d) { return d.close; });
  var ma5 = i >= 4 ? calcSMA_sp(closes, 5)[i] : null;
  var ma10 = i >= 9 ? calcSMA_sp(closes, 10)[i] : null;
  var ma20 = i >= 19 ? calcSMA_sp(closes, 20)[i] : null;
  var ma60 = i >= 59 ? calcSMA_sp(closes, 60)[i] : null;
  var close = bars[i].close;
  var score = 0;
  if (ma5 !== null && close > ma5) score += 5;
  if (ma10 !== null && close > ma10) score += 5;
  if (ma20 !== null && close > ma20) score += 5;
  if (ma60 !== null && close > ma60) score += 5;
  if (ma5 !== null && ma10 !== null && ma20 !== null &&
      ma5 > ma10 && ma10 > ma20 && close > ma5) {
    score += 5;
  }
  return Math.min(score, 20);
}

function scoreCandlestick(bars, i) {
  if (i < 1) return 0;
  var o = bars[i].open, c = bars[i].close, h = bars[i].high, l = bars[i].low;
  var body = Math.abs(c - o);
  var upperShadow = h - Math.max(c, o);
  var lowerShadow = Math.min(c, o) - l;
  var totalRange = h - l;
  if (totalRange <= 0) return 0;
  if (lowerShadow > 2 * body && body > 0 && lowerShadow > 0.3 * totalRange && upperShadow < 0.1 * totalRange)
    return 10;
  if (upperShadow > 2 * body && body > 0 && upperShadow > 0.3 * totalRange && lowerShadow < 0.1 * totalRange)
    return -10;
  var yo = bars[i - 1].open, yc = bars[i - 1].close;
  if (c > o && yc < yo && o <= yc && c >= yo) return 15;
  if (c < o && yc > yo && o >= yc && c <= yo) return -15;
  return 0;
}

function scoreConsecutive(bars, i) {
  if (i < 1) return 0;
  var upCount = 0, downCount = 0;
  for (var j = i; j >= 1; j--) {
    if (bars[j].close > bars[j - 1].close) upCount++;
    else break;
  }
  for (var j = i; j >= 1; j--) {
    if (bars[j].close < bars[j - 1].close) downCount++;
    else break;
  }
  if (upCount >= 5) return 15;
  if (upCount >= 3) return 10;
  if (downCount >= 5) return -15;
  if (downCount >= 3) return -10;
  return 0;
}

function scoreBreakout(bars, i) {
  if (i < 20) return 0;
  var close = bars[i].close;
  var high20 = -Infinity;
  for (var j = i - 20; j < i; j++) {
    if (bars[j].high > high20) high20 = bars[j].high;
  }
  var breakout20 = close > high20;
  var closes = bars.map(function(d) { return d.close; });
  var ma20Arr = calcSMA_sp(closes, 20);
  var ma20val = ma20Arr[i];
  var bollBreak = false;
  if (ma20val !== null && i >= 19) {
    var sd = stddev(closes, i - 19, i, ma20val);
    bollBreak = close > (ma20val + 2 * sd);
  }
  if (breakout20 && bollBreak) return 15;
  if (breakout20) return 10;
  if (bollBreak) return 5;
  return 0;
}

function scoreVolumeRatio(bars, i) {
  if (i < 5) return 0;
  var sum5 = 0, count = 0;
  for (var j = i - 4; j <= i; j++) {
    if (bars[j].volume > 0) { sum5 += bars[j].volume; count++; }
  }
  if (count === 0) return 0;
  var avgVol = sum5 / count;
  var volRatio = bars[i].volume / avgVol;
  var priceUp = bars[i].close > bars[i - 1].close;
  if (volRatio > 2.0 && priceUp) return 10;
  if (volRatio > 2.0 && !priceUp) return -10;
  if (volRatio < 0.5) return -5;
  return 0;
}

function scoreAmplitude(bars, i) {
  if (i < 1) return 0;
  var prevClose = bars[i - 1].close;
  if (prevClose <= 0) return 0;
  var amplitude = ((bars[i].high - bars[i].low) / prevClose) * 100;
  if (amplitude > 10) return -10;
  if (amplitude >= 5) return 5;
  if (amplitude < 2) return -5;
  return 0;
}

// ========================
// Master Scoring
// ========================

function scoreStock(klineData) {
  if (!Array.isArray(klineData) || klineData.length < 10) return null;
  var i = klineData.length - 1;
  var factors = [
    { name: '涨跌停检测', key: 'limit',    score: scoreLimitUpDown(klineData, i) },
    { name: '跳空缺口',   key: 'gap',      score: scoreGap(klineData, i) },
    { name: '超跌反弹',   key: 'oversold', score: scoreOversoldBounce(klineData, i) },
    { name: '量价配合',   key: 'volprice', score: scoreVolumePrice(klineData, i) },
    { name: '均线位置',   key: 'ma',       score: scoreMAPosition(klineData, i) },
    { name: 'K线形态',    key: 'candle',   score: scoreCandlestick(klineData, i) },
    { name: '连涨连跌',   key: 'consec',   score: scoreConsecutive(klineData, i) },
    { name: '突破信号',   key: 'breakout', score: scoreBreakout(klineData, i) },
    { name: '量比',       key: 'volratio', score: scoreVolumeRatio(klineData, i) },
    { name: '振幅',       key: 'amplitude',score: scoreAmplitude(klineData, i) },
  ];
  var total = 0;
  for (var f = 0; f < factors.length; f++) total += factors[f].score;
  var grade;
  if (total >= 80) grade = 'S';
  else if (total >= 50) grade = 'A';
  else if (total >= 20) grade = 'B';
  else grade = 'C';
  var positives = factors.filter(function(f) { return f.score > 0; })
    .sort(function(a, b) { return b.score - a.score; })
    .slice(0, 3);
  var negatives = factors.filter(function(f) { return f.score < 0; })
    .sort(function(a, b) { return a.score - b.score; })
    .slice(0, 2);
  return {
    total: total, factors: factors, grade: grade,
    topPositives: positives, topNegatives: negatives,
    lastDate: klineData[i].day, lastClose: klineData[i].close,
  };
}

// ========================
// Sector Mapping
// ========================

var SECTOR_MAP = {
  '金融': ['银行', '保险', '证券', '金融', '资本', '信托', '基金', '期货'],
  '科技': ['计算机', '软件', '通信', '电子', '半导体', '互联网', '信息技术', '芯片', '人工智能', '大数据', '数据'],
  '消费': ['食品', '饮料', '酒', '零售', '纺织', '服装', '家电', '日化', '旅游', '餐饮', '酒店', '免税'],
  '医药': ['医药', '医疗', '生物', '制药', '器械', '健康', '疫苗', '基因', '中药'],
  '制造': ['汽车', '机械', '设备', '电气', '仪器', '军工', '航天', '船舶', '高铁', '工程机械', '飞机'],
  '能源': ['石油', '煤炭', '电力', '能源', '光伏', '锂电', '风电', '储能', '核电', '天然气', '氢能', '太阳能'],
  '材料': ['钢铁', '有色', '化工', '建材', '稀土', '塑料', '化学', '水泥', '玻璃', '新材料'],
  '地产': ['房地产', '建筑', '基建', '装修', '园区', '物业', '家居'],
  '交通': ['交通', '物流', '航空', '港口', '铁路', '高速', '机场', '航运', '快递'],
  '传媒': ['传媒', '广告', '游戏', '影视', '出版', '体育', '动漫', '直播', '短视频'],
  '农业': ['农业', '畜牧', '渔业', '林业', '种业', '饲料', '养殖'],
};

function mapIndustryToSector(industryStr) {
  if (!industryStr) return '其他';
  for (var sector in SECTOR_MAP) {
    var keywords = SECTOR_MAP[sector];
    for (var k = 0; k < keywords.length; k++) {
      if (industryStr.indexOf(keywords[k]) !== -1) return sector;
    }
  }
  return '其他';
}

// ========================
// Stock List Fetching
// ========================

var STOCK_LIST_CACHE_KEY = 'sp_stock_list_cache';
var STOCK_LIST_CACHE_TTL = 86400000; // 1 day

function getCachedStockList() {
  try {
    var entry = JSON.parse(localStorage.getItem(STOCK_LIST_CACHE_KEY));
    if (entry && (Date.now() - entry.ts) < STOCK_LIST_CACHE_TTL) {
      return entry.data;
    }
  } catch (e) { /* ignore */ }
  return null;
}

function setCachedStockList(data) {
  try {
    localStorage.setItem(STOCK_LIST_CACHE_KEY, JSON.stringify({ ts: Date.now(), data: data }));
  } catch (e) { /* ignore */ }
}

var STOCK_LIST_NODES = ['hs_a', 'etf_fund_dz'];

async function fetchStockListPage(page, num, node) {
  var resp = await fetch('/api/stock_list?page=' + page + '&num=' + num + '&sort=symbol&asc=1&node=' + (node || 'hs_a'));
  if (!resp.ok) return [];
  return await resp.json();
}

async function fetchStockListForNode(node, onProgress) {
  var allStocks = [];
  var page = 1, num = 100, emptyPages = 0;

  while (emptyPages < 2) {
    var pageData = await fetchStockListPage(page, num, node);
    if (!Array.isArray(pageData) || pageData.length === 0) {
      emptyPages++;
      page++;
      continue;
    }
    emptyPages = 0;
    for (var i = 0; i < pageData.length; i++) {
      allStocks.push(pageData[i]);
    }
    if (onProgress) onProgress('正在获取 ' + (node === 'hs_a' ? 'A股' : 'ETF') + ' 列表 第' + page + '页...', allStocks.length);
    page++;
  }

  return allStocks;
}

async function fetchAllStockList(onProgress) {
  var cached = getCachedStockList();
  if (cached) {
    if (onProgress) onProgress('已加载缓存', cached.length);
    return cached;
  }

  var allStocks = [];
  for (var n = 0; n < STOCK_LIST_NODES.length; n++) {
    var nodeStocks = await fetchStockListForNode(STOCK_LIST_NODES[n], onProgress);
    for (var i = 0; i < nodeStocks.length; i++) {
      allStocks.push(nodeStocks[i]);
    }
  }

  setCachedStockList(allStocks);
  return allStocks;
}

// ========================
// UI State Management
// ========================

function setSPState(state, errorMsg) {
  document.getElementById('spLoading').style.display = state === 'loading' ? 'block' : 'none';
  document.getElementById('spError').style.display = state === 'error' ? 'block' : 'none';
  document.getElementById('spEmpty').style.display = state === 'empty' ? 'block' : 'none';
  document.getElementById('spResults').style.display = state === 'done' ? 'block' : 'none';
  if (state === 'error') {
    document.getElementById('spError').textContent = errorMsg;
  }
  if (state === 'empty') {
    document.getElementById('spCount').textContent = '';
  }
}

function updateProgress(pct, text) {
  document.getElementById('spProgressBar').style.width = Math.min(100, Math.max(0, pct)) + '%';
  if (text) document.getElementById('spProgressText').textContent = text;
}

// ========================
// Table Rendering
// ========================

function formatNumSP(v) {
  if (v == null || isNaN(v)) return '--';
  if (Math.abs(v) >= 1e8) return (v / 1e8).toFixed(2) + '亿';
  return v.toFixed ? v.toFixed(2) : v;
}

function formatMktcap(v) {
  if (v == null || isNaN(v) || v <= 0) return '--';
  // v is in 万元 from Sina API
  var yi = v / 10000; // convert to 亿
  if (yi >= 1) return yi.toFixed(0) + '亿';
  return (yi * 10000).toFixed(0) + '万';
}

function renderResultsTable(results, limit) {
  var tbody = document.getElementById('spTableBody');
  if (results.length === 0) {
    tbody.innerHTML = '<tr><td colspan="12" style="text-align:center;padding:32px;color:var(--text-secondary);">无符合条件的股票</td></tr>';
    document.getElementById('spMoreRow').style.display = 'none';
    return;
  }

  var show = limit ? results.slice(0, limit) : results;
  tbody.innerHTML = show.map(function(r, idx) {
    var totalCls = r.total > 0 ? 'sp-score-pos' : (r.total < 0 ? 'sp-score-neg' : 'sp-score-zero');
    var chgCls = r.changePct >= 0 ? 'up' : 'down';
    var chgSign = r.changePct >= 0 ? '+' : '';

    // Factor column: first tag visible, rest in hover tooltip
    var positives = r.topPositives;
    var factorHtml = '--';
    if (positives.length > 0) {
      factorHtml = '<span class="sp-pos">' + esc(positives[0].name) + '+' + positives[0].score + '</span>';
      if (positives.length > 1) {
        factorHtml += ' <span class="sp-factor-more">+' + (positives.length - 1) + '</span>';
        var allTags = positives.map(function(f) {
          return '<span class="sp-pos">' + esc(f.name) + '+' + f.score + '</span>';
        }).join(' ');
        factorHtml += '<span class="sp-factor-tip">' + allTags + '</span>';
      }
    }

    var watchBadge = r.inWatchlist ? ' <span style="display:inline-block;background:#fef2f2;color:#dc2626;font-size:10px;font-weight:700;padding:1px 5px;border-radius:3px;vertical-align:middle;">★自选</span>' : '';

    var addBtn = r.inWatchlist
      ? '<span style="font-size:11px;color:var(--text-secondary);">已自选</span>'
      : '<button class="sp-add-wl-btn" data-code="' + esc(r.code) + '" data-name="' + esc(r.name) + '">添加自选</button>';

    return '<tr>' +
      '<td>' + (idx + 1) + '</td>' +
      '<td style="font-family:monospace;font-weight:600;">' + esc(r.code) + '</td>' +
      '<td>' + esc(r.name) + watchBadge + '</td>' +
      '<td>' + formatNumSP(r.price) + '</td>' +
      '<td class="' + chgCls + '">' + chgSign + r.changePct.toFixed(2) + '%</td>' +
      '<td>' + formatMktcap(r.mktcap) + '</td>' +
      '<td class="' + totalCls + '" style="font-weight:700;font-size:15px;">' + r.total + '</td>' +
      '<td><span class="sp-grade sp-grade-' + r.grade + '">' + r.grade + '级</span></td>' +
      '<td title="' + esc(r.sector) + '">' + esc(r.sector) + '</td>' +
      '<td title="' + esc(r.industry || '') + '">' + esc(r.industry || '--') + '</td>' +
      '<td><div class="sp-factor-cell">' + factorHtml + '</div></td>' +
      '<td>' + addBtn + '</td>' +
      '</tr>';
  }).join('');

  // More/less toggle
  var hasMore = limit && results.length > limit;
  var moreRow = document.getElementById('spMoreRow');
  if (hasMore) {
    moreRow.style.display = '';
    document.getElementById('spResultsTitle').textContent = '评分结果 (显示前' + limit + ' / 共 ' + results.length + ' 只)';
  } else {
    moreRow.style.display = 'none';
    document.getElementById('spResultsTitle').textContent = '评分结果 (共 ' + results.length + ' 只)';
  }
}

var spDisplayLimit = 50;
var spShowAll = false;

function spToggleMore() {
  spShowAll = !spShowAll;
  var filtered = applyFilters();
  var limit = spShowAll ? 0 : spDisplayLimit;
  renderResultsTable(filtered, limit);
  document.getElementById('spMoreBtn').textContent = spShowAll ? '收起' : '显示全部 (' + filtered.length + ' 只)';
}

// ========================
// Filter Logic
// ========================

function applyFilters() {
  var f = spState.filters;
  return spState.results.filter(function(r) {
    if (f.market && r.market !== f.market) return false;
    if (f.sector && r.sector !== f.sector) return false;
    if (f.industry && r.industry !== f.industry) return false;
    return true;
  });
}

function updateIndustryFilters(filteredResults) {
  var industries = {};
  for (var i = 0; i < filteredResults.length; i++) {
    var ind = filteredResults[i].industry;
    if (ind) industries[ind] = true;
  }
  var indList = Object.keys(industries).sort();
  var list = document.getElementById('spIndustryList');
  var html = '';
  for (var j = 0; j < indList.length; j++) {
    var act = spState.filters.industry === indList[j] ? ' active' : '';
    html += '<span class="sp-filter' + act + '" data-fkey="industry" data-fval="' + esc(indList[j]) + '">' + esc(indList[j]) + '</span>';
  }
  list.innerHTML = html;
}

function applyFiltersAndRender() {
  var filtered = applyFilters();
  spShowAll = false;
  updateIndustryFilters(filtered);
  renderResultsTable(filtered, spDisplayLimit);
  document.getElementById('spCount').textContent = '符合条件的股票: ' + filtered.length + ' 只';
  setSPState('done', '');
}

// ========================
// Main Flow
// ========================

async function runScreen() {
  if (spState.running) return;
  spState.running = true;

  var btn = document.getElementById('spRunBtn');
  btn.disabled = true;
  btn.textContent = '筛选中...';

  setSPState('loading', '');
  document.getElementById('spCount').textContent = '';

  try {
    var f = spState.filters;

    // ---- Cache check ----
    var cached = getScreenCache(f.market, f.mcap);
    if (cached && cached.results && cached.results.length > 0) {
      spState.results = cached.results;
      spState.filters.sector = '';
      spState.filters.industry = '';
      _collapseIndustry();
      applyFiltersAndRender();
      document.getElementById('spCount').textContent = '符合条件的股票: ' + applyFilters().length + ' 只（缓存 · ' + cached.cachedAt.slice(11, 16) + '）';
      setSPState('done', '');
      updateProgress(100, '已加载缓存结果 (' + cached.results.length + ' 只)');
      btn.disabled = false;
      btn.textContent = '开始筛选';
      spState.running = false;
      return;
    }

    // ---- Phase 1: Fetch stock list ----
    updateProgress(5, '正在加载A股股票列表...');
    var allStocks = await fetchAllStockList(function(msg, count) {
      updateProgress(5 + Math.min(15, count / 200), msg);
    });

    if (allStocks.length === 0) {
      setSPState('error', '无法获取股票列表，请稍后重试');
      spState.running = false;
      btn.disabled = false;
      btn.textContent = '开始筛选';
      return;
    }

    // ---- Phase 2: Filter by market and market cap ----
    var f = spState.filters;
    var mcapMin = parseFloat(f.mcap) || 0; // in 亿
    var mcapMinWan = mcapMin * 10000; // convert 亿 to 万元 (API unit)

    var watchlistCodes = {};
    var wlStocks = StockConfig.getAll();
    for (var wi = 0; wi < wlStocks.length; wi++) {
      watchlistCodes[wlStocks[wi].code.toUpperCase()] = true;
    }

    var pool = [];
    for (var si = 0; si < allStocks.length; si++) {
      var s = allStocks[si];
      var code = s.code;
      var symbol = s.symbol || '';

      // Market filter
      var market = '';
      if (symbol.startsWith('sh')) market = 'SH';
      else if (symbol.startsWith('sz')) market = 'SZ';
      else continue; // skip BJ/HK/others

      if (f.market && market !== f.market) continue;

      // Market cap filter (mktcap in 万元)
      var mktcap = parseFloat(s.mktcap) || 0;
      if (mcapMinWan > 0 && mktcap < mcapMinWan) continue;

      // Parse price
      var price = parseFloat(s.trade) || 0;
      var changePct = parseFloat(s.changepercent) || 0;

      pool.push({
        code: code,
        symbol: symbol,
        name: s.name || '',
        price: price,
        changePct: changePct,
        mktcap: mktcap,
        market: market,
        inWatchlist: !!watchlistCodes[code],
      });
    }

    // Sort by market cap descending for priority scoring
    pool.sort(function(a, b) { return b.mktcap - a.mktcap; });

    updateProgress(20, '待评分股票: ' + pool.length + ' 只 (市值 >' + (mcapMin > 0 ? mcapMin + '亿' : '0') + ')');

    // ---- Phase 3: Score stocks in concurrent batches ----
    var BATCH = 5;
    var results = [];
    var done = 0, failed = 0;
    var totalPool = pool.length;

    for (var bi = 0; bi < pool.length; bi += BATCH) {
      var batch = pool.slice(bi, Math.min(bi + BATCH, pool.length));

      // Concurrent K-line + profile fetch + score for this batch
      var batchResults = await Promise.all(batch.map(async function(stock) {
        try {
          // Fetch K-line and profile in parallel
          var cached = FinanceCache.get(stock.code);
          var hasProfile = cached && cached.profile;

          var fetches = [fetch('/api/kline?code=' + encodeURIComponent(stock.code) + '&scale=240')];
          if (!hasProfile) {
            fetches.push(fetch('/api/sa/profile?identifier=' + encodeURIComponent(stock.code)));
          }

          var responses = await Promise.all(fetches);
          var klineResp = responses[0];
          var profileResp = responses.length > 1 ? responses[1] : null;

          if (!klineResp.ok) return null;
          var klineData = await klineResp.json();
          if (!Array.isArray(klineData) || klineData.length < 10) return null;
          var scored = scoreStock(klineData);
          if (!scored) return null;

          // Get industry from cache or freshly fetched profile
          var industry = '';
          if (hasProfile) {
            var pdata = cached.profile.data || cached.profile;
            industry = pdata.industry || '';
          } else if (profileResp && profileResp.ok) {
            try {
              var profileData = await profileResp.json();
              var existing = FinanceCache.get(stock.code) || {};
              FinanceCache.set(stock.code, { profile: profileData, financials: existing.financials || null, news: existing.news || null });
              var pdata = profileData.data || profileData;
              industry = pdata.industry || '';
            } catch (e) { /* ignore parse errors */ }
          }

          return {
            code: stock.code,
            name: stock.name,
            market: stock.market,
            price: stock.price,
            changePct: stock.changePct,
            mktcap: stock.mktcap,
            total: scored.total,
            grade: scored.grade,
            factors: scored.factors,
            topPositives: scored.topPositives,
            topNegatives: scored.topNegatives,
            sector: mapIndustryToSector(industry),
            industry: industry,
            inWatchlist: stock.inWatchlist,
          };
        } catch (e) {
          return null;
        }
      }));

      for (var ri = 0; ri < batchResults.length; ri++) {
        if (batchResults[ri]) results.push(batchResults[ri]);
        else failed++;
        done++;
      }

      var pct = 20 + Math.round((done / totalPool) * 70);
      updateProgress(pct, '评分中 ' + done + '/' + totalPool + ' (' + results.length + ' 成功, ' + failed + ' 失败)');
    }

    // Sort by total score descending
    results.sort(function(a, b) { return b.total - a.total; });
    spState.results = results;

    // Save to cache
    setScreenCache(f.market, f.mcap, results);

    updateProgress(100, '评分完成: ' + results.length + ' 只, 失败 ' + failed);

    // Reset secondary filters (sector/industry — keep market/mcap)
    spState.filters.sector = '';
    spState.filters.industry = '';
    _collapseIndustry();
    // Update UI to reflect
    var sectorGroup = document.querySelector('.sp-filter-group:nth-child(3)');
    if (sectorGroup) {
      sectorGroup.querySelectorAll('.sp-filter').forEach(function(x) { x.classList.remove('active'); });
      var firstSector = sectorGroup.querySelector('.sp-filter[data-fval=""]');
      if (firstSector) firstSector.classList.add('active');
    }
    var indGroup = document.getElementById('spIndustryGroup');
    indGroup.querySelectorAll('.sp-filter').forEach(function(x) { x.classList.remove('active'); });
    var firstInd = indGroup.querySelector('.sp-filter[data-fval=""]');
    if (firstInd) firstInd.classList.add('active');

    applyFiltersAndRender();

  } catch (e) {
    setSPState('error', '数据加载失败: ' + e.message);
  }

  btn.disabled = false;
  btn.textContent = '开始筛选';
  spState.running = false;
}

// ========================
// Event Wiring
// ========================

var spInitialized = false;

function initAIPick() {
  if (spInitialized) return;
  spInitialized = true;

  // Industry filter toggle
  var indToggle = document.getElementById('spIndustryToggle');
  var indListEl = document.getElementById('spIndustryList');
  var indOpen = false;

  window._collapseIndustry = function() {
    indOpen = false;
    indListEl.style.display = 'none';
    indToggle.textContent = '行业 ▸';
  };

  indToggle.addEventListener('click', function(e) {
    e.stopPropagation();
    indOpen = !indOpen;
    indListEl.style.display = indOpen ? 'inline-flex' : 'none';
    indToggle.textContent = indOpen ? '行业 ▾' : '行业 ▸';
  });

  // Scoring guide toggle
  var guideTrigger = document.getElementById('spGuideTrigger');
  var guideDropdown = document.getElementById('spGuideDropdown');
  guideTrigger.addEventListener('click', function(e) {
    e.stopPropagation();
    guideDropdown.classList.toggle('show');
  });
  document.addEventListener('click', function() {
    guideDropdown.classList.remove('show');
  });

  // Show more toggle
  document.getElementById('spMoreBtn').addEventListener('click', spToggleMore);

  // Run button
  document.getElementById('spRunBtn').addEventListener('click', runScreen);

  // Filter bar - event delegation
  document.querySelector('.sp-filter-bar').addEventListener('click', function(e) {
    var target = e.target;
    if (!target.classList.contains('sp-filter')) return;

    var fkey = target.dataset.fkey;
    var fval = target.dataset.fval;

    // Update active state in the same group
    var group = target.parentElement;
    group.querySelectorAll('.sp-filter').forEach(function(x) { x.classList.remove('active'); });
    target.classList.add('active');

    // If changing sector, reset industry filter
    if (fkey === 'sector') {
      spState.filters.industry = '';
      _collapseIndustry();
    }

    // Store filter value
    spState.filters[fkey] = fval;

    // For market/mcap changes, need to re-run the entire screen
    // For sector/industry, just re-filter existing results
    if (fkey === 'market' || fkey === 'mcap') {
      // Don't auto re-run — user clicks button to re-screen
    } else if (spState.results.length > 0) {
      applyFiltersAndRender();
    }
  });

  // Table body - add-to-watchlist delegation
  document.getElementById('spTableBody').addEventListener('click', function(e) {
    var target = e.target;
    if (!target.classList.contains('sp-add-wl-btn')) return;
    var code = target.dataset.code;
    var name = target.dataset.name;
    var ok = StockConfig.add(code, name);
    if (ok) {
      // Update spState.results to mark this stock as in-watchlist
      for (var i = 0; i < spState.results.length; i++) {
        if (spState.results[i].code === code) {
          spState.results[i].inWatchlist = true;
          break;
        }
      }
      applyFiltersAndRender();
      cfgToast('已添加自选: ' + code + ' ' + name);
    } else {
      cfgToast(code + ' 已在自选列表中');
    }
  });

  // Navigation - handle first visit
  document.querySelector('[data-page="aipick"]').addEventListener('click', function() {
    // Show hint if no results yet
    if (spState.results.length === 0 && !spState.running) {
      document.getElementById('spCount').textContent = '';
      document.getElementById('spEmpty').style.display = 'block';
    }
  });
}

// On DOM ready
document.addEventListener('DOMContentLoaded', function() {
  initAIPick();
});
