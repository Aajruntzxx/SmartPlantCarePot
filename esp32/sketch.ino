/*
 * PotPintar - Smart Plant Care Pot (ESP32)
 *
 * Library (Library Manager / libraries.txt Wokwi):
 *   - PubSubClient
 *   - ArduinoJson (versi 7.x)
 *   - LiquidCrystal I2C
 *   (Preferences, WiFi, Wire sudah bawaan core ESP32)
 *
 * Topic MQTT (harus sama dengan backend):
 *   potpintar/smartplant_azarya_01/telemetry  ESP32 -> backend (JSON)
 *   potpintar/smartplant_azarya_01/status     ESP32 -> backend (online/offline, retained + LWT)
 *   potpintar/smartplant_azarya_01/config     backend -> ESP32 (soil_threshold, retained)
 *   potpintar/smartplant_azarya_01/command    backend -> ESP32 (mode / pump)
 *
 * Full Cloud Decision: Keputusan pompa otomatis diatur oleh Cloud Backend.
 * Keterkaitan LDR & Soil: Malam hari (cahaya < lightThreshold) tidak menyiram meski tanah kering.
 * Relay: HIGH = OFF, LOW = ON.
 */

#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <Preferences.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>

// ==================================================
// 1. KONFIGURASI WIFI & MQTT (UBAH DI SINI)
// ==================================================

// Masukkan Nama Wi-Fi (SSID) dan Kata Sandi (Password) di sini:
const char* WIFI_SSID     = "KONTRAKIN";         // Ganti dengan nama Wi-Fi Anda
const char* WIFI_PASSWORD = "Bismillahselalu";   // Ganti dengan password Wi-Fi Anda

// Harus broker yang sama dengan MQTT_URL di file .env backend.
const char* MQTT_SERVER = "broker.hivemq.com";
const int   MQTT_PORT   = 1883;
const char* MQTT_USER   = nullptr;  // isi jika broker memakai autentikasi
const char* MQTT_PASS   = nullptr;

const char* DEVICE_ID = "smartplant_azarya_01";

String topicTelemetry, topicStatus, topicConfig, topicCommand;

// ==================================================
// 2. PIN & HARDWARE
// ==================================================

#define SOIL_PIN  34
#define LDR_PIN   35
#define RELAY_PIN 26
#define LED_PIN   25
#define LCD_SDA   21
#define LCD_SCL   22

LiquidCrystal_I2C lcd(0x27, 16, 2);

// Konfigurasi Trigger Relay Fisik:
// Modul relay berjenis Active LOW (Sinyal LOW = Relay ON / Menyiram, Sinyal HIGH = Relay OFF / Standby):
#define RELAY_TRIGGER_ACTIVE_HIGH false

#if RELAY_TRIGGER_ACTIVE_HIGH
  #define RELAY_ON  HIGH
  #define RELAY_OFF LOW
#else
  #define RELAY_ON  LOW
  #define RELAY_OFF HIGH
#endif

// ==================================================
// 3. KALIBRASI SENSOR (tidak diubah dari kode lama)
// ==================================================

// Kalibrasi Sensor:
// Capacitive v1.2 / Analog Soil Sensor:
// - Udara kering: ~3200 - 3600 ADC raw
// - Air / basah: ~1100 - 1400 ADC raw
const int SOIL_DRY_RAW   = 3500; // dinaikkan dari 3000 agar nilai udara (~3200-3400) tidak langsung mentok di 0%
const int SOIL_WET_RAW   = 1200; // nilai saat tanah sangat basah / dicelup air

// Kalibrasi Sensor Cahaya (LDR):
// Modul LDR pengguna bertipe Active-Low (Disorot cahaya ADC turun, Gelap ADC naik):
// - Terang / Disorot Senter = Nilai ADC Rendah (~300 - 600 -> 100% Terang/Siang)
// - Gelap / Ditutup Tangan  = Nilai ADC Tinggi (~3200 - 3800 -> 0% Gelap/Malam)
#define LDR_BRIGHT_IS_HIGH false

#if LDR_BRIGHT_IS_HIGH
  const int LDR_DARK_RAW   = 500;   // Gelap / Malam = ADC rendah (~500 -> 0%)
  const int LDR_BRIGHT_RAW = 3500;  // Terang / Siang = ADC tinggi (~3500 -> 100%)
