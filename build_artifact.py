"""Inline website/index.html + scripts into one self-contained page (website/dist/)."""
import re
from pathlib import Path

D = Path(__file__).resolve().parent / "website"
html = (D / "index.html").read_text(encoding="utf-8")


def inline(m):
    src = m.group(1)
    js = (D / src).read_text(encoding="utf-8").replace("</script", "<\\/script")
    return f"<script>\n{js}\n</script>"


html = re.sub(r'<script src="([^"]+)"></script>', inline, html)
# the artifact host adds its own document skeleton
body = re.sub(r"<!doctype html>\s*|<html[^>]*>\s*|</html>\s*|<head>\s*|</head>\s*|<body>\s*|</body>\s*", "", html, flags=re.I)
body = re.sub(r'<meta charset="utf-8">\s*|<meta name="viewport"[^>]*>\s*', "", body)
out = D / "dist"
out.mkdir(exist_ok=True)
(out / "branchease.html").write_text(body, encoding="utf-8")
print("wrote", out / "branchease.html", f"{len(body) / 1024:.0f} KB")
