# PotPintar v2 — MySQL, Login, dan Ambang Kelembapan Mandiri

Pengembangan dari `PotPintar_MQTT_Website.zip`. Desain dashboard lama dipertahankan; yang berubah adalah sumber data (sekarang backend + MySQL) dan fitur baru.

## Struktur dan penempatan file

```
PotPintar/
├── .env.example            (BARU)  salin menjadi .env lalu isi
├── database/potpintar_db.sql (BARU) skema + perangkat smartplant_azarya_01
├── backend/                 (BARU)  Node.js + Express
│   ├── server.js
│   ├── package.json
│   ├── config/database.js
│   ├── controllers/authController.js, deviceController.js
│   ├── routes/auth.js, devices.js
│   ├── middleware/auth.js
│   └── services/mqtt.js, realtime.js
├── frontend/
│   ├── index.html           (DIGANTI) dashboard lama + pengaturan, riwayat, grafik cahaya
│   ├── app.js               (DIGANTI) tidak lagi memakai MQTT.js di browser
│   ├── style.css            (DIPERTAHANKAN + tambahan di akhir file)
│   ├── login.html, register.html, auth.js (BARU)
└── esp32/
    ├── sketch.ino           (DIGANTI) ganti isi sketch lama
    └── libraries.txt
```

## Bug pada kode lama (sudah diperbaiki)

1. **Topic dan payload tidak cocok.** Website memakai `potpintar/demo-ajrun-7f3c9a/telemetry` (JSON `humidity`, `light`, `pump`), ESP32 memakai `smartplant_azarya_01/soil|light|pump|mode|control` (teks biasa). Keduanya tidak pernah bisa saling terhubung. Sekarang semuanya memakai `potpintar/smartplant_azarya_01/{telemetry,config,status,command}` dengan JSON.
2. **ESP32 subscribe ke topic yang ia publish sendiri** (`/mode`), sehingga menerima echo pesannya sendiri.
3. **Pompa otomatis berhenti saat internet putus.** `setupWiFi()` dan `reconnectMQTT()` adalah `while` yang memblokir `loop()`. Sekarang koneksi di-retry tanpa memblokir dan kontrol pompa jalan lokal.
4. **Ambang `const`** (tidak bisa diubah) → variabel yang disimpan di Preferences.
5. **Grafik memakai array JavaScript sementara** (hilang saat refresh) → dibaca dari MySQL.
6. **Browser terhubung langsung ke broker publik tanpa autentikasi**, siapa pun bisa mengirim perintah ke pompa → browser kini hanya bicara ke backend yang memakai login.
7. Teks lama menyebut ambang 35% dan batas manual 10 detik, padahal kode memakai 60% dan tidak ada batas waktu → teks disesuaikan.
8. Pin LED: README lama menyebut GPIO 27, sketch memakai GPIO 25. Saya mempertahankan **GPIO 25** (sesuai sketch).
9. Sketch lama berisi password Wi-Fi asli. Di versi baru diganti placeholder. Jika ZIP lama pernah dibagikan, sebaiknya ganti password Wi-Fi tersebut.

## 1. Dependency

- Node.js 18+ (disarankan 20/22), MySQL 8+ (atau MariaDB 10.5+).
- Backend (`npm install` di folder `backend`): `express`, `mysql2`, `mqtt`, `bcryptjs`, `jsonwebtoken`, `cookie-parser`, `helmet`, `express-rate-limit`, `dotenv`.
- ESP32 (Arduino IDE, board "ESP32 Dev Module"): `PubSubClient`, `ArduinoJson` **versi 7.x**, `LiquidCrystal I2C`. `Preferences` bawaan core ESP32.

## 2. MySQL

```sql
-- sebagai root:  mysql -u root -p
CREATE USER 'potpintar'@'localhost' IDENTIFIED BY 'PASSWORD_KUAT_ANDA';
```
```bash
mysql -u root -p < database/potpintar_db.sql
```
```sql
GRANT SELECT, INSERT, UPDATE, DELETE ON potpintar_db.* TO 'potpintar'@'localhost';
FLUSH PRIVILEGES;
```

## 3. Menjalankan backend

```bash
cp .env.example .env        # Windows: copy .env.example .env
# isi JWT_SECRET, DB_PASSWORD, DEVICE_OWNER_EMAIL (opsional), MQTT_URL
cd backend
npm install
npm start
```
Buka `http://localhost:3000`. Log yang benar: `[DB] terhubung ke MySQL`, `[MQTT] terhubung ...`.

Perangkat `smartplant_azarya_01` dibuat tanpa pemilik. Ada dua cara memilikinya: isi `DEVICE_OWNER_EMAIL` di `.env` (akun dengan email itu otomatis memilikinya saat mendaftar), atau daftar lalu klik "Tambahkan" di dashboard dan masukkan kode perangkat. Akun lain tidak bisa mengklaim perangkat yang sudah dimiliki. Jika server dibuka ke internet, isi `DEVICE_OWNER_EMAIL` dan set `ALLOW_REGISTRATION=false` setelah akun Anda dibuat.

## 4. Konfigurasi MQTT

