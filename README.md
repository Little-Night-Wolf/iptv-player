# IPTV Player

A lightweight static IPTV/Radio player — no server needed. Just open `index.html` in a browser or publish to GitHub Pages.

## Features

- Load M3U/M3U8 playlists via URL, paste, or file upload
- Playlists saved in browser localStorage (persist across sessions)
- Search channels by name or category
- Filter by category and playlist
- HLS.js streaming (M3U8 support)
- Radio stream support (audio-only channels)
- Reconnects to live stream on unpause
- Keyboard shortcuts: `Space` play/pause, `M` mute, `↑↓` volume, `Esc` close

## How to publish on GitHub Pages

1. Create a new GitHub repository
2. Upload `index.html`, `style.css`, and `app.js`
3. Go to **Settings → Pages → Source → main branch**
4. Your player will be live at `https://yourusername.github.io/yourrepo/`

## Files

| File | Description |
|------|-------------|
| `index.html` | Main HTML structure |
| `style.css` | Dark theme styles |
| `app.js` | All player logic (M3U parser, HLS player, localStorage) |

## Notes

- Loading playlists from external URLs may fail due to browser CORS restrictions. Use **Paste** or **File Upload** instead when that happens.
- HLS.js is loaded from CDN — requires internet connection.
