# chatbot image. Build from the REPOSITORY ROOT (the build needs the shared lockfile):
#   docker build -f chatbot/Dockerfile -t chatbot .
# On Railway: set RAILWAY_DOCKERFILE_PATH=chatbot/Dockerfile and leave Root Directory empty
# (the .railway/railway.ts config does this for you).

FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY file-server/package.json file-server/
COPY mcp-server/package.json mcp-server/
COPY client/package.json client/
COPY chatbot/package.json chatbot/
RUN npm ci --omit=dev --workspace chatbot --workspace mcp-server --no-audit --no-fund && npm cache clean --force

FROM node:22-slim
ENV NODE_ENV=production \
    HOST=:: \
    PORT=3000
WORKDIR /app
COPY --from=deps /app /app
# mcp-server is included so the chatbot can also run it locally over stdio when no MCP_SERVER_HOST is set.
COPY mcp-server/src mcp-server/src
COPY chatbot/src chatbot/src
COPY chatbot/public chatbot/public
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
USER node
CMD ["node", "chatbot/src/server.js"]
