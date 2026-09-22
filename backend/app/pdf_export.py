"""PDF export with correct Arabic rendering.

Arabic needs two things most PDF libraries get wrong:

1. **Shaping** – letters change form depending on their neighbours
   (isolated/initial/medial/final) and form ligatures such as لا.
2. **Bidirectional layout** – Arabic runs right-to-left while embedded
   English words and numbers run left-to-right.

fpdf2 delegates shaping to HarfBuzz (``uharfbuzz``) – the same engine used by
Chrome and Firefox – and implements the Unicode Bidirectional Algorithm, so
the output is identical to what a browser would show. The Amiri font (SIL Open
Font License) is embedded; it covers Arabic *and* Latin so mixed text never
falls back to empty boxes.
"""

from __future__ import annotations

import logging
import unicodedata
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from fpdf import FPDF
from fpdf.enums import XPos, YPos

from .errors import AppError, ErrorCode

log = logging.getLogger(__name__)

APP_LABEL = "Local Transcriber"

_LABELS = {
    "ar": {
        "title": "تفريغ نصي",
        "file": "الملف",
        "date": "تاريخ التفريغ",
        "language": "اللغة",
        "model": "النموذج",
        "duration": "المدة",
        "page": "صفحة {page} من {total}",
        "generated": "أُنشئ محليًا بواسطة Local Transcriber — لم تُرفع أي بيانات",
    },
    "en": {
        "title": "Transcript",
        "file": "File",
        "date": "Transcribed on",
        "language": "Language",
        "model": "Model",
        "duration": "Duration",
        "page": "Page {page} of {total}",
        "generated": "Generated locally by Local Transcriber — no data was uploaded",
    },
}


@dataclass
class ExportSegment:
    start: float
    end: float
    text: str


@dataclass
class ExportRequest:
    output_path: Path
    media_name: str
    language_code: str
    language_name: str
    model_name: str | None
    duration: float | None
    include_timestamps: bool
    ui_language: str  # "ar" | "en" – language of the PDF's labels
    segments: list[ExportSegment]
    transcribed_at: datetime


def format_timestamp(seconds: float) -> str:
    seconds = max(0, int(round(seconds)))
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    return f"{h:02d}:{m:02d}:{s:02d}"


def is_rtl(text: str) -> bool:
    """Paragraph direction from the first strong character (Unicode bidi rule P2)."""
    for ch in text:
        bidi = unicodedata.bidirectional(ch)
        if bidi in ("R", "AL"):
            return True
        if bidi == "L":
            return False
    return False


def build_paragraphs(segments: list[ExportSegment], gap: float = 2.0, max_chars: int = 700) -> list[ExportSegment]:
    """Merge consecutive segments into readable paragraphs (used without timestamps).

    A new paragraph starts after a pause longer than ``gap`` seconds, or when
    the current one is long and the previous segment ended a sentence.
    """
    paragraphs: list[ExportSegment] = []
    current: ExportSegment | None = None
    for seg in segments:
        text = seg.text.strip()
        if not text:
            continue
        if current is None:
            current = ExportSegment(seg.start, seg.end, text)
            continue
        ends_sentence = current.text.endswith((".", "؟", "?", "!", "…"))
        if seg.start - current.end > gap or (len(current.text) > max_chars and ends_sentence):
            paragraphs.append(current)
            current = ExportSegment(seg.start, seg.end, text)
        else:
            current.text = f"{current.text} {text}"
            current.end = seg.end
    if current is not None:
        paragraphs.append(current)
    return paragraphs