#else
  const int LDR_DARK_RAW   = 3600;  // Gelap / Ditutup Tangan (ADC tinggi -> 0% Malam)
  const int LDR_BRIGHT_RAW = 400;   // Disorot Cahaya/Senter (ADC rendah -> 100% Terang)
#endif

// ==================================================
// 4. PENGATURAN SISTEM (3 Kriteria Ambang Sensor Custom User)
// ==================================================

const float DEFAULT_DRY_THRESHOLD   = 40.0;   // Kriteria 1: Batas Kering (Mulai Menyiram)
const float DEFAULT_WET_THRESHOLD   = 70.0;   // Kriteria 2: Batas Lembab (Berhenti Menyiram)
const float DEFAULT_LIGHT_THRESHOLD = 50.0;   // Kriteria 3: Batas Cahaya (Kategori Terang/Siang)

float dryThreshold   = DEFAULT_DRY_THRESHOLD;   // diubah dari website, disimpan di Preferences
float wetThreshold   = DEFAULT_WET_THRESHOLD;
float lightThreshold = DEFAULT_LIGHT_THRESHOLD;

const unsigned long SENSOR_INTERVAL     = 1000;   // baca sensor + perbarui LCD setiap 1 detik (lancar & tanpa delay)
const unsigned long PUBLISH_INTERVAL    = 2000;   // kirim telemetri rutin setiap 2 detik (responsif)
const unsigned long WIFI_RETRY_INTERVAL = 15000;
const unsigned long MQTT_RETRY_INTERVAL = 8000;

unsigned long lastSensorRead = 0;
unsigned long lastPublish    = 0;
unsigned long lastWifiTry    = 0;
unsigned long lastMqttTry    = 0;

int soilRaw = 0, lightRaw = 0;
int soilMoisture = 0, lightIntensity = 0;
int lastReportedSoil = -999;
int lastReportedLight = -999;

bool pumpStatus = false;
String systemMode = "AUTO";   // "AUTO" atau "MANUAL"

WiFiClient espClient;
PubSubClient mqtt(espClient);
Preferences prefs;

// ==================================================
// PROTOTYPE FUNGSI (Forward Declarations)
// ==================================================
void updateLCD();
void applyAutoRule();
void publishTelemetry();
void publishStatus(const char* status);
void readSensors();
void setPump(bool state);
void saveThresholds(float dry, float wet, float light);
void loadThresholds();

// ==================================================
// 5. KONTROL POMPA & ANALISIS KONDISI TANAMAN
// ==================================================

// Matriks Hasil Analisis Kondisi & Kebutuhan Tanaman
const char* getPlantAnalysis(int soil, int light, float dryThr, float lightThr) {
  bool isMalam = (float)light < lightThr;
  bool isKering = (float)soil < dryThr;

  if (isMalam) {
    if (isKering) {
      // Aturan 4: Jika malam hari dan tanah kering, tampilkan status ini
      return "TANAH KERING - PENYIRAMAN DITUNDA";
    } else {
      return "Malam hari: kelembapan terjaga, tanaman beristirahat";
    }
  } else {
    // Siang hari
    if (isKering) {
      return "Siang hari: tanah kering di bawah ambang, menyiram otomatis";
    } else {
      return "Siang hari: kelembapan mencukupi di atas ambang, pompa standby";
    }
  }
}

void setPump(bool state) {
  int relayVal = state ? RELAY_ON : RELAY_OFF;
  digitalWrite(RELAY_PIN, relayVal);
  digitalWrite(LED_PIN, state ? HIGH : LOW);
  if (pumpStatus != state) {
    pumpStatus = state;
    Serial.printf("[KONTROL POMPA] Status Pompa: %s -> Pin Relay %d diset ke: %s\n",
                  state ? "MENYALA (ON)" : "MATI (OFF)",
                  RELAY_PIN,
                  relayVal == HIGH ? "HIGH (3.3V)" : "LOW (0V)");
    // Jeda 20ms agar percikan kontak relay mereda sebelum mengirim data ke LCD & MQTT
    delay(20);
    updateLCD();
    publishTelemetry();  // Langsung kirim ke website seketika saat status pompa berubah
  }
}

