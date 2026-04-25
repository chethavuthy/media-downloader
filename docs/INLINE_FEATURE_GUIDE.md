# ClipSniper Inline Feature Guide

Last updated: 2026-04-09

## 1) What Is Included

This bot currently includes two inline features:

1. Inline video download:
- Use in any chat with `@YourBotUsername <video_link>`
- Supports platforms already handled by the bot (TikTok, YouTube, Instagram, Facebook, Twitter/X, etc.)
- Sends a placeholder first, then replaces/sends media

2. Inline Ask AI:
- Use in any chat with:
  - `@YourBotUsername <question>` (no prefix required)
  - `@YourBotUsername Ask AI <question>`
  - `@YourBotUsername Ask Grok <question>` (alias)
  - `@YourBotUsername Ask Gemini <question>` (alias)
- Returns a placeholder first, then edits to final AI answer
- Inline picker description is static (not repeating question)
- Placeholder message shows `Q: <question>` + thinking status for clarity
- Tuned for Cambodia-focused realtime responses (Khmer/English aware)

3. Inline Ask Gemini:
- Available as a separate inline action for the same query
- Uses Gemini chain only (`Gemini + Google Search` → `Gemini + Brave/Tavily context` → `Gemini`)

## 2) What You Need To Know First

1. Inline must be enabled in BotFather:
- `/setinline`
- `/setinlinefeedback`

2. `chosen_inline_result` is required for placeholder replacement:
- Without it, inline replacement logic will fall back to private message behavior.

3. AI behavior uses a fallback provider chain:
- `Ask AI`: `Gemini + Google Search` (primary) → `Gemini + Brave/Tavily web context` → `Gemini` → `Grok`
- `Ask Gemini`: `Gemini + Google Search` → `Gemini + Brave/Tavily web context` → `Gemini`

4. Rate limiting applies to inline AI and inline/video requests:
- Same rate-limit service as other bot usage.

## 3) How To Use (User Side)

### A) Inline Video

1. In Telegram, type:
```text
@YourBotUsername https://www.tiktok.com/...
```
2. Tap the inline result.
3. Placeholder appears (`⏳ Downloading...`), then media is delivered.

### B) Inline Ask AI

1. In Telegram, type:
```text
@YourBotUsername What is happening in Phnom Penh now?
```
2. Tap `🤖 Ask AI` for smart fallback mode, or `✨ Ask Gemini` for Gemini-only mode.
3. Placeholder appears with question context:
```text
🤖 Ask AI
Q: <your question>

⏳ Checking latest sources...
```
4. Then answer is inserted.
5. Reply includes the provider used and whether fallback was used.

## 4) Cambodia-Focused Prompt Tuning (Already Added)

Ask AI is tuned for:

1. Cambodia priority:
- Prefers Cambodia context (national, Phnom Penh first) unless user asks another country.

2. Khmer/English adaptation:
- Khmer question: Khmer-first answer + short English summary.
- English question: English answer with useful Khmer place/event names if relevant.

3. Intent-specific formatting:
- `news`: top updates, impact for Cambodia, what to watch next
- `traffic`: hotspots, alternatives, better travel window
- `events`: event name/location/time/entry/tip
- `trading`: snapshot, drivers, risks, neutral checklist

4. Time sensitivity:
- Injects current Phnom Penh time context.
- Instructs AI to avoid stale certainty for fast-changing topics.

5. Source-aware output:
- If fallback web snippets are used, asks AI to cite source markers and list sources.

## 5) Environment Variables Checklist

### Required for basic bot operation
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_USE_WEBHOOK` (false for VPS polling mode)
- `TELEGRAM_WEBHOOK_URL` (only needed for webhook mode)
- `TELEGRAM_WEBHOOK_PATH`
- `TELEGRAM_WEBHOOK_SECRET_TOKEN`
- `YT_DLP_PATH`
- `INSTALOADER_PATH`
- `GALLERY_DL_PATH`
- `COOKIES_PATH`
- `MAX_DOWNLOADS_PER_USER`
- `RATE_LIMIT_WINDOW_MINUTES`
- `MAX_FILE_SIZE_MB`
- `DOWNLOAD_TIMEOUT_SECONDS`
- `CONCURRENT_DOWNLOADS`
- `AUTO_CLEANUP_MINUTES`
- `LOG_LEVEL`
- `MEDIA_CHAT_ID` (important for inline video replacement)
- `BOT_USERNAME`

### Required for Inline Ask AI (recommended)
- `GEMINI_API_KEY`

### Optional but recommended for stronger fallback
- `BRAVE_API_KEY`
- `TAVILY_API_KEY`
- `GROK_API_KEY`

### Optional tuning controls
- `GEMINI_MODEL` (default: `gemini-2.5-flash`)
- `GEMINI_API_BASE_URL`
- `GEMINI_API_TIMEOUT_MS`
- `BRAVE_API_BASE_URL`
- `TAVILY_API_BASE_URL`
- `AI_MAX_SEARCH_RESULTS` (default: `6`)
- `GROK_API_BASE_URL`
- `GROK_MODEL`
- `GROK_API_TIMEOUT_MS`

## 6) Quick Validation After Deployment

1. Service health (VPS):
```bash
systemctl is-active media-downloader.service
curl -s http://127.0.0.1:7860/health
```

2. Inline video test:
- In any chat: `@YourBotUsername <valid video url>`
- Confirm placeholder + final media delivery.

3. Inline AI test:
- `@YourBotUsername Ask AI traffic in Phnom Penh now`
- Confirm placeholder + final answer.

4. Fallback test:
- Temporarily remove one provider key and verify another provider responds.

## 7) Troubleshooting

1. Inline result does not appear:
- Recheck BotFather inline settings.
- Ensure bot username is correct and bot is not privacy-restricted for this use.

2. Inline placeholder does not get replaced:
- Ensure inline feedback is enabled (`/setinlinefeedback`).
- Check logs for `chosen_inline_result` and `inline_message_id`.

3. Ask AI returns config error:
- Set at least one provider key:
  - `GEMINI_API_KEY` or `GROK_API_KEY`

4. Ask AI quality is weak:
- Add `BRAVE_API_KEY` and `TAVILY_API_KEY`.
- Keep prompt questions explicit about location/time (e.g., `today in Phnom Penh`).

5. Inline video fails but private message works:
- Verify `MEDIA_CHAT_ID` is set and bot is a member of that chat/channel.

## 8) Security Notes

1. Do not commit real `.env` values to git.
2. Rotate credentials immediately if leaked:
- VPS root password
- Telegram bot token
- AI/search API keys
3. Prefer SSH keys over password login for VPS operations.
