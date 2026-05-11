"""
Multi-user DatabaseManager for Claudia Memory HTTP Server.

Routes requests to per-user SQLite databases stored at:
  ~/.claudia/memory/users/<user_id>/claudia.db

This keeps each Slack workspace user's memories completely isolated.
The global claudia.db (used by Claude Code sessions) is used when no
user_id is supplied.

Design decisions:
  - Each user gets their own DB file, schema is initialized on first access.
  - Connections are cached per user_id in a thread-safe dict.
  - A context manager temporarily overrides CLAUDIA_DB_OVERRIDE so that
    module-level get_db() calls (e.g. from _build_briefing) read the right DB.
  - The global singleton get_db() / get_config() are not replaced; we create
    fresh Database instances scoped to each user.
"""

import logging
import os
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Dict, Optional

logger = logging.getLogger(__name__)

# The base directory where per-user databases are stored.
# Overridable via USER_DB_BASE_DIR env var.
_DEFAULT_BASE_DIR = Path.home() / ".claudia" / "memory" / "users"
_USER_DB_BASE_DIR = Path(os.environ.get("USER_DB_BASE_DIR", str(_DEFAULT_BASE_DIR)))


class DatabaseManager:
    """
    Routes memory operations to per-user SQLite databases.

    Usage::

        mgr = DatabaseManager()

        # Get a Database instance for a specific Slack user
        db = mgr.get_db("U012AB3CD")

        # Temporarily set the environment override so module-level
        # get_db() also resolves to this user's database
        with mgr.db_context("U012AB3CD"):
            result = some_function_that_calls_get_db()
    """

    def __init__(self, base_dir: Optional[Path] = None):
        self._base_dir = base_dir or _USER_DB_BASE_DIR
        self._base_dir.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        # Cache: user_id -> Database instance
        self._connections: Dict[str, object] = {}

    def _db_path_for(self, user_id: str) -> Path:
        """Return the SQLite file path for a given user_id."""
        # Sanitize user_id to prevent directory traversal
        safe_id = "".join(c for c in user_id if c.isalnum() or c in "-_")
        if not safe_id:
            safe_id = "default"
        user_dir = self._base_dir / safe_id
        user_dir.mkdir(parents=True, exist_ok=True)
        return user_dir / "claudia.db"

    def get_db(self, user_id: Optional[str] = None):
        """
        Return a Database instance for the given user_id.

        If user_id is None or empty, returns the global database via the
        standard get_db() singleton (respects CLAUDIA_DB_OVERRIDE).
        """
        if not user_id:
            from .database import get_db as _global_get_db
            return _global_get_db()

        with self._lock:
            if user_id not in self._connections:
                self._connections[user_id] = self._open_user_db(user_id)
            return self._connections[user_id]

    def _open_user_db(self, user_id: str):
        """Open (or create) a per-user database with a fully initialized schema."""
        from .database import Database

        db_path = self._db_path_for(user_id)
        logger.info(f"Opening user DB for {user_id!r}: {db_path}")

        db = Database(db_path)
        # initialize() creates all tables via schema.sql if they don't exist.
        db.initialize()
        return db

    def close_user_db(self, user_id: str) -> None:
        """Close and remove the cached connection for a user."""
        with self._lock:
            db = self._connections.pop(user_id, None)
        if db is not None:
            try:
                db.close()
            except Exception:
                pass

    def close_all(self) -> None:
        """Close all cached connections (called on shutdown)."""
        with self._lock:
            ids = list(self._connections.keys())
        for uid in ids:
            self.close_user_db(uid)

    @contextmanager
    def db_context(self, user_id: Optional[str] = None):
        """
        Context manager that temporarily sets CLAUDIA_DB_OVERRIDE so that
        module-level get_db() calls resolve to this user's database.

        This is used when calling legacy functions (like _build_briefing)
        that do not accept a db parameter.

        Restores the original value on exit, even if an exception is raised.
        """
        if not user_id:
            yield
            return

        db_path = str(self._db_path_for(user_id))
        prev = os.environ.get("CLAUDIA_DB_OVERRIDE")
        os.environ["CLAUDIA_DB_OVERRIDE"] = db_path

        # Also invalidate the config cache so get_config() re-reads the new path.
        from . import config as _cfg_module
        old_config = _cfg_module._config
        _cfg_module._config = None

        try:
            yield
        finally:
            if prev is None:
                os.environ.pop("CLAUDIA_DB_OVERRIDE", None)
            else:
                os.environ["CLAUDIA_DB_OVERRIDE"] = prev
            # Restore the config cache state.
            _cfg_module._config = old_config
