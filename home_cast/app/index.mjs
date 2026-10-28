// Home Cast: shows up in the Cast list of the YouTube and YouTube Music apps (DIAL + the YouTube
// "lounge" protocol, via yt-cast-receiver) and plays what is cast through Home Radio, which resolves
// the video with yt-dlp and plays it on the VLC add-on, out of the machine's own speakers.
//
// The phone keeps the queue; Home Radio plays one track at a time (home_radio.play_cast) and
// reports back with home_radio_cast events when it ends or when Next/Previous/Stop are pressed
// in Home Assistant.

import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import EventEmitter from 'node:events';
import YouTubeCastReceiver, { DataStore, Player, PLAYER_STATUSES } from 'yt-cast-receiver';

function loadOptions() {
  let opts = {};
  try {
    opts = JSON.parse(readFileSync('/data/options.json', 'utf8'));
  } catch {
    // Outside the add-on (development): environment only.
  }
  return {
    name: process.env.HOMECAST_NAME || opts.name || 'Home Assistant',
    entityId: process.env.HOMECAST_ENTITY || opts.entity_id || 'media_player.home_radio',
    logLevel: process.env.HOMECAST_LOG || opts.log_level || 'info',
  };
}

const OPTIONS = loadOptions();
const LEVELS = ['error', 'warn', 'info', 'debug'];

const log = {
  level: LEVELS.indexOf(OPTIONS.logLevel),
  out(lvl, msg) {
    if (LEVELS.indexOf(lvl) <= this.level) console.log(`${new Date().toISOString()} [${lvl}]`, ...msg);
  },
  error(...m) { this.out('error', m); },
  warn(...m) { this.out('warn', m); },
  info(...m) { this.out('info', m); },
  debug(...m) { this.out('debug', m); },
  setLevel(v) { this.level = LEVELS.indexOf(v); },
};

/** Keeps the receiver's identity and pairings across restarts, so phones see the same device.
 * (The library's default store can lose its first writes to a startup race.) */
class FileDataStore extends DataStore {
  constructor(path) {
    super();
    this.path = path;
    try {
      this.data = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      this.data = {};
    }
  }

  async set(key, value) {
    this.data[key] = value;
    this.#save();
  }

  #save() {
    writeFileSync(`${this.path}.tmp`, JSON.stringify(this.data));
    renameSync(`${this.path}.tmp`, this.path);
  }

  async get(key) {
    return this.data[key] ?? null;
  }

  async clear() {
    this.data = {};
    this.#save();
  }
}

/** Minimal Home Assistant websocket client: auth, commands, and subscriptions that survive reconnects. */
class Hass extends EventEmitter {
  constructor(url, token) {
    super();
    this.url = url;
    this.token = token;
    this.nextId = 1;
    this.pending = new Map();
    this.subs = []; // [{msg, handler}]
    this.handlers = new Map();
    this.ready = false;
  }

  connect() {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onmessage = (ev) => this.#onMessage(JSON.parse(ev.data));
    ws.onclose = () => {
      if (this.ready) log.warn('Home Assistant connection closed; reconnecting');
      this.ready = false;
      for (const { reject } of this.pending.values()) reject(new Error('connection closed'));
      this.pending.clear();
      setTimeout(() => this.connect(), 5000);
    };
    ws.onerror = () => {};
  }

  async #onMessage(msg) {
    if (msg.type === 'auth_required') {
      this.ws.send(JSON.stringify({ type: 'auth', access_token: this.token }));
    } else if (msg.type === 'auth_invalid') {
      log.error('Home Assistant rejected the token:', msg.message);
    } else if (msg.type === 'auth_ok') {
      this.ready = true;
      this.handlers.clear();
      log.info('Connected to Home Assistant', msg.ha_version);
      for (const sub of this.subs) await this.#subscribe(sub);
      this.emit('ready');
    } else if (msg.type === 'event') {
      this.handlers.get(msg.id)?.(msg.event);
    } else if (msg.type === 'result') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.success) p.resolve(msg.result);
      else p.reject(new Error(msg.error?.message || 'command failed'));
    }
  }

  send(msg) {
    if (!this.ready) return Promise.reject(new Error('not connected to Home Assistant'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ ...msg, id }));
    });
  }

  async #subscribe(sub) {
    const id = this.nextId;
    this.handlers.set(id, sub.handler);
    try {
      await this.send(sub.msg);
    } catch (e) {
      log.error('Subscription failed:', JSON.stringify(sub.msg), e.message);
    }
  }

  subscribe(msg, handler) {
    const sub = { msg, handler };
    this.subs.push(sub);
    if (this.ready) this.#subscribe(sub);
  }

  callService(domain, service, entityId, data = {}, returnResponse = false) {
    return this.send({
      type: 'call_service', domain, service, service_data: data, target: { entity_id: entityId },
      ...(returnResponse ? { return_response: true } : {}),
    });
  }
}

