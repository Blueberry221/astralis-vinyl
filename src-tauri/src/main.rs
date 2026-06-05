#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::process::Command;
// [BARU] Import ekstensi khusus Windows untuk memanipulasi terminal
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use tauri::{command, AppHandle, Manager};

// [BARU] Kode ajaib untuk menyembunyikan terminal di Windows
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// =========================================================
/// 1. AUDIO SEARCH MODULE
/// =========================================================
#[command]
fn search_song(app: AppHandle, query: &str) -> Result<String, String> {
    let resource_dir = app.path().resource_dir().map_err(|e| e.to_string())?;
    let exe_path = resource_dir.join("bin").join("yt-dlp.exe");

    let mut cmd = Command::new(exe_path);
    
    // [BARU] Sembunyikan terminal saat mencari lagu
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let output = cmd
        .args(&[&format!("ytsearch5:{}", query), "--dump-json", "--no-playlist", "--ignore-errors"])
        .output()
        .map_err(|e| format!("Failed to run yt-dlp: {}", e))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

/// =========================================================
/// 2. CACHE AUDIO DOWNLOAD MODULE
/// =========================================================
#[command]
fn download_audio(app: AppHandle, video_id: &str) -> Result<String, String> {
    let resource_dir = app.path().resource_dir().map_err(|e| e.to_string())?;
    let exe_path = resource_dir.join("bin").join("yt-dlp.exe");
    let ffmpeg_path = resource_dir.join("bin").join("ffmpeg.exe");

    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let cache_dir = app_data_dir.join("cache");
    let _ = fs::create_dir_all(&cache_dir);

    let file_path = cache_dir.join(format!("{}.m4a", video_id));
    let target_url = format!("https://www.youtube.com/watch?v={}", video_id);

    let mut cmd = Command::new(exe_path);
    
    // [BARU] Sembunyikan terminal saat memproses audio
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let output = cmd
        .args(&[
            "--ffmpeg-location", ffmpeg_path.to_str().unwrap(),
            "-f", "ba/b", 
            "-o", file_path.to_str().unwrap(), 
            "--extract-audio", 
            "--audio-format", "m4a", 
            "--extractor-args", "youtube:player_client=android,web", 
            &target_url
        ])
        .output();

    match output {
        Ok(out) => if out.status.success() { Ok(file_path.to_string_lossy().to_string()) } else { Err(String::from_utf8_lossy(&out.stderr).to_string()) },
        Err(e) => Err(format!("Fatal Error: {}", e)),
    }
}

/// =========================================================
/// 3. PERMANENT LIBRARY DOWNLOAD MODULE
/// =========================================================
#[command]
fn save_to_library(app: AppHandle, video_id: &str) -> Result<String, String> {
    let resource_dir = app.path().resource_dir().map_err(|e| e.to_string())?;
    let exe_path = resource_dir.join("bin").join("yt-dlp.exe");
    let ffmpeg_path = resource_dir.join("bin").join("ffmpeg.exe");

    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let lib_dir = app_data_dir.join("library"); 
    let _ = fs::create_dir_all(&lib_dir);

    let file_path = lib_dir.join(format!("{}.m4a", video_id));
    let target_url = format!("https://www.youtube.com/watch?v={}", video_id);

    if file_path.exists() {
        return Ok(file_path.to_string_lossy().to_string());
    }

    let mut cmd = Command::new(exe_path);
    
    // [BARU] Sembunyikan terminal saat mengunduh lagu permanen
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let output = cmd
        .args(&[
            "--ffmpeg-location", ffmpeg_path.to_str().unwrap(),
            "-f", "ba/b", 
            "-o", file_path.to_str().unwrap(), 
            "--extract-audio", 
            "--audio-format", "m4a", 
            "--extractor-args", "youtube:player_client=android,web", 
            &target_url
        ])
        .output();

    match output {
        Ok(out) => if out.status.success() { Ok(file_path.to_string_lossy().to_string()) } else { Err(String::from_utf8_lossy(&out.stderr).to_string()) },
        Err(e) => Err(e.to_string()),
    }
}

/// =========================================================
/// 4. DATABASE MANAGER MODULE
/// =========================================================
#[command]
fn load_db(app: AppHandle) -> Result<String, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let runtime_dir = app_data_dir.join("runtime");
    let _ = fs::create_dir_all(&runtime_dir);

    let db_path = runtime_dir.join("database.json");

    if db_path.exists() {
        Ok(fs::read_to_string(db_path).unwrap_or_else(|_| "[]".to_string()))
    } else {
        let default_db = r#"[{"id":"downloaded","name":"Downloaded","desc":"Permanently downloaded songs","songs":[]}]"#;
        let _ = fs::write(&db_path, default_db);
        Ok(default_db.to_string())
    }
}

#[command]
fn save_db(app: AppHandle, data: &str) -> Result<(), String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let runtime_dir = app_data_dir.join("runtime");
    let _ = fs::create_dir_all(&runtime_dir);

    let db_path = runtime_dir.join("database.json");

    fs::write(db_path, data).map_err(|e| e.to_string())
}

/// =========================================================
/// 5. MAIN ENTRY POINT
/// =========================================================
fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let window = app.get_webview_window("main").unwrap();
            let _ = window.maximize();
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