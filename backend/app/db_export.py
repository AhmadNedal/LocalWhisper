"""Insert a transcript into the user's own database with a user-written SQL statement.

The user writes an ordinary INSERT (or any DML) and references transcript
values through named variables such as ``@text`` or ``:start_seconds``. This
module:

1. converts those variables to the driver's placeholder syntax — values are
   always sent as bound **parameters**, never pasted into the SQL text, so
   Arabic quotes/apostrophes can't break the statement and there is no SQL
   injection;
2. builds one parameter set per row according to the chosen mode
   (fixed-length chunks, raw Whisper segments, or the whole transcript);
3. runs an optional "before" statement once and all inserts inside a single
   transaction — everything is committed, or nothing is.

Supported engines and drivers (all installed with pip, no system client needed):

* SQL Server  → ``pyodbc`` when a modern "ODBC Driver 17/18 for SQL Server" is
  installed (supports Windows authentication), otherwise ``pymssql``
* Oracle      → ``oracledb`` (thin mode, no Oracle Instant Client needed)
* MySQL/MariaDB → ``PyMySQL``
* PostgreSQL  → ``psycopg`` 3
"""

from __future__ import annotations

import json

import logging
import re
import time
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Callable, Literal

from .errors import AppError, ErrorCode
from .pdf_export import ExportSegment, build_paragraphs, format_timestamp

log = logging.getLogger(__name__)

DbType = Literal["sqlserver", "oracle", "mysql", "postgresql"]
Mode = Literal["chunks", "segments", "full"]

CONNECT_TIMEOUT = 15
QUERY_TIMEOUT = 300

# Variables the user can reference in SQL (besides their own custom variables).
ROW_VARIABLES = (
    "text",
    "start_seconds",
    "end_seconds",
    "start_time",
    "end_time",
    "segment_index",
    "translation",  # translated text of the same time range (NULL when there is no translation)
    "text_en",  # = translation when it is English
)
FILE_VARIABLES = (
    "file_name",
    "file_path",
    "language",
    "model",
    "duration_seconds",
    "segment_count",
    "full_text",
    "transcribed_at",
    # Translation / AI summary / archive (NULL when not available)
    "full_translation",
    "translation_language",
    "full_text_en",
    "summary",
    "key_points",
    "chapters",
    "chapters_json",
    "keywords",
    "course",
    # Per lesson when inserting a whole course or from the queue (1-based order in the course)
    "lesson_index",
    "lesson_title",
    "youtube_id",
)
BUILTIN_VARIABLES = ROW_VARIABLES + FILE_VARIABLES
_NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,62}$")


# --------------------------------------------------------------------------- data
@dataclass
class TranscriptPayload:
    segments: list[ExportSegment]
    file_name: str
    file_path: str
    language: str
    model: str
    duration: float | None
    translation: list[ExportSegment] | None = None
    translation_language: str = ""
    summary: dict[str, Any] | None = None
    course: str = ""
    lesson_index: int | None = None


@dataclass
class DbRequest:
    db_type: DbType
    connection_string: str
    sql: str
    pre_sql: str = ""
    mode: Mode = "chunks"
    chunk_seconds: int = 10
    variables: dict[str, str] = field(default_factory=dict)


# ------------------------------------------------------------------ SQL rewriting
@dataclass
class ConvertedSql:
    sql: str
    order: list[str]  # parameter names in positional order (qmark drivers)
    used: list[str]  # distinct variable names referenced
    unknown: list[str]  # @names that look like variables but aren't defined


