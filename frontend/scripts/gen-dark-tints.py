import re, glob, colorsys
files = [f for f in glob.glob('src/**/*.ts*', recursive=True)
         if not re.search(r'Document\.tsx$|engagement/templates\.ts$|workstation/print\.ts$|/data/mock/', f)]
cls = set(); sty = set()
for f in files:
    s = open(f).read()
    for m in re.finditer(r'\b((?:hover:|group-hover:)?(bg|text|ring|border))-\[#([0-9a-fA-F]{6})\]', s):
        cls.add((m.group(1), m.group(3)))
    for m in re.finditer(r"\b(background|bg|tint|color|fg|borderColor)\s*:\s*'(#[0-9a-fA-F]{6})'", s):
        k = {'bg': 'background', 'tint': 'background', 'fg': 'color'}.get(m.group(1), m.group(1))
        sty.add((k, m.group(2)[1:]))

def parts(h): return [int(h[i:i+2], 16) for i in (0, 2, 4)]
def hls(h): return colorsys.rgb_to_hls(*[x / 255 for x in parts(h)])
def grey(h):
    p = parts(h); H = hls(h)[0] * 360
    # Cool slate greys (hue 200-235) are neutrals in this palette — there is no blue brand any more.
    return (max(p) - min(p)) < 6 or 200 <= H <= 235
def tone(h, l, cap=0.62):
    H, L, S = hls(h); r, g, b = colorsys.hls_to_rgb(H, l, min(cap, max(S, 0.5)))
    return f"{round(r*255)} {round(g*255)} {round(b*255)}"
def dbg(h, a): return f"rgb(255 255 255 / {a*0.4:.2f})" if grey(h) else f"rgb({tone(h, 0.55)} / {a:.2f})"
def dfg(h): return "rgb(var(--c-inkMuted))" if grey(h) else f"rgb({tone(h, 0.70)})"
def esc(p, h): return "." + p.replace(':', '\\:') + "-\\[\\#" + h + "\\]"

R = []
for p, h in sorted(cls):
    base = p.split(':')[-1]; L = hls(h)[1]
    if p.startswith('hover:'): sel = [esc(p, h) + ':hover']
    elif p.startswith('group-hover:'): sel = ['.group:hover ' + esc(p, h)]
    else: sel = [esc(p, h) + ':not(.qdoc-page *):not(.qdoc-stack *)']
    if base == 'bg' and L > 0.86: R.append((sel, f"background-color: {dbg(h, 0.14)};"))
    elif base == 'ring' and L > 0.75: R.append((sel, f"--tw-ring-color: {dbg(h, 0.28)};"))
    elif base == 'border' and L > 0.75: R.append((sel, f"border-color: {dbg(h, 0.28)};"))
    elif base == 'text' and L < 0.45:
        # Text on the always-dark hero keeps its own colour (it sits on a white chip there).
        R.append(([x + ':not(.dash-hero *)' for x in sel], f"color: {dfg(h)};"))
for prop, h in sorted(sty):
    L = hls(h)[1]; r, g, b = parts(h); c = f"rgb({r}, {g}, {b})"
    if prop == 'background' and L > 0.86:
        R.append(([f"[style*='background: {c}']:not(.qdoc-page *):not(.qdoc-stack *)", f"[style*='background-color: {c}']:not(.qdoc-page *):not(.qdoc-stack *)"], f"background: {dbg(h, 0.14)} !important;"))
    elif prop == 'color' and L < 0.45:
        R.append(([f"[style^='color: {c}']:not(.qdoc-page *):not(.qdoc-stack *)", f"[style*=' color: {c}']:not(.qdoc-page *):not(.qdoc-stack *)"], f"color: {dfg(h)} !important;"))
    elif prop == 'borderColor' and L > 0.75:
        R.append(([f"[style*='border-color: {c}']:not(.qdoc-page *):not(.qdoc-stack *)"], f"border-color: {dbg(h, 0.28)} !important;"))

hdr = """/* ── Dark theme: pastel tints ───────────────────────────────────────────
   Generated from the arbitrary-value colours the components use (badges,
   icon tiles, status pills). In dark mode a light pastel fill becomes a
   translucent wash of the same hue, a slate-grey fill a faint white wash,
   and a deep text colour lifts to a readable tint of its hue. Print
   documents (.qdoc-page) are excluded. Regenerate with: python3 scripts/gen-dark-tints.py (from frontend/). */
"""
body = "\n".join(",\n".join(":root[data-theme='dark'] " + x for x in sel) + " { " + decl + " }" for sel, decl in R)
open('src/design/dark-tints.css', 'w').write(hdr + body + "\n")
print(len(R), 'rules')
