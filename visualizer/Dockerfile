# Claudia Brain Visualizer
# Multi-stage build: build the React frontend, then serve via the Express server.

# ---------------------------------------------------------------------------
# Stage 1: Build the Vite/React frontend
# ---------------------------------------------------------------------------
FROM node:20-alpine AS builder

WORKDIR /app

# Copy manifests first for layer caching
COPY package.json package-lock.json* ./
RUN npm ci

# Copy source and build
COPY . .
RUN npm run build

# ---------------------------------------------------------------------------
# Stage 2: Production runtime (Express server + built frontend)
# ---------------------------------------------------------------------------
FROM node:20-alpine AS runtime

WORKDIR /app

# Non-root user
RUN addgroup -S claudia && adduser -S claudia -G claudia

# Install only production dependencies
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Copy built frontend from builder stage
COPY --from=builder /app/dist ./dist

# Copy server source (lib/, server.js, public/)
COPY lib/ ./lib/
COPY public/ ./public/
COPY server.js ./

RUN chown -R claudia:claudia /app

USER claudia

# Visualizer HTTP port
EXPOSE 3849

ENV NODE_ENV=production

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://localhost:3849/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js", "--port", "3849"]
