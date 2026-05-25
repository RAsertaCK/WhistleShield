const State = {
  role       : null,
  roomId     : null,
  privatePem : null,
  publicPem  : null,
  coverData  : null,
  stegoData  : null,
  pollTimer  : null,
  decrypting : false,
};

// FIX PRODUCTION: Menggunakan sessionStorage agar kunci hancur saat tab ditutup
const STORAGE_KEY = "ws_privkey"; 

// ═══════════════════════════════════════════════════════════
// UI HELPERS
// ═══════════════════════════════════════════════════════════
function setStatus(id, type, msg, spin = false) {
  const el = document.getElementById(id);
  if (!el) return;
  el.className = `status ${type} show`;
  el.innerHTML = (spin ? `<div class="spinner"></div>` : "") + `<span>${msg}</span>`;
}

function setProgress(prefix, pct) {
  const bar  = document.getElementById(`${prefix}-progress-bar`);
  const fill = document.getElementById(`${prefix}-progress-fill`);
  if (bar)  bar.style.display = "block";
  if (fill) fill.style.width  = `${Math.min(100, pct)}%`;
}

function showSection(id) {
  document.querySelectorAll(".section").forEach(s => s.classList.remove("active"));
  const el = document.getElementById(id);
  if (el) el.classList.add("active");
}

function setActiveNav(navId) {
  document.querySelectorAll('.navbar-nav .nav-link').forEach(link => link.classList.remove('active'));
  const nav = document.getElementById(navId);
  if (nav) nav.classList.add('active');
}

function navigateTab(event, sectionId, navId) {
  event.preventDefault();
  if (sectionId === 'sec-receiver-wait' && (!State.role || State.role !== 'receiver')) {
    showSection('sec-receiver-setup');
  } else if (sectionId === 'sec-sender-setup') {
    senderResetForm();
    showSection('sec-sender-setup');
  } else {
    showSection(sectionId);
  }
  setActiveNav(navId);
}

function copyToClipboard(text, btn) {
  navigator.clipboard.writeText(text).then(() => {
    const orig = btn.textContent;
    btn.textContent = "✅ Disalin!";
    setTimeout(() => btn.textContent = orig, 1500);
  });
}

function goHome() {
  window.location.href = "/";
}

function senderBackToRoom() {
  senderResetForm();
  showSection("sec-sender-setup");
  setStatus("sender-setup-status", "info", "Masukkan Room ID penerima untuk mengirim pesan.");
}

async function downloadStegoImage() {
  const canvas = document.getElementById("stego-canvas");
  if (!canvas || !State.stegoData) {
    setStatus("sender-compose-status", "error", "❌ Tidak ada stego image untuk diunduh. Buat pesan terlebih dahulu.");
    return;
  }
  canvas.toBlob(blob => {
    if (!blob) {
      setStatus("sender-compose-status", "error", "❌ Gagal membuat file PNG.");
      return;
    }
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `stego-${State.roomId || Date.now()}.png`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(link.href);
    setStatus("sender-compose-status", "success", "✅ Stego PNG berhasil disiapkan untuk diunduh.");
  }, "image/png");
}

// ═══════════════════════════════════════════════════════════
// LANDING & AUTO-LOAD
// ═══════════════════════════════════════════════════════════
function chooseRole(role) {
  State.role = role;
  if (role === "receiver") {
    showSection("sec-receiver-setup");
    setActiveNav('nav-panel-admin');
    startReceiverSetup();
  } else {
    senderResetForm();
    showSection("sec-sender-setup");
    setActiveNav('nav-anonim-sender');
  }
}

window.addEventListener("DOMContentLoaded", () => {
  const parts = window.location.pathname.split("/");
  const idx   = parts.indexOf("room");
  if (idx !== -1 && parts[idx+1]) {
    const rid = parts[idx+1].toUpperCase();
    State.role   = "sender";
    State.roomId = rid;
    showSection("sec-sender-setup");
    setActiveNav('nav-anonim-sender');
    
    requestAnimationFrame(() => {
      const input = document.getElementById("sender-room-input");
      if (input) {
        input.value = rid;
        senderLoadRoom();
      }
    });
  }
});

window.addEventListener("beforeunload", () => {
  if (State.role === "receiver" && State.roomId) {
    const url = `/api/room/${State.roomId}/close`;
    if (navigator.sendBeacon) {
      navigator.sendBeacon(url);
    } else {
      fetch(url, { method: "POST", keepalive: true });
    }
  }
});

