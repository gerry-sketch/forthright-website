#!/usr/bin/env python3
"""
strip-dashes.py

Removes em dashes, en dashes, and their HTML entities from the Forthright site,
replacing each with something readable for its context instead of doing one
blind find/replace.

Usage:
    python3 tools/strip-dashes.py            # dry run, prints every proposed change
    python3 tools/strip-dashes.py --apply    # writes the changes
    python3 tools/strip-dashes.py --check    # exit 1 if any dash remains (for CI)

Run from the repo root.
"""

import argparse
import os
import re
import sys

# ---------------------------------------------------------------- config

# Review attributions: <span class="review-bar-name">&mdash; Austin Smith</span>
# Set to "- " to keep a visible separator, or "" to drop the dash entirely.
ATTRIBUTION_PREFIX = "- "

# Footer: "Forthright Construction LLC &mdash; Hinesburg, Vermont"
FOOTER_SEPARATOR = ", "

# Prose em dash used as punctuation: "into the trades — which means"
PROSE_REPLACEMENT = ", "

# Numeric / tier ranges: "40–60 psf", "$8,000–$18,000", "$$–$$$"
RANGE_REPLACEMENT = "-"

# Spaced ranges inside strings: "$12,000 – $18,000"
SPACED_RANGE_REPLACEMENT = " to "

# work-with-us.html form <option> values ("Roofing – Shingle", "2–5 years").
# These strings are submitted with the form, so changing them changes what
# lands downstream. Leave True only after confirming nothing keys on the
# exact value.
FIX_FORM_VALUES = True

# styles.css uses content: '—' as a decorative list bullet. Changing it is a
# design change, not a copy change, so it is off by default.
FIX_CSS_BULLET = False

# Exact strings that need a specific replacement rather than a generic rule.
# Applied first, before anything else.
LITERAL_OVERRIDES = {
    "Roofing \u2013 Shingle": "Roofing - Shingle",
    "Roofing \u2013 Standing Seam": "Roofing - Standing Seam",
    "Roofing \u2013 EPDM Rubber": "Roofing - EPDM Rubber",
    "Framing \u2013 Wood": "Framing - Wood",
    "Framing \u2013 Metal": "Framing - Metal",
}

INCLUDE_EXT = (".html", ".js", ".css")
SKIP_DIRS = {".git", "node_modules", "_archive", "_restore", "images"}

# ---------------------------------------------------------------- patterns

ENTITY_MAP = {
    "&mdash;": "\u2014",
    "&#8212;": "\u2014",
    "&#x2014;": "\u2014",
    "&ndash;": "\u2013",
    "&#8211;": "\u2013",
    "&#x2013;": "\u2013",
}

DASH = "[\u2014\u2013]"
ANY_DASH = re.compile(r"[\u2014\u2013]|&mdash;|&ndash;|&#8212;|&#8211;|&#x2014;|&#x2013;")

CSS_BULLET = re.compile(r"content:\s*'\u2014'")
CSS_BULLET_TOKEN = "@@CSSBULLET@@"


def normalize_entities(text):
    for entity, char in ENTITY_MAP.items():
        text = text.replace(entity, char)
    return text


def transform(path, text):
    """Return the rewritten text for one file."""
    text = normalize_entities(text)

    if not FIX_CSS_BULLET:
        text = CSS_BULLET.sub(CSS_BULLET_TOKEN, text)

    # 0. Exact-string overrides (form option values, labels).
    for old, new in LITERAL_OVERRIDES.items():
        text = text.replace(old, new)

    # 1. Review attribution spans.
    text = re.sub(
        r'(class="review-bar-name">)[ \t]*' + DASH + r"[ \t]*",
        lambda m: m.group(1) + ATTRIBUTION_PREFIX,
        text,
    )

    # 2. Footer copyright line.
    text = re.sub(r"LLC[ \t]*" + DASH + r"[ \t]*Hinesburg", "LLC" + FOOTER_SEPARATOR + "Hinesburg", text)

    # 3. Spaced ranges inside display strings: "$12,000 – $18,000".
    text = re.sub(r"[ \t]" + DASH + r"[ \t](?=\$|\d|'\+)", SPACED_RANGE_REPLACEMENT, text)

    # 3b. A dash alone inside a quoted string, e.g. sd.lo+'–'+sd.hi
    text = re.sub(r"(['\"])[ \t]*" + DASH + r"[ \t]*\1", lambda mm: mm.group(1) + "-" + mm.group(1), text)

    # 4. Tight numeric or price-tier ranges: 40–60, $8,000–$18,000, $$–$$$.
    text = re.sub(
        r"(?<=[\d\$\)%])" + DASH + r"(?=[\d\$])",
        RANGE_REPLACEMENT,
        text,
    )

    # 5. Anything still spaced on both sides is prose punctuation.
    text = re.sub(r"[ \t]*" + DASH + r"[ \t]+", PROSE_REPLACEMENT, text)

    # 6. Whatever is left (dash hard against markup, e.g. "replacement —<br>").
    text = re.sub(r"[ \t]*" + DASH, ",", text)

    # Tidy the one artifact the rules can create: a dash right after a comma.
    text = re.sub(r",\s*,", ",", text)

    if not FIX_CSS_BULLET:
        text = text.replace(CSS_BULLET_TOKEN, "content: '\u2014'")

    return text


def iter_files(root):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for name in sorted(filenames):
            if name.lower().endswith(INCLUDE_EXT):
                yield os.path.join(dirpath, name)


def changed_lines(before, after):
    out = []
    for i, (a, b) in enumerate(zip(before.split("\n"), after.split("\n")), 1):
        if a != b:
            out.append((i, a.strip(), b.strip()))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="write changes to disk")
    ap.add_argument("--check", action="store_true", help="exit 1 if any dash remains")
    ap.add_argument("--root", default=".", help="repo root (default: current dir)")
    ap.add_argument("--quiet", action="store_true", help="summary only")
    args = ap.parse_args()

    if args.check:
        remaining = []
        for path in iter_files(args.root):
            text = open(path, encoding="utf-8", errors="replace").read()
            if not FIX_CSS_BULLET:
                text = CSS_BULLET.sub("", text)
            hits = ANY_DASH.findall(text)
            if hits:
                remaining.append((path, len(hits)))
        if remaining:
            for path, count in remaining:
                print("STILL HAS DASHES: %s (%d)" % (path, count))
            return 1
        print("clean: no em dashes, en dashes, or entities found")
        return 0

    total_files = 0
    total_changes = 0

    for path in iter_files(args.root):
        original = open(path, encoding="utf-8", errors="replace").read()
        if not ANY_DASH.search(original):
            continue

        updated = transform(path, original)

        if updated.count("\n") != original.count("\n"):
            print("ABORT: line count changed in %s. Not safe to apply." % path)
            return 1

        if path.endswith("work-with-us.html") and not FIX_FORM_VALUES:
            print("SKIPPED (FIX_FORM_VALUES is off): %s" % path)
            continue

        if updated == original:
            continue

        diffs = changed_lines(original, updated)
        total_files += 1
        total_changes += len(diffs)

        if not args.quiet:
            print("\n=== %s (%d lines) ===" % (path, len(diffs)))
            for lineno, a, b in diffs:
                print("  %5d  -  %s" % (lineno, a[:160]))
                print("  %5d  +  %s" % (lineno, b[:160]))

        if args.apply:
            open(path, "w", encoding="utf-8").write(updated)

    verb = "changed" if args.apply else "would change"
    print("\n%s %d lines across %d files" % (verb, total_changes, total_files))
    if not args.apply:
        print("dry run only. re-run with --apply to write.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
