// ==UserScript==
// @name         WayBackTube
// @namespace    http://tampermonkey.net/
// @license      MIT
// @version      113
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
// @connect      *
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
            maxRecommendations: 20,
            initialBatchSize: 16,
            loadMoreSize: 12,
            weights: {
                subscriptions: 0.40,
                searchTerms: 0.20,
                categories: 0.25,
                topics: 0.15,
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

        // --- Active state ---
        static isActive()           { return this._get('wbt_active', this._get('ytActive', true)); }
        static setActive(v)         { this._set('wbt_active', v); }

        // --- Minimized state ---
        static isMinimized()        { return this._get('wbt_minimized', false); }
        static setMinimized(v)      { this._set('wbt_minimized', v); }

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
        static relativeToDate(publishDate, referenceDate) {
            const diffMs = new Date(referenceDate).getTime() - new Date(publishDate).getTime();
            if (diffMs < 0) return 'just now';

            const days = Math.floor(diffMs / 86400000);
            const years = Math.floor(days / 365.25);
            const months = Math.floor(days / 30.44);
            const weeks = Math.floor(days / 7);
            const hours = Math.floor(diffMs / 3600000);
            const minutes = Math.floor(diffMs / 60000);

            if (years >= 1)   return years === 1 ? '1 year ago' : `${years} years ago`;
            if (months >= 1)  return months === 1 ? '1 month ago' : `${months} months ago`;
            if (weeks >= 1)   return weeks === 1 ? '1 week ago' : `${weeks} weeks ago`;
            if (days >= 1)    return days === 1 ? '1 day ago' : `${days} days ago`;
            if (hours >= 1)   return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
            if (minutes >= 1) return minutes === 1 ? '1 minute ago' : `${minutes} minutes ago`;
            return 'just now';
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

        // For WBT feed cards: InnerTube's coarse "X years ago" text has no
        // sub-year precision, so videos near the set date all resolve to
        // "just now". Instead, use the real recalculation when it produces a
        // meaningful result (> 1 month), and fall back to a deterministic
        // hash-based spread (1 day – 3 weeks) for near-zero diffs.
        static recalcForFeed(innertubeText, setDateStr, videoId) {
            if (!setDateStr || !innertubeText) return innertubeText || '';
            const pub = this.approxPublishDate(innertubeText);
            if (!pub) return innertubeText;

            const prefix = /^Streamed\s+/i.test(innertubeText) ? 'Streamed ' : '';
            const real = this.relativeToDate(pub, setDateStr);

            // If recalculation gives a meaningful result (≥ 1 month), use it
            if (real !== 'just now' && !real.endsWith('days ago') && !real.endsWith('day ago')
                && !real.endsWith('weeks ago') && !real.endsWith('week ago')
                && !real.endsWith('hours ago') && !real.endsWith('hour ago')
                && !real.endsWith('minutes ago') && !real.endsWith('minute ago')) {
                // It's months or years — precision is fine
                return prefix + real;
            }

            // If we got a real result with day/week precision, use it directly
            if (real !== 'just now') {
                return prefix + real;
            }

            // Near-zero diff: InnerTube's year-level granularity can't
            // distinguish dates within the same period. Use videoId hash
            // to produce a realistic spread for the feed.
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
        }

        // --- InnerTube config ---

        _getConfig() {
            try {
                const win = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
                const cfg = win.ytcfg?.data_;
                if (cfg) {
                    return {
                        clientName: cfg.INNERTUBE_CLIENT_NAME || 'WEB',
                        clientVersion: cfg.INNERTUBE_CLIENT_VERSION || '2.20241001.00.00',
                        apiKey: cfg.INNERTUBE_API_KEY || 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8',
                        hl: cfg.HL || 'en',
                        gl: cfg.GL || 'US',
                    };
                }
            } catch { /* fallback */ }
            return {
                clientName: 'WEB',
                clientVersion: '2.20241001.00.00',
                apiKey: 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8',
                hl: 'en',
                gl: 'US',
            };
        }

        // --- Core InnerTube POST ---

        async _post(endpoint, body) {
            await this._rateLimit();

            const cfg = this._getConfig();
            const url = `https://www.youtube.com/youtubei/v1/${endpoint}?key=${cfg.apiKey}&prettyPrint=false`;

            const fullBody = {
                context: {
                    client: {
                        clientName: cfg.clientName,
                        clientVersion: cfg.clientVersion,
                        hl: cfg.hl,
                        gl: cfg.gl,
                    },
                },
                ...body,
            };

            return new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: 'POST',
                    url,
                    headers: { 'Content-Type': 'application/json' },
                    data: JSON.stringify(fullBody),
                    onload(res) {
                        if (res.status >= 200 && res.status < 300) {
                            try { resolve(JSON.parse(res.responseText)); }
                            catch { reject(new Error('Invalid JSON')); }
                        } else {
                            reject(new Error(`InnerTube HTTP ${res.status}`));
                        }
                    },
                    onerror() { reject(new Error('Network error')); },
                    ontimeout() { reject(new Error('Timeout')); },
                });
            });
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
                console.warn('[WayBackTube] Parse error:', e.message);
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

        async getChannelVideos(channelName, { publishedAfter, publishedBefore, maxResults, order = 'date' } = {}) {
            const q = this._buildDateQuery(`"${channelName}"`, publishedAfter, publishedBefore);
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
                order: 'viewCount',
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

        // --- Deduplication ---

        _dedupe(videos) {
            const seen = new Set();
            return videos.filter(v => {
                if (!v || seen.has(v.id)) return false;
                seen.add(v.id);
                return true;
            });
        }

        // --- Weighted shuffle: bias toward videos closer to center date ---

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
                const weight = 1 / daysDiff;
                return { v, sort: Math.random() * weight };
            });
            weighted.sort((a, b) => b.sort - a.sort);
            return weighted.map(w => w.v);
        }

        // --- Fetch from each source ---

        async _fetchSubscriptions(dateWindow, count) {
            const subs = Store.getSubscriptions();
            if (!subs.length) return [];

            const cacheKey = `subs_${dateWindow.center.toDateString()}`;
            const cached = Store.getCacheEntry(cacheKey);
            if (cached) return cached;

            const perChannel = Math.max(5, Math.ceil(count / subs.length));
            const batches = await Promise.allSettled(
                subs.map(sub =>
                    this.api.getChannelVideos(sub.name, {
                        publishedAfter: dateWindow.after,
                        publishedBefore: dateWindow.before,
                        maxResults: perChannel,
                        order: 'date',
                    })
                )
            );

            const videos = batches
                .filter(r => r.status === 'fulfilled')
                .flatMap(r => r.value);

            if (videos.length) Store.setCacheEntry(cacheKey, videos);
            return videos;
        }

        async _fetchSearchTerms(dateWindow, count) {
            const terms = Store.getSearchTerms();
            if (!terms.length) return [];

            const cacheKey = `search_${dateWindow.center.toDateString()}`;
            const cached = Store.getCacheEntry(cacheKey);
            if (cached) return cached;

            const perTerm = Math.max(5, Math.ceil(count / terms.length));
            const batches = await Promise.allSettled(
                terms.map(term =>
                    this.api.searchVideos(term, {
                        publishedAfter: dateWindow.after,
                        publishedBefore: dateWindow.before,
                        maxResults: perTerm,
                        order: 'relevance',
                    })
                )
            );

            const videos = batches
                .filter(r => r.status === 'fulfilled')
                .flatMap(r => r.value);

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

            const videos = batches
                .filter(r => r.status === 'fulfilled')
                .flatMap(r => r.value);

            if (videos.length) Store.setCacheEntry(cacheKey, videos);
            return videos;
        }

        async _fetchTopics(dateWindow, count) {
            const topics = Store.getTopics();
            if (!topics.length) return [];

            const cacheKey = `topics_${dateWindow.center.toDateString()}`;
            const cached = Store.getCacheEntry(cacheKey);
            if (cached) return cached;

            const perTopic = Math.max(5, Math.ceil(count / topics.length));
            const batches = await Promise.allSettled(
                topics.map(topic =>
                    this.api.searchVideos(topic, {
                        publishedAfter: dateWindow.after,
                        publishedBefore: dateWindow.before,
                        maxResults: perTopic,
                        order: 'viewCount',
                    })
                )
            );

            const videos = batches
                .filter(r => r.status === 'fulfilled')
                .flatMap(r => r.value);

            if (videos.length) Store.setCacheEntry(cacheKey, videos);
            return videos;
        }

        // --- Mix sources with configured weights ---

        _mixSources(sources) {
            // sources: { subscriptions, searchTerms, categories, topics }
            const w = CONFIG.feed.weights;
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
            const dateWindow = this._dateWindow(selectedDate);
            const total = CONFIG.feed.maxHomepageVideos;

            // Fetch all 4 sources in parallel (per-source caches still speed this up)
            const [subscriptions, searchTerms, categories, topics] = await Promise.all([
                this._fetchSubscriptions(dateWindow, Math.round(total * CONFIG.feed.weights.subscriptions * 2)),
                this._fetchSearchTerms(dateWindow, Math.round(total * CONFIG.feed.weights.searchTerms * 2)),
                this._fetchCategories(dateWindow, Math.round(total * CONFIG.feed.weights.categories * 2)),
                this._fetchTopics(dateWindow, Math.round(total * CONFIG.feed.weights.topics * 2)),
            ]);

            // Mix and deduplicate
            const mixed = this._mixSources({ subscriptions, searchTerms, categories, topics });
            const deduped = this._dedupe(mixed);

            // Deprioritize recently seen videos so refreshes show new content
            const seen = new Set(Store.getSeenIds());
            const unseen = deduped.filter(v => !seen.has(v.id));
            const seenVids = deduped.filter(v => seen.has(v.id));

            return [
                ...this._weightedShuffle(unseen, dateWindow.center),
                ...this._weightedShuffle(seenVids, dateWindow.center),
            ];
        }

        async buildRecommendations(currentVideoId, selectedDate) {
            const dateWindow = this._dateWindow(selectedDate);
            const count = CONFIG.feed.maxRecommendations;

            const cacheKey = `rec_${currentVideoId}_${dateWindow.center.toDateString()}`;
            const cached = Store.getCacheEntry(cacheKey);
            if (cached) return cached;

            try {
                // Get current video details for context
                const details = await this.api.getVideoDetails([currentVideoId]);
                if (!details.length) return [];

                const current = details[0];
                const channelName = current.channel || '';
                const title = current.title || '';
                const keywords = this._extractKeywords(title);

                // 60% same channel, 40% keyword-based from other channels
                const sameCount = Math.floor(count * 0.6);
                const keywordCount = count - sameCount;

                const [sameChannel, keywordVideos] = await Promise.all([
                    channelName ? this.api.getChannelVideos(channelName, {
                        publishedAfter: dateWindow.after,
                        publishedBefore: dateWindow.before,
                        maxResults: sameCount * 2,
                        order: 'date',
                    }) : Promise.resolve([]),
                    keywords.length ? this._searchKeywords(keywords, dateWindow, keywordCount, current.channelId) : Promise.resolve([]),
                ]);

                const combined = [
                    ...sameChannel.slice(0, sameCount),
                    ...keywordVideos,
                ];

                const deduped = this._dedupe(combined).filter(v => v.id !== currentVideoId).slice(0, count);

                if (deduped.length) Store.setCacheEntry(cacheKey, deduped);
                return deduped;
            } catch (e) {
                console.warn('[WayBackTube] Recommendations error:', e.message);
                return [];
            }
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
            this._lastUrl = '';
            this._nukeInterval = null;
            this._observer = null;
            this._pendingSearchClean = null;
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
            this._pendingSearchClean = null;

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
                const link = el.querySelector('a[href="/shorts"]');
                if (link) {
                    el.style.display = 'none';
                    el.dataset.wbtHidden = '1';
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

                // Show initial batch
                this.displayedIndex = 0;
                const initialBatch = this._showMoreVideos(videoGrid, CONFIG.feed.initialBatchSize);

                // Load more button
                if (this.displayedIndex < this.allVideos.length) {
                    const loadMore = VideoRenderer.loadMoreButton(() => {
                        const moreBatch = this._showMoreVideos(videoGrid, CONFIG.feed.loadMoreSize);
                        this._enrichCardDates(moreBatch); // fetch real dates for new batch
                        if (this.displayedIndex >= this.allVideos.length) {
                            loadMore.style.display = 'none';
                        }
                    });
                    container.appendChild(loadMore);
                }

                this._homepageReplaced = true;
                this._homepageLoading = false;
                Store.setLastRefresh(Date.now());

                // Track displayed video IDs so next refresh shows different ones
                Store.addSeenIds(this.allVideos.map(v => v.id));

                // Progressively fetch real publish dates in the background
                this._enrichCardDates(initialBatch);
            } catch (e) {
                console.error('[WayBackTube] Homepage load error:', e);
                // Verify container still exists before updating it
                if (document.body.contains(container)) {
                    _clear(container);
                    container.appendChild(VideoRenderer.errorMessage(e.message));
                }
                this._homepageLoading = false;
                // Don't set _homepageReplaced — allow retry
            }
        }

        _showMoreVideos(grid, count) {
            const batch = this.allVideos.slice(this.displayedIndex, this.displayedIndex + count);
            for (const video of batch) {
                grid.appendChild(VideoRenderer.homepageCard(video));
            }
            this.displayedIndex += batch.length;
            return batch;
        }

        async _refreshHomepage() {
            this._homepageReplaced = false;
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

                for (const video of recommendations) {
                    container.appendChild(VideoRenderer.sidebarCard(video));
                }

                this._sidebarReplaced = true;
                this._sidebarLoading = false;
            } catch (e) {
                console.warn('[WayBackTube] Sidebar error:', e.message);
                if (document.body.contains(container)) {
                    _clear(container);
                }
                this._sidebarLoading = false;
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
            for (const sel of ['.wbt-container', '.wbt-sidebar-container', '.wbt-channel-container']) {
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
                this._cleanSearchDisplay(query);
                return;
            }

            params.set('search_query', `${query} before:${dateStr}`.trim());
            window.location.replace(`/results?${params.toString()}`);
        }

        _cleanSearchDisplay(fullQuery) {
            const clean = fullQuery.replace(/\s*before:\d{4}-\d{2}-\d{2}/g, '').trim();
            this._pendingSearchClean = clean;

            const params = new URLSearchParams(location.search);
            params.set('search_query', clean);
            const cleanUrl = `${location.pathname}?${params.toString()}`;
            history.replaceState(null, '', cleanUrl);

            const input = document.querySelector('input#search');
            if (input && input.value !== clean) {
                input.value = clean;
            }
        }

        _ensureRetroLogo() {
            const logoLink = document.querySelector('ytd-topbar-logo-renderer a#logo');
            if (!logoLink || logoLink.querySelector('.wbt-retro-logo')) return;

            const style = window.getComputedStyle(logoLink, '::before');
            if (style && style.content && style.content !== 'none' && style.content !== '""') return;

            const logo = document.createElement('span');
            logo.className = 'wbt-retro-logo';
            logo.style.cssText = 'display:flex;align-items:center;font-family:Arial,Helvetica,sans-serif;font-size:20px;font-weight:bold;';

            const you = document.createElement('span');
            you.textContent = 'You';
            you.className = 'wbt-logo-you';

            const tube = document.createElement('span');
            tube.textContent = 'Tube';
            tube.style.cssText = 'color:#fff;background:#cc0000;border-radius:4px;padding:2px 6px;margin-left:1px;';

            logo.appendChild(you);
            logo.appendChild(tube);
            logoLink.appendChild(logo);
        }

        // --- Channel page replacement ---

        async _tryReplaceChannelPage() {
            if (this._channelReplaced || this._channelLoading) return;

            const grid = document.querySelector(
                'ytd-browse[page-subtype="channels"] ytd-rich-grid-renderer #contents,' +
                'ytd-browse[page-subtype="channels"] ytd-section-list-renderer #contents,' +
                'ytd-browse[page-subtype="channels"] #contents.ytd-rich-grid-renderer'
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
                '#channel-header ytd-channel-name yt-formatted-string'
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
                const videos = await this.feedEngine.api.getChannelVideos(channelName, {
                    publishedBefore: dateStr,
                    maxResults: 50,
                    order: 'date',
                });

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
                }
                container.appendChild(videoGrid);

                this._channelReplaced = true;
                this._channelLoading = false;
            } catch (e) {
                console.warn('[WayBackTube] Channel page error:', e.message);
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

            const comments = document.querySelectorAll(
                'ytd-comment-thread-renderer:not([data-wbt-comment-checked]),' +
                'ytd-comment-renderer:not([data-wbt-comment-checked])'
            );

            for (const comment of comments) {
                comment.setAttribute('data-wbt-comment-checked', '1');

                const timeEl = comment.querySelector(
                    '#published-time-text a,' +
                    '#published-time-text yt-formatted-string,' +
                    'yt-formatted-string.published-time-text a,' +
                    '.published-time-text a'
                );
                if (!timeEl) continue;

                const rawText = timeEl.textContent.trim();
                const cleanText = rawText.replace(/\s*\(edited\)\s*$/, '');
                const approxDate = DateHelper.approxPublishDate(cleanText);
                if (!approxDate) continue;

                if (approxDate.getTime() > cutoff.getTime()) {
                    // Comment posted more than 2 years after set date — hide
                    comment.style.display = 'none';
                    comment.dataset.wbtHidden = '1';
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
                console.log('[WayBackTube] Hourly refresh triggered');
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
                /* === WayBackTube 2011 Flat Theme === */

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

                /* === WayBackTube Custom Components (2009 YouTube style) === */

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
            // Remove existing panel if re-injecting
            const existing = document.getElementById('wbt-panel');
            if (existing) existing.remove();

            this._build();
            this._attachDragHandler();
            this._startClockTicker();
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
            header.appendChild(_el('span', 'wbt-panel-title', 'WayBackTube'));

            const controls = _el('div', 'wbt-panel-controls');
            const statusBadge = _el('span', `wbt-status ${active ? 'active' : 'inactive'}`, active ? 'ON' : 'OFF');
            statusBadge.id = 'wbt-status';
            const toggleBtn = _el('button', 'wbt-panel-btn', active ? 'Disable' : 'Enable');
            toggleBtn.id = 'wbt-toggle-active';
            toggleBtn.title = 'Toggle active';
            const minBtn = _el('button', 'wbt-panel-btn', minimized ? '+' : '\u2013');
            minBtn.id = 'wbt-minimize';
            minBtn.title = 'Minimize';
            controls.appendChild(statusBadge);
            controls.appendChild(toggleBtn);
            controls.appendChild(minBtn);
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

            // --- Stats section ---
            const statsGrid = _el('div', 'wbt-stats-grid');
            statsGrid.id = 'wbt-stats';
            body.appendChild(this._buildSection('Stats', 'stats', false, [statsGrid]));

            this.panel.appendChild(body);
            document.body.appendChild(this.panel);
            this._attachEvents();
            this._refreshAllLists();
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

                subs.push({ id: ch.id, name: ch.name });
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
            if (terms.includes(val)) {
                this._toast('Term already exists', 'error');
                return;
            }

            terms.push(val);
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

            terms.forEach((term, i) => {
                const item = document.createElement('div');
                item.className = 'wbt-list-item';

                const name = document.createElement('span');
                name.className = 'wbt-list-name';
                name.textContent = term;

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
            if (topics.includes(val.toLowerCase())) {
                this._toast('Topic already exists', 'error');
                return;
            }

            topics.push(val);
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

            topics.forEach((topic, i) => {
                const item = document.createElement('div');
                item.className = 'wbt-list-item';

                const name = document.createElement('span');
                name.className = 'wbt-list-name';
                name.textContent = topic;

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
            };

            for (const [label, value] of Object.entries(stats)) {
                const row = _el('div', 'wbt-stat', [
                    _el('span', 'wbt-stat-label', label),
                    _el('span', 'wbt-stat-value', value),
                ]);
                grid.appendChild(row);
            }
        }

        // --- Refresh all ---

        _refreshAllLists() {
            this._refreshSubsList();
            this._refreshTermsList();
            this._refreshCatsGrid();
            this._refreshTopicsList();
            this._refreshStats();
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
            console.log('[WayBackTube] Initializing v113...');

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

            // Re-inject panel if YouTube nukes it (SPA navigation can destroy elements)
            setInterval(() => {
                if (!document.getElementById('wbt-panel')) {
                    console.log('[WayBackTube] Panel was removed, re-injecting...');
                    uiPanel.init();
                }
            }, 2000);

            // Set default date if none set
            if (!Store.getDate()) {
                const d = new Date();
                d.setFullYear(d.getFullYear() - 5);
                Store.setDate(d.toISOString().split('T')[0]);
            }

            console.log('[WayBackTube] Ready. Date:', Store.getCurrentDate(),
                '| Active:', Store.isActive(), '| Clock:', Store.isClockActive());
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
                            const serverTime = data.unixtime * 1000;
                            const drift = serverTime - Date.now();
                            Store.setTimeOffset(Math.abs(drift) > 30000 ? drift : 0);
                            if (Math.abs(drift) > 30000) {
                                console.log(`[WayBackTube] Clock drift corrected: ${Math.round(drift / 1000)}s`);
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
