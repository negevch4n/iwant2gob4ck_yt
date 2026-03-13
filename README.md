# WayBackTube

Tampermonkey userscript that filters YouTube to a specific date. You pick a date, and the entire site only shows content from that time period. Homepage, search, channels, comments, everything.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/)
2. Click [here](https://raw.githubusercontent.com/negevch4n/iwant2gob4ck_yt/master/iwant2gob4ck_yt.user.js) to install the script
3. Open YouTube. Control panel shows up top right.

## Features

**Homepage feed.** Pulls videos from around your selected date using YouTube's InnerTube API. Videos come from 4 configurable sources: subscriptions, search terms, categories, and custom topics. Each source has adjustable weight so you can control how much of the feed it takes up. Infinite scroll fetches more videos as you go, shifting the date window backward to keep finding new content.

**Sidebar recommendations.** On video pages, the sidebar gets replaced with WayBackTube recommendations pulled from the same sources, filtered to the same date range. Related videos from the current video's channel and keywords are mixed in.

**Endscreen overlay.** When a video ends, YouTube's endscreen is replaced with a 3x4 grid of WayBackTube recommendations overlaid on the player.

**Date recalculation.** All relative dates on the page ("5 years ago", "2 months ago") are recalculated relative to your chosen date, not today's date. If you set the date to 2013, a video from 2012 shows "1 year ago" instead of "13 years ago".

**Real publish dates.** The script fetches actual upload dates from the API in the background and updates cards as they come in.

**Rolling clock.** Optional clock that advances in real time from your set date. The feed auto-refreshes every hour with new content as the clock ticks forward.

**Shorts removal.** Shorts are hidden everywhere: navigation, search results, channel pages, feeds, shelves. `/shorts/` URLs redirect to the homepage.

**Search filtering.** Automatically appends `before:YYYY-MM-DD` to search queries so results stay within your time period. The filter text is hidden from the search bar so it looks normal.

**Channel pages.** Replaced with a chronological grid of that channel's uploads, filtered to before your selected date.

**Comment filtering.** Comments posted after your selected date are hidden. There's a 2-year grace period so comment sections aren't completely empty on older videos. Remaining comment dates are recalculated to match.

**Channel blocking.** Block channels from appearing in your feed, sidebar, and endscreen.

**Custom logo.** Upload a custom logo image to replace the YouTube logo in the header.

**2009 visual style.** Flat UI, no rounded corners, no shadows, no animations. Blue link titles. Rectangular search bar. Classic YouTube look.

**Control panel.** Draggable panel with collapsible sections for: date picker with presets (1y, 5y, 10y, 15y ago), subscriptions, search terms, categories (checkboxes), custom topics, channel block list, logo upload, and stats.

**Clock sync.** Syncs with worldtimeapi.org so the rolling clock stays accurate.

## How it works

Uses YouTube's InnerTube API (the same internal API the site uses) with `GM_xmlhttpRequest`. No YouTube Data API key needed. Authenticates using the page's existing session cookies for InnerTube requests.

Videos are fetched by searching within a date window (configurable, default ±7 days) around the selected date. Results from all 4 sources are mixed by weight, deduplicated, and shuffled with a bias toward videos closer to the center date.

All DOM manipulation uses `document.createElement` (no innerHTML) to work with YouTube's Trusted Types CSP. The script hooks into YouTube's SPA navigation via `yt-navigate-finish` events and a URL polling fallback, re-applying all modifications on every page change. A 100ms interval continuously hides YouTube's native elements (shorts, chips, endscreens) that get re-rendered by YouTube's framework.

Data is stored locally via Tampermonkey's `GM_setValue`/`GM_getValue`. Nothing is sent to any server other than YouTube and worldtimeapi.org (for clock sync).

## License

MIT
