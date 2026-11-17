import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const INDEX_VERSION = 1;
// Graphify 环境随 AgentDot 工作区定位，避免依赖开发机的全局包。
const DEFAULT_PYTHON = fileURLToPath(new URL(process.platform === 'win32' ? '../../graphify/.venv/Scripts/python.exe' : '../../graphify/.venv/bin/python', import.meta.url));
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_GRAPH_BYTES = 64 * 1024 * 1024;
const LEASE_VERSION = 2;
const VALID_CLASSIFICATIONS = new Set(['EXTRACTED', 'INFERRED', 'AMBIGUOUS']);
const VALID_ORIGINS = new Set(['user', 'external']);
const BRIDGE = fileURLToPath(new URL('./graphify_bridge.py', import.meta.url));

/** 将 scope 校验为不会造成路径穿越的固定十六进制标识。 */
function normalizeScope(scopeId) {
  if (typeof scopeId !== 'string' || !/^[0-9a-f]{64}$/iu.test(scopeId)) {
    throw new TypeError('Invalid scopeId');
  }
  return scopeId.toLowerCase();
}

/** 校验从零开始的宿主修订号。 */
function normalizeRevision(revision) {
  if (!Number.isInteger(revision) || revision < 0) {
    throw new TypeError('Invalid revision');
  }
  return revision;
}

/** 判断来源标识可作为证据键且不会被解释为绝对或穿越路径。 */
function isValidSourceId(sourceId) {
  if (typeof sourceId !== 'string' || sourceId.length === 0 || sourceId.includes('\0')) return false;
  if (sourceId.includes('\\') || sourceId.startsWith('/') || /^[a-z]:/iu.test(sourceId)) return false;
  const parts = sourceId.split('/');
  return parts.every((part) => part.length > 0 && part !== '.' && part !== '..');
}

/** 校验并复制一条可信宿主记录，忽略合同之外的字段。 */
function normalizeRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Invalid record');
  }
  for (const field of ['id', 'sourceId', 'subjectKey', 'topic', 'text']) {
    if (typeof value[field] !== 'string') throw new TypeError('Invalid record');
  }
  if (value.id.length === 0 || !isValidSourceId(value.sourceId)) {
    throw new TypeError('Invalid record');
  }
  if (!VALID_CLASSIFICATIONS.has(value.classification) || !VALID_ORIGINS.has(value.origin)) {
    throw new TypeError('Invalid record');
  }
  return {
    id: value.id,
    sourceId: value.sourceId,
    subjectKey: value.subjectKey,
    topic: value.topic,
    text: value.text,
    classification: value.classification,
    origin: value.origin,
  };
}

/** 校验构建记录数组并拒绝会破坏 sidecar 映射的重复记录标识。 */
function normalizeRecords(records) {
  if (!Array.isArray(records)) throw new TypeError('Invalid records');
  const normalized = records.map(normalizeRecord);
  const ids = new Set(normalized.map((record) => record.id));
  if (ids.size !== normalized.length) throw new TypeError('Duplicate record id');
  return normalized;
}

/** 计算与 Python 桥一致的固定字段内容指纹。 */
function recordHash(record) {
  return createHash('sha256').update(JSON.stringify([
    record.id,
    record.sourceId,
    record.subjectKey,
    record.topic,
    record.text,
    record.classification,
    record.origin,
  ]), 'utf8').digest('hex');
}

/** 仅保留 Python 启动和临时文件所需环境，不继承凭据、代理或注入选项。 */
function workerEnvironment() {
  const environment = {
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
  };
  for (const name of ['SystemRoot', 'WINDIR', 'ComSpec', 'TEMP', 'TMP']) {
    if (typeof process.env[name] === 'string') environment[name] = process.env[name];
  }
  return environment;
}