// Logika Penyiraman Otomatis Memenuhi 3 Kriteria Custom User:
// 1. Kriteria Cahaya (light_threshold): Pompa HANYA boleh menyiram saat Siang/Terang (cahaya >= lightThreshold).
//    Jika Malam/Gelap (cahaya < lightThreshold), pompa SELALU OFF meskipun tanah kering!
// 2. Kriteria Batas Kering (dry_threshold): Pompa MULAI MENYALA saat tanah kering (soil < dryThreshold).
// 3. Kriteria Batas Lembab (wet_threshold): Pompa BERHENTI MENYIRAM saat tanah cukup basah (soil >= wetThreshold).
// Di antara dryThreshold dan wetThreshold: sistem mempertahankan status pompa (histeresis).
void applyAutoRule() {
  if (systemMode != "AUTO") return;

  // Evaluasi Kriteria 3: Ambang Batas Cahaya (Siang vs Malam)
  bool isMalam = (float)lightIntensity < lightThreshold;

  if (isMalam) {
    // Kriteria 3: Malam Hari -> Pompa WAJIB MATI
    if (pumpStatus) {
      Serial.printf("[AUTO RULE] Cahaya Redup/Malam (%d%% < Ambang=%.1f%%) -> Pompa Dimatikan.\n",
                    lightIntensity, lightThreshold);
      setPump(false);
    }
    return; // Proteksi malam: hentikan eksekusi, pompa dilarang menyiram
  }

  // Evaluasi Kriteria 1 & 2: Siang Hari (cahaya >= lightThreshold)
  if ((float)soilMoisture < dryThreshold) {
    // Kriteria 1: Tanah Kering di bawah batas user -> Nyalakan Pompa
    if (!pumpStatus) {
      Serial.printf("[AUTO RULE] MEMENUHI 3 KRITERIA: Siang (%d%% >= %.1f%%) & Tanah Kering (%d%% < %.1f%%) -> Pompa MENYALA (ON).\n",
                    lightIntensity, lightThreshold, soilMoisture, dryThreshold);
    }
    setPump(true);
  } else if ((float)soilMoisture >= wetThreshold) {
    // Kriteria 2: Tanah Lembab mencapai/melebihi batas user -> Matikan Pompa
    if (pumpStatus) {
      Serial.printf("[AUTO RULE] TARGET TERCAPAI: Tanah Lembab (%d%% >= Target=%.1f%%) -> Pompa MATI (OFF).\n",
                    soilMoisture, wetThreshold);
    }
    setPump(false);
  }
}

// ==================================================
// 6. PREFERENCES (ambang tersimpan permanen)
// ==================================================

void loadThresholds() {
  prefs.begin("potpintar", true);  // read-only
  dryThreshold   = prefs.getFloat("dry_thr", DEFAULT_DRY_THRESHOLD);
  wetThreshold   = prefs.getFloat("wet_thr", DEFAULT_WET_THRESHOLD);
  lightThreshold = prefs.getFloat("light_thr", DEFAULT_LIGHT_THRESHOLD);
  // fallback jika masih ada konfigurasi lama
  if (!prefs.isKey("dry_thr") && prefs.isKey("thr")) {
    dryThreshold = prefs.getFloat("thr", DEFAULT_DRY_THRESHOLD);
  }
  prefs.end();

  if (isnan(dryThreshold) || dryThreshold < 0 || dryThreshold > 100) {
    dryThreshold = DEFAULT_DRY_THRESHOLD;
  }
  if (isnan(wetThreshold) || wetThreshold < 0 || wetThreshold > 100) {
    wetThreshold = DEFAULT_WET_THRESHOLD;
  }
  if (isnan(lightThreshold) || lightThreshold < 0 || lightThreshold > 100) {
    lightThreshold = DEFAULT_LIGHT_THRESHOLD;
  }
  if (dryThreshold >= wetThreshold) {
    dryThreshold = DEFAULT_DRY_THRESHOLD;
    wetThreshold = DEFAULT_WET_THRESHOLD;
  }
  Serial.printf("Ambang dimuat dari Preferences: kering=%.1f | lembab=%.1f | cahaya=%.1f\n",
                dryThreshold, wetThreshold, lightThreshold);
}

void saveThresholds(float dry, float wet, float light) {
  prefs.begin("potpintar", false);
  prefs.putFloat("dry_thr", dry);
  prefs.putFloat("wet_thr", wet);
  prefs.putFloat("light_thr", light);
  prefs.end();
}

