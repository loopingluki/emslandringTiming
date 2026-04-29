"""Ausdruck: Template-PDF + WeasyPrint-Overlay (pypdf-Merge).

Pipeline:
  _render_overlay_html()  →  WeasyPrint  →  overlay.pdf
                                             ↓ pypdf merge
  training.pdf  (Vorlage) ────────────────►  final.pdf  →  lp

Dateien:
  server/data/templates/training.pdf
  server/data/templates/training-overflow.pdf
  server/data/fonts/Lato-*.ttf + Geom_Graphic_*.otf
  server/data/logo.png
"""
from __future__ import annotations

import asyncio
import html as _html
import io
import logging
import shutil
import statistics
import time
from datetime import datetime, timedelta
from pathlib import Path

import config as cfg
import database

log = logging.getLogger(__name__)

ROOT          = Path(__file__).parent.parent
DATA_DIR      = ROOT / "server" / "data"
FONTS_DIR     = DATA_DIR / "fonts"
TEMPLATES_DIR = DATA_DIR / "templates"
LOGO_PATH     = DATA_DIR / "logo.png"
DATA_DIR.mkdir(parents=True, exist_ok=True)

MATRIX_MAX_KARTS = 20   # max Karts in der Matrix
MATRIX_MAX_LAPS  = 15   # Runden auf Seite 1; ab Runde 16 → Überlaufseite

# ── Koordinaten für das Training-Template (alle Werte in mm) ─────────────
# Hauptseite
L = {
    # Header  (+3mm tiefer für Kart-Nr + Platzierung)
    "kart_num_x": 9.0,    "kart_num_y": 14.0,   "kart_num_pt": 72,
    "kart_class_x": 23.0,  "kart_class_y": 46.0, "kart_class_pt": 15,   # korrigiert: -86mm links, -2mm höher
    "pos_num_x": 73.0,    "pos_num_y": 16.0,    "pos_num_pt": 48,    # -2mm links, +2mm tiefer
    "logo_x": 145.0,      "logo_y": 9.0,        "logo_w": 55.0, "logo_h": 41.0,
    # Deine Runden (Schrift kleiner: max 15mm Breite für "1:05.510")
    "laps_x": 14.0,       "laps_y": 63.0,
    "laps_col_w": 23.5,   "laps_row_h": 7.5,    "laps_pt": 9.0,
    # Stat-Werte
    "best_x": 144.0,      "best_y": 64.0,       "best_pt": 16,
    "avg_x": 144.0,       "avg_y": 88.5,        "avg_pt": 16,
    # Chart (-5mm links → +5mm breiter links)
    "chart_x": 6.0,       "chart_y": 107.0,
    "chart_w": 193.0,     "chart_h": 30.0,
    # Matrix (5mm links, 10mm breiter)
    "mx_x": 6.0,          "mx_y": 143.0,
    "mx_w": 198.0,        "mx_h": 61.0,
    "mx_nw": 42.0,        "mx_hh": 4.5,         "mx_pt": 6.0,
    # Bestenliste (Klassen-Label: -2mm höher, Schrift ~3mm = 11pt)
    "bo_lbl_x": 47.0,     "bo_lbl_y": 244.0,
    "bo_cols": [13.0, 58.5, 108.0, 155.5],   # Jahr 1mm nach links
    "bo_data_y": 252.0,   "bo_row_h": 4.1,      "bo_pt": 7.0,
    # Footer (kein Cover-Rechteck mehr, Text rechts-bündig, 10mm vom rechten Rand)
    "ftr_x": 10.0,        "ftr_y": 288.5,       "ftr_pt": 7.0,
}
# Überlaufseite – mx_row_h_max verhindert Streckung über die ganze Seite
_MAIN_ROW_H_MAX = (L["mx_h"] - L["mx_hh"]) / 10   # = 5.65mm (gleich wie Hauptseite bei 10 Karts)
LO = {
    "kart_num_x": 9.0,    "kart_num_y": 11.0,   "kart_num_pt": 72,
    "kart_class_x": 23.0, "kart_class_y": 46.0, "kart_class_pt": 15,
    "pos_num_x": 73.0,    "pos_num_y": 16.0,    "pos_num_pt": 48,
    # Matrix: gleiche X-Position wie Hauptseite, volle verfügbare Höhe
    "mx_x": 6.0,          "mx_y": 63.0,
    "mx_w": 198.0,        "mx_h": 215.0,
    "mx_nw": 42.0,        "mx_hh": 4.5,         "mx_pt": 6.0,
    "mx_row_h_max": _MAIN_ROW_H_MAX,             # Zeilen nicht über die Seite strecken
    "mx_pt_ref_row_h": (L["mx_h"] - L["mx_hh"]) / 20,  # pt-Referenz = Hauptseite (2.825mm)
    # Footer: gleich wie Hauptseite
    "ftr_x": 10.0,        "ftr_y": 288.5,       "ftr_pt": 7.0,
}


# ── Format-Helfer ────────────────────────────────────────────────────────
def fmt_lap(us: int | None) -> str:
    if not us or us <= 0:
        return ""
    ms = us // 1000
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{m}:{s:02d}.{ms:03d}" if m else f"{s}.{ms:03d}"


def fmt_lap_short(us: int | None) -> str:
    """Matrix-Format: M:SS.t (1 Dezimalstelle, spart Breite)."""
    if not us or us <= 0:
        return "–"
    ms = us // 1000
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    t = ms // 100
    return f"{m}:{s:02d}.{t}" if m else f"{s}.{t}"


def fmt_date(iso: str) -> str:
    try:
        y, mo, d = iso.split("-")
        return f"{d}.{mo}.{y}"
    except Exception:
        return iso


