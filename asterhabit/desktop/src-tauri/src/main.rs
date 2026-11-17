#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod role_files;

use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Read, Write},
    path::PathBuf,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{atomic::{AtomicBool, AtomicU64, Ordering}, mpsc, Arc, Mutex},
    thread,
    time::Duration,
};
use tauri::{Manager, State, WebviewUrl, WebviewWindow};
#[cfg(windows)]
use std::os::windows::process::CommandExt;

const OPERATIONS: &[&str] = &[
    "application.quit",
    "app.snapshot", "app.activity", "application.configure",
    "agent.create", "agent.update", "agent.archive", "agent.pause", "model.list",
    "agent.profile.templates", "agent.profile.importFile", "agent.profile.exportFile",
    "model.connection.list", "model.connection.save", "model.connection.test",
    "model.connection.remove", "model.catalogue.refresh",
    "chat.history", "chat.send", "chat.cancel",
    "memory.list", "memory.save", "memory.correct", "memory.forget", "memory.sync", "memory.recover",
    "permissions.save", "permissions.revoke", "runtime.pause",
    "simulation.submit", "simulation.execute", "simulation.cancel", "audit.list",
    "growth.get", "growth.configure", "growth.sources.list", "growth.sources.authorize",
    "growth.sources.forget", "growth.sources.requeue", "character.list", "character.dismiss",
    "reflection.status",
    "proactive.get", "proactive.configure", "plans.list", "plans.cancel", "inbox.list", "inbox.read",
    "bilibili.account.get", "bilibili.account.bind", "bilibili.account.unbind", "bilibili.verify",
    "content.get", "content.configure", "content.browse",
    "observations.list", "observations.get", "observations.feedback", "observations.forget",
    "qq.latency.list", "qq.connection.get", "qq.connection.bind", "qq.connection.bindOneBot", "qq.contact.policies", "qq.contact.configure", "qq.contact.plans", "qq.contact.generate", "qq.contact.update", "qq.contact.cancel", "qq.contact.send", "qq.pairing.start", "qq.connection.unbind",
    "qq.settings.get", "qq.settings.configure", "qq.targets.resolve", "qq.groups.get", "qq.receive", "qq.messages.list", "qq.messages.forget",
    "qq.reply.get", "qq.reply.configure", "qq.drafts.generate", "qq.drafts.list",
    "qq.drafts.update", "qq.drafts.cancel", "qq.drafts.send",
    "qq.records.list", "qq.records.forget",
];
type Reply = Result<Value, String>;
type Pending = Arc<Mutex<HashMap<String, mpsc::Sender<Reply>>>>;

/// 模型管理保留稳定错误码；既有业务继续返回原简短错误文本。
fn host_error(frame: &Value) -> String {
    if let Some(error) = frame.get("modelConnectionError") {
        if error.get("modelConnectionError") == Some(&Value::Bool(true))
            && error.get("code").and_then(Value::as_str).is_some()
            && error.get("message").and_then(Value::as_str).is_some() {
            return error.to_string();
        }
    }
    frame.get("error").and_then(Value::as_str).unwrap_or("本次操作未完成").to_owned()
}

/// Node 进程和请求通道的唯一拥有者。原生控制令牌始终留在 Node。
struct HostBridge {
    input: Mutex<Option<ChildStdin>>,
    child: Mutex<Child>,
    pending: Pending,
    sequence: AtomicU64,
    closing: AtomicBool,
}

/// 从应用位置确定项目根；只有本机启动配置可覆盖，renderer 不能传入路径。
fn project_root() -> Result<PathBuf, String> {
    if let Some(configured) = std::env::var_os("COMPANION_ROOT") {
        let root = PathBuf::from(configured);
        if root.is_absolute() && root.join("scripts/desktop-service.mjs").is_file() {
            return root.canonicalize().map_err(|_| "项目目录不可访问".into());
        }
        return Err("本地项目配置无效".into());
    }
    let executable = std::env::current_exe().map_err(|_| "无法确定应用位置")?;
    for directory in executable.ancestors().skip(1) {
        if directory.join("scripts/desktop-service.mjs").is_file() {
            return Ok(directory.to_path_buf());
        }
    }
    Err("未找到本地 Asterhabit 项目，请使用项目启动脚本".into())
}

/// 窗口关闭只脱离后台；是否常驻由后台持久化设置决定。
fn window_close_operation() -> &'static str { "host.detach" }

