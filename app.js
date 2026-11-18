/* ==========================================================================
   APP.JS - Moteur de Gestion du Tournoi Sportif Inter-Filières
   Synchronisation temps réel via localStorage (Onglet Admin <-> Vidéoprojecteur)
   Basé sur la logique du fichier "Planinng tip.xlsx"
   ========================================================================== */

// ============================================================================
// 🔒 SÉCURITÉ & AUTHENTIFICATION ADMIN (HASH CRYPTOGRAPHIQUE SHA-256)
// Le mot de passe n'est JAMAIS stocké en clair dans le code.
// Empreinte SHA-256 par défaut de votre mot de passe ("BDSBDEBAR") :
// ============================================================================
const DEFAULT_ADMIN_PASSWORD_HASH = "7402c4886baceceb680a9aaf6260d94fd53da013eb59502c8c6e03e4a49b50e0";
const ADMIN_HASH_STORAGE_KEY = "TIP_ADMIN_CUSTOM_HASH";

// Fonction autonome de hachage SHA-256 (standard universel, compatible tout navigateur)
function sha256(ascii) {
  function rightRotate(value, amount) { return (value >>> amount) | (value << (32 - amount)); }
  const mathPow = Math.pow;
  const maxWord = mathPow(2, 32);
  let lengthProperty = "length";
  let i, j;
  let result = "";
  const words = [];
  ascii = unescape(encodeURIComponent(ascii));
  const asciiBitLength = ascii[lengthProperty] * 8;
  let hash = [];
  let k = [];
  let primeCounter = 0;
  const isComposite = {};
  for (let candidate = 2; primeCounter < 64; candidate++) {
    if (!isComposite[candidate]) {
      for (i = 0; i < 313; i += candidate) isComposite[i] = candidate;
      hash[primeCounter] = (mathPow(candidate, 0.5) * maxWord) | 0;
      k[primeCounter++] = (mathPow(candidate, 1 / 3) * maxWord) | 0;
    }
  }
  hash = hash.slice(0, 8);
  ascii += "\x80";
  while ((ascii[lengthProperty] % 64) - 56) ascii += "\x00";
  for (i = 0; i < ascii[lengthProperty]; i++) {
    j = ascii.charCodeAt(i);
    words[i >> 2] |= j << ((3 - (i % 4)) * 8);
  }
  words[words[lengthProperty]] = (asciiBitLength / maxWord) | 0;
  words[words[lengthProperty]] = asciiBitLength;
  for (j = 0; j < words[lengthProperty]; ) {
    const w = words.slice(j, (j += 16));
    const oldHash = hash;
    hash = hash.slice(0, 8);
    for (i = 0; i < 64; i++) {
      const w15 = w[i - 15], w2 = w[i - 2];
      const s0 = rightRotate(w15, 7) ^ rightRotate(w15, 18) ^ (w15 >>> 3);
      const s1 = rightRotate(w2, 17) ^ rightRotate(w2, 19) ^ (w2 >>> 10);
      w[i] = i < 16 ? w[i] : (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      const s1h = rightRotate(hash[0], 2) ^ rightRotate(hash[0], 13) ^ rightRotate(hash[0], 22);
      const ch = (hash[0] & hash[1]) ^ (~hash[0] & hash[2]);
      const temp1 = (hash[7] + (rightRotate(hash[4], 6) ^ rightRotate(hash[4], 11) ^ rightRotate(hash[4], 25)) + ((hash[4] & hash[5]) ^ (~hash[4] & hash[6])) + k[i] + w[i]) | 0;
      const temp2 = (s1h + ((hash[0] & hash[1]) ^ (hash[0] & hash[2]) ^ (hash[1] & hash[2]))) | 0;
      hash = [(temp1 + temp2) | 0].concat(hash);
      hash[4] = (hash[4] + temp1) | 0;
    }
    for (i = 0; i < 8; i++) hash[i] = (hash[i] + oldHash[i]) | 0;
  }
  for (i = 0; i < 8; i++) {
    for (j = 3; j + 1; j--) {
      const b = (hash[i] >> (j * 8)) & 255;
      result += (b < 16 ? 0 : "") + b.toString(16);
    }
  }
  return result;
}

function getAdminPasswordHash() {
  try {
    return localStorage.getItem(ADMIN_HASH_STORAGE_KEY) || DEFAULT_ADMIN_PASSWORD_HASH;
  } catch (e) {
    return DEFAULT_ADMIN_PASSWORD_HASH;
  }
}

function verifyAdminPassword(inputPassword) {
  if (!inputPassword) return false;
  const inputHash = sha256(inputPassword);
  return inputHash === getAdminPasswordHash();
}

function changeAdminPassword(newPassword) {
  if (!newPassword || newPassword.length < 3) {
    return { success: false, message: "Le mot de passe doit comporter au moins 3 caractères." };
  }
  const newHash = sha256(newPassword);
  try {
    localStorage.setItem(ADMIN_HASH_STORAGE_KEY, newHash);
  } catch (e) {
    console.error(e);
  }
  return { success: true, hash: newHash };
}
// ============================================================================

const STORAGE_KEY = "TOURNOI_INTERFILIERES_STATE_V1";
const THEME_KEY = "TOURNOI_THEME_MODE";

// 1. Définition des 8 Filières et Couleurs officielles
const FILIERES = [
  { id: "telecom", name: "Télécom", colorName: "Jaune", hex: "#facc15", textHex: "#0f172a" },
  { id: "info", name: "Info", colorName: "Vert", hex: "#22c55e", textHex: "#0f172a" },
  { id: "matmeca", name: "Matméca", colorName: "Rouge", hex: "#ef4444", textHex: "#ffffff" },
  { id: "see", name: "SEE", colorName: "Rose", hex: "#f472b6", textHex: "#0f172a" },
  { id: "ri", name: "R&I", colorName: "Violet", hex: "#a855f7", textHex: "#ffffff" },
  { id: "elec", name: "Elec", colorName: "Bleu", hex: "#2563eb", textHex: "#ffffff" },
  { id: "ekipbar", name: "Ekip Bar", colorName: "Noir", hex: "#334155", textHex: "#ffffff" },
  { id: "admin", name: "Admin", colorName: "Orange", hex: "#f97316", textHex: "#0f172a" }
];

// 2. Barème officiel des points (Mis à jour selon les consignes) :
// • 8ème : 1 pt
// • Quart : 2 pts
// • Demi : 4 pts (inclut petite finale)
// • Finale : 5 pts (finaliste / 2ème place)
// • Vainqueur : 7 pts (gagnant / 1ère place)
// Une équipe en poule qui ne passe pas la phase obtient 0 pt.
const POINTS_SCALE = {
  POULE: 0,
  HUITIEME: 1,
  QUART: 2,
  DEMI: 4,
  FINALE: 5,
  GAGNANT: 7
};

const STAGE_LABELS = {
  POULE: "Poule (0 pt - si non qualifiée)",
  HUITIEME: "8ème de finale (1 pt)",
  QUART: "Quart de finale (2 pts)",
  DEMI: "Demi-finale (4 pts)",
  FINALE: "Finaliste (5 pts)",
  GAGNANT: "Vainqueur 🏆 (7 pts)"
};

// 3. Couleurs thématiques distinctes par sport (pour le contour, l'heure et les badges)
const SPORT_THEMES = {
  foot: {
    id: "foot",
    name: "Football",
    icon: "⚽",
    color: "#0284c7", // Bleu Océan / Sport
    accent: "#38bdf8",
    bgLight: "rgba(2, 132, 199, 0.12)",
    border: "#0284c7"
  },
  basket: {
    id: "basket",
    name: "Basketball",
    icon: "🏀",
    color: "#ea580c", // Orange Basket
    accent: "#fb923c",
    bgLight: "rgba(234, 88, 12, 0.12)",
    border: "#ea580c"
  },
  volley: {
    id: "volley",
    name: "Volleyball",
    icon: "🏐",
    color: "#2563eb", // Bleu Roi Volley
    accent: "#60a5fa",
    bgLight: "rgba(37, 99, 235, 0.12)",
    border: "#2563eb"
  },
  relais: {
    id: "relais",
    name: "Relais 4x100m",
    icon: "🏃",
    color: "#dc2626", // Rouge Piste Athlé
    accent: "#f87171",
    bgLight: "rgba(220, 38, 38, 0.12)",
    border: "#dc2626"
  },
  dodgeball: {
    id: "dodgeball",
    name: "Dodgeball",
    icon: "🤾",
    color: "#7c3aed", // Violet Intense Dodgeball
    accent: "#a78bfa",
    bgLight: "rgba(124, 58, 237, 0.12)",
    border: "#7c3aed"
  }
};

function getSportTheme(sportId) {
  return SPORT_THEMES[sportId] || {
    id: sportId,
    name: sportId,
    icon: "🏅",
    color: "#3b82f6",
    accent: "#60a5fa",
    bgLight: "rgba(59, 130, 246, 0.12)",
    border: "#3b82f6"
  };
}

// 4. Configuration par défaut des Sports (extraite de "Planinng tip.xlsx")
// Pour le foot : Gymnase 1 = COSEC et Gymnase 2 = Sport-Co
const DEFAULT_SPORTS_CONFIG = {
  foot: {
    id: "foot",
    name: "Football",
    icon: "⚽",
    teamsPerFiliere: 2,
    type: "1v1",
    startTime: "09:30",
    endTime: "12:05",
    matchDuration: 12, // minutes
    pitchesCount: 2,
    pitchNames: ["COSEC", "Sport-Co"],
    excelNote: "2 terrains pour les poules (COSEC & Sport-Co à 9h30), puis 1 seul terrain à partir de 11h00 quand le Basket commence."
  },
  basket: {
    id: "basket",
    name: "Basketball",
    icon: "🏀",
    teamsPerFiliere: 2,
    type: "1v1",
    startTime: "11:00",
    knockoutStartTime: "14:00",
    endTime: "14:55",
    matchDuration: 12,
    pitchesCount: 2,
    pitchNames: ["COSEC", "Sport-Co"],
    excelNote: "Poules de 11h00 à 12h25 sur 2 terrains. Pause repas / Show pom-pom à 13h15, puis phases finales à 14h00."
  },
  volley: {
    id: "volley",
    name: "Volleyball",
    icon: "🏐",
    teamsPerFiliere: 3,
    type: "1v1",
    startTime: "14:00",
    endTime: "17:40",
    matchDuration: 15,
    pitchesCount: 3,
    pitchNames: ["Terrain Volley 1", "Terrain Volley 2", "Terrain Volley 3"],
    excelNote: "3 terrains disponibles de 14h00 à 17h40. Adaptatif selon le nombre d'équipes."
  },
  relais: {
    id: "relais",
    name: "Relais 4x100m",
    icon: "🏃",
    teamsPerFiliere: 3,
    type: "race", // Courses de 3 ou 4 équipes simultanément
    startTime: "14:00",
    endTime: "16:00",
    matchDuration: 10,
    pitchesCount: 1,
    pitchNames: ["Piste d'Athlétisme"],
    excelNote: "Piste disponible de 14h00 à 16h00. Séries qualificatives puis finale."
  },
  dodgeball: {
    id: "dodgeball",
    name: "Dodgeball",
    icon: "🤾",
    teamsPerFiliere: 3,
    type: "1v1",
    startTime: "15:00",
    endTime: "17:10",
    matchDuration: 10,
    pitchesCount: 3,
    pitchNames: ["COSEC Terrain 1", "COSEC Terrain 2", "COSEC Terrain 3"],
    excelNote: "Gymnase COSEC de 15h00 à 17h10 : 3 terrains en parallèle."
  }
};

// ============================================================================
// INITIALISATION & PERSISTANCE (LOCALSTORAGE)
// ============================================================================
function createInitialState() {
  const sports = {};
  Object.keys(DEFAULT_SPORTS_CONFIG).forEach(sportId => {
    const cfg = DEFAULT_SPORTS_CONFIG[sportId];
    const teams = [];
    FILIERES.forEach(filiere => {
      for (let i = 1; i <= cfg.teamsPerFiliere; i++) {
        teams.push({
          id: `${sportId}_${filiere.id}_${i}`,
          name: `${filiere.name} ${i}`,
          filiereId: filiere.id,
          teamNumber: i,
          active: true,
          stageReached: "POULE", // Départ en poule (0 pt)
          manualPointsBonus: 0
        });
      }
    });

    sports[sportId] = {
      ...cfg,
      initialized: false,
      teams: teams,
      pools: [],
      matches: []
    };
  });

  return {
    lastUpdated: new Date().toISOString(),
    tournamentTitle: "TIP",
    pompomMode: false, // Mode Show POM-POM / Pause Repas (13h15)
    flashInfo: {
      active: false,
      message: "",
      level: "urgent", // "info", "urgent", "call"
      timestamp: null
    },
    liveScore: {
      active: false,
      title: "Match 1",
      teamAName: "Équipe A",
      teamAColor: "#ef4444",
      scoreA: 0,
      teamBName: "Équipe B",
      teamBColor: "#2563eb",
      scoreB: 0,
      timerMinutes: 10,
      timerSeconds: 0,
      timerRunning: false,
      timerEndsAt: null,
      timerRemainingOnPause: 600,
      updatedAt: Date.now()
    },
    liveMatches: {
      match_1: {
        id: "match_1",
        active: false,
        title: "FINALE FOOTBALL",
        teamAName: "Matméca",
        teamAColor: "#ef4444",
        teamAFiliereId: "matmeca",
        scoreA: 0,
        teamBName: "Elec",
        teamBColor: "#2563eb",
        teamBFiliereId: "elec",
        scoreB: 0,
        timerMinutes: 10,
        timerSeconds: 0,
        timerRunning: false,
        timerEndsAt: null,
        timerRemainingOnPause: 600,
        updatedAt: Date.now()
      }
    },
    sports: sports
  };
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    let state;
    if (!raw) {
      state = createInitialState();
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      } catch (e) {}
      return state;
    }
    state = JSON.parse(raw);
    let needsSave = false;

    // Initialiser les drapeaux manquants si ancienne version
    if (state.pompomMode === undefined) {
      state.pompomMode = false;
      needsSave = true;
    }

    if (state.tournamentTitle !== "TIP") {
      state.tournamentTitle = "TIP";
      needsSave = true;
    }

    if (!state.flashInfo) {
      state.flashInfo = {
        active: false,
        message: "",
        level: "urgent",
        timestamp: null
      };
      needsSave = true;
    }

    if (!state.liveScore) {
      state.liveScore = {
        active: false,
        title: "Match 1",
        teamAName: "Équipe A",
        teamAColor: "#ef4444",
        scoreA: 0,
        teamBName: "Équipe B",
        teamBColor: "#2563eb",
        scoreB: 0,
        timerMinutes: 10,
        timerSeconds: 0,
        timerRunning: false,
        timerEndsAt: null,
        timerRemainingOnPause: 600,
        updatedAt: Date.now()
      };
      needsSave = true;
    }

    if (!state.liveMatches || typeof state.liveMatches !== "object") {
      state.liveMatches = {};
      if (state.liveScore) {
        state.liveMatches.match_1 = {
          id: "match_1",
          active: Boolean(state.liveScore.active),
          title: state.liveScore.title || "FINALE FOOTBALL",
          teamAName: state.liveScore.teamAName || "Matméca",
          teamAColor: state.liveScore.teamAColor || "#ef4444",
          teamAFiliereId: state.liveScore.teamAFiliereId || "matmeca",
          scoreA: state.liveScore.scoreA || 0,
          teamBName: state.liveScore.teamBName || "Elec",
          teamBColor: state.liveScore.teamBColor || "#2563eb",
          teamBFiliereId: state.liveScore.teamBFiliereId || "elec",
          scoreB: state.liveScore.scoreB || 0,
          timerMinutes: state.liveScore.timerMinutes !== undefined ? state.liveScore.timerMinutes : 10,
          timerSeconds: state.liveScore.timerSeconds !== undefined ? state.liveScore.timerSeconds : 0,
          timerRunning: Boolean(state.liveScore.timerRunning),
          timerEndsAt: state.liveScore.timerEndsAt || null,
          timerRemainingOnPause: state.liveScore.timerRemainingOnPause !== undefined ? state.liveScore.timerRemainingOnPause : 600,
          updatedAt: Date.now()
        };
      }
      needsSave = true;
    }

    // 1. Nettoyage et synchronisation Relais (Piste d'Athlétisme)
    if (state.sports && state.sports.relais) {
      const targetRelaisPitch = (DEFAULT_SPORTS_CONFIG.relais && DEFAULT_SPORTS_CONFIG.relais.pitchNames && DEFAULT_SPORTS_CONFIG.relais.pitchNames[0])
        ? DEFAULT_SPORTS_CONFIG.relais.pitchNames[0]
        : "Piste d'Athlétisme";

      if (state.sports.relais.pitchNames) {
        state.sports.relais.pitchNames = state.sports.relais.pitchNames.map(p => {
          if (p.includes("Couloirs 1-4") || p.includes("(Couloirs")) {
            needsSave = true;
            return targetRelaisPitch;
          }
          return p;
        });
      }
      if (Array.isArray(state.sports.relais.matches)) {
        state.sports.relais.matches.forEach(m => {
          if (m.pitch && (m.pitch.includes("Couloirs 1-4") || m.pitch.includes("(Couloirs"))) {
            m.pitch = targetRelaisPitch;
            needsSave = true;
          }
        });
      }
    }

    // 2. Migration Foot : Gymnase 1 -> COSEC, Gymnase 2 -> Sport-Co
    if (state.sports && state.sports.foot) {
      state.sports.foot.pitchNames = ["COSEC", "Sport-Co"];
      if (Array.isArray(state.sports.foot.matches)) {
        state.sports.foot.matches.forEach(m => {
          if (m.pitch && (m.pitch.includes("Gymnase 1") || m.pitch.includes("Terrain A"))) {
            m.pitch = "COSEC";
            needsSave = true;
          } else if (m.pitch && (m.pitch.includes("Gymnase 2") || m.pitch.includes("Terrain B"))) {
            m.pitch = "Sport-Co";
            needsSave = true;
          }
        });
      }
    }

    // 3. Migration Basket : Gymnase Multisport 1 -> COSEC, Gymnase Multisport 2 -> Sport-Co
    if (state.sports && state.sports.basket) {
      state.sports.basket.pitchNames = ["COSEC", "Sport-Co"];
      if (Array.isArray(state.sports.basket.matches)) {
        state.sports.basket.matches.forEach(m => {
          if (m.pitch && (m.pitch.includes("Gymnase Multisport 1") || m.pitch.includes("Multisport 1"))) {
            m.pitch = "COSEC";
            needsSave = true;
          } else if (m.pitch && (m.pitch.includes("Gymnase Multisport 2") || m.pitch.includes("Multisport 2"))) {
            m.pitch = "Sport-Co";
            needsSave = true;
          }
        });
      }
    }

    // 4. Nettoyage global sur tous les sports pour d'anciens libellés "Gymnase Multisport"
    if (state.sports) {
      Object.values(state.sports).forEach(sport => {
        if (sport.pitchNames) {
          sport.pitchNames = sport.pitchNames.map(p => {
            if (p.includes("Gymnase Multisport 1")) { needsSave = true; return "COSEC"; }
            if (p.includes("Gymnase Multisport 2")) { needsSave = true; return "Sport-Co"; }
            return p;
          });
        }
        if (Array.isArray(sport.matches)) {
          sport.matches.forEach(m => {
            if (m.pitch && m.pitch.includes("Gymnase Multisport 1")) {
              m.pitch = "COSEC";
              needsSave = true;
            } else if (m.pitch && m.pitch.includes("Gymnase Multisport 2")) {
              m.pitch = "Sport-Co";
              needsSave = true;
            }
          });
        }
      });
    }

    // 5. Migration automatique : Ajout des équipes de la filière Elec si absentes
    if (state.sports) {
      Object.keys(DEFAULT_SPORTS_CONFIG).forEach(sportId => {
        const sport = state.sports[sportId];
        if (!sport || !Array.isArray(sport.teams)) return;
        const cfg = DEFAULT_SPORTS_CONFIG[sportId];
        const hasElec = sport.teams.some(t => t.filiereId === "elec");
        if (!hasElec) {
          const count = cfg.teamsPerFiliere || 2;
          for (let i = 1; i <= count; i++) {
            sport.teams.push({
              id: `${sportId}_elec_${i}`,
              name: `Elec ${i}`,
              filiereId: "elec",
              teamNumber: i,
              active: true,
              stageReached: "POULE",
              manualPointsBonus: 0
            });
          }
          needsSave = true;
        }
      });
    }

    // 6. Nettoyage automatique des phases finales (enlève 8èmes et quarts si pas assez de qualifiés)
    if (state.sports) {
      Object.values(state.sports).forEach(sport => {
        if (cleanupUnneededKnockoutMatches(sport)) {
          needsSave = true;
        }
      });
    }

    if (needsSave) {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      } catch (e) {}
    }

    return state;
  } catch (e) {
    console.error("Erreur lecture localStorage:", e);
    return createInitialState();
  }
}

