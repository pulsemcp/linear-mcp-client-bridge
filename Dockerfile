# syntax=docker/dockerfile:1

# ---- Build stage: install everything and compile TypeScript ----
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- Runtime stage: production deps + compiled output only ----
FROM node:22-slim AS runtime
ENV NODE_ENV=production \
    HOME=/home/node \
    STATE_DIR=/data \
    PROJECT_ROOT=/app

WORKDIR /app

# Production dependencies only (includes the Claude Agent SDK + Claude Code CLI).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Compiled bridge.
COPY --from=build /app/dist ./dist

# Agent configuration the SDK loads from the project root at runtime.
COPY CLAUDE.md .mcp.json ./
COPY .claude ./.claude

# Persistent state (session id + poll cursor) lives on a mounted volume.
RUN mkdir -p /data && chown -R node:node /app /data /home/node
VOLUME ["/data"]

# Claude Code refuses to bypass permissions as root, so run unprivileged.
USER node

CMD ["node", "dist/index.js"]