impl HostBridge {
    /// 以无 shell 的固定参数启动私有 stdio 服务，不开放额外 HTTP 端口。
    fn spawn(root: &PathBuf) -> Result<Arc<Self>, String> {
        let executable = match std::env::var_os("COMPANION_NODE") {
            Some(value) => {
                let file = PathBuf::from(&value);
                if !file.is_absolute() || !file.is_file() { return Err("Node 路径配置无效".into()); }
                value
            }
            None => "node".into(),
        };
        let mut command = Command::new(executable);
        command.arg(root.join("scripts/desktop-service.mjs"))
            .current_dir(root)
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null())
            .env_remove("NODE_OPTIONS").env_remove("NODE_PATH");
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let mut child = command.spawn().map_err(|_| "无法启动本地宿主，请检查 Node 环境")?;
        let input = child.stdin.take().ok_or("宿主输入通道不可用")?;
        let output = child.stdout.take().ok_or("宿主输出通道不可用")?;
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let readers = Arc::clone(&pending);
        thread::spawn(move || {
            let mut reader = BufReader::new(output);
            loop {
                let mut bytes = Vec::new();
                let read = reader.by_ref().take(1_048_577).read_until(b'\n', &mut bytes);
                match read {
                    Ok(0) | Err(_) => break,
                    Ok(_) if bytes.len() > 1_048_576 || bytes.last() != Some(&b'\n') => break,
                    _ => {}
                }
                let Ok(frame) = serde_json::from_slice::<Value>(&bytes) else { break };
                let Some(id) = frame.get("id").and_then(Value::as_str) else { continue };
                let sender = readers.lock().ok().and_then(|mut requests| requests.remove(id));
                if let Some(sender) = sender {
                    let reply = if frame.get("ok") == Some(&Value::Bool(true)) {
                        Ok(frame.get("result").cloned().unwrap_or(Value::Null))
                    } else {
                        Err(host_error(&frame))
                    };
                    let _ = sender.send(reply);
                }
            }
            if let Ok(mut requests) = readers.lock() {
                for (_, sender) in requests.drain() { let _ = sender.send(Err("本地宿主已断开".into())); }
            }
        });
        Ok(Arc::new(Self { input: Mutex::new(Some(input)), child: Mutex::new(child), pending, sequence: AtomicU64::new(1), closing: AtomicBool::new(false) }))
    }

    /// 写入锁仅覆盖帧发送；等待回答期间暂停/取消请求仍可进入。
    fn request(&self, operation: &str, payload: Value) -> Reply {
        let id = self.sequence.fetch_add(1, Ordering::Relaxed).to_string();
        let mut encoded = serde_json::to_vec(&json!({"id":id,"operation":operation,"payload":payload})).map_err(|_| "请求编码失败")?;
        let maximum = if ["agent.create", "agent.update", "agent.profile.parse"].contains(&operation) { 1_048_576 } else { 32_768 };
        if encoded.len() > maximum { return Err("请求内容过长".into()); }
        encoded.push(b'\n');
        let (sender, receiver) = mpsc::channel();
        {
            let mut requests = self.pending.lock().map_err(|_| "宿主状态不可用")?;
            if requests.len() >= 32 && !["chat.cancel", "runtime.pause", "host.shutdown"].contains(&operation) { return Err("请求过多，请稍后再试".into()); }
            requests.insert(id.clone(), sender);
        }
        let sent = (|| -> Result<(), String> {
            let mut input = self.input.lock().map_err(|_| "宿主通道不可用")?;
            let pipe = input.as_mut().ok_or("宿主已关闭")?;
            pipe.write_all(&encoded).map_err(|_| "消息提交失败")?;
            pipe.flush().map_err(|_| "消息提交失败")?;
            Ok(())
        })();
        if let Err(error) = sent {
            if let Ok(mut requests) = self.pending.lock() { requests.remove(&id); }
            return Err(error);
        }
        let reply = receiver.recv_timeout(Duration::from_secs(if operation.starts_with("host.") { 70 } else { 210 })).unwrap_or_else(|_| Err("操作超时，请检查运行状态".into()));
        if let Ok(mut requests) = self.pending.lock() { requests.remove(&id); }
        reply
    }

    /// 关闭时先请宿主完成自己的取消与清理；只终止本应用的 Node 进程。
    fn shutdown(&self) {
        if self.closing.swap(true, Ordering::SeqCst) { return; }
        let _ = self.request(window_close_operation(), json!({}));
        self.close_proxy();
    }

    /// 完全退出只发一次shutdown；成功后ExitRequested不再向已关闭代理发送detach。
    fn quit(&self) -> Reply {
        if self.closing.swap(true, Ordering::SeqCst) { return Err("控制台正在关闭".into()); }
        let reply = self.request("host.shutdown", json!({}));
        if reply.is_err() { self.closing.store(false, Ordering::SeqCst); return reply; }
        self.close_proxy();
        reply
    }

    fn close_proxy(&self) {
        if let Ok(mut input) = self.input.lock() { input.take(); }
        if let Ok(mut child) = self.child.lock() {
            for _ in 0..20 {
                if matches!(child.try_wait(), Ok(Some(_))) { return; }
                thread::sleep(Duration::from_millis(100));
            }
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

/// 本地资源与固定开发 origin；生产不接受任何远程导航。
fn local_url(url: &tauri::Url) -> bool {
    (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
        || (matches!(url.scheme(), "http" | "https") && url.host_str() == Some("tauri.localhost") && url.port().is_none())
        || (cfg!(debug_assertions) && url.scheme() == "http" && url.host_str() == Some("127.0.0.1") && url.port() == Some(1420))
}

/// 主窗口唯一业务桥接；白名单和 origin 检查都在 Rust 端执行。
#[tauri::command]
async fn desktop_request(window: WebviewWindow, app: tauri::AppHandle, bridge: State<'_, Arc<HostBridge>>, operation: String, payload: Value) -> Reply {
    if window.label() != "main" || !local_url(&window.url().map_err(|_| "窗口来源不可用")?) {
        return Err("此窗口无权操作".into());
    }
    if !OPERATIONS.contains(&operation.as_str()) || !payload.is_object() {
        return Err("不支持此操作".into());
    }
    if bridge.closing.load(Ordering::SeqCst) { return Err("控制台正在关闭".into()); }
    #[cfg(windows)]
    let owner = window.hwnd().map_err(|_| "窗口来源不可用")?.0 as isize;
    #[cfg(not(windows))]
    let owner = 0isize;
    let bridge = Arc::clone(bridge.inner());
    tauri::async_runtime::spawn_blocking(move || {
        if operation == "application.quit" {
            if !payload.as_object().is_some_and(|fields| fields.is_empty()) { return Err("退出参数无效".into()); }
            let reply = bridge.quit();
            if reply.is_ok() { app.exit(0); }
            return reply;
        }
        if operation == "agent.profile.importFile" || operation == "agent.profile.exportFile" {
            return role_file_request(&bridge, owner, &operation, payload);
        }
        bridge.request(&operation, payload)
    })
        .await.map_err(|_| "本地操作未完成".to_owned())?
}

/// 文件入口固定操作与载荷；串行对话框防止重复点击和跨窗口重复保存。
fn role_file_request(bridge: &HostBridge, owner: isize, operation: &str, payload: Value) -> Reply {
    static ACTIVE: AtomicBool = AtomicBool::new(false);
    struct DialogGuard;
    impl Drop for DialogGuard { fn drop(&mut self) { ACTIVE.store(false, Ordering::SeqCst); } }
    let fields = payload.as_object().ok_or("请求字段无效")?;
    let importing = operation == "agent.profile.importFile";
    if (importing && !fields.is_empty()) || (!importing && (fields.len() != 1 || fields.get("agentId").and_then(Value::as_str).filter(|id| !id.is_empty()).is_none())) {
        return Err("请求字段无效".into());
    }
    if ACTIVE.swap(true, Ordering::SeqCst) { return Err("角色文件操作正在进行".into()); }
    let _guard = DialogGuard;
    if importing {
        let Some(path) = role_files::choose_file(owner, None)? else { return Ok(json!({"cancelled":true})); };
        let text = role_files::read_role(&path)?;
        let preview = bridge.request("agent.profile.parse", json!({"text":text}))?;
        Ok(json!({"cancelled":false,"configuration":preview["configuration"]}))
    } else {
        let exported = bridge.request("agent.profile.export", payload)?;
        let filename = exported["filename"].as_str().ok_or("角色配置文件名无效")?;
        let text = exported["json"].as_str().ok_or("角色配置文件内容无效")?;
        let Some(path) = role_files::choose_file(owner, Some(filename))? else { return Ok(json!({"cancelled":true})); };
        role_files::save_role(&path, text)?;
        Ok(json!({"cancelled":false}))
    }
}

fn main() {
    let application = tauri::Builder::default()
        .setup(|app| {
            let root = project_root().map_err(std::io::Error::other)?;
            let bridge = HostBridge::spawn(&root).map_err(std::io::Error::other)?;
            app.manage(bridge);
            let window = tauri::WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Asterhabit")
                .inner_size(1180.0, 800.0).min_inner_size(390.0, 600.0)
                .data_directory(root.join("state/desktop/webview"))
                .on_navigation(local_url)
                .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
                .on_download(|_, _| false);
            // 仅验收构建开放回环调试；正式构建不包含此参数。
            #[cfg(feature = "desktop-testing")]
            let window = window.additional_browser_args("--remote-debugging-port=9224 --remote-debugging-address=127.0.0.1");
            window.build()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![desktop_request])
        .build(tauri::generate_context!())
        .expect("桌面应用启动失败");
    let exit_started = Arc::new(AtomicBool::new(false));
    application.run(move |handle, event| {
        if let tauri::RunEvent::ExitRequested { api, .. } = event {
            if exit_started.swap(true, Ordering::SeqCst) { return; }
            api.prevent_exit();
            let bridge = Arc::clone(handle.state::<Arc<HostBridge>>().inner());
            let handle = handle.clone();
            tauri::async_runtime::spawn_blocking(move || { bridge.shutdown(); handle.exit(0); });
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn navigation_is_local_only() {
        for address in ["https://example.com", "file:///C:/Windows", "http://tauri.localhost.evil/", "javascript:alert(1)"] {
            assert!(!local_url(&address.parse().unwrap()));
        }
        assert!(local_url(&"http://tauri.localhost/".parse().unwrap()));
    }
    #[test]
    fn raw_management_operations_are_not_exposed() {
        for operation in ["host.shutdown", "agent_delete", "write_file", "shell.execute", "connect_provider"] {
            assert!(!OPERATIONS.contains(&operation));
        }
    }
    #[test]
    fn window_close_detaches_but_explicit_quit_stops_the_backend() {
        assert_eq!(window_close_operation(), "host.detach");
        assert!(OPERATIONS.contains(&"application.quit"));
        assert!(!OPERATIONS.contains(&"host.detach"));
    }
    #[test]
    fn explicit_quit_sends_no_second_detach() {
        use std::fs;
        let suffix = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let root = std::env::temp_dir().join(format!("asterhabit-quit-{}-{suffix}", std::process::id()));
        fs::create_dir_all(root.join("scripts")).unwrap();
        fs::write(root.join("scripts/desktop-service.mjs"), "import fs from 'node:fs';import readline from 'node:readline';const r=readline.createInterface({input:process.stdin});r.on('line',line=>{const f=JSON.parse(line);fs.appendFileSync('operations.txt',f.operation+'\\n');process.stdout.write(JSON.stringify({id:f.id,ok:true,result:{closed:true}})+'\\n');if(f.operation==='host.shutdown')r.close();});").unwrap();
        let bridge = HostBridge::spawn(&root).unwrap();
        assert!(bridge.quit().is_ok());
        bridge.shutdown();
        assert_eq!(fs::read_to_string(root.join("operations.txt")).unwrap(), "host.shutdown\n");
        fs::remove_dir_all(root).unwrap();
    }
    /// 消息工作区沿用固定 QQ 操作，不开放任意目标发送或通用网络调用。
    #[test]
    fn messages_keep_qq_review_and_target_lookup_boundary() {
        for operation in ["qq.targets.resolve", "qq.groups.get", "qq.messages.list", "qq.drafts.generate", "qq.drafts.update", "qq.drafts.send", "qq.records.list"] {
            assert!(OPERATIONS.contains(&operation));
        }
        for operation in ["qq.send", "qq.proactive.send", "http.request"] {
            assert!(!OPERATIONS.contains(&operation));
        }
    }
    #[test]
    fn model_connections_keep_fixed_operations_and_error_codes() {
        for operation in ["model.connection.list", "model.connection.save", "model.connection.test", "model.connection.remove", "model.catalogue.refresh"] {
            assert!(OPERATIONS.contains(&operation));
        }
        let frame = json!({"error":"安全错误", "modelConnectionError":{"modelConnectionError":true,"code":"CONFLICT","message":"配置已变化"}});
        let error: Value = serde_json::from_str(&host_error(&frame)).unwrap();
        assert_eq!(error["code"], "CONFLICT");
        assert_eq!(host_error(&json!({"error":"原有错误"})), "原有错误");
    }
}


