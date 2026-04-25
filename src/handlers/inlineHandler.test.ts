import { buildTikTokNextReplyMarkup } from './inlineHandler.js';

describe('inline TikTok controls', () => {
  it('renders replace and send-next buttons in one row', () => {
    expect(buildTikTokNextReplyMarkup('abc123')).toEqual({
      inline_keyboard: [[
        { text: 'Replace ↻', callback_data: 'tt_replace:abc123' },
        { text: 'Send Next ▶', callback_data: 'tt_send:abc123' },
      ]],
    });
  });
});
