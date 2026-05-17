"""Profanity-Filter und Name-Validierung für Customer-Claims.

Die Wortliste liegt in server/data/profanity_de.txt und ist vom
Operator erweiterbar. Wir verwenden zwei Strategien parallel:

1. **Exakter Wort-Match** (mit Bindestrich-/Leerzeichen-Trennern als
   Wortgrenzen). Verhindert dass "Klasse" als anstößig erkannt wird
   nur weil "ass" enthalten ist.
2. **Substring-Match nach Normalisierung** für die wirklich harten
   Begriffe (Beleidigungen, Nazi-Kram). Das verhindert dass
   l33t-Spelling wie "h1tler" oder "n@zi" durchrutscht.

Aufruf einfach via :func:`is_clean` oder :func:`validate_name`.
"""
from __future__ import annotations
from pathlib import Path
import re
import unicodedata

_PROFANITY_PATH = Path(__file__).parent / "data" / "profanity_de.txt"

# Begriffe die so dermaßen anstößig sind, dass auch Substring-Treffer
# blockiert werden (auch "Mhitlero" wird gefiltert). Wird beim Laden
# aus der Wortliste mit einem Marker "!" am Zeilenende markiert –
# aber zur Einfachheit codieren wir das hier hart.
_HARDCORE_HINTS = {
    "hitler", "nazi", "fick", "hure", "fotze",
    "neger", "nigger", "wichs", "arschloch",
}

_words_cache: list[str] | None = None
_hardcore_cache: list[str] | None = None


def _normalize(text: str) -> str:
    """Lowercase + Umlaute auflösen + nicht-Buchstaben raus.

    l33t-Spelling-Tricks ausgehebelt: 0→o, 1→i, 3→e, 4→a, 5→s, 7→t,
    @→a, $→s. Damit fällt "h1tler" auf "hitler" zurück.
    """
    text = text.lower().strip()
    text = (text.replace("ä", "ae").replace("ö", "oe").replace("ü", "ue")
                .replace("ß", "ss"))
    text = (text.replace("0", "o").replace("1", "i").replace("3", "e")
                .replace("4", "a").replace("5", "s").replace("7", "t")
                .replace("@", "a").replace("$", "s"))
    # alles außer a-z entfernen
    text = re.sub(r"[^a-z]", "", text)
    return text


def _load() -> tuple[list[str], list[str]]:
    """Wortliste laden und cachen. Liefert (alle_woerter, hardcore)."""
    global _words_cache, _hardcore_cache
    if _words_cache is not None and _hardcore_cache is not None:
        return _words_cache, _hardcore_cache
    words: list[str] = []
    hardcore: list[str] = []
    if _PROFANITY_PATH.exists():
        for raw in _PROFANITY_PATH.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            norm = _normalize(line)
            if not norm:
                continue
            words.append(norm)
            if any(h in norm for h in _HARDCORE_HINTS):
                hardcore.append(norm)
    _words_cache = words
    _hardcore_cache = hardcore
    return words, hardcore


def reload() -> None:
    """Cache invalidieren (für Tests oder nach Editing der Liste)."""
    global _words_cache, _hardcore_cache
    _words_cache = None
    _hardcore_cache = None


def is_clean(name: str) -> bool:
    """True wenn der Name unauffällig ist."""
    norm = _normalize(name)
    if not norm:
        return False
    words, hardcore = _load()
    # Exakter Match (normalisiert)
    if norm in set(words):
        return False
    # Substring-Match für Hardcore-Terms
    for h in hardcore:
        if h and h in norm:
            return False
    return True


def validate_name(name: str) -> tuple[bool, str]:
    """Validiert einen vom Customer eingegebenen Namen.

    Returns (ok, message). Message ist deutsch, kundengerecht.
    """
    name = (name or "").strip()
    if not name:
        return False, "Bitte einen Namen eingeben."
    if len(name) < 2:
        return False, "Der Name ist zu kurz (min. 2 Zeichen)."
    if len(name) > 25:
        return False, "Der Name ist zu lang (max. 25 Zeichen)."
    # Nur druckbare Zeichen erlauben (verhindert Steuerzeichen,
    # Zero-Width-Tricks, etc.).
    if any(unicodedata.category(c).startswith("C") for c in name):
        return False, "Der Name enthält ungültige Zeichen."
    # Mindestens 1 Buchstabe verlangen (sonst "1234" oder "..." OK)
    if not re.search(r"[A-Za-zÄÖÜäöüß]", name):
        return False, "Der Name muss mindestens einen Buchstaben enthalten."
    if not is_clean(name):
        return False, "Dieser Name ist leider nicht erlaubt. Bitte wähle einen anderen."
    return True, ""
