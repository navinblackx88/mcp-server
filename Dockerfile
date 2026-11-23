# One image for the whole project. Railway picks up this root Dockerfile automatically.
# start.js decides what runs, from SERVICE or Railway's RAILWAY_SERVICE_NAME:
#   file-server | mcp-server | chatbot  -> that service only (three-service setup)
#   anything else                       -> all-in-one (file server + chatbot + MCP over stdio)
#
#   docker build -t mcp-file-reader .
#   docker run -p 3000:3000 -e PORT=3000 -v files:/data mcp-file-reader        # all-in-one

FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY file-server/package.json file-server/
COPY mcp-server/package.json mcp-server/
COPY client/package.json client/
COPY chatbot/package.json chatbot/
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

FROM node:22-slim
ENV NODE_ENV=production \
    HOST=:: \
    PORT=3000 \
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
EXPOSE 3000
# Every mode answers /health on $PORT.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Runs as root on purpose: Railway mounts volumes owned by root, and the file server writes uploads there.
CMD ["node", "start.js"]
