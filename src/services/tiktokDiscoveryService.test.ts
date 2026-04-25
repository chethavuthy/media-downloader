import {
  buildTikTokWebSearchQuery,
  extractTikTokFindQuery,
  rankTikTokCandidates,
  selectNextTikTokUrl,
  selectBestTikTokUrl,
} from './tiktokDiscoveryService.js';

describe('TikTok discovery helpers', () => {
  it('extracts a TikTok discovery query from find inline text', () => {
    expect(extractTikTokFindQuery('find tiktok girl dancing video khmer cute')).toBe(
      'girl dancing video khmer cute'
    );
  });

  it('returns null for non-find inline text', () => {
    expect(extractTikTokFindQuery('ask ai traffic in phnom penh')).toBeNull();
  });

  it('builds a site-scoped TikTok web query without duplicated find/tiktok words', () => {
    expect(buildTikTokWebSearchQuery('find tiktok girl dancing video khmer cute')).toBe(
      'site:tiktok.com girl dancing video khmer cute Cambodia Khmer ខ្មែរ'
    );
  });

  it('selects the first likely TikTok video URL and skips profiles or tags', () => {
    const url = selectBestTikTokUrl([
      'https://www.tiktok.com/@creator',
      'https://www.tiktok.com/tag/khmerdance',
      'https://www.tiktok.com/@creator/video/7351234567890123456?lang=en',
      'https://example.com/not-tiktok',
    ]);

    expect(url).toBe('https://www.tiktok.com/@creator/video/7351234567890123456');
  });

  it('accepts TikTok short links as discoverable video URLs', () => {
    expect(selectBestTikTokUrl(['https://vt.tiktok.com/ZSr123abc/'])).toBe(
      'https://vt.tiktok.com/ZSr123abc/'
    );
  });

  it('selects a later TikTok URL when earlier results were already used', () => {
    const urls = [
      'https://www.tiktok.com/@creator/video/7351234567890123456',
      'https://www.tiktok.com/@creator/video/7351234567890123499',
    ];

    expect(selectNextTikTokUrl(urls, [urls[0]])).toBe(urls[1]);
  });

  it('ranks Cambodia or Khmer candidates above generic TikTok results', () => {
    const ranked = rankTikTokCandidates([
      {
        url: 'https://www.tiktok.com/@generic/video/7351234567890123456',
        text: 'cute dancing trend usa viral',
      },
      {
        url: 'https://www.tiktok.com/@khmercreator/video/7351234567890123499',
        text: 'Khmer girl dancing Cambodia រាំខ្មែរ',
      },
    ]);

    expect(ranked[0]).toBe('https://www.tiktok.com/@khmercreator/video/7351234567890123499');
  });
});
