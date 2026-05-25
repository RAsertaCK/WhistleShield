const CryptoEngine = (() => {
  const ALG = { name: "RSA-OAEP", hash: "SHA-256" };
  const KEY_PARAMS = {
    ...ALG,
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
  };

  async function generateKeyPair() {
    const pair    = await crypto.subtle.generateKey(KEY_PARAMS, true, ["encrypt", "decrypt"]);
    const pubDer  = await crypto.subtle.exportKey("spki",  pair.publicKey);
    const privDer = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
    return {
      publicKey : pair.publicKey,
      privateKey: pair.privateKey,
      publicPem : _derToPem(pubDer,  "PUBLIC KEY"),
      privatePem: _derToPem(privDer, "PRIVATE KEY"),
    };
  }

  async function encrypt(publicPem, plaintext) {
    const key       = await _importPublic(publicPem);
    const encoded   = new TextEncoder().encode(plaintext);
    const encrypted = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, key, encoded);
    return new Uint8Array(encrypted);
  }

  async function decrypt(privatePem, cipherBytes) {
    const key       = await _importPrivate(privatePem);
    const decrypted = await crypto.subtle.decrypt({ name: "RSA-OAEP" }, key, cipherBytes);
    return new TextDecoder().decode(decrypted);
  }

  function _ab2b64(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    let binary  = "";
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  function _derToPem(der, label) {
    const b64   = _ab2b64(der);
    const lines = b64.match(/.{1,64}/g).join("\n");
    return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----`;
  }

  function _pemToDer(pem) {
    const b64 = pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s/g, "");
    const bin = atob(b64);
    const der = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) der[i] = bin.charCodeAt(i);
    return der;
  }

  async function _importPublic(pem) {
    return crypto.subtle.importKey("spki", _pemToDer(pem), ALG, false, ["encrypt"]);
  }

  async function _importPrivate(pem) {
    return crypto.subtle.importKey("pkcs8", _pemToDer(pem), ALG, false, ["decrypt"]);
  }

  return { generateKeyPair, encrypt, decrypt };
})();

const DCTEngine = (() => {
  const BLOCK     = 8;
  const EMBED_ROW = 3;
  const EMBED_COL = 4;
  const ALPHA     = 10;

  function dct1d(x) {
    const N = x.length, out = new Float64Array(N);
    for (let k = 0; k < N; k++) {
      let s = 0;
      for (let n = 0; n < N; n++)
        s += x[n] * Math.cos(Math.PI * k * (2*n+1) / (2*N));
      out[k] = s * (k === 0 ? Math.sqrt(1/N) : Math.sqrt(2/N));
    }
    return out;
  }

  function idct1d(X) {
    const N = X.length, out = new Float64Array(N);
    for (let n = 0; n < N; n++) {
      let s = X[0] * Math.sqrt(1/N);
      for (let k = 1; k < N; k++)
        s += X[k] * Math.sqrt(2/N) * Math.cos(Math.PI * k * (2*n+1) / (2*N));
      out[n] = s;
    }
    return out;
  }

  function dct2d(block) {
    const tmp = block.map(row => dct1d(row));
    const out = Array.from({length: BLOCK}, () => new Float64Array(BLOCK));
    for (let c = 0; c < BLOCK; c++) {
      const col    = tmp.map(r => r[c]);
      const dctCol = dct1d(col);
      for (let r = 0; r < BLOCK; r++) out[r][c] = dctCol[r];
    }
    return out;
  }

  function idct2d(block) {
    const tmp = block.map(row => idct1d(row));
    const out = Array.from({length: BLOCK}, () => new Float64Array(BLOCK));
    for (let c = 0; c < BLOCK; c++) {
      const col     = tmp.map(r => r[c]);
      const idctCol = idct1d(col);
      for (let r = 0; r < BLOCK; r++) out[r][c] = idctCol[r];
    }
    return out;
  }

  function getYBlock(imgData, bx, by) {
    const W     = imgData.width;
    const block = Array.from({length: BLOCK}, () => new Float64Array(BLOCK));
    for (let r = 0; r < BLOCK; r++) {
      for (let c = 0; c < BLOCK; c++) {
        const idx   = ((by*BLOCK+r)*W + (bx*BLOCK+c)) * 4;
        const R = imgData.data[idx], G = imgData.data[idx+1], B = imgData.data[idx+2];
        block[r][c] = 0.299*R + 0.587*G + 0.114*B - 128;
      }
    }
    return block;
  }

  function setYBlock(stegoData, bx, by, origBlock, newBlock) {
    const W = stegoData.width;
    for (let r = 0; r < BLOCK; r++) {
      for (let c = 0; c < BLOCK; c++) {
        const idx   = ((by*BLOCK+r)*W + (bx*BLOCK+c)) * 4;
        const delta = Math.round(newBlock[r][c]) - Math.round(origBlock[r][c]);
        stegoData.data[idx]   = Math.max(0, Math.min(255, stegoData.data[idx]   + delta));
        stegoData.data[idx+1] = Math.max(0, Math.min(255, stegoData.data[idx+1] + delta));
        stegoData.data[idx+2] = Math.max(0, Math.min(255, stegoData.data[idx+2] + delta));
      }
    }
  }

  function embedBit(dctBlock, bit) {
    let coeff = dctBlock[EMBED_ROW][EMBED_COL];
    let q     = Math.round(coeff / ALPHA);
    const odd = ((q % 2) + 2) % 2 === 1;
    if (bit === 1 && !odd) q += 1;
    if (bit === 0 &&  odd) q += 1;
    dctBlock[EMBED_ROW][EMBED_COL] = q * ALPHA;
    return dctBlock;
  }

  function extractBit(dctBlock) {
    const q = Math.round(dctBlock[EMBED_ROW][EMBED_COL] / ALPHA);
    return ((q % 2) + 2) % 2;
  }

  const HEADER_BITS = 32;

  function capacity(w, h) {
    const blocks = Math.floor(w/BLOCK) * Math.floor(h/BLOCK);
    const usable = blocks - HEADER_BITS;
    return { blocks, usableBits: usable, usableBytes: Math.floor(usable/8) };
  }

  function embedAll(coverData, bits, onProgress) {
    const W       = coverData.width, H = coverData.height;
    const blocksX = Math.floor(W/BLOCK);
    const totalBlocks = Math.floor(W/BLOCK) * Math.floor(H/BLOCK);

    if (bits.length > totalBlocks)
      throw new Error(`Kapasitas tidak cukup: butuh ${bits.length} bit, tersedia ${totalBlocks} bit.`);

    const stegoData = new ImageData(new Uint8ClampedArray(coverData.data), W, H);

    for (let b = 0; b < bits.length; b++) {
      const bx = b % blocksX, by = Math.floor(b / blocksX);
      const orig = getYBlock(coverData, bx, by);
      const dct  = dct2d(orig);
      embedBit(dct, bits[b]);
      const idct = idct2d(dct);
      setYBlock(stegoData, bx, by, orig, idct);
      if (b % 400 === 0 && onProgress) onProgress(b / bits.length * 100);
    }
    if (onProgress) onProgress(100);
    return stegoData;
  }

  function extractAll(stegoData, totalBits, onProgress) {
    const W       = stegoData.width;
    const blocksX = Math.floor(W/BLOCK);
    const bits    = [];

    for (let b = 0; b < totalBits; b++) {
      const bx = b % blocksX, by = Math.floor(b / blocksX);
      bits.push(extractBit(dct2d(getYBlock(stegoData, bx, by))));
      if (b % 400 === 0 && onProgress) onProgress(b / totalBits * 100);
    }
    if (onProgress) onProgress(100);
    return bits;
  }

  function bytesToBits(bytes) {
    const bits = [];
    for (const b of bytes)
      for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1);
    return bits;
  }

  function bitsToBytes(bits) {
    const bytes = new Uint8Array(Math.ceil(bits.length / 8));
    for (let i = 0; i < bytes.length; i++) {
      let v = 0;
      for (let j = 0; j < 8; j++) v = (v << 1) | (bits[i*8+j] ?? 0);
      bytes[i] = v;
    }
    return bytes;
  }

  return { embedAll, extractAll, bytesToBits, bitsToBytes, capacity, BLOCK };
})();

const QualityMetrics = (() => {
  function compute(coverData, stegoData) {
    const n = coverData.width * coverData.height;
    let sumSq = 0;
    for (let i = 0; i < n; i++) {
      const base = i * 4;
      for (let ch = 0; ch < 3; ch++) {
        const d = coverData.data[base+ch] - stegoData.data[base+ch];
        sumSq  += d * d;
      }
    }
    const mse  = sumSq / (3 * n);
    const psnr = mse === 0 ? Infinity : 10 * Math.log10(255*255 / mse);
    let quality;
    if (!isFinite(psnr) || psnr >= 50) quality = "★★★ Sempurna";
    else if (psnr >= 40)                quality = "★★☆ Sangat Baik";
    else if (psnr >= 30)                quality = "★☆☆ Noticeable";
    else                                quality = "☆☆☆ Buruk";
    return { mse: mse.toFixed(4), psnr: isFinite(psnr) ? psnr.toFixed(2) : "∞", quality };
  }
  return { compute };
})();