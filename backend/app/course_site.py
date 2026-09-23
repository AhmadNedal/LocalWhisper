"""Export a course as a small static website.

``website/index.html`` lists the lessons and searches the whole course;
``website/lesson-01.html``… show each lesson's summary, chapters and text (with
the translation behind a toggle). Everything is plain HTML/CSS/JS in one folder
with relative links, so it works when opened straight from disk (file://), on a
USB stick, or uploaded to any static host. Nothing is loaded from the internet.

Search runs in the browser over ``assets/search-index.js`` (a script, not JSON,
because browsers block ``fetch`` of local files). Arabic is normalized the same
way as the app's archive search: tashkeel, tatweel, alef forms, ya/ta marbuta.
"""

from __future__ import annotations

import html
import json
import re
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, quote, urlparse

from .errors import AppError, ErrorCode
from .pdf_export import ExportRequest, ExportSegment, _body_events, _content_segments, format_clock
from .documents import display_title, text_rtl

LABELS = {
    "ar": {
        "lessons": "الدروس",
        "lesson": "الدرس",
        "search": "ابحث في كل الدورة…",
        "search_btn": "بحث",
        "results": "{n} نتيجة",
        "results_more": "أول {n} نتيجة — اكتب كلمات أكثر لتضييق البحث",
        "no_results": "لا توجد نتائج",
        "summary": "الملخص",
        "key_points": "النقاط الرئيسية",
        "chapters": "الفصول",
        "transcript": "النص",
        "show_translation": "إظهار الترجمة",
        "hide_translation": "إخفاء الترجمة",
        "prev": "الدرس السابق",
        "next": "الدرس التالي",
        "all_lessons": "كل الدروس",
        "downloads": "تنزيل",
        "watch": "مشاهدة على يوتيوب",
        "watch_here": "شاهد من هذه اللحظة",
        "total": "{n} درس · {d}",
        "generated": "صُنع بواسطة Local Transcriber في {date}",
        "hours": "{h} س {m} د",
        "minutes": "{m} د",
        "pdf": "PDF",
        "subtitles": "ترجمة الفيديو",
        "back_top": "للأعلى",
    },
    "en": {
        "lessons": "Lessons",
        "lesson": "Lesson",
        "search": "Search the whole course…",
        "search_btn": "Search",
        "results": "{n} results",
        "results_more": "First {n} results — add words to narrow the search",
        "no_results": "No results",
        "summary": "Summary",
        "key_points": "Key points",
        "chapters": "Chapters",
        "transcript": "Transcript",
        "show_translation": "Show translation",
        "hide_translation": "Hide translation",
        "prev": "Previous lesson",
        "next": "Next lesson",
        "all_lessons": "All lessons",
        "downloads": "Download",
        "watch": "Watch on YouTube",
        "watch_here": "Watch from here",
        "total": "{n} lessons · {d}",
        "generated": "Made with Local Transcriber on {date}",
        "hours": "{h}h {m}m",
        "minutes": "{m}m",
        "pdf": "PDF",
        "subtitles": "Subtitles",
        "back_top": "Top",
    },
}


@dataclass
class SiteLesson:
    index: int
    title: str
    request: ExportRequest  # same data as the lesson's PDF
    files: dict[str, str] = field(default_factory=dict)  # "pdf" / "subtitles" / … → file name next to the site folder

    @property
    def href(self) -> str:
        return f"lesson-{self.index:02d}.html"


def youtube_id(source: str) -> str | None:
    if not source.startswith(("http://", "https://")):
        return None
    url = urlparse(source)
    host = url.netloc.lower().removeprefix("www.").removeprefix("m.")
    if host == "youtu.be":
        vid = url.path.strip("/").split("/")[0]
    elif host.endswith("youtube.com"):
        vid = parse_qs(url.query).get("v", [""])[0] or (url.path.split("/")[2] if url.path.startswith(("/shorts/", "/live/", "/embed/")) else "")
    else:
        return None
    return vid if re.fullmatch(r"[A-Za-z0-9_-]{6,20}", vid or "") else None


