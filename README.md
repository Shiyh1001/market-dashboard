# 行情仪表盘

A股/港股实时行情仪表盘，支持指数监控、个股查询、K线图表和财报排雷分析。

## 功能

- 上证指数、深证成指、创业板指、恒生指数实时行情
- 个股行情查询与K线图
- 自选股监控与异动提醒
- 财报排雷分析（依赖 Python 后端）

## 环境要求

- Node.js 18+
- Python 3.12+（仅财报排雷功能需要）
- Tushare API token（仅财报排雷功能需要）

## 快速启动

```bash
# 1. 安装依赖
npm install

# 2. 启动服务（自动打开浏览器）
node server.js
```

浏览器访问 `http://localhost:8080`

## 启动财报排雷模块（可选）

```bash
cd senior-analyst
pip install -r requirements.txt
python api_server.py
```

## 项目结构

```
├── index.html        # 前端页面
├── server.js         # Node.js 后端（端口 8080）
├── config.js         # 前端配置
├── analysis.js       # 分析逻辑
├── alerts.js         # 异动提醒
├── stockpick.js      # 选股逻辑
├── financials.js     # 财务数据
├── senior-analyst/   # Python 分析后端（端口 8765）
└── financial-report-minesweeper/  # 财报排雷模块
```
