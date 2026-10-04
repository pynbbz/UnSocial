const { Feed } = require('feed');
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { resolveFeedBaseUrl } = require('./feed-url-base');

/**
 * Generate an RSS/Atom feed XML file for a given profile.
 * Feeds are stored in the app's userData directory under `feeds/`.
 * @param {string} platform - 'instagram' or 'twitter'
 */
async function generateFeed(username, profileData, store, platform) {
  platform = platform || 'instagram';
  username = String(username || '');
  const feedDir = getFeedDir();
  if (!fs.existsSync(feedDir)) {
    fs.mkdirSync(feedDir, { recursive: true });
  }

  // Platform-specific metadata
  const platformMeta = {
    instagram: {
      siteUrl: `https://www.instagram.com/${username}/`,
      favicon: 'https://www.instagram.com/static/images/ico/favicon-192.png/68d99ba29cc8.png',
      label: 'Instagram',
    },
    twitter: {
      siteUrl: `https://x.com/${username}`,
      favicon: 'https://abs.twimg.com/icons/apple-touch-icon-192x192.png',
      label: 'Twitter / X',
    },
    facebook: {
      siteUrl: `https://www.facebook.com/${username}`,
      favicon: 'https://www.facebook.com/images/fb_icon_325x325.png',
      label: username.startsWith('groups/') ? 'Facebook Group' :
             username.startsWith('events/') ? 'Facebook Event' : 'Facebook',
    },
    linkedin: {
      siteUrl: (username.startsWith('company/') || username.startsWith('showcase/') || username.startsWith('school/'))
        ? `https://www.linkedin.com/${username}`
        : `https://www.linkedin.com/in/${username}`,
      favicon: 'https://upload.wikimedia.org/wikipedia/commons/c/ca/LinkedIn_logo_initials.png',
      label: username.startsWith('company/') ? 'LinkedIn Company' :
             username.startsWith('showcase/') ? 'LinkedIn Showcase' :
             username.startsWith('school/') ? 'LinkedIn School' : 'LinkedIn',
    },
    txt: {
      siteUrl: profileData.biography || '',
      favicon: 'https://cdn-icons-png.flaticon.com/512/337/337956.png',
      label: 'Text',
    },
    custom: {
      siteUrl: profileData.biography || `https://${username}`,
      favicon: 'https://cdn-icons-png.flaticon.com/512/1006/1006771.png',
      label: 'Custom',
    },
    reddit: {
      siteUrl: profileData.fullUrl || profileData.siteUrl || (username.startsWith('http') ? username : `https://www.reddit.com/${username}`),
      favicon: 'https://www.redditstatic.com/shreddit/assets/favicon/192x192.png',
      label: 'Reddit',
    },
  };

  const meta = platformMeta[platform] || platformMeta.instagram;
  const siteUrl = meta.siteUrl;
  const feedBase = resolveFeedBaseUrl(store);
  const feedKey = profileData.feedKey || username.replace(/[\/\\?%*:|"<>]/g, '-');
  const selfUrl = `${feedBase}/feed/${feedKey}`;

  const feedTitle = platform === 'reddit'
    ? (profileData.alias || profileData.fullName || username)
    : `${profileData.fullName || username} (@${username}) – ${meta.label}`;

  const feed = new Feed({
    title: feedTitle,
    description: profileData.biography || `${meta.label} posts from ${username}`,
    id: siteUrl,
    link: siteUrl,
    language: 'en',
    image: meta.favicon,
    favicon: meta.favicon,
    updated: profileData.posts.length
      ? new Date(profileData.posts[0].timestamp)
      : new Date(),
    feedLinks: {
      rss: selfUrl,
      atom: `${selfUrl}?format=atom`,
    },
    author: {
      name: profileData.fullName || username,
      link: siteUrl,
    },
  });

  for (let i = 0; i < Math.min(profileData.posts.length, 25); i++) {
    const post = profileData.posts[i];
    const rawCaption = post.caption || '';
    const isAiGuess = isAccessibilityCaption(rawCaption);
    const displayCaption = isAiGuess ? '' : rawCaption;

    const title = post.title || truncate(displayCaption || `Post by ${username}`, 120);
    const altText = isAiGuess ? escapeHtml(rawCaption) : 'Post image';
    let postImg = post.imageUrl || (post.media && post.media.find(m => m.type === 'image')?.url);
    const postVid = post.videoUrl || (post.media && post.media.find(m => m.type === 'video')?.url);
    const isVideo = Boolean(post.isVideo || postVid);

    const cleanAuthor = (post.author || '').replace(/^u\//i, '');
    const authorLine = cleanAuthor ? `Posted by u/${escapeHtml(cleanAuthor)} · ` : '';
    const likesCount = (post.score !== undefined ? post.score : post.likes) ?? 0;
    const commentsCount = (post.commentCount !== undefined ? post.commentCount : post.comments) ?? 0;
    const formattedLikes = Number(likesCount).toLocaleString();
    const formattedComments = Number(commentsCount).toLocaleString();
    const statsHtml = `<p><small>${authorLine}${platform === 'reddit' ? '🔺' : '❤️'} ${formattedLikes} · 💬 ${formattedComments}</small></p>`;

    const isDirectExternal = Boolean(profileData.directExternalLink && post.externalUrl && post.externalUrl !== post.permalink);
    const primaryLink = isDirectExternal ? post.externalUrl : (post.permalink || siteUrl);
    const primaryId = post.permalink || `${siteUrl}#${post.id || i}`;

    const ytId = extractYouTubeId(post.externalUrl || post.contentHref);

    let imageHtml = postImg
      ? `<p><img src="${escapeHtml(postImg)}" alt="${altText}" style="max-width:100%;" /></p>`
      : '';
    let videoHtml = isVideo && postVid
      ? `<p><video src="${escapeHtml(postVid)}" controls style="max-width:100%;"></video></p>`
      : '';
    const captionHtml = displayCaption && displayCaption !== post.title && displayCaption !== `u/${post.author}` && displayCaption !== post.externalUrl
      ? `<p>${escapeHtml(displayCaption).replace(/\n/g, '<br/>')}</p>`
      : '';

    let externalMediaHtml = '';
    if (isDirectExternal) {
      if (ytId) {
        if (!postImg) {
          postImg = `https://img.youtube.com/vi/${ytId}/hqdefault.jpg`;
        }
        externalMediaHtml = `
<p><iframe width="100%" height="360" src="https://www.youtube-nocookie.com/embed/${ytId}" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen style="max-width:100%; aspect-ratio:16/9; border-radius:8px;"></iframe></p>
<p><a href="${escapeHtml(post.externalUrl)}" target="_blank" rel="noopener"><img src="https://img.youtube.com/vi/${ytId}/hqdefault.jpg" alt="${escapeHtml(title)}" style="max-width:100%; border-radius:8px;" /></a></p>
<p>▶️ <a href="${escapeHtml(post.externalUrl)}" target="_blank" rel="noopener"><strong>Watch Video (${escapeHtml(post.externalUrl)})</strong></a></p>
<p>💬 <a href="${escapeHtml(post.permalink)}" target="_blank" rel="noopener">View Discussion on Reddit (${formattedComments} comments)</a></p>
`;
        imageHtml = '';
        videoHtml = '';
      } else {
        externalMediaHtml = `
<p>🔗 <a href="${escapeHtml(post.externalUrl)}" target="_blank" rel="noopener"><strong>Open Source: ${escapeHtml(post.externalUrl)}</strong></a></p>
<p>💬 <a href="${escapeHtml(post.permalink)}" target="_blank" rel="noopener">View Discussion on Reddit (${formattedComments} comments)</a></p>
`;
      }
    } else {
      const extUrl = post.externalUrl && post.externalUrl !== post.permalink ? post.externalUrl : null;
      if (extUrl) {
        externalMediaHtml = `<p><a href="${escapeHtml(extUrl)}" target="_blank" rel="noopener">🔗 View Source Article</a></p>`;
      }
    }

    feed.addItem({
      title,
      id: primaryId,
      link: primaryLink,
      description: truncate(displayCaption || title, 300),
      content: `${imageHtml}${videoHtml}${externalMediaHtml}${captionHtml}${statsHtml}`,
      date: new Date(post.timestamp),
      image: postImg || undefined,
      author: [
        {
          name: cleanAuthor ? `u/${cleanAuthor}` : (profileData.fullName || username),
          link: cleanAuthor ? `https://www.reddit.com/user/${cleanAuthor}` : siteUrl,
        },
      ],
    });
  }

  // Write both RSS 2.0 and Atom
  let rssXml = feed.rss2();
  // Fix unescaped ampersands in enclosure URLs for strict XML parsers (e.g. FreshRSS / SimplePie)
  rssXml = rssXml.replace(/<enclosure\s+url="([^"]+)"/g, (match, url) => {
    return `<enclosure url="${url.replace(/&/g, "&amp;").replace(/&amp;amp;/g, "&amp;")}"`;
  });
  const atomXml = feed.atom1();

  fs.writeFileSync(path.join(feedDir, `${feedKey}.rss.xml`), rssXml, 'utf-8');
  fs.writeFileSync(path.join(feedDir, `${feedKey}.atom.xml`), atomXml, 'utf-8');

  return { rss: rssXml, atom: atomXml };
}

function getFeedDir() {
  if (app && typeof app.getPath === 'function') {
    return path.join(app.getPath('userData'), 'feeds');
  }
  return path.join(require('os').tmpdir(), 'unsocial-feeds');
}

function truncate(str, max) {
  if (str.length <= max) return str;
  return str.slice(0, max - 1) + '…';
}

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function isAccessibilityCaption(text) {
  if (!text || typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (/^Photo (?:by|shared by) .+ on [A-Za-z]+ \d{1,2}, \d{4}\./i.test(trimmed)) return true;
  if (/^May be (?:an? |the )?(?:image|cartoon|graphic|photo|illustration|drawing|poster|text) of /i.test(trimmed)) return true;
  if (/^No photo description available/i.test(trimmed)) return true;
  return false;
}

function extractYouTubeId(url) {
  if (!url || typeof url !== 'string') return null;
  const m = url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:.*&)?v=|(?:embed|v|shorts)\/))([a-zA-Z0-9_-]{11})/i);
  return m ? m[1] : null;
}

module.exports = { generateFeed, getFeedDir, extractYouTubeId };

