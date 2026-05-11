# Claudia Slack Bot
# Multi-stage build: install deps then copy source

FROM node:20-alpine AS deps

WORKDIR /app

# Copy package files and install production dependencies only
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# ---------------------------------------------------------------------------

FROM node:20-alpine AS runtime

WORKDIR /app

# Non-root user for security
RUN addgroup -S claudia && adduser -S claudia -G claudia

# Copy installed node_modules and source
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Set ownership
RUN chown -R claudia:claudia /app

USER claudia

# Health probe uses the sidecar Express server
# In Socket Mode: PORT is the health port
# In HTTP mode: PORT is the Bolt receiver, PORT+1 is health
EXPOSE 3851

# Tini for proper signal handling (Alpine ships without it by default)
# install it via apk in the deps stage to keep the image lean
ENV NODE_ENV=production

CMD ["node", "server.js"]
