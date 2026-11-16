CREATE TABLE IF NOT EXISTS feign_players (
  id                  INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  room_id             INT UNSIGNED NOT NULL,
  psid                VARCHAR(64) NOT NULL,
  display_name        VARCHAR(100) NOT NULL,
  role_key            VARCHAR(32) NULL,
  team                ENUM('town','impostor','neutral') NULL,
  apparent_role_key   VARCHAR(32) NULL,
  ability_variant     VARCHAR(32) NULL,
  ability_used        TINYINT(1) NOT NULL DEFAULT 0,
  armor_count         TINYINT UNSIGNED NOT NULL DEFAULT 0,
  is_alive            TINYINT(1) NOT NULL DEFAULT 1,
  joined_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_feign_room_psid (room_id, psid),
  KEY idx_feign_psid (psid),
  CONSTRAINT fk_feign_player_room FOREIGN KEY (room_id)
    REFERENCES game_rooms(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS feign_actions (
  id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  room_id          INT UNSIGNED NOT NULL,
  round_number     TINYINT UNSIGNED NOT NULL,
  actor_player_id  INT UNSIGNED NOT NULL,
  action_type      VARCHAR(32) NOT NULL,
  target_player_id INT UNSIGNED NULL,
  guessed_role_key VARCHAR(32) NULL,
  created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
                   ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_feign_action (room_id, round_number, actor_player_id),
  KEY idx_feign_action_target (room_id, round_number, target_player_id),
  CONSTRAINT fk_feign_action_room FOREIGN KEY (room_id)
    REFERENCES game_rooms(id) ON DELETE CASCADE,
  CONSTRAINT fk_feign_action_actor FOREIGN KEY (actor_player_id)
    REFERENCES feign_players(id) ON DELETE CASCADE,
  CONSTRAINT fk_feign_action_target FOREIGN KEY (target_player_id)
    REFERENCES feign_players(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS feign_votes (
  id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  room_id          INT UNSIGNED NOT NULL,
  round_number     TINYINT UNSIGNED NOT NULL,
  voter_player_id  INT UNSIGNED NOT NULL,
  target_player_id INT UNSIGNED NOT NULL,
  created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
                   ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_feign_vote (room_id, round_number, voter_player_id),
  KEY idx_feign_vote_target (room_id, round_number, target_player_id),
  CONSTRAINT fk_feign_vote_room FOREIGN KEY (room_id)
    REFERENCES game_rooms(id) ON DELETE CASCADE,
  CONSTRAINT fk_feign_vote_voter FOREIGN KEY (voter_player_id)
    REFERENCES feign_players(id) ON DELETE CASCADE,
  CONSTRAINT fk_feign_vote_target FOREIGN KEY (target_player_id)
    REFERENCES feign_players(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS feign_marks (
  id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  room_id          INT UNSIGNED NOT NULL,
  source_player_id INT UNSIGNED NOT NULL,
  target_player_id INT UNSIGNED NOT NULL,
  mark_type        ENUM('bomb','candle','haunt') NOT NULL,
  planted_round    TINYINT UNSIGNED NOT NULL,
  created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_feign_mark (room_id, source_player_id, target_player_id, mark_type),
  KEY idx_feign_marks_target (room_id, mark_type, target_player_id),
  CONSTRAINT fk_feign_mark_room FOREIGN KEY (room_id)
    REFERENCES game_rooms(id) ON DELETE CASCADE,
  CONSTRAINT fk_feign_mark_source FOREIGN KEY (source_player_id)
    REFERENCES feign_players(id) ON DELETE CASCADE,
  CONSTRAINT fk_feign_mark_target FOREIGN KEY (target_player_id)
    REFERENCES feign_players(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS feign_deaths (
  id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  room_id          INT UNSIGNED NOT NULL,
  round_number     TINYINT UNSIGNED NOT NULL,
  player_id        INT UNSIGNED NOT NULL,
  cause            VARCHAR(32) NOT NULL,
  reveal_mode      ENUM('role','hidden','impostor') NOT NULL DEFAULT 'role',
  reveal_role_key  VARCHAR(32) NULL,
  created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_feign_death_round (room_id, round_number),
  CONSTRAINT fk_feign_death_room FOREIGN KEY (room_id)
    REFERENCES game_rooms(id) ON DELETE CASCADE,
  CONSTRAINT fk_feign_death_player FOREIGN KEY (player_id)
    REFERENCES feign_players(id) ON DELETE CASCADE
) ENGINE=InnoDB;