class _TranscriptPDF(FPDF):
    def __init__(self, labels: dict[str, str], rtl: bool, header_text: str, total_pages: int | None) -> None:
        super().__init__(orientation="portrait", unit="mm", format="A4")
        self.labels = labels
        self.total_pages = total_pages
        self.doc_rtl = rtl
        self.header_text = header_text
        self.set_margins(left=20, top=22, right=20)
        self.set_auto_page_break(auto=True, margin=22)
        self.set_title(header_text)
        self.set_creator(APP_LABEL)
        self.set_producer(APP_LABEL)

    # Direction must be set before every piece of text so HarfBuzz shapes it right.
    def use_direction(self, text: str) -> bool:
        rtl = is_rtl(text) if text.strip() else self.doc_rtl
        self.set_text_shaping(use_shaping_engine=True, direction="rtl" if rtl else "ltr")
        return rtl

    def header(self) -> None:
        if self.page_no() == 1:
            return
        self.set_font("Amiri", size=9)
        self.set_text_color(120, 120, 120)
        self.use_direction(self.header_text)
        self.set_y(10)
        self.cell(0, 6, self.header_text, align="R" if self.doc_rtl else "L")
        self.set_draw_color(220, 220, 220)
        self.line(self.l_margin, 17, self.w - self.r_margin, 17)
        self.set_y(self.t_margin)
        self.set_text_color(0, 0, 0)

    def footer(self) -> None:
        self.set_y(-15)
        self.set_draw_color(220, 220, 220)
        self.line(self.l_margin, self.get_y() - 1, self.w - self.r_margin, self.get_y() - 1)
        self.set_font("Amiri", size=8.5)
        self.set_text_color(130, 130, 130)
        # The total is known from a first layout pass (see generate_pdf). fpdf2's
        # "{nb}" alias can't be used: shaped RTL text no longer contains it.
        page = self.labels["page"].format(page=self.page_no(), total=self.total_pages or self.page_no())
        self.use_direction(page)
        self.cell(0, 6, page, align="C")
        self.set_text_color(0, 0, 0)


def generate_pdf(req: ExportRequest, fonts_dir: Path) -> Path:
    try:
        # Two passes: the first only measures how many pages the layout needs
        # so the footer can say "page X of Y" in Arabic.
        total = _layout(req, fonts_dir, None).pages_count
        pdf = _layout(req, fonts_dir, total)
        req.output_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = req.output_path.with_suffix(".pdf.part")
        pdf.output(str(tmp))
        tmp.replace(req.output_path)  # atomic: never leave a half-written PDF
        return req.output_path
    except AppError:
        raise
    except PermissionError as exc:
        raise AppError(ErrorCode.PDF_FAILED, f"Cannot write to {req.output_path} (is it open in another program?)") from exc
    except Exception as exc:  # noqa: BLE001
        log.exception("PDF generation failed")
        raise AppError(ErrorCode.PDF_FAILED, f"{exc.__class__.__name__}: {exc}"[:300]) from exc


