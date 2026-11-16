"""Lecture du texte SQL : commentaires et littéraux masqués, paramètres @…, empreinte d'une requête.

Outils génériques, utilisés par le test de requête, les brouillons et la passerelle BigQuery simulée.
Miroir de frontend/src/lib/sql.ts.
"""

import re

_PARAM_RE = re.compile(r"(^|[^@\w])@([A-Za-z_]\w*)")


def mask_sql(sql: str, keep_strings: bool = False) -> str:
    """Remplace commentaires (et littéraux) par des espaces, positions conservées."""
    out: list[str] = []
    i, n = 0, len(sql)

    def blank(s: str) -> str:
        return re.sub(r"[^\n]", " ", s)

    while i < n:
        c = sql[i]
        nxt = sql[i + 1] if i + 1 < n else ""
        if (c == "-" and nxt == "-") or c == "#":
            end = sql.find("\n", i)
            stop = n if end == -1 else end
            out.append(blank(sql[i:stop]))
            i = stop
        elif c == "/" and nxt == "*":
            end = sql.find("*/", i + 2)
            stop = n if end == -1 else end + 2
            out.append(blank(sql[i:stop]))
            i = stop
        elif c in "'\"`":
            j = i + 1
            while j < n and sql[j] != c:
                j += 2 if sql[j] == "\\" else 1
            stop = min(j + 1, n)
            chunk = sql[i:stop]
            if c == "`" or keep_strings:
                out.append(chunk)
            else:
                out.append(c + blank(chunk[1:-1]) + (c if stop > i + 1 else ""))
            i = stop
        else:
            out.append(c)
            i += 1
    return "".join(out)


def offset_to_line_col(sql: str, offset: int) -> tuple[int, int]:
    before = sql[:offset]
    return before.count("\n") + 1, offset - before.rfind("\n")


def find_params(sql: str) -> list[tuple[str, int]]:
    return [(m.group(2), m.start() + len(m.group(1))) for m in _PARAM_RE.finditer(mask_sql(sql))]


def query_hash(sql: str) -> str:
    """Empreinte de la requête, identique à `queryHash` du front (FNV-1a 32 bits sur UTF-16)."""
    s = re.sub(r"\s+", " ", sql.strip())
    h = 0x811C9DC5
    data = s.encode("utf-16-le")
    for i in range(0, len(data), 2):
        h ^= data[i] | (data[i + 1] << 8)
        h = (h * 0x01000193) & 0xFFFFFFFF
    return f"{h:08x}"
