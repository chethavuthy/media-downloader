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

### Running the Bot

**Development mode** (with auto-reload):
```bash
npm run dev
```

**Production mode**:
```bash
npm run build
```

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
