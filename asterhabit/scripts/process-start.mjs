// 进程创建标识算法保留原表示和未知状态语义；来源与许可见 THIRD_PARTY_NOTICES.md。
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
const PROCESS_START_PROBE_TIMEOUT_MS=250;
/** 获取进程创建标识用于防止PID复用；失败返回null，由调用方保守处理。 */
export function getProcessStart(pid, platform = process.platform, run = (executable, args, options) => execFileSync(executable, args, {
  ...options,
  encoding: "utf8",
  windowsHide: true
}), timeoutMs = PROCESS_START_PROBE_TIMEOUT_MS) {
  if (!Number.isSafeInteger(pid) || pid <= 0)
    return null;
  try {
    if (platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const closeParen = stat.lastIndexOf(")");
      if (closeParen < 0)
        return null;
      return stat.slice(closeParen + 2).split(" ")[19] ?? null;
    }
    const started = platform === "win32" ? run("powershell", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToFileTimeUtc()`
    ], { timeout: timeoutMs }) : run("ps", ["-o", "lstart=", "-p", String(pid)], {
      env: { ...process.env, TZ: "UTC", LC_ALL: "C" },
      timeout: timeoutMs
    });
    return started.trim() || null;
  } catch {
    return null;
  }
}
