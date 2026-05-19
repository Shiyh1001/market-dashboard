(function() {
// ---- Technical Analysis Engine ----
// Computes MACD, RSI, KDJ, BOLL, and MAs from daily K-line data.
// Renders multi-grid ECharts chart and signal summary cards.

var taChart = null;
var taCurrentCode = null;
var taCurrentData = null;
var taCurrentResults = null;

// ========================
// Indicator Calculations
// ========================

function calcEMAFromExisting(data, period) {
  // data may contain nulls; compute EMA skipping them
  var k = 2 / (period + 1);
  var result = [];
  // Seed: first 'period' non-null values
  var validVals = [];
  for (var i = 0; i < data.length; i++) {
    if (data[i] != null) validVals.push({ idx: i, val: data[i] });
  }
  if (validVals.length < period) {
    for (var i = 0; i < data.length; i++) result.push(null);
    return result;
  }
  // Seed with SMA of first 'period' non-null values
  var seedEndIdx = validVals[period - 1].idx;
  var seedSum = 0;
  for (var j = 0; j < period; j++) seedSum += validVals[j].val;
  var seedVal = seedSum / period;

  for (var i = 0; i < data.length; i++) {
    if (data[i] == null) {
      result.push(null);
    } else if (i === seedEndIdx) {
      result.push(seedVal);
    } else if (i < seedEndIdx) {
      result.push(null);
    } else {
      var prev = null;
      for (var j = i - 1; j >= 0; j--) {
        if (result[j] != null) { prev = result[j]; break; }
      }
      if (prev != null) {
        result.push(data[i] * k + prev * (1 - k));
      } else {
        result.push(null);
      }
    }
  }
  return result;
}

function calcBOLL(closePrices, period, multiplier) {
  period = period || 20;
  multiplier = multiplier || 2;
  var middle = Utils.calcSMA(closePrices, period);
  var upper = [], lower = [];
  for (var i = 0; i < closePrices.length; i++) {
    if (i < period - 1) {
      upper.push(null); lower.push(null);
    } else {
      var sumSq = 0;
      for (var j = 0; j < period; j++) {
        sumSq += Math.pow(closePrices[i - j] - middle[i], 2);
      }
      var sd = Math.sqrt(sumSq / period);
      upper.push(middle[i] + multiplier * sd);
      lower.push(middle[i] - multiplier * sd);
    }
  }
  return { middle: middle, upper: upper, lower: lower };
}

function calcMACD(closePrices, fast, slow, signal) {
  fast = fast || 12; slow = slow || 26; signal = signal || 9;
  var emaFast = Utils.calcEMA(closePrices, fast);
  var emaSlow = Utils.calcEMA(closePrices, slow);
  var dif = [];
  for (var i = 0; i < closePrices.length; i++) {
    if (emaFast[i] == null || emaSlow[i] == null) {
      dif.push(null);
    } else {
      dif.push(emaFast[i] - emaSlow[i]);
    }
  }
  var dea = calcEMAFromExisting(dif, signal);
  var macdBar = [];
  for (var i = 0; i < dif.length; i++) {
    if (dif[i] == null || dea[i] == null) {
      macdBar.push(null);
    } else {
      macdBar.push(2 * (dif[i] - dea[i]));
    }
  }
  return { dif: dif, dea: dea, macd: macdBar };
}

function calcRSI(closePrices, period) {
  period = period || 14;
  var rsi = [null]; // index 0: no prior close
  var avgGain = 0, avgLoss = 0;

  for (var i = 1; i < closePrices.length; i++) {
    var diff = closePrices[i] - closePrices[i - 1];
    var gain = diff > 0 ? diff : 0;
    var loss = diff < 0 ? -diff : 0;

    if (i <= period) {
      avgGain += gain;
      avgLoss += loss;
      if (i === period) {
        avgGain /= period;
        avgLoss /= period;
        var rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
        rsi.push(100 - 100 / (1 + rs));
      } else {
        rsi.push(null);
      }
    } else {
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      var rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
      rsi.push(100 - 100 / (1 + rs));
    }
  }
  return rsi;
}

function calcKDJ(highs, lows, closes, n, m1, m2) {
  n = n || 9; m1 = m1 || 3; m2 = m2 || 3;
  var rsv = [];
  for (var i = 0; i < closes.length; i++) {
    if (i < n - 1) { rsv.push(null); continue; }
    var highest = -Infinity, lowest = Infinity;
    for (var j = 0; j < n; j++) {
      if (highs[i - j] > highest) highest = highs[i - j];
      if (lows[i - j] < lowest) lowest = lows[i - j];
    }
    var range = highest - lowest;
    rsv.push(range === 0 ? 50 : ((closes[i] - lowest) / range) * 100);
  }
  var K = [], D = [], J = [];
  var kPrev = 50, dPrev = 50;
  for (var i = 0; i < rsv.length; i++) {
    if (rsv[i] == null) {
      K.push(null); D.push(null); J.push(null);
    } else {
      kPrev = ((m1 - 1) / m1) * kPrev + (1 / m1) * rsv[i];
      dPrev = ((m2 - 1) / m2) * dPrev + (1 / m2) * kPrev;
      K.push(kPrev);
      D.push(dPrev);
      J.push(3 * kPrev - 2 * dPrev);
    }
  }
  return { K: K, D: D, J: J };
}

function computeAllIndicators(rawData) {
  var closes = rawData.map(function(d) { return d.close; });
  var highs  = rawData.map(function(d) { return d.high; });
  var lows   = rawData.map(function(d) { return d.low; });
  return {
    ma5:   Utils.calcSMA(closes, 5),
    ma10:  Utils.calcSMA(closes, 10),
    ma20:  Utils.calcSMA(closes, 20),
    ma60:  Utils.calcSMA(closes, 60),
    boll:  calcBOLL(closes, 20, 2),
    macd:  calcMACD(closes, 12, 26, 9),
    rsi:   calcRSI(closes, 14),
    kdj:   calcKDJ(highs, lows, closes, 9, 3, 3),
  };
}

// ========================
// Signal Extraction
// ========================

function lastValid(arr, last) {
  for (var i = last; i >= 0; i--) { if (arr[i] != null) return arr[i]; }
  return null;
}

function lastTwoValid(dif, dea) {
  var pairs = [];
  for (var i = dif.length - 1; i >= 0 && pairs.length < 3; i--) {
    if (dif[i] != null && dea[i] != null) pairs.push({ dif: dif[i], dea: dea[i] });
  }
  return pairs;
}

function getMACDSignal(macd) {
  var pairs = lastTwoValid(macd.dif, macd.dea);
  if (pairs.length < 2) return { text: '数据不足', cls: 'neutral' };
  var cur = pairs[0], prev = pairs[1];
  if (cur.dif > cur.dea && prev.dif <= prev.dea) return { text: '金叉 ▲', cls: 'bullish' };
  if (cur.dif < cur.dea && prev.dif >= prev.dea) return { text: '死叉 ▼', cls: 'bearish' };
  if (cur.dif >= cur.dea) return { text: '多头', cls: 'bullish' };
  return { text: '空头', cls: 'bearish' };
}

function getRSISignal(rsi, last) {
  var v = lastValid(rsi, last);
  if (v == null) return { text: '数据不足', cls: 'neutral' };
  if (v > 70) return { text: '超买 ' + v.toFixed(1), cls: 'bearish' };
  if (v < 30) return { text: '超卖 ' + v.toFixed(1), cls: 'bullish' };
  return { text: '正常 ' + v.toFixed(1), cls: 'neutral' };
}

function getKDJSignal(kdj, last) {
  var k = lastValid(kdj.K, last);
  var d = lastValid(kdj.D, last);
  if (k == null || d == null) return { text: '数据不足', cls: 'neutral' };
  // Check cross
  var kPrev = null, dPrev = null;
  for (var i = last - 1; i >= 0; i--) {
    if (kdj.K[i] != null && kdj.D[i] != null) { kPrev = kdj.K[i]; dPrev = kdj.D[i]; break; }
  }
  if (kPrev != null && dPrev != null) {
    if (k > d && kPrev <= dPrev) return { text: '金叉 ▲', cls: 'bullish' };
    if (k < d && kPrev >= dPrev) return { text: '死叉 ▼', cls: 'bearish' };
  }
  if (k > 80 && d > 80) return { text: '超买区', cls: 'bearish' };
  if (k < 20 && d < 20) return { text: '超卖区', cls: 'bullish' };
  return { text: 'K=' + k.toFixed(1) + ' D=' + d.toFixed(1), cls: 'neutral' };
}

function getBOLLSignal(close, boll, last) {
  var upper = lastValid(boll.upper, last);
  var lower = lastValid(boll.lower, last);
  var middle = lastValid(boll.middle, last);
  if (upper == null) return { text: '数据不足', cls: 'neutral' };
  if (close >= upper) return { text: '触及上轨', cls: 'bearish' };
  if (close <= lower) return { text: '触及下轨', cls: 'bullish' };
  if (close > middle) return { text: '中轨上方', cls: 'neutral' };
  return { text: '中轨下方', cls: 'neutral' };
}

function getMASignal(results, last) {
  var ma5  = lastValid(results.ma5, last);
  var ma10 = lastValid(results.ma10, last);
  var ma20 = lastValid(results.ma20, last);
  var ma60 = lastValid(results.ma60, last);
  if (!ma5 || !ma10 || !ma20 || !ma60) return { text: '数据不足', cls: 'neutral' };
  if (ma5 > ma10 && ma10 > ma20 && ma20 > ma60) return { text: '多头排列', cls: 'bullish' };
  if (ma5 < ma10 && ma10 < ma20 && ma20 < ma60) return { text: '空头排列', cls: 'bearish' };
  return { text: '交织', cls: 'neutral' };
}

function extractSignals(results, data) {
  var last = data.length - 1;
  return {
    macd:  getMACDSignal(results.macd),
    rsi:   getRSISignal(results.rsi, last),
    kdj:   getKDJSignal(results.kdj, last),
    boll:  getBOLLSignal(data[last].close, results.boll, last),
    ma:    getMASignal(results, last),
  };
}

// ========================
// Composite Recommendation
// ========================

function computeRecommendation(indicators, data) {
  var last = data.length - 1;
  var score = 0;
  var breakdown = {};

  // --- MACD (20%) ---
  var macdScore = 0;
  var dif = indicators.macd.dif;
  var dea = indicators.macd.dea;
  var macdBar = indicators.macd.macd;
  var pairs = [];
  for (var i = last; i >= 0 && pairs.length < 3; i--) {
    if (dif[i] != null && dea[i] != null) pairs.unshift({ dif: dif[i], dea: dea[i], bar: macdBar[i] });
  }
  if (pairs.length >= 2) {
    var cur = pairs[pairs.length - 1], prev = pairs[pairs.length - 2];
    if (cur.dif > cur.dea && prev.dif <= prev.dea) macdScore = 1.0;
    else if (cur.dif < cur.dea && prev.dif >= prev.dea) macdScore = -1.0;
    else if (cur.dif > cur.dea) macdScore = (cur.bar != null && prev.bar != null && cur.bar > 0 && cur.bar >= prev.bar) ? 0.8 : 0.5;
    else macdScore = (cur.bar != null && prev.bar != null && cur.bar < 0 && cur.bar <= prev.bar) ? -0.8 : -0.5;
  }
  breakdown.macd = macdScore;
  score += macdScore * 0.20;

  // --- RSI (20%) ---
  var rsiScore = 0;
  var rsi = lastValid(indicators.rsi, last);
  var rsiPrev = lastValidPair(indicators.rsi, last);
  if (rsi != null && rsiPrev != null) {
    if (rsi > 80) rsiScore = -1.0;
    else if (rsi > 70) rsiScore = -0.7;
    else if (rsi < 20) rsiScore = 1.0;
    else if (rsi < 30) rsiScore = 0.7;
    else if (rsi > 50) rsiScore = rsi > rsiPrev ? 0.3 : -0.1;
    else rsiScore = rsi > rsiPrev ? 0.5 : -0.3;
  }
  breakdown.rsi = rsiScore;
  score += rsiScore * 0.20;

  // --- KDJ (15%) ---
  var kdjScore = 0;
  var k = lastValid(indicators.kdj.K, last);
  var d = lastValid(indicators.kdj.D, last);
  if (k != null && d != null) {
    var kPrev = lastNearby(indicators.kdj.K, last);
    var dPrev = lastNearby(indicators.kdj.D, last);
    if (k < 20 && d < 20) kdjScore = 1.0;
    else if (k > 80 && d > 80) kdjScore = -1.0;
    else if (kPrev != null && dPrev != null) {
      if (k > d && kPrev <= dPrev) kdjScore = 0.8;
      else if (k < d && kPrev >= dPrev) kdjScore = -0.8;
      else if (k > d) kdjScore = 0.4;
      else kdjScore = -0.4;
    }
  }
  breakdown.kdj = kdjScore;
  score += kdjScore * 0.15;

  // --- BOLL (15%) ---
  var bollScore = 0;
  var close = data[last].close;
  var upper = lastValid(indicators.boll.upper, last);
  var middle = lastValid(indicators.boll.middle, last);
  var lower = lastValid(indicators.boll.lower, last);
  if (upper != null && lower != null && middle != null) {
    var bandWidth = upper - lower;
    if (bandWidth > 0) {
      var pos = (close - lower) / bandWidth;
      if (pos < 0.1) bollScore = 1.0;
      else if (pos < 0.25) bollScore = 0.7;
      else if (pos > 0.9) bollScore = -1.0;
      else if (pos > 0.75) bollScore = -0.7;
      else if (pos < 0.5) bollScore = 0.3;
      else bollScore = -0.3;
    }
  }
  breakdown.boll = bollScore;
  score += bollScore * 0.15;

  // --- MA (30%) ---
  var maScore = 0;
  var ma5  = lastValid(indicators.ma5, last);
  var ma10 = lastValid(indicators.ma10, last);
  var ma20 = lastValid(indicators.ma20, last);
  var ma60 = lastValid(indicators.ma60, last);
  if (ma5 && ma10 && ma20 && ma60) {
    if (ma5 > ma10 && ma10 > ma20 && ma20 > ma60) maScore = 1.0;
    else if (ma5 < ma10 && ma10 < ma20 && ma20 < ma60) maScore = -1.0;
    else if (ma5 > ma10 && ma10 > ma20) maScore = 0.7;
    else if (ma5 < ma10 && ma10 < ma20) maScore = -0.7;
    else if (close > ma60) maScore = 0.3;
    else if (close < ma60) maScore = -0.3;
  }
  breakdown.ma = maScore;
  score += maScore * 0.30;

  // --- Final ---
  score = Math.max(-1, Math.min(1, score));

  // Confidence = indicator agreement: how many sub-scores agree with the final direction
  var agreeCount = 0;
  var keys = ['macd', 'rsi', 'kdj', 'boll', 'ma'];
  for (var ki = 0; ki < keys.length; ki++) {
    var s = breakdown[keys[ki]];
    if (s == null || isNaN(s)) continue;
    if ((score > 0 && s > 0.05) || (score < 0 && s < -0.05) || (Math.abs(score) < 0.05 && Math.abs(s) < 0.1)) agreeCount++;
  }
  var confidence = Math.round((agreeCount / keys.length) * 100);

  var text, cls;
  if (score >= 0.6)      { text = '强烈买入'; cls = 'strong-buy'; }
  else if (score >= 0.2) { text = '买入';     cls = 'buy'; }
  else if (score > -0.2) { text = '观望';     cls = 'hold'; }
  else if (score > -0.6) { text = '卖出';     cls = 'sell'; }
  else                   { text = '强烈卖出'; cls = 'strong-sell'; }

  return {
    text: text,
    score: score,
    confidence: confidence,
    cls: cls,
    breakdown: breakdown,
  };
}

// Helper: second-to-last valid value
function lastValidPair(arr, idx) {
  var found = 0, val = null;
  for (var i = idx - 1; i >= 0; i--) {
    if (arr[i] != null) return arr[i];
  }
  return null;
}

// Helper: last valid value at an index just before current
function lastNearby(arr, idx) {
  for (var i = idx - 1; i >= 0; i--) {
    if (arr[i] != null) return arr[i];
  }
  return null;
}

// ========================
// UI Update Functions
// ========================

function updateSignalCards(signals) {
  updateSignalCard('taSignalMACD', 'MACD', signals.macd);
  updateSignalCard('taSignalRSI', 'RSI(14)', signals.rsi);
  updateSignalCard('taSignalKDJ', 'KDJ', signals.kdj);
  updateSignalCard('taSignalBOLL', 'BOLL', signals.boll);
  updateSignalCard('taSignalMA', '均线排列', signals.ma);
}

function updateRecommendationCard(rec) {
  var panel = document.getElementById('taRecommendation');
  if (!panel) return;
  panel.style.display = 'flex';
  panel.className = 'ta-recommendation ' + rec.cls;

  document.getElementById('taRecValue').textContent = rec.text;
  document.getElementById('taRecValue').className = 'ta-rec-value ' + rec.cls;
  document.getElementById('taRecConf').textContent = rec.confidence;

  var items = ['macd', 'rsi', 'kdj', 'boll', 'ma'];
  var labels = { macd:'MACD', rsi:'RSI', kdj:'KDJ', boll:'BOLL', ma:'均线' };
  items.forEach(function(key) {
    var el = document.getElementById('taRec' + key.toUpperCase());
    if (!el) return;
    var v = rec.breakdown[key];
    if (v == null || isNaN(v)) { el.textContent = '--'; el.className = 'rscore neutral'; return; }
    var sign = v >= 0 ? '+' : '';
    el.textContent = sign + v.toFixed(2);
    el.className = 'rscore ' + (v > 0.1 ? 'bullish' : v < -0.1 ? 'bearish' : 'neutral');
  });
}

function updateSignalCard(id, label, signal) {
  var card = document.getElementById(id);
  if (!card) return;
  card.querySelector('.ta-signal-label').textContent = label;
  var valueEl = card.querySelector('.ta-signal-value');
  valueEl.textContent = signal.text;
  valueEl.className = 'ta-signal-value ' + signal.cls;
}

function updateStockInfo(name, price, change, changePct) {
  document.getElementById('taStockName').textContent = name || taCurrentCode;
  document.getElementById('taStockCode').textContent = taCurrentCode;
  document.getElementById('taStockPrice').textContent = price.toFixed(2);
  var cls = change >= 0 ? 'up' : 'down';
  var sign = change >= 0 ? '+' : '';
  var el = document.getElementById('taStockChange');
  el.textContent = sign + change.toFixed(2) + '  ' + sign + changePct.toFixed(2) + '%';
  el.className = 'ta-stock-change ' + (change >= 0 ? 'up-bg up' : 'down-bg down');
}

function highlightActiveTag(code) {
  document.querySelectorAll('.ta-tag').forEach(function(t) {
    t.classList.toggle('active', t.dataset.code === code);
  });
}

// ========================
// ECharts Rendering
// ========================

function formatTooltipVal(v) {
  if (v == null) return '--';
  if (Array.isArray(v)) return 'O:' + v[0].toFixed(2) + ' C:' + v[1].toFixed(2);
  if (Math.abs(v) >= 1e8) return (v / 1e8).toFixed(2) + ' 亿';
  if (Math.abs(v) >= 1e4) return (v / 1e4).toFixed(2) + ' 万';
  if (Math.abs(v) >= 1 || v === 0) return v.toFixed(2);
  return v.toFixed(3);
}

function renderTAChart(rawData, indicators) {
  var dates = rawData.map(function(d) {
    var day = d.day;
    return day.length > 10 ? day.slice(5, 10) : day; // shorten date labels
  });
  var ohlc = rawData.map(function(d) { return [d.open, d.close, d.low, d.high]; });
  var vols = rawData.map(function(d, i) {
    return { value: d.volume, itemStyle: { color: d.close >= d.open ? '#ef4444' : '#22c55e' } };
  });

  var dom = document.getElementById('taChart');
  if (taChart) taChart.dispose();
  taChart = echarts.init(dom);

  var chartH = dom.clientHeight || 780;
  var gap = 18; // room for titles between grids
  var proportions = [0.36, 0.08, 0.15, 0.15, 0.15];
  var gridDefs = [];
  var cum = 16; // start offset for first title
  for (var i = 0; i < proportions.length; i++) {
    var h = Math.round(chartH * proportions[i]);
    gridDefs.push({
      left: 70, right: 25,
      top: cum,
      height: h
    });
    cum = gridDefs[i].top + h + gap;
  }

  // Reference lines for RSI and KDJ — constant series
  var n = rawData.length;
  function constArr(v) { var a = []; for (var i = 0; i < n; i++) a.push(v); return a; }

  // MACD bar data with colors
  var macdBars = indicators.macd.macd.map(function(v) {
    if (v == null) return null;
    return { value: v, itemStyle: { color: v >= 0 ? '#ef4444' : '#22c55e' } };
  });

  var option = {
    title: [
      { text: 'K线 · MA · BOLL', left: 70, top: 0, textStyle: { fontSize: 12, fontWeight: 600, color: '#36454f' } },
      { text: '成交量', left: 70, top: gridDefs[1].top - 14, textStyle: { fontSize: 11, color: '#708090' } },
      { text: 'MACD (12,26,9)', left: 70, top: gridDefs[2].top - 14, textStyle: { fontSize: 11, color: '#708090' } },
      { text: 'RSI (14)', left: 70, top: gridDefs[3].top - 14, textStyle: { fontSize: 11, color: '#708090' } },
      { text: 'KDJ (9,3,3)', left: 70, top: gridDefs[4].top - 14, textStyle: { fontSize: 11, color: '#708090' } },
    ],
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'cross' },
      backgroundColor: '#fff',
      borderColor: '#d3d3d3',
      textStyle: { color: '#36454f', fontSize: 12 },
      formatter: function(params) {
        var d = params[0].axisValue;
        var html = '<div style="font-weight:600;margin-bottom:4px;">' + d + '</div>';
        for (var i = 0; i < params.length; i++) {
          var p = params[i];
          if (p.value == null) continue;
          var v = formatTooltipVal(p.value);
          html += '<div style="display:flex;gap:12px;">' +
            '<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:' + p.color + ';margin-top:4px;"></span>' +
            '<span style="flex:1;">' + p.seriesName + '</span>' +
            '<span style="font-weight:600;">' + v + '</span>' +
            '</div>';
        }
        return html;
      },
    },
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    grid: gridDefs,
    xAxis: [
      { type:'category', data:dates, gridIndex:0, axisLabel:{show:false}, axisTick:{show:false}, axisLine:{lineStyle:{color:'#d3d3d3'}} },
      { type:'category', data:dates, gridIndex:1, axisLabel:{show:false}, axisTick:{show:false}, axisLine:{lineStyle:{color:'#d3d3d3'}} },
      { type:'category', data:dates, gridIndex:2, axisLabel:{show:false}, axisTick:{show:false}, axisLine:{lineStyle:{color:'#d3d3d3'}} },
      { type:'category', data:dates, gridIndex:3, axisLabel:{show:false}, axisTick:{show:false}, axisLine:{lineStyle:{color:'#d3d3d3'}} },
      { type:'category', data:dates, gridIndex:4, axisLabel:{fontSize:10,color:'#708090',interval:Math.floor(n/8)||0}, axisTick:{show:false}, axisLine:{lineStyle:{color:'#d3d3d3'}} },
    ],
    yAxis: [
      { type:'value', gridIndex:0, scale:true, splitLine:{lineStyle:{color:'#f0f0f0'}}, axisLabel:{fontSize:10,color:'#708090',formatter:function(v){return v.toFixed(0)}} },
      { type:'value', gridIndex:1, splitLine:{show:false}, axisLabel:{fontSize:9,color:'#708090',formatter:function(v){return v>=1e8?(v/1e8).toFixed(1)+'亿':(v/1e4).toFixed(0)+'万'}} },
      { type:'value', gridIndex:2, splitLine:{lineStyle:{color:'#f0f0f0'}}, axisLabel:{fontSize:10,color:'#708090',formatter:function(v){return v.toFixed(2)}} },
      { type:'value', gridIndex:3, min:0, max:100, interval:25, splitLine:{lineStyle:{color:'#f0f0f0'}}, axisLabel:{fontSize:10,color:'#708090',formatter:function(v){return v.toFixed(0)}} },
      { type:'value', gridIndex:4, min:0, max:100, interval:20, splitLine:{lineStyle:{color:'#f0f0f0'}}, axisLabel:{fontSize:10,color:'#708090',formatter:function(v){return v.toFixed(0)}} },
    ],
    series: [
      // ===== Grid 0: K-line + MAs + BOLL =====
      { name:'K线', type:'candlestick', xAxisIndex:0, yAxisIndex:0, data:ohlc,
        itemStyle:{color:'#ef4444',color0:'#22c55e',borderColor:'#ef4444',borderColor0:'#22c55e'} },
      { name:'MA5', type:'line', xAxisIndex:0, yAxisIndex:0, data:indicators.ma5,
        smooth:true, symbol:'none', lineStyle:{width:1,color:'#36454f'} },
      { name:'MA10', type:'line', xAxisIndex:0, yAxisIndex:0, data:indicators.ma10,
        smooth:true, symbol:'none', lineStyle:{width:1,color:'#708090'} },
      { name:'MA20', type:'line', xAxisIndex:0, yAxisIndex:0, data:indicators.ma20,
        smooth:true, symbol:'none', lineStyle:{width:1,color:'#d3d3d3'} },
      { name:'MA60', type:'line', xAxisIndex:0, yAxisIndex:0, data:indicators.ma60,
        smooth:true, symbol:'none', lineStyle:{width:1,color:'#c4a35a'} },
      { name:'BOLL上', type:'line', xAxisIndex:0, yAxisIndex:0, data:indicators.boll.upper,
        smooth:true, symbol:'none', lineStyle:{width:1,color:'#70809066',type:'dashed'} },
      { name:'BOLL中', type:'line', xAxisIndex:0, yAxisIndex:0, data:indicators.boll.middle,
        smooth:true, symbol:'none', lineStyle:{width:1,color:'#70809066',type:'dashed'} },
      { name:'BOLL下', type:'line', xAxisIndex:0, yAxisIndex:0, data:indicators.boll.lower,
        smooth:true, symbol:'none', lineStyle:{width:1,color:'#70809066',type:'dashed'} },

      // ===== Grid 1: Volume =====
      { name:'成交量', type:'bar', xAxisIndex:1, yAxisIndex:1, data:vols },

      // ===== Grid 2: MACD =====
      { name:'DIF', type:'line', xAxisIndex:2, yAxisIndex:2, data:indicators.macd.dif,
        smooth:true, symbol:'none', lineStyle:{width:1.5,color:'#f59e0b'} },
      { name:'DEA', type:'line', xAxisIndex:2, yAxisIndex:2, data:indicators.macd.dea,
        smooth:true, symbol:'none', lineStyle:{width:1.5,color:'#3b82f6'} },
      { name:'MACD', type:'bar', xAxisIndex:2, yAxisIndex:2, data:macdBars },

      // ===== Grid 3: RSI =====
      { name:'RSI', type:'line', xAxisIndex:3, yAxisIndex:3, data:indicators.rsi,
        smooth:true, symbol:'none', lineStyle:{width:2,color:'#8b5cf6'} },
      { name:'RSI70', type:'line', xAxisIndex:3, yAxisIndex:3, data:constArr(70),
        silent:true, symbol:'none', lineStyle:{width:1,color:'#ef444488',type:'dashed'} },
      { name:'RSI50', type:'line', xAxisIndex:3, yAxisIndex:3, data:constArr(50),
        silent:true, symbol:'none', lineStyle:{width:1,color:'#70809044',type:'dashed'} },
      { name:'RSI30', type:'line', xAxisIndex:3, yAxisIndex:3, data:constArr(30),
        silent:true, symbol:'none', lineStyle:{width:1,color:'#22c55e88',type:'dashed'} },

      // ===== Grid 4: KDJ =====
      { name:'K', type:'line', xAxisIndex:4, yAxisIndex:4, data:indicators.kdj.K,
        smooth:true, symbol:'none', lineStyle:{width:1.5,color:'#ef4444'} },
      { name:'D', type:'line', xAxisIndex:4, yAxisIndex:4, data:indicators.kdj.D,
        smooth:true, symbol:'none', lineStyle:{width:1.5,color:'#22c55e'} },
      { name:'J', type:'line', xAxisIndex:4, yAxisIndex:4, data:indicators.kdj.J,
        smooth:true, symbol:'none', lineStyle:{width:1.5,color:'#8b5cf6'} },
      { name:'KDJ80', type:'line', xAxisIndex:4, yAxisIndex:4, data:constArr(80),
        silent:true, symbol:'none', lineStyle:{width:1,color:'#ef444488',type:'dashed'} },
      { name:'KDJ20', type:'line', xAxisIndex:4, yAxisIndex:4, data:constArr(20),
        silent:true, symbol:'none', lineStyle:{width:1,color:'#22c55e88',type:'dashed'} },
    ],
  };

  taChart.setOption(option, true);
}

