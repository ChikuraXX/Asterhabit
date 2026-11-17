from __future__ import annotations
import hashlib
import json
import os
import sys
from pathlib import Path

from graphify.build import build_merge
from graphify.cluster import cluster
from graphify.export import to_json

KINDS = {"interest", "preference", "opinion", "question"}
STATUSES = {"tentative", "established", "retired", "open", "resolved", "dismissed"}


def _write_lease(path: Path, value: dict) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
    os.replace(temporary, path)


def main() -> int:
    if len(sys.argv) != 4:
        return 2
    input_path, output_path, lease_path = map(Path, sys.argv[1:])
    lease = json.loads(lease_path.read_text(encoding="utf-8"))
    lease["phase"] = "running"
    lease["workerPid"] = os.getpid()
    _write_lease(lease_path, lease)

    payload = json.loads(input_path.read_text(encoding="utf-8"))
    fingerprint = payload.pop("fingerprint", None)
    canonical = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if not isinstance(fingerprint, str) or hashlib.sha256(canonical).hexdigest() != fingerprint:
        raise ValueError("invalid projection fingerprint")
    scope = payload["scopeId"]
    revision = payload["revision"]
    valid = set(payload["validSourceIds"])
    accepted = []
    for row in payload["states"]:
        if row["kind"] not in KINDS or row["status"] not in STATUSES:
            raise ValueError("invalid character state")
        if row["status"] in {"retired", "dismissed"}:
            continue
        sources = list(dict.fromkeys(row["sourceIds"]))
        dependencies = list(dict.fromkeys(row.get("dependencySourceIds") or sources))
        if not sources or not dependencies or any(source_id not in valid for source_id in dependencies):
            continue
        accepted.append({**row, "sourceIds": sources, "dependencySourceIds": dependencies})

    source_file = f"character-state-v1/{scope}.json"
    source_ids = sorted({source_id for row in accepted for source_id in row["dependencySourceIds"]})
    nodes = []
    for row in accepted:
        nodes.append({
            "id": "character:" + row["id"],
            "label": row["topic"],
            "type": "character_state",
            "description": row["statement"],
            "source_file": source_file,
            "source_location": "state:" + row["id"],
            "confidence": "AMBIGUOUS",
            "_origin": "semantic",
            "character_kind": row["kind"],
            "topic": row["topic"],
            "statement": row["statement"],
            "brief_reason": row["briefReason"],
            "character_status": row["status"],
            "state_revision": row["revision"],
            "source_ids": row["sourceIds"],
            "dependency_source_ids": row["dependencySourceIds"],
            "created_at": row["createdAt"],
            "updated_at": row["updatedAt"],
        })
    for source_id in source_ids:
        nodes.append({
            "id": "source:" + source_id,
            "label": "Authorized growth source",
            "type": "growth_source",
            "description": "Authorized local source reference",
            "source_file": source_file,
            "source_location": "source:" + source_id,
            "confidence": "EXTRACTED",
            "_origin": "semantic",
        })
    edges = [{
        "source": "character:" + row["id"],
        "target": "source:" + source_id,
        "relation": "derived_from",
        "confidence": "EXTRACTED",
        "source_file": source_file,
        "_origin": "semantic",
    } for row in accepted for source_id in row["dependencySourceIds"]]

    graph = build_merge([{"nodes": nodes, "edges": edges, "hyperedges": []}], directed=True, dedup=False)
    graph.graph.update({
        "contract": "character-state-v1",
        "scope_id": scope,
        "revision": revision,
        "input_fingerprint": fingerprint,
    })
    if not to_json(graph, cluster(graph), str(output_path), force=True):
        raise RuntimeError("graph export refused")

    lease.pop("workerPid", None)
    lease["phase"] = "artifact"
    _write_lease(lease_path, lease)
    print(json.dumps({"ok": True, "nodes": len(nodes), "edges": len(edges)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