def convert_sql(sql: str, known: set[str], style: Literal["pyformat", "named", "qmark"]) -> ConvertedSql:
    """Replace ``@name`` / ``:name`` variables with driver placeholders.

    A small tokenizer skips string literals, quoted identifiers ("x", [x],
    `x`) and comments, so text such as ``'user@example.com'`` or ``'10:30'``
    is never touched. ``@@IDENTITY``, ``::int`` casts and variables the user
    DECLAREs themselves are left alone.
    """
    known_lower = {k.lower(): k for k in known}
    out: list[str] = []
    order: list[str] = []
    used: list[str] = []
    unknown: list[str] = []
    i, n = 0, len(sql)

    def emit_literal(chunk: str) -> None:
        # With pyformat drivers every literal % must be doubled.
        out.append(chunk.replace("%", "%%") if style == "pyformat" else chunk)

    while i < n:
        ch = sql[i]
        nxt = sql[i + 1] if i + 1 < n else ""
        # -- line comment
        if ch == "-" and nxt == "-":
            j = sql.find("\n", i)
            j = n if j == -1 else j
            emit_literal(sql[i:j])
            i = j
            continue
        # /* block comment */
        if ch == "/" and nxt == "*":
            j = sql.find("*/", i + 2)
            j = n if j == -1 else j + 2
            emit_literal(sql[i:j])
            i = j
            continue
        # quoted strings / identifiers
        if ch in ("'", '"', "`", "["):
            close = "]" if ch == "[" else ch
            j = i + 1
            while j < n:
                if sql[j] == close:
                    if close != "]" and j + 1 < n and sql[j + 1] == close:  # '' escape
                        j += 2
                        continue
                    break
                j += 1
            j = min(j + 1, n)
            emit_literal(sql[i:j])
            i = j
            continue
        # variables
        if ch in ("@", ":"):
            prev = sql[i - 1] if i > 0 else ""
            m = re.match(r"[A-Za-z_][A-Za-z0-9_]*", sql[i + 1 :])
            if m and prev not in ("@", ":") and not (prev.isalnum() or prev == "_") and nxt not in ("@", ":"):
                name = m.group(0)
                canonical = known_lower.get(name.lower())
                if canonical:
                    if canonical not in used:
                        used.append(canonical)
                    if style == "qmark":
                        out.append("?")
                        order.append(canonical)
                    elif style == "named":
                        out.append(f":p_{canonical}")
                    else:
                        out.append(f"%(p_{canonical})s")
                    i += 1 + len(name)
                    continue
                if ch == "@" and name.lower() not in unknown:
                    unknown.append(name.lower())
        emit_literal(ch)
        i += 1
    return ConvertedSql("".join(out), order, used, unknown)


# ---------------------------------------------------------------------- rows
def _chunk_segments(segments: list[ExportSegment], seconds: int) -> list[ExportSegment]:
    """Merge consecutive segments until each chunk spans at least ``seconds``."""
    chunks: list[ExportSegment] = []
    current: ExportSegment | None = None
    for seg in segments:
        text = seg.text.strip()
        if not text:
            continue
        if current is None:
            current = ExportSegment(seg.start, seg.end, text)
        else:
            current.text = f"{current.text} {text}"
            current.end = seg.end
        if current.end - current.start >= seconds:
            chunks.append(current)
            current = None
    if current is not None:
        chunks.append(current)
    return chunks


def full_text(segments: list[ExportSegment]) -> str:
    return "\n\n".join(p.text for p in build_paragraphs(segments))


def _coerce(value: str) -> Any:
    """Custom variable values: integers and decimals are sent as numbers."""
    v = value.strip()
    if re.fullmatch(r"-?(0|[1-9]\d{0,17})", v):  # keep "007" / GUIDs as text
        return int(v)
    if re.fullmatch(r"-?\d+\.\d+", v):
        return float(v)
    return value


