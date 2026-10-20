#!/usr/bin/env python3
"""Remove obsolete one-shot apply/patch/restore workflows."""
from pathlib import Path

REMOVE = [
    "apply-exp-rich-state.yml",
    "apply-quest-media.yml",
    "apply-quests-enrich.yml",
    "apply-sampling-patch.yml",
    "apply-user-rollouts-v10.yml",
    "join-quests-enriched.yml",
    "patch-dismissible.yml",
    "patch-quest-logo.yml",
    "patch-ur-embeds.yml",
    "restore-quests-js.yml",
    "restore-ur-v10.yml",
    "p0-fix-libs.yml",
]
root = Path(".github/workflows")
removed = []
for name in REMOVE:
    path = root / name
    if path.exists():
        path.unlink()
        removed.append(name)
print("removed", removed)
