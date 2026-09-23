"""Extra export formats: Word (.docx), plain text (.txt) and JSON.

They take the same :class:`ExportRequest` as the PDF, so every option of the
PDF (reading vs. timed layout, original / translation / both, AI summary and
chapters) behaves the same way here.

The .docx is written by hand (a handful of XML parts in a zip) instead of via a
library: it keeps the installer small, and it lets us mark Arabic paragraphs as
right-to-left properly (``w:bidi`` + ``w:rtl``), which is what makes Word lay
them out correctly.
"""

from __future__ import annotations

import json
import re
import zipfile
from pathlib import Path
from typing import Any
from xml.sax.saxutils import escape

from .errors import AppError, ErrorCode
from .pdf_export import (
    ExportRequest,
    ExportSegment,
    _body_events,
    _content_segments,
    format_clock,
    format_timestamp,
    is_rtl,
)

JSON_FORMAT = "local-transcriber-transcript"

LABELS = {
    "ar": {
        "summary": "الملخص",
        "key_points": "النقاط الرئيسية",
        "chapters": "الفصول",
        "transcript": "النص",
        "language": "اللغة",
        "duration": "المدة",
        "model": "النموذج",
        "source": "المصدر",
        "translation": "الترجمة",
        "date": "تاريخ التفريغ",
    },
    "en": {
        "summary": "Summary",
        "key_points": "Key points",
        "chapters": "Chapters",
        "transcript": "Transcript",
        "language": "Language",
        "duration": "Duration",
        "model": "Model",
        "source": "Source",
        "translation": "Translation",
        "date": "Transcribed",
    },
}

_BAD_XML = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f￾￿]")


def _labels(req: ExportRequest) -> dict[str, str]:
    return LABELS.get(req.ui_language, LABELS["ar"])


def _duration_text(seconds: float | None, ui: str) -> str:
    if not seconds:
        return ""
    total = int(round(seconds))
    h, rem = divmod(total, 3600)
    m, s = divmod(rem, 60)
    if ui == "ar":
        return f"{h} س {m} د" if h else f"{m} د {s} ث"
    return f"{h}h {m}m" if h else f"{m}m {s}s"


def _web_source(source: str) -> str:
    return source if source.startswith(("http://", "https://")) else ""


def _chapters(req: ExportRequest) -> list[dict[str, Any]]:
    chapters = (req.summary or {}).get("chapters") or []
    out = []
    for ch in chapters:
        try:
            out.append({"start": float(ch.get("start", 0)), "title": str(ch.get("title", "")).strip(), "summary": str(ch.get("summary", "") or "")})
        except (TypeError, ValueError, AttributeError):
            continue
    return sorted(out, key=lambda c: c["start"])


RLM = "\u200f"
LRM = "\u200e"


def text_rtl(text: str) -> bool:
    """Direction of a mixed line by its majority script ("JOIN يربط الجداول" is right-to-left)."""
    import unicodedata

    rtl = ltr = 0
    for ch in text:
        bidi = unicodedata.bidirectional(ch)
        if bidi in ("R", "AL"):
            rtl += 1
        elif bidi == "L":
            ltr += 1
    if not rtl:
        return False
    return rtl >= ltr or is_rtl(text)  # majority script, or a line that starts in Arabic


def display_title(name: str) -> str:
    """File name without its extension ("Lesson 1.mp4" → "Lesson 1")."""
    stem, dot, ext = (name or "").rpartition(".")
    return stem if dot and stem and 1 <= len(ext) <= 5 and ext.isalnum() else (name or "")


def _meta_line(req: ExportRequest) -> list[tuple[str, str]]:
    lb = _labels(req)
    rows = []
    if req.language_name or req.language_code:
        rows.append((lb["language"], req.language_name or req.language_code))
    if req.duration:
        rows.append((lb["duration"], _duration_text(req.duration, req.ui_language)))
    if req.model_name:
        rows.append((lb["model"], req.model_name))
    rows.append((lb["date"], req.transcribed_at.strftime("%Y-%m-%d")))
    if _web_source(req.source):
        rows.append((lb["source"], req.source))
    return rows


def _events(req: ExportRequest) -> list[ExportSegment | dict]:
    content = req.content if req.translation else "original"
    return _body_events(_content_segments(req, content), _chapters(req), req.include_timestamps)


def _long(req: ExportRequest) -> bool:
    return (req.duration or 0) >= 3600


# --------------------------------------------------------------------- text
def to_txt(req: ExportRequest) -> str:
    lb = _labels(req)
    long = _long(req)
    lines = [display_title(req.media_name), " · ".join(f"{k}: {v}" for k, v in _meta_line(req)), ""]
    summary = req.summary or {}
    if summary.get("summary"):
        lines += [f"== {lb['summary']} ==", str(summary["summary"]).strip(), ""]
    points = [str(p).strip() for p in summary.get("key_points") or [] if str(p).strip()]
    if points:
        lines += [f"== {lb['key_points']} ==", *[f"• {p}" for p in points], ""]
    chapters = _chapters(req)
    if chapters:
        lines += [f"== {lb['chapters']} ==", *[f"{format_clock(c['start'], long)}  {c['title']}" for c in chapters], ""]
    lines += [f"== {lb['transcript']} ==", ""]
    lines.pop()
    for ev in _events(req):
        if isinstance(ev, dict):
            if lines[-1]:
                lines.append("")
            lines += [f"— {format_clock(ev['start'], long)} {ev['title']} —", ""]
            continue
        text = ev.text.strip()
        lines.append(f"[{format_clock(ev.start, long)}] {text}" if req.include_timestamps else text)
        if ev.alt:
            lines.append(ev.alt.strip())
        if not req.include_timestamps or ev.alt:
            lines.append("")
    return "\n".join(lines).rstrip() + "\n"


