"""HTTP API server for the market dashboard — financial data for A-share stocks.

Usage: venv/Scripts/python api_server.py
Default port: 8765

Fetches complete financial data (income + balance + cash flow) via akshare/Sina Finance.
"""

import sys, os, re, json, logging, asyncio
from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from fastapi import FastAPI, Query, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("api_server")

executor = ThreadPoolExecutor(max_workers=4)
app = FastAPI(title="Senior Analyst API", version="1.7.2")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

def _fetched_at() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── Identifier resolution ────────────────────────────────

def _resolve(identifier: str) -> tuple:
    """Resolve to (code, market, sina_code). market is 'SH' or 'SZ'."""
    identifier = identifier.strip()
    m = re.match(r'^(sh|sz)(\d{6})$', identifier, re.I)
    if m:
        code = m.group(2)
        market = 'SH' if m.group(1).lower() == 'sh' else 'SZ'
        return code, market, identifier.lower()
    m = re.match(r'^(\d{6})$', identifier)
    if m:
        code = m.group(1)
        market = 'SH' if code.startswith(('6','9')) else 'SZ'
        return code, market, ('sh' if market == 'SH' else 'sz') + code
    m = re.match(r'^(\d{6})\.?(SH|SZ)$', identifier, re.I)
    if m:
        code = m.group(1)
        market = m.group(2).upper()
        return code, market, ('sh' if market == 'SH' else 'sz') + code
    return identifier, None, None


# ── Profile ──────────────────────────────────────────────

def _fetch_profile_qq(code: str, market: str) -> dict:
    """Fetch profile from QQ/Tencent finance (qt.gtimg.cn). Returns PE, PB, market cap, name."""
    import urllib.request
    ticker = code + ('.SH' if market == 'SH' else '.SZ')
    prefix = 'sh' if market == 'SH' else 'sz'
    try:
        url = f'https://qt.gtimg.cn/q={prefix}{code}'
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=6) as resp:
            raw = resp.read().decode('gbk')
        # Extract the quoted payload
        m = re.search(r'"([^"]*)"', raw)
        if not m:
            return {}
        fields = m.group(1).split('~')
        if len(fields) < 50 or not fields[1]:
            return {}
        # QQ finance fields: [1]=name, [3]=price, [39]=PE, [44]=market_cap(亿),
        # [46]=PB, [72]=total_shares
        name = fields[1]
        pe_val = _num(fields[39]) if len(fields) > 39 else None
        pb_val = _num(fields[46]) if len(fields) > 46 else None
        mcap_raw = _num(fields[44]) if len(fields) > 44 else None
        mcap = mcap_raw * 1e8 if mcap_raw else None  # QQ reports in 亿元
        price = _num(fields[3]) if len(fields) > 3 else None
        return {
            "name": name, "ticker": ticker, "industry": "",
            "market_cap": mcap, "pe_ratio": pe_val, "pb_ratio": pb_val,
            "price": price,
        }
    except Exception as e:
        logger.warning(f"Profile QQ failed for {code}: {e}")
        return {}


def _fetch_profile_sina(code: str, market: str) -> dict:
    """Fallback: fetch company name from Sina real-time quote."""
    import urllib.request
    ticker = code + ('.SH' if market == 'SH' else '.SZ')
    prefix = 'sh' if market == 'SH' else 'sz'
    try:
        url = f'https://hq.sinajs.cn/list={prefix}{code}'
        req = urllib.request.Request(url, headers={'Referer': 'https://finance.sina.com.cn'})
        with urllib.request.urlopen(req, timeout=5) as resp:
            raw = resp.read().decode('gbk')
        m = re.search(r'"([^"]*)"', raw)
        if m:
            fields = m.group(1).split(',')
            if len(fields) > 0 and fields[0]:
                return {"name": fields[0], "ticker": ticker, "industry": "",
                        "market_cap": None, "pe_ratio": None, "pb_ratio": None}
    except Exception as e:
        logger.warning(f"Profile Sina fallback failed for {code}: {e}")
    return {}


def _fetch_industry_cninfo(code: str) -> str:
    """Fetch industry classification from cninfo (independent of eastmoney)."""
    import akshare as ak
    try:
        df = ak.stock_profile_cninfo(symbol=code)
        if df is not None and not df.empty:
            industry = str(df.iloc[0].get('所属行业', ''))
            if industry and industry != 'None':
                return industry
    except Exception:
        pass
    return ""


