// WebGL Networking Bridge for Spade Synergy
// Handles WebSocket communication with the backend

class SpadeSynergyNetworker {
  constructor() {
    this.socket = null;
    this.gameData = null;
    this.callbacks = {};
    this.connected = false;
    this._pendingCalls = [];   // queued actions that arrived before socket connected
    this.playerIndex = -1;
    this.roomId = null;
    this._chosenVoice = null;
    // Reconnect session token. Persisted in localStorage so it survives a full
    // page refresh — letting the player rejoin their seat even after a reload.
    this._token = null;
    try { this._token = localStorage.getItem('ss_token') || null; } catch (e) {}

    // Load socket.io library
    this.loadSocketIO();

    // Warm up the speech voice list and lock a voice as soon as it's ready.
    if (window.speechSynthesis) {
      const lock = () => this.pickVoice();
      lock();
      window.speechSynthesis.onvoiceschanged = lock;
    }
  }

  loadSocketIO() {
    // Already present (e.g. NetworkManager bootstrap loaded it first)? Skip.
    if (window.io || document.getElementById('ss-sio-js')) { console.log('Socket.IO already present'); return; }
    const script = document.createElement('script');
    script.id = 'ss-sio-js';
    script.src = 'socket.io.min.js';   // bundled locally — avoids CDN/CSP issues
    script.onload = () => {
      console.log('Socket.IO loaded');
    };
    document.head.appendChild(script);
  }

