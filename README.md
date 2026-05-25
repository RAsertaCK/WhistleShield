# WhistleShield Cryptography (Perubahan)

## Ringkasan Perubahan
README ini menjelaskan perubahan yang telah dilakukan pada kode di `Cryptography/`.

### Server-side
- `app.py`
  - Menambahkan file-based persistence ke `rooms_db.json` sehingga room state tidak hilang saat server restart.
  - Menambahkan `DB_LOCK` dan fungsi `_save_db()` / `_load_db()` untuk mengelola penulisan dan pembacaan data secara aman.
  - Menambahkan cleanup zombie session otomatis dengan `IDLE_TTL` dan thread background `_cleanup_loop()`.
  - Menambahkan endpoint baru `/api/room/<room_id>/close` untuk membersihkan room ketika receiver menutup tab.
  - Menambahkan header cache untuk asset statis (`Cache-Control: public, max-age=31536000, immutable`).
  - Menambahkan header HSTS (`Strict-Transport-Security`) untuk HTTPS.
  - Mengubah server produksi lokal agar berjalan dengan `ssl_context="adhoc"` sehingga server siap HTTPS otomatis.
  - Menambahkan loading `static_version` ke template untuk cache busting asset statis.

### UI-side
- `templates/index.html`
  - Menambahkan `url_for(..., v=static_version)` untuk `style.css`, `crypto.js`, dan `app.js` sehingga browser memuat versi baru saat server restart.
  - Memperbaiki `viewport` menjadi `width=device-width, initial-scale=1.0` agar UI responsif di perangkat mobile.

- `static/js/app.js`
  - Menambahkan listener `beforeunload` untuk mengirim beacon ke endpoint penutupan room ketika receiver menutup tab.
  - Menambahkan `senderResetForm()` dipanggil saat memilih peran sender atau kembali ke setup sender.
  - Menambahkan `cache: "no-store"` pada beberapa request `fetch()` penting untuk menghindari cache browser stale.
  - Memastikan status form dan tombol kembali reset dengan benar.

### Responsivitas dan UI
- `static/css/style.css`
  - Mengoptimalkan tampilan mobile dengan aturan media query `@media (max-width: 900px)` dan `@media (max-width: 600px)`.
  - Menambahkan perbaikan layout untuk tombol, preview image, dan grid metrik agar lebih adaptif pada layar lebih kecil.

## Cara Menjalankan
1. Masuk ke folder `Cryptography`.
2. Pastikan environment Python sudah dipasang dan dependency Flask tersedia.
3. Jalankan server dengan:
   ```bash
   python app.py
   ```
4. Akses aplikasi melalui `https://localhost:5000`.

## Catatan
- HTTPS lokal menggunakan sertifikat adhoc Flask. Browser mungkin memperlihatkan warning karena sertifikat tidak ditandatangani CA.
- `rooms_db.json` akan dibuat otomatis di folder `Cryptography/`.
- Room yang tidak aktif akan dihapus otomatis setelah `IDLE_TTL`.
