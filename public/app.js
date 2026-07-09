/* ============================================================
   UNO Master · Cliente Web (JavaScript Vanilla)
   ------------------------------------------------------------
   Este cliente NO calcula lógica de juego. Solo:
     1) Envía las acciones del jugador al backend por WebSocket.
     2) Renderiza de forma reactiva el estado (gameState) que
        dicta el servidor, sincronizado en las 4 pantallas.

   Protocolo (JSON): { type: "NOMBRE", data: { ... } }
   ============================================================ */

/* ---------- 1. Configuración de conexión ---------- */
const CONFIG = {
  // 👉 Al desplegar el backend en Render, coloca aquí tu URL (con wss://):
  //    Ejemplo: "wss://uno-backend-xxxx.onrender.com"
  RENDER_WS_URL: "wss://TU-APP.onrender.com",
};

/**
 * Decide a qué servidor conectarse:
 *  - En local (localhost / 127.0.0.1) usa el mismo host por ws://
 *  - En producción (GitHub Pages) usa la URL de Render (wss://)
 *  - Se puede forzar con ?server=ws://host:puerto en la URL.
 */
function resolveServerUrl() {
  const params = new URLSearchParams(location.search);
  if (params.get("server")) return params.get("server");

  const host = location.hostname;
  const esLocal = host === "localhost" || host === "127.0.0.1" || host === "";
  if (esLocal) {
    const puerto = location.port || "3000";
    return `ws://${host || "localhost"}:${puerto}`;
  }
  return CONFIG.RENDER_WS_URL;
}

/* ---------- 2. Tablas de mapeo (español → assets en inglés) ---------- */
const COLOR_ES_EN = { Rojo: "Red", Amarillo: "Yellow", Verde: "Green", Azul: "Blue", "Comodín": "Wild" };
const VALUE_ES_EN = {
  "0": "Zero", "1": "One", "2": "Two", "3": "Three", "4": "Four",
  "5": "Five", "6": "Six", "7": "Seven", "8": "Eight", "9": "Nine",
  Bloqueo: "SkipTurn", CambioSentido: "Reverse", "+2": "DrawTwo",
  CambiaColor: "ChangeColor", "+4": "DrawFour",
};
const COLOR_HEX = { Rojo: "#d9202a", Amarillo: "#f0b400", Verde: "#1f9d3b", Azul: "#1f7fd1", "Comodín": "#2b2b3a" };

/** Devuelve la ruta de imagen para una carta del gameState. */
function cardImage(card) {
  if (!card) return "assets/card_back.png";
  // Los comodines siempre usan la imagen "Wild_*", sin importar el color asignado.
  if (card.value === "CambiaColor") return "assets/Wild_ChangeColor.png";
  if (card.value === "+4") return "assets/Wild_DrawFour.png";
  const c = COLOR_ES_EN[card.color] || "Wild";
  const v = VALUE_ES_EN[card.value] || card.value;
  return `assets/${c}_${v}.png`;
}

/** ¿La carta es un comodín (elige color al jugarla)? */
const esComodin = (card) => card.color === "Comodín";

/** Pista visual: ¿coincide con la carta de la mesa? (el servidor es la autoridad real) */
function esJugable(card, top) {
  if (!top) return false;
  return esComodin(card) || card.color === top.color || card.value === top.value;
}

/* ---------- 3. Estado local del cliente ---------- */
const state = {
  myName: "",
  players: [],        // nombres conocidos (desde waitingRoom)
  game: null,         // último gameState recibido
  pendingCardIndex: null, // índice de comodín esperando elección de color
  gameOver: false,
};

let ws = null;

/* ---------- 4. Referencias al DOM ---------- */
const $ = (id) => document.getElementById(id);
const el = {
  lobby: $("lobby"), game: $("game"),
  connBadge: $("connBadge"), connText: $("connText"),
  // lobby
  joinForm: $("joinForm"), nickname: $("nickname"), joinBtn: $("joinBtn"),
  waitingRoom: $("waitingRoom"), playerCount: $("playerCount"), playerList: $("playerList"),
  // header / mesa
  meName: $("meName"), directionPill: $("directionPill"),
  turnBanner: $("turnBanner"), deckBtn: $("deckBtn"), discardPile: $("discardPile"),
  topCardImg: $("topCardImg"), pauseHint: $("pauseHint"),
  logText: $("logText"),
  // asientos
  seats: {
    top: { av: $("seat-top"), name: $("seat-top-name"), box: document.querySelector(".seat--top") },
    left: { av: $("seat-left"), name: $("seat-left-name"), box: document.querySelector(".seat--left") },
    right: { av: $("seat-right"), name: $("seat-right-name"), box: document.querySelector(".seat--right") },
  },
  // mano / botones
  handCount: $("handCount"), unoBadge: $("unoBadge"),
  botonera: $("botonera"), unoBtn: $("unoBtn"), corteBtn: $("corteBtn"), hand: $("hand"),
  // modales
  colorModal: $("colorModal"), colorCancel: $("colorCancel"),
  popupModal: $("popupModal"), popupText: $("popupText"), popupOk: $("popupOk"),
  overModal: $("overModal"), overText: $("overText"), overBtn: $("overBtn"),
  toasts: $("toasts"),
};