# --------------------------------------------------------------------- json
def to_json(req: ExportRequest, extra: dict[str, Any] | None = None) -> dict[str, Any]:
    """Everything, whatever the layout options: meant for programs, not people."""
    base = [s for s in req.segments if s.text.strip()]
    trans = req.translation or []
    segments = []
    for i, s in enumerate(base):
        row: dict[str, Any] = {"index": i, "start": round(s.start, 3), "end": round(s.end, 3), "text": s.text.strip()}
        if trans:
            match = trans[i] if len(trans) == len(base) else min(trans, key=lambda t, s=s: abs(t.start - s.start))
            row["translation"] = match.text.strip()
        segments.append(row)
    summary = req.summary or None
    data: dict[str, Any] = {
        "format": JSON_FORMAT,
        "version": 1,
        "title": req.media_name,
        "source": req.source or "",
        "engine": req.engine,
        "language": req.language_code,
        "language_name": req.language_name,
        "model": req.model_name,
        "duration": req.duration,
        "transcribed_at": req.transcribed_at.isoformat(timespec="seconds"),
        "text": " ".join(s["text"] for s in segments),
        "segments": segments,
        "translation": (
            {"language_name": req.translation_language_name, "text": " ".join(t.text.strip() for t in trans if t.text.strip())}
            if trans
            else None
        ),
        "summary": summary,
    }
    if extra:
        data.update(extra)
    return data


# --------------------------------------------------------------------- docx
def _t(text: str) -> str:
    return escape(_BAD_XML.sub("", text))


def _run(text: str, rtl: bool, *, bold: bool = False, color: str | None = None, size: int | None = None) -> str:
    props = []
    if bold:
        props += ["<w:b/>", "<w:bCs/>"]
    if color:
        props.append(f'<w:color w:val="{color}"/>')
    if size:
        props += [f'<w:sz w:val="{size}"/>', f'<w:szCs w:val="{size}"/>']
    if rtl:
        props.append("<w:rtl/>")
    rpr = f"<w:rPr>{''.join(props)}</w:rPr>" if props else ""
    return f'<w:r>{rpr}<w:t xml:space="preserve">{_t(text)}</w:t></w:r>'


def _para(runs: list[tuple[str, dict[str, Any]]] | str, *, style: str | None = None, rtl: bool | None = None, keep_next: bool = False) -> str:
    if isinstance(runs, str):
        runs = [(runs, {})]
    text = "".join(r[0] for r in runs)
    direction = text_rtl(text) if rtl is None else rtl
    ppr = []
    if style:
        ppr.append(f'<w:pStyle w:val="{style}"/>')
    if keep_next:
        ppr.append("<w:keepNext/>")
    if direction:
        ppr.append("<w:bidi/>")
    # Each run carries its own direction: marking Latin text or numbers (a date, a time) as
    # right-to-left makes Word reorder their digits.
    body = "".join(_run(t, direction and text_rtl(t), **opts) for t, opts in runs if t)
    return f"<w:p><w:pPr>{''.join(ppr)}</w:pPr>{body}</w:p>"


_STYLES = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults>
    <w:rPrDefault><w:rPr>
      <w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="Arial" w:cs="Arial"/>
      <w:sz w:val="24"/><w:szCs w:val="26"/><w:lang w:val="en-US" w:bidi="ar-SA"/>
    </w:rPr></w:rPrDefault>
    <w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="324" w:lineRule="auto"/></w:pPr></w:pPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
  <w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>
    <w:pPr><w:spacing w:after="80"/></w:pPr><w:rPr><w:b/><w:bCs/><w:color w:val="0F3D6E"/><w:sz w:val="40"/><w:szCs w:val="40"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>
    <w:pPr><w:keepNext/><w:spacing w:before="360" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr>
    <w:rPr><w:b/><w:bCs/><w:color w:val="0F3D6E"/><w:sz w:val="30"/><w:szCs w:val="30"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>
    <w:pPr><w:keepNext/><w:spacing w:before="240" w:after="80"/><w:outlineLvl w:val="1"/></w:pPr>
    <w:rPr><w:b/><w:bCs/><w:color w:val="1F5F99"/><w:sz w:val="26"/><w:szCs w:val="26"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Meta"><w:name w:val="Meta"/><w:basedOn w:val="Normal"/>
    <w:pPr><w:spacing w:after="40"/></w:pPr><w:rPr><w:color w:val="5F6B7A"/><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Translation"><w:name w:val="Translation"/><w:basedOn w:val="Normal"/>
    <w:pPr><w:spacing w:after="200"/></w:pPr><w:rPr><w:i/><w:iCs/><w:color w:val="44546A"/></w:rPr></w:style>