def _layout(req: ExportRequest, fonts_dir: Path, total_pages: int | None) -> _TranscriptPDF:
    regular = fonts_dir / "Amiri-Regular.ttf"
    bold = fonts_dir / "Amiri-Bold.ttf"
    if not regular.is_file():
        raise AppError(ErrorCode.PDF_FAILED, f"Arabic font missing: {regular}")

    labels = _LABELS.get(req.ui_language, _LABELS["ar"])
    sample = " ".join(s.text for s in req.segments[:20])
    doc_rtl = is_rtl(sample) if sample.strip() else req.ui_language == "ar"

    pdf = _TranscriptPDF(labels, doc_rtl, f"{req.media_name} — {labels['title']}", total_pages)
    pdf.add_font("Amiri", "", str(regular))
    pdf.add_font("Amiri", "B", str(bold if bold.is_file() else regular))
    pdf.add_page()

    body_w = pdf.w - pdf.l_margin - pdf.r_margin
    ui_rtl = req.ui_language == "ar"
    ui_align = "R" if ui_rtl else "L"

    # ---- Title -------------------------------------------------------------
    pdf.set_font("Amiri", "B", 22)
    pdf.set_text_color(20, 60, 120)
    pdf.use_direction(labels["title"])
    pdf.cell(0, 13, labels["title"], align=ui_align, new_x=XPos.LMARGIN, new_y=YPos.NEXT)
    pdf.set_text_color(0, 0, 0)
    pdf.ln(2)

    # ---- Metadata block ----------------------------------------------------
    meta: list[tuple[str, str]] = [
        (labels["file"], req.media_name),
        (labels["date"], req.transcribed_at.strftime("%Y-%m-%d %H:%M")),
        (labels["language"], req.language_name or req.language_code),
    ]
    if req.duration:
        meta.append((labels["duration"], format_timestamp(req.duration)))
    if req.model_name:
        meta.append((labels["model"], req.model_name))

    label_w = 38
    row_h = 7.5
    top = pdf.get_y()
    pdf.set_fill_color(244, 247, 251)
    pdf.set_draw_color(215, 224, 236)
    pdf.rect(pdf.l_margin, top, body_w, row_h * len(meta) + 4, style="DF")
    pdf.set_y(top + 2)
    for label, value in meta:
        y = pdf.get_y()
        value_w = body_w - label_w - 8
        label_x = pdf.w - pdf.r_margin - 4 - label_w if ui_rtl else pdf.l_margin + 4
        value_x = pdf.l_margin + 4 if ui_rtl else pdf.l_margin + 4 + label_w
        pdf.set_font("Amiri", "B", 10.5)
        pdf.set_text_color(70, 80, 95)
        pdf.use_direction(label)
        pdf.set_xy(label_x, y)
        pdf.cell(label_w, row_h, label, align=ui_align)
        pdf.set_font("Amiri", "", 10.5)
        pdf.set_text_color(0, 0, 0)
        pdf.use_direction(value)
        pdf.set_xy(value_x, y)
        # Truncate very long file names so the row never wraps.
        shown = value
        while pdf.get_string_width(shown) > value_w and len(shown) > 8:
            shown = shown[: len(shown) - 4] + "…"
        pdf.cell(value_w, row_h, shown, align=ui_align)
        pdf.set_y(y + row_h)
    pdf.set_y(top + row_h * len(meta) + 10)

    # ---- Transcript body ---------------------------------------------------
    body_size = 13
    line_h = 8.2
    items = req.segments if req.include_timestamps else build_paragraphs(req.segments)
    ts_w = 24 if req.include_timestamps else 0
    text_w = body_w - ts_w - (3 if ts_w else 0)

    for item in items:
        text = item.text.strip()
        if not text:
            continue
        if pdf.get_y() + line_h > pdf.page_break_trigger:
            pdf.add_page()
        rtl = is_rtl(text) if text else doc_rtl
        y = pdf.get_y()

        if ts_w:
            stamp = f"[{format_timestamp(item.start)}]"
            pdf.set_font("Amiri", "", 9.5)
            pdf.set_text_color(40, 110, 170)
            pdf.set_text_shaping(use_shaping_engine=True, direction="ltr")
            stamp_x = pdf.w - pdf.r_margin - ts_w if doc_rtl else pdf.l_margin
            pdf.set_xy(stamp_x, y + 0.6)
            pdf.cell(ts_w, line_h, stamp, align="R" if doc_rtl else "L")
            text_x = pdf.l_margin if doc_rtl else pdf.l_margin + ts_w + 3
        else:
            text_x = pdf.l_margin

        pdf.set_font("Amiri", "", body_size)
        pdf.set_text_color(15, 15, 15)
        pdf.use_direction(text)
        pdf.set_xy(text_x, y)
        pdf.multi_cell(
            text_w,
            line_h,
            text,
            align="R" if rtl else "L",
            new_x=XPos.LMARGIN,
            new_y=YPos.NEXT,
        )
        pdf.ln(1.5 if ts_w else 3.5)

    # ---- Closing note ------------------------------------------------------
    pdf.ln(4)
    pdf.set_font("Amiri", "", 8.5)
    pdf.set_text_color(140, 140, 140)
    pdf.use_direction(labels["generated"])
    pdf.cell(0, 6, labels["generated"], align="C", new_x=XPos.LMARGIN, new_y=YPos.NEXT)
    return pdf