def _fetch_profile(code: str, market: str = 'SZ') -> dict:
    """Fetch company profile: QQ finance for valuation + cninfo for industry."""
    # Primary: QQ/Tencent finance (PE, PB, market cap, name)
    data = _fetch_profile_qq(code, market)

    # Industry from cninfo (non-blocking, best-effort)
    industry = _fetch_industry_cninfo(code)
    if industry:
        data["industry"] = industry

    # Fallback: Sina if QQ gave nothing
    if not data.get("name"):
        return _fetch_profile_sina(code, market)
    return data


def _num(val) -> float | None:
    """Parse numeric value that may include Chinese units like '万' or '亿'."""
    if val is None: return None
    if isinstance(val, (int, float)): return float(val)
    s = str(val).replace(',', '').replace(' ', '').strip()
    if not s: return None
    try:
        if '万' in s: return float(s.replace('万','')) * 1e4
        if '亿' in s: return float(s.replace('亿','')) * 1e8
        return float(s)
    except ValueError:
        return None


# ── Financial Statements ─────────────────────────────────

def _find_col(cols: list, *patterns: str) -> str | None:
    """Find a column name matching a pattern. Returns the column name or None."""
    for p in patterns:
        # Prefer exact match to avoid '负债合计' matching '流动负债合计'
        for c in cols:
            if str(c) == p:
                return c
        # Fall back to shortest substring match
        matches = [(len(str(c)), c) for c in cols if p in str(c)]
        if matches:
            matches.sort()
            return matches[0][1]
    return None


def _fetch_all_statements(sina_code: str) -> dict:
    """Fetch income, balance, and cash flow statements. Returns {year: record}."""
    import akshare as ak
    import pandas as pd

    # Fetch all three statements
    try:
        df_inc = ak.stock_financial_report_sina(stock=sina_code, symbol="利润表")
    except Exception as e:
        logger.warning(f"Income statement failed: {e}")
        df_inc = None
    try:
        df_bal = ak.stock_financial_report_sina(stock=sina_code, symbol="资产负债表")
    except Exception as e:
        logger.warning(f"Balance sheet failed: {e}")
        df_bal = None
    try:
        df_cf = ak.stock_financial_report_sina(stock=sina_code, symbol="现金流量表")
    except Exception as e:
        logger.warning(f"Cash flow failed: {e}")
        df_cf = None

    if df_inc is None or df_inc.empty:
        return {}

    # Find key columns
    cols_inc = [str(c) for c in df_inc.columns]
    cols_bal = [str(c) for c in df_bal.columns] if df_bal is not None else []
    cols_cf = [str(c) for c in df_cf.columns] if df_cf is not None else []

    rev_col = _find_col(cols_inc, '营业总收入')
    cost_col = _find_col(cols_inc, '营业总成本')
    ni_col = _find_col(cols_inc, '归属于母公司股东的净利润') or _find_col(cols_inc, '净利润')
    assets_col = _find_col(cols_bal, '资产总计', '资产总额')
    liab_col = _find_col(cols_bal, '负债合计', '负债总额')
    ocf_col = _find_col(cols_cf, '经营活动产生的现金流量净额', '经营活动现金净流量')

    annual = defaultdict(dict)
    date_col = df_inc.columns[0]

    # Extract income statement data (prefer annual 12-31 periods)
    for idx in range(len(df_inc)):
        period = str(df_inc.iloc[idx, 0])
        year = period[:4]
        is_annual = period[4:6] == '12' and period[6:8] == '31'
        if not is_annual and year in annual:
            continue

        annual[year]['year'] = year
        annual[year]['period_end'] = period
        for col_key, field in [(rev_col, 'revenue'), (cost_col, 'operate_cost'), (ni_col, 'net_income')]:
            if col_key and col_key in df_inc.columns:
                val = df_inc.loc[idx, col_key]
                annual[year][field] = float(val) if pd.notna(val) else None

    # Extract balance sheet data
    if df_bal is not None:
        for idx in range(len(df_bal)):
            period = str(df_bal.iloc[idx, 0])
            year = period[:4]
            if year not in annual:
                continue
            is_annual = period[4:6] == '12' and period[6:8] == '31'
            if not is_annual and 'total_assets' in annual[year] and annual[year]['total_assets'] is not None:
                continue
            for col_key, field in [(assets_col, 'total_assets'), (liab_col, 'total_liabilities')]:
                if col_key and col_key in df_bal.columns:
                    val = df_bal.loc[idx, col_key]
                    annual[year][field] = float(val) if pd.notna(val) else None

    # Extract cash flow data
    if df_cf is not None:
        for idx in range(len(df_cf)):
            period = str(df_cf.iloc[idx, 0])
            year = period[:4]
            if year not in annual:
                continue
            is_annual = period[4:6] == '12' and period[6:8] == '31'
            if not is_annual and 'operating_cash_flow' in annual[year] and annual[year]['operating_cash_flow'] is not None:
                continue
            if ocf_col and ocf_col in df_cf.columns:
                val = df_cf.loc[idx, ocf_col]
                annual[year]['operating_cash_flow'] = float(val) if pd.notna(val) else None

    # Compute gross profit and clean up
    for yr, rec in annual.items():
        if rec.get('revenue') is not None and rec.get('operate_cost') is not None:
            rec['gross_profit'] = rec['revenue'] - rec['operate_cost']
        rec.pop('operate_cost', None)

    return annual