/** 把 worker 的小型 JSON 结果解析为不含底层错误细节的返回值。 */
function parseWorkerResult(stdout) {
  try {
    const result = JSON.parse(stdout);
    if (result?.ok === true) return result;
  } catch {
    // 统一由下方安全错误处理，避免暴露 worker 输出。
  }
  throw new Error('Graphify worker failed');
}

/** 仅在操作系统明确报告 PID 不存在时，判定 lease 所属进程已退出。 */
function processDefinitelyExited(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error?.code === 'ESRCH';
  }
}

/** 校验 lease 元数据与其文件名严格一致，并返回可安全处理的限定文件名。 */
function validateLease(leaseName, value) {
  const match = /^([0-9a-f]{64})\.(0|[1-9][0-9]*)\.([0-9a-f]{32})\.lease\.json$/u.exec(leaseName);
  if (!match || value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const [, scopeId, revision, token] = match;
  const stem = `${scopeId}.${revision}.${token}`;
  const expected = [`${stem}.graph.json`, `${stem}.fingerprints.json`];
  if (value.version !== LEASE_VERSION
    || !['starting', 'running', 'artifact'].includes(value.phase)
    || !Number.isInteger(value.parentPid)
    || value.parentPid <= 0
    || value.token !== token
    || !Array.isArray(value.files)
    || value.files.length !== expected.length
    || expected.some((name) => !value.files.includes(name))
    || value.files.some((name) => basename(name) !== name)) return null;
  if (value.phase === 'running') {
    if (!Number.isInteger(value.workerPid) || value.workerPid <= 0) return null;
  } else if ('workerPid' in value) {
    return null;
  }
  return {
    phase: value.phase,
    parentPid: value.parentPid,
    workerPid: value.workerPid,
    scopeId,
    files: expected,
  };
}

/**
 * 清理已退出进程的合法 lease；无法证明安全归属的遗留只计入 manualPending。
 */
function recoverStaging(stagingDirectory) {
  const protectedNames = new Set();
  const pendingProtectedNames = new Set();
  for (const leaseName of readdirSync(stagingDirectory).filter((name) => name.endsWith('.lease.json'))) {
    const leasePath = join(stagingDirectory, leaseName);
    let lease;
    try {
      lease = validateLease(leaseName, JSON.parse(readFileSync(leasePath, 'utf8')));
    } catch {
      lease = null;
    }
    if (!lease) continue;
    const parentExited = processDefinitelyExited(lease.parentPid);
    const workerExited = lease.phase === 'running'
      ? processDefinitelyExited(lease.workerPid)
      : null;
    const reclaim = lease.phase === 'artifact'
      ? parentExited
      : lease.phase === 'running' && parentExited && workerExited;
    if (!reclaim) {
      if (lease.phase === 'starting' && parentExited) continue;
      protectedNames.add(leaseName);
      for (const name of lease.files) protectedNames.add(name);
      if (lease.phase === 'running' && parentExited) {
        pendingProtectedNames.add(leaseName);
        for (const name of lease.files) pendingProtectedNames.add(name);
      }
      continue;
    }
    for (const name of lease.files) rmSync(join(stagingDirectory, name), { force: true });
    rmSync(leasePath, { force: true });
  }

  const byScope = new Map();
  let count = 0;
  for (const name of readdirSync(stagingDirectory)) {
    if (protectedNames.has(name) && !pendingProtectedNames.has(name)) continue;
    count += 1;
    const match = /^([0-9a-f]{64})\./u.exec(name);
    if (match) byScope.set(match[1], (byScope.get(match[1]) ?? 0) + 1);
  }
  return { count, byScope };
}

/** 原子写入不含正文的构建 lease 状态。 */
function writeBuildLease(state, token, phase, workerPid = undefined) {
  const value = {
    version: LEASE_VERSION,
    phase,
    parentPid: process.pid,
    token,
    files: [basename(state.graphPath), basename(state.fingerprintPath)],
  };
  if (phase === 'running') value.workerPid = workerPid;
  const temporary = `${state.leasePath}.${randomUUID().replaceAll('-', '')}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    renameSync(temporary, state.leasePath);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** 从正式图提取并验证无正文索引元数据。 */
function readGraph(directory, scopeId) {
  const path = join(directory, `${scopeId}.graph.json`);
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > MAX_GRAPH_BYTES) return { error: 'corrupt' };
    const graph = JSON.parse(readFileSync(path, 'utf8'));
    const metadata = graph?.graph?.letta_index;
    if (!Array.isArray(graph?.nodes) || !Array.isArray(graph?.links)) return { error: 'corrupt' };
    if (metadata?.version !== INDEX_VERSION
      || !Number.isInteger(metadata?.revision)
      || metadata.revision < 0) return { error: 'corrupt' };
    return { graph, revision: metadata.revision };
  } catch (error) {
    if (error?.code === 'ENOENT') return { error: 'missing' };
    return { error: 'corrupt' };
  }
}

/** 对查询文本执行与语种无关的保守大小写归一化。 */
function normalizeSearchText(value) {
  return value.normalize('NFKC').toLocaleLowerCase('und');
}

/** 为节点生成只包含合同字段的有限检索文本。 */
function searchableText(node) {
  return normalizeSearchText([
    node.label,
    node.text,
    node.subject_key,
    node.topic,
  ].filter((value) => typeof value === 'string').join('\n'));
}

/** 维护每个 artifact 的私有路径和一次性生命周期。 */
const artifactStates = new WeakMap();
/** 维护不可由实例公共字段伪造的私有所有者令牌。 */
const indexOwners = new WeakMap();
/** 维护每个实例已完成但尚未发布或丢弃的 artifact 状态。 */
const ownedArtifactStates = new WeakMap();

/**
 * 在每个 scope 的独立 Graphify 图上提供暂存构建、原子发布与证据过滤检索。
 */
export class GraphifyIndex {
  /** 创建绑定绝对私人目录的索引适配器。 */
  constructor({ directory, python = DEFAULT_PYTHON }) {
    if (typeof directory !== 'string' || !isAbsolute(directory)) {
      throw new TypeError('directory must be absolute');
    }
    if (typeof python !== 'string' || !isAbsolute(python)) {
      throw new TypeError('python must be an absolute path');
    }
    this.directory = resolve(directory);
    this.python = python;
    this._workerTimeoutMs = DEFAULT_TIMEOUT_MS;
    this._children = new Set();
    this._closed = false;
    indexOwners.set(this, Object.freeze({}));
    ownedArtifactStates.set(this, new Set());
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const stagingDirectory = join(this.directory, '.staging');
    mkdirSync(stagingDirectory, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') {
      chmodSync(this.directory, 0o700);
      chmodSync(stagingDirectory, 0o700);
    }
    this._refreshStagingRecovery();
  }

  /** 重新扫描 staging，回收新近退出的 lease 并刷新无正文 pending 状态。 */
  _refreshStagingRecovery() {
    const recovery = recoverStaging(join(this.directory, '.staging'));
    this.manualPending = recovery.count;
    this._manualPendingByScope = recovery.byScope;
  }

  /** 异步运行一次受限 Python 桥操作并约束时长与输出。 */
  _run(operation, payload, onSpawn = undefined) {
    if (this._closed) return Promise.reject(new Error('Graphify index is closed'));
    const input = JSON.stringify(payload);
    return new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(this.python, ['-I', '-X', 'utf8', BRIDGE, operation], {
        cwd: this.directory,
        env: workerEnvironment(),
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this._children.add(child);
      let stdout = Buffer.alloc(0);
      let stderrBytes = 0;
      let settled = false;
      let termination = null;

      /** 完成 Promise 并释放定时器和进程跟踪。 */
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this._children.delete(child);
        if (error) rejectPromise(error);
        else resolvePromise(value);
      };

      /** 超限时终止 worker，且不保留其输出。 */
      const stop = (reason) => {
        if (termination === null) termination = reason;
        child.kill();
      };

      const timer = setTimeout(() => stop('timed out'), this._workerTimeoutMs);
      child.stdout.on('data', (chunk) => {
        if (stdout.length + chunk.length > MAX_OUTPUT_BYTES) {
          stdout = Buffer.alloc(0);
          stop('exceeded output limit');
          return;
        }
        stdout = Buffer.concat([stdout, chunk]);
      });
      child.stderr.on('data', (chunk) => {
        stderrBytes += chunk.length;
        if (stderrBytes > MAX_OUTPUT_BYTES) stop('exceeded output limit');
      });
      child.on('error', () => finish(new Error('Graphify worker failed')));
      child.on('close', (code) => {
        if (termination !== null) {
          finish(new Error(`Graphify worker ${termination}`));
          return;
        }
        if (this._closed) {
          finish(new Error('Graphify index is closed'));
          return;
        }
        if (code !== 0) {
          finish(new Error('Graphify worker failed'));
          return;
        }
        try {
          finish(null, parseWorkerResult(stdout.toString('utf8')));
        } catch (error) {
          finish(error);
        }
      });
      child.stdin.on('error', () => {});
      try {
        if (!Number.isInteger(child.pid) || child.pid <= 0) throw new Error('invalid worker pid');
        onSpawn?.(child.pid);
        child.stdin.end(input, 'utf8');
      } catch {
        stop('failed during startup');
        child.stdin.destroy();
      }
    });
  }

  /** 同步运行 prune 桥操作并使用同样的隔离、超时和输出上限。 */
  _runSync(operation, payload) {
    if (this._closed) throw new Error('Graphify index is closed');
    const result = spawnSync(this.python, ['-I', '-X', 'utf8', BRIDGE, operation], {
      cwd: this.directory,
      env: workerEnvironment(),
      shell: false,
      windowsHide: true,
      input: JSON.stringify(payload),
      encoding: 'utf8',
      timeout: this._workerTimeoutMs,
      maxBuffer: MAX_OUTPUT_BYTES,
    });
    if (result.error?.code === 'ETIMEDOUT') throw new Error('Graphify worker timed out');
    if (result.error || result.status !== 0) throw new Error('Graphify worker failed');
    return parseWorkerResult(result.stdout);
  }

  /** 删除指定 artifact 的两个自有暂存文件。 */
  _removeStaged(state) {
    rmSync(state.graphPath, { force: true });
    rmSync(state.fingerprintPath, { force: true });
  }

  /** 标记 artifact 已消费并删除其不含正文的 lease。 */
  _consumeArtifact(state) {
    state.consumed = true;
    ownedArtifactStates.get(this).delete(state);
    rmSync(state.leasePath, { force: true });
  }

  /** 构建暂存图和指纹 sidecar，但不改变正式图。 */
  async build(scopeId, revision, records) {
    const scope = normalizeScope(scopeId);
    const normalizedRevision = normalizeRevision(revision);
    const normalizedRecords = normalizeRecords(records);
    const token = randomUUID().replaceAll('-', '');
    const stem = `${scope}.${normalizedRevision}.${token}`;
    const state = {
      scopeId: scope,
      revision: normalizedRevision,
      graphPath: join(this.directory, '.staging', `${stem}.graph.json`),
      fingerprintPath: join(this.directory, '.staging', `${stem}.fingerprints.json`),
      leasePath: join(this.directory, '.staging', `${stem}.lease.json`),
      owner: indexOwners.get(this),
      consumed: false,
    };
    let artifactReady = false;
    let cleanupFailed = false;
    try {
      writeBuildLease(state, token, 'starting');
      await this._run('build', {
        directory: this.directory,
        scopeId: scope,
        revision: normalizedRevision,
        token,
        records: normalizedRecords,
      }, (workerPid) => writeBuildLease(state, token, 'running', workerPid));
      writeBuildLease(state, token, 'artifact');
      if (!existsSync(state.graphPath) || !existsSync(state.fingerprintPath)) {
        throw new Error('Graphify worker failed');
      }
      const artifact = Object.freeze({ scopeId: scope, revision: normalizedRevision, id: token });
      artifactStates.set(artifact, state);
      ownedArtifactStates.get(this).add(state);
      artifactReady = true;
      return artifact;
    } catch (error) {
      try {
        this._removeStaged(state);
      } catch {
        cleanupFailed = true;
      }
      throw error;
    } finally {
      if (!artifactReady && !cleanupFailed) rmSync(state.leasePath, { force: true });
    }
  }

  /** 以正式图单文件替换作为可见性边界，同步发布一次性 artifact。 */
  publish(artifact) {
    const state = artifactStates.get(artifact);
    if (!state || state.owner !== indexOwners.get(this) || state.consumed) {
      throw new TypeError('Invalid artifact');
    }
    const graphTarget = join(this.directory, `${state.scopeId}.graph.json`);
    const fingerprintTarget = join(this.directory, `${state.scopeId}.fingerprints.json`);
    try {
      renameSync(state.fingerprintPath, fingerprintTarget);
      renameSync(state.graphPath, graphTarget);
      this._consumeArtifact(state);
      return { revision: state.revision };
    } catch {
      throw new Error('Graphify artifact publish failed');
    }
  }

  /** 丢弃未发布 artifact 的自有暂存文件。 */
  discard(artifact) {
    const state = artifactStates.get(artifact);
    if (!state || state.owner !== indexOwners.get(this)) throw new TypeError('Invalid artifact');
    if (state.consumed) return false;
    this._removeStaged(state);
    this._consumeArtifact(state);
    return true;
  }

  /** 同步清理正式图内不再合法的来源证据。 */
  prune(scopeId, validSourceIds) {
    const scope = normalizeScope(scopeId);
    if (!Array.isArray(validSourceIds) || validSourceIds.some((sourceId) => !isValidSourceId(sourceId))) {
      throw new TypeError('Invalid source ids');
    }
    try {
      return this._runSync('prune', {
        directory: this.directory,
        scopeId: scope,
        validSourceIds: [...new Set(validSourceIds)],
      });
    } catch (error) {
      let removalFailed = false;
      for (const target of [
        join(this.directory, `${scope}.graph.json`),
        join(this.directory, `${scope}.fingerprints.json`),
      ]) {
        try {
          rmSync(target, { force: true });
        } catch {
          removalFailed = true;
        }
      }
      if (removalFailed) throw new Error('Graphify worker failed and index removal failed');
      throw error;
    }
  }

  /** 在修订匹配时按允许记录指纹过滤节点和边，再做有限深度遍历。 */
  search(scopeId, expectedRevision, allowedRecords, query, { limit = 8, maxDepth = 2 } = {}) {
    let scope;
    let revision;
    try {
      scope = normalizeScope(scopeId);
      revision = normalizeRevision(expectedRevision);
    } catch {
      return [];
    }
    if (typeof query !== 'string' || !Array.isArray(allowedRecords)) return [];
    const loaded = readGraph(this.directory, scope);
    if (loaded.error || loaded.revision !== revision) return [];

    const allowed = new Map();
    for (const candidate of allowedRecords) {
      try {
        const normalized = normalizeRecord(candidate);
        allowed.set(`${normalized.sourceId}\0${normalized.id}`, recordHash(normalized));
      } catch {
        // 单条无效 allowedRecord 不得扩大权限或使其他来源可见。
      }
    }
    if (allowed.size === 0) return [];

    /** 判断图元素是否仍与宿主允许记录完全一致。 */
    const isAllowed = (item) => {
      if (item === null || typeof item !== 'object') return false;
      if (!isValidSourceId(item.source_file) || typeof item.record_id !== 'string') return false;
      return allowed.get(`${item.source_file}\0${item.record_id}`) === item.content_hash;
    };
    const nodes = new Map(loaded.graph.nodes.filter(isAllowed).map((node) => [node.id, node]));
    const adjacency = new Map([...nodes.keys()].map((id) => [id, []]));
    for (const edge of loaded.graph.links) {
      if (!isAllowed(edge) || !nodes.has(edge.source) || !nodes.has(edge.target)) continue;
      adjacency.get(edge.source).push(edge.target);
      adjacency.get(edge.target).push(edge.source);
    }

    const normalizedQuery = normalizeSearchText(query.trim());
    if (normalizedQuery.length === 0) return [];
    const terms = normalizedQuery.match(/[\p{L}\p{N}_-]+/gu) ?? [normalizedQuery];
    const queue = [];
    const bestDepth = new Map();
    const seedScore = new Map();
    for (const [id, node] of nodes) {
      const haystack = searchableText(node);
      const score = (haystack.includes(normalizedQuery) ? terms.length + 2 : 0)
        + terms.filter((term) => haystack.includes(term)).length;
      if (score > 0) {
        queue.push([id, 0]);
        bestDepth.set(id, 0);
        seedScore.set(id, score);
      }
    }

    const depthLimit = Number.isInteger(maxDepth) ? Math.max(0, Math.min(8, maxDepth)) : 2;
    const sourceMatches = new Map();
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const [id, depth] = queue[cursor];
      const node = nodes.get(id);
      const score = seedScore.get(id) ?? 0;
      if (node.kind === 'memory') {
        const previous = sourceMatches.get(node.source_file);
        if (!previous || score > previous.score || (score === previous.score && depth < previous.depth)) {
          sourceMatches.set(node.source_file, { score, depth });
        }
      }
      if (depth >= depthLimit) continue;
      for (const neighbor of adjacency.get(id) ?? []) {
        const nextDepth = depth + 1;
        if ((bestDepth.get(neighbor) ?? Infinity) <= nextDepth) continue;
        bestDepth.set(neighbor, nextDepth);
        seedScore.set(neighbor, Math.max(seedScore.get(neighbor) ?? 0, score));
        queue.push([neighbor, nextDepth]);
      }
    }
    const resultLimit = Number.isInteger(limit) ? Math.max(0, Math.min(100, limit)) : 8;
    return [...sourceMatches.entries()]
      .sort(([sourceA, a], [sourceB, b]) => b.score - a.score || a.depth - b.depth || sourceA.localeCompare(sourceB))
      .slice(0, resultLimit)
      .map(([sourceId]) => sourceId);
  }

  /** 返回不含标签、正文、来源或路径的索引状态。 */
  indexStatus(scopeId) {
    let scope;
    try {
      scope = normalizeScope(scopeId);
    } catch {
      return { version: INDEX_VERSION, error: 'invalid-scope' };
    }
    this._refreshStagingRecovery();
    const loaded = readGraph(this.directory, scope);
    const pending = this._manualPendingByScope.get(scope) ?? 0;
    const status = loaded.error ? { version: INDEX_VERSION, error: loaded.error } : {
      version: INDEX_VERSION,
      revision: loaded.revision,
      nodes: loaded.graph.nodes.length,
    };
    return pending ? { ...status, manualPending: pending } : status;
  }

  /** 终止本实例仍在运行的 worker，并拒绝后续操作。 */
  close() {
    if (this._closed) return;
    this._closed = true;
    for (const child of this._children) child.kill();
    for (const state of ownedArtifactStates.get(this)) {
      let stagedRemoved = false;
      try {
        this._removeStaged(state);
        stagedRemoved = true;
      } catch {
        // 保留 lease，待当前进程退出后由下次构造安全回收。
      }
      if (stagedRemoved) {
        try {
          rmSync(state.leasePath, { force: true });
        } catch {
          // 暂存正文已删除；残留无正文 lease 可在进程退出后回收。
        }
      }
      state.consumed = true;
    }
    ownedArtifactStates.get(this).clear();
  }
}