let saveStateDebounceTimer = null;
let pendingStateToSave = null;
let isSavingToServer = false;

function saveState(state) {
  state.lastUpdated = new Date().toISOString();
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    console.error("Erreur saveState localStorage:", e);
  }

  // Si on est dans un environnement sans HTTP (ex: Node test ou file://), s'arrêter là
  if (typeof fetch !== "function" || typeof window === "undefined" || !window.location.protocol.startsWith("http")) {
    return;
  }

  // Débouncage & mise en file d'attente pour éviter les requêtes concurrentes lors des clics rapides (+1 / -1)
  pendingStateToSave = state;
  if (saveStateDebounceTimer) {
    clearTimeout(saveStateDebounceTimer);
  }

  saveStateDebounceTimer = setTimeout(() => {
    executeServerSave();
  }, 120);
}

function executeServerSave() {
  if (isSavingToServer || !pendingStateToSave) return;
  const stateToSend = pendingStateToSave;
  pendingStateToSave = null;
  isSavingToServer = true;

  fetch("/api/state", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(stateToSend)
  })
  .then(() => {})
  .catch(() => {})
  .finally(() => {
    isSavingToServer = false;
    // Si d'autres modifications ont eu lieu pendant la requête, envoyer la version la plus fraîche
    if (pendingStateToSave) {
      setTimeout(executeServerSave, 50);
    }
  });
}