// ═══════════════════════════════════════════════════════════
// RECEIVER SETUP & POLLING
// ═══════════════════════════════════════════════════════════
async function startReceiverSetup() {
  setStatus("receiver-setup-status", "info", "Membangkitkan kunci RSA-2048 OAEP...", true);

  try {
    const keys = await CryptoEngine.generateKeyPair();
    State.privatePem = keys.privatePem;
    State.publicPem  = keys.publicPem;

    // FIX PRODUCTION: Mengamankan Private Key
    sessionStorage.setItem(STORAGE_KEY, keys.privatePem);
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

    document.getElementById("display-room-id").textContent = data.room_id;
    const shareUrl = `${window.location.origin}/room/${data.room_id}`;
    document.getElementById("display-share-url").textContent = shareUrl;
    document.getElementById("display-share-url").href        = shareUrl;

    setStatus("receiver-setup-status", "success", "✅ Room berhasil dibuat!");
    showSection("sec-receiver-wait");
    startPolling();

  } catch (e) {
    setStatus("receiver-setup-status", "error", `❌ Error: ${e.message}`);
  }
}

function copyRoomId() {
  copyToClipboard(State.roomId, document.getElementById("btn-copy-room"));
}

function copyShareUrl() {
  copyToClipboard(`${window.location.origin}/room/${State.roomId}`, document.getElementById("btn-copy-url"));
}

function startPolling() {
  if (State.pollTimer) clearInterval(State.pollTimer);
  State.pollTimer = setInterval(pollForMessage, 4000);
  pollForMessage();
}