  connect(serverURL) {
    if (!window.io) {
      setTimeout(() => this.connect(serverURL), 100);
      return;
    }

    this.socket = io(serverURL, {
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      reconnectionAttempts: Infinity,   // never stop trying — long drops still recover
      timeout: 20000
    });

    this.socket.on('connect', () => {
      console.log('Connected to server');
      this.connected = true;
      this.sendToUnity('OnConnectedJS', '');
      // Flush any calls that arrived before the socket was ready.
      const pending = this._pendingCalls.splice(0);
      if (pending.length) console.log(`[Networker] flushing ${pending.length} queued call(s)`);
      pending.forEach(fn => fn());
      // If we have a session token, this is a RECONNECT — rejoin our seat.
      if (this._token) {
        console.log('[Networker] reconnecting with token…');
        this.socket.emit('rejoin', { token: this._token });
      }
    });

    this.socket.on('disconnect', () => {
      console.log('Disconnected from server');
      this.connected = false;
    });

    this.socket.on('rejoinOk', (data) => {
      console.log('[Networker] rejoin OK — seat', data.yourIndex);
      this.gameData = data.game;
      this.playerIndex = data.yourIndex;
      this.sendToUnity('OnRejoinOkJS', JSON.stringify(data));
    });
    this.socket.on('rejoinFailed', (data) => {
      console.warn('[Networker] rejoin failed —', data.reason);
      this._token = null;
      try { localStorage.removeItem('ss_token'); } catch (e) {}
      this.sendToUnity('OnRejoinFailedJS', JSON.stringify(data));
    });
    this.socket.on('opponentRejoined', (data) => {
      this.gameData = data.game;
      this.sendToUnity('OnGameStartJS', JSON.stringify({ game: data.game }));
    });

    // Game events
    this.socket.on('gameStart', (data) => {
      this.gameData = data.game;
      console.log('[Networker] gameStart — both players matched! Game beginning.', data.game);
      this.sendToUnity('OnGameStartJS', JSON.stringify(data));
    });

    this.socket.on('bidMade', (data) => {
      this.gameData = data.game;
      this.sendToUnity('OnBidMadeJS', JSON.stringify(data));
    });

    this.socket.on('bidsComplete', (data) => {
      this.gameData = data.game;
      console.log('[Networker] bidsComplete — currentTurn=' + data.game.currentTurn + ' phase=' + data.game.phase);
      this.sendToUnity('OnBidsCompleteJS', JSON.stringify(data));
    });

    this.socket.on('cardPlayed', (data) => {
      this.gameData = data.game;
      console.log('[Networker] cardPlayed — by seat ' + data.playerIndex + ', currentTurn now ' + data.game.currentTurn);
      this.sendToUnity('OnCardPlayedJS', JSON.stringify(data));
    });

    this.socket.on('trickResolved', (data) => {
      this.gameData = data.game;
      this.sendToUnity('OnTrickResolvedJS', JSON.stringify(data));
    });

    this.socket.on('roundOver', (data) => {
      this.gameData = data.game;
      this.sendToUnity('OnRoundOverJS', JSON.stringify(data));
    });

    this.socket.on('matchOver', (data) => {
      this.gameData = data.game;
      // Match is finished — discard the reconnect token so a later page load
      // doesn't try to rejoin a seat that no longer exists.
      this._token = null;
      try { localStorage.removeItem('ss_token'); } catch (e) {}
      this.sendToUnity('OnMatchOverJS', JSON.stringify(data));
    });

    this.socket.on('nextGameReady', (data) => {
      this.gameData = data.game;
      this.sendToUnity('OnNextGameReadyJS', JSON.stringify(data));
    });

    this.socket.on('nextTrick', (data) => {
      this.gameData = data.game;
      this.sendToUnity('OnNextTrickJS', JSON.stringify(data));
    });

    this.socket.on('shopOpened', (data) => {
      this.gameData = data.game;
      console.log('[Networker] shopOpened — visitor seat ' + data.visitor);
      this.sendToUnity('OnShopOpenedJS', JSON.stringify(data));
    });

    this.socket.on('shopClosed', (data) => {
      this.gameData = data.game;
      console.log('[Networker] shopClosed — play resumes');
      this.sendToUnity('OnShopClosedJS', JSON.stringify(data));
    });

    this.socket.on('powerupUsed', (data) => {
      this.gameData = data.game;
      console.log('[Networker] powerupUsed by seat ' + data.user + ': ' + data.message);
      this.sendToUnity('OnPowerupUsedJS', JSON.stringify(data));
    });

    this.socket.on('cardInsightReveal', (data) => {
      console.log('[Networker] cardInsightReveal — peeked at ' + data.targetName);
      this.sendToUnity('OnCardInsightRevealJS', JSON.stringify(data));
    });

    this.socket.on('swapInfo', (data) => {
      console.log('[Networker] swapInfo (private)');
      this.sendToUnity('OnSwapInfoJS', JSON.stringify(data));
    });

    this.socket.on('interactPrompt', (data) => {
      console.log('[Networker] interactPrompt — ' + data.type + ' for seat ' + data.forSeat);
      this.sendToUnity('OnInteractPromptJS', JSON.stringify(data));
    });

    this.socket.on('opponentLeft', (data) => {
      console.log('[Networker] opponentLeft — the other player disconnected.');
      this.sendToUnity('OnOpponentLeftJS', JSON.stringify(data));
    });

    this.socket.on('waitingForOpponent', (data) => {
      console.log('[Networker] waitingForOpponent — solo start in', data.secondsLeft, 's');
      this.sendToUnity('OnWaitingForOpponentJS', JSON.stringify(data));
    });

    this.socket.on('playerJoined', (data) => {
      this.playerIndex = data.yourIndex;
      this.gameData = data.game;
      if (data.token) {                            // remember for reconnect
        this._token = data.token;
        try { localStorage.setItem('ss_token', data.token); } catch (e) {}
      }
      console.log('[Networker] playerJoined — you are player index', data.yourIndex);
      this.sendToUnity('OnPlayerJoinedJS', JSON.stringify(data));
    });

    // ── Private 4-player room events ──
    this.socket.on('roomCreated', (data) => {
      console.log('[Networker] roomCreated — code', data.code);
      this.sendToUnity('OnRoomCreatedJS', JSON.stringify(data));
    });
    this.socket.on('roomJoined', (data) => {
      console.log('[Networker] roomJoined — code', data.code);
      this.sendToUnity('OnRoomJoinedJS', JSON.stringify(data));
    });
    this.socket.on('lobbyState', (data) => {
      this.sendToUnity('OnLobbyStateJS', JSON.stringify(data));
    });
    this.socket.on('roomError', (data) => {
      console.warn('[Networker] roomError —', data.message);
      this.sendToUnity('OnRoomErrorJS', JSON.stringify(data));
    });
    this.socket.on('resyncState', (data) => {
      this.gameData = data.game;
      if (typeof data.yourIndex === 'number' && data.yourIndex >= 0) this.playerIndex = data.yourIndex;
      console.log('[Networker] resyncState — phase=' + data.phase);
      this.sendToUnity('OnResyncStateJS', JSON.stringify(data));
    });
  }

