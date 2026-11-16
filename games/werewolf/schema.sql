CREATE TABLE IF NOT EXISTS werewolf_players (
  id                 INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  room_id            INT UNSIGNED NOT NULL,
  psid               VARCHAR(64) NOT NULL,
  display_name       VARCHAR(100) NOT NULL,
  role_key           VARCHAR(24) NULL,
  team               ENUM('wolves','village') NULL,
  is_alive           TINYINT(1) NOT NULL DEFAULT 1,
  witch_heal_used    TINYINT(1) NOT NULL DEFAULT 0,
  witch_poison_used  TINYINT(1) NOT NULL DEFAULT 0,
  joined_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_werewolf_room_psid (room_id, psid),
  KEY idx_werewolf_psid (psid),
  CONSTRAINT fk_werewolf_player_room FOREIGN KEY (room_id)
    REFERENCES game_rooms(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS werewolf_actions (
  id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  room_id          INT UNSIGNED NOT NULL,
  round_number     TINYINT UNSIGNED NOT NULL,
  actor_player_id  INT UNSIGNED NOT NULL,
  action_type      VARCHAR(24) NOT NULL,
  target_player_id INT UNSIGNED NULL,
  target_player_id_2 INT UNSIGNED NULL,
  created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
                   ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_werewolf_action (room_id, round_number, actor_player_id, action_type),
  KEY idx_werewolf_action_target (room_id, round_number, target_player_id),
  CONSTRAINT fk_werewolf_action_room FOREIGN KEY (room_id)
    REFERENCES game_rooms(id) ON DELETE CASCADE,
  CONSTRAINT fk_werewolf_action_actor FOREIGN KEY (actor_player_id)
    REFERENCES werewolf_players(id) ON DELETE CASCADE,
  CONSTRAINT fk_werewolf_action_target FOREIGN KEY (target_player_id)
    REFERENCES werewolf_players(id) ON DELETE SET NULL,
  CONSTRAINT fk_werewolf_action_target_two FOREIGN KEY (target_player_id_2)
    REFERENCES werewolf_players(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS werewolf_votes (
  id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  room_id          INT UNSIGNED NOT NULL,
  round_number     TINYINT UNSIGNED NOT NULL,
  voter_player_id  INT UNSIGNED NOT NULL,
  target_player_id INT UNSIGNED NOT NULL,
  created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
                   ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_werewolf_vote (room_id, round_number, voter_player_id),
  KEY idx_werewolf_vote_target (room_id, round_number, target_player_id),
  CONSTRAINT fk_werewolf_vote_room FOREIGN KEY (room_id)
    REFERENCES game_rooms(id) ON DELETE CASCADE,
  CONSTRAINT fk_werewolf_vote_voter FOREIGN KEY (voter_player_id)
    REFERENCES werewolf_players(id) ON DELETE CASCADE,
  CONSTRAINT fk_werewolf_vote_target FOREIGN KEY (target_player_id)
    REFERENCES werewolf_players(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS werewolf_deaths (
  id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  room_id          INT UNSIGNED NOT NULL,
  round_number     TINYINT UNSIGNED NOT NULL,
  player_id        INT UNSIGNED NOT NULL,
  cause            VARCHAR(24) NOT NULL,
  created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_werewolf_death_round (room_id, round_number),
  CONSTRAINT fk_werewolf_death_room FOREIGN KEY (room_id)
    REFERENCES game_rooms(id) ON DELETE CASCADE,
  CONSTRAINT fk_werewolf_death_player FOREIGN KEY (player_id)
    REFERENCES werewolf_players(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS werewolf_state (
  room_id                  INT UNSIGNED PRIMARY KEY,
  pending_hunter_player_id INT UNSIGNED NULL,
  after_hunter             ENUM('discussion','night') NULL,
  witch_prompt_round       TINYINT UNSIGNED NOT NULL DEFAULT 0,
  lover_player_id_one      INT UNSIGNED NULL,
  lover_player_id_two      INT UNSIGNED NULL,
  sheriff_player_id        INT UNSIGNED NULL,
  sheriff_successor_player_id INT UNSIGNED NULL,
  sheriff_election_done    TINYINT(1) NOT NULL DEFAULT 0,
  pending_hunter_queue     TEXT NULL,
  CONSTRAINT fk_werewolf_state_room FOREIGN KEY (room_id)
    REFERENCES game_rooms(id) ON DELETE CASCADE,
  CONSTRAINT fk_werewolf_pending_hunter FOREIGN KEY (pending_hunter_player_id)
    REFERENCES werewolf_players(id) ON DELETE SET NULL
) ENGINE=InnoDB;
