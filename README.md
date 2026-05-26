# Market Dashboard

A 股/港股实时行情仪表盘，支持指数监控、个股查询、K 线图表和财报排雷分析。

## 仓库结构

```
├── web-dashboard/                  # Node.js 前端仪表盘（端口 8080）
│   ├── index.html                 # 前端页面
│   ├── server.js                  # Node.js 后端
│   ├── analysis.js / alerts.js    # 分析 & 异动提醒
│   ├── stockpick.js / financials.js # 选股 & 财务数据
│   ├── config.js / utils.js       # 配置 & 工具
│   └── Dockerfile                 # Docker 部署
├── senior-analyst/                # Python 分析后端（端口 8765）
│   ├── api_server.py              # FastAPI 服务
│   ├── sources/                   # 多数据源适配（AkShare/YFinance/东方财富等）
│   └── skill/                     # 分析 playbooks & 行业知识库
└── financial-report-minesweeper/  # 财报排雷模块
    ├── scripts/                   # Tushare 数据采集 & 排雷分析
    └── 手把手读财报/                 # 财报阅读指南
```

## 快速启动

```bash
# 仪表盘
cd web-dashboard
npm install
node server.js
# 访问 http://localhost:8080

# 财报排雷（可选）
cd senior-analyst
pip install -r requirements.txt
python api_server.py
```