async function pollForMessage() {
  if (!State.roomId) return;
  try {
    const res  = await fetch(`/api/room/${State.roomId}/status`, { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json();
    if (data.has_message && !State.decrypting) {
      // Notify receiver: do not auto-decrypt. Show download button so user can
      // download the stego PNG and optionally extract later via Extractor menu.
      if (State.pollTimer) { clearInterval(State.pollTimer); State.pollTimer = null; }
      State.decrypting = false;
      setStatus("receiver-wait-status", "success", "📩 Pesan masuk! Klik 'Unduh Stego' untuk menyimpan gambar.");
      const btn = document.getElementById("btn-download-stego-receiver");
      if (btn) btn.style.display = "inline-block";
    }
  } catch (_) { }
}

// Receiver: download stego image (preview + save)
async function receiverDownloadStego() {
  if (!State.roomId) return setStatus("receiver-wait-status", "error", "Room tidak tersedia.");
  try {
    setStatus("receiver-wait-status", "info", "Mengunduh stego dari server...", true);
    const dlUrl = `/api/room/${State.roomId}/download?t=${Date.now()}`;
    const res = await fetch(dlUrl, { cache: "no-store" });
    if (!res.ok) throw new Error("Gagal mengunduh citra stego dari server");
    const blob = await res.blob();

    // Show preview on canvas
    const stegoData = await blobToImageData(blob);
    const canvas = document.getElementById("receiver-stego-canvas");
    canvas.style.display = "block";
    drawToCanvas(stegoData, "receiver-stego-canvas");

    // Offer file download
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `stego-${State.roomId || Date.now()}.png`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(link.href);

    setStatus("receiver-wait-status", "success", "✅ Stego berhasil diunduh. Buka menu Extractor untuk mengekstrak dan mendekripsi.");
  } catch (e) {
    setStatus("receiver-wait-status", "error", `❌ ${e.message}`);
    startPolling();
  }
}

// ═══════════════════════════════════════════════════════════
// RECEIVER DECRYPT
// ═══════════════════════════════════════════════════════════
async function receiverDownloadAndDecrypt() {
  try {
    const dlUrl = `/api/room/${State.roomId}/download?t=${Date.now()}`;
    const res = await fetch(dlUrl, { cache: "no-store" });
    if (!res.ok) throw new Error("Gagal mengunduh citra stego dari server");
    const blob     = await res.blob();
    const stegoData = await blobToImageData(blob);

    const previewCanvas = document.getElementById("receiver-stego-canvas");
    previewCanvas.style.display = "block";
    drawToCanvas(stegoData, "receiver-stego-canvas");

    setStatus("receiver-wait-status", "info", "Membaca header DCT...", true);
    setProgress("receiver", 10);
    await new Promise(r => setTimeout(r, 50));

    const headerBits  = DCTEngine.extractAll(stegoData, 32, null);
    const headerBytes = DCTEngine.bitsToBytes(headerBits);
    const totalBytes  = new DataView(headerBytes.buffer).getUint32(0, false);

    if (totalBytes === 0 || totalBytes > 500000)
      throw new Error("Header tidak valid. Pastikan citra tidak dikonversi ke JPEG setelah dikirim.");

    const totalBitsAvail  = Math.floor(stegoData.width  / DCTEngine.BLOCK) *
                            Math.floor(stegoData.height / DCTEngine.BLOCK);
    const totalBitsNeeded = 32 + totalBytes * 8;
    if (totalBitsNeeded > totalBitsAvail)
      throw new Error("Data overflow: ukuran citra tidak cukup untuk payload.");

    setStatus("receiver-wait-status", "info", `Mengekstrak ${totalBytes} byte ciphertext...`, true);
    setProgress("receiver", 20);
    await new Promise(r => setTimeout(r, 50));

    const allBits     = DCTEngine.extractAll(stegoData, totalBitsNeeded, pct => setProgress("receiver", 20 + pct * 0.65));
    const cipherBits  = allBits.slice(32);
    const cipherBytes = DCTEngine.bitsToBytes(cipherBits).slice(0, totalBytes);

    setProgress("receiver", 85);
    setStatus("receiver-wait-status", "info", "Mendekripsi RSA-2048 OAEP...", true);

    const privPem = State.privatePem || sessionStorage.getItem(STORAGE_KEY);
    if (!privPem)
      throw new Error("Private key hancur/tidak ditemukan. Pastikan tab tidak ditutup atau di-refresh.");

    const plaintext = await CryptoEngine.decrypt(privPem, cipherBytes);

    setProgress("receiver", 100);
    setStatus("receiver-wait-status", "success", "✅ Pesan berhasil didekripsi!");

    document.getElementById("decrypted-message").textContent = plaintext;

    try {
      await fetch(`/api/room/${State.roomId}/clear`, { method: "DELETE" });
    } catch(_) {}

    if (State.pollTimer) { clearInterval(State.pollTimer); State.pollTimer = null; }
    State.decrypting = false;

    showSection("sec-receiver-result");

  } catch (e) {
    setStatus("receiver-wait-status", "error", `❌ ${e.message}`);
    State.decrypting = false;
    startPolling();
  }
}

function receiverWaitAgain() {
  showSection("sec-receiver-wait");
  setStatus("receiver-wait-status", "info", "Menunggu pesan berikutnya...");
  startPolling();
}

// ═══════════════════════════════════════════════════════════
// SENDER SETUP & COMPOSE
// ═══════════════════════════════════════════════════════════
async function senderLoadRoom() {
  const input  = document.getElementById("sender-room-input");
  const roomId = (input ? input.value : "").trim().toUpperCase();

  if (!roomId || roomId.length < 4) {
    setStatus("sender-setup-status", "error", "❌ Masukkan Room ID yang valid (min 4 karakter)."); return;
  }

  setStatus("sender-setup-status", "info", "Menghubungkan ke room...", true);

  try {
    const res  = await fetch(`/api/room/${roomId}/pubkey`, { cache: "no-store" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Room tidak ditemukan atau sudah kadaluarsa");

    State.roomId    = data.room_id;
    State.publicPem = data.public_key;

    setStatus("sender-setup-status", "success", `✅ Terhubung ke room ${data.room_id}.`);
    document.getElementById("sender-room-display").textContent = data.room_id;
    showSection("sec-sender-compose");

  } catch (e) {
    setStatus("sender-setup-status", "error", `❌ ${e.message}`);
  }
}

function senderLoadCover(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    const img = new Image();
    img.onload = () => {
      // FIX PRODUCTION: FITUR "ANTI-BEGO" AUTO RESIZE V2 (Aman untuk Rasio Ekstrem)
      const MIN_SIZE = 400;  
      const MAX_SIZE = 1000; 

      let targetW = img.width;
      let targetH = img.height;

      if (targetW < MIN_SIZE || targetH < MIN_SIZE) {
        const scale = Math.max(MIN_SIZE / targetW, MIN_SIZE / targetH);
        targetW = Math.floor(targetW * scale);
        targetH = Math.floor(targetH * scale);
      }
      
      if (targetW > MAX_SIZE || targetH > MAX_SIZE) {
        const scale = Math.min(MAX_SIZE / targetW, MAX_SIZE / targetH);
        if (Math.floor(targetW * scale) >= MIN_SIZE && Math.floor(targetH * scale) >= MIN_SIZE) {
          targetW = Math.floor(targetW * scale);
          targetH = Math.floor(targetH * scale);
        } else {
          const safeScale = Math.max(MIN_SIZE / targetW, MIN_SIZE / targetH);
          targetW = Math.floor(targetW * safeScale);
          targetH = Math.floor(targetH * safeScale);
        }
      }

      const canvas = document.getElementById("cover-canvas");
      canvas.width = targetW; 
      canvas.height = targetH;
      
      canvas.getContext("2d").drawImage(img, 0, 0, targetW, targetH);
      State.coverData = canvas.getContext("2d").getImageData(0, 0, targetW, targetH);
      
      const cap = DCTEngine.capacity(targetW, targetH);
      document.getElementById("cover-preview-wrap").style.display = "flex";
      document.getElementById("cover-zone-label").textContent = `📁 ${file.name}`;
      setStatus("sender-compose-status", "info", `Dimensi disesuaikan: ${targetW}×${targetH}px · Kapasitas: ~${cap.usableBytes} byte ciphertext`);
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

async function senderSendMessage() {
  const msg = document.getElementById("sender-message").value.trim();
  if (!msg)             { setStatus("sender-compose-status", "error", "❌ Tulis pesan terlebih dahulu."); return; }
  if (!State.coverData) { setStatus("sender-compose-status", "error", "❌ Upload foto cover terlebih dahulu."); return; }
  if (!State.publicPem) { setStatus("sender-compose-status", "error", "❌ Belum terhubung ke room."); return; }

  const msgBytes = new TextEncoder().encode(msg);
  if (msgBytes.length > 190) {
    setStatus("sender-compose-status", "error", `❌ Pesan terlalu panjang (${msgBytes.length} byte). Maks 190 byte untuk RSA-2048 OAEP.`); return;
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
    payload.set(header, 0);
    payload.set(cipherBytes, 4);
    const bits = DCTEngine.bytesToBits(payload);

    const cap = DCTEngine.capacity(State.coverData.width, State.coverData.height);
    if (bits.length > cap.blocks)
      throw new Error(`Citra terlalu kecil! Butuh ${bits.length} bit, tersedia ${cap.blocks} bit.`);

    setStatus("sender-compose-status", "info", "📐 Menyisipkan ke domain DCT...", true);
    await new Promise(r => setTimeout(r, 50));
    State.stegoData = DCTEngine.embedAll(State.coverData, bits, pct => setProgress("sender", 15 + pct * 0.65));
    setProgress("sender", 82);

    const metrics = QualityMetrics.compute(State.coverData, State.stegoData);

    const sc = document.getElementById("stego-canvas");
    sc.style.opacity = "1";
    drawToCanvas(State.stegoData, "stego-canvas");
    document.getElementById("cover-preview-wrap").style.display = "flex";
    document.getElementById("btn-download-stego").style.display = "inline-block";

    setStatus("sender-compose-status", "info", "📤 Mengunggah citra stego ke server...", true);
    const blob = await new Promise(res => sc.toBlob(res, "image/png"));
    const form = new FormData();
    form.append("file", blob, "stego.png");

    const uploadRes  = await fetch(`/api/room/${State.roomId}/upload`, { method: "POST", body: form });
    const uploadData = await uploadRes.json();
    if (!uploadRes.ok) throw new Error(uploadData.error || "Gagal upload ke server");

    setProgress("sender", 100);
    setStatus("sender-compose-status", "success", `✅ Pesan terkirim! PSNR: ${metrics.psnr} dB · ${metrics.quality}`);
    btnSend.textContent = "✅ Terkirim";

    document.getElementById("btn-send-again").style.display = "inline-block";
    document.getElementById("sender-metrics").style.display = "block";
    document.getElementById("m-psnr").textContent = `${metrics.psnr} dB`;
    document.getElementById("m-mse").textContent  = metrics.mse;
    document.getElementById("m-qual").textContent = metrics.quality;
    document.getElementById("m-bits").textContent = `${bits.length} / ${cap.usableBits}`;

  } catch(e) {
    setStatus("sender-compose-status", "error", `❌ ${e.message}`);
    btnSend.disabled = false;
  }
}

// ═══════════════════════════════════════════════════════════
// SENDER RESET FORM
// ═══════════════════════════════════════════════════════════
function senderResetForm() {
  document.getElementById("sender-message").value = "";
  document.getElementById('msg-counter').textContent = "0/190";

  State.coverData = null;
  State.stegoData = null;
  
  const fileInput = document.querySelector('.upload-zone input[type="file"]');
  if (fileInput) fileInput.value = "";
  document.getElementById("cover-zone-label").textContent = "Meme receh/foto bebas, format otomatis disesuaikan";

  document.getElementById("cover-preview-wrap").style.display = "none";
  document.getElementById("btn-download-stego").style.display = "none";
  document.getElementById("btn-send-again").style.display = "none";
  document.getElementById("sender-metrics").style.display = "none";

  const bar = document.getElementById("sender-progress-bar");
  if (bar) bar.style.display = "none";
  
  const statusEl = document.getElementById("sender-compose-status");
  statusEl.className = "status"; 
  statusEl.innerHTML = "";

  const btnSend = document.getElementById("btn-send");
  btnSend.disabled = false;
  btnSend.textContent = "🔒 Enkripsi & Kirim";
}

// ═══════════════════════════════════════════════════════════
// IMAGE HELPERS
// ═══════════════════════════════════════════════════════════
function blobToImageData(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.width; canvas.height = img.height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      resolve(ctx.getImageData(0, 0, img.width, img.height));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Gagal load gambar")); };
    img.src = url;
  });
}

function drawToCanvas(imageData, canvasId) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  canvas.width  = imageData.width;
  canvas.height = imageData.height;
  
  canvas.style.maxWidth = "100%";
  canvas.style.height = "auto";
  
  canvas.getContext("2d").putImageData(imageData, 0, 0);
}

// Extractor: user uploads a local stego PNG and extracts + decrypts it manually
async function extractorUploadAndExtract(event) {
  try {
    const file = (event.target && event.target.files && event.target.files[0]) || event;
    if (!file) return setStatus("extractor-status", "error", "Tidak ada file yang dipilih.");

    setStatus("extractor-status", "info", "Membaca file stego...", true);
    setProgress("extractor", 5);

    const blob = file instanceof Blob ? file : file.file;
    const stegoData = await blobToImageData(blob);

    document.getElementById("extractor-stego-canvas").style.display = "block";
    drawToCanvas(stegoData, "extractor-stego-canvas");

    setStatus("extractor-status", "info", "Mengekstrak header DCT...", true);
    setProgress("extractor", 15);

    const headerBits = DCTEngine.extractAll(stegoData, 32, null);
    const headerBytes = DCTEngine.bitsToBytes(headerBits);
    const totalBytes = new DataView(headerBytes.buffer).getUint32(0, false);
    if (totalBytes === 0 || totalBytes > 500000) throw new Error("Header tidak valid atau payload terlalu besar.");

    setStatus("extractor-status", "info", `Mengekstrak ${totalBytes} byte ciphertext...`, true);
    setProgress("extractor", 30);

    const totalBitsNeeded = 32 + totalBytes * 8;
    const allBits = DCTEngine.extractAll(stegoData, totalBitsNeeded, pct => setProgress("extractor", 30 + pct * 0.6));
    const cipherBits = allBits.slice(32);
    const cipherBytes = DCTEngine.bitsToBytes(cipherBits).slice(0, totalBytes);

    setProgress("extractor", 85);
    setStatus("extractor-status", "info", "Mendekripsi RSA-2048 OAEP...", true);

    const privPem = State.privatePem || sessionStorage.getItem(STORAGE_KEY);
    if (!privPem) throw new Error("Private key tidak ditemukan. Pastikan kunci tersedia di sesi browser ini.");

    const plaintext = await CryptoEngine.decrypt(privPem, cipherBytes);

    setProgress("extractor", 100);
    setStatus("extractor-status", "success", "✅ Pesan berhasil diekstrak & didekripsi.");

    document.getElementById("extractor-decrypted").textContent = plaintext;
    document.getElementById("decrypted-message").textContent = plaintext;

    // Clear server copy
    try { await fetch(`/api/room/${State.roomId}/clear`, { method: "DELETE" }); } catch(_) {}

  } catch (e) {
    setStatus("extractor-status", "error", `❌ ${e.message}`);
    setProgress("extractor", 0);
  }
}