def _e(text: Any) -> str:
    return html.escape(str(text or ""), quote=True)


def _dir(text: str) -> str:
    return "rtl" if text_rtl(text) else "ltr"


def _duration(seconds: float, lb: dict[str, str]) -> str:
    total = int(round(seconds or 0))
    h, rem = divmod(total, 3600)
    m = rem // 60
    return lb["hours"].format(h=h, m=m) if h else lb["minutes"].format(m=max(1, m) if total else 0)


def _chapters(req: ExportRequest) -> list[dict[str, Any]]:
    out = []
    for ch in (req.summary or {}).get("chapters") or []:
        try:
            out.append({"start": float(ch.get("start", 0)), "title": str(ch.get("title", "")).strip(), "summary": str(ch.get("summary") or "")})
        except (TypeError, ValueError, AttributeError):
            continue
    return sorted(out, key=lambda c: c["start"])


def _paragraphs(req: ExportRequest) -> list[ExportSegment | dict]:
    content = "both" if req.translation else "original"
    return _body_events(_content_segments(req, content), _chapters(req), False)


# ------------------------------------------------------------------ pages
def _page(title: str, lang: str, body: str, *, scripts: list[str], description: str = "") -> str:
    direction = "rtl" if lang == "ar" else "ltr"
    tags = "".join(f'<script src="{s}"></script>' for s in scripts)
    return f"""<!doctype html>
<html lang="{lang}" dir="{direction}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="Local Transcriber">
<meta name="description" content="{_e(description)[:300]}">
<title>{_e(title)}</title>
<link rel="stylesheet" href="assets/style.css">
</head>
<body>
{body}
{tags}
</body>
</html>
"""


def _topbar(course: str, lb: dict[str, str], *, home: bool) -> str:
    brand = f'<span class="brand" dir="auto">{_e(course)}</span>' if home else f'<a class="brand" href="index.html" dir="auto">{_e(course)}</a>'
    return f"""<header class="topbar"><div class="wrap topbar-in">
{brand}
<form class="search" action="index.html" method="get" role="search">
<input type="search" name="q" placeholder="{_e(lb['search'])}" aria-label="{_e(lb['search'])}" dir="auto" autocomplete="off">
<button type="submit">{_e(lb['search_btn'])}</button>
</form>
</div></header>"""


def _downloads(lesson: SiteLesson, lb: dict[str, str]) -> str:
    links = []
    for key, label in (("pdf", lb["pdf"]), ("docx", "Word"), ("subtitles", lb["subtitles"]), ("subtitles_translation", lb["subtitles"]), ("txt", "TXT")):
        name = lesson.files.get(key)
        if name:
            suffix = Path(name).suffixes
            extra = f" ({''.join(suffix[-2:-1]).lstrip('.')})" if key.startswith("subtitles") and len(suffix) > 1 else ""
            links.append(f'<a class="chip" href="../{_e(quote(name))}" download>{_e(label)}{_e(extra)}</a>')
    if not links:
        return ""
    return f'<div class="downloads"><span class="muted">{_e(lb["downloads"])}:</span> {" ".join(links)}</div>'


