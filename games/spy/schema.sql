CREATE TABLE IF NOT EXISTS spy_players (
  id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  room_id      INT UNSIGNED NOT NULL,
  psid         VARCHAR(64) NOT NULL,
  display_name VARCHAR(100) NOT NULL,
  is_spy       TINYINT(1) NOT NULL DEFAULT 0,
  is_out       TINYINT(1) NOT NULL DEFAULT 0,
  guess_used   TINYINT(1) NOT NULL DEFAULT 0,
  joined_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_spy_room_psid (room_id, psid),
  KEY idx_spy_psid (psid),
  CONSTRAINT fk_spy_player_room FOREIGN KEY (room_id)
    REFERENCES game_rooms(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS spy_rounds (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  room_id       INT UNSIGNED NOT NULL,
  location_name VARCHAR(120) NOT NULL,
  category      VARCHAR(80) NOT NULL,
  image_asset_key VARCHAR(120) NOT NULL,
  image_title   VARCHAR(160) NOT NULL,
  spy_hint      VARCHAR(255) NOT NULL,
  forbidden_words JSON NOT NULL,
  spy_player_id INT UNSIGNED NULL,
  result        ENUM('spy','citizens') NULL,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_spy_round_room (room_id),
  CONSTRAINT fk_spy_round_room FOREIGN KEY (room_id)
    REFERENCES game_rooms(id) ON DELETE CASCADE,
  CONSTRAINT fk_spy_round_player FOREIGN KEY (spy_player_id)
    REFERENCES spy_players(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS spy_pending_scenes (
  id               INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  reserved_room_id INT UNSIGNED NULL,
  location_name    VARCHAR(120) NOT NULL,
  category         VARCHAR(80) NOT NULL,
  image_asset_key  VARCHAR(120) NOT NULL,
  image_title      VARCHAR(160) NOT NULL,
  spy_hint         VARCHAR(255) NOT NULL,
  forbidden_words  JSON NOT NULL,
  created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_spy_pending_reservation (reserved_room_id, id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS spy_votes (
  id               INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  room_id          INT UNSIGNED NOT NULL,
  voter_player_id  INT UNSIGNED NOT NULL,
  target_player_id INT UNSIGNED NOT NULL,
  created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
                   ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_spy_vote_voter (room_id, voter_player_id),
  KEY idx_spy_vote_target (room_id, target_player_id),
  CONSTRAINT fk_spy_vote_room FOREIGN KEY (room_id)
    REFERENCES game_rooms(id) ON DELETE CASCADE,
  CONSTRAINT fk_spy_vote_voter FOREIGN KEY (voter_player_id)
    REFERENCES spy_players(id) ON DELETE CASCADE,
  CONSTRAINT fk_spy_vote_target FOREIGN KEY (target_player_id)
    REFERENCES spy_players(id) ON DELETE CASCADE
) ENGINE=InnoDB;
