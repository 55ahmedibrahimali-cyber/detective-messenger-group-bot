package com.detective.bot.models

data class GameControlItem(
    val id: String,
    val name: String,
    val command: String,
    val type: String, // "game" or "command"
    var enabled: Boolean
)
