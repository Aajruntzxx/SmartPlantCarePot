-- PotPintar database schema (MySQL 8+ / MariaDB 10.5+)
CREATE DATABASE IF NOT EXISTS potpintar_db
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE potpintar_db;

CREATE TABLE IF NOT EXISTS users (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name          VARCHAR(100) NOT NULL,
  email         VARCHAR(190) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_email (email)
) ENGINE=InnoDB;

-- user_id boleh NULL: perangkat yang belum diklaim pemilik.
CREATE TABLE IF NOT EXISTS devices (
  id                     INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id                INT UNSIGNED NULL,
  device_code            VARCHAR(64) NOT NULL,
  device_name            VARCHAR(100) NOT NULL DEFAULT 'PotPintar',
  dry_threshold          DECIMAL(5,2) NOT NULL DEFAULT 40.00 COMMENT 'batas kering: pompa ON saat kelembapan < ambang ini',
  wet_threshold          DECIMAL(5,2) NOT NULL DEFAULT 70.00 COMMENT 'batas lembab: pompa OFF saat kelembapan >= ambang ini',
  soil_threshold         DECIMAL(5,2) NOT NULL DEFAULT 40.00 COMMENT 'kompatibilitas versi sebelumnya',
  light_threshold        DECIMAL(5,2) NOT NULL DEFAULT 50.00 COMMENT 'batas cahaya: kategori tinggi saat intensitas >= ambang ini',
  reported_dry_threshold DECIMAL(5,2) NULL COMMENT 'batas kering yang dilaporkan ESP32 sedang dipakai',
  reported_wet_threshold DECIMAL(5,2) NULL COMMENT 'batas lembab yang dilaporkan ESP32 sedang dipakai',
  reported_threshold     DECIMAL(5,2) NULL COMMENT 'ambang yang dilaporkan ESP32 sedang dipakai (kompatibilitas)',
  reported_light_threshold DECIMAL(5,2) NULL COMMENT 'batas cahaya yang dilaporkan ESP32 sedang dipakai',
  created_at             TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at             TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  last_seen_at           DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_devices_code (device_code),
  KEY idx_devices_user (user_id),
  CONSTRAINT chk_dry_threshold CHECK (dry_threshold >= 0 AND dry_threshold <= 100),
  CONSTRAINT chk_wet_threshold CHECK (wet_threshold >= 0 AND wet_threshold <= 100),
  CONSTRAINT chk_threshold_order CHECK (dry_threshold < wet_threshold),
  CONSTRAINT fk_devices_user FOREIGN KEY (user_id)
    REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB;

-- Migrasi jika tabel devices sudah pernah dibuat di versi sebelumnya:
-- ALTER TABLE devices
--   ADD COLUMN IF NOT EXISTS dry_threshold DECIMAL(5,2) NOT NULL DEFAULT 40.00 AFTER device_name,
--   ADD COLUMN IF NOT EXISTS wet_threshold DECIMAL(5,2) NOT NULL DEFAULT 70.00 AFTER dry_threshold,
--   ADD COLUMN IF NOT EXISTS reported_dry_threshold DECIMAL(5,2) NULL AFTER wet_threshold,
--   ADD COLUMN IF NOT EXISTS reported_wet_threshold DECIMAL(5,2) NULL AFTER reported_dry_threshold;

CREATE TABLE IF NOT EXISTS sensor_logs (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  device_id       INT UNSIGNED NOT NULL,
  soil_moisture   DECIMAL(5,2) NOT NULL,
  light_intensity DECIMAL(5,2) NOT NULL,
  pump_status     ENUM('ON','OFF') NOT NULL,
  mode            ENUM('AUTO','MANUAL') NOT NULL,
  recorded_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_logs_device_time (device_id, recorded_at),
  CONSTRAINT fk_logs_device FOREIGN KEY (device_id)
    REFERENCES devices(id) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;

-- Perangkat milik proyek ini (belum punya pemilik; diklaim saat registrasi/dashboard).
INSERT INTO devices (user_id, device_code, device_name, dry_threshold, wet_threshold, soil_threshold)
VALUES (NULL, 'smartplant_azarya_01', 'PotPintar Azarya', 40.00, 70.00, 40.00)
ON DUPLICATE KEY UPDATE device_code = device_code;
