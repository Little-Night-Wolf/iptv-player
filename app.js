// ─────────────────────────────────────────────
//  IPTV PLAYER - static HTML/JS/JSON edition
// ─────────────────────────────────────────────

// ══════════════════════════════════════════════
//  STORAGE
// ══════════════════════════════════════════════
const Storage = {
  KEY: 'iptv_playlists_v2',
  load()          { try { return JSON.parse(localStorage.getItem(this.KEY) || '[]'); } catch { return []; } },
  save(list)      { localStorage.setItem(this.KEY, JSON.stringify(list)); },
  add(playlist)   { const l = this.load(); l.push(playlist); this.save(l); },
  remove(id)      { this.save(this.load().filter(p => p.id !== id)); },
};

// ══════════════════════════════════════════════
//  M3U PARSER
// ══════════════════════════════════════════════
const Parser = {
  parse(content) {
    const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    const channels = [];
    let meta = null;

    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith('#EXTINF')) {
        meta = this._parseMeta(line);
      } else if (!line.startsWith('#') && line.length > 3) {
        channels.push({
          id:      uid(),
          name:    meta?.name  || 'Unknown',
          logo:    meta?.logo  || '',
          group:   meta?.group || 'General',
          tvgId:   meta?.tvgId || '',
          url:     line,
          isRadio: this._isRadio(line, meta?.group || '', meta?.name || ''),
        });
        meta = null;
      }
    }
    return channels;
  },

  _parseMeta(line) {
    const get = attr => { const m = new RegExp(`${attr}="([^"]*)"`, 'i').exec(line); return m ? m[1].trim() : ''; };
    let name = get('tvg-name');
    const ci = line.lastIndexOf(',');
    if (ci !== -1) { const s = line.slice(ci + 1).trim(); if (s) name = s; }
    return { name: name || 'Unknown', logo: get('tvg-logo'), group: get('group-title') || 'General', tvgId: get('tvg-id') };
  },

  _isRadio(url, group, name) {
    const gl = group.toLowerCase(), nl = name.toLowerCase(), ul = url.toLowerCase();
    return gl.includes('radio') || gl.includes('music') ||
           nl.includes('radio') || /\bfm\b/.test(nl) ||
           ul.endsWith('.mp3') || ul.endsWith('.aac') || ul.endsWith('.ogg');
  },

  // Group channels with same name → multi-source
  deduplicate(channels) {
    const map = new Map();
    for (const ch of channels) {
      const key = ch.name.toLowerCase().trim().replace(/\s+/g, ' ');
      if (!map.has(key)) {
        map.set(key, { ...ch, sources: [{ label: 'Source 1', url: ch.url }] });
      } else {
        const ex = map.get(key);
        ex.sources.push({ label: `Source ${ex.sources.length + 1}`, url: ch.url });
      }
    }
    return Array.from(map.values());
  },
};

