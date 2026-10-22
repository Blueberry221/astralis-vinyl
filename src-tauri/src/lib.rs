// <<PURE-START>>
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime};

/// A cached (temporary) song is deleted when it has not been played for this long.
const CACHE_TTL_SECS: u64 = 7 * 24 * 60 * 60; // 7 days
/// Anything smaller than this is a broken / half-finished download.
const MIN_AUDIO_BYTES: u64 = 10 * 1024;

/// YouTube ids are exactly 11 chars of [A-Za-z0-9_-]. Anything else is rejected
/// so it can never end up inside a file path or URL.
fn valid_video_id(id: &str) -> bool {
    id.len() == 11
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn audio_file(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{}.m4a", id))
}

/// A real, non-trivial audio file (not missing, not empty, not a half download).
fn is_usable(path: &Path) -> bool {
    fs::metadata(path)
        .map(|m| m.is_file() && m.len() >= MIN_AUDIO_BYTES)
        .unwrap_or(false)
}

/// Based on the file's last-modified time vs. the device clock.
/// If the clock looks wrong (file dated in the future) we keep the file.
fn is_expired(path: &Path) -> bool {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|modified| SystemTime::now().duration_since(modified).ok())
        .map(|age| age.as_secs() > CACHE_TTL_SECS)
        .unwrap_or(false)
}

/// Marks a cached song as "just played" so its expiry timer restarts.
fn touch(path: &Path) {
    if let Ok(file) = fs::OpenOptions::new().write(true).open(path) {
        let _ = file.set_modified(SystemTime::now());
    }
}

/// Library first (permanent), then cache (temporary, with expiry).
fn find_local_in(base: &Path, id: &str) -> Result<Option<PathBuf>, String> {
    if !valid_video_id(id) {
        return Err("Invalid video id".to_string());
    }

    let lib = audio_file(&base.join("library"), id);
    if is_usable(&lib) {
        return Ok(Some(lib));
    }

    let cache = audio_file(&base.join("cache"), id);
    if cache.exists() {
        if is_usable(&cache) && !is_expired(&cache) {
            touch(&cache);
            return Ok(Some(cache));
        }
        // expired or broken: remove it
        let _ = fs::remove_file(&cache);
    }

    Ok(None)
}

/// Returns the library copy; if only a cached copy exists, copies it into the
/// library (no second download). None means it must be downloaded.
fn promote_to_library_in(base: &Path, id: &str) -> Result<Option<PathBuf>, String> {
    if !valid_video_id(id) {
        return Err("Invalid video id".to_string());
    }

    let lib_dir = base.join("library");
    let lib = audio_file(&lib_dir, id);
    if is_usable(&lib) {
        return Ok(Some(lib));
    }

    let cache = audio_file(&base.join("cache"), id);
    if is_usable(&cache) {
        fs::create_dir_all(&lib_dir).map_err(|e| e.to_string())?;
        fs::copy(&cache, &lib).map_err(|e| e.to_string())?;
        return Ok(Some(lib));
    }

    Ok(None)
}

/// Cleans the cache folder. Removes (1) expired files and (2) songs that are
/// already saved in the library (the permanent copy makes the temporary one
/// pointless). Returns how many files were removed.
fn cleanup_cache_in(base: &Path) -> usize {
    let lib = base.join("library");
    let mut removed = 0;
    if let Ok(entries) = fs::read_dir(base.join("cache")) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let duplicate = path
                .file_name()
                .map(|name| is_usable(&lib.join(name)))
                .unwrap_or(false);
            if (duplicate || is_expired(&path)) && fs::remove_file(&path).is_ok() {
                removed += 1;
            }
        }
    }
    removed
}

/// Ids of all permanently downloaded songs.
fn list_library_ids_in(base: &Path) -> Vec<String> {
    let mut ids = Vec::new();
    if let Ok(entries) = fs::read_dir(base.join("library")) {
        for entry in entries.flatten() {
            let path = entry.path();
            let is_m4a = path.extension().and_then(|e| e.to_str()) == Some("m4a");
            if !is_m4a {
                continue;
            }
            if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                if valid_video_id(stem) && is_usable(&path) {
                    ids.push(stem.to_string());
                }
            }
        }
    }
    ids
}

/// Windows may still hold the file for a moment after the player stops,
/// so deletion is retried a few times.
fn remove_with_retry(path: &Path, retries: u32, delay: Duration) -> Result<(), String> {
    let mut attempt = 0;
    loop {
        match fs::remove_file(path) {
            Ok(_) => return Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => {
                attempt += 1;
                if attempt > retries {
                    return Err(format!("Cannot delete {}: {}", path.display(), e));
                }
                std::thread::sleep(delay);
            }
        }
    }
}