  // Queue fn if not yet connected; otherwise run it immediately.
  // Shows a "Connecting…" notice in the lobby so the player isn't left wondering.
  _whenReady(fn) {
    if (this.connected) { fn(); return; }
    console.log('[Networker] queuing call until connected');
    this._pendingCalls.push(fn);
    this.sendToUnity('OnLobbyStatusJS', 'Connecting to server…');
  }

  // ── Private room actions ──
  createRoom(playerName, color, character) {
    this._whenReady(() => this.socket.emit('createRoom', { playerName, color, character: character || null }));
  }
  joinRoom(playerName, code, color, character) {
    this._whenReady(() => this.socket.emit('joinRoom', { playerName, code, color, character: character || null }));
  }
  startRoom() {
    if (!this.connected) return;
    this.socket.emit('startRoom', {});
  }
  resync() {
    if (!this.connected) return;
    this.socket.emit('resync', {});
  }
  setTeam(index, team) {
    if (!this.connected) return;
    this.socket.emit('setTeam', { index, team });
  }

  joinGame(playerName, color) {
    this._whenReady(() => this.socket.emit('joinGame', { playerName, color }));
  }

  makeBid(bid) {
    if (!this.connected || this.playerIndex < 0) return;
    this.socket.emit('makeBid', { bid });
  }

  // cardIndex kept for fallback; suit+rank are the authoritative identity so a
  // laggy/desynced client can never play the wrong card or stall the game.
  playCard(cardIndex, suit, rank) {
    console.log('[Networker] playCard idx=' + cardIndex + ' card=' + rank + suit);
    if (!this.connected || this.playerIndex < 0) {
      console.warn('[Networker] playCard BLOCKED — not connected or no playerIndex');
      return;
    }
    const payload = { cardIndex };
    if (suit && typeof rank === 'number') payload.cardId = { suit, rank };
    this.socket.emit('playCard', payload);
  }

  // ── Shop actions ──
  // Full arg set for every powerup kind; -1 / empty means "not used".
  buyPowerup(powerupId, targetSeat, cardIndex, targetSeat2, earnedIndex, guessSuit, guessRank) {
    if (!this.connected) return;
    const payload = { powerupId };
    if (targetSeat  !== undefined && targetSeat  >= 0) payload.targetSeat  = targetSeat;
    if (cardIndex   !== undefined && cardIndex   >= 0) payload.cardIndex   = cardIndex;
    if (targetSeat2 !== undefined && targetSeat2 >= 0) payload.targetSeat2 = targetSeat2;
    if (earnedIndex !== undefined && earnedIndex >= 0) payload.earnedIndex = earnedIndex;
    if (guessSuit) payload.guessSuit = guessSuit;
    if (guessRank !== undefined && guessRank > 0) payload.guessRank = guessRank;
    console.log('[Networker] buyPowerup', payload);
    this.socket.emit('buyPowerup', payload);
  }

  interactRespond(cardIndex) {
    if (!this.connected) return;
    console.log('[Networker] interactRespond cardIndex=' + cardIndex);
    this.socket.emit('interactRespond', { cardIndex });
  }

  skipShop() {
    if (!this.connected) return;
    console.log('[Networker] skipShop');
    this.socket.emit('skipShop', {});
  }