// ══════════════════════════════════════════════
//  PLAYER
// ══════════════════════════════════════════════
const Player = {
  hls:            null,
  currentChannel: null,
  currentUrl:     null,
  isPlaying:      false,
  isRadio:        false,
  isMuted:        false,
  volume:         0.9,
  controlsTimer:  null,

  video:   null,
  audio:   null,
  videoCol: null,

  init() {
    this.video    = document.getElementById('main-video');
    this.audio    = document.getElementById('audio-el');
    this.videoCol = document.getElementById('video-col');

    // Click on video area → toggle controls visibility
    //this.video.addEventListener('click', () => this._toggleControls());
    
    // New hide ui system
    this.video.addEventListener('click', () => this.wakeControls());

    const ev = (el, evts, fn) => evts.forEach(e => el.addEventListener(e, fn));
    ev(this.video, ['playing'],  () => this._onPlaying());
    ev(this.video, ['waiting'],  () => this._onWaiting());
    ev(this.video, ['pause'],    () => this._onPause());
    ev(this.video, ['error'],    () => this._onError());
    ev(this.audio, ['playing'],  () => this._onPlayingRadio());
    ev(this.audio, ['waiting'],  () => {});
    ev(this.audio, ['pause'],    () => this._onPauseRadio());
    ev(this.audio, ['error'],    () => this._onError());
  },

  play(channel, url) {
    this.currentChannel = channel;
    this.isRadio = channel.isRadio;
    this.currentUrl = url || channel.url;
    this._destroyHls();

    if (this.isRadio) {
      this._stopVideo();
      this._playAudio(this.currentUrl);
      UI.showRadioBar(channel);
      UI.hideVideoPanel();
    } else {
      this._stopAudio();
      this._loadVideo(this.currentUrl);
      UI.showVideoPanel(channel);
      UI.hideRadioBar();
    }
    UI.renderChannels(); // highlight active
  },

  _playAudio(url) {
    this.audio.src = url;
    this.audio.volume = this.volume;
    this.audio.muted = this.isMuted;
    this.audio.play().catch(() => {});
  },

  _stopAudio() {
    this.audio.pause();
    this.audio.src = '';
  },

  _stopVideo() {
    this._destroyHls();
    this.video.pause();
    this.video.src = '';
  },

  _loadVideo(url) {
    this.video.volume = this.volume;
    this.video.muted  = this.isMuted;
    UI.setSpinner(true);

    if (Hls.isSupported()) {
      this.hls = new Hls({ enableWorker: true, lowLatencyMode: true, backBufferLength: 60 });
      this.hls.loadSource(url);
      this.hls.attachMedia(this.video);
      this.hls.on(Hls.Events.MANIFEST_PARSED, () => this.video.play().catch(() => {}));
      this.hls.on(Hls.Events.ERROR, (_, d) => { if (d.fatal) this._onError(); });
    } else if (this.video.canPlayType('application/vnd.apple.mpegurl')) {
      this.video.src = url;
      this.video.play().catch(() => {});
    } else {
      showToast('HLS not supported in this browser');
      UI.setSpinner(false);
    }
  },

  togglePlay() {
    if (!this.currentChannel) return;
    if (this.isRadio) {
      if (this.isPlaying) {
        this.audio.pause();
      } else {
        // Reconnect to live
        this.audio.src = this.currentUrl;
        this.audio.play().catch(() => {});
      }
    } else {
      if (this.isPlaying) {
        this.video.pause();
      } else {
        // Reconnect to live
        if (this.hls) { this.hls.loadSource(this.currentUrl); }
        this.video.play().catch(() => {});
      }
    }
  },

  setVolume(v) {
    this.volume = v;
    this.video.volume = v;
    this.audio.volume = v;
  },

  setMuted(m) {
    this.isMuted = m;
    this.video.muted = m;
    this.audio.muted = m;
  },

  switchSource(url) {
    this.currentUrl = url;
    if (this.isRadio) {
      this._stopAudio();
      this._playAudio(url);
    } else {
      this._stopVideo();
      this._loadVideo(url);
    }
  },

  stop() {
    this._destroyHls();
    this._stopVideo();
    this._stopAudio();
    this.currentChannel = null;
    this.currentUrl = null;
    this.isPlaying = false;
    UI.hideVideoPanel();
    UI.hideRadioBar();
    UI.renderChannels();
  },

  requestFullscreen() {
    const el = this.videoCol;
    if (!el) return;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      el.requestFullscreen().catch(() => {});
    }
  },

  _destroyHls() {
    if (this.hls) { this.hls.destroy(); this.hls = null; }
  },
  
  // New player hide controls system
  wakeControls() {
    const el = document.getElementById('vcontrols');
    if (this.videoCol) this.videoCol.style.cursor = 'default';
    el.classList.add('show');
    
    clearTimeout(this.controlsTimer);
    this.controlsTimer = setTimeout(() => {
      el.classList.remove('show');
      if (this.isPlaying && this.videoCol) {
        this.videoCol.style.cursor = 'none';
      }
    }, 3000);
  },
  
/*
  _toggleControls() {
    const el = document.getElementById('vcontrols');
    el.classList.add('show');
    clearTimeout(this.controlsTimer);
    this.controlsTimer = setTimeout(() => el.classList.remove('show'), 3000);
  },
*/
  _onPlaying()      { this.isPlaying = true;  UI.setSpinner(false); UI.setVideoPlayState(true);  },
  _onWaiting()      { UI.setSpinner(true); },
  _onPause()        { this.isPlaying = false;  UI.setVideoPlayState(false); },
  _onPlayingRadio() { this.isPlaying = true;  UI.setRadioPlayState(true);  },
  _onPauseRadio()   { this.isPlaying = false;  UI.setRadioPlayState(false); },
  _onError()        { UI.setSpinner(false); showToast('Stream error: Wait or try another source'); this.isPlaying = false; UI.setVideoPlayState(false); UI.setRadioPlayState(false); },
};