/* ---------- 5. Utilidades de conexión ---------- */
function connect() {
  const url = resolveServerUrl();
  setConn("connecting", "Conectando…");
  try {
    ws = new WebSocket(url);
  } catch (e) {
    setConn("error", "URL inválida");
    return;
  }

  ws.onopen = () => setConn("connected", "Conectado");
  ws.onclose = () => {
    setConn("error", "Desconectado");
    // Si el juego seguía activo, avisa (el servidor reinicia la sala al desconectarse alguien).
    if (!state.gameOver && state.game && state.game.gameStarted) {
      showOver("⚠️ Conexión perdida con el servidor. La partida se cerró.");
    }
  };
  ws.onerror = () => setConn("error", "Error de conexión");
  ws.onmessage = (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    handleMessage(msg.type, msg.data);
  };
}

/** Envía un evento al servidor con la estructura del protocolo. */
function send(type, data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, data }));
  }
}

function setConn(cls, text) {
  el.connBadge.className = `conn-badge conn-${cls}`;
  el.connText.textContent = text;
}

/* ---------- 6. Manejo de eventos del servidor ---------- */
function handleMessage(type, data) {
  switch (type) {
    case "waitingRoom": onWaitingRoom(data); break;
    case "gameState":   onGameState(data);   break;
    case "showPopup":   showPopup(data);      break;
    case "errorMsg":    toast(data);          break;
    case "gameOver":    showOver(data);       break;
    default: /* ignoramos tipos desconocidos */ break;
  }
}

function onWaitingRoom(names) {
  state.players = Array.isArray(names) ? names : [];
  // Renderiza la sala de espera dentro del lobby.
  el.joinForm.classList.add("hidden");
  el.waitingRoom.classList.remove("hidden");
  el.playerCount.textContent = state.players.length;
  el.playerList.innerHTML = "";
  state.players.forEach((name) => {
    const li = document.createElement("li");
    li.textContent = name;
    if (name === state.myName) li.classList.add("is-me");
    el.playerList.appendChild(li);
  });
}

function onGameState(g) {
  state.game = g;
  // Al recibir el primer gameState, si el juego arrancó, pasamos a la pantalla de juego.
  if (g.gameStarted) showScreen("game");
  render();
}

/* ---------- 7. Render reactivo de la pantalla de juego ---------- */
function render() {
  const g = state.game;
  if (!g) return;

  el.meName.textContent = state.myName || "—";
  el.directionPill.textContent = `Sentido: ${g.direction || "—"}`;

  // --- Carta de la mesa (descarte) + color activo ---
  el.topCardImg.src = cardImage(g.topCard);
  const activeHex = g.topCard ? (COLOR_HEX[g.topCard.color] || "#000") : "#000";
  el.discardPile.style.boxShadow = `0 0 0 5px ${activeHex}, 0 0 26px ${activeHex}aa`;

  // --- Banner de turno ---
  if (g.isMyTurn) {
    el.turnBanner.textContent = "¡ES TU TURNO!";
    el.turnBanner.classList.add("my-turn");
  } else {
    el.turnBanner.textContent = `Turno de ${g.currentTurnName || "…"}`;
    el.turnBanner.classList.remove("my-turn");
  }

  // --- Asientos de oponentes (decorativo + resaltar turno activo) ---
  renderSeats(g);

  // --- Log de acción ---
  if (g.log) el.logText.textContent = g.log;

  // --- Pausa (popup en curso de otro jugador) ---
  const popupAbierto = !el.popupModal.classList.contains("hidden");
  el.pauseHint.classList.toggle("hidden", !(g.isPaused && !popupAbierto));

  // --- Mazo (robar) ---
  const puedoJugar = g.isMyTurn && !g.isPaused;
  el.deckBtn.disabled = !puedoJugar;
  el.deckBtn.classList.toggle("can-draw", puedoJugar);

  // --- Mi mano ---
  renderHand(g, puedoJugar);

  // --- Contador + badge UNO ---
  el.handCount.textContent = g.hand ? g.hand.length : 0;
  el.unoBadge.classList.toggle("hidden", !g.dijoUno);

  // --- Botonera UNO / CORTE ---
  el.botonera.classList.toggle("hidden", !g.mostrarBotoneraUno);
}

