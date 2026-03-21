// ==UserScript==
// @name         iwant2gob4ck - YouTube Time Machine
// @namespace    http://tampermonkey.net/
// @license      MIT
// @version      140
// @description  YouTube time machine. Pick a date, see videos from that era. Subscriptions, search terms, categories, and custom topics feed a vintage 2011-themed experience.
// @author       You
// @match        https://www.youtube.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @connect      youtube.com
// @connect      worldtimeapi.org
// @run-at       document-start
// @downloadURL  https://raw.githubusercontent.com/negevch4n/iwant2gob4ck_yt/master/iwant2gob4ck_yt.user.js
// @updateURL    https://raw.githubusercontent.com/negevch4n/iwant2gob4ck_yt/master/iwant2gob4ck_yt.user.js
// ==/UserScript==

(function () {
    'use strict';

    // =========================================================================
    // 1. CONFIG
    // =========================================================================

    const CONFIG = {
        // API
        api: {
            maxResults: 25,
            cooldownMs: 250,
            maxConcurrent: 3,
        },

        // Feed
        feed: {
            dateWindowDays: 7,
            maxHomepageVideos: 60,
            maxRecommendations: 30,
            initialBatchSize: 16,
            loadMoreSize: 12,
            weights: {
                subscriptions: 0.35,
                searchTerms: 0.15,
                categories: 0.20,
                topics: 0.10,
                trending: 0.20,
            },
        },

        // UI
        ui: {
            panelWidth: 320,
            updateInterval: 100,
        },

        // Cache
        cache: {
            ttlMs: 7200000, // 2 hours
        },

        // YouTube category IDs
        categories: {
            1:  'Film & Animation',
            2:  'Autos & Vehicles',
            10: 'Music',
            15: 'Pets & Animals',
            17: 'Sports',
            19: 'Travel & Events',
            20: 'Gaming',
            22: 'People & Blogs',
            23: 'Comedy',
            24: 'Entertainment',
            25: 'News & Politics',
            26: 'How-to & Style',
            27: 'Education',
            28: 'Science & Technology',
        },

        // Selectors to hide
        selectors: {
            shorts: [
                'ytd-reel-shelf-renderer',
                'ytd-rich-shelf-renderer[is-shorts]',
                '[overlay-style="SHORTS"]',
                '.shortsLockupViewModelHost',
                '.ytGridShelfViewModelHost',
                'ytd-reel-item-renderer',
            ],
            chips: [
                'ytd-feed-filter-chip-bar-renderer',
                'ytd-chip-cloud-renderer',
                '#chips',
            ],
        },

        // Broad discovery queries — rotated randomly to surface popular content from any era
        discoveryQueries: [
            '', 'music video', 'trailer', 'funny', 'review', 'highlights',
            'how to', 'compilation', 'reaction', 'vlog', 'tutorial', 'news',
            'challenge', 'prank', 'unboxing', 'animation', 'live', 'top 10',
            'best of', 'cover', 'remix', 'parody', 'documentary', 'interview',
            'behind the scenes', 'gameplay', 'montage', 'fail', 'epic',
        ],
    };

    // =========================================================================
    // 2. STORE  –  single source of truth for persistent data
    // =========================================================================

    class Store {
        static _get(key, fallback) {
            try {
                const raw = GM_getValue(key, undefined);
                if (raw === undefined) return fallback;
                return typeof raw === 'string' ? JSON.parse(raw) : raw;
            } catch {
                return fallback;
            }
        }

        static _set(key, value) {
            GM_setValue(key, JSON.stringify(value));
        }

        static _del(key) {
            GM_deleteValue(key);
        }

        // --- API Keys (legacy, kept for backwards compat) ---
        static getApiKeys()        { return this._get('wayback_persistent_api_keys', []); }
        static setApiKeys(keys)    { this._set('wayback_persistent_api_keys', keys); }
        static getKeyIndex()       { return this._get('wayback_persistent_current_key_index', 0); }
        static setKeyIndex(i)      { this._set('wayback_persistent_current_key_index', i); }
        static getKeyStats()       { return this._get('wayback_persistent_key_stats', {}); }
        static setKeyStats(s)      { this._set('wayback_persistent_key_stats', s); }

        // --- Selected date ---
        static getDate() {
            const d = this._get('wbt_date', null);
            return d || this._get('ytSelectedDate', null);
        }
        static setDate(dateStr) { this._set('wbt_date', dateStr); }

        // --- Subscriptions ---
        static getSubscriptions()   { return this._get('wbt_subscriptions', this._get('ytSubscriptions', [])); }
        static setSubscriptions(s)  { this._set('wbt_subscriptions', s); }

        // --- Search Terms ---
        static getSearchTerms()     { return this._get('wbt_search_terms', this._get('ytSearchTerms', [])); }
        static setSearchTerms(t)    { this._set('wbt_search_terms', t); }

        // --- Categories (array of category IDs) ---
        static getCategories()      { return this._get('wbt_categories', [20, 10, 24]); } // default: Gaming, Music, Entertainment
        static setCategories(c)     { this._set('wbt_categories', c); }

        // --- Custom Topics ---
        static getTopics()          { return this._get('wbt_topics', []); }
        static setTopics(t)         { this._set('wbt_topics', t); }

        // --- Blocked Channels ---
        static getBlockedChannels() { return this._get('wbt_blocked_channels', []); }
        static setBlockedChannels(b) { this._set('wbt_blocked_channels', b); }

        // --- Active state ---
        static isActive()           { return this._get('wbt_active', this._get('ytActive', true)); }
        static setActive(v)         { this._set('wbt_active', v); }

        // --- Minimized state ---
        static isMinimized()        { return this._get('wbt_minimized', false); }
        static setMinimized(v)      { this._set('wbt_minimized', v); }

        // --- Collapsed state (tiny tab) ---
        static isCollapsed()        { return this._get('wbt_collapsed', false); }
        static setCollapsed(v)      { this._set('wbt_collapsed', v); }
        static getTabY()            { return this._get('wbt_tab_y', null); }
        static setTabY(v)           { this._set('wbt_tab_y', v); }

        // --- Profiles ---
        static getProfiles()        { return this._get('wbt_profiles', {}); }
        static setProfiles(p)       { this._set('wbt_profiles', p); }

        static saveProfile(name) {
            const profiles = this.getProfiles();
            profiles[name] = {
                date: this.getDate(),
                subscriptions: this.getSubscriptions(),
                searchTerms: this.getSearchTerms(),
                categories: this.getCategories(),
                topics: this.getTopics(),
                blockedChannels: this.getBlockedChannels(),
                customLogo: this.getCustomLogo(),
                discovery: this.isDiscoveryEnabled(),
                learning: this.isLearningEnabled(),
                savedAt: Date.now(),
            };
            this.setProfiles(profiles);
        }

        static loadProfile(name) {
            const profiles = this.getProfiles();
            const p = profiles[name];
            if (!p) return false;
            if (p.date) this.setDate(p.date);
            if (p.subscriptions) this.setSubscriptions(p.subscriptions);
            if (p.searchTerms) this.setSearchTerms(p.searchTerms);
            if (p.categories) this.setCategories(p.categories);
            if (p.topics) this.setTopics(p.topics);
            if (p.blockedChannels) this.setBlockedChannels(p.blockedChannels);
            if (p.discovery !== undefined) this.setDiscoveryEnabled(p.discovery);
            if (p.learning !== undefined) this.setLearningEnabled(p.learning);
            if (p.customLogo) this.setCustomLogo(p.customLogo);
            else this.clearCustomLogo();
            // Reset clock so it doesn't carry over
            this.stopClock();
            return true;
        }

        static deleteProfile(name) {
            const profiles = this.getProfiles();
            delete profiles[name];
            this.setProfiles(profiles);
        }

        static exportProfile(name) {
            const profiles = this.getProfiles();
            const p = profiles[name];
            if (!p) return null;
            return JSON.stringify({ name, ...p }, null, 2);
        }

        static importProfile(json) {
            const data = JSON.parse(json);
            const name = data.name;
            if (!name) throw new Error('Profile has no name');
            delete data.name;
            const profiles = this.getProfiles();
            profiles[name] = data;
            this.setProfiles(profiles);
            return name;
        }

        // --- Trending/Discovery ---
        static isDiscoveryEnabled()   { return this._get('wbt_discovery', true); }
        static setDiscoveryEnabled(v) { this._set('wbt_discovery', v); }

        // --- Custom logo (data URL) ---
        static getCustomLogo()      { return this._get('wbt_custom_logo', null); }
        static setCustomLogo(dataUrl) { this._set('wbt_custom_logo', dataUrl); }
        static clearCustomLogo()    { this._del('wbt_custom_logo'); }

        // --- Rolling clock ---
        static isClockActive()      { return this._get('wbt_clock_active', false); }
        static setClockActive(v)    { this._set('wbt_clock_active', v); }
        static getClockRealStart()  { return this._get('wbt_clock_real_start', 0); }
        static setClockRealStart(t) { this._set('wbt_clock_real_start', t); }
        static getClockSimStart()   { return this._get('wbt_clock_sim_start', 0); }
        static setClockSimStart(t)  { this._set('wbt_clock_sim_start', t); }
        static getTimeOffset()      { return this._get('wbt_time_offset', 0); }
        static setTimeOffset(v)     { this._set('wbt_time_offset', v); }
        static getLastRefresh()     { return this._get('wbt_last_refresh', 0); }
        static setLastRefresh(t)    { this._set('wbt_last_refresh', t); }

        // --- Seen video IDs (reduce repeats across refreshes) ---
        static getSeenIds()         { return this._get('wbt_seen_ids', []); }
        static setSeenIds(ids)      { this._set('wbt_seen_ids', ids); }
        static addSeenIds(newIds) {
            const ids = this.getSeenIds();
            for (const id of newIds) {
                if (!ids.includes(id)) ids.push(id);
            }
            if (ids.length > 300) ids.splice(0, ids.length - 300);
            this.setSeenIds(ids);
        }
        static clearSeenIds()       { this._del('wbt_seen_ids'); }

        // --- Impression tracking (hide overexposed videos from feed/recommendations) ---
        // Structure: { [videoId]: { count: number, hiddenUntil: number|0 } }
        static getImpressions()     { return this._get('wbt_impressions', {}); }
        static setImpressions(imp)  { this._set('wbt_impressions', imp); }

        // Record that these video IDs were shown. When count hits 3, hide for 1 week.
        static recordImpressions(videoIds) {
            const imp = this.getImpressions();
            const now = Date.now();
            const HIDE_DURATION = 7 * 86400000; // 1 week

            for (const id of videoIds) {
                if (!imp[id]) imp[id] = { count: 0, hiddenUntil: 0 };
                const entry = imp[id];

                // If it was hidden but the hiding period expired, reset its counter
                if (entry.hiddenUntil && entry.hiddenUntil <= now) {
                    entry.count = 0;
                    entry.hiddenUntil = 0;
                }

                entry.count++;

                if (entry.count >= 3) {
                    entry.hiddenUntil = now + HIDE_DURATION;
                    entry.count = 0; // reset so it gets a fresh counter when it comes back
                }
            }

            // Prune: remove entries that are fully expired (not hidden and count 0)
            // and cap at 5000 entries
            const keys = Object.keys(imp);
            if (keys.length > 5000) {
                // Remove oldest expired entries first
                const expiredKeys = keys.filter(k => !imp[k].hiddenUntil && imp[k].count === 0);
                for (const k of expiredKeys.slice(0, keys.length - 4000)) {
                    delete imp[k];
                }
            }

            this.setImpressions(imp);
        }

        // Check if a video is currently hidden due to overexposure
        static isImpressionHidden(videoId) {
            const imp = this.getImpressions();
            const entry = imp[videoId];
            if (!entry || !entry.hiddenUntil) return false;
            return entry.hiddenUntil > Date.now();
        }

        // Returns the current simulated date string (YYYY-MM-DD).
        // If clock is active, advances in real time from the set date.
        static getCurrentDate() {
            if (this.isClockActive()) {
                const realStart = this.getClockRealStart();
                const simStart = this.getClockSimStart();
                if (realStart && simStart) {
                    const realNow = Date.now() + this.getTimeOffset();
                    const simNow = new Date(simStart + (realNow - realStart));
                    return simNow.toISOString().split('T')[0];
                }
            }
            return this.getDate();
        }

        // Returns full simulated Date object (with time)
        static getCurrentDateTime() {
            if (this.isClockActive()) {
                const realStart = this.getClockRealStart();
                const simStart = this.getClockSimStart();
                if (realStart && simStart) {
                    const realNow = Date.now() + this.getTimeOffset();
                    return new Date(simStart + (realNow - realStart));
                }
            }
            const d = this.getDate();
            return d ? new Date(d) : new Date();
        }

        // Activate the clock from a given date string
        static startClock(dateStr) {
            this.setDate(dateStr);
            this.setClockActive(true);
            this.setClockRealStart(Date.now() + this.getTimeOffset());
            this.setClockSimStart(new Date(dateStr).getTime());
        }

        static stopClock() {
            // Freeze at current simulated date
            const current = this.getCurrentDate();
            this.setClockActive(false);
            this.setDate(current);
        }

        // --- Learning ---
        static isLearningEnabled()     { return this._get('wbt_learning', true); }
        static setLearningEnabled(v)   { this._set('wbt_learning', v); }
        static getWatchHistory()       { return this._get('wbt_watch_history', []); }
        static setWatchHistory(h)      { this._set('wbt_watch_history', h); }
        static addWatchEvent(event) {
            const history = this.getWatchHistory();
            if (history.some(e => e.videoId === event.videoId && (event.ts - e.ts) < 300000)) return;
            history.push(event);
            const cutoff = Date.now() - (60 * 86400000);
            const pruned = history.filter(e => e.ts > cutoff);
            if (pruned.length > 200) pruned.splice(0, pruned.length - 200);
            this.setWatchHistory(pruned);
            this._del('wbt_cached_interests');
        }
        static getCachedInterests() {
            const cached = this._get('wbt_cached_interests', null);
            if (cached) return cached;
            const interests = InterestModel.compute();
            this._set('wbt_cached_interests', interests);
            return interests;
        }
        static clearLearningData() {
            this._del('wbt_watch_history');
            this._del('wbt_cached_interests');
            this._del('wbt_load_count');
        }
        static getLoadCount()          { return this._get('wbt_load_count', 0); }
        static incrementLoadCount()    { const c = this.getLoadCount() + 1; this._set('wbt_load_count', c); return c; }

        // --- Unified response cache ---
        static getCacheEntry(key) {
            const entry = this._get(`wbt_cache_${key}`, null);
            if (!entry) return null;
            if (Date.now() - entry.ts > CONFIG.cache.ttlMs) {
                this._del(`wbt_cache_${key}`);
                return null;
            }
            return entry.data;
        }

        static setCacheEntry(key, data) {
            this._set(`wbt_cache_${key}`, { ts: Date.now(), data });
        }
    }

    // =========================================================================
    // 2a. INTEREST MODEL  –  compute channel/keyword scores from watch history
    // =========================================================================

    class InterestModel {
        static YT_STOP_WORDS = new Set([
            'official', 'video', 'full', 'new', 'part', 'episode', 'ep',
            'hd', '4k', 'live', 'stream', 'clip', 'trailer', 'season',
            'ft', 'feat', 'vs', 'vol', 'remix', 'edit', 'reupload',
            'deleted', 'original', 'extended', 'version', 'subtitles',
        ]);

        static compute() {
            const watches = Store.getWatchHistory();
            const now = Date.now();
            const channels = {};
            const keywords = {};

            for (const w of watches) {
                const ageDays = (now - w.ts) / 86400000;
                const decay = Math.pow(0.5, ageDays / 7);

                if (w.channelId) {
                    if (!channels[w.channelId]) channels[w.channelId] = { name: w.channel, score: 0 };
                    channels[w.channelId].score += decay;
                }

                if (w.title) {
                    const stopWords = new Set(['the','a','an','in','on','at','to','for','of','and','or','is','it','my','we','i','you','this','that','with','from','by','be','as','are','was','were','been','has','have','had','do','does','did','but','not','so','if','no','yes']);
                    const kws = w.title.replace(/[^\w\s]/g, '').split(/\s+/)
                        .filter(word => word.length > 2 && !stopWords.has(word.toLowerCase()) && !this.YT_STOP_WORDS.has(word.toLowerCase()));
                    for (const kw of kws.slice(0, 5)) {
                        const lower = kw.toLowerCase();
                        if (!keywords[lower]) keywords[lower] = { score: 0 };
                        keywords[lower].score += decay;
                    }
                }
            }

            return { channels, keywords };
        }

        static getLearnedChannels(interests) {
            return Object.entries(interests.channels)
                .filter(([_, c]) => c.score >= 2)
                .sort((a, b) => b[1].score - a[1].score)
                .slice(0, 10)
                .map(([id, c]) => ({ channelId: id, name: c.name, score: c.score }));
        }

        static getLearnedKeywords(interests) {
            return Object.entries(interests.keywords)
                .filter(([_, k]) => k.score >= 3)
                .sort((a, b) => b[1].score - a[1].score)
                .slice(0, 5)
                .map(([kw, k]) => ({ keyword: kw, score: k.score }));
        }
    }

    // =========================================================================
    // 2b. DATE HELPER  –  recalculate relative dates to set date
    // =========================================================================

    class DateHelper {
        static _msMap = {
            year: 365.25 * 86400000,
            month: 30.44 * 86400000,
            week: 7 * 86400000,
            day: 86400000,
            hour: 3600000,
            minute: 60000,
            second: 1000,
        };

        // "14 years ago" (relative to real now) → approximate Date object
        static approxPublishDate(relativeText) {
            if (!relativeText) return null;
            const clean = relativeText.replace(/^Streamed\s+/i, '');
            const match = clean.match(/(\d+)\s*(year|month|week|day|hour|minute|second)/i);
            if (!match) return null;
            const n = parseInt(match[1], 10);
            const unit = match[2].toLowerCase();
            return new Date(Date.now() - n * (this._msMap[unit] || 0));
        }

        // Date object + reference date → "1 year ago"
        // Never returns "just now" — minimum is "1 day ago"
        static relativeToDate(publishDate, referenceDate, videoId) {
            const diffMs = new Date(referenceDate).getTime() - new Date(publishDate).getTime();

            if (diffMs < 0) {
                // Future date — use hash spread to fake a plausible age
                const h = videoId ? this._hash(videoId) : this._hash(String(publishDate));
                const d = (h % 13) + 1;
                return d === 1 ? '1 day ago' : `${d} days ago`;
            }

            const days = Math.floor(diffMs / 86400000);
            const years = Math.floor(days / 365.25);
            const months = Math.floor(days / 30.44);
            const weeks = Math.floor(days / 7);
            const hours = Math.floor(diffMs / 3600000);

            if (years >= 1)   return years === 1 ? '1 year ago' : `${years} years ago`;
            if (months >= 1)  return months === 1 ? '1 month ago' : `${months} months ago`;
            if (weeks >= 1)   return weeks === 1 ? '1 week ago' : `${weeks} weeks ago`;
            if (days >= 1)    return days === 1 ? '1 day ago' : `${days} days ago`;
            if (hours >= 1)   return hours === 1 ? '1 hour ago' : `${hours} hours ago`;

            // Less than 1 hour — show as "1 day ago" (never "just now" or minutes)
            return '1 day ago';
        }

        // One-shot: InnerTube relative text → text relative to set date
        // Used for native YouTube elements (watch page info, search metadata, etc.)
        static recalcRelative(innertubeText, setDateStr) {
            if (!setDateStr || !innertubeText) return innertubeText || '';
            const pub = this.approxPublishDate(innertubeText);
            if (!pub) return innertubeText;
            const prefix = /^Streamed\s+/i.test(innertubeText) ? 'Streamed ' : '';
            return prefix + this.relativeToDate(pub, setDateStr);
        }

        // Deterministic hash of a string → integer
        static _hash(str) {
            let h = 0;
            for (let i = 0; i < str.length; i++) {
                h = ((h << 5) - h) + str.charCodeAt(i);
                h |= 0;
            }
            return Math.abs(h);
        }

        // For WBT feed cards: use real recalculation when meaningful,
        // otherwise hash-spread for variety (1 day – 3 weeks).
        static recalcForFeed(innertubeText, setDateStr, videoId) {
            if (!setDateStr || !innertubeText) return innertubeText || '';
            const pub = this.approxPublishDate(innertubeText);
            if (!pub) return innertubeText;

            const prefix = /^Streamed\s+/i.test(innertubeText) ? 'Streamed ' : '';
            const real = this.relativeToDate(pub, setDateStr, videoId);

            // If recalculation gives months/years precision, use it
            if (real.includes('year') || real.includes('month')) {
                return prefix + real;
            }

            // For day/week/hour results, use hash-spread for feed variety
            const h = this._hash(videoId || innertubeText);
            const spreadDays = (h % 20) + 1; // 1–20 days ago
            if (spreadDays <= 1)  return prefix + '1 day ago';
            if (spreadDays <= 6)  return prefix + `${spreadDays} days ago`;
            if (spreadDays <= 7)  return prefix + '1 week ago';
            if (spreadDays <= 13) return prefix + `${spreadDays} days ago`;
            return prefix + `${Math.floor(spreadDays / 7)} weeks ago`;
        }
    }

    // =========================================================================
    // 3. YOUTUBE API  –  InnerTube (no API keys needed)
    // =========================================================================

    class YouTubeAPI {
        constructor() {
            this._lastRequest = 0;
            this._configCache = null;
            this._configCacheTs = 0;
            this._pageFetch = null;
            this._initPageFetch();
        }

        // --- Grab the page's native fetch (inherits YouTube's full auth context) ---

        _initPageFetch() {
            try {
                const win = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
                if (win && typeof win.fetch === 'function') {
                    this._pageFetch = win.fetch.bind(win);
                    console.log('[iw2gb] Using page fetch for API calls');
                }
            } catch (e) {
                console.warn('[iw2gb] Could not access page fetch:', e.message);
            }
        }

        // --- Cookie helper ---

        _getCookie(name) {
            try {
                const win = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
                const cookies = win.document.cookie;
                const match = cookies.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
                return match ? decodeURIComponent(match[1]) : null;
            } catch {
                return null;
            }
        }

        // --- SAPISIDHASH auth (required by InnerTube for GM_xmlhttpRequest) ---

        async _getSapisidHash(origin) {
            const sapisid = this._getCookie('SAPISID') || this._getCookie('__Secure-3PAPISID');
            if (!sapisid) return null;

            const timestamp = Math.floor(Date.now() / 1000);
            const input = `${timestamp} ${sapisid} ${origin}`;

            try {
                const encoder = new TextEncoder();
                const data = encoder.encode(input);
                const hashBuffer = await crypto.subtle.digest('SHA-1', data);
                const hashArray = Array.from(new Uint8Array(hashBuffer));
                const hash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
                return `SAPISIDHASH ${timestamp}_${hash}`;
            } catch {
                return null;
            }
        }

        // --- InnerTube config ---

        _getConfig() {
            // Cache for 30s to avoid re-reading ytcfg on every request
            if (this._configCache && Date.now() - this._configCacheTs < 30000) {
                return this._configCache;
            }

            let cfg = null;
            try {
                const win = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
                cfg = win.ytcfg?.data_;
            } catch { /* fallback */ }

            // Extract the FULL InnerTube context (includes all fields YouTube expects)
            let fullContext = null;
            if (cfg?.INNERTUBE_CONTEXT) {
                try {
                    // Deep clone to avoid mutating YouTube's own object
                    fullContext = JSON.parse(JSON.stringify(cfg.INNERTUBE_CONTEXT));
                } catch { /* fallback to manual context */ }
            }

            const result = {
                apiKey: cfg?.INNERTUBE_API_KEY || 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8',
                clientVersion: cfg?.INNERTUBE_CLIENT_VERSION || '2.20260301.00.00',
                fullContext, // complete context object from YouTube
            };

            if (!this._configCache) {
                console.log('[iw2gb] ytcfg: version=' + result.clientVersion +
                    ', key=' + result.apiKey.substring(0, 10) + '...' +
                    ', fullContext=' + (fullContext ? 'YES' : 'NO'));
            }

            this._configCache = result;
            this._configCacheTs = Date.now();
            return result;
        }

        // --- Strategy 1: page fetch (inherits YouTube's own auth/cookies) ---

        async _postViaFetch(url, fullBody) {
            if (!this._pageFetch) return null;

            try {
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), 15000);

                const resp = await this._pageFetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(fullBody),
                    credentials: 'include',
                    signal: controller.signal,
                });
                clearTimeout(timeout);

                if (resp.ok) {
                    return await resp.json();
                }
                // 403 is expected (Tampermonkey proxy detection) — silently fall through to GM
                if (resp.status !== 403) {
                    console.warn(`[iw2gb] page fetch HTTP ${resp.status}`);
                }
                return null; // fall through to GM_xmlhttpRequest
            } catch (e) {
                console.warn('[iw2gb] page fetch error:', e.message);
                return null;
            }
        }

        // --- Strategy 2: GM_xmlhttpRequest with manual auth headers ---

        _postViaGM(url, fullBody, headers) {
            return new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: 'POST',
                    url,
                    headers,
                    data: JSON.stringify(fullBody),
                    timeout: 15000,
                    onload(res) {
                        if (res.status >= 200 && res.status < 300) {
                            try { resolve(JSON.parse(res.responseText)); }
                            catch { reject(new Error('Invalid JSON')); }
                        } else {
                            const err = new Error(`InnerTube HTTP ${res.status}`);
                            err.status = res.status;
                            reject(err);
                        }
                    },
                    onerror() { reject(new Error('Network error')); },
                    ontimeout() { reject(new Error('Request timed out (15s)')); },
                });
            });
        }

        // --- Build request context (use YouTube's full context if available) ---

        _buildContext(cfg) {
            if (cfg.fullContext) {
                return cfg.fullContext;
            }
            // Fallback: minimal context (shouldn't happen if ytcfg loaded)
            return {
                client: {
                    clientName: 'WEB',
                    clientVersion: cfg.clientVersion,
                    hl: 'en',
                    gl: 'US',
                },
            };
        }

        // --- Core InnerTube POST: page fetch first, then GM_xmlhttpRequest ---

        async _post(endpoint, body) {
            await this._rateLimit();

            const cfg = this._getConfig();
            const url = `https://www.youtube.com/youtubei/v1/${endpoint}?key=${cfg.apiKey}&prettyPrint=false`;

            const fullBody = {
                context: this._buildContext(cfg),
                ...body,
            };

            // Try page's native fetch first (has YouTube's full auth context)
            const fetchResult = await this._postViaFetch(url, fullBody);
            if (fetchResult) return fetchResult;

            // Fallback: GM_xmlhttpRequest with manual headers + SAPISIDHASH
            const headers = {
                'Content-Type': 'application/json',
                'X-YouTube-Client-Name': '1',
                'X-YouTube-Client-Version': cfg.clientVersion,
                'X-Origin': 'https://www.youtube.com',
                'Origin': 'https://www.youtube.com',
                'Referer': 'https://www.youtube.com/',
            };

            const authHeader = await this._getSapisidHash('https://www.youtube.com');
            if (authHeader) {
                headers['Authorization'] = authHeader;
                headers['X-Goog-AuthUser'] = '0';
            }

            // First GM attempt
            try {
                return await this._postViaGM(url, fullBody, headers);
            } catch (err) {
                // Retry once on 403/5xx with fresh config
                if (err.status === 403 || (err.status >= 500 && err.status < 600)) {
                    console.warn(`[iw2gb] ${endpoint} got ${err.status}, retrying in 1s...`);
                    this._configCache = null;
                    await new Promise(r => setTimeout(r, 1000));

                    const cfg2 = this._getConfig();
                    const url2 = `https://www.youtube.com/youtubei/v1/${endpoint}?key=${cfg2.apiKey}&prettyPrint=false`;
                    headers['X-YouTube-Client-Version'] = cfg2.clientVersion;
                    const auth2 = await this._getSapisidHash('https://www.youtube.com');
                    if (auth2) headers['Authorization'] = auth2;

                    fullBody.context = this._buildContext(cfg2);

                    return await this._postViaGM(url2, fullBody, headers);
                }
                throw err;
            }
        }

        async _rateLimit() {
            const now = Date.now();
            const wait = CONFIG.api.cooldownMs - (now - this._lastRequest);
            if (wait > 0) await new Promise(r => setTimeout(r, wait));
            this._lastRequest = Date.now();
        }

        // --- Parse InnerTube search results ---

        _parseSearchResults(data) {
            const results = [];
            try {
                const sections = data?.contents?.twoColumnSearchResultsRenderer
                    ?.primaryContents?.sectionListRenderer?.contents || [];
                for (const section of sections) {
                    const items = section?.itemSectionRenderer?.contents || [];
                    for (const item of items) {
                        if (item.videoRenderer) {
                            const v = item.videoRenderer;
                            const viewText = v.viewCountText?.simpleText || v.viewCountText?.runs?.[0]?.text || '';
                            const relDate = v.publishedTimeText?.simpleText || '';
                            results.push({
                                id: v.videoId,
                                title: v.title?.runs?.[0]?.text || '',
                                channel: v.ownerText?.runs?.[0]?.text || v.longBylineText?.runs?.[0]?.text || '',
                                channelId: v.ownerText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId || '',
                                thumbnail: v.thumbnail?.thumbnails?.slice(-1)?.[0]?.url || '',
                                publishedAt: '',
                                viewCount: this._parseViewCount(viewText),
                                viewCountFormatted: viewText || '0 views',
                                relativeDate: relDate,
                            });
                        }
                    }
                }
            } catch (e) {
                console.warn('[iw2gb] Parse error:', e.message);
            }
            return results;
        }

        _parsePlaylistResults(data) {
            const results = [];
            try {
                // Navigate the browse response for playlist/uploads
                const tabs = data?.contents?.twoColumnBrowseResultsRenderer?.tabs
                    || data?.contents?.singleColumnBrowseResultsRenderer?.tabs || [];
                let items = [];
                for (const tab of tabs) {
                    const contents = tab?.tabRenderer?.content?.sectionListRenderer?.contents
                        || tab?.tabRenderer?.content?.richGridRenderer?.contents || [];
                    for (const section of contents) {
                        const sectionItems = section?.itemSectionRenderer?.contents?.[0]
                            ?.playlistVideoListRenderer?.contents || [];
                        items.push(...sectionItems);
                    }
                }
                // Also try the direct playlist path
                if (!items.length) {
                    items = data?.contents?.twoColumnBrowseResultsRenderer?.tabs?.[0]
                        ?.tabRenderer?.content?.sectionListRenderer?.contents?.[0]
                        ?.itemSectionRenderer?.contents?.[0]
                        ?.playlistVideoListRenderer?.contents || [];
                }
                for (const item of items) {
                    const v = item.playlistVideoRenderer;
                    if (!v || !v.videoId) continue;
                    const viewText = v.videoInfo?.runs?.[0]?.text || '';
                    const relDate = v.videoInfo?.runs?.[2]?.text || '';
                    results.push({
                        id: v.videoId,
                        title: v.title?.runs?.[0]?.text || v.title?.simpleText || '',
                        channel: v.shortBylineText?.runs?.[0]?.text || '',
                        channelId: v.shortBylineText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId || '',
                        thumbnail: v.thumbnail?.thumbnails?.slice(-1)?.[0]?.url || '',
                        publishedAt: '',
                        viewCount: this._parseViewCount(viewText),
                        viewCountFormatted: viewText || '0 views',
                        relativeDate: relDate,
                    });
                }
            } catch (e) {
                console.warn('[iw2gb] Playlist parse error:', e.message);
            }
            return results;
        }

        _parseChannelResults(data) {
            try {
                const sections = data?.contents?.twoColumnSearchResultsRenderer
                    ?.primaryContents?.sectionListRenderer?.contents || [];
                for (const section of sections) {
                    const items = section?.itemSectionRenderer?.contents || [];
                    for (const item of items) {
                        if (item.channelRenderer) {
                            const ch = item.channelRenderer;
                            return {
                                id: ch.channelId,
                                name: ch.title?.simpleText || ch.title?.runs?.[0]?.text || '',
                            };
                        }
                    }
                }
            } catch { /* fall through */ }
            return null;
        }

        _parseViewCount(text) {
            if (!text) return 0;
            const clean = text.replace(/,/g, '').toLowerCase();
            const match = clean.match(/([\d.]+)\s*([kmb])?/);
            if (!match) return 0;
            const num = parseFloat(match[1]);
            const suffix = match[2];
            if (suffix === 'b') return Math.round(num * 1e9);
            if (suffix === 'm') return Math.round(num * 1e6);
            if (suffix === 'k') return Math.round(num * 1e3);
            return Math.round(num);
        }

        // --- Date operators for InnerTube search ---

        _buildDateQuery(query, publishedAfter, publishedBefore) {
            let q = query || '';
            if (publishedAfter) {
                const d = publishedAfter instanceof Date ? publishedAfter : new Date(publishedAfter);
                q += ` after:${d.toISOString().split('T')[0]}`;
            }
            if (publishedBefore) {
                const d = publishedBefore instanceof Date ? publishedBefore : new Date(publishedBefore);
                q += ` before:${d.toISOString().split('T')[0]}`;
            }
            return q.trim();
        }

        // --- High-level methods ---

        async searchVideos(query, { publishedAfter, publishedBefore, maxResults, order = 'relevance', categoryId } = {}) {
            let q = this._buildDateQuery(query, publishedAfter, publishedBefore);

            // Append category name to query if provided
            if (categoryId && CONFIG.categories[categoryId]) {
                q = `${CONFIG.categories[categoryId]} ${q}`.trim();
            }

            // Determine params for sort/filter
            let params;
            if (order === 'viewCount') {
                params = 'CAMSAhAB'; // sort by view count + videos only
            } else {
                params = 'EgIQAQ=='; // videos only
            }

            const body = { query: q, params };
            const data = await this._post('search', body);
            const results = this._parseSearchResults(data);
            return results.slice(0, maxResults || CONFIG.api.maxResults);
        }

        async getChannelVideos(channelName, { publishedAfter, publishedBefore, maxResults, order = 'date', channelId } = {}) {
            // If we have a channel ID, use the browse endpoint to get actual uploads
            if (channelId && channelId.startsWith('UC')) {
                try {
                    const uploadsPlaylistId = 'UU' + channelId.slice(2);
                    const data = await this._post('browse', { browseId: `VL${uploadsPlaylistId}` });
                    const results = this._parsePlaylistResults(data);
                    // Filter by date client-side
                    const filtered = results.filter(v => {
                        const approx = DateHelper.approxPublishDate(v.relativeDate);
                        if (!approx) return true; // keep if we can't determine date
                        if (publishedAfter && approx < new Date(publishedAfter)) return false;
                        if (publishedBefore && approx > new Date(publishedBefore)) return false;
                        return true;
                    });
                    if (filtered.length > 0) {
                        return filtered.slice(0, maxResults || CONFIG.api.maxResults);
                    }
                    // Fall through to search if browse returned nothing in range
                } catch (e) {
                    console.warn('[iw2gb] Browse fallback for', channelName, e.message);
                }
            }
            // Fallback: search for channel name (unquoted for broader match)
            const q = this._buildDateQuery(channelName, publishedAfter, publishedBefore);
            const body = { query: q, params: 'EgIQAQ==' }; // videos only
            const data = await this._post('search', body);
            const results = this._parseSearchResults(data);
            return results.slice(0, maxResults || CONFIG.api.maxResults);
        }

        async getPopularByCategory(categoryId, { publishedAfter, publishedBefore, maxResults } = {}) {
            return this.searchVideos('', {
                publishedAfter,
                publishedBefore,
                maxResults: maxResults || CONFIG.api.maxResults,
                order: 'relevance',
                categoryId,
            });
        }

        async getVideoDetails(videoIds) {
            if (!videoIds.length) return [];

            // Use /next endpoint to get video info
            const results = [];
            for (const videoId of videoIds.slice(0, 5)) { // limit to avoid too many requests
                try {
                    const data = await this._post('next', { videoId });
                    const primary = data?.contents?.twoColumnWatchNextResults?.results?.results?.contents;
                    if (primary) {
                        for (const content of primary) {
                            const vp = content?.videoPrimaryInfoRenderer;
                            const vs = content?.videoSecondaryInfoRenderer;
                            if (vp) {
                                const viewText = vp.viewCount?.videoViewCountRenderer?.viewCount?.simpleText || '';
                                const title = vp.title?.runs?.[0]?.text || '';
                                const channelName = vs?.owner?.videoOwnerRenderer?.title?.runs?.[0]?.text || '';
                                const channelId = vs?.owner?.videoOwnerRenderer?.title?.runs?.[0]
                                    ?.navigationEndpoint?.browseEndpoint?.browseId || '';
                                results.push({
                                    id: videoId,
                                    title,
                                    channel: channelName,
                                    channelId,
                                    viewCount: this._parseViewCount(viewText),
                                });
                                break;
                            }
                        }
                    }
                } catch { /* skip individual failures */ }
            }
            return results;
        }

        async resolveChannel(input) {
            // Try as @handle or channel name via search with channel filter
            const searchQuery = input.startsWith('@') ? input : `"${input}"`;
            const body = { query: searchQuery, params: 'EgIQAg==' }; // channels only
            const data = await this._post('search', body);
            const ch = this._parseChannelResults(data);
            if (ch) return ch;

            return null;
        }

        // Fetch the actual ISO publish date for a video via /player endpoint
        async getPublishDate(videoId) {
            try {
                const data = await this._post('player', { videoId });
                return data?.microformat?.playerMicroformatRenderer?.publishDate
                    || data?.microformat?.playerMicroformatRenderer?.uploadDate
                    || '';
            } catch {
                return '';
            }
        }
    }

    // =========================================================================
    // 4. FEED ENGINE  –  assembles feeds from 4 sources
    // =========================================================================

    class FeedEngine {
        constructor(api) {
            this.api = api;
        }

        // --- Date window ---

        _dateWindow(selectedDate) {
            const d = new Date(selectedDate);
            const days = CONFIG.feed.dateWindowDays;
            const after = new Date(d);
            after.setDate(after.getDate() - days);
            const before = new Date(d);
            before.setDate(before.getDate() + days);
            return { after, before, center: d };
        }

        // --- Round-robin interleave: ensures even spread across sub-sources ---

        _interleave(batches) {
            const result = [];
            const maxLen = Math.max(0, ...batches.map(b => b.length));
            for (let i = 0; i < maxLen; i++) {
                for (const batch of batches) {
                    if (i < batch.length) result.push(batch[i]);
                }
            }
            return result;
        }

        // --- Deduplication ---

        _dedupe(videos) {
            const seen = new Set();
            const blocked = new Set(Store.getBlockedChannels().map(b => b.name.toLowerCase()));
            const blockedIds = new Set(Store.getBlockedChannels().map(b => b.id).filter(Boolean));
            return videos.filter(v => {
                if (!v || seen.has(v.id)) return false;
                // Filter blocked channels by name or ID
                if (v.channel && blocked.has(v.channel.toLowerCase())) return false;
                if (v.channelId && blockedIds.has(v.channelId)) return false;
                seen.add(v.id);
                return true;
            });
        }

        // --- Weighted shuffle: gentle bias toward videos closer to center date ---

        _weightedShuffle(videos, centerDate) {
            const center = new Date(centerDate).getTime();
            const weighted = videos.map(v => {
                let pub = v.publishedAt ? new Date(v.publishedAt).getTime() : 0;
                if (!pub || isNaN(pub)) {
                    const d = DateHelper.approxPublishDate(v.relativeDate);
                    pub = d ? d.getTime() : 0;
                }
                if (!pub) pub = center; // fallback to center if we can't determine date
                const daysDiff = Math.max(1, Math.abs(center - pub) / 86400000);
                // Gentle curve: newer content is favored but older stuff still comes through
                // 1 day → 1.0, 7 days → 0.53, 30 days → 0.30, 90 days → 0.22, 365 days → 0.16
                const weight = 1 / Math.pow(daysDiff, 0.3);
                return { v, sort: Math.random() * weight };
            });
            weighted.sort((a, b) => b.sort - a.sort);
            return weighted.map(w => w.v);
        }

        // --- Fetch from each source ---

        async _fetchSubscriptions(dateWindow, count) {
            const subs = Store.getSubscriptions();

            // Inject learned channels
            let allSubs = [...subs];
            if (Store.isLearningEnabled()) {
                const interests = Store.getCachedInterests();
                if (interests) {
                    const learned = InterestModel.getLearnedChannels(interests);
                    const explicitIds = new Set(subs.map(s => s.id).filter(Boolean));
                    for (const lc of learned) {
                        if (!explicitIds.has(lc.channelId)) {
                            allSubs.push({ id: lc.channelId, name: lc.name, weight: Math.min(3, Math.round(lc.score)), _learned: true });
                        }
                    }
                }
            }

            if (!allSubs.length) return [];

            const cacheKey = `subs_${dateWindow.center.toDateString()}`;
            const cached = Store.getCacheEntry(cacheKey);
            if (cached) return cached;

            const totalWeight = allSubs.reduce((sum, s) => sum + (s.weight || 3), 0);
            const batches = await Promise.allSettled(
                allSubs.map(sub => {
                    const w = sub.weight || 3;
                    const perChannel = Math.max(3, Math.ceil(count * w / totalWeight));
                    return this.api.getChannelVideos(sub.name, {
                        publishedAfter: dateWindow.after,
                        publishedBefore: dateWindow.before,
                        maxResults: perChannel,
                        order: 'date',
                        channelId: sub.id,
                    });
                })
            );

            // Round-robin interleave so no single channel dominates the pool
            const perSource = batches.filter(r => r.status === 'fulfilled').map(r => r.value);
            const videos = this._interleave(perSource);

            if (videos.length) Store.setCacheEntry(cacheKey, videos);
            return videos;
        }

        async _fetchSearchTerms(dateWindow, count) {
            const raw = Store.getSearchTerms();
            const terms = raw.map(t => typeof t === 'string' ? { term: t, weight: 3 } : t);

            // Inject learned keywords
            let allTerms = [...terms];
            if (Store.isLearningEnabled()) {
                const interests = Store.getCachedInterests();
                if (interests) {
                    const learned = InterestModel.getLearnedKeywords(interests);
                    const existingTerms = new Set(terms.map(t => t.term.toLowerCase()));
                    for (const lk of learned) {
                        if (!existingTerms.has(lk.keyword)) {
                            allTerms.push({ term: lk.keyword, weight: 2, _learned: true });
                        }
                    }
                }
            }

            if (!allTerms.length) return [];

            const cacheKey = `search_${dateWindow.center.toDateString()}`;
            const cached = Store.getCacheEntry(cacheKey);
            if (cached) return cached;

            const totalWeight = allTerms.reduce((sum, t) => sum + (t.weight || 3), 0);
            const batches = await Promise.allSettled(
                allTerms.map(t => {
                    const w = t.weight || 3;
                    const perTerm = Math.max(3, Math.ceil(count * w / totalWeight));
                    return this.api.searchVideos(t.term, {
                        publishedAfter: dateWindow.after,
                        publishedBefore: dateWindow.before,
                        maxResults: perTerm,
                        order: 'relevance',
                    });
                })
            );

            // Round-robin interleave so no single term dominates the pool
            const perSource = batches.filter(r => r.status === 'fulfilled').map(r => r.value);
            const videos = this._interleave(perSource);

            if (videos.length) Store.setCacheEntry(cacheKey, videos);
            return videos;
        }

        async _fetchCategories(dateWindow, count) {
            const cats = Store.getCategories();
            if (!cats.length) return [];

            const cacheKey = `cats_${cats.join('_')}_${dateWindow.center.toDateString()}`;
            const cached = Store.getCacheEntry(cacheKey);
            if (cached) return cached;

            const perCat = Math.max(5, Math.ceil(count / cats.length));
            const batches = await Promise.allSettled(
                cats.map(catId =>
                    this.api.getPopularByCategory(catId, {
                        publishedAfter: dateWindow.after,
                        publishedBefore: dateWindow.before,
                        maxResults: perCat,
                    })
                )
            );

            // Round-robin interleave so no single category dominates the pool
            const catSources = batches.filter(r => r.status === 'fulfilled').map(r => r.value);
            const videos = this._interleave(catSources);

            if (videos.length) Store.setCacheEntry(cacheKey, videos);
            return videos;
        }

        async _fetchTopics(dateWindow, count) {
            const raw = Store.getTopics();
            // Normalize legacy string format to { name, weight }
            const topics = raw.map(t => typeof t === 'string' ? { name: t, weight: 3 } : t);
            if (!topics.length) return [];

            const cacheKey = `topics_${dateWindow.center.toDateString()}`;
            const cached = Store.getCacheEntry(cacheKey);
            if (cached) return cached;

            const totalWeight = topics.reduce((sum, t) => sum + (t.weight || 3), 0);
            const batches = await Promise.allSettled(
                topics.map(topic => {
                    const w = topic.weight || 3;
                    const perTopic = Math.max(3, Math.ceil(count * w / totalWeight));
                    return this.api.searchVideos(topic.name || topic, {
                        publishedAfter: dateWindow.after,
                        publishedBefore: dateWindow.before,
                        maxResults: perTopic,
                        order: 'relevance',
                    });
                })
            );

            // Round-robin interleave so no single topic dominates the pool
            const topicSources = batches.filter(r => r.status === 'fulfilled').map(r => r.value);
            const videos = this._interleave(topicSources);

            if (videos.length) Store.setCacheEntry(cacheKey, videos);
            return videos;
        }

        async _fetchTrending(dateWindow, count) {
            if (!Store.isDiscoveryEnabled()) return [];

            const cacheKey = `trending_${dateWindow.center.toDateString()}`;
            const cached = Store.getCacheEntry(cacheKey);
            if (cached) return cached;

            const videos = await this._fetchTrendingInner(dateWindow, count);
            if (videos.length) Store.setCacheEntry(cacheKey, videos);
            return videos;
        }

        async _fetchTrendingInner(dateWindow, count) {
            // Pick 4 random queries from the pool
            const pool = [...CONFIG.discoveryQueries];
            const picked = [];
            for (let i = 0; i < 4 && pool.length; i++) {
                const idx = Math.floor(Math.random() * pool.length);
                picked.push(pool.splice(idx, 1)[0]);
            }

            const perQuery = Math.max(5, Math.ceil(count / picked.length));
            const batches = await Promise.allSettled(
                picked.map(q =>
                    this.api.searchVideos(q, {
                        publishedAfter: dateWindow.after,
                        publishedBefore: dateWindow.before,
                        maxResults: perQuery,
                        order: 'viewCount',
                    })
                )
            );

            return batches
                .filter(r => r.status === 'fulfilled')
                .flatMap(r => r.value);
        }

        // --- Effective weights (adjusted by learning) ---

        _getEffectiveWeights() {
            if (!Store.isLearningEnabled()) return CONFIG.feed.weights;
            const interests = Store.getCachedInterests();
            if (!interests) return CONFIG.feed.weights;

            const learnedCh = InterestModel.getLearnedChannels(interests).length;
            const learnedKw = InterestModel.getLearnedKeywords(interests).length;

            const w = { ...CONFIG.feed.weights };
            const subBoost = Math.min(0.10, learnedCh * 0.02);
            const termBoost = Math.min(0.05, learnedKw * 0.01);
            w.subscriptions += subBoost;
            w.searchTerms += termBoost;
            w.trending = Math.max(0.05, w.trending - subBoost - termBoost);
            return w;
        }

        // --- Mix sources with configured weights ---

        _mixSources(sources, weights) {
            // sources: { subscriptions, searchTerms, categories, topics, trending }
            const w = weights || CONFIG.feed.weights;
            const total = CONFIG.feed.maxHomepageVideos;
            const mixed = [];

            const take = (arr, n) => {
                const shuffled = [...arr].sort(() => Math.random() - 0.5);
                return shuffled.slice(0, n);
            };

            // Calculate how many from each source
            const counts = {
                subscriptions: Math.round(total * w.subscriptions),
                searchTerms:   Math.round(total * w.searchTerms),
                categories:    Math.round(total * w.categories),
                topics:        Math.round(total * w.topics),
                trending:      Math.round(total * w.trending),
            };

            // Take from each, then redistribute unfilled slots
            for (const [key, count] of Object.entries(counts)) {
                const available = sources[key] || [];
                const taken = take(available, count);
                mixed.push(...taken);
            }

            // If we didn't fill enough, take more from whatever has extras
            if (mixed.length < total) {
                const remaining = total - mixed.length;
                const all = Object.values(sources).flat();
                const ids = new Set(mixed.map(v => v.id));
                const extras = all.filter(v => !ids.has(v.id));
                mixed.push(...take(extras, remaining));
            }

            return mixed;
        }

        // --- Public API ---

        async buildHomeFeed(selectedDate) {
            // Wrap the entire feed build in a 30s timeout so loading can't hang forever
            const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Feed build timed out (30s)')), 30000)
            );
            return Promise.race([this._buildHomeFeedInner(selectedDate), timeoutPromise]);
        }

        async _buildHomeFeedInner(selectedDate) {
            const total = CONFIG.feed.maxHomepageVideos;
            const d = new Date(selectedDate);

            // Subscriptions: tight window (recent uploads from channels you follow)
            const subWindow = this._dateWindow(selectedDate);

            // Other sources: wider windows for natural temporal variety
            // Search terms / topics: ±90 days — stuff from around that era
            const searchWindow = {
                after: new Date(d.getTime() - 90 * 86400000),
                before: new Date(d.getTime() + 7 * 86400000),
                center: d,
            };
            // Categories: ±180 days — broader cultural content from that period
            const catWindow = {
                after: new Date(d.getTime() - 180 * 86400000),
                before: new Date(d.getTime() + 7 * 86400000),
                center: d,
            };
            // Trending/discovery: up to 1 year back — surface older popular content
            const trendWindow = {
                after: new Date(d.getTime() - 365 * 86400000),
                before: new Date(d.getTime() + 7 * 86400000),
                center: d,
            };

            // Learning: compute effective weights (every 10th load = exploration burst)
            const loadNum = Store.incrementLoadCount();
            const isExploration = loadNum % 10 === 0;
            const weights = isExploration ? CONFIG.feed.weights : this._getEffectiveWeights();

            // Fetch all 5 sources in parallel with per-source date windows
            // Use allSettled so one failing source doesn't kill the whole feed
            const results = await Promise.allSettled([
                this._fetchSubscriptions(subWindow, Math.round(total * weights.subscriptions * 2)),
                this._fetchSearchTerms(searchWindow, Math.round(total * weights.searchTerms * 2)),
                this._fetchCategories(catWindow, Math.round(total * weights.categories * 2)),
                this._fetchTopics(searchWindow, Math.round(total * weights.topics * 2)),
                this._fetchTrending(trendWindow, Math.round(total * weights.trending * 2)),
            ]);

            const subscriptions = results[0].status === 'fulfilled' ? results[0].value : [];
            const searchTerms  = results[1].status === 'fulfilled' ? results[1].value : [];
            const categories   = results[2].status === 'fulfilled' ? results[2].value : [];
            const topics       = results[3].status === 'fulfilled' ? results[3].value : [];
            const trending     = results[4].status === 'fulfilled' ? results[4].value : [];

            // Log which sources failed so we can debug
            const names = ['subscriptions', 'searchTerms', 'categories', 'topics', 'trending'];
            results.forEach((r, i) => {
                if (r.status === 'rejected') {
                    console.warn(`[iw2gb] ${names[i]} fetch failed:`, r.reason?.message || r.reason);
                }
            });

            // Mix and deduplicate
            const mixed = this._mixSources({ subscriptions, searchTerms, categories, topics, trending }, weights);
            const deduped = this._dedupe(mixed);

            // Filter out videos hidden due to overexposure (shown 3+ times → hidden for 1 week)
            const notHidden = deduped.filter(v => !Store.isImpressionHidden(v.id));

            // Deprioritize recently seen videos so refreshes show new content
            const seen = new Set(Store.getSeenIds());
            const unseen = notHidden.filter(v => !seen.has(v.id));
            const seenVids = notHidden.filter(v => seen.has(v.id));

            return [
                ...this._weightedShuffle(unseen, d),
                ...this._weightedShuffle(seenVids, d),
            ];
        }

        async buildHomeFeedMore(selectedDate, page, excludeIds) {
            const d = new Date(selectedDate);
            const days = CONFIG.feed.dateWindowDays;
            // Shift the window backward: page 1 = original, page 2 = 2 weeks earlier, etc.
            d.setDate(d.getDate() - days * 2 * (page - 1));
            const shiftedDate = d.toISOString().split('T')[0];

            const dateWindow = this._dateWindow(shiftedDate);
            const total = CONFIG.feed.maxHomepageVideos;

            const results = await Promise.allSettled([
                this._fetchSubscriptionsUncached(dateWindow, Math.round(total * CONFIG.feed.weights.subscriptions * 2)),
                this._fetchSearchTermsUncached(dateWindow, Math.round(total * CONFIG.feed.weights.searchTerms * 2)),
                this._fetchCategoriesUncached(dateWindow, Math.round(total * CONFIG.feed.weights.categories * 2)),
                this._fetchTopicsUncached(dateWindow, Math.round(total * CONFIG.feed.weights.topics * 2)),
                this._fetchTrendingUncached(dateWindow, Math.round(total * CONFIG.feed.weights.trending * 2)),
            ]);

            const subscriptions = results[0].status === 'fulfilled' ? results[0].value : [];
            const searchTerms  = results[1].status === 'fulfilled' ? results[1].value : [];
            const categories   = results[2].status === 'fulfilled' ? results[2].value : [];
            const topics       = results[3].status === 'fulfilled' ? results[3].value : [];
            const trending     = results[4].status === 'fulfilled' ? results[4].value : [];

            const mixed = this._mixSources({ subscriptions, searchTerms, categories, topics, trending });
            const deduped = this._dedupe(mixed);

            // Filter out already-displayed videos and impression-hidden videos
            const fresh = deduped.filter(v => !excludeIds.has(v.id) && !Store.isImpressionHidden(v.id));

            return this._weightedShuffle(fresh, dateWindow.center);
        }

        // Uncached fetch variants for infinite scroll
        async _fetchSubscriptionsUncached(dateWindow, count) {
            const subs = Store.getSubscriptions();
            let allSubs = [...subs];
            if (Store.isLearningEnabled()) {
                const interests = Store.getCachedInterests();
                if (interests) {
                    const learned = InterestModel.getLearnedChannels(interests);
                    const explicitIds = new Set(subs.map(s => s.id).filter(Boolean));
                    for (const lc of learned) {
                        if (!explicitIds.has(lc.channelId)) {
                            allSubs.push({ id: lc.channelId, name: lc.name, weight: Math.min(3, Math.round(lc.score)), _learned: true });
                        }
                    }
                }
            }
            if (!allSubs.length) return [];
            const totalWeight = allSubs.reduce((sum, s) => sum + (s.weight || 3), 0);
            const batches = await Promise.allSettled(
                allSubs.map(sub => {
                    const w = sub.weight || 3;
                    const perChannel = Math.max(3, Math.ceil(count * w / totalWeight));
                    return this.api.getChannelVideos(sub.name, {
                        publishedAfter: dateWindow.after,
                        publishedBefore: dateWindow.before,
                        maxResults: perChannel,
                        order: 'date',
                        channelId: sub.id,
                    });
                })
            );
            return this._interleave(batches.filter(r => r.status === 'fulfilled').map(r => r.value));
        }

        async _fetchSearchTermsUncached(dateWindow, count) {
            const raw = Store.getSearchTerms();
            const terms = raw.map(t => typeof t === 'string' ? { term: t, weight: 3 } : t);
            let allTerms = [...terms];
            if (Store.isLearningEnabled()) {
                const interests = Store.getCachedInterests();
                if (interests) {
                    const learned = InterestModel.getLearnedKeywords(interests);
                    const existingTerms = new Set(terms.map(t => t.term.toLowerCase()));
                    for (const lk of learned) {
                        if (!existingTerms.has(lk.keyword)) {
                            allTerms.push({ term: lk.keyword, weight: 2, _learned: true });
                        }
                    }
                }
            }
            if (!allTerms.length) return [];
            const totalWeight = allTerms.reduce((sum, t) => sum + (t.weight || 3), 0);
            const batches = await Promise.allSettled(
                allTerms.map(t => {
                    const w = t.weight || 3;
                    const perTerm = Math.max(3, Math.ceil(count * w / totalWeight));
                    return this.api.searchVideos(t.term, {
                        publishedAfter: dateWindow.after,
                        publishedBefore: dateWindow.before,
                        maxResults: perTerm,
                        order: 'relevance',
                    });
                })
            );
            return this._interleave(batches.filter(r => r.status === 'fulfilled').map(r => r.value));
        }

        async _fetchCategoriesUncached(dateWindow, count) {
            const cats = Store.getCategories();
            if (!cats.length) return [];
            const perCat = Math.max(5, Math.ceil(count / cats.length));
            const batches = await Promise.allSettled(
                cats.map(catId =>
                    this.api.getPopularByCategory(catId, {
                        publishedAfter: dateWindow.after,
                        publishedBefore: dateWindow.before,
                        maxResults: perCat,
                    })
                )
            );
            return this._interleave(batches.filter(r => r.status === 'fulfilled').map(r => r.value));
        }

        async _fetchTopicsUncached(dateWindow, count) {
            const raw = Store.getTopics();
            const topics = raw.map(t => typeof t === 'string' ? { name: t, weight: 3 } : t);
            if (!topics.length) return [];
            const totalWeight = topics.reduce((sum, t) => sum + (t.weight || 3), 0);
            const batches = await Promise.allSettled(
                topics.map(topic => {
                    const w = topic.weight || 3;
                    const perTopic = Math.max(3, Math.ceil(count * w / totalWeight));
                    return this.api.searchVideos(topic.name || topic, {
                        publishedAfter: dateWindow.after,
                        publishedBefore: dateWindow.before,
                        maxResults: perTopic,
                        order: 'relevance',
                    });
                })
            );
            return this._interleave(batches.filter(r => r.status === 'fulfilled').map(r => r.value));
        }

        async _fetchTrendingUncached(dateWindow, count) {
            if (!Store.isDiscoveryEnabled()) return [];
            return this._fetchTrendingInner(dateWindow, count);
        }

        async buildRecommendations(currentVideoId, selectedDate) {
            const dateWindow = this._dateWindow(selectedDate);
            const targetCount = 30; // Show ~30 sidebar videos

            const cacheKey = `rec_${currentVideoId}_${dateWindow.center.toDateString()}`;
            const cached = Store.getCacheEntry(cacheKey);
            if (cached) return cached;

            try {
                // Get current video details for context
                const details = await this.api.getVideoDetails([currentVideoId]);

                let relatedVideos = [];
                if (details.length) {
                    const current = details[0];
                    const channelName = current.channel || '';
                    const title = current.title || '';
                    const keywords = this._extractKeywords(title);

                    // Fetch related: same channel + keyword-based
                    const [sameChannel, keywordVideos] = await Promise.allSettled([
                        channelName ? this.api.getChannelVideos(channelName, {
                            publishedAfter: dateWindow.after,
                            publishedBefore: dateWindow.before,
                            maxResults: 10,
                            order: 'date',
                            channelId: current.channelId,
                        }) : Promise.resolve([]),
                        keywords.length ? this._searchKeywords(keywords, dateWindow, 10, current.channelId) : Promise.resolve([]),
                    ]);

                    const same = sameChannel.status === 'fulfilled' ? sameChannel.value : [];
                    const kw = keywordVideos.status === 'fulfilled' ? keywordVideos.value : [];
                    relatedVideos = [...same.slice(0, 6), ...kw];
                }

                // Fetch random "discovery" videos from user's feed sources
                // (subscriptions, categories, topics) to simulate an algorithm
                const randomVideos = await this._fetchRandomSidebar(dateWindow, targetCount);

                // Interleave: related videos scattered among random ones
                // Place a related video roughly every 3-4 slots
                // Also filter out impression-hidden videos
                const related = this._dedupe(relatedVideos).filter(v => v.id !== currentVideoId && !Store.isImpressionHidden(v.id));
                const random = this._dedupe(randomVideos).filter(v => v.id !== currentVideoId && !Store.isImpressionHidden(v.id));

                const merged = [];
                let ri = 0, di = 0;
                const usedIds = new Set([currentVideoId]);

                while (merged.length < targetCount && (ri < related.length || di < random.length)) {
                    // Every 3rd-4th slot, insert a related video if available
                    if (ri < related.length && (merged.length % 3 === 0 || di >= random.length)) {
                        if (!usedIds.has(related[ri].id)) {
                            usedIds.add(related[ri].id);
                            merged.push(related[ri]);
                        }
                        ri++;
                    } else if (di < random.length) {
                        if (!usedIds.has(random[di].id)) {
                            usedIds.add(random[di].id);
                            merged.push(random[di]);
                        }
                        di++;
                    } else {
                        break;
                    }
                }

                if (merged.length) Store.setCacheEntry(cacheKey, merged);
                return merged;
            } catch (e) {
                console.warn('[iw2gb] Recommendations error:', e.message);
                return [];
            }
        }

        // Fetch random videos from user's sources for sidebar discovery
        async _fetchRandomSidebar(dateWindow, count) {
            const subs = Store.getSubscriptions();
            const topics = Store.getTopics();
            const cats = Store.getCategories();

            const fetches = [];

            // Pick a few random subscriptions
            if (subs.length) {
                const shuffled = [...subs].sort(() => Math.random() - 0.5).slice(0, 3);
                for (const sub of shuffled) {
                    fetches.push(this.api.getChannelVideos(sub.name, {
                        publishedAfter: dateWindow.after,
                        publishedBefore: dateWindow.before,
                        maxResults: 5,
                        channelId: sub.id,
                    }));
                }
            }

            // Pick a random category
            if (cats.length) {
                const cat = cats[Math.floor(Math.random() * cats.length)];
                fetches.push(this.api.getPopularByCategory(cat, {
                    publishedAfter: dateWindow.after,
                    publishedBefore: dateWindow.before,
                    maxResults: 8,
                }));
            }

            // Pick a random topic
            if (topics.length) {
                const raw = topics[Math.floor(Math.random() * topics.length)];
                const name = typeof raw === 'string' ? raw : raw.name;
                fetches.push(this.api.searchVideos(name, {
                    publishedAfter: dateWindow.after,
                    publishedBefore: dateWindow.before,
                    maxResults: 5,
                    order: 'relevance',
                }));
            }

            if (!fetches.length) return [];

            const results = await Promise.allSettled(fetches);
            const all = results
                .filter(r => r.status === 'fulfilled')
                .flatMap(r => r.value);

            // Shuffle and return
            return all.sort(() => Math.random() - 0.5).slice(0, count);
        }

        async _searchKeywords(keywords, dateWindow, count, excludeChannelId) {
            const batches = await Promise.allSettled(
                keywords.slice(0, 3).map(kw =>
                    this.api.searchVideos(kw, {
                        publishedAfter: dateWindow.after,
                        publishedBefore: dateWindow.before,
                        maxResults: Math.ceil(count / Math.min(keywords.length, 3)),
                        order: 'relevance',
                    })
                )
            );

            return batches
                .filter(r => r.status === 'fulfilled')
                .flatMap(r => r.value)
                .filter(v => v && v.channelId !== excludeChannelId)
                .slice(0, count);
        }

        _extractKeywords(title) {
            const stopWords = new Set(['the', 'a', 'an', 'in', 'on', 'at', 'to', 'for', 'of', 'and', 'or', 'is', 'it', 'my', 'we', 'i', 'you', 'this', 'that', 'with', 'from', 'by', 'be', 'as', 'are', 'was', 'were', 'been', 'has', 'have', 'had', 'do', 'does', 'did', 'but', 'not', 'so', 'if', 'no', 'yes']);
            return title
                .replace(/[^\w\s]/g, '')
                .split(/\s+/)
                .filter(w => w.length > 2 && !stopWords.has(w.toLowerCase()))
                .slice(0, 5);
        }
    }

    // =========================================================================
    // 5. VIDEO RENDERER  –  pure DOM creation (no innerHTML - Trusted Types safe)
    // =========================================================================

    // Helper: create element with optional class, text, and children
    function _el(tag, className, textOrChildren) {
        const el = document.createElement(tag);
        if (className) el.className = className;
        if (typeof textOrChildren === 'string') {
            el.textContent = textOrChildren;
        } else if (Array.isArray(textOrChildren)) {
            for (const child of textOrChildren) {
                if (child) el.appendChild(child);
            }
        }
        return el;
    }

    function _clear(el) {
        while (el.firstChild) el.removeChild(el.firstChild);
    }

    class VideoRenderer {
        static homepageCard(video) {
            const card = _el('div', 'wbt-card');
            card.dataset.videoId = video.id;

            const link = _el('a', 'wbt-card-link');
            link.href = `/watch?v=${video.id}`;

            const thumbWrap = _el('div', 'wbt-thumb-wrap');
            const img = document.createElement('img');
            img.className = 'wbt-thumb';
            img.src = video.thumbnail;
            img.alt = '';
            img.loading = 'lazy';
            thumbWrap.appendChild(img);

            const dateSpan = _el('span', 'wbt-card-date', DateHelper.recalcForFeed(video.relativeDate, Store.getCurrentDate(), video.id));
            const info = _el('div', 'wbt-card-info', [
                _el('div', 'wbt-card-title', video.title),
                _el('div', 'wbt-card-channel', video.channel),
                _el('div', 'wbt-card-meta', [
                    _el('span', null, video.viewCountFormatted),
                    _el('span', 'wbt-dot', '\u00B7'),
                    dateSpan,
                ]),
            ]);

            link.appendChild(thumbWrap);
            link.appendChild(info);
            card.appendChild(link);
            return card;
        }

        static sidebarCard(video) {
            const card = _el('div', 'wbt-sidebar-card');

            const link = _el('a', 'wbt-sidebar-link');
            link.href = `/watch?v=${video.id}`;

            const thumbWrap = _el('div', 'wbt-sidebar-thumb-wrap');
            const img = document.createElement('img');
            img.className = 'wbt-sidebar-thumb';
            img.src = video.thumbnail;
            img.alt = '';
            img.loading = 'lazy';
            thumbWrap.appendChild(img);

            const info = _el('div', 'wbt-sidebar-info', [
                _el('div', 'wbt-sidebar-title', video.title),
                _el('div', 'wbt-sidebar-channel', video.channel),
                _el('div', 'wbt-sidebar-meta', `${video.viewCountFormatted} \u00B7 ${DateHelper.recalcForFeed(video.relativeDate, Store.getCurrentDate(), video.id)}`),
            ]);

            link.appendChild(thumbWrap);
            link.appendChild(info);
            card.appendChild(link);
            return card;
        }

        static loadingIndicator() {
            return _el('div', 'wbt-loading', 'Loading...');
        }

        static noVideosMessage() {
            return _el('div', 'wbt-empty', [
                _el('h3', null, 'No videos found'),
                _el('p', null, 'Try selecting a different date or adjusting your preferences.'),
            ]);
        }

        static errorMessage(msg) {
            return _el('div', 'wbt-empty', [
                _el('h3', null, 'Something went wrong'),
                _el('p', null, msg),
            ]);
        }

        static loadMoreButton(onClick) {
            const btn = _el('button', 'wbt-load-more', 'Load More');
            btn.addEventListener('click', onClick);
            return btn;
        }

        static refreshButton(onClick) {
            const btn = _el('button', 'wbt-refresh-btn', 'New Videos');
            btn.addEventListener('click', onClick);
            return btn;
        }

        static endscreenCard(video) {
            const card = _el('div', 'wbt-endscreen-card');

            const link = _el('a', 'wbt-endscreen-link');
            link.href = `/watch?v=${video.id}`;

            const thumbWrap = _el('div', 'wbt-endscreen-thumb-wrap');
            const img = document.createElement('img');
            img.className = 'wbt-endscreen-thumb';
            img.src = video.thumbnail;
            img.alt = '';
            img.loading = 'lazy';
            thumbWrap.appendChild(img);

            const info = _el('div', 'wbt-endscreen-info', [
                _el('div', 'wbt-endscreen-title', video.title),
                _el('div', 'wbt-endscreen-channel', video.channel),
            ]);

            link.appendChild(thumbWrap);
            link.appendChild(info);
            card.appendChild(link);
            return card;
        }
    }

    // =========================================================================
    // 6. DOM CONTROLLER  –  page manipulation
    // =========================================================================

    class DOMController {
        constructor(feedEngine) {
            this.feedEngine = feedEngine;
            this.allVideos = [];
            this.displayedIndex = 0;
            this._homepageReplaced = false;
            this._homepageLoading = false;
            this._sidebarReplaced = false;
            this._sidebarLoading = false;
            this._channelReplaced = false;
            this._channelLoading = false;
            this._endscreenReplaced = false;
            this._endscreenLoading = false;
            this._lastUrl = '';
            this._nukeInterval = null;
            this._observer = null;
            this._pendingSearchClean = null;
            this._videoMetaMap = new Map();
            this._pendingWatch = null;
        }

        init() {
            this._startNavDetection();
            this._startNuking();
            this._onNavChange();
        }

        destroy() {
            if (this._nukeInterval) clearInterval(this._nukeInterval);
            if (this._observer) this._observer.disconnect();
        }

        // --- Navigation detection ---

        _startNavDetection() {
            // SPA navigation via yt-navigate-finish event
            document.addEventListener('yt-navigate-finish', () => this._onNavChange());

            // Fallback: poll URL changes
            setInterval(() => {
                if (location.href !== this._lastUrl) {
                    this._lastUrl = location.href;
                    this._onNavChange();
                }
            }, 500);
        }

        _onNavChange() {
            this._lastUrl = location.href;
            this._homepageReplaced = false;
            this._homepageLoading = false;
            this._sidebarReplaced = false;
            this._sidebarLoading = false;
            this._channelReplaced = false;
            this._channelLoading = false;
            this._endscreenReplaced = false;
            this._endscreenLoading = false;
            this._pendingSearchClean = null;
            this._pendingWatch = null;

            if (!Store.isActive()) return;

            // Redirect /shorts to homepage
            if (location.pathname.startsWith('/shorts')) {
                window.location.replace('/');
                return;
            }

            // Intercept search to inject date filter
            if (this._isSearchPage()) {
                this._interceptSearch();
            }

            if (this._isHomePage()) {
                this._tryReplaceHomepage();
            } else if (this._isVideoPage()) {
                this._tryReplaceSidebar();
                // Start watch tracking
                if (Store.isLearningEnabled()) {
                    const videoId = new URLSearchParams(location.search).get('v');
                    if (videoId && this._videoMetaMap.has(videoId)) {
                        this._pendingWatch = { videoId, meta: this._videoMetaMap.get(videoId), startedAt: Date.now() };
                    } else if (videoId) {
                        // Video not in meta map (e.g. from search, channel page, direct link).
                        // Fetch its details so we can still track the watch.
                        this._pendingWatch = null;
                        this.feedEngine.api.getVideoDetails([videoId]).then(details => {
                            if (details.length && this._isVideoPage()) {
                                const d = details[0];
                                const meta = { channel: d.channel || '', channelId: d.channelId || '', title: d.title || '' };
                                this._videoMetaMap.set(videoId, meta);
                                // Only set pending if we're still on this video page
                                const currentId = new URLSearchParams(location.search).get('v');
                                if (currentId === videoId) {
                                    this._pendingWatch = { videoId, meta, startedAt: Date.now() };
                                    console.log('[iw2gb] Late-resolved watch tracking for:', meta.channel, '-', meta.title);
                                }
                            }
                        }).catch(() => {});
                    } else {
                        this._pendingWatch = null;
                    }
                }
            } else if (this._isChannelPage()) {
                this._tryReplaceChannelPage();
            }
        }

        _isHomePage() {
            return location.pathname === '/' || location.pathname === '';
        }

        _isVideoPage() {
            return location.pathname === '/watch';
        }

        _isSearchPage() {
            return location.pathname === '/results';
        }

        _isChannelPage() {
            const p = location.pathname;
            return p.startsWith('/@') || p.startsWith('/channel/') || p.startsWith('/c/') || p.startsWith('/user/');
        }

        // --- Continuous nuking of Shorts, chips, etc. ---

        _startNuking() {
            this._nukeInterval = setInterval(() => {
                if (!Store.isActive()) return;
                this._hideShorts();
                this._hideChips();
                this._rewriteNativeDates();
                this._checkHourlyRefresh();

                // Continuously clean search input (YouTube re-renders it)
                if (this._isSearchPage() && this._pendingSearchClean !== null) {
                    const searchInput = document.querySelector('input#search');
                    if (searchInput && searchInput.value !== this._pendingSearchClean) {
                        searchInput.value = this._pendingSearchClean;
                    }
                }

                // Retro logo fallback
                this._ensureRetroLogo();

                // Continuously hide original homepage content
                if (this._isHomePage()) {
                    this._hideOriginalFeed();
                    if (this._homepageReplaced && !document.querySelector('.wbt-container')) {
                        this._homepageReplaced = false;
                        this._homepageLoading = false;
                    }
                    if (!this._homepageReplaced && !this._homepageLoading) this._tryReplaceHomepage();
                }
                if (this._isVideoPage()) {
                    if (this._sidebarReplaced && !document.querySelector('.wbt-sidebar-container')) {
                        this._sidebarReplaced = false;
                        this._sidebarLoading = false;
                    }
                    if (!this._sidebarReplaced && !this._sidebarLoading) this._tryReplaceSidebar();
                    this._filterComments();
                    this._hidePlayerOverlays();

                    // Commit watch after sufficient time on video page
                    // Threshold scales with video duration: 50% of length, clamped 5s–30s
                    if (this._pendingWatch) {
                        const videoEl = document.querySelector('video.html5-main-video');
                        const dur = videoEl && videoEl.duration && isFinite(videoEl.duration) ? videoEl.duration : 0;
                        const threshold = dur > 0 ? Math.max(5000, Math.min(30000, dur * 500)) : 30000;
                        this._pendingWatch._threshold = threshold;
                    }
                    if (this._pendingWatch && Date.now() - this._pendingWatch.startedAt >= (this._pendingWatch._threshold || 30000)) {
                        const pw = this._pendingWatch;
                        Store.addWatchEvent({
                            videoId: pw.videoId,
                            channel: pw.meta.channel,
                            channelId: pw.meta.channelId,
                            title: pw.meta.title,
                            ts: Date.now(),
                        });
                        console.log('[iw2gb] Learned watch:', pw.meta.channel, '-', pw.meta.title);
                        this._pendingWatch = null;
                    }

                    // Endscreen: show WBT grid when video ends
                    const video = document.querySelector('video.html5-main-video');
                    if (video && video.ended) {
                        if (!this._endscreenReplaced && !this._endscreenLoading) {
                            this._tryReplaceEndscreen();
                        }
                    } else {
                        // Video still playing or navigated — remove any endscreen overlay
                        if (this._endscreenReplaced) {
                            const es = document.querySelector('.wbt-endscreen-container');
                            if (es) es.remove();
                            this._endscreenReplaced = false;
                        }
                    }
                }
                if (this._isChannelPage()) {
                    if (this._channelReplaced && !document.querySelector('.wbt-channel-container')) {
                        this._channelReplaced = false;
                        this._channelLoading = false;
                    }
                    if (!this._channelReplaced && !this._channelLoading) this._tryReplaceChannelPage();
                }
            }, CONFIG.ui.updateInterval);
        }

        _hideShorts() {
            for (const sel of CONFIG.selectors.shorts) {
                for (const el of document.querySelectorAll(sel)) {
                    if (!el.dataset.wbtHidden) {
                        el.style.display = 'none';
                        el.dataset.wbtHidden = '1';
                    }
                }
            }
            // Hide any video renderer linking to /shorts/
            for (const a of document.querySelectorAll('a[href*="/shorts/"]')) {
                const renderer = a.closest('ytd-video-renderer, ytd-rich-item-renderer, ytd-grid-video-renderer, ytd-compact-video-renderer');
                if (renderer && !renderer.dataset.wbtHidden) {
                    renderer.style.display = 'none';
                    renderer.dataset.wbtHidden = '1';
                }
            }
            // Hide Shorts entries in sidebar navigation
            for (const el of document.querySelectorAll('ytd-guide-entry-renderer, ytd-mini-guide-entry-renderer')) {
                if (el.dataset.wbtHidden) continue;
                const link = el.querySelector('a[href="/shorts"], a[href*="shorts"], a[title="Shorts"]');
                const text = el.textContent || '';
                if (link || text.trim() === 'Shorts') {
                    el.style.display = 'none';
                    el.dataset.wbtHidden = '1';
                }
            }
        }

        _hidePlayerOverlays() {
            const selectors = [
                '.ytp-suggestion-set',
                '.ytp-videowall-still',
                '.ytp-autonav-endscreen',
                '.ytp-upnext',
                '.ytp-pause-overlay',
                '.ytp-ce-element',
            ];
            for (const sel of selectors) {
                for (const el of document.querySelectorAll(sel)) {
                    if (!el.dataset.wbtHidden) {
                        el.style.display = 'none';
                        el.dataset.wbtHidden = '1';
                    }
                }
            }
        }

        _hideChips() {
            for (const sel of CONFIG.selectors.chips) {
                for (const el of document.querySelectorAll(sel)) {
                    if (!el.dataset.wbtHidden) {
                        el.style.display = 'none';
                        el.dataset.wbtHidden = '1';
                    }
                }
            }
        }

        _hideOriginalFeed() {
            const selectors = [
                'ytd-rich-grid-renderer > #contents > ytd-rich-item-renderer',
                'ytd-rich-grid-renderer > #contents > ytd-rich-section-renderer',
                'ytd-browse[page-subtype="home"] ytd-rich-grid-renderer > #contents > *:not(.wbt-container)',
            ];
            for (const sel of selectors) {
                for (const el of document.querySelectorAll(sel)) {
                    if (!el.classList.contains('wbt-container') && !el.dataset.wbtHidden) {
                        el.style.display = 'none';
                        el.dataset.wbtHidden = '1';
                    }
                }
            }
        }

        // --- Homepage replacement ---

        async _tryReplaceHomepage() {
            if (this._homepageReplaced || this._homepageLoading) return;

            const grid = document.querySelector('ytd-browse[page-subtype="home"] ytd-rich-grid-renderer #contents');
            if (!grid) return;

            // Check if we already injected
            if (grid.querySelector('.wbt-container')) {
                this._homepageReplaced = true;
                return;
            }

            this._homepageLoading = true;
            this._hideOriginalFeed();

            // Insert our container at the top
            const container = document.createElement('div');
            container.className = 'wbt-container';
            container.appendChild(VideoRenderer.loadingIndicator());
            grid.insertBefore(container, grid.firstChild);

            const dateStr = Store.getCurrentDate();
            if (!dateStr) {
                _clear(container);
                container.appendChild(VideoRenderer.noVideosMessage());
                this._homepageReplaced = true;
                this._homepageLoading = false;
                return;
            }

            try {
                this.allVideos = await this.feedEngine.buildHomeFeed(dateStr);

                // Verify container is still in DOM after async work
                if (!document.body.contains(container)) {
                    this._homepageLoading = false;
                    return; // Will retry on next interval tick
                }

                _clear(container);

                if (!this.allVideos.length) {
                    container.appendChild(VideoRenderer.noVideosMessage());
                    this._homepageReplaced = true;
                    this._homepageLoading = false;
                    return;
                }

                // Toolbar
                const toolbar = document.createElement('div');
                toolbar.className = 'wbt-toolbar';
                toolbar.appendChild(VideoRenderer.refreshButton(() => this._refreshHomepage()));
                container.appendChild(toolbar);

                // Video grid
                const videoGrid = document.createElement('div');
                videoGrid.className = 'wbt-grid';
                container.appendChild(videoGrid);

                // Render ALL pre-fetched videos immediately (60 cards is nothing)
                for (const video of this.allVideos) {
                    videoGrid.appendChild(VideoRenderer.homepageCard(video));
                }

                // Register video metadata for watch tracking
                for (const v of this.allVideos) {
                    this._videoMetaMap.set(v.id, { channel: v.channel, channelId: v.channelId, title: v.title });
                }

                // "Loading more..." indicator for infinite scroll
                const loadingMore = document.createElement('div');
                loadingMore.className = 'wbt-loading-more';
                loadingMore.textContent = 'Loading more videos...';
                loadingMore.style.cssText = 'text-align:center;padding:20px;color:#aaa;font-size:14px;display:none;';
                container.appendChild(loadingMore);

                // Infinite scroll: fetch MORE videos from API when user nears bottom
                const self = this;
                this._infiniteScrollActive = true;
                this._infiniteScrollFetching = false;
                this._infiniteScrollPage = 1;

                const fetchAndAppend = async () => {
                    if (!self._infiniteScrollActive || self._infiniteScrollFetching) return;
                    if (!document.body.contains(videoGrid)) { self._infiniteScrollActive = false; return; }

                    self._infiniteScrollFetching = true;
                    loadingMore.style.display = 'block';

                    try {
                        const dateStr = Store.getCurrentDate();
                        if (!dateStr) { self._infiniteScrollFetching = false; return; }

                        self._infiniteScrollPage++;
                        const existingIds = new Set(self.allVideos.map(v => v.id));

                        // Fetch from a shifted date window so we get genuinely new videos
                        const fresh = await self.feedEngine.buildHomeFeedMore(dateStr, self._infiniteScrollPage, existingIds);
                        if (!document.body.contains(videoGrid)) return;

                        if (fresh.length === 0) {
                            // Try one more page before giving up
                            self._infiniteScrollPage++;
                            const retry = await self.feedEngine.buildHomeFeedMore(dateStr, self._infiniteScrollPage, existingIds);
                            if (retry.length === 0) {
                                loadingMore.textContent = 'No more videos to load';
                                loadingMore.style.display = 'block';
                                self._infiniteScrollActive = false;
                                return;
                            }
                            for (const video of retry) {
                                videoGrid.appendChild(VideoRenderer.homepageCard(video));
                                self.allVideos.push(video);
                                self._videoMetaMap.set(video.id, { channel: video.channel, channelId: video.channelId, title: video.title });
                            }
                            self._enrichCardDates(retry);
                            Store.addSeenIds(retry.map(v => v.id));
                            Store.recordImpressions(retry.map(v => v.id));
                        } else {
                            for (const video of fresh) {
                                videoGrid.appendChild(VideoRenderer.homepageCard(video));
                                self.allVideos.push(video);
                                self._videoMetaMap.set(video.id, { channel: video.channel, channelId: video.channelId, title: video.title });
                            }
                            self._enrichCardDates(fresh);
                            Store.addSeenIds(fresh.map(v => v.id));
                            Store.recordImpressions(fresh.map(v => v.id));
                        }
                    } catch (e) {
                        console.warn('[iw2gb] Infinite scroll fetch error:', e.message);
                    } finally {
                        self._infiniteScrollFetching = false;
                        loadingMore.style.display = 'none';
                    }
                };

                // Use IntersectionObserver to detect when the sentinel nears the viewport.
                // This is far more reliable than scroll math on YouTube's SPA.
                const sentinel = document.createElement('div');
                sentinel.className = 'wbt-scroll-sentinel';
                sentinel.style.cssText = 'height:1px;width:100%;';
                container.appendChild(sentinel);

                const observer = new IntersectionObserver((entries) => {
                    if (entries[0].isIntersecting && self._infiniteScrollActive && !self._infiniteScrollFetching) {
                        fetchAndAppend();
                    }
                }, { rootMargin: '1500px' });
                observer.observe(sentinel);

                // Cleanup observer when grid is removed
                const cleanupPoll = setInterval(() => {
                    if (!document.body.contains(videoGrid)) {
                        observer.disconnect();
                        clearInterval(cleanupPoll);
                    }
                }, 2000);

                this._homepageReplaced = true;
                this._homepageLoading = false;
                Store.setLastRefresh(Date.now());

                // Track displayed video IDs so next refresh shows different ones
                Store.addSeenIds(this.allVideos.map(v => v.id));

                // Record impressions for overexposure tracking
                Store.recordImpressions(this.allVideos.map(v => v.id));

                // Progressively fetch real publish dates in the background
                this._enrichCardDates(this.allVideos);
            } catch (e) {
                console.error('[iw2gb] Homepage load error:', e);
                // Verify container still exists before updating it
                if (document.body.contains(container)) {
                    _clear(container);
                    container.appendChild(VideoRenderer.errorMessage(e.message));
                }
                this._homepageLoading = false;
                // Don't set _homepageReplaced — allow retry
            }
        }

        async _refreshHomepage() {
            this._infiniteScrollActive = false; // stop any running infinite scroll
            this._homepageReplaced = false;
            this._homepageLoading = false;
            const container = document.querySelector('.wbt-container');
            if (container) container.remove();

            // Clear all caches for this date so we get truly fresh results
            const dateStr = Store.getCurrentDate();
            if (dateStr) {
                const d = new Date(dateStr);
                const dk = d.toDateString();
                Store._del(`wbt_cache_feed_${dk}`);
                Store._del(`wbt_cache_subs_${dk}`);
                Store._del(`wbt_cache_search_${dk}`);
                Store._del(`wbt_cache_topics_${dk}`);
                const cats = Store.getCategories();
                Store._del(`wbt_cache_cats_${cats.join('_')}_${dk}`);
            }

            // Reset seen IDs so the full pool is available
            Store.clearSeenIds();

            this._tryReplaceHomepage();
        }

        // --- Video page sidebar replacement ---

        async _tryReplaceSidebar() {
            if (this._sidebarReplaced || this._sidebarLoading) return;

            const sidebar = document.querySelector('#secondary #related, #secondary-inner #related');
            if (!sidebar) return;

            // Check if already replaced
            if (sidebar.querySelector('.wbt-sidebar-container')) {
                this._sidebarReplaced = true;
                return;
            }

            this._sidebarLoading = true;

            // Hide original recommendations
            const original = sidebar.querySelector('#items, ytd-watch-next-secondary-results-renderer');
            if (original) original.style.display = 'none';

            const container = document.createElement('div');
            container.className = 'wbt-sidebar-container';
            container.appendChild(VideoRenderer.loadingIndicator());
            sidebar.insertBefore(container, sidebar.firstChild);

            const dateStr = Store.getCurrentDate();
            const videoId = new URLSearchParams(location.search).get('v');
            if (!dateStr || !videoId) {
                _clear(container);
                this._sidebarReplaced = true;
                this._sidebarLoading = false;
                return;
            }

            try {
                const recommendations = await this.feedEngine.buildRecommendations(videoId, dateStr);

                if (!document.body.contains(container)) {
                    this._sidebarLoading = false;
                    return;
                }

                _clear(container);

                if (!recommendations.length) {
                    this._sidebarReplaced = true;
                    this._sidebarLoading = false;
                    return;
                }

                const header = document.createElement('div');
                header.className = 'wbt-sidebar-header';
                header.textContent = 'Recommended';
                container.appendChild(header);

                // Show all recommendations — ~30 sidebar cards is fine for perf
                for (const video of recommendations) {
                    container.appendChild(VideoRenderer.sidebarCard(video));
                    this._videoMetaMap.set(video.id, { channel: video.channel, channelId: video.channelId, title: video.title });
                }

                // Record impressions for overexposure tracking
                Store.recordImpressions(recommendations.map(v => v.id));

                this._sidebarReplaced = true;
                this._sidebarLoading = false;
            } catch (e) {
                console.warn('[iw2gb] Sidebar error:', e.message);
                if (document.body.contains(container)) {
                    _clear(container);
                }
                this._sidebarLoading = false;
            }
        }

        // --- Video endscreen replacement ---

        async _tryReplaceEndscreen() {
            if (this._endscreenReplaced || this._endscreenLoading) return;

            // Find the player container to overlay on
            const player = document.querySelector('#movie_player, .html5-video-player');
            if (!player) return;

            // Already injected
            if (player.querySelector('.wbt-endscreen-container')) {
                this._endscreenReplaced = true;
                return;
            }

            this._endscreenLoading = true;

            // Hide YouTube's native endscreen elements
            for (const sel of ['.ytp-endscreen-content', '.html5-endscreen', '.ytp-ce-element', '.ytp-suggestion-set', '.ytp-videowall-still', '.ytp-autonav-endscreen', '.ytp-upnext', '.ytp-pause-overlay']) {
                for (const el of player.querySelectorAll(sel)) {
                    el.style.display = 'none';
                }
            }

            const dateStr = Store.getCurrentDate();
            const videoId = new URLSearchParams(location.search).get('v');
            if (!dateStr || !videoId) {
                this._endscreenLoading = false;
                return;
            }

            // Create overlay container
            const overlay = document.createElement('div');
            overlay.className = 'wbt-endscreen-container';

            const grid = document.createElement('div');
            grid.className = 'wbt-endscreen-grid';

            overlay.appendChild(VideoRenderer.loadingIndicator());

            // Ensure player has position for absolute overlay
            const playerPos = getComputedStyle(player).position;
            if (playerPos === 'static') player.style.position = 'relative';

            player.appendChild(overlay);

            try {
                const recommendations = await this.feedEngine.buildRecommendations(videoId, dateStr);

                if (!document.body.contains(overlay)) {
                    this._endscreenLoading = false;
                    return;
                }

                _clear(overlay);

                if (!recommendations.length) {
                    overlay.remove();
                    this._endscreenLoading = false;
                    return;
                }

                const endscreenVideos = recommendations.slice(0, 12);
                for (const video of endscreenVideos) {
                    grid.appendChild(VideoRenderer.endscreenCard(video));
                    this._videoMetaMap.set(video.id, { channel: video.channel, channelId: video.channelId, title: video.title });
                }

                // Record impressions for overexposure tracking
                Store.recordImpressions(endscreenVideos.map(v => v.id));

                overlay.appendChild(grid);
                this._endscreenReplaced = true;
                this._endscreenLoading = false;
            } catch (e) {
                console.warn('[iw2gb] Endscreen error:', e.message);
                if (document.body.contains(overlay)) overlay.remove();
                this._endscreenLoading = false;
            }
        }

        // --- Force reload ---

        forceReload() {
            this._homepageReplaced = false;
            this._homepageLoading = false;
            this._sidebarReplaced = false;
            this._sidebarLoading = false;
            this._channelReplaced = false;
            this._channelLoading = false;
            this._endscreenReplaced = false;
            this._endscreenLoading = false;
            for (const sel of ['.wbt-container', '.wbt-sidebar-container', '.wbt-channel-container', '.wbt-endscreen-container']) {
                const el = document.querySelector(sel);
                if (el) el.remove();
            }
            // Clear rewritten date markers so they get recalculated
            for (const el of document.querySelectorAll('[data-wbt-date-rewritten]')) {
                el.removeAttribute('data-wbt-date-rewritten');
            }
            for (const el of document.querySelectorAll('[data-wbt-comment-checked]')) {
                el.removeAttribute('data-wbt-comment-checked');
            }
            this._onNavChange();
        }

        // --- Search interception ---

        _interceptSearch() {
            const dateStr = Store.getCurrentDate();
            if (!dateStr) return;

            const params = new URLSearchParams(location.search);
            const query = params.get('search_query') || '';

            if (query.includes('before:')) {
                // Already filtered — just clean the search input visually
                this._pendingSearchClean = query.replace(/\s*before:\d{4}-\d{2}-\d{2}/g, '').trim();
                return;
            }

            params.set('search_query', `${query} before:${dateStr}`.trim());
            window.location.replace(`/results?${params.toString()}`);
        }

        _ensureRetroLogo() {
            const logoLink = document.querySelector('ytd-topbar-logo-renderer a#logo');
            if (!logoLink) return;

            const customUrl = Store.getCustomLogo();
            const existing = logoLink.querySelector('.wbt-retro-logo');

            // If custom logo changed, remove old one to rebuild
            if (existing && customUrl && !existing.querySelector('img')) existing.remove();
            if (existing && !customUrl && existing.querySelector('img')) existing.remove();
            if (logoLink.querySelector('.wbt-retro-logo')) return;

            // Toggle CSS pseudo-elements based on custom logo
            if (customUrl) {
                logoLink.classList.add('wbt-has-custom-logo');
            } else {
                logoLink.classList.remove('wbt-has-custom-logo');
                // Check if CSS pseudo-elements are working
                const style = window.getComputedStyle(logoLink, '::before');
                if (style && style.content && style.content !== 'none' && style.content !== '""') return;
            }

            const logo = document.createElement('span');
            logo.className = 'wbt-retro-logo';
            logo.style.cssText = 'display:flex;align-items:center;';

            if (customUrl) {
                const img = document.createElement('img');
                img.src = customUrl;
                img.style.cssText = 'height:20px;width:auto;object-fit:contain;';
                logo.appendChild(img);
            } else {
                logo.style.cssText += 'font-family:Arial,Helvetica,sans-serif;font-size:20px;font-weight:bold;';
                const you = document.createElement('span');
                you.textContent = 'You';
                you.className = 'wbt-logo-you';
                const tube = document.createElement('span');
                tube.textContent = 'Tube';
                tube.style.cssText = 'color:#fff;background:#cc0000;border-radius:4px;padding:2px 6px;margin-left:1px;';
                logo.appendChild(you);
                logo.appendChild(tube);
            }

            logoLink.appendChild(logo);
        }

        // --- Channel page replacement ---

        async _tryReplaceChannelPage() {
            if (this._channelReplaced || this._channelLoading) return;

            // Try multiple selectors — YouTube changes DOM structure across versions
            const grid = document.querySelector(
                'ytd-browse[page-subtype="channels"] ytd-rich-grid-renderer #contents,' +
                'ytd-browse[page-subtype="channels"] ytd-section-list-renderer #contents,' +
                'ytd-browse[page-subtype="channels"] #contents.ytd-rich-grid-renderer,' +
                'ytd-browse[page-subtype="channel"] ytd-rich-grid-renderer #contents,' +
                'ytd-browse[page-subtype="channel"] ytd-section-list-renderer #contents,' +
                'ytd-browse[page-subtype="channel"] #contents.ytd-rich-grid-renderer'
            );
            if (!grid) return;

            if (grid.querySelector('.wbt-channel-container')) {
                this._channelReplaced = true;
                return;
            }

            this._channelLoading = true;

            const channelNameEl = document.querySelector(
                'ytd-channel-name #text,' +
                'yt-dynamic-text-view-model .yt-core-attributed-string,' +
                '#channel-header ytd-channel-name yt-formatted-string,' +
                '#channel-header-container ytd-channel-name yt-formatted-string,' +
                'ytd-c4-tabbed-header-renderer #channel-name'
            );
            const channelName = channelNameEl?.textContent?.trim();
            if (!channelName) {
                this._channelLoading = false;
                return;
            }

            const dateStr = Store.getCurrentDate();
            if (!dateStr) {
                this._channelLoading = false;
                return;
            }

            // Hide original channel content
            for (const child of grid.children) {
                if (!child.classList.contains('wbt-channel-container') && !child.dataset.wbtHidden) {
                    child.style.display = 'none';
                    child.dataset.wbtHidden = '1';
                }
            }

            const container = _el('div', 'wbt-channel-container');
            container.appendChild(VideoRenderer.loadingIndicator());
            grid.insertBefore(container, grid.firstChild);

            try {
                // Get channel ID from page metadata
                const channelIdMeta = document.querySelector('meta[itemprop="channelId"]')?.content
                    || document.querySelector('link[rel="canonical"]')?.href?.match(/channel\/(UC[^/]+)/)?.[1]
                    || '';

                // Search for this channel's videos before the set date, sorted by date (newest first)
                // This is more reliable than the browse endpoint which only returns the first page
                const q = this.feedEngine.api._buildDateQuery(`"${channelName}"`, null, dateStr);
                const body = { query: q, params: 'CAISAhAB' }; // sort by upload date + videos only
                const data = await this.feedEngine.api._post('search', body);
                let videos = this.feedEngine.api._parseSearchResults(data);

                // Filter to only this channel's videos (search may return others mentioning the name)
                if (channelIdMeta) {
                    const strict = videos.filter(v => v.channelId === channelIdMeta);
                    if (strict.length > 0) videos = strict;
                }

                if (!document.body.contains(container)) {
                    this._channelLoading = false;
                    return;
                }

                _clear(container);

                if (!videos.length) {
                    container.appendChild(_el('div', 'wbt-empty', [
                        _el('h3', null, 'No videos found'),
                        _el('p', null, 'No videos from this channel before the selected date.'),
                    ]));
                    this._channelReplaced = true;
                    this._channelLoading = false;
                    return;
                }

                const videoGrid = _el('div', 'wbt-grid');
                for (const video of videos) {
                    videoGrid.appendChild(VideoRenderer.homepageCard(video));
                    this._videoMetaMap.set(video.id, { channel: video.channel, channelId: video.channelId, title: video.title });
                }
                container.appendChild(videoGrid);

                // Store state for infinite scroll
                this._channelAllVideos = [...videos];
                this._channelScrollPage = 1;
                this._channelScrollActive = true;
                this._channelScrollFetching = false;
                this._channelName = channelName;
                this._channelId = channelIdMeta;

                // Infinite scroll sentinel
                const sentinel = document.createElement('div');
                sentinel.className = 'wbt-scroll-sentinel';
                sentinel.style.cssText = 'height:1px;width:100%;';
                container.appendChild(sentinel);

                const loadingMore = _el('div', 'wbt-loading-more', 'Loading more videos...');
                loadingMore.style.cssText = 'text-align:center;padding:20px;color:#aaa;font-size:14px;display:none;';
                container.appendChild(loadingMore);

                const self = this;
                const channelFetchMore = async () => {
                    if (!self._channelScrollActive || self._channelScrollFetching) return;
                    if (!document.body.contains(videoGrid)) { self._channelScrollActive = false; return; }

                    self._channelScrollFetching = true;
                    loadingMore.style.display = 'block';

                    try {
                        self._channelScrollPage++;
                        const existingIds = new Set(self._channelAllVideos.map(v => v.id));

                        // Shift the date window backward for each page
                        const d = new Date(dateStr);
                        const daysShift = CONFIG.feed.dateWindowDays * 2 * (self._channelScrollPage - 1);
                        d.setDate(d.getDate() - daysShift);
                        const shiftedBefore = d.toISOString().split('T')[0];

                        const q2 = self.feedEngine.api._buildDateQuery(`"${self._channelName}"`, null, shiftedBefore);
                        const body2 = { query: q2, params: 'CAISAhAB' };
                        const data2 = await self.feedEngine.api._post('search', body2);
                        let moreVideos = self.feedEngine.api._parseSearchResults(data2);

                        if (self._channelId) {
                            const strict = moreVideos.filter(v => v.channelId === self._channelId);
                            if (strict.length > 0) moreVideos = strict;
                        }

                        const fresh = moreVideos.filter(v => !existingIds.has(v.id));

                        if (fresh.length === 0) {
                            loadingMore.textContent = 'No more videos to load';
                            loadingMore.style.display = 'block';
                            self._channelScrollActive = false;
                            return;
                        }

                        for (const video of fresh) {
                            videoGrid.appendChild(VideoRenderer.homepageCard(video));
                            self._channelAllVideos.push(video);
                            self._videoMetaMap.set(video.id, { channel: video.channel, channelId: video.channelId, title: video.title });
                        }
                    } catch (e) {
                        console.warn('[iw2gb] Channel infinite scroll error:', e.message);
                    } finally {
                        self._channelScrollFetching = false;
                        loadingMore.style.display = 'none';
                    }
                };

                const channelObserver = new IntersectionObserver((entries) => {
                    if (entries[0].isIntersecting && self._channelScrollActive && !self._channelScrollFetching) {
                        channelFetchMore();
                    }
                }, { rootMargin: '1500px' });
                channelObserver.observe(sentinel);

                const channelCleanup = setInterval(() => {
                    if (!document.body.contains(videoGrid)) {
                        channelObserver.disconnect();
                        clearInterval(channelCleanup);
                    }
                }, 2000);

                this._channelReplaced = true;
                this._channelLoading = false;

                // Enrich dates
                this._enrichCardDates(videos);
            } catch (e) {
                console.warn('[iw2gb] Channel page error:', e.message);
                if (document.body.contains(container)) {
                    _clear(container);
                    container.appendChild(VideoRenderer.errorMessage(e.message));
                }
                this._channelLoading = false;
            }
        }

        // --- Comment filtering ---

        _filterComments() {
            const dateStr = Store.getCurrentDate();
            if (!dateStr) return;
            const setDate = new Date(dateStr);

            // 2-year leniency: show comments up to 2 years past the set date
            const cutoff = new Date(setDate);
            cutoff.setFullYear(cutoff.getFullYear() + 2);

            // Match both old (ytd-comment-renderer) and new (ytd-comment-view-model) layouts
            const comments = document.querySelectorAll(
                'ytd-comment-thread-renderer:not([data-wbt-comment-checked]),' +
                'ytd-comment-renderer:not([data-wbt-comment-checked]),' +
                'ytd-comment-view-model:not([data-wbt-comment-checked])'
            );

            for (const comment of comments) {
                comment.setAttribute('data-wbt-comment-checked', '1');

                // Always show your own comments regardless of date filter
                if (comment.querySelector(
                    '#author-comment-badge,' +
                    'ytd-author-comment-badge-renderer,' +
                    '.ytd-author-comment-badge-renderer,' +
                    '[is-creator],' +
                    '[creator-badge]'
                )) {
                    continue;
                }

                // Find the time element by searching for date-like text in the comment header.
                // This is resilient to YouTube DOM changes — we just look for "N unit(s) ago".
                const datePattern = /^\s*(?:Streamed\s+)?(\d+)\s+(year|month|week|day|hour|minute|second)s?\s+ago\s*(?:\(edited\))?\s*$/i;
                let timeEl = null;
                for (const el of comment.querySelectorAll('a, span, yt-formatted-string')) {
                    if (datePattern.test(el.textContent.trim())) {
                        timeEl = el;
                        break;
                    }
                }
                if (!timeEl) continue;

                const rawText = timeEl.textContent.trim();
                if (!rawText) continue;
                const cleanText = rawText.replace(/\s*\(edited\)\s*$/, '');
                const approxDate = DateHelper.approxPublishDate(cleanText);
                if (!approxDate) continue;

                if (approxDate.getTime() > cutoff.getTime()) {
                    // Comment posted more than 2 years after set date — hide
                    // Hide at the thread level if possible so replies are also hidden
                    const thread = comment.closest('ytd-comment-thread-renderer') || comment;
                    thread.style.display = 'none';
                    thread.dataset.wbtHidden = '1';
                } else {
                    // Rewrite date relative to set date
                    const newText = DateHelper.relativeToDate(approxDate, setDate);
                    const editedSuffix = rawText.includes('(edited)') ? ' (edited)' : '';
                    timeEl.textContent = newText + editedSuffix;
                }
            }
        }

        // --- Rewrite native YouTube dates ---

        _rewriteNativeDates() {
            const dateStr = Store.getCurrentDate();
            if (!dateStr) return;

            const dateSelectors = [
                // Watch page — old layout
                '#info-strings yt-formatted-string',
                'ytd-video-primary-info-renderer #info-strings span',
                // Watch page — modern layout (ytd-watch-metadata)
                'ytd-watch-metadata #info span',
                'ytd-watch-metadata #info-text span',
                'ytd-watch-metadata yt-formatted-string#info span',
                '#above-the-fold #info span',
                '#info-container span',
                '#info-container yt-formatted-string',
                // Video lists (search, sidebar, home)
                'ytd-video-renderer #metadata-line span',
                'ytd-video-meta-block #metadata-line span',
                'ytd-grid-video-renderer #metadata-line span',
                'ytd-rich-item-renderer #metadata-line span',
                'ytd-compact-video-renderer #metadata-line span',
                '.ytd-video-meta-block',
            ];

            const datePattern = /^(\d+)\s+(year|month|week|day|hour|minute|second)s?\s+ago$/i;
            const streamedPattern = /^Streamed\s+(\d+)\s+(year|month|week|day|hour|minute|second)s?\s+ago$/i;

            for (const sel of dateSelectors) {
                for (const el of document.querySelectorAll(sel)) {
                    if (el.dataset.wbtDateRewritten === dateStr) continue;

                    const text = el.textContent.trim();
                    if (!datePattern.test(text) && !streamedPattern.test(text)) continue;

                    el.dataset.wbtDateRewritten = dateStr;
                    el.textContent = DateHelper.recalcRelative(text, dateStr);
                }
            }
        }

        // --- Progressive real-date enrichment for feed cards ---

        async _enrichCardDates(videos) {
            const dateStr = Store.getCurrentDate();
            if (!dateStr) return;

            for (const video of videos) {
                try {
                    const pubDate = await this.feedEngine.api.getPublishDate(video.id);
                    if (!pubDate) continue;

                    // Update homepage card
                    const card = document.querySelector(`[data-video-id="${video.id}"] .wbt-card-date`);
                    if (card) {
                        card.textContent = DateHelper.relativeToDate(new Date(pubDate), dateStr);
                    }
                } catch { /* skip failed lookups */ }
            }
        }

        // --- Hourly refresh check (for rolling clock) ---

        _checkHourlyRefresh() {
            if (!Store.isClockActive()) return;
            const lastRefresh = Store.getLastRefresh();
            if (!lastRefresh) return;
            const elapsed = Date.now() - lastRefresh;
            if (elapsed >= 3600000 && this._isHomePage()) { // 1 hour
                console.log('[iw2gb] Hourly refresh triggered');
                Store.setLastRefresh(Date.now()); // update BEFORE refresh to prevent re-triggering
                this._refreshHomepage();
            }
        }
    }

    // =========================================================================
    // 7. THEME ENGINE  –  2011 vintage flat CSS
    // =========================================================================

    class ThemeEngine {
        static inject() {
            GM_addStyle(`
                /* === iwant2gob4ck 2011 Flat Theme === */

                /* Global overrides — square corners, no shadows, no animations */
                ytd-app,
                ytd-browse,
                ytd-watch-flexy,
                ytd-masthead,
                ytd-mini-guide-renderer,
                ytd-guide-renderer,
                #content,
                #page-manager {
                    border-radius: 0 !important;
                }

                /* Kill rounded corners on thumbnails */
                ytd-thumbnail,
                ytd-thumbnail img,
                yt-image,
                yt-img-shadow,
                yt-img-shadow img,
                .yt-core-image,
                ytd-rich-item-renderer,
                ytd-compact-video-renderer,
                ytd-video-renderer {
                    border-radius: 0 !important;
                }

                /* Kill shadows */
                ytd-masthead,
                #masthead-container,
                ytd-searchbox,
                tp-yt-paper-dialog,
                ytd-popup-container {
                    box-shadow: none !important;
                }

                /* Kill animations/transitions on common elements */
                ytd-thumbnail,
                ytd-rich-item-renderer,
                yt-img-shadow {
                    transition: none !important;
                }

                /* Hide Shorts shelf & tabs everywhere */
                ytd-reel-shelf-renderer,
                ytd-rich-shelf-renderer[is-shorts],
                [overlay-style="SHORTS"],
                .shortsLockupViewModelHost,
                .ytGridShelfViewModelHost,
                ytd-reel-item-renderer,
                ytd-feed-filter-chip-bar-renderer,
                ytd-chip-cloud-renderer,
                #chips {
                    display: none !important;
                }

                /* Nuke Shorts from navigation, channel tabs, and search */
                ytd-guide-entry-renderer:has(a[href="/shorts"]),
                ytd-mini-guide-entry-renderer:has(a[href="/shorts"]),
                yt-tab-shape[tab-title="Shorts"],
                tp-yt-paper-tab:has(div[tab-title="Shorts"]),
                ytd-video-renderer:has(a[href*="/shorts/"]),
                ytd-rich-item-renderer:has(a[href*="/shorts/"]) {
                    display: none !important;
                }

                /* === iwant2gob4ck Custom Components (2009 YouTube style) === */

                /* Homepage / channel grid — span full width of YouTube's grid */
                .wbt-container,
                .wbt-channel-container {
                    grid-column: 1 / -1;
                    width: 100%;
                    padding: 16px 0;
                    box-sizing: border-box;
                }

                .wbt-toolbar {
                    display: flex;
                    gap: 8px;
                    margin-bottom: 16px;
                    padding: 0 16px;
                }

                .wbt-refresh-btn {
                    background: #cc0000;
                    color: #fff;
                    border: none;
                    padding: 8px 16px;
                    font-size: 12px;
                    font-weight: bold;
                    cursor: pointer;
                    text-transform: uppercase;
                    letter-spacing: 0.5px;
                }
                .wbt-refresh-btn:hover {
                    background: #aa0000;
                }

                .wbt-grid {
                    display: grid;
                    grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
                    gap: 16px;
                    padding: 0 16px;
                    width: 100%;
                    box-sizing: border-box;
                }

                .wbt-card {
                    background: transparent;
                }

                .wbt-card-link {
                    text-decoration: none;
                    color: inherit;
                    display: block;
                }

                .wbt-thumb-wrap {
                    position: relative;
                    width: 100%;
                    padding-bottom: 56.25%;
                    overflow: hidden;
                    background: #000;
                }

                .wbt-thumb {
                    position: absolute;
                    top: 0; left: 0;
                    width: 100%;
                    height: 100%;
                    object-fit: cover;
                }

                .wbt-card-info {
                    padding: 8px 0;
                }

                /* 2009 blue link titles */
                .wbt-card-title {
                    font-size: 14px;
                    font-weight: bold;
                    line-height: 1.3;
                    color: #0033cc;
                    display: -webkit-box;
                    -webkit-line-clamp: 2;
                    -webkit-box-orient: vertical;
                    overflow: hidden;
                    margin-bottom: 4px;
                }
                .wbt-card-link:hover .wbt-card-title {
                    text-decoration: underline;
                }
                html[dark] .wbt-card-title {
                    color: #6e9fff;
                }

                .wbt-card-channel {
                    font-size: 12px;
                    color: #666;
                    margin-bottom: 2px;
                }
                html[dark] .wbt-card-channel {
                    color: #aaa;
                }

                .wbt-card-meta {
                    font-size: 12px;
                    color: #666;
                }
                html[dark] .wbt-card-meta {
                    color: #888;
                }

                .wbt-dot {
                    margin: 0 4px;
                }

                /* Sidebar recommendations */
                .wbt-sidebar-container {
                    padding: 8px 0;
                }

                .wbt-sidebar-header {
                    font-weight: bold;
                    color: #333;
                    padding: 0 0 12px 0;
                    border-bottom: 1px solid #e0e0e0;
                    margin-bottom: 12px;
                    text-transform: uppercase;
                    letter-spacing: 0.5px;
                    font-size: 11px;
                }
                html[dark] .wbt-sidebar-header {
                    color: #ccc;
                    border-bottom-color: #333;
                }

                .wbt-sidebar-card {
                    margin-bottom: 8px;
                }

                .wbt-sidebar-link {
                    display: flex;
                    gap: 8px;
                    text-decoration: none;
                    color: inherit;
                }

                .wbt-sidebar-thumb-wrap {
                    flex-shrink: 0;
                    width: 168px;
                    height: 94px;
                    overflow: hidden;
                    background: #000;
                }

                .wbt-sidebar-thumb {
                    width: 100%;
                    height: 100%;
                    object-fit: cover;
                }

                .wbt-sidebar-info {
                    flex: 1;
                    min-width: 0;
                }

                .wbt-sidebar-title {
                    font-size: 13px;
                    font-weight: bold;
                    line-height: 1.3;
                    color: #0033cc;
                    display: -webkit-box;
                    -webkit-line-clamp: 2;
                    -webkit-box-orient: vertical;
                    overflow: hidden;
                    margin-bottom: 4px;
                }
                .wbt-sidebar-link:hover .wbt-sidebar-title {
                    text-decoration: underline;
                }
                html[dark] .wbt-sidebar-title {
                    color: #6e9fff;
                }

                .wbt-sidebar-channel {
                    font-size: 11px;
                    color: #666;
                    margin-bottom: 2px;
                }
                html[dark] .wbt-sidebar-channel {
                    color: #aaa;
                }

                .wbt-sidebar-meta {
                    font-size: 11px;
                    color: #666;
                }
                html[dark] .wbt-sidebar-meta {
                    color: #888;
                }

                /* Loading / empty states */
                .wbt-loading {
                    text-align: center;
                    padding: 40px;
                    color: #666;
                    font-size: 14px;
                }
                html[dark] .wbt-loading {
                    color: #aaa;
                }

                .wbt-empty {
                    text-align: center;
                    padding: 40px;
                    background: #f2f2f2;
                }
                html[dark] .wbt-empty {
                    background: #1a1a1a;
                }
                .wbt-empty h3 {
                    margin: 0 0 8px;
                    color: #333;
                }
                html[dark] .wbt-empty h3 {
                    color: #ddd;
                }
                .wbt-empty p {
                    margin: 0;
                    color: #666;
                    font-size: 13px;
                }
                html[dark] .wbt-empty p {
                    color: #aaa;
                }

                /* Load more button */
                .wbt-load-more {
                    display: block;
                    margin: 16px auto;
                    background: #f0f0f0;
                    color: #333;
                    border: 1px solid #ccc;
                    padding: 10px 32px;
                    font-size: 12px;
                    font-weight: bold;
                    cursor: pointer;
                    text-transform: uppercase;
                }
                .wbt-load-more:hover {
                    background: #e0e0e0;
                }
                html[dark] .wbt-load-more {
                    background: #272727;
                    color: #ccc;
                    border-color: #444;
                }
                html[dark] .wbt-load-more:hover {
                    background: #333;
                }

                /* === Control Panel === */

                .wbt-panel {
                    position: fixed;
                    top: 60px;
                    right: 10px;
                    width: ${CONFIG.ui.panelWidth}px;
                    max-height: calc(100vh - 80px);
                    overflow-y: auto;
                    background: #1a1a1a;
                    color: #ddd;
                    z-index: 99999;
                    font-family: Arial, Helvetica, sans-serif;
                    font-size: 12px;
                    border: 1px solid #333;
                }

                .wbt-panel-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    padding: 10px 12px;
                    background: #111;
                    border-bottom: 1px solid #333;
                    cursor: move;
                }

                .wbt-panel-title {
                    font-weight: bold;
                    font-size: 13px;
                    color: #fff;
                }

                .wbt-panel-controls {
                    display: flex;
                    gap: 6px;
                }

                .wbt-panel-btn {
                    background: none;
                    border: none;
                    color: #aaa;
                    cursor: pointer;
                    font-size: 16px;
                    padding: 0 4px;
                    line-height: 1;
                }
                .wbt-panel-btn:hover {
                    color: #fff;
                }

                .wbt-panel-body {
                    padding: 0;
                }

                .wbt-section {
                    border-bottom: 1px solid #333;
                }

                .wbt-section-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    padding: 10px 12px;
                    cursor: pointer;
                    user-select: none;
                    background: #222;
                }
                .wbt-section-header:hover {
                    background: #2a2a2a;
                }

                .wbt-section-title {
                    font-weight: bold;
                    font-size: 11px;
                    text-transform: uppercase;
                    letter-spacing: 0.5px;
                    color: #ccc;
                }

                .wbt-section-toggle {
                    color: #888;
                    font-size: 10px;
                }

                .wbt-section-content {
                    padding: 10px 12px;
                    display: none;
                }
                .wbt-section-content.open {
                    display: block;
                }

                /* Date section */
                .wbt-date-input {
                    width: 100%;
                    padding: 6px 8px;
                    background: #2a2a2a;
                    border: 1px solid #444;
                    color: #fff;
                    font-size: 13px;
                    margin-bottom: 8px;
                    box-sizing: border-box;
                }

                .wbt-presets {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 4px;
                }

                .wbt-preset-btn {
                    background: #333;
                    border: 1px solid #555;
                    color: #ccc;
                    padding: 4px 10px;
                    font-size: 11px;
                    cursor: pointer;
                }
                .wbt-preset-btn:hover {
                    background: #444;
                    color: #fff;
                }

                /* Clock */
                .wbt-clock-row {
                    margin-top: 8px;
                    display: flex;
                    align-items: center;
                    gap: 8px;
                }

                .wbt-clock-btn {
                    background: #333;
                    border: 1px solid #555;
                    color: #ccc;
                    padding: 4px 12px;
                    font-size: 11px;
                    cursor: pointer;
                    white-space: nowrap;
                }
                .wbt-clock-btn:hover {
                    background: #444;
                    color: #fff;
                }

                .wbt-clock-display {
                    font-family: 'Consolas', 'Courier New', monospace;
                    font-size: 12px;
                    color: #4caf50;
                    letter-spacing: 0.5px;
                }

                /* List items (subs, terms, topics) */
                .wbt-add-row {
                    display: flex;
                    gap: 4px;
                    margin-bottom: 8px;
                }

                .wbt-add-input {
                    flex: 1;
                    padding: 5px 8px;
                    background: #2a2a2a;
                    border: 1px solid #444;
                    color: #fff;
                    font-size: 12px;
                }

                .wbt-add-btn {
                    background: #cc0000;
                    border: none;
                    color: #fff;
                    padding: 5px 12px;
                    font-size: 11px;
                    cursor: pointer;
                    white-space: nowrap;
                }
                .wbt-add-btn:hover {
                    background: #aa0000;
                }

                .wbt-list {
                    max-height: 150px;
                    overflow-y: auto;
                }

                .wbt-list-item {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    padding: 4px 0;
                    border-bottom: 1px solid #2a2a2a;
                }

                .wbt-list-name {
                    flex: 1;
                    min-width: 0;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                    color: #ccc;
                    font-size: 12px;
                }

                .wbt-list-remove {
                    background: #c00;
                    border: none;
                    color: #fff;
                    padding: 2px 8px;
                    font-size: 10px;
                    cursor: pointer;
                    flex-shrink: 0;
                    margin-left: 6px;
                }
                .wbt-list-remove:hover {
                    background: #a00;
                }

                /* Weight controls */
                .wbt-weight-ctrl {
                    display: flex;
                    align-items: center;
                    gap: 2px;
                    flex-shrink: 0;
                    margin-left: 4px;
                }
                .wbt-weight-btn {
                    background: #444;
                    border: none;
                    color: #ccc;
                    width: 16px;
                    height: 16px;
                    font-size: 10px;
                    cursor: pointer;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    padding: 0;
                    line-height: 1;
                }
                .wbt-weight-btn:hover {
                    background: #666;
                    color: #fff;
                }
                .wbt-weight-label {
                    font-size: 10px;
                    color: #4caf50;
                    font-weight: bold;
                    min-width: 10px;
                    text-align: center;
                }

                /* Categories checkboxes */
                .wbt-cat-grid {
                    display: grid;
                    grid-template-columns: 1fr 1fr;
                    gap: 4px;
                }

                .wbt-cat-label {
                    display: flex;
                    align-items: center;
                    gap: 4px;
                    font-size: 11px;
                    color: #ccc;
                    cursor: pointer;
                    padding: 2px 0;
                }

                .wbt-cat-label input {
                    accent-color: #cc0000;
                }

                /* Stats */
                .wbt-stats-grid {
                    display: grid;
                    grid-template-columns: 1fr 1fr;
                    gap: 4px;
                }

                .wbt-stat {
                    display: flex;
                    justify-content: space-between;
                    padding: 2px 0;
                    font-size: 11px;
                }

                .wbt-stat-label {
                    color: #888;
                }

                .wbt-stat-value {
                    color: #ccc;
                    font-weight: bold;
                }

                /* Status badge */
                .wbt-status {
                    display: inline-block;
                    padding: 2px 8px;
                    font-size: 10px;
                    font-weight: bold;
                    text-transform: uppercase;
                }
                .wbt-status.active {
                    background: #0a3d0a;
                    color: #4caf50;
                }
                .wbt-status.inactive {
                    background: #3d0a0a;
                    color: #f44336;
                }

                /* Toast */
                .wbt-toast {
                    position: fixed;
                    bottom: 20px;
                    right: 20px;
                    padding: 10px 20px;
                    color: #fff;
                    font-size: 13px;
                    z-index: 999999;
                    opacity: 0;
                    transition: opacity 0.3s;
                }
                .wbt-toast.show {
                    opacity: 1;
                }
                .wbt-toast.success { background: #2e7d32; }
                .wbt-toast.error   { background: #c62828; }

                /* === 2009 Visual Overhaul === */

                /* Hide modern masthead clutter */
                #voice-search-button,
                ytd-topbar-menu-button-renderer:has(button[aria-label="Create"]),
                ytd-topbar-menu-button-renderer:has(button[aria-label*="Gemini"]),
                ytd-topbar-menu-button-renderer:has(button[aria-label*="gemini"]),
                ytd-topbar-menu-button-renderer:has(button[aria-label*="AI"]),
                ytd-topbar-menu-button-renderer:has([class*="gemini"]),
                ytd-topbar-menu-button-renderer:has([class*="Gemini"]),
                ytd-topbar-menu-button-renderer:has(yt-icon[icon="youtube_gemini_sparkle"]),
                ytd-topbar-menu-button-renderer:has(path[d*="M12 2C6.48"]),
                tp-yt-iron-icon[icon="youtube_gemini_sparkle"],
                [class*="gemini-promo"],
                [class*="gemini-entry"],
                ytd-notification-topbar-button-renderer,
                ytd-topbar-logo-renderer #country-code,
                ytd-topbar-menu-button-renderer:has(a[href*="premium"]) {
                    display: none !important;
                }

                /* Classic "YouTube" logo */
                ytd-topbar-logo-renderer a#logo yt-icon,
                ytd-topbar-logo-renderer a#logo svg {
                    display: none !important;
                }
                ytd-topbar-logo-renderer a#logo {
                    display: flex !important;
                    align-items: center;
                    text-decoration: none !important;
                    font-family: Arial, Helvetica, sans-serif;
                    font-size: 20px;
                    font-weight: bold;
                    line-height: 1;
                }
                ytd-topbar-logo-renderer a#logo::before {
                    content: 'You';
                    color: #000;
                    font-size: 20px;
                    font-weight: bold;
                }
                html[dark] ytd-topbar-logo-renderer a#logo::before {
                    color: #fff;
                }
                ytd-topbar-logo-renderer a#logo::after {
                    content: 'Tube';
                    color: #fff;
                    background: #cc0000;
                    border-radius: 4px;
                    padding: 2px 6px;
                    font-size: 20px;
                    font-weight: bold;
                    margin-left: 1px;
                }
                /* JS fallback logo styling */
                .wbt-logo-you {
                    color: #000;
                }
                html[dark] .wbt-logo-you {
                    color: #fff;
                }
                /* Hide pseudo-elements when custom logo is uploaded */
                ytd-topbar-logo-renderer a#logo.wbt-has-custom-logo::before,
                ytd-topbar-logo-renderer a#logo.wbt-has-custom-logo::after {
                    display: none !important;
                }

                /* 2009 rectangular search bar */
                ytd-searchbox,
                ytd-searchbox #container {
                    border-radius: 0 !important;
                    border: 1px solid #999 !important;
                    background: #fff !important;
                    box-shadow: none !important;
                }
                ytd-searchbox #container.ytd-searchbox {
                    border-radius: 0 !important;
                    padding: 0 !important;
                    margin: 0 !important;
                }
                input#search {
                    background: #fff !important;
                    border: none !important;
                    border-radius: 0 !important;
                    box-shadow: none !important;
                }
                html[dark] ytd-searchbox,
                html[dark] ytd-searchbox #container {
                    background: #222 !important;
                    border-color: #555 !important;
                }
                html[dark] input#search {
                    background: #222 !important;
                    color: #fff !important;
                }
                #search-icon-legacy {
                    background: #f0f0f0 !important;
                    border-left: 1px solid #999 !important;
                    border-radius: 0 !important;
                }
                html[dark] #search-icon-legacy {
                    background: #333 !important;
                    border-left-color: #555 !important;
                }
                ytd-searchbox[has-focus] #container,
                ytd-searchbox[focused] #container {
                    box-shadow: none !important;
                    border-color: #999 !important;
                }
                html[dark] ytd-searchbox[has-focus] #container,
                html[dark] ytd-searchbox[focused] #container {
                    border-color: #555 !important;
                }

                /* 2009 masthead/header */
                ytd-masthead {
                    background: #fff !important;
                    border-bottom: 1px solid #ccc !important;
                    box-shadow: none !important;
                }
                #masthead-container {
                    background: #fff !important;
                }
                ytd-app,
                ytd-browse,
                #content,
                #page-manager,
                ytd-two-column-browse-results-renderer {
                    background: #f2f2f2 !important;
                }
                html[dark] ytd-masthead {
                    background: #1a1a1a !important;
                    border-bottom-color: #333 !important;
                }
                html[dark] #masthead-container {
                    background: #1a1a1a !important;
                }
                html[dark] ytd-app,
                html[dark] ytd-browse,
                html[dark] #content,
                html[dark] #page-manager,
                html[dark] ytd-two-column-browse-results-renderer {
                    background: #111 !important;
                }

                /* 2009 sidebar navigation */
                ytd-guide-renderer {
                    background: #f2f2f2 !important;
                    border-right: 1px solid #ccc !important;
                }
                html[dark] ytd-guide-renderer {
                    background: #1a1a1a !important;
                    border-right-color: #333 !important;
                }
                ytd-guide-entry-renderer {
                    border-radius: 0 !important;
                }
                ytd-guide-entry-renderer tp-yt-paper-item,
                ytd-guide-entry-renderer a.yt-simple-endpoint {
                    border-radius: 0 !important;
                    height: 32px !important;
                    padding: 0 12px !important;
                }
                ytd-guide-entry-renderer yt-icon,
                ytd-guide-entry-renderer .guide-icon {
                    width: 18px !important;
                    height: 18px !important;
                }
                ytd-guide-entry-renderer[active] tp-yt-paper-item,
                ytd-guide-entry-renderer[active] a.yt-simple-endpoint,
                ytd-guide-entry-renderer tp-yt-paper-item:hover,
                ytd-guide-entry-renderer a.yt-simple-endpoint:hover {
                    background: #e0e0e0 !important;
                    border-radius: 0 !important;
                }
                html[dark] ytd-guide-entry-renderer[active] tp-yt-paper-item,
                html[dark] ytd-guide-entry-renderer[active] a.yt-simple-endpoint,
                html[dark] ytd-guide-entry-renderer tp-yt-paper-item:hover,
                html[dark] ytd-guide-entry-renderer a.yt-simple-endpoint:hover {
                    background: #333 !important;
                }
                ytd-guide-section-renderer #guide-section-title {
                    text-transform: uppercase !important;
                    font-size: 10px !important;
                    letter-spacing: 1px !important;
                    color: #888 !important;
                }
                ytd-mini-guide-renderer {
                    background: #f2f2f2 !important;
                }
                html[dark] ytd-mini-guide-renderer {
                    background: #1a1a1a !important;
                }
                ytd-mini-guide-entry-renderer {
                    border-radius: 0 !important;
                }
                ytd-mini-guide-entry-renderer yt-icon {
                    width: 18px !important;
                    height: 18px !important;
                }
                #guide-renderer #footer,
                ytd-guide-renderer #footer {
                    display: none !important;
                }

                /* === Video page: flatten like/dislike/subscribe/share === */

                /* Kill all rounded buttons on watch page */
                yt-button-shape button,
                yt-button-shape a,
                ytd-button-renderer button,
                ytd-button-renderer a,
                ytd-toggle-button-renderer button,
                ytd-subscribe-button-renderer button,
                #subscribe-button button,
                #subscribe-button yt-button-shape button,
                .yt-spec-button-shape-next,
                tp-yt-paper-button {
                    border-radius: 0 !important;
                }

                /* Like/dislike segmented button */
                ytd-segmented-like-dislike-button-renderer,
                like-button-view-model,
                dislike-button-view-model,
                .YtLikeButtonViewModelHost,
                .YtDislikeButtonViewModelHost {
                    border-radius: 0 !important;
                }
                ytd-segmented-like-dislike-button-renderer .yt-spec-button-shape-next,
                like-button-view-model .yt-spec-button-shape-next,
                dislike-button-view-model .yt-spec-button-shape-next {
                    border-radius: 0 !important;
                }

                /* Subscribe button flat */
                ytd-subscribe-button-renderer,
                yt-subscribe-button-view-model,
                .yt-spec-button-shape-next--filled {
                    border-radius: 0 !important;
                }

                /* Share, clip, save, thanks buttons */
                ytd-menu-renderer yt-button-shape,
                #top-level-buttons-computed yt-button-shape,
                #flexible-item-buttons yt-button-shape {
                    border-radius: 0 !important;
                }
                ytd-menu-renderer yt-button-shape button,
                #top-level-buttons-computed yt-button-shape button,
                #flexible-item-buttons yt-button-shape button {
                    border-radius: 0 !important;
                }

                /* Description box */
                ytd-text-inline-expander,
                #description-inner,
                ytd-watch-metadata #description,
                #above-the-fold #description,
                tp-yt-paper-dialog {
                    border-radius: 0 !important;
                }

                /* Comment input and chips */
                #comment-dialog tp-yt-paper-input-container,
                #contenteditable-root,
                #simplebox-placeholder,
                ytd-comments-header-renderer #sort-menu yt-sort-filter-sub-menu-renderer,
                ytd-comment-simplebox-renderer {
                    border-radius: 0 !important;
                }

                /* Channel avatar — square */
                #owner #avatar img,
                #owner yt-img-shadow,
                ytd-video-owner-renderer #avatar img,
                ytd-video-owner-renderer yt-img-shadow {
                    border-radius: 0 !important;
                }

                /* Chips/pills on watch page */
                yt-chip-cloud-chip-renderer,
                ytd-search-filter-renderer {
                    border-radius: 0 !important;
                }

                /* Kill Gemini on video page */
                ytd-watch-metadata [class*="gemini"],
                ytd-watch-flexy [class*="gemini"],
                #cinematics,
                [class*="sparkle"],
                ytd-menu-renderer ytd-button-renderer:has([aria-label*="Gemini"]),
                ytd-menu-renderer ytd-button-renderer:has([aria-label*="gemini"]),
                ytd-menu-renderer yt-button-shape:has([aria-label*="Gemini"]),
                ytd-menu-renderer yt-button-shape:has([aria-label*="gemini"]) {
                    display: none !important;
                }

                /* Profile buttons */
                .wbt-profile-actions {
                    margin-bottom: 8px;
                }
                .wbt-profile-import-btn {
                    background: #333;
                    border: 1px solid #555;
                    color: #ccc;
                    padding: 4px 10px;
                    font-size: 11px;
                    cursor: pointer;
                }
                .wbt-profile-import-btn:hover {
                    background: #444;
                    color: #fff;
                }
                .wbt-profile-btns {
                    display: flex;
                    gap: 4px;
                    flex-shrink: 0;
                    margin-left: 4px;
                }
                .wbt-profile-action-btn {
                    background: #333;
                    border: 1px solid #555;
                    color: #ccc;
                    padding: 2px 8px;
                    font-size: 10px;
                    cursor: pointer;
                }
                .wbt-profile-action-btn:hover {
                    background: #444;
                    color: #fff;
                }

                /* === Panel collapse tab === */
                .wbt-fab {
                    position: fixed;
                    right: 0;
                    top: 50%;
                    width: 16px;
                    height: 40px;
                    background: #cc0000;
                    color: #fff;
                    border: none;
                    border-radius: 4px 0 0 4px;
                    cursor: pointer;
                    z-index: 99999;
                    font-size: 0;
                    padding: 0;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    box-shadow: -1px 1px 4px rgba(0,0,0,0.3);
                    transition: width 0.15s, background 0.15s;
                }
                .wbt-fab::after {
                    content: '';
                    display: block;
                    width: 0;
                    height: 0;
                    border-top: 5px solid transparent;
                    border-bottom: 5px solid transparent;
                    border-right: 5px solid #fff;
                    margin-right: 1px;
                }
                .wbt-fab:hover {
                    background: #aa0000;
                    width: 20px;
                }

                /* Logo upload section */
                .wbt-logo-preview {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    margin-bottom: 8px;
                }
                .wbt-logo-preview img {
                    max-height: 24px;
                    max-width: 120px;
                    object-fit: contain;
                    background: repeating-conic-gradient(#808080 0% 25%, transparent 0% 50%) 50% / 8px 8px;
                }
                .wbt-logo-actions {
                    display: flex;
                    gap: 4px;
                }

                /* === WBT Endscreen Overlay === */

                /* Hide YouTube's native endscreen & watch-next overlays */
                .html5-endscreen,
                .ytp-endscreen-content,
                .ytp-ce-element,
                .ytp-suggestion-set,
                .ytp-videowall-still,
                .ytp-endscreen-content .ytp-videowall-still,
                .ytp-autonav-endscreen,
                .ytp-autonav-endscreen-countdown,
                .ytp-autonav-endscreen-upnext-container,
                .ytp-player-content:has(.ytp-autonav-endscreen),
                .ytp-upnext,
                .ytp-pause-overlay,
                .ytp-scroll-min .ytp-pause-overlay {
                    display: none !important;
                }

                .wbt-endscreen-container {
                    position: absolute;
                    top: 0; left: 0; right: 0; bottom: 0;
                    background: rgba(0, 0, 0, 0.85);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    z-index: 60;
                    padding: 20px;
                    box-sizing: border-box;
                }

                .wbt-endscreen-grid {
                    display: grid;
                    grid-template-columns: repeat(4, 1fr);
                    gap: 12px;
                    max-width: 900px;
                    width: 100%;
                }

                .wbt-endscreen-card {
                    background: transparent;
                }

                .wbt-endscreen-link {
                    text-decoration: none;
                    color: inherit;
                    display: block;
                }

                .wbt-endscreen-thumb-wrap {
                    position: relative;
                    width: 100%;
                    padding-bottom: 56.25%;
                    overflow: hidden;
                    background: #000;
                }

                .wbt-endscreen-thumb {
                    position: absolute;
                    top: 0; left: 0;
                    width: 100%;
                    height: 100%;
                    object-fit: cover;
                }

                .wbt-endscreen-info {
                    padding: 4px 0;
                }

                .wbt-endscreen-title {
                    font-size: 12px;
                    font-weight: bold;
                    line-height: 1.3;
                    color: #fff;
                    display: -webkit-box;
                    -webkit-line-clamp: 2;
                    -webkit-box-orient: vertical;
                    overflow: hidden;
                    margin-bottom: 2px;
                }
                .wbt-endscreen-link:hover .wbt-endscreen-title {
                    text-decoration: underline;
                    color: #6e9fff;
                }

                .wbt-endscreen-channel {
                    font-size: 11px;
                    color: #aaa;
                }
            `);
        }
    }

    // =========================================================================
    // 8. UI PANEL  –  control panel
    // =========================================================================

    class UIPanel {
        constructor(api, domController) {
            this.api = api;
            this.dom = domController;
            this.panel = null;
            this._stats = { videosLoaded: 0, cacheHits: 0 };
        }

        init() {
            // Remove existing panel/fab if re-injecting
            const existing = document.getElementById('wbt-panel');
            if (existing) existing.remove();
            const existingFab = document.getElementById('wbt-fab');
            if (existingFab) existingFab.remove();

            this._build();
            this._buildFab();
            this._attachDragHandler();
            this._startClockTicker();

            // Apply collapsed state
            if (Store.isCollapsed()) {
                this.panel.style.display = 'none';
                document.getElementById('wbt-fab').style.display = 'flex';
            }
        }

        _startClockTicker() {
            // Update the clock display every second
            if (this._clockInterval) clearInterval(this._clockInterval);
            this._clockInterval = setInterval(() => {
                const display = document.getElementById('wbt-clock-display');
                if (!display) return;
                if (Store.isClockActive()) {
                    const dt = Store.getCurrentDateTime();
                    const dateStr = dt.toISOString().split('T')[0];
                    const timeStr = dt.toTimeString().split(' ')[0]; // HH:MM:SS
                    display.textContent = `${dateStr}  ${timeStr}`;
                    display.style.display = 'block';
                }
            }, 1000);
        }

        _buildFab() {
            const fab = _el('button', 'wbt-fab');
            fab.id = 'wbt-fab';
            fab.title = 'Open iwant2gob4ck panel';
            fab.style.display = 'none';

            // Restore saved Y position
            const savedY = Store.getTabY();
            if (savedY !== null) {
                fab.style.top = savedY + 'px';
            }

            // Drag vertically along right edge
            let dragging = false, startY, startTop, didDrag = false;

            fab.addEventListener('mousedown', (e) => {
                dragging = true;
                didDrag = false;
                startY = e.clientY;
                startTop = fab.getBoundingClientRect().top;
                e.preventDefault();
            });

            document.addEventListener('mousemove', (e) => {
                if (!dragging) return;
                const dy = e.clientY - startY;
                if (Math.abs(dy) > 3) didDrag = true;
                const newTop = Math.max(0, Math.min(window.innerHeight - fab.offsetHeight, startTop + dy));
                fab.style.top = newTop + 'px';
            });

            document.addEventListener('mouseup', () => {
                if (dragging) {
                    dragging = false;
                    Store.setTabY(parseInt(fab.style.top));
                }
            });

            fab.addEventListener('click', () => {
                if (didDrag) return; // don't open panel if user was dragging
                Store.setCollapsed(false);
                this.panel.style.display = '';
                fab.style.display = 'none';
            });

            document.body.appendChild(fab);
        }

        // --- Build (pure DOM, no innerHTML — Trusted Types safe) ---

        _build() {
            this.panel = _el('div', 'wbt-panel');
            this.panel.id = 'wbt-panel';

            const minimized = Store.isMinimized();
            const active = Store.isActive();
            const selectedDate = Store.getDate() || '';

            // Header
            const header = _el('div', 'wbt-panel-header');
            header.id = 'wbt-drag-handle';
            header.appendChild(_el('span', 'wbt-panel-title', 'iwant2gob4ck'));

            const controls = _el('div', 'wbt-panel-controls');
            const statusBadge = _el('span', `wbt-status ${active ? 'active' : 'inactive'}`, active ? 'ON' : 'OFF');
            statusBadge.id = 'wbt-status';
            const toggleBtn = _el('button', 'wbt-panel-btn', active ? 'Disable' : 'Enable');
            toggleBtn.id = 'wbt-toggle-active';
            toggleBtn.title = 'Toggle active';
            const minBtn = _el('button', 'wbt-panel-btn', minimized ? '+' : '\u2013');
            minBtn.id = 'wbt-minimize';
            minBtn.title = 'Minimize';
            const collapseBtn = _el('button', 'wbt-panel-btn', 'X');
            collapseBtn.id = 'wbt-collapse';
            collapseBtn.title = 'Collapse to button';
            controls.appendChild(statusBadge);
            controls.appendChild(toggleBtn);
            controls.appendChild(minBtn);
            controls.appendChild(collapseBtn);
            header.appendChild(controls);
            this.panel.appendChild(header);

            // Body
            const body = _el('div', 'wbt-panel-body');
            body.id = 'wbt-body';
            if (minimized) body.style.display = 'none';

            // --- Date section ---
            const dateInput = document.createElement('input');
            dateInput.type = 'date';
            dateInput.className = 'wbt-date-input';
            dateInput.id = 'wbt-date';
            dateInput.value = selectedDate;

            const presets = _el('div', 'wbt-presets');
            for (const y of [1, 2, 5, 10, 15]) {
                const pb = _el('button', 'wbt-preset-btn', `${y}y ago`);
                pb.dataset.years = y;
                presets.appendChild(pb);
            }

            // Clock toggle + display
            const clockRow = _el('div', 'wbt-clock-row');
            const clockToggle = _el('button', 'wbt-clock-btn', Store.isClockActive() ? 'Stop Clock' : 'Start Clock');
            clockToggle.id = 'wbt-clock-toggle';
            const clockDisplay = _el('div', 'wbt-clock-display');
            clockDisplay.id = 'wbt-clock-display';
            clockDisplay.textContent = Store.isClockActive() ? Store.getCurrentDate() : '';
            clockDisplay.style.display = Store.isClockActive() ? 'block' : 'none';
            clockRow.appendChild(clockToggle);
            clockRow.appendChild(clockDisplay);

            body.appendChild(this._buildSection('Date', 'date', true, [dateInput, presets, clockRow]));

            // --- Logo section ---
            const logoContainer = _el('div', null);
            const logoPreview = _el('div', 'wbt-logo-preview');
            logoPreview.id = 'wbt-logo-preview';
            const currentLogo = Store.getCustomLogo();
            if (currentLogo) {
                const prevImg = document.createElement('img');
                prevImg.src = currentLogo;
                logoPreview.appendChild(prevImg);
            } else {
                logoPreview.appendChild(_el('span', null, 'Default (YouΤube text)'));
                logoPreview.style.cssText = 'color:#666;font-size:11px;';
            }
            logoContainer.appendChild(logoPreview);

            const logoActions = _el('div', 'wbt-logo-actions');
            const logoFileInput = document.createElement('input');
            logoFileInput.type = 'file';
            logoFileInput.accept = 'image/png,image/gif,image/webp,image/svg+xml';
            logoFileInput.id = 'wbt-logo-file';
            logoFileInput.style.display = 'none';
            const uploadBtn = _el('button', 'wbt-preset-btn', 'Upload PNG');
            uploadBtn.id = 'wbt-logo-upload';
            const clearBtn = _el('button', 'wbt-preset-btn', 'Clear');
            clearBtn.id = 'wbt-logo-clear';
            logoActions.appendChild(logoFileInput);
            logoActions.appendChild(uploadBtn);
            logoActions.appendChild(clearBtn);
            logoContainer.appendChild(logoActions);

            body.appendChild(this._buildSection('Logo', 'logo', false, [logoContainer]));

            // --- Subscriptions section ---
            const subInput = document.createElement('input');
            subInput.className = 'wbt-add-input';
            subInput.id = 'wbt-sub-input';
            subInput.placeholder = 'Channel name, @handle, or ID';
            const subBtn = _el('button', 'wbt-add-btn', 'Add');
            subBtn.id = 'wbt-sub-add';
            const subRow = _el('div', 'wbt-add-row', [subInput, subBtn]);
            const subList = _el('div', 'wbt-list');
            subList.id = 'wbt-sub-list';
            body.appendChild(this._buildSection('Subscriptions', 'subs', false, [subRow, subList]));

            // --- Search Terms section ---
            const termInput = document.createElement('input');
            termInput.className = 'wbt-add-input';
            termInput.id = 'wbt-term-input';
            termInput.placeholder = 'e.g. funny cats';
            const termBtn = _el('button', 'wbt-add-btn', 'Add');
            termBtn.id = 'wbt-term-add';
            const termRow = _el('div', 'wbt-add-row', [termInput, termBtn]);
            const termList = _el('div', 'wbt-list');
            termList.id = 'wbt-term-list';
            body.appendChild(this._buildSection('Search Terms', 'search', false, [termRow, termList]));

            // --- Categories section ---
            const catGrid = _el('div', 'wbt-cat-grid');
            catGrid.id = 'wbt-cat-grid';
            body.appendChild(this._buildSection('Categories', 'cats', false, [catGrid]));

            // --- Custom Topics section ---
            const topicInput = document.createElement('input');
            topicInput.className = 'wbt-add-input';
            topicInput.id = 'wbt-topic-input';
            topicInput.placeholder = 'e.g. Minecraft, Obama';
            const topicBtn = _el('button', 'wbt-add-btn', 'Add');
            topicBtn.id = 'wbt-topic-add';
            const topicRow = _el('div', 'wbt-add-row', [topicInput, topicBtn]);
            const topicList = _el('div', 'wbt-list');
            topicList.id = 'wbt-topic-list';
            body.appendChild(this._buildSection('Custom Topics', 'topics', false, [topicRow, topicList]));

            // --- Trending/Discovery section ---
            const trendingContainer = _el('div', null);
            const trendingRow = _el('div', 'wbt-add-row');
            trendingRow.style.cssText = 'justify-content:space-between;align-items:center;';
            const trendingLabel = _el('span', null, 'Mix in popular videos from the era');
            trendingLabel.style.cssText = 'color:#ccc;font-size:11px;';
            const trendingToggle = _el('button', 'wbt-preset-btn');
            trendingToggle.id = 'wbt-trending-toggle';
            trendingToggle.textContent = Store.isDiscoveryEnabled() ? 'ON' : 'OFF';
            trendingToggle.style.cssText = Store.isDiscoveryEnabled()
                ? 'background:#2a5a2a;color:#4caf50;min-width:40px;'
                : 'background:#5a2a2a;color:#f44;min-width:40px;';
            trendingRow.appendChild(trendingLabel);
            trendingRow.appendChild(trendingToggle);
            const trendingDesc = _el('div', null, 'Searches broad queries sorted by view count within your date window to surface what was popular/viral at the time.');
            trendingDesc.style.cssText = 'color:#666;font-size:10px;margin-top:4px;line-height:1.3;';
            trendingContainer.appendChild(trendingRow);
            trendingContainer.appendChild(trendingDesc);
            body.appendChild(this._buildSection('Trending', 'trending', false, [trendingContainer]));

            // --- Learning section ---
            const learnContainer = _el('div', null);
            const learnRow = _el('div', 'wbt-add-row');
            learnRow.style.cssText = 'justify-content:space-between;align-items:center;';
            const learnLabel = _el('span', null, 'Learn from what I watch');
            learnLabel.style.cssText = 'color:#ccc;font-size:11px;';
            const learnToggle = _el('button', 'wbt-preset-btn');
            learnToggle.id = 'wbt-learn-toggle';
            learnToggle.textContent = Store.isLearningEnabled() ? 'ON' : 'OFF';
            learnToggle.style.cssText = Store.isLearningEnabled()
                ? 'background:#2a5a2a;color:#4caf50;min-width:40px;'
                : 'background:#5a2a2a;color:#f44;min-width:40px;';
            learnRow.appendChild(learnLabel);
            learnRow.appendChild(learnToggle);

            const learnStats = _el('div', null);
            learnStats.id = 'wbt-learn-stats';

            const learnReset = _el('button', 'wbt-preset-btn', 'Reset Learning Data');
            learnReset.id = 'wbt-learn-reset';
            learnReset.style.cssText = 'margin-top:6px;background:#5a2a2a;color:#f44;width:100%;';

            const learnDesc = _el('div', null, 'Tracks what you watch (30s+) and boosts similar channels/topics. Every 10th load uses original weights for discovery.');
            learnDesc.style.cssText = 'color:#666;font-size:10px;margin-top:4px;line-height:1.3;';

            learnContainer.appendChild(learnRow);
            learnContainer.appendChild(learnStats);
            learnContainer.appendChild(learnReset);
            learnContainer.appendChild(learnDesc);
            body.appendChild(this._buildSection('Learning', 'learning', false, [learnContainer]));

            // --- Blocked Channels section ---
            const blockInput = document.createElement('input');
            blockInput.className = 'wbt-add-input';
            blockInput.id = 'wbt-block-input';
            blockInput.placeholder = 'Channel name to block';
            const blockBtn = _el('button', 'wbt-add-btn', 'Block');
            blockBtn.id = 'wbt-block-add';
            const blockRow = _el('div', 'wbt-add-row', [blockInput, blockBtn]);
            const blockList = _el('div', 'wbt-list');
            blockList.id = 'wbt-block-list';
            body.appendChild(this._buildSection('Blocked Channels', 'block', false, [blockRow, blockList]));

            // --- Profiles section ---
            const profileNameInput = document.createElement('input');
            profileNameInput.className = 'wbt-add-input';
            profileNameInput.id = 'wbt-profile-name';
            profileNameInput.placeholder = 'Profile name (e.g. 2007)';
            const profileSaveBtn = _el('button', 'wbt-add-btn', 'Save');
            profileSaveBtn.id = 'wbt-profile-save';
            const profileSaveRow = _el('div', 'wbt-add-row', [profileNameInput, profileSaveBtn]);

            const profileImportBtn = _el('button', 'wbt-profile-import-btn', 'Import');
            profileImportBtn.id = 'wbt-profile-import';
            const profileImportFile = document.createElement('input');
            profileImportFile.type = 'file';
            profileImportFile.accept = '.json';
            profileImportFile.id = 'wbt-profile-file';
            profileImportFile.style.display = 'none';
            const profileActions = _el('div', 'wbt-profile-actions', [profileImportBtn, profileImportFile]);

            const profileList = _el('div', 'wbt-list');
            profileList.id = 'wbt-profile-list';
            body.appendChild(this._buildSection('Profiles', 'profiles', false, [profileSaveRow, profileActions, profileList]));

            // --- Stats section ---
            const statsGrid = _el('div', 'wbt-stats-grid');
            statsGrid.id = 'wbt-stats';
            body.appendChild(this._buildSection('Stats', 'stats', false, [statsGrid]));

            this.panel.appendChild(body);
            document.body.appendChild(this.panel);
            this._attachEvents();
            try { this._refreshAllLists(); } catch (e) { console.error('[iw2gb] List refresh error:', e); }
        }

        _buildSection(title, id, openByDefault, children) {
            const section = _el('div', 'wbt-section');
            section.dataset.section = id;

            const header = _el('div', 'wbt-section-header');
            header.dataset.toggle = id;
            header.appendChild(_el('span', 'wbt-section-title', title));
            header.appendChild(_el('span', 'wbt-section-toggle', openByDefault ? '\u25B2' : '\u25BC'));
            section.appendChild(header);

            const content = _el('div', `wbt-section-content${openByDefault ? ' open' : ''}`);
            content.id = `wbt-sec-${id}`;
            for (const child of children) {
                content.appendChild(child);
            }
            section.appendChild(content);

            return section;
        }

        // --- Events ---

        _attachEvents() {
            // Toggle active
            this.panel.querySelector('#wbt-toggle-active').addEventListener('click', () => {
                const nowActive = !Store.isActive();
                Store.setActive(nowActive);
                this.panel.querySelector('#wbt-status').className = `wbt-status ${nowActive ? 'active' : 'inactive'}`;
                this.panel.querySelector('#wbt-status').textContent = nowActive ? 'ON' : 'OFF';
                this.panel.querySelector('#wbt-toggle-active').textContent = nowActive ? 'Disable' : 'Enable';
                if (nowActive) this.dom.forceReload();
            });

            // Minimize
            this.panel.querySelector('#wbt-minimize').addEventListener('click', () => {
                const body = this.panel.querySelector('#wbt-body');
                const btn = this.panel.querySelector('#wbt-minimize');
                const isHidden = body.style.display === 'none';
                body.style.display = isHidden ? '' : 'none';
                btn.textContent = isHidden ? '\u2013' : '+';
                Store.setMinimized(!isHidden);
            });

            // Collapse to FAB
            this.panel.querySelector('#wbt-collapse').addEventListener('click', () => {
                Store.setCollapsed(true);
                this.panel.style.display = 'none';
                const fab = document.getElementById('wbt-fab');
                if (fab) fab.style.display = 'flex';
            });

            // Logo upload
            this.panel.querySelector('#wbt-logo-upload').addEventListener('click', () => {
                this.panel.querySelector('#wbt-logo-file').click();
            });
            this.panel.querySelector('#wbt-logo-file').addEventListener('change', (e) => {
                const file = e.target.files[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = () => {
                    Store.setCustomLogo(reader.result);
                    // Remove existing logo so it rebuilds
                    const existing = document.querySelector('.wbt-retro-logo');
                    if (existing) existing.remove();
                    this._refreshLogoPreview();
                    this._toast('Logo updated', 'success');
                };
                reader.readAsDataURL(file);
            });
            this.panel.querySelector('#wbt-logo-clear').addEventListener('click', () => {
                Store.clearCustomLogo();
                const existing = document.querySelector('.wbt-retro-logo');
                if (existing) existing.remove();
                const logoLink = document.querySelector('ytd-topbar-logo-renderer a#logo');
                if (logoLink) logoLink.classList.remove('wbt-has-custom-logo');
                this._refreshLogoPreview();
                this._toast('Logo reset to default', 'success');
            });

            // Section toggles
            this.panel.querySelectorAll('.wbt-section-header').forEach(header => {
                header.addEventListener('click', () => {
                    const id = header.dataset.toggle;
                    const content = this.panel.querySelector(`#wbt-sec-${id}`);
                    const toggle = header.querySelector('.wbt-section-toggle');
                    const isOpen = content.classList.contains('open');
                    content.classList.toggle('open');
                    toggle.textContent = isOpen ? '\u25BC' : '\u25B2';

                    // Refresh content when opening
                    if (!isOpen) {
                        if (id === 'subs') this._refreshSubsList();
                        if (id === 'search') this._refreshTermsList();
                        if (id === 'cats') this._refreshCatsGrid();
                        if (id === 'topics') this._refreshTopicsList();
                        if (id === 'block') this._refreshBlockList();
                        if (id === 'learning') this._refreshLearningSection();
                        if (id === 'profiles') this._refreshProfileList();
                        if (id === 'stats') this._refreshStats();
                    }
                });
            });

            // Date input
            this.panel.querySelector('#wbt-date').addEventListener('change', (e) => {
                if (Store.isClockActive()) {
                    Store.startClock(e.target.value);
                } else {
                    Store.setDate(e.target.value);
                }
                this._toast('Date set to ' + e.target.value, 'success');
                this.dom.forceReload();
            });

            // Date presets
            this.panel.querySelectorAll('.wbt-preset-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    const years = parseInt(btn.dataset.years, 10);
                    const d = new Date();
                    d.setFullYear(d.getFullYear() - years);
                    const dateStr = d.toISOString().split('T')[0];
                    if (Store.isClockActive()) {
                        Store.startClock(dateStr);
                    } else {
                        Store.setDate(dateStr);
                    }
                    this.panel.querySelector('#wbt-date').value = dateStr;
                    this._toast(`Set to ${years} year${years > 1 ? 's' : ''} ago`, 'success');
                    this.dom.forceReload();
                });
            });

            // Clock toggle
            this.panel.querySelector('#wbt-clock-toggle').addEventListener('click', () => {
                if (Store.isClockActive()) {
                    Store.stopClock();
                    this.panel.querySelector('#wbt-clock-toggle').textContent = 'Start Clock';
                    this.panel.querySelector('#wbt-clock-display').style.display = 'none';
                    this.panel.querySelector('#wbt-date').value = Store.getDate();
                    this._toast('Clock stopped', 'success');
                } else {
                    const dateStr = Store.getDate();
                    if (!dateStr) {
                        this._toast('Set a date first', 'error');
                        return;
                    }
                    Store.startClock(dateStr);
                    this.panel.querySelector('#wbt-clock-toggle').textContent = 'Stop Clock';
                    this.panel.querySelector('#wbt-clock-display').style.display = 'block';
                    this._toast('Clock started — advancing in real time', 'success');
                    this.dom.forceReload();
                }
            });

            // Trending toggle
            this.panel.querySelector('#wbt-trending-toggle').addEventListener('click', () => {
                const nowEnabled = !Store.isDiscoveryEnabled();
                Store.setDiscoveryEnabled(nowEnabled);
                const btn = this.panel.querySelector('#wbt-trending-toggle');
                btn.textContent = nowEnabled ? 'ON' : 'OFF';
                btn.style.cssText = nowEnabled
                    ? 'background:#2a5a2a;color:#4caf50;min-width:40px;'
                    : 'background:#5a2a2a;color:#f44;min-width:40px;';
                this._toast(nowEnabled ? 'Trending enabled' : 'Trending disabled', 'success');
            });

            // Learning toggle
            this.panel.querySelector('#wbt-learn-toggle').addEventListener('click', () => {
                const nowEnabled = !Store.isLearningEnabled();
                Store.setLearningEnabled(nowEnabled);
                const btn = this.panel.querySelector('#wbt-learn-toggle');
                btn.textContent = nowEnabled ? 'ON' : 'OFF';
                btn.style.cssText = nowEnabled
                    ? 'background:#2a5a2a;color:#4caf50;min-width:40px;'
                    : 'background:#5a2a2a;color:#f44;min-width:40px;';
                this._toast(nowEnabled ? 'Learning enabled' : 'Learning disabled', 'success');
            });

            // Learning reset
            this.panel.querySelector('#wbt-learn-reset').addEventListener('click', () => {
                Store.clearLearningData();
                this._refreshLearningSection();
                this._toast('Learning data cleared', 'success');
            });

            // Add subscription
            this.panel.querySelector('#wbt-sub-add').addEventListener('click', () => this._addSubscription());
            this.panel.querySelector('#wbt-sub-input').addEventListener('keydown', (e) => {
                if (e.key === 'Enter') this._addSubscription();
            });

            // Add search term
            this.panel.querySelector('#wbt-term-add').addEventListener('click', () => this._addSearchTerm());
            this.panel.querySelector('#wbt-term-input').addEventListener('keydown', (e) => {
                if (e.key === 'Enter') this._addSearchTerm();
            });

            // Add topic
            this.panel.querySelector('#wbt-topic-add').addEventListener('click', () => this._addTopic());
            this.panel.querySelector('#wbt-topic-input').addEventListener('keydown', (e) => {
                if (e.key === 'Enter') this._addTopic();
            });

            // Block channel
            this.panel.querySelector('#wbt-block-add').addEventListener('click', () => this._addBlockedChannel());
            this.panel.querySelector('#wbt-block-input').addEventListener('keydown', (e) => {
                if (e.key === 'Enter') this._addBlockedChannel();
            });

            // Profiles
            this.panel.querySelector('#wbt-profile-save').addEventListener('click', () => {
                const input = this.panel.querySelector('#wbt-profile-name');
                const name = input.value.trim();
                if (!name) return;
                Store.saveProfile(name);
                input.value = '';
                this._refreshProfileList();
                this._toast(`Profile "${name}" saved`, 'success');
            });
            this.panel.querySelector('#wbt-profile-name').addEventListener('keydown', (e) => {
                if (e.key === 'Enter') this.panel.querySelector('#wbt-profile-save').click();
            });
            this.panel.querySelector('#wbt-profile-import').addEventListener('click', () => {
                this.panel.querySelector('#wbt-profile-file').click();
            });
            this.panel.querySelector('#wbt-profile-file').addEventListener('change', (e) => {
                const file = e.target.files[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = () => {
                    try {
                        const name = Store.importProfile(reader.result);
                        this._refreshProfileList();
                        this._toast(`Imported "${name}"`, 'success');
                    } catch (err) {
                        this._toast('Invalid profile file', 'error');
                    }
                };
                reader.readAsText(file);
                e.target.value = '';
            });
        }

        // --- Drag ---

        _attachDragHandler() {
            const handle = this.panel.querySelector('#wbt-drag-handle');
            let dragging = false, offsetX, offsetY;

            handle.addEventListener('mousedown', (e) => {
                if (e.target.tagName === 'BUTTON' || e.target.tagName === 'SPAN') return;
                dragging = true;
                offsetX = e.clientX - this.panel.getBoundingClientRect().left;
                offsetY = e.clientY - this.panel.getBoundingClientRect().top;
                e.preventDefault();
            });

            document.addEventListener('mousemove', (e) => {
                if (!dragging) return;
                this.panel.style.left = (e.clientX - offsetX) + 'px';
                this.panel.style.top = (e.clientY - offsetY) + 'px';
                this.panel.style.right = 'auto';
            });

            document.addEventListener('mouseup', () => { dragging = false; });
        }

        // --- Subscription management ---

        async _addSubscription() {
            const input = this.panel.querySelector('#wbt-sub-input');
            const val = input.value.trim();
            if (!val) return;

            input.disabled = true;
            const btn = this.panel.querySelector('#wbt-sub-add');
            btn.textContent = '...';

            try {
                const ch = await this.api.resolveChannel(val);
                if (!ch) {
                    this._toast('Channel not found', 'error');
                    return;
                }

                const subs = Store.getSubscriptions();
                if (subs.some(s => s.id === ch.id)) {
                    this._toast('Already subscribed', 'error');
                    return;
                }

                subs.push({ id: ch.id, name: ch.name, weight: 3 });
                Store.setSubscriptions(subs);
                input.value = '';
                this._refreshSubsList();
                this._toast(`Added ${ch.name}`, 'success');
            } catch (e) {
                this._toast('Error: ' + e.message, 'error');
            } finally {
                input.disabled = false;
                btn.textContent = 'Add';
            }
        }

        _refreshSubsList() {
            const list = this.panel.querySelector('#wbt-sub-list');
            if (!list) return;
            const subs = Store.getSubscriptions();
            _clear(list);

            if (!subs.length) {
                const empty = _el('div', null, 'No subscriptions');
                empty.style.cssText = 'color:#666;text-align:center;padding:8px;';
                list.appendChild(empty);
                return;
            }

            subs.forEach((sub, i) => {
                const item = document.createElement('div');
                item.className = 'wbt-list-item';

                const name = document.createElement('span');
                name.className = 'wbt-list-name';
                name.textContent = sub.name;

                const weightCtrl = _el('div', 'wbt-weight-ctrl');
                const wDown = _el('button', 'wbt-weight-btn', '-');
                const wLabel = _el('span', 'wbt-weight-label', String(sub.weight || 3));
                const wUp = _el('button', 'wbt-weight-btn', '+');
                wDown.addEventListener('click', () => {
                    const s = Store.getSubscriptions();
                    s[i].weight = Math.max(1, (s[i].weight || 3) - 1);
                    Store.setSubscriptions(s);
                    this._refreshSubsList();
                });
                wUp.addEventListener('click', () => {
                    const s = Store.getSubscriptions();
                    s[i].weight = Math.min(5, (s[i].weight || 3) + 1);
                    Store.setSubscriptions(s);
                    this._refreshSubsList();
                });
                weightCtrl.appendChild(wDown);
                weightCtrl.appendChild(wLabel);
                weightCtrl.appendChild(wUp);

                const btn = document.createElement('button');
                btn.className = 'wbt-list-remove';
                btn.textContent = 'X';
                btn.addEventListener('click', () => {
                    const s = Store.getSubscriptions();
                    s.splice(i, 1);
                    Store.setSubscriptions(s);
                    this._refreshSubsList();
                });

                item.appendChild(name);
                item.appendChild(weightCtrl);
                item.appendChild(btn);
                list.appendChild(item);
            });
        }

        // --- Search term management ---

        _addSearchTerm() {
            const input = this.panel.querySelector('#wbt-term-input');
            const val = input.value.trim().toLowerCase();
            if (!val) return;

            const terms = Store.getSearchTerms();
            const names = terms.map(t => (typeof t === 'string' ? t : t.term).toLowerCase());
            if (names.includes(val)) {
                this._toast('Term already exists', 'error');
                return;
            }

            terms.push({ term: val, weight: 3 });
            Store.setSearchTerms(terms);
            input.value = '';
            this._refreshTermsList();
            this._toast(`Added "${val}"`, 'success');
        }

        _refreshTermsList() {
            const list = this.panel.querySelector('#wbt-term-list');
            if (!list) return;
            const terms = Store.getSearchTerms();
            _clear(list);

            if (!terms.length) {
                const empty = _el('div', null, 'No search terms');
                empty.style.cssText = 'color:#666;text-align:center;padding:8px;';
                list.appendChild(empty);
                return;
            }

            terms.forEach((rawTerm, i) => {
                if (!rawTerm) return;
                const term = typeof rawTerm === 'string' ? { term: rawTerm, weight: 3 } : rawTerm;
                if (!term.term) return;
                const item = document.createElement('div');
                item.className = 'wbt-list-item';

                const name = document.createElement('span');
                name.className = 'wbt-list-name';
                name.textContent = term.term;

                const weightCtrl = _el('div', 'wbt-weight-ctrl');
                const wDown = _el('button', 'wbt-weight-btn', '-');
                const wLabel = _el('span', 'wbt-weight-label', String(term.weight || 3));
                const wUp = _el('button', 'wbt-weight-btn', '+');
                wDown.addEventListener('click', () => {
                    const t = Store.getSearchTerms();
                    if (typeof t[i] === 'string') t[i] = { term: t[i], weight: 3 };
                    t[i].weight = Math.max(1, (t[i].weight || 3) - 1);
                    Store.setSearchTerms(t);
                    this._refreshTermsList();
                });
                wUp.addEventListener('click', () => {
                    const t = Store.getSearchTerms();
                    if (typeof t[i] === 'string') t[i] = { term: t[i], weight: 3 };
                    t[i].weight = Math.min(5, (t[i].weight || 3) + 1);
                    Store.setSearchTerms(t);
                    this._refreshTermsList();
                });
                weightCtrl.appendChild(wDown);
                weightCtrl.appendChild(wLabel);
                weightCtrl.appendChild(wUp);

                const btn = document.createElement('button');
                btn.className = 'wbt-list-remove';
                btn.textContent = 'X';
                btn.addEventListener('click', () => {
                    const t = Store.getSearchTerms();
                    t.splice(i, 1);
                    Store.setSearchTerms(t);
                    this._refreshTermsList();
                });

                item.appendChild(name);
                item.appendChild(weightCtrl);
                item.appendChild(btn);
                list.appendChild(item);
            });
        }

        // --- Category management ---

        _refreshCatsGrid() {
            const grid = this.panel.querySelector('#wbt-cat-grid');
            if (!grid) return;
            const selected = Store.getCategories();
            _clear(grid);

            for (const [id, name] of Object.entries(CONFIG.categories)) {
                const label = document.createElement('label');
                label.className = 'wbt-cat-label';

                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.checked = selected.includes(parseInt(id, 10));
                cb.addEventListener('change', () => {
                    const cats = Store.getCategories();
                    const numId = parseInt(id, 10);
                    if (cb.checked) {
                        if (!cats.includes(numId)) cats.push(numId);
                    } else {
                        const idx = cats.indexOf(numId);
                        if (idx !== -1) cats.splice(idx, 1);
                    }
                    Store.setCategories(cats);
                });

                label.appendChild(cb);
                label.appendChild(document.createTextNode(name));
                grid.appendChild(label);
            }
        }

        // --- Topic management ---

        _addTopic() {
            const input = this.panel.querySelector('#wbt-topic-input');
            const val = input.value.trim();
            if (!val) return;

            const topics = Store.getTopics();
            const names = topics.map(t => (typeof t === 'string' ? t : t.name).toLowerCase());
            if (names.includes(val.toLowerCase())) {
                this._toast('Topic already exists', 'error');
                return;
            }

            topics.push({ name: val, weight: 3 });
            Store.setTopics(topics);
            input.value = '';
            this._refreshTopicsList();
            this._toast(`Added topic "${val}"`, 'success');
        }

        _refreshTopicsList() {
            const list = this.panel.querySelector('#wbt-topic-list');
            if (!list) return;
            const topics = Store.getTopics();
            _clear(list);

            if (!topics.length) {
                const empty = _el('div', null, 'No topics');
                empty.style.cssText = 'color:#666;text-align:center;padding:8px;';
                list.appendChild(empty);
                return;
            }

            topics.forEach((rawTopic, i) => {
                const topic = typeof rawTopic === 'string' ? { name: rawTopic, weight: 3 } : rawTopic;
                const item = document.createElement('div');
                item.className = 'wbt-list-item';

                const name = document.createElement('span');
                name.className = 'wbt-list-name';
                name.textContent = topic.name;

                const weightCtrl = _el('div', 'wbt-weight-ctrl');
                const wDown = _el('button', 'wbt-weight-btn', '-');
                const wLabel = _el('span', 'wbt-weight-label', String(topic.weight || 3));
                const wUp = _el('button', 'wbt-weight-btn', '+');
                wDown.addEventListener('click', () => {
                    const t = Store.getTopics();
                    if (typeof t[i] === 'string') t[i] = { name: t[i], weight: 3 };
                    t[i].weight = Math.max(1, (t[i].weight || 3) - 1);
                    Store.setTopics(t);
                    this._refreshTopicsList();
                });
                wUp.addEventListener('click', () => {
                    const t = Store.getTopics();
                    if (typeof t[i] === 'string') t[i] = { name: t[i], weight: 3 };
                    t[i].weight = Math.min(5, (t[i].weight || 3) + 1);
                    Store.setTopics(t);
                    this._refreshTopicsList();
                });
                weightCtrl.appendChild(wDown);
                weightCtrl.appendChild(wLabel);
                weightCtrl.appendChild(wUp);

                const btn = document.createElement('button');
                btn.className = 'wbt-list-remove';
                btn.textContent = 'X';
                btn.addEventListener('click', () => {
                    const t = Store.getTopics();
                    t.splice(i, 1);
                    Store.setTopics(t);
                    this._refreshTopicsList();
                });

                item.appendChild(name);
                item.appendChild(btn);
                list.appendChild(item);
            });
        }

        // --- Blocked channel management ---

        async _addBlockedChannel() {
            const input = this.panel.querySelector('#wbt-block-input');
            const val = input.value.trim();
            if (!val) return;

            input.disabled = true;
            const btn = this.panel.querySelector('#wbt-block-add');
            btn.textContent = '...';

            try {
                const ch = await this.api.resolveChannel(val);
                const entry = ch
                    ? { id: ch.id, name: ch.name }
                    : { id: '', name: val }; // allow blocking by name even if unresolved

                const blocked = Store.getBlockedChannels();
                if (blocked.some(b => b.name.toLowerCase() === entry.name.toLowerCase())) {
                    this._toast('Already blocked', 'error');
                    return;
                }

                blocked.push(entry);
                Store.setBlockedChannels(blocked);
                input.value = '';
                this._refreshBlockList();
                this._toast(`Blocked ${entry.name}`, 'success');
            } catch (e) {
                // Still add by name even if resolve fails
                const blocked = Store.getBlockedChannels();
                if (blocked.some(b => b.name.toLowerCase() === val.toLowerCase())) {
                    this._toast('Already blocked', 'error');
                    return;
                }
                blocked.push({ id: '', name: val });
                Store.setBlockedChannels(blocked);
                input.value = '';
                this._refreshBlockList();
                this._toast(`Blocked ${val}`, 'success');
            } finally {
                input.disabled = false;
                btn.textContent = 'Block';
            }
        }

        _refreshBlockList() {
            const list = this.panel.querySelector('#wbt-block-list');
            if (!list) return;
            const blocked = Store.getBlockedChannels();
            _clear(list);

            if (!blocked.length) {
                const empty = _el('div', null, 'No blocked channels');
                empty.style.cssText = 'color:#666;text-align:center;padding:8px;';
                list.appendChild(empty);
                return;
            }

            blocked.forEach((ch, i) => {
                const item = document.createElement('div');
                item.className = 'wbt-list-item';

                const name = document.createElement('span');
                name.className = 'wbt-list-name';
                name.textContent = ch.name;

                const btn = document.createElement('button');
                btn.className = 'wbt-list-remove';
                btn.textContent = 'X';
                btn.addEventListener('click', () => {
                    const b = Store.getBlockedChannels();
                    b.splice(i, 1);
                    Store.setBlockedChannels(b);
                    this._refreshBlockList();
                });

                item.appendChild(name);
                item.appendChild(btn);
                list.appendChild(item);
            });
        }

        // --- Profiles ---

        _refreshProfileList() {
            const list = this.panel.querySelector('#wbt-profile-list');
            if (!list) return;
            const profiles = Store.getProfiles();
            const names = Object.keys(profiles);
            _clear(list);

            if (!names.length) {
                const empty = _el('div', null, 'No saved profiles');
                empty.style.cssText = 'color:#666;text-align:center;padding:8px;';
                list.appendChild(empty);
                return;
            }

            for (const name of names) {
                const p = profiles[name];
                const item = _el('div', 'wbt-list-item');

                const label = _el('span', 'wbt-list-name');
                label.textContent = `${name} (${p.date || '?'})`;

                const btns = _el('div', 'wbt-profile-btns');

                const loadBtn = _el('button', 'wbt-profile-action-btn', 'Load');
                loadBtn.addEventListener('click', () => {
                    Store.loadProfile(name);
                    this.panel.querySelector('#wbt-date').value = Store.getDate() || '';
                    this._refreshAllLists();
                    this._refreshLogoPreview();
                    const existing = document.querySelector('.wbt-retro-logo');
                    if (existing) existing.remove();
                    this.dom.forceReload();
                    this._toast(`Loaded "${name}"`, 'success');
                });

                const exportBtn = _el('button', 'wbt-profile-action-btn', 'Export');
                exportBtn.addEventListener('click', () => {
                    const json = Store.exportProfile(name);
                    if (!json) return;
                    const blob = new Blob([json], { type: 'application/json' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = `iw2gb_${name}.json`;
                    a.click();
                    URL.revokeObjectURL(url);
                    this._toast(`Exported "${name}"`, 'success');
                });

                const delBtn = _el('button', 'wbt-list-remove', 'X');
                delBtn.addEventListener('click', () => {
                    Store.deleteProfile(name);
                    this._refreshProfileList();
                    this._toast(`Deleted "${name}"`, 'success');
                });

                btns.appendChild(loadBtn);
                btns.appendChild(exportBtn);
                btns.appendChild(delBtn);
                item.appendChild(label);
                item.appendChild(btns);
                list.appendChild(item);
            }
        }

        // --- Learning stats ---

        _refreshLearningSection() {
            const container = this.panel.querySelector('#wbt-learn-stats');
            if (!container) return;
            _clear(container);

            const history = Store.getWatchHistory();
            const interests = history.length ? Store.getCachedInterests() : null;
            const channels = interests ? InterestModel.getLearnedChannels(interests) : [];
            const keywords = interests ? InterestModel.getLearnedKeywords(interests) : [];

            container.style.cssText = 'margin-top:6px;font-size:11px;color:#aaa;line-height:1.5;';

            const watchLine = _el('div', null, `${history.length} watches tracked`);
            container.appendChild(watchLine);

            if (channels.length) {
                const chTitle = _el('div', null, 'Learned channels:');
                chTitle.style.cssText = 'color:#ccc;margin-top:4px;';
                container.appendChild(chTitle);
                for (const ch of channels.slice(0, 5)) {
                    const line = _el('div', null, `  ${ch.name} (${ch.score.toFixed(1)})`);
                    line.style.cssText = 'color:#888;padding-left:8px;';
                    container.appendChild(line);
                }
            }

            if (keywords.length) {
                const kwTitle = _el('div', null, 'Learned keywords:');
                kwTitle.style.cssText = 'color:#ccc;margin-top:4px;';
                container.appendChild(kwTitle);
                for (const kw of keywords.slice(0, 5)) {
                    const line = _el('div', null, `  "${kw.keyword}" (${kw.score.toFixed(1)})`);
                    line.style.cssText = 'color:#888;padding-left:8px;';
                    container.appendChild(line);
                }
            }

            if (!channels.length && !keywords.length && history.length) {
                const hint = _el('div', null, 'Watch more videos to build up interests');
                hint.style.cssText = 'color:#666;font-style:italic;';
                container.appendChild(hint);
            }
        }

        // --- Stats ---

        _refreshStats() {
            const grid = this.panel.querySelector('#wbt-stats');
            if (!grid) return;
            _clear(grid);

            const stats = {
                'Date': Store.getDate() || 'Not set',
                'Subscriptions': String(Store.getSubscriptions().length),
                'Search Terms': String(Store.getSearchTerms().length),
                'Categories': String(Store.getCategories().length),
                'Topics': String(Store.getTopics().length),
                'Blocked': String(Store.getBlockedChannels().length),
            };

            for (const [label, value] of Object.entries(stats)) {
                const row = _el('div', 'wbt-stat', [
                    _el('span', 'wbt-stat-label', label),
                    _el('span', 'wbt-stat-value', value),
                ]);
                grid.appendChild(row);
            }
        }

        // --- Logo preview ---

        _refreshLogoPreview() {
            const preview = this.panel.querySelector('#wbt-logo-preview');
            if (!preview) return;
            _clear(preview);
            const currentLogo = Store.getCustomLogo();
            if (currentLogo) {
                const img = document.createElement('img');
                img.src = currentLogo;
                preview.appendChild(img);
                preview.style.cssText = '';
            } else {
                preview.appendChild(_el('span', null, 'Default (YouTube text)'));
                preview.style.cssText = 'color:#666;font-size:11px;';
            }
        }

        // --- Refresh all ---

        _refreshAllLists() {
            try { this._refreshSubsList(); } catch (e) { console.error('[iw2gb] Subs list error:', e); }
            try { this._refreshTermsList(); } catch (e) { console.error('[iw2gb] Terms list error:', e); }
            try { this._refreshCatsGrid(); } catch (e) { console.error('[iw2gb] Cats grid error:', e); }
            try { this._refreshTopicsList(); } catch (e) { console.error('[iw2gb] Topics list error:', e); }
            try { this._refreshBlockList(); } catch (e) { console.error('[iw2gb] Block list error:', e); }
            try { this._refreshProfileList(); } catch (e) { console.error('[iw2gb] Profile list error:', e); }
            try { this._refreshStats(); } catch (e) { console.error('[iw2gb] Stats error:', e); }
        }

        // --- Toast ---

        _toast(msg, type = 'success') {
            const existing = document.querySelector('.wbt-toast');
            if (existing) existing.remove();

            const toast = document.createElement('div');
            toast.className = `wbt-toast ${type}`;
            toast.textContent = msg;
            document.body.appendChild(toast);

            requestAnimationFrame(() => toast.classList.add('show'));
            setTimeout(() => {
                toast.classList.remove('show');
                setTimeout(() => toast.remove(), 300);
            }, 2500);
        }
    }

    // =========================================================================
    // 9. APP  –  orchestrator
    // =========================================================================

    class App {
        static async init() {
            console.log('[iw2gb] Initializing v126...');

            // Validate time offset isn't insane (max 24h drift)
            const offset = Store.getTimeOffset();
            if (Math.abs(offset) > 86400000) {
                console.warn('[iw2gb] Time offset was insane (' + offset + 'ms), resetting to 0');
                Store.setTimeOffset(0);
            }

            // Clear ALL caches on version upgrade (prevents stale data from broken versions)
            const lastVersion = Store._get('wbt_last_version', 0);
            if (lastVersion < 119) {
                console.log('[iw2gb] Version upgrade detected, clearing all caches...');
                try {
                    const allKeys = GM_listValues();
                    for (const key of allKeys) {
                        if (key.startsWith('wbt_cache_')) GM_deleteValue(key);
                    }
                } catch (e) {
                    console.warn('[iw2gb] Cache clear failed:', e);
                }
                Store._set('wbt_last_version', 119);
            }

            // Sync clock with external time source (non-blocking)
            App._syncTime();

            // Wait for YouTube's app shell to be ready
            await App._waitForReady();

            // Inject theme
            ThemeEngine.inject();

            // Initialize modules
            const api = new YouTubeAPI();
            const feedEngine = new FeedEngine(api);
            const domController = new DOMController(feedEngine);
            const uiPanel = new UIPanel(api, domController);

            // Start DOM controller (navigation detection + nuking)
            domController.init();

            // Build UI panel
            uiPanel.init();

            // Re-inject panel/fab if YouTube nukes them (SPA navigation can destroy elements)
            setInterval(() => {
                if (!document.getElementById('wbt-panel') && !document.getElementById('wbt-fab')) {
                    console.log('[iw2gb] Panel was removed, re-injecting...');
                    uiPanel.init();
                }
            }, 2000);

            // Set default date if none set
            if (!Store.getDate()) {
                const d = new Date();
                d.setFullYear(d.getFullYear() - 5);
                Store.setDate(d.toISOString().split('T')[0]);
            }

            console.log('[iw2gb] v126 Ready. Date:', Store.getCurrentDate(),
                '| Active:', Store.isActive(), '| Clock:', Store.isClockActive(),
                '| TimeOffset:', Store.getTimeOffset());
        }

        // Sync with external time source to handle PC being off
        static _syncTime() {
            try {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url: 'https://worldtimeapi.org/api/ip',
                    timeout: 5000,
                    onload(res) {
                        try {
                            const data = JSON.parse(res.responseText);
                            if (!data || !data.unixtime) return;
                            const serverTime = data.unixtime * 1000;
                            const drift = serverTime - Date.now();
                            // Cap drift at 24 hours — anything beyond is likely garbage
                            if (Math.abs(drift) > 86400000) {
                                console.warn('[iw2gb] Time API returned suspicious drift, ignoring');
                                return;
                            }
                            Store.setTimeOffset(Math.abs(drift) > 30000 ? drift : 0);
                            if (Math.abs(drift) > 30000) {
                                console.log(`[iw2gb] Clock drift corrected: ${Math.round(drift / 1000)}s`);
                            }
                        } catch { /* ignore parse errors */ }
                    },
                    onerror() { /* silent fail — local clock is fine */ },
                    ontimeout() { /* silent fail */ },
                });
            } catch { /* GM_xmlhttpRequest not available in this context */ }
        }

        static _waitForReady() {
            return new Promise(resolve => {
                const check = () => {
                    // Wait for YouTube's SPA shell — ytd-app is the real signal
                    if (document.body && document.querySelector('ytd-app')) {
                        resolve();
                    } else {
                        setTimeout(check, 200);
                    }
                };

                if (document.readyState === 'loading') {
                    document.addEventListener('DOMContentLoaded', check, { once: true });
                } else {
                    check();
                }
            });
        }
    }

    // =========================================================================
    // ENTRY POINT
    // =========================================================================

    App.init();

})();