/// Removes a song from the library AND the cache.
fn delete_audio_in(base: &Path, id: &str) -> Result<(), String> {
    if !valid_video_id(id) {
        return Err("Invalid video id".to_string());
    }
    for folder in ["library", "cache"] {
        remove_with_retry(
            &audio_file(&base.join(folder), id),
            5,
            Duration::from_millis(300),
        )?;
    }
    Ok(())
}

/// Percent-encodes a search query for use inside a URL (no extra crates needed).
fn percent_encode(input: &str) -> String {
    let mut out = String::new();
    for byte in input.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{:02X}", byte)),
        }
    }
    out
}

/// Builds the yt-dlp arguments for a search.
///  - "music":   YouTube Music, "Songs" section only (no random videos)
///  - anything else: normal YouTube search (the UI filters non-music itself)
/// "--flat-playlist" returns the result list without opening every video,
/// which is what makes this much faster than the old "--dump-json" search.
fn search_args(query: &str, source: &str) -> Result<Vec<String>, String> {
    let cleaned: String = query.chars().filter(|c| !c.is_control()).collect();
    let q: String = cleaned.trim().chars().take(200).collect();
    if q.is_empty() {
        return Err("Empty query".to_string());
    }

    // The target always starts with "https://" or "ytsearch", so a query that
    // begins with "-" can never be mistaken for a yt-dlp option.
    let target = if source == "music" {
        format!(
            "https://music.youtube.com/search?q={}#songs",
            percent_encode(&q)
        )
    } else {
        format!("ytsearch20:{}", q)
    };

    let mut args: Vec<String> = [
        "--flat-playlist",
        "-j",
        "--no-warnings",
        "--ignore-errors",
        "--socket-timeout",
        "10",
        "--playlist-end",
        "20",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    args.push(target);
    Ok(args)
}

/// yt-dlp is asked to print "ASTRALIS <percent>" for every progress update.
/// "ASTRALIS  45.3%" -> Some(45.3). Any other line -> None.
fn parse_progress(line: &str) -> Option<f32> {
    let rest = line.trim().strip_prefix("ASTRALIS")?;
    let value: f32 = rest.trim().trim_end_matches('%').trim().parse().ok()?;
    if value.is_finite() {
        Some(value.clamp(0.0, 100.0))
    } else {
        None
    }
}

/// `yt-dlp -g` prints the direct media URL(s). Takes the first https one.
fn first_https_line(output: &str) -> Option<String> {
    output
        .lines()
        .map(str::trim)
        .find(|line| line.starts_with("https://"))
        .map(|line| line.to_string())
}

/// yt-dlp is checked for updates at most once a day.
const UPDATE_EVERY_SECS: u64 = 24 * 60 * 60;

/// True when the "last successful update" stamp is missing or older than a day.
fn update_due(stamp: &Path) -> bool {
    fs::metadata(stamp)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|modified| SystemTime::now().duration_since(modified).ok())
        .map(|age| age.as_secs() >= UPDATE_EVERY_SECS)
        .unwrap_or(true)
}

/// Songs that are being downloaded right now ("cache:ID" / "library:ID").
/// The stream's background cache, the prefetch and the Download button can all
/// ask for the same song; only one yt-dlp may write a given file at a time.
fn active_downloads() -> &'static Mutex<HashSet<String>> {
    static ACTIVE: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    ACTIVE.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Releases the claim on a song when dropped (also on errors and early returns).
struct DownloadGuard(String);

impl Drop for DownloadGuard {
    fn drop(&mut self) {
        let mut set = active_downloads().lock().unwrap_or_else(|e| e.into_inner());
        set.remove(&self.0);
    }
}

/// Some(guard) = you are the one who should download. None = someone else already is.
fn claim_download(key: &str) -> Option<DownloadGuard> {
    let mut set = active_downloads().lock().unwrap_or_else(|e| e.into_inner());
    if set.insert(key.to_string()) {
        Some(DownloadGuard(key.to_string()))
    } else {
        None
    }
}

// <<PURE-END>>

use std::io::{BufRead, BufReader, Read};
use std::process::{Command, Stdio};
use std::time::{Instant, UNIX_EPOCH};

// Windows-only: lets us hide the black console window when running yt-dlp
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use tauri::{AppHandle, Emitter, Manager};

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

