const db = require("../database");

async function findActiveGameForPlayer(userId) {
  return db.one(
    `SELECT gr.game_id FROM game_rooms gr
     LEFT JOIN room_players rp ON rp.room_id=gr.id AND rp.psid=?
     LEFT JOIN storm_players stp ON stp.room_id=gr.id AND stp.psid=?
     LEFT JOIN spy_players spp ON spp.room_id=gr.id AND spp.psid=?
     LEFT JOIN feign_players fgp ON fgp.room_id=gr.id AND fgp.psid=?
     LEFT JOIN werewolf_players wwp ON wwp.room_id=gr.id AND wwp.psid=?
     LEFT JOIN drawing_players drp ON drp.room_id=gr.id AND drp.psid=?
     WHERE gr.status IN ('lobby','playing')
       AND ((gr.game_id IN ('crime','try-escape','treasure-hunt','shadow-market','rescue-code') AND rp.id IS NOT NULL)
         OR (gr.game_id='storm' AND stp.id IS NOT NULL)
         OR (gr.game_id='spy' AND spp.id IS NOT NULL)
         OR (gr.game_id='feign' AND fgp.id IS NOT NULL)
         OR (gr.game_id='werewolf' AND wwp.id IS NOT NULL)
         OR (gr.game_id='drawing' AND drp.id IS NOT NULL))
     ORDER BY FIELD(gr.game_id, 'crime', 'try-escape', 'treasure-hunt', 'shadow-market', 'rescue-code', 'storm', 'spy', 'feign', 'werewolf', 'drawing'),
              gr.id DESC
     LIMIT 1`,
    Array(6).fill(userId),
  );
}

module.exports = { findActiveGameForPlayer };
