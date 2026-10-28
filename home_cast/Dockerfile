ARG BUILD_FROM
FROM ${BUILD_FROM}

RUN apk add --no-cache nodejs npm

WORKDIR /app
COPY app/package.json app/package-lock.json ./
COPY app/scripts ./scripts
RUN npm ci --omit=dev && npm cache clean --force
COPY app/index.mjs ./

# The receiver keeps its pairing data (node-persist) in the working directory.
WORKDIR /data
# Node runs as PID 1 itself (no s6 init); it handles SIGTERM.
ENTRYPOINT ["node", "/app/index.mjs"]