function resetAllTournament() {
  const fresh = createInitialState();
  saveState(fresh);
  return fresh;
}

// ============================================================================
// UTILITAIRES HORAIRES, COULEURS & MÉLANGE ALÉATOIRE
// ============================================================================
function getFiliereById(filiereId) {
  return FILIERES.find(f => f.id === filiereId) || FILIERES[0];
}

function addMinutesToTime(timeStr, minsToAdd) {
  if (!timeStr || !timeStr.includes(":")) return timeStr || "00:00";
  const [hh, mm] = timeStr.split(":").map(Number);
  let total = hh * 60 + mm + minsToAdd;
  while (total < 0) total += 24 * 60;
  const newH = Math.floor(total / 60) % 24;
  const newM = total % 60;
  return `${String(newH).padStart(2, "0")}:${String(newM).padStart(2, "0")}`;
}

function shuffleArray(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// ============================================================================
// DÉCALAGE HORAIRE GLOBAL PAR SPORT & PAR TERRAIN
// ============================================================================
function shiftSportSchedule(sportId, deltaMinutes, pitchFilter = "ALL") {
  const state = loadState();
  const sport = state.sports[sportId];
  if (!sport || !Array.isArray(sport.matches) || sport.matches.length === 0) {
    return { success: false, message: "Aucun match généré pour ce sport." };
  }

  let count = 0;
  sport.matches.forEach(m => {
    // Ne décaler que les matchs non terminés (sans score renseigné)
    const isFinished = (m.scoreA !== null && m.scoreB !== null && m.scoreA !== "" && m.scoreB !== "") ||
                       (m.raceResults && Object.keys(m.raceResults).length > 0);
    if (isFinished) return;

    if (pitchFilter && pitchFilter !== "ALL" && m.pitch !== pitchFilter) return;

    m.time = addMinutesToTime(m.time, deltaMinutes);
    count++;
  });

  saveState(state);
  return { success: true, count, delta: deltaMinutes };
}

// ============================================================================
// GESTION DU FLASH INFO & DES ALERTES PLEIN ÉCRAN
// ============================================================================
function setFlashInfo(active, message = "", level = "urgent") {
  const state = loadState();
  state.flashInfo = {
    active: Boolean(active),
    message: String(message || "").trim(),
    level: level || "urgent",
    timestamp: new Date().toISOString()
  };
  saveState(state);

  // Émission directe au serveur si disponible
  if (typeof fetch === "function" && typeof window !== "undefined" && window.location.protocol.startsWith("http")) {
    fetch("/api/flash", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(state.flashInfo)
    }).catch(() => {});
  }

  return state.flashInfo;
}

let sharedAudioContext = null;

function getSharedAudioContext() {
  if (typeof window === "undefined") return null;
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return null;
  if (!sharedAudioContext) {
    sharedAudioContext = new AudioCtx();
  }
  if (sharedAudioContext.state === "suspended") {
    sharedAudioContext.resume().catch(() => {});
  }
  return sharedAudioContext;
}

// Déverrouillage automatique du son et des vibrations au premier contact tactile ou clic
if (typeof window !== "undefined") {
  const unlockAudio = () => {
    const ctx = getSharedAudioContext();
    if (ctx && ctx.state === "suspended") {
      ctx.resume().catch(() => {});
    }
    // Demander la permission de notification discrètement si disponible
    if ("Notification" in window && Notification.permission === "default") {
      try { Notification.requestPermission(); } catch (e) {}
    }
  };
  window.addEventListener("touchstart", unlockAudio, { once: true, passive: true });
  window.addEventListener("click", unlockAudio, { once: true, passive: true });
}

// Signal sonore d'alerte haute clarté synthétisé via Web Audio API (0 fichier externe)
function playAlertChime() {
  try {
    const ctx = getSharedAudioContext();
    if (!ctx) return;
    if (ctx.state === "suspended") {
      ctx.resume().catch(() => {});
    }
    const now = ctx.currentTime;

    // Son d'annonce à 3 notes montantes percutantes (523Hz C5 -> 659Hz E5 -> 784Hz G5)
    const tones = [
      { freq: 523.25, time: now, dur: 0.18, gain: 0.5 },
      { freq: 659.25, time: now + 0.18, dur: 0.18, gain: 0.55 },
      { freq: 783.99, time: now + 0.36, dur: 0.45, gain: 0.6 }
    ];

    tones.forEach(t => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(t.freq, t.time);
      gain.gain.setValueAtTime(0.01, t.time);
      gain.gain.linearRampToValueAtTime(t.gain, t.time + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.001, t.time + t.dur);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t.time);
      osc.stop(t.time + t.dur);
    });
  } catch (e) {
    console.debug("AudioChime:", e);
  }
}

// Alarme sonore puissante de fin de match / coup de sifflet électronique
function playMatchEndBuzzer() {
  try {
    const ctx = getSharedAudioContext();
    if (!ctx) return;
    if (ctx.state === "suspended") {
      ctx.resume().catch(() => {});
    }
    const now = ctx.currentTime;

    // 3 bips puissants style buzzer de gymnase
    [0, 0.35, 0.70].forEach(delay => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sawtooth";
      osc.frequency.setValueAtTime(440, now + delay);
      osc.frequency.exponentialRampToValueAtTime(320, now + delay + 0.28);
      gain.gain.setValueAtTime(0.6, now + delay);
      gain.gain.exponentialRampToValueAtTime(0.01, now + delay + 0.28);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + delay);
      osc.stop(now + delay + 0.28);
    });

    if (typeof navigator !== "undefined" && "vibrate" in navigator) {
      try { navigator.vibrate([300, 100, 300, 100, 600]); } catch (e) {}
    }
  } catch (e) {
    console.debug("Buzzer:", e);
  }
}

// Notification push et vibration sur smartphone (pattern fort 500ms - 200ms - 500ms)
function triggerMobileAlert(title, body) {
  playAlertChime();
  if (typeof navigator !== "undefined" && "vibrate" in navigator) {
    try {
      navigator.vibrate([500, 200, 500, 200, 500]);
    } catch (e) {}
  }
  if (typeof window !== "undefined" && "Notification" in window && Notification.permission === "granted") {
    try {
      new Notification(title, {
        body: body,
        icon: "favicon.ico",
        vibrate: [500, 200, 500]
      });
    } catch (e) {}
  }
}

let lastSeenFlashTimestamp = null;

// Synchronisation temps réel avec le serveur local (SSE) + fallback polling
function initServerSync(onUpdateCallback) {
  if (typeof window !== "undefined" && window.location.protocol.startsWith("http")) {
    let es = null;

    function connectSSE() {
      try {
        es = new EventSource("/api/events");
        es.onmessage = function(e) {
          try {
            const data = JSON.parse(e.data);
            if (data.type === "STATE_UPDATE" && data.state) {
              const prevState = loadState();
              localStorage.setItem(STORAGE_KEY, JSON.stringify(data.state));
              // Détection alerte flash via STATE_UPDATE
              if (data.state.flashInfo && data.state.flashInfo.active) {
                const prevTs = (prevState && prevState.flashInfo) ? prevState.flashInfo.timestamp : null;
                if (data.state.flashInfo.timestamp && data.state.flashInfo.timestamp !== prevTs && data.state.flashInfo.timestamp !== lastSeenFlashTimestamp) {
                  lastSeenFlashTimestamp = data.state.flashInfo.timestamp;
                  triggerMobileAlert("📢 Flash Info TIP", data.state.flashInfo.message);
                }
              }
              if (typeof onUpdateCallback === "function") onUpdateCallback(data.state);
            } else if (data.type === "FLASH_INFO" && data.flashInfo) {
              const state = loadState();
              state.flashInfo = data.flashInfo;
              localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
              if (data.flashInfo.active && data.flashInfo.timestamp !== lastSeenFlashTimestamp) {
                lastSeenFlashTimestamp = data.flashInfo.timestamp;
                triggerMobileAlert("📢 Flash Info TIP", data.flashInfo.message);
              }
              if (typeof onUpdateCallback === "function") onUpdateCallback(state);
            } else if (data.type === "TUNNEL_UPDATE" || (data.type === "CONNECTED" && (data.publicUrl || data.mobileUrl))) {
              const mobileUrl = data.mobileUrl || data.publicUrl;
              if (mobileUrl && typeof window !== "undefined") {
                window.dispatchEvent(new CustomEvent("tip:tunnel_update", {
                  detail: {
                    mobileUrl: mobileUrl,
                    publicUrl: data.publicUrl || null,
                    tunnelActive: Boolean(data.publicUrl)
                  }
                }));
              }
            }
          } catch (err) {
            console.debug("SSE Parse Error:", err);
          }
        };

        es.onerror = function() {
          // Si SSE est coupé par un proxy mobile 4G ou veille de téléphone, reconnection automatique
          if (es) {
            es.close();
            es = null;
          }
          setTimeout(connectSSE, 3000);
        };
      } catch (e) {
        console.debug("SSE non supporté:", e);
      }
    }

    connectSSE();

    // Fallback polling périodique (toutes les 4 secondes) pour garantir les alertes sur smartphone
    // même si un navigateur mobile ou Cloudflare met en pause la connexion EventSource
    setInterval(() => {
      fetch("/api/state")
        .then(res => res.ok ? res.json() : null)
        .then(serverState => {
          if (!serverState || !serverState.sports) return;
          const localRaw = localStorage.getItem(STORAGE_KEY);
          const localState = localRaw ? JSON.parse(localRaw) : null;

          // Détecter si l'état ou le flashInfo a changé
          const hasFlashChange = Boolean(
            serverState.flashInfo &&
            serverState.flashInfo.active &&
            (!localState || !localState.flashInfo || localState.flashInfo.timestamp !== serverState.flashInfo.timestamp)
          );

          const hasStateChange = Boolean(
            !localState ||
            serverState.lastUpdated !== localState.lastUpdated ||
            hasFlashChange
          );

          if (hasStateChange) {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(serverState));
            if (hasFlashChange && serverState.flashInfo.timestamp !== lastSeenFlashTimestamp) {
              lastSeenFlashTimestamp = serverState.flashInfo.timestamp;
              triggerMobileAlert("📢 Flash Info TIP", serverState.flashInfo.message);
            }
            if (typeof onUpdateCallback === "function") {
              onUpdateCallback(serverState);
            }
          }
        })
        .catch(() => {});
    }, 4000);
  }
}

