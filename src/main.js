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
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
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
    currentSong: null, // the song object currently loaded (used by lyrics)
    streamFallback: null, // set while streaming: called if the stream fails, to download instead
    waitingDownloadId: null, // song we are waiting on (full download) before it can play
    shuffle: false,
    baseList: [], // the playlist in its normal order (currentQueue is the order that is really played)
    upNext: [], // songs added with "Add to queue": they play before the rest of the list
    fromUpNext: false, // the song playing right now came from upNext
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
  };

  /** * Lyrics panel state
   */
  const LYRICS = {
    open: false,
    token: 0, // increases on every load; results of older loads are ignored
    songId: null,
    data: null, // {synced, lines:[{t,text}], instrumental?}
    active: -1, // index of the highlighted line
    // saved in localStorage: found lyrics are kept 30 days, "not found" only 1 day (the library may get it later)
    cache: U.createStoredCache("astralis_lyrics_v1", 60, (v) => (v.none ? 24 : 24 * 30) * 60 * 60 * 1000),
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

  // ---- Download progress: a ring on the song card while it downloads ----------
  const DL = { pct: new Map(), refs: new Map() }; // song id -> percent / number of running downloads

  /** Shows or hides the progress ring on the card of this song. */
  function paintDl(id) {
    const card = document.getElementById(`card-${id}`);
    if (!card) return;
    const active = DL.refs.has(id);
    card.classList.toggle("is-downloading", active);
    if (!active) return;
    const pct = DL.pct.get(id) || 0;
    card.classList.toggle("dl-indeterminate", pct <= 0);
    card.style.setProperty("--pct", pct > 0 ? pct : 30);
  }

  /** Wraps a backend download promise so the card shows the ring while it runs. */
  function trackDownload(id, promise) {
    DL.refs.set(id, (DL.refs.get(id) || 0) + 1);
    paintDl(id);
    return promise.finally(() => {
      const left = (DL.refs.get(id) || 1) - 1;
      if (left > 0) {
        DL.refs.set(id, left);
      } else {
        DL.refs.delete(id);
        DL.pct.delete(id);
      }
      paintDl(id);
    });
  }

  // The backend sends {id, percent} while yt-dlp downloads
  window.__TAURI__?.event?.listen?.("download-progress", (event) => {
    const { id, percent } = event.payload || {};
    if (!id || !DL.refs.has(id)) return;
    DL.pct.set(id, percent);
    paintDl(id);
    if (STATE.waitingDownloadId === id && STATE.currentSongId === id) {
      document.getElementById("np-artist").textContent = `Downloading... ${Math.round(percent)}%`;
    }
  });

  // ---- Helpers for playback ----------------------------------------------------

  /** Adds the song to the "recent" list (compact copy: id, title, artist, thumbnail, duration). */
  function commitRecent(song) {
    DATABASE.recentSongs = DATABASE.recentSongs.filter((s) => s.id !== song.id);
    DATABASE.recentSongs.unshift(U.compactSong(song));
    if (DATABASE.recentSongs.length > 10) DATABASE.recentSongs.pop();
    persistRecent();
  }

  let prefetchingId = null;
  /** Quietly downloads the NEXT song of the queue so it starts instantly. */
  function prefetchNext() {
    if (STATE.repeatMode === "one") return;
    const upcoming = peekNext();
    const next = upcoming && upcoming.song;
    if (!next || next.id === STATE.currentSongId || STATE.localIds.has(next.id) || prefetchingId === next.id) return;

    prefetchingId = next.id;
    invoke("download_audio", { videoId: next.id, silent: true })
      .catch((err) => console.warn("Prefetch failed:", err))
      .finally(() => {
        if (prefetchingId === next.id) prefetchingId = null;
      });
  }

  /** While a song streams, also save it to the cache so the next play is instant and works offline. */
  function cacheInBackground(song, token) {
    setTimeout(() => {
      if (token !== STATE.playToken) return; // skipped to another song meanwhile: do not waste bandwidth
      trackDownload(song.id, invoke("download_audio", { videoId: song.id }))
        .then(() => {
          if (token === STATE.playToken) prefetchNext();
        })
        .catch((err) => console.warn("Background cache failed:", err));
    }, 1500);
  }

  /**
   * Main execution bridge for loading and playing audio tracks.
   *  1. Song already on the device (library / non-expired cache)  -> play the file
   *  2. Otherwise                                                  -> STREAM it right away and
   *     cache it in the background. If the stream fails, download the file and play that.
   * @param {Object} song - The song metadata payload.
   * @param {boolean} isFromLibrary - Unused: the backend decides where the audio comes from.
   */
  async function executePlay(song, isFromLibrary) {
    // Every request gets a token; if a newer request starts, older ones stop silently.
    const token = ++STATE.playToken;
    STATE.currentSongId = song.id;
    STATE.currentSong = song;
    STATE.streamFallback = null;
    STATE.waitingDownloadId = null;
    refreshQueueUI();

    // 1. Crossfade Out UI
    DOM.npContainer.style.opacity = 0;

    // Remove active styling from all list cards, highlight the current one
    document.querySelectorAll(".song-card").forEach((c) => c.classList.remove("now-playing-active"));
    const activeCard = document.getElementById(`card-${song.id}`);
    if (activeCard) activeCard.classList.add("now-playing-active");

    if (LYRICS.open) loadLyrics(song);

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

      setMarquee(document.getElementById("np-title"), title);
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
      const setStatus = (text) => {
        if (token === STATE.playToken) document.getElementById("np-artist").textContent = text;
      };
      const fail = (err) => {
        if (token !== STATE.playToken) return; // errors of superseded requests are ignored
        console.error(err);
        STATE.streamFallback = null;
        setStatus("❌ Failed to play");
      };
      const started = () => {
        // isPlaying / vinyl / play icon are updated by the audio "play" event listener
        setStatus(artist);
        commitRecent(song);
        updateMediaSession(title, artist, cover);
      };
      const playFile = async (path, resumeAt = 0) => {
        DOM.audio.src = convertFileSrc(path);
        if (resumeAt > 1) {
          DOM.audio.addEventListener(
            "loadedmetadata",
            () => {
              DOM.audio.currentTime = resumeAt;
            },
            { once: true },
          );
        }
        await DOM.audio.play();
      };

      // Download the whole file (the card shows progress), then play it
      const playFromDownload = async (resumeAt = 0) => {
        STATE.waitingDownloadId = song.id;
        setStatus("Downloading... ⏳");
        try {
          const path = await trackDownload(song.id, invoke("download_audio", { videoId: song.id }));
          if (token !== STATE.playToken) return false;
          await playFile(path, resumeAt);
        } finally {
          if (STATE.waitingDownloadId === song.id) STATE.waitingDownloadId = null;
        }
        return token === STATE.playToken;
      };

      // Runs at most once per request: the stream failed, so use the downloaded file instead
      let fellBack = false;
      const fallback = async (resumeAt) => {
        if (fellBack || token !== STATE.playToken) return;
        fellBack = true;
        STATE.streamFallback = null;
        try {
          if (await playFromDownload(resumeAt)) {
            started();
            prefetchNext();
          }
        } catch (err) {
          fail(err);
        }
      };

      try {
        // Local first: library, then non-expired cache.
        const local = await invoke("get_local_path", { videoId: song.id });
        if (token !== STATE.playToken) return;

        if (local) {
          await playFile(local);
          if (token !== STATE.playToken) return;
          started();
          prefetchNext();
          return;
        }

        // Not on this device: ask for a direct stream link
        let streamUrl = null;
        try {
          streamUrl = await invoke("get_stream_url", { videoId: song.id });
        } catch (err) {
          console.warn("No stream link, downloading instead:", err);
        }
        if (token !== STATE.playToken) return;

        if (!streamUrl) {
          fellBack = true;
          if (await playFromDownload()) {
            started();
            prefetchNext();
          }
          return;
        }

        // Stream it now; if the stream breaks (blocked, expired, connection lost) the audio
        // "error" listener calls STATE.streamFallback, which downloads and resumes.
        STATE.streamFallback = () => fallback(DOM.audio.currentTime || 0);
        DOM.audio.src = streamUrl;
        try {
          await DOM.audio.play();
        } catch (err) {
          console.warn("Stream could not start, downloading instead:", err);
          await fallback(0);
          return;
        }
        if (token !== STATE.playToken) return;

        started();
        cacheInBackground(song, token);
      } catch (error) {
        fail(error);
      }
    }, 400);
  }

    // ==========================================================================
  // 4b. QUEUE, SHUFFLE, PLAY ALL
  // ==========================================================================
  // currentQueue = the order songs are really played (a copy of the list, shuffled when shuffle is on)
  // baseList     = the same list in its normal order (used when shuffle is switched off)
  // upNext       = songs added with "Add to queue": they always play first, then the list continues

  const ICON = {
    play: `<svg viewBox="0 0 24 24"><path d="M7 4.5v15l12-7.5z" /></svg>`,
    shuffle: `<svg viewBox="0 0 24 24"><path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5" /></svg>`,
    queueAdd: `<svg viewBox="0 0 24 24"><path d="M4 6h12M4 12h12M4 18h7M18 13v6M15 16h6" /></svg>`,
  };
  const SHUFFLE_KEY = "astralis_shuffle";
  const shuffleBtn = document.getElementById("shuffle-btn");
  const queueBtn = document.getElementById("queue-btn");
  const queueBadge = document.getElementById("queue-badge");
  const queueBody = document.getElementById("queue-body");
  let queueOpen = false;

  const titleOf = (s) => s.track || s.title || "Unknown Title";
  const artistOf = (s) => s.artist || s.uploader || "";

  let toastTimer = null;
  function toast(text) {
    let el = document.getElementById("toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "toast";
      el.className = "toast";
      document.body.appendChild(el);
    }
    el.textContent = text;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 1800);
  }

  /** Copy of `list` in random order; the song with `firstId` (if any) is put first. */
  function shuffled(list, firstId) {
    const rest = list.filter((s) => s.id !== firstId);
    for (let i = rest.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [rest[i], rest[j]] = [rest[j], rest[i]];
    }
    const first = list.find((s) => s.id === firstId);
    return first ? [first, ...rest] : rest;
  }

  const canSkip = () => STATE.upNext.length > 0 || (STATE.playContext !== "search" && STATE.currentQueue.length > 0);

  /** Which song comes next? {song, index, fromUpNext} or null. Changes nothing. */
  function peekNext() {
    if (STATE.upNext.length) return { song: STATE.upNext[0], index: -1, fromUpNext: true };
    const q = STATE.currentQueue;
    if (STATE.playContext === "search" || !q.length) return null;
    let i = STATE.currentSongIndex + 1;
    if (i >= q.length) {
      if (STATE.repeatMode !== "all") return null;
      i = 0;
    }
    return { song: q[i], index: i, fromUpNext: false };
  }

  /** Plays the next song (queued songs first). Returns false when there is none. */
  function goNext() {
    const n = peekNext();
    if (!n) return false;
    if (n.fromUpNext) {
      STATE.upNext.shift(); // currentSongIndex stays: the list continues after the queued songs
      STATE.fromUpNext = true;
    } else {
      STATE.currentSongIndex = n.index;
      STATE.fromUpNext = false;
    }
    executePlay(n.song, false);
    return true;
  }

  function goPrev() {
    const q = STATE.currentQueue;
    if (DOM.audio.currentTime > 3 || STATE.playContext === "search" || !q.length) {
      DOM.audio.currentTime = 0; // more than 3s in (or no list): restart the song
      return;
    }
    // while a queued song plays, "previous" goes back to the list song that came before it
    let i = STATE.fromUpNext ? STATE.currentSongIndex : STATE.currentSongIndex - 1;
    if (i < 0) i = STATE.repeatMode === "all" ? q.length - 1 : 0;
    STATE.currentSongIndex = i;
    STATE.fromUpNext = false;
    executePlay(q[i], false);
  }

  /** A song was picked from a list: that list becomes the queue (shuffled if shuffle is on). */
  function startQueue(list, song, playlistId) {
    STATE.playContext = "playlist";
    STATE.currentPlaylistId = playlistId;
    STATE.baseList = list.slice();
    STATE.currentQueue = STATE.shuffle ? shuffled(list, song.id) : list.slice();
    STATE.currentSongIndex = STATE.currentQueue.findIndex((s) => s.id === song.id);
    STATE.fromUpNext = false;
    executePlay(song, playlistId === "downloaded");
  }

  /** "Play All" (wantShuffle false: in order) and "Shuffle" buttons. */
  function playList(list, playlistId, wantShuffle) {
    if (!list || !list.length) return;
    applyShuffleFlag(wantShuffle);
    const first = wantShuffle ? list[Math.floor(Math.random() * list.length)] : list[0];
    startQueue(list, first, playlistId);
  }

  function applyShuffleFlag(on) {
    STATE.shuffle = on;
    shuffleBtn.classList.toggle("on", on);
    shuffleBtn.setAttribute("aria-pressed", String(on));
    try {
      localStorage.setItem(SHUFFLE_KEY, on ? "1" : "0");
    } catch {}
  }

  /** Shuffle button / S key: reorders what is left of the list, the song playing now stays put. */
  function setShuffle(on, quiet = false) {
    applyShuffleFlag(on);
    const anchor = STATE.currentQueue[STATE.currentSongIndex];
    if (STATE.currentQueue.length) {
      const base = STATE.baseList.length ? STATE.baseList : STATE.currentQueue;
      STATE.currentQueue = on ? shuffled(base, anchor && anchor.id) : base.slice();
      STATE.currentSongIndex = anchor ? STATE.currentQueue.findIndex((s) => s.id === anchor.id) : -1;
    }
    refreshQueueUI();
    if (!quiet) {
      toast(on ? "Shuffle on" : "Shuffle off");
      prefetchNext();
    }
  }

  function restoreShuffle() {
    let on = false;
    try {
      on = localStorage.getItem(SHUFFLE_KEY) === "1";
    } catch {}
    setShuffle(on, true);
  }

  /** "+" button on a card. Normal click: end of the queue. Shift+click: play next. */
  function enqueue(song, atFront = false) {
    const s = U.compactSong(song);
    if (!STATE.currentSong) {
      // nothing has been played yet: just play it
      STATE.playContext = "none";
      STATE.currentQueue = [];
      STATE.baseList = [];
      STATE.currentSongIndex = -1;
      STATE.currentPlaylistId = null;
      STATE.fromUpNext = false;
      executePlay(s, false);
      return;
    }
    if (STATE.upNext.length >= 200) {
      toast("The queue is full (200 songs)");
      return;
    }
    if (atFront) STATE.upNext.unshift(s);
    else STATE.upNext.push(s);
    toast(`${atFront ? "Playing next" : "Added to queue"}: ${titleOf(s)}`);
    if (DOM.audio.ended) {
      goNext(); // the list had finished: continue with the song just added
      return;
    }
    refreshQueueUI();
    prefetchNext();
  }

  /** A song was deleted from the playlist that is playing: take it out of the queue too. */
  function dropFromQueue(id) {
    const p = STATE.currentQueue.findIndex((s) => s.id === id);
    if (p >= 0) {
      STATE.currentQueue.splice(p, 1);
      if (p <= STATE.currentSongIndex) STATE.currentSongIndex--;
    }
    STATE.baseList = STATE.baseList.filter((s) => s.id !== id);
    STATE.upNext = STATE.upNext.filter((s) => s.id !== id);
    refreshQueueUI();
  }

  function removeQueued(kind, i) {
    if (kind === "up") {
      STATE.upNext.splice(i, 1);
    } else {
      const gone = STATE.currentQueue.splice(i, 1)[0]; // rows of the list are always after the current song
      if (gone) STATE.baseList = STATE.baseList.filter((s) => s.id !== gone.id);
    }
    refreshQueueUI();
    prefetchNext();
  }

  // ---------- queue panel ----------
  const QUEUE_LIST_MAX = 100;

  function listName() {
    if (STATE.currentPlaylistId === "recent") return "RECENT SONGS";
    const pl = DATABASE.userPlaylists.find((p) => p.id === STATE.currentPlaylistId);
    return (pl ? pl.name : "THE LIST").toUpperCase();
  }

  function queueRow(song, kind, i) {
    const dur = U.formatDuration(song.duration);
    const cover = song.thumbnail || song.cover || "";
    return `<div class="q-row${kind === "now" ? " now" : ""}" data-kind="${kind}" data-i="${i}">
      <img class="q-cover" src="${esc(cover)}" alt="" />
      <div class="q-info"><div class="q-title mq" title="${esc(titleOf(song))}"><span class="marq">${esc(titleOf(song))}</span></div><div class="q-artist">${esc(artistOf(song))}${dur ? ` · ${dur}` : ""}</div></div>
      ${kind === "now" ? `<span class="q-eq">PLAYING</span>` : `<button class="q-x" data-rm="1" title="Remove" aria-label="Remove from queue">×</button>`}
    </div>`;
  }

  function fmtLeft(sec) {
    const m = Math.max(1, Math.round(sec / 60));
    return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
  }

  function queueSubText() {
    const cur = STATE.currentSong;
    const after = STATE.playContext === "search" ? [] : STATE.currentQueue.slice(STATE.currentSongIndex + 1);
    const all = [...STATE.upNext, ...after];
    const curLeft = cur && isFinite(DOM.audio.duration)
      ? DOM.audio.duration - DOM.audio.currentTime
      : Number(cur && cur.duration) || 0;
    const total = all.reduce((t, s) => t + (Number(s.duration) || 0), 0) + Math.max(curLeft, 0);
    const missing = all.some((s) => !Number(s.duration));

    const parts = [];
    if (cur) parts.push(`<span>${all.length} ${all.length === 1 ? "song" : "songs"} up next</span>`);
    if (cur && total) parts.push(`<span class="q-time">${missing ? "~" : ""}${fmtLeft(total)} left</span>`);

    const flags = [
      STATE.shuffle ? "SHUFFLE" : "",
      STATE.repeatMode === "all" ? "REPEAT ALL" : STATE.repeatMode === "one" ? "REPEAT ONE" : "",
    ].filter(Boolean);

    return parts.join(`<i class="q-dot">·</i>`) + flags.map((f) => `<span class="q-chip">${f}</span>`).join("");
  }

  function renderQueue() {
    const cur = STATE.currentSong;
    const after = STATE.playContext === "search" ? [] : STATE.currentQueue.slice(STATE.currentSongIndex + 1);
    const left = STATE.upNext.length + after.length;

    let html = "";
    if (cur) html += `<div class="q-section">NOW PLAYING</div>` + queueRow(cur, "now", 0);
    if (STATE.upNext.length) {
      html += `<div class="q-section">NEXT IN QUEUE · ${STATE.upNext.length}</div>`;
      html += STATE.upNext.map((s, i) => queueRow(s, "up", i)).join("");
    }
    if (after.length) {
      html += `<div class="q-section">NEXT FROM ${esc(listName())}${STATE.shuffle ? " · SHUFFLED" : ""}</div>`;
      html += after.slice(0, QUEUE_LIST_MAX).map((s, k) => queueRow(s, "ctx", STATE.currentSongIndex + 1 + k)).join("");
      if (after.length > QUEUE_LIST_MAX) html += `<div class="q-more">+ ${after.length - QUEUE_LIST_MAX} more</div>`;
    }
    if (!cur) {
      html = `<div class="ly-msg"><p>Nothing is playing.</p><p class="hint">Use the + button on any song to add it here.</p></div>`;
    } else if (!left) {
      html += `<div class="ly-msg"><p>Nothing else is queued.</p><p class="hint">Use the + button on a song to add it. Shift+click plays it next.</p></div>`;
    }

    const top = queueBody.scrollTop;
    queueBody.innerHTML = html;
    queueBody.scrollTop = top;
    requestAnimationFrame(() => fitMarquees(queueBody));

    document.getElementById("queue-sub").innerHTML = queueSubText();
    document.getElementById("queue-clear").hidden = STATE.upNext.length === 0;
  }

  /** Call after anything that changes the queue or the current song. */
  function refreshQueueUI() {
    const skip = canSkip();
    DOM.btnNext.disabled = !skip;
    DOM.btnPrev.disabled = !skip;
    const n = STATE.upNext.length;
    queueBadge.textContent = n > 99 ? "99+" : String(n);
    queueBadge.hidden = n === 0;
    if (queueOpen) renderQueue();
    refreshMediaSkip();
  }

  function toggleQueue(force) {
    queueOpen = typeof force === "boolean" ? force : !queueOpen;
    if (queueOpen && LYRICS.open) toggleLyrics(false); // lyrics and queue share the same space
    document.querySelector(".content-section").classList.toggle("queue-on", queueOpen);
    queueBtn.classList.toggle("on", queueOpen);
    if (queueOpen) renderQueue();
  }

  queueBtn.addEventListener("click", () => toggleQueue());
  let lastQTick = -1;
  DOM.audio.addEventListener("timeupdate", () => {
    if (!queueOpen) return;
    const tick = Math.floor(DOM.audio.currentTime / 15); // update every ~15 s
    if (tick === lastQTick) return;
    lastQTick = tick;
    document.getElementById("queue-sub").innerHTML = queueSubText();
  });
  document.getElementById("queue-close").addEventListener("click", () => toggleQueue(false));
  document.getElementById("queue-clear").addEventListener("click", () => {
    STATE.upNext = [];
    refreshQueueUI();
  });
  shuffleBtn.addEventListener("click", () => setShuffle(!STATE.shuffle));

  queueBody.addEventListener("click", (e) => {
    const row = e.target.closest(".q-row");
    if (!row) return;
    const kind = row.dataset.kind;
    const i = Number(row.dataset.i);
    if (e.target.closest("[data-rm]")) {
      removeQueued(kind, i);
    } else if (kind === "up") {
      STATE.upNext.splice(0, i); // skipping ahead drops the queued songs before it
      goNext();
    } else if (kind === "ctx") {
      STATE.currentSongIndex = i;
      STATE.fromUpNext = false;
      executePlay(STATE.currentQueue[i], false);
    }
  });
  // inline onerror is blocked by the CSP, so a broken cover is hidden from here
  queueBody.addEventListener("error", (e) => {
    if (e.target.classList && e.target.classList.contains("q-cover")) e.target.style.display = "none";
  }, true);

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
            ${
              DATABASE.recentSongs.length
                ? `<div class="pl-actions">
                    <button class="pl-btn play" id="recent-play">${ICON.play} Play All</button>
                    <button class="pl-btn ghost" id="recent-shuffle">${ICON.shuffle} Shuffle</button>
                    <button class="create-playlist-btn" id="clear-recent-btn">Clear all</button>
                  </div>`
                : ""
            }
          </div>
          <div class="playlist-container" id="recent-container"></div>
        `;
        renderPlaylistCards(DATABASE.recentSongs, document.getElementById("recent-container"), "home", "recent");

        const recentPlay = document.getElementById("recent-play");
        if (recentPlay) {
          recentPlay.onclick = () => playList(DATABASE.recentSongs, "recent", false);
          document.getElementById("recent-shuffle").onclick = () => playList(DATABASE.recentSongs, "recent", true);
        }

        const clearBtn = document.getElementById("clear-recent-btn");
        if (clearBtn)
          clearBtn.onclick = async () => {
            const ok = await customConfirm("Clear Recent Songs", "Remove every song from this list? Your downloads and playlists are not affected.", "Clear");
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
              <div class="pl-actions">
                <button id="pl-play" class="pl-btn play"${playlist.songs.length ? "" : " disabled"}>${ICON.play} Play All</button>
                <button id="pl-shuffle" class="pl-btn ghost"${playlist.songs.length ? "" : " disabled"}>${ICON.shuffle} Shuffle</button>
              </div>
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

      document.getElementById("pl-play").onclick = () => playList(playlist.songs, playlist.id, false);
      document.getElementById("pl-shuffle").onclick = () => playList(playlist.songs, playlist.id, true);

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

      const queueBtnHTML = `<button class="action-btn queue-btn" title="Add to queue (Shift+click: play next)" aria-label="Add to queue">${ICON.queueAdd}</button>`;
      let actionButtonsHTML = "";
      if (viewContext === "search") {
        actionButtonsHTML = queueBtnHTML + downloadBtnHTML + addBtnHTML;
      } else if (viewContext === "home") {
        actionButtonsHTML = queueBtnHTML + downloadBtnHTML + addBtnHTML + `<button class="action-btn remove-recent-btn" title="Remove from recent"><img src="assets/close.png"></button>`;
      } else {
        actionButtonsHTML = queueBtnHTML + `<button class="action-btn delete-btn"><img src="assets/delete.png"></button>`;
      }

      const card = document.createElement("div");
      card.className = "song-card";
      card.id = `card-${song.id}`;
      card.innerHTML = `
        <img src="${esc(cover)}" class="song-cover">
        <div class="song-info">
          <span class="song-title" title="${esc(title)}"><span class="marq">${esc(title)}</span></span>
          <span class="song-artist">${esc(artist)}${durationText ? `<span class="song-dur"> · ${durationText}</span>` : ""}</span>
          ${showBadge ? DL_BADGE_HTML : ""}
        </div>
        <span class="card-spin"></span>
        <div class="song-actions">${actionButtonsHTML}</div>
      `;

      // Hide the cover if the image fails to load (inline onerror is blocked by the CSP)
      card.querySelector(".song-cover").addEventListener("error", (e) => (e.target.style.display = "none"));

      // -- CARD ACTIONS BINDING --
      const qBtn = card.querySelector(".queue-btn");
      if (qBtn)
        qBtn.onclick = (e) => {
          e.stopPropagation();
          enqueue(song, e.shiftKey);
        };

      const dlBtn = card.querySelector(".download-btn");
      if (dlBtn) {
        if (isDownloaded) dlBtn.dataset.done = "1";
        dlBtn.onclick = async (e) => {
          e.stopPropagation();
          if (dlBtn.dataset.done || dlBtn.dataset.busy) return; // already saved / in progress
          dlBtn.dataset.busy = "1";
          dlBtn.innerHTML = "⏳";
          try {
            await trackDownload(song.id, invoke("save_to_library", { videoId: song.id }));
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
            fromDownloads ? "Delete" : "Remove",
          );
          if (!ok) return;

          const target = DATABASE.userPlaylists.find((p) => p.id === playlistId);
          if (!target) return;
          target.songs = target.songs.filter((s) => s.id !== song.id);
          await saveDatabase();
          card.remove();
          if (STATE.currentPlaylistId === playlistId) dropFromQueue(song.id);

          // Stop and release the file first if this song is the one currently loaded
          if (STATE.currentSongId === song.id) {
            STATE.playToken++; // cancel any in-flight load for this song
            STATE.currentSongId = null;
            DOM.audio.pause();
            DOM.audio.removeAttribute("src");
            DOM.audio.load();
            STATE.currentQueue = [];
            STATE.baseList = [];
            STATE.currentSong = null;
            STATE.currentSongIndex = -1;
            refreshQueueUI();
            DOM.progressRing.style.strokeDashoffset = MAX_OFFSET;
            DOM.timeDisplay.textContent = "00:00 / 00:00";
            setMarquee(document.getElementById("np-title"), "Welcome back~");
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
        if (viewContext === "search") {
          // a search result plays on its own (the songs you queued still follow it)
          STATE.playContext = "search";
          STATE.repeatMode = "none";
          DOM.btnRepeat.style.opacity = "0.5";
          DOM.btnRepeat.querySelector("img").src = "assets/repeat.png";
          STATE.currentQueue = [];
          STATE.baseList = [];
          STATE.currentSongIndex = -1;
          STATE.currentPlaylistId = null;
          STATE.fromUpNext = false;
          executePlay(song, false);
        } else {
          DOM.btnRepeat.style.cursor = "pointer";
          startQueue(data, song, playlistId); // this list becomes the queue
        }
      });

      container.appendChild(card);
      paintDl(song.id); // a download may already be running for this song
    });

    // One-line titles: measure after layout and slide the long ones
    requestAnimationFrame(() => fitMarquees(container));
  }

  /** Put text in a one-line box that slides when it is too long (.mq) */
  function setMarquee(el, text) {
    if (!el) return;
    el.classList.add("mq");
    el.title = text;
    el.innerHTML = "";
    const s = document.createElement("span");
    s.className = "marq";
    s.textContent = text;
    el.appendChild(s);
    requestAnimationFrame(() => fitMarquees(el.parentElement || document));
  }

  /**
   * Song titles stay on ONE line. A title that does not fit gets the class "is-long" and
   * the distance it must slide (--shift); CSS slides it while the card is hovered / playing.
   */
  function fitMarquees(root = document) {
    root.querySelectorAll(".song-title, .mq").forEach((box) => {
      const inner = box.firstElementChild;
      if (!inner) return;
      const overflow = inner.offsetWidth - box.clientWidth;
      box.classList.toggle("is-long", overflow > 2);
      if (overflow > 2) {
        box.style.setProperty("--shift", `-${overflow + 12}px`);
        box.style.setProperty("--marq-dur", `${Math.min(18, 3 + overflow / 35).toFixed(1)}s`);
      }
    });
  }

  // ==========================================================================
  // 5b. SEARCH  (history, result cache, skeleton loading, music-first + fallback)
  // ==========================================================================

  const skeletonHTML = (count = 6) =>
    Array.from({ length: count }, () => `<div class="skeleton-card"><div class="sk-cover"></div><div class="sk-lines"><div class="sk-line w70"></div><div class="sk-line w40"></div></div></div>`).join(
      "",
    );

  const friendlySearchError = (err) => (/failed to run yt-dlp/i.test(String(err)) ? "The search engine (yt-dlp) could not start." : "Search failed. Check your internet connection and try again.");

  async function fetchSongs(query) {
    const key = query.toLowerCase();
    const cached = SEARCH.cache.get(key);
    if (cached) return cached;

    // YouTube Music flat results have no artist field, so use normal YouTube search.
    const raw = await invoke("search_song", { query, source: "youtube" });
    const results = U.processSearch(raw, "youtube", query);

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
      box.innerHTML = `<div class="search-state"><p>Search for a song or an artist.</p><p class="hint">Tip: press / anywhere to jump to this box.</p></div>`;
    }
  }

  async function doSearch(rawQuery) {
    const query = String(rawQuery || "")
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, 200);
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
            `<span class="sh-chip" data-q="${esc(h)}"><span class="sh-text">${esc(h)}</span><button class="sh-x" data-del="${esc(h)}" aria-label="Remove ${esc(h)} from history" title="Remove">×</button></span>`,
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

  DOM.btnPlay.addEventListener("click", () => togglePlayback());

  DOM.volumeSlider.addEventListener("input", (e) => applyVolume(e.target.value));
  DOM.volumeBtn.addEventListener("click", () => DOM.volumeContainer.classList.toggle("active"));
  DOM.volumeBtn.addEventListener("dblclick", () => toggleMute()); // optional: double-click mutes

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
    // A stream that fails (blocked, expired, connection lost) is replaced by the downloaded file
    if (STATE.streamFallback) {
      const retry = STATE.streamFallback;
      STATE.streamFallback = null;
      retry();
      return;
    }
    syncPlayingUI(false);
    document.getElementById("np-artist").textContent = "❌ Failed to play";
  });

  DOM.btnNext.addEventListener("click", () => goNext());

  DOM.btnPrev.addEventListener("click", () => goPrev());

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
    DOM.timeDisplay.innerHTML = `${formatTime(DOM.audio.currentTime)}<span class="t-total"> / ${formatTime(DOM.audio.duration)}</span>`;
    if (DOM.audio.duration) {
      const percent = DOM.audio.currentTime / DOM.audio.duration;
      DOM.progressRing.style.strokeDashoffset = MAX_OFFSET - percent * (MAX_OFFSET / 4);
      DOM.timeDisplay.textContent = `${formatTime(DOM.audio.currentTime)} / ${formatTime(DOM.audio.duration)}`;
    }
    syncLyrics();
  });
  DOM.audio.addEventListener("seeked", () => syncLyrics());

  DOM.audio.addEventListener("ended", () => {
    STATE.streamFallback = null;
    if (STATE.repeatMode === "one") {
      DOM.audio.currentTime = 0;
      DOM.audio.play().catch(console.error);
    } else if (!goNext()) {
      DOM.progressRing.style.strokeDashoffset = MAX_OFFSET; // nothing left to play
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

  /** Keeps the maximize / restore icon in sync with the real window state. */
  const syncWindowState = async () => {
    if (!appWindow) return;
    try {
      document.body.classList.toggle("is-maximized", await appWindow.isMaximized());
    } catch (err) {
      console.error(err);
    }
  };

  const onClick = (id, fn) => document.getElementById(id).addEventListener("click", () => Promise.resolve(fn()).catch(console.error));
  onClick("win-min", () => appWindow?.minimize());
  onClick("win-max", async () => {
    await appWindow?.toggleMaximize();
    syncWindowState();
  });
  onClick("win-close", () => appWindow?.close());

  appWindow?.onResized?.(syncWindowState);
  syncWindowState();

  // ==========================================================================
  // 7c. LYRICS  (LRCLIB: free, no account, time-synced when available)
  // ==========================================================================
  const lyricsBody = document.getElementById("lyrics-body");
  const lyricsBtn = document.getElementById("lyrics-btn");
  const contentSection = document.querySelector(".content-section");

  function setLyricsMessage(text, hint = "") {
    lyricsBody.className = "ly-body";
    lyricsBody.innerHTML = `<div class="ly-msg"><p>${esc(text)}</p>${hint ? `<p class="hint">${esc(hint)}</p>` : ""}</div>`;
    document.getElementById("lyrics-tag").textContent = "";
  }

  /** One single message for: not in the lyrics library, instrumental, or the lookup failed. */
  function showNotFound() {
    setLyricsMessage("No lyrics found for this song.", "It may not be in the lyrics library, or it is instrumental.");
  }

  function renderLyrics(data) {
    LYRICS.data = data;
    LYRICS.active = -1;
    if (!data || !data.lines || !data.lines.length) {
      showNotFound();
      return;
    }
    lyricsBody.className = `ly-body ${data.synced ? "synced" : "plain"}`;
    lyricsBody.innerHTML = data.lines.map((line, i) => `<p class="ly-line${line.text ? "" : " ly-gap"}" data-i="${i}">${esc(line.text || "♪")}</p>`).join("");
    document.getElementById("lyrics-tag").textContent = data.synced ? "SYNCED" : "TEXT ONLY";
    lyricsBody.scrollTop = 0;
    syncLyrics(true);
  }

  /** Highlights the line being sung and scrolls it to the middle. */
  function syncLyrics(jump = false) {
    if (!LYRICS.open || !LYRICS.data || !LYRICS.data.synced) return;
    const index = U.activeLine(LYRICS.data.lines, DOM.audio.currentTime + 0.2);
    if (index === LYRICS.active && !jump) return;
    LYRICS.active = index;

    const previous = lyricsBody.querySelector(".ly-line.active");
    if (previous) previous.classList.remove("active");
    if (index < 0) return;
    const line = lyricsBody.querySelector(`.ly-line[data-i="${index}"]`);
    if (!line) return;
    line.classList.add("active");
    lyricsBody.scrollTo({ top: line.offsetTop - lyricsBody.clientHeight / 2 + line.offsetHeight / 2, behavior: jump ? "auto" : "smooth" });
  }

  /** One request to LRCLIB. Returns the parsed JSON, or null when nothing was found. */
  async function lrclib(path, params, retries = 1) {
    const url = new URL(`https://lrclib.net/api/${path}`);
    Object.entries(params).forEach(([k, v]) => v && url.searchParams.set(k, v));

    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      try {
        const res = await fetch(url, { signal: controller.signal });
        if (res.status === 404) return null;
        if (res.status >= 400 && res.status < 500 && res.status !== 429) return null; // bad query = "nothing found"
        if (!res.ok) {
          const e = new Error(`LRCLIB HTTP ${res.status}`);
          e.kind = "server";
          throw e;
        }
        return await res.json();
      } catch (err) {
        if (!err.kind) err.kind = err.name === "AbortError" ? "timeout" : "network";
        console.warn("LRCLIB", path, err.kind, err.message); // helps you see what's failing
        if (err.kind === "server" || attempt >= retries) throw err; // don't retry server errors / 429
        await new Promise((r) => setTimeout(r, 800));
      } finally {
        clearTimeout(timer);
      }
    }
  }

  async function fetchLyrics(song) {
    const { tracks, artists, full } = U.lyricsCandidates(song);
    if (!tracks.length) return null;
    if (/\b(instrumental|karaoke)\b/i.test(full)) return null; // title says so: no need to ask the server
    const duration = Number(song.duration) || 0;

    let lastError = null;
    let answered = false;

    // 1. exact lookups: best 2 track names x best 3 artist names, max 5 requests
    const exact = [];
    for (const t of tracks.slice(0, 2)) {
      for (const a of artists.slice(0, 3)) exact.push({ track_name: t, artist_name: a, duration });
    }
    for (const params of exact.slice(0, 5)) {
      try {
        const rec = await lrclib("get", params, 0);
        answered = true;
        const found = U.lyricsFromRecord(rec); // null when empty/instrumental -> keep trying
        if (found) return found;
      } catch (err) {
        lastError = err;
      }
    }

    // 2. search fallback (song length must match, so wrong songs are filtered out)
    const searches = [artists[0] ? { q: `${artists[0]} ${tracks[0]}` } : null, { q: tracks[0] }, tracks[1] ? { q: tracks[1] } : null, full !== tracks[0] ? { q: full } : null].filter(Boolean);
    for (const params of searches) {
      try {
        const record = U.pickLyrics(await lrclib("search", params, 0), duration);
        answered = true;
        const found = U.lyricsFromRecord(record);
        if (found) return found;
      } catch (err) {
        lastError = err;
      }
    }

    if (!answered && lastError) throw lastError;
    return null;
  }

  async function loadLyrics(song) {
    if (!song) {
      setMarquee(document.getElementById("lyrics-title"), "No song playing");
      document.getElementById("lyrics-artist").textContent = "";
      setLyricsMessage("Play a song to see its lyrics.");
      return;
    }
    setMarquee(document.getElementById("lyrics-title"), song.track || song.title || "");
    document.getElementById("lyrics-artist").textContent = song.artist || song.uploader || "";

    if (LYRICS.songId === song.id && LYRICS.data) {
      syncLyrics(true); // same song, already loaded
      return;
    }
    LYRICS.songId = song.id;
    LYRICS.data = null;
    const token = ++LYRICS.token;

    const cached = LYRICS.cache.get(song.id);
    if (cached) {
      if (cached.none) showNotFound();
      else renderLyrics(cached);
      return;
    }

    setLyricsMessage("Searching lyrics... ⏳");
    try {
      const data = await fetchLyrics(song);
      if (token !== LYRICS.token) return; // another song started meanwhile
      LYRICS.cache.set(song.id, data || { none: true });
      if (data) renderLyrics(data);
      else showNotFound();
    } catch (err) {
      if (token !== LYRICS.token) return;
      console.error("Lyrics error:", err);
      LYRICS.songId = null; // not cached, so reopening the panel tries again
      showNotFound();
    }
  }

  function toggleLyrics(force) {
    LYRICS.open = typeof force === "boolean" ? force : !LYRICS.open;
    if (LYRICS.open && queueOpen) toggleQueue(false);
    contentSection.classList.toggle("lyrics-on", LYRICS.open);
    lyricsBtn.classList.toggle("on", LYRICS.open);
    if (LYRICS.open) loadLyrics(STATE.currentSong);
  }

  lyricsBtn.addEventListener("click", () => toggleLyrics());
  document.getElementById("lyrics-close").addEventListener("click", () => toggleLyrics(false));
  // Click a synced line to jump to it
  lyricsBody.addEventListener("click", (e) => {
    const line = e.target.closest(".ly-line");
    if (!line || !LYRICS.data || !LYRICS.data.synced || !DOM.audio.getAttribute("src")) return;
    const target = LYRICS.data.lines[Number(line.dataset.i)];
    if (target) DOM.audio.currentTime = target.t;
  });

  // ==========================================================================
  // SHORTCUTS, MEDIA KEYS, SAVED VOLUME, RESUME
  // ==========================================================================

  // ---------- Volume (saved) ----------
  const VOLUME_KEY = "astralis_volume";

  function applyVolume(value, save = true) {
    const v = Math.min(1, Math.max(0, Number(value) || 0));
    DOM.audio.volume = v;
    DOM.volumeSlider.value = v;
    DOM.volumeIcon.src = v === 0 ? "assets/no-volume.png" : "assets/max-volume.png";
    if (v > 0) STATE.previousVolume = v;
    if (save) {
      try {
        localStorage.setItem(VOLUME_KEY, JSON.stringify({ volume: v, previous: STATE.previousVolume }));
      } catch {}
    }
  }

  function toggleMute() {
    if (DOM.audio.volume > 0) applyVolume(0);
    else applyVolume(STATE.previousVolume || 1);
  }

  function restoreVolume() {
    try {
      const s = JSON.parse(localStorage.getItem(VOLUME_KEY) || "null");
      if (!s) return;
      STATE.previousVolume = s.previous > 0 ? s.previous : 1;
      applyVolume(s.volume, false);
    } catch {}
  }

  // ---------- Play / pause (button, Space and media keys all use this) ----------
  const RESUME = { song: null, position: 0, seekId: null, seekTo: 0 };

  function togglePlayback() {
    if (!DOM.audio.getAttribute("src")) {
      if (RESUME.song) startResume(); // nothing loaded yet, but we have a saved song
      return;
    }
    if (DOM.audio.paused) DOM.audio.play().catch(console.error);
    else DOM.audio.pause();
  }

  function seekBy(seconds) {
    const d = DOM.audio.duration;
    if (!DOM.audio.getAttribute("src") || !isFinite(d)) return;
    DOM.audio.currentTime = Math.min(Math.max(DOM.audio.currentTime + seconds, 0), d);
  }

  // ---------- Media Session (keyboard media keys + Windows overlay) ----------
  const MS = "mediaSession" in navigator ? navigator.mediaSession : null;

  function updateMediaSession(title, artist, cover) {
    if (!MS) return;
    try {
      MS.metadata = new MediaMetadata({
        title,
        artist,
        album: "Astralis Vinyl",
        artwork: cover ? [{ src: cover, sizes: "512x512" }] : [],
      });
    } catch {}
    refreshMediaSkip();
  }

  /** Prev / next media keys only exist while there is something to skip to. */
  function refreshMediaSkip() {
    if (!MS) return;
    try {
      MS.setActionHandler("previoustrack", DOM.btnPrev.disabled ? null : () => DOM.btnPrev.click());
      MS.setActionHandler("nexttrack", DOM.btnNext.disabled ? null : () => DOM.btnNext.click());
    } catch {}
  }

  function updatePosition() {
    if (!MS || !MS.setPositionState) return;
    const d = DOM.audio.duration;
    if (!isFinite(d) || d <= 0) return;
    try {
      MS.setPositionState({ duration: d, playbackRate: DOM.audio.playbackRate || 1, position: Math.min(DOM.audio.currentTime, d) });
    } catch {}
  }

  if (MS) {
    const on = (action, fn) => {
      try {
        MS.setActionHandler(action, fn);
      } catch {}
    };
    on("play", () => {
      if (DOM.audio.paused) togglePlayback();
    });
    on("pause", () => DOM.audio.pause());
    on("seekbackward", (d) => seekBy(-(d.seekOffset || 10)));
    on("seekforward", (d) => seekBy(d.seekOffset || 10));
    on("seekto", (d) => {
      if (d.seekTime != null && isFinite(DOM.audio.duration)) DOM.audio.currentTime = d.seekTime;
    });

    DOM.audio.addEventListener("play", () => (MS.playbackState = "playing"));
    DOM.audio.addEventListener("pause", () => (MS.playbackState = "paused"));
    ["play", "pause", "seeked", "durationchange", "ratechange"].forEach((ev) => DOM.audio.addEventListener(ev, updatePosition));
  }

  // ---------- Resume last song + position ----------
  const SESSION_KEY = "astralis_session";
  let loadedSongId = null; // the song whose audio is really loaded (protects the saved position)
  let lastSave = 0;

  function saveSession(force = false, position = Math.floor(DOM.audio.currentTime)) {
    const song = STATE.currentSong;
    if (!song || loadedSongId !== STATE.currentSongId || !DOM.audio.getAttribute("src")) return;
    const now = Date.now();
    if (!force && now - lastSave < 5000) return;
    lastSave = now;
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify({ song: U.compactSong(song), position, ctx: STATE.playContext, playlistId: STATE.currentPlaylistId }));
    } catch {}
  }

  DOM.audio.addEventListener("loadedmetadata", () => {
    loadedSongId = STATE.currentSongId;
    RESUME.song = null;
    // Jump to the saved position once, and only for the song we are resuming
    if (RESUME.seekTo > 0 && RESUME.seekId === STATE.currentSongId) {
      const d = DOM.audio.duration;
      if (!isFinite(d) || RESUME.seekTo < d - 2) DOM.audio.currentTime = RESUME.seekTo;
    }
    RESUME.seekTo = 0;
    updatePosition();
  });
  DOM.audio.addEventListener("timeupdate", () => saveSession(false));
  DOM.audio.addEventListener("pause", () => saveSession(true));
  DOM.audio.addEventListener("seeked", () => saveSession(true));
  DOM.audio.addEventListener("ended", () => saveSession(true, 0)); // finished: next launch starts it from the top
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) saveSession(true);
  });
  window.addEventListener("pagehide", () => saveSession(true));

  function startResume() {
    const { song, position } = RESUME;
    RESUME.song = null;
    RESUME.seekId = song.id;
    RESUME.seekTo = position;
    executePlay(song, STATE.currentPlaylistId === "downloaded");
  }

  /** Shows the last song (paused, nothing downloaded yet). The first Play press loads it and jumps to the position. */
  function restoreSession() {
    DOM.timeDisplay.innerHTML = `${formatTime(position)}<span class="t-total"> / ${formatTime(duration)}</span>`;
    let s = null;
    try {
      s = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
    } catch {}
    if (!s || !s.song || !s.song.id) return;
    const song = s.song;

    STATE.currentSong = song;
    STATE.currentSongId = song.id;
    STATE.playContext = s.ctx === "search" ? "search" : "playlist";

    let queue = [];
    if (STATE.playContext === "playlist") {
      const list = s.playlistId === "recent" ? DATABASE.recentSongs : (DATABASE.userPlaylists.find((p) => p.id === s.playlistId) || {}).songs;
      queue = Array.isArray(list) ? list : [];
    }
    const index = queue.findIndex((x) => x.id === song.id);
    STATE.currentQueue = index >= 0 ? queue.slice() : [];
    STATE.baseList = STATE.currentQueue.slice();
    STATE.currentSongIndex = index;
    STATE.currentPlaylistId = index >= 0 ? s.playlistId : null;
    DOM.btnPrev.disabled = DOM.btnNext.disabled = STATE.playContext === "search" || index < 0;

    setMarquee(document.getElementById("np-title"), song.title || "Unknown Title");
    document.getElementById("np-artist").textContent = song.artist || "Unknown Artist";
    if (song.thumbnail) {
      document.getElementById("np-cover").src = song.thumbnail;
      document.getElementById("np-cover").style.display = "block";
      document.getElementById("cover").src = song.thumbnail;
      document.getElementById("cover").style.display = "block";
    }
    const position = Number(s.position) || 0;
    const duration = Number(song.duration) || 0;
    DOM.timeDisplay.textContent = `${formatTime(position)} / ${formatTime(duration)}`;
    if (duration) DOM.progressRing.style.strokeDashoffset = MAX_OFFSET - Math.min(position / duration, 1) * (MAX_OFFSET / 4);

    RESUME.song = song;
    RESUME.position = position;
  }

  // ---------- Keyboard shortcuts ----------
  const MODALS = [
    ["confirm-modal", "confirm-cancel"],
    ["select-playlist-modal", "close-select-modal-btn"],
    ["playlist-modal", "cancel-playlist-btn"],
  ];
  const openModal = () =>
    MODALS.find(([id]) => {
      const el = document.getElementById(id);
      return el && el.style.display !== "none";
    });

  const isTextField = (el) =>
    !!el && (el.isContentEditable || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || (el.tagName === "INPUT" && !/^(range|checkbox|radio|button|submit|file|color)$/i.test(el.type)));

  function focusSearch() {
    const go = () => {
      const input = document.getElementById("search-input");
      if (input) {
        input.focus();
        input.select();
      }
      return !!input;
    };
    if (go()) return;
    document.querySelector('.top-nav li[data-target="search"]').click();
    let tries = 0; // the page appears after a short fade, so wait for the input
    const timer = setInterval(() => {
      if (go() || ++tries > 20) clearInterval(timer);
    }, 50);
  }

  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return; // keep Ctrl+R, Alt+Left, etc. for the system

    // Esc closes one layer at a time: modal -> typing -> volume popup -> lyrics
    if (e.key === "Escape") {
      const modal = openModal();
      if (modal) {
        document.getElementById(modal[1]).click();
        return;
      }
      if (isTextField(e.target)) {
        e.target.blur();
        return;
      }
      if (DOM.volumeContainer.classList.contains("active")) {
        DOM.volumeContainer.classList.remove("active");
        return;
      }
      if (LYRICS.open) toggleLyrics(false);
      else if (queueOpen) toggleQueue(false);
      return;
    }

    if (isTextField(e.target) || openModal()) return;

    switch (e.code) {
      case "Space":
        e.preventDefault();
        if (!e.repeat) togglePlayback();
        break;
      case "ArrowLeft":
      case "ArrowRight":
        if (e.target.type === "range") return; // the volume slider keeps its own arrow keys
        e.preventDefault();
        seekBy(e.code === "ArrowLeft" ? -5 : 5);
        break;
      case "KeyS":
        if (!e.repeat) setShuffle(!STATE.shuffle);
        break;
      case "KeyQ":
        if (!e.repeat) toggleQueue();
        break;
      case "KeyN":
        if (!e.repeat) DOM.btnNext.click();
        break;
      case "KeyP":
        if (!e.repeat) DOM.btnPrev.click();
        break;
      case "KeyM":
        if (!e.repeat) toggleMute();
        break;
      case "KeyR":
        if (!e.repeat) DOM.btnRepeat.click();
        break;
      default:
        if (e.key === "/") {
          e.preventDefault();
          focusSearch();
        }
    }
  });

  // A focused button would also "click" itself when Space is released: stop that
  document.addEventListener("keyup", (e) => {
    if (e.code === "Space" && !isTextField(e.target) && !openModal()) e.preventDefault();
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
      toggleLyrics(false); // leaving the lyrics view when a tab is chosen
      toggleQueue(false);
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

  restoreVolume(); // saved volume
  restoreSession(); // last song (paused) + position
  restoreShuffle(); // saved shuffle on / off
  refreshQueueUI();

  await refreshLocalIds();

  // Long song titles are measured again when the window is resized or the fonts finish loading
  let marqueeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(marqueeTimer);
    marqueeTimer = setTimeout(() => fitMarquees(), 150);
  });
  document.fonts?.ready?.then(() => fitMarquees());

  DOM.navItems.forEach((nav) => nav.classList.remove("active"));
  document.querySelector('[data-target="home"]').classList.add("active");
  renderPage("home");
});