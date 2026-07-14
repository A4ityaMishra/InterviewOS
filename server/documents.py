"""Text extraction from uploaded interview documents (JD, resumes, notes).

Extraction results are cached on disk by content hash, so re-uploading the
same JD (or resume) never re-parses the PDF/DOCX.
"""

import hashlib
import io
from pathlib import Path

from pypdf import PdfReader
from docx import Document

MAX_CHARS_PER_DOC = 15000

CACHE_DIR = Path(__file__).resolve().parent.parent / "data" / "doc_cache"
CACHE_DIR.mkdir(parents=True, exist_ok=True)


def extract_text(filename: str, data: bytes) -> str:
    ext = Path(filename.lower()).suffix or ".txt"
    key = hashlib.sha256(data).hexdigest() + ext.strip(".")
    cached = CACHE_DIR / f"{key}.txt"
    if cached.exists():
        return cached.read_text()
    text = _extract(filename, data)
    cached.write_text(text)
    return text


def _extract(filename: str, data: bytes) -> str:
    name = filename.lower()
    if name.endswith(".pdf"):
        reader = PdfReader(io.BytesIO(data))
        text = "\n".join(page.extract_text() or "" for page in reader.pages)
    elif name.endswith(".docx"):
        doc = Document(io.BytesIO(data))
        text = "\n".join(p.text for p in doc.paragraphs)
    else:  # txt / md / anything else: treat as utf-8 text
        text = data.decode("utf-8", errors="replace")
    text = text.strip()
    return text[:MAX_CHARS_PER_DOC]