// ============================================================================
// GESTION & COMPOSITION MANUELLE DES POULES
// ============================================================================
function getSportQualifiersPerPool(sport) {
  if (sport.qualifiersPerPool !== undefined && sport.qualifiersPerPool !== null) {
    return Number(sport.qualifiersPerPool);
  }
  const poolsCount = (sport.pools || []).length;
  if (poolsCount === 4) return 2;
  if (poolsCount === 2) return 2;
  if (poolsCount === 3) return 1;
  if (poolsCount === 1) return 4;
  return 2;
}

function getSportQualifiersCount(sport) {
  if (sport.type === "race") return 4;
  const pools = sport.pools || [];
  if (pools.length === 0) return (sport.teams || []).filter(t => t.active).length;

  const qPerPool = getSportQualifiersPerPool(sport);
  if (pools.length === 3) {
    if (qPerPool >= 5) return 16;
    if (qPerPool >= 2) return 8;
    return 4; // 3 premiers + 1 meilleur 2ème
  }
  if (pools.length === 1) {
    return qPerPool;
  }
  return pools.length * qPerPool;
}

function setSportPoolsCount(sport, targetCount) {
  targetCount = Math.max(1, Math.min(6, Number(targetCount)));
  if (!sport.pools) sport.pools = [];

  while (sport.pools.length < targetCount) {
    const nextIdx = sport.pools.length + 1;
    sport.pools.push({
      id: `poule_${nextIdx}`,
      name: `Poule ${nextIdx}`,
      teamIds: []
    });
  }

  while (sport.pools.length > targetCount) {
    sport.pools.pop();
  }
}

function addSportPool(sport, customName) {
  if (!sport.pools) sport.pools = [];
  const nextIdx = sport.pools.length + 1;
  sport.pools.push({
    id: `poule_${Date.now()}_${nextIdx}`,
    name: customName || `Poule ${nextIdx}`,
    teamIds: []
  });
}

function removeSportPool(sport, poolId) {
  if (!sport.pools) return;
  sport.pools = sport.pools.filter(p => p.id !== poolId);
}

function renameSportPool(sport, poolId, newName) {
  if (!sport.pools) return;
  const p = sport.pools.find(pool => pool.id === poolId);
  if (p && newName) p.name = newName.trim();
}

function assignTeamToSportPool(sport, teamId, targetPoolId) {
  if (!sport.pools) return;
  sport.pools.forEach(p => {
    p.teamIds = (p.teamIds || []).filter(id => id !== teamId);
  });
  if (targetPoolId && targetPoolId !== "none") {
    const target = sport.pools.find(p => p.id === targetPoolId);
    if (target && !target.teamIds.includes(teamId)) {
      target.teamIds.push(teamId);
    }
  }
}

function removeTeamFromSportPool(sport, teamId) {
  assignTeamToSportPool(sport, teamId, "none");
}

function autoDistributeTeamsToPools(sport) {
  if (!sport.pools || sport.pools.length === 0) {
    setSportPoolsCount(sport, 2);
  }
  const activeTeams = (sport.teams || []).filter(t => t.active);
  sport.pools.forEach(p => p.teamIds = []);

  const sorted = [...activeTeams].sort((a, b) => a.filiereId.localeCompare(b.filiereId));
  sorted.forEach((team, idx) => {
    sport.pools[idx % sport.pools.length].teamIds.push(team.id);
  });
}

function clearAllSportPools(sport) {
  if (!sport.pools) return;
  sport.pools.forEach(p => p.teamIds = []);
}

function updateSportQualifiersPerPool(sport, val) {
  sport.qualifiersPerPool = Number(val);
  cleanupUnneededKnockoutMatches(sport);
}

// Règle TIP : Enlève les 8èmes et quarts si pas assez de qualifiés
function cleanupUnneededKnockoutMatches(sport) {
  if (!sport || sport.type === "race" || !sport.matches) return false;
  const numQualifiers = getSportQualifiersCount(sport);
  let changed = false;

  // 8èmes nécessitent au moins 16 qualifiés
  if (numQualifiers < 16) {
    const prevLen = sport.matches.length;
    sport.matches = sport.matches.filter(m => m.phase !== "HUITIEME");
    if (sport.matches.length !== prevLen) changed = true;
  }
  // Quarts nécessitent au moins 8 qualifiés
  if (numQualifiers < 8) {
    const prevLen = sport.matches.length;
    sport.matches = sport.matches.filter(m => m.phase !== "QUART");
    if (sport.matches.length !== prevLen) changed = true;
  }
  // Demis nécessitent au moins 4 qualifiés
  if (numQualifiers < 4) {
    const prevLen = sport.matches.length;
    sport.matches = sport.matches.filter(m => m.phase !== "DEMI" && m.phase !== "PETITE_FINALE");
    if (sport.matches.length !== prevLen) changed = true;
  }

  // Mettre à jour les placeholders des demis si pas de quarts
  const quarters = sport.matches.filter(m => m.phase === "QUART");
  const semis = sport.matches.filter(m => m.phase === "DEMI");
  if (quarters.length === 0 && semis.length === 2 && sport.pools && sport.pools.length >= 2) {
    if (semis[0].placeholderA && semis[0].placeholderA.includes("Quart")) {
      semis[0].placeholderA = "1er Poule 1";
      semis[0].placeholderB = "2ème Poule 2";
      semis[1].placeholderA = "1er Poule 2";
      semis[1].placeholderB = "2ème Poule 1";
      changed = true;
    }
  }

  return changed;
}

// ============================================================================
// INITIALISATION ALÉATOIRE COMPLÈTE DU SPORT
// ============================================================================
function initializeSportSchedule(state, sportId) {
  const sport = state.sports[sportId];
  const activeTeams = shuffleArray(sport.teams.filter(t => t.active));

  if (activeTeams.length < 2) {
    alert("Il faut au moins 2 équipes actives pour initialiser ce sport.");
    return false;
  }

  sport.teams.forEach(t => {
    t.stageReached = t.active ? "POULE" : null;
  });

  if (sport.type === "race") {
    const n = activeTeams.length;
    const heatSize = n % 3 === 0 && n <= 9 ? 3 : 4;
    const numHeats = Math.ceil(n / heatSize);
    sport.pools = Array.from({ length: numHeats }, (_, idx) => ({
      id: `serie_${idx + 1}`,
      name: `Série qualificative ${idx + 1}`,
      teamIds: []
    }));
    activeTeams.forEach((team, index) => {
      sport.pools[index % numHeats].teamIds.push(team.id);
    });
    sport.matches = [];
    formatAndScheduleRelayMatches(sport, activeTeams);
  } else {
    const n = activeTeams.length;
    let numPools = n <= 5 ? 1 : n <= 8 ? 2 : n <= 11 ? 3 : 4;
    sport.pools = Array.from({ length: numPools }, (_, idx) => ({
      id: `poule_${idx + 1}`,
      name: `Poule ${idx + 1}`,
      teamIds: []
    }));
    const sortedByFiliere = [...activeTeams].sort((a, b) => a.filiereId.localeCompare(b.filiereId));
    sortedByFiliere.forEach((team, index) => {
      sport.pools[index % numPools].teamIds.push(team.id);
    });
    sport.matches = [];
    formatAndScheduleTeamSportMatches(sport, activeTeams);
  }

  cleanupUnneededKnockoutMatches(sport);
  sport.initialized = true;
  recalculateSportStages(sport);
  saveState(state);
  return true;
}

// ============================================================================
// MODE COMPLÉTER : PREND LES POULES (MANUELLES OU EXISTANTES), GÉNÈRE LES MATCHS
// ET LES HORAIRES, ET REMET TOUT PROPREMENT EN FORME
// ============================================================================
function completeSportSchedule(state, sportId) {
  const sport = state.sports[sportId];
  if (!sport) return false;

  const activeTeams = sport.teams.filter(t => t.active);
  if (activeTeams.length < 2) {
    alert("Il faut au moins 2 équipes actives pour ce sport.");
    return false;
  }

  // Si aucune poule n'est encore définie, en créer par défaut
  if (!sport.pools || sport.pools.length === 0) {
    const n = activeTeams.length;
    let numPools = n <= 5 ? 1 : n <= 8 ? 2 : n <= 11 ? 3 : 4;
    sport.pools = Array.from({ length: numPools }, (_, idx) => ({
      id: `poule_${idx + 1}`,
      name: `Poule ${idx + 1}`,
      teamIds: []
    }));
  }

  // Équipes actives non encore assignées à une poule
  const assigned = new Set();
  sport.pools.forEach(p => (p.teamIds || []).forEach(id => assigned.add(id)));
  const unassigned = activeTeams.filter(t => !assigned.has(t.id));

  // Répartir automatiquement les équipes non assignées dans les poules les moins remplies
  if (unassigned.length > 0) {
    unassigned.forEach(team => {
      sport.pools.sort((a, b) => (a.teamIds || []).length - (b.teamIds || []).length);
      if (!sport.pools[0].teamIds) sport.pools[0].teamIds = [];
      sport.pools[0].teamIds.push(team.id);
    });
  }

  if (sport.type === "race") {
    formatAndScheduleRelayMatches(sport, activeTeams);
  } else {
    formatAndScheduleTeamSportMatches(sport, activeTeams);
  }

  cleanupUnneededKnockoutMatches(sport);
  sport.initialized = true;
  recalculateSportStages(sport);
  saveState(state);
  return true;
}

