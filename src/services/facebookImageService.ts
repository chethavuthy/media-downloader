/**
 * Facebook photo/album download service.
 *
 * Extracted from imageService.ts to keep individual modules under ~200 lines.
 * Uses mbasic.facebook.com scraping with gallery-dl fallback and timeline scan.
 */
import { logger } from '../utils/logger.js';
import { config } from '../config/index.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import { DownloadedMedia, scanForMedia } from './imageService.js';

const execAsync = promisify(exec);

// ─── URL resolution helpers ──────────────────────────────────────────────────

async function resolveShareLink(url: string): Promise<{ targetUrl: string; resolvedUrl: string; fbid: string }> {
  let targetUrl = url;
  let resolvedUrl = '';
  let fbid = '';

  const resolutionUA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

  // Tier 1: Follow redirect locally
  try {
    logger.info(`Attempting Tier 1 resolution (local curl): ${url}`);
    const { stdout } = await execAsync(
      `curl -sL -o /dev/null -w "%{url_effective}" -A "${resolutionUA}" "${url}"`,
      { timeout: 15000 }
    );

    if (stdout.trim() && !stdout.includes('/login') && stdout.trim() !== url) {
      targetUrl = stdout.trim();
      resolvedUrl = targetUrl;
      logger.info(`Resolved share link to: ${targetUrl}`);

      const storyFbidMatch = targetUrl.match(/story_fbid=(\d+)/);
      const fbidParamMatch = targetUrl.match(/fbid=(\d+)/);
      if (storyFbidMatch) {
        fbid = storyFbidMatch[1];
      } else if (fbidParamMatch) {
        fbid = fbidParamMatch[1];
      }
      return { targetUrl, resolvedUrl, fbid };
    }
    throw new Error('Tier 1 returned same or login URL');
  } catch (e: any) {
    logger.warn(`Tier 1 resolution failed: ${e.message}. Attempting Tier 2 proxy...`);
  }

  // Tier 2 / 3: Proxy fallbacks
  let content = '';
  try {
    const proxyUrl = `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`;
    const { stdout } = await execAsync(`curl -sL "${proxyUrl}"`, { timeout: 20000 });
    content = stdout;
  } catch {
    try {
      const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`;
      const { stdout: proxyJson } = await execAsync(`curl -s "${proxyUrl}"`, { timeout: 20000 });
      if (proxyJson?.startsWith('{')) content = JSON.parse(proxyJson).contents || '';
    } catch (err: any) {
      logger.error(`All proxy resolutions failed: ${err.message}`);
    }
  }

  if (content) {
    const urlIdMatch = resolvedUrl.match(
      /(?:fbid=|photo\.php\?fbid=|photos\/[^/]+\/|posts\/[^/]+\/|posts\/|pfbid|videos\/|share\/p\/|share\/v\/)([a-zA-Z0-9]+)/
    );
    if (urlIdMatch) {
      fbid = urlIdMatch[1];
    } else {
      const storyFbidMatch = content.match(/"story_fbid":"(\d+)"/);
      const fbidMatch = content.match(/fbid=(\d+)/);
      const canonicalMatch =
        content.match(/link rel="canonical" href="([^"]+)"/) ||
        content.match(/"og:url" content="([^"]+)"/);

      if (canonicalMatch && !canonicalMatch[1].includes('/login')) {
        const canonicalUrl = canonicalMatch[1];
        if (canonicalUrl.includes('/videos/') || canonicalUrl.includes('/reel/') || canonicalUrl.includes('/watch/')) {
          logger.info('Canonical URL indicates VIDEO. Aborting image download.');
          return { targetUrl: '', resolvedUrl: '', fbid: '__video__' };
        }
        const canonicalIdMatch = canonicalUrl.match(
          /(?:fbid=|photo\.php\?fbid=|photos\/[^/]+\/|posts\/[^/]+\/|posts\/|pfbid)([a-zA-Z0-9]+)/
        );
        if (canonicalIdMatch) fbid = canonicalIdMatch[1];
      }

      if (!fbid) {
        const genericIds = content.match(/(\d{15,})/g);
        fbid = storyFbidMatch?.[1] || fbidMatch?.[1] || genericIds?.[genericIds.length - 1] || '';
      }
    }

    if (
      resolvedUrl.includes('/videos/') ||
      resolvedUrl.includes('/reel/') ||
      resolvedUrl.includes('/watch/') ||
      resolvedUrl.includes('share/v/')
    ) {
      logger.info('Resolved URL indicates VIDEO. Aborting image download.');
      return { targetUrl: '', resolvedUrl: '', fbid: '__video__' };
    }
  }

  return { targetUrl, resolvedUrl, fbid };
}

// ─── mbasic scraping ─────────────────────────────────────────────────────────

function extractImagesFromContent(content: string): string[] {
  const matches = content.match(/(?:scontent|fbcdn\.net)[^\s"<>']+/g) || [];
  const ogMatch =
    content.match(/property="og:image" content="([^"]+)"/) ||
    content.match(/"og:image" content="([^"]+)"/);

  let urls = matches
    .map(u => {
      let clean = u.replace(/&amp;/g, '&').replace(/\\\//g, '/');
      if (!clean.startsWith('http')) clean = 'https://' + clean;
      return clean;
    })
    .filter(u => {
      const hasDomain = u.includes('scontent') || u.includes('fbcdn.net');
      const lower = u.toLowerCase();
      const hasExt =
        lower.includes('.jpg') || lower.includes('.jpeg') || lower.includes('.png') ||
        lower.includes('.kf') || lower.includes('_nc_');
      const isStatic =
        u.includes('rsrc.php') || u.includes('emoji.php') || u.includes('/catalog/') ||
        u.includes('ad_') || lower.includes('t15.') || lower.includes('/t15/') || lower.includes('t16.');
      return hasDomain && hasExt && !isStatic;
    });

  if (urls.length === 0 && ogMatch) {
    urls = [ogMatch[1].replace(/&amp;/g, '&').replace(/\\\//g, '/')];
  }
  return urls;
}

async function scrapeMbasic(fbid: string, targetUrl: string, resolvedUrl: string, outputDir: string): Promise<void> {
  const mbasicUrl =
    fbid.startsWith('pfbid') || targetUrl.includes('/posts/')
      ? `https://mbasic.facebook.com/posts/${fbid}`
      : `https://mbasic.facebook.com/photo.php?fbid=${fbid}`;

  logger.info(`Attempting mbasic scraping: ${mbasicUrl}`);
  const modernUA =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
  const botUA = 'Googlebot/2.1 (+http://www.google.com/bot.html)';

  let stdout = '';
  try {
    const result = await execAsync(
      `curl -sL -A "${modernUA}" "${mbasicUrl}"`,
      { timeout: 30000, maxBuffer: 10 * 1024 * 1024 }
    );
    stdout = result.stdout;
  } catch {
    try {
      const proxyUrl = `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(mbasicUrl)}`;
      const r1 = await execAsync(`curl -sL -A "${modernUA}" "${proxyUrl}"`, { timeout: 30000 });
      stdout = r1.stdout;
      if (stdout.includes('Connectez-vous') || stdout.includes('Log In') || stdout.length < 10000) {
        const r2 = await execAsync(`curl -sL -A "${botUA}" "${proxyUrl}"`, { timeout: 30000 });
        stdout = r2.stdout;
      }
    } catch (e: any) {
      logger.error(`Proxy scraping failed: ${e.message}`);
    }
  }

  logger.info(`mbasic scraping returned ${stdout.length} bytes`);

  let imageUrls = extractImagesFromContent(stdout);
  logger.info(`Initial mbasic sweep found ${imageUrls.length} image URLs`);

  const isLoginWall =
    stdout.includes('Connectez-vous') || stdout.includes('Log In') ||
    (stdout.length > 0 && stdout.length < 5000);

  if (imageUrls.length === 0 || isLoginWall) {
    // Tier 4: Embed Plugin fallback
    try {
      const pluginHref = fbid
        ? `https://www.facebook.com/facebook/posts/${fbid}`
        : resolvedUrl || targetUrl;
      const embedUrl = `https://www.facebook.com/plugins/post.php?href=${encodeURIComponent(pluginHref)}`;
      const proxyEmbedUrl = `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(embedUrl)}`;
      const { stdout: embedStdout } = await execAsync(`curl -sL -A "${modernUA}" "${proxyEmbedUrl}"`, { timeout: 30000 });

      if (embedStdout && embedStdout.length > 1000) {
        const embedUrls = extractImagesFromContent(embedStdout);
        if (embedUrls.length > 0) {
          logger.info(`Embed Plugin rescued the download with ${embedUrls.length} images`);
          imageUrls = embedUrls;
          stdout = embedStdout;
        }
      }
    } catch (e: any) {
      logger.warn(`Embed Plugin scraping failed: ${e.message}`);
    }
  }

  if (stdout.includes('video_id') || stdout.includes('"video_id"') || stdout.includes('swfobject')) {
    logger.info('Content indicates VIDEO. Aborting image download.');
    return;
  }

  logger.info(`mbasic filtered to ${imageUrls.length} valid image URLs`);

  // Group by content ID and download best variant of each
  const imageGroups = new Map<string, string[]>();
  imageUrls.forEach(u => {
    const idMatch = u.match(/(\d+)_(\d+)_(\d+)_[a-z]\.jpg/);
    let contentId = 'default';
    if (idMatch) contentId = idMatch[2];
    else {
      const anyNum = u.match(/\/(\d+)_/);
      contentId = anyNum ? anyNum[1] || 'misc' : 'og_image';
    }
    if (!imageGroups.has(contentId)) imageGroups.set(contentId, []);
    imageGroups.get(contentId)!.push(u);
  });

  const getDimensions = (u: string) => {
    const m = u.match(/[sp](\d+)x(\d+)/);
    if (m) return { w: parseInt(m[1]), h: parseInt(m[2]), pixels: parseInt(m[1]) * parseInt(m[2]) };
    if ((u.includes('scontent') || u.includes('fbcdn')) && !u.includes('s100x100') && !u.includes('p100x100')) {
      return { w: 9999, h: 9999, pixels: 99999999 };
    }
    return { w: 0, h: 0, pixels: 0 };
  };

  for (const [contentId, groupUrls] of imageGroups) {
    const bestUrl = groupUrls.sort((a, b) => {
      const dA = getDimensions(a), dB = getDimensions(b);
      return dB.pixels !== dA.pixels ? dB.pixels - dA.pixels : b.length - a.length;
    })[0];

    const dims = getDimensions(bestUrl);
    if (dims.w > 0 && (dims.w < 200 || dims.h < 200)) continue;
    if (bestUrl.includes('p50x50') || bestUrl.includes('s50x50')) continue;

    const filename = contentId === 'default' || contentId === 'og_image' ? `${fbid}.jpg` : `${contentId}.jpg`;
    const imagePath = path.join(outputDir, filename);

    try {
      await execAsync(`curl -sL -o "${imagePath}" "${bestUrl}"`, { timeout: 30000 });
      const stat = await fs.stat(imagePath);
      if (stat.size <= 25000) {
        logger.warn(`Downloaded file too small (${stat.size}B), removing: ${imagePath}`);
        await fs.unlink(imagePath).catch(() => { /* ignore */ });
      }
    } catch {
      const proxyUrl = `https://images.weserv.nl/?url=${encodeURIComponent(bestUrl)}`;
      try {
        await execAsync(`curl -sL -o "${imagePath}" "${proxyUrl}"`, { timeout: 30000 });
      } catch {
        logger.error(`Failed to download image ${contentId} via proxy`);
      }
    }
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Download photos/album from a Facebook post.
 * Returns an empty array if the URL resolves to a video.
 */
export async function downloadFacebookAlbum(url: string, outputDir: string): Promise<DownloadedMedia[]> {
  logger.info('Using mbasic.facebook.com scraping for Facebook photos');

  let targetUrl = url;
  let resolvedUrl = '';
  let fbid = '';

  if (url.includes('/share/')) {
    const resolved = await resolveShareLink(url);
    if (resolved.fbid === '__video__') return [];
    targetUrl = resolved.targetUrl || url;
    resolvedUrl = resolved.resolvedUrl;
    fbid = resolved.fbid;
  }

  if (resolvedUrl?.includes('/login')) {
    logger.warn('Discarding login-bound resolved URL');
    resolvedUrl = '';
  }
  if (!resolvedUrl) resolvedUrl = targetUrl;

  if (!fbid) {
    const m = targetUrl.match(
      /(?:fbid=|photo\.php\?fbid=|photos\/[^/]+\/|posts\/[^/]+\/|posts\/|pfbid)([a-zA-Z0-9]+)/
    );
    if (m) fbid = m[1];
  }

  if (fbid) {
    if (!targetUrl.includes('photo.php')) {
      targetUrl = `https://www.facebook.com/photo.php?fbid=${fbid}`;
    }
    await scrapeMbasic(fbid, targetUrl, resolvedUrl, outputDir).catch(e =>
      logger.warn(`mbasic scraping overall failed: ${e.message}`)
    );
  }

  let files = await scanForMedia(outputDir);

  // Quality check: if the single image is < 40KB, try gallery-dl
  let isLowQuality = false;
  let lowQualityFile: DownloadedMedia | null = null;

  if (files.length === 1 && files[0].type === 'photo') {
    try {
      const stat = await fs.stat(files[0].path);
      if (stat.size < 40 * 1024) {
        logger.warn(`Single image low quality (${Math.round(stat.size / 1024)}KB). Trying gallery-dl...`);
        isLowQuality = true;
        lowQualityFile = files[0];
      }
    } catch { /* ignore */ }
  }

  if (files.length === 0 || isLowQuality) {
    const args = [`"${targetUrl}"`, `--dest "${outputDir}"`, '--no-mtime', '--write-metadata', '--range 1'];
    if (config.cookiesPath) args.push(`--cookies "${config.cookiesPath}"`);

    try {
      await execAsync(`${config.galleryDlPath} ${args.join(' ')}`, { timeout: 60000 });
    } catch (e: any) {
      logger.warn(`gallery-dl fallback failed: ${e.message}`);
    }

    const newFiles = await scanForMedia(outputDir);
    if (newFiles.length > 0) {
      files = newFiles;
    } else if (isLowQuality && lowQualityFile) {
      logger.warn('gallery-dl returned nothing; keeping low-res original.');
      files = [lowQualityFile];
    }
  }

  // Timeline scan for multi-photo posts
  if (
    files.length === 1 &&
    (targetUrl.includes('/posts/') || targetUrl.includes('fbid=') ||
      targetUrl.includes('permalink.php') || targetUrl.includes('/photos/') ||
      targetUrl.includes('/share/p/'))
  ) {
    files = await timelineScan(files, outputDir, targetUrl);
  }

  return files;
}

async function timelineScan(files: DownloadedMedia[], outputDir: string, targetUrl: string): Promise<DownloadedMedia[]> {
  logger.info('Reconstructing gallery via Timeline Scan...');
  try {
    const absOutputDir = path.resolve(outputDir);
    let metaPath: string | null = null;

    const findMeta = async (dir: string): Promise<void> => {
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        if (metaPath) return;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) await findMeta(full);
        else if (e.name.endsWith('.json')) { metaPath = full; return; }
      }
    };
    await findMeta(absOutputDir);

    if (!metaPath) {
      logger.warn('No metadata (.json) found; skipping timeline scan.');
      return files;
    }

    const metadata = JSON.parse(await fs.readFile(metaPath, 'utf-8'));
    const baseDate = new Date(metadata.upload_date || metadata.date).getTime();
    const userIdentifier = metadata.user_id || metadata.username;

    if (!userIdentifier || isNaN(baseDate)) {
      logger.warn(`Insufficient data for timeline scan`);
      return files;
    }

    const scanDir = path.join(outputDir, 'timeline_scan');
    await fs.mkdir(scanDir, { recursive: true });

    const timelineArgs = [`"https://www.facebook.com/${userIdentifier}/photos/"`,
      `--dest "${scanDir}"`, '--range 1-20', '--no-mtime', '--write-metadata'];
    if (config.cookiesPath) timelineArgs.push(`--cookies "${config.cookiesPath}"`);
    await execAsync(`${config.galleryDlPath} ${timelineArgs.join(' ')}`, { timeout: 120000 });

    const scanResults = await scanForMedia(scanDir);
    const isGenuineGallery =
      (metadata.set_id?.includes('pcb.')) ||
      (metadata.title?.toLowerCase().includes('post'));

    if (!isGenuineGallery) {
      logger.info('Not a genuine gallery post; skipping reconstruction.');
      return files;
    }

    const matching: DownloadedMedia[] = [];
    for (const media of scanResults) {
      const itemMetaPath = `${media.path}.json`;
      if (!await fs.stat(itemMetaPath).catch(() => null)) continue;
      const itemMeta = JSON.parse(await fs.readFile(itemMetaPath, 'utf-8'));
      const itemDate = new Date(itemMeta.upload_date || itemMeta.date).getTime();
      if (Math.abs(itemDate - baseDate) <= 45000) {
        const newPath = path.join(outputDir, path.basename(media.path));
        await fs.rename(media.path, newPath);
        matching.push({ path: newPath, type: media.type });
      }
    }

    if (matching.length > 1) {
      logger.info(`Reconstructed gallery with ${matching.length} images`);
      return matching.sort((a, b) => a.path.localeCompare(b.path));
    }
  } catch (e: any) {
    logger.error('Timeline Scan failed', e);
  }
  return files;
}

/**
 * Returns true if the Facebook URL is likely a photo/album (not a video).
 */
export async function isFacebookAlbum(url: string): Promise<boolean> {
  if (
    url.includes('/watch') ||
    url.includes('/reel/') ||
    url.includes('/reels/') ||
    url.includes('fb.watch')
  ) {
    logger.info('Detected Facebook video (watch/reel), will use yt-dlp');
    return false;
  }

  if (url.includes('/share/')) {
    try {
      const cookiesArg = config.cookiesPath ? `--cookies "${config.cookiesPath}"` : '';
      const { stdout } = await execAsync(
        `"${config.ytDlpPath}" "${url}" --print "%(ext)s" --no-warnings --no-check-certificates ${cookiesArg} 2>&1`,
        { timeout: 10000 }
      );
      const ext = stdout.trim().toLowerCase();

      if (['mp4', 'webm', 'mkv', 'm4v'].includes(ext)) {
        logger.info('Detected Facebook video (share), will use yt-dlp');
        return false;
      }
      logger.info('Detected Facebook photo/album (share)');
      return true;
    } catch {
      logger.info('Facebook share probe failed, using proxy resolution...');
      return await probeFacebookShareViaProxy(url);
    }
  }

  if (
    url.includes('photo.php') ||
    url.includes('permalink.php') ||
    url.includes('/photos/') ||
    url.includes('/posts/') ||
    url.includes('/story.php')
  ) {
    logger.info('Detected Facebook photo/album/post');
    return true;
  }

  return false;
}

async function probeFacebookShareViaProxy(url: string): Promise<boolean> {
  const resolutionUA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';
  try {
    const { stdout: resUrl } = await execAsync(
      `curl -sL -o /dev/null -w "%{url_effective}" -A "${resolutionUA}" "${url}"`,
      { timeout: 10000 }
    );
    const bestUrl = resUrl && !resUrl.includes('/login') ? resUrl.trim() : url;

    const proxyUrl = `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(bestUrl)}`;
    const { stdout: content } = await execAsync(`curl -sL "${proxyUrl}"`, { timeout: 30000 });

    if (content.includes('og:video') || content.includes('"video_id":"')) {
      logger.info('Detected Facebook video via proxy content');
      return false;
    }

    if (content.includes('Connectez-vous') || content.includes('Log In') || content.length < 10000) {
      const fbidMatch =
        bestUrl.match(/(?:fbid=|photo\.php\?fbid=|photos\/[^/]+\/|posts\/[^/]+\/|posts\/|pfbid)([a-zA-Z0-9]+)/) ||
        content.match(/"fbid":"(\d+)"/);
      const checkFbid = fbidMatch?.[1];
      const pluginUrl = checkFbid
        ? `https://www.facebook.com/facebook/posts/${checkFbid}`
        : bestUrl;
      const embedUrl = `https://www.facebook.com/plugins/post.php?href=${encodeURIComponent(pluginUrl)}`;
      const proxyEmbedUrl = `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(embedUrl)}`;
      const { stdout: embedContent } = await execAsync(`curl -sL "${proxyEmbedUrl}"`, { timeout: 20000 });
      if (embedContent.includes('swfobject') || embedContent.includes('video_id')) {
        logger.info('Detected Facebook video via Embed Plugin');
        return false;
      }
    }
  } catch {
    try {
      const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`;
      const { stdout: proxyJson } = await execAsync(`curl -s "${proxyUrl}"`, { timeout: 30000 });
      if (proxyJson?.startsWith('{')) {
        const content = JSON.parse(proxyJson).contents || '';
        if (content.includes('og:video') || content.includes('"video_id":"')) {
          logger.info('Detected Facebook video via AllOrigins');
          return false;
        }
      }
    } catch {
      logger.error('All proxy resolution fallbacks in isFacebookAlbum failed');
    }
  }

  if (url.includes('/share/v/') || url.includes('/share/r/')) {
    logger.info('Uncertain share link — assuming album/hybrid');
    return true;
  }
  return true;
}
