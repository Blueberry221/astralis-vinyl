/**
 * ============================================================================
 * ASTRALIS VINYL - CORE JAVASCRIPT CONTROLLER
 * ============================================================================
 * Architecture Overview:
 * 1. Tauri Bindings & Global Context
 * 2. Data Structures (STATE, DOM, DATABASE)
 * 3. Utility & Core Services
 * 4. Audio Processing Engine
 * 5. Layout & UI Renderers (+ 5b. Search)
 * 6. Hardware & Media Events Bindings
 * 7. Visual Decorators (Clock, Quotes, Particles)
 * 8. Bootstrapper
 * ============================================================================
 */

// ============================================================================
// 1. TAURI BINDINGS
// ============================================================================
const invoke = window.__TAURI__?.core?.invoke || window.__TAURI__?.tauri?.invoke || async function () {};
const convertFileSrc = window.__TAURI__?.core?.convertFileSrc || window.__TAURI__?.tauri?.convertFileSrc || ((p) => p);
// Block the native context menu, except inside text fields (so paste still works)
document.addEventListener("contextmenu", (event) => {
  if (!event.target.closest("input, textarea")) event.preventDefault();
});

/** Escapes text before it is placed inside innerHTML (prevents broken UI / injection). */
const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const U = window.AstralisUtils; // from utils.js (loaded before this file)
document.addEventListener("DOMContentLoaded", async () => {
  // ==========================================================================
  // 2. DATA STRUCTURES
  // ==========================================================================

  /** * Application State Manager
   */
  const STATE = {
    isPlaying: false,
    playContext: "none", // Enum: 'none' | 'search' | 'playlist'
    repeatMode: "none", // Enum: 'none' | 'one' | 'all'
    currentQueue: [],
    currentSongIndex: -1,
    currentPlaylistId: null,
    activeSongToSave: null,
    previousVolume: 1,
    playToken: 0, // Incremented on every play request; stale requests are discarded
    currentSongId: null, // id of the song currently loaded in the player
    localIds: new Set(), // ids of permanently downloaded songs (for badges)
  };

  /** * Local Session Database
   */
  const DATABASE = {
    userPlaylists: [],
    recentSongs: [],
  };

  /** * Search page state (kept while you switch tabs, so results are not lost)
   */
  const SEARCH = {
    query: "",
    status: "idle", // 'idle' | 'loading' | 'done' | 'error'
    results: [],
    error: "",
    token: 0, // increases on every search; results of older searches are ignored
    history: U.loadHistory(),
    cache: U.createCache(10 * 60 * 1000, 30), // same query within 10 min = instant
    musicFails: 0, // after 2 failures in a row YouTube Music search is skipped for this session
  };

  /** * DOM Element Caching
   */
  const DOM = {
    // Audio Node
    audio: document.getElementById("audio-player"),

    // Player UI
    vinyl: document.getElementById("vinyl"),
    vinylContainer: document.querySelector(".vinyl-container"),
    progressRing: document.querySelector(".progress-ring__progress"),
    npContainer: document.querySelector(".now-playing"),
    timeDisplay: document.getElementById("time-display"),

    // Controls
    btnPlay: document.getElementById("play-pause-btn"),
    iconPlay: document.getElementById("play-icon"),
    btnPrev: document.getElementById("prev-btn"),
    btnNext: document.getElementById("next-btn"),
    btnRepeat: document.getElementById("repeat-btn"),
    volumeSlider: document.getElementById("volume-slider"),
    volumeBtn: document.querySelector(".volume-trigger-btn"),
    volumeIcon: document.querySelector(".volume-trigger-btn img"),
    volumeContainer: document.querySelector(".volume-hover-container"),

    // Layout Wrappers
    dynamicContent: document.getElementById("dynamic-content"),
    navItems: document.querySelectorAll(".top-nav li"),
  };

  const MAX_OFFSET = 1979; // Vinyl SVG circumference constant
  DOM.progressRing.style.strokeDashoffset = MAX_OFFSET;

  // ==========================================================================
  // 3. UTILITY & CORE SERVICES
  // ==========================================================================

  /**
   * Formats raw seconds into standard MM:SS string layout.
   * @param {number} seconds - The time in seconds.
   * @return {string} Formatted time string (e.g., "03:45").
   */
  const formatTime = (seconds) => {
    if (isNaN(seconds)) return "00:00";
    const m = Math.floor(seconds / 60)
      .toString()
      .padStart(2, "0");
    const s = Math.floor(seconds % 60)
      .toString()
      .padStart(2, "0");
    return `${m}:${s}`;
  };

  /**
   * Triggers custom asynchronous confirm dialog interface.
   * @param {string} title - The header title of the modal.
   * @param {string} message - The message body prompt.
   * @param {string} okLabel - Text of the confirm button (default "Delete").
   * @return {Promise<boolean>} True if user confirms, false otherwise.
   */
  function customConfirm(title, message, okLabel = "Delete") {
    return new Promise((resolve) => {
      const modal = document.getElementById("confirm-modal");
      document.getElementById("confirm-title").textContent = title;
      document.getElementById("confirm-message").textContent = message;
      modal.style.display = "flex";

      const okBtn = document.getElementById("confirm-ok");
      const cancelBtn = document.getElementById("confirm-cancel");
      okBtn.textContent = okLabel;

      const cleanup = () => {
        modal.style.display = "none";
        okBtn.onclick = null;
        cancelBtn.onclick = null;
      };

      okBtn.onclick = () => {
        cleanup();
        resolve(true);
      };
      cancelBtn.onclick = () => {
        cleanup();
        resolve(false);
      };
    });
  }

  /**
   * Commits the current DATABASE state to Rust backend.
   * @return {Promise<void>}
   */
  const saveDatabase = async () => { 
    try {
      await invoke("save_db", { data: JSON.stringify(DATABASE.userPlaylists) });
    } catch (err) {
      console.error("Database Save Error:", err);
    }
  };

  /** Saves the recent-songs list (localStorage). */
  const persistRecent = () => {
    try {
      localStorage.setItem("astralis_recent", JSON.stringify(DATABASE.recentSongs));
    } catch (err) {
      console.error("Could not save recent songs:", err);
    }
  };

  /** Reloads the set of permanently downloaded song ids from disk (used for badges). */
  const refreshLocalIds = async () => {
    try {
      STATE.localIds = new Set(await invoke("list_library_ids"));
    } catch (err) {
      console.error("Could not read library:", err);
    }
  };
  const DL_BADGE_HTML = `<span class="dl-badge">✓ DOWNLOADED</span>`;

  // ==========================================================================
  // 4. AUDIO PROCESSING ENGINE
  // ==========================================================================

  /**
   * Main execution bridge for loading and playing audio tracks.
   * Handles UI crossfading, metadata extraction, and backend stream calls.
   * @param {Object} song - The song metadata payload.
   * @param {boolean} isFromLibrary - Unused now: the backend always checks the library,
   *   then the (non-expired) cache, and only downloads when the song is not on the device.
   */
  async function executePlay(song, isFromLibrary) {
    // Every request gets a token; if a newer request starts, older ones stop silently.
    const token = ++STATE.playToken;
    STATE.currentSongId = song.id;

    // 1. Crossfade Out UI
    DOM.npContainer.style.opacity = 0;

    // Remove active styling from all list cards, highlight the current one
    document.querySelectorAll(".song-card").forEach((c) => c.classList.remove("now-playing-active"));
    const activeCard = document.getElementById(`card-${song.id}`);
    if (activeCard) activeCard.classList.add("now-playing-active");

    // 2. Wait for CSS transition sync (400ms)
    setTimeout(async () => {
      if (token !== STATE.playToken) return; // a newer song was requested meanwhile
      DOM.audio.pause();
      DOM.audio.removeAttribute("src");
      DOM.audio.load();
      DOM.progressRing.style.strokeDashoffset = MAX_OFFSET;
      DOM.timeDisplay.textContent = "00:00 / 00:00";

      // Inject Metadata
      const title = song.track || song.title || "Unknown Title";
      const artist = song.artist || song.uploader || "Unknown Artist";
      let cover = song.thumbnail || song.cover || "";
      if (!cover && song.thumbnails && song.thumbnails.length > 0) cover = song.thumbnails[song.thumbnails.length - 1].url;

      document.getElementById("np-title").textContent = title;
      document.getElementById("np-artist").textContent = "Loading audio... ⏳";
      if (cover) {
        document.getElementById("np-cover").src = cover;
        document.getElementById("np-cover").style.display = "block";
        document.getElementById("cover").src = cover;
        document.getElementById("cover").style.display = "block";
      }

      // 3. Crossfade In UI
      DOM.npContainer.style.opacity = 1;

      // 4. Backend Call & Execution
      try {
        // Local first: library, then non-expired cache. Download only if it is not on the device.
        let absolutePath = await invoke("get_local_path", { videoId: song.id });
        if (!absolutePath) {
          if (token !== STATE.playToken) return;
          document.getElementById("np-artist").textContent = "Downloading... ⏳";
          absolutePath = await invoke("download_audio", { videoId: song.id });
        }

        if (token !== STATE.playToken) return; // user picked another song while this one loaded

        DOM.audio.src = convertFileSrc(absolutePath);
        await DOM.audio.play();
        if (token !== STATE.playToken) return;

        // isPlaying / vinyl / play icon are updated by the audio "play" event listener
        document.getElementById("np-artist").textContent = artist;

        // Push to Recent History (compact copy: id, title, artist, thumbnail, duration)
        DATABASE.recentSongs = DATABASE.recentSongs.filter((s) => s.id !== song.id);
        DATABASE.recentSongs.unshift(U.compactSong(song));
        if (DATABASE.recentSongs.length > 10) DATABASE.recentSongs.pop();
        persistRecent();
      } catch (error) {
        if (token !== STATE.playToken) return; // ignore errors from superseded requests
        document.getElementById("np-artist").textContent = "❌ Failed to play";
        console.error(error);
      }
    }, 400);
  }

  // ==========================================================================
  // 5. LAYOUT & UI RENDERERS
  // ==========================================================================

  /**
   * Top-level content router. Swaps main view panels smoothly.
   * @param {string} page - The target route identifier ('home' | 'search' | 'playlist').
   */
  function renderPage(page) {
    DOM.dynamicContent.style.opacity = 0;

    if (page === "home") document.documentElement.style.setProperty("--bg-color", "var(--bg-home)");
    else if (page === "search") document.documentElement.style.setProperty("--bg-color", "var(--bg-search)");
    else if (page === "playlist") document.documentElement.style.setProperty("--bg-color", "var(--bg-playlist)");

    setTimeout(() => {
      if (page === "home") {
        DOM.dynamicContent.innerHTML = `
          <div class="playlist-header-actions">
            <div><h1 class="view-title">RECENT SONGS</h1><hr class="title-divider" style="margin-bottom:0;"/></div>
            ${DATABASE.recentSongs.length ? `<button class="create-playlist-btn" id="clear-recent-btn">Clear all</button>` : ""}
          </div>
          <div class="playlist-container" id="recent-container"></div>
        `;
        renderPlaylistCards(DATABASE.recentSongs, document.getElementById("recent-container"), "home", "recent");

        const clearBtn = document.getElementById("clear-recent-btn");
        if (clearBtn)
          clearBtn.onclick = async () => {
            const ok = await customConfirm(
              "Clear Recent Songs",
              "Remove every song from this list? Your downloads and playlists are not affected.",
              "Clear"
            );
            if (!ok) return;
            DATABASE.recentSongs = [];
            persistRecent();
            renderPage("home");
          };
      } else if (page === "playlist") {
        DOM.dynamicContent.innerHTML = `
          <div class="playlist-header-actions">
            <div><h1 class="view-title">PLAYLISTS</h1><hr class="title-divider" style="margin-bottom:0;"/></div>
            <button class="create-playlist-btn" id="create-playlist-btn"><img src="assets/more.png" alt="+"> Create Playlist</button>
          </div>
          <div class="playlist-container" id="playlist-folder-container"></div>
        `;

        const container = document.getElementById("playlist-folder-container");
        DATABASE.userPlaylists.forEach((pl) => {
          const folder = document.createElement("div");
          folder.className = "playlist-folder-card";
          folder.innerHTML = `
            <div class="folder-icon"><img src="assets/icon.jpg" alt="Dir"></div>
            <div class="folder-info">
              <span class="folder-name">${esc(pl.name)} <span style="font-size:0.8rem; font-weight:normal;">(${pl.songs.length} songs)</span></span>
              <span class="folder-desc">${esc(pl.desc)}</span>
            </div>
          `;
          folder.onclick = () => renderPlaylistDetail(pl.id);
          container.appendChild(folder);
        });

        // Modals bind
        const modal = document.getElementById("playlist-modal");
        document.getElementById("create-playlist-btn").onclick = () => (modal.style.display = "flex");
        document.getElementById("cancel-playlist-btn").onclick = () => {
          modal.style.display = "none";
        };
        document.getElementById("save-playlist-btn").onclick = async () => {
          const name = document.getElementById("playlist-name-input").value.trim();
          const desc = document.getElementById("playlist-desc-input").value.trim();
          if (!name) return alert("Name cannot be empty!");
          DATABASE.userPlaylists.push({ id: "pl_" + Date.now(), name, desc, songs: [] });
          await saveDatabase();
          modal.style.display = "none";
          document.getElementById("playlist-name-input").value = "";
          document.getElementById("playlist-desc-input").value = "";
          renderPage("playlist");
        };
      } else if (page === "search") {
        DOM.dynamicContent.innerHTML = `
          <h1 class="view-title">SEARCH</h1>
          <hr class="title-divider" />
          <div class="search-container">
            <input type="text" id="search-input" class="search-input" placeholder="Search for a song or an artist..." autocomplete="off" spellcheck="false" maxlength="200" />
            <button id="search-btn" class="search-btn" aria-label="Search"><img src="assets/search.png" alt="Search"></button>
          </div>
          <div id="search-history" class="search-history" hidden></div>
          <div id="search-results-container" class="playlist-container"></div>
        `;
        initSearchPage();
      }
      DOM.dynamicContent.style.opacity = 1;
    }, 400);
  }

  /**
   * Renders the inside view of a specific playlist folder.
   * @param {string} playlistId - The ID of the playlist to display.
   */
  function renderPlaylistDetail(playlistId) {
    const playlist = DATABASE.userPlaylists.find((p) => p.id === playlistId);
    if (!playlist) return;

    DOM.dynamicContent.style.opacity = 0;
    setTimeout(() => {
      DOM.dynamicContent.innerHTML = `
        <div class="playlist-detail-hero">
          <div class="playlist-detail-top">
            <button id="back-to-playlists" class="back-btn"><img src="assets/back.png"> Back</button>
            ${playlist.id !== "downloaded" ? `<button id="delete-playlist-btn" class="delete-playlist-btn"><img src="assets/delete.png"> Delete Playlist</button>` : ""}
          </div>
          <div class="playlist-meta">
            <div class="playlist-cover-large"><img src="assets/icon.jpg"></div>
            <div class="playlist-texts">
              <span class="playlist-label">PLAYLIST</span>
              <h1 class="playlist-big-title">${esc(playlist.name)}</h1>
              <p class="playlist-big-desc">${esc(playlist.desc) || "No description."}</p>
              <div class="playlist-stats">${playlist.songs.length} songs</div>
            </div>
          </div>
        </div>
        <div class="playlist-container" id="playlist-detail-container"></div>
      `;

      document.getElementById("back-to-playlists").onclick = () => renderPage("playlist");

      const deletePlaylistBtn = document.getElementById("delete-playlist-btn");
      if (deletePlaylistBtn) {
        deletePlaylistBtn.onclick = async () => {
          const confirmDelete = await customConfirm("Delete Playlist", `Delete playlist '${playlist.name}' permanently?`); // customConfirm uses textContent, safe
          if (!confirmDelete) return;
          DATABASE.userPlaylists = DATABASE.userPlaylists.filter((p) => p.id !== playlist.id);
          await saveDatabase();
          renderPage("playlist");
        };
      }

      renderPlaylistCards(playlist.songs, document.getElementById("playlist-detail-container"), "playlist", playlist.id);
      DOM.dynamicContent.style.opacity = 1;
    }, 400);
  }

  /**
   * Reusable card component generator.
   * Scans array and appends song HTML nodes along with their bound event listeners.
   * @param {Array} data - Parsed JSON array of songs.
   * @param {HTMLElement} container - Wrapper target.
   * @param {string} viewContext - Determines action buttons layout.
   * @param {string} playlistId - ID for local deletion context.
   */
  function renderPlaylistCards(data, container, viewContext = "playlist", playlistId = null) {
    container.innerHTML = "";
    if (data.length === 0) {
      container.innerHTML = `<p style="opacity:0.7; font-style:italic;">No songs here yet.</p>`;
      return;
    }

    data.forEach((song) => {
      const title = song.track || song.title || "Unknown Title";
      const artist = song.artist || song.uploader || "Unknown Artist";
      let cover = song.thumbnail || song.cover || "";
      if (!cover && song.thumbnails && song.thumbnails.length > 0) cover = song.thumbnails[song.thumbnails.length - 1].url;

      const durationText = U.formatDuration(song.duration);
      const isDownloaded = STATE.localIds.has(song.id);
      const showBadge = isDownloaded && !(viewContext === "playlist" && playlistId === "downloaded");

      const downloadBtnHTML = `<button class="action-btn download-btn" title="${isDownloaded ? "Downloaded" : "Download (keep permanently)"}"><img src="assets/${isDownloaded ? "check" : "download"}.png"></button>`;
      const addBtnHTML = `<button class="action-btn add-btn" title="Add to playlist"><img src="assets/more.png"></button>`;

      let actionButtonsHTML = "";
      if (viewContext === "search") {
        actionButtonsHTML = downloadBtnHTML + addBtnHTML;
      } else if (viewContext === "home") {
        actionButtonsHTML = downloadBtnHTML + addBtnHTML + `<button class="action-btn remove-recent-btn" title="Remove from recent"><img src="assets/close.png"></button>`;
      } else {
        actionButtonsHTML = `<button class="action-btn delete-btn"><img src="assets/delete.png"></button>`;
      }

      const card = document.createElement("div");
      card.className = "song-card";
      card.id = `card-${song.id}`;
      card.innerHTML = `
        <img src="${esc(cover)}" class="song-cover">
        <div class="song-info">
          <span class="song-title">${esc(title)}</span>
          <span class="song-artist">${esc(artist)}${durationText ? `<span class="song-dur"> · ${durationText}</span>` : ""}</span>
          ${showBadge ? DL_BADGE_HTML : ""}
        </div>
        <div class="song-actions">${actionButtonsHTML}</div>
      `;

      // Hide the cover if the image fails to load (inline onerror is blocked by the CSP)
      card.querySelector(".song-cover").addEventListener("error", (e) => (e.target.style.display = "none"));

      // -- CARD ACTIONS BINDING --
      const dlBtn = card.querySelector(".download-btn");
      if (dlBtn) {
        if (isDownloaded) dlBtn.dataset.done = "1";
        dlBtn.onclick = async (e) => {
          e.stopPropagation();
          if (dlBtn.dataset.done || dlBtn.dataset.busy) return; // already saved / in progress
          dlBtn.dataset.busy = "1";
          dlBtn.innerHTML = "⏳";
          try {
            await invoke("save_to_library", { videoId: song.id });
            let dlPlaylist = DATABASE.userPlaylists.find((p) => p.id === "downloaded");
            if (!dlPlaylist) {
              // Self-heal: recreate the system playlist if it is missing from the DB
              dlPlaylist = { id: "downloaded", name: "Downloaded", desc: "Permanently downloaded songs", songs: [] };
              DATABASE.userPlaylists.unshift(dlPlaylist);
            }
            if (!dlPlaylist.songs.some((s) => s.id === song.id)) {
              dlPlaylist.songs.push(U.compactSong(song));
              await saveDatabase();
            }
            STATE.localIds.add(song.id);
            dlBtn.dataset.done = "1";
            dlBtn.innerHTML = `<img src="assets/check.png">`;
            if (!card.querySelector(".dl-badge")) card.querySelector(".song-info").insertAdjacentHTML("beforeend", DL_BADGE_HTML);
          } catch (err) {
            console.error(err);
            dlBtn.innerHTML = "❌"; // click again to retry
          } finally {
            delete dlBtn.dataset.busy;
          }
        };
      }

      const rmBtn = card.querySelector(".remove-recent-btn");
      if (rmBtn)
        rmBtn.onclick = (e) => {
          e.stopPropagation();
          DATABASE.recentSongs = DATABASE.recentSongs.filter((s) => s.id !== song.id);
          persistRecent();
          card.remove();
          // Last one removed: redraw the page (empty message, "Clear all" button disappears)
          if (!container.querySelector(".song-card")) renderPage("home");
        };

      const addBtn = card.querySelector(".add-btn");
      if (addBtn)
        addBtn.onclick = (e) => {
          e.stopPropagation();
          STATE.activeSongToSave = song;
          const optionsContainer = document.getElementById("playlist-options-container");
          optionsContainer.innerHTML = "";
          DATABASE.userPlaylists.forEach((pl) => {
            if (pl.id !== "downloaded") {
              const isAdded = pl.songs.some((s) => s.id === song.id);
              const btn = document.createElement("button");
              btn.className = "playlist-option-btn";
              btn.innerHTML = `<span><img src="assets/icon.jpg" style="width:16px; margin-right:8px; vertical-align:middle;"> ${esc(pl.name)}</span> <img src="assets/${isAdded ? "check" : "more"}.png">`;
              if (isAdded) btn.classList.add("success");
              btn.onclick = async () => {
                if (!pl.songs.some((s) => s.id === song.id)) {
                  pl.songs.push(U.compactSong(STATE.activeSongToSave));
                  await saveDatabase();
                  btn.classList.add("success");
                  btn.innerHTML = `<span><img src="assets/icon.jpg" style="width:16px; margin-right:8px; vertical-align:middle;"> ${esc(pl.name)}</span> <img src="assets/check.png">`;
                }
              };
              optionsContainer.appendChild(btn);
            }
          });
          document.getElementById("select-playlist-modal").style.display = "flex";
        };

      const delBtn = card.querySelector(".delete-btn");
      if (delBtn)
        delBtn.onclick = async (e) => {
          e.stopPropagation();
          const fromDownloads = playlistId === "downloaded";
          const ok = await customConfirm(
            fromDownloads ? "Delete Download" : "Remove Song",
            fromDownloads ? `Delete "${title}" from your device?` : `Remove "${title}" from this playlist?`,
            fromDownloads ? "Delete" : "Remove"
          );
          if (!ok) return;

          const target = DATABASE.userPlaylists.find((p) => p.id === playlistId);
          if (!target) return;
          target.songs = target.songs.filter((s) => s.id !== song.id);
          await saveDatabase();
          card.remove();

          // Stop and release the file first if this song is the one currently loaded
          if (STATE.currentSongId === song.id) {
            STATE.playToken++; // cancel any in-flight load for this song
            STATE.currentSongId = null;
            DOM.audio.pause();
            DOM.audio.removeAttribute("src");
            DOM.audio.load();
            STATE.currentQueue = [];
            STATE.currentSongIndex = -1;
            DOM.progressRing.style.strokeDashoffset = MAX_OFFSET;
            DOM.timeDisplay.textContent = "00:00 / 00:00";
            document.getElementById("np-title").textContent = "Welcome back~";
            document.getElementById("np-artist").textContent = "Astralis Station";
            document.getElementById("np-cover").style.display = "none";
            document.getElementById("cover").style.display = "none";
          }

          // Removing from "Downloaded" also deletes the audio file from disk
          if (fromDownloads) {
            try {
              await invoke("delete_from_library", { videoId: song.id });
              STATE.localIds.delete(song.id);
            } catch (err) {
              console.error("Could not delete the file:", err);
            }
          }
        };

      // Play Execution Trigger
      card.addEventListener("click", () => {
        STATE.playContext = viewContext === "search" ? "search" : "playlist";
        DOM.btnPrev.disabled = DOM.btnNext.disabled = STATE.playContext === "search";

        if (STATE.playContext === "search") {
          STATE.repeatMode = "none";
          DOM.btnRepeat.style.opacity = "0.5";
          DOM.btnRepeat.querySelector("img").src = "assets/repeat.png";
          STATE.currentQueue = [];
          STATE.currentSongIndex = -1;
          STATE.currentPlaylistId = null;
        } else {
          DOM.btnRepeat.style.cursor = "pointer";
          STATE.currentQueue = data;
          STATE.currentSongIndex = data.findIndex((s) => s.id === song.id);
          STATE.currentPlaylistId = playlistId;
        }
        executePlay(song, viewContext === "playlist" && playlistId === "downloaded");
      });

      container.appendChild(card);
    });
  }

  // ==========================================================================
  // 5b. SEARCH  (history, result cache, skeleton loading, music-first + fallback)
  // ==========================================================================

  const skeletonHTML = (count = 6) =>
    Array.from(
      { length: count },
      () => `<div class="skeleton-card"><div class="sk-cover"></div><div class="sk-lines"><div class="sk-line w70"></div><div class="sk-line w40"></div></div></div>`
    ).join("");

  const friendlySearchError = (err) =>
    /failed to run yt-dlp/i.test(String(err))
      ? "The search engine (yt-dlp) could not start."
      : "Search failed. Check your internet connection and try again.";

  /**
   * Gets songs for a query. YouTube Music ("Songs" only) is tried first so you do not
   * get random videos; normal YouTube search (filtered) is the fallback.
   */
  async function fetchSongs(query) {
    const key = query.toLowerCase();
    const cached = SEARCH.cache.get(key);
    if (cached) return cached;

    let results = [];
    if (SEARCH.musicFails < 2) {
      try {
        const raw = await invoke("search_song", { query, source: "music" });
        results = U.processSearch(raw, "music", query);
        SEARCH.musicFails = 0;
      } catch (err) {
        SEARCH.musicFails++;
        console.warn("YouTube Music search failed, falling back to YouTube:", err);
      }
    }
    if (results.length === 0) {
      const raw = await invoke("search_song", { query, source: "youtube" });
      results = U.processSearch(raw, "youtube", query);
    }
    if (results.length > 0) SEARCH.cache.set(key, results);
    return results;
  }

  /** Draws the search results area from SEARCH.status. Safe to call when the tab is not open. */
  function paintSearch() {
    const box = document.getElementById("search-results-container");
    if (!box) return; // user is on another tab: it is drawn again when they come back

    if (SEARCH.status === "loading") {
      box.innerHTML = skeletonHTML();
    } else if (SEARCH.status === "error") {
      box.innerHTML = `<div class="search-state"><p>${esc(SEARCH.error)}</p><button class="create-playlist-btn" id="search-retry" style="margin:0 auto;">Try again</button></div>`;
      document.getElementById("search-retry").onclick = () => doSearch(SEARCH.query);
    } else if (SEARCH.status === "done") {
      if (SEARCH.results.length === 0) {
        box.innerHTML = `<div class="search-state"><p>No songs found for “${esc(SEARCH.query)}”.</p><p class="hint">Try the song title together with the artist name.</p></div>`;
      } else {
        renderPlaylistCards(SEARCH.results, box, "search");
      }
    } else {
      box.innerHTML = `<div class="search-state"><p>Search for a song or an artist.</p><p class="hint">Songs first: YouTube Music is searched before regular YouTube.</p></div>`;
    }
  }

  async function doSearch(rawQuery) {
    const query = String(rawQuery || "").trim().replace(/\s+/g, " ").slice(0, 200);
    if (!query) return;
    if (SEARCH.status === "loading" && SEARCH.query.toLowerCase() === query.toLowerCase()) return; // already running

    const input = document.getElementById("search-input");
    if (input) input.value = query;
    const historyBox = document.getElementById("search-history");
    if (historyBox) historyBox.hidden = true;

    SEARCH.query = query;
    SEARCH.status = "loading";
    SEARCH.results = [];
    const token = ++SEARCH.token;
    paintSearch();

    try {
      const results = await fetchSongs(query);
      if (token !== SEARCH.token) return; // a newer search was started meanwhile
      SEARCH.results = results;
      SEARCH.status = "done";
      if (results.length > 0) {
        SEARCH.history = U.addToHistory(SEARCH.history, query);
        U.saveHistory(SEARCH.history);
      }
    } catch (err) {
      if (token !== SEARCH.token) return;
      console.error("Search error:", err);
      SEARCH.status = "error";
      SEARCH.error = friendlySearchError(err);
    }
    paintSearch();
  }

  /** Recent-search chips under the search box (filtered by what is typed). */
  function renderSearchHistory() {
    const box = document.getElementById("search-history");
    const input = document.getElementById("search-input");
    if (!box || !input) return;

    const typed = input.value.trim().toLowerCase();
    const visible = document.activeElement === input || SEARCH.status === "idle";
    const items = SEARCH.history.filter((h) => h.toLowerCase() !== typed && h.toLowerCase().includes(typed));
    if (!visible || items.length === 0) {
      box.hidden = true;
      return;
    }

    box.hidden = false;
    box.innerHTML = `
      <div class="sh-head"><span>RECENT SEARCHES</span><button class="sh-clear" id="sh-clear">Clear</button></div>
      <div class="sh-chips">${items
        .map(
          (h) =>
            `<span class="sh-chip" data-q="${esc(h)}"><span class="sh-text">${esc(h)}</span><button class="sh-x" data-del="${esc(h)}" aria-label="Remove ${esc(h)} from history" title="Remove">×</button></span>`
        )
        .join("")}</div>`;
  }

  function initSearchPage() {
    const input = document.getElementById("search-input");
    const box = document.getElementById("search-history");
    input.value = SEARCH.query; // coming back from another tab keeps your last search

    document.getElementById("search-btn").onclick = () => doSearch(input.value);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") doSearch(input.value);
    });
    input.addEventListener("focus", renderSearchHistory);
    input.addEventListener("input", renderSearchHistory);
    input.addEventListener("blur", () => setTimeout(renderSearchHistory, 0));

    box.addEventListener("mousedown", (e) => e.preventDefault()); // keep the cursor in the input
    box.addEventListener("click", (e) => {
      const del = e.target.closest("[data-del]");
      if (del) {
        SEARCH.history = SEARCH.history.filter((h) => h !== del.dataset.del);
        U.saveHistory(SEARCH.history);
        renderSearchHistory();
        return;
      }
      if (e.target.closest("#sh-clear")) {
        SEARCH.history = [];
        U.saveHistory(SEARCH.history);
        renderSearchHistory();
        return;
      }
      const chip = e.target.closest("[data-q]");
      if (chip) doSearch(chip.dataset.q);
    });

    paintSearch();
    renderSearchHistory();
    if (SEARCH.status === "idle") input.focus();
  }

  // ==========================================================================
  // 6. HARDWARE & MEDIA EVENTS BINDINGS
  // ==========================================================================

  let volumeClickTimeout = null;
  let volumeClickCount = 0;

  DOM.volumeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    volumeClickCount++;

    if (volumeClickCount === 1) {
      volumeClickTimeout = setTimeout(() => {
        DOM.volumeContainer.classList.toggle("active");
        volumeClickCount = 0;
      }, 250);
    } else if (volumeClickCount === 2) {
      clearTimeout(volumeClickTimeout);
      volumeClickCount = 0;

      if (DOM.audio.volume > 0) {
        // Proses Mute
        STATE.previousVolume = DOM.audio.volume;
        DOM.audio.volume = 0;
        DOM.volumeSlider.value = 0;
        DOM.volumeIcon.src = "assets/no-volume.png";
      } else {
        // Proses Unmute (Kembali ke volume awal)
        DOM.audio.volume = STATE.previousVolume || 1;
        DOM.volumeSlider.value = DOM.audio.volume;
        DOM.volumeIcon.src = "assets/max-volume.png";
      }
    }
  });

  DOM.volumeSlider.addEventListener("input", (e) => {
    DOM.audio.volume = e.target.value;
    if (DOM.audio.volume == 0) {
      DOM.volumeIcon.src = "assets/no-volume.png";
    } else {
      DOM.volumeIcon.src = "assets/max-volume.png";
      STATE.previousVolume = DOM.audio.volume;
    }
  });

  document.addEventListener("click", (e) => {
    if (DOM.volumeContainer && !DOM.volumeContainer.contains(e.target)) {
      DOM.volumeContainer.classList.remove("active");
    }
  });

  DOM.btnPlay.addEventListener("click", () => {
    if (!DOM.audio.getAttribute("src")) return;
    // UI state is updated by the audio "play" / "pause" listeners below
    if (DOM.audio.paused) DOM.audio.play().catch(console.error);
    else DOM.audio.pause();
  });

  // Single source of truth for play state: the <audio> element's own events
  const syncPlayingUI = (playing) => {
    STATE.isPlaying = playing;
    DOM.vinyl.classList.toggle("playing", playing);
    DOM.iconPlay.src = playing ? "assets/pause.png" : "assets/play.png";
  };
  DOM.audio.addEventListener("play", () => syncPlayingUI(true));
  DOM.audio.addEventListener("pause", () => syncPlayingUI(false));
  DOM.audio.addEventListener("error", () => {
    if (!DOM.audio.getAttribute("src")) return; // we cleared it ourselves
    syncPlayingUI(false);
    document.getElementById("np-artist").textContent = "❌ Failed to play";
  });

  DOM.btnNext.addEventListener("click", () => {
    if (STATE.playContext === "search" || STATE.currentQueue.length === 0) return;
    let nextIndex = STATE.currentSongIndex + 1;
    if (nextIndex >= STATE.currentQueue.length) {
      if (STATE.repeatMode === "all") nextIndex = 0;
      else return;
    }
    STATE.currentSongIndex = nextIndex;
    executePlay(STATE.currentQueue[nextIndex], STATE.currentPlaylistId === "downloaded");
  });

  DOM.btnPrev.addEventListener("click", () => {
    if (STATE.playContext === "search" || STATE.currentQueue.length === 0) return;
    if (DOM.audio.currentTime > 3) {
      DOM.audio.currentTime = 0;
      return;
    }
    let prevIndex = STATE.currentSongIndex - 1;
    if (prevIndex < 0) {
      if (STATE.repeatMode === "all") prevIndex = STATE.currentQueue.length - 1;
      else prevIndex = 0;
    }
    STATE.currentSongIndex = prevIndex;
    executePlay(STATE.currentQueue[prevIndex], STATE.currentPlaylistId === "downloaded");
  });

  DOM.btnRepeat.addEventListener("click", () => {
    if (STATE.playContext === "search") return;
    const repImg = DOM.btnRepeat.querySelector("img");
    if (STATE.repeatMode === "none") {
      STATE.repeatMode = "one";
      DOM.btnRepeat.style.opacity = "1";
      repImg.src = "assets/repeat-one.png";
    } else if (STATE.repeatMode === "one") {
      STATE.repeatMode = "all";
      DOM.btnRepeat.style.opacity = "1";
      repImg.src = "assets/repeat.png";
    } else {
      STATE.repeatMode = "none";
      DOM.btnRepeat.style.opacity = "0.5";
      repImg.src = "assets/repeat.png";
    }
  });

  DOM.audio.addEventListener("timeupdate", () => {
    if (DOM.audio.duration) {
      const percent = DOM.audio.currentTime / DOM.audio.duration;
      DOM.progressRing.style.strokeDashoffset = MAX_OFFSET - percent * (MAX_OFFSET / 4);
      DOM.timeDisplay.textContent = `${formatTime(DOM.audio.currentTime)} / ${formatTime(DOM.audio.duration)}`;
    }
  });

  DOM.audio.addEventListener("ended", () => {
    if (STATE.repeatMode === "one") {
      DOM.audio.currentTime = 0;
      DOM.audio.play().catch(console.error);
    } else if (STATE.playContext !== "search" && STATE.currentQueue.length > 0) {
      let nextIndex = STATE.currentSongIndex + 1;
      if (nextIndex >= STATE.currentQueue.length) {
        if (STATE.repeatMode === "all") {
          STATE.currentSongIndex = 0;
          executePlay(STATE.currentQueue[0], STATE.currentPlaylistId === "downloaded");
        } else {
          DOM.progressRing.style.strokeDashoffset = MAX_OFFSET;
        }
      } else {
        STATE.currentSongIndex = nextIndex;
        executePlay(STATE.currentQueue[nextIndex], STATE.currentPlaylistId === "downloaded");
      }
    } else {
      DOM.progressRing.style.strokeDashoffset = MAX_OFFSET;
    }
  });

  /** Scrubbing Vinyl Seek Mechanism */
  const handleSeek = (e) => {
    if (!DOM.audio.getAttribute("src") || !DOM.audio.duration) return;
    const rect = DOM.vinylContainer.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    let angle = Math.atan2(e.clientY - cy, e.clientX - cx) * (180 / Math.PI) + 90;
    if (angle < 0) angle += 360;
    let percent = Math.min(Math.max(angle / 90, 0), 1);
    DOM.audio.currentTime = DOM.audio.duration * percent;
  };
  DOM.vinylContainer.addEventListener("mousedown", (e) => {
    e.preventDefault(); // stops text/image selection while dragging on the vinyl
    handleSeek(e);
    const onMouseMove = (ev) => handleSeek(ev);
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", () => document.removeEventListener("mousemove", onMouseMove), { once: true });
  });

  // ==========================================================================
  // 7. VISUAL DECORATORS
  // ==========================================================================

  /**
   * Dot-Matrix Station Time Engine. Evaluates date obj every second.
   */
  function updateStationClock() {
    const now = new Date();
    let h = now.getHours();
    const ampm = h >= 12 ? "PM" : "AM";
    h = h % 12 || 12;
    const m = now.getMinutes().toString().padStart(2, "0");
    const days = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"];
    const months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

    const hmElem = document.getElementById("hour-min");
    if (hmElem) {
      hmElem.textContent = `${h}:${m}`;
      document.getElementById("am-pm").textContent = ampm;
      document.getElementById("day-name").textContent = days[now.getDay()];
      document.getElementById("date-num").textContent = `${months[now.getMonth()]} ${now.getDate()}`;
    }
  }
  setInterval(updateStationClock, 1000);
  updateStationClock();

  /**
   * Randomized Quote Carousel Iterator.
   */
  const QUOTES_REPOSITORY = [
    "Where words fail, music speaks.",
    "Life is like a vinyl record, it has two sides.",
    "Music in the soul can be heard by the universe.",
    "Astralis Vinyl: Your gateway to the stars.",
    "Vintage sounds for modern souls.",
    "Without music, life would be a mistake.",
    "Every song has a story. What's yours?",
    "Lost in time, found in music.",
    "A symphony of dots and sounds.",
    "Keep the record spinning.",
  ];
  function rotateQuotes() {
    const qElem = document.getElementById("quote-text");
    if (!qElem) return;
    qElem.style.opacity = 0;
    setTimeout(() => {
      qElem.textContent = QUOTES_REPOSITORY[Math.floor(Math.random() * QUOTES_REPOSITORY.length)];
      qElem.style.opacity = 0.85;
    }, 500);
  }
  setInterval(rotateQuotes, 60000);
  rotateQuotes();

  /**
   * Particle Physics: Starfall projection locked on NP bounds.
   */
  const starContainer = document.getElementById("star-container");
  function emitStarParticle() {
    if (!STATE.isPlaying || !starContainer) return;
    const star = document.createElement("div");
    star.className = "falling-star";
    star.style.left = Math.random() * 90 + 5 + "%";
    const size = Math.random() * 5 + 4;
    star.style.width = size + "px";
    star.style.height = size + "px";
    star.style.animationDuration = Math.random() * 3 + 3 + "s";
    starContainer.appendChild(star);
    setTimeout(() => star.remove(), 6000);
  }
  setInterval(emitStarParticle, 700);

  /**
   * Particle Physics: Floating musical notes ascending from Vinyl.
   */
  const notesContainer = document.getElementById("notes-container");
  const musicNotes = ["♪", "♫", "♬"];
  function emitFlyingNote() {
    if (!STATE.isPlaying || !notesContainer) return;
    const note = document.createElement("div");
    note.className = "flying-note";
    note.textContent = musicNotes[Math.floor(Math.random() * musicNotes.length)];
    note.style.left = Math.random() * 80 + 10 + "%";
    note.style.animationDuration = Math.random() * 2 + 3 + "s";
    notesContainer.appendChild(note);
    setTimeout(() => note.remove(), 5000);
  }
  setInterval(emitFlyingNote, 800);

  // ==========================================================================
  // 7b. TITLE BAR (frameless window) & LIGHT / DARK THEME
  // ==========================================================================
  const appWindow = window.__TAURI__?.window?.getCurrentWindow?.() ?? null;

  const setTheme = (theme) => {
    document.documentElement.setAttribute("data-theme", theme);
    try {
      localStorage.setItem(U.THEME_KEY, theme);
    } catch {
      /* storage unavailable: the choice just will not be remembered */
    }
  };
  document.getElementById("theme-toggle-btn").addEventListener("click", () => {
    setTheme(document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark");
  });

  /** Keeps the maximize / fullscreen icons in sync with the real window state. */
  const syncWindowState = async () => {
    if (!appWindow) return;
    try {
      document.body.classList.toggle("is-maximized", await appWindow.isMaximized());
      document.body.classList.toggle("is-fullscreen", await appWindow.isFullscreen());
    } catch (err) {
      console.error(err);
    }
  };

  const toggleFullscreen = async () => {
    if (!appWindow) return;
    try {
      await appWindow.setFullscreen(!(await appWindow.isFullscreen()));
    } catch (err) {
      console.error(err);
    }
    syncWindowState();
  };

  const onClick = (id, fn) =>
    document.getElementById(id).addEventListener("click", () => Promise.resolve(fn()).catch(console.error));
  onClick("win-min", () => appWindow?.minimize());
  onClick("win-max", async () => {
    await appWindow?.toggleMaximize();
    syncWindowState();
  });
  onClick("win-close", () => appWindow?.close());
  onClick("fullscreen-btn", toggleFullscreen);

  appWindow?.onResized?.(syncWindowState);
  syncWindowState();

  document.addEventListener("keydown", (e) => {
    if (e.key === "F11") {
      e.preventDefault();
      toggleFullscreen();
    } else if (e.key === "Escape" && document.body.classList.contains("is-fullscreen")) {
      toggleFullscreen();
    }
  });

  // ==========================================================================
  // 8. BOOTSTRAPPER
  // ==========================================================================

  document.getElementById("close-select-modal-btn").onclick = () => {
    document.getElementById("select-playlist-modal").style.display = "none";
  };

  DOM.navItems.forEach((item) => {
    item.addEventListener("click", () => {
      DOM.navItems.forEach((nav) => nav.classList.remove("active"));
      item.classList.add("active");
      renderPage(item.getAttribute("data-target"));
    });
  });

  const bgInput = document.getElementById("bg-input");
  const savedBg = localStorage.getItem("astralis_custom_bg");
  if (savedBg) {
    document.body.style.setProperty("--custom-bg", `url('${savedBg}')`);
    document.getElementById("reset-bg-btn").style.display = "flex";
  }

  document.getElementById("change-bg-btn").addEventListener("click", () => bgInput.click());
  bgInput.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        localStorage.setItem("astralis_custom_bg", event.target.result);
        document.body.style.setProperty("--custom-bg", `url('${event.target.result}')`);
        document.getElementById("reset-bg-btn").style.display = "flex";
      } catch (err) {
        alert("Image too large! Please select a standard resolution image.");
      }
    };
    reader.readAsDataURL(file);
  });
  document.getElementById("reset-bg-btn").addEventListener("click", () => {
    localStorage.removeItem("astralis_custom_bg");
    document.body.style.setProperty("--custom-bg", "none");
    document.getElementById("reset-bg-btn").style.display = "none";
    bgInput.value = "";
  });

  // Load song history from localStorage
  // A corrupted value must not stop the app from starting
  try {
    const parsed = JSON.parse(localStorage.getItem("astralis_recent") || "[]");
    DATABASE.recentSongs = Array.isArray(parsed) ? parsed : [];
  } catch {
    DATABASE.recentSongs = [];
  }

  // Init Async Context
  try {
    const dbRaw = await invoke("load_db");
    DATABASE.userPlaylists = JSON.parse(dbRaw);
  } catch (error) {
    console.error("DB Load Error:", error);
  }
  // The "Downloaded" system playlist must always exist
  if (!Array.isArray(DATABASE.userPlaylists)) DATABASE.userPlaylists = [];
  if (!DATABASE.userPlaylists.some((p) => p.id === "downloaded")) {
    DATABASE.userPlaylists.unshift({ id: "downloaded", name: "Downloaded", desc: "Permanently downloaded songs", songs: [] });
  }

  await refreshLocalIds();

  DOM.navItems.forEach((nav) => nav.classList.remove("active"));
  document.querySelector('[data-target="home"]').classList.add("active");
  renderPage("home");
});