// ==================================================
// 7. PUBLISH MQTT
// ==================================================

void publishStatus(const char* status) {
  if (!mqtt.connected()) return;
  char buf[128];
  snprintf(buf, sizeof(buf), "{\"device_id\":\"%s\",\"status\":\"%s\"}", DEVICE_ID, status);
  mqtt.publish(topicStatus.c_str(), buf, true);  // retained
}

void publishTelemetry() {
  if (!mqtt.connected()) return;

  JsonDocument doc;
  doc["device_id"]       = DEVICE_ID;
  doc["soil_moisture"]   = soilMoisture;
  doc["light_intensity"] = lightIntensity;
  doc["pump_status"]     = pumpStatus ? "ON" : "OFF";
  doc["mode"]            = systemMode;
  doc["dry_threshold"]   = dryThreshold;
  doc["wet_threshold"]   = wetThreshold;
  doc["light_threshold"] = lightThreshold;
  doc["soil_threshold"]  = dryThreshold;  // kompatibilitas dengan pembaca lama
  doc["analysis"]        = getPlantAnalysis(soilMoisture, lightIntensity, dryThreshold, lightThreshold);
  doc["soil_state"]      = (float)soilMoisture < dryThreshold ? "Kering" : "Lembab";
  doc["light_state"]     = (float)lightIntensity >= lightThreshold ? "Terang (Siang)" : "Redup (Malam)";

  char buf[512];
  size_t n = serializeJson(doc, buf, sizeof(buf));
  if (mqtt.publish(topicTelemetry.c_str(), (const uint8_t*)buf, n, false)) {
    lastPublish = millis();
  }
}

// ==================================================
// 8. MQTT CALLBACK
// ==================================================

void handleConfig(const JsonDocument& doc) {
  if (doc["device_id"].is<const char*>() && String((const char*)doc["device_id"]) != DEVICE_ID) return;

  float newDry   = dryThreshold;
  float newWet   = wetThreshold;
  float newLight = lightThreshold;

  if (doc["dry_threshold"].is<float>()) {
    float v = doc["dry_threshold"].as<float>();
    if (!isnan(v) && v >= 0 && v <= 100) newDry = v;
  } else if (doc["soil_threshold"].is<float>()) {
    float v = doc["soil_threshold"].as<float>();
    if (!isnan(v) && v >= 0 && v <= 100) newDry = v;
  }

  if (doc["wet_threshold"].is<float>()) {
    float v = doc["wet_threshold"].as<float>();
    if (!isnan(v) && v >= 0 && v <= 100) newWet = v;
  }

  if (doc["light_threshold"].is<float>()) {
    float v = doc["light_threshold"].as<float>();
    if (!isnan(v) && v >= 0 && v <= 100) newLight = v;
  }

  if (newDry >= newWet) {
    Serial.println("Config diabaikan: batas kering harus lebih kecil dari batas lembab");
    return;
  }

  if (newDry != dryThreshold || newWet != wetThreshold || newLight != lightThreshold) {
    dryThreshold   = newDry;
    wetThreshold   = newWet;
    lightThreshold = newLight;
    saveThresholds(dryThreshold, wetThreshold, lightThreshold);
    Serial.printf("Ambang baru disimpan: kering=%.1f | lembab=%.1f | cahaya=%.1f\n", dryThreshold, wetThreshold, lightThreshold);
  }
  applyAutoRule();
  updateLCD();
  publishTelemetry();
}

void handleCommand(const JsonDocument& doc) {
  if (doc["device_id"].is<const char*>() && String((const char*)doc["device_id"]) != DEVICE_ID) return;

  if (doc["mode"].is<const char*>()) {
    String m = (const char*)doc["mode"];
    if (m == "AUTO") {
      systemMode = "AUTO";
      applyAutoRule();
    } else if (m == "MANUAL") {
      systemMode = "MANUAL";
    }
  }
  // Menerima perintah status pompa baik dari kendali manual maupun dari keputusan otomatisasi Cloud
  if (doc["pump"].is<const char*>()) {
    String p = (const char*)doc["pump"];
    if (p == "ON") setPump(true);
    else if (p == "OFF") setPump(false);
  }
  updateLCD();
  publishTelemetry();
}