/** The Player yt-cast-receiver drives; every command goes to the Home Radio entity. */
class HomeRadioPlayer extends Player {
  constructor(hass, entityId) {
    super();
    this.hass = hass;
    this.entityId = entityId;
    this.haState = null;
    this.senderName = null;
    this.failures = 0;
    this.lastVolume = null;
  }

  get attrs() {
    return this.haState?.attributes || {};
  }

  // ---- commands from the phone ----

  async doPlay(video, position) {
    log.info(`Play ${video.id} from ${Math.round(position)}s`);
    try {
      const res = await this.hass.callService('home_radio', 'play_cast', this.entityId,
        { video_id: video.id, position, sender: this.senderName || 'YouTube' }, true);
      const reply = res?.response?.[this.entityId];
      if (reply?.ok) {
        this.failures = 0;
        log.info(`Playing: ${reply.title || video.id}`);
        return true;
      }
      log.warn(`Could not play ${video.id}`);
    } catch (e) {
      log.error('play_cast failed:', e.message);
    }
    // Unplayable (removed, region-blocked, …): move on, but don't race through a whole queue.
    if (++this.failures < 3) setTimeout(() => this.next().catch(() => {}), 500);
    else this.failures = 0;
    return false;
  }

  async #mp(service, data) {
    try {
      await this.hass.callService('media_player', service, this.entityId, data);
      return true;
    } catch (e) {
      log.error(`${service} failed:`, e.message);
      return false;
    }
  }

  doPause() { return this.#mp('media_pause'); }
  doResume() { return this.#mp('media_play'); }
  doStop() { return this.#mp('media_stop'); }
  doSeek(position) { return this.#mp('media_seek', { seek_position: position }); }

  async doSetVolume(volume) {
    const ok = await this.#mp('volume_set', { volume_level: Math.max(0, Math.min(100, volume.level)) / 100 });
    if (Boolean(this.attrs.is_volume_muted) !== Boolean(volume.muted)) {
      await this.#mp('volume_mute', { is_volume_muted: Boolean(volume.muted) });
    }
    return ok;
  }

  async doGetVolume() {
    return { level: Math.round((this.attrs.volume_level ?? 0.5) * 100), muted: Boolean(this.attrs.is_volume_muted) };
  }

  async doGetPosition() {
    const { media_position: pos, media_position_updated_at: at } = this.attrs;
    if (typeof pos !== 'number') return 0;
    const running = this.haState?.state === 'playing' && at ? (Date.now() - Date.parse(at)) / 1000 : 0;
    return Math.max(0, pos + running);
  }

  async doGetDuration() {
    return this.attrs.media_duration || 0;
  }

  // ---- what happens in Home Assistant ----

  get casting() {
    return this.status !== PLAYER_STATUSES.IDLE && this.status !== PLAYER_STATUSES.STOPPED;
  }

  /** Pause/Play/volume from Home Assistant (card, phone app, volume keys) show up on the phone. */
  onHaState(state) {
    this.haState = state;
    if (!state || !this.casting || !this.attrs.cast_sender) return;
    const volume = `${this.attrs.volume_level}|${this.attrs.is_volume_muted}`;
    const volumeChanged = this.lastVolume !== null && volume !== this.lastVolume;
    this.lastVolume = volume;
    if (this.status === PLAYER_STATUSES.PLAYING && state.state === 'paused') {
      this.notifyExternalStateChange(PLAYER_STATUSES.PAUSED);
    } else if (this.status === PLAYER_STATUSES.PAUSED && state.state === 'playing') {
      this.notifyExternalStateChange(PLAYER_STATUSES.PLAYING);
    } else if (volumeChanged) {
      this.notifyExternalStateChange();
    }
  }

  onCastEvent(data) {
    if (data.entity_id && data.entity_id !== this.entityId) return;
    log.info(`Home Radio: ${data.command}`);
    if (!this.casting && data.command !== 'stop') return;
    switch (data.command) {
      case 'ended':
      case 'next':
        this.next().catch((e) => log.error('next failed:', e.message));
        break;
      case 'previous':
        this.previous().catch((e) => log.error('previous failed:', e.message));
        break;
      case 'stop':
        // Something else now plays on Home Radio (or it was stopped there).
        if (this.casting) this.notifyExternalStateChange(PLAYER_STATUSES.STOPPED);
        break;
      default:
    }
  }
}

async function main() {
  const token = process.env.SUPERVISOR_TOKEN || process.env.HA_TOKEN;
  if (!token) {
    log.error('No Home Assistant token (homeassistant_api must be enabled for the add-on)');
    process.exit(1);
  }
  const hass = new Hass(process.env.HA_WS_URL || 'ws://supervisor/core/websocket', token);
  const player = new HomeRadioPlayer(hass, OPTIONS.entityId);

  hass.on('ready', async () => {
    try {
      const states = await hass.send({ type: 'get_states' });
      const st = states.find((s) => s.entity_id === OPTIONS.entityId);
      if (!st) log.error(`${OPTIONS.entityId} not found — is the Home Radio integration set up?`);
      player.onHaState(st || null);
    } catch (e) {
      log.error('get_states failed:', e.message);
    }
  });
  hass.subscribe({ type: 'subscribe_trigger', trigger: { platform: 'state', entity_id: OPTIONS.entityId } },
    (ev) => player.onHaState(ev.variables?.trigger?.to_state || null));
  hass.subscribe({ type: 'subscribe_events', event_type: 'home_radio_cast' }, (ev) => player.onCastEvent(ev.data || {}));
  hass.connect();

  const receiver = new YouTubeCastReceiver(player, {
    device: { name: OPTIONS.name, screenName: OPTIONS.name, brand: 'Home Assistant', model: 'Home Cast' },
    dial: { port: Number(process.env.HOMECAST_PORT) || 8098 },
    dataStore: new FileDataStore(process.env.HOMECAST_STORE || '/data/receiver.json'),
    logger: log,
    logLevel: OPTIONS.logLevel,
  });
  receiver.on('senderConnect', (sender) => {
    player.senderName = sender.user?.name || sender.name || 'YouTube';
    log.info(`Connected: ${sender.name}${sender.user?.name ? ` (${sender.user.name})` : ''}`);
  });
  receiver.on('senderDisconnect', (sender, implicit) => {
    log.info(`Disconnected: ${sender.name}${implicit ? ' (implicit)' : ''}`);
  });
  receiver.on('error', (e) => log.error('Receiver error:', e?.message || e));
  receiver.on('terminate', (e) => {
    log.error('Receiver stopped:', e?.message || e);
    process.exit(1);
  });

  await receiver.start();
  log.info(`"${OPTIONS.name}" is ready in the Cast list of YouTube / YouTube Music on this network`);

  // For a phone that doesn't list it (other network, multicast blocked): YouTube → Settings →
  // Watch on TV → Link with TV code. The code changes every few minutes.
  const pairing = receiver.getPairingCodeRequestService();
  pairing.on('response', (code) => log.info(`TV code: ${code.replace(/(\d{3})(?=\d)/g, '$1 ')}`));
  pairing.on('error', (e) => log.debug('TV code request failed:', e?.message || e));
  pairing.start();

  const shutdown = async () => {
    pairing.stop();
    try { await receiver.stop(); } catch { /* exiting anyway */ }
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((e) => {
  log.error(e?.stack || e);
  process.exit(1);
});
