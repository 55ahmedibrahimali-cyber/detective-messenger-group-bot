package com.detective.bot.adapters

import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.view.Gravity
import android.view.LayoutInflater
import android.view.ViewGroup
import androidx.core.content.ContextCompat
import androidx.recyclerview.widget.RecyclerView
import com.detective.bot.R
import com.detective.bot.databinding.ItemChatMessageBinding
import com.detective.bot.models.ChatMessage

class ChatMessagesAdapter(
    private var messages: MutableList<ChatMessage>,
    private val currentUserIdProvider: () -> String
) : RecyclerView.Adapter<ChatMessagesAdapter.ViewHolder>() {

    inner class ViewHolder(val binding: ItemChatMessageBinding) :
        RecyclerView.ViewHolder(binding.root)

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): ViewHolder {
        val binding = ItemChatMessageBinding.inflate(
            LayoutInflater.from(parent.context),
            parent,
            false
        )
        return ViewHolder(binding)
    }

    private fun createPillDrawable(color: Int): GradientDrawable {
        return GradientDrawable().apply {
            shape = GradientDrawable.RECTANGLE
            cornerRadius = 24f
            setColor(color)
        }
    }

    override fun onBindViewHolder(holder: ViewHolder, position: Int) {
        val msg = messages[position]
        val binding = holder.binding
        val myId = currentUserIdProvider()
        val isMe = msg.senderId == myId

        binding.tvSenderName.text = if (isMe) "أنت" else msg.senderName
        binding.tvMessageContent.text = msg.text
        binding.tvMessageTime.text = msg.time

        // Discord / Telegram Theme Styling
        when {
            msg.isBot -> {
                binding.tvRoleBadge.text = "⚡ ستورم بوت"
                binding.tvRoleBadge.background = createPillDrawable(Color.parseColor("#5865f2"))
                binding.tvRoleBadge.setTextColor(Color.WHITE)
                binding.tvSenderName.setTextColor(Color.parseColor("#818cf8"))
                binding.cardMessageBubble.setCardBackgroundColor(Color.parseColor("#181d2f"))
                binding.cardMessageBubble.strokeColor = Color.parseColor("#384370")
            }
            msg.role == "owner" -> {
                binding.tvRoleBadge.text = "👑 مالك"
                binding.tvRoleBadge.background = createPillDrawable(Color.parseColor("#f59e0b"))
                binding.tvRoleBadge.setTextColor(Color.parseColor("#0a0c10"))
                binding.tvSenderName.setTextColor(Color.parseColor("#fbbf24"))
                if (isMe) {
                    binding.cardMessageBubble.setCardBackgroundColor(Color.parseColor("#4338ca"))
                    binding.cardMessageBubble.strokeColor = Color.parseColor("#6366f1")
                } else {
                    binding.cardMessageBubble.setCardBackgroundColor(Color.parseColor("#21252f"))
                    binding.cardMessageBubble.strokeColor = Color.parseColor("#f59e0b")
                }
            }
            msg.role == "admin" -> {
                binding.tvRoleBadge.text = "🛡️ مشرف"
                binding.tvRoleBadge.background = createPillDrawable(Color.parseColor("#3b82f6"))
                binding.tvRoleBadge.setTextColor(Color.WHITE)
                binding.tvSenderName.setTextColor(Color.parseColor("#60a5fa"))
                if (isMe) {
                    binding.cardMessageBubble.setCardBackgroundColor(Color.parseColor("#4338ca"))
                    binding.cardMessageBubble.strokeColor = Color.parseColor("#6366f1")
                } else {
                    binding.cardMessageBubble.setCardBackgroundColor(Color.parseColor("#21252f"))
                    binding.cardMessageBubble.strokeColor = Color.parseColor("#3b82f6")
                }
            }
            else -> {
                binding.tvRoleBadge.text = "👤 لاعب"
                binding.tvRoleBadge.background = createPillDrawable(Color.parseColor("#334155"))
                binding.tvRoleBadge.setTextColor(Color.parseColor("#cbd5e1"))
                binding.tvSenderName.setTextColor(Color.parseColor("#94a3b8"))
                if (isMe) {
                    binding.cardMessageBubble.setCardBackgroundColor(Color.parseColor("#4338ca"))
                    binding.cardMessageBubble.strokeColor = Color.parseColor("#6366f1")
                } else {
                    binding.cardMessageBubble.setCardBackgroundColor(Color.parseColor("#21252f"))
                    binding.cardMessageBubble.strokeColor = Color.parseColor("#2d323e")
                }
            }
        }

        // Message alignment (Telegram/Discord style)
        val root = binding.messageRootLayout
        val header = binding.headerLayout
        if (isMe) {
            root.gravity = Gravity.END
            header.gravity = Gravity.END
        } else {
            root.gravity = Gravity.START
            header.gravity = Gravity.START
        }
    }

    override fun getItemCount(): Int = messages.size

    fun addMessages(newMsgs: List<ChatMessage>) {
        val startPos = messages.size
        messages.addAll(newMsgs)
        notifyItemRangeInserted(startPos, newMsgs.size)
    }

    fun setMessages(newMsgs: List<ChatMessage>) {
        messages = newMsgs.toMutableList()
        notifyDataSetChanged()
    }
}