void mqttCallback(char* topic, byte* payload, unsigned int length) {
  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, payload, length);
  if (err) {
    Serial.print("JSON tidak valid: ");
    Serial.println(err.c_str());
    return;
  }
  String t = String(topic);
  if (t == topicConfig) handleConfig(doc);
  else if (t == topicCommand) handleCommand(doc);
}

// ==================================================
// 9. KONEKSI NON-BLOCKING
// ==================================================

void maintainConnections() {
  unsigned long now = millis();

  if (WiFi.status() != WL_CONNECTED) {
    if (now - lastWifiTry >= WIFI_RETRY_INTERVAL) {
      lastWifiTry = now;
      Serial.printf("Wi-Fi terputus, mencoba menyambung ulang ke %s...\n", WIFI_SSID);
      WiFi.disconnect();
      WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    }
    return;  // tanpa WiFi: lewati MQTT, kontrol lokal tetap jalan
  }

  if (!mqtt.connected()) {
    if (now - lastMqttTry >= MQTT_RETRY_INTERVAL) {
      lastMqttTry = now;
      String clientId = String(DEVICE_ID) + "_" + String((uint32_t)ESP.getEfuseMac(), HEX);
      char will[128];
      snprintf(will, sizeof(will), "{\"device_id\":\"%s\",\"status\":\"offline\"}", DEVICE_ID);

      Serial.print("Menghubungkan MQTT...");
      // LWT: broker mengumumkan "offline" (retained) bila ESP32 hilang tiba-tiba.
      if (mqtt.connect(clientId.c_str(), MQTT_USER, MQTT_PASS,
                       topicStatus.c_str(), 1, true, will, true)) {
        Serial.println("Terhubung");
        mqtt.subscribe(topicConfig.c_str(), 1);   // retained: ambang terbaru langsung diterima
        mqtt.subscribe(topicCommand.c_str(), 1);
        publishStatus("online");
        publishTelemetry();
      } else {
        Serial.print("Gagal, state=");
        Serial.println(mqtt.state());
      }
    }
  }
}

// ==================================================
// 10. SENSOR (Multi-sampling 16x & Kalibrasi Presisi)
// ==================================================

void readSensors() {
  // Multi-sampling 16x untuk meredam noise ADC ESP32 dan lonjakan daya Wi-Fi
  long soilSum = 0;
  long lightSum = 0;
  for (int i = 0; i < 16; i++) {
    soilSum += analogRead(SOIL_PIN);
    lightSum += analogRead(LDR_PIN);
    delay(2);
  }
  soilRaw  = (int)(soilSum / 16);
  lightRaw = (int)(lightSum / 16);

  // Konversi nilai ADC analog ke persentase 0 - 100%
  if (SOIL_DRY_RAW > SOIL_WET_RAW) {
    soilMoisture = map(soilRaw, SOIL_DRY_RAW, SOIL_WET_RAW, 0, 100);
  } else {
    soilMoisture = map(soilRaw, SOIL_DRY_RAW, SOIL_WET_RAW, 100, 0);
  }
  lightIntensity = map(lightRaw, LDR_DARK_RAW, LDR_BRIGHT_RAW, 0, 100);

  soilMoisture   = constrain(soilMoisture, 0, 100);
  lightIntensity = constrain(lightIntensity, 0, 100);

  Serial.printf("[SENSOR DIAGNOSTIK] Soil Pin 34 Raw=%d -> %d%% | LDR Pin 35 Raw=%d -> %d%% | Mode=%s | Pompa=%s\n",
                soilRaw, soilMoisture, lightRaw, lightIntensity,
                systemMode.c_str(), pumpStatus ? "ON" : "OFF");
  const char* sState = (float)soilMoisture < dryThreshold ? "Kering" : "Lembab";
  const char* lState = (float)lightIntensity >= lightThreshold ? "Terang" : "Redup";
  Serial.printf("[ANALISIS] Kelembapan: %s | Cahaya: %s -> %s\n",
                sState, lState, getPlantAnalysis(soilMoisture, lightIntensity, dryThreshold, lightThreshold));
}

// ==================================================
// 11. LCD (Responsif, Anti-Hilang & Anti-Karakter Acak)
// ==================================================