/// Root app data folder (contains cache/, library/, runtime/).
fn app_base(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

/// App data subfolder (created if missing), e.g. "cache", "library", "runtime".
fn data_dir(app: &AppHandle, sub: &str) -> Result<PathBuf, String> {
    let dir = app_base(app)?.join(sub);
    fs::create_dir_all(&dir).map_err(|e| format!("Cannot create {}: {}", dir.display(), e))?;
    Ok(dir)
}

/// The yt-dlp to run: the self-updating copy in the app data folder when it
/// exists, otherwise the one bundled with the app.
fn yt_exe(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(base) = app_base(app) {
        let local = base.join("bin").join("yt-dlp.exe");
        if is_usable(&local) {
            return Ok(local);
        }
    }
    bin_path(app, "yt-dlp.exe")
}

/// A yt-dlp command with the console window hidden on Windows.
fn yt_command(app: &AppHandle) -> Result<Command, String> {
    let mut cmd = Command::new(yt_exe(app)?);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    Ok(cmd)
}

/// Downloads a song with yt-dlp into "cache" or "library".
/// `report` = send "download-progress" events to the UI while it downloads.
fn fetch_audio(
    app: &AppHandle,
    video_id: &str,
    folder: &str,
    report: bool,
) -> Result<String, String> {
    if !valid_video_id(video_id) {
        return Err("Invalid video id".to_string());
    }

    let dir = data_dir(app, folder)?;
    let file_path = audio_file(&dir, video_id);
    let done = |path: &Path| -> Result<String, String> { Ok(path.to_string_lossy().to_string()) };

    // One download per song at a time: if another one is already running for this
    // song, wait for it and use its result instead of starting a second yt-dlp.
    let key = format!("{}:{}", folder, video_id);
    let started = Instant::now();
    let _guard = loop {
        if is_usable(&file_path) {
            return done(&file_path);
        }
        if let Some(guard) = claim_download(&key) {
            break guard;
        }
        if started.elapsed() > Duration::from_secs(300) {
            return Err("Timed out waiting for another download of this song".to_string());
        }
        std::thread::sleep(Duration::from_millis(300));
    };
    if is_usable(&file_path) {
        return done(&file_path);
    }
    // leftover from a failed / interrupted download
    let _ = fs::remove_file(&file_path);

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
            // one "ASTRALIS 45.3%" line per progress update, read below
            "--newline",
            "--progress",
            "--progress-template",
            "download:ASTRALIS %(progress._percent_str)s",
        ])
        .arg(&url)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to run yt-dlp: {}", e))?;

    // stderr is drained on its own thread so yt-dlp can never block on a full pipe
    let stderr = child.stderr.take();
    let stderr_thread = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        if let Some(mut pipe) = stderr {
            let _ = pipe.read_to_end(&mut bytes);
        }
        String::from_utf8_lossy(&bytes).to_string()
    });

    let id = video_id.to_string();
    let emit = |percent: f32| {
        if report {
            let _ = app.emit(
                "download-progress",
                serde_json::json!({ "id": id, "percent": percent }),
            );
        }
    };
    emit(0.0);

    if let Some(out) = child.stdout.take() {
        let mut reader = BufReader::new(out);
        let mut buf = Vec::new();
        let mut last = -1.0_f32;
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let line = String::from_utf8_lossy(&buf);
                    if let Some(percent) = parse_progress(&line) {
                        // at most ~100 events per download
                        if percent >= last + 1.0 || (percent >= 100.0 && last < 100.0) {
                            last = percent;
                            emit(percent);
                        }
                    }
                }
            }
        }
        // keep reading to the end so yt-dlp is never stuck writing
        let _ = std::io::copy(&mut reader, &mut std::io::sink());
    }

    let status = child
        .wait()
        .map_err(|e| format!("yt-dlp did not finish: {}", e))?;
    let err = stderr_thread.join().unwrap_or_default();

    if status.success() && is_usable(&file_path) {
        emit(100.0);
        done(&file_path)
    } else if err.trim().is_empty() {
        Err("yt-dlp finished but no audio file was created".to_string())
    } else {
        Err(err)
    }
}

