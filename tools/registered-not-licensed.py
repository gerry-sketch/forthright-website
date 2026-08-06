#!/usr/bin/env python3
"""
registered-not-licensed.py

Vermont issues no statewide general contractor license. Residential contractors
doing $10,000 or more of work register with the Secretary of State's Office of
Professional Regulation. This replaces the site's "licensed" self-description
with "registered" everywhere it is a claim about Forthright.

Each rule is an exact string, not a pattern, so nothing is caught by accident.
The script reports how many times each rule fired and aborts if a rule that
should have matched found nothing.

NOT touched by default (see SKIP_FILES): work-with-us.html and partners.html.
Those ask trade partners about their own credential and are tied to form field
names that flow downstream. Different problem, different decision.

Usage:
    python3 tools/registered-not-licensed.py           # dry run
    python3 tools/registered-not-licensed.py --apply   # write changes
    python3 tools/registered-not-licensed.py --check   # report any leftovers

Run from the repo root.
"""

import argparse
import os
import re
import sys

# Ordered longest-first so a broad rule never eats a specific one.
REPLACEMENTS = [
    # Body copy
    ("We're fully licensed and insured for commercial and residential work in Vermont",
     "We're registered and insured for commercial and residential work in Vermont"),
    ("We're a licensed and insured Vermont contractor",
     "We're a registered and insured Vermont contractor"),
    ("straight answers, licensed and insured.",
     "straight answers, registered and insured."),
    ("from a licensed Vermont contractor",
     "from a registered Vermont contractor"),
    # A crew is not registered, the company is. Reworded rather than swapped.
    ("Both installed by our Vermont-licensed crew.",
     "Both installed by our own Vermont crew."),
    # Trust strips and pills
    ("Vermont Licensed &amp; Insured", "Vermont Registered &amp; Insured"),
    ("Vermont licensed &amp; insured", "Vermont registered &amp; insured"),
    # Footers
    ("Licensed &middot; Fully Insured", "Registered &middot; Fully Insured"),
    ("Licensed \u00b7 Fully Insured", "Registered \u00b7 Fully Insured"),
    # Meta descriptions, og and twitter copies included
    ("Licensed and insured.\"", "Registered and insured.\""),
    ("Licensed, insured.", "Registered, insured."),
    ("Licensed.\">", "Registered.\">"),
]

# Rules that must fire at least once. If one goes to zero the page changed
# under us and the run stops rather than half-applying.
REQUIRED = {old for old, _ in REPLACEMENTS}

SKIP_FILES = {"work-with-us.html", "partners.html"}
SKIP_DIRS = {".git", "node_modules", "_archive", "_restore", "images", "tools"}
INCLUDE_EXT = (".html",)

LEFTOVER = re.compile(r"[Ll]icens\w*")


def iter_files(root="."):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for name in sorted(filenames):
            if name.lower().endswith(INCLUDE_EXT) and name not in SKIP_FILES:
                yield os.path.join(dirpath, name)


def snippet(text, start, end, pad=60):
    return re.sub(r"\s+", " ", text[max(0, start - pad):min(len(text), end + pad)]).strip()


def run(apply_changes, quiet):
    fired = {old: 0 for old, _ in REPLACEMENTS}
    touched = {}

    for path in iter_files():
        original = open(path, encoding="utf-8").read()
        updated = original

        for old, new in REPLACEMENTS:
            count = updated.count(old)
            if count:
                fired[old] += count
                updated = updated.replace(old, new)

        if updated != original:
            if updated.count("\n") != original.count("\n"):
                print("ABORT: line count changed in %s." % path)
                return 1
            touched[path] = sum(original.count(old) for old, _ in REPLACEMENTS)
            if apply_changes:
                open(path, "w", encoding="utf-8").write(updated)

    missing = [old for old in REQUIRED if fired[old] == 0]
    if missing:
        print("ABORT: these rules matched nothing, so the source has changed:")
        for old in missing:
            print("  %r" % old)
        print("\nRe-read the live files before applying.")
        return 1

    if not quiet:
        print("Rule hits:")
        for old, new in REPLACEMENTS:
            print("  %3d  %s" % (fired[old], old[:70]))
        print("\nFiles changed:")
        for path in sorted(touched):
            print("  %3d  %s" % (touched[path], path))

    total = sum(fired.values())
    verb = "changed" if apply_changes else "would change"
    print("\n%s %d strings across %d files" % (verb, total, len(touched)))
    if not apply_changes:
        print("dry run only. re-run with --apply to write.")
    return 0


def check():
    leftovers = 0
    for path in iter_files():
        text = open(path, encoding="utf-8").read()
        for m in LEFTOVER.finditer(text):
            line = text[:m.start()].count("\n") + 1
            print("%s:%d  %s" % (path, line, snippet(text, m.start(), m.end())))
            leftovers += 1
    if leftovers:
        print("\n%d licence references still present in scanned files." % leftovers)
        return 1
    print("clean: no licence references outside %s" % ", ".join(sorted(SKIP_FILES)))
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="write changes")
    ap.add_argument("--check", action="store_true", help="report leftovers")
    ap.add_argument("--quiet", action="store_true", help="summary only")
    args = ap.parse_args()
    if args.check:
        return check()
    return run(args.apply, args.quiet)


if __name__ == "__main__":
    sys.exit(main())