// ========================
// Main Analysis Flow
// ========================

function setTAState(state) {
  document.getElementById('taLoading').style.display = state === 'loading' ? 'block' : 'none';
  document.getElementById('taError').style.display = state === 'error' ? 'block' : 'none';
  document.getElementById('taEmpty').style.display = state === 'empty' ? 'block' : 'none';
  document.getElementById('taChartPanel').style.display = (state === 'done') ? 'block' : 'none';
  document.getElementById('taSignals').style.display = (state === 'done') ? 'grid' : 'none';
  document.getElementById('taRecommendation').style.display = (state === 'done') ? 'flex' : 'none';
  document.getElementById('taStockInfo').style.display = (state === 'done') ? 'flex' : 'none';
}

async function resolveStockName(code) {
  // Try FinanceCache profile first
  var cached = FinanceCache.get(code);
  if (cached && cached.profile) {
    var p = cached.profile.data || cached.profile;
    if (p.name) return p.name;
  }
  // Try stock list cache
  try {
    var slEntry = JSON.parse(localStorage.getItem('sp_stock_list_cache'));
    if (slEntry && slEntry.data) {
      for (var i = 0; i < slEntry.data.length; i++) {
        if (slEntry.data[i].code === code) return slEntry.data[i].name || '';
      }
    }
  } catch (e) { /* ignore */ }
  // Try real-time quote for A-shares
  if (/^\d{6}$/.test(code)) {
    try {
      var resp = await fetch('/api/stock_quotes?codes=' + encodeURIComponent(code));
      if (resp.ok) {
        var quotes = await resp.json();
        if (quotes.length && quotes[0].name) return quotes[0].name;
      }
    } catch (e) { /* ignore */ }
  }
  return '';
}

