FROM harbor.internal.zenmen.com/basis/python-nodejs:python3.12-nodejs20

WORKDIR /app

# ---- Node.js dependencies ----
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev 2>/dev/null || npm install --omit=dev

# ---- Python dependencies (Tsinghua mirror for China) ----
COPY senior-analyst/requirements.txt ./senior-analyst/requirements.txt
RUN pip install --no-cache-dir -i https://pypi.tuna.tsinghua.edu.cn/simple \
    -r senior-analyst/requirements.txt \
    && pip install --no-cache-dir -i https://pypi.tuna.tsinghua.edu.cn/simple \
    fastapi uvicorn

# ---- Application code ----
COPY . .

# Bind to all interfaces inside the container
ENV SA_API_HOST=0.0.0.0
ENV SA_API_PORT=8765
EXPOSE 8080 8765

# Start Python API in background, Node.js in foreground
CMD SA_API_HOST=${SA_API_HOST} SA_API_PORT=${SA_API_PORT} \
    python senior-analyst/api_server.py & \
    node server.js
