"""
FastAPI HTTP wrapper for the Claudia Memory Daemon.

Exposes the core memory tools (remember, recall, about, relate, briefing)
as HTTP POST endpoints with API key authentication. This allows non-MCP
clients like the Slack bot to interact with the memory system over HTTP.

Usage:
    uvicorn claudia_memory.http_server:app --port 3850
    # or launched by __main__.py with:  python -m claudia_memory http-server --port 3850

Authentication:
    All endpoints require an Authorization: Bearer <MEMORY_API_KEY> header.
    Set MEMORY_API_KEY in the environment. If unset, a random key is generated
    at startup and printed to stdout.

Multi-user routing:
    Pass user_id in the request body to route to a per-user SQLite database.
    If omitted, the global claudia.db is used (standard Claude Code session).
"""

import logging
import os
import secrets
from typing import List, Optional

from fastapi import Depends, FastAPI, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field

from .db_manager import DatabaseManager

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# API key auth
# ---------------------------------------------------------------------------

_MEMORY_API_KEY: str = os.environ.get("MEMORY_API_KEY", "")

if not _MEMORY_API_KEY:
    _MEMORY_API_KEY = secrets.token_urlsafe(32)
    print(
        f"[claudia-memory-http] No MEMORY_API_KEY set. "
        f"Generated key: {_MEMORY_API_KEY}\n"
        f"Copy this into your .env as MEMORY_API_KEY=<value>"
    )

_security = HTTPBearer()


def _require_api_key(credentials: HTTPAuthorizationCredentials = Depends(_security)) -> None:
    if credentials.credentials != _MEMORY_API_KEY:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid API key",
        )


# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------


class RememberRequest(BaseModel):
    content: str = Field(..., description="Fact or memory to store")
    memory_type: str = Field("fact", description="Type: fact, preference, commitment, etc.")
    entities: List[str] = Field(default_factory=list, description="Entity names to associate")
    importance: float = Field(0.7, ge=0.0, le=1.0)
    source_channel: str = Field("slack", description="Origin channel identifier")
    user_id: Optional[str] = Field(None, description="Per-user routing key (Slack user ID)")


class RecallRequest(BaseModel):
    query: str = Field(..., description="Semantic search query")
    limit: int = Field(10, ge=1, le=50)
    memory_types: Optional[List[str]] = Field(None, description="Filter by memory type")
    user_id: Optional[str] = Field(None)


class AboutRequest(BaseModel):
    entity_name: str = Field(..., description="Name of entity to retrieve context for")
    user_id: Optional[str] = Field(None)


class RelateRequest(BaseModel):
    source: str = Field(..., description="Source entity name")
    target: str = Field(..., description="Target entity name")
    relationship: str = Field(..., description="Relationship description")
    strength: float = Field(0.5, ge=0.0, le=1.0)
    user_id: Optional[str] = Field(None)


class BriefingRequest(BaseModel):
    user_id: Optional[str] = Field(None)


# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------

app = FastAPI(
    title="Claudia Memory HTTP API",
    description="HTTP wrapper for the Claudia Memory Daemon.",
    version="1.0.0",
)

_allowed_origins = os.environ.get("ALLOWED_ORIGINS", "*").split(",")
app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

_db_manager = DatabaseManager()


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------


@app.get("/health")
async def health():
    """Liveness probe. No authentication required."""
    from .config import get_config
    cfg = get_config()
    return {"status": "ok", "db_path": str(cfg.db_path)}


# ---------------------------------------------------------------------------
# /memory/remember
# ---------------------------------------------------------------------------


