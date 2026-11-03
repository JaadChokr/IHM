"""Contrôles de la requête (PRD F2). Miroir de frontend/src/lib/sql.ts.

Les contraintes structurelles (SELECT unique, colonne order_id) s'appuient sur
les métadonnées du dry-run BigQuery, pas sur le texte : voir `query.py`. Ici,
uniquement ce que BigQuery ne dit pas : aucun paramètre (la requête s'exécute telle quelle) ; dates
en dur et absence de fenêtre relative au jour d'exécution (simples alertes).
"""

import re

from app.schemas import SqlIssue

_PARAM_RE = re.compile(r"(^|[^@\w])@([A-Za-z_]\w*)")
_CLOCK_RE = re.compile(r"\bCURRENT_(?:DATE|DATETIME|TIMESTAMP)\b", re.IGNORECASE)
_DATE_RE = re.compile(r"(?:\b(?:DATE|TIMESTAMP)\s*)?'\d{4}-\d{2}-\d{2}[^']*'", re.IGNORECASE)


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


def check_params(sql: str) -> list[SqlIssue]:
    """Aucun paramètre : la requête s'exécute telle quelle (seuils en dur, dates via CURRENT_DATE())."""
    issues: list[SqlIssue] = []
    used = find_params(sql)
    reported: set[str] = set()
    for name, off in used:
        if name in reported:
            continue
        reported.add(name)
        line, col = offset_to_line_col(sql, off)
        issues.append(
            SqlIssue(
                severity="error",
                code="PARAM_NOT_ALLOWED",
                message=f"@{name} : les paramètres ne sont pas pris en charge, la requête s'exécute telle "
                "quelle. Écrivez la valeur dans la requête (ex. > 500, ou CURRENT_DATE() pour une date).",
                line=line,
                column=col,
                length=len(name) + 1,
            )
        )
    return issues


def check_hardcoded_dates(sql: str) -> list[SqlIssue]:
    masked = mask_sql(sql, keep_strings=True)
    issues = []
    for m in _DATE_RE.finditer(masked):
        line, col = offset_to_line_col(sql, m.start())
        issues.append(
            SqlIssue(
                # Simple alerte : une date fixe est légitime comme seuil (ex. comptes créés après le
                # 1er janvier 2024), mais pas comme jour traité, qui serait alors le même à chaque run.
                severity="warning",
                code="HARDCODED_DATE",
                message=f"Date en dur ({m.group(0)}) : normal pour un seuil fixe. Si elle désigne le jour "
                "traité, la règle relira ce même jour à chaque exécution : préférez "
                "DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY) pour la veille.",
                line=line,
                column=col,
                length=len(m.group(0)),
            )
        )
    return issues


def check_date_window(sql: str) -> list[SqlIssue]:
    """Alerte si la requête ne dépend pas du jour d'exécution : sans fenêtre glissante, le premier run
    d'une version remonte tout ce qu'elle lit (le dédoublonnage ne joue qu'ensuite)."""
    if not sql.strip() or _CLOCK_RE.search(mask_sql(sql)):
        return []
    return [
        SqlIssue(
            severity="warning",
            code="NO_DATE_WINDOW",
            message="Pas de fenêtre relative au jour d'exécution (CURRENT_DATE(), CURRENT_TIMESTAMP()…) : "
            "au premier run, la règle remontera toutes les commandes lues, d'où un pic ponctuel dans le "
            "comparatif des versions. Les runs suivants n'écrivent que les nouvelles commandes.",
        )
    ]


def query_hash(sql: str) -> str:
    """Empreinte de la requête, identique à `queryHash` du front (FNV-1a 32 bits sur UTF-16)."""
    s = re.sub(r"\s+", " ", sql.strip())
    h = 0x811C9DC5
    data = s.encode("utf-16-le")
    for i in range(0, len(data), 2):
        h ^= data[i] | (data[i + 1] << 8)
        h = (h * 0x01000193) & 0xFFFFFFFF
    return f"{h:08x}"
