"""PostgreSQL + pgvector data layer for the Just Laws RAG backend.

Stores one row per law article chunk: metadata columns + a `vector` column,
with a cosine-distance index (ivfflat or hnsw) for similarity search.

Everything is connection-driven via ``DATABASE_URL`` (see config.py). This
module replaces the PoC's local Chroma store.
"""

import psycopg
from pgvector.psycopg import register_vector

import config

# Metadata columns mirror the chunk dicts produced by chunker.py.
_METADATA_COLUMNS = (
    "chunk_id",
    "law_name",
    "category",
    "slug",
    "book",
    "chapter",
    "section",
    "article_no",
    "article_num",
    "source_url",
    "context",
    "text",
)


def connect():
    """Open a connection with the pgvector type adapter registered."""
    conn = psycopg.connect(config.DATABASE_URL)
    # CREATE EXTENSION must run before register_vector can find the type.
    conn.execute("CREATE EXTENSION IF NOT EXISTS vector")
    conn.commit()
    register_vector(conn)
    return conn


def _create_index(conn):
    """Create the cosine-distance ANN index for the vector column."""
    table = config.PG_TABLE
    if config.PG_INDEX_TYPE == "hnsw":
        conn.execute(
            f"CREATE INDEX IF NOT EXISTS {table}_embedding_hnsw "
            f"ON {table} USING hnsw (embedding vector_cosine_ops)"
        )
    else:
        conn.execute(
            f"CREATE INDEX IF NOT EXISTS {table}_embedding_ivfflat "
            f"ON {table} USING ivfflat (embedding vector_cosine_ops) "
            f"WITH (lists = {config.PG_IVFFLAT_LISTS})"
        )


def init_schema(conn, recreate=False):
    """Create the chunk table (+ vector index). Optionally drop it first."""
    table = config.PG_TABLE
    if recreate:
        conn.execute(f"DROP TABLE IF EXISTS {table}")
    conn.execute(
        f"""
        CREATE TABLE IF NOT EXISTS {table} (
            chunk_id    TEXT PRIMARY KEY,
            law_name    TEXT NOT NULL,
            category    TEXT,
            slug        TEXT,
            book        TEXT,
            chapter     TEXT,
            section     TEXT,
            article_no  TEXT,
            article_num INTEGER,
            source_url  TEXT,
            context     TEXT,
            text        TEXT NOT NULL,
            embedding   vector({config.EMBEDDING_DIM}) NOT NULL
        )
        """
    )
    conn.execute(
        f"CREATE INDEX IF NOT EXISTS {table}_category_idx ON {table} (category)"
    )
    _create_index(conn)
    conn.commit()


def upsert_chunks(conn, chunks, vectors):
    """Insert/replace a batch of chunks with their embeddings.

    ``chunks`` is a list of dicts (from chunker.iter_chunks); ``vectors`` is a
    parallel list of embedding lists.
    """
    table = config.PG_TABLE
    cols = ", ".join(_METADATA_COLUMNS) + ", embedding"
    placeholders = ", ".join(["%s"] * (len(_METADATA_COLUMNS) + 1))
    updates = ", ".join(
        f"{c} = EXCLUDED.{c}" for c in _METADATA_COLUMNS[1:]
    ) + ", embedding = EXCLUDED.embedding"
    sql = (
        f"INSERT INTO {table} ({cols}) VALUES ({placeholders}) "
        f"ON CONFLICT (chunk_id) DO UPDATE SET {updates}"
    )
    rows = []
    for c, vec in zip(chunks, vectors):
        num = c.get("article_num")
        rows.append(
            (
                c["chunk_id"],
                c["law_name"],
                c.get("category"),
                c.get("slug"),
                c.get("book"),
                c.get("chapter"),
                c.get("section"),
                c.get("article_no"),
                int(num) if num is not None else None,
                c.get("source_url"),
                c.get("context"),
                c["text"],
                vec,
            )
        )
    with conn.cursor() as cur:
        cur.executemany(sql, rows)
    conn.commit()


def count(conn):
    return conn.execute(f"SELECT COUNT(*) FROM {config.PG_TABLE}").fetchone()[0]


def search(conn, query_vector, top_k=None, category=None):
    """Cosine-similarity search. Returns a list of hit dicts (best first)."""
    top_k = top_k or config.TOP_K
    table = config.PG_TABLE
    # `<=>` is pgvector's cosine distance; similarity = 1 - distance.
    where = "WHERE category = %s" if category else ""
    sql = (
        f"SELECT law_name, article_no, context, source_url, text, "
        f"1 - (embedding <=> %s::vector) AS score "
        f"FROM {table} {where} "
        f"ORDER BY embedding <=> %s::vector LIMIT %s"
    )
    # The distance operator appears twice (SELECT score + ORDER BY), so the
    # query vector is bound for both positions, with the optional category
    # filter in between.
    bind = [query_vector] + ([category] if category else []) + [query_vector, top_k]
    rows = conn.execute(sql, bind).fetchall()
    hits = []
    for law_name, article_no, context, source_url, text, score in rows:
        hits.append(
            {
                "text": text,
                "law_name": law_name,
                "article_no": article_no,
                "context": context or "",
                "source_url": source_url,
                "score": round(float(score), 4),
            }
        )
    return hits
