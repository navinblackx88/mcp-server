# One image for the whole project. Railway picks up this root Dockerfile automatically.
# start.js decides what runs, from SERVICE or Railway's RAILWAY_SERVICE_NAME:
#   file-server | mcp-server | chatbot  -> that service only (three-service setup)
#   anything else                       -> all-in-one (file server + chatbot + MCP over stdio)
#
#   docker build -t mcp-file-reader .
#   docker run -p 3000:3000 -v files:/data mcp-file-reader        # all-in-one on port 3000

FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY file-server/package.json file-server/
COPY mcp-server/package.json mcp-server/
COPY client/package.json client/
COPY chatbot/package.json chatbot/
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

FROM node:22-slim
# No fixed PORT: the app listens on the PORT the platform provides (Railway sets it), else 3000.
ENV NODE_ENV=production \
    HOST=:: \
    DATA_DIR=/data
WORKDIR /app
COPY --from=deps /app /app
COPY start.js ./
COPY file-server/src file-server/src
COPY mcp-server/src mcp-server/src
COPY chatbot/src chatbot/src
COPY chatbot/public chatbot/public
COPY client/src client/src
COPY sample-files sample-files
# Every mode answers /health on $PORT.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Runs as root on purpose: Railway mounts volumes owned by root, and the file server writes uploads there.
CMD ["node", "start.js"]
