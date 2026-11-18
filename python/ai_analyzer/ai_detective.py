"""
محلل الذكاء الاصطناعي للعبة المحقق
- لا يستنتج الأسماء من الكلام إطلاقاً، بل يعتمد على الأسماء الرسمية المسجلة من فيسبوك ماسنجر
- يحفظ الأسماء والكنى في قاعدة بيانات محلية لاستخدامها في الردود
- يقدم ردوداً مرحة وبشرية عند الصواب (للأول فقط) وردوداً تهكمية خفيفة عند الخطأ (اختيار عشوائي)
- يحلل السلوك دون الإضرار بخصوصية أو أمان الحساب
"""

import json
import random
import os
from pathlib import Path
from typing import List, Dict, Any, Optional

NAMES_FILE = Path(__file__).resolve().parent.parent.parent / "config" / "player_names.json"


class DetectiveAI:
    def __init__(self):
        self.players = self._load_players()

    def _load_players(self) -> Dict[str, str]:
        try:
            if NAMES_FILE.exists():
                with open(NAMES_FILE, "r", encoding="utf-8") as f:
                    return json.load(f)
        except Exception:
            pass
        return {}

    def _save_players(self):
        try:
            NAMES_FILE.parent.mkdir(parents=True, exist_ok=True)
            with open(NAMES_FILE, "w", encoding="utf-8") as f:
                json.dump(self.players, f, ensure_ascii=False, indent=2)
        except Exception:
            pass

    def register_player(self, user_id: str, name: str):
        """تسجيل اسم اللاعب الرسمي المأخوذ من الماسنجر (وليس المستنتج من الكلام)"""
        if not user_id or not name:
            return
        clean_id = str(user_id)
        clean_name = str(name).strip()
        if self.players.get(clean_id) != clean_name:
            self.players[clean_id] = clean_name
            self._save_players()

    def get_name(self, user_id: str, fallback: str = "اللاعب") -> str:
        """جلب الاسم الأول أو الكنية للاعب"""
        full_name = self.players.get(str(user_id), fallback)
        if full_name:
            # استخدام الاسم الأول لإضفاء لمسة ودية وبشرية
            return full_name.split()[0]
        return fallback

    # =========================================================================
    # تحليل سلوك اللعبة (الجاسوس / المحقق) بدون استنتاج أسماء من النصوص
    # =========================================================================
    def analyze_behavior(self, user_id: str, messages: List[str]) -> Dict[str, Any]:
        player_name = self.get_name(user_id)
        defensive_keywords = ["مو انا", "مش انا", "والله مو", "ليش انا", "شدخلني", "بريء", "مظلوم", "احلف"]
        deflection_keywords = ["شوف فلان", "ركز على", "هو الجاسوس", "واضح انه", "شكله", "صوتوا على"]

        defensive_count = sum(1 for m in messages for k in defensive_keywords if k in m)
        deflection_count = sum(1 for m in messages for k in deflection_keywords if k in m)

        score = min(defensive_count * 20 + deflection_count * 15, 100)
        behavior = "مرتبك / دفاعي" if score >= 60 else "مراوغ" if score >= 35 else "هادئ وطبيعي"

        return {
            "user_id": user_id,
            "player_name": player_name,
            "suspicion_score": score,
            "behavior": behavior,
            "message_count": len(messages)
        }

    # =========================================================================
    # اختيار شخص عشوائي من قائمة المخطئين للرد عليه بتهكم مرح
    # =========================================================================
    def pick_random_wrong_reply(self, wrong_user_ids: List[str]) -> Optional[str]:
        if not wrong_user_ids:
            return None
        chosen_id = random.choice(wrong_user_ids)
        name = self.get_name(chosen_id, "يا غالي")
        
        sarcastic_replies = [
            f"معلش يا {name}.. الجواب راح في داهية خالص 😂 حاول تاني!",
            f"يا {name} إيه الإجابة دي بس؟ 🙈 أنت باين لسه ما شربتش شاي!",
            f"لا يا {name} مش للدرجة دي.. بعيدة أوي والله 😅",
            f"شكلك كنت بتجاوب على سؤال تاني في كوكب تاني يا {name} 🛸😂",
            f"حبيبي يا {name}، الثقة دي تستاهل نقطة لوحدها بس الإجابة غلط 🤷‍♂️😂",
            f"أوف يا {name}.. رمية من غير رامي، بس جت في العارضة ⚽💔",
            f"يا {name} يا غالي، الجوجل اللي في مخك علّق ولا إيه؟ 🔍💀",
            f"هههههه يا {name} مين اللي غششك الإجابة دي بس؟ اشتكي عليه! 🏃‍♂️"
        ]
        return random.choice(sarcastic_replies)

    # =========================================================================
    # رد الفوز للأول فقط
    # =========================================================================
    def get_first_winner_reply(self, winner_id: str) -> str:
        name = self.get_name(winner_id, "البطل")
        praise_replies = [
            f"يا عيني عليك يا {name}! 🔥 جبتها في مقتل وأول واحد كمان!",
            f"أيوة كدة يا {name}! الدماغ الشغالة رزق وربنا 🧠✨",
            f"صح الصح يا {name}! 🎯 مبروك النقطة خطفتها قبل الكل",
            f"كفو والله يا {name}! ما مداهم يفكرون إلا وأنت خاطفها ⚡😂",
            f"وعاش {name}! 👏 طيران على النقطة الأولى 🚀"
        ]
        return random.choice(praise_replies)