# ── Datenbeschaffung ─────────────────────────────────────────────────────
async def _gather_run_data(run_id: int) -> dict:
    run = await database.get_run(run_id)
    if not run:
        raise ValueError(f"Lauf {run_id} nicht gefunden")
    passings    = await database.get_passings_for_run(run_id)
    kart_names  = await database.get_run_kart_names(run_id)
    karts: dict[int, dict] = {}
    for p in passings:
        knr = p["kart_nr"]
        if knr is None:
            continue
        k = karts.setdefault(knr, {
            "kart_nr": knr, "transponder_id": p["transponder_id"],
            "name": kart_names.get(knr) or cfg.get_kart_name(p["transponder_id"]),
            "class": (cfg.get_kart_info(p["transponder_id"]) or {}).get("class", ""),
            "laps": [], "first_ts_us": None,
        })
        if p["lap_time_us"]:
            k["laps"].append(p["lap_time_us"])
        k["first_ts_us"] = (p["timestamp_us"] if k["first_ts_us"] is None
                            else min(k["first_ts_us"], p["timestamp_us"]))
    for k in karts.values():
        laps = k["laps"]
        k["lap_count"] = len(laps)
        k["best_us"] = min(laps) if laps else None
        k["total_us"] = sum(laps) if laps else 0
        k["avg_us"]   = int(statistics.mean(laps)) if laps else None
        k["consistency_pct"] = (
            round((statistics.pstdev(laps) / statistics.mean(laps)) * 100, 2)
            if len(laps) >= 2 else None
        )
    # Sortierung modus-abhängig – identisch zur Live-UI (race_engine._sorted_karts)
    mode = run.get("mode", "training")
    if mode == "training":
        # Training: beste Runde entscheidet (Karts ohne Runde ans Ende)
        ranked = sorted(
            karts.values(),
            key=lambda k: (k["best_us"] is None, k["best_us"] or 10**18),
        )
    else:
        # Grand Prix: meiste Runden, dann geringste Gesamtzeit
        ranked = sorted(
            karts.values(),
            key=lambda k: (-k["lap_count"],
                           k["total_us"] if k["lap_count"] else 10**18),
        )
    leader_total = ranked[0]["total_us"] if ranked and ranked[0]["lap_count"] else None
    for pos, k in enumerate(ranked, 1):
        k["position"] = pos
        k["delta_us"] = (
            k["total_us"] - leader_total
            if leader_total and k["lap_count"] == ranked[0]["lap_count"] and pos > 1
            else (0 if pos == 1 else None)
        )
    return {"run": run, "karts_by_nr": karts, "ranked": ranked}


async def _best_of(kart_class: str, since_dt: datetime, limit: int = 8) -> list[dict]:
    tps = cfg.get().get("transponders", {})
    ids = [int(k) for k, v in tps.items() if v.get("class") == kart_class]
    if not ids:
        return []
    rows = await database.get_best_laps_since(since_dt.timestamp(), ids, limit_per_kart=1)
    out = []
    for r in rows[:limit]:
        info = cfg.get_kart_info(r["transponder_id"]) or {}
        out.append({
            "pid": r.get("pid"),
            "transponder_id": r["transponder_id"],
            "kart_nr": info.get("kart_nr"),
            "name": info.get("name", f"Kart ?"),
            "lap_time_us": r["lap_time_us"],
            "run_date": r["run_date"],
            "run_started_at": r["run_started_at"],
        })
    return out


def _date_ranges(now: datetime | None = None) -> dict[str, datetime]:
    now  = now or datetime.now()
    tod  = datetime(now.year, now.month, now.day)
    return {
        "day":   tod,
        "week":  tod - timedelta(days=tod.weekday()),
        "month": datetime(now.year, now.month, 1),
        "year":  datetime(now.year, 1, 1),
    }


# ── CSS (Overlay) ────────────────────────────────────────────────────────
import shutil as _shutil

# Fonts werden beim ersten Aufruf in einen ASCII-sicheren Pfad kopiert,
# da WeasyPrint mit file://-URLs auf Pfaden mit Sonderzeichen (ö, ä, Leerzeichen) versagt.
_FONT_CACHE: Path | None = None


def _font_cache_dir() -> Path:
    """Gibt einen ASCII-sicheren Font-Pfad zurück (kopiert bei Bedarf nach /tmp)."""
    global _FONT_CACHE
    if _FONT_CACHE and _FONT_CACHE.exists():
        return _FONT_CACHE

    # Ist der originale Pfad bereits ASCII-sicher?
    try:
        FONTS_DIR.as_posix().encode("ascii")
        _FONT_CACHE = FONTS_DIR
        return _FONT_CACHE
    except UnicodeEncodeError:
        pass  # Pfad enthält Nicht-ASCII → nach /tmp kopieren

    cache = Path("/tmp/ems_fonts_cache")
    cache.mkdir(exist_ok=True)
    for src in FONTS_DIR.glob("*"):
        dst = cache / src.name
        if not dst.exists() or dst.stat().st_mtime < src.stat().st_mtime:
            _shutil.copy2(src, dst)
    _FONT_CACHE = cache
    log.info("Fonts nach %s kopiert (ASCII-Pfad für WeasyPrint)", cache)
    return cache


def _asset_url(path: Path) -> str:
    """Gibt eine file://-URL zurück – ASCII-sicher (kopiert falls nötig)."""
    try:
        path.as_posix().encode("ascii")
        return f"file://{path.as_posix()}"
    except UnicodeEncodeError:
        pass
    # Nicht-ASCII-Pfad: Datei in den Font-Cache kopieren (gleicher Ordner)
    cache = _font_cache_dir()
    dst = cache / path.name
    if not dst.exists() or dst.stat().st_mtime < path.stat().st_mtime:
        _shutil.copy2(path, dst)
    return f"file://{dst.as_posix()}"