def lesson_page(course: str, lesson: SiteLesson, prev: SiteLesson | None, nxt: SiteLesson | None, lang: str) -> str:
    lb = LABELS.get(lang, LABELS["ar"])
    req = lesson.request
    long = (req.duration or 0) >= 3600
    title = display_title(lesson.title)
    vid = youtube_id(req.source)
    summary = req.summary or {}
    chapters = _chapters(req)
    parts: list[str] = [_topbar(course, lb, home=False), '<main class="wrap lesson">']
    parts.append(f'<p class="crumb"><a href="index.html">{_e(lb["all_lessons"])}</a> · {_e(lb["lesson"])} {lesson.index}</p>')
    parts.append(f'<h1 dir="{_dir(title)}">{_e(title)}</h1>')
    meta = []
    if req.duration:
        meta.append(_e(_duration(req.duration, lb)))
    if req.language_name:
        meta.append(_e(req.language_name))
    if vid:
        meta.append(f'<a href="https://www.youtube.com/watch?v={vid}" target="_blank" rel="noopener">{_e(lb["watch"])} ↗</a>')
    if meta:
        parts.append(f'<p class="meta">{" · ".join(meta)}</p>')
    parts.append(_downloads(lesson, lb))

    if summary.get("summary") or summary.get("key_points"):
        parts.append('<section class="card summary">')
        if summary.get("summary"):
            parts.append(f'<h2>{_e(lb["summary"])}</h2>')
            for block in str(summary["summary"]).split("\n"):
                if block.strip():
                    parts.append(f'<p dir="{_dir(block)}">{_e(block.strip())}</p>')
        points = [str(p).strip() for p in summary.get("key_points") or [] if str(p).strip()]
        if points:
            parts.append(f'<h3>{_e(lb["key_points"])}</h3><ul>')
            parts += [f'<li dir="{_dir(p)}">{_e(p)}</li>' for p in points]
            parts.append("</ul>")
        parts.append("</section>")

    if chapters:
        parts.append(f'<nav class="card chapters" aria-label="{_e(lb["chapters"])}"><h2>{_e(lb["chapters"])}</h2><ol>')
        for ch in chapters:
            sec = int(ch["start"])
            parts.append(
                f'<li><a href="#t-{sec}"><span class="time">{format_clock(ch["start"], long)}</span>'
                f'<span dir="{_dir(ch["title"])}">{_e(ch["title"])}</span></a></li>'
            )
        parts.append("</ol></nav>")

    has_tr = bool(req.translation)
    head = f'<div class="transcript-head"><h2>{_e(lb["transcript"])}</h2>'
    if has_tr:
        head += (
            f'<button type="button" class="toggle-tr" data-show="{_e(lb["show_translation"])}" '
            f'data-hide="{_e(lb["hide_translation"])}">{_e(lb["show_translation"])}</button>'
        )
    parts.append(head + "</div>")
    parts.append('<article class="transcript">')
    for ev in _paragraphs(req):
        if isinstance(ev, dict):
            sec = int(ev["start"])
            parts.append(f'<h3 class="chapter" id="t-{sec}" dir="{_dir(ev["title"])}">{_e(ev["title"])}</h3>')
            continue
        sec = int(ev.start)
        clock = format_clock(ev.start, long)
        stamp = (
            f'<a class="time" href="https://www.youtube.com/watch?v={vid}&amp;t={sec}s" target="_blank" rel="noopener" '
            f'title="{_e(lb["watch_here"])}">{clock} ▶</a>'
            if vid
            else f'<a class="time" href="#t-{sec}">{clock}</a>'
        )
        parts.append(f'<div class="para" id="t-{sec}">{stamp}<p dir="{_dir(ev.text)}">{_e(ev.text)}</p>')
        if ev.alt:
            parts.append(f'<p class="tr" dir="{_dir(ev.alt)}">{_e(ev.alt)}</p>')
        parts.append("</div>")
    parts.append("</article>")

    nav = ['<nav class="pager">']
    nav.append(
        f'<a class="prev" href="{prev.href}"><small>{_e(lb["prev"])}</small><span dir="auto">{_e(display_title(prev.title))}</span></a>'
        if prev
        else "<span></span>"
    )
    nav.append(
        f'<a class="next" href="{nxt.href}"><small>{_e(lb["next"])}</small><span dir="auto">{_e(display_title(nxt.title))}</span></a>'
        if nxt
        else "<span></span>"
    )
    nav.append("</nav>")
    parts += nav
    parts.append("</main>")
    return _page(f"{title} — {course}", lang, "\n".join(parts), scripts=["assets/site.js"], description=str(summary.get("summary") or ""))


