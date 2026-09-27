#!/usr/bin/env python3
"""Publish the current local HEAD tree to a remote branch via the GitHub API.

Computes the difference between the remote branch's tree and the local HEAD tree
(added/modified/deleted files) and applies it on top of the remote tree, so it
does not depend on local/remote ancestry matching. Binary files are uploaded as
base64 blobs.

Usage: publish.py <owner/repo> <branch> <commit-message-file?>
"""
from __future__ import annotations

import base64
import json
import subprocess
import sys
import urllib.request
import os

REPO, BRANCH = sys.argv[1], sys.argv[2]


def gh_api(path: str, method: str = "GET", body: dict | None = None) -> dict:
    url = f"https://api.github.com/{path}"
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(url, data=data, method=method)
    token = subprocess.check_output(["gh", "auth", "token"], text=True).strip()
    request.add_header("Authorization", f"Bearer {token}")
    request.add_header("Accept", "application/vnd.github+json")
    request.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(request) as response:
        return json.load(response)


def local_tree() -> dict[str, tuple[str, bytes]]:
    out = subprocess.check_output(["git", "ls-tree", "-r", "HEAD"], text=True)
    result = {}
    for line in out.splitlines():
        meta, path = line.split("\t", 1)
        mode, kind, sha = meta.split()
        if kind != "blob":
            continue
        content = subprocess.check_output(["git", "cat-file", "blob", sha])
        result[path] = (mode, content)
    return result


def main() -> int:
    ref = gh_api(f"repos/{REPO}/git/ref/heads/{BRANCH}")
    base_commit = ref["object"]["sha"]
    base_tree = gh_api(f"repos/{REPO}/git/commits/{base_commit}")["tree"]["sha"]
    remote = gh_api(f"repos/{REPO}/git/trees/{base_tree}?recursive=1")
    remote_files = {item["path"]: (item["sha"], item.get("mode", "100644")) for item in remote["tree"] if item["type"] == "blob"}

    local = local_tree()
    entries = []
    for path, (mode, content) in local.items():
        local_sha = subprocess.check_output(["git", "rev-parse", f"HEAD:{path}"], text=True).strip()
        remote_sha, remote_mode = remote_files.get(path, (None, None))
        if remote_sha == local_sha and remote_mode == mode:
            continue
        if remote_sha == local_sha and remote_mode != mode:
            # Mode-only correction (e.g. restoring an executable bit).
            entries.append({"path": path, "mode": mode, "type": "blob", "sha": local_sha})
            continue
        try:
            text = content.decode("utf-8")
            if "\x00" in text:
                raise UnicodeDecodeError("utf-8", content, 0, 1, "nul")
            entries.append({"path": path, "mode": mode, "type": "blob", "content": text})
        except UnicodeDecodeError:
            blob = gh_api(f"repos/{REPO}/git/blobs", "POST", {
                "content": base64.b64encode(content).decode("ascii"), "encoding": "base64",
            })
            entries.append({"path": path, "mode": mode, "type": "blob", "sha": blob["sha"]})
    for path in remote_files:
        if path not in local:
            entries.append({"path": path, "mode": "100644", "type": "blob", "sha": None})

    message = subprocess.check_output(["git", "log", "-1", "--format=%B"], text=True)
    new_tree = gh_api(f"repos/{REPO}/git/trees", "POST", {"base_tree": base_tree, "tree": entries})["sha"]
    commit = gh_api(f"repos/{REPO}/git/commits", "POST", {
        "message": message, "tree": new_tree, "parents": [base_commit],
    })
    gh_api(f"repos/{REPO}/git/refs/heads/{BRANCH}", "PATCH", {"sha": commit["sha"]})
    print(json.dumps({"base": base_commit, "changed": len(entries), "commit": commit["sha"]}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