  rerollShop() {
    if (!this.connected) return;
    console.log('[Networker] rerollShop');
    this.socket.emit('rerollShop', {});
  }

  startNewGame() {
    if (!this.connected) return;
    this.socket.emit('newGame', {});
  }

  startNewMatch() {
    if (!this.connected) return;
    this.socket.emit('newMatch', {});
  }

  // Choose ONE British voice and lock it for the whole session so the
  // commentator always sounds the same. Voice list loads async, so we
  // pick the best available and remember it.
  pickVoice() {
    if (this._chosenVoice) return this._chosenVoice;
    const voices = window.speechSynthesis.getVoices();
    if (!voices || voices.length === 0) return null;

    // Preference order: specific named British male voices first, then any en-GB.
    const byName = (needle) =>
      voices.find(v => v.name.toLowerCase().includes(needle));
    this._chosenVoice =
      byName('google uk english male') ||
      byName('daniel') ||
      byName('arthur') ||
      byName('oliver') ||
      voices.find(v => v.lang === 'en-GB') ||
      byName('british') ||
      voices.find(v => v.lang && v.lang.startsWith('en')) ||
      voices[0];
    return this._chosenVoice;
  }

  speak(text) {
    if (!window.speechSynthesis) return;
    window.speechSynthesis.cancel(); // cut off any current line
    const utter = new SpeechSynthesisUtterance(text);
    utter.rate   = 0.88;  // slightly slower — old man pace
    utter.pitch  = 0.75;  // lower pitch — authoritative
    utter.volume = 1.0;
    const v = this.pickVoice();
    if (v) { utter.voice = v; utter.lang = v.lang; }
    window.speechSynthesis.speak(utter);
  }

  sendToUnity(method, data) {
    if (window.unityInstance) {
      window.unityInstance.SendMessage('NetworkManager', method, data);
    }
  }

  getGameData() {
    return this.gameData;
  }

  getPlayerIndex() {
    return this.playerIndex;
  }
}

// Global instance
window.spadeNetworker = new SpadeSynergyNetworker();

// Called from Unity C# via ExternalEval to speak a commentator line
window.speakCommentary = function(text) {
  window.spadeNetworker.speak(text);
};

// ─────────────────────────────────────────────────────────────────────────────
// Voice recognition (push-to-talk) — Web Speech API, runs entirely in-browser.
// Unity calls startVoiceListen()/stopVoiceListen(); we send the transcript back
// via SendMessage('NetworkManager','OnVoiceCommandJS', text).
// ─────────────────────────────────────────────────────────────────────────────
(function () {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recog = null;
  let listening = false;

  function ensureRecog() {
    if (recog || !SR) return recog;
    recog = new SR();
    recog.lang = 'en-US';
    recog.continuous = false;
    recog.interimResults = false;
    recog.maxAlternatives = 3;

    recog.onresult = (e) => {
      // Gather all alternatives across results into one space-joined string,
      // so Unity can fuzzy-match against any of them.
      let parts = [];
      for (let i = 0; i < e.results.length; i++) {
        for (let j = 0; j < e.results[i].length; j++) {
          parts.push(e.results[i][j].transcript);
        }
      }
      const text = parts.join(' | ').toLowerCase().trim();
      if (text && window.unityInstance) {
        window.unityInstance.SendMessage('NetworkManager', 'OnVoiceCommandJS', text);
      }
    };
    recog.onerror = (e) => { console.warn('[Voice] error', e.error); };
    recog.onend = () => { listening = false; };
    return recog;
  }

  window.voiceSupported = function () { return !!SR; };

  window.startVoiceListen = function () {
    const r = ensureRecog();
    if (!r || listening) return;
    try { r.start(); listening = true; }
    catch (err) { console.warn('[Voice] start failed', err); }
  };

  window.stopVoiceListen = function () {
    if (recog && listening) { try { recog.stop(); } catch (e) {} }
    listening = false;
  };
})();
