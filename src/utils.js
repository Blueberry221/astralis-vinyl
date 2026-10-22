/**
 * ============================================================================
 * ASTRALIS VINYL - UTILITIES (no Tauri calls in here)
 * ============================================================================
 * Loaded as a normal <script> in <head>, BEFORE main.js:
 *   1. Applies the saved light/dark theme immediately (no white flash on start)
 *   2. Search helpers: parse yt-dlp output, drop non-music, rank, de-duplicate
 *   3. Search history + small result cache
 * Everything is exposed as window.AstralisUtils.
 * ============================================================================
 */
(function (root) {
  "use strict";

  // ==========================================================================
  // 1. THEME BOOTSTRAP
  // ==========================================================================
  var THEME_KEY = "astralis_theme";

  function systemPrefersDark() {
    try {
      return !!(root.matchMedia && root.matchMedia("(prefers-color-scheme: dark)").matches);
    } catch (e) {
      return false;
    }
  }

  function savedTheme() {
    try {
      var t = root.localStorage.getItem(THEME_KEY);
      return t === "light" || t === "dark" ? t : null;
    } catch (e) {
      return null;
    }
  }

  function initialTheme() {
    return savedTheme() || (systemPrefersDark() ? "dark" : "light");
  }

  if (typeof document !== "undefined") {
    document.documentElement.setAttribute("data-theme", initialTheme());
  }

  // ==========================================================================
  // 2. SEARCH RESULT PROCESSING
  // ==========================================================================
  var ID_RE = /^[A-Za-z0-9_-]{11}$/;

  // Titles that are almost never songs. Ignored when the user searched for that word.
  var NON_MUSIC_RE =
    /\b(reaction|reacts?|reacting|tutorial|how to|interview|podcast|trailer|gameplay|walkthrough|unboxing|review|news|vlog|documentary|asmr|prank|highlights|compilation)\b/i;
  var DELETED_RE = /^\[(deleted|private) video\]$/i;

  /** Parses yt-dlp output line by line. One broken line never breaks the rest. */
  function parseLines(raw) {
    var out = [];
    String(raw || "")
      .split("\n")
      .forEach(function (line) {
        line = line.trim();
        if (!line) return;
        try {
          var obj = JSON.parse(line);
          if (obj && typeof obj === "object") out.push(obj);
        } catch (e) {
          /* skip this line */
        }
      });
    return out;
  }

  /** Video id from entry.id, or from its url (watch?v=ID). */
  function idFrom(entry) {
    if (typeof entry.id === "string" && ID_RE.test(entry.id)) return entry.id;
    var m = typeof entry.url === "string" && entry.url.match(/[?&]v=([A-Za-z0-9_-]{11})/);
    return m ? m[1] : null;
  }

  function isHttps(url) {
    return typeof url === "string" && url.indexOf("https://") === 0;
  }

  /**
   * Picks a small, fast thumbnail for the cards:
   *  - square album art (YouTube Music) when available
   *  - otherwise YouTube's 320x180 thumbnail (the old code loaded the biggest one)
   */
  function pickThumbnail(entry, id) {
    var list = Array.isArray(entry.thumbnails) ? entry.thumbnails.filter(function (t) { return t && isHttps(t.url); }) : [];

    var square = list
      .filter(function (t) { return t.width && t.height && t.width === t.height; })
      .sort(function (a, b) { return a.width - b.width; });
    if (square.length) {
      var good = square.filter(function (t) { return t.width >= 120; })[0];
      return (good || square[square.length - 1]).url;
    }

    var album = list.filter(function (t) { return /googleusercontent\.com|ggpht\.com/.test(t.url); });
    if (album.length) return album[album.length - 1].url;

    return "https://i.ytimg.com/vi/" + id + "/mqdefault.jpg";
  }

  /** "Artist - Topic" (auto-generated YouTube channels) -> "Artist" */
  function cleanArtist(name) {
    return String(name || "").replace(/\s*-\s*Topic\s*$/i, "").trim();
  }

  /** Turns one raw yt-dlp entry into the small object the app stores. */
  function normalizeEntry(entry) {
    var id = idFrom(entry);
    var title = typeof entry.title === "string" ? entry.title.trim() : typeof entry.track === "string" ? entry.track.trim() : "";
    if (!id || !title || DELETED_RE.test(title)) return null;

    var rawChannel = entry.channel || entry.uploader || "";
    var artist = (Array.isArray(entry.artists) && entry.artists[0]) || entry.artist || rawChannel;
    var duration = Number(entry.duration);

    return {
      id: id,
      title: title,
      artist: cleanArtist(artist),
      thumbnail: pickThumbnail(entry, id),
      duration: duration > 0 ? Math.round(duration) : null,
      _topic: /-\s*Topic\s*$/i.test(String(rawChannel)),
      _vevo: /vevo/i.test(String(rawChannel)),
    };
  }

  function scoreSong(s) {
    var score = 0;
    if (s._topic) score += 3; // "Artist - Topic" = official audio upload
    if (/official audio|\(audio\)|audio only/i.test(s.title)) score += 2;
    if (/lyric/i.test(s.title)) score += 1;
    if (/official (music )?video|\bm\/v\b/i.test(s.title)) score += 1;
    if (s._vevo) score += 1;
    return score;
  }

  /**
   * Raw yt-dlp output -> clean, ranked song list.
   * @param {string} raw    NDJSON from the Rust "search_song" command
   * @param {string} source "music" (YouTube Music songs) or "youtube" (normal search)
   * @param {string} query  what the user typed
   * @param {number} limit  max results (default 10)
   */
  function processSearch(raw, source, query, limit) {
    var q = String(query || "").toLowerCase();
    var seen = {};
    var minSec = source === "music" ? 30 : 60;
    var maxSec = source === "music" ? 1500 : 720;
    var out = [];

    parseLines(raw).forEach(function (entry, index) {
      var s = normalizeEntry(entry);
      if (!s || seen[s.id]) return;

      if (s.duration === null) {
        if (source !== "music") return; // live streams / premieres are not songs
      } else if (s.duration < minSec || s.duration > maxSec) {
        return;
      }

      if (source !== "music") {
        var m = s.title.match(NON_MUSIC_RE);
        if (m && q.indexOf(m[1].toLowerCase()) === -1) return;
      }

      seen[s.id] = true;
      s._index = index;
      s._score = scoreSong(s);
      out.push(s);
    });

    out.sort(function (a, b) { return b._score - a._score || a._index - b._index; });

    return out.slice(0, limit || 10).map(function (s) {
      return { id: s.id, title: s.title, artist: s.artist, thumbnail: s.thumbnail, duration: s.duration };
    });
  }

  /**
   * The small object we store in recents / playlists. Older saved songs contain the
   * whole yt-dlp JSON (hundreds of KB each); this keeps only what the app displays.
   */
  function compactSong(song) {
    var cover = song.thumbnail || song.cover || "";
    if (!cover && Array.isArray(song.thumbnails) && song.thumbnails.length) {
      cover = song.thumbnails[song.thumbnails.length - 1].url || "";
    }
    var duration = Number(song.duration);
    return {
      id: song.id,
      title: song.track || song.title || "Unknown Title",
      artist: song.artist || song.uploader || "",
      thumbnail: cover,
      duration: duration > 0 ? Math.round(duration) : null,
    };
  }

  /** 225 -> "3:45", 3725 -> "1:02:05" */
  function formatDuration(sec) {
    sec = Math.round(Number(sec));
    if (!sec || sec < 0) return "";
    var h = Math.floor(sec / 3600);
    var m = Math.floor((sec % 3600) / 60);
    var s = sec % 60;
    var ss = (s < 10 ? "0" : "") + s;
    return h ? h + ":" + (m < 10 ? "0" : "") + m + ":" + ss : m + ":" + ss;
  }

  // ==========================================================================
  // 3. SEARCH HISTORY + RESULT CACHE
  // ==========================================================================
  var HISTORY_KEY = "astralis_search_history";

  /** New list with `query` first, no duplicates (case-insensitive), max 10 entries. */
  function addToHistory(list, query, max) {
    var q = String(query || "").trim().replace(/\s+/g, " ");
    if (!q) return (list || []).slice();
    var lower = q.toLowerCase();
    var rest = (list || []).filter(function (x) { return String(x).toLowerCase() !== lower; });
    return [q].concat(rest).slice(0, max || 10);
  }

  function loadHistory() {
    try {
      var parsed = JSON.parse(root.localStorage.getItem(HISTORY_KEY) || "[]");
      return Array.isArray(parsed) ? parsed.filter(function (x) { return typeof x === "string" && x; }).slice(0, 10) : [];
    } catch (e) {
      return [];
    }
  }

  function saveHistory(list) {
    try {
      root.localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
    } catch (e) {
      /* storage unavailable: history just won't persist */
    }
  }

  /** Tiny in-memory cache with expiry, used so a repeated search is instant. */
  function createCache(ttlMs, maxEntries) {
    var map = new Map();
    return {
      get: function (key) {
        var hit = map.get(key);
        if (!hit) return null;
        if (Date.now() - hit.time > ttlMs) {
          map.delete(key);
          return null;
        }
        return hit.value;
      },
      set: function (key, value) {
        map.delete(key);
        map.set(key, { time: Date.now(), value: value });
        while (map.size > maxEntries) map.delete(map.keys().next().value);
      },
      size: function () {
        return map.size;
      },
    };
  }

  var api = {
    THEME_KEY: THEME_KEY,
    initialTheme: initialTheme,
    parseLines: parseLines,
    normalizeEntry: normalizeEntry,
    processSearch: processSearch,
    formatDuration: formatDuration,
    compactSong: compactSong,
    addToHistory: addToHistory,
    loadHistory: loadHistory,
    saveHistory: saveHistory,
    createCache: createCache,
  };

  root.AstralisUtils = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);