def index_page(course: str, lessons: list[SiteLesson], lang: str) -> str:
    lb = LABELS.get(lang, LABELS["ar"])
    total = sum(float(l.request.duration or 0) for l in lessons)
    parts = [_topbar(course, lb, home=True), '<main class="wrap home">']
    parts.append(f'<h1 dir="{_dir(course)}">{_e(course)}</h1>')
    parts.append(f'<p class="meta">{_e(lb["total"].format(n=len(lessons), d=_duration(total, lb)))}</p>')
    parts.append('<section id="results" class="results" hidden aria-live="polite"></section>')
    parts.append(f'<section id="lessons"><h2>{_e(lb["lessons"])}</h2><ol class="lesson-list">')
    for l in lessons:
        req = l.request
        summary = str((req.summary or {}).get("summary") or "").strip()
        excerpt = summary.split("\n")[0][:260] if summary else " ".join(s.text for s in req.segments[:6])[:220]
        badges = []
        if req.duration:
            badges.append(_e(_duration(req.duration, lb)))
        if (req.summary or {}).get("chapters"):
            badges.append(f'{len(req.summary["chapters"])} {_e(lb["chapters"])}')
        title = display_title(l.title)
        parts.append(
            f'<li><a href="{l.href}"><span class="num">{l.index}</span>'
            f'<span class="body"><span class="title" dir="{_dir(title)}">{_e(title)}</span>'
            f'<span class="excerpt" dir="{_dir(excerpt)}">{_e(excerpt)}</span>'
            f'<span class="badges">{" · ".join(badges)}</span></span></a></li>'
        )
    parts.append("</ol></section>")
    stamp = f'<bdi dir="ltr">{datetime.now().strftime("%Y-%m-%d")}</bdi>'
    parts.append(f'<footer class="foot">{_e(lb["generated"]).replace("{date}", stamp)}</footer>')
    parts.append("</main>")
    return _page(course, lang, "\n".join(parts), scripts=["assets/search-index.js", "assets/site.js"])


def search_index(course: str, lessons: list[SiteLesson], lang: str) -> str:
    lb = LABELS.get(lang, LABELS["ar"])
    items: list[list[Any]] = []
    meta = []
    for i, l in enumerate(lessons):
        long = (l.request.duration or 0) >= 3600
        meta.append({"n": l.index, "title": display_title(l.title), "href": l.href})
        for ev in _paragraphs(l.request):
            if isinstance(ev, dict):
                items.append([i, int(ev["start"]), ev["title"], "", format_clock(ev["start"], long), 1])
            else:
                items.append([i, int(ev.start), ev.text, ev.alt or "", format_clock(ev.start, long), 0])
    labels = {k: lb[k] for k in ("results", "results_more", "no_results", "lesson")}
    data = {"course": course, "lessons": meta, "items": items, "labels": labels}
    return "window.SITE_INDEX = " + json.dumps(data, ensure_ascii=False, separators=(",", ":")) + ";\n"


