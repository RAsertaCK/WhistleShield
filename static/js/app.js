// ═══════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════
const State = {
  role           : null,
  roomId         : null,
  privatePem     : null,
  publicPem      : null,
  coverData      : null,
  stegoData      : null,
  cachedStegoBlob: null,
  pollTimer      : null,
  decrypting     : false,
};

// ═══════════════════════════════════════════════════════════
// SESSION PERSISTENCE
// Private key TIDAK ikut terhapus saat room ditutup.
// Key disimpan per roomId dalam ws_keys_archive sehingga
// stego dari sesi sebelumnya tetap bisa diekstrak kapanpun.
// ═══════════════════════════════════════════════════════════
const SS = {
  KEY_PRIV   : "ws_privkey",
  KEY_PUB    : "ws_pubkey",
  KEY_ROOM   : "ws_roomid",
  KEY_ROLE   : "ws_role",
  KEY_ARCHIVE: "ws_keys_archive", // {roomId: {priv, pub, savedAt}}

  save(role, roomId, privatePem, publicPem) {
    try {
      localStorage.setItem(this.KEY_ROLE, role       || "");
      localStorage.setItem(this.KEY_ROOM, roomId     || "");
      localStorage.setItem(this.KEY_PRIV, privatePem || "");
      localStorage.setItem(this.KEY_PUB,  publicPem  || "");
      // Simpan juga ke arsip per roomId
      this._archiveSave(roomId, privatePem, publicPem);
    } catch(e) { console.warn("[WS] localStorage write error:", e); }
  },

  load() {
    try {
      return {
        role      : localStorage.getItem(this.KEY_ROLE) || null,
        roomId    : localStorage.getItem(this.KEY_ROOM) || null,
        privatePem: localStorage.getItem(this.KEY_PRIV) || null,
        publicPem : localStorage.getItem(this.KEY_PUB)  || null,
      };
    } catch(e) { return {}; }
  },

  // Simpan key ke arsip — max 5 entri, TTL 3 hari
  _archiveSave(roomId, privatePem, publicPem) {
    if (!roomId || !privatePem) return;
    try {
      const raw     = localStorage.getItem(this.KEY_ARCHIVE) || "{}";
      const archive = JSON.parse(raw);
      const now     = Date.now();
      const TTL_MS  = 3 * 24 * 60 * 60 * 1000; // 3 hari

      // Hapus entri expired dulu
      for (const [k, v] of Object.entries(archive)) {
        if (now - v.savedAt > TTL_MS) delete archive[k];
      }

      // Tambah/update entri baru
      archive[roomId] = { priv: privatePem, pub: publicPem, savedAt: now };

      // Jaga max 5 entri — hapus yang paling lama kalau lebih
      const entries = Object.entries(archive).sort((a, b) => a[1].savedAt - b[1].savedAt);
      if (entries.length > 5) {
        entries.slice(0, entries.length - 5).forEach(([k]) => delete archive[k]);
      }

      localStorage.setItem(this.KEY_ARCHIVE, JSON.stringify(archive));
    } catch(e) {}
  },

  // Cari private key dari arsip berdasarkan roomId
  // Kalau roomId tidak diketahui, return semua (untuk extractor manual)
  findKey(roomId) {
    try {
      const archive = JSON.parse(localStorage.getItem(this.KEY_ARCHIVE) || "{}");
      if (roomId && archive[roomId]) return archive[roomId].priv;
      // Fallback: cek key aktif
      const active = localStorage.getItem(this.KEY_PRIV);
      if (active) return active;
      // Fallback terakhir: key terbaru dari arsip
      const entries = Object.values(archive).sort((a, b) => b.savedAt - a.savedAt);
      return entries.length ? entries[0].priv : null;
    } catch(e) { return null; }
  },

  // Daftar semua room yang punya arsip key (untuk UI extractor)
  listArchive() {
    try {
      const archive = JSON.parse(localStorage.getItem(this.KEY_ARCHIVE) || "{}");
      const now     = Date.now();
      const TTL_MS  = 3 * 24 * 60 * 60 * 1000;
      return Object.entries(archive)
        .filter(([, v]) => now - v.savedAt <= TTL_MS)   // buang yang expired
        .sort((a, b) => b[1].savedAt - a[1].savedAt)    // terbaru dulu
        .map(([roomId, v]) => ({ roomId, savedAt: v.savedAt }));
    } catch(e) { return []; }
  },

  // Hapus sesi aktif TAPI pertahankan arsip key
  clearSession() {
    try {
      [this.KEY_ROLE, this.KEY_ROOM, this.KEY_PUB]
        .forEach(k => localStorage.removeItem(k));
      // KEY_PRIV sengaja TIDAK dihapus — tetap bisa dipakai extractor
      // KEY_ARCHIVE juga TIDAK dihapus
    } catch(e) {}
  },

  // Hapus total (hanya dari tombol "Reset Semua" yang eksplisit)
  clearAll() {
    try {
      [this.KEY_ROLE, this.KEY_ROOM, this.KEY_PRIV, this.KEY_PUB, this.KEY_ARCHIVE]
        .forEach(k => localStorage.removeItem(k));
    } catch(e) {}
  },

  // Alias lama — sekarang hanya hapus sesi, pertahankan key
  clear() { this.clearSession(); }
};

// ═══════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════
const MAX_MSG_BYTES = 190; // RSA-2048 OAEP-SHA256 hard limit

