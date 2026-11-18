package com.detective.bot.adapters

import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.view.LayoutInflater
import android.view.ViewGroup
import androidx.recyclerview.widget.RecyclerView
import com.detective.bot.databinding.ItemGameControlBinding
import com.detective.bot.models.GameControlItem

class GameControlsAdapter(
    private var items: List<GameControlItem>,
    private val onToggle: (item: GameControlItem, enabled: Boolean) -> Unit
) : RecyclerView.Adapter<GameControlsAdapter.ViewHolder>() {

    inner class ViewHolder(val binding: ItemGameControlBinding) :
        RecyclerView.ViewHolder(binding.root)

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): ViewHolder {
        val binding = ItemGameControlBinding.inflate(
            LayoutInflater.from(parent.context),
            parent,
            false
        )
        return ViewHolder(binding)
    }

    private fun createPill(bgColor: Int): GradientDrawable {
        return GradientDrawable().apply {
            shape = GradientDrawable.RECTANGLE
            cornerRadius = 20f
            setColor(bgColor)
        }
    }

    override fun onBindViewHolder(holder: ViewHolder, position: Int) {
        val item = items[position]
        val binding = holder.binding

        binding.tvTitle.text = item.name
        binding.tvCommand.text = item.command

        if (item.type == "game") {
            binding.tvTypeBadge.text = "لعبة 🎮"
            binding.tvTypeBadge.background = createPill(Color.parseColor("#1e293b"))
            binding.tvTypeBadge.setTextColor(Color.parseColor("#38bdf8"))
        } else {
            binding.tvTypeBadge.text = "أمر ⚡"
            binding.tvTypeBadge.background = createPill(Color.parseColor("#272015"))
            binding.tvTypeBadge.setTextColor(Color.parseColor("#fbbf24"))
        }

        binding.switchToggle.setOnCheckedChangeListener(null)
        binding.switchToggle.isChecked = item.enabled

        binding.switchToggle.setOnCheckedChangeListener { _, isChecked ->
            item.enabled = isChecked
            onToggle(item, isChecked)
        }
    }

    override fun getItemCount(): Int = items.size

    fun updateList(newItems: List<GameControlItem>) {
        items = newItems
        notifyDataSetChanged()
    }
}