void updateLCD() {
  lcd.display();      // Pastikan display selalu aktif (tidak blank)

  char line1[17];
  snprintf(line1, sizeof(line1), "Soil:%-3d%% L:%-3d%%  ", soilMoisture, lightIntensity);
  line1[16] = '\0';
  lcd.setCursor(0, 0);
  lcd.print(line1);

  char line2[17];
  bool isMalam = (float)lightIntensity < lightThreshold;
  bool isKering = (float)soilMoisture < dryThreshold;

  if (systemMode == "AUTO" && isMalam && isKering) {
    // Aturan 4: Jika malam hari dan tanah kering, tampilkan status tunda pada LCD
    snprintf(line2, sizeof(line2), "TNH KRN-DITUNDA ");
  } else {
    // Menampilkan status pompa, mode, dan rentang ambang custom user (Kering - Lembab)
    snprintf(line2, sizeof(line2), "P:%-3s %-4s %02d-%02d ",
             pumpStatus ? "ON" : "OFF",
             systemMode == "AUTO" ? "AUTO" : "MANU",
             (int)dryThreshold,
             (int)wetThreshold);
  }
  line2[16] = '\0';
  lcd.setCursor(0, 1);
  lcd.print(line2);
}

// ==================================================
// 12. SETUP & LOOP
// ==================================================

void setup() {
  Serial.begin(115200);

  pinMode(RELAY_PIN, OUTPUT);
  digitalWrite(RELAY_PIN, RELAY_OFF);
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);

  // Konfigurasi ADC Sensor ESP32 (Resolusi 12-bit & Skala Penuh 0 - 3.3V)
  pinMode(SOIL_PIN, INPUT);
  pinMode(LDR_PIN, INPUT);
  analogReadResolution(12);
  analogSetPinAttenuation(SOIL_PIN, ADC_11db); // Skala penuh hingga ~3.3V
  analogSetPinAttenuation(LDR_PIN, ADC_11db);

  Wire.begin(LCD_SDA, LCD_SCL);
  Wire.setClock(100000); // 100 kHz standar
  Wire.setTimeOut(30);
  lcd.init();
  lcd.backlight();
  lcd.setCursor(0, 0);
  lcd.print("SMART PLANT POT ");
  lcd.setCursor(0, 1);
  lcd.print("Starting...     ");

  loadThresholds(); // Ambang batas kelembapan & cahaya dari flash

  String base = String("potpintar/") + DEVICE_ID;
  topicTelemetry = base + "/telemetry";
  topicStatus    = base + "/status";
  topicConfig    = base + "/config";
  topicCommand   = base + "/command";

  mqtt.setServer(MQTT_SERVER, MQTT_PORT);
  mqtt.setCallback(mqttCallback);
  mqtt.setBufferSize(512);
  mqtt.setKeepAlive(30);

  // Sambungkan ke Wi-Fi yang ditentukan pada kode
  Serial.printf("\n[WIFI] Menghubungkan ke: %s\n", WIFI_SSID);
  lcd.setCursor(0, 1);
  lcd.print("WiFi Connecting ");

  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  lastWifiTry = millis();

  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 10000) {
    delay(400);
    Serial.print(".");
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("[WIFI] Sukses terhubung ke %s | IP: %s\n", WIFI_SSID, WiFi.localIP().toString().c_str());
  } else {
    Serial.printf("[WIFI] Gagal terhubung ke %s. Sistem tetap menjalankan kontrol otomatis lokal.\n", WIFI_SSID);
  }

  // Pembacaan pertama agar kontrol dan tampilan langsung aktif
  readSensors();
  applyAutoRule();
  updateLCD();
}

void loop() {
  maintainConnections();
  if (mqtt.connected()) mqtt.loop();

  unsigned long now = millis();

  if (now - lastSensorRead >= SENSOR_INTERVAL) {
    lastSensorRead = now;
    readSensors();
    applyAutoRule();   // LOKAL: tidak butuh internet
    updateLCD();

    // Deteksi instan: Bila nilai sensor berubah cukup besar, langsung kirim ke website
    if (abs(soilMoisture - lastReportedSoil) >= 2 || abs(lightIntensity - lastReportedLight) >= 3) {
      lastReportedSoil = soilMoisture;
      lastReportedLight = lightIntensity;
      publishTelemetry();
    }
  }

  if (now - lastPublish >= PUBLISH_INTERVAL) {
    lastPublish = now;
    lastReportedSoil = soilMoisture;
    lastReportedLight = lightIntensity;
    publishTelemetry();
  }
}
