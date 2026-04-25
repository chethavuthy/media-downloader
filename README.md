---
title: ClipSniper
emoji: 🎬
colorFrom: blue
colorTo: red
sdk: docker
pinned: false
---

# 🎬 Telegram Video Downloader Bot

A production-ready Telegram bot that downloads videos from multiple platforms with Khmer 🇰🇭 and English 🇬🇧 language support.

## ✨ Features

- **Multi-Platform Support**: TikTok, Douyin, YouTube, Instagram, Facebook, Twitter/X
- **Bilingual**: Full support for Khmer and English
- **Private & Group Chats**: Works seamlessly in both contexts
- **Inline Mode**: Type `@bot [link]` in any chat — no need to add bot to group
- **3 Inline Actions**: Video download, Ask AI (fallback chain), Ask Gemini (Gemini-only)
- **Rate Limiting**: Prevents abuse with configurable limits
- **Smart Queue System**: Handles multiple downloads concurrently
- **Auto Cleanup**: Temporary files are automatically deleted
- **Error Handling**: User-friendly error messages for common issues
- **No Watermarks**: Downloads videos without watermarks (where supported)

## 🚀 Quick Start

### Prerequisites

- **Node.js** 18+ 
- **yt-dlp** (system dependency)

### Installation

1. **Clone the repository**
   ```bash
   cd /Users/chetha/Documents/fun/downloader-telegram-bot
   ```

2. **Install Node.js dependencies**
   ```bash
   npm install
   ```

3. **Install yt-dlp** (macOS)
   ```bash
   brew install yt-dlp
   ```

   For other platforms, see [yt-dlp installation guide](https://github.com/yt-dlp/yt-dlp#installation)

4. **Configure environment**
   ```bash
   cp .env.example .env
   ```

   Edit `.env` and add your Telegram bot token:
   ```
   TELEGRAM_BOT_TOKEN=your_bot_token_here
   ```

   To create a bot token:
   - Message [@BotFather](https://t.me/botfather) on Telegram
   - Send `/newbot` and follow instructions
   - Copy the token to your `.env` file
   - For inline mode: send `/setinline` and set placeholder (e.g. "Paste video link")
   - For inline feedback: send `/setinlinefeedback` (enables chosen_inline_result)

### Running the Bot

**Development mode** (with auto-reload):
```bash
npm run dev
```

**Production mode**:
```bash
npm run build
```

### Fast VPS Deploy

```bash
# one-time setup for passwordless SSH
npm run setup:vps:ssh

# fast deploy (single command)
npm run deploy:vps
```

Use `npm run deploy:vps:safe` to run local build + VPS build.

## 📖 Usage

### Private Chat

1. Start a conversation with your bot
2. Send `/start` to select your language
3. Send any supported video URL
4. Bot will download and send the video back to you

### Group Chat

1. Add the bot to your group
2. Anyone can post video URLs
3. Bot automatically detects and downloads videos
4. Videos are sent back to the group

### Inline Mode (no need to add bot to group)

1. In any chat, type `@YourBotUsername https://tiktok.com/...`
2. Tap the video result (placeholder shows while downloading)
3. Video appears in the chat as "You via @YourBotUsername"
4. Requires `MEDIA_CHAT_ID` (channel/group where bot uploads to get file_id)

### Inline Ask AI

1. In any chat, type `@YourBotUsername What is happening in Phnom Penh now?`
2. Choose one inline action:
   - `🤖 Ask AI` (fallback chain)
   - `✨ Ask Gemini` (Gemini-only chain)
   - `📥 Download ... video` (shown when a valid video URL is present)
3. AI options use static descriptions in the picker; the selected placeholder shows `Q: <your question>` + `Thinking...`
4. Placeholder is replaced with the final result
5. Prefixes still supported for compatibility: `Ask AI`, `Ask Grok`, `Ask Gemini`
6. Ask AI fallback order: `Gemini + Google Search` → `Gemini + Brave/Tavily web context` → `Gemini` → `Grok`

## ⚙️ Configuration

Edit `.env` to customize bot behavior:

| Variable | Default | Description |
|----------|---------|-------------|
| `TELEGRAM_BOT_TOKEN` | - | Your bot token from BotFather (required) |
| `MAX_DOWNLOADS_PER_USER` | 5 | Downloads allowed per time window |
| `RATE_LIMIT_WINDOW_MINUTES` | 10 | Time window for rate limiting |
| `MAX_FILE_SIZE_MB` | 50 | Maximum file size (Telegram limit) |
| `DOWNLOAD_TIMEOUT_SECONDS` | 300 | Timeout for downloads |
| `CONCURRENT_DOWNLOADS` | 3 | Max simultaneous downloads |
| `AUTO_CLEANUP_MINUTES` | 30 | How often to clean old files |
| `LOG_LEVEL` | info | Logging level (info/warn/error) |
| `MEDIA_CHAT_ID` | - | For inline: chat where bot uploads to get file_id (required for "via @bot") |
| `BOT_USERNAME` | - | For TikTok caption: "mention @BOT_USERNAME to download any video" |
| `GEMINI_API_KEY` | - | Primary API key for Ask AI |
| `GEMINI_MODEL` | `gemini-2.5-flash` | Gemini model used for Ask AI |
| `GEMINI_API_BASE_URL` | `https://generativelanguage.googleapis.com/v1beta` | Gemini API base URL |
| `GEMINI_API_TIMEOUT_MS` | 30000 | Timeout for Gemini requests |
| `BRAVE_API_KEY` | - | Web-search fallback key (used when Gemini grounding fails) |
| `BRAVE_API_BASE_URL` | `https://api.search.brave.com/res/v1` | Brave Search API base URL |
| `TAVILY_API_KEY` | - | Secondary web-search fallback key |
| `TAVILY_API_BASE_URL` | `https://api.tavily.com` | Tavily API base URL |
| `AI_MAX_SEARCH_RESULTS` | 6 | Max results used in fallback web context |
| `GROK_API_KEY` | - | Optional final fallback provider key |
| `GROK_API_BASE_URL` | `https://api.x.ai/v1` | Grok fallback API base URL |
| `GROK_MODEL` | `grok-3-mini` | Grok fallback model |
| `GROK_API_TIMEOUT_MS` | 30000 | Timeout for Grok fallback requests |

## 🏗️ Architecture

```
src/
├── config/          # Environment configuration
├── types/           # TypeScript type definitions
├── locales/         # Khmer and English translations
├── utils/           # Utility functions (logger, URL detection)
├── services/        # Core business logic
├── handlers/        # Telegram message handlers
└── index.ts         # Main application entry point
```

## 🔧 Development

**Type checking**:
```bash
npx tsc --noEmit
```

**Linting**:
```bash
npm run lint
```

## 🐛 Troubleshooting

### "yt-dlp not found"
- Install yt-dlp system-wide: `brew install yt-dlp` (macOS)

### "Download failed" errors
- Check if the video is private or geo-restricted
- Some platforms may block downloads - this is expected

### Bot doesn't respond
- Verify `TELEGRAM_BOT_TOKEN` is set correctly in `.env`
- Check bot logs for errors

## 📝 License

MIT

## 🙏 Acknowledgments

- [Telegraf](https://telegraf.js.org/) - Telegram Bot API framework
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) - Video downloader

Check out the configuration reference at https://huggingface.co/docs/hub/spaces-config-reference

## 📚 Additional Docs

- Inline features guide: `docs/INLINE_FEATURE_GUIDE.md`
- VPS deployment runbook: `docs/DEPLOYMENT_RUNBOOK.md`