_FONT_DEFS = [
    ("Lato", 400, "normal", "Lato-Regular.ttf",      "truetype"),
    ("Lato", 400, "italic", "Lato-Italic.ttf",       "truetype"),
    ("Lato", 700, "normal", "Lato-Bold.ttf",         "truetype"),
    ("Lato", 700, "italic", "Lato-BoldItalic.ttf",   "truetype"),
    ("Lato", 800, "normal", "Lato-Heavy.ttf",        "truetype"),
    ("Lato", 800, "italic", "Lato-HeavyItalic.ttf",  "truetype"),
    ("Lato", 900, "normal", "Lato-Black.ttf",        "truetype"),
    ("Lato", 900, "italic", "Lato-BlackItalic.ttf",  "truetype"),
    ("GeomGraphic", 400, "normal", "Geom_Graphic_Regular.otf",        "opentype"),
    ("GeomGraphic", 400, "italic", "Geom_Graphic_Regular_Italic.otf", "opentype"),
    ("GeomGraphic", 700, "normal", "Geom_Graphic_Bold.otf",           "opentype"),
    ("GeomGraphic", 700, "italic", "Geom_Graphic_Bold_Italic.otf",    "opentype"),
    ("GeomGraphic", 600, "normal", "Geom_Graphic_SemiBold.otf",       "opentype"),
    ("GeomGraphic", 600, "italic", "Geom_Graphic_SemiBold_Italic.otf","opentype"),
]


def _font_faces() -> str:
    """Für WeasyPrint (serverseitig): file://-URLs aus ASCII-sicherem Pfad."""
    fd = _font_cache_dir()
    css = ""
    for family, weight, style, fname, fmt in _FONT_DEFS:
        p = fd / fname
        if p.exists():
            css += (f'@font-face{{font-family:"{family}";font-weight:{weight};'
                    f'font-style:{style};'
                    f'src:url("{_asset_url(p)}") format("{fmt}");}}\n')
    return css


def _font_faces_http() -> str:
    """Für Browser-Vorschau: HTTP-URLs über /fonts/ Route."""
    css = ""
    for family, weight, style, fname, fmt in _FONT_DEFS:
        if (FONTS_DIR / fname).exists():
            css += (f'@font-face{{font-family:"{family}";font-weight:{weight};'
                    f'font-style:{style};'
                    f'src:url("/fonts/{fname}") format("{fmt}");}}\n')
    return css


def _base_css(for_browser: bool = False) -> str:
    fonts = _font_faces_http() if for_browser else _font_faces()
    return (
        fonts
        + """
@page{size:210mm 297mm;margin:0;background:transparent;}
html,body{background:transparent!important;margin:0;padding:0;
  font-family:"Lato","Helvetica Neue",Arial,sans-serif;
  font-variant-numeric:tabular-nums;}
.pg{width:210mm;height:297mm;position:relative;overflow:hidden;
    background:transparent;page-break-after:always;}
.pg:last-child{page-break-after:auto;}
"""
    )


# ── Overlay-Bausteine ────────────────────────────────────────────────────
def e(x: float, y: float, text: str, *,
      pt: float = 9, w: int = 400, italic: bool = False,
      color: str = "#111", lh: float = 1.0, ls: str = "normal",
      upper: bool = False, align: str = "left",
      font: str = "Lato") -> str:
    """Absolut positioniertes Text-Element (mm-Koordinaten)."""
    sty = (f"position:absolute;left:{x}mm;top:{y}mm;"
           f"font-family:{font},sans-serif;font-size:{pt}pt;"
           f"font-weight:{w};color:{color};white-space:nowrap;"
           f"line-height:{lh};letter-spacing:{ls};")
    if italic: sty += "font-style:italic;"
    if upper:  sty += "text-transform:uppercase;"
    if align == "right":
        sty = sty.replace(f"left:{x}mm;", f"right:{x}mm;")
        sty += "text-align:right;"
    return f'<div style="{sty}">{_html.escape(str(text))}</div>'


def cover(x: float, y: float, w: float, h: float, color: str = "#fff") -> str:
    """Weißes Rechteck zum Abdecken von Template-Text."""
    return (f'<div style="position:absolute;left:{x}mm;top:{y}mm;'
            f'width:{w}mm;height:{h}mm;background:{color};"></div>')


# ── Chart SVG ────────────────────────────────────────────────────────────
def _smooth_path(pts: list[tuple[float, float]]) -> str:
    if len(pts) < 2:
        return ""
    d = [f"M{pts[0][0]:.2f} {pts[0][1]:.2f}"]
    n = len(pts)
    for i in range(n - 1):
        p0 = pts[i - 1] if i > 0 else pts[i]
        p1, p2 = pts[i], pts[i + 1]
        p3 = pts[i + 2] if i + 2 < n else pts[i + 1]
        cx1, cy1 = p1[0] + (p2[0]-p0[0])/6, p1[1] + (p2[1]-p0[1])/6
        cx2, cy2 = p2[0] - (p3[0]-p1[0])/6, p2[1] - (p3[1]-p1[1])/6
        d.append(f"C{cx1:.2f} {cy1:.2f},{cx2:.2f} {cy2:.2f},{p2[0]:.2f} {p2[1]:.2f}")
    return " ".join(d)