# ------------------------------------------------------------------ assets
STYLE = """:root{--bg:#f6f7f9;--card:#fff;--ink:#17202b;--ink2:#4a5566;--muted:#6b7686;--line:#e3e7ec;--accent:#0f5fa8;--accent-soft:#e7f0fa;--mark:#ffe58a;--time:#0f5fa8}
@media (prefers-color-scheme:dark){:root{--bg:#12161c;--card:#1a2029;--ink:#e8ecf1;--ink2:#b9c2cd;--muted:#8a95a3;--line:#2a323d;--accent:#6fb1f2;--accent-soft:#1d2d40;--mark:#6b5a12;--time:#6fb1f2}}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--ink);font:17px/1.85 "Segoe UI",Tahoma,"Noto Naskh Arabic","Noto Sans Arabic",Arial,sans-serif;-webkit-text-size-adjust:100%}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
.wrap{max-width:860px;margin:0 auto;padding:0 18px}
.topbar{position:sticky;top:0;z-index:5;background:var(--card);border-bottom:1px solid var(--line)}
.topbar-in{display:flex;align-items:center;gap:14px;min-height:58px;flex-wrap:wrap;padding-block:8px}
.brand{font-weight:700;color:var(--ink);font-size:17px;flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.search{display:flex;gap:6px;flex:1 1 300px;max-width:420px}
.search input{flex:1;min-width:0;font:inherit;font-size:15px;padding:7px 12px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink)}
.search input:focus{outline:2px solid var(--accent);outline-offset:-1px}
.search button,.toggle-tr{font:inherit;font-size:14px;padding:6px 14px;border-radius:8px;border:1px solid var(--accent);background:var(--accent);color:#fff;cursor:pointer}
.toggle-tr{background:transparent;color:var(--accent)}
.toggle-tr[aria-pressed=true]{background:var(--accent-soft)}
h1{font-size:30px;line-height:1.4;margin:26px 0 4px}
h2{font-size:20px;margin:0 0 10px}
h3{font-size:17px;margin:16px 0 6px}
.meta,.crumb,.muted{color:var(--muted);font-size:15px}
.crumb{margin:18px 0 0}.meta{margin:0 0 14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px 22px;margin:18px 0}
.summary p{margin:0 0 8px}.summary ul{margin:0;padding-inline-start:22px}
.chapters ol{list-style:none;margin:0;padding:0;columns:2;column-gap:28px}
.chapters li{break-inside:avoid}
.chapters a{display:flex;gap:10px;padding:3px 0;color:var(--ink)}
.time{font:600 13px/1.9 ui-monospace,Consolas,monospace;color:var(--time);direction:ltr;unicode-bidi:isolate;white-space:nowrap}
.downloads{display:flex;flex-wrap:wrap;gap:8px;align-items:center;font-size:14px}
.chip{border:1px solid var(--line);border-radius:999px;padding:2px 12px;background:var(--card)}
.transcript-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:30px}
.transcript{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:10px 22px 16px}
.chapter{color:var(--accent);border-bottom:1px solid var(--line);padding-bottom:4px;margin-top:26px;scroll-margin-top:80px}
.para{display:grid;grid-template-columns:auto 1fr;column-gap:14px;padding:6px 0;scroll-margin-top:80px}
.para .time{grid-row:span 2;padding-top:4px;opacity:.75}
.para:hover .time{opacity:1}
.para p{margin:0}
.para .tr{display:none;color:var(--ink2);font-style:italic;margin-top:4px;grid-column:2}
body.show-tr .para .tr{display:block}
.para:target,.para.hit{background:var(--accent-soft);border-radius:8px;margin-inline:-10px;padding-inline:10px}
mark{background:var(--mark);color:inherit;border-radius:3px;padding:0 1px}
.pager{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:26px 0 40px}
.pager a{display:flex;flex-direction:column;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 16px;color:var(--ink)}
.pager a:hover{border-color:var(--accent);text-decoration:none}
.pager small{color:var(--muted)}
.pager .next{text-align:end}
.lesson-list{list-style:none;margin:0;padding:0;display:grid;gap:10px}
.lesson-list a{display:flex;gap:14px;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 18px;color:var(--ink)}
.lesson-list a:hover{border-color:var(--accent);text-decoration:none}
.num{flex:0 0 34px;height:34px;border-radius:50%;background:var(--accent-soft);color:var(--accent);display:grid;place-items:center;font-weight:700;font-size:15px}
.body{display:flex;flex-direction:column;min-width:0}
.title{font-weight:600}
.excerpt{color:var(--ink2);font-size:15px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.badges{color:var(--muted);font-size:13px}
.results{margin:10px 0 24px}
.results h2{font-size:17px;color:var(--muted);font-weight:600}
.hit-group{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:10px 18px;margin-bottom:10px}
.hit-group h3{margin:4px 0 6px;font-size:16px}
.hit{display:flex;gap:12px;padding:4px 0;color:var(--ink)}
.hit:hover{text-decoration:none;background:var(--accent-soft);border-radius:6px}
.hit .snip{font-size:15px}
.foot{color:var(--muted);font-size:13px;text-align:center;margin:30px 0}
@media (max-width:640px){body{font-size:16px}h1{font-size:24px}.chapters ol{columns:1}.pager{grid-template-columns:1fr}.transcript,.card{padding-inline:14px}.para{grid-template-columns:1fr}.para .time{grid-row:auto;padding:0}.para .tr{grid-column:1}}
@media print{.topbar,.pager,.toggle-tr,.downloads{display:none}body{background:#fff}.card,.transcript{border:0;padding:0}.para .tr{display:block}}
"""

