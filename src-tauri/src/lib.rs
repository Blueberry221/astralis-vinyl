use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

// Windows-only: lets us hide the black console window when running yt-dlp
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use tauri::{AppHandle, Manager};

const CREATE_NO_WINDOW: u32 = 0x08000000;
const DEFAULT_DB: &str =
    r#"[{"id":"downloaded","name":"Downloaded","desc":"Permanently downloaded songs","songs":[]}]"#;

/// =========================================================
/// HELPERS
/// =========================================================

/// Path to a bundled executable inside <resources>/bin.
fn bin_path(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    let dir = app.path().resource_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("bin").join(name))
}

/// App data subfolder (created if missing), e.g. "cache", "library", "runtime".
fn data_dir(app: &AppHandle, sub: &str) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join(sub);
    fs::create_dir_all(&dir).map_err(|e| format!("Cannot create {}: {}", dir.display(), e))?;
    Ok(dir)
}

/// A yt-dlp command with the console window hidden on Windows.
fn yt_command(app: &AppHandle) -> Result<Command, String> {
    let mut cmd = Command::new(bin_path(app, "yt-dlp.exe")?);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    Ok(cmd)
}

/// YouTube ids are exactly 11 chars of [A-Za-z0-9_-]. Anything else is rejected
/// so it can never end up inside a file path or URL.
fn valid_video_id(id: &str) -> bool {
    id.len() == 11 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Shared download logic for the cache and library folders.
fn fetch_audio(app: &AppHandle, video_id: &str, folder: &str) -> Result<String, String> {
    if !valid_video_id(video_id) {
        return Err("Invalid video id".to_string());
    }

    let dir = data_dir(app, folder)?;
    let file_path = dir.join(format!("{}.m4a", video_id));

    // Already downloaded: reuse it
    if file_path.exists() {
        return Ok(file_path.to_string_lossy().to_string());
    }

    let ffmpeg = bin_path(app, "ffmpeg.exe")?;
    let url = format!("https://www.youtube.com/watch?v={}", video_id);

    let mut cmd = yt_command(app)?;
    cmd.arg("--ffmpeg-location")
        .arg(&ffmpeg)
        .args(["-f", "ba/b"])
        .arg("-o")
        .arg(&file_path)
        .args([
            "--extract-audio",
            "--audio-format",
            "m4a",
            "--extractor-args",
            "youtube:player_client=android,web",
        ])
        .arg(&url);

    let output = cmd
        .output()
        .map_err(|e| format!("Failed to run yt-dlp: {}", e))?;

    if output.status.success() && file_path.exists() {
        Ok(file_path.to_string_lossy().to_string())
    } else {
        let err = String::from_utf8_lossy(&output.stderr).to_string();
        if err.trim().is_empty() {
            Err("yt-dlp finished but no audio file was created".to_string())
        } else {
            Err(err)
        }
    }
}

fn is_valid_db(raw: &str) -> bool {
    serde_json::from_str::<Vec<serde_json::Value>>(raw).is_ok()
}

/// =========================================================
/// 1. AUDIO SEARCH  (async: the window stays responsive)
/// =========================================================
#[tauri::command]
async fn search_song(app: AppHandle, query: String) -> Result<String, String> {
    let query = query.trim().to_string();
    if query.is_empty() {
        return Err("Empty query".to_string());
    }

    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = yt_command(&app)?;
        cmd.arg(format!("ytsearch5:{}", query))
            .args(["--dump-json", "--no-playlist", "--ignore-errors"]);

        let output = cmd
            .output()
            .map_err(|e| format!("Failed to run yt-dlp: {}", e))?;

        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        // --ignore-errors can exit non-zero even when some results came back
        if output.status.success() || !stdout.trim().is_empty() {
            Ok(stdout)
        } else {
            Err(String::from_utf8_lossy(&output.stderr).to_string())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// =========================================================
/// 2. CACHE AUDIO DOWNLOAD
/// =========================================================
#[tauri::command]
async fn download_audio(app: AppHandle, video_id: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || fetch_audio(&app, &video_id, "cache"))
        .await
        .map_err(|e| e.to_string())?
}

/// =========================================================
/// 3. PERMANENT LIBRARY DOWNLOAD
/// =========================================================
#[tauri::command]
async fn save_to_library(app: AppHandle, video_id: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || fetch_audio(&app, &video_id, "library"))
        .await
        .map_err(|e| e.to_string())?
}

/// =========================================================
/// 4. DATABASE (playlists)
///    - never overwrites good data with an empty list
///    - keeps database.json.bak
///    - writes via temp file + rename (no half-written file on crash)
/// =========================================================
#[tauri::command]
async fn load_db(app: AppHandle) -> Result<String, String> {
    let dir = data_dir(&app, "runtime")?;
    let db = dir.join("database.json");
    let bak = dir.join("database.json.bak");

    match fs::read_to_string(&db) {
        Ok(raw) => {
            if is_valid_db(&raw) {
                return Ok(raw);
            }
            // Corrupted: keep the broken file for inspection instead of destroying it
            let stamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let _ = fs::rename(&db, dir.join(format!("database.corrupt-{}.json", stamp)));
        }
        // The file exists but cannot be read: fail loudly, do not fall back to an empty DB
        Err(e) if db.exists() => return Err(format!("Cannot read database: {}", e)),
        Err(_) => {} // first launch
    }

    // Try the backup
    if let Ok(raw) = fs::read_to_string(&bak) {
        if is_valid_db(&raw) {
            let _ = fs::write(&db, &raw);
            return Ok(raw);
        }
    }

    // Fresh start
    let _ = fs::write(&db, DEFAULT_DB);
    Ok(DEFAULT_DB.to_string())
}

#[tauri::command]
async fn save_db(app: AppHandle, data: String) -> Result<(), String> {
    if !is_valid_db(&data) {
        return Err("Refusing to save: data is not a valid playlist list".to_string());
    }

    let dir = data_dir(&app, "runtime")?;
    let db = dir.join("database.json");
    let tmp = dir.join("database.json.tmp");
    let bak = dir.join("database.json.bak");

    fs::write(&tmp, &data).map_err(|e| e.to_string())?;
    if db.exists() {
        let _ = fs::copy(&db, &bak);
    }
    fs::rename(&tmp, &db).map_err(|e| e.to_string())
}

/// =========================================================
/// 5. ENTRY POINT
/// =========================================================
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.maximize();
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            search_song,
            download_audio,
            save_to_library,
            load_db,
            save_db
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}