// ═══════════════════════════════════════════════════════════
// ZOMBIE POLL GUARD
// ═══════════════════════════════════════════════════════════
function _killPoll() {
  if (State.pollTimer !== null) {
    clearInterval(State.pollTimer);
    State.pollTimer = null;
  }
}

// ═══════════════════════════════════════════════════════════
// UI HELPERS
// ═══════════════════════════════════════════════════════════
function setStatus(id, type, msg, spin = false) {
  const el = document.getElementById(id);
  if (!el) return;
  el.className = `status ${type} show`;
  el.innerHTML = (spin ? `<div class="spinner"></div>` : "") + `<span>${msg}</span>`;
}

function clearStatus(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.className = "status";
  el.innerHTML = "";
}

function setProgress(prefix, pct) {
  const bar  = document.getElementById(`${prefix}-progress-bar`);
  const fill = document.getElementById(`${prefix}-progress-fill`);
  if (bar)  bar.style.display = pct > 0 ? "block" : "none";
  if (fill) fill.style.width  = `${Math.min(100, Math.max(0, pct))}%`;
}

function showSection(id) {
  document.querySelectorAll(".section").forEach(s => s.classList.remove("active"));
  const el = document.getElementById(id);
  if (el) el.classList.add("active");
}

function setActiveNav(navId) {
  document.querySelectorAll('.navbar-nav .nav-link').forEach(l => l.classList.remove('active'));
  const nav = document.getElementById(navId);
  if (nav) nav.classList.add('active');
}

function yieldToUI() {
  return new Promise(r => setTimeout(r, 30));
}

// Normalize error — DOMException dari crypto.subtle sering punya .message kosong
function _errMsg(e) {
  if (!e) return "Error tidak diketahui";
  if (e.name === "OperationError")
    return "Dekripsi gagal — kunci privat tidak cocok dengan stego ini, atau data DCT rusak. " +
           "Pastikan Anda membuka room yang sama tempat stego dikirim.";
  if (e.name === "DataError")
    return "Format kunci tidak valid — localStorage mungkin korup. Coba tutup room dan buat ulang.";
  if (e.name === "InvalidAccessError")
    return "Kunci tidak bisa digunakan untuk operasi ini.";
  return e.message || e.name || String(e) || "Error tidak diketahui";
}

// ═══════════════════════════════════════════════════════════
// BYTE COUNTER
// ═══════════════════════════════════════════════════════════
function _updateMsgCounter(val) {
  const bytes = new TextEncoder().encode(val).length;
  const el    = document.getElementById('msg-counter');
  if (!el) return;
  el.textContent = `${bytes} / ${MAX_MSG_BYTES} byte`;
  el.style.color = bytes > MAX_MSG_BYTES
    ? 'var(--danger)'
    : bytes > MAX_MSG_BYTES * 0.85
    ? 'var(--warn)'
    : 'var(--success)';
}

// ═══════════════════════════════════════════════════════════
// BURGER + SIDEBAR
// ═══════════════════════════════════════════════════════════
function _initBurger() {
  document.querySelectorAll('.sidebar-toggler').forEach(btn => {
    btn.addEventListener('click', e => {
      e.preventDefault();
      document.querySelector('.sidebar')?.classList.toggle('open');
      document.querySelector('.content')?.classList.toggle('open');
    });
  });
}

function _initSidebarOverlay() {
  document.addEventListener('click', e => {
    const sidebar = document.querySelector('.sidebar');
    if (!sidebar?.classList.contains('open')) return;
    if (sidebar.contains(e.target)) return;
    if (e.target.closest('.sidebar-toggler')) return;
    sidebar.classList.remove('open');
    document.querySelector('.content')?.classList.remove('open');
  });
}

function _closeSidebarMobile() {
  const sidebar = document.querySelector('.sidebar');
  if (sidebar?.classList.contains('open')) {
    sidebar.classList.remove('open');
    document.querySelector('.content')?.classList.remove('open');
  }
}

// ═══════════════════════════════════════════════════════════
// NAVIGATION
// ═══════════════════════════════════════════════════════════
function navigateTab(event, sectionId, navId) {
  event.preventDefault();
  _closeSidebarMobile();

  if (sectionId === 'sec-receiver-wait') {
    if (State.role === 'receiver' && State.roomId) {
      showSection('sec-receiver-wait');
    } else {
      const saved = SS.load();
      if (saved.role === 'receiver' && saved.roomId && saved.privatePem) {
        _restoreReceiverSession(saved);
        showSection('sec-receiver-wait');
      } else {
        showSection('sec-receiver-setup');
        startReceiverSetup();
      }
    }
  } else if (sectionId === 'sec-sender-setup') {
    senderResetForm();
    showSection('sec-sender-setup');
  } else if (sectionId === 'sec-extractor') {
    // Pastikan private key di State sebelum buka extractor
    if (!State.privatePem) {
      const saved = SS.load();
      if (saved.privatePem) {
        State.privatePem = saved.privatePem;
        if (!State.roomId) State.roomId = saved.roomId;
      }
    }
    _populateExtractorArchive();
    _autoFillExtractor();
    showSection(sectionId);
  } else {
    showSection(sectionId);
  }
  setActiveNav(navId);
}