def _chart_svg(laps: list[int], W: float, H: float) -> str:
    if not laps:
        return (f'<svg viewBox="0 0 {W} {H}" xmlns="http://www.w3.org/2000/svg">'
                '</svg>')
    PL, PR, PT, PB = 14.0, 3.0, 2.0, 7.0
    pw, ph = W - PL - PR, H - PT - PB
    n   = len(laps)
    mn, mx = min(laps), max(laps)
    if mx == mn:
        mx = mn + 1000
    span = mx - mn
    y_min, y_max = mn - span * 0.15, mx + span * 0.15

    def px(i):  return PL + (i / max(1, n - 1)) * pw
    def py(us): return PT + (1 - (us - y_min) / (y_max - y_min)) * ph

    pts = [(px(i), py(t)) for i, t in enumerate(laps)]
    path = _smooth_path(pts)

    # Y-Gitter (4 Linien)
    grid, ylbl = "", ""
    for t in [y_min + (y_max - y_min) * i / 3 for i in range(4)]:
        yy = py(t)
        grid += (f'<line x1="{PL:.1f}" y1="{yy:.2f}" x2="{W-PR:.1f}" y2="{yy:.2f}" '
                 f'stroke="#d8d8d8" stroke-width="0.3" stroke-dasharray="1.5,1.5"/>')
        ylbl += (f'<text x="{PL-1:.1f}" y="{yy+1.2:.2f}" text-anchor="end" '
                 f'font-size="2.8" fill="#aaa" font-family="Lato,Arial">'
                 f'{fmt_lap(int(t))}</text>')

    # X-Beschriftung (Rundennummern)
    step = max(1, n // 8)
    xlbl = ""
    for i in range(n):
        if i == 0 or i == n - 1 or i % step == 0:
            xlbl += (f'<text x="{px(i):.2f}" y="{H-0.5:.1f}" text-anchor="middle" '
                     f'font-size="2.8" fill="#aaa" font-family="Lato,Arial">'
                     f'{i+1}</text>')

    # Best-Markierung
    bi = laps.index(mn)
    bx, by = pts[bi]
    marker = (f'<circle cx="{bx:.2f}" cy="{by:.2f}" r="2.0" fill="#fff" '
              f'stroke="#111" stroke-width="0.6"/>'
              f'<circle cx="{bx:.2f}" cy="{by:.2f}" r="0.8" fill="#111"/>')

    glow = (f'<path d="{path}" fill="none" stroke="#111" '
            f'stroke-width="2.0" stroke-opacity="0.12" '
            f'stroke-linecap="round" stroke-linejoin="round"/>')
    line = (f'<path d="{path}" fill="none" stroke="#111" '
            f'stroke-width="0.8" stroke-linecap="round" stroke-linejoin="round"/>')

    return (f'<svg viewBox="0 0 {W} {H}" xmlns="http://www.w3.org/2000/svg">'
            + grid + ylbl + glow + line + marker + xlbl + '</svg>')


# ── Seiten-Renderer ──────────────────────────────────────────────────────
def _header_elements(kart: dict, ranked: list, lo: dict) -> str:
    """Kart-Nummer, Platzierung, Klasse, Logo — gemeinsam für beide Seiten."""
    parts = []
    # Kart-Nummer (GeomGraphic Bold Italic)
    parts.append(e(lo["kart_num_x"], lo["kart_num_y"],
                   str(kart["kart_nr"]),
                   pt=lo["kart_num_pt"], w=700, italic=True, font="GeomGraphic"))
    # Kart-Klasse
    if kart.get("class"):
        parts.append(e(lo["kart_class_x"], lo["kart_class_y"],
                       kart["class"].upper(),
                       pt=lo["kart_class_pt"], w=800, italic=True,
                       ls="0.12em", font="Lato"))
    # Platzierung (GeomGraphic Bold Italic, mit Punkt)
    parts.append(e(lo["pos_num_x"], lo["pos_num_y"],
                   f'{kart["position"]}.',
                   pt=lo["pos_num_pt"], w=700, italic=True, font="GeomGraphic"))
    # Logo
    if LOGO_PATH.exists():
        lx, ly = lo.get("logo_x", 145), lo.get("logo_y", 9)
        lw, lh = lo.get("logo_w", 55),  lo.get("logo_h", 41)
        parts.append(
            f'<img src="{_asset_url(LOGO_PATH)}" '
            f'style="position:absolute;left:{lx}mm;top:{ly}mm;'
            f'width:{lw}mm;height:{lh}mm;object-fit:contain;">'
        )
    return "".join(parts)


def _laps_elements(kart: dict, lo: dict) -> str:
    laps = kart["laps"][:20]
    best = kart["best_us"]
    parts = []
    col_w   = lo["laps_col_w"]
    row_h   = lo["laps_row_h"]
    pt      = lo["laps_pt"]
    x0, y0  = lo["laps_x"], lo["laps_y"]
    # 4 Spalten × 5 Zeilen
    for i, us in enumerate(laps):
        col, row = i // 5, i % 5
        x = x0 + col * col_w
        y = y0 + row * row_h
        is_best = (us == best)
        # Rundennummer: Lato Regular grau
        parts.append(e(x,     y, f"{i+1}.", pt=pt, w=400, color="#888"))
        # Rundenzeit: GeomGraphic SemiBold; Bestzeit fett hervorgehoben
        parts.append(e(x+5.5, y, fmt_lap(us),
                       pt=pt, w=700 if is_best else 600,
                       font="GeomGraphic"))
    return "".join(parts)


def _stats_elements(kart: dict, lo: dict) -> str:
    best = fmt_lap(kart["best_us"]) if kart["best_us"] else "–"
    avg  = fmt_lap(kart["avg_us"])  if kart["avg_us"]  else "–"
    return (
        e(lo["best_x"], lo["best_y"], best, pt=lo["best_pt"], w=600, font="GeomGraphic")
        + e(lo["avg_x"], lo["avg_y"],  avg,  pt=lo["avg_pt"],  w=600, font="GeomGraphic")
    )


def _chart_element(kart: dict, lo: dict) -> str:
    W, H = lo["chart_w"], lo["chart_h"]
    svg  = _chart_svg(kart["laps"], W, H)
    return (f'<div style="position:absolute;left:{lo["chart_x"]}mm;'
            f'top:{lo["chart_y"]}mm;width:{W}mm;height:{H}mm;">{svg}</div>')


def _matrix_element(ranked: list, lap_from: int, lap_to: int, lo: dict) -> str:
    """Rundenzeiten-Matrix: Pos | Nr | Name | Runden – dynamische Schriftgröße."""
    mx_x, mx_y   = lo["mx_x"], lo["mx_y"]
    mx_w, mx_h   = lo["mx_w"], lo["mx_h"]
    nw           = lo["mx_nw"]   # Gesamtbreite der linken Infospalten
    hh           = lo["mx_hh"]   # Header-Höhe
    n_laps       = lap_to - lap_from
    karts        = ranked[:MATRIX_MAX_KARTS]
    n_karts      = len(karts)
    if n_laps <= 0 or n_karts == 0:
        return ""

    # ── Dynamische Schriftgröße ──────────────────────────────────────────────
    usable_h      = mx_h - hh
    MAX_LARGE     = 10          # ab hier: feste Zeilenhöhe, Lücke unten
    if n_karts <= MAX_LARGE:
        row_h = usable_h / MAX_LARGE
    else:
        row_h = usable_h / n_karts
    # Optionaler Cap (Überlaufseite: Zeilen nicht über die ganze Seite strecken)
    row_h_cap = lo.get("mx_row_h_max", 0)
    if row_h_cap > 0:
        row_h = min(row_h, row_h_cap)
    # pt skaliert proportional zur Zeilenhöhe (kalibriert: 6pt bei 20 Karts)
    # Überlaufseite nutzt dieselbe Referenz wie Hauptseite, damit die Schrift gleich groß bleibt
    ref_row_h = lo.get("mx_pt_ref_row_h") or (usable_h / 20)
    pt = lo["mx_pt"] * (row_h / ref_row_h)
    pt = min(pt, 9.5)           # Obergrenze

    # ── Dynamische Namensspaltenbreite (passt sich an längsten Namen an, max 20 Zeichen) ──
    POS_W = 6.0   # fest: "1." bis "20."
    NR_W  = 8.0   # fest: Kart-Nummern 1–99
    # Zeichenbreite in mm: 1pt = 0.3528mm, avg char ≈ 55% der Zeichenhöhe
    char_w_mm    = pt * 0.3528 * 0.55
    max_name_len = min(max((len(k["name"]) for k in karts), default=6), 20)
    name_w       = min(max_name_len * char_w_mm + 2.0, nw - POS_W - NR_W)
    nw_actual    = POS_W + NR_W + name_w
    col_w        = (mx_w - nw_actual) / n_laps  # Rundenzeiten-Spaltenbreite neu berechnen
    pos_w, nr_w  = POS_W, NR_W

    parts = []

    # ── Header ───────────────────────────────────────────────────────────────
    hpt = max(pt - 1.0, 4.5)
    parts.append(e(mx_x + 0.5,              mx_y + 0.5, "Pos.", pt=hpt, w=700, color="#888"))
    parts.append(e(mx_x + pos_w + 0.5,      mx_y + 0.5, "Nr.",  pt=hpt, w=700, color="#888"))
    parts.append(e(mx_x + pos_w + nr_w + 0.5, mx_y + 0.5, "Name", pt=hpt, w=700, color="#888"))
    for i in range(n_laps):
        cx = mx_x + nw_actual + i * col_w
        parts.append(e(cx + 0.5, mx_y + 0.5, str(lap_from + i + 1),
                       pt=hpt, w=700, color="#888"))

    # Trennlinie unter Header
    parts.append(
        f'<div style="position:absolute;left:{mx_x}mm;top:{mx_y+hh-0.3}mm;'
        f'width:{mx_w}mm;height:0.3mm;background:#ccc;"></div>'
    )

    # ── Kart-Zeilen ──────────────────────────────────────────────────────────
    for ki, k in enumerate(karts):
        ky = mx_y + hh + ki * row_h

        # Zebrastreifen
        if ki % 2 == 0:
            parts.append(
                f'<div style="position:absolute;left:{mx_x}mm;top:{ky}mm;'
                f'width:{mx_w}mm;height:{row_h:.2f}mm;background:#f7f7f7;z-index:-1;"></div>'
            )

        # Pos, Nr, Name
        parts.append(e(mx_x + 0.5,              ky + 0.3,
                       f'{k["position"]}.',  pt=pt, w=700, color="#555"))
        parts.append(e(mx_x + pos_w + 0.5,      ky + 0.3,
                       str(k["kart_nr"]),    pt=pt, w=700))
        # Name: auf max_name_len Zeichen abschneiden
        name = k["name"]
        if len(name) > max_name_len:
            name = name[:max_name_len]
        parts.append(e(mx_x + pos_w + nr_w + 0.5, ky + 0.3,
                       name, pt=pt, w=400, color="#333"))

        # Rundenzeiten
        laps = k["laps"]
        for li in range(n_laps):
            idx = lap_from + li
            us  = laps[idx] if idx < len(laps) else None
            cx  = mx_x + nw_actual + li * col_w
            if us is None:
                parts.append(e(cx + 0.5, ky + 0.3, "–", pt=pt, color="#ccc"))
            else:
                is_best = (us == k["best_us"])
                if is_best:
                    parts.append(e(cx + 0.5, ky + 0.3,
                                   fmt_lap(us), pt=pt, w=900,
                                   italic=True, color="#111"))
                else:
                    parts.append(e(cx + 0.5, ky + 0.3,
                                   fmt_lap(us), pt=pt, w=400,
                                   color="#333"))
    return "".join(parts)


def _bestof_elements(best_of: dict, kart_class: str, own_tid: int | None,
                     lo: dict) -> str:
    parts = []
    # "– KLASSENNAME" neben dem Template-"BESTENLISTE"-Label (2× Schriftgröße)
    if kart_class:
        parts.append(e(lo["bo_lbl_x"], lo["bo_lbl_y"],
                       f"– {kart_class.upper()}",
                       pt=11, w=800, italic=True, ls="0.05em"))

    # Spalten-Datum-Overlays werden NICHT mehr gerendert:
    # Das neue Template hat "TAG", "WOCHE", "MONAT", "JAHR" vorgedruckt.

    periods = [("day",), ("week",), ("month",), ("year",)]
    max_entries = int(33.0 / lo["bo_row_h"])  # max Einträge damit Höhe ≤ 33mm

    for ci, (period,) in enumerate(periods):
        cx = lo["bo_cols"][ci]
        entries = best_of.get(period, [])

        for ri, ent in enumerate(entries[:max_entries]):
            ry     = lo["bo_data_y"] + ri * lo["bo_row_h"]
            is_own = (own_tid is not None
                      and ent.get("transponder_id") == own_tid)

            # Datum/Zeit-String
            if period == "day" and ent.get("run_started_at"):
                ts = datetime.fromtimestamp(ent["run_started_at"]).strftime("%H:%M")
            elif ent.get("run_date"):
                ts = fmt_date(ent["run_date"])
            else:
                ts = ""

            kart_lbl = (f'Kart {ent["kart_nr"]}'
                        if ent.get("kart_nr") is not None
                        else ent.get("name", "?"))

            col_bold = 900 if is_own else 400
            t_bold   = 900 if is_own else 700
            # Layout pro Spalte: Nr(5mm) | Name(17mm) | Zeit(13mm) | Datum(10mm)
            parts.append(e(cx,      ry, f'{ri+1}.',  pt=lo["bo_pt"], w=col_bold))
            parts.append(e(cx+5,    ry, kart_lbl,    pt=lo["bo_pt"], w=col_bold))
            parts.append(e(cx+22,   ry, fmt_lap(ent["lap_time_us"]),
                           pt=lo["bo_pt"], w=t_bold))
            if ts:
                parts.append(e(cx+35, ry, ts, pt=6.0, w=400, color="#888"))

    return "".join(parts)


def _footer_element(lo: dict) -> str:
    """Druckdatum rechts-bündig, kein weißes Abdeckrechteck."""
    now_str = datetime.now().strftime("%d.%m.%Y %H:%M")
    # Nutze left:0 + right:Xmm damit text-align:right korrekt funktioniert
    return (
        f'<div style="position:absolute;left:0;right:{lo["ftr_x"]}mm;'
        f'top:{lo["ftr_y"]}mm;text-align:right;'
        f'font-family:Lato,sans-serif;font-size:{lo["ftr_pt"]}pt;'
        f'font-weight:400;color:#333;white-space:nowrap;">'
        f'Druckdatum: {_html.escape(now_str)}</div>'
    )


# ── HTML-Dokument ────────────────────────────────────────────────────────
async def _build_overlay_html(data: dict, kart: dict, sim_laps: int = 0) -> str:
    """Gesamtes Overlay-HTML (alle Seiten) für einen Kart.
    sim_laps > 0: Runden-Daten künstlich auf diese Anzahl aufblasen (Test Überlauf)."""
    ranked   = data["ranked"]
    max_laps = max((k["lap_count"] for k in ranked), default=0)

    # Simulation: fehlende Runden mit Zufallszeiten auffüllen
    if sim_laps > max_laps:
        import random
        for k in ranked:
            while len(k["laps"]) < sim_laps:
                base = k["best_us"] or 60_000_000
                k["laps"].append(int(base * random.uniform(0.97, 1.06)))
            k["lap_count"] = sim_laps
        max_laps = sim_laps

    # Best-of laden
    ranges  = _date_ranges()
    best_of = {
        p: await _best_of(kart["class"], ranges[p], limit=8)
        for p in ("day", "week", "month", "year")
    }

    pages = []

    # ── Seite 1 (Haupttemplate) ──────────────────────────────────────────
    lap_to_p1 = min(max_laps, MATRIX_MAX_LAPS)
    body  = _header_elements(kart, ranked, L)
    body += _laps_elements(kart, L)
    body += _stats_elements(kart, L)
    body += _chart_element(kart, L)
    body += _matrix_element(ranked, 0, lap_to_p1, L)
    body += _bestof_elements(best_of, kart["class"], kart.get("transponder_id"), L)
    body += _footer_element(L)
    pages.append(f'<div class="pg">{body}</div>')

    # ── Überlaufseiten (falls > MATRIX_MAX_LAPS Runden) ──────────────────
    for lap_from in range(MATRIX_MAX_LAPS, max_laps, MATRIX_MAX_LAPS):
        lap_to = min(max_laps, lap_from + MATRIX_MAX_LAPS)
        body2  = _header_elements(kart, ranked, LO)
        body2 += _matrix_element(ranked, lap_from, lap_to, LO)
        body2 += _footer_element(LO)
        pages.append(f'<div class="pg">{body2}</div>')

    return (f'<!doctype html><html><head><meta charset="utf-8">'
            f'<style>{_base_css()}</style></head>'
            f'<body>{"".join(pages)}</body></html>')


# ── PDF-Merge ─────────────────────────────────────────────────────────────
def _merge_pages(overlay_bytes: bytes) -> bytes:
    """Overlay-PDF auf Template-PDFs legen (pypdf).

    Wichtig: ``base.merge_page(overlay)`` mutiert die base-Page – wir
    brauchen also für jede Output-Seite eine **frische Kopie** der
    Template-Page. Wenn wir aber für jede Seite einen NEUEN
    ``PdfReader`` aus den Template-Bytes anlegen, hat jeder Reader
    seinen eigenen Ressourcen-Pool und die Template-Fonts/Grafiken
    werden N-mal in das finale PDF eingebettet (~1 MB pro Seite).

    Trick: Wir parsen die Template-Bytes **einmal** und nutzen
    ``PdfWriter.add_page(template_page)`` – das fügt die Page
    inklusive Ressourcen zum Writer hinzu und gibt eine **eigene
    Page-Instanz** zurück, die wir mutieren können. Pypdf
    dedupliziert dann die Ressourcen über den Writer-internen
    Object-Pool.
    """
    from pypdf import PdfReader, PdfWriter

    tmpl_main_reader = PdfReader(
        io.BytesIO((TEMPLATES_DIR / "training.pdf").read_bytes())
    )
    tmpl_over_reader = PdfReader(
        io.BytesIO((TEMPLATES_DIR / "training-overflow.pdf").read_bytes())
    )
    overlay_reader = PdfReader(io.BytesIO(overlay_bytes))

    writer  = PdfWriter()
    n_pages = len(overlay_reader.pages)

    for i in range(n_pages):
        src_page = (
            tmpl_main_reader.pages[0] if i == 0 else tmpl_over_reader.pages[0]
        )
        # add_page klont die Page in den Writer-Pool. Die zurückgegebene
        # Instanz ist mutierbar ohne den Reader zu verändern, und teilt
        # ihre Ressourcen mit anderen aus demselben Reader hinzugefügten
        # Pages (= Deduplizierung).
        new_page = writer.add_page(src_page)
        new_page.merge_page(overlay_reader.pages[i])

    # Optional: Object-Stream-Konsolidierung für nochmal kleinere PDFs
    try:
        writer.compress_identical_objects(remove_orphans=True)
    except Exception:
        pass

    out = io.BytesIO()
    writer.write(out)
    return out.getvalue()


# ── Public API ─────────────────────────────────────────────────────────────
async def render_run_html(run_id: int, kart_nr: int | None = None, sim_laps: int = 0) -> str:
    """Standalone-Vorschau (weißer Hintergrund, A4-Rahmen).
    kart_nr: nur dieses Kart rendern; None = alle Karts."""
    data = await _gather_run_data(run_id)
    if not data["ranked"]:
        return "<html><body><p>Keine Karts im Lauf.</p></body></html>"

    kart_list = (
        [k for k in data["ranked"] if k["kart_nr"] == kart_nr]
        if kart_nr is not None else data["ranked"]
    )
    if not kart_list:
        return f"<html><body><p>Kart {kart_nr} nicht im Lauf.</p></body></html>"

    all_pages: list[str] = []
    import re
    for kart in kart_list:
        overlay_html = await _build_overlay_html(data, kart, sim_laps=sim_laps)
        match = re.search(r'<body>(.*?)</body>', overlay_html, re.DOTALL)
        if match:
            all_pages.append(match.group(1))

    # CSS einmal, weißer Hintergrund, Rahmen-Simulation
    preview_css = (
        _base_css(for_browser=True)
        .replace("background:transparent!important;", "background:#f0f0f0!important;")
        .replace("@page{size:210mm 297mm;margin:0;background:transparent;}",
                 "@page{size:210mm 297mm;margin:10mm;background:#fff;}")
        + """
        .pg { background: #fff !important; box-shadow: 0 2px 12px rgba(0,0,0,0.15);
              margin: 20px auto; border: 1px solid #ddd; }
        """
    )
    body_html = "\n".join(all_pages)
    return (f'<!doctype html><html><head><meta charset="utf-8">'
            f'<style>{preview_css}</style></head>'
            f'<body style="background:#f0f0f0;padding:20px;">'
            f'{body_html}</body></html>')


async def print_run(
    run_id: int,
    kart_nr: int | None = None,
    *,
    printer_override: str | None = None,
    dry_run: bool = False,
) -> dict:
    """Druckauftrag mit Diagnose-Infos.

    Parameter:
      kart_nr           – nur dieses Kart drucken (None = alle Karts)
      printer_override  – CUPS-Drucker-Name; überschreibt config.json
                          (zum Gegentest auf einem anderen Drucker)
      dry_run           – PDF nur erzeugen+optimieren, NICHT drucken.
                          Liefert nur die Größen+Zeit-Diagnose zurück.

    Antwort enthält jetzt Zeit- und Größen-Diagnose:
      sizes: { merged_kb, optimized_kb, ratio_pct }
      timing_ms: { gather, render, merge, optimize, lp_send, total }
      debug_path: Pfad zum gespeicherten PDF unter /tmp
    """
    t_start = time.time()
    timing: dict[str, int] = {}
    sizes: dict[str, int] = {}

    if not (TEMPLATES_DIR / "training.pdf").exists():
        return {"ok": False, "error": "Template training.pdf fehlt in server/data/templates/"}

    try:
        from weasyprint import HTML as WpHTML  # type: ignore
    except ImportError:
        return {"ok": False, "error": "WeasyPrint nicht installiert (pip install weasyprint)"}

    t0 = time.time()
    data = await _gather_run_data(run_id)
    timing["gather_ms"] = int((time.time() - t0) * 1000)
    if not data["ranked"]:
        return {"ok": False, "error": "Keine Karts im Lauf"}

    kart_list = (
        [k for k in data["ranked"] if k["kart_nr"] == kart_nr]
        if kart_nr is not None else data["ranked"]
    )
    if not kart_list:
        return {"ok": False, "error": f"Kart {kart_nr} nicht im Lauf"}

    # Alle Kart-PDFs PARALLEL erzeugen und zusammenführen.
    # WeasyPrint ist nicht thread-safe für eine einzelne HTML-Instanz,
    # aber jeder Aufruf erzeugt sein eigenes HTML-Objekt → safe.
    # Bei 13 Karts spart das auf einem Mehrkern-Server fast die ganze
    # Render-Zeit (vorher sequentiell ~9s, parallel ~1-2s).
    def _render_kart(html_str: str) -> bytes:
        overlay_pdf = WpHTML(string=html_str, base_url=str(ROOT)).write_pdf()
        return _merge_pages(overlay_pdf)

    async def _render_one(kart: dict) -> bytes:
        overlay_html = await _build_overlay_html(data, kart)
        return await asyncio.to_thread(_render_kart, overlay_html)

    t0 = time.time()
    all_merged: list[bytes] = list(
        await asyncio.gather(*[_render_one(k) for k in kart_list])
    )
    timing["render_merge_ms"] = int((time.time() - t0) * 1000)

    # Alle Kart-PDFs zu einem Job zusammenführen
    t0 = time.time()
    if len(all_merged) == 1:
        final_pdf = all_merged[0]
    else:
        from pypdf import PdfReader, PdfWriter
        writer = PdfWriter()
        for pdf_bytes in all_merged:
            reader = PdfReader(io.BytesIO(pdf_bytes))
            for page in reader.pages:
                writer.add_page(page)
        buf = io.BytesIO()
        writer.write(buf)
        final_pdf = buf.getvalue()
    timing["concat_ms"] = int((time.time() - t0) * 1000)
    sizes["merged_bytes"] = len(final_pdf)

    # PDF mit Ghostscript optimieren – pypdf dedupliziert beim Merge die
    # Template-Ressourcen (Fonts, Bilder) nicht, dadurch wird die finale
    # PDF unnötig groß und der CUPS-Filter braucht lange für die
    # Konvertierung → Drucker-Pausen zwischen Seiten. Mit gs durchgejagt
    # schrumpft das PDF typischerweise und der Drucker bekommt einen
    # kontinuierlichen Datenstrom.
    t0 = time.time()
    optimized_pdf = await _optimize_pdf_for_print(final_pdf)
    timing["optimize_ms"] = int((time.time() - t0) * 1000)
    sizes["optimized_bytes"] = len(optimized_pdf)
    sizes["ratio_pct"] = int(
        100 * len(optimized_pdf) / max(1, len(final_pdf))
    )

    # Beide Versionen für Diagnose nach /tmp schreiben
    debug_dir = Path("/tmp")
    debug_files = {}
    try:
        merged_path = debug_dir / f"emsl-print-{run_id}-merged.pdf"
        opt_path    = debug_dir / f"emsl-print-{run_id}-optimized.pdf"
        merged_path.write_bytes(final_pdf)
        opt_path.write_bytes(optimized_pdf)
        debug_files["merged"]    = str(merged_path)
        debug_files["optimized"] = str(opt_path)
    except Exception as exc:
        log.warning("Konnte Debug-PDFs nicht schreiben: %s", exc)

    log.info(
        "[print_run] run=%s karts=%d merged=%.1fKB optimized=%.1fKB (%d%%) "
        "render=%dms gs=%dms",
        run_id, len(all_merged),
        sizes["merged_bytes"] / 1024,
        sizes["optimized_bytes"] / 1024,
        sizes["ratio_pct"],
        timing["render_merge_ms"],
        timing["optimize_ms"],
    )

    # Bei dry_run hier abbrechen – PDF wurde geschrieben, aber wir
    # senden ihn nicht zum Drucker.
    if dry_run:
        timing["total_ms"] = int((time.time() - t_start) * 1000)
        return {
            "ok": True,
            "dry_run": True,
            "karts": len(all_merged),
            "sizes": sizes,
            "timing_ms": timing,
            "debug_files": debug_files,
        }

    # Druckername bestimmen (Override > config.json)
    printer_name = (printer_override or cfg.get().get("printer") or "").strip()
    if not printer_name:
        return {"ok": False, "error": "Kein Drucker konfiguriert"}
    if not shutil.which("lp"):
        return {"ok": False, "error": "`lp` nicht verfügbar (macOS/Linux CUPS)"}

    t0 = time.time()
    proc = await asyncio.create_subprocess_exec(
        "lp", "-d", printer_name, "-o", "sides=one-sided",
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    out, err = await proc.communicate(input=optimized_pdf)
    timing["lp_send_ms"] = int((time.time() - t0) * 1000)

    if proc.returncode != 0:
        log.error("lp Fehler: %s", err.decode("utf-8", "ignore"))
        return {"ok": False, "error": err.decode("utf-8", "ignore")}

    timing["total_ms"] = int((time.time() - t_start) * 1000)
    return {
        "ok": True,
        "job": out.decode("utf-8", "ignore").strip(),
        "printer": printer_name,
        "karts": len(all_merged),
        "sizes": sizes,
        "timing_ms": timing,
        "debug_files": debug_files,
    }


async def _optimize_pdf_for_print(pdf_bytes: bytes) -> bytes:
    """Reduziert die PDF-Größe vor dem Drucken via Ghostscript.

    pypdf merged Template-Pages durch ``base.merge_page(overlay)`` und
    legt dabei für jede der ~20 Seiten eine eigene Kopie der
    Template-Ressourcen (Fonts, Bilder, Vektorgrafiken) an. Das
    aufgeblasene PDF kann mehrere MB groß werden, selbst wenn der
    eigentliche Inhalt nur ~500 KB nötig hätte. Ghostscript mit
    ``-dPDFSETTINGS=/printer`` re-rendert die Seiten und dedupliziert
    die Ressourcen sauber.

    Wenn ``gs`` nicht installiert ist oder die Optimierung fehlschlägt,
    wird das Original-PDF zurückgegeben (keine Verschlechterung).
    """
    if not shutil.which("gs"):
        log.info("Ghostscript nicht gefunden – PDF unkomprimiert drucken.")
        return pdf_bytes
    try:
        # /default + Compress/Subset reicht für unsere Use-Case: das
        # Original ist NUR durch redundante Template-Embeddings groß,
        # nicht durch hochaufgelöste Bilder. Wir müssen also kein
        # Re-Rasterizing machen (was /printer mit 300 dpi tut), sondern
        # nur Resources deduplizieren. Spart ~70% Ghostscript-Zeit
        # gegenüber /printer bei gleicher Output-Größe.
        proc = await asyncio.create_subprocess_exec(
            "gs",
            "-q", "-dNOPAUSE", "-dBATCH", "-dSAFER",
            "-sDEVICE=pdfwrite",
            "-dCompatibilityLevel=1.5",
            "-dDetectDuplicateImages=true",
            "-dCompressFonts=true",
            "-dSubsetFonts=true",
            "-sOutputFile=-",
            "-",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        out, err = await proc.communicate(input=pdf_bytes)
        if proc.returncode == 0 and out:
            saved = len(pdf_bytes) - len(out)
            log.info(
                "PDF optimiert: %d → %d Bytes (-%d%% / %.1f KB gespart)",
                len(pdf_bytes), len(out),
                int(saved * 100 / max(1, len(pdf_bytes))),
                saved / 1024,
            )
            return out
        log.warning(
            "Ghostscript-Optimierung fehlgeschlagen (rc=%d): %s",
            proc.returncode, err.decode("utf-8", "ignore"),
        )
    except Exception as exc:
        log.warning("PDF-Optimierung übersprungen: %s", exc)
    return pdf_bytes
