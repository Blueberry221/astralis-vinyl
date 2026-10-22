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

  /** Like createCache, but survives page reloads (localStorage). ttlFor(value) gives each entry's lifetime. */
  function createStoredCache(storageKey, maxEntries, ttlFor) {
    var map = new Map();
    try {
      var raw = JSON.parse(root.localStorage.getItem(storageKey) || "[]");
      if (Array.isArray(raw)) {
        raw.forEach(function (e) {
          if (e && e.k != null && e.v) map.set(e.k, { time: Number(e.t) || 0, value: e.v });
        });
      }
    } catch (e) {}

    function save() {
      var arr = [];
      map.forEach(function (hit, k) { arr.push({ k: k, t: hit.time, v: hit.value }); });
      while (arr.length) {
        try {
          root.localStorage.setItem(storageKey, JSON.stringify(arr));
          return;
        } catch (e) {
          map.delete(arr.shift().k); // storage full: drop the oldest entry and retry
        }
      }
    }

    return {
      get: function (key) {
        var hit = map.get(key);
        if (!hit) return null;
        if (Date.now() - hit.time > ttlFor(hit.value)) {
          map.delete(key);
          save();
          return null;
        }
        return hit.value;
      },
      set: function (key, value) {
        map.delete(key);
        map.set(key, { time: Date.now(), value: value });
        while (map.size > maxEntries) map.delete(map.keys().next().value);
        save();
      },
      size: function () {
        return map.size;
      },
    };
  }

    // ==========================================================================
  // 4. LYRICS HELPERS  (data comes from LRCLIB, see main.js)
  // ==========================================================================
  var TITLE_JUNK_RE =
    /\s*[\(\[\{][^\)\]\}]*(official|lyric|audio|video|visuali[sz]er|m\/v|\bmv\b|\bhd\b|4k|remaster|explicit|full version)[^\)\]\}]*[\)\]\}]/gi;
  var FEAT_BRACKET_RE = /\s*[\(\[]\s*(ft\.?|feat\.?|featuring)\b[^\)\]]*[\)\]]/gi;

  /** "Song (Official Video) [4K] ft. X" -> "Song" */
  function cleanTrackTitle(title) {
    return String(title || "")
      .replace(/[（［｛]/g, "(")
      .replace(/[）］｝]/g, ")")
      .replace(TITLE_JUNK_RE, "")
      .replace(FEAT_BRACKET_RE, "")
      .replace(/\s*[|｜].*$/, "")
      .replace(/\s+(featuring|feat|ft)\b\.?.*$/i, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  /** Best guess of {track, artist} for a lyrics search. Handles "Artist - Title" titles. */
  function norm(s) {
    return String(s || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  }

  function sameName(a, b) {
    a = norm(a); b = norm(b);
    return !!a && !!b && (a === b || a.indexOf(b) !== -1 || b.indexOf(a) !== -1);
  }

  function lyricsQuery(song) {
    var channel = cleanArtist(song.artist || song.uploader || "");
    if (/^unknown artist$/i.test(channel)) channel = "";
    var full = cleanTrackTitle(song.track || song.title || "");
    var track = full, artist = channel, alt = null;

    var m = full.match(/^(.+?)\s+[-–—]\s+(.+)$/);
    if (m) {
      var left = m[1].trim(), right = m[2].trim();
      if (channel && sameName(channel, right) && !sameName(channel, left)) {
        artist = right; track = left;            // "Title - Artist"
      } else if (channel && sameName(channel, left) && !sameName(channel, right)) {
        artist = left; track = right;            // "Artist - Title"
      } else {
        artist = left; track = right;            // unsure: default, but keep the swap as a fallback
        alt = { track: left, artist: right };
      }
    }
    return { track: track, artist: artist, channel: channel, full: full, alt: alt };
  }

    /** Removes hearts, stars, emoji and full-width brackets that break lyric searches. */
  function tidy(s) {
    return String(s || "")
      .replace(/[（［｛]/g, "(")
      .replace(/[）］｝]/g, ")")
      .replace(/[^\p{L}\p{N}\s'&.,!?()\-]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  /** Several possible track names and artist names to try, best guess first. */
  function lyricsCandidates(song) {
    var base = lyricsQuery(song);
    var tracks = [];
    var artists = [];
    function add(list, v) {
      v = tidy(v);
      if (v && list.indexOf(v) === -1) list.push(v);
    }

    // "Song / Artist" style titles: the first piece is usually the song
    var pieces = base.full.split(/\s*\/\s*/);
    if (pieces.length > 1) add(tracks, pieces[0]);
    add(tracks, base.track);
    if (base.alt) add(tracks, base.alt.track);

    [base.artist, base.channel, base.alt && base.alt.artist].forEach(function (a) {
      add(artists, a);
      String(a || "")
        .split(/\s*[\/&,]\s*|\s+(?:feat\.?|ft\.?|x)\s+/i)
        .forEach(function (p) { add(artists, p); });
    });

    return { tracks: tracks, artists: artists, full: base.full };
  }

  function parseLrc(text) {
    var out = [];
    String(text || "")
      .split(/\r?\n/)
      .forEach(function (line) {
        var re = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
        var times = [];
        var last = 0;
        var m;
        while ((m = re.exec(line))) {
          times.push(Number(m[1]) * 60 + Number(m[2]) + (m[3] ? Number("0." + m[3]) : 0));
          last = re.lastIndex;
        }
        if (!times.length) return;
        var words = line.slice(last).trim();
        times.forEach(function (t) {
          out.push({ t: t, text: words });
        });
      });
    out.sort(function (a, b) {
      return a.t - b.t;
    });
    return out;
  }

  /**
   * Chooses the best LRCLIB record: time-synced first, and its length must match the
   * song (a different length = live / remix / other song, so the timing would be wrong).
   * Records that do not match the length can still be used as plain, un-synced text.
   */
  function pickLyrics(list, duration) {
    if (!Array.isArray(list)) list = list ? [list] : [];
    var usable = list.filter(function (x) {
      return x && !x.instrumental && (x.syncedLyrics || x.plainLyrics);
    });
    if (!usable.length) return null;

    var dur = Number(duration) > 0 ? Number(duration) : 0;
    var close = dur
      ? usable.filter(function (x) {
          return !x.duration || Math.abs(x.duration - dur) <= 8;
        })
      : usable;

    if (close.length) {
      close = close.slice().sort(function (a, b) {
        var synced = (b.syncedLyrics ? 1 : 0) - (a.syncedLyrics ? 1 : 0);
        if (synced) return synced;
        return dur ? Math.abs((a.duration || dur) - dur) - Math.abs((b.duration || dur) - dur) : 0;
      });
      return close[0];
    }

    var plain = usable.filter(function (x) {
      return x.plainLyrics;
    })[0];
    return plain ? { plainLyrics: plain.plainLyrics, duration: plain.duration } : null;
  }

  /** LRCLIB record -> {synced, lines:[{t,text}], instrumental?} or null. */
  function lyricsFromRecord(rec) {
    if (!rec) return null;
    if (rec.syncedLyrics) {
      var lines = parseLrc(rec.syncedLyrics);
      if (lines.length) return { synced: true, lines: lines };
    }
    if (rec.plainLyrics) {
      return {
        synced: false,
        lines: String(rec.plainLyrics)
          .split(/\r?\n/)
          .map(function (t) {
            return { t: null, text: t.trim() };
          }),
      };
    }
    return null; // instrumental or empty record = nothing to show
  }

  /** Index of the line being sung at `time` (last line whose start <= time), or -1. */
  function activeLine(lines, time) {
    var lo = 0;
    var hi = lines.length - 1;
    var found = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (lines[mid].t <= time) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return found;
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
    createStoredCache: createStoredCache,
    cleanTrackTitle: cleanTrackTitle,
    lyricsQuery: lyricsQuery,
    parseLrc: parseLrc,
    pickLyrics: pickLyrics,
    lyricsFromRecord: lyricsFromRecord,
    activeLine: activeLine,
    lyricsCandidates: lyricsCandidates,
  };

  root.AstralisUtils = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);