// --- Cas 1 : Sports 1v1 (Foot, Basket, Volley, Dodgeball) ---
function formatAndScheduleTeamSportMatches(sport, activeTeams) {
  const pools = sport.pools || [];
  const existingMatches = sport.matches || [];

  // 1. Extraire les paires Round-Robin par poule (conserve les scores existants)
  const rawPoolMatches = [];
  pools.forEach(pool => {
    const tIds = (pool.teamIds || []).filter(tid => activeTeams.some(t => t.id === tid));
    let poolMatchNum = 1;
    for (let i = 0; i < tIds.length; i++) {
      for (let j = i + 1; j < tIds.length; j++) {
        const tA = tIds[i];
        const tB = tIds[j];

        const existing = existingMatches.find(m =>
          m.phase === "POULE" && m.poolId === pool.id &&
          ((m.teamAId === tA && m.teamBId === tB) || (m.teamAId === tB && m.teamBId === tA))
        );

        if (existing) {
          existing.poolName = pool.name;
          rawPoolMatches.push(existing);
        } else {
          rawPoolMatches.push({
            id: `${sport.id}_P${pool.id}_${tA}_${tB}`,
            phase: "POULE",
            label: `${pool.name} • Match ${poolMatchNum++}`,
            poolId: pool.id,
            poolName: pool.name,
            teamAId: tA,
            teamBId: tB,
            scoreA: null,
            scoreB: null,
            referee: "",
            status: "scheduled"
          });
        }
      }
    }
  });

  // 2. Ordonnancer et planifier proprement les matchs de poule ("remettre bien en forme")
  const poolMatchesScheduled = [];
  let currentTime = sport.startTime;
  const remaining = [...rawPoolMatches];
  let orderCounter = 1;

  while (remaining.length > 0) {
    let availablePitches = sport.pitchesCount;
    if (sport.id === "foot" && currentTime >= "11:00") {
      availablePitches = 1;
    }

    const busyTeamsInSlot = new Set();
    for (let p = 0; p < availablePitches && remaining.length > 0; p++) {
      let chosenIdx = remaining.findIndex(
        m => !busyTeamsInSlot.has(m.teamAId) && !busyTeamsInSlot.has(m.teamBId)
      );
      if (chosenIdx === -1) break;

      const m = remaining.splice(chosenIdx, 1)[0];
      busyTeamsInSlot.add(m.teamAId);
      busyTeamsInSlot.add(m.teamBId);

      const pitchName = sport.pitchNames[p] || `Terrain ${p + 1}`;
      m.order = orderCounter++;
      // Ne réassigner heure et terrain que pour les matchs non joués ou sans heure
      if (m.scoreA === null || m.scoreB === null || !m.time) {
        m.time = currentTime;
        m.pitch = pitchName;
      }
      poolMatchesScheduled.push(m);
    }
    currentTime = addMinutesToTime(currentTime, sport.matchDuration);
  }

  // 3. Phases Finales (Quarts / Demis / Finales selon qualifiés)
  let knockoutTime = currentTime;
  if (sport.knockoutStartTime && knockoutTime < sport.knockoutStartTime) {
    knockoutTime = sport.knockoutStartTime;
  }

  const numQualifiers = getSportQualifiersCount(sport);
  const includeEighths = numQualifiers >= 16;
  const includeQuarters = numQualifiers >= 8;
  const includeSemis = numQualifiers >= 4;

  const knockoutMatches = [];

  // 8èmes de finale (si >= 16 qualifiés)
  if (includeEighths) {
    for (let q = 1; q <= 8; q += sport.pitchesCount) {
      for (let p = 0; p < sport.pitchesCount && (q + p) <= 8; p++) {
        const idx = q + p;
        const existing = existingMatches.find(m => m.phase === "HUITIEME" && m.id === `${sport.id}_H${idx}`);
        knockoutMatches.push(existing || {
          id: `${sport.id}_H${idx}`,
          order: orderCounter++,
          phase: "HUITIEME",
          label: `8ème de finale ${idx}`,
          time: knockoutTime,
          pitch: sport.pitchNames[p] || `Terrain ${p + 1}`,
          teamAId: null,
          teamBId: null,
          placeholderA: `Qualifié 8ème #${idx * 2 - 1}`,
          placeholderB: `Qualifié 8ème #${idx * 2}`,
          scoreA: null,
          scoreB: null,
          referee: "",
          status: "scheduled"
        });
      }
      knockoutTime = addMinutesToTime(knockoutTime, sport.matchDuration);
    }
  }

  // Quarts de finale (si >= 8 qualifiés)
  if (includeQuarters) {
    for (let q = 1; q <= 4; q += sport.pitchesCount) {
      for (let p = 0; p < sport.pitchesCount && (q + p) <= 4; p++) {
        const idx = q + p;
        const existing = existingMatches.find(m => m.phase === "QUART" && m.id === `${sport.id}_Q${idx}`);
        knockoutMatches.push(existing || {
          id: `${sport.id}_Q${idx}`,
          order: orderCounter++,
          phase: "QUART",
          label: `Quart de finale ${idx}`,
          time: knockoutTime,
          pitch: sport.pitchNames[p] || `Terrain ${p + 1}`,
          teamAId: null,
          teamBId: null,
          placeholderA: includeEighths ? `Vainqueur 8ème ${idx * 2 - 1}` : `Qualifié Quart #${idx * 2 - 1}`,
          placeholderB: includeEighths ? `Vainqueur 8ème ${idx * 2}` : `Qualifié Quart #${idx * 2}`,
          scoreA: null,
          scoreB: null,
          referee: "",
          status: "scheduled"
        });
      }
      knockoutTime = addMinutesToTime(knockoutTime, sport.matchDuration);
    }
  }

  // Demi-finales (si >= 4 qualifiés)
  if (includeSemis) {
    const semiPlaceholders = [
      ["1er Poule 1", pools.length >= 2 ? "2ème Poule 2" : "4ème Poule 1"],
      [pools.length >= 2 ? "1er Poule 2" : "2ème Poule 1", pools.length >= 3 ? "1er Poule 3 / Meilleur 2e" : "3ème Poule 1"]
    ];

    for (let s = 0; s < 2; s++) {
      const pitchIdx = s < sport.pitchesCount ? s : 0;
      if (s > 0 && sport.pitchesCount === 1) {
        knockoutTime = addMinutesToTime(knockoutTime, sport.matchDuration);
      }
      const existing = existingMatches.find(m => m.phase === "DEMI" && (m.id === `${sport.id}_D${s + 1}` || m.label.includes(`Demi-finale ${s + 1}`)));
      const phA = includeQuarters ? `Vainqueur Quart ${s * 2 + 1}` : semiPlaceholders[s][0];
      const phB = includeQuarters ? `Vainqueur Quart ${s * 2 + 2}` : semiPlaceholders[s][1];

      if (existing) {
        if (!existing.teamAId) existing.placeholderA = phA;
        if (!existing.teamBId) existing.placeholderB = phB;
        existing.order = orderCounter++;
        knockoutMatches.push(existing);
      } else {
        knockoutMatches.push({
          id: `${sport.id}_D${s + 1}`,
          order: orderCounter++,
          phase: "DEMI",
          label: `Demi-finale ${s + 1}`,
          time: knockoutTime,
          pitch: sport.pitchNames[pitchIdx] || `Terrain 1`,
          teamAId: null,
          teamBId: null,
          placeholderA: phA,
          placeholderB: phB,
          scoreA: null,
          scoreB: null,
          referee: "",
          status: "scheduled"
        });
      }
    }
    knockoutTime = addMinutesToTime(knockoutTime, sport.matchDuration);

    // Petite Finale (3ème place)
    const existingPf = existingMatches.find(m => m.phase === "PETITE_FINALE");
    if (existingPf) {
      existingPf.order = orderCounter++;
      knockoutMatches.push(existingPf);
    } else {
      knockoutMatches.push({
        id: `${sport.id}_PF`,
        order: orderCounter++,
        phase: "PETITE_FINALE",
        label: "Petite Finale (3e place)",
        time: knockoutTime,
        pitch: sport.pitchNames[0] || "Terrain 1",
        teamAId: null,
        teamBId: null,
        placeholderA: "Perdant Demi 1",
        placeholderB: "Perdant Demi 2",
        scoreA: null,
        scoreB: null,
        referee: "",
        status: "scheduled"
      });
    }

    if (sport.pitchesCount < 2) {
      knockoutTime = addMinutesToTime(knockoutTime, sport.matchDuration);
    }
  }

  // Grande Finale
  const existingFinale = existingMatches.find(m => m.phase === "FINALE");
  const finalePhA = includeSemis ? "Vainqueur Demi 1" : (pools.length >= 2 ? "1er Poule 1" : "1er Poule 1");
  const finalePhB = includeSemis ? "Vainqueur Demi 2" : (pools.length >= 2 ? "1er Poule 2" : "2ème Poule 1");

  if (existingFinale) {
    existingFinale.order = orderCounter++;
    if (!existingFinale.teamAId) existingFinale.placeholderA = finalePhA;
    if (!existingFinale.teamBId) existingFinale.placeholderB = finalePhB;
    knockoutMatches.push(existingFinale);
  } else {
    knockoutMatches.push({
      id: `${sport.id}_FINALE`,
      order: orderCounter++,
      phase: "FINALE",
      label: "Grande Finale 🏆",
      time: knockoutTime,
      pitch: sport.pitchNames[0] || "Terrain Honneur",
      teamAId: null,
      teamBId: null,
      placeholderA: finalePhA,
      placeholderB: finalePhB,
      scoreA: null,
      scoreB: null,
      referee: "",
      status: "scheduled"
    });
  }

  sport.matches = [...poolMatchesScheduled, ...knockoutMatches];
}

// --- Cas 2 : Relais 4x100m (Courses à plusieurs équipes) ---
function formatAndScheduleRelayMatches(sport, activeTeams) {
  const pools = sport.pools || [];
  const existingMatches = sport.matches || [];
  const matches = [];
  let currentTime = sport.startTime;
  let order = 1;

  pools.forEach((heat, idx) => {
    const existing = existingMatches.find(m => m.phase === "POULE" && (m.poolId === heat.id || m.id === `${sport.id}_SERIE_${idx + 1}`));
    const validTeamIds = (heat.teamIds || []).filter(tid => activeTeams.some(t => t.id === tid));
    if (existing) {
      existing.raceTeamIds = [...validTeamIds];
      existing.order = order++;
      matches.push(existing);
    } else {
      matches.push({
        id: `${sport.id}_SERIE_${idx + 1}`,
        order: order++,
        phase: "POULE",
        isRace: true,
        label: `Série ${idx + 1} (${validTeamIds.length} couloirs)`,
        poolId: heat.id,
        poolName: heat.name,
        time: currentTime,
        pitch: sport.pitchNames[0] || "Piste d'Athlétisme",
        raceTeamIds: [...validTeamIds],
        raceResults: {},
        referee: "",
        status: "scheduled"
      });
    }
    currentTime = addMinutesToTime(currentTime, sport.matchDuration);
  });

  const n = activeTeams.length;
  if (n > 6) {
    for (let d = 1; d <= 2; d++) {
      const existing = existingMatches.find(m => m.phase === "DEMI" && m.id === `${sport.id}_DEMI_${d}`);
      if (existing) {
        existing.order = order++;
        matches.push(existing);
      } else {
        matches.push({
          id: `${sport.id}_DEMI_${d}`,
          order: order++,
          phase: "DEMI",
          isRace: true,
          label: `Demi-finale Course ${d}`,
          time: currentTime,
          pitch: sport.pitchNames[0] || "Piste d'Athlétisme",
          raceTeamIds: [null, null, null, null],
          raceResults: {},
          referee: "",
          status: "scheduled"
        });
      }
      currentTime = addMinutesToTime(currentTime, sport.matchDuration);
    }
  }

  const existingFinale = existingMatches.find(m => m.phase === "FINALE");
  if (existingFinale) {
    existingFinale.order = order++;
    matches.push(existingFinale);
  } else {
    matches.push({
      id: `${sport.id}_FINALE`,
      order: order++,
      phase: "FINALE",
      isRace: true,
      label: `Finale Relais 4x100m 🏆`,
      time: currentTime,
      pitch: sport.pitchNames[0] || "Piste d'Athlétisme",
      raceTeamIds: [null, null, null, null],
      raceResults: {},
      referee: "",
      status: "scheduled"
    });
  }

  sport.matches = matches;
}

