# WayBackTube

A Tampermonkey userscript that turns YouTube into a time machine. Pick a date and YouTube becomes what it would've looked like on that day — the videos, the dates, the comments, all of it.

## What it does

You set a date (say, March 2013) and WayBackTube takes over YouTube. Your homepage fills with videos from that time period based on your subscriptions, search terms, favorite categories, and custom topics. Every "12 years ago" label gets recalculated to say "1 year ago" like it would've back then. Shorts don't exist yet in 2013, so they're gone — nuked from the sidebar, search results, channel pages, everywhere. Comments posted after your set date get hidden. Search results automatically filter to before your date. Channel pages show their uploads in order, stopping at your date.

It's not a skin or a theme. It rewrites the entire experience so nothing breaks the illusion.

## Features

- **Time-shifted homepage** — Pulls real videos from your set date using YouTube's internal API. Subscriptions, search terms, categories, and topics all feed into the mix. Every refresh gives you a different set of videos.
- **Date recalculation** — Every relative date on YouTube ("5 years ago", "2 months ago") gets recalculated relative to your chosen date, not today.
- **Real publish dates** — Fetches actual upload dates from YouTube's API for accuracy instead of guessing.
- **Rolling clock** — Optional real-time clock that advances from your set date. Leave it running and the feed refreshes every hour with "new" content.
- **Shorts annihilation** — Removes Shorts from navigation, search, channels, feeds, and redirects /shorts URLs back to the homepage.
- **Search filtering** — Automatically appends `before:YYYY-MM-DD` to every search so results stay in your time period.
- **Channel pages** — Replaces channel content with a chronological grid of that channel's videos, filtered to before your date.
- **Comment filtering** — Hides comments posted after your set date (with a 2-year grace period so comment sections aren't empty). Rewrites remaining comment dates to match.
- **2009 YouTube styling** — Blue link titles, flat design, no rounded corners, no shadows. The way it used to look.
- **Control panel** — Draggable panel to set the date, manage subscriptions, add search terms, pick categories, and add custom topics.
- **Clock sync** — Syncs with an external time server so the rolling clock stays accurate even if your PC was off.

## Installation

1. Install [Tampermonkey](https://www.tampermonkey.net/) for your browser
2. Click [here](https://raw.githubusercontent.com/negevch4n/iwant2gob4ck_yt/master/iwant2gob4ck_yt.user.js) to install the script
3. Go to YouTube and the control panel will appear in the top right

## How to use

Open YouTube. The WayBackTube panel shows up in the corner. Pick a date with the date picker or hit one of the preset buttons (1y ago, 5y ago, etc.). The homepage rebuilds with videos from that era.

Add your favorite channels under Subscriptions so they show up in the feed. Add search terms and topics to broaden what videos appear. Check off categories you're interested in.

Hit "New Videos" on the homepage to get a fresh batch. The script tracks what you've already seen and prioritizes showing you something different.

If you want the full experience, hit "Start Clock" and the date will advance in real time from wherever you set it. The feed auto-refreshes every hour.

## How it works

WayBackTube uses YouTube's internal InnerTube API — the same API the YouTube website itself uses. No API keys needed. It searches for videos within a date window around your chosen date, mixes results from your configured sources, and renders them in a custom grid that replaces YouTube's normal homepage.

All DOM manipulation is done with pure element creation (no innerHTML) to comply with YouTube's Trusted Types policy. The script detects YouTube's SPA navigation and re-applies itself on every page change.

## License

MIT