function updateTASearchHeader(code, name) {
  var nameEl = document.getElementById('taSearchName');
  var wlBtn = document.getElementById('taSearchWlBtn');
  if (nameEl) {
    nameEl.textContent = name || code;
  }
  if (wlBtn) {
    updateTAWlButton(code);
  }
}

function updateTAWlButton(code) {
  var wlBtn = document.getElementById('taSearchWlBtn');
  if (!wlBtn) return;
  var stocks = StockConfig.getAll();
  var inList = false;
  for (var i = 0; i < stocks.length; i++) {
    if (stocks[i].code.toUpperCase() === code.toUpperCase()) { inList = true; break; }
  }
  if (inList) {
    wlBtn.textContent = '★ 已自选';
    wlBtn.className = 'ta-rec-wl-btn in-wl';
    wlBtn.title = '已在自选列表中';
  } else {
    wlBtn.textContent = '+ 自选';
    wlBtn.className = 'ta-rec-wl-btn';
    wlBtn.title = '添加到自选';
  }
}

async function runTAAnalysis(code) {
  if (!code) return;
  taCurrentCode = code;
  setTAState('loading');

  try {
    var resp = await fetch('/api/kline?code=' + encodeURIComponent(code) + '&scale=240');
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    var data = await resp.json();

    if (data && data.error) throw new Error(data.error);
    if (!Array.isArray(data) || data.length === 0) throw new Error('该股票暂无K线数据');

    taCurrentData = data;
    var indicators = computeAllIndicators(data);
    taCurrentResults = indicators;

    var lastBar = data[data.length - 1];
    var prevBar = data[data.length - 2];
    var change = prevBar ? (lastBar.close - prevBar.close) : 0;
    var changePct = prevBar ? ((change / prevBar.close) * 100) : 0;

    // Resolve name and update header
    var name = await resolveStockName(code);
    updateTASearchHeader(code, name);
    updateStockInfo(name || code, lastBar.close, change, changePct);

    var signals = extractSignals(indicators, data);
    updateSignalCards(signals);

    var rec = computeRecommendation(indicators, data);
    updateRecommendationCard(rec);

    setTAState('done');
    highlightActiveTag(code);

    setTimeout(function() { renderTAChart(data, indicators); }, 50);

  } catch (e) {
    setTAState('error');
    document.getElementById('taError').textContent = '数据加载失败：' + e.message;
  }
}

