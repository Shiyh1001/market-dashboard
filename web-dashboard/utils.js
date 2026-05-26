// ---- Shared Utilities ----
// Common functions used across dashboard modules.

var Utils = (function() {
  'use strict';

  function esc(str) {
    if (str == null) return '';
    var el = document.createElement('span');
    el.textContent = String(str);
    return el.innerHTML;
  }

  function formatNum(n, dec) {
    if (n == null || isNaN(n)) return '--';
    return Number(n).toFixed(dec != null ? dec : 2);
  }

  function formatVol(n) {
    if (n == null || isNaN(n)) return '--';
    n = Number(n);
    if (n >= 1e8) return (n / 1e8).toFixed(2) + ' 亿';
    if (n >= 1e4) return (n / 1e4).toFixed(0) + ' 万';
    return n.toFixed(0);
  }

  function formatAmt(n) {
    if (n == null || isNaN(n)) return '--';
    n = Number(n);
    if (n >= 1e8) return (n / 1e8).toFixed(2) + ' 亿';
    return (n / 1e4).toFixed(0) + ' 万';
  }

  function calcSMA(arr, period) {
    var result = [];
    for (var i = 0; i < arr.length; i++) {
      if (i < period - 1) { result.push(null); continue; }
      var sum = 0;
      for (var j = 0; j < period; j++) sum += arr[i - j];
      result.push(sum / period);
    }
    return result;
  }

  function calcEMA(data, period) {
    var k = 2 / (period + 1);
    var result = [];
    for (var i = 0; i < data.length; i++) {
      if (i < period - 1) {
        result.push(null);
      } else if (i === period - 1) {
        var sum = 0;
        for (var j = 0; j < period; j++) sum += data[j];
        result.push(sum / period);
      } else {
        result.push(data[i] * k + result[i - 1] * (1 - k));
      }
    }
    return result;
  }

  function fmtAlertTime(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    var now = new Date();
    var diff = now - d;
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
    if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前';
    return d.toLocaleDateString('zh-CN') + ' ' + d.toLocaleTimeString('zh-CN', { hour12: false });
  }

  return {
    esc: esc,
    formatNum: formatNum,
    formatVol: formatVol,
    formatAmt: formatAmt,
    calcSMA: calcSMA,
    calcEMA: calcEMA,
    fmtAlertTime: fmtAlertTime,
  };
})();

// Global aliases for backward compatibility across modules
var esc = Utils.esc;
var escHTML = Utils.esc;
var formatNum = Utils.formatNum;
var formatVol = Utils.formatVol;
var formatAmt = Utils.formatAmt;
var fmtAlertTime = Utils.fmtAlertTime;