// ============================================================================
// CALCUL DES CLASSEMENTS DE POULES & BOUTON DÉDIÉ DE REMPLISSAGE DES PHASES FINALES
// ============================================================================
function computePoolStandings(sport, poolId) {
  const pool = sport.pools.find(p => p.id === poolId);
  if (!pool) return [];

  const stats = {};
  pool.teamIds.forEach(tid => {
    const team = sport.teams.find(t => t.id === tid);
    if (team) {
      stats[tid] = {
        teamId: tid,
        name: team.name,
        filiereId: team.filiereId,
        played: 0,
        wins: 0,
        draws: 0,
        losses: 0,
        pts: 0,
        goalsFor: 0,
        goalsAgainst: 0,
        diff: 0
      };
    }
  });

  sport.matches
    .filter(m => m.phase === "POULE" && m.poolId === poolId && m.scoreA !== null && m.scoreB !== null && m.scoreA !== "" && m.scoreB !== "")
    .forEach(m => {
      const sA = Number(m.scoreA);
      const sB = Number(m.scoreB);
      const stA = stats[m.teamAId];
      const stB = stats[m.teamBId];
      if (!stA || !stB) return;

      stA.played++;
      stB.played++;
      stA.goalsFor += sA;
      stA.goalsAgainst += sB;
      stA.diff = stA.goalsFor - stA.goalsAgainst;

      stB.goalsFor += sB;
      stB.goalsAgainst += sA;
      stB.diff = stB.goalsFor - stB.goalsAgainst;

      // Règle officielle TIP : 3 pts victoire, 2 pts nul, 1 pt défaite
      if (sA > sB) {
        stA.wins++;
        stA.pts += 3;
        stB.losses++;
        stB.pts += 1;
      } else if (sB > sA) {
        stB.wins++;
        stB.pts += 3;
        stA.losses++;
        stA.pts += 1;
      } else {
        stA.draws++;
        stB.draws++;
        stA.pts += 2;
        stB.pts += 2;
      }
    });

  return Object.values(stats).sort((a, b) => {
    if (b.pts !== a.pts) return b.pts - a.pts;
    if (b.diff !== a.diff) return b.diff - a.diff;
    return b.goalsFor - a.goalsFor;
  });
}

// ============================================================================
// BOUTON EXPLICITE : REMPLISSAGE AUTOMATIQUE DES PHASES FINALES APRÈS LES POULES
// ============================================================================
function fillKnockoutFromPools(sportId) {
  const state = loadState();
  const sport = state.sports[sportId];
  if (!sport || !sport.initialized) {
    return { success: false, message: "Ce sport n'est pas encore initialisé." };
  }

  if (sport.type === "race") {
    // Relais 4x100m : qualifier les meilleurs coureurs des séries
    const finalists = [];
    sport.matches.filter(m => m.phase === "POULE" && m.isRace).forEach(m => {
      const ranked = Object.entries(m.raceResults || {})
        .sort((a, b) => {
          const valA = parseFloat(a[1]) || 999;
          const valB = parseFloat(b[1]) || 999;
          return valA - valB;
        })
        .map(x => x[0]);
      if (ranked[0]) finalists.push(ranked[0]);
      if (ranked[1]) finalists.push(ranked[1]);
    });

    const finaleMatch = sport.matches.find(m => m.phase === "FINALE");
    if (finaleMatch) {
      finaleMatch.raceTeamIds = finalists.slice(0, 4);
      while (finaleMatch.raceTeamIds.length < 4) finaleMatch.raceTeamIds.push(null);
    }

    recalculateSportStages(sport);
    saveState(state);
    return { success: true, count: finalists.length };
  }

  // Sports 1v1
  const poolMatches = sport.matches.filter(m => m.phase === "POULE");
  const unplayedCount = poolMatches.filter(m => m.scoreA === null || m.scoreB === null || m.scoreA === "" || m.scoreB === "").length;

  const poolRankings = sport.pools.map(p => computePoolStandings(sport, p.id));
  const eighthMatches = sport.matches.filter(m => m.phase === "HUITIEME");
  const quarterMatches = sport.matches.filter(m => m.phase === "QUART");
  const semiMatches = sport.matches.filter(m => m.phase === "DEMI");

  if (eighthMatches.length === 8) {
    if (poolRankings.length === 4) {
      // 4 Poules : Top 4 de chaque poule croisés (16 qualifiés)
      const p1 = poolRankings[0], p2 = poolRankings[1], p3 = poolRankings[2], p4 = poolRankings[3];
      eighthMatches[0].teamAId = p1[0] ? p1[0].teamId : null;
      eighthMatches[0].teamBId = p2[3] ? p2[3].teamId : null;

      eighthMatches[1].teamAId = p3[1] ? p3[1].teamId : null;
      eighthMatches[1].teamBId = p4[2] ? p4[2].teamId : null;

      eighthMatches[2].teamAId = p2[0] ? p2[0].teamId : null;
      eighthMatches[2].teamBId = p1[3] ? p1[3].teamId : null;

      eighthMatches[3].teamAId = p4[1] ? p4[1].teamId : null;
      eighthMatches[3].teamBId = p3[2] ? p3[2].teamId : null;

      eighthMatches[4].teamAId = p3[0] ? p3[0].teamId : null;
      eighthMatches[4].teamBId = p4[3] ? p4[3].teamId : null;

      eighthMatches[5].teamAId = p1[1] ? p1[1].teamId : null;
      eighthMatches[5].teamBId = p2[2] ? p2[2].teamId : null;

      eighthMatches[6].teamAId = p4[0] ? p4[0].teamId : null;
      eighthMatches[6].teamBId = p3[3] ? p3[3].teamId : null;

      eighthMatches[7].teamAId = p2[1] ? p2[1].teamId : null;
      eighthMatches[7].teamBId = p1[2] ? p1[2].teamId : null;
    } else if (poolRankings.length === 2) {
      // 2 Poules : Top 8 de chaque poule croisés (1er P1 vs 8e P2, etc.)
      const p1 = poolRankings[0], p2 = poolRankings[1];
      for (let i = 0; i < 8; i++) {
        if (i % 2 === 0) {
          eighthMatches[i].teamAId = p1[i] ? p1[i].teamId : null;
          eighthMatches[i].teamBId = p2[7 - i] ? p2[7 - i].teamId : null;
        } else {
          eighthMatches[i].teamAId = p2[i] ? p2[i].teamId : null;
          eighthMatches[i].teamBId = p1[7 - i] ? p1[7 - i].teamId : null;
        }
      }
    } else {
      // Remplissage séquentiel (ex: 1 poule)
      const qualifiers = [];
      const maxRank = Math.max(...poolRankings.map(r => r.length));
      for (let r = 0; r < maxRank; r++) {
        poolRankings.forEach(pRank => {
          if (pRank[r]) qualifiers.push(pRank[r].teamId);
        });
      }
      for (let i = 0; i < 8; i++) {
        eighthMatches[i].teamAId = qualifiers[i] || null;
        eighthMatches[i].teamBId = qualifiers[15 - i] || null;
      }
    }
  } else if (quarterMatches.length === 4) {
    if (poolRankings.length === 4) {
      // 4 Poules : 1er vs 2e croisés
      const p1 = poolRankings[0], p2 = poolRankings[1], p3 = poolRankings[2], p4 = poolRankings[3];
      quarterMatches[0].teamAId = p1[0] ? p1[0].teamId : null;
      quarterMatches[0].teamBId = p2[1] ? p2[1].teamId : null;

      quarterMatches[1].teamAId = p3[0] ? p3[0].teamId : null;
      quarterMatches[1].teamBId = p4[1] ? p4[1].teamId : null;

      quarterMatches[2].teamAId = p2[0] ? p2[0].teamId : null;
      quarterMatches[2].teamBId = p1[1] ? p1[1].teamId : null;

      quarterMatches[3].teamAId = p4[0] ? p4[0].teamId : null;
      quarterMatches[3].teamBId = p3[1] ? p3[1].teamId : null;
    } else if (poolRankings.length === 2) {
      // 2 Poules : 4 premiers de chaque poule croisés
      const p1 = poolRankings[0], p2 = poolRankings[1];
      quarterMatches[0].teamAId = p1[0] ? p1[0].teamId : null;
      quarterMatches[0].teamBId = p2[3] ? p2[3].teamId : null;

      quarterMatches[1].teamAId = p1[2] ? p1[2].teamId : null;
      quarterMatches[1].teamBId = p2[1] ? p2[1].teamId : null;

      quarterMatches[2].teamAId = p2[0] ? p2[0].teamId : null;
      quarterMatches[2].teamBId = p1[3] ? p1[3].teamId : null;

      quarterMatches[3].teamAId = p2[2] ? p2[2].teamId : null;
      quarterMatches[3].teamBId = p1[1] ? p1[1].teamId : null;
    } else {
      // Remplissage séquentiel
      const qualifiers = [];
      const maxRank = Math.max(...poolRankings.map(r => r.length));
      for (let r = 0; r < maxRank; r++) {
        poolRankings.forEach(pRank => {
          if (pRank[r]) qualifiers.push(pRank[r].teamId);
        });
      }
      const pairs = [[0, 7], [3, 4], [1, 6], [2, 5]];
      quarterMatches.forEach((qm, idx) => {
        qm.teamAId = qualifiers[pairs[idx][0]] || null;
        qm.teamBId = qualifiers[pairs[idx][1]] || null;
      });
    }
  } else if (semiMatches.length === 2) {
    if (poolRankings.length === 2) {
      // 2 Poules : 1er P1 vs 2e P2 & 1er P2 vs 2e P1
      const p1 = poolRankings[0], p2 = poolRankings[1];
      semiMatches[0].teamAId = p1[0] ? p1[0].teamId : null;
      semiMatches[0].teamBId = p2[1] ? p2[1].teamId : null;

      semiMatches[1].teamAId = p2[0] ? p2[0].teamId : null;
      semiMatches[1].teamBId = p1[1] ? p1[1].teamId : null;
    } else if (poolRankings.length === 3) {
      // 3 Poules : 1er de chaque poule + Meilleur 2ème
      const firsts = poolRankings.map(r => r[0]).filter(Boolean);
      const seconds = poolRankings.map(r => r[1]).filter(Boolean).sort((a, b) => {
        if (b.pts !== a.pts) return b.pts - a.pts;
        if (b.diff !== a.diff) return b.diff - a.diff;
        return b.goalsFor - a.goalsFor;
      });
      const bestSecond = seconds[0];
      semiMatches[0].teamAId = firsts[0] ? firsts[0].teamId : null;
      semiMatches[0].teamBId = bestSecond ? bestSecond.teamId : null;

      semiMatches[1].teamAId = firsts[1] ? firsts[1].teamId : null;
      semiMatches[1].teamBId = firsts[2] ? firsts[2].teamId : null;
    } else if (poolRankings.length === 4) {
      // 4 Poules avec 1 qualifié par poule -> Demis directes
      const p1 = poolRankings[0], p2 = poolRankings[1], p3 = poolRankings[2], p4 = poolRankings[3];
      semiMatches[0].teamAId = p1[0] ? p1[0].teamId : null;
      semiMatches[0].teamBId = p2[0] ? p2[0].teamId : null;

      semiMatches[1].teamAId = p3[0] ? p3[0].teamId : null;
      semiMatches[1].teamBId = p4[0] ? p4[0].teamId : null;
    } else if (poolRankings.length === 1) {
      // 1 Poule unique : 1er vs 4e, 2e vs 3e
      const p1 = poolRankings[0];
      semiMatches[0].teamAId = p1[0] ? p1[0].teamId : null;
      semiMatches[0].teamBId = p1[3] ? p1[3].teamId : null;

      semiMatches[1].teamAId = p1[1] ? p1[1].teamId : null;
      semiMatches[1].teamBId = p1[2] ? p1[2].teamId : null;
    }
  } else if (semiMatches.length === 0 && quarterMatches.length === 0) {
    // Cas où seules les Grandes Finales sont prévues (2 qualifiés)
    const finaleMatch = sport.matches.find(m => m.phase === "FINALE");
    if (finaleMatch && poolRankings.length >= 2) {
      finaleMatch.teamAId = poolRankings[0][0] ? poolRankings[0][0].teamId : null;
      finaleMatch.teamBId = poolRankings[1][0] ? poolRankings[1][0].teamId : null;
    } else if (finaleMatch && poolRankings.length === 1 && poolRankings[0].length >= 2) {
      finaleMatch.teamAId = poolRankings[0][0] ? poolRankings[0][0].teamId : null;
      finaleMatch.teamBId = poolRankings[0][1] ? poolRankings[0][1].teamId : null;
    }
  }

  recalculateSportStages(sport);
  saveState(state);
  return { success: true, unplayedCount };
}

