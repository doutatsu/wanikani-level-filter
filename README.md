# WaniKani Level Filter

A userscript that allows you to filter WaniKani reviews by level during active review sessions. Select a specific level from a dropdown menu, and only review items from that level while other items are automatically skipped.

## Features

- **Real-time filtering** during active review sessions
- **Simple dropdown UI** at the top of the review page
- **Level persistence** - your selection is saved across sessions
- **Smart queue management** - skipped items are deferred to the end of the queue
- **Empty queue detection** - warns you if few/no items from the selected level are available
- **Graceful error handling** - continues working even if data loading fails

## Prerequisites

This script requires the **WaniKani Open Framework (WKOF)** to function.

1. Install a userscript manager:
   - **Chrome/Edge**: [Tampermonkey](https://www.tampermonkey.net/) (recommended) or [Violentmonkey](https://violentmonkey.github.io/)
   - **Firefox**: [Tampermonkey](https://www.tampermonkey.net/) or [Greasemonkey](https://www.greasespot.net/)
   - **Safari**: [Userscripts](https://apps.apple.com/app/userscripts/id1463298887)

2. Install the **WaniKani Open Framework**:
   - [Install from GreasyFork](https://greasyfork.org/en/scripts/38582-wanikani-open-framework)
   - Or follow the [installation instructions](https://community.wanikani.com/t/instructions-installing-wanikani-open-framework/28549)

## Installation

1. Make sure you have WKOF installed (see Prerequisites)
2. Click here to install: [wanikani-level-filter.user.js](wanikani-level-filter.user.js)
3. Your userscript manager will prompt you to confirm installation
4. Click "Install" or "Confirm"

Alternative: Copy the contents of `wanikani-level-filter.user.js` and create a new userscript in your userscript manager.

## Usage

1. Navigate to a WaniKani review session: https://www.wanikani.com/review
2. Look for the **"Filter by Level:"** dropdown at the top of the page
3. Select a level from the dropdown (or choose "All Levels" to disable filtering)
4. Start your reviews - items from other levels will be automatically skipped
5. Your selection is saved and will persist across review sessions

### How It Works

- When you select a specific level, the script monitors each review item as it appears
- If an item is not from the selected level, it's automatically moved to the end of your review queue
- This allows you to focus on reviewing items from a specific level without interruption
- Items from other levels are not removed - they're just deferred for later

## License

MIT License - see [LICENSE](LICENSE) file for details

## Credits

- Built on top of the [WaniKani Open Framework](https://github.com/rfindley/wanikani-open-framework) by rfindley
- Inspired by various WaniKani userscripts from the community
