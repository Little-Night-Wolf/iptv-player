// ─────────────────────────────────────────────
//  IPTV PLAYER  –  static HTML/JS/JSON edition
// ─────────────────────────────────────────────

// ══════════════════════════════════════════════
//  STORAGE
// ══════════════════════════════════════════════
const Storage = {
  KEY: 'iptv_playlists_v2',

  load() {
    try { return JSON.parse(localStorage.getItem(this.KEY) || '[]'); }
    catch { return []; }
  },

  save(playlists) {
    localStorage.setItem(this.KEY, JSON.stringify(playlists));
  },

  add(playlist) {
    const list = this.load();
    list.push(playlist);
    this.save(list);
  },

  remove(id) {
    this.save(this.load().filter(p => p.id !== id));
  },

  update(id, data) {
    this.save(this.load().map(p => p.id === id ? { ...p, ...data } : p));
  }
};

// ══════════════════════════════════════════════
//  M3U PARSER
// ══════════════════════════════════════════════
const Parser = {
  parse(content) {
    const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    const channels = [];
    let meta = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      if (line.startsWith('#EXTINF')) {
        meta = this._parseMeta(line);
      } else if (!line.startsWith('#') && line.length > 3) {
        const url = line;
        const ch = {
          id: uid(),
          name: (meta && meta.name) || 'Unknown',
          logo: (meta && meta.logo) || '',
          group: (meta && meta.group) || 'General',
          tvgId: (meta && meta.tvgId) || '',
          url,
          isRadio: this._isRadio(url, (meta && meta.group) || '', (meta && meta.name) || '')
        };
        channels.push(ch);
        meta = null;
      }
    }

    return channels;
  },

  _parseMeta(line) {
    const get = (attr) => {
      const re = new RegExp(`${attr}="([^"]*)"`, 'i');
      const m = re.exec(line);
      return m ? m[1].trim() : '';
    };

    let name = get('tvg-name');
    const commaIdx = line.lastIndexOf(',');
    if (commaIdx !== -1) {
      const afterComma = line.slice(commaIdx + 1).trim();
      if (afterComma) name = afterComma;
    }

    return {
      name: name || 'Unknown',
      logo: get('tvg-logo'),
      group: get('group-title') || 'General',
      tvgId: get('tvg-id')
    };
  },

  _isRadio(url, group, name) {
    const gl = group.toLowerCase();
    const nl = name.toLowerCase();
    const ul = url.toLowerCase();
    return gl.includes('radio') || gl.includes('music') ||
           nl.includes('radio') || nl.includes('fm ') || nl.includes(' fm') ||
           ul.endsWith('.mp3') || ul.endsWith('.aac') || ul.endsWith('.ogg');
  }
};