// ========================
// Dynamic Tags from Watchlist
// ========================

function renderConfigTagsToAnalysis() {
  var container = document.getElementById('taConfigAnalysisTags');
  if (!container) return;
  container.querySelectorAll('.ta-tag').forEach(function(t) { t.remove(); });
  var stocks = StockConfig.getAll();
  var hint = container.querySelector('.cfg-hint');
  if (stocks.length === 0) {
    if (hint) hint.textContent = '暂无自选股，请先在「配置」页面添加';
    return;
  }
  if (hint) hint.textContent = '我的自选：';
  stocks.forEach(function(s) {
    var tag = document.createElement('span');
    tag.className = 'ta-tag';
    tag.dataset.code = s.code;
    tag.textContent = s.label || s.code;
    tag.addEventListener('click', function() {
      document.getElementById('taInput').value = this.dataset.code;
      runTAAnalysis(this.dataset.code);
    });
    container.appendChild(tag);
  });
}

// ========================
// Event Wiring
// ========================

document.addEventListener('DOMContentLoaded', function() {
  // Search button
  document.getElementById('taBtn').addEventListener('click', function() {
    var code = document.getElementById('taInput').value.trim();
    if (!code) return;
    runTAAnalysis(code);
  });

  // Enter key
  document.getElementById('taInput').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') document.getElementById('taBtn').click();
  });

  // Add to watchlist button
  document.getElementById('taSearchWlBtn').addEventListener('click', function() {
    if (!taCurrentCode) return;
    var wlBtn = this;
    if (wlBtn.classList.contains('in-wl')) return; // already in watchlist
    var nameEl = document.getElementById('taSearchName');
    var name = nameEl ? nameEl.textContent : '';
    var ok = StockConfig.add(taCurrentCode, name);
    if (ok) {
      updateTAWlButton(taCurrentCode);
      renderConfigTagsToAnalysis(); // refresh quick tags
      if (typeof cfgToast === 'function') cfgToast('已添加自选: ' + taCurrentCode + ' ' + name);
    } else {
      if (typeof cfgToast === 'function') cfgToast(taCurrentCode + ' 已在自选列表中');
      updateTAWlButton(taCurrentCode);
    }
  });

  // Lazy init on first visit
  var taInitialized = false;
  document.querySelector('[data-page="analysis"]').addEventListener('click', function() {
    if (!taInitialized) {
      taInitialized = true;
      renderConfigTagsToAnalysis();
    }
    if (taChart) setTimeout(function() { taChart.resize(); }, 100);
  });

  // Window resize
  window.addEventListener('resize', function() {
    if (taChart) taChart.resize();
  });
});
})();