// ══════════════════════════════════════════════
//  UI
// ══════════════════════════════════════════════
const UI = {
  activePlaylistId: 'all',
  searchQuery: '',
  activeGroup: '',
  dedupEnabled: true,

  init() {
    this._bindHeader();
    this._bindVideoControls();
    this._bindRadioBar();
    this._bindSidebar();
    this._bindKeyboard();
    this.renderAll();
  },

  // ── DATA ──
  getPlaylists()     { return Storage.load(); },
  getAllChannels()    { return this.getPlaylists().flatMap(p => p.channels || []); },

  getVisibleChannels() {
    let ch = this.activePlaylistId === 'all'
      ? this.getAllChannels()
      : (this.getPlaylists().find(p => p.id === this.activePlaylistId)?.channels || []);

    if (this.dedupEnabled) ch = Parser.deduplicate(ch);
    if (this.activeGroup)  ch = ch.filter(c => c.group === this.activeGroup);
    if (this.searchQuery) {
      const q = this.searchQuery.toLowerCase();
      ch = ch.filter(c => c.name.toLowerCase().includes(q) || c.group.toLowerCase().includes(q));
    }
    return ch;
  },

  // ── RENDER ──
  renderAll() {
    this.renderSidebar();
    this.renderGroupFilter();
    this.renderChannels();
  },

  renderSidebar() {
    const playlists = this.getPlaylists();
    document.getElementById('all-count').textContent = this.getAllChannels().length;
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
        <span class="pi-count">${(p.channels||[]).length}</span>
        <button class="playlist-del" data-id="${p.id}">&times;</button>`;
      list.appendChild(div);
    });

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
    const cur = sel.value;
    sel.innerHTML = '<option value="">All categories</option>';
    groups.forEach(g => {
      const o = document.createElement('option');
      o.value = g; o.textContent = g;
      if (g === cur) o.selected = true;
      sel.appendChild(o);
    });
    if (!groups.includes(this.activeGroup)) this.activeGroup = '';
  },

  renderChannels() {
    const grid     = document.getElementById('channels-grid');
    const channels = this.getVisibleChannels();
    const playId   = Player.currentChannel?.id;

    if (channels.length === 0) {
      const has = this.getPlaylists().length > 0;
      grid.innerHTML = `
        <div class="empty-state">
          <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2">
            <rect x="2" y="7" width="20" height="15" rx="2"/><path d="M17 2H7l-1 5h12l-1-5z"/>
          </svg>
          <h3>${has ? 'No channels match' : 'No playlists yet'}</h3>
          <p>${has ? 'Try a different search or filter.' : 'Click <strong>Add Playlist</strong> to get started.'}</p>
        </div>`;
      return;
    }

    grid.innerHTML = '';
    channels.forEach(ch => {
      const isPlaying = ch.id === playId;
      const card = document.createElement('div');
      card.className = 'channel-card' + (isPlaying ? ' playing' : '');

      const hasSources = ch.sources && ch.sources.length > 1;
      const logoHtml = ch.logo
        ? `<div class="ch-logo-wrap"><img class="ch-logo" src="${esc(ch.logo)}" alt="" onerror="this.parentElement.innerHTML='<div class=ch-logo-placeholder>${esc(ch.name.charAt(0).toUpperCase())}</div>'"></div>`
        : `<div class="ch-logo-wrap"><div class="ch-logo-placeholder">${esc(ch.name.charAt(0).toUpperCase())}</div></div>`;

      card.innerHTML = `
        ${isPlaying ? '<div class="ch-playing-badge"></div>' : ''}
        ${logoHtml}
        <div class="ch-name">${esc(ch.name)}</div>
        <div class="ch-meta">
          <div class="ch-group">${esc(ch.group)}</div>
          ${hasSources ? `<div class="ch-sources-badge">${ch.sources.length} sources</div>` : ''}
        </div>`;

      card.addEventListener('click', () => this._playChannel(ch));
      grid.appendChild(card);
    });
  },

  _playChannel(ch) {
    Player.play(ch, ch.url);
  },

  // ── VIDEO PANEL ──
  showVideoPanel(channel) {
    document.getElementById('video-col').classList.add('visible');
    document.getElementById('channel-col').classList.add('with-video');

    // Populate controls
    document.getElementById('vc-name').textContent  = channel.name;
    document.getElementById('vc-group').textContent = channel.group;
    this._setLogo(channel, 'vc-logo', 'vc-logo-ph');
    this._populateSources(channel, 'vc-source-wrap', 'vc-source-select', false);
  },

  hideVideoPanel() {
    document.getElementById('video-col').classList.remove('visible');
    document.getElementById('channel-col').classList.remove('with-video');
  },

  // ── RADIO BAR ──
  showRadioBar(channel) {
    document.getElementById('radio-bar').classList.add('visible');
    document.getElementById('rbar-name').textContent  = channel.name;
    document.getElementById('rbar-group').textContent = channel.group;
    this._setLogo(channel, 'rbar-logo', 'rbar-logo-ph');
    this._populateSources(channel, 'rbar-source-wrap', 'rbar-source-select', true);
  },

  hideRadioBar() {
    document.getElementById('radio-bar').classList.remove('visible');
  },

  _setLogo(channel, imgId, phId) {
    const img = document.getElementById(imgId);
    const ph  = document.getElementById(phId);
    ph.textContent = channel.name.charAt(0).toUpperCase();
    if (channel.logo) {
      img.src = channel.logo;
      img.style.display = '';
      ph.style.display  = 'none';
      img.onerror = () => { img.style.display = 'none'; ph.style.display = ''; };
    } else {
      img.style.display = 'none';
      ph.style.display  = '';
    }
  },

  _populateSources(channel, wrapId, selId, isRadio) {
    const wrap = document.getElementById(wrapId);
    const sel  = document.getElementById(selId);
    const sources = channel.sources;

    if (sources && sources.length > 1) {
      wrap.style.display = 'flex';
      sel.innerHTML = '';
      sources.forEach((s, i) => {
        const o = document.createElement('option');
        o.value = s.url;
        o.textContent = s.label || `Source ${i + 1}`;
        sel.appendChild(o);
      });
      sel.value = channel.url;
      sel.onchange = () => Player.switchSource(sel.value);
    } else {
      wrap.style.display = 'none';
    }
  },

  setSpinner(v) {
    document.getElementById('vc-spinner').style.display = v ? '' : 'none';
  },

  setVideoPlayState(playing) {
    document.getElementById('vc-icon-play').style.display  = playing ? 'none' : '';
    document.getElementById('vc-icon-pause').style.display = playing ? ''     : 'none';
  },

  setRadioPlayState(playing) {
    document.getElementById('r-icon-play').style.display  = playing ? 'none' : '';
    document.getElementById('r-icon-pause').style.display = playing ? ''     : 'none';
    document.getElementById('radio-viz').classList.toggle('paused', !playing);
  },

  // ── BIND ──
  _bindHeader() {
    document.getElementById('search').addEventListener('input', e => {
      this.searchQuery = e.target.value.trim();
      this.renderChannels();
    });
    document.getElementById('group-filter').addEventListener('change', e => {
      this.activeGroup = e.target.value;
      this.renderChannels();
    });
    document.getElementById('dedup-check').addEventListener('change', e => {
      this.dedupEnabled = e.target.checked;
      this.renderChannels();
    });
    document.getElementById('btn-add-playlist').addEventListener('click', openModal);
  },

  _bindVideoControls() {
    document.getElementById('video-col').addEventListener('mousemove', () => {
    Player.wakeControls();
  });
    document.getElementById('vc-play-btn').addEventListener('click', () => Player.togglePlay());

    document.getElementById('vc-close').addEventListener('click', () => Player.stop());

    document.getElementById('vc-mute-btn').addEventListener('click', () => {
      Player.setMuted(!Player.isMuted);
      this._updateMuteIcons();
    });

    document.getElementById('vc-vol').addEventListener('input', e => {
      Player.setVolume(e.target.value / 100);
      document.getElementById('rbar-vol').value = e.target.value;
    });

    document.getElementById('vc-fullscreen-btn').addEventListener('click', () => Player.requestFullscreen());

    document.addEventListener('fullscreenchange', () => {
      const btn = document.getElementById('vc-fullscreen-btn');
      btn.innerHTML = document.fullscreenElement
        ? `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
             <polyline points="4,14 10,14 10,20"/><polyline points="20,10 14,10 14,4"/>
             <line x1="10" y1="14" x2="3" y2="21"/><line x1="21" y1="3" x2="14" y2="10"/>
           </svg>`
        : `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
             <polyline points="15,3 21,3 21,9"/><polyline points="9,21 3,21 3,15"/>
             <line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>
           </svg>`;
    });

    // Show controls on mouse move over video panel
    document.getElementById('video-col').addEventListener('mousemove', () => {
      const el = document.getElementById('vcontrols');
      el.classList.add('show');
      clearTimeout(Player.controlsTimer);
      Player.controlsTimer = setTimeout(() => el.classList.remove('show'), 3000);
    });
  },

  _bindRadioBar() {
    document.getElementById('radio-play-btn').addEventListener('click', () => Player.togglePlay());

    document.getElementById('rbar-close-btn').addEventListener('click', () => Player.stop());

    document.getElementById('rbar-mute-btn').addEventListener('click', () => {
      Player.setMuted(!Player.isMuted);
      this._updateMuteIcons();
    });

    document.getElementById('rbar-vol').addEventListener('input', e => {
      Player.setVolume(e.target.value / 100);
      document.getElementById('vc-vol').value = e.target.value;
    });
  },

  _updateMuteIcons() {
    const m = Player.isMuted;
    document.getElementById('vc-icon-vol').style.display   = m ? 'none' : '';
    document.getElementById('vc-icon-mute').style.display  = m ? ''     : 'none';
    document.getElementById('r-icon-vol').style.display    = m ? 'none' : '';
    document.getElementById('r-icon-mute').style.display   = m ? ''     : 'none';
  },

  _bindSidebar() {
    document.querySelector('.sidebar-all').addEventListener('click', e => {
      if (e.target.closest('.playlist-item')) {
        this.activePlaylistId = 'all';
        this.activeGroup = '';
        document.getElementById('group-filter').value = '';
        this.renderAll();
      }
    });

    document.getElementById('playlist-list').addEventListener('click', e => {
      const del = e.target.closest('.playlist-del');
      if (del) {
        e.stopPropagation();
        if (!confirm('Remove this playlist?')) return;
        const id = del.dataset.id;
        const pChs = this.getPlaylists().find(p => p.id === id)?.channels || [];
        if (pChs.find(c => c.id === Player.currentChannel?.id)) Player.stop();
        Storage.remove(id);
        if (this.activePlaylistId === id) this.activePlaylistId = 'all';
        this.activeGroup = '';
        this.renderAll();
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
      
      Player.wakeControls();
      
      if (['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName)) return;
      if (e.code === 'Space') { e.preventDefault(); Player.togglePlay(); }
      if (e.code === 'KeyM')  { Player.setMuted(!Player.isMuted); this._updateMuteIcons(); }
      if (e.code === 'KeyF' && Player.currentChannel && !Player.isRadio) Player.requestFullscreen();
      if (e.code === 'Escape') {
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
        else if (document.getElementById('modal-overlay').classList.contains('open')) closeModal();
      }
      if (e.code === 'ArrowUp')   { const v = Math.min(1, Player.volume + 0.05); Player.setVolume(v); document.getElementById('vc-vol').value = Math.round(v*100); document.getElementById('rbar-vol').value = Math.round(v*100); }
      if (e.code === 'ArrowDown') { const v = Math.max(0, Player.volume - 0.05); Player.setVolume(v); document.getElementById('vc-vol').value = Math.round(v*100); document.getElementById('rbar-vol').value = Math.round(v*100); }
    });
  },
};

// ══════════════════════════════════════════════
//  MODAL
// ══════════════════════════════════════════════
let activeTab = 'url';

function openModal()  { document.getElementById('modal-overlay').classList.add('open'); clearErr(); }
function closeModal() {
  document.getElementById('modal-overlay').classList.remove('open'); clearErr();
  ['url-input','url-name','paste-input','paste-name','file-name'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('file-input').value = '';
}
function showErr(msg) { const e = document.getElementById('modal-error'); e.textContent = msg; e.classList.add('visible'); }
function clearErr()   { document.getElementById('modal-error').classList.remove('visible'); }
function setTab(tab)  {
  activeTab = tab;
  document.querySelectorAll('.modal-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  document.querySelectorAll('.modal-tab-panel').forEach(p => p.classList.toggle('active', p.id === `tab-${tab}`));
}

async function savePlaylist() {
  clearErr();
  let name = '', content = '';

  if (activeTab === 'url') {
    const url = document.getElementById('url-input').value.trim();
    name = document.getElementById('url-name').value.trim();
    if (!url) { showErr('Please enter a URL.'); return; }
    try { if (!name) name = new URL(url).hostname; } catch { name = 'Playlist'; }
    showToast('Fetching playlist…');
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      content = await res.text();
    } catch (e) { showErr(`Could not load: ${e.message}. Try Paste or File instead.`); return; }

  } else if (activeTab === 'paste') {
    name    = document.getElementById('paste-name').value.trim() || 'Playlist';
    content = document.getElementById('paste-input').value.trim();
    if (!content) { showErr('Please paste M3U content.'); return; }

  } else if (activeTab === 'file') {
    const file = document.getElementById('file-input').files[0];
    if (!file) { showErr('Please select a file.'); return; }
    name    = document.getElementById('file-name').value.trim() || file.name.replace(/\.(m3u8?|txt)$/i, '');
    content = await readFile(file);
  }

  if (!content.includes('#EXTINF') && !content.includes('#EXTM3U')) {
    showErr('This does not look like a valid M3U file.'); return;
  }

  const channels = Parser.parse(content);
  if (!channels.length) { showErr('No channels found.'); return; }

  Storage.add({ id: uid(), name, channels });
  closeModal();
  UI.renderAll();
  showToast(`Loaded ${channels.length} channels from "${name}"`);
}

function readFile(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload  = e => res(e.target.result);
    r.onerror = () => rej(new Error('File read error'));
    r.readAsText(file);
  });
}

// ══════════════════════════════════════════════
//  TOAST
// ══════════════════════════════════════════════
let _toastTimer;
function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg; el.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
}

// ══════════════════════════════════════════════
//  UTILS
// ══════════════════════════════════════════════
function uid() {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36);
}
function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ══════════════════════════════════════════════
//  BOOTSTRAP
// ══════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', async () => { 
  Player.init();
  UI.init();

  // --- NEW PLAYLIST AUTO-LOAD LOGIC ---
  await autoLoadLocalPlaylists();
  // ------------------------------------

  document.getElementById('modal-cancel').addEventListener('click', closeModal);
  document.getElementById('modal-save').addEventListener('click', savePlaylist);
  document.getElementById('modal-overlay').addEventListener('click', e => {
    if (e.target === document.getElementById('modal-overlay')) closeModal();
  });
  document.querySelectorAll('.modal-tab').forEach(btn => {
    btn.addEventListener('click', () => setTab(btn.dataset.tab));
  });
});

// Helper function to automatically load local playlists from /playlists
async function autoLoadLocalPlaylists() {
  try {
    const response = await fetch('playlists/index.json');
    if (!response.ok) return; // If the JSON doesn't exist, exit quietly
    
    const playlistIndex = await response.json();
    const currentPlaylists = Storage.load();

    for (const item of playlistIndex) {
      // Prevent duplication if a playlist with the same name already exists
      const exists = currentPlaylists.some(p => p.name === item.name);
      if (exists) continue;

      try {
        const fileResponse = await fetch(item.file);
        if (!fileResponse.ok) continue;
        
        const m3uContent = await fileResponse.text();
        const channels = Parser.parse(m3uContent);

        if (channels.length > 0) {
          Storage.add({
            id: uid(),
            name: item.name,
            channels: channels
          });
          console.log(`[AutoLoad] Automatically loaded playlist: ${item.name}`);
        }
      } catch (err) {
        console.error(`Error loading m3u file (${item.file}):`, err);
      }
    }
    
    // Refresh the entire UI so the new playlists and channels appear immediately
    UI.renderAll();
    
  } catch (e) {
    console.log("No local playlists found to auto-load or the JSON is invalid.");
  }
}