function _autoFillExtractor() {
  if (!State.cachedStegoBlob) return;
  const lbl = document.getElementById('extractor-zone-label');
  if (lbl) lbl.textContent = `📦 Stego ter-cache dari room ${State.roomId || ''}`;
  setStatus('extractor-status', 'info', '🗂️ Stego ter-cache. Klik ⚡ Langsung Ekstrak atau upload file lain.');
  const qBtn = document.getElementById('btn-extractor-quick');
  if (qBtn) qBtn.style.display = 'inline-block';
}

// ═══════════════════════════════════════════════════════════
// CLIPBOARD
// ═══════════════════════════════════════════════════════════
function copyToClipboard(text, btn) {
  navigator.clipboard.writeText(text).then(() => {
    const orig = btn.textContent;
    btn.textContent = "✅ Disalin!";
    setTimeout(() => btn.textContent = orig, 1500);
  }).catch(() => {
    // Fallback untuk browser tanpa clipboard API
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity  = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    const orig = btn.textContent;
    btn.textContent = "✅ Disalin!";
    setTimeout(() => btn.textContent = orig, 1500);
  });
}

// ═══════════════════════════════════════════════════════════
// SESSION MANAGEMENT
// ═══════════════════════════════════════════════════════════
function goHome() {
  _killPoll();
  _closeRoomAndClear();
  window.location.href = "/";
}

function _closeRoomAndClear() {
  _killPoll();
  if (State.roomId) {
    try { navigator.sendBeacon(`/api/room/${State.roomId}/close`); } catch(_) {}
  }
  // Pakai clearSession — private key dan arsip DIPERTAHANKAN
  // agar stego dari sesi ini tetap bisa diekstrak nanti via Extractor
  SS.clearSession();
  State.role = State.roomId = State.publicPem = null;
  State.coverData = State.stegoData = State.cachedStegoBlob = null;
  State.decrypting = false;
  // State.privatePem SENGAJA tidak di-null — extractor perlu key ini
  if (typeof _updateNavRoomUI === 'function') _updateNavRoomUI();
}

function chooseRole(role) {
  if (role === "receiver") {
    State.role = "receiver";
    showSection("sec-receiver-setup");
    setActiveNav('nav-panel-admin');
    startReceiverSetup();
  } else {
    State.role = "sender";
    // Jangan sentuh State.privatePem — receiver key harus tetap ada
    State.coverData = null;
    State.stegoData = null;
    senderResetForm();
    showSection("sec-sender-setup");
    setActiveNav('nav-anonim-sender');
  }
}

function _restoreReceiverSession(saved) {
  State.role       = "receiver";
  State.roomId     = saved.roomId;
  State.privatePem = saved.privatePem;
  State.publicPem  = saved.publicPem;

  const roomEl = document.getElementById("display-room-id");
  if (roomEl) roomEl.textContent = saved.roomId;
  const shareUrl = `${window.location.origin}/room/${saved.roomId}`;
  const linkEl = document.getElementById("display-share-url");
  if (linkEl) { linkEl.textContent = shareUrl; linkEl.href = shareUrl; }

  if (typeof _updateNavRoomUI === 'function') _updateNavRoomUI();
  setStatus("receiver-wait-status", "info", "Sesi dipulihkan. Menunggu pesan...", true);
  _killPoll();
  startPolling();
}

// ═══════════════════════════════════════════════════════════
// DOM READY
// ═══════════════════════════════════════════════════════════
window.addEventListener("DOMContentLoaded", () => {
  _initBurger();
  _initSidebarOverlay();

  // Deep-link sender: /room/<id>
  const parts = window.location.pathname.split("/");
  const idx   = parts.indexOf("room");
  if (idx !== -1 && parts[idx + 1]) {
    const rid    = parts[idx + 1].toUpperCase();
    State.role   = "sender";
    State.roomId = rid;
    showSection("sec-sender-setup");
    setActiveNav('nav-anonim-sender');
    requestAnimationFrame(() => {
      const inp = document.getElementById("sender-room-input");
      if (inp) { inp.value = rid; senderLoadRoom(); }
    });
    return;
  }

  // Restore sesi receiver — verifikasi ke server dulu
  const saved = SS.load();
  if (saved.role === "receiver" && saved.roomId && saved.privatePem) {
    fetch(`/api/room/${saved.roomId}/status`, { cache: "no-store" })
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then(data => {
        _restoreReceiverSession(saved);
        showSection("sec-receiver-wait");
        setActiveNav("nav-panel-admin");
        if (data.has_message) {
          setStatus("receiver-wait-status", "success",
            "📩 Sesi dipulihkan & ada pesan masuk! Klik 'Unduh & Dekripsi'.");
          document.getElementById("btn-download-stego-receiver")?.style.setProperty("display", "inline-block");
          document.getElementById("btn-decrypt-now")?.style.setProperty("display", "inline-block");
        }
      })
      .catch(status => {
        SS.clear();
        console.info("[WS] Sesi lama dibersihkan (room expired, status:", status, ")");
      });
  }
});