// ══════════════════════════════════════════════
//  PLAYER
// ══════════════════════════════════════════════
const Player = {
  hls: null,
  currentChannel: null,
  isPlaying: false,
  isRadio: false,

  video: null,   // hls-video element
  audio: null,   // audio element

  init() {
    this.video = document.getElementById('hls-video');
    this.audio = document.getElementById('audio-el');

    this.video.addEventListener('playing', () => this._onPlaying());
    this.video.addEventListener('waiting', () => this._onWaiting());
    this.video.addEventListener('pause', () => this._onPause());
    this.video.addEventListener('error', () => this._onError());

    this.audio.addEventListener('playing', () => this._onPlaying());
    this.audio.addEventListener('waiting', () => this._onWaiting());
    this.audio.addEventListener('pause', () => this._onPause());
    this.audio.addEventListener('error', () => this._onError());
  },

  play(channel) {
    this.currentChannel = channel;
    this.isRadio = channel.isRadio;
    this._destroyHls();

    if (channel.isRadio) {
      this.video.pause();
      this.audio.src = channel.url;
      this.audio.volume = UI.getVolume();
      this.audio.play().catch(() => {});
    } else {
      this.audio.pause();
      this._loadHls(channel.url);
    }

    UI.showPlayerBar(channel);
    UI.setSpinner(true);
  },

  _loadHls(url) {
    const video = this.video;
    video.volume = UI.getVolume();

    if (Hls.isSupported()) {
      this.hls = new Hls({
        enableWorker: true,
        lowLatencyMode: true,
        backBufferLength: 90
      });
      this.hls.loadSource(url);
      this.hls.attachMedia(video);
      this.hls.on(Hls.Events.MANIFEST_PARSED, () => {
        video.play().catch(() => {});
      });
      this.hls.on(Hls.Events.ERROR, (_, data) => {
        if (data.fatal) this._onError();
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = url;
      video.play().catch(() => {});
    } else {
      showToast('HLS not supported in this browser');
    }
  },

  togglePlay() {
    if (!this.currentChannel) return;
    const el = this.isRadio ? this.audio : this.video;

    if (this.isPlaying) {
      el.pause();
    } else {
      // Reconnect to live on resume
      if (this.isRadio) {
        this.audio.src = this.currentChannel.url;
        this.audio.play().catch(() => {});
      } else if (this.hls) {
        this.hls.loadSource(this.currentChannel.url);
        this.video.play().catch(() => {});
      } else {
        this.video.play().catch(() => {});
      }
    }
  },

  setVolume(v) {
    this.video.volume = v;
    this.audio.volume = v;
  },

  setMuted(m) {
    this.video.muted = m;
    this.audio.muted = m;
  },

  stop() {
    this._destroyHls();
    this.video.pause();
    this.video.src = '';
    this.audio.pause();
    this.audio.src = '';
    this.currentChannel = null;
    this.isPlaying = false;
    UI.hidePlayerBar();
    UI.renderChannels();
  },

  enterFullscreen() {
    if (!this.currentChannel || this.isRadio) return;

    const overlay = document.getElementById('video-overlay');
    const overlayVideo = document.getElementById('overlay-video');
    const nameEl = document.getElementById('overlay-ch-name');

    nameEl.textContent = this.currentChannel.name;
    overlay.classList.add('visible');

    // Reattach HLS to overlay video
    if (this.hls) {
      this.hls.detachMedia();
      this.hls.attachMedia(overlayVideo);
      overlayVideo.play().catch(() => {});
    } else {
      overlayVideo.src = this.currentChannel.url;
      overlayVideo.play().catch(() => {});
    }
  },

  exitFullscreen() {
    const overlay = document.getElementById('video-overlay');
    const overlayVideo = document.getElementById('overlay-video');
    overlay.classList.remove('visible');

    overlayVideo.pause();
    overlayVideo.src = '';

    // Re-attach HLS to bar video
    if (this.hls && this.currentChannel && !this.isRadio) {
      this.hls.detachMedia();
      this.hls.attachMedia(this.video);
      this.video.play().catch(() => {});
    }
  },

  _destroyHls() {
    if (this.hls) {
      this.hls.destroy();
      this.hls = null;
    }
  },

  _onPlaying() {
    this.isPlaying = true;
    UI.setSpinner(false);
    UI.setPlayState(true);
  },

  _onWaiting() {
    UI.setSpinner(true);
  },

  _onPause() {
    this.isPlaying = false;
    UI.setPlayState(false);
  },

  _onError() {
    UI.setSpinner(false);
    showToast('Stream error – try again');
    this.isPlaying = false;
    UI.setPlayState(false);
  }
};

// ══════════════════════════════════════════════
//  UI
// ══════════════════════════════════════════════
const UI = {
  activePlaylistId: 'all',
  searchQuery: '',
  activeGroup: '',
  volValue: 0.9,

  init() {
    this._bindHeader();
    this._bindPlayerBar();
    this._bindModal();
    this._bindSidebar();
    this._bindKeyboard();
    this.renderAll();
  },

  // ── DATA ──
  getPlaylists() { return Storage.load(); },

  getAllChannels() {
    return this.getPlaylists().flatMap(p => p.channels || []);
  },

  getVisibleChannels() {
    let ch = this.activePlaylistId === 'all'
      ? this.getAllChannels()
      : (this.getPlaylists().find(p => p.id === this.activePlaylistId)?.channels || []);

    if (this.activeGroup) ch = ch.filter(c => c.group === this.activeGroup);
    if (this.searchQuery) {
      const q = this.searchQuery.toLowerCase();
      ch = ch.filter(c => c.name.toLowerCase().includes(q) || c.group.toLowerCase().includes(q));
    }
    return ch;
  },

  getVolume() { return this.volValue; },

  // ── RENDER ──
  renderAll() {
    this.renderSidebar();
    this.renderGroupFilter();
    this.renderChannels();
  },

  renderSidebar() {
    const playlists = this.getPlaylists();
    const total = this.getAllChannels().length;
    document.getElementById('all-count').textContent = total;

    const list = document.getElementById('playlist-list');
    list.innerHTML = '';

    playlists.forEach(p => {
      const div = document.createElement('div');
      div.className = 'playlist-item' + (this.activePlaylistId === p.id ? ' active' : '');
      div.dataset.id = p.id;
      div.innerHTML = `
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/>
          <line x1="8" y1="18" x2="21" y2="18"/>
          <line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/>
          <line x1="3" y1="18" x2="3.01" y2="18"/>
        </svg>
        <span class="pi-name" title="${esc(p.name)}">${esc(p.name)}</span>
        <span class="pi-count">${(p.channels || []).length}</span>
        <button class="playlist-del" data-id="${p.id}" title="Remove playlist">&times;</button>
      `;
      list.appendChild(div);
    });

    // Update "all" active state
    document.querySelectorAll('.sidebar-all .playlist-item').forEach(el => {
      el.classList.toggle('active', this.activePlaylistId === 'all');
    });
  },

  renderGroupFilter() {
    const channels = this.activePlaylistId === 'all'
      ? this.getAllChannels()
      : (this.getPlaylists().find(p => p.id === this.activePlaylistId)?.channels || []);

    const groups = [...new Set(channels.map(c => c.group).filter(Boolean))].sort();
    const sel = document.getElementById('group-filter');
    const current = sel.value;
    sel.innerHTML = '<option value="">All categories</option>';
    groups.forEach(g => {
      const opt = document.createElement('option');
      opt.value = g;
      opt.textContent = g;
      if (g === current) opt.selected = true;
      sel.appendChild(opt);
    });
    if (!groups.includes(this.activeGroup)) this.activeGroup = '';
  },

  renderChannels() {
    const grid = document.getElementById('channels-grid');
    const channels = this.getVisibleChannels();
    const playingId = Player.currentChannel?.id;

    if (channels.length === 0) {
      const hasPlaylists = this.getPlaylists().length > 0;
      grid.innerHTML = `
        <div class="empty-state">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <rect x="2" y="7" width="20" height="15" rx="2"/>
            <path d="M17 2H7l-1 5h12l-1-5z"/>
          </svg>
          <h3>${hasPlaylists ? 'No channels match' : 'No playlists yet'}</h3>
          <p>${hasPlaylists ? 'Try a different search or filter.' : 'Click <strong>Add Playlist</strong> to get started.'}</p>
        </div>`;
      return;
    }

    grid.innerHTML = '';
    channels.forEach(ch => {
      const card = document.createElement('div');
      card.className = 'channel-card' + (ch.id === playingId ? ' playing' : '');
      card.dataset.id = ch.id;

      const logo = ch.logo
        ? `<img class="ch-logo" src="${esc(ch.logo)}" alt="" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
          + `<div class="ch-logo-placeholder" style="display:none">${ch.name.charAt(0).toUpperCase()}</div>`
        : `<div class="ch-logo-placeholder">${ch.name.charAt(0).toUpperCase()}</div>`;

      card.innerHTML = `
        ${ch.id === playingId ? '<div class="ch-playing-badge"></div>' : ''}
        ${logo}
        <div class="ch-name">${esc(ch.name)}</div>
        <div class="ch-group">${esc(ch.group)}</div>
      `;

      card.addEventListener('click', () => this.playChannel(ch));
      grid.appendChild(card);
    });
  },

  playChannel(ch) {
    Player.play(ch);
    this.renderChannels();
  },

  // ── PLAYER BAR ──
  showPlayerBar(channel) {
    const bar = document.getElementById('player-bar');
    bar.classList.add('visible');

    document.getElementById('player-name').textContent = channel.name;
    document.getElementById('player-group').textContent = channel.group;

    const ph = document.getElementById('player-logo-ph');
    const img = document.getElementById('player-logo');

    if (channel.logo) {
      img.src = channel.logo;
      img.style.display = '';
      img.onerror = () => { img.style.display = 'none'; ph.style.display = ''; };
      ph.style.display = 'none';
      ph.textContent = channel.name.charAt(0).toUpperCase();
    } else {
      img.style.display = 'none';
      ph.style.display = '';
      ph.textContent = channel.name.charAt(0).toUpperCase();
    }

    const radioViz = document.getElementById('radio-viz');
    radioViz.style.display = channel.isRadio ? 'flex' : 'none';

    const fsBtn = document.getElementById('fullscreen-btn');
    fsBtn.style.display = channel.isRadio ? 'none' : '';
  },

  hidePlayerBar() {
    document.getElementById('player-bar').classList.remove('visible');
    document.getElementById('video-overlay').classList.remove('visible');
  },

  setSpinner(v) {
    document.getElementById('player-spinner').style.display = v ? '' : 'none';
  },

  setPlayState(playing) {
    document.getElementById('icon-play').style.display = playing ? 'none' : '';
    document.getElementById('icon-pause').style.display = playing ? '' : 'none';
    const viz = document.getElementById('radio-viz');
    viz.classList.toggle('paused', !playing);
  },

  // ── BINDINGS ──
  _bindHeader() {
    document.getElementById('search').addEventListener('input', e => {
      this.searchQuery = e.target.value.trim();
      this.renderChannels();
    });

    document.getElementById('group-filter').addEventListener('change', e => {
      this.activeGroup = e.target.value;
      this.renderChannels();
    });

    document.getElementById('btn-add-playlist').addEventListener('click', () => openModal());
  },

  _bindPlayerBar() {
    document.getElementById('play-pause-btn').addEventListener('click', () => {
      Player.togglePlay();
    });

    document.getElementById('mute-btn').addEventListener('click', () => {
      const muted = !this.video?.muted;
      Player.setMuted(muted);
      document.getElementById('icon-vol').style.display = muted ? 'none' : '';
      document.getElementById('icon-mute').style.display = muted ? '' : 'none';
    });

    document.getElementById('vol-slider').addEventListener('input', e => {
      this.volValue = e.target.value / 100;
      Player.setVolume(this.volValue);
    });

    document.getElementById('fullscreen-btn').addEventListener('click', () => {
      Player.enterFullscreen();
    });

    document.getElementById('exit-fullscreen-btn').addEventListener('click', () => {
      Player.exitFullscreen();
    });

    document.getElementById('close-player-btn').addEventListener('click', () => {
      Player.stop();
    });
  },

  _bindSidebar() {
    // "All Channels" item
    document.querySelector('.sidebar-all').addEventListener('click', (e) => {
      if (e.target.closest('.playlist-item')) {
        this.activePlaylistId = 'all';
        this.activeGroup = '';
        document.getElementById('group-filter').value = '';
        this.renderAll();
      }
    });

    // Dynamic playlist items
    document.getElementById('playlist-list').addEventListener('click', (e) => {
      const del = e.target.closest('.playlist-del');
      if (del) {
        e.stopPropagation();
        const id = del.dataset.id;
        if (confirm('Remove this playlist?')) {
          if (Player.currentChannel) {
            const ch = this.getPlaylists().find(p => p.id === id)?.channels || [];
            if (ch.find(c => c.id === Player.currentChannel?.id)) Player.stop();
          }
          Storage.remove(id);
          if (this.activePlaylistId === id) this.activePlaylistId = 'all';
          this.activeGroup = '';
          this.renderAll();
        }
        return;
      }

      const item = e.target.closest('.playlist-item');
      if (item) {
        this.activePlaylistId = item.dataset.id;
        this.activeGroup = '';
        document.getElementById('group-filter').value = '';
        this.renderAll();
      }
    });
  },

  _bindKeyboard() {
    document.addEventListener('keydown', e => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (e.code === 'Space') { e.preventDefault(); Player.togglePlay(); }
      if (e.code === 'KeyM') {
        const muted = !(Player.video?.muted);
        Player.setMuted(muted);
        document.getElementById('icon-vol').style.display = muted ? 'none' : '';
        document.getElementById('icon-mute').style.display = muted ? '' : 'none';
      }
      if (e.code === 'Escape') {
        if (document.getElementById('video-overlay').classList.contains('visible')) {
          Player.exitFullscreen();
        }
        if (document.getElementById('modal-overlay').classList.contains('open')) {
          closeModal();
        }
      }
      if (e.code === 'ArrowUp') {
        const v = Math.min(1, this.volValue + 0.1);
        this.volValue = v;
        Player.setVolume(v);
        document.getElementById('vol-slider').value = Math.round(v * 100);
      }
      if (e.code === 'ArrowDown') {
        const v = Math.max(0, this.volValue - 0.1);
        this.volValue = v;
        Player.setVolume(v);
        document.getElementById('vol-slider').value = Math.round(v * 100);
      }
    });
  },

  _bindModal() {
    // handled by modal functions below
  }
};

// ══════════════════════════════════════════════
//  MODAL
// ══════════════════════════════════════════════
let activeTab = 'url';

function openModal() {
  document.getElementById('modal-overlay').classList.add('open');
  clearModalError();
}

function closeModal() {
  document.getElementById('modal-overlay').classList.remove('open');
  clearModalError();
  document.getElementById('url-input').value = '';
  document.getElementById('url-name').value = '';
  document.getElementById('paste-input').value = '';
  document.getElementById('paste-name').value = '';
  document.getElementById('file-name').value = '';
  document.getElementById('file-input').value = '';
}

function showModalError(msg) {
  const el = document.getElementById('modal-error');
  el.textContent = msg;
  el.classList.add('visible');
}

function clearModalError() {
  document.getElementById('modal-error').classList.remove('visible');
}

function setTab(tab) {
  activeTab = tab;
  document.querySelectorAll('.modal-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  document.querySelectorAll('.modal-tab-panel').forEach(p => p.classList.toggle('active', p.id === `tab-${tab}`));
}

async function savePlaylist() {
  clearModalError();
  let name = '', content = '';

  if (activeTab === 'url') {
    name = document.getElementById('url-name').value.trim();
    const url = document.getElementById('url-input').value.trim();
    if (!url) { showModalError('Please enter a URL.'); return; }
    if (!name) name = new URL(url).hostname || 'Playlist';

    showToast('Fetching playlist…');
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      content = await res.text();
    } catch (e) {
      showModalError(`Could not load URL: ${e.message}. Try Paste or File instead.`);
      return;
    }

  } else if (activeTab === 'paste') {
    name = document.getElementById('paste-name').value.trim() || 'Playlist';
    content = document.getElementById('paste-input').value.trim();
    if (!content) { showModalError('Please paste M3U content.'); return; }

  } else if (activeTab === 'file') {
    name = document.getElementById('file-name').value.trim();
    const file = document.getElementById('file-input').files[0];
    if (!file) { showModalError('Please select a file.'); return; }
    if (!name) name = file.name.replace(/\.(m3u8?|txt)$/i, '');
    content = await readFile(file);
  }

  if (!content.includes('#EXTINF') && !content.includes('#EXTM3U')) {
    showModalError('This does not look like a valid M3U file.');
    return;
  }

  const channels = Parser.parse(content);
  if (channels.length === 0) {
    showModalError('No channels found in this playlist.');
    return;
  }

  const playlist = { id: uid(), name, channels };
  Storage.add(playlist);
  closeModal();
  UI.renderAll();
  showToast(`Loaded ${channels.length} channels from "${name}"`);
}

function readFile(file) {
  return new Promise((res, rej) => {
    const reader = new FileReader();
    reader.onload = e => res(e.target.result);
    reader.onerror = () => rej(new Error('File read error'));
    reader.readAsText(file);
  });
}

// ══════════════════════════════════════════════
//  TOAST
// ══════════════════════════════════════════════
let toastTimer = null;
function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
}

// ══════════════════════════════════════════════
//  UTILS
// ══════════════════════════════════════════════
function uid() {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ══════════════════════════════════════════════
//  BOOTSTRAP
// ══════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
  Player.init();
  UI.init();

  // Modal events
  document.getElementById('modal-cancel').addEventListener('click', closeModal);
  document.getElementById('modal-save').addEventListener('click', savePlaylist);
  document.getElementById('modal-overlay').addEventListener('click', e => {
    if (e.target === document.getElementById('modal-overlay')) closeModal();
  });
  document.querySelectorAll('.modal-tab').forEach(btn => {
    btn.addEventListener('click', () => setTab(btn.dataset.tab));
  });
});
