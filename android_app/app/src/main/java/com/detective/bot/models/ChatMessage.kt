package com.detective.bot.models

data class ChatMessage(
    val id: Long,
    val senderId: String,
    val senderName: String,
    val text: String,
    val isBot: Boolean,
    val role: String,
    val time: String
)
