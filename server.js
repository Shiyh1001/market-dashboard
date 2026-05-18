const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const PORT = 8080;
const INDICES = {
  sh:  's_sh000001',
  sz:  's_sz399001',
  cy:  's_sz399006',
  hsi: 'int_hangseng',
};

const KLINE_SYMBOLS = {
  sh:  'sh000001',
  sz:  'sz399001',
  cy:  'sz399006',
  hsi: 'int_hangseng',
};

function fetchSina() {
  const codes = Object.values(INDICES).join(',');
  const url = `https://hq.sinajs.cn/list=${codes}`;
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { Referer: 'https://finance.sina.com.cn' } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        // Sina uses GBK, convert to UTF-8
        const text = new TextDecoder('gbk').decode(raw);
        resolve(parseSina(text));
      });
    }).on('error', reject);
  });
}

function parseSina(text) {
  const result = {};
  const re = /var\s+hq_str_(\w+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const code = m[1];
    const vals = m[2].split(',');
    const key = Object.entries(INDICES).find(([, v]) => v === code)?.[0];
    if (!key) continue;
    result[key] = {
      name:   vals[0],
      price:  parseFloat(vals[1]) || 0,
      change: parseFloat(vals[2]) || 0,
      pct:    parseFloat(vals[3]) || 0,
    };
    if (key !== 'hsi' && vals.length > 5) {
      result[key].volume = parseInt(vals[4]) || 0;
      result[key].amount = parseInt(vals[5]) || 0;
    }
  }
  return result;
}

// ---- Individual Stock Quotes ----
function resolveStockCode(code) {
  // Normalize to Sina format: sh600519 or sz300750
  code = code.trim().toUpperCase();
  let m = code.match(/^(SH|SZ)(\d{6})$/);
  if (m) return m[0].toLowerCase();
  m = code.match(/^(\d{6})$/);
  if (m) return (m[1].startsWith('6') || m[1].startsWith('9') ? 'sh' : 'sz') + m[1];
  // Non-A-share (HK, US) — not supported by Sina stock quote endpoint
  return null;
}

function fetchStockQuotes(codes) {
  const sinaCodes = codes.map(resolveStockCode).filter(Boolean);
  if (sinaCodes.length === 0) return Promise.resolve([]);
  const url = `https://hq.sinajs.cn/list=${sinaCodes.join(',')}`;
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { Referer: 'https://finance.sina.com.cn' } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        const text = new TextDecoder('gbk').decode(raw);
        resolve(parseStockQuotes(text, sinaCodes));
      });
    }).on('error', reject);
  });
}

function parseStockQuotes(text, codes) {
  const results = [];
  const re = /var\s+hq_str_(\w+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const sinaCode = m[1];
    const vals = m[2].split(',');
    if (vals.length < 33 || !vals[0]) continue;
    const code = sinaCode.replace(/^sh|^sz/i, '');
    results.push({
      code: code,
      market: sinaCode.startsWith('sh') ? 'SH' : 'SZ',
      name: vals[0],
      open: parseFloat(vals[1]) || 0,
      prevClose: parseFloat(vals[2]) || 0,
      price: parseFloat(vals[3]) || 0,
      high: parseFloat(vals[4]) || 0,
      low: parseFloat(vals[5]) || 0,
      volume: parseInt(vals[8]) || 0,
      amount: parseFloat(vals[9]) || 0,
      change: parseFloat(vals[3]) - parseFloat(vals[2]) || 0,
      changePct: parseFloat(vals[3]) && parseFloat(vals[2])
        ? ((parseFloat(vals[3]) - parseFloat(vals[2])) / parseFloat(vals[2]) * 100)
        : 0,
      date: vals[30] || '',
      time: vals[31] || '',
      status: vals[32] || '00',
      halted: (vals[32] || '00') !== '00',
    });
  }
  return results;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
};

function fetchKline(symbol, scale) {
  const url = `https://quotes.sina.cn/cn/api/jsonp_v2.php/data/CN_MarketDataService.getKLineData?symbol=${symbol}&scale=${scale}&ma=no&datalen=60`;
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { Referer: 'https://finance.sina.com.cn' } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8');
        const m = raw.match(/data\((.+)\)/);
        if (!m) { reject(new Error('No data')); return; }
        let arr;
        try { arr = JSON.parse(m[1]); } catch (_) { reject(new Error('Invalid JSON')); return; }
        if (!Array.isArray(arr)) { reject(new Error('Empty or invalid kline data')); return; }
        resolve(arr.map(d => ({
          day: d.day,
          open: parseFloat(d.open),
          close: parseFloat(d.close),
          low: parseFloat(d.low),
          high: parseFloat(d.high),
          volume: parseInt(d.volume) || 0,
        })));
      });
    }).on('error', reject);
  });
}

