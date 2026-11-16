CREATE TABLE IF NOT EXISTS drawing_players (
  id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  room_id      INT UNSIGNED NOT NULL,
  psid         VARCHAR(64) NOT NULL,
  display_name VARCHAR(100) NOT NULL,
  score        INT UNSIGNED NOT NULL DEFAULT 0,
  joined_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_drawing_room_psid (room_id, psid),
  KEY idx_drawing_psid (psid),
  CONSTRAINT fk_drawing_player_room FOREIGN KEY (room_id)
    REFERENCES game_rooms(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS drawing_submissions (
  id                  BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  room_id             INT UNSIGNED NOT NULL,
  player_id           INT UNSIGNED NOT NULL,
  word                VARCHAR(120) NOT NULL,
  aliases_json        JSON NOT NULL,
  token_hash          CHAR(64) NOT NULL,
  token_expires_at    DATETIME NOT NULL,
  status              ENUM('issued','queued','publishing','published','solved','expired','cancelled') NOT NULL DEFAULT 'issued',
  image_data          MEDIUMBLOB NULL,
  image_content_type  VARCHAR(32) NULL,
  submitted_at        DATETIME NULL,
  published_at        DATETIME NULL,
  guessed_by_player_id INT UNSIGNED NULL,
  created_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_drawing_token (token_hash),
  KEY idx_drawing_queue (room_id, status, id),
  KEY idx_drawing_player_status (room_id, player_id, status),
  CONSTRAINT fk_drawing_submission_room FOREIGN KEY (room_id)
    REFERENCES game_rooms(id) ON DELETE CASCADE,
  CONSTRAINT fk_drawing_submission_player FOREIGN KEY (player_id)
    REFERENCES drawing_players(id) ON DELETE CASCADE,
  CONSTRAINT fk_drawing_submission_guesser FOREIGN KEY (guessed_by_player_id)
    REFERENCES drawing_players(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS drawing_state (
  room_id          INT UNSIGNED PRIMARY KEY,
  artist_psid      VARCHAR(64) NULL,
  round_started_at DATETIME NULL,
  last_activity_at DATETIME NULL,
  next_publish_at  DATETIME NULL,
  CONSTRAINT fk_drawing_state_room FOREIGN KEY (room_id)
    REFERENCES game_rooms(id) ON DELETE CASCADE
) ENGINE=InnoDB;
