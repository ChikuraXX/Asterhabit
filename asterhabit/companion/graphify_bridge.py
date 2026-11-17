"""Letta 私有记忆图与 Graphify 之间的受限进程桥。"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import sys
import tempfile

from graphify.build import build_merge
from graphify.export import to_json


INDEX_VERSION = 1
VALID_CLASSIFICATIONS = {"EXTRACTED", "INFERRED", "AMBIGUOUS"}
VALID_ORIGINS = {"user", "external"}
FORBIDDEN_ENV_MARKERS = ("API_KEY", "TOKEN", "PROXY", "NODE_OPTIONS", "PYTHONPATH")


def _fail() -> None:
    """返回不含输入正文、路径或底层异常的统一失败结果。"""
    sys.stdout.write('{"ok":false,"error":"bridge_failed"}')
    raise SystemExit(1)


def _validate_environment() -> None:
    """确认受限 worker 没有继承模型、社交、代理或注入环境。"""
    upper_names = {name.upper() for name in os.environ}
    if any(marker in name for name in upper_names for marker in FORBIDDEN_ENV_MARKERS):
        raise ValueError("unsafe worker environment")


def _scope(value: object) -> str:
    """校验并规范化不参与路径拼接之外含义的 scope 标识。"""
    if not isinstance(value, str) or len(value) != 64:
        raise ValueError("invalid scope")
    if any(char not in "0123456789abcdefABCDEF" for char in value):
        raise ValueError("invalid scope")
    return value.lower()


def _revision(value: object) -> int:
    """校验允许从零开始的单调宿主修订号。"""
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError("invalid revision")
    return value


def _token(value: object) -> str:
    """校验由宿主生成、仅用于暂存文件名的随机令牌。"""
    if not isinstance(value, str) or len(value) != 32:
        raise ValueError("invalid token")
    if any(char not in "0123456789abcdef" for char in value):
        raise ValueError("invalid token")
    return value


def _directory(value: object) -> Path:
    """校验绝对私人目录并解析为不依赖记录内容的路径。"""
    if not isinstance(value, str):
        raise ValueError("invalid directory")
    directory = Path(value)
    if not directory.is_absolute():
        raise ValueError("invalid directory")
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    return directory.resolve()


def _valid_source_id(value: object) -> bool:
    """判断来源标识能否安全作为 Graphify 的证据键而非文件路径。"""
    if not isinstance(value, str) or not value or "\x00" in value or "\\" in value:
        return False
    if value.startswith("/") or (len(value) >= 2 and value[0].isalpha() and value[1] == ":"):
        return False
    parts = PurePosixPath(value).parts
    return bool(parts) and all(part not in {"", ".", ".."} for part in parts)


def _record_hash(record: dict) -> str:
    """按跨语言固定字段顺序计算记录内容指纹。"""
    values = [
        record["id"],
        record["sourceId"],
        record["subjectKey"],
        record["topic"],
        record["text"],
        record["classification"],
        record["origin"],
    ]
    encoded = json.dumps(values, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _records(value: object) -> list[dict]:
    """严格校验宿主记录合同并拒绝重复记录标识。"""
    if not isinstance(value, list):
        raise ValueError("invalid records")
    normalized: list[dict] = []
    seen_ids: set[str] = set()
    for item in value:
        if not isinstance(item, dict):
            raise ValueError("invalid record")
        required_strings = ("id", "sourceId", "subjectKey", "topic", "text")
        if any(not isinstance(item.get(field), str) for field in required_strings):
            raise ValueError("invalid record")
        if not item["id"] or not _valid_source_id(item["sourceId"]):
            raise ValueError("invalid record")
        if item.get("classification") not in VALID_CLASSIFICATIONS:
            raise ValueError("invalid record")
        if item.get("origin") not in VALID_ORIGINS:
            raise ValueError("invalid record")
        if item["id"] in seen_ids:
            raise ValueError("duplicate record")
        seen_ids.add(item["id"])
        normalized.append({
            "id": item["id"],
            "sourceId": item["sourceId"],
            "subjectKey": item["subjectKey"],
            "topic": item["topic"],
            "text": item["text"],
            "classification": item["classification"],
            "origin": item["origin"],
        })
    return normalized


def _paths(directory: Path, scope_id: str, revision: int | None = None, token: str | None = None) -> dict[str, Path]:
    """只从已校验 scope、修订号和随机令牌派生索引路径。"""
    paths = {
        "graph": directory / f"{scope_id}.graph.json",
        "fingerprints": directory / f"{scope_id}.fingerprints.json",
    }
    if revision is not None and token is not None:
        staging = directory / ".staging"
        staging.mkdir(parents=True, exist_ok=True, mode=0o700)
        stem = f"{scope_id}.{revision}.{token}"
        paths["staged_graph"] = staging / f"{stem}.graph.json"
        paths["staged_fingerprints"] = staging / f"{stem}.fingerprints.json"
    return paths


def _atomic_json(path: Path, value: dict) -> None:
    """在同目录写入并原子替换 JSON 文件。"""
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    handle, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(handle, "w", encoding="utf-8", newline="\n") as stream:
            json.dump(value, stream, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary_name, path)
    except Exception:
        try:
            os.unlink(temporary_name)
        except OSError:
            pass
        raise


def _fingerprints(records: list[dict], revision: int) -> dict:
    """生成只含记录标识、来源标识与哈希的无正文 sidecar。"""
    return {
        "version": INDEX_VERSION,
        "revision": revision,
        "records": {
            record["id"]: {
                "sourceId": record["sourceId"],
                "hash": _record_hash(record),
            }
            for record in records
        },
    }


def _read_incremental_base(graph_path: Path, fingerprint_path: Path) -> tuple[dict, dict] | None:
    """读取修订一致的正式图和 sidecar；损坏或错配时要求全量安全重建。"""
    if not graph_path.is_file() or not fingerprint_path.is_file():
        return None
    try:
        graph = json.loads(graph_path.read_text(encoding="utf-8"))
        fingerprints = json.loads(fingerprint_path.read_text(encoding="utf-8"))
        metadata = graph.get("graph", {}).get("letta_index", {})
        if not isinstance(graph.get("nodes"), list) or not isinstance(graph.get("links"), list):
            return None
        if fingerprints.get("version") != INDEX_VERSION:
            return None
        if metadata.get("version") != INDEX_VERSION:
            return None
        if metadata.get("revision") != fingerprints.get("revision"):
            return None
        if not isinstance(fingerprints.get("records"), dict):
            return None
        return graph, fingerprints
    except (OSError, UnicodeError, json.JSONDecodeError, AttributeError):
        return None


def _node_id(prefix: str, record: dict, discriminator: str) -> str:
    """为每条证据实例生成不含正文的稳定独立节点标识。"""
    raw = json.dumps(
        [record["sourceId"], record["id"], discriminator],
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")
    return f"{prefix}_{hashlib.sha256(raw).hexdigest()}"


def _extraction(records: list[dict]) -> dict:
    """把已校验记录转换为带完整来源证据的有限实体关系。"""
    nodes: list[dict] = []
    edges: list[dict] = []
    for record in records:
        content_hash = _record_hash(record)
        common = {
            "source_file": record["sourceId"],
            "file_type": "concept",
            "classification": record["classification"],
            "origin": record["origin"],
            "record_id": record["id"],
            "content_hash": content_hash,
            "_origin": "semantic",
        }
        memory_id = _node_id("memory", record, "memory")
        subject_id = _node_id("subject", record, "subject")
        topic_id = _node_id("topic", record, "topic")
        nodes.extend([
            {
                "id": memory_id,
                "label": record["text"],
                "kind": "memory",
                "text": record["text"],
                "subject_key": record["subjectKey"],
                "topic": record["topic"],
                **common,
            },
            {
                "id": subject_id,
                "label": record["subjectKey"],
                "kind": "subject",
                "subject_key": record["subjectKey"],
                **common,
            },
            {
                "id": topic_id,
                "label": record["topic"],
                "kind": "topic",
                "topic": record["topic"],
                **common,
            },
        ])
        edge_common = {
            "source_file": record["sourceId"],
            "confidence": record["classification"],
            "classification": record["classification"],
            "origin": record["origin"],
            "record_id": record["id"],
            "content_hash": content_hash,
            "_origin": "semantic",
        }
        edges.extend([
            {"source": subject_id, "target": memory_id, "relation": "HAS_MEMORY", **edge_common},
            {"source": memory_id, "target": topic_id, "relation": "ABOUT_TOPIC", **edge_common},
        ])
    return {"nodes": nodes, "edges": edges, "hyperedges": []}


def _export_graph(graph, graph_path: Path, revision: int) -> int:
    """用 Graphify 真实导出接口写入带适配器修订元数据的图。"""
    graph.graph["letta_index"] = {"version": INDEX_VERSION, "revision": revision}
    if not to_json(graph, {}, str(graph_path), force=True):
        raise RuntimeError("graph export refused")
    return graph.number_of_nodes()


def _build(payload: dict) -> dict:
    """基于正式图副本增量构建暂存图，绝不覆盖正式图。"""
    directory = _directory(payload.get("directory"))
    scope_id = _scope(payload.get("scopeId"))
    revision = _revision(payload.get("revision"))
    token = _token(payload.get("token"))
    records = _records(payload.get("records"))
    paths = _paths(directory, scope_id, revision, token)
    staged_graph = paths["staged_graph"]
    staged_fingerprints = paths["staged_fingerprints"]
    for staged in (staged_graph, staged_fingerprints):
        staged.unlink(missing_ok=True)

    current_fingerprints = _fingerprints(records, revision)
    base = _read_incremental_base(paths["graph"], paths["fingerprints"])
    if base is None:
        graph = build_merge([_extraction(records)], graph_path=staged_graph, directed=False, dedup=False)
    else:
        _, old_fingerprints = base
        shutil.copy2(paths["graph"], staged_graph)
        old_records = old_fingerprints["records"]
        current_records = current_fingerprints["records"]
        changed_sources: set[str] = set()
        for record_id, old in old_records.items():
            current = current_records.get(record_id)
            if current != old and isinstance(old, dict) and isinstance(old.get("sourceId"), str):
                changed_sources.add(old["sourceId"])
        for record_id, current in current_records.items():
            if old_records.get(record_id) != current:
                changed_sources.add(current["sourceId"])
        replacement_records = [record for record in records if record["sourceId"] in changed_sources]
        current_sources = {record["sourceId"] for record in records}
        prune_sources = sorted(source for source in changed_sources if source not in current_sources)
        chunks = [_extraction(replacement_records)] if replacement_records else []
        graph = build_merge(
            chunks,
            graph_path=staged_graph,
            prune_sources=prune_sources or None,
            directed=False,
            dedup=False,
        )
    nodes = _export_graph(graph, staged_graph, revision)
    _atomic_json(staged_fingerprints, current_fingerprints)
    return {"ok": True, "nodes": nodes}


def _safe_graph_revision(graph: dict) -> int | None:
    """从结构完整的正式图读取非负修订号。"""
    if not isinstance(graph, dict) or not isinstance(graph.get("nodes"), list):
        return None
    if not isinstance(graph.get("links"), list):
        return None
    metadata = graph.get("graph", {}).get("letta_index", {})
    revision = metadata.get("revision")
    if metadata.get("version") != INDEX_VERSION:
        return None
    if isinstance(revision, bool) or not isinstance(revision, int) or revision < 0:
        return None
    return revision


def _prune(payload: dict) -> dict:
    """同步删除正式图中的失效来源；坏图直接删除且不留副本。"""
    directory = _directory(payload.get("directory"))
    scope_id = _scope(payload.get("scopeId"))
    valid_value = payload.get("validSourceIds")
    if not isinstance(valid_value, list) or any(not _valid_source_id(value) for value in valid_value):
        raise ValueError("invalid valid sources")
    valid_sources = set(valid_value)
    paths = _paths(directory, scope_id)
    if not paths["graph"].is_file():
        paths["fingerprints"].unlink(missing_ok=True)
        return {"ok": True, "status": "missing"}
    try:
        graph_data = json.loads(paths["graph"].read_text(encoding="utf-8"))
        revision = _safe_graph_revision(graph_data)
        if revision is None:
            raise ValueError("corrupt graph")
    except (OSError, UnicodeError, json.JSONDecodeError, AttributeError, ValueError):
        paths["graph"].unlink(missing_ok=True)
        paths["fingerprints"].unlink(missing_ok=True)
        return {"ok": True, "status": "removed-corrupt"}

    stored_sources = {
        item.get("source_file")
        for collection in (graph_data.get("nodes", []), graph_data.get("links", []))
        for item in collection
        if isinstance(item, dict) and isinstance(item.get("source_file"), str)
    }
    invalid_sources = sorted(stored_sources - valid_sources)
    if not invalid_sources:
        return {
            "ok": True,
            "status": "unchanged",
            "revision": revision,
            "nodes": len(graph_data["nodes"]),
        }

    graph = build_merge(
        [],
        graph_path=paths["graph"],
        prune_sources=invalid_sources,
        directed=False,
        dedup=False,
    )
    nodes = _export_graph(graph, paths["graph"], revision)
    fingerprint_data = {"version": INDEX_VERSION, "revision": revision, "records": {}}
    try:
        existing = json.loads(paths["fingerprints"].read_text(encoding="utf-8"))
        entries = existing.get("records", {})
        if isinstance(entries, dict):
            fingerprint_data["records"] = {
                record_id: entry
                for record_id, entry in entries.items()
                if isinstance(entry, dict) and entry.get("sourceId") in valid_sources
            }
    except (OSError, UnicodeError, json.JSONDecodeError, AttributeError):
        pass
    _atomic_json(paths["fingerprints"], fingerprint_data)
    return {"ok": True, "status": "pruned", "revision": revision, "nodes": nodes}


def _read_payload() -> dict:
    """从标准输入读取唯一 JSON 请求，避免把记录放入 argv。"""
    payload = json.load(sys.stdin)
    if not isinstance(payload, dict):
        raise ValueError("invalid payload")
    return payload


def main() -> None:
    """分派受限桥操作并只向标准输出返回小型结构化状态。"""
    _validate_environment()
    if len(sys.argv) != 2:
        raise ValueError("invalid operation")
    payload = _read_payload()
    if sys.argv[1] == "build":
        result = _build(payload)
    elif sys.argv[1] == "prune":
        result = _prune(payload)
    else:
        raise ValueError("invalid operation")
    sys.stdout.write(json.dumps(result, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except BaseException:
        _fail()