/// Keeps yt-dlp current: YouTube changes often and an old yt-dlp stops working.
/// The bundled copy may sit in a read-only folder (Program Files), so a writable
/// copy is made in the app data folder and updated there.
fn update_ytdlp(app: &AppHandle) -> Result<String, String> {
    let stamp = data_dir(app, "runtime")?.join("ytdlp-update.stamp");
    if !update_due(&stamp) {
        return Ok("checked recently".to_string());
    }

    let local = data_dir(app, "bin")?.join("yt-dlp.exe");
    if !is_usable(&local) {
        fs::copy(bin_path(app, "yt-dlp.exe")?, &local)
            .map_err(|e| format!("Cannot copy yt-dlp: {}", e))?;
    }

    let mut cmd = Command::new(&local);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let output = cmd
        .arg("-U")
        .output()
        .map_err(|e| format!("Failed to run yt-dlp -U: {}", e))?;

    if output.status.success() {
        let _ = fs::write(&stamp, b"ok");
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        // no internet / blocked: the stamp is not written, so it is retried next launch
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

fn is_valid_db(raw: &str) -> bool {
    serde_json::from_str::<Vec<serde_json::Value>>(raw).is_ok()
}

fn path_string(path: PathBuf) -> String {
    path.to_string_lossy().to_string()
}

/// =========================================================
/// 1. AUDIO SEARCH  (async: the window stays responsive)
/// =========================================================
#[tauri::command]
async fn search_song(
    app: AppHandle,
    query: String,
    source: Option<String>,
) -> Result<String, String> {
    let args = search_args(&query, source.as_deref().unwrap_or("youtube"))?;

    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let mut cmd = yt_command(&app)?;
        cmd.args(&args);

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

/// Direct audio URL of a song, so playback can start right away while the file
/// is still being cached. The link expires after a few hours.
#[tauri::command]
async fn get_stream_url(app: AppHandle, video_id: String) -> Result<String, String> {
    if !valid_video_id(&video_id) {
        return Err("Invalid video id".to_string());
    }

    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let mut cmd = yt_command(&app)?;
        cmd.args([
            "-g",
            "-f",
            "ba[ext=m4a]/ba/b",
            "--no-playlist",
            "--no-warnings",
            "--socket-timeout",
            "10",
            "--extractor-args",
            "youtube:player_client=android,web",
        ])
        .arg(format!("https://www.youtube.com/watch?v={}", video_id));

        let output = cmd
            .output()
            .map_err(|e| format!("Failed to run yt-dlp: {}", e))?;

        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        match first_https_line(&stdout) {
            Some(url) if output.status.success() => Ok(url),
            _ => {
                let err = String::from_utf8_lossy(&output.stderr).to_string();
                Err(if err.trim().is_empty() {
                    "yt-dlp returned no stream URL".to_string()
                } else {
                    err
                })
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// =========================================================
/// 2. LOCAL-FIRST LOOKUP
/// =========================================================

/// Path of the song if it is already on this device (library, then non-expired cache).
#[tauri::command]
async fn get_local_path(app: AppHandle, video_id: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Option<String>, String> {
        let base = app_base(&app)?;
        Ok(find_local_in(&base, &video_id)?.map(path_string))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Ids of all permanently downloaded songs (used for the "downloaded" badges).
#[tauri::command]
async fn list_library_ids(app: AppHandle) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<String>, String> {
        let base = app_base(&app)?;
        Ok(list_library_ids_in(&base))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// =========================================================
/// 3. DOWNLOADS
/// =========================================================

/// Temporary download: reuses a local copy if there is one, otherwise downloads into cache.
/// `silent: true` = no progress events (used when preloading the next song).
#[tauri::command]
async fn download_audio(
    app: AppHandle,
    video_id: String,
    silent: Option<bool>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let base = app_base(&app)?;
        if let Some(path) = find_local_in(&base, &video_id)? {
            return Ok(path_string(path));
        }
        fetch_audio(&app, &video_id, "cache", !silent.unwrap_or(false))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Permanent download: reuses the library copy, or promotes the cached copy, or downloads.
#[tauri::command]
async fn save_to_library(app: AppHandle, video_id: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let base = app_base(&app)?;
        if let Some(path) = promote_to_library_in(&base, &video_id)? {
            return Ok(path_string(path));
        }
        fetch_audio(&app, &video_id, "library", true)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Deletes the downloaded file (library and cache copies).
#[tauri::command]
async fn delete_from_library(app: AppHandle, video_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let base = app_base(&app)?;
        delete_audio_in(&base, &video_id)
    })
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

            // On every launch: delete cached songs that have expired (works offline,
            // uses only the file dates already on disk).
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                if let Ok(base) = app_base(&handle) {
                    cleanup_cache_in(&base);
                }
            });

            // A few seconds after launch: update yt-dlp if the last check was over a day ago
            let updater = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(8));
                match update_ytdlp(&updater) {
                    Ok(message) => println!("yt-dlp update: {}", message.trim()),
                    Err(err) => eprintln!("yt-dlp update skipped: {}", err.trim()),
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            search_song,
            get_stream_url,
            get_local_path,
            list_library_ids,
            download_audio,
            save_to_library,
            delete_from_library,
            load_db,
            save_db
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}