// ═══════════════════════════════════════════════════════════
// RECEIVER SETUP
// ═══════════════════════════════════════════════════════════
async function startReceiverSetup() {
  setStatus("receiver-setup-status", "info", "Membangkitkan kunci RSA-2048 OAEP...", true);
  try {
    const keys = await CryptoEngine.generateKeyPair();
    State.privatePem = keys.privatePem;
    State.publicPem  = keys.publicPem;

    setStatus("receiver-setup-status", "info", "Mendaftarkan room ke server...", true);
    const res  = await fetch("/api/room/create", {
      method : "POST",
      cache  : "no-store",
      headers: { "Content-Type": "application/json" },
      body   : JSON.stringify({ public_key: keys.publicPem }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Gagal membuat room");

    State.roomId = data.room_id;
    State.role   = "receiver";
    SS.save("receiver", data.room_id, keys.privatePem, keys.publicPem);

    document.getElementById("display-room-id").textContent = data.room_id;
    const shareUrl = `${window.location.origin}/room/${data.room_id}`;
    document.getElementById("display-share-url").textContent = shareUrl;
    document.getElementById("display-share-url").href        = shareUrl;

    setStatus("receiver-setup-status", "success", "✅ Room berhasil dibuat!");
    if (typeof _updateNavRoomUI === 'function') _updateNavRoomUI();
    showSection("sec-receiver-wait");
    _killPoll();
    startPolling();

  } catch (e) {
    setStatus("receiver-setup-status", "error", `❌ ${_errMsg(e)}`);
  }
}

function copyRoomId() {
  copyToClipboard(State.roomId, document.getElementById("btn-copy-room"));
}
function copyShareUrl() {
  copyToClipboard(
    `${window.location.origin}/room/${State.roomId}`,
    document.getElementById("btn-copy-url")
  );
}

// ═══════════════════════════════════════════════════════════
// POLLING
// ═══════════════════════════════════════════════════════════
function startPolling() {
  _killPoll(); // anti-zombie
  State.pollTimer = setInterval(pollForMessage, 4000);
  pollForMessage();
}

async function pollForMessage() {
  if (!State.roomId || State.decrypting) return;
  try {
    const res = await fetch(`/api/room/${State.roomId}/status`, { cache: "no-store" });
    if (!res.ok) {
      if (res.status === 404) {
        _killPoll();
        SS.clear();
        setStatus("receiver-wait-status", "error", "⚠️ Room sudah kedaluwarsa. Buat room baru.");
      }
      return;
    }
    const data = await res.json();
    if (data.has_message) {
      _killPoll();
      setStatus("receiver-wait-status", "success",
        "📩 Pesan masuk! Klik 'Unduh & Dekripsi'.");
      document.getElementById("btn-download-stego-receiver")?.style.setProperty("display", "inline-block");
      document.getElementById("btn-decrypt-now")?.style.setProperty("display", "inline-block");
    }
  } catch (_) { /* jaringan putus — diam */ }
}

// ═══════════════════════════════════════════════════════════
// RECEIVER DOWNLOAD STEGO (ke disk saja, tanpa dekripsi)
// ═══════════════════════════════════════════════════════════
async function receiverDownloadStego() {
  if (!State.roomId) {
    setStatus("receiver-wait-status", "error", "Room tidak tersedia."); return;
  }
  try {
    setStatus("receiver-wait-status", "info", "Mengunduh stego dari server...", true);
    const res = await fetch(`/api/room/${State.roomId}/download?t=${Date.now()}`,
      { cache: "no-store" });
    if (!res.ok) throw new Error("Gagal mengunduh citra stego");
    const blob = await res.blob();
    State.cachedStegoBlob = blob;

    const imgData = await blobToImageData(blob);
    drawToCanvas(imgData, "receiver-stego-canvas");
    document.getElementById("receiver-stego-canvas").style.display = "block";
    _triggerBlobDownload(blob, `stego-${State.roomId}.png`);
    setStatus("receiver-wait-status", "success",
      "✅ Stego diunduh. Buka Extractor atau klik 'Unduh & Dekripsi' untuk membaca pesan.");
  } catch (e) {
    setStatus("receiver-wait-status", "error", `❌ ${_errMsg(e)}`);
  }
}

function _triggerBlobDownload(blob, filename) {
  const url  = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url; link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

// ═══════════════════════════════════════════════════════════
// RECEIVER DECRYPT
// ═══════════════════════════════════════════════════════════
async function receiverDownloadAndDecrypt() {
  // Pastikan private key tersedia — guard race condition
  const privPem = State.privatePem || SS.load().privatePem;
  if (!privPem) {
    setStatus("receiver-wait-status", "error",
      "❌ Private key belum tersedia. Tunggu sebentar lalu coba lagi, atau refresh halaman.");
    return;
  }
  // Pastikan State.privatePem selalu ter-set sebelum masuk ke _extractAndDecrypt
  State.privatePem = privPem;
  State.decrypting = true;

  try {
    let blob;
    if (State.cachedStegoBlob) {
      blob = State.cachedStegoBlob;
      setStatus("receiver-wait-status", "info", "Menggunakan stego ter-cache...", true);
    } else {
      setStatus("receiver-wait-status", "info", "Mengunduh stego dari server...", true);
      const res = await fetch(`/api/room/${State.roomId}/download?t=${Date.now()}`,
        { cache: "no-store" });
      if (res.status === 404) {
        throw new Error(
          "Stego tidak ditemukan di server (mungkin sudah terhapus atau room expired). " +
          "Jika kamu sudah mengunduh file PNG-nya, buka menu Extractor dan upload file tersebut."
        );
      }
      if (!res.ok) throw new Error(`Gagal mengunduh stego dari server (HTTP ${res.status})`);
      blob = await res.blob();
      State.cachedStegoBlob = blob;
    }

    const stegoData = await blobToImageData(blob);
    drawToCanvas(stegoData, "receiver-stego-canvas");
    document.getElementById("receiver-stego-canvas").style.display = "block";

    const { plaintext } = await _extractAndDecrypt(stegoData, "receiver-wait-status", "receiver");

    setProgress("receiver", 100);
    setStatus("receiver-wait-status", "success", "✅ Pesan berhasil didekripsi!");
    document.getElementById("decrypted-message").textContent = plaintext;

    try { await fetch(`/api/room/${State.roomId}/clear`, { method: "DELETE" }); } catch(_) {}

    _killPoll();
    State.decrypting      = false;
    State.cachedStegoBlob = null;
    showSection("sec-receiver-result");

  } catch (e) {
    setStatus("receiver-wait-status", "error", `❌ ${_errMsg(e)}`);
    setProgress("receiver", 0);
    State.decrypting = false;
    console.error("[WS] decrypt error:", e);
  }
}

function receiverWaitAgain() {
  State.cachedStegoBlob = null;
  State.decrypting      = false;
  // Reset tombol
  document.getElementById("btn-download-stego-receiver")?.style.setProperty("display", "none");
  document.getElementById("btn-decrypt-now")?.style.setProperty("display", "none");
  showSection("sec-receiver-wait");
  clearStatus("receiver-wait-status");
  setProgress("receiver", 0);
  setStatus("receiver-wait-status", "info", "Menunggu pesan berikutnya...", true);
  _killPoll();
  startPolling();
}

// ═══════════════════════════════════════════════════════════
// SHARED EXTRACT + DECRYPT CORE
// ═══════════════════════════════════════════════════════════
async function _extractAndDecrypt(stegoData, statusId, progressPrefix) {
  const setS = (t, m, s) => setStatus(statusId, t, m, s);

  setS("info", "Membaca header DCT...", true);
  setProgress(progressPrefix, 10);
  await yieldToUI();

  const headerBits  = DCTEngine.extractAll(stegoData, 32, null);
  const headerBytes = DCTEngine.bitsToBytes(headerBits);
  const totalBytes  = new DataView(headerBytes.buffer).getUint32(0, false);

  // RSA-2048 OAEP-SHA256 selalu output 256 byte — validasi ketat
  if (totalBytes < 200 || totalBytes > 300) {
    throw new Error(
      `Header DCT tidak valid (nilai=${totalBytes}). ` +
      `Kemungkinan: gambar dikonversi ke JPEG, atau file stego yang salah. ` +
      `Hanya upload PNG asli dari WhistleShield.`
    );
  }

  const totalBitsAvail  = Math.floor(stegoData.width  / DCTEngine.BLOCK) *
                          Math.floor(stegoData.height / DCTEngine.BLOCK);
  const totalBitsNeeded = 32 + totalBytes * 8;
  if (totalBitsNeeded > totalBitsAvail)
    throw new Error("Overflow: citra terlalu kecil untuk payload yang tersimpan.");

  setS("info", `Mengekstrak ${totalBytes} byte ciphertext...`, true);
  setProgress(progressPrefix, 20);
  await yieldToUI();

  const allBits     = DCTEngine.extractAll(stegoData, totalBitsNeeded,
    pct => setProgress(progressPrefix, 20 + pct * 0.6));
  const cipherBits  = allBits.slice(32);
  const cipherBytes = DCTEngine.bitsToBytes(cipherBits).slice(0, totalBytes);

  setProgress(progressPrefix, 82);
  setS("info", "Mendekripsi RSA-2048 OAEP...", true);
  await yieldToUI();

  // Cari private key: State → arsip per roomId → arsip terbaru
  // Ini yang memungkinkan stego dari sesi sebelumnya tetap bisa diekstrak
  const privPem = State.privatePem || SS.findKey(State.roomId);
  if (!privPem) throw new Error("Private key tidak ditemukan. Pastikan Anda membuka browser yang sama tempat room dibuat.");

  if (!privPem.includes("PRIVATE KEY")) {
    throw new Error("Format private key tidak valid. Coba buat room baru.");
  }

  console.debug("[WS] privkey[:60]:", privPem.slice(0, 60).replace(/\n/g, " "));
  console.debug("[WS] cipherBytes.length:", cipherBytes.length);

  const plaintext = await CryptoEngine.decrypt(privPem, cipherBytes);
  return { plaintext, totalBytes };
}

// ═══════════════════════════════════════════════════════════
// SENDER
// ═══════════════════════════════════════════════════════════
function senderBackToRoom() {
  senderResetForm();
  showSection("sec-sender-setup");
  setStatus("sender-setup-status", "info", "Masukkan Room ID penerima.");
}

async function senderLoadRoom() {
  const input  = document.getElementById("sender-room-input");
  const roomId = (input?.value || "").trim().toUpperCase();
  if (!roomId || roomId.length < 4) {
    setStatus("sender-setup-status", "error", "❌ Masukkan Room ID yang valid (min 4 karakter)."); return;
  }
  setStatus("sender-setup-status", "info", "Menghubungkan ke room...", true);
  try {
    const res  = await fetch(`/api/room/${roomId}/pubkey`, { cache: "no-store" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Room tidak ditemukan atau sudah kedaluwarsa");
    // Set sender state — JANGAN sentuh State.privatePem
    State.roomId    = data.room_id;
    State.publicPem = data.public_key;
    setStatus("sender-setup-status", "success", `✅ Terhubung ke room ${data.room_id}.`);
    document.getElementById("sender-room-display").textContent = data.room_id;
    showSection("sec-sender-compose");
  } catch (e) {
    setStatus("sender-setup-status", "error", `❌ ${_errMsg(e)}`);
  }
}

function senderLoadCover(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    const img = new Image();
    img.onload = () => {
      const MIN = 400, MAX = 1000;
      const origW = img.width, origH = img.height;
      let w = origW, h = origH;

      const tooSmall = origW < MIN || origH < MIN;
      const tooBig   = origW > MAX || origH > MAX;

      if (tooSmall) {
        const s = Math.max(MIN / w, MIN / h);
        w = Math.floor(w * s); h = Math.floor(h * s);
      }
      if (w > MAX || h > MAX) {
        const s = Math.min(MAX / w, MAX / h);
        if (Math.floor(w * s) >= MIN && Math.floor(h * s) >= MIN) {
          w = Math.floor(w * s); h = Math.floor(h * s);
        } else {
          const s2 = Math.max(MIN / w, MIN / h);
          w = Math.floor(w * s2); h = Math.floor(h * s2);
        }
      }
      // WAJIB kelipatan 8 untuk blok DCT 8×8
      w = Math.max(8, Math.floor(w / 8) * 8);
      h = Math.max(8, Math.floor(h / 8) * 8);

      const canvas = document.getElementById("cover-canvas");
      canvas.width = w; canvas.height = h;
      // willReadFrequently: paksa CPU path — konsisten dengan extract path
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      State.coverData = ctx.getImageData(0, 0, w, h);

      const cap         = DCTEngine.capacity(w, h);
      const bitsNeeded  = (4 + 256) * 8; // 2080
      const warnEl      = document.getElementById("cover-size-warning");

      document.getElementById("cover-preview-wrap").style.display = "flex";
      document.getElementById("cover-zone-label").textContent = `📁 ${file.name}`;

      if (cap.blocks < bitsNeeded) {
        if (warnEl) setStatus("cover-size-warning", "error",
          `⛔ Kapasitas tidak cukup (${cap.blocks} blok tersedia, butuh 2080). ` +
          `Ganti dengan gambar resolusi lebih tinggi.`);
        setStatus("sender-compose-status", "error",
          `⛔ Gambar ini tidak bisa digunakan sebagai cover stego.`);
        State.coverData = null;
        return;
      }

      if (warnEl) {
        if (tooSmall) {
          setStatus("cover-size-warning", "info",
            `⚠️ Gambar asli (${origW}×${origH}px) di bawah 400×400px — ` +
            `di-upscale ke ${w}×${h}px. Lebih baik pakai gambar resolusi lebih tinggi.`);
        } else if (tooBig) {
          setStatus("cover-size-warning", "info",
            `ℹ️ Gambar asli (${origW}×${origH}px) dikecilkan ke ${w}×${h}px.`);
        } else {
          clearStatus("cover-size-warning");
        }
      }

      setStatus("sender-compose-status", "info",
        `✅ Gambar siap: ${w}×${h}px · Kapasitas ~${cap.usableBytes} byte` +
        ` · Pakai ${bitsNeeded} dari ${cap.blocks} blok DCT`);
    };
    img.onerror = () =>
      setStatus("sender-compose-status", "error", "❌ Gagal membaca file gambar.");
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

async function senderSendMessage() {
  const msgEl  = document.getElementById("sender-message");
  const msg    = msgEl?.value.trim() || "";
  const byteLen = new TextEncoder().encode(msg).length;

  // Validasi semua SEBELUM disable tombol
  if (!msg) {
    setStatus("sender-compose-status", "error", "❌ Tulis pesan terlebih dahulu."); return;
  }
  if (!State.coverData) {
    setStatus("sender-compose-status", "error", "❌ Upload foto cover terlebih dahulu."); return;
  }
  if (!State.publicPem) {
    setStatus("sender-compose-status", "error", "❌ Belum terhubung ke room."); return;
  }
  if (byteLen > MAX_MSG_BYTES) {
    setStatus("sender-compose-status", "error",
      `❌ Pesan terlalu panjang (${byteLen} byte, maks ${MAX_MSG_BYTES}). ` +
      `Kurangi ${byteLen - MAX_MSG_BYTES} byte. ` +
      `Emoji = 4 byte, karakter non-ASCII bisa lebih dari 1 byte.`);
    return;
  }

  const btnSend = document.getElementById("btn-send");
  btnSend.disabled = true;
  setProgress("sender", 5);

  try {
    setStatus("sender-compose-status", "info", "🔐 Mengenkripsi RSA-2048 OAEP...", true);
    const cipherBytes = await CryptoEngine.encrypt(State.publicPem, msg);
    setProgress("sender", 15);

    const header  = new Uint8Array(4);
    new DataView(header.buffer).setUint32(0, cipherBytes.length, false);
    const payload = new Uint8Array(4 + cipherBytes.length);
    payload.set(header, 0); payload.set(cipherBytes, 4);
    const bits = DCTEngine.bytesToBits(payload);

    const cap = DCTEngine.capacity(State.coverData.width, State.coverData.height);
    if (bits.length > cap.blocks)
      throw new Error(
        `Gambar terlalu kecil (butuh ${bits.length} blok, tersedia ${cap.blocks}). ` +
        `Gunakan gambar ≥400×400px.`
      );

    setStatus("sender-compose-status", "info", "📐 Menyisipkan ke domain DCT...", true);
    await yieldToUI();
    State.stegoData = DCTEngine.embedAll(State.coverData, bits,
      pct => setProgress("sender", 15 + pct * 0.65));
    setProgress("sender", 82);

    const metrics = QualityMetrics.compute(State.coverData, State.stegoData);
    const sc = document.getElementById("stego-canvas");
    sc.style.opacity = "1";
    drawToCanvas(State.stegoData, "stego-canvas");
    document.getElementById("cover-preview-wrap").style.display = "flex";
    document.getElementById("btn-download-stego").style.display = "inline-block";

    setStatus("sender-compose-status", "info", "📤 Mengunggah stego ke server...", true);
    const blob = await new Promise(res => sc.toBlob(res, "image/png"));
    if (!blob) throw new Error("Gagal membuat PNG dari canvas. Coba refresh halaman.");

    const form = new FormData();
    form.append("file", blob, "stego.png");
    const uploadRes  = await fetch(`/api/room/${State.roomId}/upload`, { method: "POST", body: form });
    const uploadData = await uploadRes.json();
    if (!uploadRes.ok) throw new Error(uploadData.error || "Gagal upload ke server");

    setProgress("sender", 100);
    setStatus("sender-compose-status", "success",
      `✅ Pesan terkirim! PSNR: ${metrics.psnr} dB · ${metrics.quality}`);
    btnSend.textContent = "✅ Terkirim";
    document.getElementById("btn-send-again").style.display = "inline-block";
    document.getElementById("sender-metrics").style.display = "block";
    document.getElementById("m-psnr").textContent = `${metrics.psnr} dB`;
    document.getElementById("m-mse").textContent  = metrics.mse;
    document.getElementById("m-qual").textContent = metrics.quality;
    document.getElementById("m-bits").textContent = `${bits.length} / ${cap.usableBits}`;

  } catch(e) {
    setStatus("sender-compose-status", "error", `❌ ${_errMsg(e)}`);
    btnSend.disabled    = false;
    btnSend.textContent = "🔒 Enkripsi & Kirim";
    setProgress("sender", 0);
    console.error("[WS] send error:", e);
  }
}

function senderResetForm() {
  const msgEl = document.getElementById("sender-message");
  if (msgEl) msgEl.value = "";
  _updateMsgCounter("");

  State.coverData = null;
  State.stegoData = null;

  document.getElementById("cover-file-input")?.setAttribute("value", "");
  try { document.getElementById("cover-file-input").value = ""; } catch(_) {}
  const czl = document.getElementById("cover-zone-label");
  if (czl) czl.textContent = "Klik atau seret foto ke sini";

  clearStatus("cover-size-warning");
  document.getElementById("cover-preview-wrap").style.display = "none";
  document.getElementById("btn-download-stego").style.display = "none";
  document.getElementById("btn-send-again").style.display     = "none";
  document.getElementById("sender-metrics").style.display     = "none";
  setProgress("sender", 0);
  clearStatus("sender-compose-status");

  const btn = document.getElementById("btn-send");
  if (btn) { btn.disabled = false; btn.textContent = "🔒 Enkripsi & Kirim"; }
}

async function downloadStegoImage() {
  const canvas = document.getElementById("stego-canvas");
  if (!canvas || !State.stegoData) {
    setStatus("sender-compose-status", "error", "❌ Belum ada stego. Kirim pesan terlebih dahulu."); return;
  }
  canvas.toBlob(blob => {
    if (!blob) { setStatus("sender-compose-status", "error", "❌ Gagal membuat PNG."); return; }
    _triggerBlobDownload(blob, `stego-${State.roomId || Date.now()}.png`);
    setStatus("sender-compose-status", "success", "✅ Stego PNG sedang diunduh.");
  }, "image/png");
}

// ═══════════════════════════════════════════════════════════
// IMAGE HELPERS
// ═══════════════════════════════════════════════════════════

// Fill background putih SEBELUM drawImage — mencegah premultiplied-alpha round-trip.
// willReadFrequently=true: paksa browser pakai CPU path (bukan GPU) agar pixel values
// konsisten antara embed dan extract — GPU floating point bisa beda ±1 dari CPU.
function blobToImageData(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width  = img.width;
      canvas.height = img.height;
      // willReadFrequently: paksa CPU path untuk konsistensi pixel values
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      resolve(ctx.getImageData(0, 0, canvas.width, canvas.height));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Gagal memuat gambar — file mungkin rusak atau bukan format gambar valid."));
    };
    img.src = url;
  });
}

function drawToCanvas(imageData, canvasId) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  canvas.width           = imageData.width;
  canvas.height          = imageData.height;
  canvas.style.maxWidth  = "100%";
  canvas.style.height    = "auto";
  // willReadFrequently: CPU path agar putImageData → toBlob konsisten
  canvas.getContext("2d", { willReadFrequently: true }).putImageData(imageData, 0, 0);
}

// ═══════════════════════════════════════════════════════════
// EXTRACTOR
// ═══════════════════════════════════════════════════════════

// Populate dropdown arsip room saat buka extractor
function _populateExtractorArchive() {
  const archive    = SS.listArchive();
  const selectEl   = document.getElementById('extractor-room-select');
  const archiveBar = document.getElementById('extractor-archive-bar');
  const indicator  = document.getElementById('extractor-key-indicator');
  if (!selectEl || !archiveBar) return;

  if (archive.length === 0) {
    archiveBar.style.display = 'none';
    return;
  }

  // Auto-select: pakai room aktif kalau ada, kalau tidak pakai yang terbaru
  const autoRoom = State.roomId || archive[0].roomId;
  State.privatePem = State.privatePem || SS.findKey(autoRoom);
  if (autoRoom && !State.roomId) State.roomId = autoRoom;

  // Kalau hanya 1 room — sembunyikan dropdown, langsung set key dan tampilkan info saja
  if (archive.length === 1) {
    archiveBar.style.display = 'block';
    selectEl.closest('div[style*="display:flex"]')?.style.setProperty('display', 'none');
    if (indicator) {
      const date = new Date(archive[0].savedAt).toLocaleDateString('id-ID',
        { day: 'numeric', month: 'short', year: 'numeric' });
      indicator.textContent = `🔑 Room ${archive[0].roomId} (${date}) — kunci aktif`;
      indicator.style.color  = 'var(--success)';
      indicator.style.display = 'block';
    }
    // Sembunyikan label dan select, hanya tampilkan indicator
    const label = archiveBar.querySelector('label');
    if (label) label.style.display = 'none';
    return;
  }

  // >1 room: tampilkan dropdown
  archiveBar.style.display = 'block';
  const flexDiv = selectEl.closest('div[style*="display:flex"]');
  if (flexDiv) flexDiv.style.display = 'flex';
  const label = archiveBar.querySelector('label');
  if (label) label.style.display = 'block';

  selectEl.innerHTML = '<option value="">— Pilih Room ID —</option>';
  archive.forEach(({ roomId, savedAt }) => {
    const date = new Date(savedAt).toLocaleDateString('id-ID',
      { day: 'numeric', month: 'short', year: 'numeric' });
    const opt  = document.createElement('option');
    opt.value  = roomId;
    opt.textContent = `${roomId}  ·  ${date}`;
    if (roomId === autoRoom) opt.selected = true;
    selectEl.appendChild(opt);
  });

  // Auto-trigger untuk room yang dipilih
  extractorSelectRoom(autoRoom);
}

// Set State.privatePem dari arsip berdasarkan room yang dipilih
function extractorSelectRoom(roomId) {
  const indicator = document.getElementById('extractor-key-indicator');
  if (!roomId) {
    if (indicator) indicator.textContent = '';
    return;
  }
  const key = SS.findKey(roomId);
  if (key) {
    State.privatePem = key;
    State.roomId     = roomId;
    if (indicator) {
      indicator.textContent = '🔑 Kunci privat ditemukan ✅';
      indicator.style.color = 'var(--success)';
    }
  } else {
    if (indicator) {
      indicator.textContent = '⚠️ Kunci tidak ditemukan untuk room ini';
      indicator.style.color = 'var(--warn)';
    }
  }
}

async function extractorQuickExtract() {
  if (!State.cachedStegoBlob) {
    setStatus("extractor-status", "error", "❌ Tidak ada stego ter-cache. Upload file PNG."); return;
  }
  await _runExtractor(State.cachedStegoBlob);
}

async function extractorUploadAndExtract(event) {
  const file = event.target?.files?.[0];
  if (!file) return setStatus("extractor-status", "error", "Tidak ada file yang dipilih.");

  // Validasi: harus PNG
  if (file.type !== 'image/png' && !file.name.toLowerCase().endsWith('.png')) {
    setStatus("extractor-status", "error",
      "❌ File harus PNG. JPEG/JPG tidak didukung karena kompresi lossy merusak data DCT.");
    return;
  }

  const lbl = document.getElementById('extractor-zone-label');
  if (lbl) lbl.textContent = `📁 ${file.name}`;
  await _runExtractor(file);
}

async function _runExtractor(blobOrFile) {
  // Pastikan ada key sebelum mulai
  const keyCheck = State.privatePem || SS.findKey(State.roomId);
  if (!keyCheck) {
    setStatus("extractor-status", "error",
      "❌ Kunci privat tidak ditemukan. Pilih Room ID dari dropdown di atas, " +
      "atau pastikan Anda membuka browser yang sama tempat room dibuat.");
    return;
  }
  State.privatePem = keyCheck;

  try {
    setStatus("extractor-status", "info", "Membaca file stego...", true);
    setProgress("extractor", 5);

    const stegoData = await blobToImageData(blobOrFile);
    drawToCanvas(stegoData, "extractor-stego-canvas");
    document.getElementById("extractor-stego-canvas").style.display = "block";

    const { plaintext } = await _extractAndDecrypt(stegoData, "extractor-status", "extractor");

    setProgress("extractor", 100);
    setStatus("extractor-status", "success", "✅ Pesan berhasil diekstrak & didekripsi.");
    document.getElementById("extractor-decrypted").textContent = plaintext;
    document.getElementById("decrypted-message").textContent   = plaintext;

    // Hapus stego dari server kalau room masih aktif (best-effort)
    if (State.roomId) {
      fetch(`/api/room/${State.roomId}/clear`, { method: "DELETE" }).catch(() => {});
    }
    State.cachedStegoBlob = null;
    document.getElementById('btn-extractor-quick')?.style.setProperty("display", "none");

  } catch (e) {
    setStatus("extractor-status", "error", `❌ ${_errMsg(e)}`);
    setProgress("extractor", 0);
    console.error("[WS] extractor error:", e);
  }
}