"""Bounded, deterministic text extraction. No packages, network or model calls."""
import hashlib
import re

MAX_TEXT_BYTES = 200_000
MAX_LINES = 2_000


def extract_document(document):
    if not isinstance(document, dict):
        raise ValueError("Provide a document object.")
    document_id = document.get("id")
    text = document.get("text")
    if not isinstance(document_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,160}", document_id):
        raise ValueError("Provide a valid document reference.")
    if not isinstance(text, str) or not text.strip():
        raise ValueError("Provide non-empty document text.")
    try:
        encoded = text.encode("utf-8")
    except UnicodeEncodeError as error:
        raise ValueError("Document text must contain valid Unicode.") from error
    if len(encoded) > MAX_TEXT_BYTES:
        raise ValueError("Document text exceeds 200 KB.")
    lines = text.splitlines()
    if len(lines) > MAX_LINES:
        raise ValueError("Document text exceeds 2,000 lines.")
    return {
        "documentId": document_id,
        "sha256": hashlib.sha256(encoded).hexdigest(),
        "lines": [{"line": index, "text": line} for index, line in enumerate(lines, start=1)],
        "authoritative": False,
    }