// Avancement des vainqueurs de 8èmes -> Quarts -> Demis -> Finale lors de la saisie des scores de phases finales
function advanceKnockoutRounds(sport) {
  if (sport.type === "race") return;

  // 0. 8èmes -> Quarts
  const eighths = sport.matches.filter(m => m.phase === "HUITIEME");
  const quarters = sport.matches.filter(m => m.phase === "QUART");
  if (eighths.length === 8 && quarters.length === 4) {
    for (let q = 0; q < 4; q++) {
      const wA = getMatchWinnerId(eighths[q * 2]);
      const wB = getMatchWinnerId(eighths[q * 2 + 1]);
      if (wA) quarters[q].teamAId = wA;
      if (wB) quarters[q].teamBId = wB;
    }
  }

  // 1. Quarts -> Demis
  const semis = sport.matches.filter(m => m.phase === "DEMI");
  if (quarters.length === 4 && semis.length === 2) {
    const q1W = getMatchWinnerId(quarters[0]);
    const q2W = getMatchWinnerId(quarters[1]);
    const q3W = getMatchWinnerId(quarters[2]);
    const q4W = getMatchWinnerId(quarters[3]);

    if (q1W) semis[0].teamAId = q1W;
    if (q2W) semis[0].teamBId = q2W;
    if (q3W) semis[1].teamAId = q3W;
    if (q4W) semis[1].teamBId = q4W;
  }

  // 2. Demis -> Petite Finale & Grande Finale
  const pf = sport.matches.find(m => m.phase === "PETITE_FINALE");
  const finale = sport.matches.find(m => m.phase === "FINALE");
  if (semis.length === 2) {
    const w1 = getMatchWinnerId(semis[0]);
    const l1 = getMatchLoserId(semis[0]);
    const w2 = getMatchWinnerId(semis[1]);
    const l2 = getMatchLoserId(semis[1]);

    if (finale) {
      if (w1) finale.teamAId = w1;
      if (w2) finale.teamBId = w2;
    }
    if (pf) {
      if (l1) pf.teamAId = l1;
      if (l2) pf.teamBId = l2;
    }
  }

  recalculateSportStages(sport);
}

function getMatchWinnerId(m) {
  if (!m || m.scoreA === null || m.scoreB === null || m.scoreA === "" || m.scoreB === "") return null;
  const a = Number(m.scoreA);
  const b = Number(m.scoreB);
  if (a > b) return m.teamAId;
  if (b > a) return m.teamBId;
  return null;
}

function getMatchLoserId(m) {
  if (!m || m.scoreA === null || m.scoreB === null || m.scoreA === "" || m.scoreB === "") return null;
  const a = Number(m.scoreA);
  const b = Number(m.scoreB);
  if (a > b) return m.teamBId;
  if (b > a) return m.teamAId;
  return null;
}

// Mise à jour automatique du stade maximum atteint par chaque équipe :
// Règle : Une équipe en phase de poule qui ne passe pas n'obtient AUCUN point (0 pt).
// Elle obtient des points uniquement lorsqu'elle passe la phase et entre dans le tableau éliminatoire :
// • 8ème : 1 pts • Quart : 2 pts • Demi : 3 pts • Finale : 4 pts • Gagnant : 5 pts
function recalculateSportStages(sport) {
  if (!sport.initialized) return;

  const stageRankOrder = ["POULE", "HUITIEME", "QUART", "DEMI", "FINALE", "GAGNANT"];
  const upgradeStage = (team, newStage) => {
    if (!team || !team.active) return;
    const curIdx = stageRankOrder.indexOf(team.stageReached || "POULE");
    const newIdx = stageRankOrder.indexOf(newStage);
    if (newIdx > curIdx) {
      team.stageReached = newStage;
    }
  };

  // Par défaut, toute équipe active commence à POULE (0 pt)
  sport.teams.forEach(t => {
    if (t.active) t.stageReached = "POULE";
  });

  if (sport.type !== "race") {
    sport.matches.forEach(m => {
      // On n'attribue les stades éliminatoires QUE si l'équipe est effectivement affectée à ce match
      if (m.phase === "HUITIEME") {
        if (m.teamAId) upgradeStage(sport.teams.find(t => t.id === m.teamAId), "HUITIEME");
        if (m.teamBId) upgradeStage(sport.teams.find(t => t.id === m.teamBId), "HUITIEME");
      } else if (m.phase === "QUART") {
        if (m.teamAId) upgradeStage(sport.teams.find(t => t.id === m.teamAId), "QUART");
        if (m.teamBId) upgradeStage(sport.teams.find(t => t.id === m.teamBId), "QUART");
      } else if (m.phase === "DEMI" || m.phase === "PETITE_FINALE") {
        if (m.teamAId) upgradeStage(sport.teams.find(t => t.id === m.teamAId), "DEMI");
        if (m.teamBId) upgradeStage(sport.teams.find(t => t.id === m.teamBId), "DEMI");
      } else if (m.phase === "FINALE") {
        if (m.teamAId) upgradeStage(sport.teams.find(t => t.id === m.teamAId), "FINALE");
        if (m.teamBId) upgradeStage(sport.teams.find(t => t.id === m.teamBId), "FINALE");
        const winnerId = getMatchWinnerId(m);
        if (winnerId) {
          upgradeStage(sport.teams.find(t => t.id === winnerId), "GAGNANT");
        }
      }
    });
  } else {
    // Relais 4x100m
    sport.matches.forEach(m => {
      (m.raceTeamIds || []).forEach(tid => {
        if (!tid) return;
        const team = sport.teams.find(t => t.id === tid);
        if (m.phase === "DEMI") upgradeStage(team, "DEMI");
        if (m.phase === "FINALE") {
          upgradeStage(team, "FINALE");
          if (m.raceResults && String(m.raceResults[tid]).trim() === "1") {
            upgradeStage(team, "GAGNANT");
          }
        }
      });
    });
  }
}

// Calcul du Classement Général des Filières tous sports confondus
function computeGlobalFiliereStandings(state) {
  const standings = {};
  FILIERES.forEach(f => {
    standings[f.id] = {
      ...f,
      totalPoints: 0,
      activeTeamsCount: 0,
      bySport: {}
    };
    Object.keys(state.sports).forEach(sId => {
      standings[f.id].bySport[sId] = 0;
    });
  });

  Object.values(state.sports).forEach(sport => {
    sport.teams.forEach(team => {
      if (!team.active) return;
      standings[team.filiereId].activeTeamsCount++;
      if (sport.initialized && team.stageReached) {
        const pts = (POINTS_SCALE[team.stageReached] || 0) + (Number(team.manualPointsBonus) || 0);
        standings[team.filiereId].bySport[sport.id] += pts;
        standings[team.filiereId].totalPoints += pts;
      }
    });
  });

  return Object.values(standings).sort((a, b) => b.totalPoints - a.totalPoints);
}

// ============================================================================
// RÉCUPÉRATION DES 2 PROCHAINS MATCHS PAR TERRAIN & PAR SPORT (POUR LE PROJETÉ)
// Règle projeté : n'affiche un match QUE si les 2 équipes sont connues !
// ============================================================================
function getNextMatchesForProjection(state, selectedSportFilter) {
  const result = [];
  const isSingleSport = selectedSportFilter && selectedSportFilter !== "ALL";

  const sportsToScan = isSingleSport
    ? [state.sports[selectedSportFilter]].filter(Boolean)
    : Object.values(state.sports);

  sportsToScan.forEach(sport => {
    if (!sport.initialized) return;

    if (isSingleSport) {
      // Si un sport spécifique est sélectionné : afficher TOUS les matchs du sport
      sport.matches.forEach(m => {
        result.push({
          ...m,
          sportId: sport.id,
          sportName: sport.name,
          sportIcon: sport.icon,
          pitchName: m.pitch,
          slotLabel: m.label,
          sportTheme: getSportTheme(sport.id),
          sportRef: sport
        });
      });
    } else {
      // Vue globale "Tous les sports" : 2 prochains matchs confirmés par terrain
      const pitches = sport.pitchNames && sport.pitchNames.length > 0
        ? sport.pitchNames
        : Array.from(new Set(sport.matches.map(m => m.pitch)));

      pitches.forEach(pitchName => {
        const pitchMatches = sport.matches.filter(m => m.pitch === pitchName);

        const upcomingWithBothTeams = pitchMatches.filter(m => {
          if (m.isRace) {
            const filledLanes = (m.raceTeamIds || []).filter(Boolean);
            const hasResults = Object.keys(m.raceResults || {}).length > 0;
            return !hasResults && filledLanes.length >= 2;
          }

          const isFinished = (m.scoreA !== null && m.scoreB !== null && m.scoreA !== "" && m.scoreB !== "");
          if (isFinished) return false;

          const hasTeamA = Boolean(m.teamAId);
          const hasTeamB = Boolean(m.teamBId);
          return hasTeamA && hasTeamB;
        });

        upcomingWithBothTeams.sort((a, b) => {
          if (a.time !== b.time) return a.time.localeCompare(b.time);
          return a.order - b.order;
        });

        const nextTwo = upcomingWithBothTeams.slice(0, 2);
        nextTwo.forEach((m, slotIndex) => {
          result.push({
            ...m,
            sportId: sport.id,
            sportName: sport.name,
            sportIcon: sport.icon,
            pitchName: pitchName,
            slotLabel: slotIndex === 0 ? "Prochain match" : "Match suivant",
            sportTheme: getSportTheme(sport.id),
            sportRef: sport
          });
        });
      });
    }
  });

  // Trier globalement la liste chronologiquement par heure puis ordre
  result.sort((a, b) => {
    if (a.time !== b.time) return a.time.localeCompare(b.time);
    return a.order - b.order;
  });

  return result;
}

