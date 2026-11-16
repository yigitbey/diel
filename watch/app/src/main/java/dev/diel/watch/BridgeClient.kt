package dev.diel.watch

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.os.Handler
import android.os.Looper
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import org.json.JSONObject
import java.util.concurrent.TimeUnit

enum class Status { OFFLINE, IDLE, WORKING, NEEDS_YOU, ERROR }

data class AgentState(
    val status: Status = Status.OFFLINE,
    val title: String = "",
    val activity: String = "",
    val lastMessage: String = "",
    val approval: String? = null,
    val notice: String = "Connecting…",
    /** True when the Mac bridge can run a live voice session. */
    val voiceAvailable: Boolean = false,
    /** Which Mac this state comes from. */
    val macName: String = "",
)

enum class VoiceState { OFF, CONNECTING, LISTENING, SPEAKING }

private const val NOT_PAIRED = "Not paired. Run npm run pair on a Mac."

/**
 * Keeps a WebSocket open over Wi-Fi to the bridge on whichever Mac [macs]
 * picks, and exposes that agent's state. All callbacks run on the main thread.
 */
class BridgeClient(context: Context) {
    val state = MutableStateFlow(AgentState())
    /** Errors to flash on screen. */
    val events = MutableSharedFlow<String>(extraBufferCapacity = 4)
    /** Neutral notes to flash on screen, e.g. which Mac it switched to. */
    val info = MutableSharedFlow<String>(extraBufferCapacity = 4)
    val voice = MutableStateFlow(VoiceState.OFF)
    val caption = MutableStateFlow("")

    private val engine = VoiceEngine(context) { pcm -> socket?.send(pcm.toByteString()) }

    private val main = Handler(Looper.getMainLooper())
    private val cm = context.getSystemService(ConnectivityManager::class.java)
    private var network: Network? = null
    private var socket: WebSocket? = null
    private var http: OkHttpClient? = null
    private var running = false
    private var generation = 0
    private var target: Target? = null

    val macs: MacDirectory = MacDirectory(
        context,
        onTarget = { t ->
            target = t
            if (t == null) drop(if (macs.entries.value.none { it.paired }) NOT_PAIRED else "Looking for your Macs…") else connect()
        },
        isBusy = { voice.value != VoiceState.OFF },
        onSwitched = { name -> info.tryEmit("On $name") },
    )

    private val wifiCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(n: Network) {
            main.post {
                network = n
                drop(if (macs.entries.value.none { it.paired }) NOT_PAIRED else "Looking for your Macs…")
                macs.start(n)
            }
        }

        override fun onLost(n: Network) {
            main.post {
                if (network == n) {
                    network = null
                    macs.stop()
                    drop("Wi-Fi lost")
                }
            }
        }
    }

    fun start() {
        if (running) return
        running = true
        state.value = AgentState(notice = "Waiting for Wi-Fi…")
        // The watch normally reaches the internet through the phone over Bluetooth,
        // which cannot see the Mac's LAN address. Ask for Wi-Fi explicitly.
        val request = NetworkRequest.Builder()
            .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
            .build()
        cm.requestNetwork(request, wifiCallback)
    }

    fun stop() {
        if (!running) return
        running = false
        main.removeCallbacksAndMessages(null)
        runCatching { cm.unregisterNetworkCallback(wifiCallback) }
        macs.stop()
        network = null
        drop("Stopped")
    }

    private fun drop(why: String) {
        generation++
        endVoice()
        socket?.cancel()
        socket = null
        http?.dispatcher?.executorService?.shutdown()
        http = null
        state.value = state.value.copy(status = Status.OFFLINE, activity = "", approval = null, notice = why)
    }

    private fun connect() {
        val net = network ?: return
        val mac = target ?: return
        if (!running) return
        drop("Connecting to ${mac.name}…")
        val gen = generation
        val client = OkHttpClient.Builder()
            .socketFactory(net.socketFactory)
            .connectTimeout(5, TimeUnit.SECONDS)
            .pingInterval(15, TimeUnit.SECONDS)
            .build()
        http = client
        val url = "ws://${mac.host}:${mac.port}/watch"
        socket = client.newWebSocket(Request.Builder().url(url).build(), object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                webSocket.send(JSONObject().put("type", "hello").put("token", mac.token).toString())
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                main.post { if (gen == generation) handle(text) }
            }

            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                if (gen == generation) engine.play(bytes.toByteArray())
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                main.post { if (gen == generation) retry(if (code == 4401) "${mac.name} no longer knows this watch. Pair again." else "${mac.name}'s bridge closed") }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                main.post { if (gen == generation) retry("Can't reach ${mac.name}") }
            }
        })
    }

    private fun retry(why: String) {
        drop(why)
        main.postDelayed({ connect() }, 3000)
    }

    private fun handle(text: String) {
        val m = runCatching { JSONObject(text) }.getOrNull() ?: return
        when (m.optString("type")) {
            "state" -> {
                val thread = m.optJSONObject("thread")
                val approval = m.optJSONObject("approval")
                state.value = AgentState(
                    status = when (m.optString("status")) {
                        "idle" -> Status.IDLE
                        "working" -> Status.WORKING
                        "needs-you" -> Status.NEEDS_YOU
                        "error" -> Status.ERROR
                        else -> Status.OFFLINE
                    },
                    title = thread?.optString("title").orEmpty(),
                    activity = m.optString("activity"),
                    lastMessage = m.optString("lastMessage"),
                    approval = approval?.optString("summary"),
                    notice = m.optString("notice"),
                    voiceAvailable = m.optBoolean("voice"),
                    macName = m.optJSONObject("mac")?.optString("name").orEmpty(),
                )
            }
            "voice" -> {
                when (m.optString("state")) {
                    "connecting" -> voice.value = VoiceState.CONNECTING
                    "listening" -> voice.value = VoiceState.LISTENING
                    "speaking" -> voice.value = VoiceState.SPEAKING
                    else -> {
                        endVoice()
                        m.optString("detail").takeIf { it.isNotEmpty() }?.let { events.tryEmit(it) }
                    }
                }
            }
            "voiceClear" -> engine.clearPlayback()
            "caption" -> caption.value = m.optString("text")
            "ack" -> if (!m.optBoolean("ok")) {
                events.tryEmit(m.optString("detail").ifEmpty { "Couldn't do that" })
            }
        }
    }

    private fun send(type: String, text: String? = null): Boolean {
        val json = JSONObject().put("type", type)
        if (text != null) json.put("text", text)
        val sent = socket?.send(json.toString()) ?: false
        if (!sent) events.tryEmit("Not connected")
        return sent
    }

    /** Start a live voice conversation. RECORD_AUDIO must already be granted. */
    fun startVoice() {
        if (voice.value != VoiceState.OFF) return
        if (!engine.start()) {
            events.tryEmit("Microphone unavailable")
            return
        }
        caption.value = ""
        voice.value = VoiceState.CONNECTING
        if (!send("voiceStart")) endVoice()
    }

    fun stopVoice() {
        if (voice.value == VoiceState.OFF) return
        socket?.send(JSONObject().put("type", "voiceStop").toString())
        endVoice()
    }

    private fun endVoice() {
        if (voice.value == VoiceState.OFF) return
        voice.value = VoiceState.OFF
        engine.stop()
    }

    fun say(text: String) = send("say", text)
    fun approve() = send("approve")
    fun deny() = send("deny")
    fun stopTurn() = send("stop")
}
