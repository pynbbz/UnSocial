const https = require('https');
const http = require('http');
const { getRealisticUserAgent } = require('./user-agent');

const RESERVED_TG_PATHS = new Set([
  's',
  'c',
  'joinchat',
  'addstickers',
  'addemoji',
  'addlist',
  'addtheme',
  'proxy',
  'socks',
  'share',
  'iv',
  'login',
  'confirmphone',
  'setlanguage',
  'bg',
  'boost',
  'giftcode',
  'contact',
  'dl',
]);

/**
 * Parse a user-entered string into a Telegram target descriptor.
 * Returns null if the input does not look like a Telegram URL or handle.
 *
 * Supported formats:
 *   - Public channel URLs:
 *       t.me/hesam_tone
 *       https://t.me/hesam_tone
 *       https://t.me/s/hesam_tone
 *       https://t.me/hesam_tone/227
 *       telegram.me/hesam_tone
 *       telegram.dog/hesam_tone
 *       https://web.telegram.org/k/#@hesam_tone
 *       https://web.telegram.org/a/#@hesam_tone
 *   - Private channel URLs (by chat ID):
 *       t.me/c/1234567890
 *       https://t.me/c/1234567890/45
 *       https://web.telegram.org/k/#-1001234567890
 *       https://web.telegram.org/a/#-1001234567890
 *       https://web.telegram.org/k/#-1234567890
 *       c/1234567890
 *   - Private channel invite links:
 *       https://t.me/+AbCdEfGh123
 *       t.me/+AbCdEfGh123
 *       https://t.me/joinchat/AbCdEfGh123
 *       invite/AbCdEfGh123
 *   - Explicit prefix shorthand:
 *       tg:hesam_tone / telegram:hesam_tone
 *       tg:c/1234567890
 */
function parseTelegramInput(rawInput) {
  if (!rawInput || typeof rawInput !== 'string') return null;
  const input = rawInput.trim();
  if (!input) return null;

  // 1. Internal stored formats: c/<chatId> or invite/<hash>
  const internalPrivateMatch = input.match(/^(?:tg:|telegram:)?c\/(\d{5,20})(?:\/\d+)?$/i);
  if (internalPrivateMatch) {
    const chatId = internalPrivateMatch[1];
    return {
      platform: 'telegram',
      username: `c/${chatId}`,
      chatId,
      isPrivate: true,
      fullUrl: `https://t.me/c/${chatId}`,
    };
  }

  const internalInviteMatch = input.match(/^(?:tg:|telegram:)?invite\/([A-Za-z0-9_-]{5,64})$/i);
  if (internalInviteMatch) {
    const inviteHash = internalInviteMatch[1];
    return {
      platform: 'telegram',
      username: `invite/${inviteHash}`,
      inviteHash,
      isPrivate: true,
      fullUrl: `https://t.me/+${inviteHash}`,
    };
  }

  // 2. Explicit tg: or telegram: prefix for public channels
  const prefixMatch = input.match(/^(?:tg|telegram):@?([A-Za-z0-9_]{4,64})$/i);
  if (prefixMatch) {
    const username = prefixMatch[1];
    return {
      platform: 'telegram',
      username,
      isPrivate: false,
      fullUrl: `https://t.me/s/${username}`,
    };
  }

  // 3. Telegram Web URLs (web.telegram.org/k/#... or web.telegram.org/a/#...)
  const webTgMatch = input.match(
    /^(?:https?:\/\/)?web\.telegram\.org\/(?:k|a|z)\/?#(.+)$/i
  );
  if (webTgMatch) {
    const fragment = decodeURIComponent(webTgMatch[1].trim()).replace(/^\?tgaddr=/, '');
    // #-1001234567890 or #-1234567890
    const peerNumMatch = fragment.match(/^-100(\d{5,20})$/) || fragment.match(/^-(\d{5,20})$/);
    if (peerNumMatch) {
      const chatId = peerNumMatch[1];
      return {
        platform: 'telegram',
        username: `c/${chatId}`,
        chatId,
        isPrivate: true,
        fullUrl: `https://t.me/c/${chatId}`,
      };
    }
    // #@username or #username
    const peerUserMatch = fragment.match(/^@?([A-Za-z][A-Za-z0-9_]{3,63})$/);
    if (peerUserMatch) {
      const username = peerUserMatch[1];
      return {
        platform: 'telegram',
        username,
        isPrivate: false,
        fullUrl: `https://t.me/s/${username}`,
      };
    }
  }

  // 4. t.me / telegram.me / telegram.dog URLs (with or without http(s)://)
  const tmeMatch = input.match(
    /^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me|telegram\.dog)\/(.+)$/i
  );
  if (tmeMatch) {
    const pathPart = tmeMatch[1].split(/[?#]/)[0].replace(/\/+$/, '');

    // 4a. Private channel post/chat link: t.me/c/1234567890 or t.me/c/1234567890/45
    const privateChatMatch = pathPart.match(/^c\/(\d{5,20})(?:\/\d+)*$/i);
    if (privateChatMatch) {
      const chatId = privateChatMatch[1];
      return {
        platform: 'telegram',
        username: `c/${chatId}`,
        chatId,
        isPrivate: true,
        fullUrl: `https://t.me/c/${chatId}`,
      };
    }

    // 4b. Invite link: t.me/+HASH or t.me/joinchat/HASH
    const plusInviteMatch = pathPart.match(/^\+([A-Za-z0-9_-]{5,64})$/);
    if (plusInviteMatch) {
      const inviteHash = plusInviteMatch[1];
      return {
        platform: 'telegram',
        username: `invite/${inviteHash}`,
        inviteHash,
        isPrivate: true,
        fullUrl: `https://t.me/+${inviteHash}`,
      };
    }

    const joinchatMatch = pathPart.match(/^joinchat\/([A-Za-z0-9_-]{5,64})$/i);
    if (joinchatMatch) {
      const inviteHash = joinchatMatch[1];
      return {
        platform: 'telegram',
        username: `invite/${inviteHash}`,
        inviteHash,
        isPrivate: true,
        fullUrl: `https://t.me/+${inviteHash}`,
      };
    }

    // 4c. Public preview link: t.me/s/<username> or t.me/s/<username>/<postId>
    const previewMatch = pathPart.match(/^s\/([A-Za-z][A-Za-z0-9_]{3,63})(?:\/\d+)?$/i);
    if (previewMatch) {
      const username = previewMatch[1];
      return {
        platform: 'telegram',
        username,
        isPrivate: false,
        fullUrl: `https://t.me/s/${username}`,
      };
    }

    // 4d. Direct public channel link: t.me/<username> or t.me/<username>/<postId>
    const publicMatch = pathPart.match(/^@?([A-Za-z][A-Za-z0-9_]{3,63})(?:\/\d+)?$/i);
    if (publicMatch) {
      const username = publicMatch[1];
      if (!RESERVED_TG_PATHS.has(username.toLowerCase())) {
        return {
          platform: 'telegram',
          username,
          isPrivate: false,
          fullUrl: `https://t.me/s/${username}`,
        };
      }
    }
  }

  return null;
}

/**
 * Decode HTML entities into plain UTF-8 characters.
 */
function decodeHtmlEntities(str) {
  if (!str) return '';
  return str
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      try {
        return String.fromCodePoint(parseInt(hex, 16));
      } catch {
        return _;
      }
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      try {
        return String.fromCodePoint(parseInt(dec, 10));
      } catch {
        return _;
      }
    })
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

