# PotPintar — Smart Plant Care Pot

Sistem pot pintar berbasis Internet of Things (IoT) untuk pemantauan kondisi lingkungan tanaman secara *real-time* dan otomatisasi penyiraman berbasis *cloud decision*.

---

## Identitas Kelompok

**Praktikum Internet of Things (IoT) — Kelas IF-F**  
**Program Studi Informatika, UPN "Veteran" Yogyakarta**  
Tahun Ajaran 2026/2027

| No | Nama Lengkap | NIM |
| :---: | :--- | :---: |
| 1 | **Azarya Shalom Widura** | 123240232 |
| 2 | **Iva Rohmanto** | 123240252 |
| 3 | **Muhammad Fatkhan Kurniadi** | 123240253 |
| 4 | **Ajrun Ramadhan** | 123240254 |

---

## Deskripsi Singkat Proyek

**PotPintar** adalah solusi perawatan tanaman otomatis berbasis IoT yang mengintegrasikan mikrokontroler **ESP32**, protokol komunikasi **MQTT**, backend **Node.js (Express)**, basis data **MySQL**, dan antarmuka web interaktif.

Sistem ini dirancang untuk menjaga kelembapan tanah optimal secara mandiri sekaligus memberikan kemudahan pemantauan dan kontrol bagi pemilik tanaman dari mana saja melalui web dashboard.

### Fitur Utama:
1. **Monitoring Real-Time:** Memantau kelembapan tanah (*soil moisture*) dan intensitas cahaya (*LDR*) secara langsung melalui web dan layar LCD 16x2 fisik.
2. **Otomatisasi 3 Kriteria (Cloud & Local):**
   - **Batas Kering (*Dry Threshold*):** Pompa otomatis aktif jika kelembapan tanah turun di bawah batas yang ditentukan pengguna.
   - **Batas Lembab (*Wet Threshold*):** Pompa berhenti menyiram saat tanah mencapai batas kelembapan target.
   - **Proteksi Malam (*Light Threshold*):** Pompa tidak akan menyiram pada malam hari (gelap) untuk mencegah pembusukan akar dan jamur akibat kelembapan berlebih saat tanaman beristirahat.
3. **Kendali Mode Fleksibel:** Mendukung pergantian mode kerja secara instan antara **AUTO** dan **MANUAL** (buka/tutup pompa langsung dari website).
4. **Riwayat & Grafik Historis:** Data sensor dan log penyiraman tersimpan secara persisten di MySQL dan divisualisasikan dalam bentuk grafik riwayat.
5. **Autentikasi & Keamanan:** Dashboard web dilengkapi sistem login dan registrasi dengan enkripsi password (bcrypt) dan token JWT.

---

## Teknologi yang Digunakan

- **Hardware:** ESP32 Dev Module, Capacitive/Analog Soil Moisture Sensor, LDR Light Sensor, 5V Relay Module, Water Pump, LCD 16x2 I2C.
- **Komunikasi:** MQTT (HiveMQ Broker), HTTP/REST API, SSE (Server-Sent Events) untuk pembaruan *real-time*.
- **Backend:** Node.js, Express.js, MySQL2, MQTT.js, JWT, Bcrypt.
- **Frontend:** HTML5, CSS3, JavaScript (Vanilla), Chart.js.
