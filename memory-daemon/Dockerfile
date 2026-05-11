# Claudia Memory Daemon (HTTP mode)
# Runs the FastAPI HTTP wrapper over the memory MCP daemon.
# Uses a slim Python image with the claudia-memory package installed.

FROM python:3.12-slim AS base

# System deps: git for pip installs from VCS, curl for health checks
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    && rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
# Dependencies stage
# ---------------------------------------------------------------------------

FROM base AS deps

WORKDIR /build

# Copy only the dependency manifest first for layer caching
COPY pyproject.toml ./
# requirements.txt is optional (used for direct pip installs)
COPY requirements.txt* ./

# Install the claudia_memory package in editable mode so the source is live
RUN pip install --no-cache-dir \
    uvicorn[standard] \
    fastapi \
    httpx

# ---------------------------------------------------------------------------
# Runtime stage
# ---------------------------------------------------------------------------

FROM base AS runtime

WORKDIR /app

# Non-root user
RUN useradd -m -s /bin/sh claudia

# Install runtime Python deps
COPY pyproject.toml ./
COPY requirements.txt* ./
RUN pip install --no-cache-dir \
    uvicorn[standard] \
    fastapi \
    && pip install --no-cache-dir -e .

# Copy source
COPY claudia_memory/ ./claudia_memory/

# Create the claudia home directory so the daemon can write its DB
# In Docker this is mounted from a volume (see docker-compose.yml)
RUN mkdir -p /home/claudia/.claudia/memory && \
    chown -R claudia:claudia /home/claudia

USER claudia
ENV HOME=/home/claudia

# HTTP API port (matches MEMORY_API_URL default port)
EXPOSE 3850

# Health check: call the /health endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:3850/health || exit 1

CMD ["uvicorn", "claudia_memory.http_server:app", "--host", "0.0.0.0", "--port", "3850"]
