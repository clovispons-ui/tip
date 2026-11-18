/**
 * QR Code Generator - Léger, autonome, zéro dépendance
 * Conçu spécifiquement pour le Tournoi Inter-Filières (TIP)
 * Génère des codes QR en SVG vectoriel pur, lisibles par tout smartphone.
 */
(function(global) {
  "use strict";

  const GF = {
    exp: new Uint8Array(512),
    log: new Uint8Array(256),
    init() {
      let x = 1;
      for (let i = 0; i < 255; i++) {
        this.exp[i] = x;
        this.exp[i + 255] = x;
        this.log[x] = i;
        x <<= 1;
        if (x & 256) x ^= 0x11d;
      }
    },
    mul(x, y) {
      if (x === 0 || y === 0) return 0;
      return this.exp[this.log[x] + this.log[y]];
    }
  };
  GF.init();

  function rsPoly(n) {
    let p = [1];
    for (let i = 0; i < n; i++) {
      let next = new Array(p.length + 1).fill(0);
      for (let j = 0; j < p.length; j++) {
        next[j] ^= GF.mul(p[j], GF.exp[i]);
        next[j + 1] ^= p[j];
      }
      p = next;
    }
    return p;
  }

  function rsEncode(data, ecLen) {
    const poly = rsPoly(ecLen);
    const result = new Array(ecLen).fill(0);
    for (let i = 0; i < data.length; i++) {
      const coef = data[i] ^ result[0];
      for (let j = 0; j < ecLen - 1; j++) {
        result[j] = result[j + 1] ^ GF.mul(poly[ecLen - 1 - j], coef);
      }
      result[ecLen - 1] = GF.mul(poly[0], coef);
    }
    return result;
  }

  const VERSIONS = [
    null,
    { size: 21, totalCW: 26, dataCW: 16, ecCW: 10, align: [], blocks: 1, dataPerBlock: 16, ecPerBlock: 10 },
    { size: 25, totalCW: 44, dataCW: 28, ecCW: 16, align: [6, 18], blocks: 1, dataPerBlock: 28, ecPerBlock: 16 },
    { size: 29, totalCW: 70, dataCW: 44, ecCW: 26, align: [6, 22], blocks: 1, dataPerBlock: 44, ecPerBlock: 26 },
    { size: 33, totalCW: 100, dataCW: 64, ecCW: 36, align: [6, 26], blocks: 2, dataPerBlock: 32, ecPerBlock: 18 },
    { size: 37, totalCW: 134, dataCW: 86, ecCW: 48, align: [6, 30], blocks: 2, dataPerBlock: 43, ecPerBlock: 24 },
    { size: 41, totalCW: 172, dataCW: 108, ecCW: 64, align: [6, 34], blocks: 4, dataPerBlock: 27, ecPerBlock: 16 }
  ];

  function encodeData(text, version) {
    const bytes = new TextEncoder().encode(text);
    const spec = VERSIONS[version];
    const dataCap = spec.dataCW;
    if (bytes.length > dataCap - 3) {
      throw new Error("Texte trop long pour la version QR " + version);
    }

    const bits = [];
    function pushBits(val, len) {
      for (let i = len - 1; i >= 0; i--) {
        bits.push((val >> i) & 1);
      }
    }

    pushBits(0b0100, 4); // Mode Octet
    pushBits(bytes.length, 8); // Longueur
    for (let b of bytes) pushBits(b, 8);

    const capBits = dataCap * 8;
    const term = Math.min(4, capBits - bits.length);
    pushBits(0, term);
    while (bits.length % 8 !== 0) bits.push(0);

    const padBytes = [0xEC, 0x11];
    let padIdx = 0;
    while (bits.length < capBits) {
      pushBits(padBytes[padIdx % 2], 8);
      padIdx++;
    }

    const dataCW = [];
    for (let i = 0; i < bits.length; i += 8) {
      let b = 0;
      for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
      dataCW.push(b);
    }

    const numBlocks = spec.blocks;
    const dataPerBlock = spec.dataPerBlock;
    const ecPerBlock = spec.ecPerBlock;

    const dataBlocks = [];
    const ecBlocks = [];

    for (let b = 0; b < numBlocks; b++) {
      const blockData = dataCW.slice(b * dataPerBlock, (b + 1) * dataPerBlock);
      dataBlocks.push(blockData);
      ecBlocks.push(rsEncode(blockData, ecPerBlock));
    }

    const result = [];
    for (let i = 0; i < dataPerBlock; i++) {
      for (let b = 0; b < numBlocks; b++) {
        result.push(dataBlocks[b][i]);
      }
    }
    for (let i = 0; i < ecPerBlock; i++) {
      for (let b = 0; b < numBlocks; b++) {
        result.push(ecBlocks[b][i]);
      }
    }

    return result;
  }

  function createMatrix(version, codewords) {
    const spec = VERSIONS[version];
    const size = spec.size;
    const mat = Array.from({ length: size }, () => Array(size).fill(null));
    const isFunc = Array.from({ length: size }, () => Array(size).fill(false));

    function setMod(r, c, val, func = true) {
      if (r >= 0 && r < size && c >= 0 && c < size) {
        mat[r][c] = val;
        if (func) isFunc[r][c] = true;
      }
    }

    function addFinder(row, col) {
      for (let r = -1; r <= 7; r++) {
        for (let c = -1; c <= 7; c++) {
          const pr = row + r, pc = col + c;
          if (pr < 0 || pr >= size || pc < 0 || pc >= size) continue;
          if (r >= 0 && r <= 6 && c >= 0 && c <= 6) {
            const isBlack = (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
            setMod(pr, pc, isBlack);
          } else {
            setMod(pr, pc, false);
          }
        }
      }
    }
    addFinder(0, 0);
    addFinder(0, size - 7);
    addFinder(size - 7, 0);

    if (spec.align && spec.align.length > 0) {
      for (let r of spec.align) {
        for (let c of spec.align) {
          if (isFunc[r][c]) continue;
          for (let dr = -2; dr <= 2; dr++) {
            for (let dc = -2; dc <= 2; dc++) {
              const isB = (Math.abs(dr) === 2 || Math.abs(dc) === 2 || (dr === 0 && dc === 0));
              setMod(r + dr, c + dc, isB);
            }
          }
        }
      }
    }

    for (let i = 8; i < size - 8; i++) {
      if (!isFunc[6][i]) setMod(6, i, i % 2 === 0);
      if (!isFunc[i][6]) setMod(i, 6, i % 2 === 0);
    }

    setMod(size - 8, 8, true);

    for (let i = 0; i <= 8; i++) {
      if (!isFunc[8][i]) setMod(8, i, false);
      if (!isFunc[i][8]) setMod(i, 8, false);
    }
    for (let i = size - 8; i < size; i++) {
      if (!isFunc[8][i]) setMod(8, i, false);
      if (!isFunc[i][8]) setMod(i, 8, false);
    }

    const allBits = [];
    for (let cw of codewords) {
      for (let i = 7; i >= 0; i--) allBits.push((cw >> i) & 1);
    }

    let bitIdx = 0;
    let right = size - 1;
    let upward = true;

    while (right > 0) {
      if (right === 6) right--;
      const colPairs = [right, right - 1];
      const rows = upward ? Array.from({ length: size }, (_, i) => size - 1 - i) : Array.from({ length: size }, (_, i) => i);

      for (let r of rows) {
        for (let c of colPairs) {
          if (!isFunc[r][c]) {
            const bit = bitIdx < allBits.length ? allBits[bitIdx++] : 0;
            mat[r][c] = (bit === 1);
          }
        }
      }
      upward = !upward;
      right -= 2;
    }

    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (!isFunc[r][c] && (r + c) % 2 === 0) {
          mat[r][c] = !mat[r][c];
        }
      }
    }

    // Format info : EC Level M (00) + Mask 0 (000) selon ISO/IEC 18004
    // Calcul BCH(15, 5) avec masque standard 0x5412 (101010000010010)
    const dataFormat = 0;
    let remFormat = dataFormat;
    for (let i = 0; i < 10; i++) {
      remFormat = (remFormat << 1) ^ ((remFormat >> 9) * 0x537);
    }
    const formatBitsVal = ((dataFormat << 10) | remFormat) ^ 0x5412;
    function getFormatBit(i) {
      return ((formatBitsVal >>> i) & 1) !== 0;
    }

    // Copie 1 : autour du finder supérieur gauche
    for (let i = 0; i <= 5; i++) mat[8][i] = getFormatBit(i);
    mat[8][7] = getFormatBit(6);
    mat[8][8] = getFormatBit(7);
    mat[7][8] = getFormatBit(8);
    for (let i = 9; i < 15; i++) mat[14 - i][8] = getFormatBit(i);

    // Copie 2 : répartie selon la norme ISO 18004
    // 1) Sous le finder supérieur droit (ligne 8, cols size-1 à size-8, bits 0 à 7)
    for (let i = 0; i < 8; i++) mat[8][size - 1 - i] = getFormatBit(i);
    // 2) À droite du finder inférieur gauche (col 8, lignes size-7 à size-1, bits 8 à 14)
    for (let i = 8; i < 15; i++) mat[size - 15 + i][8] = getFormatBit(i);

    return mat;
  }

  function toSVG(matrix, sizePx = 200, margin = 4) {
    const n = matrix.length;
    const totalSize = n + margin * 2;
    let paths = [];
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (matrix[r][c]) {
          paths.push(`M${c + margin},${r + margin}h1v1h-1z`);
        }
      }
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalSize} ${totalSize}" width="${sizePx}" height="${sizePx}" shape-rendering="crispEdges">
      <rect width="100%" height="100%" fill="#ffffff" />
      <path d="${paths.join('')}" fill="#000000" />
    </svg>`;
  }

  global.TIP_QRCode = {
    generateSVG(text, sizePx = 160) {
      if (!text) return "";
      const len = new TextEncoder().encode(text).length;
      let version = 1;
      if (len > 13) version = 2;
      if (len > 25) version = 3;
      if (len > 41) version = 4;
      if (len > 61) version = 5;
      if (len > 83) version = 6;

      const cw = encodeData(text, version);
      const mat = createMatrix(version, cw);
      return toSVG(mat, sizePx, 4);
    },
    rsEncode,
    encodeData,
    VERSIONS
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = global.TIP_QRCode;
  }
})(typeof window !== "undefined" ? window : global);