function renderSeats(g) {
  // No conocemos con certeza la posición de cada oponente (el protocolo solo
  // envía currentTurnName), así que mostramos asientos genéricos y resaltamos
  // el que coincide con el nombre del turno actual.
  const oponentes = state.players.filter((n) => n !== state.myName);
  const seatKeys = ["left", "top", "right"];
  seatKeys.forEach((key, i) => {
    const seat = el.seats[key];
    const nombre = oponentes[i];
    seat.name.textContent = nombre || "Oponente";
    seat.av.textContent = nombre ? nombre.charAt(0).toUpperCase() : "?";
    const esTurno = !g.isMyTurn && nombre && nombre === g.currentTurnName;
    seat.box.classList.toggle("is-turn", !!esTurno);
  });
}

function renderHand(g, puedoJugar) {
  el.hand.innerHTML = "";
  el.hand.classList.toggle("playable-turn", puedoJugar);
  const top = g.topCard;
  (g.hand || []).forEach((card, index) => {
    const btn = document.createElement("button");
    btn.className = "card";
    const jugable = esJugable(card, top);
    if (jugable) btn.classList.add("playable");
    btn.innerHTML = `<img src="${cardImage(card)}" alt="${card.color} ${card.value}" draggable="false" />`;

    // Solo permitimos el clic en el turno propio (el servidor valida igualmente).
    if (puedoJugar) {
      btn.addEventListener("click", () => onCardClick(index, card));
    }
    el.hand.appendChild(btn);
  });
}

/* ---------- 8. Acciones del jugador (cliente → servidor) ---------- */
function onCardClick(index, card) {
  const g = state.game;
  if (!g || !g.isMyTurn || g.isPaused) return;

  if (esComodin(card)) {
    // Comodín: primero elegimos color, luego enviamos playCard.
    state.pendingCardIndex = index;
    el.colorModal.classList.remove("hidden");
  } else {
    send("playCard", { index, chosenColor: null });
  }
}

function elegirColor(color) {
  if (state.pendingCardIndex === null) return;
  send("playCard", { index: state.pendingCardIndex, chosenColor: color });
  state.pendingCardIndex = null;
  el.colorModal.classList.add("hidden");
}

/* ---------- 9. Modales ---------- */
function showPopup(mensaje) {
  el.popupText.textContent = mensaje || "Debes resolver una penalización.";
  el.popupModal.classList.remove("hidden");
  el.pauseHint.classList.add("hidden");
}

function showOver(mensaje) {
  state.gameOver = true;
  el.overText.textContent = mensaje || "Fin del juego.";
  // Un emoji de trofeo si alguien ganó; de otro modo, aviso.
  el.overModal.classList.remove("hidden");
}

function toast(mensaje) {
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = mensaje || "Acción no permitida.";
  el.toasts.appendChild(t);
  setTimeout(() => t.remove(), 3200);
}

/* ---------- 10. Navegación entre pantallas ---------- */
function showScreen(name) {
  el.lobby.classList.toggle("screen--active", name === "lobby");
  el.game.classList.toggle("screen--active", name === "game");
}

/* ---------- 11. Enlace de eventos de la interfaz ---------- */
function bindUI() {
  // Lobby: entrar
  const doJoin = () => {
    const nombre = el.nickname.value.trim();
    if (!nombre) { el.nickname.focus(); return; }
    state.myName = nombre;
    send("joinGame", nombre);        // ⚠️ joinGame envía el nombre como string directo
    el.joinBtn.disabled = true;
    el.joinBtn.textContent = "Entrando…";
  };
  el.joinBtn.addEventListener("click", doJoin);
  el.nickname.addEventListener("keydown", (e) => { if (e.key === "Enter") doJoin(); });

  // Mazo: robar carta
  el.deckBtn.addEventListener("click", () => {
    const g = state.game;
    if (g && g.isMyTurn && !g.isPaused) send("drawCard", {});
  });

  // Botonera UNO / CORTE
  el.unoBtn.addEventListener("click", () => send("cantarUno", {}));
  el.corteBtn.addEventListener("click", () => send("cantarCorte", {}));

  // Selección de color (comodín)
  document.querySelectorAll(".color-swatch").forEach((sw) => {
    sw.addEventListener("click", () => elegirColor(sw.dataset.color));
  });
  el.colorCancel.addEventListener("click", () => {
    state.pendingCardIndex = null;
    el.colorModal.classList.add("hidden");
  });

  // Popup bloqueante → avisar que estamos listos para reanudar
  el.popupOk.addEventListener("click", () => {
    el.popupModal.classList.add("hidden");
    send("resolvePopup", {});
  });

  // Fin de juego → recargar para volver al lobby (el servidor ya reinició la sala)
  el.overBtn.addEventListener("click", () => location.reload());
}

/* ---------- 12. Arranque ---------- */
window.addEventListener("DOMContentLoaded", () => {
  showScreen("lobby");
  bindUI();
  connect();
});
