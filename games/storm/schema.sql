CREATE TABLE IF NOT EXISTS storm_players (
  id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  room_id         INT UNSIGNED NOT NULL,
  psid            VARCHAR(64) NOT NULL,
  display_name    VARCHAR(100) NOT NULL,
  role_key        VARCHAR(32) NULL,
  team            ENUM('kingdom','shadow','independent') NULL,
  is_alive        TINYINT(1) NOT NULL DEFAULT 1,
  armor_count     INT UNSIGNED NOT NULL DEFAULT 0,
  trickster_points INT UNSIGNED NOT NULL DEFAULT 0,
  assassin_used   TINYINT(1) NOT NULL DEFAULT 0,
  sniper_used     TINYINT(1) NOT NULL DEFAULT 0,
  joined_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_storm_room_psid (room_id, psid),
  KEY idx_storm_psid (psid),
  CONSTRAINT fk_storm_player_room FOREIGN KEY (room_id)
    REFERENCES game_rooms(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS storm_actions (
  id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  room_id          INT UNSIGNED NOT NULL,
  round_number     TINYINT UNSIGNED NOT NULL,
  actor_player_id  INT UNSIGNED NOT NULL,
  action_type      VARCHAR(32) NOT NULL,
  target_player_id INT UNSIGNED NULL,
  created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
                   ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_storm_action (room_id, round_number, actor_player_id, action_type),
  KEY idx_storm_action_round (room_id, round_number, action_type),
  CONSTRAINT fk_storm_action_room FOREIGN KEY (room_id)
    REFERENCES game_rooms(id) ON DELETE CASCADE,
  CONSTRAINT fk_storm_action_actor FOREIGN KEY (actor_player_id)
    REFERENCES storm_players(id) ON DELETE CASCADE,
  CONSTRAINT fk_storm_action_target FOREIGN KEY (target_player_id)
    REFERENCES storm_players(id) ON DELETE SET NULL
) ENGINE=InnoDB;
