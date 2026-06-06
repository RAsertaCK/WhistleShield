# WhistleShield

WhistleShield adalah aplikasi web yang dibuat untuk komunikasi rahasia antara whistleblower dan admin.
Web ini menggabungkan enkripsi end-to-end RSA-2048 OAEP dengan steganografi DCT pada gambar PNG.

## Apa yang dilakukan web ini
- Receiver (admin) membuat room baru di browser.
- Browser receiver membuat pasangan kunci RSA-2048.
- Receiver membagikan `Room ID` kepada pengirim.
- Pengirim memasukkan `Room ID` dan mengirim pesan rahasia.
- Pesan rahasia dienkripsi dengan public key receiver di browser pengirim.
- Ciphertext disisipkan ke dalam gambar PNG sebagai stego image.
- Server menyimpan file PNG stego sementara dan memberi tanda bahwa room punya pesan.
- Receiver dapat mengunduh PNG stego dan mendekripsi pesan menggunakan private key yang tetap berada di browser.

## Fitur utama
- Enkripsi RSA-2048 OAEP end-to-end di sisi klien.
- Private key tidak pernah dikirim ke server.
- Steganografi DCT pada PNG untuk menyembunyikan pesan di dalam gambar.
- Room sederhana dengan `Room ID` untuk komunikasi sender ⇄ receiver.
- Pemeriksaan status room secara berkala.
- Upload/download stego PNG melalui API.
- Pembersihan otomatis room dan file lama.
- Tampilan responsive dengan interface sidebar.

## Cara kerja singkat
1. Receiver klik setup room.
2. Browser receiver membuat public/private key.
3. Public key dikirim ke server untuk membuat `Room ID`.
4. Sender memasukkan `Room ID` dan teks pesan.
5. Browser sender mengenkripsi pesan dengan public key.
6. Browser sender menyisipkan ciphertext ke file PNG.
7. Sender upload file PNG stego ke server.
8. Receiver mendeteksi pesan baru dan mengunduh file.
9. Receiver mendekripsi pesan menggunakan private key dari browser.

## Struktur folder penting
- `app.py` - server Flask utama.
- `requirements.txt` - dependency Python (Flask, dan lain-lain jika diperlukan).
- `rooms_db.json` - penyimpanan state room.
- `uploads/` - tempat simpan file PNG stego yang diupload.
- `Icon/` - asset gambar icon receiver / sender.
- `static/`
  - `css/`
    - `bootstrap.min.css`
    - `darkpan.css`
    - `style.css`
  - `js/`
    - `app.js`
    - `crypto.js`
    - `darkpan.js`
- `templates/`
  - `index.html`

## Struktur
app.py
Procfile
README.md
requirements.txt
rooms_db.json
Icon/
static/
  css/
    bootstrap.min.css
    darkpan.css
    style.css
  js/
    app.js
    crypto.js
    darkpan.js
templates/
  index.html
uploads/