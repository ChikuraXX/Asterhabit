//! 角色文件使用系统选择/保存对话框，路径仅停留在原生层。
use std::{fs::{File, OpenOptions}, io::{Read, Write}, path::{Path, PathBuf}, sync::atomic::{AtomicU64, Ordering}};

/// 文件大小与前后端使用同一份合同；UTF-8字节上限不等于字段字符上限。
fn maximum_bytes() -> Result<u64, String> {
    let contract: serde_json::Value = serde_json::from_str(include_str!("../../../shared/agent-role-contract.json")).map_err(|_| "角色文件合同不可用")?;
    contract["maxFileBytes"].as_u64().ok_or_else(|| "角色文件合同不可用".into())
}

/// 有界读取普通文件；读取期间增长也不能突破上限，拒绝无效UTF-8。
pub fn read_role(path: &Path) -> Result<String, String> {
    let file = File::open(path).map_err(|_| "角色配置文件无法读取")?;
    let metadata = file.metadata().map_err(|_| "角色配置文件无法读取")?;
    let maximum = maximum_bytes()?;
    if !metadata.is_file() { return Err("角色配置文件无法读取".into()); }
    if metadata.len() > maximum { return Err("角色配置文件超过大小限制".into()); }
    let mut bytes = Vec::new();
    file.take(maximum + 1).read_to_end(&mut bytes).map_err(|_| "角色配置文件无法读取")?;
    if bytes.len() as u64 > maximum { return Err("角色配置文件超过大小限制".into()); }
    String::from_utf8(bytes).map_err(|_| "角色配置文件必须使用UTF-8".into())
}

/// 先在目标目录完整落盘，再原子替换；失败不留下截断的原文件。
pub fn save_role(path: &Path, text: &str) -> Result<(), String> {
    static SEQUENCE: AtomicU64 = AtomicU64::new(1);
    if text.len() as u64 > maximum_bytes()? { return Err("角色配置文件超过大小限制".into()); }
    let parent = path.parent().ok_or("角色配置文件无法保存")?;
    let temporary = parent.join(format!(".asterhabit-role-{}-{}.tmp", std::process::id(), SEQUENCE.fetch_add(1, Ordering::Relaxed)));
    let mut file = OpenOptions::new().write(true).create_new(true).open(&temporary).map_err(|_| "角色配置文件无法保存")?;
    let result = (|| {
        file.write_all(text.as_bytes()).and_then(|_| file.sync_all()).map_err(|_| "角色配置文件无法保存".to_owned())?;
        drop(file);
        replace_file(&temporary, path)
    })();
    if result.is_err() { let _ = std::fs::remove_file(&temporary); }
    result
}

#[cfg(windows)]
fn wide(value: &std::ffi::OsStr) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    value.encode_wide().chain(std::iter::once(0)).collect()
}

#[cfg(windows)]
fn replace_file(source: &Path, destination: &Path) -> Result<(), String> {
    #[link(name = "kernel32")]
    extern "system" { fn MoveFileExW(source: *const u16, destination: *const u16, flags: u32) -> i32; }
    // 同目录临时文件，不允许跨卷复制回退；REPLACE_EXISTING | WRITE_THROUGH。
    let result = unsafe { MoveFileExW(wide(source.as_os_str()).as_ptr(), wide(destination.as_os_str()).as_ptr(), 0x1 | 0x8) };
    if result == 0 { Err("角色配置文件无法保存".into()) } else { Ok(()) }
}
#[cfg(not(windows))]
fn replace_file(source: &Path, destination: &Path) -> Result<(), String> {
    std::fs::rename(source, destination).map_err(|_| "角色配置文件无法保存".into())
}