</w:styles>"""

_CONTENT_TYPES = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>"""

_ROOT_RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>"""

_DOC_RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>"""


def _core(title: str) -> str:
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
        'xmlns:dc="http://purl.org/dc/elements/1.1/">'
        f"<dc:title>{_t(title)}</dc:title><dc:creator>Local Transcriber</dc:creator></cp:coreProperties>"
    )


def docx_body(req: ExportRequest) -> list[str]:
    lb = _labels(req)
    ui_rtl = req.ui_language == "ar"
    long = _long(req)
    parts = [_para(display_title(req.media_name), style="Title")]
    for key, value in _meta_line(req):
        parts.append(_para([(f"{key}: ", {"bold": True}), (value, {})], style="Meta", rtl=ui_rtl))
    summary = req.summary or {}
    if summary.get("summary"):
        parts.append(_para(lb["summary"], style="Heading1", rtl=ui_rtl))
        for block in str(summary["summary"]).split("\n"):
            if block.strip():
                parts.append(_para(block.strip()))
    points = [str(p).strip() for p in summary.get("key_points") or [] if str(p).strip()]
    if points:
        parts.append(_para(lb["key_points"], style="Heading2", rtl=ui_rtl))
        parts += [_para(f"•  {p}", rtl=text_rtl(p)) for p in points]
    chapters = _chapters(req)
    if chapters:
        parts.append(_para(lb["chapters"], style="Heading2", rtl=ui_rtl))
        for ch in chapters:
            parts.append(
                _para([(format_clock(ch["start"], long) + "   ", {"color": "1F5F99", "bold": True}), (ch["title"], {})], rtl=text_rtl(ch["title"]))
            )
    parts.append(_para(lb["transcript"], style="Heading1", rtl=ui_rtl))
    for ev in _events(req):
        if isinstance(ev, dict):
            rtl = text_rtl(ev["title"])
            clock = format_clock(ev["start"], long)
            parts.append(_para([(clock + "  ·  ", {"color": "7A8594"}), (ev["title"] + (RLM if rtl else ""), {})], style="Heading2", rtl=rtl))
            continue
        text = ev.text.strip()
        runs: list[tuple[str, dict[str, Any]]] = []
        if req.include_timestamps:
            runs.append((f"[{format_clock(ev.start, long)}]  ", {"color": "7A8594", "size": 19}))
        runs.append((text, {}))
        parts.append(_para(runs, rtl=text_rtl(text), keep_next=bool(ev.alt)))
        if ev.alt:
            parts.append(_para(ev.alt.strip(), style="Translation"))
    return parts


def write_docx(req: ExportRequest, path: Path) -> Path:
    body = "".join(docx_body(req))
    rtl_section = "<w:bidi/>" if req.ui_language == "ar" else ""
    document = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        f"<w:body>{body}"
        '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>'
        '<w:pgMar w:top="1300" w:right="1300" w:bottom="1300" w:left="1300" w:header="708" w:footer="708" w:gutter="0"/>'
        f"{rtl_section}</w:sectPr></w:body></w:document>"
    )
    return _write_zip(
        path,
        {
            "[Content_Types].xml": _CONTENT_TYPES,
            "_rels/.rels": _ROOT_RELS,
            "word/document.xml": document,
            "word/_rels/document.xml.rels": _DOC_RELS,
            "word/styles.xml": _STYLES,
            "docProps/core.xml": _core(req.media_name),
        },
    )


# --------------------------------------------------------------------- files
def _write_zip(path: Path, files: dict[str, str]) -> Path:
    partial = path.with_name(path.name + ".part")
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(partial, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            for name, content in files.items():
                zf.writestr(name, content)
        partial.replace(path)
    except OSError as exc:
        partial.unlink(missing_ok=True)
        raise AppError(ErrorCode.EXPORT_FAILED, f"{path}: {exc}") from exc
    return path


def write_document(req: ExportRequest, fmt: str, extra: dict[str, Any] | None = None) -> Path:
    """Write ``req.output_path`` (its suffix is replaced by the format's)."""
    path = Path(req.output_path).with_suffix(f".{fmt}")
    if fmt == "docx":
        return write_docx(req, path)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        if fmt == "txt":
            # BOM: Windows Notepad and Excel then read Arabic correctly.
            path.write_text(to_txt(req), encoding="utf-8-sig", newline="\r\n")
        elif fmt == "json":
            path.write_text(json.dumps(to_json(req, extra), ensure_ascii=False, indent=2), encoding="utf-8")
        else:
            raise AppError(ErrorCode.INVALID_REQUEST, f"Unknown format: {fmt}")
    except OSError as exc:
        raise AppError(ErrorCode.EXPORT_FAILED, f"{path}: {exc}") from exc
    return path


__all__ = ["write_document", "to_txt", "to_json", "write_docx", "format_timestamp"]