// ---- Senior Analyst API proxy ----
const SA_API = 'http://127.0.0.1:8765';

function proxyToSA(path, res) {
  const url = SA_API + path;
  const protocol = url.startsWith('https') ? https : http;
  const req = protocol.get(url, { timeout: 15000 }, upstream => {
    const chunks = [];
    upstream.on('data', c => chunks.push(c));
    upstream.on('end', () => {
      if (!res.headersSent) {
        res.writeHead(upstream.statusCode, {
          'Content-Type': upstream.headers['content-type'] || 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
        });
      }
      if (!res.writableEnded) res.end(Buffer.concat(chunks));
    });
  });
  req.on('error', e => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    }
    if (!res.writableEnded) res.end(JSON.stringify({ success: false, error: 'Python API server unavailable: ' + e.message }));
  });
  req.on('timeout', function() {
    this.destroy();
    if (!res.headersSent) {
      res.writeHead(504, { 'Content-Type': 'application/json; charset=utf-8' });
    }
    if (!res.writableEnded) res.end(JSON.stringify({ success: false, error: 'Python API timeout' }));
  });
}

const server = http.createServer(async (req, res) => {
  // Proxy /api/sa/* to Python API
  if (req.url.startsWith('/api/sa/')) {
    const path = req.url.replace('/api/sa', '/api');
    proxyToSA(path, res);
    return;
  }

  if (req.url.startsWith('/api/stock_quotes')) {
    try {
      const qs = req.url.split('?')[1] || '';
      const codes = new URLSearchParams(qs).get('codes');
      if (!codes) throw new Error('Missing codes parameter');
      const data = await fetchStockQuotes(codes.split(','));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

	  if (req.url.startsWith('/api/stock_list')) {
	    try {
	      const qs = req.url.split('?')[1] || '';
	      const params = new URLSearchParams(qs);
	      const page = parseInt(params.get('page')) || 1;
	      const num = Math.min(parseInt(params.get('num')) || 100, 500);
	      const node = params.get('node') || 'hs_a';
	      const sort = params.get('sort') || 'symbol';
	      const asc = params.get('asc') || '1';
	      const url = `https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData?page=${page}&num=${num}&sort=${sort}&asc=${asc}&node=${node}`;
	      const data = await new Promise((resolve, reject) => {
	        https.get(url, { headers: { Referer: 'https://finance.sina.com.cn' } }, upstream => {
	          const chunks = [];
	          upstream.on('data', c => chunks.push(c));
	          upstream.on('end', () => {
	            const raw = Buffer.concat(chunks);
	            try {
	              const text = new TextDecoder('gbk').decode(raw);
	              resolve(JSON.parse(text));
	            } catch (e) { reject(e); }
	          });
	        }).on('error', reject);
	      });
	      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
	      res.end(JSON.stringify(data));
	    } catch (e) {
	      res.writeHead(500, { 'Content-Type': 'application/json' });
	      res.end(JSON.stringify({ error: e.message }));
	    }
	    return;
	  }

  if (req.url === '/api/data') {
    try {
      const data = await fetchSina();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.url.startsWith('/api/kline')) {
    try {
      const qs = req.url.split('?')[1] || '';
      const params = new URLSearchParams(qs);
      const key = params.get('symbol');
      const code = params.get('code');
      const scale = parseInt(params.get('scale')) || 240;
      let symbol;
      if (key && KLINE_SYMBOLS[key]) {
        symbol = KLINE_SYMBOLS[key];
      } else if (code) {
        symbol = resolveStockCode(code);
        if (!symbol) throw new Error('Unsupported stock code: ' + code);
      } else if (key) {
        // Try resolving as individual stock code directly
        symbol = resolveStockCode(key);
        if (!symbol) throw new Error('Unknown symbol: ' + key);
      } else {
        throw new Error('Missing symbol or code parameter');
      }
      const data = await fetchKline(symbol, scale);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  const filePath = req.url === '/' ? '/index.html' : req.url;
  const fullPath = path.join(__dirname, filePath);
  const ext = path.extname(fullPath);

  try {
    const content = fs.readFileSync(fullPath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('Not Found');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://localhost:${PORT}`;
  console.log(`Server running at ${url}`);
  console.log('Press Ctrl+C to stop');
  const cmd = process.platform === 'win32'
    ? `start ${url}`
    : process.platform === 'darwin'
      ? `open ${url}`
      : `xdg-open ${url}`;
  exec(cmd);
});