/**
 * Convert a Telegram HTML fragment into readable plain text, preserving line breaks.
 */
function htmlFragmentToText(html) {
  if (!html) return '';
  let text = html;
  // Convert <br> tags to newlines
  text = text.replace(/<br\s*\/?>/gi, '\n');
  // Strip emoji fallback images if they wrap inner emoji text, or replace with alt
  text = text.replace(/<i[^>]*class="[^"]*emoji[^"]*"[^>]*>([\s\S]*?)<\/i>/gi, '$1');
  // Preserve hyperlinked URLs if the anchor text is not already a URL or hashtag/mention
  text = text.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (full, attrs, inner) => {
    const cleanInner = decodeHtmlEntities(inner.replace(/<[^>]+>/g, '')).trim();
    const hrefMatch = attrs.match(/\bhref=["']([^"']+)["']/i);
    if (!hrefMatch) return cleanInner;
    const href = decodeHtmlEntities(hrefMatch[1]).trim();
    if (
      !href ||
      href.startsWith('tg://') ||
      href.startsWith('?') ||
      cleanInner.startsWith('#') ||
      cleanInner.startsWith('@') ||
      cleanInner.includes('http://') ||
      cleanInner.includes('https://') ||
      cleanInner.includes('t.me/')
    ) {
      return cleanInner;
    }
    return `${cleanInner} (${href})`;
  });
  // Strip remaining HTML tags
  text = text.replace(/<[^>]+>/g, '');
  return decodeHtmlEntities(text).replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Parse compact count strings like "7.37K", "1.2M", "452" into integers.
 */
function parseCompactCount(str) {
  if (!str) return 0;
  const cleaned = str.trim().toUpperCase().replace(/,/g, '');
  const match = cleaned.match(/^(\d+(?:\.\d+)?)\s*([KM])?$/);
  if (!match) {
    const digits = parseInt(cleaned.replace(/\D/g, ''), 10);
    return Number.isFinite(digits) ? digits : 0;
  }
  const num = parseFloat(match[1]);
  const suffix = match[2];
  if (suffix === 'K') return Math.round(num * 1000);
  if (suffix === 'M') return Math.round(num * 1000000);
  return Math.round(num);
}

/**
 * Fetch an HTTPS/HTTP URL as UTF-8 text, following up to `maxRedirects` redirects.
 */
function fetchUrlText(url, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(
      url,
      {
        headers: {
          'User-Agent': getRealisticUserAgent(),
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cache-Control': 'no-cache',
        },
        timeout: 20000,
      },
      (res) => {
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location &&
          maxRedirects > 0
        ) {
          res.resume();
          const nextUrl = new URL(res.headers.location, url).toString();
          resolve(
            fetchUrlText(nextUrl, maxRedirects - 1).then((r) => ({
              ...r,
              finalUrl: r.finalUrl || nextUrl,
            }))
          );
          return;
        }
        if (res.statusCode && res.statusCode >= 400) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
          return;
        }
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            body: Buffer.concat(chunks).toString('utf8'),
            finalUrl: url,
            statusCode: res.statusCode || 200,
          });
        });
      }
    );
    req.on('timeout', () => {
      req.destroy(new Error(`Timed out fetching ${url}`));
    });
    req.on('error', reject);
  });
}

/**
 * Parse the HTML of `https://t.me/s/<channel>` into UnSocial's standard profile + posts object.
 */