/// 原生对话框结果只有选定路径或取消；任何renderer参数都不能充当路径。
#[cfg(windows)]
pub fn choose_file(owner: isize, filename: Option<&str>) -> Result<Option<PathBuf>, String> {
    use std::{ffi::{c_void, OsStr, OsString}, os::windows::ffi::OsStringExt};
    #[repr(C)]
    struct OpenFilename {
        size: u32, owner: isize, instance: isize, filter: *const u16,
        custom_filter: *mut u16, max_custom_filter: u32, filter_index: u32,
        file: *mut u16, max_file: u32, file_title: *mut u16, max_file_title: u32,
        initial_dir: *const u16, title: *const u16, flags: u32,
        file_offset: u16, file_extension: u16, default_extension: *const u16,
        custom_data: isize, hook: *const c_void, template_name: *const u16,
        reserved: *mut c_void, reserved_word: u32, flags_ex: u32,
    }
    #[link(name = "comdlg32")]
    extern "system" {
        fn GetOpenFileNameW(value: *mut OpenFilename) -> i32;
        fn GetSaveFileNameW(value: *mut OpenFilename) -> i32;
        fn CommDlgExtendedError() -> u32;
    }
    let mut buffer = vec![0u16; 32768];
    if let Some(name) = filename {
        let initial = wide(OsStr::new(name));
        if initial.len() >= buffer.len() || name.contains(['/', '\\', '\0']) { return Err("角色配置文件名无效".into()); }
        buffer[..initial.len()].copy_from_slice(&initial);
    }
    let filter = wide(OsStr::new("JSON (*.json)\0*.json\0"));
    let extension = wide(OsStr::new("json"));
    // 对话框拥有已初始化结构中的借用缓冲区；同步返回前所有指针始终有效。
    let mut dialog: OpenFilename = unsafe { std::mem::zeroed() };
    dialog.size = std::mem::size_of::<OpenFilename>() as u32;
    dialog.owner = owner;
    dialog.filter = filter.as_ptr();
    dialog.filter_index = 1;
    dialog.file = buffer.as_mut_ptr();
    dialog.max_file = buffer.len() as u32;
    dialog.default_extension = extension.as_ptr();
    // EXPLORER | NOCHANGEDIR | PATHMUSTEXIST，打开要求文件存在，保存询问覆盖。
    dialog.flags = 0x80000 | 0x8 | 0x800 | if filename.is_some() { 0x2 } else { 0x1000 };
    let accepted = unsafe { if filename.is_some() { GetSaveFileNameW(&mut dialog) } else { GetOpenFileNameW(&mut dialog) } };
    if accepted == 0 {
        if unsafe { CommDlgExtendedError() } == 0 { return Ok(None); }
        return Err("角色文件对话框无法打开".into());
    }
    let end = buffer.iter().position(|value| *value == 0).ok_or("角色配置文件名无效")?;
    Ok(Some(PathBuf::from(OsString::from_wide(&buffer[..end]))))
}

#[cfg(not(windows))]
pub fn choose_file(_owner: isize, _filename: Option<&str>) -> Result<Option<PathBuf>, String> {
    Err("当前系统不支持角色文件对话框".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounded_utf8_read_and_atomic_save() {
        let directory = std::env::temp_dir().join(format!("asterhabit-role-test-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let target = directory.join("synthetic.json");
        save_role(&target, "{\"name\":\"测试\"}").unwrap();
        assert_eq!(read_role(&target).unwrap(), "{\"name\":\"测试\"}");
        save_role(&target, "{}").unwrap();
        assert_eq!(read_role(&target).unwrap(), "{}");
        std::fs::write(&target, [0xff]).unwrap();
        assert!(read_role(&target).unwrap_err().contains("UTF-8"));
        std::fs::write(&target, vec![b' '; maximum_bytes().unwrap() as usize + 1]).unwrap();
        assert!(read_role(&target).unwrap_err().contains("大小"));
        assert!(save_role(&target, &" ".repeat(maximum_bytes().unwrap() as usize + 1)).is_err());
        std::fs::remove_dir_all(directory).unwrap();
    }
}