@app.post("/memory/remember", dependencies=[Depends(_require_api_key)])
async def memory_remember(body: RememberRequest):
    """Store a new memory. Returns the new memory ID."""
    try:
        with _db_manager.db_context(body.user_id):
            # Invalidate module-level service singleton so it opens the
            # correct per-user DB for this request.
            from .services import remember as _rem_mod
            _rem_mod._service = None

            from .services.remember import get_remember_service
            svc = get_remember_service()

            memory_id = svc.remember_fact(
                content=body.content,
                memory_type=body.memory_type,
                about_entities=body.entities,
                importance=body.importance,
                source_channel=body.source_channel,
            )
        return {"success": True, "memory_id": memory_id}
    except Exception as exc:
        logger.exception("remember failed")
        raise HTTPException(status_code=500, detail=str(exc))


# ---------------------------------------------------------------------------
# /memory/recall
# ---------------------------------------------------------------------------


@app.post("/memory/recall", dependencies=[Depends(_require_api_key)])
async def memory_recall(body: RecallRequest):
    """Semantic search over stored memories."""
    try:
        with _db_manager.db_context(body.user_id):
            from .services import recall as _rec_mod
            _rec_mod._service = None

            from .services.recall import get_recall_service
            svc = get_recall_service()

            results = svc.recall(
                query=body.query,
                limit=body.limit,
                memory_types=body.memory_types,
            )

        return {
            "results": [
                {
                    "id": r.id,
                    "content": r.content,
                    "type": r.type,
                    "score": r.score,
                    "importance": r.importance,
                    "created_at": r.created_at,
                    "entities": r.entities,
                }
                for r in results
            ]
        }
    except Exception as exc:
        logger.exception("recall failed")
        raise HTTPException(status_code=500, detail=str(exc))


# ---------------------------------------------------------------------------
# /memory/about
# ---------------------------------------------------------------------------


@app.post("/memory/about", dependencies=[Depends(_require_api_key)])
async def memory_about(body: AboutRequest):
    """Retrieve everything known about a named entity."""
    try:
        with _db_manager.db_context(body.user_id):
            from .services import recall as _rec_mod
            _rec_mod._service = None

            from .services.recall import get_recall_service
            svc = get_recall_service()

            result = svc.recall_about(entity_name=body.entity_name)

        return result if result else {"entity": None, "memories": [], "relationships": []}
    except Exception as exc:
        logger.exception("about failed")
        raise HTTPException(status_code=500, detail=str(exc))


# ---------------------------------------------------------------------------
# /memory/relate
# ---------------------------------------------------------------------------


@app.post("/memory/relate", dependencies=[Depends(_require_api_key)])
async def memory_relate(body: RelateRequest):
    """Create or update a relationship between two entities."""
    try:
        with _db_manager.db_context(body.user_id):
            from .services import remember as _rem_mod
            _rem_mod._service = None

            from .services.remember import get_remember_service
            svc = get_remember_service()

            rel_id = svc.relate_entities(
                source_name=body.source,
                target_name=body.target,
                relationship_type=body.relationship,
                strength=body.strength,
            )
        return {"success": True, "relationship_id": rel_id}
    except Exception as exc:
        logger.exception("relate failed")
        raise HTTPException(status_code=500, detail=str(exc))


# ---------------------------------------------------------------------------
# /memory/briefing
# ---------------------------------------------------------------------------


@app.post("/memory/briefing", dependencies=[Depends(_require_api_key)])
async def memory_briefing(body: BriefingRequest):
    """
    Return a compact session briefing (~500 tokens).

    Includes overdue commitments, cooling relationships, recent activity,
    and pattern highlights.
    """
    try:
        with _db_manager.db_context(body.user_id):
            from .database import reset_db
            reset_db() 

            from .mcp.server import _build_briefing
            briefing_text = _build_briefing()

        return {"briefing": briefing_text}
    except Exception as exc:
        logger.exception("briefing failed")
        raise HTTPException(status_code=500, detail=str(exc))


# ---------------------------------------------------------------------------
# Shutdown hook: close all user DB connections cleanly
# ---------------------------------------------------------------------------


@app.on_event("shutdown")
async def on_shutdown():
    _db_manager.close_all()


