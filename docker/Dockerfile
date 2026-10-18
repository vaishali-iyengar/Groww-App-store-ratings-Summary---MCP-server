# Build:  docker build -f docker/Dockerfile -t google-workspace-mcp .
# Run:    docker run --env-file .env -e MCP_HTTP_HOST=0.0.0.0 -p 3000:3000 \
#           -v gwmcp-data:/data google-workspace-mcp
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production DATA_DIR=/data MCP_TRANSPORT=http MCP_HTTP_PORT=3000
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "dist/index.js"]
