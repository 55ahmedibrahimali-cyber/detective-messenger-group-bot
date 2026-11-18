import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))

from ai_detective import DetectiveAI

def main():
    print("=" * 60)
    print("   Demo — محلل المحقق الذكي مع الكنى والردود المرحة")
    print("=" * 60)

    ai = DetectiveAI()

    # تسجيل اللاعبين بأسمائهم الرسمية المأخوذة من فيسبوك
    ai.register_player("1001", "أحمد المطيري")
    ai.register_player("1002", "خالد العمري")
    ai.register_player("1003", "محمد الغامدي")
    ai.register_player("1004", "علي الحربي")

    # محادثة لعبة تجريبية
    game_chat = {
        "1001": ["المكان هذا فيه أكل وشرب؟", "أعتقد إني شفت خالد يطالع بالسقف"],
        "1002": [
            "ليش كلكم علي؟ مو انا والله",
            "شدخلني بالمكان ياخي؟",
            "والله مو انا الجاسوس شوفوا محمد هو الساكت",
            "احلف لكم اني بريء لا تصوتون علي",
        ],
        "1003": ["المكان معروف وفيه ناس كثير", "أنا مركز بالأسئلة"],
        "1004": ["خالد مرتبك وكلامه كله دفاعي", "أنا اعرف المكان زين"],
    }

    print("\n🔍 تحليل سلوك اللاعبين:\n")
    for pid, msgs in game_chat.items():
        res = ai.analyze_behavior(pid, msgs)
        bar = "█" * (res["suspicion_score"] // 10) + "░" * (10 - res["suspicion_score"] // 10)
        print(f"[{res['player_name']}]:")
        print(f"    الشبهة: {res['suspicion_score']}% [{bar}]")
        print(f"    النمط: {res['behavior']}")
        print(f"    عدد الرسائل: {res['message_count']}")
        print("-" * 50)

    print("\n" + "=" * 60)
    print("اختبار الردود التلقائية في اللعبة:")
    print("=" * 60)
    print("✅ رد الفائز الأول:", ai.get_first_winner_reply("1003"))
    print("❌ رد عشوائي على المخطئين:", ai.pick_random_wrong_reply(["1001", "1002", "1004"]))

if __name__ == "__main__":
    main()