SCRIPT = r"""(function () {
  "use strict";
  function norm(s) {
    return (s || "").toLowerCase()
      .replace(/[ً-ْٰـ]/g, "")
      .replace(/[إأآ]/g, "ا")
      .replace(/ى/g, "ي")
      .replace(/ة/g, "ه");
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function terms(q) {
    return norm(q).split(/\s+/).filter(function (t) { return t.length > 0; });
  }
  // Highlight terms inside text; matching runs on normalized letters so "اول" finds "أوّل".
  function highlight(text, ts) {
    if (!ts.length) return esc(text);
    var map = [], flat = "";
    for (var i = 0; i < text.length; i++) {
      var n = norm(text[i]);
      for (var k = 0; k < n.length; k++) { flat += n[k]; map.push(i); }
    }
    var marks = new Array(text.length).fill(false);
    ts.forEach(function (t) {
      var from = 0, at;
      while ((at = flat.indexOf(t, from)) !== -1) {
        for (var j = at; j < at + t.length; j++) marks[map[j]] = true;
        from = at + t.length;
      }
    });
    var out = "", open = false;
    for (var p = 0; p < text.length; p++) {
      if (marks[p] && !open) { out += "<mark>"; open = true; }
      if (!marks[p] && open) { out += "</mark>"; open = false; }
      out += esc(text[p]);
    }
    return out + (open ? "</mark>" : "");
  }
  function snippet(text, ts, size) {
    if (text.length <= size) return text;
    var n = norm(text), first = n.length;
    ts.forEach(function (t) { var i = n.indexOf(t); if (i !== -1 && i < first) first = i; });
    if (first === n.length) first = 0;
    var start = Math.max(0, first - Math.floor(size / 3));
    var cut = text.slice(start, start + size);
    return (start > 0 ? "… " : "") + cut + (start + size < text.length ? " …" : "");
  }
  var params = new URLSearchParams(location.search);
  var q = params.get("q") || "";
  document.querySelectorAll('.search input[name="q"]').forEach(function (el) { el.value = q; });

  // ---- Course search (index page) ----
  var box = document.getElementById("results");
  if (box && window.SITE_INDEX) {
    var run = function (query) {
      var ts = terms(query);
      if (!ts.length) { box.hidden = true; document.getElementById("lessons").hidden = false; return; }
      var idx = window.SITE_INDEX, L = idx.labels, LIMIT = 200, hits = [];
      for (var i = 0; i < idx.items.length && hits.length <= LIMIT; i++) {
        var it = idx.items[i], hay = norm(it[2] + " " + it[3]);
        if (ts.every(function (t) { return hay.indexOf(t) !== -1; })) hits.push(it);
      }
      var more = hits.length > LIMIT;
      if (more) hits = hits.slice(0, LIMIT);
      var html = "<h2>" + esc((more ? L.results_more : L.results).replace("{n}", hits.length)) + "</h2>";
      if (!hits.length) html = "<h2>" + esc(L.no_results) + "</h2>";
      var groups = {};
      hits.forEach(function (h) { (groups[h[0]] = groups[h[0]] || []).push(h); });
      Object.keys(groups).sort(function (a, b) { return a - b; }).forEach(function (li) {
        var lesson = idx.lessons[li];
        html += '<div class="hit-group"><h3><a href="' + lesson.href + "?q=" + encodeURIComponent(query) + '" dir="auto">' +
          esc(L.lesson + " " + lesson.n + " — " + lesson.title) + "</a></h3>";
        groups[li].forEach(function (h) {
          var text = norm(h[2]).indexOf(ts[0]) === -1 && h[3] ? h[3] : h[2];
          html += '<a class="hit" href="' + lesson.href + "?q=" + encodeURIComponent(query) + "#t-" + h[1] + '"><span class="time">' +
            esc(h[4]) + '</span><span class="snip" dir="auto">' + (h[5] ? "<strong>" : "") +
            highlight(snippet(text, ts, 220), ts) + (h[5] ? "</strong>" : "") + "</span></a>";
        });
        html += "</div>";
      });
      box.innerHTML = html;
      box.hidden = false;
      document.getElementById("lessons").hidden = true;
    };
    run(q);
    var input = document.querySelector('.search input[name="q"]');
    var timer;
    input.addEventListener("input", function () {
      clearTimeout(timer);
      timer = setTimeout(function () {
        var v = input.value;
        history.replaceState(null, "", v ? "?q=" + encodeURIComponent(v) : location.pathname);
        run(v);
      }, 200);
    });
    document.querySelector(".search").addEventListener("submit", function (e) { e.preventDefault(); run(input.value); });
  }

  // ---- Lesson page: translation toggle and search highlights ----
  var toggle = document.querySelector(".toggle-tr");
  if (toggle) {
    var key = "show-translation";
    var set = function (on) {
      document.body.classList.toggle("show-tr", on);
      toggle.setAttribute("aria-pressed", on ? "true" : "false");
      toggle.textContent = on ? toggle.dataset.hide : toggle.dataset.show;
      try { localStorage.setItem(key, on ? "1" : "0"); } catch (e) {}
    };
    var saved = "0";
    try { saved = localStorage.getItem(key) || "0"; } catch (e) {}
    set(saved === "1");
    toggle.addEventListener("click", function () { set(!document.body.classList.contains("show-tr")); });
  }
  if (q && document.querySelector(".transcript")) {
    var ts = terms(q), firstHit = null;
    document.querySelectorAll(".para p, .chapter").forEach(function (el) {
      var hay = norm(el.textContent);
      if (ts.every(function (t) { return hay.indexOf(t) !== -1; }) || ts.some(function (t) { return hay.indexOf(t) !== -1; })) {
        el.innerHTML = highlight(el.textContent, ts);
        var para = el.closest(".para");
        if (para && ts.every(function (t) { return hay.indexOf(t) !== -1; })) {
          para.classList.add("hit");
          if (el.classList.contains("tr")) document.body.classList.add("show-tr");
          if (!firstHit) firstHit = para;
        }
      }
    });
    if (firstHit && !location.hash) firstHit.scrollIntoView({ block: "center" });
  }
})();
"""


def write_site(dest: Path, course: str, lessons: list[SiteLesson], lang: str) -> Path:
    """Write the website into ``dest`` and return the path of its ``index.html``."""
    if not lessons:
        raise AppError(ErrorCode.INVALID_REQUEST, "No lessons")
    try:
        (dest / "assets").mkdir(parents=True, exist_ok=True)
        (dest / "assets" / "style.css").write_text(STYLE, encoding="utf-8")
        (dest / "assets" / "site.js").write_text(SCRIPT, encoding="utf-8")
        (dest / "assets" / "search-index.js").write_text(search_index(course, lessons, lang), encoding="utf-8")
        for i, lesson in enumerate(lessons):
            prev = lessons[i - 1] if i > 0 else None
            nxt = lessons[i + 1] if i + 1 < len(lessons) else None
            (dest / lesson.href).write_text(lesson_page(course, lesson, prev, nxt, lang), encoding="utf-8")
        index = dest / "index.html"
        index.write_text(index_page(course, lessons, lang), encoding="utf-8")
    except OSError as exc:
        raise AppError(ErrorCode.EXPORT_FAILED, f"{dest}: {exc}") from exc
    return index