# ── News ──────────────────────────────────────────────────

def _fetch_news(code: str, limit: int = 10) -> list[dict]:
    """Fetch stock news via akshare. Uses positional access (col order is stable)."""
    import akshare as ak
    try:
        df = ak.stock_news_em(symbol=code)
        if df is None or df.empty:
            return []
        cols = list(df.columns)
        # Columns: 0=keyword, 1=title, 2=content, 3=pub_date, 4=source, 5=url
        def _get(row, pos, *names):
            if pos < len(cols) and pd.notna(row.iloc[pos]):
                return str(row.iloc[pos])
            for n in names:
                v = row.get(n)
                if v is not None and pd.notna(v) and str(v) != '':
                    return str(v)
            return ''
        import pandas as pd
        articles = []
        for _, row in df.head(limit).iterrows():
            articles.append({
                "title": _get(row, 1, 'title', '新闻标题'),
                "date": _get(row, 3, 'date', '发布时间'),
                "snippet": _get(row, 2, 'content', '新闻内容')[:200],
                "source": _get(row, 4, 'source', '来源', '新闻来源'),
            })
        return articles
    except Exception as e:
        logger.warning(f"News failed for {code}: {e}")
        return []


# ── API Endpoints ─────────────────────────────────────────

@app.get("/api/health")
async def health():
    return {"status": "ok", "version": "1.7.2", "time": _fetched_at()}


@app.get("/api/profile")
async def profile(identifier: str = Query(..., description="Company name or ticker")):
    code, market, sina_code = _resolve(identifier)
    if not code or not market:
        return {
            "success": True, "data": {"name": identifier, "ticker": identifier, "industry": "",
                "market_cap": None, "pe_ratio": None, "pb_ratio": None},
            "data_source": "fallback", "fetched_at": _fetched_at(),
        }

    loop = asyncio.get_event_loop()
    data = await loop.run_in_executor(executor, _fetch_profile, code, market)
    if not data.get("name"):
        data["name"] = code
        data["ticker"] = code + ('.SH' if market == 'SH' else '.SZ')

    return {"success": True, "data": data, "data_source": "qq/cninfo", "fetched_at": _fetched_at()}


@app.get("/api/financials")
async def financials(
    identifier: str = Query(..., description="Company name or ticker"),
    period: str = Query("annual", description="annual or quarterly"),
    years: int = Query(3, description="Number of years"),
):
    code, market, sina_code = _resolve(identifier)
    if not sina_code:
        raise HTTPException(502, detail={"success": False, "error": "Currently only A-share stocks are supported"})

    try:
        loop = asyncio.get_event_loop()
        annual = await loop.run_in_executor(executor, _fetch_all_statements, sina_code)
    except Exception as e:
        logger.error(f"Financial fetch error: {e}")
        raise HTTPException(502, detail={"success": False, "error": str(e)})

    # Sort by year descending, limit to requested years
    sorted_years = sorted(annual.keys(), reverse=True)[:years]
    rows = [annual[yr] for yr in sorted_years if annual[yr].get('revenue')]

    return {
        "success": True, "identifier": identifier, "period": period, "years": years,
        "data": {"data": rows},
        "data_source": "sina/akshare", "fetched_at": _fetched_at(),
    }


@app.get("/api/stock_news")
async def stock_news(
    identifier: str = Query(..., description="Company name or ticker"),
    days: int = Query(7), limit: int = Query(10),
):
    limit = min(max(limit, 1), 20)
    code, market, _ = _resolve(identifier)
    key = code or identifier
    loop = asyncio.get_event_loop()
    articles = await loop.run_in_executor(executor, _fetch_news, key, limit)
    return {
        "success": True, "data": {"articles": articles},
        "data_source": "akshare", "fetched_at": _fetched_at(),
    }


if __name__ == "__main__":
    port = int(os.environ.get("SA_API_PORT", "8765"))
    logger.info(f"Senior Analyst API v1.7.2 on http://localhost:{port}")
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