| Topic | Arah | Isi | QoS / retain |
|---|---|---|---|
| `potpintar/<id>/telemetry` | ESP32 → backend | `{"device_id","soil_moisture","light_intensity","pump_status","mode","dry_threshold","wet_threshold"}` | 0 / tidak |
| `potpintar/<id>/status` | ESP32 → backend | `{"device_id","status":"online"\|"offline"}` (offline = LWT) | 0 (LWT 1) / retained |
| `potpintar/<id>/config` | backend → ESP32 | `{"device_id","dry_threshold":40,"wet_threshold":70}` | 1 / **retained** |
| `potpintar/<id>/command` | backend → ESP32 | `{"device_id","mode":"MANUAL","pump":"ON"}` | 1 / tidak |

Config di-retain agar ESP32 yang menyala/menyambung ulang langsung menerima ambang terbaru. Command tidak di-retain agar perintah lama tidak dieksekusi ulang. Backend juga mengirim ulang semua config saat start dan saat ESP32 melapor `online`.

Broker `broker.hivemq.com` bersifat **publik**: siapa pun yang menebak topic dapat membaca atau menulis. Untuk perangkat nyata gunakan broker privat dengan username/password (isi `MQTT_USERNAME/PASSWORD` di `.env` dan `MQTT_USER/MQTT_PASS` di sketch), idealnya TLS.

## 5. Menghubungkan ESP32

1. Buka `esp32/sketch.ino`, isi `WIFI_SSID`, `WIFI_PASSWORD`, dan pastikan `MQTT_SERVER` sama dengan broker di `.env`.
2. Upload. Serial Monitor (115200) menampilkan "Ambang dimuat dari Preferences: kering=40.0 | lembab=70.0" saat pertama kali.
3. Setelah "MQTT Terhubung", dashboard menampilkan **ESP32 online** dan data masuk tiap 10 detik.
4. Logika otomatis memakai histeresis: pompa menyala saat kelembapan < batas kering (mis. 40%), dan terus menyiram hingga mencapai batas lembab (mis. 70%).

## 6. Pengujian

Status jujur: saya hanya dapat memeriksa **sintaks** kode Node.js (`node --check`). MySQL, broker MQTT, `npm install`, dan kompilasi Arduino tidak tersedia di lingkungan saya, jadi **belum ada satu pun pengujian fungsional yang dijalankan**. Semua baris di bawah harus Anda jalankan.

| No. | Pengujian | Cara | Status |
|---|---|---|---|
| 1 | Registrasi | Buka `/register.html`, daftar; `SELECT id,email,LEFT(password_hash,7) FROM users;` (hash diawali `$2a$12$`) | Belum diuji |
| 2 | Login | Masuk di `/login.html` → dashboard | Belum diuji |
| 3 | Ambang Awal (40% & 70%) | Periksa nilai awal di dashboard dan database: `SELECT dry_threshold, wet_threshold FROM devices;` | Belum diuji |
| 4 | Ubah ke 35% & 65% | Simpan batas kering 35 dan batas lembab 65; Serial Monitor: "Ambang baru disimpan: kering=35.0 | lembab=65.0"; dashboard menampilkan batas aktif di ESP32 | Belum diuji (butuh ESP32/Wokwi) |
| 5 | Histeresis Pompa | Kelembapan < 35% → Pompa ON. Kelembapan naik ke 50% (di antara 35% & 65%) → Pompa tetap ON menyiram. Kelembapan mencapai 65% → Pompa OFF. | Belum diuji |
| 6 | Validasi Batas | Coba simpan batas kering lebih besar/sama dengan batas lembab (mis. kering 70, lembab 40) → pesan error "Batas kering harus lebih kecil dari batas lembab" muncul | Belum diuji |
| 7 | Telemetri masuk MySQL | `SELECT * FROM sensor_logs ORDER BY id DESC LIMIT 5;` | Belum diuji |
| 8 | Riwayat | Tabel "Pembacaan terbaru" dan grafik terisi dengan garis batas kering dan batas lembab | Belum diuji |
| 9 | Wi-Fi terputus | Matikan router; Serial Monitor tetap mencetak baris sensor dan pompa mengikuti histeresis secara lokal | Perlu uji fisik |
| 10 | ESP32 restart | Ubah batas, reset board, Serial Monitor harus memuat nilai yang sama dari Preferences | Perlu uji fisik |

## Yang belum dikerjakan / catatan

- **Fitur kalibrasi kering/basah dari dashboard tidak dibuat.** Nilai `SOIL_DRY_RAW=3000` dan `SOIL_WET_RAW=1300` tetap konstanta di sketch (tidak saya ubah). Kalibrasi sebaiknya Anda ukur pada sensor dan tanah Anda sendiri. Dashboard menyebut bahwa nilai kelembapan adalah persentase hasil konversi analog, bukan VWC. Saya tidak memuat klaim isi jurnal atau rekomendasi angka dari jurnal karena tidak memverifikasi isinya.
- Sketch belum dikompilasi. Jika ada error kompilasi, kirim pesan error-nya.
- `mqtt.connect()` pada ESP32 dapat memblokir beberapa detik saat broker tidak terjangkau. Retry dibatasi tiap 8 detik dan kontrol otomatis tetap berjalan di antaranya, tetapi tidak sempurna "tanpa jeda".
- Mode (AUTO/MANUAL) tidak disimpan di Preferences; setelah restart ESP32 selalu AUTO (lebih aman untuk pompa).
- Telemetri disimpan setiap 10 detik (~8.600 baris/hari). Grafik memakai rata-rata per bucket (5 menit / 1 jam / 6 jam), tidak ada penghapusan data lama otomatis.
- Untuk akses internet gunakan HTTPS (reverse proxy) dan set `COOKIE_SECURE=true`.