function parseTelegramPublicHtml(html, channelUsername) {
  // Extract channel metadata from OpenGraph / header
  const ogTitleMatch =
    html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']*)["']/i) ||
    html.match(/<meta\s+content=["']([^"']*)["']\s+property=["']og:title["']/i);
  const ogDescMatch =
    html.match(/<meta\s+property=["']og:description["']\s+content=["']([^"']*)["']/i) ||
    html.match(/<meta\s+content=["']([^"']*)["']\s+property=["']og:description["']/i);
  const ogImageMatch =
    html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']*)["']/i) ||
    html.match(/<meta\s+content=["']([^"']*)["']\s+property=["']og:image["']/i);

  const headerTitleMatch = html.match(
    /<div\s+class=["']tgme_channel_info_header_title["'][^>]*>([\s\S]*?)<\/div>/i
  );
  const fullName =
    (headerTitleMatch ? htmlFragmentToText(headerTitleMatch[1]) : '') ||
    (ogTitleMatch ? decodeHtmlEntities(ogTitleMatch[1]).trim() : '') ||
    channelUsername;

  const bio = ogDescMatch ? decodeHtmlEntities(ogDescMatch[1]).trim() : '';
  const profilePicUrl = ogImageMatch ? decodeHtmlEntities(ogImageMatch[1]).trim() : '';

  // Split HTML into individual message widgets
  const wrapParts = html.split(/<div\s+class=["'][^"']*tgme_widget_message_wrap[^"']*["'][^>]*>/i);
  const posts = [];

  for (let i = 1; i < wrapParts.length; i++) {
    const block = wrapParts[i];

    // Extract data-post="channel/123"
    const dataPostMatch = block.match(/\bdata-post=["']([^"']+)["']/i);
    if (!dataPostMatch) continue;
    const dataPost = dataPostMatch[1]; // e.g., "hesam_tone/227"
    const [postChannel, postId] = dataPost.split('/');
    if (!postId) continue;

    // Skip Pure service messages unless they have media/text
    const isService = /\btgme_widget_message_service\b/i.test(block);

    // Remove the quoted reply block (.tgme_widget_message_reply) before extracting the post's own text/media
    let replyPrefix = '';
    const replyMatch = block.match(
      /<a\s+class=["'][^"']*tgme_widget_message_reply["'][^>]*>([\s\S]*?)<\/a>/i
    );
    let blockWithoutReply = block;
    if (replyMatch) {
      blockWithoutReply = block.replace(replyMatch[0], '');
      const replyAuthorMatch = replyMatch[1].match(
        /<span\s+class=["'][^"']*tgme_widget_message_author_name["'][^>]*>([\s\S]*?)<\/span>/i
      );
      const replyTextMatch = replyMatch[1].match(
        /<div\s+class=["'][^"']*js-message_reply_text[^"']*["'][^>]*>([\s\S]*?)<\/div>/i
      );
      const replyText = replyTextMatch ? htmlFragmentToText(replyTextMatch[1]) : '';
      const replyAuthor = replyAuthorMatch ? htmlFragmentToText(replyAuthorMatch[1]) : '';
      if (replyText) {
        const snippet = replyText.length > 100 ? replyText.slice(0, 100) + '…' : replyText;
        replyPrefix = replyAuthor ? `↩️ Reply to ${replyAuthor}: "${snippet}"\n\n` : `↩️ "${snippet}"\n\n`;
      }
    }

    // Extract main message text (.js-message_text)
    let rawText = '';
    const textRegex =
      /<div\s+class=["'][^"']*tgme_widget_message_text\s+js-message_text[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi;
    const textMatches = [...blockWithoutReply.matchAll(textRegex)];
    if (textMatches.length > 0) {
      rawText = textMatches.map((m) => htmlFragmentToText(m[1])).filter(Boolean).join('\n\n');
    }

    // Extract Poll if present
    const pollQuestionMatch = blockWithoutReply.match(
      /<div\s+class=["'][^"']*tgme_widget_message_poll_question[^"']*["'][^>]*>([\s\S]*?)<\/div>/i
    );
    let pollTitle = '';
    let pollText = '';
    if (pollQuestionMatch) {
      pollTitle = htmlFragmentToText(pollQuestionMatch[1]);
      const optionMatches = [
        ...blockWithoutReply.matchAll(
          /<div\s+class=["'][^"']*tgme_widget_message_poll_option_text[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi
        ),
      ].map((m) => `• ${htmlFragmentToText(m[1])}`);
      pollText = `📊 Poll: ${pollTitle}${optionMatches.length ? '\n' + optionMatches.join('\n') : ''}`;
    }

    // Extract Document / Audio / Music metadata if present
    // Note: class can be "tgme_widget_message_document_title accent_color"
    const docTitleMatch = blockWithoutReply.match(
      /<div\s+class=["'][^"']*tgme_widget_message_document_title[^"']*["'][^>]*>([\s\S]*?)<\/div>/i
    );
    const docExtraMatch = blockWithoutReply.match(
      /<div\s+class=["'][^"']*tgme_widget_message_document_extra[^"']*["'][^>]*>([\s\S]*?)<\/div>/i
    );
    const isAudioDoc =
      /<div\s+class=["'][^"']*tgme_widget_message_document_icon[^"']*\baudio\b[^"']*["']/i.test(
        blockWithoutReply
      );
    const docTitle = docTitleMatch ? htmlFragmentToText(docTitleMatch[1]) : '';
    const docExtra = docExtraMatch ? htmlFragmentToText(docExtraMatch[1]) : '';

    // Extract Voice message if present
    const isVoice = /\btgme_widget_message_voice\b/i.test(blockWithoutReply);
    const voiceUrlMatch = blockWithoutReply.match(
      /<audio\b[^>]*class=["'][^"']*tgme_widget_message_voice[^"']*["'][^>]*\bsrc=["']([^"']+)["']/i
    );
    const voiceUrl = voiceUrlMatch ? decodeHtmlEntities(voiceUrlMatch[1]).trim() : null;
    const voiceDurationMatch = blockWithoutReply.match(
      /<time\s+class=["'][^"']*tgme_widget_message_voice_duration[^"']*["'][^>]*>([\s\S]*?)<\/time>/i
    );
    const voiceDuration = voiceDurationMatch ? htmlFragmentToText(voiceDurationMatch[1]) : '';

    // Extract Photos from .tgme_widget_message_photo_wrap background-image
    const images = [];
    const photoWrapRegex =
      /<a\s+class=["'][^"']*tgme_widget_message_photo_wrap[^"']*["'][^>]*style=["'][^"']*background-image\s*:\s*url\(['"]?([^'")]+)['"]?\)/gi;
    for (const m of blockWithoutReply.matchAll(photoWrapRegex)) {
      const url = decodeHtmlEntities(m[1]).trim();
      if (url && !images.includes(url)) {
        images.push(url);
      }
    }
    const photoWrapAltRegex =
      /<a\s+[^>]*style=["'][^"']*background-image\s*:\s*url\(['"]?([^'")]+)['"]?\)[^"']*["'][^>]*class=["'][^"']*tgme_widget_message_photo_wrap[^"']*["']/gi;
    for (const m of blockWithoutReply.matchAll(photoWrapAltRegex)) {
      const url = decodeHtmlEntities(m[1]).trim();
      if (url && !images.includes(url)) {
        images.push(url);
      }
    }

    // Extract Video player, Video URL, Video Thumbnail, and Video Duration
    const hasVideoPlayer =
      /\btgme_widget_message_video_player\b|\btgme_widget_message_roundvideo_player\b/i.test(
        blockWithoutReply
      );
    let videoUrl = null;
    const videoMatch =
      blockWithoutReply.match(
        /<video\b[^>]*class=["'][^"']*tgme_widget_message_video[^"']*["'][^>]*\bsrc=["']([^"']+)["']/i
      ) ||
      blockWithoutReply.match(
        /<video\b[^>]*\bsrc=["']([^"']+)["'][^>]*class=["'][^"']*tgme_widget_message_video[^"']*["']/i
      ) ||
      blockWithoutReply.match(/<video\b[^>]*\bsrc=["']([^"']+)["']/i);
    if (videoMatch) {
      videoUrl = decodeHtmlEntities(videoMatch[1]).trim();
    }
    const isVideo = Boolean(videoUrl || hasVideoPlayer);

    const videoDurationMatch = blockWithoutReply.match(
      /<time\s+class=["'][^"']*message_video_duration[^"']*["'][^>]*>([\s\S]*?)<\/time>/i
    );
    const videoDuration = videoDurationMatch ? htmlFragmentToText(videoDurationMatch[1]) : '';

    let videoThumb = null;
    const videoThumbMatch =
      blockWithoutReply.match(
        /class=["'][^"']*tgme_widget_message_(?:round)?video_thumb[^"']*["'][^>]*style=["'][^"']*background-image\s*:\s*url\(['"]?([^'")]+)['"]?\)/i
      ) ||
      blockWithoutReply.match(
        /style=["'][^"']*background-image\s*:\s*url\(['"]?([^'")]+)['"]?\)[^"']*["'][^>]*class=["'][^"']*tgme_widget_message_(?:round)?video_thumb[^"']*["']/i
      );
    if (videoThumbMatch) {
      videoThumb = decodeHtmlEntities(videoThumbMatch[1]).trim();
    }

    // Extract Link Preview if present
    const linkPreviewMatch = blockWithoutReply.match(
      /<a\s+class=["'][^"']*tgme_widget_message_link_preview[^"']*["'][^>]*>([\s\S]*?)<\/a>/i
    );
    let linkPreviewImage = null;
    let linkPreviewSummary = '';
    if (linkPreviewMatch) {
      const lpFull = linkPreviewMatch[0];
      const lpInner = linkPreviewMatch[1];
      const lpHrefMatch = lpFull.match(/\bhref=["']([^"']+)["']/i);
      const lpHref = lpHrefMatch ? decodeHtmlEntities(lpHrefMatch[1]).trim() : '';
      const lpTitleMatch = lpInner.match(
        /<div\s+class=["'][^"']*link_preview_title[^"']*["'][^>]*>([\s\S]*?)<\/div>/i
      );
      const lpDescMatch = lpInner.match(
        /<div\s+class=["'][^"']*link_preview_description[^"']*["'][^>]*>([\s\S]*?)<\/div>/i
      );
      const lpImgMatch = lpInner.match(
        /class=["'][^"']*link_preview_(?:right_)?image[^"']*["'][^>]*style=["'][^"']*background-image\s*:\s*url\(['"]?([^'")]+)['"]?\)/i
      );
      if (lpImgMatch) {
        linkPreviewImage = decodeHtmlEntities(lpImgMatch[1]).trim();
      }
      const lpTitle = lpTitleMatch ? htmlFragmentToText(lpTitleMatch[1]) : '';
      const lpDesc = lpDescMatch ? htmlFragmentToText(lpDescMatch[1]) : '';
      if (lpTitle && !rawText.includes(lpTitle)) {
        linkPreviewSummary = [
          `🔗 ${lpTitle}`,
          lpDesc ? lpDesc : '',
          lpHref && !rawText.includes(lpHref) ? lpHref : '',
        ]
          .filter(Boolean)
          .join('\n');
      }
    }

    const hasAnyContent =
      Boolean(rawText) ||
      images.length > 0 ||
      isVideo ||
      Boolean(docTitle) ||
      isVoice ||
      Boolean(pollTitle) ||
      Boolean(linkPreviewSummary);

    if (isService && !hasAnyContent) {
      continue;
    }
    if (!hasAnyContent) {
      continue;
    }

    const permalink = `https://t.me/${postChannel || channelUsername}/${postId}`;

    // Determine post media classification & build clear Title + Caption
    let postType = 'text';
    let postTypeBadge = '📝 [Text]';
    let mediaLine = '';

    if (isAudioDoc && docTitle) {
      postType = 'audio';
      postTypeBadge = '🎵 [Audio]';
      const audioLabel = docExtra ? `${docTitle} — ${docExtra}` : docTitle;
      mediaLine = `🎵 Audio: ${audioLabel}`;
    } else if (isVoice) {
      postType = 'voice';
      postTypeBadge = voiceDuration ? `🎤 [Voice ${voiceDuration}]` : '🎤 [Voice]';
      mediaLine = `🎤 Voice Message${voiceDuration ? ` (${voiceDuration})` : ''}`;
    } else if (isVideo) {
      postType = 'video';
      postTypeBadge = videoDuration ? `🎬 [Video ${videoDuration}]` : '🎬 [Video]';
      mediaLine = `🎬 Video${videoDuration ? ` (${videoDuration})` : ''}`;
    } else if (images.length > 0) {
      postType = 'photo';
      postTypeBadge = images.length > 1 ? `📷 [Photos (${images.length})]` : '📷 [Photo]';
      mediaLine = images.length > 1 ? `📷 ${images.length} Photos` : '📷 Photo';
    } else if (docTitle) {
      postType = 'file';
      postTypeBadge = '📎 [File]';
      mediaLine = docExtra ? `📎 File: ${docTitle} (${docExtra})` : `📎 File: ${docTitle}`;
    } else if (pollTitle) {
      postType = 'poll';
      postTypeBadge = '📊 [Poll]';
      mediaLine = pollText;
    }

    // Build body text (caption)
    const bodyParts = [];
    if (mediaLine) bodyParts.push(mediaLine);
    if (replyPrefix && rawText) {
      bodyParts.push(`${replyPrefix}${rawText}`);
    } else if (rawText) {
      bodyParts.push(rawText);
    } else if (replyPrefix) {
      bodyParts.push(replyPrefix.trim());
    }
    if (pollText && postType !== 'poll') {
      bodyParts.push(pollText);
    }
    if (linkPreviewSummary) {
      bodyParts.push(linkPreviewSummary);
    }
    const caption = bodyParts.join('\n\n');

    // Build descriptive title showing whether post has audio/video/photo or is plain text
    const firstLineText = rawText ? rawText.split('\n').find((l) => l.trim()) || '' : '';
    let title = '';
    if (postType === 'audio') {
      const trackLabel = docExtra ? `${docTitle} – ${docExtra}` : docTitle;
      title = firstLineText
        ? `${postTypeBadge} ${trackLabel} — ${firstLineText}`
        : `${postTypeBadge} ${trackLabel}`;
    } else if (postType === 'voice') {
      title = firstLineText
        ? `${postTypeBadge} ${firstLineText}`
        : `${postTypeBadge} Voice message`;
    } else if (postType === 'video') {
      title = firstLineText
        ? `${postTypeBadge} ${firstLineText}`
        : `${postTypeBadge} Video post`;
    } else if (postType === 'photo') {
      title = firstLineText
        ? `${postTypeBadge} ${firstLineText}`
        : `${postTypeBadge} Photo post`;
    } else if (postType === 'file') {
      const fileLabel = docExtra ? `${docTitle} (${docExtra})` : docTitle;
      title = firstLineText
        ? `${postTypeBadge} ${fileLabel} — ${firstLineText}`
        : `${postTypeBadge} ${fileLabel}`;
    } else if (postType === 'poll') {
      title = `${postTypeBadge} ${pollTitle}`;
    } else {
      title = `${postTypeBadge} ${firstLineText || caption || `Post #${postId}`}`;
    }
    if (title.length > 130) {
      title = title.slice(0, 127) + '…';
    }

    // Extract Timestamp
    const timeMatch =
      block.match(
        /<a\s+class=["'][^"']*tgme_widget_message_date[^"']*["'][^>]*>[\s\S]*?<time\b[^>]*\bdatetime=["']([^"']+)["']/i
      ) || block.match(/<time\b[^>]*\bdatetime=["']([^"']+)["']/i);
    const timestamp = timeMatch ? timeMatch[1].trim() : new Date().toISOString();

    // Extract Views / Reactions
    const viewsMatch = block.match(
      /<span\s+class=["'][^"']*tgme_widget_message_views[^"']*["'][^>]*>([\s\S]*?)<\/span>/i
    );
    const viewsCount = viewsMatch ? parseCompactCount(htmlFragmentToText(viewsMatch[1])) : 0;

    let reactionsCount = 0;
    const reactionsBlockMatch = block.match(
      /<div\s+class=["'][^"']*tgme_widget_message_reactions[^"']*["'][^>]*>([\s\S]*?)<\/div>/i
    );
    if (reactionsBlockMatch) {
      const rMatches = [
        ...reactionsBlockMatch[1].matchAll(
          /<span\s+class=["'][^"']*tgme_reaction[^"']*["'][^>]*>([\s\S]*?)<\/span>/gi
        ),
      ];
      for (const rm of rMatches) {
        const rText = rm[1].replace(/<[^>]+>/g, ' ').trim();
        const rNumMatch = rText.match(/(\d+(?:\.\d+)?[KMkm]?)\s*$/);
        if (rNumMatch) {
          reactionsCount += parseCompactCount(rNumMatch[1]);
        }
      }
    }

    const displayUrl = images[0] || videoThumb || linkPreviewImage || null;
    if (displayUrl && images.length === 0) {
      images.push(displayUrl);
    }

    posts.push({
      id: postId,
      shortcode: postId,
      title,
      caption,
      postType,
      postTypeBadge,
      audioUrl: voiceUrl || null,
      audioTitle: isAudioDoc ? (docExtra ? `${docTitle} — ${docExtra}` : docTitle) : null,
      videoDuration: videoDuration || null,
      timestamp,
      imageUrl: displayUrl,
      displayUrl,
      images,
      videoUrl,
      isVideo,
      isAudio: Boolean(isAudioDoc || isVoice),
      likes: reactionsCount || viewsCount,
      views: viewsCount,
      comments: 0,
      permalink,
    });
  }

  // Sort newest first
  posts.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  return {
    username: channelUsername,
    fullName,
    bio,
    profilePicUrl,
    posts,
    scrapedAt: new Date().toISOString(),
  };
}

/**
 * Scrape a public Telegram channel via `https://t.me/s/<channel>` without requiring authentication.
 */
async function scrapeTelegramPublic(channelUsername) {
  const cleanUser = channelUsername.replace(/^@/, '').trim();
  const previewUrl = `https://t.me/s/${encodeURIComponent(cleanUser)}`;
  const { body, finalUrl } = await fetchUrlText(previewUrl);

  const parsed = parseTelegramPublicHtml(body, cleanUser);

  // Check if t.me/s/<channel> redirected to t.me/<channel> or had 0 messages
  if (parsed.posts.length === 0) {
    // Check if the channel doesn't exist at all vs. has preview disabled
    const hasChannelTitle =
      /<div\s+class=["']tgme_page_title["']/i.test(body) ||
      /<div\s+class=["']tgme_channel_info_header_title["']/i.test(body);
    return {
      ...parsed,
      previewUnavailable: !finalUrl.includes('/s/') || !/tgme_widget_message_wrap/i.test(body),
      channelExists: hasChannelTitle,
    };
  }

  return parsed;
}

/**
 * Scrape a private (or preview-disabled public) Telegram channel using an authenticated
 * hidden Electron BrowserWindow running Telegram Web K (`https://web.telegram.org/k/`).
 */
async function scrapeTelegramWeb(targetInfo) {
  let BrowserWindow;
  try {
    ({ BrowserWindow } = require('electron'));
  } catch {
    throw new Error('Electron runtime is required to scrape private Telegram channels.');
  }

  const hidden = new BrowserWindow({
    width: 1280,
    height: 900,
    show: false,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  const chromeUA = getRealisticUserAgent();
  hidden.webContents.session.setUserAgent(chromeUA);
  hidden.webContents.setUserAgent(chromeUA);

  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Timed out loading Telegram Web for private channel scrape.'));
      }, 35000);

      hidden.webContents.once('did-finish-load', () => {
        clearTimeout(timeout);
        resolve();
      });
      hidden.webContents.once('did-fail-load', (_e, code, desc) => {
        clearTimeout(timeout);
        reject(new Error(`Failed to load Telegram Web: ${desc} (${code})`));
      });

      hidden.loadURL('https://web.telegram.org/k/');
    });

    // Execute extraction inside Telegram Web K using its internal managers
    const result = await hidden.webContents.executeJavaScript(
      `(${ telegramWebExtractScript.toString() })(${JSON.stringify(targetInfo)})`,
      true
    );

    if (result && result.error) {
      throw new Error(result.error);
    }

    return result;
  } finally {
    if (!hidden.isDestroyed()) hidden.destroy();
  }
}

/**
 * Runs inside `https://web.telegram.org/k/` renderer context.
 * Uses `window.rootScope.managers` to resolve the channel and fetch its latest messages.
 */
async function telegramWebExtractScript(targetInfo) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  try {
    // 1. Verify login state in localStorage
    const userAuthRaw = localStorage.getItem('user_auth') || localStorage.getItem('account1');
    if (!userAuthRaw) {
      return {
        error:
          'Telegram login required for private channels — please click the Telegram badge in the top bar to log in.',
      };
    }
    try {
      const parsedAuth = JSON.parse(userAuthRaw);
      if (!parsedAuth || (!parsedAuth.id && !parsedAuth.userId)) {
        return {
          error:
            'Telegram login required for private channels — please click the Telegram badge in the top bar to log in.',
        };
      }
    } catch {
      // Non-JSON truthy string is still treated as present, proceed to wait for managers
    }

    // 2. Wait up to 20s for rootScope.managers to initialize
    let managers = null;
    for (let i = 0; i < 80; i++) {
      if (
        window.rootScope &&
        window.rootScope.managers &&
        window.rootScope.managers.appMessagesManager &&
        window.rootScope.managers.appChatsManager
      ) {
        managers = window.rootScope.managers;
        break;
      }
      await sleep(250);
    }

    if (!managers) {
      return { error: 'Telegram Web managers did not initialize in time. Please try again.' };
    }

    // Warm up dialogs so chat entities are populated in Web K's local cache
    try {
      await managers.dialogsStorage.getDialogs({ limit: 100 });
    } catch {
      // Ignore warmup errors
    }

    let chatId = targetInfo.chatId ? Number(targetInfo.chatId) : null;
    let peerId = chatId ? -Math.abs(chatId) : null;
    let chatObj = null;

    // 3a. Resolve invite hash if provided (t.me/+HASH or t.me/joinchat/HASH)
    if (targetInfo.inviteHash && managers.appChatInvitesManager) {
      try {
        const inviteRes = await managers.appChatInvitesManager.checkChatInvite(
          targetInfo.inviteHash
        );
        if (inviteRes && inviteRes.chat) {
          chatObj = inviteRes.chat;
          chatId = Number(chatObj.id);
          peerId = -Math.abs(chatId);
        } else if (inviteRes && (inviteRes._ === 'chatInvite' || inviteRes._ === 'chatInvitePeek')) {
          if (inviteRes.chat) {
            chatObj = inviteRes.chat;
            chatId = Number(chatObj.id);
            peerId = -Math.abs(chatId);
          } else {
            const imported = await managers.appChatInvitesManager.importChatInvite(
              targetInfo.inviteHash
            );
            const firstChat = imported && imported.chats && imported.chats[0];
            if (firstChat) {
              chatObj = firstChat;
              chatId = Number(firstChat.id);
              peerId = -Math.abs(chatId);
            }
          }
        }
      } catch (inviteErr) {
        return {
          error: `Could not open Telegram invite link: ${inviteErr.message || String(inviteErr)}`,
        };
      }
    }

    // 3b. Resolve public username if neither chatId nor inviteHash was used
    if (!peerId && targetInfo.username && !targetInfo.username.startsWith('c/')) {
      const cleanUsername = targetInfo.username.replace(/^@/, '');
      try {
        const peer = await managers.appUsersManager.resolveUsername(cleanUsername);
        if (peer && peer._ === 'channel') {
          chatObj = peer;
          chatId = Number(peer.id);
          peerId = -Math.abs(chatId);
        } else if (peer && peer.chats && peer.chats[0]) {
          chatObj = peer.chats[0];
          chatId = Number(chatObj.id);
          peerId = -Math.abs(chatId);
        } else if (typeof peer === 'number') {
          peerId = peer;
          chatId = Math.abs(peer);
        }
      } catch (resolveErr) {
        return {
          error: `Could not resolve Telegram channel @${cleanUsername}: ${resolveErr.message || String(resolveErr)}`,
        };
      }
    }

    if (!peerId || !chatId) {
      return { error: 'Could not determine Telegram channel ID.' };
    }

    // Fetch chat metadata
    if (!chatObj) {
      try {
        chatObj = await managers.appChatsManager.getChat(chatId);
      } catch {
        chatObj = null;
      }
    }

    let bio = '';
    try {
      if (managers.appProfileManager && managers.appProfileManager.getChannelFull) {
        const fullChat = await managers.appProfileManager.getChannelFull(chatId);
        if (fullChat && fullChat.about) {
          bio = fullChat.about;
        }
      }
    } catch {
      // Optional bio
    }

    const fullName =
      (chatObj && (chatObj.title || chatObj.username)) ||
      targetInfo.customName ||
      `Telegram Channel ${chatId}`;
    const publicUsername =
      (chatObj && chatObj.username) ||
      (chatObj && chatObj.usernames && chatObj.usernames[0] && chatObj.usernames[0].username) ||
      null;

    // Fetch latest messages from the channel
    let histResult = await managers.appMessagesManager.getHistory({
      peerId,
      offsetId: 0,
      limit: 35,
      fetchIfWasNotFetched: true,
    });

    // If first call triggered a background network fetch and returned empty, wait briefly and retry
    let mids = (histResult && (histResult.history || histResult.messages)) || [];
    if (mids.length === 0) {
      await sleep(1500);
      histResult = await managers.appMessagesManager.getHistory({
        peerId,
        offsetId: 0,
        limit: 35,
        fetchIfWasNotFetched: true,
      });
      mids = (histResult && (histResult.history || histResult.messages)) || [];
    }

    const rawMessages = [];
    for (const item of mids) {
      let msg = typeof item === 'object' && item !== null ? item : null;
      if (!msg) {
        try {
          msg = await managers.appMessagesManager.getMessageByPeer(peerId, item);
        } catch {
          msg = null;
        }
      }
      if (msg && msg._ === 'message') {
        rawMessages.push(msg);
      }
    }

    // Group album messages that share `grouped_id`
    const groupedMap = new Map();
    const orderedEntries = [];

    for (const msg of rawMessages) {
      const groupKey = msg.grouped_id ? `group_${String(msg.grouped_id)}` : `msg_${msg.mid || msg.id}`;
      if (groupedMap.has(groupKey)) {
        const existing = groupedMap.get(groupKey);
        if (!existing.caption && msg.message) {
          existing.caption = msg.message;
        }
        existing.albumCount += 1;
        continue;
      }

      // Compute server post ID (Telegram Web K shifts message IDs by 2^32 locally, or stores server ID in msg.id)
      const rawMid = Number(msg.id || msg.mid || 0);
      const postId = String(rawMid >= 4294967296 ? Math.floor(rawMid / 4294967296) || (rawMid % 4294967296) : rawMid);

      const rawText = msg.message || '';
      let isVideo = false;
      let isAudio = false;
      let postType = 'text';
      let postTypeBadge = '📝 [Text]';
      let mediaNotice = '';
      let audioLabel = '';
      let videoDuration = '';
      let wpSummary = '';

      const fmtDur = (sec) => {
        const s = Math.round(Number(sec || 0));
        if (!s || s <= 0) return '';
        const m = Math.floor(s / 60);
        const r = String(s % 60).padStart(2, '0');
        return `${m}:${r}`;
      };

      const media = msg.media;
      if (media) {
        if (media._ === 'messageMediaPhoto') {
          postType = 'photo';
          postTypeBadge = '📷 [Photo]';
          mediaNotice = '📷 Photo';
        } else if (media._ === 'messageMediaDocument' && media.document) {
          const doc = media.document;
          const mime = doc.mime_type || '';
          const attrs = Array.isArray(doc.attributes) ? doc.attributes : [];
          const fileAttr = attrs.find((a) => a._ === 'documentAttributeFilename');
          const audioAttr = attrs.find((a) => a._ === 'documentAttributeAudio');
          const videoAttr = attrs.find((a) => a._ === 'documentAttributeVideo');

          if (mime.startsWith('video/') || videoAttr || doc.type === 'video' || doc.type === 'gif') {
            isVideo = true;
            videoDuration = fmtDur(videoAttr && videoAttr.duration);
            postType = 'video';
            postTypeBadge = videoDuration ? `🎬 [Video ${videoDuration}]` : '🎬 [Video]';
            mediaNotice = videoDuration ? `🎬 Video (${videoDuration})` : '🎬 Video';
          } else if (audioAttr || mime.startsWith('audio/') || doc.type === 'voice' || doc.type === 'audio') {
            isAudio = true;
            const dur = fmtDur(audioAttr && audioAttr.duration);
            const isVoice = Boolean((audioAttr && audioAttr.voice) || doc.type === 'voice');
            if (isVoice) {
              postType = 'voice';
              postTypeBadge = dur ? `🎤 [Voice ${dur}]` : '🎤 [Voice]';
              mediaNotice = dur ? `🎤 Voice message (${dur})` : '🎤 Voice message';
            } else {
              postType = 'audio';
              postTypeBadge = '🎵 [Audio]';
              const trackTitle = [audioAttr && audioAttr.title, audioAttr && audioAttr.performer]
                .filter(Boolean)
                .join(' – ');
              audioLabel = trackTitle || (fileAttr && fileAttr.file_name) || 'Audio track';
              mediaNotice = `🎵 Audio: ${audioLabel}`;
            }
          } else if (fileAttr && fileAttr.file_name) {
            postType = 'file';
            postTypeBadge = '📎 [File]';
            audioLabel = fileAttr.file_name;
            mediaNotice = `📎 File: ${fileAttr.file_name}`;
          }
        } else if (media._ === 'messageMediaPoll' && media.poll) {
          const q =
            (media.poll.question && (media.poll.question.text || media.poll.question)) || 'Poll';
          postType = 'poll';
          postTypeBadge = '📊 [Poll]';
          audioLabel = q;
          mediaNotice = `📊 Poll: ${q}`;
        } else if (media._ === 'messageMediaWebPage' && media.webpage) {
          const wp = media.webpage;
          if (wp.title && !rawText.includes(wp.title)) {
            wpSummary = [`🔗 ${wp.title}`, wp.description || '', wp.url || '']
              .filter(Boolean)
              .join('\n');
          }
        }
      }

      const bodyParts = [];
      if (mediaNotice) bodyParts.push(mediaNotice);
      if (rawText) bodyParts.push(rawText);
      if (wpSummary) bodyParts.push(wpSummary);
      const caption = bodyParts.join('\n\n');

      if (!caption && !media) continue;

      const firstLineText = rawText ? rawText.split('\n').find((l) => l.trim()) || '' : '';
      let title = '';
      if (postType === 'audio' || postType === 'file') {
        title = firstLineText
          ? `${postTypeBadge} ${audioLabel} — ${firstLineText}`
          : `${postTypeBadge} ${audioLabel}`;
      } else if (postType === 'voice') {
        title = firstLineText
          ? `${postTypeBadge} ${firstLineText}`
          : `${postTypeBadge} Voice message`;
      } else if (postType === 'video') {
        title = firstLineText
          ? `${postTypeBadge} ${firstLineText}`
          : `${postTypeBadge} Video post`;
      } else if (postType === 'photo') {
        title = firstLineText
          ? `${postTypeBadge} ${firstLineText}`
          : `${postTypeBadge} Photo post`;
      } else if (postType === 'poll') {
        title = `${postTypeBadge} ${audioLabel}`;
      } else {
        title = `${postTypeBadge} ${firstLineText || caption || `Post #${postId}`}`;
      }
      if (title.length > 130) {
        title = title.slice(0, 127) + '…';
      }

      let reactionsCount = 0;
      if (msg.reactions && Array.isArray(msg.reactions.results)) {
        for (const r of msg.reactions.results) {
          reactionsCount += Number(r.count || 0);
        }
      }
      const viewsCount = Number(msg.views || 0);
      const commentsCount = Number((msg.replies && msg.replies.replies) || 0);
      const timestamp = msg.date
        ? new Date(Number(msg.date) * 1000).toISOString()
        : new Date().toISOString();

      const permalink = publicUsername
        ? `https://t.me/${publicUsername}/${postId}`
        : `https://t.me/c/${chatId}/${postId}`;

      const entry = {
        id: postId,
        shortcode: postId,
        title,
        caption,
        postType,
        postTypeBadge,
        timestamp,
        imageUrl: null,
        displayUrl: null,
        images: [],
        videoUrl: null,
        audioUrl: null,
        audioTitle: postType === 'audio' ? audioLabel : null,
        videoDuration: videoDuration || null,
        isVideo,
        isAudio,
        likes: reactionsCount || viewsCount,
        comments: commentsCount,
        permalink,
        albumCount: 1,
      };

      groupedMap.set(groupKey, entry);
      orderedEntries.push(entry);
    }

    const canonicalUsername = publicUsername || `c/${chatId}`;

    return {
      username: canonicalUsername,
      chatId: String(chatId),
      isPrivate: !publicUsername,
      fullName,
      bio,
      profilePicUrl: 'https://telegram.org/img/apple-touch-icon.png',
      posts: orderedEntries,
      scrapedAt: new Date().toISOString(),
    };
  } catch (err) {
    return { error: err.message || String(err) };
  }
}

/**
 * List all channels (private & public) that the logged-in Telegram user is a member of.
 * Used for the Telegram channel picker UI so users can easily add private channels.
 */
async function listTelegramChannels() {
  let BrowserWindow;
  try {
    ({ BrowserWindow } = require('electron'));
  } catch {
    throw new Error('Electron runtime is required to list Telegram channels.');
  }

  const hidden = new BrowserWindow({
    width: 1000,
    height: 750,
    show: false,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  const chromeUA = getRealisticUserAgent();
  hidden.webContents.session.setUserAgent(chromeUA);
  hidden.webContents.setUserAgent(chromeUA);

  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Timed out loading Telegram Web.'));
      }, 30000);

      hidden.webContents.once('did-finish-load', () => {
        clearTimeout(timeout);
        resolve();
      });
      hidden.webContents.once('did-fail-load', (_e, code, desc) => {
        clearTimeout(timeout);
        reject(new Error(`Failed to load Telegram Web: ${desc} (${code})`));
      });

      hidden.loadURL('https://web.telegram.org/k/');
    });

    const result = await hidden.webContents.executeJavaScript(
      `(${async function () {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const userAuthRaw = localStorage.getItem('user_auth') || localStorage.getItem('account1');
        if (!userAuthRaw) {
          return { error: 'Not logged into Telegram. Click the Telegram badge in the top bar first.' };
        }
        let managers = null;
        for (let i = 0; i < 60; i++) {
          if (
            window.rootScope &&
            window.rootScope.managers &&
            window.rootScope.managers.dialogsStorage &&
            window.rootScope.managers.appChatsManager
          ) {
            managers = window.rootScope.managers;
            break;
          }
          await sleep(250);
        }
        if (!managers) {
          return { error: 'Telegram Web managers did not initialize in time.' };
        }

        const channels = [];
        const seenIds = new Set();
        let offsetIndex = 0;

        for (let page = 0; page < 3; page++) {
          let res;
          try {
            res = await managers.dialogsStorage.getDialogs({ limit: 100, offsetIndex });
          } catch {
            break;
          }
          const dialogs = (res && res.dialogs) || [];
          if (dialogs.length === 0) break;

          for (const d of dialogs) {
            const peerId = Number(d.peerId || 0);
            if (peerId >= 0) continue; // Only negative peerIds are chats/channels
            const chatId = Math.abs(peerId);
            if (seenIds.has(chatId)) continue;
            seenIds.add(chatId);

            try {
              const chat = await managers.appChatsManager.getChat(chatId);
              if (!chat) continue;
              // Include broadcast channels and supergroups/megagroups
              if (chat._ === 'channel' || chat._ === 'chat') {
                const publicUsername =
                  chat.username ||
                  (Array.isArray(chat.usernames) &&
                    chat.usernames[0] &&
                    chat.usernames[0].username) ||
                  null;
                const isPrivate = !publicUsername;
                const isBroadcast = Boolean(chat.pFlags && chat.pFlags.broadcast);
                channels.push({
                  chatId: String(chatId),
                  title: chat.title || publicUsername || `Channel ${chatId}`,
                  username: publicUsername ? publicUsername : `c/${chatId}`,
                  url: publicUsername
                    ? `https://t.me/${publicUsername}`
                    : `https://t.me/c/${chatId}`,
                  isPrivate,
                  isBroadcast,
                });
              }
            } catch {
              // Ignore individual chat lookup error
            }
          }

          if (res.isEnd || dialogs.length < 100) break;
          const lastDialog = dialogs[dialogs.length - 1];
          offsetIndex = lastDialog && lastDialog.index ? lastDialog.index : 0;
          if (!offsetIndex) break;
        }

        return { channels };
      }.toString()})()`,
      true
    );

    if (result && result.error) {
      throw new Error(result.error);
    }
    return (result && result.channels) || [];
  } finally {
    if (!hidden.isDestroyed()) hidden.destroy();
  }
}

/**
 * Unified entry point to scrape either a public or private Telegram channel.
 *
 * - For public channels (`isPrivate: false`), fetches `https://t.me/s/<username>` directly
 *   (fast, zero login required). If the public web preview is disabled on that channel and
 *   the user is logged into Telegram, automatically falls back to `scrapeTelegramWeb`.
 * - For private channels (`c/<chatId>` or `invite/<hash>`), uses `scrapeTelegramWeb`.
 */
async function scrapeTelegramChannel(inputOrUsername, options = {}) {
  const parsed =
    typeof inputOrUsername === 'object' && inputOrUsername !== null
      ? inputOrUsername
      : parseTelegramInput(String(inputOrUsername)) || {
          platform: 'telegram',
          username: String(inputOrUsername).replace(/^@/, '').trim(),
          isPrivate:
            String(inputOrUsername).startsWith('c/') ||
            String(inputOrUsername).startsWith('invite/'),
        };

  if (parsed.isPrivate || parsed.username.startsWith('c/') || parsed.username.startsWith('invite/')) {
    return scrapeTelegramWeb({ ...parsed, ...options });
  }

  // Public channel: scrape https://t.me/s/<username> without authentication
  const publicResult = await scrapeTelegramPublic(parsed.username);

  if (publicResult.posts.length > 0) {
    return publicResult;
  }

  // If 0 posts were returned from t.me/s/<username> (e.g. channel disabled public web preview)
  // and the user is logged into Telegram in Electron, try authenticated Telegram Web K fallback
  if (options.telegramLoggedIn) {
    try {
      const webResult = await scrapeTelegramWeb({ ...parsed, ...options });
      if (webResult && Array.isArray(webResult.posts) && webResult.posts.length > 0) {
        return webResult;
      }
    } catch {
      // Fall through to descriptive error below
    }
  }

  if (publicResult.previewUnavailable && !publicResult.channelExists) {
    throw new Error(
      `Telegram channel "${parsed.username}" was not found or has no public preview. If this is a private channel, log into Telegram first and use its t.me/c/... or invite link.`
    );
  }

  if (publicResult.previewUnavailable && publicResult.channelExists) {
    throw new Error(
      `Telegram channel "@${parsed.username}" has public web preview disabled on t.me/s/${parsed.username}. Log into Telegram using the badge at the top to fetch it with your account.`
    );
  }

  return publicResult;
}

module.exports = {
  parseTelegramInput,
  scrapeTelegramPublic,
  scrapeTelegramWeb,
  scrapeTelegramChannel,
  listTelegramChannels,
};