def build_rows(req: DbRequest, payload: TranscriptPayload) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Return (file-level params, per-row params)."""
    segments = [s for s in payload.segments if s.text.strip()]
    if not segments:
        raise AppError(ErrorCode.INVALID_REQUEST, "Transcript is empty")

    whole = full_text(segments)
    duration = payload.duration or (segments[-1].end if segments else 0.0)
    common: dict[str, Any] = {
        "file_name": payload.file_name,
        "file_path": payload.file_path,
        "language": payload.language,
        "model": payload.model,
        "duration_seconds": round(float(duration), 2),
        "full_text": whole,
        "transcribed_at": datetime.now().replace(microsecond=0),
        **_extra_file_values(payload),
    }
    for name, value in req.variables.items():
        common[name] = _coerce(value)

    if req.mode == "full":
        units = [ExportSegment(0.0, float(duration), whole)]
    elif req.mode == "segments":
        units = segments
    else:
        units = _chunk_segments(segments, max(1, int(req.chunk_seconds)))

    common["segment_count"] = len(units)
    trans = [t for t in (payload.translation or []) if t.text.strip()]
    is_en = payload.translation_language.lower().startswith("en")
    integer_times = req.mode == "chunks"
    rows = []
    for idx, unit in enumerate(units, start=1):
        start = int(unit.start) if integer_times else round(unit.start, 2)
        end = int(round(unit.end)) if integer_times else round(unit.end, 2)
        translated = _translation_for(unit, trans, req.mode)
        rows.append(
            {
                **common,
                "translation": translated,
                "text_en": translated if is_en else None,
                "text": unit.text.strip(),
                "start_seconds": start,
                "end_seconds": end,
                "start_time": format_timestamp(unit.start),
                "end_time": format_timestamp(unit.end),
                "segment_index": idx,
            }
        )
    return common, rows


def _extra_file_values(payload: TranscriptPayload) -> dict[str, Any]:
    """File-level values from the translation, the AI summary and the archive."""
    trans = [t for t in (payload.translation or []) if t.text.strip()]
    full_translation = " ".join(t.text.strip() for t in trans) or None
    is_en = payload.translation_language.lower().startswith("en")
    summary = payload.summary or {}
    chapters = [c for c in (summary.get("chapters") or []) if isinstance(c, dict)]
    key_points = [str(k).strip() for k in (summary.get("key_points") or []) if str(k).strip()]
    keywords = [str(k).strip() for k in (summary.get("keywords") or []) if str(k).strip()]
    return {
        "full_translation": full_translation,
        "translation_language": payload.translation_language or None if trans else None,
        "full_text_en": full_translation if is_en else None,
        "summary": str(summary.get("summary") or "").strip() or None,
        "key_points": "\n".join(f"• {k}" for k in key_points) or None,
        "chapters": "\n".join(
            f"{format_timestamp(float(c.get('start') or 0))} {str(c.get('title') or '').strip()}" for c in chapters
        )
        or None,
        "chapters_json": json.dumps(
            [
                {"start": round(float(c.get("start") or 0), 2), "title": c.get("title", ""), "summary": c.get("summary", "")}
                for c in chapters
            ],
            ensure_ascii=False,
        )
        if chapters
        else None,
        "keywords": ", ".join(keywords) or None,
        "course": payload.course.strip() or None,
        "lesson_index": payload.lesson_index,
        "lesson_title": _lesson_title(payload.file_name),
        "youtube_id": _youtube_id(payload.file_path),
    }


def _lesson_title(name: str) -> str | None:
    """File name without its extension (a YouTube title is kept as is)."""
    name = (name or "").strip()
    stem, dot, ext = name.rpartition(".")
    if dot and stem and 1 <= len(ext) <= 5 and ext.isalnum():
        return stem.strip()
    return name or None


def _youtube_id(source: str) -> str | None:
    m = re.search(r"(?:v=|youtu\.be/|/shorts/|/embed/)([A-Za-z0-9_-]{11})", source or "")
    return m.group(1) if m else None


def _translation_for(unit: ExportSegment, trans: list[ExportSegment], mode: str) -> str | None:
    """Translated text covering the same time range as ``unit``."""
    if not trans:
        return None
    if mode == "full":
        return " ".join(t.text.strip() for t in trans)
    if mode == "segments":
        best = min(trans, key=lambda t: abs(t.start - unit.start))
        return best.text.strip() if abs(best.start - unit.start) < 0.05 else None
    # chunks: every translated segment that starts inside this chunk
    parts = [t.text.strip() for t in trans if unit.start - 0.01 <= t.start < unit.end - 0.01]
    return " ".join(parts) or None


def _validate_variables(variables: dict[str, str]) -> None:
    for name in variables:
        if not _NAME_RE.match(name):
            raise AppError(ErrorCode.INVALID_REQUEST, f"Invalid variable name '{name}'")
        if name.lower() in BUILTIN_VARIABLES:
            raise AppError(ErrorCode.INVALID_REQUEST, f"'{name}' is a built-in variable name")


# ------------------------------------------------------------ connection strings
def parse_kv(conn: str) -> dict[str, str]:
    """Parse 'Key=Value;Key2={va;lue}' style strings (ADO.NET / ODBC / Npgsql)."""
    result: dict[str, str] = {}
    i, n = 0, len(conn)
    while i < n:
        while i < n and conn[i] in " ;\t\r\n":
            i += 1
        eq = conn.find("=", i)
        if eq == -1:
            break
        key = conn[i:eq].strip().lower()
        i = eq + 1
        while i < n and conn[i] == " ":
            i += 1
        if i < n and conn[i] in "{\"'":
            close = "}" if conn[i] == "{" else conn[i]
            j = conn.find(close, i + 1)
            j = n if j == -1 else j
            value = conn[i + 1 : j]
            i = j + 1
            semi = conn.find(";", i)
            i = n if semi == -1 else semi + 1
        else:
            semi = conn.find(";", i)
            semi = n if semi == -1 else semi
            value = conn[i:semi].strip()
            i = semi + 1
        if key:
            result[key] = value
    return result


def _pick(kv: dict[str, str], *names: str, default: str | None = None) -> str | None:
    for name in names:
        if name in kv and kv[name] != "":
            return kv[name]
    return default


def _truthy(value: str | None) -> bool:
    return (value or "").strip().lower() in ("true", "yes", "sspi", "1", "mandatory", "strict")


class _Driver:
    """Thin adapter: connect() + the placeholder style of the driver."""

    style: Literal["pyformat", "named", "qmark"] = "pyformat"
    name = ""

    def connect(self):  # noqa: ANN201
        raise NotImplementedError


def _missing(pkg: str, exc: Exception) -> AppError:
    return AppError(
        ErrorCode.DB_DRIVER_MISSING,
        f"Python package '{pkg}' is not installed ({exc}). Run `npm run setup`.",
    )


class _SqlServer(_Driver):
    def __init__(self, conn: str) -> None:
        self.raw = conn.strip()
        self.kv = parse_kv(self.raw)
        self.style, self.name = self._choose()

    def _choose(self) -> tuple[Literal["pyformat", "qmark"], str]:
        wants_windows_auth = _truthy(_pick(self.kv, "integrated security", "trusted_connection"))
        explicit_odbc = "driver" in self.kv
        try:
            import pyodbc  # noqa: F401

            drivers = [d for d in pyodbc.drivers() if "SQL Server" in d]
            modern = [d for d in drivers if "ODBC Driver" in d]
            if explicit_odbc or modern or (wants_windows_auth and drivers):
                self._odbc_driver = (modern or drivers or ["SQL Server"])[-1]
                return "qmark", "pyodbc"
        except ImportError:
            if explicit_odbc:
                raise
        return "pyformat", "pymssql"

    def _server_port(self) -> tuple[str, int | None]:
        server = _pick(self.kv, "server", "data source", "address", "addr", "network address") or "localhost"
        server = re.sub(r"^(tcp|np|lpc):", "", server, flags=re.I).strip()
        port: int | None = None
        if "," in server:
            server, _, p = server.partition(",")
            port = int(p.strip()) if p.strip().isdigit() else None
        host, sep, instance = server.partition("\\")
        if host.strip().lower() in (".", "(local)", "(localdb)"):
            host = "localhost"
        server = f"{host}{sep}{instance}"
        return server.strip(), port

    def connect(self):  # noqa: ANN201
        if self.name == "pyodbc":
            import pyodbc

            if "driver" in self.kv:
                conn_str = self.raw
            else:
                server, port = self._server_port()
                parts = [
                    f"DRIVER={{{self._odbc_driver}}}",
                    f"SERVER={server}{',' + str(port) if port else ''}",
                ]
                db = _pick(self.kv, "database", "initial catalog")
                if db:
                    parts.append(f"DATABASE={db}")
                if _truthy(_pick(self.kv, "integrated security", "trusted_connection")):
                    parts.append("Trusted_Connection=yes")
                else:
                    parts.append(f"UID={_pick(self.kv, 'user id', 'uid', 'user', 'username') or ''}")
                    parts.append(f"PWD={{{(_pick(self.kv, 'password', 'pwd') or '').replace('}', '}}')}}}")
                encrypt = _pick(self.kv, "encrypt")
                if encrypt is not None:
                    parts.append(f"Encrypt={'yes' if _truthy(encrypt) else 'no'}")
                if _truthy(_pick(self.kv, "trustservercertificate", "trust server certificate")):
                    parts.append("TrustServerCertificate=yes")
                conn_str = ";".join(parts)
            conn = pyodbc.connect(conn_str, timeout=CONNECT_TIMEOUT, autocommit=False)
            conn.timeout = QUERY_TIMEOUT
            return conn

        try:
            import pymssql
        except ImportError as exc:
            raise _missing("pymssql", exc) from exc
        server, port = self._server_port()
        instance = None
        if "\\" in server:
            server, _, instance = server.partition("\\")
        kwargs: dict[str, Any] = {
            "server": f"{server}\\{instance}" if instance else server,
            "user": _pick(self.kv, "user id", "uid", "user", "username") or "",
            "password": _pick(self.kv, "password", "pwd") or "",
            "database": _pick(self.kv, "database", "initial catalog") or "",
            "login_timeout": CONNECT_TIMEOUT,
            "timeout": QUERY_TIMEOUT,
            "charset": "UTF-8",
            "autocommit": False,
        }
        if port:
            kwargs["port"] = str(port)
        return pymssql.connect(**kwargs)


class _Oracle(_Driver):
    style = "named"
    name = "oracledb"

    def __init__(self, conn: str) -> None:
        self.raw = conn.strip()

    def connect(self):  # noqa: ANN201
        try:
            import oracledb
        except ImportError as exc:
            raise _missing("oracledb", exc) from exc
        raw = self.raw
        if "=" in raw and ";" in raw and not raw.lstrip().startswith("("):
            kv = parse_kv(raw)
            user = _pick(kv, "user id", "user", "uid", "username") or ""
            password = _pick(kv, "password", "pwd") or ""
            dsn = _pick(kv, "data source", "dsn", "server") or ""
        else:
            # EZConnect: user/password@host:port/service
            creds, sep, dsn = raw.rpartition("@")
            if not sep:
                raise AppError(ErrorCode.INVALID_REQUEST, "Oracle connection string must look like user/password@host:1521/service")
            user, _, password = creds.partition("/")
        return oracledb.connect(user=user, password=password, dsn=dsn, tcp_connect_timeout=CONNECT_TIMEOUT)


class _MySql(_Driver):
    style = "pyformat"
    name = "pymysql"

    def __init__(self, conn: str) -> None:
        self.raw = conn.strip()

    def connect(self):  # noqa: ANN201
        try:
            import pymysql
        except ImportError as exc:
            raise _missing("PyMySQL", exc) from exc
        from urllib.parse import unquote, urlparse

        raw = self.raw
        if re.match(r"^(mysql|mariadb)(\+\w+)?://", raw, re.I):
            u = urlparse(raw)
            kwargs = {
                "host": u.hostname or "localhost",
                "port": u.port or 3306,
                "user": unquote(u.username or ""),
                "password": unquote(u.password or ""),
                "database": (u.path or "/").lstrip("/") or None,
            }
        else:
            kv = parse_kv(raw)
            kwargs = {
                "host": _pick(kv, "server", "host", "data source", "address") or "localhost",
                "port": int(_pick(kv, "port", default="3306") or 3306),
                "user": _pick(kv, "uid", "user id", "user", "username") or "",
                "password": _pick(kv, "pwd", "password") or "",
                "database": _pick(kv, "database", "initial catalog"),
            }
        return pymysql.connect(
            **kwargs,
            charset="utf8mb4",
            connect_timeout=CONNECT_TIMEOUT,
            read_timeout=QUERY_TIMEOUT,
            write_timeout=QUERY_TIMEOUT,
            autocommit=False,
        )


class _Postgres(_Driver):
    style = "pyformat"
    name = "psycopg"

    def __init__(self, conn: str) -> None:
        self.raw = conn.strip()

    def connect(self):  # noqa: ANN201
        try:
            import psycopg
        except ImportError as exc:
            raise _missing("psycopg", exc) from exc
        raw = self.raw
        if ";" in raw and "://" not in raw:
            # Npgsql style: Host=..;Port=..;Database=..;Username=..;Password=..
            kv = parse_kv(raw)
            kwargs = {
                "host": _pick(kv, "host", "server", "data source") or "localhost",
                "port": int(_pick(kv, "port", default="5432") or 5432),
                "dbname": _pick(kv, "database", "initial catalog", "dbname"),
                "user": _pick(kv, "username", "user id", "user", "uid"),
                "password": _pick(kv, "password", "pwd"),
            }
            ssl = _pick(kv, "ssl mode", "sslmode")
            if ssl:
                kwargs["sslmode"] = ssl.lower()
            return psycopg.connect(
                **{k: v for k, v in kwargs.items() if v is not None}, connect_timeout=CONNECT_TIMEOUT
            )
        return psycopg.connect(raw, connect_timeout=CONNECT_TIMEOUT)


def make_driver(db_type: str, connection_string: str) -> _Driver:
    if not connection_string.strip():
        raise AppError(ErrorCode.INVALID_REQUEST, "Connection string is empty")
    factories: dict[str, Callable[[str], _Driver]] = {
        "sqlserver": _SqlServer,
        "oracle": _Oracle,
        "mysql": _MySql,
        "postgresql": _Postgres,
    }
    factory = factories.get(db_type)
    if factory is None:
        raise AppError(ErrorCode.INVALID_REQUEST, f"Unsupported database type '{db_type}'")
    try:
        return factory(connection_string)
    except ImportError as exc:
        raise _missing(str(exc.name or "driver"), exc) from exc


# ---------------------------------------------------------------- operations
def _db_error(exc: Exception) -> AppError:
    """Database errors are shown to the user verbatim — they are actionable."""
    if isinstance(exc, AppError):
        return exc
    text = " ".join(str(exc).split()) or exc.__class__.__name__
    lowered = text.lower()
    connect_words = ("login", "connect", "timeout", "timed out", "authentication", "password", "host", "network", "refused", "resolve", "tns")
    code = ErrorCode.DB_CONNECT_FAILED if any(w in lowered for w in connect_words) else ErrorCode.DB_QUERY_FAILED
    return AppError(code, f"{exc.__class__.__name__}: {text}"[:800])


def _server_version(conn, driver: _Driver) -> str:  # noqa: ANN001
    queries = {
        "pymssql": "SELECT @@VERSION",
        "pyodbc": "SELECT @@VERSION",
        "pymysql": "SELECT VERSION()",
        "psycopg": "SELECT version()",
        "oracledb": "SELECT banner FROM v$version WHERE ROWNUM = 1",
    }
    try:
        cur = conn.cursor()
        cur.execute(queries[driver.name])
        row = cur.fetchone()
        cur.close()
        return str(row[0]).splitlines()[0][:160] if row else ""
    except Exception:  # noqa: BLE001 - version is informational only
        return getattr(conn, "version", "") or ""


def test_connection(db_type: str, connection_string: str) -> dict[str, Any]:
    driver = make_driver(db_type, connection_string)
    started = time.time()
    try:
        conn = driver.connect()
    except Exception as exc:  # noqa: BLE001
        raise _db_error(exc) from exc
    try:
        version = _server_version(conn, driver)
    finally:
        try:
            conn.close()
        except Exception:  # noqa: BLE001
            pass
    return {"ok": True, "driver": driver.name, "serverVersion": version, "elapsedMs": int((time.time() - started) * 1000)}


def _params(values: dict[str, Any], converted: ConvertedSql, style: str) -> Any:
    if style == "qmark":
        return [values.get(name) for name in converted.order]
    return {f"p_{name}": values.get(name) for name in converted.used}


def _clean_statement(sql: str, db_type: str) -> str:
    """Oracle rejects a trailing ';' on plain SQL (ORA-00933) but PL/SQL blocks need it."""
    sql = sql.strip()
    if db_type == "oracle" and not re.match(r"^(begin|declare)\b", sql, re.I):
        sql = sql.rstrip().rstrip(";").rstrip()
    return sql


def prepare(req: DbRequest, payload: TranscriptPayload, style: str) -> dict[str, Any]:
    _validate_variables(req.variables)
    if not req.sql.strip():
        raise AppError(ErrorCode.INVALID_REQUEST, "SQL statement is empty")
    known = set(BUILTIN_VARIABLES) | set(req.variables)
    main = convert_sql(_clean_statement(req.sql, req.db_type), known, style)  # type: ignore[arg-type]
    pre_sql = req.pre_sql.strip()
    pre_known = set(FILE_VARIABLES) | set(req.variables)
    pre = convert_sql(_clean_statement(pre_sql, req.db_type), pre_known, style) if pre_sql else None  # type: ignore[arg-type]
    common, rows = build_rows(req, payload)
    return {"main": main, "pre": pre, "common": common, "rows": rows}


def preview(req: DbRequest, payload: TranscriptPayload) -> dict[str, Any]:
    if req.connection_string.strip():
        style = make_driver(req.db_type, req.connection_string).style
    else:
        style = "named" if req.db_type == "oracle" else "pyformat"
    prepared = prepare(req, payload, style)
    main: ConvertedSql = prepared["main"]
    pre: ConvertedSql | None = prepared["pre"]
    rows = prepared["rows"]
    row_vars_in_pre = [v for v in (pre.unknown if pre else []) if v in ROW_VARIABLES]

    def jsonable(d: dict[str, Any], names: list[str]) -> dict[str, Any]:
        out = {}
        for name in names:
            v = d.get(name)
            out[name] = v.isoformat(sep=" ") if isinstance(v, datetime) else v
        return out

    return {
        "rowCount": len(rows),
        "sql": main.sql,
        "preSql": pre.sql if pre else "",
        "used": main.used,
        "unknown": main.unknown + [f"{v} (before-statement)" for v in (pre.unknown if pre else []) if v not in row_vars_in_pre],
        "rowVariablesInPre": row_vars_in_pre,
        "sample": [jsonable(r, main.used) for r in rows[:3]],
    }


def execute(req: DbRequest, payload: TranscriptPayload) -> dict[str, Any]:
    driver = make_driver(req.db_type, req.connection_string)
    prepared = prepare(req, payload, driver.style)
    main: ConvertedSql = prepared["main"]
    pre: ConvertedSql | None = prepared["pre"]
    if pre and any(v in ROW_VARIABLES for v in pre.unknown):
        raise AppError(
            ErrorCode.INVALID_REQUEST,
            "The 'before' statement runs once, so it can only use file-level and custom variables",
        )
    rows = prepared["rows"]
    started = time.time()
    try:
        conn = driver.connect()
    except Exception as exc:  # noqa: BLE001
        raise _db_error(exc) from exc
    try:
        cur = conn.cursor()
        if pre:
            cur.execute(pre.sql, _params(prepared["common"], pre, driver.style))
        params = [_params(r, main, driver.style) for r in rows]
        if driver.name == "pyodbc":
            cur.fast_executemany = False  # NVARCHAR(MAX) + Arabic safe path
        cur.executemany(main.sql, params)
        conn.commit()
        cur.close()
    except Exception as exc:  # noqa: BLE001
        try:
            conn.rollback()
        except Exception:  # noqa: BLE001
            pass
        log.warning("DB insert failed: %s", exc)
        raise _db_error(exc) from exc
    finally:
        try:
            conn.close()
        except Exception:  # noqa: BLE001
            pass
    return {
        "ok": True,
        "inserted": len(rows),
        "driver": driver.name,
        "elapsedMs": int((time.time() - started) * 1000),
    }