// ============================================================================
// EXPORT DU PLANNING AU FORMAT EXCEL (.XLS)
// ============================================================================
function exportSportScheduleToExcel(sport) {
  if (!sport.initialized || sport.matches.length === 0) {
    alert("Veuillez d'abord initialiser le planning de ce sport avant de l'exporter.");
    return;
  }

  const theme = getSportTheme(sport.id);

  const getTeamInfo = (tid, placeholder) => {
    if (!tid) return { name: placeholder || "À déterminer", hex: "#64748b", textHex: "#ffffff", filiereName: "" };
    const t = sport.teams.find(x => x.id === tid);
    if (!t) return { name: placeholder || "À déterminer", hex: "#64748b", textHex: "#ffffff", filiereName: "" };
    const f = getFiliereById(t.filiereId);
    return { name: t.name, hex: f.hex, textHex: f.textHex || "#000000", filiereName: f.name };
  };

  const buildMatchRow = (m) => {
    if (m.isRace) {
      const runners = (m.raceTeamIds || []).map((tid, idx) => {
        const info = getTeamInfo(tid, "Qualifié");
        return `<span style="background:${info.hex}; color:${info.textHex}; padding:2px 6px; border-radius:4px; font-weight:bold;">C${idx + 1}: ${info.name}</span>`;
      }).join(" &nbsp; ");

      const resultStr = Object.entries(m.raceResults || {}).map(([tid, r]) => {
        const info = getTeamInfo(tid);
        return `${info.name}: ${r}`;
      }).join(", ");

      return `
        <tr>
          <td style="text-align:center; font-weight:bold; background:#f8fafc;">${m.order}</td>
          <td style="text-align:center; font-weight:bold; background:#f1f5f9;">${m.time}</td>
          <td style="background:#ffffff;">${m.pitch}</td>
          <td style="background:#ffffff; font-weight:bold;">${m.phase} - ${m.label}</td>
          <td colspan="5" style="background:#ffffff;">${runners}</td>
          <td style="text-align:center; background:#f8fafc; font-weight:bold;">${resultStr || "À courir"}</td>
          <td style="background:#ffffff;">${m.referee || "Chrono BDS"}</td>
          <td style="background:#ffffff;"></td>
        </tr>
      `;
    }

    const teamA = getTeamInfo(m.teamAId, m.placeholderA);
    const teamB = getTeamInfo(m.teamBId, m.placeholderB);

    const scoreA = (m.scoreA !== null && m.scoreA !== undefined) ? m.scoreA : "";
    const scoreB = (m.scoreB !== null && m.scoreB !== undefined) ? m.scoreB : "";

    let winner = "";
    if (scoreA !== "" && scoreB !== "") {
      if (Number(scoreA) > Number(scoreB)) winner = teamA.name;
      else if (Number(scoreB) > Number(scoreA)) winner = teamB.name;
      else winner = "Match Nul";
    }

    return `
      <tr>
        <td style="text-align:center; font-weight:bold; background:#f8fafc;">${m.order}</td>
        <td style="text-align:center; font-weight:bold; background:#f1f5f9; color:#0f172a;">${m.time}</td>
        <td style="background:#ffffff;">${m.pitch}</td>
        <td style="background:#ffffff; font-weight:600;">${m.label}</td>
        <td style="background:${teamA.hex}; color:${teamA.textHex}; font-weight:bold; padding:6px 10px;">${teamA.name}</td>
        <td style="text-align:center; font-weight:900; font-size:1.15em; background:#f8fafc; border:2px solid #94a3b8; width:55px;">${scoreA}</td>
        <td style="text-align:center; font-weight:bold; color:#64748b; background:#f1f5f9;">VS</td>
        <td style="text-align:center; font-weight:900; font-size:1.15em; background:#f8fafc; border:2px solid #94a3b8; width:55px;">${scoreB}</td>
        <td style="background:${teamB.hex}; color:${teamB.textHex}; font-weight:bold; padding:6px 10px;">${teamB.name}</td>
        <td style="background:#ffffff; font-style:italic;">${m.referee || "À désigner"}</td>
        <td style="background:#ffffff; font-weight:bold; color:${theme.color};">${winner}</td>
        <td style="background:#ffffff;"></td>
      </tr>
    `;
  };

  const poolMatches = sport.matches.filter(m => m.phase === "POULE" || !m.phase);
  const knockoutMatches = sport.matches.filter(m => m.phase && m.phase !== "POULE");

  const poolRowsHtml = poolMatches.map(buildMatchRow).join("");
  const knockoutRowsHtml = knockoutMatches.map(buildMatchRow).join("");

  let teamsRowsHtml = "";
  sport.teams.filter(t => t.active).forEach(t => {
    const f = getFiliereById(t.filiereId);
    const pts = POINTS_SCALE[t.stageReached] || 0;
    teamsRowsHtml += `
      <tr>
        <td style="font-weight:bold; background:#ffffff;">${t.name}</td>
        <td style="background:${f.hex}; color:${f.textHex || '#000000'}; font-weight:bold; text-align:center;">${f.name}</td>
        <td style="text-align:center; background:#ffffff;">${STAGE_LABELS[t.stageReached] || t.stageReached || "Poule"}</td>
        <td style="text-align:center; font-weight:900; background:#f1f5f9; color:${theme.color};">${pts} pt(s)</td>
      </tr>
    `;
  });

  const excelTemplate = `
    <html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">
    <head>
      <meta charset="UTF-8">
      <style>
        body { font-family: 'Segoe UI', Calibri, Arial, sans-serif; background-color: #ffffff; color: #0f172a; }
        table { border-collapse: collapse; margin-bottom: 28px; width: 100%; }
        th { background-color: ${theme.color}; color: #ffffff; font-weight: bold; padding: 9px 8px; border: 1px solid #334155; font-size: 13px; text-transform: uppercase; }
        td { padding: 7px 10px; border: 1px solid #cbd5e1; font-size: 12px; vertical-align: middle; }
        h1 { color: ${theme.color}; font-size: 20px; margin-bottom: 4px; }
        h2 { color: #0f172a; font-size: 16px; margin-top: 20px; margin-bottom: 8px; border-bottom: 2px solid ${theme.color}; padding-bottom: 4px; }
        .rule-box { background: #f8fafc; border: 1px solid #cbd5e1; padding: 10px 14px; margin-bottom: 20px; font-size: 12px; }
      </style>
    </head>
    <body>
      <h1>🏆 TOURNOI INTER-PROMO (TIP) — PLANNING OFFICIEL : ${sport.name.toUpperCase()}</h1>
      <div class="rule-box">
        <b>Créneaux horaires :</b> ${sport.startTime} - ${sport.endTime} &nbsp;•&nbsp; 
        <b>Durée des rencontres :</b> ${sport.matchDuration} min &nbsp;•&nbsp; 
        <b>Barème officiel :</b> 8ème: 1 pt • Quart: 2 pts • Demi: 4 pts • Finale: 5 pts • Vainqueur: 7 pts (Poules: 3V - 2N - 1D)
        <br/><i>Note terrain : ${sport.excelNote || "Respectez impérativement le temps de jeu pour libérer les terrains à 13h10."}</i>
      </div>

      ${poolMatches.length > 0 ? `
        <h2>PHASE 1 : MATCHS DE POULES</h2>
        <table>
          <thead>
            <tr>
              <th style="width:40px;">#</th>
              <th style="width:75px;">Heure</th>
              <th style="width:140px;">Terrain</th>
              <th style="width:130px;">Match</th>
              <th>Équipe A</th>
              <th style="width:60px;">Score A</th>
              <th style="width:35px;">VS</th>
              <th style="width:60px;">Score B</th>
              <th>Équipe B</th>
              <th style="width:140px;">Arbitre / Table</th>
              <th style="width:130px;">Vainqueur</th>
              <th style="width:130px;">Émargement</th>
            </tr>
          </thead>
          <tbody>
            ${poolRowsHtml}
          </tbody>
        </table>
      ` : ''}

      ${knockoutMatches.length > 0 ? `
        <h2>PHASE 2 : PHASES FINALES (QUARTS, DEMIS, FINALES)</h2>
        <table>
          <thead>
            <tr>
              <th style="width:40px;">#</th>
              <th style="width:75px;">Heure</th>
              <th style="width:140px;">Terrain</th>
              <th style="width:130px;">Tour</th>
              <th>Équipe A</th>
              <th style="width:60px;">Score A</th>
              <th style="width:35px;">VS</th>
              <th style="width:60px;">Score B</th>
              <th>Équipe B</th>
              <th style="width:140px;">Arbitre / Table</th>
              <th style="width:130px;">Vainqueur</th>
              <th style="width:130px;">Émargement</th>
            </tr>
          </thead>
          <tbody>
            ${knockoutRowsHtml}
          </tbody>
        </table>
      ` : ''}

      <h2>ÉQUIPES ENGAGÉES & POINTS ACQUIS (${sport.name.toUpperCase()})</h2>
      <table style="max-width: 750px;">
        <thead>
          <tr>
            <th>Équipe</th>
            <th style="width:140px;">Filière</th>
            <th style="width:200px;">Stade de Qualification</th>
            <th style="width:140px;">Points au Classement</th>
          </tr>
        </thead>
        <tbody>
          ${teamsRowsHtml}
        </tbody>
      </table>
    </body>
    </html>
  `;

  const blob = new Blob([excelTemplate], { type: "application/vnd.ms-excel;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `Planning_${sport.name.replace(/\s+/g, "_")}.xls`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ============================================================================
// GESTION DU THÈME & HORLOGE TEMPS RÉEL
// ============================================================================
function initTheme() {
  const savedTheme = localStorage.getItem(THEME_KEY) || "dark";
  if (savedTheme === "light") {
    document.body.classList.add("light-mode");
  } else {
    document.body.classList.remove("light-mode");
  }
  updateThemeButtonLabel();
}

function toggleTheme() {
  document.body.classList.toggle("light-mode");
  const isLight = document.body.classList.contains("light-mode");
  localStorage.setItem(THEME_KEY, isLight ? "light" : "dark");
  updateThemeButtonLabel();
}

function updateThemeButtonLabel() {
  const btn = document.getElementById("theme-toggle-btn");
  if (!btn) return;
  const isLight = document.body.classList.contains("light-mode");
  const icon = isLight ? "🌙" : "☀️";
  const label = isLight ? "Mode Nuit" : "Mode Clair";
  btn.innerHTML = `<span class="btn-icon">${icon}</span><span class="btn-text">${label}</span>`;
}

function startRealtimeClock(elementId) {
  const el = document.getElementById(elementId);
  if (!el) return;
  const tick = () => {
    const now = new Date();
    el.textContent = now.toLocaleTimeString("fr-FR", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });
  };
  tick();
  setInterval(tick, 1000);
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    loadState,
    saveState,
    createInitialState,
    resetAllTournament,
    initServerSync,
    FILIERES,
    STORAGE_KEY
  };
}
