-- ============================================================
--  Detective Bot (Group mode) - MySQL 8+ schema
--  الغرفة = مجموعة ماسنجر (thread_id). لا يوجد كود غرفة بعد الآن.
-- ============================================================
CREATE DATABASE IF NOT EXISTS detective_bot
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE detective_bot;

CREATE TABLE IF NOT EXISTS bot_user_bans (
  psid      VARCHAR(64) NOT NULL PRIMARY KEY,
  banned_by VARCHAR(64) NOT NULL,
  reason    VARCHAR(500) NULL,
  banned_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS bot_player_scores (
  psid         VARCHAR(64) NOT NULL PRIMARY KEY,
  display_name VARCHAR(100) NOT NULL,
  points       BIGINT UNSIGNED NOT NULL DEFAULT 0,
  updated_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS bot_point_awards (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  room_id      INT UNSIGNED NOT NULL,
  game_id      VARCHAR(40) NOT NULL,
  psid         VARCHAR(64) NOT NULL,
  display_name VARCHAR(100) NOT NULL,
  points       TINYINT UNSIGNED NOT NULL DEFAULT 1,
  awarded_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_room_point_award (room_id, psid),
  KEY idx_point_awards_psid (psid)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS bot_point_transactions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  psid VARCHAR(64) NOT NULL,
  amount BIGINT NOT NULL,
  transaction_type VARCHAR(32) NOT NULL,
  description VARCHAR(255) NULL,
  created_by VARCHAR(64) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_point_transactions_psid (psid)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS bot_game_prompt_usage (
  game_id VARCHAR(40) NOT NULL,
  thread_id VARCHAR(64) NOT NULL,
  prompt_index INT UNSIGNED NOT NULL,
  used_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (game_id, thread_id, prompt_index),
  KEY idx_prompt_usage_thread (thread_id, game_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS bot_shop_products (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  description VARCHAR(500) NOT NULL DEFAULT '',
  item_type ENUM('cosmetic','perk') NOT NULL,
  price BIGINT UNSIGNED NOT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_by VARCHAR(64) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_shop_products_active (active, id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS bot_shop_inventory (
  psid VARCHAR(64) NOT NULL,
  product_id BIGINT UNSIGNED NOT NULL,
  quantity INT UNSIGNED NOT NULL DEFAULT 1,
  equipped TINYINT(1) NOT NULL DEFAULT 0,
  purchased_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (psid, product_id),
  KEY idx_shop_inventory_product (product_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS bot_shop_purchases (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  psid VARCHAR(64) NOT NULL,
  product_id BIGINT UNSIGNED NOT NULL,
  price_paid BIGINT UNSIGNED NOT NULL,
  purchased_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_shop_purchases_psid (psid),
  KEY idx_shop_purchases_product (product_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS bot_game_controls (
  game_id    VARCHAR(40) NOT NULL PRIMARY KEY,
  enabled    TINYINT(1) NOT NULL DEFAULT 1,
  changed_by VARCHAR(64) NOT NULL,
  changed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS bot_fixed_replies (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  trigger_text VARCHAR(100) NOT NULL,
  trigger_key VARCHAR(100) NOT NULL,
  response_text VARCHAR(1000) NOT NULL,
  created_by VARCHAR(64) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_fixed_reply_trigger (trigger_key)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS game_image_cache (
  game_id     VARCHAR(40) NOT NULL,
  image_key   VARCHAR(120) NOT NULL,
  content_type VARCHAR(32) NOT NULL,
  image_data  MEDIUMBLOB NOT NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (game_id, image_key)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS cases_pool (
  id             INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  title          VARCHAR(255)  NOT NULL,
  summary        TEXT          NOT NULL,
  setting        VARCHAR(255)  NOT NULL,
  victim_name    VARCHAR(120)  NULL,
  victim_desc    VARCHAR(500)  NULL,
  solution       TEXT          NOT NULL,
  killer_json    JSON          NOT NULL,
  innocents_json JSON          NOT NULL,
  source_title   VARCHAR(255)  NULL,
  source_url     VARCHAR(500)  NULL,
  is_real_based  TINYINT(1)    NOT NULL DEFAULT 0,
  times_used     INT UNSIGNED  NOT NULL DEFAULT 0,
  created_at     TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS case_clues (
  id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  case_id      INT UNSIGNED NOT NULL,
  round_number TINYINT UNSIGNED NOT NULL,
  clue_text    TEXT NOT NULL,
  points_to    ENUM('killer','red_herring','neutral') NOT NULL DEFAULT 'neutral',
  target_key   VARCHAR(50) NULL,
  UNIQUE KEY uq_case_round (case_id, round_number),
  CONSTRAINT fk_clue_case FOREIGN KEY (case_id) REFERENCES cases_pool(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS game_rooms (
  id               INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  game_id          VARCHAR(40)  NOT NULL DEFAULT 'crime',
  thread_id        VARCHAR(64)  NOT NULL,          -- threadID لمجموعة ماسنجر
  host_psid        VARCHAR(64)  NOT NULL,          -- Facebook userID للمضيف
  case_id          INT UNSIGNED NULL,
  case_assigned_at DATETIME(6) NULL,
  status           ENUM('lobby','playing','finished','cancelled') NOT NULL DEFAULT 'lobby',
  phase            ENUM('lobby','assigning','intro','discussion','voting','tallying','between','final_voting','final_tallying','night','spy_guess','hunter','finished')
                   NOT NULL DEFAULT 'lobby',
  current_round    TINYINT UNSIGNED NOT NULL DEFAULT 0,
  total_rounds     TINYINT UNSIGNED NOT NULL DEFAULT 3,
  killer_player_id INT UNSIGNED NULL,
  lobby_message_id VARCHAR(128) NULL,
  phase_ends_at    DATETIME NULL,
  winner           ENUM('killer','innocents') NULL,
  created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  -- يضمن لعبة نشطة واحدة فقط لكل مجموعة (القيم NULL لا تتعارض مع بعضها)
  active_thread    VARCHAR(64) GENERATED ALWAYS AS (IF(status IN ('lobby','playing'), thread_id, NULL)) STORED,
  UNIQUE KEY uq_active_thread (active_thread),
  KEY idx_game_phase_tick (game_id, status, phase, phase_ends_at),
  KEY idx_thread (thread_id),
  KEY idx_tick (status, phase, phase_ends_at),
  CONSTRAINT fk_room_case FOREIGN KEY (case_id) REFERENCES cases_pool(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS room_players (
  id               INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  room_id          INT UNSIGNED NOT NULL,
  psid             VARCHAR(64)  NOT NULL,          -- Facebook userID (اسم العمود قديم)
  display_name     VARCHAR(100) NOT NULL,
  welcome_sent_at  DATETIME NULL,
  role             ENUM('killer','innocent') NULL,
  character_key    VARCHAR(50)  NULL,
  character_name   VARCHAR(120) NULL,
  character_bio    TEXT NULL,
  bio_revealed_at  DATETIME NULL,
  alibi            TEXT NULL,
  secret_note      TEXT NULL,
  is_alive         TINYINT(1)   NOT NULL DEFAULT 1,
  eliminated_round TINYINT UNSIGNED NULL,
  joined_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_room_psid (room_id, psid),
  KEY idx_psid (psid),
  CONSTRAINT fk_player_room FOREIGN KEY (room_id) REFERENCES game_rooms(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS votes (
  id               INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  room_id          INT UNSIGNED NOT NULL,
  round_number     TINYINT UNSIGNED NOT NULL,
  voter_player_id  INT UNSIGNED NOT NULL,
  target_player_id INT UNSIGNED NOT NULL,
  created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_vote (room_id, round_number, voter_player_id),
  CONSTRAINT fk_vote_room   FOREIGN KEY (room_id)          REFERENCES game_rooms(id)    ON DELETE CASCADE,
  CONSTRAINT fk_vote_voter  FOREIGN KEY (voter_player_id)  REFERENCES room_players(id)  ON DELETE CASCADE,
  CONSTRAINT fk_vote_target FOREIGN KEY (target_player_id) REFERENCES room_players(id)  ON DELETE CASCADE
) ENGINE=InnoDB;

-- ===== ترحيل قاعدة بيانات قديمة (نسخة Page API) بدل إعادة الإنشاء =====
-- DELETE FROM game_rooms;
-- ALTER TABLE game_rooms
--   DROP COLUMN room_code,
--   ADD COLUMN thread_id VARCHAR(64) NOT NULL AFTER id,
--   ADD COLUMN active_thread VARCHAR(64) GENERATED ALWAYS AS (IF(status IN ('lobby','playing'), thread_id, NULL)) STORED,
--   ADD UNIQUE KEY uq_active_thread (active_thread),
--   ADD KEY idx_thread (thread_id);
