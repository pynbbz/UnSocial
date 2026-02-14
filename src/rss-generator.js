const { Feed } = require('feed');
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

/**
 * Generate an RSS/Atom feed XML file for a given profile.
 * Feeds are stored in the app's userData directory under `feeds/`.
 * @param {string} platform - 'instagram' or 'twitter'
 */
async function generateFeed(username, profileData, store, platform) {
  platform = platform || 'instagram';
  const feedDir = getFeedDir();
  if (!fs.existsSync(feedDir)) {
    fs.mkdirSync(feedDir, { recursive: true });
  }

  const port = store.get('serverPort');

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
      siteUrl: `https://www.linkedin.com/in/${username}`,
      favicon: 'https://upload.wikimedia.org/wikipedia/commons/c/ca/LinkedIn_logo_initials.png',
      label: username.startsWith('company/') ? 'LinkedIn Company' : 'LinkedIn',
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
  };

  const meta = platformMeta[platform] || platformMeta.instagram;
  const siteUrl = meta.siteUrl;
  const selfUrl = `http://localhost:${port}/feed/${username}`;

  const feed = new Feed({
    title: `${profileData.fullName || username} (@${username}) – ${meta.label}`,
    description: profileData.biography || `${meta.label} posts from @${username}`,
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

  for (const post of profileData.posts.slice(0, 10)) {
    const title = truncate(post.caption || '(no caption)', 120);
    const imageHtml = post.imageUrl
      ? `<p><img src="${escapeHtml(post.imageUrl)}" alt="Post image" style="max-width:100%;" /></p>`
      : '';
    const videoHtml = post.isVideo && post.videoUrl
      ? `<p><video src="${escapeHtml(post.videoUrl)}" controls style="max-width:100%;"></video></p>`
      : '';
    const captionHtml = post.caption
      ? `<p>${escapeHtml(post.caption).replace(/\n/g, '<br/>')}</p>`
      : '';
    const statsHtml = `<p><small>❤️ ${post.likes} · 💬 ${post.comments}</small></p>`;

    feed.addItem({
      title,
      id: post.permalink,
      link: post.permalink,
      description: truncate(post.caption || '', 300),
      content: `${imageHtml}${videoHtml}${captionHtml}${statsHtml}`,
      date: new Date(post.timestamp),
      image: post.imageUrl || undefined,
      author: [
        {
          name: profileData.fullName || username,
          link: siteUrl,
        },
      ],
    });
  }

  // Write both RSS 2.0 and Atom
  const rssXml = feed.rss2();
  const atomXml = feed.atom1();

  fs.writeFileSync(path.join(feedDir, `${username}.rss.xml`), rssXml, 'utf-8');
  fs.writeFileSync(path.join(feedDir, `${username}.atom.xml`), atomXml, 'utf-8');

  return { rss: rssXml, atom: atomXml };
}

function getFeedDir() {
  return path.join(app.getPath('userData'), 'feeds');
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

module.exports = { generateFeed, getFeedDir };
