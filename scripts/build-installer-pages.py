#!/usr/bin/env python3
"""Builds self-contained installer pages into <build>/resources.

productbuild only copies the files the distribution names, so the stylesheet has
to be inlined into each page. Usage: build-installer-pages.py <build-dir>
"""
import os
import shutil
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
SRC = os.path.join(ROOT, "installer", "resources")
OUT = os.path.join(sys.argv[1], "resources")

os.makedirs(OUT, exist_ok=True)
css = open(os.path.join(SRC, "installer.css")).read()

for page in ("welcome.html", "conclusion.html"):
    html = open(os.path.join(SRC, page)).read()
    html = html.replace('<link rel="stylesheet" href="installer.css">', "<style>\n%s</style>" % css)
    open(os.path.join(OUT, page), "w").write(html)

for art in ("background.png", "background-dark.png"):
    shutil.copy2(os.path.join(SRC, art), os.path.join(OUT, art))

print("installer pages -> %s" % os.path.relpath(OUT, ROOT))
